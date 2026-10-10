// Open browser tabs, read from the browsers' own session stores.
//
// A desktop session snapshot wants to bring the browser back with the pages
// that were open, and there is no way to ask a running browser for its tab
// list: Chrome's DevTools endpoint only exists when the browser was started
// with --remote-debugging-port, which the dock deliberately does not pass (it
// would hand full browser control to anything that can reach the port), and
// Firefox has no such endpoint at all. What both browsers do have is the
// session file they keep on disk so they can offer "restore previous
// session". That is what this module reads:
//
//   * Firefox writes JSON (lz4-compressed) to
//     <profile>/sessionstore-backups/recovery.jsonlz4 while it runs, and
//     sessionstore.jsonlz4 on a clean exit. Decompressing it gives the tab
//     list directly.
//
//   * Chromium (Chrome, Chromium) writes a binary command log to
//     <user-data-dir>/<profile>/Sessions/{Session,Tabs}_<timestamp>. The
//     format is the one described in components/sessions/core: an "SNSS"
//     header, then records of [uint16 size][uint8 id][size-1 bytes of
//     payload] where `size` counts the id byte. Replaying the commands is
//     what the browser itself does to restore; the subset replayed here is
//     only what is needed to learn which tabs exist, which window they are
//     in, and which URL each is showing.
//
// Both readers are best-effort by design: a browser that changes its session
// format, or a profile whose session file is mid-write, yields fewer tabs
// rather than an error. Nothing here writes to a browser profile.
//
// The URL is all that is captured. Restoring means handing those URLs to the
// browser on its command line, which is why the title and the back/forward
// history are not kept: they cannot be replayed that way, and inventing them
// would be worse than not claiming them.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Schemes worth putting back on a browser's command line. `about:` pages are
// dropped: they are the browser's own UI, not something the user opened, and
// Chrome refuses some of them as startup arguments.
const RESTORABLE_SCHEME = /^(https?|file|ftp):/i;

// A cap per window, so a pathological session file cannot turn a restore into
// hundreds of tabs. Chrome itself opens at most this many on the command line
// in practice; beyond it the extra tabs would be dropped anyway.
const MAX_TABS_PER_WINDOW = 50;

// ── Firefox: the mozLz4 sessionstore ────────────────────────

// Firefox's lz4 wrapper is its own container: the magic "mozLz40\0", the
// uncompressed size as a little-endian uint32, then one raw LZ4 *block* (not
// an LZ4 frame) holding that many bytes.
const MOZLZ4_MAGIC = Buffer.from('mozLz40\0', 'latin1');

// Raw LZ4 block decompression. The block format is a sequence of runs:
// a token byte whose high nibble is the literal length and low nibble is the
// match length minus four, extra length bytes in 255-byte steps, the literals,
// then a two-byte little-endian back-reference offset and the match. Matches
// may overlap the bytes they are producing, so the copy is byte by byte.
function lz4BlockDecompress(src) {
  let out = Buffer.alloc(Math.max(src.length * 4, 1 << 16));
  let o = 0;
  let i = 0;

  const reserve = (n) => {
    if (o + n > out.length) {
      let size = out.length * 2;
      while (size < o + n) size *= 2;
      const bigger = Buffer.alloc(size);
      out.copy(bigger, 0, 0, o);
      out = bigger;
    }
  };
  const extraLength = (base) => {
    let len = base;
    if (base === 15) {
      let b;
      do {
        if (i >= src.length) throw new Error('lz4: truncated length');
        b = src[i++];
        len += b;
      } while (b === 255);
    }
    return len;
  };

  while (i < src.length) {
    const token = src[i++];

    const literals = extraLength(token >> 4);
    if (i + literals > src.length) throw new Error('lz4: truncated literals');
    reserve(literals);
    src.copy(out, o, i, i + literals);
    o += literals;
    i += literals;

    // The final sequence of a block is literals only.
    if (i >= src.length) break;

    if (i + 2 > src.length) throw new Error('lz4: truncated offset');
    const offset = src[i] | (src[i + 1] << 8);
    i += 2;
    if (offset === 0 || offset > o) throw new Error('lz4: bad match offset');

    const match = extraLength(token & 0x0f) + 4;
    reserve(match);
    let m = o - offset;
    for (let k = 0; k < match; k++) out[o++] = out[m++];
  }

  return out.subarray(0, o);
}

