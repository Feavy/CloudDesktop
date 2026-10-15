const express = require('express');
const { execFile, exec, spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const config = require('../config');
const audio = require('../audio');
const apps = require('../apps');
const installer = require('../installer');

const router = express.Router();

// X environment for the xrandr/xclip/wmctrl calls below
const X_ENV = {
  ...process.env,
  DISPLAY: config.DISPLAY,
  XAUTHORITY: config.XAUTHORITY,
  HOME: config.HOME_DIR,
};

// The environment for the xfconf-query calls in the appearance routes below.
//
// They are the one thing here that does not talk to the X server but to the
// desktop session's D-Bus, and X_ENV is not enough for that: this process is
// launched beside Xtigervnc rather than inside the session (see the note at the
// top of ../apps.js), so it never inherited DBUS_SESSION_BUS_ADDRESS. Asked
// without one, libdbus starts a *second* session bus, and the xfconfd it
// activates there is not the one the running xfsettingsd is watching: the
// write lands in a channel nothing reads, so the desktop keeps its old text
// size and DPI however the request is answered.
//
// apps.sessionEnv() recovers the session's own values from the processes that
// do live in it, which is how a dock-launched application gets a settings
// dialog that works. The keys it returns are fixed for the life of the session
// and it answers {} when there is no session to read (the client-only image,
// or a desktop still starting), so this degrades to plain X_ENV -- and to the
// 503/502 the routes already report -- rather than guessing a bus.
function xfconfEnv() {
  return { ...X_ENV, ...apps.sessionEnv() };
}

// Run wmctrl against the desktop display. Resolves its stdout on success and
// null on failure, so callers can tell "no windows" (an empty list) from
// "could not ask" (an unusable display).
function wmctrl(args) {
  return new Promise((resolve) => {
    execFile('wmctrl', args, { env: X_ENV }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

const RUN_HOME = config.HOME_DIR;

const DESKTOP_DIR = path.join(RUN_HOME, 'Desktop');
const DOWNLOADS_DIR = path.join(RUN_HOME, 'Downloads');

// ── Chunked upload system ──────────────────────────────────
const UPLOAD_TEMP_DIR = '/tmp/clouddesktop-uploads';
fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB per chunk
const activeUploads = new Map();

// Cleanup stale uploads every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, up] of activeUploads) {
    if (now - up.lastActivity > 30 * 60 * 1000) {
      try { fs.unlinkSync(up.tempPath); } catch {}
      activeUploads.delete(id);
    }
  }
}, 10 * 60 * 1000);

function sanitizeDestDir(dest) {
  if (!dest) return DESKTOP_DIR;
  const clean = path.resolve(dest.replace(/\0/g, ''));
  // Block only /proc, /sys, /dev for safety; allow everything else
  if (clean.startsWith('/proc') || clean.startsWith('/sys') || clean.startsWith('/dev')) return DESKTOP_DIR;
  return clean;
}

// Multer setup for file uploads (100MB limit)
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(DESKTOP_DIR, { recursive: true });
    cb(null, DESKTOP_DIR);
  },
  filename: (_req, file, cb) => {
    // Sanitize filename: strip path separators, null bytes, leading dots
    let name = file.originalname
      .replace(/[/\\]/g, '_')
      .replace(/\0/g, '')
      .replace(/^\.+/, '');
    if (!name) name = 'upload';
    cb(null, name);
  },
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// Allowlisted apps for the launch endpoint. The web client's app dock
// launches from installed .desktop entries instead (see routes/apps.js);
// this endpoint stays part of the HTTP API for other consumers.
const ALLOWED_APPS = {
  filemanager: { cmd: 'thunar', args: [] },
  terminal: { cmd: 'xfce4-terminal', args: [] },
  // synaptic-root (written by install.sh) launches Synaptic as root on the
  // session display; synaptic itself must not run unprivileged.
  synaptic: { cmd: 'synaptic-root', args: [] },
  chrome: { cmd: 'google-chrome', args: ['--no-sandbox', '--no-first-run'] },
  vscode: { cmd: 'code', args: ['--no-sandbox'] },
};

// Report which allowlisted apps are actually installed in this pod, as
// `/config.canLaunch`. Kept for API consumers; the current web client
// launches through the .desktop registry in routes/apps.js instead.
// Resolved once at startup because the package set is static.
const availableApps = Object.entries(ALLOWED_APPS)
  .filter(([, app]) => {
    const found = (process.env.PATH || '').split(':').some((dir) => {
      if (!dir) return false;
      try { fs.accessSync(path.join(dir, app.cmd), fs.constants.X_OK); return true; }
      catch { return false; }
    });
    if (!found) console.log(`Launch: '${app.cmd}' not found, omitting it from canLaunch`);
    return found;
  })
  .map(([name]) => name);

// ── How a restart reaches the desktop ──────────────────────
//
//   'pod'     the desktop lives in this container (the all-in-one image), so
//             exiting restarts everything;
//   'session' it lives in a container of its own, and the VNC session is the
//             only channel that reaches it: the browser presses a shortcut
//             bound to xfce4-session-logout --logout, the session ends, and
//             start-vnc's watcher tears the desktop container down;
//   'command' no container at all (a dev checkout), so the deployment has to
//             supply RESTART_CMD;
//   'off'     none of the above — the dock hides the button.
//
// The processes of the all-in-one image are siblings in our own PID namespace;
// a sidecar's are not visible at all. That is only a guess, so RESTART_MODE
// can force any of the four.
const DESKTOP_COMMS = /^(Xtigervnc|Xvnc|Xtightvnc|xfce4-session)$/;

function desktopIsLocal() {
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let comm;
      try {
        comm = fs.readFileSync(`/proc/${entry}/comm`, 'utf8').trim();
      } catch {
        continue; // the process exited between the readdir and the read
      }
      if (DESKTOP_COMMS.test(comm)) return true;
    }
  } catch { /* no /proc to inspect — assume the desktop is elsewhere */ }
  return false;
}

