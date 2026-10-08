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
#  Optional extras are opt-in/out via environment variables:
#    INSTALL_NODE=0       skip Node.js (only if the web client is a separate
#                         deployment; it defaults to on)
#    NODE_MAJOR=22        NodeSource major version to install
#    INSTALL_BROWSERS=0   Google Chrome (the dock's "Chrome" icon)
#    INSTALL_FIREFOX=1    Firefox (opt-in; off by default)
#    INSTALL_VSCODE=0     Visual Studio Code (the dock's "VS Code" icon)
#    INSTALL_DOCS=0       LibreOffice
#    UNMINIMIZE=0         skip running the base image's stock `unminimize`,
#                         which restores the man pages, docs and translation
#                         catalogs the minimized ubuntu:24.04 image dpkg-strips
#    INSTALL_TOOLS=0      skip the common Linux command-line tools
#    INSTALL_THEME=0      skip the Orchis theme, Papirus icons and Plank dock
#    ORCHIS_THEME         Orchis variant to apply (default: Orchis-Dark)
#    ORCHIS_TAG           Orchis release tag to fetch (default: 2026-07-07)
#    EXTRA_LOCALES        extra locales to bake in, space-separated, e.g.
#                         "fr_FR.UTF-8 de_DE.UTF-8" (en_US.UTF-8 is always
#                         generated; see also start-vnc's on-the-fly fallback)
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
have_app() { command -v "$1" >/dev/null 2>&1; }

# Assert a binary the image depends on actually exists, naming the package that
# provides it so a failure says where to look instead of just what is missing.
# Defined up here because the Node step below is the first thing to call it.
check_bin() {
    command -v "$1" >/dev/null 2>&1 \
        || die "'$1' is missing after install. It should come from '$2'."
}

# True if the C library can use the named locale (e.g. fr_FR.UTF-8). `locale -a`
# lists names lowercased with `utf8` for the codeset, so compare in that shape.
locale_available() {
    local want
    want="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/utf-8/utf8/')"
    locale -a 2>/dev/null | tr '[:upper:]' '[:lower:]' | grep -qx "$want"
}

[ "$(id -u)" -eq 0 ] || die "Must run as root (use docker build as root, or sudo)."
. /etc/os-release
case "$ID" in
    ubuntu) log "Detected $PRETTY_NAME" ;;
    *) warn "This script is written for Ubuntu; proceeding on $ID anyway." ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
# 1. Pre-seed debconf so tzdata/locales do not prompt and hang the build.
#
#    Seed the debconf *database* only. Do NOT hand-write /etc/locale.gen or
#    /etc/default/keyboard: the postinst scripts of `locales` and
#    `keyboard-configuration` source those files, so anything written in the
#    wrong format makes dpkg fail with exit 127/1 and aborts the whole build.
# ─────────────────────────────────────────────────────────────────────────────
log "Seeding debconf defaults"
export DEBIAN_FRONTEND=noninteractive
debconf-set-selections <<'EOF'
tzdata tzdata/Areas select Etc
tzdata tzdata/Zones select UTC
locales locales/default_environment_locale select en_US.UTF-8
locales locales/locales_to_be_generated multiselect en_US.UTF-8
keyboard-configuration keyboard-configuration/layout select us
keyboard-configuration keyboard-configuration/modelcode select pc105
EOF

# ─────────────────────────────────────────────────────────────────────────────
# 2. Base system + build bits
# ─────────────────────────────────────────────────────────────────────────────
log "Installing base system"
apt-get update -qq

# Un-minimize the base image.
#
# The ubuntu:24.04 Docker image is the minimized cloud variant: dpkg
# path-excludes in /etc/dpkg/dpkg.cfg.d/ throw away man pages, docs and every
# translation catalog (.mo) at unpack time, and packages install "successfully"
# with none of those files on disk. /usr/bin/unminimize is the stock tool that
# undoes this -- it removes the excludes and reinstalls every installed package
# whose files were dropped. Running it here, before anything else, means all
# later installs ship their man pages, docs and .mo catalogs normally and the
# desktop can follow LANG/LC_ALL without any runtime fix-up. Costs a couple of
# minutes on a minimized base; instant on one that is not minimized.
if [ "${UNMINIMIZE:-1}" = "1" ]; then
    if command -v unminimize >/dev/null 2>&1; then
        log "Unminimizing the base image (restores man pages, docs and translation catalogs)"
        # The script asks for one interactive confirmation. printf feeds it and
        # exits cleanly under `set -o pipefail`, unlike a `yes` pipe that would
        # die on SIGPIPE when unminimize exits first.
        printf 'y\ny\ny\n' | unminimize >/dev/null \
            || warn "unminimize failed; continuing with the minimized base"
    else
        warn "unminimize not found in the base image; assuming it is not a minimized variant"
    fi
fi

apt-get install -y -qq --no-install-recommends \
    ca-certificates curl wget gnupg apt-transport-https \
    locales tzdata keyboard-configuration xkb-data \
    procps psmisc tini sudo

# The locales postinst should have generated this from the seed above; generate
# it by hand only if it somehow did not.
if ! locale_available en_US.UTF-8; then
    warn "en_US.UTF-8 was not generated by the locales postinst; generating it now"
    grep -q '^en_US.UTF-8 UTF-8' /etc/locale.gen 2>/dev/null \
        || echo "en_US.UTF-8 UTF-8" >> /etc/locale.gen
    locale-gen en_US.UTF-8 || true
fi
locale_available en_US.UTF-8 || die "en_US.UTF-8 locale unavailable"

# EXTRA_LOCALES bakes additional locales into the image, space-separated
# (EXTRA_LOCALES="fr_FR.UTF-8 de_DE.UTF-8"). Without this, pointing LANG/LC_ALL
# at any other locale fails at runtime with "setlocale: LC_ALL: cannot change
# locale" and GTK silently falls back to the C locale.
for extra in ${EXTRA_LOCALES:-}; do
    locale_available "$extra" && continue
    log "Generating extra locale $extra"
    grep -q "^${extra} UTF-8" /etc/locale.gen 2>/dev/null \
        || echo "${extra} UTF-8" >> /etc/locale.gen
    locale-gen "$extra" >/dev/null
    locale_available "$extra" || die "$extra locale unavailable"
