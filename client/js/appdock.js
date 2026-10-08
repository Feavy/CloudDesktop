// App dock — the browser-side replacement for the Plank dock.
//
// A bottom-edge dock in the page: pinned applications, then anything
// running but unpinned, then the button that opens the applications grid.
// Running applications carry a dot; clicking activates (focuses a window
// or launches); right-click / long-press opens a context menu with
// per-window focus, pin/unpin and "close all".
//
// Server side this leans on:
//   GET  /api/desktop/apps           installed applications
//   GET  /api/desktop/apps/icon/:id  resolved theme icon
//   POST /api/desktop/apps/launch    launch by application id
//   GET/PUT /api/desktop/apps/pins   the dock's pin list
//   GET     /api/desktop/windows     open windows (+ appId per window)
//   POST    /api/desktop/windows/*   focus / close

import { notify } from '/js/notifications.js?cv=%CACHE_VERSION%';

const FALLBACK_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="10" rx="2"/><line x1="2" y1="6" x2="14" y2="6"/></svg>';

const GRID_ICON_SVG = '<svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="12" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="12" width="7" height="7" rx="1.6"/><rect x="12" y="12" width="7" height="7" rx="1.6"/></svg>';

// ── Elements ────────────────────────────────────────────────

const appDock        = document.getElementById('app-dock');
const appDockTrigger = document.getElementById('app-dock-trigger');
const appsModal      = document.getElementById('apps-modal');
const appsGrid       = document.getElementById('apps-grid');
const appsEmpty      = document.getElementById('apps-empty');
const appsSearch     = document.getElementById('apps-search');
const appsFilterAll  = document.getElementById('apps-filter-all');
const appsFilterRun  = document.getElementById('apps-filter-running');
const appsCloseBtn   = document.getElementById('apps-close');
const ctxMenu        = document.getElementById('app-context-menu');

// ── State ───────────────────────────────────────────────────

let opts = { isTouch: false, isMobile: false, cacheVersion: '' };

let appsById = new Map();     // id → {id, name, comment}
let pins = [];                // pinned application ids, in order
let pinsFromServer = true;    // flips to false if the pins API is unreachable
let windows = [];             // open windows from the last poll
let lastWinSig = '';
let lastFocused = new Map();  // appId → last window id we focused
let filterRunning = false;
let searchQuery = '';

// Set when an action (long-press, menu open) must swallow the click that
// the same gesture would otherwise produce.
let suppressClickUntil = 0;
let menuOpenedAt = 0;

// ── Helpers ─────────────────────────────────────────────────

// Public so desktop.js can reuse the same URL scheme (the window
// switcher layers resolved app icons over its generic glyphs).
export function iconUrl(id, size) {
  const v = opts.cacheVersion ? `&v=${encodeURIComponent(opts.cacheVersion)}` : '';
  return `/api/desktop/apps/icon/${encodeURIComponent(id)}?size=${size}${v}`;
}

// Every icon is a fallback glyph with the resolved theme icon layered over
// it; a failed load simply reveals the glyph.
function iconShell(url) {
  const shell = document.createElement('span');
  shell.className = 'app-icon-shell';
  shell.innerHTML = FALLBACK_ICON_SVG;
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.src = url;
  img.addEventListener('error', () => img.remove());
  shell.appendChild(img);
  return shell;
}

function windowsByApp() {
  const byApp = new Map();
  for (const w of windows) {
    if (!w.appId) continue;
    let list = byApp.get(w.appId);
    if (!list) { list = []; byApp.set(w.appId, list); }
    list.push(w);
  }
  return byApp;
}