function decompressMozLz4(buf) {
  if (!buf.subarray(0, 8).equals(MOZLZ4_MAGIC)) {
    throw new Error('not a mozLz4 file');
  }
  // The stored size is a hint; the block itself is authoritative and the
  // decoder grows its output as it goes.
  return lz4BlockDecompress(buf.subarray(12));
}

// sessionstore JSON → the same {windows: [{tabs, selectedIndex}]} shape the
// Chromium reader produces, so callers do not care which browser they got.
function parseFirefoxSession(json) {
  const windows = [];
  for (const win of Array.isArray(json.windows) ? json.windows : []) {
    const tabs = [];
    let selectedIndex = 0;
    (Array.isArray(win.tabs) ? win.tabs : []).forEach((tab, i) => {
      const entries = Array.isArray(tab.entries) ? tab.entries : [];
      const index = Number.isInteger(tab.index) ? tab.index : entries.length - 1;
      const entry = entries[index] || entries[entries.length - 1];
      const url = entry && typeof entry.url === 'string' ? entry.url : '';
      if (!RESTORABLE_SCHEME.test(url)) return;
      if (tab.hidden) return;
      tabs.push({ url, title: typeof entry.title === 'string' ? entry.title : '' });
      if (tab.selected) selectedIndex = tabs.length - 1;
    });
    if (tabs.length) windows.push({ tabs, selectedIndex });
  }
  return windows;
}

function readFirefoxProfile(profileDir) {
  const candidates = [
    // Written every ~15 s while Firefox runs: the live tab list.
    path.join(profileDir, 'sessionstore-backups', 'recovery.jsonlz4'),
    // Written on a clean shutdown.
    path.join(profileDir, 'sessionstore.jsonlz4'),
  ];
  // Newest first, so a running profile beats the stale clean-exit copy.
  const files = candidates
    .map((file) => ({ file, mtime: statMtime(file) }))
    .filter((f) => f.mtime > 0)
    .sort((a, b) => b.mtime - a.mtime);

  for (const { file } of files) {
    try {
      const raw = fs.readFileSync(file);
      const json = JSON.parse(decompressMozLz4(raw).toString('utf8'));
      const windows = parseFirefoxSession(json);
      if (windows.length) return windows;
    } catch { /* try the next candidate */ }
  }
  return [];
}

// ── Chromium: the SNSS command log ──────────────────────────

const SNSS_MAGIC = 'SNSS';

// Command ids, from components/sessions/core/session_service_commands.cc.
// Everything not listed is ignored: the log contains plenty of commands a
// snapshot does not care about (tab groups, user-agent overrides, bounds…).
const CMD = {
  SET_TAB_WINDOW: 0,
  SET_TAB_INDEX_IN_WINDOW: 2,
  UPDATE_TAB_NAVIGATION: 6,
  SET_SELECTED_NAVIGATION_INDEX: 7,
  SET_SELECTED_TAB_IN_INDEX: 8,
  SET_WINDOW_TYPE: 9,
  SET_PINNED_STATE: 12,
  TAB_CLOSED: 16,
  WINDOW_CLOSED: 17,
};

// WindowType::kTabbed is 0; popups, apps and DevTools windows are recorded
// with other values and are not reopened as tabs.
const WINDOW_TYPE_TABBED = 0;

// One file's records. The size field counts the id byte, so a 1-byte record is
// an empty command — id 255 is the "end of log" marker Chromium writes and is
// returned like any other so callers can stop on it.
function readSnssCommands(buf) {
  if (buf.length < 8 || buf.subarray(0, 4).toString('latin1') !== SNSS_MAGIC) {
    throw new Error('not an SNSS file');
  }
  const version = buf.readInt32LE(4);
  if (version < 1) throw new Error(`unsupported SNSS version ${version}`);

  const commands = [];
  let i = 8;
  while (i + 3 <= buf.length) {
    const size = buf.readUInt16LE(i);
    const id = buf[i + 2];
    if (size < 1 || i + 2 + size > buf.length) break; // truncated tail
    commands.push({ id, payload: buf.subarray(i + 3, i + 2 + size) });
    i += 2 + size;
    if (id === 255) break; // end-of-log marker
  }
  return commands;
}