done

# ─────────────────────────────────────────────────────────────────────────────
# 3. Common Linux command-line tools
#
#    What a terminal user on a desktop expects to find and a bare minimized
#    Ubuntu image lacks: editors, archivers, network diagnostics, monitoring,
#    completion. Set INSTALL_TOOLS=0 to skip them.
# ─────────────────────────────────────────────────────────────────────────────
if [ "${INSTALL_TOOLS:-1}" = "1" ]; then
    log "Installing common Linux tools"
    apt-get install -y -qq --no-install-recommends \
        bash-completion man-db \
        less nano vim \
        git jq bc \
        tree file zip unzip rsync \
        htop lsof strace tmux \
        net-tools iputils-ping dnsutils netcat-openbsd \
        lsb-release
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. Node.js runtime (needed by the web client)
#
#    Ubuntu 24.04 ships Node 18, which reached end of life in April 2025, so
#    take the current LTS from NodeSource instead. Set INSTALL_NODE=0 if this
#    image is a desktop-only pod and the web client lives elsewhere.
# ─────────────────────────────────────────────────────────────────────────────
if [ "${INSTALL_NODE:-1}" = "1" ]; then
    NODE_MAJOR="${NODE_MAJOR:-22}"
    log "Installing Node.js ${NODE_MAJOR}.x from NodeSource"

    # Keyring install rather than `curl | bash`, so apt verifies the repo key
    # and the image does not run a fetched script as root.
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    chmod 0644 /etc/apt/keyrings/nodesource.gpg

    # `nodistro` keeps this working across Ubuntu point releases without
    # having to track the codename.
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list

    apt-get update -qq
    apt-get install -y -qq nodejs

    # The repo is no longer needed once the packages are installed.
    rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/keyrings/nodesource.gpg

    check_bin node nodejs
    check_bin npm  nodejs
    log "Node: $(node --version)  npm: $(npm --version)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 5. X server plumbing
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
    xcvt \
    wmctrl \
    autocutsel \
    xserver-xorg-input-all \
    xserver-xorg-input-libinput \
    xkb-data \
    xdg-utils \
    dbus-x11 \
    policykit-1

# Verify every binary the web client and the session scripts actually invoke.
# Ubuntu splits these across more packages than you would expect -- `cvt` is in
# `xcvt`, not `x11-xserver-utils` -- and a missing one fails silently at
# runtime as a dock button that does nothing, so fail the build instead.
check_bin xrandr     x11-xserver-utils
check_bin cvt        xcvt
check_bin xclip      xclip
check_bin wmctrl     wmctrl
check_bin xauth      xauth
check_bin xdpyinfo   x11-utils
check_bin dbus-launch dbus-x11
log "X tooling verified (xrandr, cvt, xclip, wmctrl, xauth, xdpyinfo, dbus-launch)"

# ─────────────────────────────────────────────────────────────────────────────
# 6. TigerVNC + websockify
# ─────────────────────────────────────────────────────────────────────────────
log "Installing TigerVNC and websockify"
apt-get install -y -qq --no-install-recommends \
    tigervnc-standalone-server \
    tigervnc-common \
    websockify

check_bin Xtigervnc   tigervnc-standalone-server
check_bin vncconfig  tigervnc-common
check_bin websockify websockify
log "Xtigervnc: $(Xtigervnc -version 2>&1 | head -1)"

# ─────────────────────────────────────────────────────────────────────────────
# 7. XFCE desktop
# ─────────────────────────────────────────────────────────────────────────────
log "Installing XFCE (this is the bulk of the image)"
apt-get install -y -qq \
    xfce4 \
    xfce4-whiskermenu-plugin \
    xfce4-terminal \
    thunar \
    mousepad \
    xfce4-notifyd \
    xfce4-screenshooter \
    xcape \
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

# These back the dock icons and the session itself. The web client resolves its
# dock against $PATH at startup, so a missing one silently shrinks the dock
# rather than erroring.
check_bin startxfce4     xfce4
check_bin xfce4-session  xfce4
check_bin xfce4-terminal xfce4-terminal
check_bin thunar         thunar
check_bin mousepad       mousepad
check_bin autocutsel     autocutsel
check_bin xcape          xcape
check_bin xfce4-popup-whiskermenu xfce4-whiskermenu-plugin
log "XFCE verified"

# Make Whisker Menu the desktop's menu. The panel template that a fresh user
# config is generated from puts the plain applicationsmenu plugin first
# (plugin-1); swap it for whiskermenu so a stock session shows it. The
# keyboard-shortcuts defaults bind <Alt>F1 to xfce4-popup-applicationsmenu,
# which xcape's Super-key bridge presses (see xfce-vnc-session below) --
# rebind it to xfce4-popup-whiskermenu so the Super key opens the new menu.
# Both seds change exactly the stock lines; if a future package rename moves
# them, the greps below warn at build time instead of failing the build.
log "Switching the panel menu to Whisker Menu"
PANEL_DEFAULTS=/etc/xdg/xfce4/panel/default.xml
KBD_DEFAULTS=/etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-keyboard-shortcuts.xml
sed -i 's/value="applicationsmenu"/value="whiskermenu"/' "$PANEL_DEFAULTS"
sed -i 's/xfce4-popup-applicationsmenu/xfce4-popup-whiskermenu/' "$KBD_DEFAULTS"
grep -q 'value="whiskermenu"' "$PANEL_DEFAULTS" \
    || warn "Panel template no longer declares applicationsmenu; Whisker Menu was not made the default"
grep -q 'xfce4-popup-whiskermenu' "$KBD_DEFAULTS" \
    || warn "Keyboard shortcuts no longer bind a menu popup; the Super key may not open Whisker Menu"

