// Runtime configuration.
//
// Everything is read from process.env so the pod's Deployment/StatefulSet
// manifest is the single source of truth. Authentication and TLS are
// deliberately absent: they are handled by the Traefik reverse proxy in
// front of this service (forwardAuth middleware).
const os = require('os');
const path = require('path');

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// In a container HOME is frequently unset or `/`; fall back to the passwd entry
// so paths like ~/Desktop used by the file-transfer API still resolve.
function resolveHome() {
  if (process.env.HOME && process.env.HOME !== '/') return process.env.HOME;
  try {
    const info = os.userInfo();
    return info.homedir || '/root';
  } catch {
    return '/root';
  }
}

const HOME_DIR = resolveHome();

module.exports = {
  PORT: int(process.env.PORT, 3000),
  HOST: process.env.HOST || '0.0.0.0',

  // VNC backend. The WebSocket proxy dials this address directly over TCP.
  VNC_HOST: process.env.VNC_HOST || '127.0.0.1',
  VNC_PORT: int(process.env.VNC_PORT, 5901),

  // X display used by xrandr/xclip/wmctrl for resolution, clipboard and
  // window management.
  DISPLAY: process.env.DISPLAY || ':1',

  // WebSocket endpoint the browser uses for the VNC stream.
  //
  // If you already run websocketify in front of TigerVNC (and expose it
  // through Traefik), set WS_URL to that absolute wss:// URL and this
  // process' built-in WS→TCP bridge is bypassed entirely.
  //
  // Leave it unset to use this server's own /websockify bridge.
  WS_URL: process.env.WS_URL || '',

  HOME_DIR,
  XAUTHORITY: process.env.XAUTHORITY || path.join(HOME_DIR, '.Xauthority'),

  // Optional shell command used by POST /api/desktop/restart. There is no
  // systemd in a container, so restarting the VNC server is deployment-specific.
  // Leave unset to hide the dock's restart button.
  RESTART_CMD: process.env.RESTART_CMD || '',
};