// A Chromium Pickle string at `offset`: a uint32 length, the bytes, then
// padding to the next four-byte boundary (measured from the pickle start).
function readPickleString(payload, offset) {
  if (offset + 4 > payload.length) return null;
  const len = payload.readUInt32LE(offset);
  const start = offset + 4;
  if (len > payload.length - start) return null;
  return {
    value: payload.subarray(start, start + len).toString('utf8'),
    next: (start + len + 3) & ~3,
  };
}

// The first string in an UpdateTabNavigation payload is the URL. Guard against
// a layout change by taking the first string that actually looks like a URL
// rather than blindly trusting offset 8.
function navigationUrl(payload) {
  for (let offset = 8; offset + 4 <= payload.length; offset += 4) {
    const s = readPickleString(payload, offset);
    if (s && RESTORABLE_SCHEME.test(s.value)) return s.value;
  }
  return null;
}

// Replays the commands into the tab list they describe. Tabs are keyed by the
// browser's own session id; a tab without a window, a closed tab, or a tab in
// a non-tabbed window is not restored.
function replaySnssCommands(commands) {
  const windows = new Map(); // windowId -> { type, tabs: Map<tabId, tab>, order }
  const tabs = new Map(); // tabId -> { windowId, visualIndex, navs: Map, selected }
  const nextTab = () => ({ windowId: null, visualIndex: 0, navs: new Map(), selected: null });
  const getTab = (id) => {
    let tab = tabs.get(id);
    if (!tab) tabs.set(id, (tab = nextTab()));
    return tab;
  };
  const getWindow = (id) => {
    let win = windows.get(id);
    if (!win) windows.set(id, (win = { type: WINDOW_TYPE_TABBED, tabs: new Set() }));
    return win;
  };

  for (const { id, payload } of commands) {
    switch (id) {
      case CMD.SET_TAB_WINDOW: {
        if (payload.length < 8) break;
        const windowId = payload.readInt32LE(0);
        const tabId = payload.readInt32LE(4);
        const tab = getTab(tabId);
        if (tab.windowId !== null) windows.get(tab.windowId)?.tabs.delete(tabId);
        tab.windowId = windowId;
        getWindow(windowId).tabs.add(tabId);
        break;
      }
      case CMD.SET_TAB_INDEX_IN_WINDOW: {
        if (payload.length < 8) break;
        getTab(payload.readInt32LE(0)).visualIndex = payload.readInt32LE(4);
        break;
      }
      case CMD.SET_WINDOW_TYPE: {
        if (payload.length < 8) break;
        getWindow(payload.readInt32LE(0)).type = payload.readInt32LE(4);
        break;
      }
      case CMD.SET_PINNED_STATE: {
        if (payload.length < 8) break;
        getTab(payload.readInt32LE(0)).pinned = payload.readUInt8(4) !== 0;
        break;
      }
      case CMD.UPDATE_TAB_NAVIGATION: {
        if (payload.length < 12) break;
        const tabId = payload.readInt32LE(4);
        const navIndex = payload.readInt32LE(8);
        const url = navigationUrl(payload);
        if (url) getTab(tabId).navs.set(navIndex, url);
        break;
      }
      case CMD.SET_SELECTED_NAVIGATION_INDEX: {
        if (payload.length < 8) break;
        getTab(payload.readInt32LE(0)).selected = payload.readInt32LE(4);
        break;
      }
      case CMD.SET_SELECTED_TAB_IN_INDEX: {
        if (payload.length < 8) break;
        getWindow(payload.readInt32LE(0)).selectedTab = payload.readInt32LE(4);
        break;
      }
      case CMD.TAB_CLOSED: {
        if (payload.length < 4) break;
        const tabId = payload.readInt32LE(0);
        const tab = tabs.get(tabId);
        if (tab && tab.windowId !== null) windows.get(tab.windowId)?.tabs.delete(tabId);
        tabs.delete(tabId);
        break;
      }
      case CMD.WINDOW_CLOSED: {
        if (payload.length < 4) break;
        const windowId = payload.readInt32LE(0);
        for (const tabId of windows.get(windowId)?.tabs || []) tabs.delete(tabId);
        windows.delete(windowId);
        break;
      }
      default:
        break; // a command this reader has no use for
    }
  }

  const ordered = [];
  for (const [windowId, win] of windows) {
    if (win.type !== WINDOW_TYPE_TABBED) continue;

    const live = [];
    for (const tabId of win.tabs) {
      const tab = tabs.get(tabId);
      if (!tab || tab.navs.size === 0) continue;
      // The tab's current URL is the navigation it had selected, or the last
      // one it navigated to.
      const indexes = [...tab.navs.keys()].sort((a, b) => a - b);
      const pick = tab.selected !== null && tab.navs.has(tab.selected)
        ? tab.selected
        : indexes[indexes.length - 1];
      live.push({ tabId, visualIndex: tab.visualIndex, selectedNav: tab.selected, url: tab.navs.get(pick) });
    }
    if (!live.length) continue;

    live.sort((a, b) => (a.visualIndex - b.visualIndex) || (a.tabId - b.tabId));
    const tabsOut = live.slice(0, MAX_TABS_PER_WINDOW).map((t) => ({ url: t.url, title: '' }));

    // The selected tab of the window, if it survived, so the restore can make
    // it the one in front.
    let selectedIndex = 0;
    if (Number.isInteger(win.selectedTab)) {
      const at = live.findIndex((t) => t.visualIndex === win.selectedTab);
      if (at >= 0 && at < MAX_TABS_PER_WINDOW) selectedIndex = at;
    }
    ordered.push({ windowId, tabs: tabsOut, selectedIndex });
  }
  return ordered;
}

