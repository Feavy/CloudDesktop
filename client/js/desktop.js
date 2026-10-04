import RFB from '/vendor/novnc/core/rfb.js';
import { notify, init as initNotifications } from '/js/notifications.js';
import { createMobileKeyboard } from '/js/mobile-keyboard.js';

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
// Set on touch devices only; guards autoFitResolution while the soft keyboard
// is up. See mobile-keyboard.js.
let keyboard = null;

initNotifications();

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
  hideStatus();
  rfb.focus();
  notify('Connected to desktop', 'success', 3000);
}

function onDisconnect(e) {
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
// Force auto-hide on mobile, respect setting on desktop
let dockAutoHide  = isMobile ? true : (localStorage.getItem('dock-autohide') === 'on');

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

// Mouse trigger (desktop)
dockTrigger.addEventListener('mouseenter', showDock);
dock.addEventListener('mouseenter', showDock);
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

// Close dock when tapping VNC area or any dock button on mobile
if (isTouch) {
  vncContainer.addEventListener('touchstart', () => {
    if (dock.classList.contains('visible')) hideDock();
  }, { passive: true });

  // Hide dock after tapping a dock button (app launched)
  dock.addEventListener('click', (e) => {
    if (e.target.closest('.dock-item')) {
      setTimeout(hideDock, 300);
    }
  });
}

applyAutoHide();

// ── Dock magnification (desktop only) ──────────────────────

if (!isTouch) {
  const MAG_RADIUS = 110;
  const MAG_MAX    = 1.4;
  const dockItems  = dock.querySelectorAll('.dock-item');

  dock.addEventListener('mousemove', (e) => {
    const mx = e.clientX;
    for (const item of dockItems) {
      const rect = item.getBoundingClientRect();
      const dist = Math.abs(mx - (rect.left + rect.width / 2));
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

document.getElementById('topbar-fullscreen').addEventListener('click', () => {
  const el = document.documentElement;
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else if (el.requestFullscreen) {
    el.requestFullscreen().catch(() => { toggleMobileFullscreen(); });
  } else if (el.webkitRequestFullscreen) {
    el.webkitRequestFullscreen();
  } else {
    // iOS Safari / browsers without Fullscreen API
    toggleMobileFullscreen();
  }
});

let mobileFullscreen = false;
function toggleMobileFullscreen() {
  mobileFullscreen = !mobileFullscreen;
  document.body.classList.toggle('mobile-fullscreen', mobileFullscreen);
  if (mobileFullscreen) {
    topbar.classList.add('hidden');
    window.scrollTo(0, 1); // nudge iOS to hide address bar
  } else {
    applyTopbar();
  }
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) applyTopbar();
});
document.addEventListener('webkitfullscreenchange', () => {
  if (!document.webkitFullscreenElement) applyTopbar();
});

document.getElementById('topbar-theme').addEventListener('click', () => {
  setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});

// ── App launch helpers ──────────────────────────────────────

async function launchApp(app) {
  try {
    await fetch('/api/desktop/launch', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app }),
    });
  } catch { /* silent */ }
}

// ── Server-side config (home dir, VNC endpoint, dock options) ───────────
let SERVER_HOME = '/root';
let SERVER_DESKTOP = '/root/Desktop';
let SERVER_WS_URL = '';
let CAN_RESTART = false;

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

      // Restarting the desktop needs a command from the deployment; without
      // one the pod has no way to do it, so hide the button.
      CAN_RESTART = Boolean(cfg.canRestart);
      const btnRestart = document.getElementById('btn-restart');
      if (btnRestart) btnRestart.hidden = !CAN_RESTART;

      // Hide dock icons for apps this pod cannot launch
      if (Array.isArray(cfg.canLaunch)) {
        document.querySelectorAll('.dock-app').forEach((btn) => {
          if (!cfg.canLaunch.includes(btn.dataset.app)) btn.hidden = true;
        });
      }

      if (!localStorage.getItem('upload-dest')) uploadDestInput.value = SERVER_DESKTOP;
    }
  } catch {}
})();

// ── Dock app icon clicks ────────────────────────────────────

document.querySelectorAll('.dock-app').forEach((btn) => {
  btn.addEventListener('click', () => launchApp(btn.dataset.app));
});

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
});

const topbarBtn = document.getElementById('settings-topbar');
topbarBtn.textContent = topbarVisible ? 'On' : 'Off';
topbarBtn.addEventListener('click', () => {
  topbarVisible = !topbarVisible;
  localStorage.setItem('topbar', topbarVisible ? 'on' : 'off');
  topbarBtn.textContent = topbarVisible ? 'On' : 'Off';
  applyTopbar();
});

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