function jsonFetch(url, method, body) {
  return fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ── Data loading ────────────────────────────────────────────

async function loadApps(fresh = false) {
  try {
    const res = await fetch(`/api/desktop/apps${fresh ? '?fresh=1' : ''}`, { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    appsById = new Map((data.apps || []).map((a) => [a.id, a]));
    renderDock();
    if (!appsModal.hidden) renderGrid();
  } catch { /* the dock keeps working with what it has */ }
}

async function loadPins() {
  try {
    const res = await fetch('/api/desktop/apps/pins', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.pinned)) {
        pins = data.pinned;
        renderDock();
        return;
      }
    }
  } catch { /* fall through to local */ }
  pinsFromServer = false;
  try { pins = JSON.parse(localStorage.getItem('appdock-pins') || '[]') || []; }
  catch { pins = []; }
  renderDock();
}

async function savePins() {
  try { localStorage.setItem('appdock-pins', JSON.stringify(pins)); } catch { /* private mode */ }
  if (!pinsFromServer) return;
  try {
    const res = await jsonFetch('/api/desktop/apps/pins', 'PUT', { pinned: pins });
    if (!res.ok) pinsFromServer = false; // degrade to this browser's storage
  } catch {
    pinsFromServer = false;
  }
}

let pollTimer = null;
async function pollWindows() {
  if (document.hidden) return;
  try {
    const res = await fetch('/api/desktop/windows', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    windows = data.windows || [];
    const sig = windows.map((w) => `${w.id}~${w.appId || ''}`).join('|');
    if (sig === lastWinSig) return;
    lastWinSig = sig;
    renderDock();
    if (!appsModal.hidden) renderGrid();
  } catch { /* transient — the next tick retries */ }
}

function schedulePoll(ms = 700) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollWindows, ms);
}

// ── Actions ─────────────────────────────────────────────────

async function focusWindow(winId, appId) {
  if (appId) lastFocused.set(appId, winId);
  try { await jsonFetch('/api/desktop/windows/focus', 'POST', { id: winId }); } catch { /* silent */ }
}

async function launchApp(id) {
  const app = appsById.get(id);
  try {
    const res = await jsonFetch('/api/desktop/apps/launch', 'POST', { id });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      notify(data.error || `Failed to launch ${app ? app.name : id}`, 'error');
      return;
    }
    notify(`Launching ${app ? app.name : id}…`, 'success', 2500);
    // Two polls: most windows map within a second, slower starters after.
    setTimeout(pollWindows, 1200);
    setTimeout(pollWindows, 3200);
  } catch {
    notify('Launch failed — is the desktop reachable?', 'error');
  }
}

// Click behaviour: launch when closed, otherwise focus the app's windows,
// cycling through them on repeated clicks (the context menu lists them all
// for a direct pick).
async function activateApp(id) {
  const wins = windowsByApp().get(id) || [];
  if (!wins.length) {
    launchApp(id);
    return;
  }
  const order = wins.map((w) => w.id);
  const last = lastFocused.get(id);
  const idx = last ? (order.indexOf(last) + 1) % order.length : 0;
  focusWindow(order[idx], id);
}

async function closeAppWindows(id) {
  const wins = windowsByApp().get(id) || [];
  await Promise.all(wins.map((w) =>
    jsonFetch('/api/desktop/windows/close', 'POST', { id: w.id }).catch(() => {})));
  schedulePoll(600);
}

function togglePin(id) {
  const i = pins.indexOf(id);
  if (i >= 0) pins.splice(i, 1);
  else pins.push(id);
  savePins();
  renderDock();
  if (!appsModal.hidden) renderGrid();
}

// ── Dock rendering ──────────────────────────────────────────

function dockItem(id, running) {
  const app = appsById.get(id);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dock-item app-dock-item' + (running ? ' running' : '');
  btn.dataset.app = id;
  btn.dataset.label = app ? app.name : id;
  btn.appendChild(iconShell(iconUrl(id, 64)));
  const dot = document.createElement('span');
  dot.className = 'app-dock-dot';
  if (!running) dot.hidden = true;
  btn.appendChild(dot);
  return btn;
}

function gridButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'btn-appview';
  btn.className = 'dock-item app-dock-item app-dock-grid';
  btn.dataset.label = 'Apps';
  btn.innerHTML = GRID_ICON_SVG;
  return btn;
}

function renderDock() {
  const byApp = windowsByApp();
  const pinnedShown = pins.filter((id) => appsById.has(id));
  const runningShown = [...byApp.keys()].filter((id) => appsById.has(id) && !pins.includes(id));

  const frag = document.createDocumentFragment();
  for (const id of pinnedShown) frag.appendChild(dockItem(id, byApp.has(id)));
  if (pinnedShown.length && runningShown.length) {
    const sep = document.createElement('div');
    sep.className = 'app-dock-sep';
    frag.appendChild(sep);
  }
  for (const id of runningShown) frag.appendChild(dockItem(id, true));
  if (pinnedShown.length || runningShown.length) {
    const sep = document.createElement('div');
    sep.className = 'app-dock-sep';
    frag.appendChild(sep);
  }
  frag.appendChild(gridButton());
  appDock.replaceChildren(frag);
}

// ── Applications grid ───────────────────────────────────────

function gridTile(id, running) {
  const app = appsById.get(id);
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'apps-tile' + (running ? ' running' : '');
  tile.dataset.app = id;
  if (app && app.comment) tile.title = app.comment;
  tile.appendChild(iconShell(iconUrl(id, 128)));
  const name = document.createElement('span');
  name.className = 'apps-tile-name';
  name.textContent = app ? app.name : id;
  tile.appendChild(name);
  const dot = document.createElement('span');
  dot.className = 'apps-tile-dot';
  if (!running) dot.hidden = true;
  tile.appendChild(dot);
  return tile;
}

function renderGrid() {
  const byApp = windowsByApp();
  const q = searchQuery.trim().toLowerCase();
  let list = [...appsById.keys()];
  if (filterRunning) list = list.filter((id) => byApp.has(id));
  if (q) {
    list = list.filter((id) => {
      const app = appsById.get(id);
      return app.name.toLowerCase().includes(q) || id.toLowerCase().includes(q);
    });
  }
  list.sort((a, b) => {
    const ra = byApp.has(a) ? 0 : 1;
    const rb = byApp.has(b) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return appsById.get(a).name.localeCompare(appsById.get(b).name);
  });

  const frag = document.createDocumentFragment();
  for (const id of list) frag.appendChild(gridTile(id, byApp.has(id)));
  appsGrid.replaceChildren(frag);
  appsEmpty.hidden = list.length > 0;
}

function openAppsView() {
  appsModal.hidden = false;
  filterRunning = false;
  appsFilterAll.classList.add('active');
  appsFilterRun.classList.remove('active');
  renderGrid();
  loadApps(true); // pick up anything installed since the last scan
  hideAppDock();
  if (!opts.isTouch) appsSearch.focus();
}

// ── Context menu ────────────────────────────────────────────

function closeCtxMenu() {
  ctxMenu.hidden = true;
  ctxMenu.replaceChildren();
}

function addCtxSep() {
  const sep = document.createElement('div');
  sep.className = 'app-ctx-sep';
  ctxMenu.appendChild(sep);
}

function addCtxItem(label, { danger = false, onClick = null } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'app-ctx-item' + (danger ? ' danger' : '');
  const title = document.createElement('span');
  title.className = 'app-ctx-win-title';
  title.textContent = label;
  btn.appendChild(title);
  btn.addEventListener('click', () => {
    closeCtxMenu();
    if (onClick) onClick();
  });
  ctxMenu.appendChild(btn);
}

function placeCtxMenu(x, y) {
  ctxMenu.hidden = false;
  menuOpenedAt = Date.now();
  const rect = ctxMenu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = Math.min(Math.max(8, x), vw - rect.width - 8);
  let top = y;
  // Near the bottom edge (the dock's own neighbourhood) the menu flips above.
  if (top + rect.height > vh - 8) top = Math.max(8, y - rect.height - 8);
  ctxMenu.style.left = `${left}px`;
  ctxMenu.style.top = `${top}px`;
}