// The Session_/Tabs_ pair the browser is currently appending to. Each file
// name carries the timestamp it was created at; the newest of each kind is the
// live one. The session file holds window and tab structure, the tabs file the
// navigations, so both are needed and the structure is replayed first.
function readChromiumProfile(profileDir) {
  const dir = path.join(profileDir, 'Sessions');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }

  const newest = (prefix) => names
    .filter((n) => n.startsWith(prefix))
    .map((n) => ({ n, ts: parseInt(n.slice(prefix.length), 10) || statMtime(path.join(dir, n)) }))
    .sort((a, b) => b.ts - a.ts)[0];

  const commands = [];
  for (const prefix of ['Session_', 'Tabs_']) {
    const found = newest(prefix);
    if (!found) continue;
    try {
      commands.push(...readSnssCommands(fs.readFileSync(path.join(dir, found.n))));
    } catch { /* unreadable or mid-rewrite: the other file may still work */ }
  }
  if (!commands.length) return [];

  try {
    return replaySnssCommands(commands).map(({ tabs, selectedIndex }) => ({ tabs, selectedIndex }));
  } catch {
    return [];
  }
}

// ── Profile discovery ───────────────────────────────────────

function statMtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// Chromium's own binary names, and the user-data-dir each defaults to. A
// process started with --user-data-dir overrides the default.
const CHROMIUM_BINARIES = {
  'google-chrome': '.config/google-chrome',
  'google-chrome-stable': '.config/google-chrome',
  chromium: '.config/chromium',
  'chromium-browser': '.config/chromium',
};

function isChromiumBinary(name) {
  return Object.prototype.hasOwnProperty.call(CHROMIUM_BINARIES, name);
}

// argv → the flags a browser launch cares about. Both `--flag=value` and
// `--flag value` are accepted; a bare `--user-data-dir` followed by another
// flag (as some launchers produce) simply has no value.
function flagValue(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) {
      const next = argv[i + 1];
      return next && !next.startsWith('-') ? next : '';
    }
    if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
  }
  return null;
}

