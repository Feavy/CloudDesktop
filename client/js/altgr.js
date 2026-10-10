// AltGr (X11 level 3) characters the browser can fail to report.
//
// On a French AZERTY keyboard, AltGr+é types "~", AltGr+è types "`",
// AltGr+ç types "^", and so on. For the combinations the client OS treats as
// DEAD KEYS -- "~", "`" and "^" -- Chromium on Windows delivers the key's
// *unshifted* character in KeyboardEvent.key instead of the composed one:
// AltGr+é arrives as `key: "é"`. There is nothing else in the event that tells
// that "é" apart from a plain, unmodified "é".
//
// noVNC trusts `KeyboardEvent.key`, turns "é" into the X11 keysym for é
// (0x00e9) and sends it, so the remote desktop types é instead of ~. The
// character cannot be recovered from the event, so recover it from the physical
// key: KeyboardEvent.code is layout independent, and a French AZERTY keyboard
// always puts the same level-3 character on the same physical key.
//
// The map is consulted only when AltGr is held AND the browser reported exactly
// the key's unshifted character -- precisely the "the browser did not compose
// this for us" case. A browser that does compose (Chromium on Linux, Firefox)
// reports "~", which is not the unshifted character, so it is left alone and
// noVNC handles the event as before. A code that is not in the map is left
// alone too, so only combinations that are actually broken are affected.
//
// Values are [unshifted character, level-3 X11 keysym] taken from the base
// French XKB layout (/usr/share/X11/xkb/symbols/fr). Only the standard symbol
// set is listed: characters the browser already reports correctly are harmless
// here (the guard never matches) but are kept for browsers that get them wrong.

const FRENCH_AZERTY_ALTGR = {
    Digit2: ['é', 0x7e], // ~
    Digit3: ['"', 0x23], // #
    Digit4: ["'", 0x7b], // {
    Digit5: ['(', 0x5b], // [
    Digit6: ['-', 0x7c], // |
    Digit7: ['è', 0x60], // `
    Digit8: ['_', 0x5c], // \
    Digit9: ['ç', 0x5e], // ^
    Digit0: ['à', 0x40], // @
    Minus:  [')', 0x5d], // ]
    Equal:  ['=', 0x7d], // }
};

function modifierState(evt, name) {
    try {
        return evt.getModifierState(name);
    } catch {
        return false;
    }
}

// True when AltGr is held. On Windows AltGr is delivered as a fake Ctrl+Alt
// pair, so both modifiers are set; on X11 the browser sets AltGraph instead
// (and usually leaves ctrlKey/altKey clear).
function isAltGr(evt) {
    return (evt.ctrlKey && evt.altKey) || modifierState(evt, 'AltGraph');
}

// Same character, ignoring case: CapsLock makes the browser report "É" where
// the unmodified key is "é", and AltGr+é still produces "~".
function sameChar(a, b) {
    return a === b || (a.length === 1 && b.length === 1 &&
                       a.toLowerCase() === b.toLowerCase());
}

// The keysym noVNC should send for this event, or null to leave it untouched.
export function altGrKeysym(evt) {
    if (!evt || !evt.code || typeof evt.key !== 'string' || !isAltGr(evt)) {
        return null;
    }

    const entry = FRENCH_AZERTY_ALTGR[evt.code];
    if (!entry) return null;

    const [unshifted, keysym] = entry;
    // Only when the browser handed us the unshifted character: if it composed
    // the level-3 character already, `key` is something else and the normal
    // noVNC path is correct.
    if (!sameChar(evt.key, unshifted)) return null;

    return keysym;
}