function restartMode() {
  const forced = config.RESTART_MODE;
  if (forced !== 'auto') {
    if (forced === 'command') return config.RESTART_CMD ? 'command' : 'off';
    if (forced === 'pod' || forced === 'session' || forced === 'off') return forced;
    return 'off'; // unrecognised value: never guess at a restart
  }
  if (config.IS_CONTAINER) return desktopIsLocal() ? 'pod' : 'session';
  return config.RESTART_CMD ? 'command' : 'off';
}

// GET /api/desktop/config — environment info and which dock actions apply
router.get('/config', (_req, res) => {
  const mode = restartMode();
  const install = installer.installCapability();
  res.json({
    homeDir: RUN_HOME,
    desktopDir: DESKTOP_DIR,
    // External websocketify endpoint, or empty to use this server's bridge
    wsUrl: config.WS_URL,
    // The dock only offers "restart" when there is a way to do it, and it has
    // to know which one: the browser performs 'session' itself over VNC.
    canRestart: mode !== 'off',
    restartMode: mode,
    // Whether "install a .deb from a URL" can work at all: the app browser
    // hides its Install button where apt-get is missing (the client-only
    // Alpine image) rather than offering one that always fails. The reason is
    // for API consumers and for diagnosing a deployment that expected it on.
    canInstallDeb: install.available,
    installDebReason: install.available ? '' : install.reason,
    // Desktop audio: whether the /audio WebSocket is served at all, and the
    // PCM format it sends. The browser hides the Sound setting when it is off
    // (there is nothing to toggle in the client-only image, which has no
    // desktop beside it to capture).
    audio: audio.status(),
    canLaunch: availableApps,
  });
});

// POST /api/desktop/resolution
router.post('/resolution', (req, res) => {
  const { width, height } = req.body;

  // The floor is the sanity rail the client fits inside, not the shape it fits
  // to: a phone in portrait is ~390 CSS px wide, and the client asks for that
  // aspect rather than for a wider mode the page cannot display.
  if (!width || !height ||
      width < 320 || width > 3840 ||
      height < 240 || height > 2160) {
    return res.status(400).json({ error: 'Invalid resolution (320-3840 x 240-2160)' });
  }

  const w = Math.floor(Number(width));
  const h = Math.floor(Number(height));
  const modeName = `${w}x${h}`;

  // Try setting the mode directly first
  execFile('xrandr', ['--output', 'VNC-0', '--mode', modeName], {
    env: X_ENV,
  }, (err) => {
    if (!err) {
      return res.json({ ok: true, width: w, height: h });
    }

    // Mode doesn't exist — create it with cvt, then add it
    execFile('cvt', [String(w), String(h), '60'], (cvtErr, cvtOut) => {
      if (cvtErr) {
        return res.status(500).json({ error: 'Failed to generate modeline' });
      }

      // Parse cvt output: "Modeline "1366x768_60.00" 85.25 ..."
      const match = cvtOut.match(/Modeline\s+"[^"]+"\s+(.+)/);
      if (!match) {
        return res.status(500).json({ error: 'Failed to parse modeline' });
      }

      const modeline = match[1].trim();
      const newModeName = `${w}x${h}_60.00`;

      // Chain: newmode → addmode → set mode
      const cmd = [
        `xrandr --newmode "${newModeName}" ${modeline} 2>/dev/null; true`,
        `xrandr --addmode VNC-0 "${newModeName}" 2>/dev/null; true`,
        `xrandr --output VNC-0 --mode "${newModeName}"`,
      ].join(' && ');

      exec(cmd, { env: X_ENV }, (execErr) => {
        if (execErr) {
          return res.status(500).json({ error: 'Failed to change resolution' });
        }
        res.json({ ok: true, width: w, height: h });
      });
    });
  });
});

// GET /api/desktop/appearance
//
// The client's Font Size and DPI controls, which are XFCE xsettings rather
// than a resolution: /Gtk/FontName is the desktop's UI and monospace font, and
// /Xft/DPI is the dots-per-inch Xft renders at. XFCE's xsettings daemon
// watches this channel, so a change lands in the running applications without
// a restart -- on the session's own bus, which is what xfconfEnv() arranges.
//
// This is deliberately separate from POST /resolution. A resolution changes
// how many pixels the desktop has; these change how big the text drawn into
// those pixels is, so the two do not fight: x2 + 96 DPI is a large, crisp
// desktop, and 96 DPI at any resolution keeps the same text size relative to
// the screen.
//
// The browser sends values it offers as presets, but the server validates them
// anyway: this route hands its input to a command line, and a font name that
// reaches xfconf-query unchecked is a command-line injection waiting to happen.
// Only the point sizes below are accepted, so the request cannot name an
// arbitrary font or an absurd DPI. The client's four buttons are a subset of
// that list on purpose -- the rest are sizes the API accepts and a deployment
// can drive without the client changing.
const FONT_SIZES = [8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24];
const DPI_MIN = 72, DPI_MAX = 240;
// "Sans 10": a family (letters, digits, spaces, dashes) then a point size.
// The family group is lazy so the last space is the one that separates the
// two, and the separator is a literal space rather than \s -- \s also matched
// the space before the size, which left "Sans 12" with nothing to match.
const FONT_NAME_RE = /^([A-Za-z0-9][A-Za-z0-9 ._-]{0,60}?)[ ]+(\d{1,2})$/;

