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
    xfce4-terminal \
    thunar \
    mousepad \
    xfce4-notifyd \
    xfce4-screenshooter \
    xcape \
    adwaita-icon-theme \
    xfce4-whiskermenu-plugin \
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

# Whisker is a panel plugin: no binary lands on $PATH, so check for the
# loadable module instead (the path carries the multiarch triplet).
ls /usr/lib/*/xfce4/panel/plugins/libwhiskermenu.so >/dev/null 2>&1 \
    || die "whiskermenu panel plugin missing after install. It should come from 'xfce4-whiskermenu-plugin'."
log "XFCE verified"

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
# 8. Look and feel: Orchis theme + a Windows-style bottom taskbar
#
#    The stock XFCE look is functional but spartan. Two things change it:
#
#    - The Orchis GTK theme (github.com/vinceliuice/orchis-theme), compiled
#      with the "compact" tweak and the compact size variant, so controls are
#      dense and Windows-like. Runs `sassc` at build time; the theme lands in
#      /usr/share/themes/Orchis-Compact{,-Light,-Dark}. Skipped when the
#      theme is already present, because Dockerfile.full re-runs this script
#      on top of the desktop image and the compile is the expensive step.
#    - System-wide xfconf defaults that move the panel to the bottom edge and
#      swap the Applications menu for Whisker Menu, whose search field and
#      favorites read like the Windows start menu. xfconfd takes these files
#      as a channel's defaults for any user without their own override, so a
#      fresh home picks the layout up with no per-user setup.
# ─────────────────────────────────────────────────────────────────────────────
THEME_NAME="Orchis-Compact"

if [ ! -d "/usr/share/themes/${THEME_NAME}" ]; then
    log "Installing Orchis theme (compact, with the compact tweak)"
    # sassc compiles the SCSS sources; murrine is the GTK2 engine Synaptic
    # needs to follow the theme; gnome-themes-extra pulls Adwaita's GTK2 bits.
    apt-get install -y -qq --no-install-recommends \
        sassc gtk2-engines-murrine gnome-themes-extra git
    git clone --depth=1 https://github.com/vinceliuice/orchis-theme.git /tmp/orchis-theme
    # -s compact selects the compact size variant (controls rendered smaller);
    # --tweaks compact selects the compact/no-floating-panel tweak. Standard,
    # light and dark color variants are all installed; the accent is the
    # default blue.
    (cd /tmp/orchis-theme && ./install.sh -s compact --tweaks compact) \
        || die "Orchis theme installation failed"
    # Orchis ships a matching wallpaper; bake one in for the default backdrop.
    mkdir -p /usr/share/backgrounds
    install -m 0644 /tmp/orchis-theme/wallpaper/1080p.jpg \
        /usr/share/backgrounds/orchis-1080p.jpg
    rm -rf /tmp/orchis-theme
else
    log "Orchis theme already installed; skipping the build"
fi
[ -d "/usr/share/themes/${THEME_NAME}" ] || die "${THEME_NAME} theme not found after install"
[ -f /usr/share/backgrounds/orchis-1080p.jpg ] || warn "Orchis wallpaper missing; the default backdrop will be empty"
log "Orchis theme verified (${THEME_NAME})"

XDG_CONF_DIR=/etc/xdg/xfce4
XCONF_DIR="${XDG_CONF_DIR}/xfconf/xfce-perchannel-xml"
mkdir -p "$XCONF_DIR"

# Panel: one full-width bar snapped to the bottom edge, Windows-taskbar style.
# The position string is "p=<snap>;x=<x>;y=<y>" (xfce4-panel >= 4.16): snap 12
# is SNAP_POSITION_S, the bottom edge. Plugins left to right: Whisker start
# menu, a gap, the window buttons, a stretching gap, tray, clock and a
# show-desktop sliver on the far right.
log "Writing the bottom taskbar panel defaults"
cat > "${XCONF_DIR}/xfce4-panel.xml" <<PANEL
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-panel" version="1.0">
  <property name="configver" type="int" value="2"/>
  <property name="panels" type="uint" value="1"/>
  <property name="panel-1" type="empty">
    <property name="mode" type="uint" value="0"/>
    <property name="position" type="string" value="p=12;x=0;y=0"/>
    <property name="size" type="uint" value="40"/>
    <property name="length" type="double" value="100.0"/>
    <property name="autohide-behavior" type="uint" value="0"/>
    <property name="enable-struts" type="bool" value="true"/>
    <property name="plugin-ids" type="array">
      <value type="int" value="1"/>
      <value type="int" value="2"/>
      <value type="int" value="3"/>
      <value type="int" value="4"/>
      <value type="int" value="5"/>
      <value type="int" value="6"/>
      <value type="int" value="7"/>
    </property>
  </property>
  <property name="plugin-1" type="string" value="whiskermenu">
    <!-- Whisker >= 2.8 keeps its settings in the panel's xfconf channel,
         under this plugin's property base, so the button icon rides along
         here. A grid icon reads as the Windows start button. -->
    <property name="button-icon" type="string" value="view-grid"/>
  </property>
  <property name="plugin-2" type="string" value="separator">
    <property name="style" type="uint" value="0"/>
    <property name="expand" type="bool" value="false"/>
  </property>
  <property name="plugin-3" type="string" value="tasklist">
    <!-- One button per window, like Windows: no grouping, flat buttons with
         labels, and windows from every workspace listed so a workspace switch
         can never orphan the taskbar. -->
    <property name="grouping" type="bool" value="false"/>
    <property name="flat-buttons" type="bool" value="true"/>
    <property name="show-labels" type="bool" value="true"/>
    <property name="include-all-workspaces" type="bool" value="true"/>
  </property>
  <property name="plugin-4" type="string" value="separator">
    <property name="style" type="uint" value="0"/>
    <property name="expand" type="bool" value="true"/>
  </property>
  <property name="plugin-5" type="string" value="systray"/>
  <property name="plugin-6" type="string" value="clock">
    <!-- 2 = CLOCK_PLUGIN_MODE_DIGITAL: time and date, like Windows. -->
    <property name="mode" type="uint" value="2"/>
  </property>
  <property name="plugin-7" type="string" value="showdesktop"/>
</channel>
PANEL

# Application theme. The stock xsettings defaults are kept and only the theme
# entries change; xfsettingsd falls back to its built-in defaults for anything
# missing, but keeping the file complete costs nothing and is easier to diff
# against upstream.
log "Writing the Orchis theme defaults"
cat > "${XCONF_DIR}/xsettings.xml" <<XSETTINGS
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xsettings" version="1.0">
  <property name="Net" type="empty">
    <property name="ThemeName" type="string" value="${THEME_NAME}"/>
    <property name="IconThemeName" type="string" value="Adwaita"/>
    <property name="DoubleClickTime" type="int" value="400"/>
    <property name="DoubleClickDistance" type="int" value="5"/>
    <property name="DndDragThreshold" type="int" value="8"/>
    <property name="CursorBlink" type="bool" value="true"/>
    <property name="CursorBlinkTime" type="int" value="1200"/>
    <property name="SoundThemeName" type="string" value="default"/>
    <property name="EnableEventSounds" type="bool" value="false"/>
    <property name="EnableInputFeedbackSounds" type="bool" value="false"/>
  </property>
  <property name="Xft" type="empty">
    <property name="DPI" type="empty"/>
    <property name="Antialias" type="int" value="-1"/>
    <property name="Hinting" type="int" value="-1"/>
    <property name="HintStyle" type="string" value="hintslight"/>
    <property name="RGBA" type="string" value="rgb"/>
  </property>
  <property name="Gtk" type="empty">
    <property name="CanChangeAccels" type="bool" value="false"/>
    <property name="ColorPalette" type="string" value="black:white:gray50:red:purple:blue:light blue:green:yellow:orange:lavender:brown:goldenrod4:dodger blue:pink:light green:gray10:gray30:gray75:gray90"/>
    <property name="FontName" type="string" value="Sans 10"/>
    <property name="MonospaceFontName" type="string" value="Monospace 10"/>
    <property name="IconSizes" type="string" value=""/>
    <property name="KeyThemeName" type="string" value=""/>
    <property name="ToolbarStyle" type="string" value="icons"/>
    <property name="ToolbarIconSize" type="int" value="3"/>
    <property name="MenuImages" type="bool" value="true"/>
    <property name="ButtonImages" type="bool" value="true"/>
    <property name="MenuBarAccel" type="string" value="F10"/>
    <property name="CursorThemeName" type="string" value="Adwaita"/>
    <property name="CursorThemeSize" type="int" value="0"/>
    <property name="DecorationLayout" type="string" value=":minimize,maximize,close"/>
    <property name="DialogsUseHeader" type="bool" value="false"/>
    <property name="TitlebarMiddleClick" type="string" value="lower"/>
  </property>
  <property name="Gdk" type="empty">
    <property name="WindowScalingFactor" type="int" value="1"/>
  </property>
</channel>
XSETTINGS

# Window decorations. Orchis ships a matching xfwm4 theme inside its theme
# directory, so the titlebars follow the widgets.
cat > "${XCONF_DIR}/xfwm4.xml" <<XFWM
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfwm4" version="1.0">
  <property name="general" type="empty">
    <property name="theme" type="string" value="${THEME_NAME}"/>
    <property name="button_layout" type="string" value="O|HMC"/>
  </property>
</channel>
XFWM

# Wallpaper. TigerVNC names its RandR output VNC-0 (older trees say Virtual-0);
# per-monitor entries for names that never exist are simply unused, so write
# the candidates rather than guessing one. Zoomed (5) fills the screen without
# distorting the image.
log "Writing the wallpaper defaults"
cat > "${XCONF_DIR}/xfce4-desktop.xml" <<DESKTOP
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-desktop" version="1.0">
  <property name="backdrop" type="empty">
    <property name="screen0" type="empty">
      <property name="monitorVNC-0" type="empty">
        <property name="workspace0" type="empty">
          <property name="last-image" type="string" value="/usr/share/backgrounds/orchis-1080p.jpg"/>
          <property name="image-style" type="uint" value="5"/>
        </property>
      </property>
      <property name="monitorVirtual-0" type="empty">
        <property name="workspace0" type="empty">
          <property name="last-image" type="string" value="/usr/share/backgrounds/orchis-1080p.jpg"/>
          <property name="image-style" type="uint" value="5"/>
        </property>
      </property>
    </property>
  </property>
</channel>
DESKTOP

# The bare-Super bridge in xfce-vnc-session turns Super into Alt+F1, and the
# stock default binds Alt+F1 to the Applications menu popup -- which the panel
# above no longer contains. Repoint the stock default at Whisker so the
# Windows-key behavior survives the menu swap.
KBD_DEFAULTS="${XCONF_DIR}/xfce4-keyboard-shortcuts.xml"
if [ -f "$KBD_DEFAULTS" ] && grep -q 'xfce4-popup-applicationsmenu' "$KBD_DEFAULTS"; then
    log "Rebinding Alt+F1 to the Whisker menu"
    sed -i 's/value="xfce4-popup-applicationsmenu"/value="xfce4-popup-whiskermenu"/' "$KBD_DEFAULTS"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 9. Desktop applications
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
# section 10 instead: DISPLAY survives sudo's env_reset, and XAUTHORITY is
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
# 10. Unprivileged runtime user
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
# 0755 mode marks them executable, which XFCE's desktop icons require before
# they launch without an "untrusted application" prompt.
log "Adding desktop shortcuts (Chrome, VS Code, Synaptic)"
for shortcut_src in \
    /usr/share/applications/google-chrome.desktop \
    /usr/share/applications/code.desktop \
    /usr/local/share/applications/synaptic.desktop; do
    if [ -f "$shortcut_src" ]; then
        install -m 0755 "$shortcut_src" "$DESKTOP_HOME/Desktop/$(basename "$shortcut_src")"
    else
        warn "Desktop shortcut source $shortcut_src not found; skipping"
    fi
done

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

# Bridge the X clipboard to the VNC clipboard in both directions.
#   vncconfig  = VNC side  <-> X selections
#   autocutsel = PRIMARY   <-> CLIPBOARD
# Both are daemons, so they are left running on their own.
vncconfig -nowin >/dev/null 2>&1 &
autocutsel -fork -selection CLIPBOARD >/dev/null 2>&1 &

# A bare Super (Windows) key press must open the Whisker start menu, but
# XFCE's shortcut engine cannot grab a bare modifier: the key events arrive
# at X (from a physical keyboard or the on-screen sticky Win key alike) and
# are ignored no matter what is bound in xfconf -- verified live, a
# successfully-set /commands/custom/Super_L binding does nothing. xcape is
# the standard bridge: a Super press+release with no other key in between
# becomes Alt+F1, which the session keyboard defaults bind to
# xfce4-popup-whiskermenu (repointed from the Applications menu popup by the
# look-and-feel section above). Held-Super combos are unaffected; xcape
# steps aside whenever a second key is pressed first. stderr is kept in a
# file rather than discarded because this exact step failed silently once
# already; /tmp is per-pod, so the log never grows across restarts.
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

  CMD ["start-vnc"]

  Next: add the web client as a second container in the same pod, or run it
  as its own deployment pointed at the websockify port above.

SUMMARY