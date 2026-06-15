import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

import * as cheerio from "cheerio";

import { sanitizeArticleText } from "./fetch-blog.mjs";
import { activeModel, activeProvider, requestStructured } from "./lib/llm.mjs";
import { loadEnv } from "./lib/load-env.mjs";

loadEnv();

const DIGESTS_PATH = new URL("../public/blog/digests.json", import.meta.url);
const DRAFT_DIGESTS_PATH = new URL("../.cache/draft/digests.json", import.meta.url);

const BATCH_SIZE = 8;
const FETCH_CONCURRENCY = 3;
const MAX_RETRIES = 2;
const MAX_CONTEXT_CHARS = 6000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_RETRIES = 3;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Загрузка HTML с браузерным UA и ретраями: 403/429/5xx и сетевые сбои часто
// лечатся повтором с экспоненциальной паузой (анти-rate-limit, напр. Хабр).
async function fetchHtml(url, attempt = 0) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
      headers: {
        "user-agent": BROWSER_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "ru,en;q=0.9",
      },
    });
    if ((response.status === 403 || response.status === 429 || response.status >= 500) && attempt < MAX_FETCH_RETRIES) {
      await sleep(800 * 2 ** attempt + Math.random() * 500);
      return fetchHtml(url, attempt + 1);
    }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.text();
  } catch (error) {
    if (attempt < MAX_FETCH_RETRIES && /timeout|aborted|network|fetch failed|terminated/i.test(error.message)) {
      await sleep(800 * 2 ** attempt + Math.random() * 500);
      return fetchHtml(url, attempt + 1);
    }
    throw error;
  }
}

// --- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const args = { before: "2026-06", only: null, limit: null, dry: false, latest: false, draft: false, fallbackOnly: false };
  for (const arg of argv) {
    if (arg === "--dry") args.dry = true;
    else if (arg === "--latest") args.latest = true;
    else if (arg === "--draft") args.draft = true;
    else if (arg === "--fallback-only") args.fallbackOnly = true;
    else if (arg.startsWith("--before=")) args.before = arg.slice(9);
    else if (arg.startsWith("--only=")) args.only = arg.slice(7);
    else if (arg.startsWith("--limit=")) args.limit = Number(arg.slice(8)) || null;
  }
  return args;
}

// --- Извлечение текста статьи ------------------------------------------------

function sourceFromUrl(url) {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  if (host.includes("habr.com")) return "habr";
  if (host.includes("bureau.ru")) return "bureau";
  return "generic";
}

