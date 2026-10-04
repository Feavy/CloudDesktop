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
//  * While the keyboard is open we suspend resizeSession. On Android the soft
//    keyboard shrinks the layout viewport, and noVNC would otherwise resize the
//    whole remote desktop to match, re-flowing every window each time the
//    keyboard opens or closes.

import * as KeyboardUtil from '/vendor/novnc/core/input/util.js';
import KeyTable from '/vendor/novnc/core/input/keysym.js';

export function createMobileKeyboard({ getRfb, button, onOpenChange }) {
  let input = null;
  let open = false;

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

  function setOpen(next) {
    if (open === next) return;
    open = next;

    const rfb = getRfb();
    if (rfb) {
      // See the note at the top of this file: both of these are what stop the
      // soft keyboard from breaking the session.
      rfb.focusOnClick = !next;
      rfb.resizeSession = !next;
    }
    if (button) button.classList.toggle('active', next);
    onOpenChange?.(next);
  }

  function openKeyboard() {
    // A reconnect mid-press replaces the RFB object; anything remembered from
    // the old session must not be released into the new one.
    held.clear();
    recentlySent = '';
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
    setOpen(false);
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
    open: openKeyboard,
    close: closeKeyboard,
    toggle: () => (open ? closeKeyboard() : openKeyboard()),
    refocus,
  };
}