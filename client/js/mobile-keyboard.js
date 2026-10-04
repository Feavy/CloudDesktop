// Virtual (soft) keyboard for touch devices.
//
// The remote desktop is a canvas, and noVNC grabs keydown/keyup on that canvas.
// A canvas cannot be focused in a way that makes iOS or Android raise the
// on-screen keyboard, so we keep a real off-screen input focused to summon the
// OS keyboard and translate what is typed into calls noVNC can send.
//
// Two things make this work rather than merely appear to work:
//
//  * While the keyboard is open we suspend noVNC's click-to-focus. Otherwise
//    tapping a remote text field focuses the canvas, the input loses focus and
//    the soft keyboard closes -- so you could never tap into a field and type.
//  * While the keyboard is open -- and while it is on its way closed -- we
//    suspend resizeSession. On Android the soft keyboard shrinks the layout
//    viewport, and noVNC would otherwise resize the whole remote desktop to
//    match, re-flowing every window each time the keyboard opens or closes.
//
// Closing is the hard half. The OS does not tear the keyboard down when we
// blur the input: it plays an animation over a few hundred milliseconds and
// grows the viewport back in steps, firing a resize event for each. Re-enabling
// resizeSession on blur therefore leaves it on during that animation, and noVNC
// debounces its own request by 500ms -- so the last request it sends describes a
// viewport that no longer exists. Both that request and our own fit-to-viewport
// call land on the same xrandr mode, the two race, and the desktop ends up at
// whichever size won. Hence SETTLE_*: resizeSession stays off until the viewport
// has actually stopped moving, and only then do we tell the caller to refit.

import * as KeyboardUtil from '/vendor/novnc/core/input/util.js';
import KeyTable from '/vendor/novnc/core/input/keysym.js';

// How long the viewport has to stay still before we believe the keyboard is
// really gone. Android's close animation is ~250ms and its resize events arrive
// throughout, so the quiet window has to be comfortably longer than the gaps
// between them. The cap keeps a viewport that never settles (an orientation
// change mid-dismissal) from stranding the session on the shrunk resolution.
const SETTLE_QUIET_MS = 250;
const SETTLE_MAX_MS = 1500;

