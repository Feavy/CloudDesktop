// ── Remote desktop audio ────────────────────────────────────
// Plays the PCM stream served on the server's /audio WebSocket (see
// server/audio.js) with the Web Audio API. The format is signed 16-bit
// little-endian interleaved samples at the rate GET /api/desktop/config
// advertises.
//
// Each chunk becomes an AudioBuffer started at a running clock time rather
// than a media element, which is what keeps the sound continuous instead of
// restarting per chunk. Guacamole's client works the same way. Two
// consequences are load-bearing here:
//
//   * Browsers refuse to start audio without a user gesture. The context is
//     created suspended, the socket is not opened while it is suspended, and
//     the first click or key press resumes it and opens the stream. That is
//     what the 'blocked' state means.
//   * This is live audio, not synchronised audio: whenever the backlog grows
//     past MAX_LEAD the clock is re-anchored, so a stalled tab drops the
//     excess instead of drifting further and further behind.

// Audio scheduled ahead of the output clock. Small enough to stay live, large
// enough to absorb a scheduling hiccup or a slow chunk.
const LEAD_SECONDS = 0.12;
// Past this much backlog the stream is considered stale and re-anchored.
const MAX_LEAD_SECONDS = 0.5;
// A chunk arriving later than this is treated as an underrun and re-anchored.
const MIN_LEAD_SECONDS = 0.005;

const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30000;

const GESTURES = ['pointerdown', 'keydown', 'touchstart'];