function fontPointSize(name) {
  const m = FONT_NAME_RE.exec(String(name || ''));
  return m ? parseInt(m[2], 10) : null;
}

// The desktop's own font family, so a size change keeps the theme's choice.
// Read at most once: xfconf-query is not free, and the family is not what this
// route changes.
let fontFamilyPromise = null;
function fontFamily() {
  if (!fontFamilyPromise) {
    fontFamilyPromise = new Promise((resolve) => {
      execFile('xfconf-query', ['-c', 'xsettings', '-p', '/Gtk/FontName'],
        { env: xfconfEnv() }, (err, stdout) => {
          if (err) return resolve('Sans');
          const m = /^(.+?)\s+\d{1,3}$/.exec(String(stdout).trim());
          resolve(m ? m[1].trim() : 'Sans');
        });
    });
  }
  return fontFamilyPromise;
}

// xfconf-query needs the property's type to convert the value, and the wrong
// one is not a silent no-op: "-s 'Sans 12' -t int" fails the write outright
// ("cannot convert to gint"), which is how the font half of a request could
// fail while the DPI half went through. So every write names its type, and a
// font name names `string` even though that is what it would have been.
//
// Every write also creates the property when the channel does not have it yet.
// The xsettings channel is not a fixed schema: this image's /etc/xdg carries
// only the theme entries (install.sh writes that file and documents why), and
// xfsettingsd keeps its remaining defaults in memory rather than storing them,
// so /Gtk/FontName and /Xft/DPI exist only once something has set them. A
// write to a property that is not there is refused -- "the property does not
// exist in the channel, use --create" -- which is the other half of why this
// route used to answer 502 on a fresh desktop. --create needs the type named
// above: without one it refuses to create the property at all.
//
// The bus has to be the session's (see xfconfEnv) as well as the channel
// carrying the properties, or none of the above reaches the desktop.
function xfconfSet(property, value, type) {
  const args = [
    '-c', 'xsettings',
    '-p', property,
    '-s', String(value),
    '-t', type || 'string',
    '--create',
  ];
  return new Promise((resolve) => {
    execFile('xfconf-query', args, { env: xfconfEnv() }, (err, _stdout, stderr) => {
      // The reason a write failed is the whole diagnosis for a 502 here, and
      // nothing else surfaces it: xfconf-query reports it on stderr only.
      if (err) {
        console.error(`Appearance: xfconf-query failed for ${property}:`,
          String(stderr || err.message).trim());
      }
      resolve(!err);
    });
  });
}

// One batched read of the xsettings channel: the client modal opens with the
// desktop's current values, so a preference saved by another browser (or by
// the desktop itself) shows up as the selected segment.
function readXsettings() {
  return new Promise((resolve) => {
    execFile('xfconf-query', ['-c', 'xsettings', '-lv'],
      { env: xfconfEnv(), maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null);
        const out = {};
        for (const line of String(stdout).split('\n')) {
          const m = /^\s*(\S+)\s+(.*)$/.exec(line);
          if (m) out[m[1]] = m[2].trim();
        }
        resolve(out);
      });
  });
}

router.get('/appearance', async (_req, res) => {
  const settings = await readXsettings();
  if (!settings) {
    return res.status(503).json({ error: 'The desktop is not reachable to read its appearance' });
  }
  const dpi = parseInt(settings['/Xft/DPI'], 10);
  res.json({
    ok: true,
    fontName: settings['/Gtk/FontName'] || '',
    monospaceFontName: settings['/Gtk/MonospaceFontName'] || '',
    fontPointSize: fontPointSize(settings['/Gtk/FontName']),
    dpi: Number.isFinite(dpi) ? dpi : 96,
  });
});

// POST /api/desktop/appearance — see the note above; the validation here is
// what keeps a browser-supplied font name off the command line unchecked.
router.post('/appearance', async (req, res) => {
  const { fontName, dpi } = req.body || {};

  if (typeof fontName !== 'string' || !fontName.trim()) {
    return res.status(400).json({ error: 'A font name is required' });
  }
  const point = fontPointSize(fontName);
  if (point === null || !FONT_SIZES.includes(point)) {
    return res.status(400).json({
      error: `Unsupported font: the point size must be one of ${FONT_SIZES.join(', ')}`,
    });
  }
  const dpiNum = Number(dpi);
  if (!Number.isInteger(dpiNum) || dpiNum < DPI_MIN || dpiNum > DPI_MAX) {
    return res.status(400).json({ error: `DPI must be an integer between ${DPI_MIN} and ${DPI_MAX}` });
  }

  // A family change would be a different font, not a size; keep the desktop's
  // own.
  const family = await fontFamily();
  const name = `${family} ${point}`;
  const writes = [
    ['/Gtk/FontName', name],
    // Monospace follows the same size so terminals and editors scale with the
    // rest of the UI.
    ['/Gtk/MonospaceFontName', `Monospace ${point}`],
    ['/Xft/DPI', dpiNum, 'int'],
  ];
  const results = await Promise.all(writes.map(([p, v, t]) => xfconfSet(p, v, t)));
  if (results.some((okay) => !okay)) {
    return res.status(502).json({ error: 'The desktop refused the appearance change' });
  }
  res.json({ ok: true, fontName: name, dpi: dpiNum });
});

