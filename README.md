# Desktop Web Client

A browser front-end for a **TigerVNC + XFCE** desktop that is already running in a
Kubernetes pod. It is a noVNC replacement with a proper dock: mobile touch controls,
clipboard sync, chunked file transfer, resolution switching, an app launcher and a
window switcher.

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
switching via `xrandr`, the app launcher, the window switcher, CPU/RAM/disk stats, the
PWA install path, and the mobile touch experience (virtual trackpad cursor, on-screen
keyboard, pinch zoom, auto-fit resolution).

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
docker build -f Dockerfile.full    -t clouddesktop-full:latest .
```

Use `clouddesktop-full` if you want one container and don't care about size. Use
the split `clouddesktop-desktop` + `clouddesktop-client` pair if you already run
the desktop yourself, or want the web client on a smaller base.

Both Ubuntu-based images are built by `install.sh`, which installs TigerVNC,
websockify, XFCE, and — importantly — the X tooling (`xclip`, `wmctrl`, `xrandr`,
`cvt`) that the web client shells out to. Without those the desktop renders fine
but silently loses clipboard sync, the window switcher and resolution switching.

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

Opt-in extras:

| Variable | Default | Effect |
|---|---|---|
| `INSTALL_NODE` | `1` | Install Node.js from NodeSource (Ubuntu's own is 18, EOL). `Dockerfile.desktop` sets this to `0` |
| `NODE_MAJOR` | `22` | NodeSource major version |
| `INSTALL_BROWSERS` | `0` | Google Chrome (the dock's Chrome icon) |
| `INSTALL_FIREFOX` | `0` | Firefox from Mozilla's APT repo, not Ubuntu's snap wrapper |
| `INSTALL_DOCS` | `0` | LibreOffice Calc and Writer |
| `DISPLAY_GEOMETRY` | `1920x1080` | Initial framebuffer size |
| `VNC_PORT` | `5900` | Raw RFB port (loopback only) |
| `VNC_WS_PORT` | `6900` | websockify port |

Docker icons for apps that aren't installed are hidden automatically — `canLaunch`
in `/api/desktop/config` is resolved against `$PATH` at startup, so a minimal image
simply shows a smaller dock.

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
| `RESTART_CMD` | *(unset)* | Command run by the dock's Restart button; unset hides the button |

`RESTART_CMD` replaces the old `systemctl restart clouddesktop-vnc` call — there is no
service manager in a container, so the deployment decides how to cycle the session. If
you leave it unset the Restart button is hidden rather than failing.

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
| `POST` | `/api/desktop/restart` | Run `RESTART_CMD`; `501` if unconfigured |
| `GET` | `/api/desktop/stats` | CPU / RAM / disk |
| `GET` | `/api/desktop/windows` | List open X windows |
| `POST` | `/api/desktop/windows/focus` | Raise and focus a window |
| `POST` | `/api/desktop/launch` | Start an allowlisted app |
| `POST` | `/api/desktop/upload` | Single-shot upload |
| `POST` | `/api/desktop/upload/init` `/chunk` `/pause` `/resume` | Chunked upload |
| `GET` | `/api/desktop/files` | List `~/Desktop` and `~/Downloads` |
| `GET` | `/api/desktop/browse` | Directory listing |
| `GET` | `/api/desktop/download` | Download with Range support |
| `POST` | `/api/desktop/rename` | Rename a file |
| `WS` | `/websockify` | VNC stream (when `WS_URL` is unset) |

The launcher allowlist is `terminal`, `firefox`, `chrome`, `filemanager` and `editor`,
hardcoded in `server/routes/desktop.js`. Dock icons for apps missing from that list are
hidden at runtime.

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