export function createMobileKeyboard({ getRfb, button, onOpenChange }) {
  let input = null;
  let open = false;

  // Viewport height while the keyboard was up, remembered when it opens. On
  // close we wait for the viewport to climb back to at least this height before
  // believing the animation is over -- a pure quiet-timer would fire during the
  // slow part of the animation, where no resize event has happened yet.
  let baselineHeight = 0;
  let settle = null;
  // noVNC's resizeSession as it was before we suspended it, so we put it back
  // the way we found it. It is not always on: on a touch device the caller owns
  // the remote resolution and keeps noVNC out of it.
  let resumeResizeSession = null;

  // Text the keydown path already sent, so the input/composition fallback below
  // does not send the same characters a second time.
  let recentlySent = '';
  // Keys we have pressed but not yet released, so a keyboard that vanishes
  // mid-press cannot leave a modifier stuck down on the remote desktop.
  const held = new Map();

  function ensureInput() {
    if (input) return input;

    input = document.createElement('textarea');
    input.setAttribute('aria-label', 'Remote keyboard');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');
    // Off-screen rather than display:none: a hidden element cannot be focused on
    // iOS. font-size must stay at 16px or iOS zooms the page into this 1px box
    // the moment it takes focus. pointer-events:none keeps the trackpad layer
    // above it usable.
    input.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'width:1px', 'height:1px',
      'font-size:16px', 'opacity:0', 'border:0', 'padding:0', 'margin:0',
      'resize:none', 'overflow:hidden', 'white-space:nowrap',
      'pointer-events:none', 'caret-color:transparent', 'z-index:-1',
    ].join(';') + ';';

    document.body.appendChild(input);

    input.addEventListener('keydown', onKeyDown);
    input.addEventListener('keyup', onKeyUp);
    input.addEventListener('input', onInput);
    return input;
  }

  function sendKey(keysym, code, down, caps, num) {
    const rfb = getRfb();
    if (!rfb) return;
    if (down) {
      // Mirror noVNC's lock-key resync: if the remote Caps/Num state disagrees
      // with the device, toggle it first so the keystroke lands with the
      // modifier the user expects.
      syncLock(rfb, code, 'CapsLock', KeyTable.XK_Caps_Lock, caps);
      syncLock(rfb, code, 'NumLock', KeyTable.XK_Num_Lock, num);
    }
    rfb.sendKey(keysym, code, down);
  }

  function syncLock(rfb, code, name, keysym, state) {
    if (code === name) {
      // The user is pressing the lock key itself: forget the cached remote
      // state so we neither double-toggle nor "fix" it on the next keystroke.
      if (name === 'CapsLock') rfb._remoteCapsLock = null;
      else rfb._remoteNumLock = null;
      return;
    }
    const remote = name === 'CapsLock' ? rfb._remoteCapsLock : rfb._remoteNumLock;
    if (remote === null || remote === undefined || state === null || state === remote) return;
    rfb.sendKey(keysym, name, true);
    rfb.sendKey(keysym, name, false);
    if (name === 'CapsLock') rfb._remoteCapsLock = null;
    else rfb._remoteNumLock = null;
  }

  function onKeyDown(e) {
    const rfb = getRfb();
    if (!rfb) return;
    e.preventDefault();

    const code = KeyboardUtil.getKeycode(e);
    const keysym = KeyboardUtil.getKeysym(e);

    // A virtual keyboard with no key info still tells us the character, so send
    // it as an instant tap. Matches what noVNC does for unidentified keys.
    if (keysym === null) {
      const ks = charKeysym(e.key);
      if (!ks) return;
      const caps = mod(e, 'CapsLock'), num = mod(e, 'NumLock');
      sendKey(ks, code, true, caps, num);
      sendKey(ks, code, false, caps, num);
      return;
    }

    if (e.key && e.key.length === 1) remember(e.key);
    held.set(code, keysym);
    sendKey(keysym, code, true, mod(e, 'CapsLock'), mod(e, 'NumLock'));
  }

  function onKeyUp(e) {
    const rfb = getRfb();
    if (!rfb) return;
    e.preventDefault();
    const code = KeyboardUtil.getKeycode(e);
    // Only release what we pressed. Soft keyboards emit keyup for keys that
    // never reached us, and a stray release leaves a modifier stuck down on
    // the remote desktop.
    if (!held.has(code)) return;
    const keysym = held.get(code);
    held.delete(code);
    sendKey(keysym, code, false, mod(e, 'CapsLock'), mod(e, 'NumLock'));
  }

  // Autocorrect, swipe typing and IME composition insert text without ever
  // delivering a usable keydown. Whatever lands in the input is therefore sent
  // as taps, minus anything the keydown path already reported.
  function onInput() {
    const rfb = getRfb();
    const typed = input.value;
    input.value = '';
    if (!rfb || !typed) return;

    let text = typed;
    if (recentlySent) {
      const n = Math.min(recentlySent.length, typed.length);
      if (typed.slice(0, n) === recentlySent.slice(0, n)) {
        text = typed.slice(n);
        recentlySent = recentlySent.slice(n);
      } else {
        recentlySent = '';
      }
    }
    for (const ch of text) {
      sendKey(ch.charCodeAt(0), 'Unidentified', true, null, null);
      sendKey(ch.charCodeAt(0), 'Unidentified', false, null, null);
    }
    if (recentlySent) setTimeout(() => { recentlySent = ''; }, 250);
  }

  function remember(ch) {
    recentlySent = (recentlySent + ch).slice(-8);
  }

  function charKeysym(key) {
    return key && key.length === 1 ? key.charCodeAt(0) : 0;
  }

  function mod(e, name) {
    try { return e.getModifierState(name); } catch { return null; }
  }

  // `settled` is false while the keyboard is still animating away: the caller
  // is not told yet, because a refit now would measure a viewport that is about
  // to change again. See settleClose.
  function setOpen(next, settled = true) {
    if (open === next) return;
    open = next;

    const rfb = getRfb();
    if (rfb) {
      // See the note at the top of this file: both of these are what stop the
      // soft keyboard from breaking the session. focusOnClick only concerns
      // focus, which blur() settles synchronously; resizeSession is layout and
      // has to wait for the viewport.
      rfb.focusOnClick = !next;
      if (next) {
        if (resumeResizeSession === null) resumeResizeSession = rfb.resizeSession;
        rfb.resizeSession = false;
      }
    }
    if (button) button.classList.toggle('active', next);
    if (settled) onOpenChange?.(next);
  }

  // Re-enable noVNC's own resize and announce the keyboard as gone, but only
  // once the viewport has stopped moving (see the note at the top).
  function settleClose() {
    const state = { timer: null, cap: null, onResize: null };
    settle = state;

    const finish = () => {
      if (settle !== state) return;
      settle = null;
      window.removeEventListener('resize', state.onResize);
      clearTimeout(state.timer);
      clearTimeout(state.cap);
      const rfb = getRfb();
      if (rfb) rfb.resizeSession = resumeResizeSession ?? true;
      resumeResizeSession = null;
      onOpenChange?.(false);
    };

    // Any resize means the animation is still running (or has moved on), so
    // restart the quiet window.
    state.onResize = () => {
      clearTimeout(state.timer);
      state.timer = setTimeout(check, SETTLE_QUIET_MS);
    };

    const started = Date.now();
    // Quiet for SETTLE_QUIET_MS is not on its own proof the keyboard is gone:
    // the animation can sit still for a moment partway through. Only accept a
    // viewport that is back to at least the height it had before the keyboard
    // opened, which no intermediate frame of the animation reaches.
    const check = () => {
      const short = window.innerHeight < baselineHeight - 1;
      if (short && Date.now() - started < SETTLE_MAX_MS) {
        state.timer = setTimeout(check, SETTLE_QUIET_MS);
        return;
      }
      finish();
    };

    const tall = window.innerHeight >= baselineHeight - 1;
    state.timer = setTimeout(check, tall ? 0 : SETTLE_QUIET_MS);
    state.cap = setTimeout(finish, SETTLE_MAX_MS);
  }

  // Called when the keyboard is reopened mid-settle. Hand back the resizeSession
  // we are still holding suspended, so the new open captures the right value to
  // restore: leaving it off here would strand the session with noVNC's resize
  // permanently disabled after a quick tap-toggle-tap on the keyboard button.
  function cancelSettle() {
    if (!settle) return;
    const state = settle;
    settle = null;
    window.removeEventListener('resize', state.onResize);
    clearTimeout(state.timer);
    clearTimeout(state.cap);
    const rfb = getRfb();
    if (rfb) rfb.resizeSession = resumeResizeSession ?? true;
    resumeResizeSession = null;
  }

  function openKeyboard() {
    cancelSettle();
    // A reconnect mid-press replaces the RFB object; anything remembered from
    // the old session must not be released into the new one.
    held.clear();
    recentlySent = '';
    // Re-capture on every open: a reconnect may have handed us an RFB with a
    // different resizeSession setting.
    resumeResizeSession = null;
    baselineHeight = window.innerHeight;
    const el = ensureInput();
    // Must happen inside the user gesture that opened it: browsers only raise
    // the soft keyboard for a focus() call made during one.
    el.focus({ preventScroll: true });
    // iOS scrolls the page to the focused element; the input is at 0,0 already
    // but an earlier scroll may not have been undone.
    window.scrollTo(0, 0);
    setOpen(true);
  }

  function closeKeyboard() {
    releaseHeld();
    input?.blur();
    // Not settled: the caller is told once the viewport has finished growing
    // back, not on blur.
    setOpen(false, false);
    settleClose();
  }

  function releaseHeld() {
    if (!held.size) return;
    const rfb = getRfb();
    if (rfb) {
      for (const [code, keysym] of held) rfb.sendKey(keysym, code, false);
    }
    held.clear();
  }

  // After any synthetic click we send to the canvas, make sure the input still
  // has focus so the next character lands somewhere.
  function refocus() {
    if (open && document.activeElement !== input) input?.focus({ preventScroll: true });
  }

  return {
    isOpen: () => open,
    // True while the keyboard is up *and* while it is animating away: both are
    // times when the viewport is not the one a fit-to-viewport should measure.
    blocksResize: () => open || !!settle,
    open: openKeyboard,
    close: closeKeyboard,
    toggle: () => (open ? closeKeyboard() : openKeyboard()),
    refocus,
  };
}