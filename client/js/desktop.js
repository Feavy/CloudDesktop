import RFB from '/vendor/novnc/core/rfb.js';
import { notify, init as initNotifications } from '/js/notifications.js?cv=%CACHE_VERSION%';
import { createMobileKeyboard } from '/js/mobile-keyboard.js?cv=%CACHE_VERSION%';
import { initAppDock, hideAppDock, setAppDockAutoHide, iconUrl } from '/js/appdock.js?cv=%CACHE_VERSION%';
import { sendRestartShortcut } from '/js/session-restart.js?cv=%CACHE_VERSION%';

const statusOverlay = document.getElementById('status-overlay');
const statusText    = document.getElementById('status-text');
const vncContainer  = document.getElementById('vnc-container');

// Modals (declared early so they're available everywhere)
const uploadModal      = document.getElementById('upload-modal');
const dirModal         = document.getElementById('dir-modal');
const filebrowserModal = document.getElementById('filebrowser-modal');

// Upload/download state (declared early for use throughout)
let selectedUploadFiles = [];
const uploads   = new Map();
const downloads = new Map();

let rfb = null;
let reconnectTimer = null;
// Tracked ourselves: noVNC exposes no public "connected" flag, and the restart
// path needs to know whether there is a session to send keys to.
let vncUp = false;
// Set on touch devices only; guards autoFitResolution while the soft keyboard
// is animating in or out. See mobile-keyboard.js.
let keyboard = null;

initNotifications();

// ── PWA ─────────────────────────────────────────────────────
// Pass-through worker at /sw.js: its existence is what makes the browser
// offer the app install prompt. Registration is best-effort; failure only
// means no install prompt, not a broken desktop.
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('Service worker registration failed:', err);
    });
}

// ── Device detection ────────────────────────────────────────
const isTouch   = navigator.maxTouchPoints > 0 || window.matchMedia('(hover: none)').matches;
const isIOS     = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(navigator.userAgent);
const isMobile  = isTouch && (Math.min(window.innerWidth, window.innerHeight) <= 600);

// ── VNC connect ─────────────────────────────────────────────