# Slimmed base images sometimes dpkg-path-exclude every .mo under
# /usr/share/locale to save space. Everything then installs "successfully" and
# dpkg -L still lists the catalogs, but none are on disk -- so the desktop
# stays in English no matter what LANG/LC_ALL say, and only apps that bundle
# their own translations (Chrome) respond to a language change. dpkg reports
# nothing, so probe the filesystem directly.
if ! ls /usr/share/locale/*/LC_MESSAGES/*.mo >/dev/null 2>&1; then
    warn "No translation catalogs (.mo) were unpacked under /usr/share/locale."
    warn "The base image likely dpkg-path-excludes them; the desktop will stay in English regardless of LANG/LC_ALL."
    warn "Fix: rebuild with UNMINIMIZE=1 (the default) so the unminimize step restores them."
fi

# ─────────────────────────────────────────────────────────────────────────────
# 8. Desktop applications
#
#    Chrome and VS Code are installed by default: they are what the dock
#    exists for, and the dock hides an icon automatically when the binary is
#    missing, so a build without them ships a half-empty dock. Firefox is
#    opt-in via INSTALL_FIREFOX=1. Set the matching INSTALL_* to 0 to slim the
#    image down again.
# ─────────────────────────────────────────────────────────────────────────────
# Synaptic: the GTK package manager. Recommends are kept so the "run in
# terminal" actions (which shell out to xterm) work as a user expects.
log "Installing Synaptic package manager"
apt-get install -y -qq synaptic
check_bin synaptic synaptic

# Synaptic's stock menu entry is `synaptic-pkexec`, i.e. pkexec, which needs a
# polkit authentication agent to put up its dialog. No agent runs in this
# session, and without logind polkit would not see it as an active local
# session anyway, so launching from the applications menu silently does
# nothing (pkexec only works from a terminal, through its built-in text
# prompt). Route the menu entry through the passwordless sudo configured in
# section 9 instead: DISPLAY survives sudo's env_reset, and XAUTHORITY is
# forwarded explicitly so the root GUI lands on the user's own X server. The
# override sits in /usr/local/share/applications, which XDG_DATA_DIRS ranks
# ahead of /usr/share, so a synaptic package upgrade cannot revert it.
mkdir -p /usr/local/share/applications
cat > /usr/local/share/applications/synaptic.desktop <<'DESKTOP'
[Desktop Entry]
Name=Synaptic Package Manager
GenericName=Package Manager
Comment=Install, remove and upgrade software packages
Exec=synaptic-root
Icon=synaptic
Terminal=false
Type=Application
Categories=PackageManager;GTK;System;Settings;
X-Ubuntu-Gettext-Domain=synaptic
StartupNotify=true
StartupWMClass=synaptic
DESKTOP
cat > /usr/local/bin/synaptic-root <<'WRAPPER'
#!/bin/sh
# Launch Synaptic as root on the session's X display; written by install.sh.
exec sudo -H DISPLAY="${DISPLAY}" XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}" /usr/sbin/synaptic "$@"
WRAPPER
chmod +x /usr/local/bin/synaptic-root

if [ "${INSTALL_BROWSERS:-1}" = "1" ]; then
    log "Installing Google Chrome"
    curl -fsSL -o /tmp/chrome.deb \
        https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    apt-get install -y -qq /tmp/chrome.deb || apt-get install -y -qq -f
    rm -f /tmp/chrome.deb
    check_bin google-chrome google-chrome-stable
fi

if [ "${INSTALL_FIREFOX:-0}" = "1" ]; then
    # Ubuntu's `firefox` package is a snap transitional wrapper, which does not
    # work in a container. Use the Mozilla APT repo instead.
    log "Installing Firefox (Mozilla APT repo)"
    install -d -m 0755 /etc/apt/keyrings
    # The key is served ASCII-armored, and the file is named .asc: save it
    # verbatim. Dearmoring it into a .asc file breaks apt, which re-converts
    # .asc keyrings on use and ends up with garbage gpgv cannot read
    # (NO_PUBKEY despite the key being in the file).
    curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg \
        -o /etc/apt/keyrings/packages.mozilla.org.asc
    chmod 0644 /etc/apt/keyrings/packages.mozilla.org.asc
    echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] \
https://packages.mozilla.org/apt mozilla main" > /etc/apt/sources.list.d/mozilla.list
    apt-get update -qq
    apt-get install -y -qq firefox
    check_bin firefox firefox
fi

if [ "${INSTALL_VSCODE:-1}" = "1" ]; then
    # Microsoft's APT repo rather than a snap (snaps do not work in containers)
    # or a downloaded .deb, so `apt upgrade` inside the image keeps working.
    # The repo publishes amd64 packages only, like Chrome's .deb above.
    if [ "$(dpkg --print-architecture)" != "amd64" ]; then
        warn "VS Code's APT repo publishes amd64 packages only; skipping on $(dpkg --print-architecture)"
    else
        log "Installing Visual Studio Code (Microsoft APT repo)"
        install -d -m 0755 /etc/apt/keyrings
        curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
            | gpg --dearmor --yes -o /etc/apt/keyrings/packages.microsoft.gpg
        chmod 0644 /etc/apt/keyrings/packages.microsoft.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/packages.microsoft.gpg] \
https://packages.microsoft.com/repos/code stable main" > /etc/apt/sources.list.d/vscode.list
        apt-get update -qq
        apt-get install -y -qq code
        check_bin code code
    fi
fi

if [ "${INSTALL_DOCS:-0}" = "1" ]; then
    log "Installing LibreOffice"
    apt-get install -y -qq --no-install-recommends libreoffice-calc libreoffice-writer
fi

# ─────────────────────────────────────────────────────────────────────────────
# 9. Unprivileged runtime user
#
#    The desktop runs as this user, not root. Xtigervnc and XFCE both want a
#    writable $HOME for .Xauthority, ~/.vnc and D-Bus sockets, and running as
#    root would leave root-owned files that break the next start.
#
#    ubuntu:24.04 already ships an unprivileged `ubuntu` user at uid 1000, so
#    reuse it by default rather than deleting it and creating a second one.
#    Set DESKTOP_USER to pick a different name; if that name does not exist yet
#    and the requested uid is taken, the occupant is removed to make room.
# ─────────────────────────────────────────────────────────────────────────────
DESKTOP_USER="${DESKTOP_USER:-ubuntu}"
DESKTOP_UID="${DESKTOP_UID:-1000}"
DESKTOP_GID="${DESKTOP_GID:-1000}"

if id -u "$DESKTOP_USER" >/dev/null 2>&1; then
    log "Reusing existing user '$DESKTOP_USER'"
    DESKTOP_UID="$(id -u "$DESKTOP_USER")"
    DESKTOP_GID="$(id -g "$DESKTOP_USER")"
else
    existing_user="$(getent passwd "$DESKTOP_UID" | cut -d: -f1 || true)"
    if [ -n "$existing_user" ]; then
        log "uid $DESKTOP_UID is taken by '$existing_user'; removing it to make room for '$DESKTOP_USER'"
        userdel -r "$existing_user" >/dev/null 2>&1 || userdel "$existing_user" >/dev/null 2>&1 || true
    fi
    log "Creating unprivileged user '$DESKTOP_USER' (uid $DESKTOP_UID)"
    groupadd -f -g "$DESKTOP_GID" "$DESKTOP_USER"
    useradd -m -u "$DESKTOP_UID" -g "$DESKTOP_GID" -s /bin/bash "$DESKTOP_USER"
fi

DESKTOP_HOME="$(getent passwd "$DESKTOP_USER" | cut -d: -f6)"

# ~/Desktop and ~/Downloads are where the web client's file transfer reads and
# writes, so they must exist and be owned by the runtime user.
mkdir -p "$DESKTOP_HOME/Desktop" "$DESKTOP_HOME/Downloads" "$DESKTOP_HOME/.vnc"

# Desktop shortcuts. They reuse the .desktop files the applications menu uses,
# so synaptic's goes through synaptic-root and needs no polkit either. The
# 0755 mode is the executable half of XFCE 4.18's launcher-trust check; the
# other half (a GVfs checksum attribute) is seeded at session start by
# /usr/local/bin/trust-desktop-launchers, see section 10.
#
# VS Code's deb ships its launcher as com.microsoft.VSCode.desktop; accept the
# older code.desktop name too so a pinned repo cannot silently lose the
# shortcut.
VSCODE_DESKTOP="/usr/share/applications/com.microsoft.VSCode.desktop"
[ -f "$VSCODE_DESKTOP" ] || VSCODE_DESKTOP="/usr/share/applications/code.desktop"
log "Adding desktop shortcuts (Chrome, VS Code, Synaptic)"
for shortcut_src in \
    /usr/share/applications/google-chrome.desktop \
    "$VSCODE_DESKTOP" \
    /usr/local/share/applications/synaptic.desktop; do
    if [ -f "$shortcut_src" ]; then
        install -m 0755 "$shortcut_src" "$DESKTOP_HOME/Desktop/$(basename "$shortcut_src")"
    else
        warn "Desktop shortcut source $shortcut_src not found; skipping"
    fi
done

# Launcher-trust seeding. XFCE 4.18 shows the "Untrusted application launcher"
# prompt unless a .desktop file is executable AND GVfs metadata carries the
# sha256 of its contents (attribute metadata::xfce-exe-checksum). The
# executable bit is baked in above, but the checksum cannot be: GVfs journals
# its metadata per filesystem, so it must be written on the real $HOME after
# the container starts. This helper is called from xfce-vnc-session with the
# session D-Bus up, which is what activates gvfsd-metadata for the write.
# Recomputing every start also re-trusts launchers the user adds later, and
# unchanged files are skipped so the journal does not grow.
cat > /usr/local/bin/trust-desktop-launchers <<'TRUST'
#!/bin/sh
# Seed XFCE 4.18 launcher trust for everything on ~/Desktop; run from
# xfce-vnc-session with the session D-Bus available. Written by install.sh.
[ -d "$HOME/Desktop" ] || exit 0
for f in "$HOME"/Desktop/*.desktop; do
    [ -f "$f" ] || continue
    chmod u+x "$f" 2>/dev/null || true
    sum="$(sha256sum "$f" 2>/dev/null)" || continue
    sum="${sum%% *}"
    cur="$(gio info -a metadata::xfce-exe-checksum "$f" 2>/dev/null \
        | sed -n 's/^ *metadata::xfce-exe-checksum: *//p')"
    [ "$cur" = "$sum" ] \
        || gio set "$f" metadata::xfce-exe-checksum "$sum" 2>>/tmp/gvfs-trust.log \
        || true
