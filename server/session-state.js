// Desktop session state: save what is open, put it back later.
//
// A pod restart takes the desktop with it. $HOME survives one only when the
// deployment mounted a persistent root (ROOT_PERSIST_DIR), and even then an
// XFCE session does not come back by itself: the applications, the terminals
// and the browser tabs are gone. This module captures enough of a running
// session to rebuild it, into one small JSON file, and replays that file.
//
// What is captured, and how far the promise goes:
//
//   * Windows       wmctrl's window list, reduced to the ones a user opened:
//                   the class, the title, the workspace, the geometry and, via
//                   the app registry, the .desktop entry that owns them.
//   * Terminals     the shell behind each terminal window, its working
//                   directory and the command running in it (from /proc, not
//                   from the terminal's memory, which is not readable).
//   * Browsers      the open tabs, read out of the browser's own session store
//                   (see browser-session.js). Chrome reinstates its own
//                   history on top of the URLs it is given; Firefox opens the
//                   URLs.
//   * Clipboard     the X clipboard text.
//
// What it deliberately does not do: it never re-runs a shell command by
// default (a captured `rm -rf` should not replay itself on a restart — that is
// an opt-in flag), it does not restore scrollback or back/forward history, and
// it does not restore unsaved document contents. Those live in the processes
// that owned them and are gone with them.
//
// The file is written atomically to $HOME/.config/clouddesktop/session-state.json,
// next to the dock pins. When $HOME does not survive the restart the file can
// be downloaded and uploaded again from the client; nothing about the format
// depends on the machine that wrote it beyond the paths in it.

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const config = require('./config');
const apps = require('./apps');
const browserSession = require('./browser-session');

const execFileP = promisify(execFile);

// The X environment every helper below runs with: the session display and the
// authority file Xtigervnc wrote.
const X_ENV = {
  ...process.env,
  DISPLAY: config.DISPLAY,
  XAUTHORITY: config.XAUTHORITY,
  HOME: config.HOME_DIR,
};

const STATE_VERSION = 1;
const STATE_DIR = path.join(config.HOME_DIR, '.config', 'clouddesktop');
const STATE_FILE = path.join(STATE_DIR, 'session-state.json');

// Caps: a snapshot is a convenience, not a backup. Beyond these the file stops
// being something a person would want replayed on a restart.
const MAX_WINDOWS = 40;
const MAX_TABS_PER_WINDOW = 50;

// Windows that are part of the desktop furniture rather than something the
// user opened. The dock's own window list skips the same ones (a negative
// desktop, or the desktop window itself) by title, which is localized, so the
// class is the reliable test here.
const FURNITURE_WMCLASS = /^(xfce4-panel|xfdesktop|xfce4-notifyd|xfce4-screenshooter|plank|tint2|polybar|feh|nitrogen)\b/i;

// Shells that a terminal window may be running. The first one found behind a
// terminal window is what holds the working directory to restore.
const SHELLS = /^(bash|sh|dash|zsh|fish|ksh|tcsh|csh|elvish|nu)$/;

// Which terminal binaries accept a starting directory, and how. The image
// ships xfce4-terminal; the others are here so a snapshot taken in one image
// still restores sensibly in another.
const TERMINAL_CWD_FLAG = {
  'xfce4-terminal': '--working-directory',
  'gnome-terminal': '--working-directory',
  'xfce4-terminal-emulator': '--working-directory',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Small helpers around the X tools ────────────────────────

async function run(cmd, args) {
  try {
    const { stdout } = await execFileP(cmd, args, { env: X_ENV, maxBuffer: 4 * 1024 * 1024 });
    return String(stdout);
  } catch {
    return ''; // a missing tool is a missing feature here, never an error
  }
}

function safeReadlink(file) {
  try { return fs.readlinkSync(file); } catch { return null; }
}

function safeReadFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// wmctrl -l -p -x -G, one call for everything:
//   id  desktop  pid  x  y  w  h  wm_class  host  title
// The geometry columns are what -G adds; the class column is what -x adds.
async function listWindows() {
  const out = await run('wmctrl', ['-l', '-p', '-x', '-G']);
  const windows = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^(0x[\da-f]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/i);
    if (!m) continue;
    const win = {
      id: m[1],
      workspace: parseInt(m[2], 10),
      pid: parseInt(m[3], 10),
      geometry: {
        x: parseInt(m[4], 10),
        y: parseInt(m[5], 10),
        width: parseInt(m[6], 10),
        height: parseInt(m[7], 10),
      },
      wmClass: m[8],
      title: m[10].trim(),
    };
    win.appId = apps.matchWindow({ wmClass: win.wmClass, pid: win.pid, title: win.title }) || null;
    windows.push(win);
  }
  return windows;
}

