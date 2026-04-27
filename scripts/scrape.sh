#!/bin/sh
set -eu

SOURCE_URL="${SCRAPE_URL:-}"
if [ -z "$SOURCE_URL" ]; then
  echo "Set SCRAPE_URL to the catalog URL to scrape." >&2
  exit 2
fi
PUBLIC_DIR="public"
CACHE_DIR=".cache"

mkdir -p "$CACHE_DIR"

echo "Fetching catalog HTML…"
curl -sL "$SOURCE_URL" -o "$CACHE_DIR/catalog.html"

echo "Parsing cards…"
node "scripts/parse-catalog.mjs" "$SOURCE_URL" "$CACHE_DIR/catalog.html" "$PUBLIC_DIR" > "$CACHE_DIR/downloads.tsv"

echo "Downloading assets…"
while IFS="$(printf '\t')" read -r url rel; do
  [ -n "$url" ] || continue
  out="$PUBLIC_DIR/$rel"
  mkdir -p "$(dirname "$out")"
  curl -sL "$url" -o "$out" || true
done < "$CACHE_DIR/downloads.tsv"

echo "Done."