done
TRUST
chmod +x /usr/local/bin/trust-desktop-launchers

chown -R "${DESKTOP_UID}:${DESKTOP_GID}" "$DESKTOP_HOME"

# X11 unix sockets. X creates /tmp/.X11-unix itself but needs the directory to
# exist and be sticky; as non-root it cannot create it if the parent is not
# writable at build time.
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

# Passwordless sudo for the runtime user.
#
# This is what lets the desktop recover from things it cannot fix as itself:
# stale /tmp/.X*-lock files left by a previous container layer under a
# different uid, recreating /tmp/.X11-unix when /tmp arrives as a fresh mount,
# and the web client's RESTART_CMD (recycling Xtigervnc and websockify).
#
# SECURITY: this is root-equivalent for anyone who can execute code as this
# user. The web client exposes file download and directory browse over HTTP, so
# treat the reverse proxy's authentication as the boundary that protects it.
# To narrow the blast radius, replace NOPASSWD:ALL below with an explicit
# command list, for example:
#
#   ${DESKTOP_USER} ALL=(root) NOPASSWD: /usr/bin/pkill, /bin/rm -f /tmp/.X*-lock
#
usermod -aG sudo "$DESKTOP_USER"
cat > "/etc/sudoers.d/${DESKTOP_USER}" <<SUDOERS
# Managed by install.sh - desktop runtime user.
Defaults:${DESKTOP_USER} !requiretty
${DESKTOP_USER} ALL=(ALL) NOPASSWD: ALL
SUDOERS
chmod 0440 "/etc/sudoers.d/${DESKTOP_USER}"

log "Runtime user: $DESKTOP_USER (uid $DESKTOP_UID), home $DESKTOP_HOME, passwordless sudo"

