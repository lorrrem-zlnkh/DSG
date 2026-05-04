import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { isBlockedBlogPost } from "./lib/blog-quality.mjs";

const LOOKBACK_MS = 1000 * 60 * 60 * 24 * 365 * 2;
const now = Date.now();
const SOURCE_LIMITS = {
  medium: 30,
  habr: 20,
  designers: 50,
};

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

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function sanitizeArticleText(text) {
  return decodeHtmlEntities(text)
    .replace(/Continue reading on [^.»]+[».]?/gi, " ")
    .replace(/\bAbout Me\b[\s—-]*/gi, " ")
    .replace(/^\s*(?:Привет|Всем привет)[!,]?\s*(?:Хабр[!.]?\s*)?/i, " ")
    .replace(/^(?:Меня зовут|Я основатель|Я [^.!?…]{1,80}(?:дизайнер|разработчик|директор|основатель))[^.!?…]*[.!?…]\s*/i, " ")
    .replace(/\s+(?:Привет|Всем привет)[!,]?\s*(?:Хабр[!.]?\s*)?/gi, " ")
    .replace(/\s*(?:Меня зовут|Я основатель|Я [^.!?…]{1,80}(?:дизайнер|разработчик|директор|основатель))[^.!?…]*[.!?…]\s*/gi, " ")
    .replace(/[.!?…](?=[А-ЯЁA-Z])/g, "$& ")
    .replace(/\s+/g, " ")
    .trim();
}

function toSummary(text) {
  const t = sanitizeArticleText(stripHtml(text));
  if (!t) return "";
  const cut = t.length > 220 ? t.slice(0, 220).trim() + "…" : t;
  return cut;
}

function toRewrite(text) {
  const t = sanitizeArticleText(stripHtml(text));
  if (!t) return "";
  const sentences = t
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20 && s.length < 280);
  const picked = sentences.slice(0, 14);
  const paragraphs = [];
  for (let i = 0; i < picked.length; i += 2) paragraphs.push(picked.slice(i, i + 2).join(" "));
  return paragraphs.slice(0, 7).join("\n\n");
}

