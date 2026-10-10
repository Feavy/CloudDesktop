// Runtime configuration.
//
// Everything is read from process.env so the pod's Deployment/StatefulSet
// manifest is the single source of truth. Authentication and TLS are
// deliberately absent: they are handled by the Traefik reverse proxy in
// front of this service (forwardAuth middleware).
const os = require('os');
const fs = require('fs');
const path = require('path');

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Whether this process runs in a container that the runtime will bring back
// when its main process exits. That is what makes a self-restart a pod
// restart: Kubernetes always injects KUBERNETES_SERVICE_HOST and mounts the
// service account (unless automountServiceAccountToken is turned off), and
// Docker drops /.dockerenv. A dev checkout has none of those, so it keeps the
// deployment-supplied RESTART_CMD instead.
function detectContainer() {
  if (process.env.KUBERNETES_SERVICE_HOST) return true;
  try {
    return fs.existsSync('/.dockerenv') ||
      fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount');
  } catch {
    return false;
  }
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

  // Where applications launched on the session display start. The dock's
  // terminal is the reason this exists: spawned without a cwd it inherits the
  // server's, which is the image's WORKDIR (/app) or / after pivot-root, and
  // the terminal opens there instead of in the user's home. Undefined when the
  // home is somehow missing, so the spawn falls back to inheritance.
  LAUNCH_CWD: fs.existsSync(HOME_DIR) ? HOME_DIR : undefined,

  // True when the process is the one the container runtime watches, so
  // POST /api/desktop/restart can restart the pod by exiting.
  IS_CONTAINER: detectContainer(),

  // Which restart the dock should use: 'auto' (default) works it out from the
  // environment, and 'pod' / 'session' / 'command' / 'off' force one when the
  // guess is wrong. See restartMode() in routes/desktop.js.
  RESTART_MODE: process.env.RESTART_MODE || 'auto',

  // Fallback used only outside a container, where there is no pod to restart:
  // a dev checkout supplies the command that recycles its session. In a
  // container the restart is the pod itself and this is not consulted.
  RESTART_CMD: process.env.RESTART_CMD || '',
};