# ─────────────────────────────────────────────────────────────────────────────
# 10. Desktop look and feel: the Orchis theme, Papirus icons and a Plank dock
#
#     All cosmetic, so nothing here may fail the build: a theme that will not
#     download should leave a plain desktop, not a broken image. Every step
#     warns and carries on instead. Set INSTALL_THEME=0 to skip the lot.
#
#     Orchis is fetched as its prebuilt release tarball rather than built from
#     source: the tarball is pinned by tag, needs no sassc/node toolchain, and
#     unpacks in seconds. Each theme directory carries the GTK 2/3/4 styles,
#     the xfwm4 window decorations and a Plank dock theme in one piece -- the
#     whole set XFCE reads -- so a single download covers everything.
#
#     The panel layout is reworked too. XFCE's stock default is two panels: a
#     top bar (menu, taskbar, clock) and a second 48px panel along the bottom
#     holding launchers -- the panel XFCE ships as its "dock". That bottom
#     panel is dropped so the dock the user sees is Plank, and the top bar is
#     made translucent: it defaults to an opaque dark bar that ignores the GTK
#     theme, which is why a themed desktop still looks unthemed along the top.
# ─────────────────────────────────────────────────────────────────────────────
if [ "${INSTALL_THEME:-1}" = "1" ]; then
    log "Installing theme packages (Orchis, Papirus icons, Plank dock)"
    apt-get install -y -qq --no-install-recommends \
        papirus-icon-theme \
        plank \
        gtk2-engines-murrine \
        gnome-themes-extra \
        dconf-gsettings-backend \
        libglib2.0-bin \
        xz-utils

    ORCHIS_TAG="${ORCHIS_TAG:-2026-07-07}"
    ORCHIS_THEME="${ORCHIS_THEME:-Orchis-Dark}"
    ORCHIS_URL="https://raw.githubusercontent.com/vinceliuice/orchis-theme/${ORCHIS_TAG}/release/Orchis.tar.xz"

    # Guarded so Dockerfile.full, which re-runs this script on a base that
    # already carries the theme, does not download and unpack it a second time.
    if [ -d "/usr/share/themes/${ORCHIS_THEME}" ]; then
        log "Orchis theme already present; skipping download"
    else
        log "Installing the Orchis theme (${ORCHIS_TAG})"
        if curl -fsSL -o /tmp/orchis.tar.xz "$ORCHIS_URL" \
            && tar -xJf /tmp/orchis.tar.xz -C /usr/share/themes; then
            # The tarball carries variants this image has no use for: the
            # -Compact menu variants, and the GNOME Shell, Cinnamon and
            # Metacity styles, none of which XFCE reads. Dropping them keeps
            # the layer small without touching the GTK/xfwm4/plank themes.
            rm -rf /usr/share/themes/Orchis*-Compact \
                   /usr/share/themes/Orchis*/gnome-shell \
                   /usr/share/themes/Orchis*/cinnamon \
                   /usr/share/themes/Orchis*/metacity-1
        else
            warn "Could not install the Orchis theme; the desktop keeps its stock look"
        fi
        rm -f /tmp/orchis.tar.xz
    fi

    if [ -d "/usr/share/themes/${ORCHIS_THEME}" ]; then
        # Plank looks for dock themes under its own data directory, not under
        # the GTK theme's. Orchis ships one inside each GTK theme; copy the
        # matching one so `Theme=Orchis` in Plank resolves to it.
        install -d /usr/share/plank/themes/Orchis
        if [ -f "/usr/share/themes/${ORCHIS_THEME}/plank/dock.theme" ]; then
            install -m 0644 "/usr/share/themes/${ORCHIS_THEME}/plank/dock.theme" \
                /usr/share/plank/themes/Orchis/dock.theme
        else
            warn "Orchis ships no Plank dock theme; Plank will use its own default"
        fi
    fi

    check_bin plank   plank
    check_bin gsettings libglib2.0-bin

    # Point XFCE at the theme and the icons. Both are only selected if the
    # download above actually landed: with no Orchis on disk, naming it would
    # leave XFCE on a theme that does not exist, which looks worse than the
    # stock one. xfce4-settings ships the system default for the xsettings
    # channel; rewriting the two values there makes them the default for every
    # fresh session, and a container session is always fresh.
    if [ -d "/usr/share/themes/${ORCHIS_THEME}" ]; then
        XSETTINGS=/etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xsettings.xml
        if [ -f "$XSETTINGS" ]; then
            log "Selecting ${ORCHIS_THEME} and Papirus-Dark in XFCE"
            sed -i -E "s|(<property name=\"ThemeName\" type=\"string\" value=\")[^\"]*|\1${ORCHIS_THEME}|" "$XSETTINGS"
            sed -i -E 's|(<property name="IconThemeName" type="string" value=")[^"]*|\1Papirus-Dark|' "$XSETTINGS"
            grep -q "name=\"ThemeName\" type=\"string\" value=\"${ORCHIS_THEME}\"" "$XSETTINGS" \
                || warn "xsettings.xml no longer declares Net/ThemeName; the GTK theme was not set"
            grep -q 'name="IconThemeName" type="string" value="Papirus-Dark"' "$XSETTINGS" \
                || warn "xsettings.xml no longer declares Net/IconThemeName; the icon theme was not set"
        else
            warn "$XSETTINGS not found; leaving the GTK and icon themes at their defaults"
        fi

        # xfwm4 reads its own channel, and unlike xsettings it has no packaged
        # default file, so write one: without it a fresh session falls back to
        # the unthemed "Default" window decorations. Compositing is switched on
        # too -- Orchis' rounded window corners and the dock's transparency are
        # alpha, and with no compositor they render as opaque black squares.
        log "Writing the xfwm4 defaults (theme + compositing)"
        cat > /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml <<XFWM4XML
<?xml version="1.0" encoding="UTF-8"?>

<channel name="xfwm4" version="1.0">
  <property name="general" type="empty">
    <property name="theme" type="string" value="${ORCHIS_THEME}"/>
    <property name="use_compositing" type="bool" value="true"/>
  </property>
