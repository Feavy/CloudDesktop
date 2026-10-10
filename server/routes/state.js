// HTTP API for desktop session state: save what is open, restore it later.
//
//   GET    /api/desktop/state            what is saved, and the settings
//   POST   /api/desktop/state/save       capture the desktop into the file
//   POST   /api/desktop/state/restore    replay the file onto the desktop
//   GET    /api/desktop/state/download   the file itself, as an attachment
//   PUT    /api/desktop/state            replace the file (upload)
//   DELETE /api/desktop/state            forget the saved state
//   POST   /api/desktop/state/settings   auto-restore preference
//
// Like the rest of this service the router is unauthenticated: the pod sits
// behind Traefik with forwardAuth, so every request here is already
// authorised. What it can launch is bounded by the app registry (installed
// .desktop entries) and by the URLs in the state file; the only thing written
// is the state file and the settings next to it.
//
// The file lives in the desktop user's home and therefore survives a pod
// restart only when the deployment mounted a persistent root there. That is
// what /download and PUT are for: the state travels as one small JSON file,
// so it can also be kept outside the pod and put back after a restart.

const express = require('express');
const state = require('../session-state');

const router = express.Router();

// GET /api/desktop/state — is there a snapshot, and what is in it
router.get('/', (_req, res) => {
  const saved = state.readStateFile();
  const settings = state.readSettings();
  res.json({
    exists: Boolean(saved),
    savedAt: saved?.savedAt || null,
    summary: saved ? state.summarize(saved) : null,
    // Where the file lives, so the client can say what a restart will keep.
    file: state.stateFilePath(),
    autoRestore: settings.autoRestore,
    lastAutoRestoreAt: settings.lastAutoRestoreAt,
  });
});

// POST /api/desktop/state/save — capture the desktop as it is now
router.post('/save', async (_req, res) => {
  try {
    const snapshot = await state.captureState();
    if (!snapshot.windows.length) {
      return res.status(409).json({ error: 'There was nothing open to save' });
    }
    state.writeStateFile(snapshot);
    res.json({
      ok: true,
      savedAt: snapshot.savedAt,
      summary: state.summarize(snapshot),
      unlaunchable: snapshot.unlaunchable,
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to save the session: ${err.message}` });
  }
});

// POST /api/desktop/state/restore — reopen what the file describes
//
// `auto` marks a restore the client started on its own because the desktop
// came back empty and auto-restore is on. It is refused when the setting is
// off, and refused a second time for the same snapshot, so a page reload does
// not launch everything again.
router.post('/restore', async (req, res) => {
  const saved = state.readStateFile();
  if (!saved) {
    return res.status(404).json({ error: 'No saved session to restore' });
  }

  const body = req.body || {};
  const isAuto = body.auto === true;
  if (isAuto) {
    const settings = state.readSettings();
    if (!settings.autoRestore) {
      return res.status(409).json({ error: 'Auto-restore is off' });
    }
    if (settings.lastAutoRestoreAt && saved.savedAt && settings.lastAutoRestoreAt >= saved.savedAt) {
      return res.status(409).json({ error: 'This session has already been restored' });
    }
  }

  try {
    const result = await state.restoreState(saved, {
      rerunCommands: body.rerunCommands === true,
      geometry: body.geometry !== false,
      clipboard: body.clipboard !== false,
    });
    if (isAuto) state.writeSettings({ lastAutoRestoreAt: new Date().toISOString() });
    res.json({ ok: true, savedAt: saved.savedAt, ...result });
  } catch (err) {
    res.status(500).json({ error: `Failed to restore the session: ${err.message}` });
  }
});

// GET /api/desktop/state/download — the state as a file the user can keep
router.get('/download', (_req, res) => {
  const saved = state.readStateFile();
  if (!saved) {
    return res.status(404).json({ error: 'No saved session' });
  }
  const stamp = (saved.savedAt || new Date().toISOString()).replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="clouddesktop-session-${stamp}.json"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify(saved, null, 2));
});

// PUT /api/desktop/state — put a downloaded state back (after a restart that
// took the home directory with it, for instance)
router.put('/', (req, res) => {
  const { state: clean, error } = state.validateState(req.body);
  if (error) {
    return res.status(400).json({ error });
  }
  if (!clean.windows.length) {
    return res.status(400).json({ error: 'That file has no windows in it' });
  }
  try {
    state.writeStateFile(clean);
    res.json({ ok: true, savedAt: clean.savedAt, summary: state.summarize(clean) });
  } catch {
    res.status(500).json({ error: 'Failed to write the session state' });
  }
});

// DELETE /api/desktop/state — forget it
router.delete('/', (_req, res) => {
  const removed = state.clearStateFile();
  res.json({ ok: true, removed });
});

// POST /api/desktop/state/settings — auto-restore preference
router.post('/settings', (req, res) => {
  const autoRestore = req.body?.autoRestore;
  if (typeof autoRestore !== 'boolean') {
    return res.status(400).json({ error: 'autoRestore must be a boolean' });
  }
  try {
    const settings = state.writeSettings({ autoRestore });
    res.json({ ok: true, autoRestore: settings.autoRestore });
  } catch {
    res.status(500).json({ error: 'Failed to save the setting' });
  }
});

module.exports = router;
