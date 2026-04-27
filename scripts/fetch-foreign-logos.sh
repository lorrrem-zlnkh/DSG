#!/bin/zsh
# NOTE: In this environment, DNS works reliably only in the current shell session.
# Run this script via: `source scripts/fetch-foreign-logos.sh`
set -euo pipefail

if [[ "${ZSH_EVAL_CONTEXT:-}" != *":file" ]]; then
  echo "Этот скрипт нужно запускать через: source scripts/fetch-foreign-logos.sh" >&2
  return 2 2>/dev/null || exit 2
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SYSTEMS_JSON="$ROOT_DIR/public/data/systems.json"
LOGOS_DIR="$ROOT_DIR/public/assets/logos"

mkdir -p "$LOGOS_DIR"
mkdir -p "$ROOT_DIR/.cache"

curl_fetch() {
  # args: <url> <outPath>
  local url="$1"
  local out="$2"

  local attempt=1
  local delay=0.4
  while (( attempt <= 5 )); do
    if curl -fsSL "$url" -o "$out"; then
      return 0
    fi
    sleep "$delay" || true
    delay="$(python3 - <<'PY' "$delay"
import sys
d=float(sys.argv[1])
print(min(d*2, 3.2))
PY
)"
    attempt=$(( attempt + 1 ))
  done
  return 1
}

# Extract: id \t siteUrl
python3 - <<'PY' "$SYSTEMS_JSON" > "$ROOT_DIR/.cache/foreign_sites.tsv"
import json, sys
systems_path = sys.argv[1]
data = json.load(open(systems_path, "r", encoding="utf-8"))
for s in data.get("systems", []):
  if s.get("origin") != "foreign":
    continue
  site = (s.get("links") or {}).get("site") or s.get("companyPageUrl")
  if not site:
    continue
  print(f"{s.get('id')}\t{site}")
PY

pick_icon_urls() {
  # args: <baseUrl> <htmlPath>
  python3 - <<'PY' "$1" "$2"
import sys
from urllib.parse import urljoin
from html.parser import HTMLParser

base = sys.argv[1]
html_path = sys.argv[2]
html = open(html_path, "r", encoding="utf-8", errors="ignore").read()

def norm_rel(val: str) -> str:
  return " ".join((val or "").lower().split())

def push(arr, url):
  if not url:
    return
  full = urljoin(base, url)
  if full not in arr:
    arr.append(full)

urls = []

class Parser(HTMLParser):
  def handle_starttag(self, tag, attrs):
    if tag not in ("link", "meta"):
      return
    a = {k.lower(): (v or "") for (k, v) in attrs}
    if tag == "link":
      rel = norm_rel(a.get("rel", ""))
      href = a.get("href", "")
      if not href:
        return
      if "icon" in rel:
        push(urls, href)
      elif rel == "apple-touch-icon":
        push(urls, href)
      return
    if tag == "meta":
      prop = norm_rel(a.get("property", ""))
      if prop == "og:image":
        push(urls, a.get("content", ""))

Parser().feed(html)

# Classic fallback
push(urls, "/favicon.ico")

for u in urls:
  print(u)
PY
}

while IFS=$'\t' read -r id site; do
  [[ -n "$id" && -n "$site" ]] || continue

  html_path="$ROOT_DIR/.cache/site-$id.html"
  if ! curl_fetch "$site" "$html_path"; then
    echo "SKIP $id (site fetch failed)"
    continue
  fi

  chosen_url=""
  chosen_rel=""

  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue

    ext="$(python3 - <<'PY' "$candidate"
import sys, os
from urllib.parse import urlparse
p = urlparse(sys.argv[1]).path
ext = os.path.splitext(p)[1].lstrip(".").lower()
print(ext or "png")
PY
)"
    out_rel="assets/logos/foreign-$id.$ext"
    out="$ROOT_DIR/public/$out_rel"
    mkdir -p "$(dirname "$out")"

    if curl_fetch "$candidate" "$out"; then
      chosen_url="$candidate"
      chosen_rel="$out_rel"
      break
    fi
  done < <(pick_icon_urls "$site" "$html_path")

  if [[ -n "$chosen_rel" ]]; then
    python3 - <<'PY' "$SYSTEMS_JSON" "$id" "$chosen_rel" "$chosen_url"
import json, sys
path, id_, rel, src = sys.argv[1:]
data = json.load(open(path, "r", encoding="utf-8"))
for s in data.get("systems", []):
  if s.get("id") == id_:
    s["logo"] = rel
    src_meta = s.get("source") or {}
    src_meta["logoFrom"] = src
    s["source"] = src_meta
    break
json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(path, "a", encoding="utf-8").write("\n")
PY
    echo "OK  $id -> $chosen_rel"
  else
    echo "SKIP $id (no icons found)"
  fi
done < "$ROOT_DIR/.cache/foreign_sites.tsv"
