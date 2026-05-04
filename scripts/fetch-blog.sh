#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Fetching source articles…"
node "$ROOT_DIR/scripts/fetch-blog.mjs"

echo "Building digests.json…"
node "$ROOT_DIR/scripts/build-digests.mjs"

echo "Done."
