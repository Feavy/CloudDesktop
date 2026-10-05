const http = require('http');
const path = require('path');
const url = require('url');
const express = require('express');
const helmet = require('helmet');
const config = require('./config');
const desktopRoutes = require('./routes/desktop');
const { createVncWss } = require('./ws-proxy');

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

// Serve client static files
app.use(express.static(path.join(__dirname, '..', 'client'), {
  index: false,
  etag: true,
  lastModified: true,
  setHeaders: immutableOne,
}));

// desktop.html reached by its own name must not fall through to the static
// handler above: it would be stamped immutable for a year, exactly the one
// file that may never be cached.
app.get('/desktop.html', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'client', 'desktop.html'));
});

// The client is a single page
app.get(['/', '/desktop'], (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'client', 'desktop.html'));
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

const server = http.createServer(app);

// ── WebSocket upgrade ──────────────────────────────────────
// /websockify → raw TCP bridge to the VNC server. Unused when the pod is
// already fronted by websocketify and WS_URL is configured.
const vncWss = createVncWss();

server.on('upgrade', (req, socket, head) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/websockify') {
    vncWss.handleUpgrade(req, socket, head, (ws) => {
      vncWss.emit('connection', ws, req);
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