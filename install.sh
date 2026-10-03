#!/bin/bash
# ============================================================================
#  Installs every prerequisite for the desktop pod into a bare Ubuntu image.
#
#  FROM ubuntu:24.04
#  COPY install.sh /tmp/
#  RUN bash /tmp/install.sh && rm -rf /var/lib/apt/lists/*
#
#  This replaces the upstream project's host installer: no nginx, no TLS, no
#  fail2ban, no firewall, no systemd. Those belong to the pod and to the
#  Traefik reverse proxy in front of it.
#
#  Optional extras are opt-in via environment variables:
#    INSTALL_BROWSERS=1   Google Chrome (the dock's "Chrome" icon)
#    INSTALL_FIREFOX=1    Firefox
#    INSTALL_DOCS=1       LibreOffice
#    DISPLAY_GEOMETRY=1920x1080
#    VNC_PORT=5900        raw RFB port
#    VNC_WS_PORT=6900     websockify port
# ============================================================================
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
export LC_ALL=C

VNC_GEOMETRY="${DISPLAY_GEOMETRY:-1920x1080}"
VNC_DEPTH="${VNC_DEPTH:-24}"
VNC_PORT="${VNC_PORT:-5900}"
VNC_WS_PORT="${VNC_WS_PORT:-6900}"
VNC_DISPLAY="${VNC_DISPLAY:-:1}"

log()  { echo -e "\033[0;32m[+]\033[0m $*"; }
warn() { echo -e "\033[1;33m[!]\033[0m $*"; }
die()  { echo -e "\033[0;31m[x]\033[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Must run as root (use docker build as root, or sudo)."
. /etc/os-release
case "$ID" in
    ubuntu) log "Detected $PRETTY_NAME" ;;
    *) warn "This script is written for Ubuntu; proceeding on $ID anyway." ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
# 1. Interactively-prompted packages must be pre-seeded or apt-get will hang.
# ─────────────────────────────────────────────────────────────────────────────
log "Seeding debconf defaults"
export DEBIAN_FRONTEND=noninteractive
echo "locales all/LOCALE=en_US.UTF-8"          > /etc/locale.gen
echo "keyboard-configuration keyboard/xkb-keymap select us"   > /etc/default/keyboard
echo "keyboard-configuration keyboard/xkb-layout  select us"   >> /etc/default/keyboard
debconf-set-selections <<'EOF'
tzdata tzdata/Areas select Etc
tzdata tzdata/Zones select UTC
EOF

# ─────────────────────────────────────────────────────────────────────────────
# 2. Base system + build bits
# ─────────────────────────────────────────────────────────────────────────────
log "Installing base system"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
    ca-certificates curl wget gnupg apt-transport-https \
    locales tzdata keyboard-configuration xkb-data \
    procps psmisc tini ca-certificates

# Make the image's locale usable for GTK apps
localedef -i en_US -c -f UTF-8 -A /usr/share/locale/locale.alias en_US.UTF-8 || true
echo "en_US.UTF-8 UTF-8" > /etc/locale.gen

# ─────────────────────────────────────────────────────────────────────────────
# 3. X server plumbing
#
#    NOTE: this is the part the web client silently depends on. It shells out
#    to xclip, wmctrl, xrandr and cvt, so a container missing these renders the
#    desktop fine but silently loses clipboard sync, the window switcher and
#    resolution switching.
# ─────────────────────────────────────────────────────────────────────────────
log "Installing X server tools (xclip, wmctrl, xrandr, cvt, xauth)"
apt-get install -y -qq --no-install-recommends \
    x11-xserver-utils \
    x11-utils \
    xauth \
    xclip \
    wmctrl \
    x11-xserver-xorg-input-all \
    xserver-xorg-input-libinput \
    xkb-data \
    xdg-utils \
    dbus-x11 \
    policykit-1

# `cvt` (modeline generation) and `xrandr` come from x11-xserver-utils.
# `vncconfig` and `Xvnc` come from tigervnc-common.
# `dbus-launch` comes from dbus-x11.
for bin in xrandr cvt xclip wmctrl xauth xdpyinfo dbus-launch; do
    command -v "$bin" >/dev/null 2>&1 || die "expected '$bin' after install but it is missing"
done
log "X tooling verified: $(command -v xrandr) / $(command -v xclip) / $(command -v wmctrl)"

