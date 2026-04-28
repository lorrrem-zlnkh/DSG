/**
 * Fetches and builds `public/blog/posts.json` (up to 100 posts, last 2 years).
 * Sources: Habr, Medium, dsgners.ru.
 *
 * Compliance:
 * - We do NOT copy full originals; we generate short rewritten versions.
 * - We keep source + author + link attribution.
 */
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";

const OUT_PATH = new URL("../public/blog/posts.json", import.meta.url);
const LOOKBACK_MS = 1000 * 60 * 60 * 24 * 365 * 2;
const now = Date.now();

function runCurl(url) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", ["-sL", url], { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(Buffer.concat(err).toString("utf8") || `curl ${code}`));
    });
  });
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapCdata(value) {
  return String(value).replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, "$1");
}

function toSummary(text) {
  const t = stripHtml(text);
  if (!t) return "";
  // very short announcement (2 lines max-ish)
  const s = t
    .replace(/Читайте.*$/i, "")
    .replace(/Под катом.*$/i, "")
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cut = s.length > 220 ? s.slice(0, 220).trim() + "…" : s;
  return cut;
}

function toRewrite(text) {
  const t = stripHtml(text);
  if (!t) return "";
  // "укороченный формат": 2–4 абзаца по 1–2 предложения
  const sentences = t
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && s.length < 260);
  const picked = sentences.slice(0, 6);
  if (!picked.length) return "";
  const paragraphs = [];
  for (let i = 0; i < picked.length; i += 2) {
    paragraphs.push(picked.slice(i, i + 2).join(" "));
  }
  return paragraphs.slice(0, 4).join("\n\n");
}

function makeId(url) {
  return crypto.createHash("sha1").update(String(url)).digest("hex").slice(0, 12);
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(String(url));
    parsed.hash = "";
    if (parsed.hostname.includes("medium.com")) {
      parsed.search = "";
    }
    return parsed.toString();
  } catch {
    return String(url);
  }
}

function parseRss(xml, source) {
  const items = [];
  const itemBlocks = xml.split(/<item>/i).slice(1);
  for (const block of itemBlocks) {
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return m ? m[1].trim() : "";
    };
    const title = stripHtml(unwrapCdata(get("title")));
    const link = normalizeUrl(stripHtml(unwrapCdata(get("link"))));
    const pubDate = stripHtml(unwrapCdata(get("pubDate")));
    const author =
      stripHtml(unwrapCdata(get("dc:creator"))) ||
      stripHtml(unwrapCdata(get("creator"))) ||
      stripHtml(unwrapCdata(get("author")));
    const desc = unwrapCdata(get("description") || get("content:encoded"));

    const publishedAt = pubDate ? new Date(pubDate).toISOString() : null;
    if (publishedAt && now - new Date(publishedAt).getTime() > LOOKBACK_MS) continue;
    if (!title || !link) continue;

    items.push({
      source,
      sourceLabel:
        source === "habr"
          ? "Хабр"
          : source === "medium"
            ? "Medium"
            : source,
      title,
      url: link,
      author: author || null,
      publishedAt,
      summary: toSummary(desc || ""),
      rewrite: toRewrite(desc || ""),
    });
  }
  return items;
}

function parseSitemap(xml) {
  // naive XML parsing for <url><loc>..</loc><lastmod>..</lastmod>
  const urls = [];
  const blocks = xml.split(/<url>/i).slice(1);
  for (const b of blocks) {
    const loc = (b.match(/<loc>\s*([\s\S]*?)\s*<\/loc>/i) || [])[1];
    if (!loc) continue;
    const lastmod = (b.match(/<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i) || [])[1];
    urls.push({ loc: stripHtml(loc), lastmod: stripHtml(lastmod || "") });
  }
  return urls;
}

function extractByMeta(html, keys) {
  for (const k of keys) {
    const re = new RegExp(
      `<meta[^>]+(?:name|property)=[\"']${k}[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>`,
      "i"
    );
    const m = html.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return "";
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtml(m[1]) : "";
}

async function fetchSitemapSource({ source, label, sitemapUrl, pickUrl }) {
  const out = [];
  const xml = await runCurl(sitemapUrl);
  const urls = parseSitemap(xml)
    .map((u) => ({ ...u, loc: u.loc.trim() }))
    .filter((u) => pickUrl(u.loc));

  for (const u of urls.slice(0, 250)) {
    // cap to avoid huge crawls
    let publishedAt = null;
    if (u.lastmod) {
      const dt = new Date(u.lastmod);
      if (!Number.isNaN(dt.getTime())) publishedAt = dt.toISOString();
      if (publishedAt && now - dt.getTime() > LOOKBACK_MS) continue;
    }

    try {
      const html = await runCurl(u.loc);
      const title = extractByMeta(html, ["og:title"]) || extractTitle(html);
      const author =
        extractByMeta(html, ["author"]) ||
        extractByMeta(html, ["article:author"]) ||
        null;
      const desc =
        extractByMeta(html, ["description", "og:description"]) || "";

      const bodyText = stripHtml(html);

      const normalizedUrl = normalizeUrl(u.loc);
      out.push({
        id: makeId(normalizedUrl),
        source,
        sourceLabel: label,
        title: stripHtml(title),
        url: normalizedUrl,
        author: author ? stripHtml(author) : null,
        publishedAt,
        summary: toSummary(desc || bodyText),
        rewrite: toRewrite(bodyText),
      });
    } catch {
      // ignore broken pages
    }
    if (out.length >= 50) break; // per-source cap
  }
  return out;
}

async function main() {
  let posts = [];

  // RSS feeds: Habr search RSS + Medium tag RSS
  const rssFeeds = [
    // Habr supports RSS for search results; query is URL-encoded.
    { source: "habr", url: "https://habr.com/ru/rss/search/?q=%D0%B4%D0%B8%D0%B7%D0%B0%D0%B9%D0%BD-%D1%81%D0%B8%D1%81%D1%82%D0%B5%D0%BC%D0%B0&target_type=posts&order=date" },
    { source: "habr", url: "https://habr.com/ru/rss/search/?q=design%20system&target_type=posts&order=date" },
    { source: "medium", url: "https://medium.com/feed/tag/design-system" },
    { source: "medium", url: "https://medium.com/feed/tag/design-tokens" }
  ];

  for (const feed of rssFeeds) {
    try {
      const xml = await runCurl(feed.url);
      const parsed = parseRss(xml, feed.source).map((p) => ({ ...p, id: makeId(p.url) }));
      posts = posts.concat(parsed);
    } catch {
      // ignore
    }
  }

  // Sitemap source: dsgners.ru
  try {
    posts = posts.concat(
      await fetchSitemapSource({
        source: "designers",
        label: "Dsgners",
        sitemapUrl: "https://dsgners.ru/sitemap.xml",
        pickUrl: (u) => /dsgners\.ru\/(article|post|news|blog)\//i.test(u) || /dsgners\.ru\/\d{4}\//.test(u)
      })
    );
  } catch {
    // ignore
  }

  // Deduplicate by URL, keep newest first
  const seen = new Set();
  posts.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
  posts = posts.filter((p) => {
    if (seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  });

  // Limit to 100
  posts = posts.slice(0, 100).map((p) => ({
    ...p,
    summary: p.summary || "Короткое описание будет добавлено после сборки данных."
  }));

  await fs.mkdir(new URL(".", OUT_PATH), { recursive: true });
  await fs.writeFile(
    OUT_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), posts }, null, 2) + "\n",
    "utf8"
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