</channel>
XFWM4XML
    else
        warn "Orchis theme is not installed; leaving the stock theme and icons"
    fi

    # Rework the stock panel layout. Two edits: drop the second panel (the
    # bottom launcher bar XFCE ships as its "dock", which would otherwise sit
    # under Plank), and make the surviving top bar translucent.
    #
    # Both edits key off the exact indentation of the packaged file, which is
    # stable for a given XFCE release: the panels array's own <value> lines are
    # the only ones indented four spaces, so deleting value 2 there cannot hit
    # a plugin-ids list (indented eight), and panel-2's closing tag is the next
    # line indented four spaces. If a future package reformats the file the
    # greps below warn rather than leaving a silently broken layout.
    PANEL_DEFAULTS=/etc/xdg/xfce4/panel/default.xml
    if [ -f "$PANEL_DEFAULTS" ]; then
        log "Reworking the XFCE panel default (translucent top bar, no stock dock)"
        # dark-mode pins the panel to a dark theme regardless of the GTK
        # theme, so the Orchis theme never reaches it. Turn it off.
        sed -i 's|name="dark-mode" type="bool" value="true"|name="dark-mode" type="bool" value="false"|' "$PANEL_DEFAULTS"
        awk '
            /^  <property name="panels" type="array">$/ { in_panels = 1 }
            in_panels && /^    <value type="int" value="2"\/>$/ { next }
            in_panels && /^  <\/property>$/ { in_panels = 0 }
            /^    <property name="panel-2" type="empty">$/ { skip = 1; next }
            skip && /^    <\/property>$/ { skip = 0; next }
            skip { next }
            { print }
            /^    <property name="panel-1" type="empty">$/ {
                print "      <property name=\"background-style\" type=\"uint\" value=\"1\"/>"
                print "      <property name=\"background-rgba\" type=\"array\">"
                print "        <value type=\"double\" value=\"0\"/>"
                print "        <value type=\"double\" value=\"0\"/>"
                print "        <value type=\"double\" value=\"0\"/>"
                print "        <value type=\"double\" value=\"0.35\"/>"
                print "      </property>"
            }
        ' "$PANEL_DEFAULTS" > "$PANEL_DEFAULTS.new" \
            && mv "$PANEL_DEFAULTS.new" "$PANEL_DEFAULTS"
        if grep -q 'name="panel-2"' "$PANEL_DEFAULTS"; then
            warn "The stock bottom panel is still declared; a launcher dock will appear alongside Plank"
        fi
        grep -q 'name="background-rgba"' "$PANEL_DEFAULTS" \
            || warn "Could not make the top bar translucent; it will stay opaque"
    else
        warn "$PANEL_DEFAULTS not found; leaving the XFCE panel layout alone"
    fi

    # Plank is configured by /usr/local/bin/plank-setup, run from
    # xfce-vnc-session: its preferences live in dconf, which needs a session
    # D-Bus, and its launchers live under $HOME, which may be a fresh mount in
    # a deployment. The autostart entry lets xfce4-session own the dock's
    # lifetime so it comes back with the session.
    log "Writing the Plank autostart entry and setup helper"
    cat > /etc/xdg/autostart/plank.desktop <<'PLANKDESKTOP'
[Desktop Entry]
Type=Application
Name=Plank
Comment=Elegant, simple, clean dock
Exec=plank
Icon=plank
Terminal=false
Categories=Utility;
OnlyShowIn=XFCE;
PLANKDESKTOP

    cat > /usr/local/bin/plank-setup <<'PLANKSETUP'
#!/bin/sh
# Configure the Plank dock on the session's X display. Written by install.sh and
# run from xfce-vnc-session once the session D-Bus is up. Best-effort by
# design: a dock that fails to configure must not keep the desktop from
# starting, so every step is allowed to fail quietly.

SCHEMA=net.launchpad.plank.dock.settings
DOCK_PATH=/net/launchpad/plank/docks/dock1/
LAUNCHERS="$HOME/.config/plank/dock1/launchers"

# Launchers. Plank loads every *.dockitem in the launchers folder and only
# falls back to its own default set (browser, mail client, media players) when
# the folder is missing -- so creating it with the applications this desktop
# actually ships keeps the dock useful. Existing files are left untouched so a
# user's own edits survive a restart.
if [ -d "$HOME" ]; then
    mkdir -p "$LAUNCHERS" 2>/dev/null
    for desktop in \
        /usr/share/applications/thunar.desktop \
        /usr/share/applications/xfce4-terminal.desktop \
        /usr/share/applications/google-chrome.desktop \
        /usr/share/applications/com.microsoft.VSCode.desktop \
        /usr/share/applications/code.desktop \
        /usr/local/share/applications/synaptic.desktop; do
        [ -f "$desktop" ] || continue
        item="$LAUNCHERS/$(basename "$desktop" .desktop).dockitem"
        [ -e "$item" ] && continue
        printf '[PlankDockItemPreferences]\nLauncher=file://%s\n' "$desktop" >"$item" 2>/dev/null
    done
fi

# Dock preferences. The dock sits at the bottom, where the second XFCE panel
# used to be (install.sh removes that panel from the panel default). Hiding is
# set to `intelligent` so windows can use the screen edge behind the dock:
# Plank only reserves space for itself in `none` mode
# (DockWindow.vala: `if (prefs.HideMode == HideType.NONE) get_struts()`), so
# every other mode leaves the edge free and slides the dock away when a window
# would overlap it. Idempotent, so it simply reasserts itself each start.
if command -v gsettings >/dev/null 2>&1; then
    gsettings set "$SCHEMA:$DOCK_PATH" theme         'Orchis'       2>/dev/null
    gsettings set "$SCHEMA:$DOCK_PATH" position      'bottom'       2>/dev/null
    gsettings set "$SCHEMA:$DOCK_PATH" alignment     'center'       2>/dev/null
    gsettings set "$SCHEMA:$DOCK_PATH" hide-mode     'intelligent'  2>/dev/null
    gsettings set "$SCHEMA:$DOCK_PATH" icon-size     48             2>/dev/null
    gsettings set "$SCHEMA:$DOCK_PATH" zoom-enabled  true           2>/dev/null
fi

exit 0
PLANKSETUP
    chmod +x /usr/local/bin/plank-setup
fi

