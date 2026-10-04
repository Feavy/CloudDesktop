#!/bin/sh
# ============================================================================
#  Replaces every %CACHE_VERSION% placeholder in the client sources with the
#  cache-busting version baked into asset URLs (?cv=...).
#
#  The server serves those assets with `max-age=31536000, immutable`, so the
#  ?cv= query parameter is what makes a new deployment pick up new files: the
#  HTML (served no-cache) references fresh URLs and the browser treats them as
#  different resources.
#
#  Usage:
#    CACHE_VERSION=<n> scripts/stamp-cache-version.sh   # CI: GitHub run number
#    scripts/stamp-cache-version.sh                     # falls back to a hash
#                                                       # of the client tree
# ============================================================================
set -eu

cd "$(dirname "$0")/.."

if [ -z "${CACHE_VERSION:-}" ]; then
    # Local builds have no run number; a content hash of the client tree
    # changes whenever any client file does, which is what cache busting needs.
    CACHE_VERSION="$(find client -type f -print0 | sort -z | xargs -0 md5sum | md5sum | cut -c1-12)"
fi

# Stamp every file that carries the placeholder (desktop.html, the module
# imports in js/*.js and the icons in manifest.json today). Kept content-based
# so adding a reference with the placeholder is enough; no list to maintain.
for f in $(grep -rl '%CACHE_VERSION%' client --include='*.html' --include='*.js' --include='*.json'); do
    sed -i "s/%CACHE_VERSION%/${CACHE_VERSION}/g" "$f"
    echo "stamped ${CACHE_VERSION} -> ${f}"
done
