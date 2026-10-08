// HTTP API for the web client's app dock.
//
//   GET  /api/desktop/apps            list installed applications
//   GET  /api/desktop/apps/icon/:id   an application's icon (?size=48)
//   POST /api/desktop/apps/launch     launch by application id
//   GET  /api/desktop/apps/pins       the saved dock pins (or the defaults)
//   PUT  /api/desktop/apps/pins       save dock pins
//
// Like the rest of the service this router is unauthenticated — the pod
// sits behind Traefik with forwardAuth, so every request here is already
// authorised. Launching is bounded to installed .desktop entries by the
// registry; the pins file is the only thing this code writes.

const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const apps = require('../apps');

const router = express.Router();

const PINS_DIR = path.join(config.HOME_DIR, '.config', 'clouddesktop');
const PINS_FILE = path.join(PINS_DIR, 'dock.json');
const MAX_PINS = 64;

const VALID_ID = /^[A-Za-z0-9._-]{1,200}$/;

// Read the saved pins, or null when none have been saved yet — the caller
// decides what the first-run defaults are.
function readPinsFile() {
  try {
    const data = JSON.parse(fs.readFileSync(PINS_FILE, 'utf8'));
    if (Array.isArray(data.pinned)) {
      return data.pinned.filter((id) => typeof id === 'string' && VALID_ID.test(id));
    }
  } catch { /* missing or corrupt — treat as never saved */ }
  return null;
}

function writePinsFile(pins) {
  fs.mkdirSync(PINS_DIR, { recursive: true });
  // Write-then-rename so a crash mid-write can never leave a truncated
  // file that would silently reset the user's dock on the next read.
  const tmp = `${PINS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pinned: pins }, null, 2));
  fs.renameSync(tmp, PINS_FILE);
}

// GET /api/desktop/apps — installed applications for the dock and the grid
router.get('/', (req, res) => {
  // ?fresh=1 rescans instead of serving the (5-minute) cache: the grid
  // asks for it when it opens, so newly installed apps appear immediately.
  const fresh = req.query.fresh === '1';
  res.json({ apps: apps.listApps(fresh) });
});

// GET /api/desktop/apps/icon/:id?size=48 — resolved icon file
router.get('/icon/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!VALID_ID.test(id)) {
    return res.status(400).json({ error: 'Invalid app id' });
  }
  const size = Math.min(Math.max(parseInt(req.query.size, 10) || 48, 16), 256);

  const file = apps.iconFile(id, size);
  if (!file) return res.status(404).json({ error: 'No icon' });

  const ext = path.extname(file).toLowerCase();
  const type = ext === '.svg' ? 'image/svg+xml'
    : ext === '.xpm' ? 'image/x-xpixmap'
      : 'image/png';
  res.setHeader('Content-Type', type);
  // Icons only change when the image does, and the client's URLs carry the
  // build's cache version, so a day of browser caching is safe.
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(file);
});

// POST /api/desktop/apps/launch — launch an installed application
router.post('/launch', async (req, res) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  if (!VALID_ID.test(id)) {
    return res.status(400).json({ error: 'Invalid app id' });
  }
  if (!apps.getApp(id)) {
    return res.status(404).json({ error: `Unknown application: ${id}` });
  }
  try {
    await apps.launchApp(id);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: `Failed to launch ${id}` });
  }
});

// GET /api/desktop/apps/pins — the dock's pinned application ids
router.get('/pins', (_req, res) => {
  const saved = readPinsFile();
  res.json({ pinned: saved === null ? apps.defaultPins() : saved });
});

// PUT /api/desktop/apps/pins — replace the dock's pinned application ids
router.put('/pins', (req, res) => {
  const raw = req.body?.pinned;
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string' || !VALID_ID.test(id))) {
    return res.status(400).json({ error: 'pinned must be an array of app ids' });
  }
  // Dedupe preserving order, cap the length: the dock is a dock, not a list.
  const pins = [...new Set(raw)].slice(0, MAX_PINS);
  try {
    writePinsFile(pins);
  } catch {
    return res.status(500).json({ error: 'Failed to save pins' });
  }
  res.json({ ok: true, pinned: pins });
});

module.exports = router;
