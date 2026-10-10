const fs = require('fs');
const http = require('http');
const path = require('path');
const url = require('url');
const express = require('express');
const helmet = require('helmet');
const config = require('./config');
const desktopRoutes = require('./routes/desktop');
const appRoutes = require('./routes/apps');
const { createVncWss } = require('./ws-proxy');
const audio = require('./audio');

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "wss:", "ws:"],
      frameSrc: ["'self'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json());

// Behind the Traefik reverse proxy
app.set('trust proxy', 1);

// No authentication here: the pod is fronted by Traefik with a forwardAuth
// middleware, so every request reaching this process is already authorised.
app.use('/api/desktop', desktopRoutes);
// The app dock's own API. Mounted after the desktop router, whose routes
// are all exact paths, so nothing collides.
app.use('/api/desktop/apps', appRoutes);

// Cache policy
// ------------
// desktop.html itself must never be stored: it is what carries the
// ?cv=<version> query on every asset URL, so every load has to get the
// current bytes. `no-cache` would still let the browser hold a copy and
// revalidate it (a 304 keeps serving the stored HTML), so it gets `no-store`
// — always a full 200. The assets behind those URLs are stamped by
// scripts/stamp-cache-version.sh during the image build and can therefore
// be cached forever — a deployment changes the URL, which is the bust.
// /vendor/novnc is the exception: its modules import each other with bare
// URLs we cannot stamp, so it revalidates instead of caching forever.
const noStore      = (res) => res.setHeader('Cache-Control', 'no-store');
const noCache      = (res) => res.setHeader('Cache-Control', 'no-cache');
const immutableOne = (res) => res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

// Serve noVNC
app.use('/vendor/novnc', express.static(
  path.join(__dirname, '..', 'client', 'vendor', 'novnc'),
  { setHeaders: noCache }
));

// The service worker script must always revalidate: it is referenced by a
// fixed URL (no ?cv= stamp to bust it), so no-cache is what lets the browser
// pick up the new bytes after a deployment.
app.get('/sw.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'client', 'sw.js'));
});

// desktop.html is the exception to the client's caching story: it is the one
// file that may never be cached, because it carries the ?cv=<version> query on
// every asset URL. It is also the file that carries the %PAGE_TITLE%
// placeholder, which PAGE_TITLE substitutes here — server-side, so the tab, the
// history entry and the installed PWA's title are correct from the first byte
// instead of flashing the built-in default while a script catches up.
//
// These routes are registered before the static handler below, not after: that
// handler would otherwise serve the raw file — literal placeholder and all —
// and, worse, stamp it immutable for a year, freezing the deployment's title
// until the asset version changed.
const DESKTOP_HTML = path.join(__dirname, '..', 'client', 'desktop.html');

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Resolved once: PAGE_TITLE is fixed for the life of the process.
const PAGE_TITLE_HTML = escapeHtml(config.PAGE_TITLE);

function serveDesktop(res) {
  fs.readFile(DESKTOP_HTML, 'utf8', (err, html) => {
    if (err) {
      console.error('Failed to read desktop.html:', err);
      res.status(500).type('text').send('Desktop client unavailable');
      return;
    }
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html.replace(/%PAGE_TITLE%/g, PAGE_TITLE_HTML));
  });
}

app.get('/desktop.html', (_req, res) => serveDesktop(res));

// The client is a single page
app.get(['/', '/desktop'], (_req, res) => serveDesktop(res));

// Serve client static files
app.use(express.static(path.join(__dirname, '..', 'client'), {
  index: false,
  etag: true,
  lastModified: true,
  setHeaders: immutableOne,
}));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

const server = http.createServer(app);

// ── WebSocket upgrade ──────────────────────────────────────
// /websockify → raw TCP bridge to the VNC server. Unused when the pod is
// already fronted by websocketify and WS_URL is configured.
const vncWss = createVncWss();

// /audio → the desktop's PulseAudio monitor as raw PCM. A second socket
// rather than a channel on the VNC one, because RFB has no audio. See
// server/audio.js.
const audioWss = audio.createAudioWss();

server.on('upgrade', (req, socket, head) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/websockify') {
    vncWss.handleUpgrade(req, socket, head, (ws) => {
      vncWss.emit('connection', ws, req);
    });
    return;
  }

  if (parsed.pathname === audio.AUDIO_PATH) {
    // The endpoint answers only when the feature is on; a client that ignored
    // /api/desktop/config gets a closed socket rather than a capture process.
    if (!audio.isEnabled()) {
      socket.destroy();
      return;
    }
    audioWss.handleUpgrade(req, socket, head, (ws) => {
      audioWss.emit('connection', ws, req);
    });
    return;
  }

  socket.destroy();
});

server.listen(config.PORT, config.HOST, () => {
  console.log(`Desktop web client listening on ${config.HOST}:${config.PORT}`);
  console.log(`  VNC backend : ${config.VNC_HOST}:${config.VNC_PORT}`);
  console.log(`  X display   : ${config.DISPLAY}`);
  if (config.WS_URL) console.log(`  WebSocket   : ${config.WS_URL} (external, proxy unused)`);
  console.log(`  Audio       : ${audio.isEnabled()
    ? `${config.AUDIO_SOURCE} → ${audio.AUDIO_PATH} (${config.AUDIO_RATE} Hz, ${config.AUDIO_CHANNELS} ch)`
    : 'disabled'}`);
});

// Graceful shutdown
function shutdown() {
  console.log('Shutting down...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Crash recovery — let the container runtime restart us
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});