// The current mode of the connection the session runs on, as the resolution
// modal would set it. Purely informational in a snapshot: a restore does not
// change the display size.
async function screenSize() {
  const out = await run('xrandr', ['--current']);
  for (const line of out.split('\n')) {
    const m = line.match(/^\s+(\d+)x(\d+)\s+[\d.]+\*/);
    if (m) return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
  }
  return null;
}

async function readClipboard() {
  try {
    const { stdout } = await execFileP('xclip', ['-selection', 'clipboard', '-o'], { env: X_ENV });
    return String(stdout);
  } catch {
    return ''; // empty selection: xclip exits non-zero
  }
}

async function writeClipboard(text) {
  if (typeof text !== 'string' || !text) return false;
  return new Promise((resolve) => {
    const proc = spawn('xclip', ['-selection', 'clipboard'], {
      env: X_ENV,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    proc.on('error', () => resolve(false));
    // xclip forks a process that owns the selection and inherits stdio, so the
    // request is done at 'exit', not 'close'.
    proc.on('exit', (code) => resolve(code === 0));
    proc.stdin.on('error', () => resolve(false));
    proc.stdin.end(text);
  });
}

// ── Processes behind a terminal window ──────────────────────

function commOf(pid) {
  const raw = safeReadFile(`/proc/${pid}/comm`);
  return raw ? raw.trim() : null;
}

function cmdlineOf(pid) {
  const raw = safeReadFile(`/proc/${pid}/cmdline`);
  if (!raw) return [];
  return raw.split('\0').filter(Boolean);
}

function cwdOf(pid) {
  return safeReadlink(`/proc/${pid}/cwd`);
}

// A process' direct children, from the kernel's own list rather than by
// scanning every /proc entry for a matching PPid.
function childrenOf(pid) {
  const raw = safeReadFile(`/proc/${pid}/task/${pid}/children`);
  if (!raw) return [];
  return raw.trim().split(/\s+/).filter((p) => /^\d+$/.test(p)).map(Number);
}

// The shells a terminal window is running, found by walking down from the
// terminal process. xfce4-terminal spawns each shell directly; other terminals
// may put a wrapper in between, hence the walk.
//
// A list, not a single shell, because xfce4-terminal's default is a D-Bus
// server: the first launch owns a process and every later window or tab is a
// child of it, so one pid can have several shells (and several windows). The
// caller decides how to attribute them.
function collectShells(pid, out = [], depth = 0) {
  if (depth > 4) return out;
  for (const child of childrenOf(pid)) {
    const comm = commOf(child);
    if (comm && SHELLS.test(comm)) {
      out.push({ pid: child, comm });
      continue; // a shell's own children are its commands, not more shells
    }
    collectShells(child, out, depth + 1);
  }
  return out;
}

// What one shell had open: its working directory and the command it was
// running (its own first non-shell child), if any.
function shellDetails(shell) {
  const cwd = cwdOf(shell.pid) || null;
  let command = '';
  for (const child of childrenOf(shell.pid)) {
    const comm = commOf(child);
    if (!comm || SHELLS.test(comm)) continue;
    const argv = cmdlineOf(child);
    command = argv.length ? argv.join(' ') : comm;
    break;
  }
  return { cwd, shell: shell.comm, command: command.slice(0, 400) };
}

// The first shell behind a terminal window. Used when a caller has one window
// and no pool to share out.
function terminalDetails(windowPid) {
  const [first] = collectShells(windowPid);
  return first ? shellDetails(first) : null;
}

// ── Capture ─────────────────────────────────────────────────

function isTerminalWindow(win) {
  if (win.appId && /(^|\.)(xfce4-terminal|gnome-terminal|konsole|xterm|alacritty|kitty|terminator)\.desktop$/.test(win.appId)) {
    return true;
  }
  return /terminal|xterm|konsole|alacritty|kitty|terminator|tilix/i.test(win.wmClass || '');
}

function isBrowserWindow(win) {
  if (win.appId && /(google-chrome|chromium|firefox|brave|vivaldi|edge)/i.test(win.appId)) {
    return true;
  }
  return /chrome|chromium|firefox|brave|vivaldi|edge/i.test(win.wmClass || '');
}

// Tabs are captured per browser process, but windows are captured per X
// window, and nothing in the session store says which X window a tab group
// was drawn in. When the counts line up the groups are paired in order;
// otherwise every group is kept and the surplus is launched as an extra
// window of the same browser, which is better than dropping tabs.
function attachBrowserTabs(entries, sessions) {
  const browserEntries = entries.filter((e) => isBrowserWindow(e));
  if (!browserEntries.length || !sessions.length) return [];

  const groups = [];
  for (const session of sessions) {
    for (const win of session.windows) {
      groups.push({
        kind: session.kind,
        label: session.label,
        profileDir: session.profileDir || null,
        tabs: win.tabs.slice(0, MAX_TABS_PER_WINDOW),
        selectedIndex: win.selectedIndex || 0,
      });
    }
  }

  const paired = Math.min(browserEntries.length, groups.length);
  for (let i = 0; i < paired; i++) browserEntries[i].browser = groups[i];
  return groups.slice(paired);
}

async function captureState() {
  const [windows, size, clipboard, sessions] = await Promise.all([
    listWindows(),
    screenSize(),
    readClipboard(),
    Promise.resolve(browserSession.collectBrowserSessions({ homeDir: config.HOME_DIR })),
  ]);

  const entries = [];
  // Shells are pooled per terminal process and handed out one per window.
  // When xfce4-terminal shares a server, every window's pid is that one
  // process, and /proc order (creation order) is the only pairing available;
  // when each window has its own process, the pool has exactly one shell and
  // the pairing is exact.
  const shellPools = new Map();
  for (const win of windows) {
    // Panels, the desktop window and notification daemons are furniture, not
    // something the user opened, so they are not part of a snapshot.
    if (FURNITURE_WMCLASS.test(win.wmClass)) continue;
    if (win.workspace < 0) continue;
    if (!win.title || win.geometry.width <= 1 || win.geometry.height <= 1) continue;
    if (entries.length >= MAX_WINDOWS) break;

    const entry = {
      appId: win.appId,
      name: win.appId ? (apps.getApp(win.appId)?.name || win.appId) : null,
      wmClass: win.wmClass,
      title: win.title,
      workspace: win.workspace,
      geometry: win.geometry,
    };

    if (isTerminalWindow(win)) {
      if (!shellPools.has(win.pid)) shellPools.set(win.pid, collectShells(win.pid));
      const pool = shellPools.get(win.pid);
      const shell = pool.shift();
      if (shell) entry.terminal = shellDetails(shell);
    }
    entries.push(entry);
  }

  const extraBrowserWindows = attachBrowserTabs(entries, sessions);
  for (const group of extraBrowserWindows) {
    if (entries.length >= MAX_WINDOWS) break;
    entries.push({ appId: null, name: group.label, wmClass: null, title: group.label, workspace: 0, geometry: null, browser: group });
  }

  const state = {
    version: STATE_VERSION,
    savedAt: new Date().toISOString(),
    host: os.hostname(),
    home: config.HOME_DIR,
    display: size,
    clipboard: clipboard.slice(0, 64 * 1024),
    windows: entries,
    // Which of the captured windows could not be tied to an installed
    // application, so the client can say so rather than silently restoring
    // less than it promised.
    unlaunchable: entries.filter((e) => !e.appId && !e.browser && !e.terminal).map((e) => e.title),
  };
  return state;
}

function summarize(state) {
  const windows = Array.isArray(state?.windows) ? state.windows : [];
  const terminals = windows.filter((w) => w.terminal).length;
  const tabs = windows.reduce((n, w) => n + (w.browser?.tabs?.length || 0), 0);
  return {
    windows: windows.length,
    terminals,
    browsers: windows.filter((w) => w.browser).length,
    tabs,
    savedAt: state?.savedAt || null,
    host: state?.host || null,
    clipboard: Boolean(state?.clipboard),
  };
}

// ── The state file ──────────────────────────────────────────

// Accepts only what this module can read back. Anything else is rejected with
// a reason, because an uploaded file comes from outside the pod.
function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'state must be a JSON object' };
  }
  if (value.version !== STATE_VERSION) {
    return { error: `unsupported state version: ${JSON.stringify(value.version)}` };
  }
  if (!Array.isArray(value.windows)) {
    return { error: 'state.windows must be an array' };
  }
  const clean = {
    version: STATE_VERSION,
    savedAt: typeof value.savedAt === 'string' ? value.savedAt : null,
    host: typeof value.host === 'string' ? value.host : null,
    home: typeof value.home === 'string' ? value.home : null,
    display: null,
    clipboard: typeof value.clipboard === 'string' ? value.clipboard.slice(0, 64 * 1024) : '',
    windows: [],
    unlaunchable: [],
  };
  if (value.display && Number.isFinite(value.display.width) && Number.isFinite(value.display.height)) {
    clean.display = { width: value.display.width, height: value.display.height };
  }

  for (const w of value.windows.slice(0, MAX_WINDOWS)) {
    if (!w || typeof w !== 'object') continue;
    const entry = {
      appId: typeof w.appId === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(w.appId) ? w.appId : null,
      name: typeof w.name === 'string' ? w.name.slice(0, 200) : null,
      wmClass: typeof w.wmClass === 'string' ? w.wmClass.slice(0, 200) : null,
      title: typeof w.title === 'string' ? w.title.slice(0, 500) : '',
      workspace: Number.isInteger(w.workspace) && w.workspace >= 0 ? w.workspace : 0,
      geometry: null,
      terminal: null,
      browser: null,
    };
    const g = w.geometry;
    if (g && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(g[k]))) {
      entry.geometry = { x: g.x, y: g.y, width: g.width, height: g.height };
    }
    if (w.terminal && typeof w.terminal === 'object') {
      entry.terminal = {
        cwd: typeof w.terminal.cwd === 'string' ? w.terminal.cwd : null,
        shell: typeof w.terminal.shell === 'string' ? w.terminal.shell.slice(0, 40) : null,
        command: typeof w.terminal.command === 'string' ? w.terminal.command.slice(0, 400) : '',
      };
    }
    if (w.browser && typeof w.browser === 'object' && Array.isArray(w.browser.tabs)) {
      const tabs = w.browser.tabs
        .filter((t) => t && typeof t.url === 'string' && /^(https?|file|ftp):/i.test(t.url))
        .slice(0, MAX_TABS_PER_WINDOW)
        .map((t) => ({ url: t.url.slice(0, 2048), title: typeof t.title === 'string' ? t.title.slice(0, 300) : '' }));
      if (tabs.length) {
        entry.browser = {
          kind: typeof w.browser.kind === 'string' ? w.browser.kind.slice(0, 20) : 'chromium',
          label: typeof w.browser.label === 'string' ? w.browser.label.slice(0, 40) : 'Browser',
          profileDir: typeof w.browser.profileDir === 'string' ? w.browser.profileDir.slice(0, 500) : null,
          tabs,
          selectedIndex: Number.isInteger(w.browser.selectedIndex) ? w.browser.selectedIndex : 0,
        };
      }
    }
    clean.windows.push(entry);
  }
  clean.unlaunchable = clean.windows.filter((e) => !e.appId && !e.browser && !e.terminal).map((e) => e.title);
  return { state: clean };
}

function readStateFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const { state } = validateState(raw);
    return state || null;
  } catch {
    return null; // missing or unreadable is the same as "nothing saved"
  }
}

function writeStateFile(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // Write-then-rename, like the dock pins: a crash mid-write must not leave a
  // truncated file where the user's session used to be.
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function clearStateFile() {
  try { fs.unlinkSync(STATE_FILE); return true; } catch { return false; }
}

function stateFilePath() {
  return STATE_FILE;
}

// Preferences that belong to the desktop rather than to a snapshot, kept in
// their own file so a downloaded state stays portable. `lastAutoRestoreAt` is
// what keeps an automatic restore from firing again on every page reload: an
// auto-restore only runs once per saved snapshot.
const SETTINGS_FILE = path.join(STATE_DIR, 'session-settings.json');

function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return {
      autoRestore: Boolean(raw.autoRestore),
      lastAutoRestoreAt: typeof raw.lastAutoRestoreAt === 'string' ? raw.lastAutoRestoreAt : null,
    };
  } catch {
    return { autoRestore: false, lastAutoRestoreAt: null };
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
  return next;
}

// ── Restore ─────────────────────────────────────────────────

// Launch one entry. Terminals get their working directory back (and, when
// asked for, the command they were running); browsers get their URLs;
// everything else is launched by its .desktop entry, which is the only thing
// the app registry promises and therefore the only thing worth doing for an
// application whose own idea of "what was open" is invisible from outside.
async function launchEntry(entry, { rerunCommands }) {
  if (entry.terminal) {
    const cwd = entry.terminal.cwd && fs.existsSync(entry.terminal.cwd) ? entry.terminal.cwd : null;
    const binary = terminalBinary(entry.appId);
    // Only the terminals that document a starting-directory flag get one; for
    // anything else the window opens in the launch directory, which is what it
    // would have done without a snapshot at all.
    const base = path.basename(binary);
    const takesCwd = Object.prototype.hasOwnProperty.call(TERMINAL_CWD_FLAG, base);
    const args = [];
    // A restored window is its own process. Without this, a terminal server
    // left running (the desktop's own terminal, say) would adopt the window
    // and every restored shell would join one pid, which is exactly the
    // ambiguity the capture side has to work around.
    if (base === 'xfce4-terminal') args.push('--disable-server');
    if (cwd && takesCwd) args.push(`${TERMINAL_CWD_FLAG[base]}=${cwd}`);

    if (rerunCommands && entry.terminal.command) {
      // Keep the terminal open after the command ends, so a command that
      // exits immediately does not take the window with it.
      args.push('-x', 'bash', '-c', `${entry.terminal.command}; exec bash`);
    }
    await spawnDetached(binary, args, cwd ? { cwd } : {});
    return;
  }

  if (entry.browser) {
    const urls = entry.browser.tabs.map((t) => t.url).slice(0, MAX_TABS_PER_WINDOW);
    if (!urls.length) return;
    const args = ['--new-window', ...urls];
    if (entry.browser.profileDir && entry.browser.kind === 'chromium') {
      // Reuse the profile so logins and cookies come back with the tabs. The
      // profile directory is <user-data-dir>/<profile>; both parts are
      // reconstructed so Chrome finds the same one.
      const profile = path.basename(entry.browser.profileDir);
      const userDataDir = path.dirname(entry.browser.profileDir);
      args.push(`--user-data-dir=${userDataDir}`, `--profile-directory=${profile}`);
    }
    await launchBrowser(entry.browser, args);
    return;
  }

  if (entry.appId && apps.getApp(entry.appId)) {
    await apps.launchApp(entry.appId);
  }
}

