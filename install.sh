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
#    INSTALL_THEME=0      keep the stock XFCE look (no Orchis, no Tela icons);
#                         see section 8
#    ORCHIS_THEME         Orchis variant to apply (default: Orchis-Dark-Compact)
#    ORCHIS_ICONS         icon theme to apply (default: Tela-circle-dark)
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
check_bin xfce4-session-logout xfce4-session
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

# Bind a chord the web client presses over VNC to end the session.
#
# When the web client shares a container with the desktop it restarts the pod
# by exiting. When the desktop runs in a container of its own, though, the
# client has no way to signal it and no cluster API access to restart the pod,
# so the VNC session is the only channel that reaches it: the chord logs the
# session out, start-vnc's watcher sees the session exit, and Kubernetes
# restarts the desktop container. The stock <Primary><Alt>Delete binding opens
# the confirmation dialog, which cannot be answered blind, so use --logout.
#
# Chord names are stored XML-escaped (&lt; / &gt;), and the insertion is
# guarded so re-running the script cannot add it twice.
grep -q 'xfce4-session-logout --logout' "$KBD_DEFAULTS" || \
    sed -i '\|value="xfce4-session-logout"/>|a\      <property name="&lt;Primary&gt;&lt;Alt&gt;&lt;Shift&gt;r" type="string" value="xfce4-session-logout --logout"/>' "$KBD_DEFAULTS"
grep -q 'xfce4-session-logout --logout' "$KBD_DEFAULTS" \
    || warn "Could not add the Restart Desktop shortcut; a desktop in a separate container cannot be restarted from the dock"

# Give the Whisker Menu button the standard XFCE "Applications" look: the
# plain-text label next to the icon, and the Ubuntu roundel in place of the
# generic plugin glyph. The plugin reads these keys from defaults.rc in
# XDG_CONFIG_DIRS for a panel instance that has none of its own xfconf values
# yet (plugin's Settings::load with is_default=true), so a fresh session
# starts this way while everything stays user-configurable through the plugin
# dialog. The icon name resolves through the Tela-circle icon theme installed
# below (distributor-logo-ubuntu.svg), with a graceful fall back to the
# generic glyph if that theme ever goes away. Appended, not replaced: the
# file is a package conffile and upstream keeps other defaults in it (the
# switch-user command, for one). The directory is created defensively so a
# future package that ships no defaults.rc still gets these keys. Written
# outside the INSTALL_THEME split below so both the themed and the stock
# builds get the same button.
log "Configuring the Whisker Menu button (Applications label, Ubuntu icon)"
WHISKER_DEFAULTS=/etc/xdg/xfce4/whiskermenu/defaults.rc
install -d "$(dirname "$WHISKER_DEFAULTS")"
touch "$WHISKER_DEFAULTS"
grep -q '^show-button-title=' "$WHISKER_DEFAULTS" \
    || printf 'show-button-title=true\n' >> "$WHISKER_DEFAULTS"
grep -q '^button-title=' "$WHISKER_DEFAULTS" \
    || printf 'button-title=Applications\n' >> "$WHISKER_DEFAULTS"