# ─────────────────────────────────────────────────────────────────────────────
# 11. X startup script
#
#    start-vnc runs this as an ordinary child process, so this script's own
#    lifetime IS the session's lifetime. It ends by exec'ing the desktop,
#    which keeps the pid that start-vnc tracks alive for as long as XFCE runs.
# ─────────────────────────────────────────────────────────────────────────────
log "Writing XFCE VNC session startup script"
cat > /usr/local/bin/xfce-vnc-session <<'SESSION'
#!/bin/bash
# Runs the desktop inside the X server, as the unprivileged desktop user.
# Launched by start-vnc; Xtigervnc has no -xstartup option.

# A per-uid D-Bus socket dir; $XDG_RUNTIME_DIR is often unset in containers,
# and /run/user/<uid> does not exist because logind is not running. /tmp is
# world-writable, so it is the only dependable place for this.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-$(id -u)}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# The web client reads $HOME/.Xauthority to reach this same X server, and the
# X server wrote it, so both sides are the same user and can read it.
export XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"

# Give the session its own D-Bus. XFCE panels and thunar need one.
if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then
    if DBUS_OUT="$(dbus-launch --sh-syntax 2>&1)" && [ -n "$DBUS_OUT" ]; then
        eval "$DBUS_OUT"
        export DBUS_SESSION_BUS_ADDRESS
    else
        # Not fatal on its own, but thunar and the XFCE panel will misbehave.
        # stderr reaches the pod log, so say so rather than failing silently.
        echo "warning: dbus-launch failed, the session has no D-Bus" >&2
    fi
fi

export XDG_SESSION_TYPE=x11
export XDG_CONFIG_DIRS=/etc/xdg
export XDG_DATA_DIRS=/usr/local/share:/usr/share
export XDG_CURRENT_DESKTOP=XFCE

# XFCE 4.18 only trusts a desktop launcher when GVfs metadata carries the
# checksum of the .desktop file's contents; seed it for everything currently
# on ~/Desktop (see trust-desktop-launchers for why this cannot happen at
# build time). Needs the D-Bus session set up above; failures are logged to
# /tmp/gvfs-trust.log and must never keep the desktop from starting.
/usr/local/bin/trust-desktop-launchers || true

# Configure the Plank dock (launchers and dconf preferences). Requires the
# session D-Bus set up above for the dconf write; see plank-setup for why this
# runs here rather than at build time. Tolerant of failure so a dock that will
# not configure never keeps the desktop from starting, and absent when the
# image was built with INSTALL_THEME=0.
[ -x /usr/local/bin/plank-setup ] && /usr/local/bin/plank-setup || true

# Bridge the X clipboard to the VNC clipboard in both directions.
#   vncconfig  = VNC side  <-> X selections
#   autocutsel = PRIMARY   <-> CLIPBOARD
# Both are daemons, so they are left running on their own.
vncconfig -nowin >/dev/null 2>&1 &
autocutsel -fork -selection CLIPBOARD >/dev/null 2>&1 &

# A bare Super (Windows) key press must open Whisker Menu, but XFCE's
# shortcut engine cannot grab a bare modifier: the key events arrive at X
# (from a physical keyboard or the on-screen sticky Win key alike) and are
# ignored no matter what is bound in xfconf -- verified live, a
# successfully-set /commands/custom/Super_L binding does nothing. xcape is
# the standard bridge: a Super press+release with no other key in between
# becomes Alt+F1, which the stock session binds to the menu popup
# (install.sh rebinds that binding to xfce4-popup-whiskermenu). Held-Super
# combos are unaffected; xcape steps aside whenever a second key is pressed
# first. stderr is kept in a file rather than discarded because this exact
# step failed silently once already; /tmp is per-pod, so the log never grows
# across restarts.
xcape -e 'Super_L=Alt_L|F1;Super_R=Alt_L|F1' >/tmp/xcape.log 2>&1 &

# Become the desktop.
#
# This must block. Backgrounding xfce4-session and letting this script fall off
# the end made the script exit within milliseconds, and since start-vnc treats
# the session pid as fatal, the container tore itself down immediately --
# a crash loop with a perfectly healthy X server.
#
# exec replaces this shell, so the pid start-vnc is watching is the desktop
# itself: when XFCE exits, the container is torn down, and killing it kills the
# session. stdout is discarded because XFCE is extremely chatty; stderr is kept
# so failures stay visible in the pod log.
exec xfce4-session >/dev/null
SESSION
chmod +x /usr/local/bin/xfce-vnc-session

# ─────────────────────────────────────────────────────────────────────────────
# 12. Xtigervnc launcher
#
#    -SecurityTypes None is deliberate: the browser client has no VNC password
#    field and sends an empty credential. If you enable VNC auth you must also
#    change client/js/desktop.js to prompt for one.
#
#    Only options Xtigervnc actually accepts are passed. It has no -xstartup
#    and no -NeverStartErrorDialog; Ubuntu 24.04 does not ship Xvnc either, so
#    the XFCE session is started by this script rather than by the X server.
# ─────────────────────────────────────────────────────────────────────────────
log "Writing Xtigervnc launcher"
cat > /usr/local/bin/start-vnc <<'STARTVNC'
#!/bin/bash
# Start Xtigervnc with the XFCE session on DISPLAY, as an unprivileged user.
set -euo pipefail

DISPLAY_NUM="${VNC_DISPLAY:-:1}"
GEOMETRY="${DISPLAY_GEOMETRY:-1920x1080}"
DEPTH="${VNC_DEPTH:-24}"
RFB_PORT="${VNC_PORT:-5900}"
WS_PORT="${VNC_WS_PORT:-6900}"

# Derive HOME from the passwd entry rather than trusting the environment. This
# keeps working whichever user DESKTOP_USER resolved to, with no matching ENV in
# the Dockerfile to keep in sync.
PW_HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
if [ -n "$PW_HOME" ]; then
    export HOME="$PW_HOME"
fi

# $HOME must be writable: Xtigervnc writes .Xauthority there and the web client
# reads it back. A root-owned home is the usual cause of a black screen.
: "${HOME:?HOME must be set for the desktop user}"
if [ ! -w "$HOME" ]; then
    echo "HOME ($HOME) is not writable by $(id -un)." >&2
    exit 1