// POST /api/desktop/restart
//
// Restarts the pod. Both shipped images run this web client as the process the
// container runtime watches, so exiting is enough: entrypoint.sh waits on it
// and exits when it goes (Dockerfile.full), and in the web-client-only image
// it is PID 1 itself (Dockerfile.client). Kubernetes then starts the pod
// again. The response goes out first on purpose — exiting before it leaves the
// socket would reset the connection and look like a failure to the browser.
//
// The other modes do not come through here: with the desktop in a separate
// container the browser ends the session over VNC itself (restartMode()
// reports 'session'), and outside a container the deployment's command runs.
router.post('/restart', (_req, res) => {
  const mode = restartMode();

  if (mode === 'pod') {
    res.json({ ok: true, mode: 'pod' });
    res.on('finish', () => {
      // The short delay lets the response reach the browser before the
      // process disappears.
      setTimeout(() => {
        console.log('Restart requested: exiting so the container runtime restarts the pod.');
        process.exit(1);
      }, 300);
    });
    return;
  }

  if (mode === 'session') {
    // Restarting the desktop container is not something this process can do:
    // it is not the container being restarted and it cannot signal across the
    // container boundary. The browser has to do it through the session.
    return res.status(409).json({
      error: 'The desktop runs in a separate container; restart it from the session',
      mode: 'session',
    });
  }

  if (mode !== 'command') {
    return res.status(501).json({ error: 'Restart is not available for this deployment' });
  }

  exec(config.RESTART_CMD, { env: X_ENV }, (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to restart the desktop session' });
    }
    res.json({ ok: true, mode: 'command' });
  });
});

// POST /api/desktop/clipboard
//
// body.selection picks which X selection to write: 'clipboard' (the default)
// is what Ctrl+V reads in a text editor, 'primary' is what a terminal's
// Shift+Insert and a middle click read. The web client pushes both for a
// paste.
router.post('/clipboard', (req, res) => {
  const { text } = req.body;

  if (typeof text !== 'string') {
    return res.status(400).json({ error: 'Text required' });
  }

  const selection = req.body.selection === 'primary' ? 'primary' : 'clipboard';

  // Write to X clipboard using xclip.
  //
  // xclip forks a background process that owns the selection for as long as
  // the clipboard holds the text, and it inherits any inherited stdio. If we
  // wait for the 'close' event the request would never resolve, so we use
  // 'exit' and drop stdout/stderr.
  const proc = spawn('xclip', ['-selection', selection], {
    env: X_ENV,
    stdio: ['pipe', 'ignore', 'ignore'],
  });

  proc.stdin.write(text);
  proc.stdin.end();

  proc.on('exit', (code) => {
    if (code !== 0) {
      return res.status(500).json({ error: 'Failed to set clipboard' });
    }
    res.json({ ok: true });
  });

  proc.on('error', () => {
    res.status(500).json({ error: 'xclip not available' });
  });
});

// ── Clipboard: images ──────────────────────────────────────
//
// The X clipboard carries an image as a MIME-typed selection, not as text, so
// it needs a target the endpoint above cannot express: the bytes are handed to
// xclip with `-t image/png`, and X clients that paste an image ask the
// selection owner for exactly that target. PNG is the one type every paste
// target on the desktop reads -- Chromium, GTK, Qt and LibreOffice all request
// it -- which is why the browser re-encodes anything else before sending it
// here rather than advertising a type the application may not understand.
//
// CLIPBOARD alone. An image is pasted by a GUI toolkit or a browser, and both
// read CLIPBOARD; PRIMARY is the selection a terminal's Shift+Insert consumes
// as text. The client empties PRIMARY alongside this push so that chord cannot
// paste whatever text was selected before instead (see desktop.js).
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// POST /api/desktop/clipboard/image
//
// The body is the image itself, with Content-Type: image/png. A body that is
// not a PNG is refused rather than stored: the selection would advertise
// image/png and every application pasting it would fail to decode.
//
// The size cap is generous on purpose: a full-screen screenshot of a large
// display is easily tens of megabytes, and the file-upload endpoint next door
// already accepts 100MB. Anything over the cap is answered 413, which the
// client reports rather than swallowing (see desktop.js).
router.post('/clipboard/image',
  express.raw({ type: 'image/png', limit: '64mb' }),
  (req, res) => {
    const png = req.body;
    if (!Buffer.isBuffer(png) || png.length <= PNG_MAGIC.length ||
        !png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
      return res.status(400).json({ error: 'PNG data required' });
    }

    // Same shape as the text write below, and for the same reason: xclip forks
    // a background process that owns the selection, so 'exit' is the event that
    // means the data is in place -- waiting for 'close' would wait for the
    // owner to give the selection up.
    const proc = spawn('xclip', ['-selection', 'clipboard', '-t', 'image/png'], {
      env: X_ENV,
      stdio: ['pipe', 'ignore', 'ignore'],
    });

    proc.on('exit', (code) => {
      if (code !== 0) {
        return res.status(500).json({ error: 'Failed to set clipboard' });
      }
      res.json({ ok: true });
    });

    proc.on('error', () => {
      res.status(500).json({ error: 'xclip not available' });
    });

    // A multi-megabyte screenshot can outlive xclip's own exit, and the EPIPE
    // that follows must not take the process down.
    proc.stdin.on('error', () => {});
    proc.stdin.end(png);
  });

