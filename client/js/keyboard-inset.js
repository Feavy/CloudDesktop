// Soft-keyboard inset for the client's own text fields.
//
// The client's text fields live in modals, and on a phone a modal is a bottom
// sheet -- precisely the part of the page the soft keyboard lands on. A field
// below the fold of a tall sheet (the upload destination, a rename box) ends up
// typed into blind, for two reasons: the sheet has to be lifted clear of the
// keyboard, and a field the browser had already brought into view before the
// keyboard opened is not re-scrolled when the sheet then shrinks.
//
// The lift is measured, never assumed. `visualViewport` reports the keyboard's
// top edge in layout coordinates on every platform, so the distance from it to
// the bottom of the layout viewport is how much of the page is covered:
//
//  * Android with `interactive-widget=resizes-content` (desktop.html) shrinks
//    the layout viewport itself. Both edges move together, the difference is
//    ~0, and the sheet is already clear -- lifting it again would push it off
//    the top of the screen.
//  * iOS overlays the keyboard and leaves the layout viewport alone, so the
//    difference is the keyboard's height.
//
// `documentElement.clientHeight` is the layout viewport on both. Not
// `window.innerHeight`: on iOS that tracks the browser's own toolbar and would
// read the toolbar's height as a keyboard the moment it is expanded.
//
// The difference can pick that toolbar up either way, which is what the
// threshold is for -- nothing below KB_MIN_INSET_PX counts as a keyboard. A
// toolbar is tens of pixels and a phone keyboard hundreds, so a threshold
// between the two keeps the sheet still while the toolbar comes and goes.
//
// This module only measures and reveals. The lift itself is CSS: it publishes
// --kb-inset, which the phone breakpoint's modal rules consume.

// Smallest bottom overlap read as a soft keyboard. See the note above.
const KB_MIN_INSET_PX = 120;

// Input types that never summon a text keyboard, so there is nothing to reveal
// for them. `upload-file-input` is one: it opens the file picker, not a
// keyboard, and scrolling the sheet for it would just be noise.
const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'checkbox', 'color', 'file', 'hidden', 'image',
  'radio', 'range', 'reset', 'submit',
]);

function isTextField(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  return !NON_TEXT_INPUT_TYPES.has(type);
}

export function createKeyboardInset() {
  let inset = 0;
  let frame = 0;
  // Height of the strip the sheet is laid out in, last time we looked. The
  // sheet changes size when this does -- on iOS because the inset grew, on
  // Android because the layout viewport shrank -- and that is the moment a
  // field the browser had already revealed can slip under the keyboard.
  let stripHeight = 0;
  // Set by focusin: the viewport does not move when the user moves between two
  // fields of an already-open keyboard, so nothing else would reveal the new
  // one.
  let revealNext = false;

  function layoutHeight() {
    return document.documentElement.clientHeight || window.innerHeight;
  }

  // Bottom edge of the visible area in layout coordinates: the keyboard's top
  // edge, wherever the platform put it.
  function visibleBottom(fallback) {
    const vv = window.visualViewport;
    return vv ? vv.offsetTop + vv.height : fallback;
  }

  function apply(next) {
    if (next === inset) return;
    inset = next;
    const root = document.documentElement;
    // Unset rather than 0, so a sheet that reads var(--kb-inset, 0px) keeps
    // working with no keyboard on a device that never had one.
    if (next) root.style.setProperty('--kb-inset', next + 'px');
    else root.style.removeProperty('--kb-inset');
  }

  // The sheet is its own scroll container, and 'nearest' moves it the least it
  // can: a field that is already above the keyboard stays exactly where the
  // user left it.
  function reveal() {
    const el = document.activeElement;
    if (!isTextField(el)) return;
    try {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {
      // Older engines without the options object; leaving the field put is a
      // better failure than throwing on every viewport event.
    }
  }

  function update() {
    frame = 0;
    const layoutH = layoutHeight();
    const covered = Math.round(layoutH - visibleBottom(layoutH));
    const next = covered > KB_MIN_INSET_PX ? covered : 0;
    const strip = layoutH - next;
    const changed = strip !== stripHeight;
    const wanted = revealNext;
    revealNext = false;
    stripHeight = strip;
    apply(next);
    // Scrolled only after the new inset is published, so the CSS has already
    // resized the sheet: scrolling first would measure the old box and leave the
    // field under the keyboard. Every step of the open animation moves the
    // strip, so the field follows the sheet down as it gives way.
    if (changed || wanted) reveal();
  }

  function schedule(revealNow) {
    if (revealNow) revealNext = true;
    if (frame) return;
    frame = requestAnimationFrame(update);
  }

  // Coalesced into one frame: mobile browsers fire these in bursts, and each
  // pass applies a custom property and may scroll.
  window.addEventListener('resize', () => schedule());
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', () => schedule());
    // iOS pans the visual viewport to keep the focused field visible; the inset
    // changes with it and the sheet has to follow.
    vv.addEventListener('scroll', () => schedule());
  }
  document.addEventListener('focusin', () => schedule(true));

  schedule();

  return {
    inset: () => inset,
  };
}