// Убираем мягкие переносы, zero-width и нормализуем пробелы.
function normalizeText(value) {
  return String(value || "")
    .replace(/[­​-‍﻿]/g, "")
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// Строки-кандидаты в мусор: соцсети, подписки, навигация, служебные метки.
const BOILERPLATE_RE =
  /(подпис[аы]|subscribe|читайте также|continue reading|read more|cookie|войти|sign in|зарегистрир|все права защищ|поделиться|коммент|facebook|instagram|t\.me\/|вконтакте|youtube|telegram|уровень сложности|время на прочтение|©)/i;

function paragraphSelector(source) {
  if (source === "habr") return ".tm-article-body p, .tm-article-body li";
  if (source === "bureau") return ".soviet-content p, .soviet-content li, .article p, main p";
  return "article p, article li, main p, main li";
}

function extractArticleText(html, url, title) {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer, aside, form, noscript, figure, figcaption").remove();

  const source = sourceFromUrl(url);
  const annotation = normalizeText(
    $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") ||
      ""
  );

  // Параграфная экстракция: только содержательные абзацы.
  const collect = (selector) => {
    const out = [];
    $(selector).each((_, el) => {
      const text = normalizeText($(el).text());
      if (text.length >= 40 && !BOILERPLATE_RE.test(text)) out.push(text);
    });
    return out;
  };

  let paragraphs = collect(paragraphSelector(source));
  if (paragraphs.join(" ").length < 200) paragraphs = collect("p");

  // Фолбэк, если контент не размечен в <p>.
  let raw = paragraphs.join("\n");
  if (raw.length < 200) {
    raw = normalizeText(
      (source === "habr" ? $(".tm-article-body").first().text() : "") ||
        (source === "bureau" ? $(".soviet-content, .article, .soviet, main").first().text() : "") ||
        $("article").first().text() ||
        $("main").first().text() ||
        $("body").text()
    );
  }

  // Срез по границе абзаца, а не по символу.
  const limited = [];
  let size = 0;
  for (const paragraph of raw.split("\n")) {
    if (size + paragraph.length > MAX_CONTEXT_CHARS && size > 0) break;
    limited.push(paragraph);
    size += paragraph.length + 1;
  }

  const body = sanitizeArticleText(limited.join("\n"), title).slice(0, MAX_CONTEXT_CHARS);
  return { body, annotation: annotation.slice(0, 500) };
}

async function fetchContext(item) {
  try {
    const html = await fetchHtml(item.url);
    const { body, annotation } = extractArticleText(html, item.url, item.sourceTitle);
    // Если тело статьи извлеклось — нужен содержательный объём. Если нет (SPA),
    // довольствуемся аннотацией (og:description) — она короче, но это лучше, чем
    // дефолтная заглушка; модель опишет тему по заголовку + аннотации.
    const text = body.length >= 120 ? body : annotation;
    return { ok: text.length >= 30, text, annotation };
  } catch (error) {
    return { ok: false, text: "", annotation: "", error: error.message };
  }
}

// Лёгкий пул для параллельной загрузки статей.
async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

// --- Качество ----------------------------------------------------------------

function sanitize(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasRussianText(text) {
  return /[А-Яа-яЁё]/.test(String(text || ""));
}

function sentenceCount(text) {
  return (String(text || "").match(/[.!?…](?=\s|$)/g) || []).length;
}

function looksEnglish(text) {
  const t = sanitize(text);
  const cyrillic = (t.match(/[А-Яа-яЁё]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  if (latin < 20) return false;
  return cyrillic === 0 && latin > 3 * cyrillic;
}

function isGoodSummary(summary) {
  const s = sanitize(summary);
  if (s.length < 160) return false;
  if (!hasRussianText(s)) return false;
  if (sentenceCount(s) !== 3) return false;
  return true;
}

// Штампованные зачины и вода — повод переписать (мягкая проверка).
const GENERIC_OPENER_RE =
  /^\s*(статья|в статье|в этой статье|в этом выпуске|в публикации|в посте|в заметке|в материале|данн(?:ый|ая|ое)|эт(?:от|а)\s+(?:материал|статья|выпуск|пост|заметка)|материал|пост|выпуск|автор(?:ы)?)\b/i;
const FILLER_RE =
  /(будет полезен тем,?\s*кто|полезн(?:ый|ая)\s+(?:ресурс|информаци)|важн(?:ый|ая|ое)\s+аспект|для тех,?\s*кто хочет|интересн(?:о|ый)\s+тем|поможет\s+(?:читател|вам|лучше))/i;

function isGeneric(summary) {
  const s = sanitize(summary);
  return GENERIC_OPENER_RE.test(s) || FILLER_RE.test(s);
}

// --- OpenAI ------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "Ты — редактор дайджеста для практикующих дизайнеров (продуктовый дизайн, дизайн-системы, UX/UI, типографика).",
  "Пишешь живо, конкретно и по делу, как редактор сильного профессионального канала.",
  "",
  "На входе по каждому материалу: title (заголовок), url, rubric (рубрика), annotation (аннотация автора, может быть пустой) и input (реальный текст статьи).",
  "",
  "Сделай summary — ровно 3 связных предложения на русском, передающих КОНКРЕТИКУ статьи: что именно разбирается, какой подход/приём/вывод предлагается и кому он практически полезен. " +
    "Сохраняй имена методов, инструментов, цифры и конкретные тезисы из текста. Опирайся только на input — не выдумывай фактов.",
  "",
  "СТИЛЬ — обязательно:",
  "— Начинай сразу с сути (с темы или тезиса). НЕЛЬЗЯ начинать со слов «Статья», «В статье», «Автор», «Материал», «Данный», «В этом выпуске», «В публикации».",
  "— Без пустых оценок: «полезный ресурс», «важный аспект», «будет полезен тем, кто», «для тех, кто хочет», «интересно тем».",
  "— Не пересказывай навигацию, подписки, даты и имена авторов как содержание.",
  "— Заголовок не переводи. Смысл переводи на русский с любого исходного языка.",
  "",
  "excerpt — короткая дословная цитата или один острый тезис из текста (до 200 символов), по-русски; пусто, если выделить нечего.",
  "languageBadge='Eng', только если исходный язык статьи английский, иначе null.",
  "",
  "Плохой пример (так НЕ надо): «Статья рассматривает вопросы дизайна форм. Автор делится советами. Этот материал будет полезен дизайнерам.»",
  "Хороший пример (так надо): «Разбор частых ошибок в дизайне форм ввода: лишние поля, неочевидные подсказки и валидация, которая мешает вместо помощи. На контрпримерах показано, как порядок полей и формулировки влияют на конверсию. В конце — чек-лист, чтобы проверять собственные формы перед релизом.»",
].join("\n");

function buildSchema(count) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "summary", "excerpt", "languageBadge"],
          properties: {
            id: { type: "string" },
            summary: { type: "string" },
            excerpt: { type: "string" },
            languageBadge: { type: ["string", "null"] },
          },
        },
      },
    },
  };
}

async function requestRewrite(items) {
  return requestStructured({
    system: SYSTEM_PROMPT,
    user: JSON.stringify({ items }, null, 2),
    schema: buildSchema(items.length),
    schemaName: "digest_rewrite",
    maxTokens: 8000,
  });
}

