const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const config = require('./config');

// ── Desktop audio ────────────────────────────────────────────
// Streams what the remote desktop is playing to the browser.
//
// There is no audio in the RFB protocol noVNC speaks, so this is a second
// WebSocket (/audio) beside the VNC one. The desktop session runs PulseAudio
// with a virtual sink (install.sh), everything the desktop plays lands on that
// sink's monitor, and one parec process reads it as raw PCM. Every connected
// browser gets the same frames: one capture, many listeners, which matters
// because the encoder-free design sends ~1.5 Mbit/s of 48 kHz stereo while
// sound is playing.
//
// The format is deliberately dumb -- signed 16-bit little-endian, interleaved,
// no container -- because the client plays it with the Web Audio API. Chunks
// are message boundaries, so the client never has to frame anything; see
// client/js/audio.js for the playback side.

// Where the endpoint lives. app.js routes upgrades here and routes/desktop.js
// advertises it in /api/desktop/config, so it is named once.
const AUDIO_PATH = '/audio';

// A short JSON frame precedes the PCM so a client never has to trust that the
// format it read from /api/desktop/config is still the one on the wire.
const HELLO = {
  type: 'hello',
  encoding: 'pcm_s16le',
  rate: config.AUDIO_RATE,
  channels: config.AUDIO_CHANNELS,
};

// One capture for every listener; null when nobody is listening, so an idle
// desktop costs nothing.
let capture = null;
// A pipe chunk can end mid-sample. Whatever is left over is prepended to the
// next chunk, because a client reading 16-bit words cannot resynchronise.
let remainder = Buffer.alloc(0);
// After a failed spawn (no PulseAudio yet, usually) give it a moment before
// forking it again for every client that connects.
let retryAfter = 0;
let retryTimer = null;

const clients = new Set();

// ── Locating the capture tool ───────────────────────────────
// Resolved by hand rather than with `which` so this stays synchronous and
// dependency-free: it runs on connection and in the /config request path.
function findExecutable(cmd) {
  if (cmd.includes('/') || cmd.includes(path.sep)) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return cmd;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

// Whether the feature is on at all. In 'auto' mode that is exactly "is the
// capture tool installed": the desktop and all-in-one images install
// pulseaudio-utils, the Alpine client-only image does not, and that image has
// no desktop beside it to capture.
function isEnabled() {
  if (config.AUDIO_ENABLED === 'off') return false;
  if (config.AUDIO_ENABLED === 'on') return true;
  return findExecutable(config.AUDIO_CAPTURE_CMD) !== null;
}

// The shape GET /api/desktop/config hands the browser.
function status() {
  return {
    enabled: isEnabled(),
    url: AUDIO_PATH,
    rate: config.AUDIO_RATE,
    channels: config.AUDIO_CHANNELS,
  };
}

// ── Capture ─────────────────────────────────────────────────

function captureEnv() {
  const env = { ...process.env };
  // PulseAudio's socket directory. config.js documents why this default
  // matches the desktop session's; without it parec would look in a directory
  // that does not exist and fail with nothing useful in the log.
  if (!env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = config.XDG_RUNTIME_DIR;
  return env;
}

// True when every sample in the chunk is below the gate. Reading the buffer as
// 16-bit words is a few microseconds per millisecond of audio, which is why
// this is affordable on every chunk.
function isSilent(buf) {
  const threshold = config.AUDIO_SILENCE_THRESHOLD;
  if (threshold <= 0) return false;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const sample = buf.readInt16LE(i);
    if (sample > threshold || sample < -threshold) return false;
  }
  return true;
}

function sendHello(ws) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(HELLO));
  }
}

function broadcastError(message) {
  const text = JSON.stringify({ type: 'error', message });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(text);
  }
}

function onPcm(chunk) {
  const frameBytes = config.AUDIO_CHANNELS * 2;

  let buf = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
  const aligned = buf.length - (buf.length % frameBytes);
  remainder = aligned === buf.length ? Buffer.alloc(0) : buf.subarray(aligned);
  if (aligned === 0) return;
  if (aligned !== buf.length) buf = buf.subarray(0, aligned);

  // Idle desktops are silent, and silence is most of the time. Not sending it
  // is what keeps an idle session from costing a megabit and a half.
  if (isSilent(buf)) return;

  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(buf, { binary: true });
  }
}

