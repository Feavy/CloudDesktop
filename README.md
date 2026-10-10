# Desktop Web Client

A browser front-end for a **TigerVNC + XFCE** desktop that is already running in a
Kubernetes pod. It is a noVNC replacement with a proper dock: mobile touch controls,
clipboard sync, chunked file transfer, resolution switching and a window switcher.
The dock itself is rendered by the browser — a bottom-edge app dock with pinned and
running applications plus a full applications grid — replacing the Plank dock the
desktop images used to ship.

<p align="center">
  <img src="screenshots/desktop.png" alt="Desktop web client" width="700">
</p>

**This service has no authentication and no TLS.** Both are expected to be handled by
a Traefik reverse proxy in front of it (TLS at the `websecure` entrypoint,
authentication via a `forwardAuth` middleware). Do not expose it directly.

---

## What was removed

The original upstream project shipped an installer for bare Ubuntu VPS hosts. This
fork targets a pod, so that machinery is gone:

| Removed | Why |
|---|---|
| `server/auth.js`, `routes/auth.js`, `middleware/authenticate.js`, `sessions.js` | JWT/bcrypt login — handled by Traefik forwardAuth |
| TOTP / two-factor setup | Same |
| `routes/admin.js`, `client/admin.html`, the Control Panel modal | Account/session admin UI with nothing left to administer |
| `ws-terminal.js`, `routes/terminal.js`, xterm vendor bundle | Browser terminal (already unreferenced by the client) |
| `audit.js` | Wrote an audit log to disk for a service behind an authenticating proxy |
| `client/login.html`, `js/login.js`, `css/login.css` | No login screen |
| Claude Code dock integration | Specific to the upstream author's VPS use case |
| `install.sh`, `uninstall.sh`, `scripts/`, `config/` (nginx, fail2ban, systemd) | Host installer, firewall and TLS management — not applicable in a pod |

Configuration moved from a `data/.env` file parsed at startup to plain environment
variables, which is how a pod manifest should express it. There is no `.env` file and
no secret material to manage.

## What was kept