function socketUrl(path) {
  if (/^wss?:\/\//i.test(path)) return path;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${path}`;
}

// Linear-interpolated resample of one channel of interleaved Int16 PCM into a
// Float32 destination. Only used when the output device refuses the stream's
// rate (rare: most desktops run at 48 kHz, which is also the default here).
function resampleChannel(view, channel, channels, frames, out, step) {
  for (let i = 0; i < out.length; i++) {
    const src = i * step;
    const i0 = Math.min(frames - 1, Math.floor(src));
    const i1 = Math.min(frames - 1, i0 + 1);
    const frac = src - i0;
    const s0 = view.getInt16((i0 * channels + channel) * 2, true);
    const s1 = view.getInt16((i1 * channels + channel) * 2, true);
    out[i] = (s0 + (s1 - s0) * frac) / 32768;
  }
}

/**
 * @param {object}   options
 * @param {string}   options.url       /audio, from the server config
 * @param {number}   options.rate      sample rate of the PCM stream
 * @param {number}   options.channels  channel count of the PCM stream
 * @param {Function} [options.onStatus] called with (status, detail)
 *   status: 'off' | 'blocked' | 'connecting' | 'playing' | 'error'
 */
export function createRemoteAudio({ url, rate = 48000, channels = 2, onStatus }) {
  let ctx = null;
  let gain = null;
  let ws = null;
  let closed = false;
  let enabled = false;
  let status = 'off';
  let nextTime = 0;
  let retryDelay = RETRY_MIN_MS;
  let retryTimer = null;
  let gestureBound = false;

  function setStatus(next, detail) {
    if (status === next && !detail) return;
    status = next;
    if (onStatus) onStatus(status, detail);
  }

  // ── Context ───────────────────────────────────────────────

  function ensureContext() {
    if (ctx) return ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) {
      setStatus('error', 'this browser has no Web Audio support');
      return null;
    }
    try {
      // Ask for the stream's own rate so the common path needs no resampling.
      ctx = new Ctor({ sampleRate: rate });
    } catch {
      ctx = new Ctor();
    }
    gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(ctx.destination);

    ctx.addEventListener?.('statechange', onContextStateChange);
    if (!ctx.addEventListener) ctx.onstatechange = onContextStateChange;
    return ctx;
  }

  function onContextStateChange() {
    if (!ctx) return;
    if (ctx.state === 'running') {
      if (enabled && !ws) openSocket();
    } else {
      // Suspended or interrupted: whatever was scheduled is stale by the time
      // it resumes, so drop the clock rather than play it late.
      nextTime = 0;
    }
  }

  // Browsers only allow the context to start from a user gesture. One
  // listener, bound for the life of the page, is enough: it resumes on the
  // first interaction (and on the first interaction after any later
  // suspend), which is the best a page can do without an explicit unmute UI.
  function bindGesture() {
    if (gestureBound) return;
    gestureBound = true;
    const handler = () => {
      if (!enabled || !ctx || ctx.state === 'running') return;
      // resume() fires 'statechange' when it takes, which onContextStateChange
      // acts on; chaining here too means a browser that stays quiet about it
      // still gets its socket.
      resumeContext().then(() => {
        if (enabled && ctx && ctx.state === 'running') openSocket();
      });
    };
    for (const event of GESTURES) {
      document.addEventListener(event, handler, { capture: true, passive: true });
    }
  }

  function resumeContext() {
    if (!ctx || ctx.state === 'running') return Promise.resolve();
    return ctx.resume().catch(() => {
      // Still blocked: the next gesture will try again.
    });
  }

  // ── Playback ──────────────────────────────────────────────

  function schedule(data) {
    if (!ctx || ctx.state !== 'running') return;

    const frameBytes = channels * 2;
    const frames = Math.floor(data.byteLength / frameBytes);
    if (frames < 1) return;

    const view = new DataView(data);
    const outRate = ctx.sampleRate;
    const outFrames = outRate === rate
      ? frames
      : Math.max(1, Math.round(frames * outRate / rate));

    const buffer = ctx.createBuffer(channels, outFrames, outRate);
    const step = rate / outRate;
    for (let c = 0; c < channels; c++) {
      const out = buffer.getChannelData(c);
      if (outRate === rate) {
        for (let i = 0; i < frames; i++) {
          out[i] = view.getInt16((i * channels + c) * 2, true) / 32768;
        }
      } else {
        resampleChannel(view, c, channels, frames, out, step);
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);

    const now = ctx.currentTime;
    if (nextTime < now + MIN_LEAD_SECONDS || nextTime > now + MAX_LEAD_SECONDS) {
      nextTime = now + LEAD_SECONDS;
    }
    source.start(nextTime);
    nextTime += buffer.duration;

    if (status !== 'playing') setStatus('playing');
  }

  // ── Socket ────────────────────────────────────────────────

  function clearRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry() {
    if (retryTimer || closed || !enabled) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      openSocket();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  }

  function openSocket() {
    if (closed || !enabled || ws) return;
    if (!ctx || ctx.state !== 'running') {
      setStatus('blocked');
      return;
    }

    setStatus('connecting');
    let sock;
    try {
      sock = new WebSocket(socketUrl(url));
    } catch (err) {
      setStatus('error', err.message);
      scheduleRetry();
      return;
    }
    sock.binaryType = 'arraybuffer';
    ws = sock;

    sock.onopen = () => {
      if (ws !== sock) return;
      retryDelay = RETRY_MIN_MS;
    };

    sock.onmessage = (event) => {
      if (ws !== sock) return;
      if (typeof event.data === 'string') {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        // The server tells us when capture cannot start (no PulseAudio, no
        // parec). Surface it and keep trying at the slow end of the backoff,
        // so a desktop that comes up late recovers without a reload.
        if (message.type === 'error') {
          setStatus('error', message.message || 'audio unavailable');
          retryDelay = RETRY_MAX_MS;
        }
        return;
      }
      schedule(event.data);
    };

    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      nextTime = 0;
      if (!closed && enabled) {
        if (status !== 'error') setStatus('connecting');
        scheduleRetry();
      }
    };

    // onerror is always followed by a close; nothing to do here.
    sock.onerror = () => {};
  }

  function closeSocket() {
    clearRetry();
    const sock = ws;
    ws = null;
    if (sock) {
      sock.onclose = null;
      sock.onerror = null;
      sock.onmessage = null;
      try { sock.close(); } catch { /* already closing */ }
    }
    nextTime = 0;
  }

  // ── Public surface ────────────────────────────────────────

  function start() {
    if (closed) return;
    ensureContext();
    bindGesture();
    if (!ctx) return;
    if (ctx.state === 'running') {
      openSocket();
    } else {
      // Try anyway: a context created from within a click handler is allowed
      // to start, and one created earlier is not.
      resumeContext().then(() => {
        if (enabled && ctx && ctx.state === 'running') openSocket();
        else if (enabled) setStatus('blocked');
      });
    }
  }

  function stop() {
    closeSocket();
    if (ctx && ctx.state === 'running') {
      // Release the output device rather than leave a suspended-but-open
      // context holding it; the next enable resumes it. Promise.resolve
      // because older implementations return nothing from suspend().
      Promise.resolve(ctx.suspend()).catch(() => {});
    }
    setStatus('off');
  }

  return {
    /** Turn the stream on or off; mirrors the Settings toggle. */
    setEnabled(on) {
      on = Boolean(on);
      if (on === enabled) return;
      enabled = on;
      if (on) start();
      else stop();
    },
    get enabled() { return enabled; },
    get status() { return status; },
    destroy() {
      closed = true;
      enabled = false;
      closeSocket();
      if (ctx) {
        Promise.resolve(ctx.close()).catch(() => {});
        ctx = null;
        gain = null;
      }
    },
  };
}