async function rewriteBatch(requestItems) {
  let attempt = 0;
  let current = requestItems;
  const accepted = new Map();

  while (current.length > 0 && attempt <= MAX_RETRIES) {
    const isLast = attempt === MAX_RETRIES;
    const result = await requestRewrite(current);
    const map = new Map(result.items.map((x) => [String(x.id), x]));
    const retry = [];

    for (const reqItem of current) {
      const out = map.get(String(reqItem.id));
      // Жёсткая проверка: 3 предложения, русский, длина. Не прошло — на перезапрос.
      if (!out || !isGoodSummary(out.summary)) {
        if (!isLast) retry.push(reqItem);
        continue;
      }
      out.languageBadge = looksEnglish(`${reqItem.title}\n${reqItem.input}`) ? "Eng" : null;
      // Мягкая проверка на штампы: переписываем, но на последней попытке принимаем как есть.
      if (!isLast && isGeneric(out.summary)) {
        retry.push(reqItem);
        continue;
      }
      accepted.set(String(reqItem.id), out);
    }

    if (retry.length === 0) break;
    attempt += 1;
    current = retry.map((x) => ({
      ...x,
      input:
        "ВАЖНО: предыдущий вариант был шаблонным или не прошёл проверку. Нужно ровно 3 связных предложения " +
        "на русском, строго по сути статьи; начинать сразу с тезиса (НЕ со слов «Статья», «В статье», «Автор», " +
        "«Материал», «В этом выпуске»), без воды вроде «будет полезен тем, кто» и «полезный ресурс».\n\n" +
        x.input,
    }));
  }

  return accepted;
}

// --- Основной проход ---------------------------------------------------------

// Признак дефолтной заглушки build-digests (когда статья не распарсилась).
const FALLBACK_RE = /^Материал разбирает тему «|редакторская выжимка без служебных данных/;

async function processDigest(digest, args, stats) {
  let items = digest.items || [];
  if (args.fallbackOnly) items = items.filter((it) => FALLBACK_RE.test(it.summary || ""));
  if (args.limit) items = items.slice(0, args.limit);
  if (items.length === 0) return;

  console.log(`\n[${digest.key}] №${digest.number} — ${items.length} материалов: загрузка статей…`);

  const contexts = await mapPool(items, FETCH_CONCURRENCY, fetchContext);

  const requestItems = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const ctx = contexts[i];
    if (!ctx.ok) {
      stats.fetchFailed += 1;
      console.warn(`  ✗ не удалось получить текст: ${item.sourceTitle} (${ctx.error || "пусто"})`);
      continue;
    }
    requestItems.push({
      id: String(item.id),
      title: item.sourceTitle,
      url: item.url,
      rubric: item.rubric || "",
      annotation: ctx.annotation || "",
      input: ctx.text,
    });
  }

  const accepted = new Map();
  for (let i = 0; i < requestItems.length; i += BATCH_SIZE) {
    const batch = requestItems.slice(i, i + BATCH_SIZE);
    const result = await rewriteBatch(batch);
    for (const [id, out] of result) accepted.set(id, out);
  }

  const byId = new Map(items.map((item) => [String(item.id), item]));
  for (const [id, out] of accepted) {
    const item = byId.get(id);
    if (!item) continue;
    if (args.dry) {
      console.log(`\n  — ${item.sourceTitle}`);
      console.log(`    БЫЛО:  ${sanitize(item.summary)}`);
      console.log(`    СТАЛО: ${sanitize(out.summary)}`);
    }
    item.summary = sanitize(out.summary);
    // excerpt оставляем только если он по-русски — иначе в карточку течёт английский.
    const excerpt = sanitize(out.excerpt);
    item.excerpt = hasRussianText(excerpt) ? excerpt : "";
    item.languageBadge = out.languageBadge;
    stats.rewritten += 1;
  }

  stats.kept += requestItems.length - accepted.size;
  console.log(
    `  ✓ переписано ${accepted.size}/${items.length} (не загрузилось: ${items.length - requestItems.length}, не прошло качество: ${requestItems.length - accepted.size})`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const digestsPath = args.draft ? DRAFT_DIGESTS_PATH : DIGESTS_PATH;
  const payload = JSON.parse(await fs.readFile(digestsPath, "utf8"));
  const all = payload.digests || [];

  // --latest: только самый свежий выпуск (для ежемесячной автосборки).
  const targets = args.latest
    ? all.slice(0, 1)
    : all.filter((d) => {
        if (args.only) return d.key === args.only;
        return d.key < args.before;
      });

  if (targets.length === 0) {
    console.log("Нет выпусков под условие. Проверь --latest / --only / --before.");
    return;
  }

  console.log(`Провайдер: ${activeProvider()} / модель: ${activeModel()}`);
  console.log(
    `Выпусков под обработку: ${targets.length} (${targets[targets.length - 1].key}…${targets[0].key})` +
      `${args.dry ? " [DRY-RUN, без записи]" : ""}`
  );

  const stats = { rewritten: 0, kept: 0, fetchFailed: 0 };
  for (const digest of targets) {
    await processDigest(digest, args, stats);
    if (!args.dry) {
      await fs.writeFile(digestsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    }
  }

  console.log(
    `\nГотово. Переписано: ${stats.rewritten}. Оставлено как было (качество): ${stats.kept}. Не загрузилось: ${stats.fetchFailed}.` +
      `${args.dry ? " (DRY-RUN — файл не изменён)" : ""}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
