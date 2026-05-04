import fs from "node:fs/promises";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import * as cheerio from "cheerio";
import { DSGNERS_SAMPLE_URLS } from "./lib/dsgners-urls.mjs";

const OUT_PATH = new URL("../public/blog/posts.json", import.meta.url);
const LOOKBACK_MS = 1000 * 60 * 60 * 24 * 365 * 3;
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_POSTS = 1400;
const MAX_LINKS_PER_PAGE = 180;
const MAX_ARTICLES_PER_SOURCE = 120;
const now = Date.now();

function range(from, to) {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function wordpressPages(baseUrl, from = 2, to = 8) {
  return [baseUrl, ...range(from, to).map((page) => `${baseUrl.replace(/\/$/, "")}/page/${page}/`)];
}

function habrPages(baseUrl, from = 2, to = 8) {
  return [baseUrl, ...range(from, to).map((page) => `${baseUrl.replace(/\/$/, "")}/page${page}/`)];
}

const FEED_SOURCES = [
  {
    source: "uxjournal",
    sourceLabel: "UX Journal",
    urls: [
      "https://ux-journal.ru/category/product-development/feed/",
      "https://ux-journal.ru/category/ux-design/feed/",
      "https://ux-journal.ru/category/ui-design/feed/",
    ],
  },
  {
    source: "alistapart",
    sourceLabel: "A List Apart",
    urls: ["https://alistapart.com/main/feed/"],
  },
  {
    source: "infogra",
    sourceLabel: "Infogra",
    urls: ["https://infogra.ru/feed"],
  },
  {
    source: "medium",
    sourceLabel: "Medium",
    urls: [
      "https://medium.com/feed/design-pub",
      "https://medium.com/feed/tag/design-systems",
      "https://medium.com/feed/tag/ux-design",
      "https://medium.com/feed/tag/product-design",
      "https://medium.com/feed/tag/user-experience",
      "https://medium.com/feed/tag/interaction-design",
      "https://medium.com/feed/tag/design-thinking",
      "https://medium.com/feed/tag/ui-ux-design",
      "https://medium.com/feed/tag/ux-research",
      "https://medium.com/feed/tag/usability",
      "https://medium.com/feed/tag/accessibility",
      "https://medium.com/feed/tag/information-architecture",
      "https://medium.com/feed/tag/figma",
    ],
  },
  {
    source: "typejournal",
    sourceLabel: "Type Journal",
    urls: ["https://typejournal.ru/feed"],
  },
  {
    source: "habr",
    sourceLabel: "Хабр",
    urls: [
      "https://habr.com/ru/rss/search/?q=%D0%BF%D1%80%D0%BE%D0%B4%D1%83%D0%BA%D1%82%D0%BE%D0%B2%D1%8B%D0%B9%20%D0%B4%D0%B8%D0%B7%D0%B0%D0%B9%D0%BD&target_type=posts&order=date",
      "https://habr.com/ru/rss/search/?q=design%20system&target_type=posts&order=date",
      "https://habr.com/ru/rss/search/?q=%D0%B4%D0%B8%D0%B7%D0%B0%D0%B9%D0%BD-%D1%81%D0%B8%D1%81%D1%82%D0%B5%D0%BC%D0%B0&target_type=posts&order=date",
      "https://habr.com/ru/rss/search/?q=UX&target_type=posts&order=date",
      "https://habr.com/ru/rss/search/?q=UI&target_type=posts&order=date",
      "https://habr.com/ru/rss/search/?q=Figma&target_type=posts&order=date",
      "https://habr.com/ru/rss/search/?q=%D0%B8%D0%BD%D1%82%D0%B5%D1%80%D1%84%D0%B5%D0%B9%D1%81&target_type=posts&order=date",
      "https://habr.com/ru/rss/search/?q=%D0%B4%D0%B8%D0%B7%D0%B0%D0%B9%D0%BD&target_type=posts&order=date",
    ],
  },
];

const PAGE_SOURCES = [
  {
    source: "apple-design",
    sourceLabel: "Apple Design",
    pages: ["https://developer.apple.com/design/"],
    include: (url) => /developer\.apple\.com\/design\/.+/i.test(url),
  },
  {
    source: "material",
    sourceLabel: "Material Design",
    pages: ["https://m3.material.io/"],
    include: (url) => /m3\.material\.io\/(foundations|styles|components|blog|develop|design)/i.test(url),
  },
  {
    source: "tilda-education",
    sourceLabel: "Tilda Education",
    pages: ["https://tilda.education/en/"],
    include: (url) => /tilda\.education\/en\/(articles|courses|web-design|design)/i.test(url),
  },
  {
    source: "typejournal",
    sourceLabel: "Type Journal",
    pages: wordpressPages("https://typejournal.ru/", 2, 8),
    include: (url) => /typejournal\.ru\/articles\/.+|typejournal\.ru\/\d{4}\//i.test(url),
  },
  {
    source: "kovodstvo",
    sourceLabel: "Ководство",
    pages: ["https://www.artlebedev.ru/kovodstvo/sections/"],
    include: (url) => /artlebedev\.ru\/kovodstvo\/sections\/\d+/i.test(url),
  },
  {
    source: "bureau",
    sourceLabel: "Бюро",
    pages: ["https://bureau.ru/soviet/"],
    maxArticles: 320,
    include: (url) => /bureau\.ru\/soviet\/\d+|bureau\.ru\/soviet\/.+/i.test(url),
  },
  {
    source: "habr",
    sourceLabel: "Хабр",
    pages: habrPages("https://habr.com/ru/flows/design/articles/", 2, 12),
    include: (url) => /habr\.com\/ru\/articles\/\d+\/?$/i.test(url),
  },
  {
    source: "uxjournal",
    sourceLabel: "UX Journal",
    pages: [
      ...wordpressPages("https://ux-journal.ru/category/product-development/", 2, 10),
      ...wordpressPages("https://ux-journal.ru/category/ux-design/", 2, 10),
      ...wordpressPages("https://ux-journal.ru/category/ui-design/", 2, 7),
    ],
    include: (url) => /ux-journal\.ru\/[^?#]+\/$/i.test(url) && !/\/category\/|\/page\/|\/tag\//i.test(url),
  },
  {
    source: "infogra",
    sourceLabel: "Infogra",
    pages: wordpressPages("https://infogra.ru/", 2, 12),
    include: (url) => /infogra\.ru\/(design|web|ux-ui|graficheskiy-dizayn|typography|inspiration|uroki|blog|[^/]+\/\d{4}\/\d{2}\/|[a-z0-9-]+)$/i.test(url) && !/\/(page|tag|category|author)\//i.test(url),
  },
  {
    source: "alistapart",
    sourceLabel: "A List Apart",
    pages: ["https://alistapart.com/articles/"],
    include: (url) => /alistapart\.com\/article\/.+/i.test(url),
  },
];

const DIRECT_ARTICLE_SOURCES = [
  {
    source: "designers",
    sourceLabel: "Dsgners",
    urls: DSGNERS_SAMPLE_URLS,
  },
];

const SITEMAP_SOURCES = [
  {
    source: "material",
    sourceLabel: "Material Design",
    urls: ["https://m3.material.io/sitemap.xml"],
    include: (url) => /m3\.material\.io\/(blog|foundations|styles|components|develop|design)\//i.test(url),
  },
  {
    source: "uxjournal",
    sourceLabel: "UX Journal",
    urls: ["https://ux-journal.ru/post-sitemap.xml"],
    include: (url) => /ux-journal\.ru\/.+/i.test(url) && !/\/(category|tag|author|page)\//i.test(url),
  },
  {
    source: "typejournal",
    sourceLabel: "Type Journal",
    urls: ["https://typejournal.ru/post-sitemap.xml"],
    include: (url) => /typejournal\.ru\/.+/i.test(url) && !/\/(category|tag|author|page)\//i.test(url),
  },
  {
    source: "alistapart",
    sourceLabel: "A List Apart",
    urls: ["https://alistapart.com/sitemap.xml"],
    include: (url) => /alistapart\.com\/article\/.+/i.test(url),
  },
];

function makeId(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 12);
}

function normalizeUrl(value, base) {
  try {
    const url = new URL(String(value), base);
    url.hash = "";
    if (/medium\.com$/i.test(url.hostname) || url.hostname.endsWith(".medium.com")) {
      url.search = "";
    } else {
      for (const key of [...url.searchParams.keys()]) {
        if (/^(utm_|fbclid|gclid|yclid|ref$)/i.test(key)) url.searchParams.delete(key);
      }
    }
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtml(html) {
  return decodeHtmlEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapCdata(value) {
  return String(value || "").replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, "$1");
}

function cleanTitle(value) {
  return stripHtml(value)
    .replace(/\s+[-—]\s*дизайнерс\s*$/i, "")
    .replace(/^Журнал «Шрифт»\s*•\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

const HABR_PREFIX_LABELS = [
  "Искусственный интеллект",
  "Карьера в IT-индустрии",
  "Учебный процесс в IT",
  "Развитие стартапа",
  "Дизайн мобильных приложений",
  "Робототехника",
  "Будущее здесь",
  "Графический дизайн",
  "Веб-разработка",
  "Веб-дизайн",
  "Интерфейсы",
  "Типографика",
  "Аналитика",
  "Usability",
  "Elixir/Phoenix",
  "Программирование",
  "Старое железо",
  "История IT",
  "Игры и игровые консоли",
  "Компьютерная анимация",
  "Параллельное программирование",
  "Алгоритмы",
  "Windows",
  "macOS",
  "Android",
  "iOS",
  "Софт",
  "PDF",
  "LaTeX",
  "Forth",
  "CSS",
  "HTML",
  "Дизайн",
  "Мнение",
  "Обзор",
  "Туториал",
  "Кейс",
  "Из песочницы",
  "Научно-популярное",
  "DIY или Сделай сам",
  "Роадмэп",
  "Цитаты из книги Том Питерс «Представьте себе! Превосходство в бизнесе в эпоху разрушений»",
];

function removeLeadingTitle(text, title) {
  const clean = String(text || "");
  const cleanTitleValue = cleanTitle(title);
  if (!cleanTitleValue) return clean;
  const haystack = clean.toLowerCase();
  const needle = cleanTitleValue.toLowerCase();
  const index = haystack.indexOf(needle);
  if (index < 0 || index > 320) return clean;
  return clean.slice(index + cleanTitleValue.length);
}

function stripLeadingHabrTaxonomy(text) {
  let value = String(text || "");
  let changed = true;
  while (changed) {
    changed = false;
    value = value.replace(/^[\s*·,;:|/]+/, "");
    for (const label of HABR_PREFIX_LABELS) {
      const next = value.replace(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\*?\\s*`, "i"), "");
      if (next !== value) {
        value = next;
        changed = true;
      }
    }
  }
  return value;
}

function sanitizeArticleText(value, title = "") {
  const withoutHtml = stripHtml(value);
  const withoutLeadingTitle = removeLeadingTitle(withoutHtml, title);
  const cleaned = stripLeadingHabrTaxonomy(withoutLeadingTitle)
    .replace(/Continue reading on [^.»]+[».]?/gi, " ")
    .replace(/\bAbout Me\b[\s—-]*/gi, " ")
    .replace(/^[\s\S]{0,240}?Привет,\s*Хабр[!.]?\s*/i, " ")
    .replace(/^Цитаты из книги[\s\S]{0,500}?(?:Привет[!.]?\s*)?/i, " ")
    .replace(/^(?:Приветствую|Привет)[!.]?\s*/i, " ")
    .replace(/^(?:Меня зовут|Я основатель|Я [^.!?…]{1,80}(?:дизайнер|разработчик|директор|основатель))[^.!?…]*[.!?…]\s*/i, " ")
    .replace(/^[A-Za-zА-Яа-я0-9_.-]{2,40}(?:сегодня|вчера|\d{1,2}\s+[а-яё]{3,8}\s+в\s+\d{1,2}:\d{2}|\d+\s+(?:час|часа|часов|мин|минут)[а-яё]*)/i, " ")
    .replace(/Уровень сложности\s*(?:Простой|Средний|Сложный)?/gi, " ")
    .replace(/Время на прочтение\s*\d+\s*мин(?:ут[а-яё]*)?/gi, " ")
    .replace(/Охват и читатели\s*[\d.,]+\s*[KК]?/gi, " ")
    .replace(/Всего голосов[\s\S]{0,180}?(?:Комментарии\d+|Поделиться|Добавить в закладки\d*)/gi, " ")
    .replace(/Написать\s+Войти[\s\S]*?Все права защищены/gi, " ")
    .replace(/Лента\s+Рейтинг\s+Подписки\s+Избранное[\s\S]*?Все права защищены/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripLeadingHabrTaxonomy(cleaned).trim();
}

function isRelevantPost(post) {
  if (post.source !== "habr") return true;
  const haystack = `${post.title || ""} ${post.summary || ""} ${post.rewrite || ""}`.toLowerCase();
  const hasDesignSignal =
    /(дизайн|интерфейс|ux|ui|usability|figma|прототип|навигац|визуал|типограф|дизайн[ -]?систем|accessibility|доступност|продуктов|пользовател)/i.test(
      haystack
    );
  const programmingOnly =
    /(elixir|phoenix|forth|интерпретатор|latex|c\+\+|алгоритм|параллельн|старое железо|игровые консоли|мандельброт)/i.test(
      haystack
    ) && !/(дизайн|интерфейс|ux|ui|usability|figma|типограф|доступност)/i.test(haystack);
  return hasDesignSignal && !programmingOnly;
}

function sanitizeText(value) {
  return sanitizeArticleText(value);
}

function toSummary(text, title = "") {
  const value = sanitizeArticleText(text, title);
  if (!value) return "";
  return value.length > 260 ? `${value.slice(0, 260).trim()}…` : value;
}

function toRewrite(text, title = "") {
  const value = sanitizeArticleText(text, title);
  const sentences = value
    .split(/(?<=[.!?…])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 30 && sentence.length < 320);
  const picked = sentences.slice(0, 12);
  const paragraphs = [];
  for (let index = 0; index < picked.length; index += 2) {
    paragraphs.push(picked.slice(index, index + 2).join(" "));
  }
  return paragraphs.slice(0, 6).join("\n\n");
}

function toIsoDate(value) {
  if (!value) return null;
  const date = new Date(String(value).trim());
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function isRecent(isoDate) {
  if (!isoDate) return true;
  const time = new Date(isoDate).getTime();
  return !Number.isNaN(time) && now - time <= LOOKBACK_MS;
}

function isUsefulInput(post) {
  const text = `${post.summary || ""} ${post.rewrite || ""}`.trim();
  if (!post.title || !post.url || !post.sourceLabel) return false;
  if (/^(хабр|medium|a list apart|бюро горбунова)$/i.test(post.title.trim())) return false;
  if (/\/comments\/?$/i.test(post.url)) return false;
  if (text.length < 80) return false;
  if (/^(about me|continue reading|sign in)/i.test(text)) return false;
  if (/(Уровень сложности|Время на прочтение|Охват и читатели)/i.test(text)) return false;
  if (/^[-—–\s.]+$/.test(text)) return false;
  return isRelevantPost(post);
}

async function fetchText(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; DSGDigestBot/1.0; +https://github.com/lorrrem-zlnkh/DSG)",
      accept: "text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

function tagContent(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? unwrapCdata(match[1].trim()) : "";
}

function parseFeed(xml, source, sourceLabel) {
  const posts = [];
  const itemBlocks = xml.split(/<item\b[^>]*>/i).slice(1);
  for (const block of itemBlocks) {
    const title = cleanTitle(tagContent(block, "title"));
    const url = normalizeUrl(stripHtml(tagContent(block, "link")));
    const publishedAt = toIsoDate(stripHtml(tagContent(block, "pubDate")));
    const author =
      stripHtml(tagContent(block, "dc:creator")) ||
      stripHtml(tagContent(block, "creator")) ||
      stripHtml(tagContent(block, "author")) ||
      null;
    const description = tagContent(block, "description") || tagContent(block, "content:encoded");
    if (!isRecent(publishedAt)) continue;
    posts.push({
      id: makeId(url),
      source,
      sourceLabel,
      title,
      url,
      author,
      publishedAt,
      summary: toSummary(description, title),
      rewrite: toRewrite(description, title),
    });
  }

  const entryBlocks = xml.split(/<entry\b[^>]*>/i).slice(1);
  for (const block of entryBlocks) {
    const title = cleanTitle(tagContent(block, "title"));
    const linkMatch = block.match(/<link[^>]+href=["']([^"']+)["']/i);
    const url = normalizeUrl(linkMatch?.[1] || stripHtml(tagContent(block, "link")));
    const publishedAt =
      toIsoDate(stripHtml(tagContent(block, "published"))) ||
      toIsoDate(stripHtml(tagContent(block, "updated")));
    const author = stripHtml(tagContent(block, "name")) || null;
    const description = tagContent(block, "summary") || tagContent(block, "content");
    if (!isRecent(publishedAt)) continue;
    posts.push({
      id: makeId(url),
      source,
      sourceLabel,
      title,
      url,
      author,
      publishedAt,
      summary: toSummary(description, title),
      rewrite: toRewrite(description, title),
    });
  }
  return posts.filter(isUsefulInput);
}

function parseSitemap(xml, include) {
  const urls = [];
  const blocks = xml.split(/<url\b[^>]*>/i).slice(1);
  for (const block of blocks) {
    const loc = stripHtml(tagContent(block, "loc"));
    const lastmod = toIsoDate(stripHtml(tagContent(block, "lastmod")));
    if (!loc || !include(loc) || !isRecent(lastmod)) continue;
    urls.push({ url: normalizeUrl(loc), lastmod });
  }
  return urls;
}

function parseSitemapIndex(xml) {
  const urls = [];
  const blocks = xml.split(/<sitemap\b[^>]*>/i).slice(1);
  for (const block of blocks) {
    const loc = stripHtml(tagContent(block, "loc"));
    if (loc) urls.push(normalizeUrl(loc));
  }
  return urls.filter(Boolean);
}

function metaContent($, names) {
  for (const name of names) {
    const value =
      $(`meta[property="${name}"]`).attr("content") ||
      $(`meta[name="${name}"]`).attr("content");
    if (value) return value;
  }
  return "";
}

function extractPublishedAt($) {
  return (
    toIsoDate(
      metaContent($, [
        "article:published_time",
        "og:published_time",
        "datePublished",
        "publish_date",
        "pubdate",
      ])
    ) ||
    toIsoDate($("time[datetime]").first().attr("datetime")) ||
    toIsoDate($('[itemprop="datePublished"]').first().attr("content")) ||
    null
  );
}

function inferPublishedAtFromUrl(url) {
  const bureauMatch = String(url || "").match(/bureau\.ru\/soviet\/(\d{4})(\d{2})(\d{2})\/?$/i);
  if (bureauMatch) {
    return toIsoDate(`${bureauMatch[1]}-${bureauMatch[2]}-${bureauMatch[3]}T00:00:00.000Z`);
  }
  return null;
}

function parseArticle(html, url, source, sourceLabel) {
  const $ = cheerio.load(html);
  const title =
    cleanTitle(metaContent($, ["og:title", "twitter:title"])) ||
    cleanTitle($("title").first().text()) ||
    cleanTitle($("h1").first().text());
  const author =
    stripHtml(metaContent($, ["author", "article:author"])) ||
    stripHtml($('[rel="author"]').first().text()) ||
    null;
  const publishedAt = extractPublishedAt($) || inferPublishedAtFromUrl(url);
  if (!isRecent(publishedAt)) return null;
  $("script, style, nav, header, footer, aside, form, .tm-article-snippet__meta, .tm-article-presenter__meta").remove();
  const description = metaContent($, ["description", "og:description"]);
  const body =
    (source === "habr" ? $(".tm-article-body").first().text() : "") ||
    (source === "bureau" ? $(".soviet-content, .article, .soviet, main").first().text() : "") ||
    $("article").first().text() ||
    $("main").first().text() ||
    $("body").text();
  const post = {
    id: makeId(url),
    source,
    sourceLabel,
    title,
    url,
    author,
    publishedAt,
    summary: toSummary(description || body, title),
    rewrite: toRewrite(body || description, title),
  };
  return isUsefulInput(post) ? post : null;
}

function extractLinks(html, pageUrl, include) {
  const $ = cheerio.load(html);
  const links = [];
  const seen = new Set();
  $("a[href]").each((_, node) => {
    const url = normalizeUrl($(node).attr("href"), pageUrl);
    if (!url || seen.has(url) || !include(url)) return;
    seen.add(url);
    links.push(url);
  });
  return links.slice(0, MAX_LINKS_PER_PAGE);
}

function isBureauAdviceUrl(url) {
  return /bureau\.ru\/soviet\/\d{8}\/?$/i.test(url);
}

function isBureauCollectionUrl(url) {
  return /bureau\.ru\/soviet\/[a-z0-9-]+\/?$/i.test(url) && !isBureauAdviceUrl(url);
}

function extractBureauAdviceLinks(html, pageUrl) {
  const $ = cheerio.load(html);
  const links = [];
  const seen = new Set();
  $('a[href][data-author], a[href][data-date], a[href*="/soviet/"]').each((_, node) => {
    const url = normalizeUrl($(node).attr("href"), pageUrl);
    if (!url || !isBureauAdviceUrl(url) || seen.has(url)) return;
    seen.add(url);
    links.push(url);
  });
  return links;
}

async function collectFeeds() {
  const posts = [];
  for (const source of FEED_SOURCES) {
    for (const url of source.urls) {
      try {
        const xml = await fetchText(url);
        posts.push(...parseFeed(xml, source.source, source.sourceLabel));
      } catch (error) {
        console.warn(`[fetch-blog] feed skipped ${url}: ${error.message}`);
      }
    }
  }
  return posts;
}

async function collectPages() {
  const posts = [];
  for (const source of PAGE_SOURCES) {
    const sourcePosts = [];
    const seenLinks = new Set();
    const maxArticles = source.maxArticles || MAX_ARTICLES_PER_SOURCE;
    for (const pageUrl of source.pages) {
      let links = [];
      try {
        const html = await fetchText(pageUrl);
        links = extractLinks(html, pageUrl, source.include);
      } catch (error) {
        console.warn(`[fetch-blog] page skipped ${pageUrl}: ${error.message}`);
      }

      for (let index = 0; index < links.length; index += 1) {
        const url = links[index];
        if (sourcePosts.length >= maxArticles) break;
        if (seenLinks.has(url)) continue;
        seenLinks.add(url);
        try {
          const html = await fetchText(url);
          if (source.source === "bureau" && isBureauCollectionUrl(url)) {
            for (const adviceUrl of extractBureauAdviceLinks(html, url)) {
              if (!seenLinks.has(adviceUrl)) links.push(adviceUrl);
            }
            continue;
          }
          const post = parseArticle(html, url, source.source, source.sourceLabel);
          if (post) sourcePosts.push(post);
        } catch {
          // ignore individual article failures
        }
      }
    }
    posts.push(...sourcePosts);
  }
  return posts;
}

async function collectSitemaps() {
  const posts = [];
  for (const source of SITEMAP_SOURCES) {
    const foundUrls = [];
    const sitemapUrls = [...source.urls];
    for (const sitemapUrl of source.urls) {
      try {
        const xml = await fetchText(sitemapUrl);
        const nested = parseSitemapIndex(xml).filter((url) =>
          /(post|article|blog|sitemap).*\.xml/i.test(url)
        );
        sitemapUrls.push(...nested);
        foundUrls.push(...parseSitemap(xml, source.include));
      } catch (error) {
        console.warn(`[fetch-blog] sitemap skipped ${sitemapUrl}: ${error.message}`);
      }
    }

    for (const sitemapUrl of sitemapUrls.slice(source.urls.length)) {
      if (foundUrls.length >= MAX_ARTICLES_PER_SOURCE * 2) break;
      try {
        const xml = await fetchText(sitemapUrl);
        foundUrls.push(...parseSitemap(xml, source.include));
      } catch {
        // ignore nested sitemap failures
      }
    }

    const seen = new Set();
    const urls = foundUrls
      .filter((item) => {
        if (!item.url || seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
      })
      .sort((left, right) => {
        const leftTime = left.lastmod ? new Date(left.lastmod).getTime() : 0;
        const rightTime = right.lastmod ? new Date(right.lastmod).getTime() : 0;
        return rightTime - leftTime;
      })
      .slice(0, MAX_ARTICLES_PER_SOURCE);

    for (const item of urls) {
      try {
        const html = await fetchText(item.url);
        const post = parseArticle(html, item.url, source.source, source.sourceLabel);
        if (post) {
          posts.push({
            ...post,
            publishedAt: post.publishedAt || item.lastmod,
          });
        }
      } catch {
        // ignore individual article failures
      }
    }
  }
  return posts;
}

async function collectDirectArticles() {
  const posts = [];
  for (const source of DIRECT_ARTICLE_SOURCES) {
    for (const url of source.urls.slice(0, MAX_ARTICLES_PER_SOURCE)) {
      try {
        const html = await fetchText(url);
        const post = parseArticle(html, url, source.source, source.sourceLabel);
        if (post) posts.push(post);
      } catch (error) {
        console.warn(`[fetch-blog] article skipped ${url}: ${error.message}`);
      }
    }
  }
  return posts;
}

function dedupePosts(posts) {
  const byUrl = new Map();
  const byTitle = new Map();
  const unique = [];
  for (const post of posts) {
    const url = normalizeUrl(post.url);
    const titleKey = String(post.title || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const titleMapKey = `${post.source}:${titleKey}`;
    const existing = byUrl.get(url) || byTitle.get(titleMapKey);
    if (!url || !titleKey) continue;
    if (existing) {
      if (!existing.publishedAt && post.publishedAt) existing.publishedAt = post.publishedAt;
      if (!existing.author && post.author) existing.author = post.author;
      if ((existing.summary || "").length < (post.summary || "").length) existing.summary = post.summary;
      if ((existing.rewrite || "").length < (post.rewrite || "").length) existing.rewrite = post.rewrite;
      if ((existing.title || "").length > (post.title || "").length && post.title) existing.title = post.title;
      byUrl.set(url, existing);
      byTitle.set(titleMapKey, existing);
      continue;
    }
    const item = { ...post, url, id: makeId(url) };
    byUrl.set(url, item);
    byTitle.set(titleMapKey, item);
    unique.push(item);
  }
  return unique;
}

function sortPosts(left, right) {
  const leftTime = left.publishedAt ? new Date(left.publishedAt).getTime() : 0;
  const rightTime = right.publishedAt ? new Date(right.publishedAt).getTime() : 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return String(left.title || "").localeCompare(String(right.title || ""), "ru");
}

export async function fetchBlogPosts() {
  const posts = dedupePosts([
    ...(await collectFeeds()),
    ...(await collectPages()),
    ...(await collectSitemaps()),
    ...(await collectDirectArticles()),
  ])
    .sort(sortPosts)
    .slice(0, MAX_POSTS);
  const generatedAt = new Date().toISOString();

  await fs.mkdir(new URL(".", OUT_PATH), { recursive: true });
  await fs.writeFile(
    OUT_PATH,
    `${JSON.stringify({ generatedAt, posts }, null, 2)}\n`,
    "utf8"
  );
  console.log(`[fetch-blog] posts: ${posts.length}`);
  return { generatedAt, posts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fetchBlogPosts().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
