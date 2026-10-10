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

// AUDIO_ENABLED is tri-state: a truthy value forces audio on, a falsy one turns
// it off, and anything else -- including unset -- leaves it to autodetection
// (which is on wherever the capture tool is installed). Same spirit as
// RESTART_MODE, minus the guessing.
function audioMode(value) {
  if (value === undefined || value === '') return 'auto';
  const v = String(value).trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return 'on';
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return 'off';
  return 'auto';
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

  // Browser tab / page title of the web client. desktop.html ships a
  // %PAGE_TITLE% placeholder that app.js substitutes while serving it, so a
  // deployment can rebrand the tab without patching the client tree.
  PAGE_TITLE: process.env.PAGE_TITLE || 'CloudDesktop',

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

  // PulseAudio's native socket lives in $XDG_RUNTIME_DIR/pulse, and in a
  // container logind is not running, so /run/user/<uid> usually does not
  // exist. start-vnc and xfce-vnc-session both fall back to /tmp/runtime-<uid>
  // (see install.sh), and this is the same default: the audio capture below
  // and the desktop's daemon have to agree on one directory, and they do as
  // long as neither side invents its own. A deployment that sets
  // XDG_RUNTIME_DIR still gets it on both sides.
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR
    || `/tmp/runtime-${typeof process.getuid === 'function' ? process.getuid() : 0}`,

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

  // ── Desktop audio ──────────────────────────────────────────
  // What the remote desktop plays is captured from PulseAudio and streamed to
  // the browser over /audio as raw PCM, which client/js/audio.js feeds to the
  // Web Audio API. That is the same shape Guacamole uses and it keeps an
  // encoder out of the image. install.sh is what makes the source exist: the
  // desktop session runs PulseAudio with a virtual sink, because a container
  // has no sound card.
  //
  // 'auto' enables it when the capture tool is installed -- true of the
  // desktop and all-in-one images, false of the Alpine client-only image,
  // where there is no desktop beside it to capture. 'on' forces it, 'off'
  // makes GET /api/desktop/config report it unavailable and the /audio
  // endpoint reject connections.
  AUDIO_ENABLED: audioMode(process.env.AUDIO_ENABLED),

  // parec, from pulseaudio-utils. Overridable so a deployment can point at a
  // different capture tool, but the arguments below are parec's.
  AUDIO_CAPTURE_CMD: process.env.AUDIO_CAPTURE_CMD || 'parec',

  // PulseAudio source to capture. @DEFAULT_MONITOR@ is PulseAudio's own alias
  // for the monitor of the default sink, so it follows install.sh's virtual
  // sink without this file having to name it.
  AUDIO_SOURCE: process.env.AUDIO_SOURCE || '@DEFAULT_MONITOR@',

  AUDIO_RATE: int(process.env.AUDIO_RATE, 48000),
  AUDIO_CHANNELS: int(process.env.AUDIO_CHANNELS, 2),

  // How much audio parec asks PulseAudio for per read. This is the floor on
  // the stream's latency.
  AUDIO_LATENCY_MS: int(process.env.AUDIO_LATENCY_MS, 50),

  // Chunks whose loudest sample falls below this are not sent at all. A null
  // sink produces exact digital silence when nothing plays (every sample 0),
  // so a small threshold drops idle bandwidth without touching real audio;
  // quiet passages are far above it. 0 disables the gate and streams silence.
  AUDIO_SILENCE_THRESHOLD: int(process.env.AUDIO_SILENCE_THRESHOLD, 32),
};