// Ending the remote desktop session from the browser.
//
// When the desktop runs in a container of its own, the web client cannot signal
// it and has no cluster API access to restart the pod. The one channel that
// reaches it is the VNC session: install.sh binds the chord below in the
// desktop image to `xfce4-session-logout --logout`, so pressing it ends
// xfce4-session. start-vnc watches the session and tears the container down
// when it exits, which is what makes Kubernetes start the desktop again.
//
// The chord is <Primary><Alt><Shift>r (Ctrl+Alt+Shift+R). It is deliberately
// not the stock <Primary><Alt>Delete, which opens the logout confirmation
// dialog and cannot be answered blind.
//
// This lives in its own module so the exact key sequence can be tested against
// a stub RFB without a live desktop.

const XK_r      = 0x72;
const CONTROL_L = 0xffe3;
const ALT_L     = 0xffe9;
const SHIFT_L   = 0xffe1;

const KEY_CODE = 'KeyR';

// Returns false when there is no session to send to, so the caller can say so
// rather than look like it restarted something.
export function sendRestartShortcut(rfb) {
  if (!rfb) return false;

  // noVNC's sendKey() silently drops input unless the connection is up, and it
  // exposes no public "connected" flag, so the caller passes the rfb it knows
  // is live. Modifiers down, key, modifiers up — the order sendCtrlAltDel()
  // uses.
  const key = (keysym, code, down) => rfb.sendKey(keysym, code, down);
  key(CONTROL_L, 'ControlLeft', true);
  key(ALT_L, 'AltLeft', true);
  key(SHIFT_L, 'ShiftLeft', true);
  key(XK_r, KEY_CODE, true);
  key(XK_r, KEY_CODE, false);
  key(SHIFT_L, 'ShiftLeft', false);
  key(ALT_L, 'AltLeft', false);
  key(CONTROL_L, 'ControlLeft', false);
  return true;
}