grep -q '^button-icon=' "$WHISKER_DEFAULTS" \
    || printf 'button-icon=distributor-logo-ubuntu\n' >> "$WHISKER_DEFAULTS"

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
# 8. Look and feel: the Orchis theme with the compact tweaks
#
#    The stock XFCE desktop is functional but spartan (Greybird widgets, flat
#    grey panel, square window corners). This section gives it the Orchis
#    theme (github.com/vinceliuice/orchis-theme) in its *compact* flavour,
#    matched icons, wallpaper and a docked panel. The dock itself is the web
#    client's: a bottom-edge app dock rendered by the browser (it lists
#    pinned and running applications and replaced the Plank dock earlier
#    revisions of this image shipped).
#
#    "Compact tweaks" means two independent upstream options, and both are
#    needed -- neither implies the other:
#
#      -s compact        the compact *size* variant: this is the one that
#                        actually densifies the desktop. It shrinks widget
#                        padding, margins, font sizes and corner radii (see
#                        src/_sass/_variables.scss: $space-size, $medium-size,
#                        $root-font-size all key off $compact). It produces the
#                        Orchis-*-Compact theme directories used below.
#      --tweaks compact  the compact *panel* tweak ($panel_style). Upstream
#                        this only affects the GNOME Shell/Budgie panel and the
#                        .xfce4-panel CSS is unaffected, so it is passed for
#                        completeness rather than for the XFCE look.
#
#    Building from the pinned upstream source (not the prebuilt release
#    tarball) is deliberate: the release tarballs are generated with plain
#    `./install.sh -t all`, i.e. WITHOUT --tweaks compact, so the tarball's
#    Orchis-Compact directories are the size variant only and cannot carry the
#    tweak. Compiling gives both from one source and pins the result by commit.
#
#    Everything is applied through /etc/xdg, never the runtime user's $HOME:
#    xfconfd treats a channel XML file found in XDG_CONFIG_DIRS as that
#    channel's *defaults* for any user with no override of their own, and a
#    container session is always a fresh home. So a stock container picks the
#    whole look up with no per-user setup. Set INSTALL_THEME=0 to skip the lot
#    and keep a plain desktop.
# ─────────────────────────────────────────────────────────────────────────────
if [ "${INSTALL_THEME:-1}" = "1" ]; then
    # Pinned upstream revision (tag 2026-07-07). Bump by rewriting the SHA;
    # a branch name here would make image contents unreproducible.
    ORCHIS_COMMIT="29975e38624ec93d8e460f8ea17129bcb68c05ef"
    ORCHIS_THEME="${ORCHIS_THEME:-Orchis-Dark-Compact}"
    ORCHIS_ICONS="${ORCHIS_ICONS:-Tela-circle-dark}"
    XDG_CONF_DIR=/etc/xdg/xfce4
    XCONF_DIR="${XDG_CONF_DIR}/xfconf/xfce-perchannel-xml"

    # sassc compiles the SCSS; murrine and gnome-themes-extra provide the GTK2
    # engines the GTK2 themes (and therefore Synaptic) need; xz-utils unpacks
    # the source tarball; gtk-update-icon-cache is what Tela's install.sh
    # invokes; dconf-gsettings-backend + libglib2.0-bin provide the GSettings
    # storage GTK applications use for their own settings.
    log "Installing theme packages (Orchis build deps, Tela icons)"
    apt-get install -y -qq --no-install-recommends \
        sassc gtk2-engines-murrine gnome-themes-extra \
        xz-utils gtk-update-icon-cache \
        dconf-gsettings-backend libglib2.0-bin

    # ── Orchis, built from source with both compact options ────────────────
    #
    # Guarded so Dockerfile.full, which re-runs this script over a base that
    # already carries the theme, does not recompile it (the compile is the
    # expensive step). The guard names the specific variant because that is
    # what the desktop actually loads.
    if [ -d "/usr/share/themes/${ORCHIS_THEME}" ]; then
        log "Orchis theme already installed; skipping the build"
    else
        log "Building the Orchis theme (commit ${ORCHIS_COMMIT:0:7}, compact)"
        ORCHIS_SRC=/tmp/orchis-theme
        rm -rf "$ORCHIS_SRC"
        mkdir -p "$ORCHIS_SRC"
        # The codeload tarball for a commit, not `git clone`: no git needed in
        # the image and no tag that could move under the build.
        curl -fsSL "https://codeload.github.com/vinceliuice/orchis-theme/tar.gz/${ORCHIS_COMMIT}" \
            -o /tmp/orchis-theme.tar.gz \
            || die "Could not download the Orchis theme source"
        tar -xzf /tmp/orchis-theme.tar.gz -C "$ORCHIS_SRC" --strip-components=1 \
            || die "Could not unpack the Orchis theme source"
        rm -f /tmp/orchis-theme.tar.gz
        # -s compact   select the compact size variant
        # --tweaks compact  select the compact panel tweak
        # Destination left to upstream's default (/usr/share/themes, because
        # this runs as root), but it is passed explicitly so the flag is
        # readable here rather than implied by the uid.
        #
        # Upstream's installer prints an advisory -- "For the rounded float
        # whiskermenu, you need set your whiskermenu background opacity to 0 !"
        # -- and, at build time, tries to apply it to a per-user rc file that
        # does not exist yet, so it cannot. We set the same thing system-wide
        # further down (whiskermenu/defaults.rc), which is where a fresh
        # session looks for it, so the banner is dropped from the build log
        # rather than left telling the builder to do a step that is already
        # handled. The build's own output is otherwise kept, and a failure
        # still dumps the whole log.
        ORCHIS_BUILD_LOG=/tmp/orchis-build.log
        if ! ( cd "$ORCHIS_SRC" && ./install.sh -d /usr/share/themes -s compact --tweaks compact ) \
                >"$ORCHIS_BUILD_LOG" 2>&1; then
            cat "$ORCHIS_BUILD_LOG" >&2
            rm -f "$ORCHIS_BUILD_LOG"
            die "Orchis theme installation failed"
        fi
        grep -v "rounded float whiskermenu" "$ORCHIS_BUILD_LOG" || true
        rm -f "$ORCHIS_BUILD_LOG"
        # Orchis ships a matching wallpaper with the theme. Bake it in now,
        # while the source tree is still around (the backdrop defaults below
        # reference it).
        mkdir -p /usr/share/backgrounds
        install -m 0644 "$ORCHIS_SRC/wallpaper/1080p.jpg" \
            /usr/share/backgrounds/orchis-1080p.jpg 2>/dev/null \
            || warn "Orchis wallpaper missing from the source tree"
        # The source tree carries SCSS, docs and the ci/ helper scripts this
        # image has no use for. The compiled themes are already in
        # /usr/share/themes; drop the rest so it never reaches a layer.
        rm -rf "$ORCHIS_SRC"
    fi
    [ -d "/usr/share/themes/${ORCHIS_THEME}" ] \
        || die "${ORCHIS_THEME} not found in /usr/share/themes after the build"
    [ -f /usr/share/backgrounds/orchis-1080p.jpg ] \
        || warn "Orchis wallpaper missing; the default backdrop will be empty"

    # ── Tela-circle: the icon theme Orchis' own index.theme references ─────
    #
    # (GtkTheme above, IconTheme=Tela-circle-dark.) Installing it means app
    # and file icons actually match the widgets instead of staying on XFCE's
    # stock elementary set. Tela ships pre-built SVG sources: its install.sh
    # only copies files and recolours them with sed, so there is nothing to
    # compile, but it does call gtk-update-icon-cache (installed above).
    if [ -d "/usr/share/icons/Tela-circle" ]; then
        log "Tela-circle icons already installed; skipping"
    else
        log "Installing the Tela-circle icon theme"
        TELA_SRC=/tmp/tela-circle
        rm -rf "$TELA_SRC"
        mkdir -p "$TELA_SRC"
        # Pinned to the same date-based tag as the Orchis pin above.
        curl -fsSL "https://codeload.github.com/vinceliuice/Tela-circle-icon-theme/tar.gz/c0adf1ab92f564e3b83540441921f26d121b09c3" \
            -o /tmp/tela-circle.tar.gz \
            || die "Could not download the Tela-circle source"
        tar -xzf /tmp/tela-circle.tar.gz -C "$TELA_SRC" --strip-components=1 \
            || die "Could not unpack the Tela-circle source"
        rm -f /tmp/tela-circle.tar.gz
        # Default colour set: installs Tela-circle plus the -dark/-light pair.
        # Only the standard colour is requested, so this is ~13 MB rather than
        # the ~350 MB an `-a` (all colours) install would cost.
        ( cd "$TELA_SRC" && ./install.sh -d /usr/share/icons ) \
            || die "Tela-circle icon installation failed"
        rm -rf "$TELA_SRC"
    fi
    [ -d "/usr/share/icons/${ORCHIS_ICONS}" ] \
        || die "${ORCHIS_ICONS} not found in /usr/share/icons after install"

    # ── Apply the theme through /etc/xdg channel defaults ──────────────────
    #
    # xfsettingsd reads the xsettings channel; its packaged defaults live in
    # xfce4-settings' own XML. Rather than editing that file in place (which
    # would break whenever the package reshuffles it), write our own channel
    # document here. xfconfd picks it up from XDG_CONFIG_DIRS as the channel's
    # default, and the session exports XDG_CONFIG_DIRS=/etc/xdg. Only the two
    # theme entries are set: everything else falls back to xfsettingsd's
    # built-in defaults, so a future XFCE release can add keys without this
    # file silently pinning them to a stale value.
    log "Selecting ${ORCHIS_THEME} and ${ORCHIS_ICONS} as the session defaults"
    mkdir -p "$XCONF_DIR"
    cat > "${XCONF_DIR}/xsettings.xml" <<XSETTINGS
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xsettings" version="1.0">
  <property name="Net" type="empty">
    <property name="ThemeName" type="string" value="${ORCHIS_THEME}"/>
    <property name="IconThemeName" type="string" value="${ORCHIS_ICONS}"/>
  </property>
