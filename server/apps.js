// Application registry for the web client's app dock.
//
// The dock lives in the browser (it replaced the Plank dock the desktop
// images used to ship), so this module is what stands in for a desktop
// shell on the server side: it enumerates installed applications from XDG
// .desktop entries, resolves their icons, launches them on the session
// display and matches open X11 windows back to the application that owns
// them.
//
// Launching is bounded by the desktop's own launchers: the only thing the
// client can name is the id of an installed .desktop file, and the command
// that runs is that file's Exec= line — never an arbitrary command sent
// from the browser.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');

// Same X environment the other route handlers run their helpers with.
const X_ENV = {
  ...process.env,
  DISPLAY: config.DISPLAY,
  XAUTHORITY: config.XAUTHORITY,
  HOME: config.HOME_DIR,
};

// Re-scan at most this often; the package set of an image is static but
// apps the user installs at runtime (~/.local, flatpak) should appear
// without a restart.
const SCAN_TTL = 5 * 60 * 1000;

// ── XDG lookups ─────────────────────────────────────────────

function dataHome() {
  return process.env.XDG_DATA_HOME || path.join(config.HOME_DIR, '.local', 'share');
}

function appDirs() {
  const dirs = [
    // User entries shadow the system ones, so they are scanned first and
    // win the id collision below.
    path.join(dataHome(), 'applications'),
    path.join(dataHome(), 'flatpak', 'exports', 'share', 'applications'),
    '/var/lib/flatpak/exports/share/applications',
  ];
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':');
  for (const d of dataDirs) {
    if (d) dirs.push(path.join(d, 'applications'));
  }
  return [...new Set(dirs)];
}

// Icon search roots: the user's overrides first, then the XDG data dirs
// (which is where a distro image keeps its themes), then the legacy
// pixmaps directory.
function iconBaseDirs() {
  const dirs = [
    path.join(config.HOME_DIR, '.icons'),
    path.join(dataHome(), 'icons'),
  ];
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':');
  for (const d of dataDirs) {
    if (d) dirs.push(path.join(d, 'icons'));
  }
  return [...new Set(dirs)];
}

function pixmapDirs() {
  const dirs = [path.join(dataHome(), 'pixmaps')];
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':');
  for (const d of dataDirs) {
    if (d) dirs.push(path.join(d, 'pixmaps'));
  }
  return [...new Set(dirs)];
}

// The icon theme the desktop itself uses (install.sh writes it into the
// xfconf xsettings channel). Matching it keeps the dock's icons consistent
// with the desktop's own menus; hicolor is the universal fallback.
function desktopIconTheme() {
  try {
    const file = '/etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xsettings.xml';
    const xml = fs.readFileSync(file, 'utf8');
    // <property name="IconThemeName" type="string" value="Tela"/>
    const m = xml.match(/name="IconThemeName"[^>]*value="([^"]+)"/);
    if (m && m[1] && /^[\w.-]+$/.test(m[1])) return m[1];
  } catch { /* no xfconf default — fall through */ }
  return '';
}

// ── .desktop parsing ────────────────────────────────────────

// Reads the [Desktop Entry] section (Desktop Actions are ignored) into a
// flat object with lower-cased keys. Localized keys (`Name[de]=…`) are
// dropped; the generic entry is what the dock shows.
function parseDesktopEntry(content) {
  const entry = {};
  let inEntry = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]';
      continue;
    }
    if (!inEntry) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key.includes('[')) continue; // localized variant
    const value = line.slice(eq + 1).trim();
    if (!(key.toLowerCase() in entry)) entry[key.toLowerCase()] = value;
  }
  return entry;
}

const truthy = (v) => /^(true|1)$/i.test(String(v || '').trim());

// Split an Exec= line into argv the way the Desktop Entry spec prescribes:
// whitespace-separated, single/double quoting, backslash escapes for the
// reserved characters, field codes dropped (we always launch without a
// document) and %% unescaped to a literal %.
function splitExec(exec) {
  const argv = [];
  let cur = '';
  let has = false;
  let inSingle = false;
  let inDouble = false;
  const push = () => { if (has) argv.push(cur); cur = ''; has = false; };
  const escaped = (next) => '\\$"`'.includes(next);

  for (let i = 0; i < exec.length; i++) {
    const c = exec[i];
    if (inSingle) {
      if (c === "'") inSingle = false; else cur += c;
      continue;
    }
    if (inDouble) {
      if (c === '"') { inDouble = false; continue; }
      if (c === '\\' && escaped(exec[i + 1])) { cur += exec[i + 1]; i++; continue; }
      cur += c;
      continue;
    }
    if (c === "'") { inSingle = true; has = true; continue; }
    if (c === '"') { inDouble = true; has = true; continue; }
    if (c === '\\' && escaped(exec[i + 1])) { cur += exec[i + 1]; i++; has = true; continue; }
    if (/\s/.test(c)) { push(); continue; }
    cur += c;
    has = true;
  }
  push();

  return argv
    .map((a) => a
      .replace(/%%/g, '\u0000')
      .replace(/%[fFuUdDnNickvm]/g, '')
      .replace(/\u0000/g, '%'))
    .filter((a) => a !== '');
}