// GET /api/desktop/clipboard
//
// ?selection=primary reads the X PRIMARY selection instead of CLIPBOARD. The
// web client asks for it when the user presses Ctrl+C over a selection: the
// selection lives in PRIMARY, which is exactly the selection the VNC clipboard
// stream no longer carries now that Xtigervnc runs with -SendPrimary=0.
//
// Signatures of the image formats a selection realistically holds. `xclip -o`
// hands the owner's bytes over whatever target is asked for, so a selection
// that holds an image -- a region selected in GIMP lands in PRIMARY as a PNG,
// and the image endpoint above puts one in CLIPBOARD -- would otherwise be
// passed on as text. The client would then write megabytes of PNG into the
// browser clipboard as if it were a string, and the Ctrl+C path would decide
// it had copied something instead of replaying the keystroke. Answering with
// "nothing" is what makes those paths behave as if no text were selected.
const IMAGE_SIGNATURES = [
  PNG_MAGIC,                                  // PNG
  Buffer.from([0xff, 0xd8, 0xff]),            // JPEG
  Buffer.from('GIF87a', 'latin1'),            // GIF
  Buffer.from('GIF89a', 'latin1'),
  Buffer.from([0x49, 0x49, 0x2a, 0x00]),      // TIFF, little endian
  Buffer.from([0x4d, 0x4d, 0x00, 0x2a]),      // TIFF, big endian
];

function looksLikeImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  return IMAGE_SIGNATURES.some((sig) => buf.subarray(0, sig.length).equals(sig));
}

router.get('/clipboard', (req, res) => {
  const selection = req.query.selection === 'primary' ? 'primary' : 'clipboard';

  execFile('xclip', ['-selection', selection, '-o'], {
    env: X_ENV,
    // An owner that never answers must not hang the request: the client
    // replays Ctrl+C when this fails, and a hung request would hang that.
    timeout: 2000,
    encoding: 'buffer',
  }, (err, stdout) => {
    // The selections change constantly; a cached answer would replay a stale
    // selection -- or worse, a stale "nothing selected" verdict, which is
    // what decides whether Ctrl+C copies or interrupts.
    res.set('Cache-Control', 'no-store');
    if (err || looksLikeImage(stdout)) {
      return res.json({ text: '' });
    }
    res.json({ text: stdout.toString('utf8') });
  });
});

// POST /api/desktop/upload — file upload to ~/Desktop
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided' });
  }
  res.json({ ok: true, filename: req.file.filename, size: req.file.size });
});

// GET /api/desktop/download — serve file with Range support for pause/resume
// Supports ?file=/absolute/path (any allowed dir) or ?path=filename (Desktop/Downloads)
router.get('/download', (req, res) => {
  let filePath = null;

  if (req.query.file) {
    // Absolute path mode
    const clean = path.resolve(req.query.file.replace(/\0/g, ''));
    if (clean.startsWith('/proc') || clean.startsWith('/sys') || clean.startsWith('/dev')) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (fs.existsSync(clean) && fs.statSync(clean).isFile()) filePath = clean;
  } else if (req.query.path) {
    // Legacy basename mode (Desktop/Downloads lookup)
    const base = path.basename(req.query.path);
    if (!base || base === '.' || base === '..') {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const desktopPath = path.join(DESKTOP_DIR, base);
    const downloadsPath = path.join(DOWNLOADS_DIR, base);
    if (fs.existsSync(desktopPath)) filePath = desktopPath;
    else if (fs.existsSync(downloadsPath)) filePath = downloadsPath;
  } else {
    return res.status(400).json({ error: 'Missing file or path parameter' });
  }

  if (!filePath) {
    return res.status(404).json({ error: 'File not found' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const filename = path.basename(filePath);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    if (start >= fileSize || end >= fileSize || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
      return res.end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', end - start + 1);
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  }
});

// GET /api/desktop/files — list files in Desktop + Downloads
router.get('/files', (_req, res) => {
  const results = [];

  const readDir = (dir, label) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          try {
            const stat = fs.statSync(path.join(dir, entry.name));
            results.push({
              name: entry.name,
              location: label,
              size: stat.size,
              modified: stat.mtime,
            });
          } catch {
            // skip files we can't stat
          }
        }
      }
    } catch {
      // directory may not exist yet
    }
  };

  readDir(DESKTOP_DIR, 'Desktop');
  readDir(DOWNLOADS_DIR, 'Downloads');

  res.json({ files: results });
});

// GET /api/desktop/stats — CPU/RAM/disk usage
router.get('/stats', (_req, res) => {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  }
  const cpuPercent = Math.round(100 - (totalIdle / totalTick) * 100);

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);

  // Get disk usage via df
  exec('df -B1 / | tail -1', (err, stdout) => {
    let diskPercent = 0;
    if (!err && stdout) {
      const parts = stdout.trim().split(/\s+/);
      if (parts.length >= 5) {
        diskPercent = parseInt(parts[4], 10) || 0;
      }
    }

    res.json({
      cpu: cpuPercent,
      ram: memPercent,
      disk: diskPercent,
      totalMem: totalMem,
      freeMem: freeMem,
      user: os.userInfo().username,
    });
  });
});

// POST /api/desktop/launch — launch allowlisted app
router.post('/launch', (req, res) => {
  const { app } = req.body;

  if (!app || !ALLOWED_APPS[app]) {
    return res.status(400).json({
      error: 'Invalid app. Allowed: ' + Object.keys(ALLOWED_APPS).join(', '),
    });
  }

  const { cmd, args } = ALLOWED_APPS[app];

  const child = spawn(cmd, args, {
    env: X_ENV,
    detached: true,
    stdio: 'ignore',
    // Same reason as the dock's launcher: a terminal with no directory of its
    // own should open in the user's home, not in the server's cwd.
    ...(config.LAUNCH_CWD ? { cwd: config.LAUNCH_CWD } : {}),
  });

  child.unref();

  child.on('error', (err) => {
    return res.status(500).json({ error: `Failed to launch ${app}: ${err.message}` });
  });

  // Give it a moment to see if it fails immediately
  setTimeout(() => {
    res.json({ ok: true, app });
  }, 300);
});

