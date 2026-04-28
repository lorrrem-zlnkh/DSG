import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./lib/load-env.mjs";

loadEnv();

const POSTS_PATH = new URL("../public/blog/posts.json", import.meta.url);
const DIGESTS_PATH = new URL("../public/blog/digests.json", import.meta.url);

const MONTH_NAMES = [
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
];

const ALLOWED_SOURCES = new Set(["medium", "designers", "habr"]);
const LOOKBACK_YEARS = 2;
const DIGEST_SIZE = 30;
const PER_SOURCE_LIMIT = 15;
const CANDIDATE_SIZE = 45;
const DEFAULT_MODEL = process.env.OPENAI_DIGEST_MODEL || "gpt-4o-mini";
const FIRST_DIGEST_YEAR = 2024;
const FIRST_DIGEST_MONTH = 1;
const OPENAI_TIMEOUT_MS = 60_000;

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function monthKeyFromDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabelFromParts(year, month) {
  return `${MONTH_NAMES[month - 1]}, ${year}`;
}

function inferRubric(post) {
  const haystack = `${post.title} ${post.summary} ${post.rewrite}`.toLowerCase();
  if (/(token|токен)/i.test(haystack)) return "Токены";
  if (/(research|исследован|interview|опрос)/i.test(haystack)) return "Исследования";
  if (/(system|система|component|компонент)/i.test(haystack)) return "Дизайн-системы";
  if (/(figma|prototype|прототип)/i.test(haystack)) return "Инструменты";
  if (/(product|продукт|growth|метрик)/i.test(haystack)) return "Продукт";
  return "Практика";
}

function looksEnglish(text) {
  const value = String(text || "");
  const hasCyrillic = /[А-Яа-яЁё]/.test(value);
  const hasLatin = /[A-Za-z]/.test(value);
  return hasLatin && !hasCyrillic;
}

