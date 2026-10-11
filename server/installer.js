// Installing a package into this pod from a .deb download URL.
//
// The web client's app browser lets the user paste the URL of a Debian
// package; this module fetches it and hands it to apt-get. That is a
// deliberate widening of the surface every other part of the client is
// careful to keep narrow: launching a window may only name an installed
// .desktop entry, but a package's maintainer scripts run as root. The
// boundary is the same one the rest of the service relies on — the pod sits
// behind Traefik with forwardAuth, and installing software is already
// root-equivalent through the file-transfer API — so nothing here is
// reachable that an authorised user could not reach with a shell.
//
// What this module does bound, so a URL cannot be used to damage the pod:
//   * only http(s) URLs are fetched,
//   * the download is capped (config.DEB_MAX_BYTES) and times out,
//   * redirects are followed a few times, never to another scheme,
//   * the bytes must actually be a Debian package before apt sees them,
//   * one installation runs at a time (apt/dpkg take a global lock anyway),
//   * the temporary file is removed whatever happens.
//
// Installation is asynchronous: a download plus apt's dependency resolution
// can easily outlive a reverse proxy's patience. startInstall returns a job
// that the client polls, and the module keeps the last JOB_TTL_MS of them so
// a browser that navigated away can still be told what happened.
//
// On success the applications the package brought also get a launcher on
// ~/Desktop, the way install.sh seeds the launchers it ships; see
// addDesktopShortcuts and apps.createDesktopShortcut.

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const config = require('./config');
const apps = require('./apps');

const TEMP_DIR = path.join(os.tmpdir(), 'clouddesktop-install');

const MAX_REDIRECTS = 5;
// Applies between chunks, not to the whole transfer: a large package from a
// slow mirror is fine, a connection that has gone quiet is not.
const IDLE_TIMEOUT_MS = 60 * 1000;
// apt's own output is what the user needs on failure; keep the tail.
const LOG_TAIL = 8000;
const JOB_TTL_MS = 15 * 60 * 1000;
const MAX_JOBS = 20;
// A package is expected to bring a handful of menu entries. The cap only
// exists so a pathological .deb cannot carpet ~/Desktop.
const MAX_SHORTCUTS = 12;

// One install at a time. dpkg's database lock makes concurrent apt runs
// queue or fail anyway, and a single job is all the UI shows.
let currentJobId = null;

// ── Capability ──────────────────────────────────────────────
//
// The all-in-one and desktop images are Ubuntu and run the server as an
// unprivileged user with passwordless sudo; the client-only image is Alpine,
// has neither apt-get nor the desktop apt would install into, and must not
// offer the feature. Resolved once: the package manager and sudo rights of a
// running container do not change.

let capability = null;

function whichSync(cmd) {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const full = path.join(dir, cmd);
    try { fs.accessSync(full, fs.constants.X_OK); return full; } catch { /* keep looking */ }
  }
  return null;
}

// Root needs no help; anyone else needs sudo to answer "may I?" without a
// prompt, which is exactly what install.sh's NOPASSWD rule provides.
function canEscalate() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return true;
  const sudo = whichSync('sudo');
  if (!sudo) return false;
  const probe = spawnSync(sudo, ['-n', 'true'], { timeout: 5000, stdio: 'ignore' });
  return probe.status === 0;
}

function installCapability() {
  if (capability) return capability;
  const apt = whichSync('apt-get');
  if (!apt) {
    capability = { available: false, reason: 'This image has no apt-get (install packages from a shell instead)' };
  } else if (!canEscalate()) {
    capability = { available: false, reason: 'The server cannot gain root to install packages' };
  } else {
    capability = { available: true, reason: '' };
  }
  return capability;
}

// ── Download ────────────────────────────────────────────────

function httpError(message, status) {
  const err = new Error(message);
  if (status) err.status = status;
  return err;
}