// The terminal binary to use: the window's own application entry when it names
// a terminal, and the image's terminal otherwise. The check is not cosmetic --
// a state file can arrive by upload, so the binary has to be a terminal before
// it is ever handed a working-directory argument.
function terminalBinary(appId) {
  const app = appId ? apps.getApp(appId) : null;
  const argv0 = app && app.argv && app.argv.length ? app.argv[0] : null;
  if (argv0 && /terminal|xterm|konsole|alacritty|kitty|terminator|tilix/i.test(path.basename(argv0))) {
    return argv0;
  }
  return 'xfce4-terminal';
}

// The .desktop entries to try for each browser, in order. Deliberately a fixed
// list instead of the window's matched app id: a Chrome window is matched to
// whatever .desktop claims its WM_CLASS, and Chrome installs one entry per
// installed web app ("Cursor", "Gmail"…), so trusting that id would relaunch
// the web app rather than the browser.
const BROWSER_APP_IDS = {
  chromium: ['google-chrome.desktop', 'chromium.desktop', 'chromium-browser.desktop'],
  firefox: ['firefox.desktop', 'firefox-esr.desktop'],
};

async function launchBrowser(browser, args) {
  for (const id of BROWSER_APP_IDS[browser.kind] || []) {
    if (apps.getApp(id)) {
      await apps.launchApp(id, args);
      return;
    }
  }
  // A browser the registry does not know (a snap, a renamed package): the
  // plain binary still gets the tabs back. Only these fixed names are ever
  // used -- never a path taken from the state file, which may have come from
  // an upload.
  const binary = browser.kind === 'firefox' ? 'firefox'
    : /chromium/i.test(browser.label || '') ? 'chromium' : 'google-chrome';
  await spawnDetached(binary, args);
}