</channel>
XSETTINGS

    # Window decorations come from their own channel. xfwm4 reads a matching
    # xfwm4 theme out of the Orchis theme directory, and compositing is
    # switched on explicitly: the panel's translucency is alpha, and without
    # a compositor it renders as an opaque black block.
    #
    # show_dock_shadow is turned off. xfwm4 draws a drop shadow around every
    # dock window by default, and the docked XFCE panel is one: with the
    # shadow on, the edge-to-edge top bar carries a band of shadow down its
    # whole width that reads as a translucent panel that is not there.
    cat > "${XCONF_DIR}/xfwm4.xml" <<XFWM
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfwm4" version="1.0">
  <property name="general" type="empty">
    <property name="theme" type="string" value="${ORCHIS_THEME}"/>
    <property name="use_compositing" type="bool" value="true"/>
    <property name="show_dock_shadow" type="bool" value="false"/>
  </property>
</channel>
XFWM

    # Wallpaper. TigerVNC names its RandR output VNC-0 (older versions say
    # Virtual-0), and a per-monitor entry for a monitor that never appears is
    # simply unused, so both are written rather than guessing. image-style 5
    # is zoomed: fills the screen without distorting the image.
    log "Writing the Orchis wallpaper default"
    cat > "${XCONF_DIR}/xfce4-desktop.xml" <<DESKTOP
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-desktop" version="1.0">
  <property name="backdrop" type="empty">
    <property name="screen0" type="empty">
      <property name="monitorVNC-0" type="empty">
        <property name="workspace0" type="empty">
          <property name="last-image" type="string" value="/usr/share/backgrounds/orchis-1080p.jpg"/>
          <property name="image-style" type="int" value="5"/>
        </property>
      </property>
      <property name="monitorVirtual-0" type="empty">
        <property name="workspace0" type="empty">
          <property name="last-image" type="string" value="/usr/share/backgrounds/orchis-1080p.jpg"/>
          <property name="image-style" type="int" value="5"/>
        </property>
      </property>
    </property>
  </property>