function sortPostsByDateDesc(left, right) {
  const leftTime = left.publishedAt ? new Date(left.publishedAt).getTime() : 0;
  const rightTime = right.publishedAt ? new Date(right.publishedAt).getTime() : 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return String(left.title || "").localeCompare(String(right.title || ""), "ru");
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

function sanitizeMediumText(text) {
  return String(text || "")
    .replace(/Continue reading on [^.»]+[».]?/gi, " ")
    .replace(/\bAbout Me\b[\s—-]*/gi, " ")
    .replace(/^\s*By\s+[A-Z][A-Za-z .-]+\s*$/gim, " ")
    .replace(/^\s*Introduction\s*$/gim, " ")
    .replace(/&#x[0-9a-f]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isWeakMediumInput({ title, summary, rewrite }) {
  const summaryText = sanitizeMediumText(summary);
  const rewriteText = sanitizeMediumText(rewrite);
  const titleText = String(title || "").trim();
  if (!titleText) return true;
  if (!summaryText && !rewriteText) return true;
  if (summaryText.length < 60 && rewriteText.length < 100) return true;
  if (/^(introduction|by\s+[a-z])/i.test(summaryText)) return true;
  if (/^[-—–\s.]+$/.test(summaryText)) return true;
  return false;
}

function parseRss(xml, source, sourceLabel) {
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
    const desc = unwrapCdata(get("description") || get("content:encoded") || "");

    const publishedAt = pubDate ? new Date(pubDate).toISOString() : null;
    if (publishedAt && now - new Date(publishedAt).getTime() > LOOKBACK_MS) continue;
    if (!title || !link) continue;

    items.push({
      id: makeId(link),
      source,
      sourceLabel,
      title,
      url: link,
      author: author || null,
      publishedAt,
      summary: toSummary(desc),
      rewrite: toRewrite(desc),
    });
  }
  return source === "medium"
    ? items.filter((item) => !isWeakMediumInput(item))
    : items;
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

function toIsoDate(value) {
  if (!value) return null;
  const date = new Date(String(value).trim());
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function extractPublishedAt(html, source) {
  const directCandidates = [
    extractByMeta(html, [
      "article:published_time",
      "og:published_time",
      "publish_date",
      "pubdate",
      "datePublished",
    ]),
    (html.match(/<time[^>]+datetime=["']([^"']+)["']/i) || [])[1],
    (html.match(/"datePublished":"([^"]+)"/i) || [])[1],
  ];

  for (const candidate of directCandidates) {
    const iso = toIsoDate(candidate);
    if (iso) return iso;
  }

  if (source === "designers") {
    const dataPage = html.match(/data-page="([\s\S]*?)"/i)?.[1];
    if (!dataPage) return null;
    const decoded = decodeHtmlEntities(dataPage);
    const nestedCandidates = [
      decoded.match(/"published_at":"([^"]+)"/i)?.[1],
      decoded.match(/"created_at":"([^"]+)"/i)?.[1],
    ];
    for (const candidate of nestedCandidates) {
      const iso = toIsoDate(candidate);
      if (iso) return iso;
    }
  }

  return null;
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtml(m[1]) : "";
}

function cleanSourceTitle(value) {
  return String(value || "")
    .replace(/\s+[-—]\s*дизайнерс\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCacheMeta(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const read = (key) => {
      const match = raw.match(new RegExp(`"${key}":"([\\s\\S]*?)"(?:,|})`));
      return match ? match[1].replace(/\\"/g, '"') : "";
    };
    return {
      id: read("id"),
      url: read("url"),
      title: read("title"),
      author: read("author"),
      description: read("description"),
    };
  }
}

async function parseHtmlFile(filePath, source, sourceLabel, url) {
  const html = await fs.readFile(filePath, "utf8");
  const normalizedUrl = normalizeUrl(url);
  const title = extractByMeta(html, ["og:title"]) || extractTitle(html);
  const author =
    extractByMeta(html, ["author"]) || extractByMeta(html, ["article:author"]) || null;
  const desc = extractByMeta(html, ["description", "og:description"]) || "";
  const bodyText = stripHtml(html);
  const publishedAt = extractPublishedAt(html, source);
  if (!title) return null;
  return {
    id: makeId(normalizedUrl),
    source,
    sourceLabel,
    title: cleanSourceTitle(stripHtml(title)),
    url: normalizedUrl,
    author: author ? stripHtml(author) : null,
    publishedAt,
    summary: toSummary(desc || bodyText),
    rewrite: toRewrite(bodyText),
  };
}

async function main() {
  const [cacheDir] = process.argv.slice(2);
  if (!cacheDir) {
    console.error("Usage: node scripts/build-blog-from-cache.mjs <cacheDir>");
    process.exitCode = 2;
    return;
  }

  const outPath = new URL("../public/blog/posts.json", import.meta.url);
  const posts = [];
  let existing = { generatedAt: null, posts: [] };
  try {
    existing = JSON.parse(await fs.readFile(outPath, "utf8"));
  } catch {
    // ignore
  }

  // RSS cached
  const rssMap = [
    { file: "habr.xml", source: "habr", label: "Хабр" },
    { file: "habr-design-system.xml", source: "habr", label: "Хабр" },
    { file: "habr-design-system-ru.xml", source: "habr", label: "Хабр" },
    { file: "medium.xml", source: "medium", label: "Medium" },
    { file: "medium-design-systems.xml", source: "medium", label: "Medium" },
    { file: "medium-ux-design.xml", source: "medium", label: "Medium" },
    { file: "medium-product-design.xml", source: "medium", label: "Medium" },
  ];
  for (const r of rssMap) {
    try {
      const xml = await fs.readFile(path.join(cacheDir, r.file), "utf8");
      posts.push(...parseRss(xml, r.source, r.label));
    } catch {
      // ignore
    }
  }

  // HTML cached (dsgners / medium metadata)
  for (const src of [
    { sub: "dsgners", source: "designers", label: "Dsgners" },
    { sub: "medium", source: "medium", label: "Medium" },
  ]) {
    const dir = path.join(cacheDir, src.sub);
    let files = [];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      const meta = parseCacheMeta(await fs.readFile(path.join(dir, f), "utf8"));
      const htmlPath = path.join(dir, `${meta.id}.html`);
      let item = null;
      if (src.sub === "medium") {
        const feedTitle = cleanSourceTitle(stripHtml(meta.title || ""));
        const feedAuthor = stripHtml(meta.author || "");
        const desc = stripHtml(meta.description || "");
        item = {
          id: meta.id,
          source: src.source,
          sourceLabel: src.label,
          title: feedTitle,
          url: normalizeUrl(meta.url),
          author: feedAuthor || null,
          publishedAt: null,
          summary: toSummary(desc),
          rewrite: toRewrite(desc || feedTitle),
        };
        if (isWeakMediumInput(item)) {
          item = null;
        }
      } else {
        item = await parseHtmlFile(htmlPath, src.source, src.label, meta.url);
      }
      if (item) posts.push(item);
    }
  }

  // Dedup + limit
  const seen = new Set();
  posts.sort(sortPostsByDateDesc);
  const unique = posts.filter((p) => {
    if (isBlockedBlogPost(p)) return false;
    if (!p.url || !p.title || !p.sourceLabel || seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  });

  const finalPosts = [];
  const selectedUrls = new Set();

  for (const [source, limit] of Object.entries(SOURCE_LIMITS)) {
    for (const post of unique) {
      if (post.source !== source || selectedUrls.has(post.url)) continue;
      finalPosts.push(post);
      selectedUrls.add(post.url);
      if (finalPosts.filter((item) => item.source === source).length >= limit) break;
    }
  }

  for (const post of unique) {
    if (finalPosts.length >= 100) break;
    if (selectedUrls.has(post.url)) continue;
    finalPosts.push(post);
    selectedUrls.add(post.url);
  }

  const outputPosts = (finalPosts.length ? finalPosts : (existing.posts || [])).sort(sortPostsByDateDesc);

  await fs.writeFile(
    outPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), posts: outputPosts }, null, 2) +
      "\n",
    "utf8"
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