function whichSync(cmd) {
  if (!cmd) return null;
  if (cmd.includes('/')) {
    try { fs.accessSync(cmd, fs.constants.X_OK); return cmd; } catch { return null; }
  }
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const full = path.join(dir, cmd);
    try { fs.accessSync(full, fs.constants.X_OK); return full; } catch { /* keep looking */ }
  }
  return null;
}

// ── Registry ────────────────────────────────────────────────

let cache = null;   // { list, byId, byStartupWMClass, byExecName }
let cacheAt = 0;
let iconTheme = null; // resolved once

function scanApps(force = false) {
  if (!force && cache && Date.now() - cacheAt < SCAN_TTL) return cache;

  const byId = new Map();
  for (const dir of appDirs()) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.desktop') || byId.has(name)) continue;
      let content;
      try { content = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
      const e = parseDesktopEntry(content);

      if (e.type && e.type.toLowerCase() !== 'application') continue;
      if (truthy(e.nodisplay) || truthy(e.hidden)) continue;
      if (!e.exec) continue;
      if (e.tryexec && !whichSync(e.tryexec.trim())) continue;

      const argv = splitExec(e.exec);
      if (!argv.length) continue;

      byId.set(name, {
        id: name,
        name: (e.name || name.replace(/\.desktop$/, '')).trim(),
        comment: (e.comment || '').trim().slice(0, 160),
        exec: e.exec,
        argv,
        execName: path.basename(argv[0]).toLowerCase(),
        icon: (e.icon || '').trim(),
        terminal: truthy(e.terminal),
        wdPath: (e.path || '').trim(),
        startupWMClass: (e.startupwmclass || '').trim(),
      });
    }
  }

  const list = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));

  const byStartupWMClass = new Map();
  const byExecName = new Map();
  for (const app of list) {
    const wm = app.startupWMClass.toLowerCase();
    if (wm && !byStartupWMClass.has(wm)) byStartupWMClass.set(wm, app.id);
    if (app.execName && !byExecName.has(app.execName)) byExecName.set(app.execName, app.id);
  }

  iconCache.clear();
  cache = { list, byId, byStartupWMClass, byExecName };
  cacheAt = Date.now();
  return cache;
}

function listApps(fresh = false) {
  const { list } = scanApps(fresh);
  return list.map((a) => ({ id: a.id, name: a.name, comment: a.comment }));
}

function getApp(id) {
  return scanApps().byId.get(id) || null;
}

// ── Icons ───────────────────────────────────────────────────

// id+size → absolute file path, so a resolved icon survives repeated polls.
const iconCache = new Map();

// Every candidate file for an icon name, as {file, size}. `size` is the
// rendered width the theme directory advertises (scalable → large).
function iconCandidates(name) {
  const out = [];
  const push = (file, size) => { try { fs.accessSync(file, fs.constants.R_OK); out.push({ file, size }); } catch { /* missing */ } };

  if (iconTheme === null) iconTheme = desktopIconTheme();
  // The desktop's own theme first, then hicolor (which every theme
  // inherits from), then whatever else is installed anywhere on the
  // search path.
  const themes = [...new Set([
    iconTheme,
    'hicolor',
    'Adwaita',
    ...iconBaseDirs().flatMap((base) => safeReaddir(base)),
  ])].filter(Boolean);

  for (const base of iconBaseDirs()) {
    for (const theme of themes) {
      const themeDir = path.join(base, theme);
      for (const sizeDir of safeReaddir(themeDir)) {
        const size = parseSizeDir(sizeDir);
        if (size === null) continue;
        for (const ext of ['svg', 'png', 'xpm']) {
          push(path.join(themeDir, sizeDir, 'apps', `${name}.${ext}`), size);
        }
      }
    }
  }

  // Legacy pixmaps directory: flat files, no size information.
  for (const pixdir of pixmapDirs()) {
    for (const ext of ['png', 'svg', 'xpm']) {
      push(path.join(pixdir, `${name}.${ext}`), 48);
    }
  }

  return out;
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function parseSizeDir(name) {
  if (name === 'scalable') return 512;
  const m = name.match(/^(\d+)x\d+$/);
  return m ? parseInt(m[1], 10) : null;
}

const EXT_ORDER = { '.svg': 0, '.png': 1, '.xpm': 2 };

// Closest size at or above the request wins; below that, the largest
// available. SVG beats raster at equal score because it renders crisp at
// any size the client asks for.
function pickIcon(candidates, requested) {
  if (!candidates.length) return null;
  const score = (c) => {
    const size = c.size >= 512 ? requested + 0.5 : Math.abs(c.size - requested);
    return size + ((EXT_ORDER[path.extname(c.file).toLowerCase()] ?? 9) / 100);
  };
  candidates.sort((a, b) => score(a) - score(b));
  return candidates[0].file;
}

function iconFile(id, size = 48) {
  const key = `${id}:${size}`;
  if (iconCache.has(key)) return iconCache.get(key);

  let result = null;
  const app = getApp(id);
  if (app && app.icon) {
    if (app.icon.startsWith('/')) {
      try { fs.accessSync(app.icon, fs.constants.R_OK); result = app.icon; } catch { /* gone */ }
    } else {
      result = pickIcon(iconCandidates(app.icon), size);
    }
  }
  iconCache.set(key, result);
  return result;
}

// ── Launching ───────────────────────────────────────────────

function launchApp(id) {
  const app = getApp(id);
  if (!app) return Promise.reject(new Error(`Unknown application: ${id}`));

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };

    const run = (cmd, args) => {
      const opts = { env: X_ENV, detached: true, stdio: 'ignore' };
      if (app.wdPath && fs.existsSync(app.wdPath)) opts.cwd = app.wdPath;
      const child = spawn(cmd, args, opts);
      child.on('error', done);
      child.unref();
      // A GUI command that starts fine resolves via the timeout; only an
      // immediate spawn failure (ENOENT…) rejects.
      setTimeout(done, 400);
    };

    // gtk-launch (ships with GTK3, which the whole desktop depends on)
    // applies the .desktop file's own rules: working directory, terminal
    // wrapping and field codes. The manual path below is the fallback for
    // images where it is absent.
    if (whichSync('gtk-launch')) {
      run('gtk-launch', [id.replace(/\.desktop$/, '')]);
      return;
    }

    let cmd = app.argv[0];
    let args = app.argv.slice(1);
    if (app.terminal) {
      const term = whichSync('xfce4-terminal');
      if (term) {
        args = ['-x', cmd, ...args];
        cmd = term;
      }
    }
    run(cmd, args);
  });
}