# ─────────────────────────────────────────────────────────────────────────────
# 4. TigerVNC + websockify
# ─────────────────────────────────────────────────────────────────────────────
log "Installing TigerVNC and websockify"
apt-get install -y -qq --no-install-recommends \
    tigervnc-standalone-server \
    tigervnc-common \
    websockify

command -v Xtigervnc >/dev/null 2>&1 || die "Xtigervnc not found after install"
log "Xtigervnc: $(Xtigervnc -version 2>&1 | head -1)"

# ─────────────────────────────────────────────────────────────────────────────
# 5. XFCE desktop
# ─────────────────────────────────────────────────────────────────────────────
log "Installing XFCE (this is the bulk of the image)"
apt-get install -y -qq \
    xfce4 \
    xfce4-terminal \
    thunar \
    mousepad \
    xfce4-notifyd \
    xfce4-screenshooter \
    adwaita-icon-theme \
    dbus-user-session

log "Installing fonts (without these the desktop renders with tofu boxes)"
apt-get install -y -qq --no-install-recommends \
    xfonts-base \
    fonts-dejavu-core \
    fonts-liberation \
    fonts-noto-color-emoji \
    fontconfig
fc-cache -f >/dev/null 2>&1 || true

# ─────────────────────────────────────────────────────────────────────────────
# 6. Optional extras
# ─────────────────────────────────────────────────────────────────────────────
if [ "${INSTALL_BROWSERS:-0}" = "1" ]; then
    log "Installing Google Chrome"
    curl -fsSL -o /tmp/chrome.deb \
        https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    apt-get install -y -qq /tmp/chrome.deb || apt-get install -y -qq -f
    rm -f /tmp/chrome.deb
fi

if [ "${INSTALL_FIREFOX:-0}" = "1" ]; then
    # Ubuntu's `firefox` package is a snap transitional wrapper, which does not
    # work in a container. Use the Mozilla APT repo instead.
    log "Installing Firefox (Mozilla APT repo)"
    apt-get install -y -qq --no-install-recommends ca-certificates gnupg
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg \
        | gpg --dearmor -o /etc/apt/keyrings/packages.mozilla.org.asc
    echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] \
https://packages.mozilla.org/apt mozilla main" > /etc/apt/sources.list.d/mozilla.list
    apt-get update -qq
    apt-get install -y -qq firefox
fi

if [ "${INSTALL_DOCS:-0}" = "1" ]; then
    log "Installing LibreOffice"
    apt-get install -y -qq --no-install-recommends libreoffice-calc libreoffice-writer
fi

# ─────────────────────────────────────────────────────────────────────────────
# 7. X startup script
#
#    Xtigervnc runs this instead of a bare X server. Without it you get a grey
#    screen with no session.
# ─────────────────────────────────────────────────────────────────────────────
log "Writing XFCE VNC session startup script"
cat > /usr/local/bin/xfce-vnc-session <<'SESSION'
#!/bin/bash
# Started by Xtigervnc via -xstartup. Runs the desktop inside the X server.

# A per-uid D-Bus socket dir; $XDG_RUNTIME_DIR is often unset in containers.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-$(id -u)}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# Give the session its own D-Bus. XFCE panels and thunar need one.
if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then
    eval "$(dbus-launch --sh-syntax)"
    export DBUS_SESSION_BUS_ADDRESS
fi

export XDG_SESSION_TYPE=x11
export XDG_CONFIG_DIRS=/etc/xdg
export XDG_DATA_DIRS=/usr/local/share:/usr/share
export XDG_CURRENT_DESKTOP=XFCE

# Bridge the X clipboard to the VNC clipboard in both directions.
#   vncconfig  = VNC side  <-> X selections
#   autocutsel = PRIMARY   <-> CLIPBOARD
vncconfig -nowin >/dev/null 2>&1 &
autocutsel -fork -selection CLIPBOARD >/dev/null 2>&1 &

# Network manager applet is meaningless in a pod and spams errors on a
# machine-id it can never reach.
xfce4-session >/dev/null 2>&1 &
SESSION
chmod +x /usr/local/bin/xfce-vnc-session