</channel>
DESKTOP

    # ── Panel: one docked, edge-to-edge top bar ────────────────────────────
    #
    # XFCE ships two panels by default: the top bar (menu, task list, tray,
    # clock, actions) and a 48px bottom bar holding launchers -- the panel
    # XFCE presents as its "dock". The bottom bar is dropped here because
    # the dock is the web client's: the browser renders a bottom-edge app
    # dock over the stream, so a panel of launchers at the bottom of the
    # remote desktop would only duplicate it.
    #
    # The top bar stays docked: position p=6 (SNAP_POSITION_NW) with length
    # 100 pins it to the top-left and edge to edge. That is the geometry
    # XFCE's own panel template uses, and it is what upstream's
    # `--tweaks compact` expects -- that tweak is documented as the
    # "no floating panel variant". An earlier revision floated this bar
    # (p=0 with a centre point, 98% length) and rounded its corners, which
    # read as a floating pill with gaps at the top and sides rather than as
    # a panel. Floating and rounding are therefore deliberately absent here,
    # and the CSS step below does not add a corner radius either.
    #
    # dark-mode is turned off: it pins the panel to a fixed dark palette
    # regardless of the GTK theme, which would hide the theme the panel is
    # meant to follow.
    #
    # The plugin list is deliberately XFCE's own default minus the drop, so
    # nothing changes functionally; a plugin this image lacks is dropped by
    # the panel itself at startup with a log line, never a failure.
    log "Writing the panel defaults (docked, edge to edge)"
    cat > "${XCONF_DIR}/xfce4-panel.xml" <<PANEL
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-panel" version="1.0">
  <property name="configver" type="int" value="2"/>
  <property name="panels" type="array">
    <value type="int" value="1"/>
    <property name="dark-mode" type="bool" value="false"/>
    <property name="panel-1" type="empty">
      <property name="position" type="string" value="p=6;x=0;y=0"/>
      <property name="length" type="uint" value="100"/>
      <property name="position-locked" type="bool" value="true"/>
      <property name="icon-size" type="uint" value="16"/>
      <property name="size" type="uint" value="26"/>
      <property name="plugin-ids" type="array">
        <value type="int" value="1"/>
        <value type="int" value="2"/>
        <value type="int" value="3"/>
        <value type="int" value="4"/>
        <value type="int" value="5"/>
        <value type="int" value="6"/>
        <value type="int" value="8"/>
        <value type="int" value="9"/>
        <value type="int" value="10"/>
        <value type="int" value="11"/>
        <value type="int" value="12"/>
        <value type="int" value="13"/>
        <value type="int" value="14"/>
      </property>
    </property>
  </property>
  <property name="plugins" type="empty">
    <property name="plugin-1" type="string" value="whiskermenu"/>
    <property name="plugin-2" type="string" value="tasklist">
      <property name="grouping" type="uint" value="1"/>
    </property>
    <property name="plugin-3" type="string" value="separator">
      <property name="expand" type="bool" value="true"/>
      <property name="style" type="uint" value="0"/>
    </property>
    <property name="plugin-4" type="string" value="pager"/>
    <property name="plugin-5" type="string" value="separator">
      <property name="style" type="uint" value="0"/>
    </property>
    <property name="plugin-6" type="string" value="systray">
      <property name="square-icons" type="bool" value="true"/>
    </property>
    <property name="plugin-8" type="string" value="pulseaudio">
      <property name="enable-keyboard-shortcuts" type="bool" value="true"/>
      <property name="show-notifications" type="bool" value="true"/>
    </property>
    <property name="plugin-9" type="string" value="power-manager-plugin"/>
    <property name="plugin-10" type="string" value="notification-plugin"/>
    <property name="plugin-11" type="string" value="separator">
      <property name="style" type="uint" value="0"/>
    </property>
    <property name="plugin-12" type="string" value="clock"/>
    <property name="plugin-13" type="string" value="separator">
      <property name="style" type="uint" value="0"/>
    </property>
    <property name="plugin-14" type="string" value="actions"/>
  </property>