Clipboard sync, chunked file upload/download with pause and resume, resolution
switching via `xrandr`, the window switcher, CPU/RAM/disk stats, the
PWA install path, and the mobile touch experience (virtual trackpad cursor, on-screen
keyboard, pinch zoom, auto-fit resolution). The app launcher came back as a
browser-side app dock (see [The app dock](#the-app-dock)).

Non-US keyboards are handled too. noVNC sends the character a key produces, which
is what lets an AZERTY desktop work against a QWERTY remote, but some browsers
report the *unshifted* key for AltGr combinations that are dead keys — Chromium
on Windows sends "é" for AltGr+é on a French keyboard, so the remote typed é
instead of `~`. Those keysyms are now resolved from the physical key on the way
out (see `client/js/altgr.js`), so `~`, `` ` `` and `^` arrive as themselves.

Two small fixes came out of the rewrite:

- The clipboard endpoint waited on Node's `close` event, but `xclip` forks a
  background process that owns the selection and inherits stdio, so the request never
  resolved. It now waits on `exit` with detached stdio.
- `multer` was upgraded from 1.x to 2.x, clearing its outstanding advisories.

---

## Architecture

```
Browser ──wss──▸ Traefik ──forwardAuth──▸ web client ──TCP──▸ Xtigervnc :5900
                     │                     (Node/Express)
                     └── TLS termination
```

The web client serves the page, the noVNC assets and a small API for the dock
features. Its `/websockify` endpoint bridges the browser WebSocket to the VNC TCP
port. If you already run websocketify, set `WS_URL` and that bridge is bypassed.

## Building

Three images, so you can take only what you need.

| Dockerfile | Image | Contents | Size |
|---|---|---|---|
| `Dockerfile.client` | `clouddesktop-client` | The web client only, on `node:22-alpine` | ~150 MB |
| `Dockerfile.desktop` | `clouddesktop-desktop` | XFCE + TigerVNC + websockify, no Node.js | ~1.5 GB |
| `Dockerfile.full` | `clouddesktop-full` | All three in one image | ~2.5 GB |

```bash
docker build -f Dockerfile.client  -t clouddesktop-client:latest .
docker build -f Dockerfile.desktop -t clouddesktop-desktop:latest .
```

`clouddesktop-full` is built **on top of** `clouddesktop-desktop` so the ~1.5 GB
desktop layer is reused rather than re-installed on every build. It only adds
Node.js and the application code:

```bash
docker pull ghcr.io/feavy/clouddesktop-desktop:latest
docker build -f Dockerfile.full \
  --build-arg BASE_IMAGE=ghcr.io/feavy/clouddesktop-desktop:latest \
  -t clouddesktop-full:latest .
```

`BASE_IMAGE` defaults to the published `clouddesktop-desktop:latest`, but a CI
build passes an immutable per-commit tag instead so the base can never come from
a different commit than the code on top of it.

Use `clouddesktop-full` if you want one container and don't care about size. Use
the split `clouddesktop-desktop` + `clouddesktop-client` pair if you already run
the desktop yourself, or want the web client on a smaller base.

Both Ubuntu-based images are built by `install.sh`, which installs TigerVNC,
websockify, XFCE, and — importantly — the X tooling (`xclip`, `wmctrl`, `xrandr`,
`cvt`) that the web client shells out to. Without those the desktop renders fine
but silently loses clipboard sync, the window switcher and resolution switching.
`Dockerfile.full` re-runs it over the base purely to add Node.js; every desktop
package is already present, so apt has nothing to download.

```dockerfile
FROM ubuntu:24.04
COPY install.sh /tmp/
RUN bash /tmp/install.sh && rm -rf /var/lib/apt/lists/*
CMD ["start-desktop"]
```

It writes two scripts into the image: `/usr/local/bin/start-vnc` (Xtigervnc + XFCE +
websockify) and `/usr/local/bin/xfce-vnc-session` (the session inside X). After
installing, it asserts that all 17 binaries the app invokes are actually present
and fails the build naming the providing package if one is missing.

`start-vnc` launches XFCE itself rather than delegating to the X server, because
`Xtigervnc` has no `-xstartup` option — passing it fails with
`Unrecognized option: -xstartup` and the server never starts. Ubuntu 24.04 ships
no `Xvnc` either. It waits for the display to accept connections, then starts the
session, and treats the session's death as fatal so a crashed desktop restarts
the pod rather than leaving a grey screen served over a healthy WebSocket.

Extras:

| Variable | Default | Effect |
|---|---|---|
| `UNMINIMIZE` | `1` | Run the base image's stock `unminimize` at build time, restoring the man pages, docs and translation catalogs the minimized `ubuntu:24.04` image dpkg-strips (without them the desktop stays in English regardless of `LANG`/`LC_ALL`) |
| `INSTALL_TOOLS` | `1` | Common Linux command-line tools: git, vim, nano, htop, tmux, jq, zip/unzip, rsync, net-tools, dnsutils, bash-completion, man pages and friends |
| `EXTRA_LOCALES` | *(empty)* | Extra locales baked in at build time, space-separated (`--build-arg EXTRA_LOCALES="fr_FR.UTF-8 de_DE.UTF-8"`). Only `en_US.UTF-8` is generated otherwise; `start-vnc` also generates a missing session locale on the fly at startup |
| `DESKTOP_USER` | `ubuntu` | Unprivileged user `install.sh` creates or reuses (with `DESKTOP_UID`/`DESKTOP_GID`). Exported into the image so the persistent-root entrypoint knows which user to drop back to after its root-only pivot |
| `INSTALL_NODE` | `1` | Install Node.js from NodeSource (Ubuntu's own is 18, EOL). `Dockerfile.desktop` sets this to `0` |
| `NODE_MAJOR` | `22` | NodeSource major version |
| `INSTALL_THEME` | `1` | Theme the desktop with the [Orchis](https://github.com/vinceliuice/orchis-theme) GTK/xfwm4 theme in its **compact** flavour, matching Tela-circle icons, the Orchis wallpaper and a docked edge-to-edge panel. `0` keeps the stock XFCE look |
| `ORCHIS_THEME` | `Orchis-Dark-Compact` | Which built Orchis variant the session starts on. All three (`-Compact`, `-Light-Compact`, `-Dark-Compact`) are installed |
| `ORCHIS_ICONS` | `Tela-circle-dark` | Icon theme to select (the Tela-circle source installs `Tela-circle`, `-light` and `-dark`) |

Installed-by-default desktop apps (set `0` to slim the image down):

| Variable | Default | Effect |
|---|---|---|
| `INSTALL_BROWSERS` | `1` | Google Chrome (also a default pin in the web client's app dock) |
| `INSTALL_FIREFOX` | `1` | Firefox from Mozilla's APT repo, not Ubuntu's snap wrapper |
| `INSTALL_VSCODE` | `1` | Visual Studio Code from Microsoft's APT repo (also a default pin in the web client's app dock) |
| `INSTALL_DOCS` | `0` | LibreOffice Calc and Writer |
| `DISPLAY_GEOMETRY` | `1920x1080` | Initial framebuffer size |
| `VNC_PORT` | `5900` | Raw RFB port (loopback only) |
| `VNC_WS_PORT` | `6900` | websockify port |

Docker icons for apps that aren't installed are hidden automatically — `canLaunch`
in `/api/desktop/config` is resolved against `$PATH` at startup, so a minimal image
simply reports a shorter list.

### Look and feel

Both desktop images are themed at build time unless `INSTALL_THEME=0` is passed:

- **Orchis**, compiled from a pinned upstream commit with `-s compact --tweaks
  compact`. Both options are needed, and neither implies the other: `-s compact` is
  the compact *size* variant (it is what actually densifies widget padding, margins
  and font sizes), while `--tweaks compact` is upstream's compact *panel* tweak.
  The theme ships GTK 2/3/4 and xfwm4 window decorations in one directory. It is
  built from source rather than taken from Orchis' prebuilt release tarball because
  those tarballs are generated without `--tweaks compact`.
- **Tela-circle** icons, the matching set Orchis' own `index.theme` references.
- The **Orchis wallpaper**, as the default backdrop.
- A **docked, edge-to-edge top panel**. XFCE's stock second (bottom) panel is
  dropped — the dock is the web client's, rendered by the browser (see
  [The app dock](#the-app-dock)) — and the surviving bar keeps XFCE's own geometry —
  `p=6;x=0;y=0` with 100% length — so it sits flush against the top and both sides.
  That is what upstream's `--tweaks compact` means by "no floating panel variant";
  the bar is deliberately *not* floated or rounded.

`xfwm4` compositing is switched on (the panel's background is alpha, and renders
as an opaque black block without it), and `show_dock_shadow` is switched **off**:
the docked panel is a dock-type window, and the drop shadow xfwm4 draws around
dock windows shows up as a translucent band floating below the full-width bar —
reading as a panel that is not there.

All of it is applied through `/etc/xdg`, never a user's `$HOME`: xfconfd treats a
channel XML file there as that channel's defaults for any user without an override,
and a container session always starts from a fresh home.

### The app dock

The dock lives in the web client, at the bottom edge of the browser page — the
position the Plank dock used to occupy on the remote desktop. It auto-hides with
the same Setting (and the same trigger pill pattern) as the left-edge control
strip, and shows:

- **Pinned applications**, in pin order. A fresh deployment seeds sensible
  defaults (terminal, file manager, browser, VS Code…) from what the image
  actually ships.
- **Running but unpinned applications**, after a separator, so a window you
  opened from elsewhere is always one click away.
- An **Apps** button that opens the applications grid: every installed
  application as a tile, with search, an *All / Running* filter and a dot on
  every running app.

Running state comes from `wmctrl`'s window list: each window's `WM_CLASS` is
matched against the application registry (`StartupWMClass`, the `Exec` basename
and the process image name, exact before substring), so a dock icon knows how
many windows an application has open. Clicking an icon focuses the window (a
second click cycles to the next window of the same app); right-click or
long-press opens a menu with per-window focus, *Open New Window*, *Pin to Dock* /
*Unpin from Dock*, and *Close All Windows*.

Pins are stored server-side in `~/.config/clouddesktop/dock.json` so every
browser and device sees the same dock; if that API is unreachable the client
falls back to `localStorage`. Launching goes through `gtk-launch` (or a manual
parse of the `.desktop` file's `Exec=` line), so what runs is always an
installed application's own launcher — never a command sent from the browser.
Icons are resolved from the desktop's icon theme (`IconThemeName` from the
xfconf xsettings defaults, falling back to hicolor) and served by the API.

Launched applications start in the desktop user's home — a `.desktop` file's own
`Path=` still wins — so a terminal opens in `$HOME` rather than the server's
`/app` or a persistent root's `/`. Terminals opened from the desktop itself use
the same directory: `install.sh` seeds it as xfce4-terminal's
`default-working-directory` through `/etc/xdg`, and the session starts there.

### Running as a non-root user

`clouddesktop-desktop` and `clouddesktop-full` both run as an unprivileged user,
never root. By default they **reuse the `ubuntu` user that `ubuntu:24.04` already
provides** (uid 1000), rather than deleting it and creating a second one.
`install.sh` gives it a writable `$HOME` containing what an X desktop needs —
`.Xauthority`, `~/.vnc`, and the `Desktop`/`Downloads` directories the file
transfer API uses.

Override with `DESKTOP_USER` (and `DESKTOP_UID`/`DESKTOP_GID` if creating a new
one). If a custom name doesn't exist yet and the requested uid is taken,
`install.sh` removes the occupant to make room.

`HOME` is never hardcoded in the Dockerfiles: `start-vnc` and `entrypoint.sh`
each read it from the passwd entry, so `DESKTOP_USER` stays the single place that
decides who we run as and the web client's file paths follow automatically.

In the full image the web client deliberately runs as that same user, because it
shells out to `xclip`/`wmctrl`/`xrandr` against the same X display and reads the
`.Xauthority` that `Xtigervnc` wrote.

`start-vnc` fails early with a clear message if `HOME` is unset or unwritable
rather than starting into a black screen. It does not refuse to run as root, so
overriding `USER` in a Deployment works if you need to.

#### Passwordless sudo

The runtime user gets `NOPASSWD: ALL`, which is what lets the desktop fix things
it cannot fix as itself:

- removing `/tmp/.X*-lock` files left behind by a previous container layer under
  a different uid
- recreating `/tmp/.X11-unix` when `/tmp` arrives as a fresh `emptyDir` mount

`start-vnc` probes for working sudo once at startup and falls back to doing those
steps unprivileged if it is unavailable, so removing the sudoers drop-in
degrades rather than breaks.

**This is root-equivalent for anyone who can execute code as this user.** The web
client exposes file download and directory browse over HTTP, so the reverse
proxy's `forwardAuth` is the boundary protecting it — do not expose the pod
directly. To narrow the blast radius, replace `NOPASSWD: ALL` in
`/etc/sudoers.d/<user>` (written by `install.sh`) with an explicit command list:

```
ubuntu ALL=(root) NOPASSWD: /usr/bin/pkill, /bin/rm -f /tmp/.X*-lock, /bin/mkdir -p /tmp/.X11-unix
```

If you enable `readOnlyRootFilesystem` (the manifest does), you **must** mount a
writable volume at `$HOME`: the file transfer API creates and writes
`$HOME/Desktop` and `$HOME/Downloads`. The manifest does this with an `emptyDir`
plus `fsGroup: 1000`; swap in a PersistentVolumeClaim if uploaded files should
survive a restart.

### Persistent root filesystem

By default everything the desktop writes goes to the container's writable layer,
so a restart — or an image upgrade — starts from the image again. Set
`ROOT_PERSIST_DIR` to a mounted volume and the image copies its own root
filesystem into that volume once, then `pivot_root(2)`s into the copy before
starting `tini`. Packages, `$HOME`, the XFCE session and everything else then
live on the volume instead of the container layer:

```yaml
containers:
  - name: desktop
    image: ghcr.io/feavy/clouddesktop-full:latest
    env:
      - name: ROOT_PERSIST_DIR
        value: /persist
    securityContext:
      # Required: the images run unprivileged on purpose, and these are what
      # mount/pivot_root and the drop back to the desktop user need.
      runAsUser: 0
      runAsGroup: 0
      appArmorProfile:
        type: Unconfined
      seccompProfile:
        type: Unconfined
      capabilities:
        add: ["SYS_ADMIN", "SYS_CHROOT", "SETUID", "SETGID", "CHOWN"]
    hostUsers: false          # on clusters that use user namespaces
    volumeMounts:
      - { name: rootfs, mountPath: /persist }
volumes:
  - name: rootfs
    persistentVolumeClaim:
      claimName: desktop-rootfs
```

How it behaves:

- The first start **seeds** the volume with a copy of the image's root
  filesystem (`tar --one-file-system`, so the volume itself and kubelet's other
  mounts are skipped) and creates `<ROOT_PERSIST_DIR>/.seeded` when it is
  done. Delete that marker to seed again; a re-seed overwrites the image's files
  but does not delete files you added yourself.
- On every start it remounts what the runtime provides inside the new root:
  `/etc/hosts`, `/etc/resolv.conf`, `/etc/hostname`, the projected service
  account token, plus `/proc`, `/sys`, `/dev` and fresh `tmpfs` mounts on `/tmp`
  and `/run`. Any **other** volume mounted outside `ROOT_PERSIST_DIR` is not
  visible after the pivot, so mount what you need inside it.
- The pivot needs root, so the wrapper calls `setpriv` to drop back to
  `DESKTOP_USER` (`ubuntu` by default) afterwards — the desktop itself still
  never runs as root. Override the target with `PERSISTENT_ROOT_USER`, or set it
  to `root` to deliberately stay root.
- If any step fails — no `SYS_ADMIN`, a non-root `runAsUser`, an unwritable
  volume — the entrypoint prints the `securityContext` and capability list above
  and exits, rather than starting a desktop that silently is not persistent.

This is implemented by `deploy/pivot-root.sh`, which is the ENTRYPOINT of both
desktop images. With `ROOT_PERSIST_DIR` unset it is a pass-through to `tini`,
so nothing changes for the default deployment. `clouddesktop-client` has no
desktop and is unaffected.

### Deployment shapes

**One container** — `clouddesktop-full`. Nothing to wire up:

```yaml
containers:
  - name: desktop
    image: ghcr.io/feavy/clouddesktop-full:latest
```

**Split into two Deployments** — `clouddesktop-desktop` for the desktop,
`clouddesktop-client` for the web client. Expose the desktop's websockify port
through Traefik and point the client at it:

```yaml
# desktop: no Service needed if websockify is reached over the IngressRoute
containers:
  - name: desktop
    image: ghcr.io/feavy/clouddesktop-desktop:latest
    ports: [{ containerPort: 6900 }]

# client
containers:
  - name: web
    image: ghcr.io/feavy/clouddesktop-client:latest
    env:
      - name: WS_URL
        value: "wss://desktop.example.com/websockify"
```

With `WS_URL` set, the browser talks to websockify directly and the client's own
WebSocket-to-TCP bridge is bypassed entirely.

**Sidecar in the same pod as your existing desktop** — for the clipboard,
resolution and window features to work, the client must reach the same X display
as the VNC server. Put it in the same container, or share the IPC namespace and
X socket:

```yaml
containers:
  - name: desktop
    # ... your XFCE + TigerVNC + websockify setup
  - name: web
    image: ghcr.io/feavy/clouddesktop-client:latest
    env:
      - name: VNC_HOST
        value: "127.0.0.1"
      - name: VNC_PORT
        value: "5900"
      - name: DISPLAY
        value: ":1"
    ports:
      - containerPort: 3000
```

The app, `xclip`, `wmctrl` and `xrandr` all talk to that X display. In the
split-two-Deployments shape above they run in a container that has no X server, so
those three features fail while the picture, dock and touch controls keep
working — which is the main reason to prefer the single `clouddesktop-full` image
if you rely on them.

---

## Configuration

All settings are environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `0.0.0.0` | Listen address |
| `PORT` | `3000` | Listen port |
| `VNC_HOST` | `127.0.0.1` | VNC server to bridge to |
| `VNC_PORT` | `5900` | VNC TCP port |
| `WS_URL` | *(unset)* | External `wss://` websockify endpoint; bypasses the built-in bridge |
| `DISPLAY` | `:1` | X display used for `xrandr`/`xclip`/`wmctrl` |
| `XAUTHORITY` | `$HOME/.Xauthority` | X authority file |
| `HOME` | passwd entry | Base for `~/Desktop` and `~/Downloads` |
| `RESTART_CMD` | *(unset)* | Restart command used when there is no container to restart (a dev checkout) |
| `RESTART_MODE` | `auto` | Force how the dock restarts: `auto`, `pod`, `session`, `command` or `off` |
| `ROOT_PERSIST_DIR` | *(unset)* | Mounted volume to `pivot_root` into at startup, so the whole root filesystem persists; see [Persistent root filesystem](#persistent-root-filesystem) |
| `PERSISTENT_ROOT_USER` | `DESKTOP_USER` (`ubuntu`) | User the entrypoint drops back to after the pivot; `root` to stay root on purpose |
| `DESKTOP_USER` | `ubuntu` | Unprivileged user the desktop runs as, also the default `PERSISTENT_ROOT_USER` |

The dock's Restart button uses whichever mechanism actually reaches the
desktop. The server reports its choice as `restartMode` from
`GET /api/desktop/config`, and the browser performs the `session` one itself:

- **`pod`** — the desktop shares this container (the all-in-one image). The web
  client exits, the entrypoint supervising it exits too, and the runtime starts
  the pod again. This is the client image as well, where the server is PID 1.
  Nothing to configure.
- **`session`** — the desktop runs in a *separate* container of the same pod.
  Nothing in this process can signal it and there is no cluster API access, so
  the browser ends the session over VNC instead: it presses Ctrl+Alt+Shift+R,
  which the desktop image binds to `xfce4-session-logout --logout` (added by
  `install.sh`). `start-vnc` sees the session exit, the container goes down and
  Kubernetes starts it again. The web client and its VNC bridge stay up
  throughout and the canvas reconnects on its own. This needs the desktop to be
  one of this repo's images — or to bind that chord itself — and needs the
  session to be alive enough to handle the key press, so a completely wedged X
  server is still out of reach this way.
- **`command`** — no container at all (a dev checkout), so `RESTART_CMD` runs.
  It replaces the old `systemctl restart clouddesktop-vnc` call.
- **`off`** — none of the above, so the button is hidden rather than failing.

`auto` decides between `pod` and `session` by looking for the desktop's
processes in this container's own PID namespace — a sidecar's are not visible,
which is what distinguishes the two. That is only a guess (and it is wrong if
the pod sets `shareProcessNamespace`, which makes a sidecar's processes visible
too), so set `RESTART_MODE` to force the right one when it does not match the
deployment.

---

## Deploying

Images are published automatically to GitHub Container Registry by
`.github/workflows/publish.yml` — no registry secrets needed, it authenticates with
the workflow's own `GITHUB_TOKEN`:

| Image | Contents |
|---|---|
| `ghcr.io/feavy/clouddesktop-client` | Web client only |
| `ghcr.io/feavy/clouddesktop-desktop` | XFCE + TigerVNC + websockify |
| `ghcr.io/feavy/clouddesktop-full` | All-in-one |

| Event | Tags produced |
|---|---|
| Push to `main` | `main`, `latest` |
| Push a `v*` tag | `v1.2.3`, `v1.2`, `latest` |
| Pull request | `pr-<number>`, `sha-<short>` — never `latest` |
| Manual dispatch | as per branch, with a push/no-push checkbox |

**Testing a pull request before merging.** Open the PR inside this repository and the
workflow publishes a snapshot under a `pr-<number>` tag. Point a deployment at it:

```bash
kubectl set image deployment/desktop-web web=ghcr.io/feavy/clouddesktop-client:pr-42 -n <namespace>
```

`pr-<number>` is overwritten by each new commit on that PR, so `kubectl rollout
restart deployment/desktop-web` always pulls the newest snapshot. The workflow's
summary shows the exact tags to use, and appends the `kubectl set image` command
when it pushed one.

A PR opened from a **fork** is built but not pushed: GitHub issues those runs a
read-only `GITHUB_TOKEN`, so there is nothing to authenticate the push with. Open
the PR against this repository instead if you need a snapshot.

`clouddesktop-full` builds in a second job that waits for `clouddesktop-desktop`,
since it uses that image as its base. A fork PR therefore also skips `full`,
because there is no freshly-built base tag to pull — `client` and `desktop` still
build. Note that GHCR packages are private by default, so the CI base pull needs
your `clouddesktop-desktop` package to be public (or the workflow's login to
cover it, which it does on same-repo runs).

To publish by hand: **Actions → Publish images → Run workflow**.

```bash
kubectl apply -f deploy/kubernetes.yaml
```

Edit `deploy/kubernetes.yaml` first: set the image, the `Host(...)` rule, and the name
of your existing forwardAuth middleware. The `WS_URL` block is commented out and left
for you to fill in if websockify is exposed through Traefik.

Traefik needs long-lived, unbuffered WebSocket connections to this service. If you
route through another hop, make sure nothing imposes a short idle timeout — the client
pings every 30s to stay alive, but intermediate proxies can still cut idle streams.

---

## API

All routes are unauthenticated; the reverse proxy gates them.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness/readiness |
| `GET` | `/api/desktop/config` | Home dir, VNC endpoint, which dock actions are available |
| `GET`/`POST` | `/api/desktop/clipboard` | Read/write the X clipboard |
| `POST` | `/api/desktop/resolution` | Set the X display size, generating a modeline with `cvt` if needed |
| `POST` | `/api/desktop/restart` | Restart the pod (the process exits so the runtime restarts it); `409` when the desktop is a separate container (the browser restarts it over VNC), runs `RESTART_CMD` outside a container, `501` if neither |
| `GET` | `/api/desktop/stats` | CPU / RAM / disk |
| `GET` | `/api/desktop/windows` | List open X windows (with `WM_CLASS` and the matched application id) |
| `POST` | `/api/desktop/windows/focus` | Raise and focus a window |
| `POST` | `/api/desktop/windows/minimize` | Minimize a window (`wmctrl -b add,hidden`) |
| `POST` | `/api/desktop/windows/close` | Ask a window to close (`wmctrl -ic`) |
| `GET` | `/api/desktop/apps` | Installed applications (XDG `.desktop` entries) |
| `GET` | `/api/desktop/apps/icon/:id` | Resolved theme icon for an application (`?size=48`) |
| `POST` | `/api/desktop/apps/launch` | Launch an installed application by id |
| `GET`/`PUT` | `/api/desktop/apps/pins` | The app dock's pinned application ids |
| `POST` | `/api/desktop/launch` | Start an allowlisted app |
| `POST` | `/api/desktop/upload` | Single-shot upload |
| `POST` | `/api/desktop/upload/init` `/chunk` `/pause` `/resume` | Chunked upload |
| `GET` | `/api/desktop/files` | List `~/Desktop` and `~/Downloads` |
| `GET` | `/api/desktop/browse` | Directory listing |
| `GET` | `/api/desktop/download` | Download with Range support |
| `POST` | `/api/desktop/rename` | Rename a file |
| `WS` | `/websockify` | VNC stream (when `WS_URL` is unset) |

The launcher allowlist is `terminal`, `synaptic`, `chrome`, `filemanager` and `vscode`,
hardcoded in `server/routes/desktop.js`. The web client's app dock launches through
the `.desktop` registry (`/api/desktop/apps*`) instead, but this endpoint and the
`canLaunch` list in `/api/desktop/config` remain part of the API.

---

## Development

```bash
cd server
npm install
npm run dev
```

---

## License

MIT — see [LICENSE](LICENSE).

Originally [CloudDesktop](https://github.com/HorusGod007/CloudDesktop) by HorusGod.