// Stream a .deb to `dest`, following redirects by hand so the scheme check
// survives every hop and so the byte count can stop an oversized body before
// it is written. Resolves with the received size.
function download(url, dest, maxBytes, onProgress) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let redirects = 0;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };

    const go = (target) => {
      let parsed;
      try { parsed = new URL(target); } catch { return fail(httpError('That is not a valid URL', 400)); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return fail(httpError('Only http:// and https:// download URLs are supported', 400));
      }

      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.get(parsed, {
        headers: { 'User-Agent': 'CloudDesktop', Accept: 'application/octet-stream' },
      }, (res) => {
        const status = res.statusCode || 0;

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (++redirects > MAX_REDIRECTS) return fail(httpError('Too many redirects', 400));
          let next;
          try { next = new URL(res.headers.location, parsed).toString(); }
          catch { return fail(httpError('The redirect target is not a valid URL', 400)); }
          return go(next);
        }

        if (status !== 200) {
          res.resume();
          return fail(httpError(`The download URL answered HTTP ${status}`, 502));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
        if (total && total > maxBytes) {
          res.destroy();
          return fail(httpError(`The package is larger than the ${Math.round(maxBytes / 1048576)} MB limit`, 413));
        }

        const out = fs.createWriteStream(dest);
        let received = 0;

        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            res.destroy();
            out.destroy();
            return fail(httpError(`The package is larger than the ${Math.round(maxBytes / 1048576)} MB limit`, 413));
          }
          if (onProgress) onProgress(received, total);
        });
        res.on('error', fail);
        out.on('error', fail);
        out.on('finish', () => { if (!settled) { settled = true; resolve(received); } });
        res.pipe(out);
      });

      req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(httpError('The download stalled', 504)));
      req.on('error', (err) => fail(err.status ? err : httpError(`Download failed: ${err.message}`, 502)));
    };

    go(url);
  });
}

// A .deb is an ar archive, and every ar archive starts with this magic. It
// costs one read and rejects an HTML error page or a tarball before apt has
// to explain itself; apt still validates the package's own structure.
function looksLikeDeb(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8);
    const read = fs.readSync(fd, buf, 0, 8, 0);
    return read === 8 && buf.toString('latin1') === '!<arch>\n';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
}

// ── apt ─────────────────────────────────────────────────────

// The last few non-empty lines of apt's output: dpkg writes its real reason
// last ("dependency problems prevent configuration…", "Read-only file
// system"), and that one line is what the user has to act on.
function lastLines(text, count = 4) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(-count).join('\n');
}