// GET /api/desktop/windows — list open X11 windows
//
// Two wmctrl calls, correlated by window id: `-l -p` for pid + title (its
// column layout is unambiguous) and `-l -x` for the WM_CLASS, which is what
// ties a window back to the application that owns it for the dock's running
// indicators.
router.get('/windows', async (_req, res) => {
  const [basicOut, classOut] = await Promise.all([
    wmctrl(['-l', '-p']),
    wmctrl(['-l', '-x']),
  ]);
  const basic = basicOut || '';
  const withClass = classOut || '';

  // Titles first: they anchor the -x parse below.
  const titleById = new Map();
  const windows = [];
  for (const line of basic.trim().split('\n')) {
    if (!line) continue;
    // Format: 0x00c0002c  0  1234  hostname Title here
    const m = line.match(/^(0x[\da-f]+)\s+(-?\d+)\s+(\d+)\s+\S+\s+(.+)$/i);
    if (!m) continue;
    const desktop = parseInt(m[2], 10);
    const title = m[4].trim();
    // Skip the root desktop window and negative desktop entries
    if (desktop < 0 || title === 'Desktop') continue;
    titleById.set(m[1].toLowerCase(), title);
    windows.push({ id: m[1], pid: parseInt(m[3], 10), title, wmClass: null, appId: null });
  }

  const classById = new Map();
  for (const line of withClass.split('\n')) {
    const idm = line.match(/^(0x[\da-f]+)\s/i);
    if (!idm) continue;
    const id = idm[1].toLowerCase();

    // wmctrl prints the WM_CLASS as `instance.Class` right before the
    // title. With the title known from the -p parse, the class token is
    // simply the last token ahead of it — which also survives builds that
    // drop the hostname column.
    const title = titleById.get(id);
    let wmClass = null;
    if (title && line.endsWith(title)) {
      const head = line.slice(0, line.length - title.length).trim().split(/\s+/);
      const cand = head[head.length - 1];
      if (cand && cand.includes('.') && !/^-?\d+$/.test(cand)) wmClass = cand;
    }
    if (!wmClass) {
      // Fallback to the canonical column layout: id desktop host class title
      const m = line.match(/^(0x[\da-f]+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(.*)$/i);
      if (m) wmClass = /\./.test(m[4]) ? m[4] : (/\./.test(m[3]) ? m[3] : null);
    }
    if (wmClass) classById.set(id, wmClass);
  }

  for (const win of windows) {
    win.wmClass = classById.get(win.id.toLowerCase()) || null;
    win.appId = apps.matchWindow({ wmClass: win.wmClass, pid: win.pid, title: win.title }) || null;
  }

  res.json({ windows });
});

// POST /api/desktop/windows/focus — raise and focus a window
router.post('/windows/focus', (req, res) => {
  const { id } = req.body;
  if (!id || typeof id !== 'string' || !/^0x[\da-f]+$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid window id' });
  }
  execFile('wmctrl', ['-i', '-a', id], { env: X_ENV }, (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to focus window' });
    }
    res.json({ ok: true });
  });
});

// POST /api/desktop/windows/close — ask a window to close (graceful, like
// its own close button: the WM gets a _NET_CLOSE_WINDOW, the app may still
// show an "unsaved work" dialog).
router.post('/windows/close', (req, res) => {
  const { id } = req.body;
  if (!id || typeof id !== 'string' || !/^0x[\da-f]+$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid window id' });
  }
  execFile('wmctrl', ['-i', '-c', id], { env: X_ENV }, (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to close window' });
    }
    res.json({ ok: true });
  });
});

// POST /api/desktop/windows/minimize — iconify a window
//
// _NET_WM_STATE_HIDDEN is the state the WM sets on an iconified window, and
// xfwm4 accepts it from a client too (wmctrl -b add,hidden), so no separate
// "restore" route is needed: /windows/focus raises and focuses the window,
// which clears the flag and brings it back.
router.post('/windows/minimize', (req, res) => {
  const { id } = req.body;
  if (!id || typeof id !== 'string' || !/^0x[\da-f]+$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid window id' });
  }
  execFile('wmctrl', ['-i', '-r', id, '-b', 'add,hidden'], { env: X_ENV }, (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to minimize window' });
    }
    res.json({ ok: true });
  });
});

// The frame extents (left, right, top, bottom) plus the flags that mean
// "leave this one alone", in one xprop call. A window that has gone away
// since the listing answers nothing, which reads as the same skip.
//
// The extents matter because the two wmctrl calls disagree about what a
// coordinate refers to: `-l -G` reports the client origin shifted by the
// frame, while `-e` takes the frame origin. For xfwm4 a decorated window has
// extents like 2,2,34,2 — the 34 is the title bar — so working in client
// coordinates without this would push the title bar off the top of the screen.
function windowFrame(id) {
  return new Promise((resolve) => {
    execFile('xprop',
      ['-id', id, '_NET_FRAME_EXTENTS', '_NET_WM_STATE', '_NET_WM_WINDOW_TYPE'],
      { env: X_ENV }, (err, stdout) => {
        if (err) return resolve(null);
        const out = String(stdout);
        const ext = out.match(
          /_NET_FRAME_EXTENTS\(CARDINAL\)\s*=\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/);
        resolve({
          el: ext ? +ext[1] : 0,
          er: ext ? +ext[2] : 0,
          et: ext ? +ext[3] : 0,
          eb: ext ? +ext[4] : 0,
          // A maximized or fullscreen window is the window manager's to place,
          // and it already tracks the work area; resizing one would only fight
          // it. Docks and the desktop itself are not windows the user moves.
          skip: /_NET_WM_STATE_(MAXIMIZED_VERT|MAXIMIZED_HORZ|FULLSCREEN)\b/.test(out)
            || /_NET_WM_WINDOW_TYPE_(DOCK|DESKTOP)\b/.test(out),
        });
      });
  });
}

