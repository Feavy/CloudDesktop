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

// Revalidate every client asset against its ETag on every load. Without this
// the browser (or a shared cache) may keep serving the previous deployment's
// files, and a stale desktop.js quietly misbehaves against a fresh pod. The
// ETag still turns unchanged loads into cheap 304s, so this costs nothing
// beyond the revalidation round-trips.
const noCacheHeaders = (res) => res.setHeader('Cache-Control', 'no-cache');

// Serve noVNC
app.use('/vendor/novnc', express.static(
  path.join(__dirname, '..', 'client', 'vendor', 'novnc'),
  { setHeaders: noCacheHeaders }
));

// Serve client static files: always revalidated, never served stale
app.use(express.static(path.join(__dirname, '..', 'client'), {
  index: false,
  etag: true,
  lastModified: true,
  maxAge: 0,
  setHeaders: noCacheHeaders,
}));

// The client is a single page
app.get(['/', '/desktop'], (_req, res) => {
  res.set('Cache-Control', 'no-cache');
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