// Run apt-get on the package. DEBIAN_FRONTEND is passed through `env`
// explicitly because sudo resets the environment, and a maintainer script
// that decided to ask a debconf question would otherwise hang the job
// forever with nobody attached to answer it.
function aptRun(args, job) {
  return new Promise((resolve) => {
    const root = typeof process.getuid === 'function' && process.getuid() === 0;
    const argv = root ? [] : ['sudo', '-n'];
    argv.push('env', 'DEBIAN_FRONTEND=noninteractive', 'LC_ALL=C', 'apt-get', ...args);

    const child = spawn(argv[0], argv.slice(1), {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const capture = (chunk) => {
      output += chunk.toString();
      if (output.length > LOG_TAIL) output = output.slice(-LOG_TAIL);
      if (job) job.log = output;
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    child.on('error', (err) => resolve({ code: -1, output: `Could not run apt-get: ${err.message}` }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

// apt resolves a local package's dependencies from the archives it knows
// about. A container built with `rm -rf /var/lib/apt/lists/*` has none, so a
// dependency that is not already installed fails the first attempt with
// "unmet dependencies" — refresh the lists and try once more. Anything else
// (a bad package, a read-only root) is reported as it stands rather than
// papered over.
const NEEDS_UPDATE = /unmet dependencies|unable to fetch|no installation candidate|not going to be installed|held broken packages/i;

async function installPackage(file, job) {
  let result = await aptRun(['install', '-y', file], job);
  if (result.code !== 0 && NEEDS_UPDATE.test(result.output)) {
    if (job) job.message = 'Updating package lists…';
    const update = await aptRun(['update'], job);
    if (update.code === 0) {
      if (job) job.message = 'Installing…';
      result = await aptRun(['install', '-y', file], job);
    }
  }
  return result;
}

// ── Jobs ────────────────────────────────────────────────────

const jobs = new Map();

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (!job.running && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
  // A long-lived pod that installs often should not grow the map forever even
  // if every entry is somehow still inside its TTL.
  while (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.values()]
      .filter((j) => !j.running)
      .sort((a, b) => a.startedAt - b.startedAt)[0];
    if (!oldest) break;
    jobs.delete(oldest.id);
  }
}

function publicJob(job) {
  return {
    id: job.id,
    state: job.state,          // downloading | installing | done | error
    message: job.message,
    error: job.error,
    bytes: job.bytes,
    total: job.total,
    shortcuts: job.shortcuts || [],
    log: job.state === 'error' ? lastLines(job.log, 6) : '',
  };
}

function getJob(id) {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

// Give the applications apt just installed a launcher on ~/Desktop each, the
// same treatment install.sh gives the launchers it ships. `before` is the
// registry's ids from before apt ran; detection is that diff rather than
// `dpkg -L <package>` on purpose, because the diff is exactly the set that
// now appears in the app browser too, so the desktop and the grid agree.
//
// A package may ship several menu entries (LibreOffice ships one per module);
// each gets its own launcher, up to MAX_SHORTCUTS. Entries the user already
// has a file for are skipped by createDesktopShortcut.
function addDesktopShortcuts(before) {
  const created = [];
  for (const app of apps.listApps(true)) {
    if (before.has(app.id)) continue;
    if (created.length >= MAX_SHORTCUTS) break;
    const name = apps.createDesktopShortcut(app.id);
    if (name) created.push(name);
  }
  // XFCE will not run them until GVfs carries their checksum; see
  // apps.trustDesktopLaunchers.
  if (created.length) apps.trustDesktopLaunchers();
  return created;
}

async function runInstall(job) {
  const file = path.join(TEMP_DIR, `clouddesktop-${job.id}.deb`);
  try {
    await fs.promises.mkdir(TEMP_DIR, { recursive: true });
    await download(job.url, file, config.DEB_MAX_BYTES, (bytes, total) => {
      job.bytes = bytes;
      if (total) job.total = total;
    });

    if (!looksLikeDeb(file)) {
      const err = new Error('That URL did not return a Debian package (.deb)');
      err.status = 415;
      throw err;
    }

    job.state = 'installing';
    job.message = 'Installing…';

    // Snapshot before apt: anything that appears in the registry afterwards
    // is what this package brought.
    const before = new Set(apps.listApps(true).map((a) => a.id));

    const result = await installPackage(file, job);
    if (result.code !== 0) {
      const err = new Error(lastLines(result.output, 4) || `apt-get exited with code ${result.code}`);
      err.status = 500;
      throw err;
    }

    job.shortcuts = addDesktopShortcuts(before);
    job.state = 'done';
    job.message = 'Installed';
  } catch (err) {
    job.state = 'error';
    job.error = String(err.message || err);
    job.message = job.error;
    if (err.stack) job.log = `${job.log || ''}\n${err.stack}`.trim().slice(-LOG_TAIL);
  } finally {
    job.running = false;
    job.finishedAt = Date.now();
    if (currentJobId === job.id) currentJobId = null;
    fs.promises.rm(file, { force: true }).catch(() => { /* best effort */ });
  }
}

// Start a download+install. Throws synchronously (with a status the route can
// use) for anything the request itself is wrong about, and returns the job
// otherwise — the work continues in the background.
function startInstall(url) {
  const cap = installCapability();
  if (!cap.available) {
    const err = new Error(cap.reason);
    err.status = 501;
    throw err;
  }

  const raw = typeof url === 'string' ? url.trim() : '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    const err = new Error('Enter the download URL of a .deb package');
    err.status = 400;
    throw err;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const err = new Error('Only http:// and https:// download URLs are supported');
    err.status = 400;
    throw err;
  }

  if (currentJobId) {
    const current = jobs.get(currentJobId);
    if (current && current.running) {
      const err = new Error('Another installation is already running');
      err.status = 409;
      throw err;
    }
  }

  pruneJobs();

  const job = {
    id: crypto.randomUUID(),
    url: parsed.toString(),
    state: 'downloading',
    message: 'Downloading…',
    error: null,
    bytes: 0,
    total: 0,
    shortcuts: [],
    log: '',
    running: true,
    startedAt: Date.now(),
    finishedAt: 0,
  };
  jobs.set(job.id, job);
  currentJobId = job.id;

  runInstall(job).catch(() => { /* runInstall records the failure on the job */ });
  return publicJob(job);
}

module.exports = {
  installCapability,
  startInstall,
  getJob,
  // exported for tests
  download,
  looksLikeDeb,
  lastLines,
};