function openAppMenu(appId, x, y) {
  const app = appsById.get(appId);
  if (!app) return;
  closeCtxMenu();

  const wins = windowsByApp().get(appId) || [];
  const pinned = pins.includes(appId);

  const header = document.createElement('div');
  header.className = 'app-ctx-header';
  header.textContent = app.name;
  ctxMenu.appendChild(header);

  for (const w of wins.slice(0, 8)) {
    addCtxItem(w.title, { onClick: () => focusWindow(w.id, appId) });
  }
  if (wins.length) addCtxSep();
  addCtxItem('Open New Window', { onClick: () => launchApp(appId) });
  addCtxItem(pinned ? 'Unpin from Dock' : 'Pin to Dock', { onClick: () => togglePin(appId) });
  if (wins.length) addCtxItem('Close All Windows', { danger: true, onClick: () => closeAppWindows(appId) });

  placeCtxMenu(x, y);
}

// ── Long-press (touch) ──────────────────────────────────────

// Delegated long-press: a held touch that stays within ~10px opens the
// context menu at the touch point; the click it would have produced is
// swallowed by suppressClickUntil.
function bindLongPress(container, selector) {
  if (!opts.isTouch) return;
  let timer = null;
  let startX = 0;
  let startY = 0;

  const cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  container.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return cancel();
    const target = e.target.closest(selector);
    if (!target) return cancel();
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    timer = setTimeout(() => {
      timer = null;
      suppressClickUntil = Date.now() + 800;
      openAppMenu(target.dataset.app, startX, startY);
    }, 500);
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (!timer) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) cancel();
  }, { passive: true });

  container.addEventListener('touchend', cancel, { passive: true });
  container.addEventListener('touchcancel', cancel, { passive: true });
}

function clickSuppressed() {
  return Date.now() < suppressClickUntil;
}

// ── Dock auto-hide ──────────────────────────────────────────

// Same setting (and the same localStorage key) as the left-edge control
// dock: desktop.js owns the Settings toggle and calls setAppDockAutoHide.
let dockAutoHide = localStorage.getItem('dock-autohide') !== 'off';
let dockHideTimer = null;

function showAppDock() {
  clearTimeout(dockHideTimer);
  appDock.classList.add('visible');
}

function hideAppDockNow() {
  clearTimeout(dockHideTimer);
  appDock.classList.remove('visible');
}

export function hideAppDock() {
  if (dockAutoHide && appDock.classList.contains('visible')) hideAppDockNow();
}

function scheduleAppDockHide() {
  if (!dockAutoHide) return;
  clearTimeout(dockHideTimer);
  dockHideTimer = setTimeout(hideAppDockNow, opts.isMobile ? 3000 : 900);
}

function applyAppDockAutoHide() {
  if (dockAutoHide) {
    appDock.classList.remove('no-autohide', 'visible');
  } else {
    appDock.classList.add('no-autohide', 'visible');
  }
}

export function setAppDockAutoHide(on) {
  dockAutoHide = on;
  applyAppDockAutoHide();
}

// A real touch suppresses the compatibility mouse events the browser
// synthesises from it, but on hybrid devices a stray mouse event can still
// arrive right after a touch — same guard the left dock uses.
let lastTouchAt = 0;
const fromTouch = () => Date.now() - lastTouchAt < 1000;

// ── Init ────────────────────────────────────────────────────