async function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  showStatus('Connecting to desktop…');

  await serverConfigReady;

  try {
    // WS_URL points at an existing websocketify when the pod already runs one;
    // otherwise fall back to this server's own /websockify → TCP bridge.
    const wsUrl = SERVER_WS_URL || (() => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${location.host}/websockify`;
    })();

    if (rfb) { rfb.disconnect(); rfb = null; }

    rfb = new RFB(vncContainer, wsUrl, { wsProtocols: ['binary'] });
    rfb.scaleViewport  = true;
    // On a touch device autoFitResolution() below is the only thing that should
    // size the remote desktop. noVNC's own resizeSession sends the raw viewport
    // size -- unscaled by devicePixelRatio and not on the 8px grid xrandr wants
    // -- so the two would issue competing xrandr calls for the same moment, and
    // the last one to finish would win. On a touch device the viewport changes
    // constantly (soft keyboard, collapsing URL bar, orientation), so that race
    // is not theoretical: suspending the keyboard's viewport change is not
    // enough on its own, without this the resolution still lands somewhere
    // arbitrary after every keyboard open and close.
    rfb.resizeSession  = !isTouch;
    rfb.clipViewport   = false;
    rfb.showDotCursor  = true;
    rfb.qualityLevel   = 5;
    rfb.compressionLevel = 6;

    rfb.addEventListener('connect',             onConnect);
    rfb.addEventListener('disconnect',          onDisconnect);
    rfb.addEventListener('credentialsrequired', () => rfb.sendCredentials({ password: '' }));
    rfb.addEventListener('clipboard',           onVncClipboard);
  } catch {
    showStatus('Connection failed. Retrying…');
    scheduleReconnect();
  }
}

function onConnect() {
  vncUp = true;
  hideStatus();
  rfb.focus();
  notify('Connected to desktop', 'success', 3000);
}

function onDisconnect(e) {
  vncUp = false;
  const clean = (e.detail || {}).clean;
  showStatus(clean ? 'Disconnected from desktop.' : 'Connection lost. Reconnecting…');
  notify(clean ? 'Disconnected from desktop' : 'Connection lost — reconnecting…', 'warning');
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

function showStatus(msg) { statusText.textContent = msg; statusOverlay.classList.remove('hidden'); }
function hideStatus()    { statusOverlay.classList.add('hidden'); }

// ── Native clipboard sync ───────────────────────────────────

// VNC → browser: when VNC clipboard changes, write to browser clipboard
function onVncClipboard(e) {
  const text = e.detail.text;
  if (navigator.clipboard && text) navigator.clipboard.writeText(text).catch(() => {});
}

// Push text to X server clipboard via API
function setXClipboard(text) {
  return fetch('/api/desktop/clipboard', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

// Read local clipboard and push it to the remote (VNC protocol + X server).
// Must be called from a user gesture, or the browser denies the read.
// Returns the text that was pushed, or '' if nothing was read.
async function pushLocalClipboard() {
  if (!rfb) return '';
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      rfb.clipboardPasteFrom(text);
      await setXClipboard(text);
    }
    return text;
  } catch { return ''; /* clipboard permission denied */ }
}

// Ctrl+V: intercept BEFORE noVNC, set X clipboard, wait, then replay keystroke
vncContainer.addEventListener('keydown', async (e) => {
  if (!rfb) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const text = await pushLocalClipboard();
    if (text) {
      // Small delay to ensure xclip has written before sending Ctrl+V
      await new Promise(r => setTimeout(r, 80));

      // Replay Ctrl+V to remote desktop
      rfb.sendKey(0xFFE3, 'ControlLeft', true);
      rfb.sendKey(0x0076, 'KeyV', true);
      rfb.sendKey(0x0076, 'KeyV', false);
      rfb.sendKey(0xFFE3, 'ControlLeft', false);
    }
  }
}, true);

// Right/middle click: sync local clipboard to the remote so right-click → Paste
// and middle-click paste use fresh local content. mousedown is a user gesture,
// so this also triggers the browser's clipboard permission prompt if needed.
//
// Right click: forward the click immediately — the context menu that opens
// gives the async push time to land before "Paste" is chosen.
//
// Middle click: the remote app pastes on the button press itself, so the click
// must be held back until the push has landed, then replayed to noVNC.
let middleClickPending = false;

vncContainer.addEventListener('mousedown', async (e) => {
  if (!e.isTrusted || (e.button !== 1 && e.button !== 2)) return;
  if (e.button === 2 || !rfb) {
    pushLocalClipboard();
    return;
  }

  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  middleClickPending = true;

  await pushLocalClipboard();

  const canvas = vncContainer.querySelector('canvas');
  if (canvas) {
    const opts = {
      clientX: e.clientX, clientY: e.clientY,
      screenX: e.screenX, screenY: e.screenY,
      button: 1, buttons: 4,
      bubbles: true, cancelable: true, view: window,
    };
    canvas.dispatchEvent(new MouseEvent('mousedown', opts));
    canvas.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
  }
  middleClickPending = false;
}, true);

// Swallow the real mouseup of a held-back middle click, so it doesn't arrive
// after the replayed down/up pair as a stray button release.
vncContainer.addEventListener('mouseup', (e) => {
  if (middleClickPending && e.isTrusted && e.button === 1) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }
}, true);

// Ctrl+C: also sync from X clipboard back to browser after a short delay
vncContainer.addEventListener('keydown', async (e) => {
  if (!rfb) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
    // Let noVNC send the Ctrl+C normally, then after a moment read X clipboard
    setTimeout(async () => {
      try {
        const res = await fetch('/api/desktop/clipboard', { credentials: 'same-origin' });
        const data = await res.json();
        if (data.text && navigator.clipboard) {
          navigator.clipboard.writeText(data.text).catch(() => {});
        }
      } catch { /* silent */ }
    }, 300);
  }
});

// ── Dock auto-hide ──────────────────────────────────────────

const dock        = document.getElementById('dock');
const dockTrigger = document.getElementById('dock-trigger');
let dockHideTimer = null;
// Auto-hide is the default everywhere — the dock slides away and the left-edge
// marker shows where it is. The Settings toggle persists an explicit opt-out.
let dockAutoHide  = localStorage.getItem('dock-autohide') !== 'off';

function showDock() {
  clearTimeout(dockHideTimer);
  dock.classList.add('visible');
}

function hideDock() {
  clearTimeout(dockHideTimer);
  dock.classList.remove('visible');
}

function scheduleDockHide() {
  if (!dockAutoHide) return;
  clearTimeout(dockHideTimer);
  dockHideTimer = setTimeout(hideDock, isMobile ? 3000 : 900);
}

function applyAutoHide() {
  if (dockAutoHide) {
    dock.classList.remove('no-autohide', 'visible');
  } else {
    dock.classList.add('no-autohide', 'visible');
  }
}

// Mouse trigger (desktop). A real touch suppresses the compatibility mouse
// events the browser synthesises from it, but on hybrid devices a stray mouse
// event can still arrive right after a touch — and mouseenter calls showDock,
// which would cancel the auto-hide timer the touch path just scheduled. So
// mouse events are ignored for a moment after any touch.
let lastTouchAt = 0;
document.addEventListener('touchstart', () => { lastTouchAt = Date.now(); },
  { capture: true, passive: true });
const fromTouch = () => Date.now() - lastTouchAt < 1000;

dockTrigger.addEventListener('mouseenter', () => { if (!fromTouch()) showDock(); });
// Leaving the hotzone without entering the dock must still arm the timer —
// the hotzone is only a band around the marker, so this is the normal way a
// hover ends when the pointer moves off along the edge.
dockTrigger.addEventListener('mouseleave', scheduleDockHide);
dock.addEventListener('mouseenter', () => { if (!fromTouch()) showDock(); });
dock.addEventListener('mouseleave', scheduleDockHide);

// Touch trigger — tap bottom edge to toggle dock
dockTrigger.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (dock.classList.contains('visible')) {
    hideDock();
  } else {
    showDock();
    scheduleDockHide();
  }
}, { passive: false });

// Hide the dock the moment the user interacts with the remote desktop — a
// mouse click or a touch, on any device. Capture phase is required: noVNC's
// mouse handlers on the canvas call stopPropagation(), and on touch devices
// the trackpad handler below stops touch events too, so a bubble-phase
// listener would never run. Respects the pinned (auto-hide off) setting.
function hideDockForCanvas() {
  if (dockAutoHide && dock.classList.contains('visible')) hideDock();
  // The app dock hides under the same rule (it keeps its own auto-hide
  // state; a pinned dock stays put).
  hideAppDock();
}
vncContainer.addEventListener('pointerdown', hideDockForCanvas, { capture: true });
vncContainer.addEventListener('touchstart', hideDockForCanvas,
  { capture: true, passive: true });

// Hide dock after tapping a dock button (app launched) on touch devices
if (isTouch) {
  dock.addEventListener('click', (e) => {
    if (e.target.closest('.dock-item')) {
      setTimeout(hideDock, 300);
    }
  });
}

applyAutoHide();

// ── Dock magnification (desktop only) ──────────────────────
//
// The dock is a vertical strip, so proximity is measured along Y and each item
// grows outward from its own vertical centre.

if (!isTouch) {
  const MAG_RADIUS = 110;
  const MAG_MAX    = 1.4;

  dock.addEventListener('mousemove', (e) => {
    const my = e.clientY;
    // Live query, not a snapshot: the app dock's section is re-rendered as
    // applications launch and close.
    for (const item of dock.querySelectorAll('.dock-item')) {
      const rect = item.getBoundingClientRect();
      const dist = Math.abs(my - (rect.top + rect.height / 2));
      const mag  = dist < MAG_RADIUS
        ? 1 + (MAG_MAX - 1) * (1 - dist / MAG_RADIUS)
        : 1;
      item.style.setProperty('--mag', mag.toFixed(3));
    }
  });

  dock.addEventListener('mouseleave', () => {
    for (const item of dock.querySelectorAll('.dock-item'))
      item.style.setProperty('--mag', '1');
  });
}

// ── Stats polling (topbar only) ─────────────────────────────

const topbarCpu  = document.getElementById('topbar-cpu');
const topbarRam  = document.getElementById('topbar-ram');
const topbarDisk = document.getElementById('topbar-disk');
const topbarUser = document.getElementById('topbar-user');

async function pollStats() {
  try {
    const res  = await fetch('/api/desktop/stats', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    if (topbarCpu)  topbarCpu.textContent  = `${data.cpu}%`;
    if (topbarRam)  topbarRam.textContent  = `${data.ram}%`;
    if (topbarDisk) topbarDisk.textContent = `${data.disk}%`;
    if (topbarUser && data.user) topbarUser.textContent = data.user;
  } catch { /* silent */ }
}

setInterval(pollStats, 5000);
pollStats();

// ── Top bar clock ───────────────────────────────────────────

const topbarClock = document.getElementById('topbar-clock');
function updateClock() {
  if (!topbarClock) return;
  const now  = new Date();
  const opts = { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  topbarClock.textContent = now.toLocaleDateString('en-US', opts);
}
setInterval(updateClock, 10000);
updateClock();

// ── Top bar buttons ─────────────────────────────────────────

const topbar = document.getElementById('topbar');
let topbarVisible = localStorage.getItem('topbar') !== 'off';

function applyTopbar() {
  // On mobile (<=600px), topbar is hidden via CSS; --topbar-h = 0
  const mobile = window.innerWidth <= 600;
  topbar.classList.toggle('hidden', !topbarVisible || mobile);
  document.documentElement.style.setProperty('--topbar-h', (topbarVisible && !mobile) ? '28px' : '0px');
}
applyTopbar();

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || mobileFullscreen);
}

function toggleFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
    document.webkitExitFullscreen();
  } else if (el.requestFullscreen) {
    el.requestFullscreen().catch(() => { toggleMobileFullscreen(); });
  } else if (el.webkitRequestFullscreen) {
    el.webkitRequestFullscreen();
  } else {
    // iOS Safari / browsers without Fullscreen API
    toggleMobileFullscreen();
  }
}

document.getElementById('topbar-fullscreen').addEventListener('click', toggleFullscreen);
document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);

// Expand/compress icons on the fullscreen buttons (mobile toolbar + dock)
// reflect the effective state, whichever fullscreen flavor is in play.
// toggleAttribute, not the .hidden property: that only exists on HTMLElement,
// so on SVG it would be an inert expando and the icon would never swap.
function updateFullscreenBtn() {
  const fs = isFullscreen();
  for (const btn of document.querySelectorAll('#mob-fullscreen, #btn-fullscreen')) {
    btn.querySelector('.fs-icon-expand').toggleAttribute('hidden', fs);
    btn.querySelector('.fs-icon-compress').toggleAttribute('hidden', !fs);
  }
}

let mobileFullscreen = false;
updateFullscreenBtn();
function toggleMobileFullscreen() {
  mobileFullscreen = !mobileFullscreen;
  document.body.classList.toggle('mobile-fullscreen', mobileFullscreen);
  updateFullscreenBtn();
  if (mobileFullscreen) {
    topbar.classList.add('hidden');
    window.scrollTo(0, 1); // nudge iOS to hide address bar
  } else {
    applyTopbar();
  }
}

// Chromium-only: while the page is in real fullscreen, the Keyboard Lock
// API hands OS-reserved keys (Win, Alt+Tab, most browser shortcuts) to
// the page instead of the host OS, so they reach noVNC and the remote.
// No-op on Firefox/Safari (no API) and iOS (fullscreen is a CSS trick).
// Escape stays special: the browser exits fullscreen only when Esc is
// held ~3s, otherwise it is delivered to the page and forwarded.
function applyKeyboardLock() {
  if (!navigator.keyboard || !navigator.keyboard.lock) return;
  if (document.fullscreenElement) {
    navigator.keyboard.lock().catch(() => {});
  } else if (navigator.keyboard.unlock) {
    navigator.keyboard.unlock();
  }
}

document.addEventListener('fullscreenchange', () => {
  applyKeyboardLock();
  updateFullscreenBtn();
  if (!document.fullscreenElement) applyTopbar();
});

// Route F11 through toggleFullscreen instead of letting it reach the
// remote. Chrome dispatches F11 as a cancellable keydown, so
// preventDefault() stops the native fullscreen and ours (with keyboard
// lock) takes over; under keyboard lock Chrome also hands F11 to the
// page, which would otherwise leave it pressed on the remote. Firefox
// never sends F11 to the page: its native fullscreen fires
// fullscreenchange, and applyKeyboardLock() engages there anyway.
// Capture phase + stopPropagation: noVNC listens on vncContainer below
// document, so a bubble-phase handler would run too late to keep the
// key from being forwarded.
for (const type of ['keydown', 'keyup']) {
  document.addEventListener(type, (e) => {
    if (e.key === 'F11') {
      e.preventDefault();
      e.stopPropagation();
      if (type === 'keydown') toggleFullscreen();
    }
  }, true);
}

document.addEventListener('webkitfullscreenchange', () => {
  updateFullscreenBtn();
  if (!document.webkitFullscreenElement) applyTopbar();
});

document.getElementById('topbar-theme').addEventListener('click', () => {
  setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});

// ── Server-side config (home dir, VNC endpoint, dock options) ───────────
let SERVER_HOME = '/root';
let SERVER_DESKTOP = '/root/Desktop';
let SERVER_WS_URL = '';
let CAN_RESTART = false;
// 'pod' | 'session' | 'command' | 'off' — the server decides which restart
// reaches this deployment's desktop, and 'session' is performed here.
let RESTART_MODE = 'off';

// Resolves once the server has told us how to reach VNC and what the dock
// should offer. connect() awaits this before opening the WebSocket.
const serverConfigReady = (async () => {
  try {
    const r = await fetch('/api/desktop/config', { credentials: 'same-origin' });
    if (r.ok) {
      const cfg = await r.json();
      if (cfg.homeDir) SERVER_HOME = cfg.homeDir;
      if (cfg.desktopDir) SERVER_DESKTOP = cfg.desktopDir;
      if (cfg.wsUrl) SERVER_WS_URL = cfg.wsUrl;

      // The pod restarts itself when we run in a container, otherwise the
      // deployment has to supply a command. Without either, hide the button.
      CAN_RESTART = Boolean(cfg.canRestart);
      RESTART_MODE = cfg.restartMode || (CAN_RESTART ? 'pod' : 'off');
      const btnRestart = document.getElementById('btn-restart');
      if (btnRestart) btnRestart.hidden = !CAN_RESTART;

      if (!localStorage.getItem('upload-dest')) uploadDestInput.value = SERVER_DESKTOP;
    }
  } catch {}
})();

// ── Drag-and-drop uploads ───────────────────────────────────

const dropOverlay = document.getElementById('drop-overlay');
let dragCounter   = 0;

document.addEventListener('dragenter', (e) => {
  e.preventDefault(); dragCounter++;
  if (dragCounter === 1) dropOverlay.hidden = false;
});
document.addEventListener('dragleave', (e) => {
  e.preventDefault(); dragCounter--;
  if (dragCounter <= 0) { dragCounter = 0; dropOverlay.hidden = true; }
});
document.addEventListener('dragover',  (e) => e.preventDefault());

document.addEventListener('drop', async (e) => {
  e.preventDefault(); dragCounter = 0; dropOverlay.hidden = true;
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  const dest = localStorage.getItem('upload-dest') || SERVER_DESKTOP;
  for (const file of files) {
    startUpload(file, dest);
  }
});

// ── Upload button ───────────────────────────────────────────

document.getElementById('btn-upload').addEventListener('click', () => {
  selectedUploadFiles = [];
  updateSelectedFiles();
  uploadModal.hidden = false;
});

// ── Theme ───────────────────────────────────────────────────

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  const btn = document.getElementById('settings-theme');
  if (btn) btn.textContent = theme === 'dark' ? 'Dark' : 'Light';
}

setTheme(localStorage.getItem('theme') || 'dark');

// ── Settings modal ──────────────────────────────────────────

const settingsModal = document.getElementById('settings-modal');

document.getElementById('btn-settings').addEventListener('click', () => {
  settingsModal.hidden = false;
});
document.getElementById('settings-close').addEventListener('click', () => {
  settingsModal.hidden = true;
});
document.getElementById('settings-theme').addEventListener('click', () => {
  setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});

const autohideBtn = document.getElementById('settings-autohide');
autohideBtn.textContent = dockAutoHide ? 'On' : 'Off';
autohideBtn.addEventListener('click', () => {
  dockAutoHide = !dockAutoHide;
  localStorage.setItem('dock-autohide', dockAutoHide ? 'on' : 'off');
  autohideBtn.textContent = dockAutoHide ? 'On' : 'Off';
  applyAutoHide();
  // The app dock follows the same setting.
  setAppDockAutoHide(dockAutoHide);
});

const topbarBtn = document.getElementById('settings-topbar');
topbarBtn.textContent = topbarVisible ? 'On' : 'Off';
topbarBtn.addEventListener('click', () => {
  topbarVisible = !topbarVisible;
  localStorage.setItem('topbar', topbarVisible ? 'on' : 'off');
  topbarBtn.textContent = topbarVisible ? 'On' : 'Off';
  applyTopbar();
});

// Build caption. Both placeholders are stamped into the deployed sources by
// scripts/stamp-cache-version.sh (BUILD_DATETIME is UTC ISO, rendered below
// in the viewer's own timezone). An unstamped dev tree keeps the literals:
// the datetime fails to parse and the caption stays hidden.
const APP_VERSION = '%CACHE_VERSION%';
const APP_BUILD_DATETIME = '%BUILD_DATETIME%';

const versionCaption = document.getElementById('settings-version');
if (versionCaption) {
  const builtAt = new Date(APP_BUILD_DATETIME);
  const isStamped = !APP_VERSION.includes('%') && !Number.isNaN(builtAt.getTime());
  if (isStamped) {
    versionCaption.textContent = `Version ${APP_VERSION} · built `
      + builtAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    versionCaption.hidden = false;
  }
}

// ── Resolution modal ────────────────────────────────────────

const resolutionModal = document.getElementById('resolution-modal');

document.getElementById('btn-resolution').addEventListener('click', () => {
  resolutionModal.hidden = false;
});
document.getElementById('resolution-close').addEventListener('click', () => {
  resolutionModal.hidden = true;
});

document.querySelectorAll('.res-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    let w = parseInt(btn.dataset.w, 10);
    let h = parseInt(btn.dataset.h, 10);
    if (w === 0 && h === 0) {
      autoFitResolution();
      resolutionModal.hidden = true;
      return;
    }
    try {
      await fetch('/api/desktop/resolution', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ width: w, height: h }),
      });
    } catch { /* silent */ }
    resolutionModal.hidden = true;
  });
});

// ── Send Ctrl+Alt+Del ───────────────────────────────────────

document.getElementById('btn-keys').addEventListener('click', () => {
  if (rfb) rfb.sendCtrlAltDel();
});

// ── Restart desktop ─────────────────────────────────────────

// The restart takes the whole pod down, so the HTTP server and the VNC backend
// disappear together and come back a variable time later (XFCE has to start
// again). Poll /health until it answers, then reconnect: a fixed delay either
// fires while the pod is still down or leaves the user on a dead screen.
async function waitForServerBack() {
  // Let the outgoing process actually go first, so an early /health cannot be
  // answered by the instance that is on its way out.
  await new Promise((r) => setTimeout(r, 2500));
  for (let i = 0; i < 80; i++) {           // ~2 minutes at 1.5s intervals
    try {
      const r = await fetch(`/health?_=${Date.now()}`,
        { cache: 'no-store', credentials: 'same-origin' });
      if (r.ok) return true;
    } catch { /* still restarting */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

document.getElementById('btn-restart').addEventListener('click', async () => {
  // A desktop in a container of its own is only reachable through the session
  // it serves: the chord logs it out, start-vnc tears that container down and
  // Kubernetes starts it again. The VNC disconnect that follows drives the
  // normal reconnect loop, so this path only has to press the keys.
  if (RESTART_MODE === 'session') {
    if (!confirm('Restart the desktop? Unsaved work is lost.')) return;
    if (!vncUp || !sendRestartShortcut(rfb)) {
      showStatus('Not connected to the desktop — cannot restart it.');
      return;
    }
    showStatus('Restarting desktop…');
    return;
  }

  if (!confirm('Restart the desktop? The pod restarts and unsaved work is lost.')) return;
  showStatus('Restarting desktop…');
  try {
    await fetch('/api/desktop/restart', { method: 'POST', credentials: 'same-origin' });
  } catch { /* the server exits mid-response — that is the restart */ }
  const back = await waitForServerBack();
  if (back) {
    connect();
  } else {
    showStatus('The desktop did not come back — reload the page to retry.');
  }
});

// ── Window switcher ─────────────────────────────────────────

const windowList      = document.getElementById('window-list');
const windowListItems = document.getElementById('window-list-items');

function windowIcon(title) {
  const t = title.toLowerCase();
  if (t.includes('firefox') || t.includes('mozilla'))   return 'firefox';
  if (t.includes('chrome') || t.includes('chromium'))    return 'chrome';
  if (t.includes('visual studio') || t.includes('vs code') || t.includes('vscode')) return 'code';
  if (t.includes('terminal'))                            return 'terminal';
  if (t.includes('thunar') || t.includes('file'))        return 'folder';
  if (t.includes('mousepad') || t.includes('editor'))    return 'edit';
  return 'window';
}

const iconSvgs = {
  firefox:  '<svg viewBox="0 0 16 16" fill="#ff6611"><circle cx="8" cy="8" r="7"/></svg>',
  chrome:   '<svg viewBox="0 0 16 16" fill="#4285f4"><circle cx="8" cy="8" r="7"/></svg>',
  code:     '<svg viewBox="0 0 24 24" fill="#007ACC" fill-rule="evenodd"><path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .325 8.74L3.899 12 .325 15.26a1 1 0 0 0 .002 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/></svg>',
  terminal: '<svg viewBox="0 0 16 16" fill="none" stroke="#30d158" stroke-width="2"><path d="M3 4l5 4-5 4"/></svg>',
  folder:   '<svg viewBox="0 0 16 16" fill="#42a5f5"><rect x="1" y="5" width="14" height="9" rx="2"/><path d="M1 7V5Q1 3 3 3H6Q8 3 8.5 5L10 7Z"/></svg>',
  edit:     '<svg viewBox="0 0 16 16" fill="none" stroke="#4caf50" stroke-width="1.5"><rect x="3" y="1" width="10" height="14" rx="2"/><line x1="6" y1="5" x2="10" y2="5"/><line x1="6" y1="8" x2="10" y2="8"/></svg>',
  window:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="10" rx="2"/><line x1="2" y1="6" x2="14" y2="6"/></svg>',
};

async function refreshWindowList() {
  try {
    const res  = await fetch('/api/desktop/windows', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();

    if (!data.windows.length) {
      windowListItems.innerHTML = '<div class="window-list-empty">No windows open</div>';
      return;
    }

    windowListItems.innerHTML = data.windows.map(w => {
      const ico = windowIcon(w.title);
      const safeTitle = w.title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // Only the resolved app icon renders; the heuristic glyph is inserted
      // if that image fails. It must not sit underneath the image — theme
      // icons are transparent, so the glyph would show through.
      const icon = w.appId
        ? `<img src="${iconUrl(w.appId, 32)}" alt="" loading="lazy">`
        : iconSvgs[ico];
      return `<button class="window-entry" data-wid="${w.id}">
        <span class="window-entry-icon" data-fallback="${ico}">${icon}</span>
        <span class="window-entry-title">${safeTitle}</span>
      </button>`;
    }).join('');

    // Failed icon loads fall back to the heuristic glyph.
    windowListItems.querySelectorAll('.window-entry-icon img').forEach((img) => {
      img.addEventListener('error', () => {
        const wrap = img.parentElement;
        img.remove();
        wrap.innerHTML = iconSvgs[wrap.dataset.fallback] || iconSvgs.window;
      });
    });

    // Attach click handlers
    windowListItems.querySelectorAll('.window-entry').forEach(btn => {
      btn.addEventListener('click', async () => {
        const wid = btn.dataset.wid;
        try {
          await fetch('/api/desktop/windows/focus', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: wid }),
          });
        } catch { /* silent */ }
        windowList.hidden = true;
      });
    });
  } catch { /* silent */ }
}

document.getElementById('btn-windows').addEventListener('click', (e) => {
  e.stopPropagation();
  const wasHidden = windowList.hidden;
  windowList.hidden = !wasHidden;
  if (wasHidden) refreshWindowList();
});

// Close window list on outside click
document.addEventListener('click', (e) => {
  if (!windowList.hidden && !windowList.contains(e.target) && e.target.id !== 'btn-windows') {
    windowList.hidden = true;
  }
});

// Canvas clicks are stopped by noVNC before they reach the listener above,
// so the switcher also closes from the capture phase on the canvas itself.
function closeWindowListForCanvas() {
  if (!windowList.hidden) windowList.hidden = true;
}
vncContainer.addEventListener('pointerdown', closeWindowListForCanvas, { capture: true });
vncContainer.addEventListener('touchstart', closeWindowListForCanvas,
  { capture: true, passive: true });

// ── App dock (bottom) ───────────────────────────────────────
// The browser-side replacement for the Plank dock: pinned + running
// applications on a bottom-edge dock, and the applications grid. The
// appdock module owns its own polling, pins and menus; it only needs the
// device flags and the stamped cache version for icon URLs.
initAppDock({ isTouch, isMobile, cacheVersion: APP_VERSION });

// ── Modal dismiss: backdrop click & Escape ──────────────────

const allModals = [resolutionModal, settingsModal, uploadModal, dirModal, filebrowserModal,
  document.getElementById('apps-modal')];

allModals.forEach((modal) => {
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    allModals.forEach((m) => { m.hidden = true; });
    windowList.hidden = true;
  }
});

// ── Upload Manager ──────────────────────────────────────────

const uploadMgr       = document.getElementById('upload-manager');
const uploadList      = document.getElementById('upload-list');
const uploadCount     = document.getElementById('upload-count');
const uploadDestInput = document.getElementById('upload-dest-input');
const uploadFileInput = document.getElementById('upload-file-input');
const uploadDropzone  = document.getElementById('upload-dropzone');
const uploadSelected  = document.getElementById('upload-selected');
const uploadStartBtn  = document.getElementById('upload-start-btn');

// (selectedUploadFiles, uploads, downloads declared at top of file)

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function fmtSpeed(bps) {
  if (bps < 1024) return Math.round(bps) + ' B/s';
  if (bps < 1048576) return (bps / 1024).toFixed(0) + ' KB/s';
  return (bps / 1048576).toFixed(1) + ' MB/s';
}

function fmtEta(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '--';
  if (seconds < 60) return Math.ceil(seconds) + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + Math.ceil(seconds % 60) + 's';
  return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
}

function showUploadMgr() {
  uploadMgr.hidden = false;
  uploadMgr.classList.remove('minimized');
}

function updateTransferCount() {
  let active = 0;
  for (const u of uploads.values()) {
    if (u.status === 'uploading' || u.status === 'paused') active++;
  }
  for (const d of downloads.values()) {
    if (d.status === 'downloading' || d.status === 'paused') active++;
  }
  uploadCount.textContent = active > 0 ? `${active} active` : '';
}

async function startUpload(file, destination) {
  try {
    const res = await fetch('/api/desktop/upload/init', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, totalSize: file.size, destination }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const upload = {
      id: data.uploadId, file, filename: file.name,
      totalSize: file.size, chunkSize: data.chunkSize,
      totalChunks: data.totalChunks, currentChunk: 0,
      bytesUploaded: 0, status: 'uploading', speed: 0, xhr: null,
      startTime: Date.now(), lastSpeedTime: Date.now(), lastSpeedBytes: 0,
    };

    uploads.set(upload.id, upload);
    renderUploadItem(upload);
    showUploadMgr();
    updateTransferCount();
    sendChunk(upload);
  } catch (err) {
    console.error('Upload init failed:', err);
  }
}

function sendChunk(upload) {
  if (upload.status !== 'uploading') return;
  if (upload.currentChunk >= upload.totalChunks) return;

  const start = upload.currentChunk * upload.chunkSize;
  const end = Math.min(start + upload.chunkSize, upload.totalSize);
  const blob = upload.file.slice(start, end);

  const xhr = new XMLHttpRequest();
  upload.xhr = xhr;

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      upload.bytesUploaded = start + e.loaded;
      const now = Date.now();
      const dt = (now - upload.lastSpeedTime) / 1000;
      if (dt > 0.3) {
        upload.speed = (upload.bytesUploaded - upload.lastSpeedBytes) / dt;
        upload.lastSpeedTime = now;
        upload.lastSpeedBytes = upload.bytesUploaded;
      }
      updateUploadItem(upload);
    }
  });

  xhr.addEventListener('load', () => {
    if (xhr.status === 200) {
      const data = JSON.parse(xhr.responseText);
      upload.currentChunk++;
      if (data.completed) {
        upload.status = 'completed';
        upload.bytesUploaded = upload.totalSize;
        updateUploadItem(upload);
        updateTransferCount();
        notify(`Upload complete: ${upload.filename}`, 'success');
        return;
      }
      sendChunk(upload);
    } else {
      upload.status = 'error';
      updateUploadItem(upload);
      updateTransferCount();
    }
  });

  xhr.addEventListener('error', () => {
    upload.status = 'error';
    updateUploadItem(upload);
    updateTransferCount();
  });

  xhr.open('POST', `/api/desktop/upload/chunk?uploadId=${encodeURIComponent(upload.id)}`);
  xhr.withCredentials = true;
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.send(blob);
}

function pauseUpload(uploadId) {
  const u = uploads.get(uploadId);
  if (!u || u.status !== 'uploading') return;
  u.status = 'paused';
  if (u.xhr) { u.xhr.abort(); u.xhr = null; }
  updateUploadItem(u);
  updateTransferCount();
  fetch('/api/desktop/upload/pause', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId }),
  }).catch(() => {});
}

async function resumeUpload(uploadId) {
  const u = uploads.get(uploadId);
  if (!u || u.status !== 'paused') return;
  try {
    const res = await fetch('/api/desktop/upload/resume', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    });
    const data = await res.json();
    u.currentChunk = data.chunksReceived;
    u.bytesUploaded = data.bytesReceived;
    u.status = 'uploading';
    u.lastSpeedTime = Date.now();
    u.lastSpeedBytes = u.bytesUploaded;
    updateUploadItem(u);
    updateTransferCount();
    sendChunk(u);
  } catch { /* silent */ }
}

function cancelUpload(uploadId) {
  const u = uploads.get(uploadId);
  if (!u) return;
  if (u.xhr) { u.xhr.abort(); u.xhr = null; }
  u.status = 'cancelled';
  updateUploadItem(u);
  updateTransferCount();
  fetch(`/api/desktop/upload/${encodeURIComponent(uploadId)}`, {
    method: 'DELETE', credentials: 'same-origin',
  }).catch(() => {});
  setTimeout(() => {
    uploads.delete(uploadId);
    const el = document.getElementById(`upload-${uploadId}`);
    if (el) el.remove();
    if (uploads.size === 0) uploadMgr.hidden = true;
  }, 2000);
}

function renderUploadItem(u) {
  const div = document.createElement('div');
  div.className = 'upload-item';
  div.id = `upload-${u.id}`;
  div.innerHTML = `
    <div class="upload-item-info">
      <span class="upload-item-name">${u.filename.replace(/</g, '&lt;')}</span>
      <span class="upload-item-meta">
        <span class="upload-item-progress-text">0%</span>
        <span class="upload-item-speed"></span>
        <span class="upload-item-eta"></span>
      </span>
    </div>
    <div class="upload-item-bar"><div class="upload-item-fill"></div></div>
    <div class="upload-item-actions">
      <button class="upload-action-btn upload-pause" title="Pause">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><rect x="3" y="2" width="4" height="12" rx="1"/><rect x="9" y="2" width="4" height="12" rx="1"/></svg>
      </button>
      <button class="upload-action-btn upload-resume" title="Resume" hidden>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4 2l10 6-10 6z"/></svg>
      </button>
      <button class="upload-action-btn upload-cancel" title="Cancel">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>
      </button>
    </div>
  `;
  div.querySelector('.upload-pause').addEventListener('click', () => pauseUpload(u.id));
  div.querySelector('.upload-resume').addEventListener('click', () => resumeUpload(u.id));
  div.querySelector('.upload-cancel').addEventListener('click', () => cancelUpload(u.id));
  uploadList.appendChild(div);
}

function updateUploadItem(u) {
  const el = document.getElementById(`upload-${u.id}`);
  if (!el) return;
  const pct = u.totalSize > 0 ? Math.round((u.bytesUploaded / u.totalSize) * 100) : 0;
  el.querySelector('.upload-item-fill').style.width = pct + '%';
  el.querySelector('.upload-item-progress-text').textContent = pct + '%';

  const speedEl   = el.querySelector('.upload-item-speed');
  const etaEl     = el.querySelector('.upload-item-eta');
  const pauseBtn  = el.querySelector('.upload-pause');
  const resumeBtn = el.querySelector('.upload-resume');
  const cancelBtn = el.querySelector('.upload-cancel');

  if (u.status === 'uploading') {
    speedEl.textContent = fmtSpeed(u.speed);
    const remaining = u.totalSize - u.bytesUploaded;
    etaEl.textContent = u.speed > 0 ? fmtEta(remaining / u.speed) : '';
    pauseBtn.hidden = false; resumeBtn.hidden = true; cancelBtn.hidden = false;
  } else if (u.status === 'paused') {
    speedEl.textContent = 'Paused'; etaEl.textContent = '';
    pauseBtn.hidden = true; resumeBtn.hidden = false; cancelBtn.hidden = false;
  } else if (u.status === 'completed') {
    speedEl.textContent = 'Done'; etaEl.textContent = fmtSize(u.totalSize);
    el.querySelector('.upload-item-fill').style.background = 'var(--stat-cpu)';
    pauseBtn.hidden = true; resumeBtn.hidden = true; cancelBtn.hidden = true;
  } else if (u.status === 'error') {
    speedEl.textContent = 'Error'; etaEl.textContent = '';
    pauseBtn.hidden = true; resumeBtn.hidden = false; cancelBtn.hidden = false;
  } else if (u.status === 'cancelled') {
    speedEl.textContent = 'Cancelled'; etaEl.textContent = '';
    pauseBtn.hidden = true; resumeBtn.hidden = true; cancelBtn.hidden = true;
    el.style.opacity = '0.5';
  }
}

// ── Upload Modal interactions ───────────────────────────────

uploadDestInput.value = localStorage.getItem('upload-dest') || SERVER_DESKTOP;

uploadDropzone.addEventListener('click', () => uploadFileInput.click());
uploadDropzone.addEventListener('dragover', (e) => {
  e.preventDefault(); uploadDropzone.classList.add('dragover');
});
uploadDropzone.addEventListener('dragleave', () => uploadDropzone.classList.remove('dragover'));
uploadDropzone.addEventListener('drop', (e) => {
  e.preventDefault(); e.stopPropagation();
  uploadDropzone.classList.remove('dragover');
  dragCounter = 0; dropOverlay.hidden = true;
  if (e.dataTransfer?.files) {
    for (const f of e.dataTransfer.files) selectedUploadFiles.push(f);
    updateSelectedFiles();
  }
});

uploadFileInput.addEventListener('change', () => {
  for (const f of (uploadFileInput.files || [])) selectedUploadFiles.push(f);
  uploadFileInput.value = '';
  updateSelectedFiles();
});

function updateSelectedFiles() {
  uploadStartBtn.disabled = selectedUploadFiles.length === 0;
  if (selectedUploadFiles.length === 0) { uploadSelected.innerHTML = ''; return; }
  const totalSize = selectedUploadFiles.reduce((a, f) => a + f.size, 0);
  uploadSelected.innerHTML =
    `<div class="upload-file-count">${selectedUploadFiles.length} file${selectedUploadFiles.length > 1 ? 's' : ''} (${fmtSize(totalSize)})</div>` +
    selectedUploadFiles.map((f, i) =>
      `<div class="upload-file-entry">
        <span>${f.name.replace(/</g, '&lt;')}</span>
        <span class="upload-file-size">${fmtSize(f.size)}</span>
        <button class="upload-file-remove" data-idx="${i}">&times;</button>
      </div>`
    ).join('');
  uploadSelected.querySelectorAll('.upload-file-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedUploadFiles.splice(parseInt(btn.dataset.idx), 1);
      updateSelectedFiles();
    });
  });
}

uploadStartBtn.addEventListener('click', () => {
  const dest = uploadDestInput.value.trim() || SERVER_DESKTOP;
  localStorage.setItem('upload-dest', dest);
  uploadModal.hidden = true;
  for (const file of selectedUploadFiles) startUpload(file, dest);
  selectedUploadFiles = [];
});

document.getElementById('upload-cancel-btn').addEventListener('click', () => {
  uploadModal.hidden = true;
  selectedUploadFiles = [];
});

// ── Directory Browser ───────────────────────────────────────

const dirPath = document.getElementById('dir-path');
const dirList = document.getElementById('dir-list');
let currentBrowseDir = SERVER_HOME;

document.getElementById('upload-browse-dir').addEventListener('click', () => {
  currentBrowseDir = uploadDestInput.value.trim() || SERVER_HOME;
  loadDirList(currentBrowseDir);
  dirModal.hidden = false;
});

async function loadDirList(dir) {
  dirPath.textContent = dir;
  currentBrowseDir = dir;
  try {
    const res = await fetch(`/api/desktop/browse?dir=${encodeURIComponent(dir)}`, { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    let html = '';
    if (data.parent !== data.current) {
      html += `<button class="dir-entry dir-parent" data-path="${data.parent.replace(/"/g, '&quot;')}">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 4L6 8l4 4"/></svg>
        ..
      </button>`;
    }
    for (const d of data.directories) {
      html += `<button class="dir-entry" data-path="${d.path.replace(/"/g, '&quot;')}">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="var(--accent)"><rect x="1" y="5" width="14" height="9" rx="2"/><path d="M1 7V5Q1 3 3 3H6Q8 3 8.5 5L10 7Z"/></svg>
        ${d.name.replace(/</g, '&lt;')}
      </button>`;
    }
    if (!data.directories.length && data.parent === data.current) {
      html = '<div class="dir-empty">Empty directory</div>';
    }
    dirList.innerHTML = html;
    dirList.querySelectorAll('.dir-entry').forEach(btn => {
      btn.addEventListener('click', () => loadDirList(btn.dataset.path));
    });
  } catch {
    dirList.innerHTML = '<div class="dir-empty">Cannot access directory</div>';
  }
}

document.getElementById('dir-select-btn').addEventListener('click', () => {
  uploadDestInput.value = currentBrowseDir;
  dirModal.hidden = true;
});

document.getElementById('dir-cancel-btn').addEventListener('click', () => {
  dirModal.hidden = true;
});

// ── Upload Manager controls ─────────────────────────────────

document.getElementById('upload-minimize').addEventListener('click', () => {
  uploadMgr.classList.toggle('minimized');
});

document.getElementById('upload-close-mgr').addEventListener('click', () => {
  let hasActive = false;
  for (const u of uploads.values()) {
    if (u.status === 'uploading' || u.status === 'paused') hasActive = true;
  }
  for (const d of downloads.values()) {
    if (d.status === 'downloading' || d.status === 'paused') hasActive = true;
  }
  if (hasActive) {
    uploadMgr.classList.add('minimized');
  } else {
    uploadMgr.hidden = true;
    uploads.clear();
    downloads.clear();
    uploadList.innerHTML = '';
  }
});

// ── Download Manager ────────────────────────────────────────

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 8);
}

async function startDownload(filePath, filename, fileSize) {
  const dl = {
    id: genId(), filePath, filename, totalSize: fileSize,
    bytesDownloaded: 0, status: 'downloading', speed: 0,
    chunks: [], controller: null,
    startTime: Date.now(), lastSpeedTime: Date.now(), lastSpeedBytes: 0,
  };
  downloads.set(dl.id, dl);
  renderDownloadItem(dl);
  showUploadMgr();
  updateTransferCount();
  fetchDownloadChunks(dl);
}

async function fetchDownloadChunks(dl) {
  if (dl.status !== 'downloading') return;
  const controller = new AbortController();
  dl.controller = controller;
  try {
    const headers = {};
    if (dl.bytesDownloaded > 0) {
      headers['Range'] = `bytes=${dl.bytesDownloaded}-`;
    }
    const res = await fetch(`/api/desktop/download?file=${encodeURIComponent(dl.filePath)}`, {
      credentials: 'same-origin', signal: controller.signal, headers,
    });
    if (!res.ok && res.status !== 206) throw new Error('Download failed');
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (dl.status !== 'downloading') { reader.cancel(); return; }
      dl.chunks.push(value);
      dl.bytesDownloaded += value.length;
      const now = Date.now();
      const dt = (now - dl.lastSpeedTime) / 1000;
      if (dt > 0.3) {
        dl.speed = (dl.bytesDownloaded - dl.lastSpeedBytes) / dt;
        dl.lastSpeedTime = now;
        dl.lastSpeedBytes = dl.bytesDownloaded;
      }
      updateDownloadItem(dl);
    }
    // Complete — trigger browser save
    const blob = new Blob(dl.chunks);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = dl.filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    dl.status = 'completed';
    dl.chunks = [];
    updateDownloadItem(dl);
    updateTransferCount();
    notify(`Download complete: ${dl.filename}`, 'success');
  } catch (err) {
    if (err.name === 'AbortError') return;
    dl.status = 'error';
    updateDownloadItem(dl);
    updateTransferCount();
  }
}

function pauseDownload(dlId) {
  const dl = downloads.get(dlId);
  if (!dl || dl.status !== 'downloading') return;
  dl.status = 'paused';
  if (dl.controller) { dl.controller.abort(); dl.controller = null; }
  updateDownloadItem(dl);
  updateTransferCount();
}

function resumeDownload(dlId) {
  const dl = downloads.get(dlId);
  if (!dl || dl.status !== 'paused') return;
  dl.status = 'downloading';
  dl.lastSpeedTime = Date.now();
  dl.lastSpeedBytes = dl.bytesDownloaded;
  updateDownloadItem(dl);
  updateTransferCount();
  fetchDownloadChunks(dl);
}

function cancelDownload(dlId) {
  const dl = downloads.get(dlId);
  if (!dl) return;
  if (dl.controller) { dl.controller.abort(); dl.controller = null; }
  dl.status = 'cancelled';
  dl.chunks = [];
  updateDownloadItem(dl);
  updateTransferCount();
  setTimeout(() => {
    downloads.delete(dlId);
    const el = document.getElementById(`dl-${dlId}`);
    if (el) el.remove();
    if (uploads.size === 0 && downloads.size === 0) uploadMgr.hidden = true;
  }, 2000);
}

function renderDownloadItem(dl) {
  const div = document.createElement('div');
  div.className = 'upload-item upload-item-dl';
  div.id = `dl-${dl.id}`;
  div.innerHTML = `
    <div class="upload-item-info">
      <span class="upload-item-name">${dl.filename.replace(/</g, '&lt;')}</span>
      <span class="upload-item-meta">
        <span class="upload-item-progress-text">0%</span>
        <span class="upload-item-speed"></span>
        <span class="upload-item-eta"></span>
      </span>
    </div>
    <div class="upload-item-bar"><div class="upload-item-fill"></div></div>
    <div class="upload-item-actions">
      <button class="upload-action-btn upload-pause" title="Pause">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><rect x="3" y="2" width="4" height="12" rx="1"/><rect x="9" y="2" width="4" height="12" rx="1"/></svg>
      </button>
      <button class="upload-action-btn upload-resume" title="Resume" hidden>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4 2l10 6-10 6z"/></svg>
      </button>
      <button class="upload-action-btn upload-cancel" title="Cancel">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>
      </button>
    </div>
  `;
  div.querySelector('.upload-pause').addEventListener('click', () => pauseDownload(dl.id));
  div.querySelector('.upload-resume').addEventListener('click', () => resumeDownload(dl.id));
  div.querySelector('.upload-cancel').addEventListener('click', () => cancelDownload(dl.id));
  uploadList.appendChild(div);
}

function updateDownloadItem(dl) {
  const el = document.getElementById(`dl-${dl.id}`);
  if (!el) return;
  const pct = dl.totalSize > 0 ? Math.round((dl.bytesDownloaded / dl.totalSize) * 100) : 0;
  el.querySelector('.upload-item-fill').style.width = pct + '%';
  el.querySelector('.upload-item-progress-text').textContent = pct + '%';

  const speedEl   = el.querySelector('.upload-item-speed');
  const etaEl     = el.querySelector('.upload-item-eta');
  const pauseBtn  = el.querySelector('.upload-pause');
  const resumeBtn = el.querySelector('.upload-resume');
  const cancelBtn = el.querySelector('.upload-cancel');

  if (dl.status === 'downloading') {
    speedEl.textContent = fmtSpeed(dl.speed);
    const remaining = dl.totalSize - dl.bytesDownloaded;
    etaEl.textContent = dl.speed > 0 ? fmtEta(remaining / dl.speed) : '';
    pauseBtn.hidden = false; resumeBtn.hidden = true; cancelBtn.hidden = false;
  } else if (dl.status === 'paused') {
    speedEl.textContent = 'Paused'; etaEl.textContent = '';
    pauseBtn.hidden = true; resumeBtn.hidden = false; cancelBtn.hidden = false;
  } else if (dl.status === 'completed') {
    speedEl.textContent = 'Saved'; etaEl.textContent = fmtSize(dl.totalSize);
    el.querySelector('.upload-item-fill').style.width = '100%';
    pauseBtn.hidden = true; resumeBtn.hidden = true; cancelBtn.hidden = true;
  } else if (dl.status === 'error') {
    speedEl.textContent = 'Error'; etaEl.textContent = '';
    pauseBtn.hidden = true; resumeBtn.hidden = false; cancelBtn.hidden = false;
  } else if (dl.status === 'cancelled') {
    speedEl.textContent = 'Cancelled'; etaEl.textContent = '';
    pauseBtn.hidden = true; resumeBtn.hidden = true; cancelBtn.hidden = true;
    el.style.opacity = '0.5';
  }
}

// ── File Browser (for downloads) ────────────────────────────

const fbPathInput = document.getElementById('fb-path-input');
const fbList = document.getElementById('fb-list');
let currentFbDir = SERVER_HOME;
const fbHistory = [];

document.getElementById('btn-download').addEventListener('click', () => {
  currentFbDir = localStorage.getItem('fb-last-dir') || SERVER_HOME;
  fbHistory.length = 0;
  loadFileBrowser(currentFbDir);
  filebrowserModal.hidden = false;
});

document.getElementById('fb-close').addEventListener('click', () => {
  filebrowserModal.hidden = true;
});

// Back button
document.getElementById('fb-back').addEventListener('click', () => {
  if (fbHistory.length > 0) {
    loadFileBrowser(fbHistory.pop(), true);
  } else if (currentFbDir !== '/') {
    // Go to parent
    const parent = currentFbDir.replace(/\/[^/]+\/?$/, '') || '/';
    loadFileBrowser(parent, true);
  }
});

// Path input — Enter or Go button
document.getElementById('fb-go').addEventListener('click', () => {
  const val = fbPathInput.value.trim();
  if (val) loadFileBrowser(val);
});
fbPathInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const val = fbPathInput.value.trim();
    if (val) loadFileBrowser(val);
  }
});

// Rename helper
async function renameFbEntry(oldPath, currentName, entry) {
  const nameSpan = entry.querySelector('.fb-entry-name');
  const origHtml = nameSpan.innerHTML;

  // Replace name with input
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'fb-rename-input';
  input.value = currentName;
  nameSpan.innerHTML = '';
  nameSpan.appendChild(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newName = input.value.trim();
    if (!newName || newName === currentName) {
      nameSpan.innerHTML = origHtml;
      return;
    }
    try {
      const res = await fetch('/api/desktop/rename', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPath, newName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      loadFileBrowser(currentFbDir);
    } catch (err) {
      nameSpan.innerHTML = origHtml;
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { nameSpan.innerHTML = origHtml; }
    e.stopPropagation();
  });
  input.addEventListener('blur', commit);
}

async function loadFileBrowser(dir, skipHistory) {
  if (!skipHistory && currentFbDir && currentFbDir !== dir) {
    fbHistory.push(currentFbDir);
  }
  currentFbDir = dir;
  fbPathInput.value = dir;
  localStorage.setItem('fb-last-dir', dir);
  try {
    const res = await fetch(`/api/desktop/browse?dir=${encodeURIComponent(dir)}&files=true`, { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const renameSvg = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"/></svg>';

    let html = '';
    // Directories
    for (const d of data.directories) {
      html += `<div class="fb-entry fb-dir-row" data-path="${d.path.replace(/"/g, '&quot;')}" data-name="${d.name.replace(/"/g, '&quot;')}">
        <svg class="fb-entry-icon" viewBox="0 0 16 16" width="14" height="14" fill="var(--accent)"><rect x="1" y="5" width="14" height="9" rx="2"/><path d="M1 7V5Q1 3 3 3H6Q8 3 8.5 5L10 7Z"/></svg>
        <span class="fb-entry-name">${d.name.replace(/</g, '&lt;')}</span>
        <span class="fb-entry-size"></span>
        <button class="fb-entry-rename" title="Rename">${renameSvg}</button>
      </div>`;
    }
    // Files
    if (data.files) {
      for (const f of data.files) {
        html += `<div class="fb-entry fb-file" data-path="${f.path.replace(/"/g, '&quot;')}" data-name="${f.name.replace(/"/g, '&quot;')}">
          <svg class="fb-entry-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="var(--text-muted)" stroke-width="1.3"><rect x="3" y="1" width="10" height="14" rx="2"/><line x1="6" y1="5" x2="10" y2="5"/><line x1="6" y1="8" x2="10" y2="8"/></svg>
          <span class="fb-entry-name">${f.name.replace(/</g, '&lt;')}</span>
          <span class="fb-entry-size">${fmtSize(f.size)}</span>
          <button class="fb-entry-rename" title="Rename">${renameSvg}</button>
          <button class="fb-entry-dl" data-path="${f.path.replace(/"/g, '&quot;')}" data-name="${f.name.replace(/"/g, '&quot;')}" data-size="${f.size}" title="Download">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="4 8 8 12 12 8"/><line x1="8" y1="12" x2="8" y2="2"/></svg>
          </button>
        </div>`;
      }
    }
    if (!data.directories.length && (!data.files || !data.files.length)) {
      html = '<div class="dir-empty">Empty directory</div>';
    }
    fbList.innerHTML = html;

    // Navigate directories (click on row, not buttons)
    fbList.querySelectorAll('.fb-dir-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.fb-entry-rename')) return;
        loadFileBrowser(row.dataset.path);
      });
      row.style.cursor = 'pointer';
    });
    // Rename buttons
    fbList.querySelectorAll('.fb-entry-rename').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const entry = btn.closest('.fb-entry');
        renameFbEntry(entry.dataset.path, entry.dataset.name, entry);
      });
    });
    // Download buttons
    fbList.querySelectorAll('.fb-entry-dl').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        startDownload(btn.dataset.path, btn.dataset.name, parseInt(btn.dataset.size, 10));
      });
    });
  } catch {
    fbList.innerHTML = '<div class="dir-empty">Cannot access directory</div>';
  }
}

// ── Mobile / Touch Enhancements ─────────────────────────────

// Standalone (home screen app) detection
const isStandalone = window.matchMedia('(display-mode: standalone)').matches
  || window.navigator.standalone === true;

// iOS-specific fixes
if (isIOS) {
  // Fix iOS Safari 100vh issue
  function setVH() {
    document.documentElement.style.setProperty('--real-vh', window.innerHeight + 'px');
  }
  window.addEventListener('resize', setVH);
  window.addEventListener('orientationchange', () => setTimeout(setVH, 100));
  setVH();
}

// PWA standalone mode enhancements
if (isStandalone) {
  document.body.classList.add('standalone-app');
  // Prevent accidental navigation
  window.addEventListener('beforeunload', (e) => {
    if (rfb) { e.preventDefault(); }
  });
  // Disable context menu in PWA (right-click handled by VNC)
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('input, textarea, .modal')) e.preventDefault();
  });
  // Auto-fit resolution when PWA window is resized (Windows/Mac/Linux desktop PWA)
  if (!isTouch) {
    let pwaResizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(pwaResizeTimer);
      pwaResizeTimer = setTimeout(() => { if (rfb) autoFitResolution(); }, 500);
    });
  }
}

// Bounds for the remote resolution. These are a sanity rail, not the shape:
// the fit below moves the two dimensions together, because a remote desktop
// with the wrong aspect ratio cannot fill the page. noVNC scales it to fit
// inside the canvas and leaves the remainder as empty margin, so on a 390x844
// phone a 640x840 desktop (what independent clamping produced) was being
// scaled down to 390x512 with a third of the page blank.
const MAX_RES_W = 1920, MAX_RES_H = 1200;
const MIN_RES_H = 240;

// Auto-fit VNC resolution to match the area the canvas actually occupies
function autoFitResolution() {
  // Stand down only while the keyboard is animating in or out: fitting to a
  // viewport that is still moving would land on a size that exists for a few
  // hundred ms. Once it has settled -- up or down -- fitting is exactly what
  // we want: the desktop tracks the strip above the keyboard while typing,
  // and the full viewport again once it is gone. The keyboard module
  // suspends noVNC's own resize for the same reason.
  if (keyboard && keyboard.blocksResize()) {
    return Promise.resolve(null);
  }

  // The soft keyboard is not a shape for the desktop to take, only something
  // laid over it. Shrinking the remote to the strip left above it re-flows every
  // window on the desktop each time the keyboard comes or goes, so the
  // resolution is left exactly as it was and the client magnifies the region
  // around the cursor instead -- see applyKeyboardZoom().
  if (keyboard && keyboard.isOpen()) {
    return Promise.resolve(null);
  }

  // Measure the canvas, not the window: the topbar eats vertical space on
  // desktop, and on iOS --real-vh differs from window.innerHeight. Either way
  // the window is not the box the desktop is drawn into.
  const box = vncContainer?.getBoundingClientRect();
  let w = box.width || window.innerWidth;
  let h = box.height || window.innerHeight;
  if (!(w > 0 && h > 0)) return Promise.resolve(null);

  // Scale up for phone HiDPI — makes desktop more usable at small viewport
  const dpr = window.devicePixelRatio || 1;
  if (isMobile && dpr >= 2) {
    w *= 1.5;
    h *= 1.5;
  }

  // Fit inside the bounds as a pair, so the aspect ratio survives. Shrink only;
  // growing a desktop beyond its own pixel size costs bandwidth and buys
  // nothing, and the HiDPI boost above is the one deliberate exception.
  let k = Math.min(1, MAX_RES_W / w, MAX_RES_H / h);
  // A container collapsed to a sliver mid-transition should still not ask the
  // server for a mode it will reject; grow back by the short edge if so, which
  // keeps the ratio.
  if (h * k < MIN_RES_H) k = MIN_RES_H / h;
  w *= k;
  h *= k;

  // Align to 8px grid (xrandr modeline requirement)
  w = Math.floor(w / 8) * 8;
  h = Math.floor(h / 8) * 8;

  return fetch('/api/desktop/resolution', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ width: w, height: h }),
  }).then(r => r.json()).catch(() => {});
}

// Auto-refit on fullscreen & orientation changes
let _fitTimer = null;
function scheduleAutoFit() {
  clearTimeout(_fitTimer);
  _fitTimer = setTimeout(() => { if (rfb) autoFitResolution(); }, 400);
}
document.addEventListener('fullscreenchange', scheduleAutoFit);
document.addEventListener('webkitfullscreenchange', scheduleAutoFit);
window.addEventListener('orientationchange', () => setTimeout(scheduleAutoFit, 300));

if (isTouch) {
  const mobileToolbar = document.getElementById('mobile-toolbar');
  const touchCursor   = document.getElementById('touch-cursor');

  // ── Local zoom ──
  // The magnified view is held as a window into the remote screen: the window's
  // top-left corner in container coordinates, plus a scale factor. It is drawn
  // with a CSS transform on the *canvas* rather than on the screen element it
  // sits in, because noVNC measures that element to work out its own fit: a
  // transformed box reads as a larger viewport, and the next resize would then
  // fit the canvas to the magnified size on top of the transform.
  let vncZoom = 1;
  let viewX = 0, viewY = 0;
  // Lowest container y still visible above the soft keyboard and the
  // special-keys bar floating on it. 0 while the keyboard is down, when the
  // whole container is visible.
  let safeBottom = 0;

  // ── Virtual cursor state (trackpad mode) ──
  let cursorX = window.innerWidth / 2;
  let cursorY = window.innerHeight / 2;
  let touchStartX = 0, touchStartY = 0;
  let touchStartTime = 0;
  let touchMoved = false;
  let touchMovedDist = 0;
  let longPressTimer = null;
  let longPressFired = false;
  let isDragging = false;        // remote left button is held (drag)
  // A completed tap is held in a buffer for DOUBLE_TAP_MS before it is sent,
  // so the next touch can still reinterpret the gesture: a second touch that
  // releases quickly is a double-click, one that is still on screen when the
  // buffer expires is a drag. Nothing reaches the host until the buffer
  // resolves, so a click's mouseup can never land inside a drag.
  let pendingClick = null;       // {x, y} where the buffered click must land
  let pendingClickTimer = null;
  let secondTapDown = false;     // the reinterpretation touch is on screen

  const CURSOR_SPEED = 1.5;
  const TAP_MAX_DURATION = 300;
  const TAP_MAX_MOVE = 10;
  const LONG_PRESS_MS = 500;
  const DOUBLE_TAP_MS = 300;
  const DBL_CLICK_GAP_MS = 80;   // pause between the two clicks of a double-click

  mobileToolbar.hidden = false;
  touchCursor.hidden = false; // Always visible in trackpad mode

  function updateCursorPos() {
    touchCursor.style.left = cursorX + 'px';
    touchCursor.style.top  = cursorY + 'px';
  }
  updateCursorPos();

  // Get noVNC canvas element
  function getCanvas() {
    return vncContainer.querySelector('canvas');
  }

  // Dispatch a synthetic mouse event to the noVNC canvas.
  //
  // These must be MouseEvents, not PointerEvents. noVNC 1.5 binds
  // mousedown/mouseup/mousemove directly to the canvas, so dispatching
  // pointermove and friends reaches nothing: the virtual cursor moved but the
  // server cursor never did, which is exactly the trackpad bug.
  function sendMouse(type, button, buttons, x = cursorX, y = cursorY) {
    const canvas = getCanvas();
    if (!canvas) return;
    // noVNC reads a mouse position with clientToElement() against the canvas's
    // *rendered* box, then divides by its own scale, which knows nothing about
    // the magnifying transform. Feed it the position that point has in the
    // canvas's unscaled box instead, so the framebuffer coordinate it derives
    // is the one actually under the cursor. At 1:1 this is the identity.
    const r = canvas.getBoundingClientRect();
    const c = contentPoint(x, y);
    const offX = canvas.offsetLeft, offY = canvas.offsetTop;
    canvas.dispatchEvent(new MouseEvent(type, {
      clientX: r.left + c.x - offX,
      clientY: r.top + c.y - offY,
      screenX: x, screenY: y,
      button, buttons,
      bubbles: true, cancelable: true, view: window,
    }));
  }

  // Move virtual cursor and send mousemove to VNC
  function moveCursor(x, y) {
    cursorX = Math.max(0, Math.min(window.innerWidth, x));
    cursorY = Math.max(0, Math.min(window.innerHeight, y));
    updateCursorPos();
    sendMouse('mousemove', 0, isDragging ? 1 : 0);
    followCursor();
  }

  // Click at a position (default: current cursor position)
  function clickAt(button, x = cursorX, y = cursorY) {
    const btns = button === 2 ? 2 : 1;
    sendMouse('mousedown', button, btns, x, y);
    setTimeout(() => {
      sendMouse('mouseup', button, 0, x, y);
      // Focusing a remote field must not cost us the soft keyboard.
      keyboard.refocus();
    }, 60);
  }

  // Two full click cycles back to back; the second starts only after the
  // first has released, or the host sees one long press, not two clicks.
  function dblClickAt(x, y) {
    clickAt(0, x, y);
    setTimeout(() => clickAt(0, x, y), DBL_CLICK_GAP_MS);
  }

  function cancelPendingClick() {
    clearTimeout(pendingClickTimer);
    pendingClickTimer = null;
    pendingClick = null;
  }

  // Press the left button and hold it down for a drag; isDragging routes
  // every cursor move out as a pressed mousemove until the finger lifts.
  function beginDrag() {
    cancelPendingClick();
    secondTapDown = false;
    isDragging = true;
    sendMouse('mousedown', 0, 1);
    if (navigator.vibrate) navigator.vibrate(30);
  }

  // The tap buffer expired: the gesture is decided, send what it resolved to.
  function resolvePendingClick() {
    pendingClickTimer = null;
    if (secondTapDown) {
      // A second touch is still on screen — holding it means drag, not
      // click. Drop the buffered click and press the left button exactly
      // once; it stays down until the finger lifts.
      beginDrag();
    } else if (pendingClick) {
      // Plain tap: land the click where the tap happened, even if the cursor
      // has moved on since.
      const { x, y } = pendingClick;
      pendingClick = null;
      clickAt(0, x, y);
    }
  }

  // ── Zoom ──
  // The view model: a container point c is drawn at zoom * (c - view). The
  // canvas keeps its own layout size and offset -- noVNC owns those -- so the
  // transform has to fold its offset back in for `view` to mean container
  // coordinates: with origin at the canvas's own corner, a canvas point p lands
  // at offset + zoom * p + translate, and that has to equal zoom * (offset + p
  // - view).
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 3;

  function clampView() {
    const canvas = getCanvas();
    if (!canvas) return;
    const offX = canvas.offsetLeft, offY = canvas.offsetTop;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const winW = vncContainer.clientWidth / vncZoom;
    // Only the strip above the keyboard has to stay filled: everything below it
    // is covered, so blank space there is never seen.
    const strip = safeBottom > 0 ? Math.min(safeBottom, vncContainer.clientHeight)
                                 : vncContainer.clientHeight;
    const winH = strip / vncZoom;
    // A window wider than the canvas is centred on it rather than pinned to an
    // edge, which is what the un-zoomed letterboxing looks like.
    const spanX = cw - winW;
    const spanY = ch - winH;
    viewX = spanX <= 0 ? offX + spanX / 2 : Math.max(offX, Math.min(offX + spanX, viewX));
    viewY = spanY <= 0 ? offY + spanY / 2 : Math.max(offY, Math.min(offY + spanY, viewY));
  }

  function applyVncZoom() {
    const canvas = getCanvas();
    if (!canvas) return;
    if (vncZoom > 1) {
      clampView();
      const offX = canvas.offsetLeft, offY = canvas.offsetTop;
      const tx = (vncZoom - 1) * offX - vncZoom * viewX;
      const ty = (vncZoom - 1) * offY - vncZoom * viewY;
      canvas.style.transformOrigin = '0 0';
      canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${vncZoom})`;
    } else {
      canvas.style.transform = '';
      canvas.style.transformOrigin = '';
      viewX = 0;
      viewY = 0;
    }
  }

  // Container coordinates of the remote screen point drawn under (x, y); the
  // inverse of the mapping applyVncZoom draws.
  function contentPoint(x, y) {
    const r = vncContainer.getBoundingClientRect();
    return { x: viewX + (x - r.left) / vncZoom,
             y: viewY + (y - r.top) / vncZoom };
  }

  // noVNC's own scale: how many CSS pixels one remote pixel takes up. Read from
  // the style width rather than clientWidth, which is rounded.
  function canvasFit(canvas) {
    if (!canvas || !canvas.width) return 1;
    const css = parseFloat(canvas.style.width) || canvas.clientWidth;
    return css > 0 ? css / canvas.width : 1;
  }

  // Remote-screen coordinate under the virtual cursor. The arrow is what drives
  // the remote pointer, so this is derived from it -- but it is the thing that
  // has to stay put whenever the view changes underneath for a reason that is
  // not the user moving the arrow.
  function cursorFramebuffer() {
    const canvas = getCanvas();
    if (!canvas || !canvas.width) return null;
    const fit = canvasFit(canvas);
    const c = contentPoint(cursorX, cursorY);
    return { x: (c.x - canvas.offsetLeft) / fit, y: (c.y - canvas.offsetTop) / fit };
  }

  function placeCursorAtFramebuffer(fb) {
    const canvas = getCanvas();
    if (!canvas || !fb) return;
    const fit = canvasFit(canvas);
    placeCursorAt({ x: canvas.offsetLeft + fb.x * fit,
                    y: canvas.offsetTop + fb.y * fit });
  }

  // Draw container point `content` at (tx, ty), and bring the virtual cursor
  // along with it: the arrow has to keep pointing at the same remote spot, or
  // the next click would land somewhere else than what it looks like it is on.
  function parkContentAt(content, tx, ty) {
    vncZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, vncZoom));
    viewX = content.x - tx / vncZoom;
    viewY = content.y - ty / vncZoom;
    applyVncZoom();
    placeCursorAt(content);
  }

  function placeCursorAt(content) {
    const r = vncContainer.getBoundingClientRect();
    cursorX = r.left + vncZoom * (content.x - viewX);
    cursorY = r.top + vncZoom * (content.y - viewY);
    updateCursorPos();
  }

  // Zoom about a container point, keeping whatever is drawn under it in place.
  function zoomAbout(cx, cy, next) {
    next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
    if (next === vncZoom) return;
    viewX += cx / vncZoom - cx / next;
    viewY += cy / vncZoom - cy / next;
    vncZoom = next;
  }

  // ── Soft keyboard: magnify locally instead of reshaping the desktop ──
  // With the keyboard up the remote resolution stays exactly what it was -- see
  // autoFitResolution(). The desktop is not made smaller to fit the strip that
  // is left; instead the client magnifies the region around the virtual cursor
  // and slides it into that strip, so the field being typed into stays in view
  // and legible.
  const CURSOR_KEEP_PX = 24;   // how close to the bar the cursor may get
  let viewBeforeKeyboard = null;
  // Remote point under the arrow when the keyboard was summoned; see onWillOpen.
  let fieldBeforeKeyboard = null;

  function applyKeyboardZoom(fieldFb) {
    const cRect = vncContainer.getBoundingClientRect();
    safeBottom = Math.max(0, Math.min(cRect.height, keyboard.visibleBottom() - cRect.top));
    const canvas = getCanvas();
    // noVNC fits the whole desktop into the container; on a phone that is well
    // under the remote's own pixels. Magnify to 1:1, where a remote pixel is a
    // CSS pixel and text is as large as the remote drew it. Pinching still
    // works from there.
    const fit = canvasFit(canvas);
    vncZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fit > 0 ? 1 / fit : 1));
    // Android shrank the viewport for the keyboard on the way in and noVNC
    // re-fitted the desktop into what was left, which moved the desktop out from
    // under the arrow. Put the arrow back on the remote point it was on before
    // that -- the field being typed into -- so the magnified view is centred on
    // it rather than on wherever the re-fit left it.
    if (fieldFb) placeCursorAtFramebuffer(fieldFb);
    const content = contentPoint(cursorX, cursorY);
    // Same column, middle of the strip: the field ends up under the eye, with
    // as much of what surrounds it visible as the strip allows.
    parkContentAt(content, cursorX - cRect.left, safeBottom / 2);
  }

  function restoreAfterKeyboard() {
    safeBottom = 0;
    const fb = cursorFramebuffer();
    if (viewBeforeKeyboard) {
      vncZoom = viewBeforeKeyboard.zoom;
      viewX = viewBeforeKeyboard.x;
      viewY = viewBeforeKeyboard.y;
      viewBeforeKeyboard = null;
      applyVncZoom();
    }
    // noVNC measures its fit from the screen element and skips the whole update
    // when the client size matches the one it recorded at connect -- which is
    // exactly what the keyboard closing looks like, since the viewport comes
    // back to the size it had. Ask it to measure again, or the canvas is left
    // scaled for the strip it no longer has. Re-assigning the property it
    // already has is the public way to do that.
    if (rfb) rfb.scaleViewport = true;
    // The desktop has just been re-fitted around the arrow, so put the arrow
    // back on the remote point it was pointing at.
    if (fb) placeCursorAtFramebuffer(fb);
  }

  // Trackpad movement while the keyboard is up: the remote cursor follows the
  // arrow, so an arrow that slips under the keyboard would hide the very thing
  // being typed into. Recentring only once it reaches the bar leaves ordinary
  // movement, and any manual pan, alone.
  function followCursor() {
    if (safeBottom <= 0) return;
    const canvas = getCanvas();
    if (!canvas) return;
    const r = vncContainer.getBoundingClientRect();
    if (cursorY - r.top <= safeBottom - CURSOR_KEEP_PX) return;
    const content = contentPoint(cursorX, cursorY);
    parkContentAt(content, cursorX - r.left, safeBottom / 2);
  }

  document.getElementById('mob-zoom-fit').addEventListener('click', () => {
    // While the keyboard is up, "fit" means the magnified strip view, not the
    // whole desktop: the remote must not be reshaped for the keyboard.
    if (keyboard && keyboard.isOpen()) {
      applyKeyboardZoom();
      return;
    }
    vncZoom = 1;
    applyVncZoom();
    autoFitResolution();
  });

  // ── Two-finger gestures: pinch-zoom, pan, remote scroll ──
  // A gesture runs from the second finger touching down until fewer than two
  // fingers remain. Its type is decided ONCE — from the first ~10px of
  // movement, whichever accumulated more: finger-distance change → pinch,
  // center-of-fingers movement → move — and then locked until the gesture
  // ends. Deciding per gesture instead of feeding every move event into the
  // zoom is what keeps two-finger scrolls from zooming: real fingers never
  // hold a perfectly constant distance, and per-event zooming multiplies that
  // jitter straight into the CSS scale, which then stuck because vncZoom
  // never drops below 1 on its own.
  //
  // This is the ONLY two-finger touchmove listener. A second, bubble-phase
  // listener could never run: the capture handler below stops propagation
  // before the event reaches it.
  let twoFingerSeen      = false; // a two-finger gesture happened in this touch sequence
  let gestureMode        = null;  // null = undecided, then 'pinch' or 'move'
  let gestureDistMoved   = 0;     // |Δfinger distance| accumulated this gesture
  let gestureCenterMoved = 0;     // |Δcenter between fingers| accumulated
  let lastDist   = 0;
  let lastCenter = null;
  let scrollAccX = 0, scrollAccY = 0;

  const GESTURE_DECIDE_PX = 10;

  function touchDist(t0, t1) {
    return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
  }

  function centerOf(t0, t1) {
    return { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
  }

  // Pan the magnified view so the point between the fingers follows them: the
  // content moves with the fingers, so the window moves against them.
  function panBy(dx, dy) {
    viewX -= dx / vncZoom;
    viewY -= dy / vncZoom;
  }

  // ═══ TRACKPAD TOUCH HANDLING ═══
  // Block ALL real touch pointer events from reaching noVNC canvas.
  // Pointer events fire BEFORE touch events, so preventDefault on touchstart
  // is too late — the pointerdown already reached the canvas. We must
  // intercept at the pointer level and stop propagation for touch pointers.
  // Only our synthetic pointerType:'mouse' events should reach noVNC.
  ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach(evt => {
    vncContainer.addEventListener(evt, (e) => {
      if (e.pointerType === 'touch') {
        e.stopPropagation();
        // NOT preventDefault — that would kill touch events (spec requirement)
      }
    }, { capture: true });
  });

  // Single-finger drag  = move virtual cursor (like a trackpad)
  // Tap (<300ms)        = left-click at cursor position, buffered briefly so
  //                       the next touch can still reinterpret the gesture
  // Quick double tap    = double-click at cursor position
  // Tap, touch again and hold or slide = left-button drag
  // Long-press (>500ms) = right-click at cursor position
  // Two-finger          = pinch-zoom / pan

  vncContainer.addEventListener('touchstart', (e) => {
    // Two or more fingers → gesture start
    if (e.touches.length >= 2) {
      twoFingerSeen = true;
      gestureMode = null;
      gestureDistMoved = 0;
      gestureCenterMoved = 0;
      lastDist = touchDist(e.touches[0], e.touches[1]);
      lastCenter = centerOf(e.touches[0], e.touches[1]);
      clearTimeout(longPressTimer);
      // A scroll or pinch must never click, and the tap the gesture grew out
      // of is no longer a double-click/drag candidate either.
      cancelPendingClick();
      secondTapDown = false;
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    if (e.touches.length !== 1) return;
    e.stopPropagation();
    e.preventDefault();

    const t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    touchStartTime = Date.now();
    touchMoved = false;
    touchMovedDist = 0;
    longPressFired = false;
    twoFingerSeen = false;
    secondTapDown = false;

    // A touch while a tap sits in the buffer is the double-click / drag
    // candidate. Its fate is decided at its first real movement (slide →
    // drag engages immediately), when the buffer expires (finger still down
    // → drag), or at its own release (quick lift → double-click), so no
    // long-press timer here: holding this touch IS the drag gesture.
    if (pendingClickTimer) {
      secondTapDown = true;
      return;
    }

    // Long-press timer → right-click
    longPressTimer = setTimeout(() => {
      if (!touchMoved && !isDragging) {
        longPressFired = true;
        clickAt(2);
        if (navigator.vibrate) navigator.vibrate(50);
      }
    }, LONG_PRESS_MS);
  }, { capture: true, passive: false });

  vncContainer.addEventListener('touchmove', (e) => {
    e.stopPropagation();
    // Two-finger gesture: pinch, pan, or remote scroll
    if (twoFingerSeen && e.touches.length >= 2) {
      e.preventDefault();
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dist   = touchDist(t0, t1);
      const center = centerOf(t0, t1);

      if (gestureMode === null) {
        gestureDistMoved   += Math.abs(dist - lastDist);
        gestureCenterMoved += Math.hypot(center.x - lastCenter.x, center.y - lastCenter.y);
        // Not enough evidence yet — keep accumulating before committing.
        if (Math.max(gestureDistMoved, gestureCenterMoved) < GESTURE_DECIDE_PX) {
          lastDist = dist;
          lastCenter = center;
          return;
        }
        gestureMode = gestureDistMoved >= gestureCenterMoved ? 'pinch' : 'move';
      }

      if (gestureMode === 'pinch') {
        if (lastDist > 0) {
          // Zoom about the point between the fingers, so what is under them
          // stays under them.
          const r = vncContainer.getBoundingClientRect();
          zoomAbout(center.x - r.left, center.y - r.top,
                    vncZoom * (dist / lastDist));
        }
        if (vncZoom > 1) panBy(center.x - lastCenter.x, center.y - lastCenter.y);
        applyVncZoom();
      } else if (vncZoom > 1) {
        // Zoomed in: fingers moving together pan the magnified view.
        panBy(center.x - lastCenter.x, center.y - lastCenter.y);
        applyVncZoom();
      } else {
        // At 1:1: fingers moving together scroll the remote, like a trackpad.
        // Natural direction — fingers up scroll the remote content forward.
        // noVNC accumulates these pixel deltas and emits one wheel step per
        // 50px, so smooth sub-pixel deltas are fine here.
        scrollAccX += center.x - lastCenter.x;
        scrollAccY += center.y - lastCenter.y;
        const canvas = getCanvas();
        if (canvas && (scrollAccX !== 0 || scrollAccY !== 0)) {
          canvas.dispatchEvent(new WheelEvent('wheel', {
            clientX: cursorX, clientY: cursorY,
            deltaX: -scrollAccX, deltaY: -scrollAccY,
            deltaMode: 0,
            bubbles: true, cancelable: true, view: window,
          }));
          scrollAccX = 0;
          scrollAccY = 0;
        }
      }

      lastDist = dist;
      lastCenter = center;
      return;
    }

    // Single-finger trackpad movement
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0];
    const dx = (t.clientX - touchStartX) * CURSOR_SPEED;
    const dy = (t.clientY - touchStartY) * CURSOR_SPEED;

    // Counted cumulatively across the whole touch sequence: touchStartX/Y
    // re-anchor every event, so a slow drag never exceeds TAP_MAX_MOVE in any
    // single event and must be caught by the accumulated distance, or the
    // long-press timer fires a right-click mid-drag.
    touchMovedDist += Math.hypot(t.clientX - touchStartX, t.clientY - touchStartY);
    if (!touchMoved && touchMovedDist > TAP_MAX_MOVE) {
      touchMoved = true;
      clearTimeout(longPressTimer);
      // The drag-candidate touch is on the move: that can no longer be a
      // double-click, so don't sit out the buffer — press the button now,
      // while the cursor is still where the finger started moving. Waiting
      // for expiry would start the drag wherever the cursor drifted to.
      if (secondTapDown && pendingClickTimer) {
        beginDrag();
      }
    }

    touchStartX = t.clientX;
    touchStartY = t.clientY;
    moveCursor(cursorX + dx, cursorY + dy);
  }, { capture: true, passive: false });

  vncContainer.addEventListener('touchend', (e) => {
    e.stopPropagation();
    if (e.touches.length < 2) {
      // Fewer than two fingers left: the gesture is over.
      gestureMode = null;
      lastDist = 0;
      lastCenter = null;
      scrollAccX = 0;
      scrollAccY = 0;
      // One finger still down: re-anchor trackpad movement to it, so the
      // cursor doesn't jump by how far finger one drifted while the gesture
      // ran.
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }
    }

    clearTimeout(longPressTimer);

    // All fingers lifted
    if (e.touches.length === 0) {
      // End drag if active: the drag finger just lifted.
      if (isDragging) {
        sendMouse('mouseup', 0, 0);
        isDragging = false;
        keyboard.refocus();
        return;
      }

      const elapsed = Date.now() - touchStartTime;

      if (secondTapDown) {
        // The reinterpretation touch lifted while the buffer was still
        // running — had it held past expiry, the buffer would have started
        // the drag and this would have been the drag's release above.
        secondTapDown = false;
        if (pendingClick && !touchMoved && !twoFingerSeen && !longPressFired
            && elapsed < TAP_MAX_DURATION) {
          // Clean, quick lift = the second click of a double-click. Flush
          // both clicks now, where the buffered first tap happened.
          const { x, y } = pendingClick;
          cancelPendingClick();
          dblClickAt(x, y);
        }
        // Otherwise this touch slid or overstayed — not a double-click. The
        // buffer still holds the first tap's click and resolves on its own
        // into a plain click.
        return;
      }

      // A sequence that ever became a two-finger gesture (e.g. a quick
      // two-finger flick scroll) is not a tap, however brief it was.
      if (touchMoved || longPressFired || twoFingerSeen || elapsed >= TAP_MAX_DURATION) {
        return;
      }

      // First tap: don't click yet — hold it in the buffer so the next touch
      // can still turn the sequence into a double-click or a drag.
      pendingClick = { x: cursorX, y: cursorY };
      pendingClickTimer = setTimeout(resolvePendingClick, DOUBLE_TAP_MS);
    }
  }, { capture: true });

  // The system took the touches away (notification shade, palm rejection,
  // incoming-call UI). Release whatever the host is holding so no pressed
  // button or pending click survives the interrupted gesture. Marking the
  // sequence as moved also stops a stray late touchend from being read as a
  // tap — some browsers still deliver one after a cancel.
  vncContainer.addEventListener('touchcancel', () => {
    clearTimeout(longPressTimer);
    cancelPendingClick();
    secondTapDown = false;
    touchMoved = true;
    if (isDragging) {
      sendMouse('mouseup', 0, 0);
      isDragging = false;
    }
  }, { capture: true });

  // Virtual keyboard. The module owns the off-screen input and the two
  // noVNC settings that must be suspended while it is open; see
  // mobile-keyboard.js for why.
  keyboard = createMobileKeyboard({
    getRfb: () => rfb,
    // The remote point the arrow is on when the keyboard is summoned: on
    // Android the viewport shrinks for it and noVNC re-fits the desktop, so by
    // the time the keyboard has settled the arrow is over something else. This
    // is the field being typed into, and what the magnified view centres on.
    onWillOpen: () => { fieldBeforeKeyboard = cursorFramebuffer(); },
    onOpenChange: (isOpen) => {
      // Fires once the keyboard has finished animating, in both directions.
      // Opening: remember the view and magnify around the cursor, so the field
      // being typed into is not hidden behind the keyboard + special-keys bar.
      // Closing: put the view back the way it was, then let the desktop refit
      // to the viewport that has grown back.
      if (isOpen) {
        if (!viewBeforeKeyboard) {
          viewBeforeKeyboard = { zoom: vncZoom, x: viewX, y: viewY };
        }
        applyKeyboardZoom(fieldBeforeKeyboard);
        return;
      }
      fieldBeforeKeyboard = null;
      restoreAfterKeyboard();
      scheduleAutoFit();
    },
  });

  document.getElementById('mob-keyboard').addEventListener('click', (e) => {
    e.stopPropagation();
    // keyboard.toggle() focuses the off-screen input mid-tap, which cancels the
    // button's :active state on touch; play the press feedback by class.
    const btn = e.currentTarget;
    btn.classList.add('pressed');
    setTimeout(() => btn.classList.remove('pressed'), 150);
    keyboard.toggle();
  });

  document.getElementById('mob-fullscreen').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFullscreen();
  });

  // Refit when the viewport changes. With noVNC's resizeSession off (see
  // connect()) this is the only resize path on a touch device. It is debounced,
  // and autoFitResolution() stands down while the soft keyboard is moving the
  // viewport; the keyboard's onOpenChange above schedules the refit that would
  // otherwise be dropped.
  window.addEventListener('resize', scheduleAutoFit);

  // Auto-hide toolbar after inactivity
  let toolbarTimer = null;
  function resetToolbarTimer() {
    mobileToolbar.style.opacity = '';
    clearTimeout(toolbarTimer);
    toolbarTimer = setTimeout(() => {
      mobileToolbar.style.opacity = '0.3';
    }, 5000);
  }
  mobileToolbar.addEventListener('touchstart', () => {
    mobileToolbar.style.opacity = '';
    clearTimeout(toolbarTimer);
  });
  mobileToolbar.addEventListener('touchend', resetToolbarTimer);
  resetToolbarTimer();
}

// ── Init ────────────────────────────────────────────────────

(async function init() {
  // Auto-fit resolution to viewport before connecting
  await serverConfigReady;
  await autoFitResolution();
  await new Promise(r => setTimeout(r, 500));
  connect();
})();