function sanitizeDigestText(text) {
  return String(text || "")
    .replace(/Continue reading on [^.»]+[».]?/gi, " ")
    .replace(/\bAbout Me\b[\s—-]*/gi, " ")
    .replace(/Краткая суть:\s*/gi, "")
    .replace(/—\s*дизайнерс[\s\S]*?Подписаться/gi, " ")
    .replace(/Написать\s+Войти[\s\S]*?Все права защищены/gi, " ")
    .replace(/Лента\s+Рейтинг\s+Подписки\s+Избранное[\s\S]*?Все права защищены/gi, " ")
    .replace(/©\s*\d{4}[-–]\d{4}\s*Все права защищены/gi, " ")
    .replace(/\bContinue reading\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isWeakDigestText(text) {
  const value = sanitizeDigestText(text);
  if (!value) return true;
  if (value.length < 80) return true;
  if (/^[-—–\s.]+$/.test(value)) return true;
  if (/^(about me|continue reading)/i.test(value)) return true;
  if (/(Написать\s+Войти|Лента\s+Рейтинг|Все права защищены|Подписаться\s+Подписаться)/i.test(value))
    return true;
  if (/(Medium\s*»|Member-only story|Sign in to Medium)/i.test(value)) return true;
  return false;
}

function fallbackDigestItem(post) {
  const summary = sanitizeDigestText(post.summary || "");
  const excerpt = sanitizeDigestText(post.rewrite?.split(/\n{2,}/).find(Boolean) || "");
  return {
    id: post.id,
    url: post.url,
    sourceTitle: post.title,
    summary: summary || "Описание будет добавлено после генерации.",
    excerpt: excerpt || summary || "Фрагмент статьи будет добавлен после генерации.",
    rubric: inferRubric(post),
    author: post.author || "Автор не указан",
    source: post.sourceLabel || post.source,
    publishedAt: post.publishedAt || null,
    languageBadge: looksEnglish(`${post.title} ${post.summary}`) ? "Eng" : null,
  };
}

function monthDistance(targetDate, candidateDate) {
  return Math.abs(
    (candidateDate.getUTCFullYear() - targetDate.getUTCFullYear()) * 12 +
      (candidateDate.getUTCMonth() - targetDate.getUTCMonth())
  );
}

function selectDigestPosts(posts, digestMonthKey) {
  const [yearString, monthString] = digestMonthKey.split("-");
  const targetDate = new Date(Date.UTC(Number(yearString), Number(monthString) - 1, 1));
  const bySource = new Map();

  for (const post of posts) {
    const date = normalizeDate(post.publishedAt);
    if (!date) continue;
    const keyed = { ...post, _date: date, _monthKey: monthKeyFromDate(date) };
    const sourcePosts = bySource.get(keyed.source) || [];
    sourcePosts.push(keyed);
    bySource.set(keyed.source, sourcePosts);
  }

  const selected = [];
  for (const source of ALLOWED_SOURCES) {
    const sourcePosts = (bySource.get(source) || []).sort((left, right) => {
      const leftSameMonth = left._monthKey === digestMonthKey ? 0 : 1;
      const rightSameMonth = right._monthKey === digestMonthKey ? 0 : 1;
      if (leftSameMonth !== rightSameMonth) return leftSameMonth - rightSameMonth;
      const byGap = monthDistance(targetDate, left._date) - monthDistance(targetDate, right._date);
      if (byGap !== 0) return byGap;
      return right._date - left._date;
    });
    selected.push(...sourcePosts.slice(0, PER_SOURCE_LIMIT));
  }

  return selected
    .filter((post, index, array) => array.findIndex((item) => item.id === post.id) === index)
    .sort((a, b) => b._date - a._date)
    .slice(0, CANDIDATE_SIZE);
}

function extractResponseText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.length > 0) {
    return payload.output_text;
  }

  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

async function requestDigestFromOpenAI(digestMeta, posts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["title", "items"],
    properties: {
      title: { type: "string" },
      items: {
        type: "array",
        minItems: Math.min(posts.length, DIGEST_SIZE),
        maxItems: posts.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "sourceTitle", "summary", "excerpt", "rubric", "author", "source", "languageBadge"],
          properties: {
            id: { type: "string" },
            sourceTitle: { type: "string" },
            summary: { type: "string" },
            excerpt: { type: "string" },
            rubric: { type: "string" },
            author: { type: "string" },
            source: { type: "string" },
            languageBadge: { type: ["string", "null"] },
          },
        },
      },
    },
  };

  const response = await fetch(`${process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"}/responses`, {
    method: "POST",
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_output_tokens: 5000,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "Ты редактор дайджестов по продуктовому дизайну. На основе входных статей создай русскоязычный дайджест. " +
                "Не выдумывай факты. Для каждой статьи верни два поля: summary и excerpt. " +
                "summary — полезный, адекватный анонс статьи на русском, 2-3 предложения. Он должен помогать понять, стоит ли читать дальше. " +
                "Нельзя писать шаблоны вроде 'Краткая суть', 'About Me', 'Continue reading on Medium' и любые обрывки RSS. " +
                "excerpt — короткий содержательный фрагмент по материалам статьи на русском, 1-2 предложения, без кавычек и без мусорных вставок. " +
                "Если статья на английском или другом языке, обязательно переводи на русский и summary, и excerpt. " +
                "Оригинальный заголовок не меняй. Для англоязычных материалов ставь languageBadge='Eng'. " +
                "Если ты не можешь написать адекватные summary/excerpt по статье (слишком мало данных, мусорный текст, меню/футер), НЕ включай эту статью в items. " +
                "Если входных данных мало или они шумные, все равно напиши аккуратный полезный анонс по доступному содержанию, но не повторяй мусорные фразы. " +
                "Рубрика должна быть короткой: 1-2 слова.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(
                {
                  digest: {
                    month: digestMeta.month,
                    year: digestMeta.year,
                    title: digestMeta.title,
                    targetItems: DIGEST_SIZE,
                  },
                  articles: posts.map((post) => ({
                    id: post.id,
                    sourceTitle: post.title,
                    source: post.sourceLabel || post.source,
                    author: post.author || "Автор не указан",
                    summary: post.summary || "",
                    rewrite: post.rewrite || "",
                    publishedAt: post.publishedAt || null,
                    url: post.url,
                  })),
                },
                null,
                2
              ),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "digest_payload",
          schema,
          strict: true,
        },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${text}`);
  }

  const payload = await response.json();
  const text = extractResponseText(payload);
  return JSON.parse(text);
}

function mergeGeneratedItems(selectedPosts, generated) {
  if (!generated) {
    return selectedPosts
      .map(fallbackDigestItem)
      .filter((item) => !isWeakDigestText(item.summary) && !isWeakDigestText(item.excerpt))
      .slice(0, DIGEST_SIZE);
  }

  const itemMap = new Map(selectedPosts.map((post) => [post.id, post]));
  const items = [];
  const seen = new Set();

  for (const item of generated.items || []) {
    const sourcePost = itemMap.get(item.id);
    if (!sourcePost || seen.has(sourcePost.id)) continue;
    const cleanSummary = sanitizeDigestText(item.summary);
    const cleanExcerpt = sanitizeDigestText(item.excerpt);

    if (isWeakDigestText(cleanSummary) || isWeakDigestText(cleanExcerpt)) {
      continue;
    }

    seen.add(sourcePost.id);
    items.push({
      id: sourcePost.id,
      url: sourcePost.url,
      sourceTitle: item.sourceTitle || sourcePost.title,
      summary: cleanSummary,
      excerpt: cleanExcerpt,
      rubric: item.rubric,
      author: item.author || sourcePost.author || "Автор не указан",
      source: item.source || sourcePost.sourceLabel || sourcePost.source,
      publishedAt: sourcePost.publishedAt || null,
      languageBadge:
        item.languageBadge === "Eng" || looksEnglish(`${sourcePost.title} ${cleanSummary}`) ? "Eng" : null,
    });
  }

  if (items.length >= DIGEST_SIZE) {
    return items.slice(0, DIGEST_SIZE);
  }

  // If OpenAI generation is available but returned fewer good items, keep the digest shorter
  // instead of filling with low-quality fallbacks.
  return items;
}

export async function buildDigests() {
  const source = JSON.parse(await fs.readFile(POSTS_PATH, "utf8"));
  const now = new Date();
  const cutoff = new Date(Date.UTC(now.getUTCFullYear() - LOOKBACK_YEARS, now.getUTCMonth(), 1));

  const posts = (source.posts || []).filter((post) => ALLOWED_SOURCES.has(post.source));

  const datedMonthKeys = new Set();
  for (const post of posts) {
    const date = normalizeDate(post.publishedAt);
    if (!date || date < cutoff) continue;
    datedMonthKeys.add(monthKeyFromDate(date));
  }

  const allMonthKeys = [];
  const cursor = new Date(Date.UTC(FIRST_DIGEST_YEAR, FIRST_DIGEST_MONTH - 1, 1));
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  while (cursor <= lastMonth) {
    allMonthKeys.push(monthKeyFromDate(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  const availableMonthKeys = allMonthKeys.sort();
  const digests = [];

  for (const [index, monthKey] of availableMonthKeys.entries()) {
    const [yearString, monthString] = monthKey.split("-");
    const year = Number(yearString);
    const month = Number(monthString);
    const digestMeta = {
      key: monthKey,
      number: index + 1,
      year,
      month,
      monthLabel: MONTH_NAMES[month - 1],
      title: `Выпуск №${index + 1}`,
    };

    const selectedPosts = selectDigestPosts(posts, monthKey);
    if (selectedPosts.length === 0) continue;

    let generated = null;
    try {
      console.log(`[build-digests] generating ${monthKey} (#${index + 1})`);
      generated = await requestDigestFromOpenAI(digestMeta, selectedPosts);
    } catch (error) {
      console.warn(`[build-digests] fallback for ${monthKey}: ${error.message}`);
    }

    const items = mergeGeneratedItems(selectedPosts, generated);

    digests.push({
      ...digestMeta,
      title: generated?.title || digestMeta.title,
      count: items.length,
      items,
    });

    const partialPayload = {
      generatedAt: new Date().toISOString(),
      latestKey: digests[digests.length - 1]?.key || null,
      digests: [...digests].sort((left, right) => right.key.localeCompare(left.key)),
    };
    await fs.writeFile(DIGESTS_PATH, `${JSON.stringify(partialPayload, null, 2)}\n`, "utf8");
  }

  digests.sort((left, right) => right.key.localeCompare(left.key));

  const payload = {
    generatedAt: new Date().toISOString(),
    latestKey: digests[0]?.key || null,
    digests,
  };

  await fs.writeFile(DIGESTS_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildDigests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
