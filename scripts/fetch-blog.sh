#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CACHE_DIR="$ROOT_DIR/.cache/blog"

mkdir -p "$CACHE_DIR/dsgners"
mkdir -p "$CACHE_DIR/medium"

fetch_into() {
  url="$1"
  out="$2"
  tmp="$out.tmp"
  i=1
  while [ "$i" -le 4 ]; do
    if curl -fsSL --connect-timeout 10 --max-time 30 "$url" -o "$tmp"; then
      if [ -s "$tmp" ]; then
        mv "$tmp" "$out"
        return 0
      fi
    fi
    i=$((i + 1))
    sleep 1
  done
  rm -f "$tmp"
  return 1
}

extract_locs() {
  grep -Eo "<loc>[^<]+</loc>" "$1" | sed -e 's#</loc>##g' -e 's#<loc>##g'
}

echo "Fetching dsgners sitemaps…"
fetch_into "https://dsgners.ru/sitemap-posts-0.xml" "$CACHE_DIR/dsgners-posts-0.xml" || true
fetch_into "https://dsgners.ru/sitemap-posts-1.xml" "$CACHE_DIR/dsgners-posts-1.xml" || true

echo "Fetching Medium feeds…"
fetch_into "https://medium.com/feed/tag/design-systems" "$CACHE_DIR/medium-design-systems.xml" || true
fetch_into "https://medium.com/feed/tag/ux-design" "$CACHE_DIR/medium-ux-design.xml" || true
fetch_into "https://medium.com/feed/tag/product-design" "$CACHE_DIR/medium-product-design.xml" || true

echo "Fetching Habr feeds…"
fetch_into "https://habr.com/ru/rss/search/?q=%D0%BF%D1%80%D0%BE%D0%B4%D1%83%D0%BA%D1%82%D0%BE%D0%B2%D1%8B%D0%B9%20%D0%B4%D0%B8%D0%B7%D0%B0%D0%B9%D0%BD&target_type=posts&order=date" "$CACHE_DIR/habr.xml" || true
fetch_into "https://habr.com/ru/rss/search/?q=design%20system&target_type=posts&order=date" "$CACHE_DIR/habr-design-system.xml" || true
fetch_into "https://habr.com/ru/rss/search/?q=%D0%B4%D0%B8%D0%B7%D0%B0%D0%B9%D0%BD-%D1%81%D0%B8%D1%81%D1%82%D0%B5%D0%BC%D0%B0&target_type=posts&order=date" "$CACHE_DIR/habr-design-system-ru.xml" || true

echo "Downloading dsgners posts…"
for sitemap in "$CACHE_DIR"/dsgners-posts-*.xml; do
  [ -s "$sitemap" ] || continue
  extract_locs "$sitemap" | head -n 120 | while read -r url; do
    [ -n "$url" ] || continue
    case "$url" in
      *design*|*ux*|*ui*|*figma*|*token*|*system*|*interface*|*interfey*|*user*|*dizayn*)
        id="$(printf "%s" "$url" | shasum | awk '{print substr($1,1,12)}')"
        fetch_into "$url" "$CACHE_DIR/dsgners/$id.html" || continue
        printf '{"id":"%s","url":"%s"}\n' "$id" "$url" > "$CACHE_DIR/dsgners/$id.json"
        ;;
    esac
  done
done

echo "Downloading medium posts…"
for feed in "$CACHE_DIR"/medium-*.xml; do
  [ -s "$feed" ] || continue
  tr '\n' ' ' < "$feed" | rg -o '<item>.*?</item>' | while read -r item; do
    url="$(printf "%s" "$item" | sed -n 's#.*<link>\(.*\)</link>.*#\1#p' | head -n1)"
    title="$(printf "%s" "$item" | sed -n 's#.*<title><!\[CDATA\[\(.*\)\]\]></title>.*#\1#p' | head -n1)"
    author="$(printf "%s" "$item" | sed -n 's#.*<dc:creator><!\[CDATA\[\(.*\)\]\]></dc:creator>.*#\1#p' | head -n1)"
    desc="$(printf "%s" "$item" | sed -n 's#.*<description><!\[CDATA\[\(.*\)\]\]></description>.*#\1#p' | head -n1)"
    [ -n "$url" ] || continue
    case "$url" in
      *design*|*ux*|*ui*|*figma*|*token*|*system*|*interface*|*product*)
        id="$(printf "%s" "$url" | shasum | awk '{print substr($1,1,12)}')"
        printf '{"id":"%s","url":"%s","title":"%s","author":"%s","description":"%s"}\n' \
          "$id" "$url" "$title" "$author" "$desc" > "$CACHE_DIR/medium/$id.json"
        ;;
    esac
  done
done

echo "Building posts.json…"
node "$ROOT_DIR/scripts/build-blog-from-cache.mjs" "$CACHE_DIR"

echo "Building digests.json…"
node "$ROOT_DIR/scripts/build-digests.mjs"

echo "Done."