// A process' argv. Normally /proc/<pid>/cmdline is NUL-separated, but some
// launchers hand the kernel a single argv[0] holding the whole command line
// (KasmVNC's browser launcher does), in which case the flags are separated by
// spaces inside that one string and have to be split back out.
function processArgv(pid) {
  let raw;
  try { raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { return []; }
  const parts = raw.split('\0').filter(Boolean);
  if (parts.length === 1 && /\s/.test(parts[0])) {
    return parts[0].split(/\s+/).filter(Boolean);
  }
  return parts;
}

// Every running browser's profile directory, from /proc. Only the main
// process is considered: a renderer or GPU helper carries the same flags but
// is not the browser, and `--type=` is what distinguishes it.
function runningBrowserProfiles(homeDir) {
  const found = [];
  const seen = new Set();

  for (const pid of safeReaddir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    const argv = processArgv(pid);
    if (!argv.length) continue;

    const binary = path.basename(argv[0]).toLowerCase();
    const chromium = isChromiumBinary(binary)
      // The Chrome .deb's process is `/opt/google/chrome/chrome`, whose
      // basename is just "chrome".
      || (binary === 'chrome' && argv[0].includes('google'));
    const firefox = binary === 'firefox' || binary === 'firefox-bin';
    if (!chromium && !firefox) continue;
    if (flagValue(argv, '--type') !== null) continue; // a helper process

    if (firefox && !seen.has('firefox')) {
      seen.add('firefox');
      found.push({ kind: 'firefox', label: 'Firefox', profileDir: null });
      continue;
    }
    if (!chromium) continue;

    const userDataDir = flagValue(argv, '--user-data-dir')
      || path.join(homeDir, CHROMIUM_BINARIES[binary] || '.config/google-chrome');
    const profileDirectory = flagValue(argv, '--profile-directory') || 'Default';
    const profileDir = path.join(userDataDir, profileDirectory);
    if (seen.has(profileDir)) continue;
    seen.add(profileDir);
    found.push({ kind: 'chromium', label: binary.startsWith('chromium') ? 'Chromium' : 'Google Chrome', profileDir });
  }
  return found;
}

// Firefox profiles live under the dot-directory for the package flavour in
// use, and profiles.ini is what names the default one. The session file is
// per-profile, so every profile that has one is offered.
function firefoxProfiles(homeDir) {
  const roots = [
    path.join(homeDir, '.mozilla', 'firefox'),
    // Snap and Flatpak builds keep their own copy of the profile.
    path.join(homeDir, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
    path.join(homeDir, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'),
  ];
  const dirs = [];
  for (const root of roots) {
    for (const name of safeReaddir(root)) {
      const dir = path.join(root, name);
      if (statMtime(path.join(dir, 'sessionstore-backups')) > 0 || statMtime(path.join(dir, 'sessionstore.jsonlz4')) > 0) {
        dirs.push(dir);
      }
    }
  }
  return dirs;
}

// ── Public entry point ──────────────────────────────────────

// Browsers running on the session display, with their open tabs. Each entry is
// { kind, label, profileDir, windows: [{ tabs: [{url,title}], selectedIndex }] }.
// A browser with nothing worth restoring is left out entirely.
function collectBrowserSessions({ homeDir = os.homedir(), processes = runningBrowserProfiles(homeDir) } = {}) {
  const out = [];
  for (const proc of processes) {
    if (proc.kind === 'firefox') {
      const profiles = proc.profileDir ? [proc.profileDir] : firefoxProfiles(homeDir);
      const windows = [];
      let used = null;
      for (const dir of profiles) {
        const parsed = readFirefoxProfile(dir);
        if (parsed.length) {
          windows.push(...parsed);
          used = dir;
        }
      }
      if (windows.length) {
        out.push({ kind: 'firefox', label: 'Firefox', profileDir: used, windows });
      }
    } else {
      const windows = readChromiumProfile(proc.profileDir);
      if (windows.length) {
        out.push({ kind: 'chromium', label: proc.label, profileDir: proc.profileDir, windows });
      }
    }
  }
  return out;
}

module.exports = {
  collectBrowserSessions,
  // exported for tests
  decompressMozLz4,
  parseFirefoxSession,
  readFirefoxProfile,
  readChromiumProfile,
  readSnssCommands,
  replaySnssCommands,
  navigationUrl,
  runningBrowserProfiles,
  firefoxProfiles,
  flagValue,
};