export function initAppDock(options = {}) {
  opts = { ...opts, ...options };

  // Render the dock shell (the Apps button) immediately, so the entry
  // point exists even if the app or pins requests fail.
  renderDock();

  loadApps();
  loadPins();
  pollWindows();
  setInterval(pollWindows, 4000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { schedulePoll(50); }
  });

  applyAppDockAutoHide();

  // ── Dock reveal / hide ──
  document.addEventListener('touchstart', () => { lastTouchAt = Date.now(); },
    { capture: true, passive: true });

  appDockTrigger.addEventListener('mouseenter', () => { if (!fromTouch()) showAppDock(); });
  appDockTrigger.addEventListener('mouseleave', scheduleAppDockHide);
  appDock.addEventListener('mouseenter', () => { if (!fromTouch()) showAppDock(); });
  appDock.addEventListener('mouseleave', scheduleAppDockHide);

  appDockTrigger.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (appDock.classList.contains('visible')) hideAppDockNow();
    else { showAppDock(); scheduleAppDockHide(); }
  }, { passive: false });

  // Magnification (desktop only): proximity measured along X, growing from
  // the item's bottom edge like the macOS dock.
  if (!opts.isTouch) {
    const MAG_RADIUS = 110;
    const MAG_MAX = 1.35;
    appDock.addEventListener('mousemove', (e) => {
      const mx = e.clientX;
      for (const item of appDock.querySelectorAll('.app-dock-item')) {
        const rect = item.getBoundingClientRect();
        const dist = Math.abs(mx - (rect.left + rect.width / 2));
        const mag = dist < MAG_RADIUS
          ? 1 + (MAG_MAX - 1) * (1 - dist / MAG_RADIUS)
          : 1;
        item.style.setProperty('--mag', mag.toFixed(3));
      }
    });
    appDock.addEventListener('mouseleave', () => {
      for (const item of appDock.querySelectorAll('.app-dock-item')) {
        item.style.setProperty('--mag', '1');
      }
    });
  }

  // ── Dock activation (delegated — items are re-rendered freely) ──
  appDock.addEventListener('click', (e) => {
    const item = e.target.closest('.app-dock-item');
    if (!item || clickSuppressed()) return;
    if (item.id === 'btn-appview') {
      openAppsView();
    } else if (item.dataset.app) {
      activateApp(item.dataset.app);
    }
    if (opts.isTouch) setTimeout(hideAppDockNow, 300);
  });

  appDock.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.app-dock-item[data-app]');
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    openAppMenu(item.dataset.app, e.clientX, e.clientY);
  });

  bindLongPress(appDock, '.app-dock-item[data-app]');

  // ── Applications grid ──
  appsGrid.addEventListener('click', (e) => {
    const tile = e.target.closest('.apps-tile');
    if (!tile || clickSuppressed()) return;
    appsModal.hidden = true;
    activateApp(tile.dataset.app);
  });

  appsGrid.addEventListener('contextmenu', (e) => {
    const tile = e.target.closest('.apps-tile');
    if (!tile) return;
    e.preventDefault();
    e.stopPropagation();
    openAppMenu(tile.dataset.app, e.clientX, e.clientY);
  });

  bindLongPress(appsGrid, '.apps-tile');

  appsSearch.addEventListener('input', () => {
    searchQuery = appsSearch.value;
    renderGrid();
  });

  appsFilterAll.addEventListener('click', () => {
    filterRunning = false;
    appsFilterAll.classList.add('active');
    appsFilterRun.classList.remove('active');
    renderGrid();
  });

  appsFilterRun.addEventListener('click', () => {
    filterRunning = true;
    appsFilterRun.classList.add('active');
    appsFilterAll.classList.remove('active');
    renderGrid();
  });

  appsCloseBtn.addEventListener('click', () => { appsModal.hidden = true; });

  // The modal's own backdrop handling comes from desktop.css + the shared
  // Escape handler in desktop.js; only the context menu is managed here.
  document.addEventListener('click', (e) => {
    if (ctxMenu.hidden) return;
    if (Date.now() - menuOpenedAt < 350) return; // the gesture that opened it
    if (!ctxMenu.contains(e.target)) closeCtxMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCtxMenu();
  });

  window.addEventListener('resize', closeCtxMenu);
  window.addEventListener('scroll', closeCtxMenu, { capture: true, passive: true });
}