# ─────────────────────────────────────────────────────────────────────────────
# 8. Xtigervnc launcher
#
#    -SecurityTypes None is deliberate: the browser client has no VNC password
#    field and sends an empty credential. If you enable VNC auth you must also
#    change client/js/desktop.js to prompt for one.
# ─────────────────────────────────────────────────────────────────────────────
log "Writing Xtigervnc launcher"
cat > /usr/local/bin/start-vnc <<'STARTVNC'
#!/bin/bash
# Start Xtigervnc with the XFCE session on DISPLAY.
set -euo pipefail

DISPLAY_NUM="${VNC_DISPLAY:-:1}"
GEOMETRY="${DISPLAY_GEOMETRY:-1920x1080}"
DEPTH="${VNC_DEPTH:-24}"
RFB_PORT="${VNC_PORT:-5900}"
WS_PORT="${VNC_WS_PORT:-6900}"

# Clear stale locks from an unclean shutdown
rm -f "/tmp/.X${DISPLAY_NUM#:}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM#:}" 2>/dev/null || true

export DISPLAY="$DISPLAY_NUM"

Xtigervnc "$DISPLAY_NUM" \
    -geometry "$GEOMETRY" \
    -depth "$DEPTH" \
    -rfbport "$RFB_PORT" \
    -localhost yes \
    -SecurityTypes None \
    -AlwaysShared \
    -AcceptKeyEvents \
    -AcceptPointerEvents \
    -SendCutText \
    -AcceptCutText \
    -xstartup /usr/local/bin/xfce-vnc-session \
    -NeverStartErrorDialog &

VNC_PID=$!

# Wait for the X server to accept connections before declaring success
for _ in $(seq 1 30); do
    if xdpyinfo -display "$DISPLAY_NUM" >/dev/null 2>&1; then
        echo "X server ready on $DISPLAY_NUM (${GEOMETRY}, RFB :${RFB_PORT})"
        break
    fi
    if ! kill -0 "$VNC_PID" 2>/dev/null; then
        echo "Xtigervnc died during startup" >&2
        exit 1
    fi
    sleep 0.5
done

# websockify exposes the same RFB stream over WebSocket.
#
# The Debian websockify package does NOT pull in noVNC, and we do not want it
# to: the web client in this repo serves its own bundled noVNC. So --web is
# only passed if a noVNC tree happens to be present (e.g. you installed the
# `novnc` package yourself).
NOVNC_WEB_ARGS=()
if [ -d /usr/share/novnc ]; then
    NOVNC_WEB_ARGS=(--web=/usr/share/novnc)
fi

echo "websockify :${WS_PORT} -> 127.0.0.1:${RFB_PORT}"
websockify ${NOVNC_WEB_ARGS[@]+"${NOVNC_WEB_ARGS[@]}"} "0.0.0.0:${WS_PORT}" "127.0.0.1:${RFB_PORT}" &
WS_PID=$!

# Exit if either dies so the container restarts rather than serving nothing
wait -n "$VNC_PID" "$WS_PID"
echo "A VNC process exited; shutting down."
kill "$VNC_PID" "$WS_PID" 2>/dev/null || true
STARTVNC
chmod +x /usr/local/bin/start-vnc

# ─────────────────────────────────────────────────────────────────────────────
# 9. Wrap Xtigervnc's own launcher so `startvnc` behaves predictably
# ─────────────────────────────────────────────────────────────────────────────
ln -sf /usr/local/bin/start-vnc /usr/local/bin/start-desktop

# ─────────────────────────────────────────────────────────────────────────────
# 10. Cleanup
# ─────────────────────────────────────────────────────────────────────────────
log "Cleaning apt cache"
apt-get clean
rm -rf /var/lib/apt/lists/*

# ─────────────────────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────────────────────
cat <<SUMMARY

  Prerequisites installed.

  Scripts written:
    /usr/local/bin/start-vnc        Xtigervnc + XFCE + websockify
    /usr/local/bin/xfce-vnc-session XFCE session run inside X

  Defaults:
    display   ${VNC_DISPLAY}  ${VNC_GEOMETRY} depth ${VNC_DEPTH}
    RFB       :${VNC_PORT}  (loopback only)
    websocket :${VNC_WS_PORT}  (bound to 0.0.0.0)

  CMD ["start-vnc"]

  Next: add the web client as a second container in the same pod, or run it
  as its own deployment pointed at the websockify port above.

SUMMARY