</channel>
PANEL

    # Whisker Menu draws its own background: at menu-opacity 100 it paints an
    # opaque rectangle over the theme's rounded popup, squaring it off. The
    # plugin reads this key from defaults.rc in XDG_CONFIG_DIRS for a panel
    # instance that has none of its own. The file itself (and the button
    # defaults) are created above, outside the themed/stock split, so this
    # only appends the theme-motivated key.
    grep -q '^menu-opacity=' "$WHISKER_DEFAULTS" \
        || printf 'menu-opacity=0\n' >> "$WHISKER_DEFAULTS"

    # ── The dock is the web client's ───────────────────────────────────────
    #
    # Nothing is installed here on purpose. Earlier revisions of this image
    # shipped the Plank dock on the bottom edge; application launching now
    # lives in the web client's own app dock (client/js/appdock.js), which
    # renders pinned and running applications at the bottom of the browser
    # page and drives them over the desktop API. Keeping the bottom edge
    # clear of a remote dock leaves the streamed desktop unobstructed.

    log "Look and feel applied: ${ORCHIS_THEME} (compact), ${ORCHIS_ICONS}, docked panel"
else
    log "INSTALL_THEME=0: keeping the stock XFCE look"
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

# ── Default terminal working directory ─────────────────────────────────────
#
# A terminal must open in the user's home. Two things decide that directory
# and neither defaults to the home: the web client's app dock spawns from the
# server process, whose cwd is the image's WORKDIR (/app), and a session under
# a persistent root starts after pivot-root cd's to /. Bake xfce4-terminal's
# "default working directory" preference into the system-wide xfconf channel,
# exactly as the theme above is baked into /etc/xdg: xfconfd treats that file
# as the desktop user's default, so no per-user copy has to be created or kept
# in sync, and the terminal uses it whenever it is not given a directory of its
# own. A per-user override still wins, so the preference stays editable.
XCONF_TERMINAL_DIR=/etc/xdg/xfce4/xfconf/xfce-perchannel-xml
mkdir -p "$XCONF_TERMINAL_DIR"
cat > "${XCONF_TERMINAL_DIR}/xfce4-terminal.xml" <<TERMINAL
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-terminal" version="1.0">
  <property name="use-default-working-dir" type="bool" value="true"/>
  <property name="default-working-directory" type="string" value="${DESKTOP_HOME}"/>