// POST /api/desktop/windows/fit — bring every window that hangs off the edge
// of the screen back inside the work area, shrinking the ones that are larger
// than it.
//
// This is what repairs the desktop after the resolution drops: windows that
// were placed for a bigger screen keep their old geometry and disappear past
// the new edges. The target box is the current desktop's work area from
// `wmctrl -d` (its WA column), which already excludes the top panel and any
// other strut, rather than the raw screen size.
router.post('/windows/fit', async (_req, res) => {
  const [desktopsOut, listingOut] = await Promise.all([
    wmctrl(['-d']),
    wmctrl(['-l', '-G']),
  ]);

  // `0 * DG: 1912x914  VP: 0,0  WA: 0,27 1912x887  Workspace 1` — the starred
  // line is the desktop in use; every desktop carries the same work area, so
  // the first line is a safe fallback when none is marked.
  const lines = (desktopsOut || '').split('\n');
  const current = lines.find((l) => l.includes('*')) || lines[0] || '';
  const box = current.match(/WA:\s*(-?\d+),(-?\d+)\s+(\d+)x(\d+)/);
  if (!box) {
    return res.status(500).json({ error: 'Could not read the desktop work area' });
  }
  const wa = { x: +box[1], y: +box[2], w: +box[3], h: +box[4] };

  if (listingOut === null) {
    return res.status(500).json({ error: 'Could not list the open windows' });
  }

  // `0x02400003  0 4 95 819 486 host title` — geometry and title together, so
  // the parse does not need the separate `-l -p` pass.
  const windows = [];
  for (const line of listingOut.split('\n')) {
    const m = line.match(
      /^(0x[\da-f]+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s*(.*)$/i);
    if (!m) continue;
    // Sticky windows (desktop -1) are the panel, the desktop background and
    // other furniture, exactly the set /windows already leaves out.
    if (parseInt(m[2], 10) < 0) continue;
    if (m[7].trim() === 'Desktop') continue;
    windows.push({ id: m[1], x: +m[3], y: +m[4], w: +m[5], h: +m[6] });
  }

  const moved = [];
  await Promise.all(windows.map(async (win) => {
    const ext = await windowFrame(win.id);
    if (!ext || ext.skip) return;

    // Frame rect in root coordinates: the client's reported origin minus the
    // frame it is wrapped in, and the client size plus that frame.
    const fx = win.x - 2 * ext.el;
    const fy = win.y - 2 * ext.et;
    const fw = win.w + ext.el + ext.er;
    const fh = win.h + ext.et + ext.eb;

    // Entirely inside the work area: the common answer, and the reason the
    // response is almost always "0 moved".
    if (fx >= wa.x && fy >= wa.y &&
        fx + fw <= wa.x + wa.w && fy + fh <= wa.y + wa.h) {
      return;
    }

    const nw = Math.min(fw, wa.w);
    const nh = Math.min(fh, wa.h);
    const nx = Math.min(Math.max(fx, wa.x), wa.x + wa.w - nw);
    const ny = Math.min(Math.max(fy, wa.y), wa.y + wa.h - nh);

    // `-e` wants the frame origin and the client size, so the new frame size
    // is reduced by the extents again; the lower bound only guards against a
    // frame taller or wider than the whole work area.
    const cw = Math.max(1, nw - ext.el - ext.er);
    const ch = Math.max(1, nh - ext.et - ext.eb);

    if (await wmctrl(['-i', '-r', win.id, '-e', `0,${nx},${ny},${cw},${ch}`]) !== null) {
      moved.push({ id: win.id, x: nx, y: ny, width: cw, height: ch });
    }
  }));

  res.json({ ok: true, total: windows.length, moved: moved.length, windows: moved });
});

// ── Chunked Upload Endpoints ───────────────────────────────

// POST /api/desktop/upload/init — start chunked upload
router.post('/upload/init', (req, res) => {
  const { filename, totalSize, destination } = req.body;
  if (!filename || !totalSize || totalSize <= 0) {
    return res.status(400).json({ error: 'filename and totalSize required' });
  }
  let safeName = filename.replace(/[/\\]/g, '_').replace(/\0/g, '').replace(/^\.+/, '');
  if (!safeName) safeName = 'upload';
  const destDir = sanitizeDestDir(destination);
  const uploadId = crypto.randomBytes(16).toString('hex');
  const tempPath = path.join(UPLOAD_TEMP_DIR, uploadId);
  const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);

  activeUploads.set(uploadId, {
    id: uploadId, filename: safeName, totalSize,
    bytesReceived: 0, totalChunks, chunksReceived: 0,
    destination: destDir, tempPath,
    status: 'uploading', startedAt: Date.now(), lastActivity: Date.now(),
  });

  fs.writeFileSync(tempPath, Buffer.alloc(0));
  res.json({ uploadId, chunkSize: CHUNK_SIZE, totalChunks });
});

