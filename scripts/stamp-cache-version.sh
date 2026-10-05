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
#    CACHE_VERSION=<n> stamp-cache-version.sh [client-dir]  # CI: run number
#    stamp-cache-version.sh [client-dir]                    # local: a hash
#                                                          # of the tree
#
#  The client tree is named explicitly rather than derived from this script's
#  own location: the Dockerfiles copy the script to /tmp, where a
#  dirname-based lookup resolves to a directory that has no client tree in it.
#  Defaulting to ./client covers running it from the repo root, and both
#  Dockerfiles pass /app/client explicitly.
#
#  This rewrites the client sources in place and is meant to run inside the
#  image build, on a copy. Run against a checkout by hand, `git checkout` the
#  client tree afterwards.
# ============================================================================
set -eu

CLIENT_DIR="${1:-${CLIENT_DIR:-client}}"

if [ ! -d "$CLIENT_DIR" ]; then
    echo "stamp-cache-version: no client tree at '${CLIENT_DIR}' (cwd $(pwd))" >&2
    exit 1
fi

if [ -z "${CACHE_VERSION:-}" ]; then
    # Local builds have no run number; a content hash of the client tree
    # changes whenever any client file does, which is what cache busting needs.
    CACHE_VERSION="$(find "$CLIENT_DIR" -type f -print0 | sort -z | xargs -0 md5sum | md5sum | cut -c1-12)"
fi

# Build timestamp, stamped next to the version: the settings modal shows both
# so a user can tell which build a pod is actually running. UTC ISO keeps the
# string unambiguous; the client renders it in the viewer's own timezone.
BUILD_DATETIME="${BUILD_DATETIME:-$(date -u '+%Y-%m-%dT%H:%M:%SZ')}"

# Candidate files are picked by extension, and only the ones that actually
# carry a placeholder are rewritten. The extension filter is what keeps sed
# away from the binaries (PNGs, fonts) that a plain recursive grep would match
# and corrupt; the grep keeps the rest content-based, so adding a reference
# with the placeholder is enough and there is no list to maintain.
stamped=0
datetime_stamped=0
for f in $(find "$CLIENT_DIR" -type f \( -name '*.html' -o -name '*.js' -o -name '*.json' \)); do
    if grep -q '%CACHE_VERSION%' "$f"; then
        sed -i "s/%CACHE_VERSION%/${CACHE_VERSION}/g" "$f"
        stamped=$((stamped + 1))
        echo "stamped ${CACHE_VERSION} -> ${f}"
    fi
    if grep -q '%BUILD_DATETIME%' "$f"; then
        sed -i "s/%BUILD_DATETIME%/${BUILD_DATETIME}/g" "$f"
        datetime_stamped=$((datetime_stamped + 1))
        echo "stamped ${BUILD_DATETIME} -> ${f}"
    fi
done

# Stamping nothing is a failure, not a no-op: the image would ship the literal
# %CACHE_VERSION% in every asset URL, so ?cv= stops varying between deploys and
# browsers keep serving the old files out of the immutable cache. That is the
# exact failure this script exists to prevent, and it has to break the build
# loudly rather than pass quietly. (Only the version counter gates the build;
# the datetime is display-only and rides along on the same files.)
if [ "$stamped" -eq 0 ]; then
    echo "stamp-cache-version: no %CACHE_VERSION% placeholders found under '${CLIENT_DIR}'" >&2
    exit 1
fi

echo "stamp-cache-version: stamped $stamped file(s) with ${CACHE_VERSION}, $datetime_stamped with ${BUILD_DATETIME}"