</channel>
TERMINAL
log "Default terminal working directory: $DESKTOP_HOME"

# Desktop shortcuts. They reuse the .desktop files the applications menu uses,
# so synaptic's goes through synaptic-root and needs no polkit either. The
# 0755 mode is the executable half of XFCE 4.18's launcher-trust check; the
# other half (a GVfs checksum attribute) is seeded at session start by
# /usr/local/bin/trust-desktop-launchers, see section 11.
#
# Terminal and Synaptic are the two shortcuts every build gets -- xfce4-terminal
# is part of the base XFCE install (section 7) and synaptic is installed
# unconditionally, while Chrome and VS Code appear only when their INSTALL_*
# package is present (section 9).
#
# VS Code's deb ships its launcher as com.microsoft.VSCode.desktop; accept the
# older code.desktop name too so a pinned repo cannot silently lose the
# shortcut.
VSCODE_DESKTOP="/usr/share/applications/com.microsoft.VSCode.desktop"
[ -f "$VSCODE_DESKTOP" ] || VSCODE_DESKTOP="/usr/share/applications/code.desktop"
log "Adding desktop shortcuts (Terminal, Chrome, VS Code, Synaptic)"
for shortcut_src in \
    /usr/share/applications/xfce4-terminal.desktop \
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

# ── Personal startup script ────────────────────────────────────────────────
#
# $HOME/.startup.sh is the "run this when my desktop starts" hook: xdg-open a
# page, start a program, export per-session settings. A container desktop has no
# login shell and no $HOME that outlives an image upgrade, so there is no
# .profile or ~/.config/autostart to hang that on; xfce-vnc-session runs this
# file instead (see section 11).
#
# It is seeded in two places. /etc/skel holds the single copy of the text: a
# useradd -m after this point would copy it into that user's home, and
# xfce-vnc-session copies it into $HOME whenever the file is missing -- the
# normal Kubernetes case, where the manifests mount an emptyDir over $HOME and
# hide whatever the image put there. The stock `ubuntu` user already existed when
# this ran, so skel never applied to it and it is seeded explicitly below.
mkdir -p /etc/skel
cat > /etc/skel/.startup.sh <<'STARTUP'
#!/bin/bash
# ~/.startup.sh -- run once, automatically, when this desktop session starts.
#
# xfce-vnc-session runs this file in a terminal window on the desktop, as your
# user, with DISPLAY and the session's D-Bus already set up and at about the same
# time XFCE itself starts. The window stays at a shell prompt when the script
# ends, so its output can be read and the terminal is still usable. It is where
# "open these pages / start these programs when my desktop comes up" belongs:
#
#   xdg-open https://example.com        # a page in the default browser
#   xdg-open ~/Documents/report.pdf     # a file in whichever app claims it
#   firefox &                           # a program, left running in the background
#
# Nothing below those examples does anything yet, and a file with no commands in
# it opens no window: this copy was seeded so the hook can be found, not because
# there is something to run. Add a real command (a bare ":" counts) and the next
# start opens the window on it -- no rebuild and no image change needed. Deleting
# the file disables the hook until the next start, when the session recreates it.
#
# The window is opened in the background, so the script can never delay the
# desktop or take it down when it fails. It is an ordinary terminal though: a
# program left in the foreground holds up the prompt below it, and a background
# one dies with the window unless it is detached (setsid firefox &).
STARTUP
chmod 0755 /etc/skel/.startup.sh

# Never overwrite an edited script: install.sh is re-run over the desktop image
# by Dockerfile.full, and the user's file is theirs.
if [ ! -e "$DESKTOP_HOME/.startup.sh" ]; then
    install -m 0755 /etc/skel/.startup.sh "$DESKTOP_HOME/.startup.sh"
fi

# What xfce-vnc-session actually launches, inside a terminal window. A separate
# file because xfce4-terminal's -x wants a command to exec, not a shell pipeline,
# and because this is also the fallback when an image has no terminal emulator.
cat > /usr/local/bin/run-startup-script <<'RUNSTARTUP'
#!/bin/bash
# Run the user's startup script in the foreground, for the terminal window
# xfce-vnc-session opens on it. Written by install.sh; see ~/.startup.sh.
set -u

SCRIPT="$HOME/.startup.sh"
if [ ! -f "$SCRIPT" ]; then
    echo "No startup script at $SCRIPT"
    exit 0