// POST /api/desktop/upload/chunk?uploadId=X — receive one chunk (raw binary)
router.post('/upload/chunk',
  express.raw({ type: 'application/octet-stream', limit: '6mb' }),
  (req, res) => {
    const up = activeUploads.get(req.query.uploadId);
    if (!up) return res.status(404).json({ error: 'Upload not found' });
    if (up.status === 'cancelled') return res.status(410).json({ error: 'Cancelled' });
    const chunk = req.body;
    if (!Buffer.isBuffer(chunk) || !chunk.length) {
      return res.status(400).json({ error: 'Empty chunk' });
    }
    try {
      fs.appendFileSync(up.tempPath, chunk);
      up.bytesReceived += chunk.length;
      up.chunksReceived++;
      up.lastActivity = Date.now();

      if (up.bytesReceived >= up.totalSize) {
        fs.mkdirSync(up.destination, { recursive: true });
        let finalName = up.filename;
        let target = path.join(up.destination, finalName);
        if (fs.existsSync(target)) {
          const ext = path.extname(finalName);
          const base = path.basename(finalName, ext);
          let i = 1;
          while (fs.existsSync(target)) {
            finalName = `${base} (${i})${ext}`;
            target = path.join(up.destination, finalName);
            i++;
          }
        }
        try { fs.renameSync(up.tempPath, target); }
        catch { fs.copyFileSync(up.tempPath, target); fs.unlinkSync(up.tempPath); }
        up.status = 'completed';
        activeUploads.delete(up.id);
        return res.json({ ok: true, completed: true, filename: finalName });
      }
      res.json({ ok: true, bytesReceived: up.bytesReceived, chunksReceived: up.chunksReceived });
    } catch {
      up.status = 'error';
      res.status(500).json({ error: 'Write failed' });
    }
  });

// POST /api/desktop/upload/pause
router.post('/upload/pause', (req, res) => {
  const up = activeUploads.get(req.body.uploadId);
  if (!up) return res.status(404).json({ error: 'Not found' });
  up.status = 'paused';
  up.lastActivity = Date.now();
  res.json({ ok: true });
});

// POST /api/desktop/upload/resume — returns progress so client can resume
router.post('/upload/resume', (req, res) => {
  const up = activeUploads.get(req.body.uploadId);
  if (!up) return res.status(404).json({ error: 'Not found' });
  up.status = 'uploading';
  up.lastActivity = Date.now();
  res.json({ ok: true, bytesReceived: up.bytesReceived, chunksReceived: up.chunksReceived });
});

// DELETE /api/desktop/upload/:uploadId — cancel and cleanup
router.delete('/upload/:uploadId', (req, res) => {
  const up = activeUploads.get(req.params.uploadId);
  if (up) {
    up.status = 'cancelled';
    try { fs.unlinkSync(up.tempPath); } catch {}
    activeUploads.delete(req.params.uploadId);
  }
  res.json({ ok: true });
});

// GET /api/desktop/upload/active — list active uploads
router.get('/upload/active', (_req, res) => {
  const list = [];
  for (const up of activeUploads.values()) {
    list.push({
      id: up.id, filename: up.filename, totalSize: up.totalSize,
      bytesReceived: up.bytesReceived, status: up.status, destination: up.destination,
    });
  }
  res.json({ uploads: list });
});

// POST /api/desktop/rename — rename a file or directory
router.post('/rename', (req, res) => {
  const { oldPath, newName } = req.body;
  if (!oldPath || !newName || typeof oldPath !== 'string' || typeof newName !== 'string') {
    return res.status(400).json({ error: 'oldPath and newName required' });
  }
  const clean = path.resolve(oldPath.replace(/\0/g, ''));
  if (clean.startsWith('/proc') || clean.startsWith('/sys') || clean.startsWith('/dev')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  // Sanitize new name
  const safeName = newName.replace(/[/\\]/g, '_').replace(/\0/g, '').trim();
  if (!safeName || safeName === '.' || safeName === '..') {
    return res.status(400).json({ error: 'Invalid name' });
  }
  const newPath = path.join(path.dirname(clean), safeName);
  if (!fs.existsSync(clean)) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (fs.existsSync(newPath)) {
    return res.status(409).json({ error: 'Name already exists' });
  }
  try {
    fs.renameSync(clean, newPath);
    res.json({ ok: true, newPath });
  } catch {
    res.status(500).json({ error: 'Rename failed' });
  }
});

// GET /api/desktop/browse — directory listing; ?files=true to include files
router.get('/browse', (req, res) => {
  const dir = req.query.dir || RUN_HOME;
  const includeFiles = req.query.files === 'true';
  const clean = path.resolve(dir.replace(/\0/g, ''));
  try {
    const entries = fs.readdirSync(clean, { withFileTypes: true });
    const dirs = entries
      .filter(e => {
        if (e.name.startsWith('.')) return false;
        try { fs.accessSync(path.join(clean, e.name), fs.constants.R_OK); return e.isDirectory(); }
        catch { return false; }
      })
      .map(e => ({ name: e.name, path: path.join(clean, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const result = { current: clean, parent: path.dirname(clean), directories: dirs };
    if (includeFiles) {
      result.files = entries
        .filter(e => e.isFile() && !e.name.startsWith('.'))
        .map(e => {
          try {
            const s = fs.statSync(path.join(clean, e.name));
            return { name: e.name, path: path.join(clean, e.name), size: s.size, modified: s.mtime };
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    res.json(result);
  } catch {
    res.status(404).json({ error: 'Directory not found' });
  }
});

module.exports = router;