fi

# Run as root when we can. Passwordless sudo is configured by install.sh, and
# these two steps genuinely need it: /tmp may arrive as a fresh emptyDir mount
# with nothing in it, and the X lock files can be owned by a different uid from
# a previous container layer. Falls back to doing it unprivileged.
SUDO=""
if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    SUDO="sudo"
fi

# LANG/LC_ALL can be overridden at deployment time to a locale this image does
# not ship (only en_US.UTF-8 is baked in unless EXTRA_LOCALES was set at build
# time). bash then warns "setlocale: LC_ALL: cannot change locale" and GTK
# falls back to the C locale. Generate it on first use instead; it takes a
# couple of seconds and passwordless sudo is available.
SESSION_LOCALE="${LC_ALL:-${LANG:-}}"
if [ -n "$SESSION_LOCALE" ] && [ "$SESSION_LOCALE" != "C" ] && [ "$SESSION_LOCALE" != "POSIX" ]; then
    want="$(printf '%s' "$SESSION_LOCALE" | tr '[:upper:]' '[:lower:]' | sed 's/utf-8/utf8/')"
    if ! locale -a 2>/dev/null | tr '[:upper:]' '[:lower:]' | grep -qx "$want"; then
        echo "Locale $SESSION_LOCALE is not generated; generating it"
        if ! $SUDO locale-gen "$SESSION_LOCALE" >/dev/null 2>&1; then
            echo "warning: could not generate locale $SESSION_LOCALE; the session will use the C locale" >&2
        fi
    fi
fi

# Translation catalogs are baked in at build time by the unminimize step in
# section 2, which reinstalls everything the minimized base image's dpkg
# path-excludes dropped. Nothing to fix up at startup.

# X11 socket dir. Created at build time with the sticky bit; recreate it here
# in case /tmp was mounted fresh.
if [ ! -d /tmp/.X11-unix ]; then
    $SUDO mkdir -p /tmp/.X11-unix 2>/dev/null || mkdir -p /tmp/.X11-unix 2>/dev/null || true
fi
$SUDO chmod 1777 /tmp/.X11-unix 2>/dev/null || chmod 1777 /tmp/.X11-unix 2>/dev/null || true

# Clear stale locks from an unclean shutdown. Failure is not fatal: if a lock is
# owned by another uid and sudo is unavailable, X reports it and exits, which is
# a clearer failure than starting on a display someone else holds.
$SUDO rm -f "/tmp/.X${DISPLAY_NUM#:}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM#:}" 2>/dev/null \
    || rm -f "/tmp/.X${DISPLAY_NUM#:}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM#:}" 2>/dev/null || true

export DISPLAY="$DISPLAY_NUM"
export HOME
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-$(id -u)}"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"

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
    -AcceptCutText &

VNC_PID=$!

# Wait for the X server to accept connections before declaring success
READY=false
for _ in $(seq 1 30); do
    if xdpyinfo -display "$DISPLAY_NUM" >/dev/null 2>&1; then
        READY=true
        break
    fi
    if ! kill -0 "$VNC_PID" 2>/dev/null; then
        echo "Xtigervnc died during startup" >&2
        exit 1
    fi
    sleep 0.5
done
if [ "$READY" != true ]; then
    echo "X server did not become ready on $DISPLAY_NUM in time" >&2
    exit 1
fi
echo "X server ready on $DISPLAY_NUM (${GEOMETRY}, RFB :${RFB_PORT})"

# Xtigervnc has no -xstartup option -- passing it fails with "Unrecognized
# option" and the server never starts. Ubuntu 24.04 ships no Xvnc either, only
# Xtigervnc, so the session is started here as an ordinary child process.
# It is included in the wait below, so a crashed desktop restarts the pod
# instead of leaving a black screen served over WebSocket.
/usr/local/bin/xfce-vnc-session &
SESSION_PID=$!

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

# Exit if any of the three dies so the container restarts rather than serving
# nothing. A dead desktop session is included deliberately: websockify would
# still answer, so the container would look healthy while showing a grey screen.
wait -n "$VNC_PID" "$WS_PID" "$SESSION_PID"
echo "A desktop component exited; shutting down."
kill "$VNC_PID" "$WS_PID" "$SESSION_PID" 2>/dev/null || true
STARTVNC
chmod +x /usr/local/bin/start-vnc

# ─────────────────────────────────────────────────────────────────────────────
# 13. Wrap Xtigervnc's own launcher so `startvnc` behaves predictably
# ─────────────────────────────────────────────────────────────────────────────
ln -sf /usr/local/bin/start-vnc /usr/local/bin/start-desktop

# ─────────────────────────────────────────────────────────────────────────────
# 14. Cleanup
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
$(if [ -x /usr/local/bin/plank-setup ]; then echo "    /usr/local/bin/plank-setup      Plank dock launchers + preferences"; fi)

  Defaults:
    display   ${VNC_DISPLAY}  ${VNC_GEOMETRY} depth ${VNC_DEPTH}
    RFB       :${VNC_PORT}  (loopback only)
    websocket :${VNC_WS_PORT}  (bound to 0.0.0.0)

  Installed runtimes:
$(if [ "${INSTALL_NODE:-1}" = "1" ]; then echo "    node       $(node --version), npm $(npm --version)"; fi)

  Desktop apps:
$(if have_app google-chrome; then echo "    chrome     $(google-chrome --version)"; fi)
$(if have_app firefox;     then echo "    firefox    $(firefox --version)"; fi)
$(if have_app code;        then echo "    code       $(code --version | head -1)"; fi)

  Desktop theme:
$(if [ -d "/usr/share/themes/${ORCHIS_THEME:-Orchis-Dark}" ]; then echo "    ${ORCHIS_THEME:-Orchis-Dark}, Papirus-Dark icons, Plank dock"; else echo "    (INSTALL_THEME=0; stock theme)"; fi)

  CMD ["start-vnc"]

  Next: add the web client as a second container in the same pod, or run it
  as its own deployment pointed at the websockify port above.

SUMMARY