fi

echo "Running $SCRIPT"
echo

# Its own shebang when it is executable, bash otherwise, so saving the file
# without the executable bit still works.
if [ -x "$SCRIPT" ]; then
    "$SCRIPT"
else
    bash "$SCRIPT"
fi
STATUS=$?

echo
echo "[startup script exited with status $STATUS]"

# Stay at a prompt so the output above can be read and the window is usable.
# Only when there is a terminal: this same script is the fallback path when
# xfce4-terminal is missing, and there it must not sit waiting for input.
if [ -t 0 ]; then
    exec bash -i
fi
RUNSTARTUP
chmod +x /usr/local/bin/run-startup-script

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
# different uid, and recreating /tmp/.X11-unix when /tmp arrives as a fresh
# mount. (The web client's Restart button no longer needs it: the pod restarts
# itself by exiting, rather than running a sudo command.)
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

# XFCE 4.18 only trusts a desktop launcher when GVfs metadata carries the
# checksum of the .desktop file's contents; seed it for everything currently
# on ~/Desktop (see trust-desktop-launchers for why this cannot happen at
# build time). Needs the D-Bus session set up above; failures are logged to
# /tmp/gvfs-trust.log and must never keep the desktop from starting.
/usr/local/bin/trust-desktop-launchers || true

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

# Start the session in the user's home. Every application the session spawns
# inherits this as its working directory, so a terminal (or the file manager)
# opened from the panel, the menu or a desktop shortcut lands in $HOME rather
# than on / or the image's WORKDIR. The web client's app dock does not run
# under this session, and is covered by the xfce4-terminal preference seeded
# in section 10 plus the launcher's own cwd (see server/apps.js).
cd "$HOME"

# The user's own startup script: $HOME/.startup.sh, seeded and documented by
# install.sh. It is the only "log in and run this" hook the desktop has, since a
# container has neither a login shell nor a ~/.config/autostart that survives an
# image upgrade. Recreate it from /etc/skel when it is missing, because the
# Kubernetes manifests mount an emptyDir over $HOME and would otherwise leave the
# hook invisible; best-effort, since a read-only $HOME must not stop the session.
STARTUP_SCRIPT="$HOME/.startup.sh"
if [ ! -e "$STARTUP_SCRIPT" ] && [ -w "$HOME" ]; then
    cp /etc/skel/.startup.sh "$STARTUP_SCRIPT" 2>/dev/null || true
fi

# Run it, when there is something to run, in a terminal window on the desktop.
#
# Visible on purpose: a startup script's output is exactly what you want to see,
# and a script that fails is otherwise invisible in a container desktop.
#
# A comment-only or empty file is skipped -- the seeded copy is exactly that, and
# a blank window on every start would be noise. grep -v keeps the lines that are
# neither blank nor a comment, so any real command (a bare ":" counts) opens it.
#
# The terminal is launched in the background, so whatever the script does can
# never delay the desktop or take it down; run-startup-script keeps the window at
# a prompt once the script has finished.
if [ -f "$STARTUP_SCRIPT" ] \
   && grep -qvE '^[[:space:]]*(#|$)' "$STARTUP_SCRIPT" 2>/dev/null; then
    echo "Running $STARTUP_SCRIPT in a terminal window"
    if command -v xfce4-terminal >/dev/null 2>&1; then
        # --disable-server: this has to be a new window started by this session,
        # never a command forwarded to an xfce4-terminal that is already up.
        xfce4-terminal --disable-server --title="Startup script" \
            -x /usr/local/bin/run-startup-script &
    else
        # No terminal emulator in the image: still run it, with the output in a
        # log instead. stdin is /dev/null so the keep-the-window-open path above
        # is skipped and this cannot wait on a tty that is not there.
        /usr/local/bin/run-startup-script </dev/null >/tmp/startup.log 2>&1 &
    fi
fi

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

  Desktop look:
$(if [ "${INSTALL_THEME:-1}" = "1" ]; then echo "    ${ORCHIS_THEME:-Orchis-Dark-Compact} (compact), ${ORCHIS_ICONS:-Tela-circle-dark} icons, docked panel"; else echo "    stock XFCE (INSTALL_THEME=0)"; fi)

  CMD ["start-vnc"]

  Next: add the web client as a second container in the same pod, or run it
  as its own deployment pointed at the websockify port above.

SUMMARY