// ── Window → application matching ───────────────────────────

// Best-effort name of the process behind a window pid: the exe symlink
// first, then comm, then argv[0].
function processName(pid) {
  if (!pid || !Number.isFinite(pid)) return null;
  try { return path.basename(fs.readlinkSync(`/proc/${pid}/exe`)).toLowerCase(); } catch { /* next */ }
  try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim().toLowerCase(); } catch { /* next */ }
  try {
    const argv0 = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0];
    return argv0 ? path.basename(argv0).toLowerCase() : null;
  } catch { return null; }
}

// Match a window ({wmClass: "instance.Class", pid, title}) to an app id.
// Exact tiers first — StartupWMClass, then the Exec basename, then the
// process image name — and only after that a substring pass, which is what
// catches renamed binaries (gnome-terminal-server vs gnome-terminal).
function matchWindow(win) {
  const { byStartupWMClass, byExecName } = scanApps();

  const parts = [];
  if (win.wmClass) {
    for (const p of String(win.wmClass).split('.')) {
      if (p) parts.push(p.toLowerCase());
    }
  }

  for (const p of parts) {
    const hit = byStartupWMClass.get(p);
    if (hit) return hit;
  }
  for (const p of parts) {
    const hit = byExecName.get(p);
    if (hit) return hit;
  }

  const pname = processName(win.pid);
  if (pname) {
    const hit = byExecName.get(pname);
    if (hit) return hit;
  }

  for (const p of parts) {
    if (p.length < 4) continue;
    for (const [name, id] of byExecName) {
      if (name.length < 4) continue;
      if (p.includes(name) || name.includes(p)) return id;
    }
  }

  return null;
}

// ── Default pins ────────────────────────────────────────────

// Used the first time a browser opens the dock and no pins have been saved
// yet: a small, ordered set of what this image actually ships. Unpinning
// is one right-click away, and once the client saves its own list this
// never runs again.
const PIN_SEED_MATCHERS = [
  ['terminal', ['xfce4-terminal', 'gnome-terminal', 'konsole', 'xterm']],
  ['files', ['thunar', 'nautilus', 'pcmanfm', 'dolphin']],
  ['browser', ['google-chrome', 'chromium', 'firefox']],
  ['code', ['code', 'code-oss', 'vscodium']],
  ['packages', ['synaptic']],
];

function defaultPins() {
  const { list, byId } = scanApps();
  const byExec = new Map(list.map((a) => [a.execName, a.id]));

  // An application's main entry carries the shortest .desktop id of the
  // family ("thunar.desktop" vs "thunar-bulk-rename.desktop"), and usually
  // the exact `<binary>.desktop` id — so exact beats exec-name beats
  // substring, and substring prefers the shortest id.
  const pickFor = (key) => {
    const exact = `${key}.desktop`;
    if (byId.has(exact)) return exact;
    if (byExec.has(key)) return byExec.get(key);
    const candidates = list
      .filter((a) => a.id.toLowerCase().includes(key) || a.name.toLowerCase().includes(key))
      .sort((a, b) => a.id.length - b.id.length);
    return candidates.length ? candidates[0].id : null;
  };

  const pins = [];
  for (const [, keys] of PIN_SEED_MATCHERS) {
    if (pins.length >= 6) break;
    for (const key of keys) {
      const id = pickFor(key);
      if (id && !pins.includes(id)) {
        pins.push(id);
        break;
      }
    }
  }
  return pins;
}

module.exports = {
  listApps,
  getApp,
  iconFile,
  launchApp,
  matchWindow,
  defaultPins,
  // exported for tests
  parseDesktopEntry,
  splitExec,
};