document.getElementById('btn-restart').addEventListener('click', async () => {
  if (!confirm('Restart the desktop session? Unsaved work will be lost.')) return;
  showStatus('Restarting desktop…');
  try { await fetch('/api/desktop/restart', { method: 'POST', credentials: 'same-origin' }); }
  catch { /* continue */ }
  setTimeout(connect, 4500);
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
      return `<button class="window-entry" data-wid="${w.id}">
        <span class="window-entry-icon">${iconSvgs[ico]}</span>
        <span class="window-entry-title">${safeTitle}</span>
      </button>`;
    }).join('');

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

// ── Modal dismiss: backdrop click & Escape ──────────────────

const allModals = [resolutionModal, settingsModal, uploadModal, dirModal, filebrowserModal];

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

// Auto-fullscreen for regular browsers (not PWA) — hides toolbar on first click
if (!isStandalone) {
  function enterFullscreenOnce(e) {
    // Never hijack a tap on the keyboard button: entering fullscreen resizes the
    // viewport, which would fight the soft keyboard the user just asked for.
    if (e.target && e.target.closest && e.target.closest('#mob-keyboard')) return;
    const el = document.documentElement;
    const go = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (go) go.call(el).catch(() => {});
    document.removeEventListener('click', enterFullscreenOnce);
    document.removeEventListener('touchstart', enterFullscreenOnce);
  }
  // Not { once: true }: the guard above has to be able to decline and stay
  // registered for the next tap. The handler removes itself on success.
  document.addEventListener('click', enterFullscreenOnce);
  document.addEventListener('touchstart', enterFullscreenOnce);
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
  // While the soft keyboard is up the viewport only shows the strip above it,
  // and it keeps changing for a few hundred ms after the keyboard starts
  // closing. Fitting to that would shrink the whole remote desktop every time
  // the keyboard opens, and land on a stale size every time it closes. The
  // keyboard module suspends noVNC's own resize for the same reason.
  if (keyboard && keyboard.blocksResize()) {
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
  const mobZoomLabel  = document.getElementById('mob-zoom-level');
  const mobRightBtn   = document.getElementById('mob-rightclick');

  let vncZoom = 1;
  let panX = 0.5, panY = 0.5;
  let rightClickMode = false;

  // ── Virtual cursor state (trackpad mode) ──
  let cursorX = window.innerWidth / 2;
  let cursorY = window.innerHeight / 2;
  let touchStartX = 0, touchStartY = 0;
  let touchStartTime = 0;
  let touchMoved = false;
  let longPressTimer = null;
  let longPressFired = false;
  let isDragging = false;   // double-tap-hold drag
  let lastTapTime = 0;

  const CURSOR_SPEED = 1.5;
  const TAP_MAX_DURATION = 300;
  const TAP_MAX_MOVE = 10;
  const LONG_PRESS_MS = 500;

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
  function sendMouse(type, button, buttons) {
    const canvas = getCanvas();
    if (!canvas) return;
    canvas.dispatchEvent(new MouseEvent(type, {
      clientX: cursorX, clientY: cursorY,
      screenX: cursorX, screenY: cursorY,
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
  }

  // Click at current cursor position
  function clickAt(button) {
    const btns = button === 2 ? 2 : 1;
    sendMouse('mousedown', button, btns);
    setTimeout(() => {
      sendMouse('mouseup', button, 0);
      // Focusing a remote field must not cost us the soft keyboard.
      keyboard.refocus();
    }, 60);
  }

  // ── Zoom ──
  function applyVncZoom() {
    const screen = vncContainer.firstElementChild;
    if (!screen) return;
    if (vncZoom > 1) {
      screen.style.transformOrigin = `${panX * 100}% ${panY * 100}%`;
      screen.style.transform = `scale(${vncZoom})`;
    } else {
      screen.style.transform = '';
      screen.style.transformOrigin = '';
      panX = 0.5; panY = 0.5;
    }
    mobZoomLabel.textContent = Math.round(vncZoom * 100) + '%';
  }

  document.getElementById('mob-zoom-in').addEventListener('click', () => {
    vncZoom = Math.min(3, +(vncZoom + 0.5).toFixed(1));
    applyVncZoom();
  });
  document.getElementById('mob-zoom-out').addEventListener('click', () => {
    vncZoom = Math.max(1, +(vncZoom - 0.5).toFixed(1));
    applyVncZoom();
  });
  document.getElementById('mob-zoom-fit').addEventListener('click', () => {
    vncZoom = 1;
    applyVncZoom();
    autoFitResolution();
  });

  // Right-click mode: next tap sends right-click
  mobRightBtn.addEventListener('click', () => {
    rightClickMode = !rightClickMode;
    mobRightBtn.classList.toggle('active', rightClickMode);
  });

  // ── Pinch-to-zoom + two-finger pan ──
  let pinchActive = false;
  let lastPinchDist = 0;
  let lastPinchCenter = null;

  function touchDist(t0, t1) {
    return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
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
  // Tap (<300ms)        = left-click at cursor position
  // Long-press (>500ms) = right-click at cursor position
  // Double-tap + hold   = drag (mousedown + move)
  // Two-finger          = pinch-zoom / pan

  vncContainer.addEventListener('touchstart', (e) => {
    // Two-finger → pinch/pan
    if (e.touches.length === 2) {
      pinchActive = true;
      lastPinchDist = touchDist(e.touches[0], e.touches[1]);
      lastPinchCenter = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
      clearTimeout(longPressTimer);
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
    longPressFired = false;

    // Double-tap-and-hold → start drag
    if (Date.now() - lastTapTime < 300) {
      isDragging = true;
      sendMouse('mousedown', 0, 1);
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
    // Two-finger pinch/pan
    if (pinchActive && e.touches.length === 2) {
      e.preventDefault();
      const dist = touchDist(e.touches[0], e.touches[1]);
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      if (lastPinchDist > 0) {
        vncZoom = Math.max(1, Math.min(3, vncZoom * (dist / lastPinchDist)));
      }
      lastPinchDist = dist;
      if (vncZoom > 1 && lastPinchCenter) {
        const dx = cx - lastPinchCenter.x;
        const dy = cy - lastPinchCenter.y;
        const cw = vncContainer.clientWidth;
        const ch = vncContainer.clientHeight;
        panX = Math.max(0, Math.min(1, panX - dx / (cw * Math.max(0.01, vncZoom - 1))));
        panY = Math.max(0, Math.min(1, panY - dy / (ch * Math.max(0.01, vncZoom - 1))));
      }
      lastPinchCenter = { x: cx, y: cy };
      applyVncZoom();
      return;
    }

    // Single-finger trackpad movement
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0];
    const dx = (t.clientX - touchStartX) * CURSOR_SPEED;
    const dy = (t.clientY - touchStartY) * CURSOR_SPEED;

    if (Math.abs(t.clientX - touchStartX) > TAP_MAX_MOVE ||
        Math.abs(t.clientY - touchStartY) > TAP_MAX_MOVE) {
      if (!touchMoved) {
        touchMoved = true;
        clearTimeout(longPressTimer);
      }
    }

    touchStartX = t.clientX;
    touchStartY = t.clientY;
    moveCursor(cursorX + dx, cursorY + dy);
  }, { capture: true, passive: false });

  vncContainer.addEventListener('touchend', (e) => {
    e.stopPropagation();
    if (e.touches.length < 2) {
      pinchActive = false;
      lastPinchDist = 0;
      lastPinchCenter = null;
    }

    clearTimeout(longPressTimer);

    // All fingers lifted
    if (e.touches.length === 0) {
      // End drag if active
      if (isDragging) {
        sendMouse('mouseup', 0, 0);
        isDragging = false;
        keyboard.refocus();
        return;
      }

      const elapsed = Date.now() - touchStartTime;

      // Tap → click
      if (!touchMoved && !longPressFired && elapsed < TAP_MAX_DURATION) {
        if (rightClickMode) {
          clickAt(2);
          rightClickMode = false;
          mobRightBtn.classList.remove('active');
        } else {
          clickAt(0);
        }
        lastTapTime = Date.now();
      }
    }
  }, { capture: true });

  // Two-finger scroll → mouse wheel
  let scrollAccY = 0;
  vncContainer.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !pinchActive) return;
    // If fingers move together (not spreading), treat as scroll
    const dist = touchDist(e.touches[0], e.touches[1]);
    if (lastPinchDist > 0 && Math.abs(dist - lastPinchDist) < 5) {
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      if (lastPinchCenter) {
        scrollAccY += cy - lastPinchCenter.y;
        const canvas = getCanvas();
        if (canvas && Math.abs(scrollAccY) > 20) {
          const dir = scrollAccY > 0 ? -1 : 1; // natural scroll
          canvas.dispatchEvent(new WheelEvent('wheel', {
            clientX: cursorX, clientY: cursorY,
            deltaY: dir * 120, deltaMode: 0,
            bubbles: true, cancelable: true, view: window,
          }));
          scrollAccY = 0;
        }
      }
    }
  }, { passive: true });
  vncContainer.addEventListener('touchend', () => { scrollAccY = 0; }, { passive: true });

  // Virtual keyboard. The module owns the off-screen input and the two
  // noVNC settings that must be suspended while it is open; see
  // mobile-keyboard.js for why.
  keyboard = createMobileKeyboard({
    getRfb: () => rfb,
    button: document.getElementById('mob-keyboard'),
    onOpenChange: (isOpen) => {
      // Fires on close only once the keyboard has finished animating away and
      // the viewport is the size it will stay, so the refit cannot be measured
      // against a viewport that is still moving.
      if (!isOpen) scheduleAutoFit();
    },
  });

  document.getElementById('mob-keyboard').addEventListener('click', (e) => {
    e.stopPropagation();
    keyboard.toggle();
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