function spawnDetached(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: X_ENV,
      detached: true,
      stdio: 'ignore',
      ...(config.LAUNCH_CWD ? { cwd: config.LAUNCH_CWD } : {}),
      ...opts,
    });
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };
    child.on('error', done);
    child.unref();
    // Like the dock's launcher: only an immediate spawn failure is an error, a
    // GUI process that starts is a success.
    setTimeout(done, 400);
  });
}

// A window's decoration thickness. wmctrl -G reports a client's position with
// the frame extents already folded in, so putting a window back where it was
// captured means taking them out again before asking the window manager to
// move it. Read per window because a dialog and a main window do not have the
// same title bar.
async function frameExtents(id) {
  const out = await run('xprop', ['-id', id, '_NET_FRAME_EXTENTS']);
  const m = out.match(/_NET_FRAME_EXTENTS\(CARDINAL\)\s*=\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return { left: +m[1], right: +m[2], top: +m[3], bottom: +m[4] };
}

// Move the windows that a restore just created onto the workspaces and
// geometries they were captured with. Windows are matched to entries by
// application, in list order, and only windows that were not already open are
// touched. Everything here is best effort: a window that never appears (an app
// that ignores its arguments, a browser that reuses an existing window)
// simply keeps the position the window manager gave it.
async function placeWindows(entries, existingIds, timeoutMs = 5000) {
  const pending = entries.filter((e) => e.geometry);
  if (!pending.length) return { placed: 0, pending: 0 };

  const placed = new Set();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const windows = await listWindows();
    for (const win of windows) {
      if (existingIds.has(win.id) || placed.has(win.id)) continue;
      // xfce4-terminal keeps a small untitled helper window beside every real
      // one; matching it to a saved entry would spend that entry's geometry on
      // a window nobody ever sees.
      if (!win.title) continue;
      const at = pending.findIndex((e) => sameApp(win, e));
      if (at < 0) continue;
      const entry = pending.splice(at, 1)[0];
      placed.add(win.id);

      // Gravity 10 is EWMH's "static": the coordinates name the client area
      // rather than the frame, so the requested size is the size the window
      // ends up with and only the frame extents have to be subtracted from
      // the captured position. Without them (no xprop, or a window manager
      // that does not publish them) the move is still attempted unmoved, and
      // the window is merely as far off as its title bar is tall.
      const ext = await frameExtents(win.id);
      const x = ext ? entry.geometry.x - ext.left : entry.geometry.x;
      const y = ext ? entry.geometry.y - ext.top : entry.geometry.y;
      await run('wmctrl', ['-i', '-r', win.id, '-e', `10,${x},${y},${entry.geometry.width},${entry.geometry.height}`]);
      if (Number.isInteger(entry.workspace) && entry.workspace >= 0) {
        await run('wmctrl', ['-i', '-r', win.id, '-t', String(entry.workspace)]);
      }
    }
    if (!pending.length) break;
    await sleep(400);
  }
  return { placed: placed.size, pending: pending.length };
}