function stopCapture() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (capture) {
    const child = capture;
    capture = null;
    child.stdout.removeAllListeners('data');
    child.kill('SIGTERM');
  }
  remainder = Buffer.alloc(0);
}

function ensureCapture() {
  if (capture || clients.size === 0) return;
  if (Date.now() < retryAfter) {
    scheduleRetry();
    return;
  }

  const tool = findExecutable(config.AUDIO_CAPTURE_CMD);
  if (!tool) {
    // 'on' forced a tool that is not there; the clients should hear about it
    // rather than wait forever for audio that cannot come.
    broadcastError(`audio capture tool '${config.AUDIO_CAPTURE_CMD}' is not installed`);
    retryAfter = Date.now() + 30000;
    scheduleRetry();
    return;
  }

  const args = [
    `--device=${config.AUDIO_SOURCE}`,
    '--format=s16le',
    `--rate=${config.AUDIO_RATE}`,
    `--channels=${config.AUDIO_CHANNELS}`,
    '--raw',
    `--latency-msec=${config.AUDIO_LATENCY_MS}`,
  ];

  let child;
  try {
    child = spawn(tool, args, {
      env: captureEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    broadcastError(`could not start audio capture: ${err.message}`);
    retryAfter = Date.now() + 10000;
    scheduleRetry();
    return;
  }

  capture = child;
  console.log(`Audio: capturing ${config.AUDIO_SOURCE} `
    + `(${config.AUDIO_RATE} Hz, ${config.AUDIO_CHANNELS} ch) with ${tool}`);

  // parec explains itself on stderr; keep the tail of it for the exit log.
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr = (stderr + data.toString()).slice(-500);
  });

  child.stdout.on('data', onPcm);

  child.on('error', (err) => {
    if (capture !== child) return;
    capture = null;
    console.error('Audio capture error:', err.message);
    broadcastError(`audio capture failed: ${err.message}`);
    retryAfter = Date.now() + 10000;
    if (clients.size > 0) scheduleRetry();
  });

  child.on('exit', (code, signal) => {
    if (capture !== child) return; // stopped on purpose
    capture = null;
    remainder = Buffer.alloc(0);
    if (clients.size === 0) return;

    const how = signal ? `signal ${signal}` : `code ${code}`;
    console.warn(`Audio capture exited (${how})${stderr ? `: ${stderr.trim()}` : ''}`);
    // Most often this is "no PulseAudio yet": the desktop session starts the
    // daemon, and the web client can come up first. Backing off keeps a
    // browser that reconnects from turning that into a fork storm.
    broadcastError('audio capture stopped; is PulseAudio running?');
    retryAfter = Date.now() + 5000;
    scheduleRetry();
  });
}

function scheduleRetry() {
  if (retryTimer || clients.size === 0) return;
  const delay = Math.max(1000, retryAfter - Date.now());
  retryTimer = setTimeout(() => {
    retryTimer = null;
    ensureCapture();
  }, delay);
  // Never hold the process open just for this.
  if (retryTimer.unref) retryTimer.unref();
}

// ── WebSocket server ────────────────────────────────────────

function createAudioWss() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    clients.add(ws);
    sendHello(ws);

    // Same keepalive as the VNC bridge: idle timeouts in the path between the
    // browser and this process are the usual reason a long silence (which is
    // all the gate ever sends nothing for) gets a socket torn down.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const pingInterval = setInterval(() => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      if (ws.readyState === ws.OPEN) ws.ping();
    }, 30000);

    // The browser never sends anything: this is a one-way stream.
    const drop = () => {
      clearInterval(pingInterval);
      clients.delete(ws);
      if (clients.size === 0) stopCapture();
    };
    ws.on('close', drop);
    ws.on('error', drop);

    ensureCapture();
  });

  return wss;
}

module.exports = { AUDIO_PATH, createAudioWss, isEnabled, status };