function sameApp(win, entry) {
  if (entry.appId && win.appId && entry.appId === win.appId) return true;
  if (entry.wmClass && win.wmClass && entry.wmClass === win.wmClass) return true;
  if (entry.browser && isBrowserWindow(win)) return true;
  return false;
}

// Rebuild a saved session. Options:
//   rerunCommands  also re-run each terminal's foreground command (off by
//                  default: replaying a destructive command automatically is
//                  not something a "restore" button should decide on its own)
//   geometry       move the new windows onto their saved workspaces/positions
//   clipboard      put the saved clipboard text back
async function restoreState(state, options = {}) {
  const { rerunCommands = false, geometry = true, clipboard = true } = options;
  const windows = Array.isArray(state?.windows) ? state.windows : [];
  if (!windows.length) return { restored: 0, failed: 0, errors: ['the saved state has no windows'] };

  const before = new Set((await listWindows()).map((w) => w.id));

  let restored = 0;
  const errors = [];
  for (const entry of windows) {
    if (!entry.appId && !entry.browser && !entry.terminal) {
      errors.push(`nothing to launch for "${entry.title}"`);
      continue;
    }
    try {
      await launchEntry(entry, { rerunCommands });
      restored++;
    } catch (err) {
      errors.push(`${entry.name || entry.title || entry.wmClass}: ${err.message}`);
    }
    // A short gap keeps the window manager from stacking every window of a
    // restore at the same place before any of them has been mapped.
    await sleep(150);
  }

  const placement = geometry ? await placeWindows(windows, before) : { placed: 0, pending: 0 };
  let clipboardRestored = false;
  if (clipboard && state.clipboard) clipboardRestored = await writeClipboard(state.clipboard);

  return {
    restored,
    failed: errors.length,
    errors: errors.slice(0, 10),
    placed: placement.placed,
    unplaced: placement.pending,
    clipboard: clipboardRestored,
  };
}

module.exports = {
  STATE_FILE,
  SETTINGS_FILE,
  STATE_VERSION,
  captureState,
  summarize,
  validateState,
  readStateFile,
  writeStateFile,
  clearStateFile,
  stateFilePath,
  readSettings,
  writeSettings,
  restoreState,
  // exported for tests
  listWindows,
  terminalDetails,
  collectShells,
  isTerminalWindow,
  isBrowserWindow,
  attachBrowserTabs,
};
