import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isBlockedBlogPost } from "./lib/blog-quality.mjs";
import { loadEnv } from "./lib/load-env.mjs";

loadEnv();

const DEFAULT_POSTS_PATH = new URL("../public/blog/posts.json", import.meta.url);
const DEFAULT_DIGESTS_PATH = new URL("../public/blog/digests.json", import.meta.url);

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

const DIGEST_SIZE = 35;
const MONTHLY_BASE_SIZE = 31;
const MIN_HISTORICAL_DIGEST_SIZE = 20;
const HISTORICAL_SELECTION_TARGET = 20;
const EVERGREEN_PER_SOURCE = 2;
const EVERGREEN_SOURCES = new Set(["bureau", "kovodstvo"]);
const FLOATING_SOURCES = new Set(["typejournal", "tilda-education", "alistapart", "apple-design"]);
const FIRST_DIGEST_YEAR = 2024;
const FIRST_DIGEST_MONTH = 1;
const DEFAULT_MODEL = process.env.OPENAI_DIGEST_MODEL || "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = 180_000;

function isHistoricalDigestKey(digestMonthKey) {
  return /^202[45]-/.test(digestMonthKey);
}

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function monthKeyFromDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
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

function hasRussianText(text) {
  return /[А-Яа-яЁё]/.test(String(text || ""));
}

function sentenceCount(text) {
  return (String(text || "").match(/[.!?…](?=\s|$)/g) || []).length;
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|yclid|ref$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(value || "").trim().toLowerCase().replace(/\/$/, "");
  }
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+[-—]\s+(дизайнерс|habr|medium)$/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSourceTitle(value) {
  return String(value || "")
    .replace(/\s+[-—]\s*дизайнерс\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function articleKey(post) {
  const url = normalizeUrl(post.url);
  if (url) return `url:${url}`;
  return `title:${normalizeTitle(post.title)}`;
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededShuffle(items, seed) {
  const result = [...items];
  let state = hashString(seed) || 1;
  const next = () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(next() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function spreadSources(items, seed) {
  const grouped = new Map();
  for (const item of seededShuffle(items, `${seed}:spread-input`)) {
    const source = item.source || "unknown";
    const sourceItems = grouped.get(source) || [];
    sourceItems.push(item);
    grouped.set(source, sourceItems);
  }

  const result = [];
  let previousSource = null;
  while (grouped.size > 0) {
    const candidates = [...grouped.entries()]
      .filter(([source]) => source !== previousSource || grouped.size === 1)
      .sort((left, right) => {
        if (right[1].length !== left[1].length) return right[1].length - left[1].length;
        return hashString(`${seed}:${left[0]}`) - hashString(`${seed}:${right[0]}`);
      });
    const [source, sourceItems] = candidates[0];
    result.push(sourceItems.shift());
    previousSource = source;
    if (sourceItems.length === 0) grouped.delete(source);
  }

  return result;
}

const HABR_PREFIX_LABELS = [
  "Управление продуктом",
  "Управление персоналом",
  "Искусственный интеллект",
  "Карьера в IT-индустрии",
  "Учебный процесс в IT",
  "Развитие стартапа",
  "Читальный зал",
  "Дизайн мобильных приложений",
  "мобильных приложений",
  "CRM-системы",
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

function removeLeadingSourceTitle(text, title) {
  const value = String(text || "");
  const titleValue = cleanSourceTitle(title);
  if (!titleValue) return value;
  const index = value.toLowerCase().indexOf(titleValue.toLowerCase());
  if (index < 0 || index > 320) return value;
  return value.slice(index + titleValue.length);
}

function sanitizeDigestText(text, title = "") {
  const cleaned = stripLeadingHabrTaxonomy(removeLeadingSourceTitle(String(text || ""), title))
    .replace(/Continue reading on [^.»]+[».]?/gi, " ")
    .replace(/\bAbout Me\b[\s—-]*/gi, " ")
    .replace(/Краткая суть:\s*/gi, "")
    .replace(/^[\s\S]{0,240}?Привет,\s*Хабр[!.]?\s*/i, " ")
    .replace(/^Цитаты из книги[\s\S]{0,500}?(?:Привет[!.]?\s*)?/i, " ")
    .replace(/^(?:Приветствую|Привет)[!.]?\s*/i, " ")
    .replace(/^(?:Меня зовут|Я основатель|Я [^.!?…]{1,80}(?:дизайнер|разработчик|директор|основатель))[^.!?…]*[.!?…]\s*/i, " ")
    .replace(/^[A-Za-zА-Яа-я0-9_.-]{2,40}(?:сегодня|вчера|\d{1,2}\s+[а-яё]{3,8}\s+в\s+\d{1,2}:\d{2}|\d+\s+(?:час|часа|часов|мин|минут)[а-яё]*)/i, " ")
    .replace(/Уровень сложности\s*(?:Простой|Средний|Сложный)?/gi, " ")
    .replace(/Время на прочтение\s*\d+\s*мин(?:ут[а-яё]*)?/gi, " ")
    .replace(/Охват и читатели\s*[\d.,]+\s*[KК]?/gi, " ")
    .replace(/Всего голосов[\s\S]{0,180}?(?:Комментарии\d+|Поделиться|Добавить в закладки\d*)/gi, " ")
    .replace(/^(?:Иконки приложений\s*)?(?:Цвет|Пятно|Сюжет\s*\d*){2,}\s*/i, " ")
    .replace(/^(?:Иконки приложений\s*Цвет\s*Пятно\s*Сюжет\s*1?\s*Сюжет\s*2\s*)+/i, " ")
    .replace(/—\s*дизайнерс[\s\S]*?Подписаться/gi, " ")
    .replace(/Написать\s+Войти[\s\S]*?Все права защищены/gi, " ")
    .replace(/Лента\s+Рейтинг\s+Подписки\s+Избранное[\s\S]*?Все права защищены/gi, " ")
    .replace(/©\s*\d{4}[-–]\d{4}\s*Все права защищены/gi, " ")
    .replace(/\bContinue reading\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripLeadingHabrTaxonomy(cleaned).trim();
}

function isWeakDigestText(text, title = "") {
  const value = sanitizeDigestText(text, title);
  if (!value) return true;
  if (value.length < 80) return true;
  if (/^[-—–\s.]+$/.test(value)) return true;
  if (/^(about me|continue reading)/i.test(value)) return true;
  if (/^[А-ЯЁ][а-яё-]{2,24}!\s*/.test(value)) return true;
  if (/(Написать\s+Войти|Лента\s+Рейтинг|Все права защищены|Подписаться\s+Подписаться)/i.test(value))
    return true;
  if (/(Medium\s*»|Member-only story|Sign in to Medium)/i.test(value)) return true;
  if (/(Уровень сложности|Время на прочтение|Охват и читатели)/i.test(value)) return true;
  if (/(привет,\s*хабр|привет!\s*я\s+|я\s+основатель|меня\s+зовут)/i.test(value)) return true;
  if (/^(сначала приведу примеры|я прош[её]л курс|когда я увидел|из своей практики)/i.test(value))
    return true;
  if (/^[А-ЯЁ][а-яё-]{2,24},\s+(?:это|этот|вы|я|мне|тут|к сожалению|допустим)\b/i.test(value))
    return true;
  if (/(ответ будет «?не знаю|вы верно пишете|договориться тут не выйдет)/i.test(value)) return true;
  if (/(ИИ в проектах по визуализации, часть 2\s+Сколько дизайнеров звать|Хочется визуально выделить данные.+Как вы работаете над чужими книгами)/i.test(value))
    return true;
  if (/Иконки приложений\s*Цвет\s*Пятно\s*Сюжет/i.test(value)) return true;
  if (/[а-яё][.!?…][А-ЯЁA-Z]/.test(value)) return true;
  if (/[а-яё][A-Z][a-z]+|[a-z][А-ЯЁа-яё]/.test(value)) return true;
  if (/\b(?:Insights|Audience|Crime map)\b/.test(value)) return true;
  if (/(РобототехникаБудущее|Карьера в IT-индустрииМнение|ДизайнУправление продуктом|Из песочницыБольшинство|Искусственный интеллектРазвитие стартапа|Elixir\/Phoenix\s*\*\s*Forth)/i.test(value))
    return true;
  return false;
}

function isGoodSummary(text, title = "") {
  const value = sanitizeDigestText(text, title);
  if (isWeakDigestText(value, title)) return false;
  if (!hasRussianText(value)) return false;
  if (sentenceCount(value) < 2) return false;
  return true;
}

function pickSummarySentences(text, title = "") {
  return sanitizeDigestText(text, title)
    .split(/(?<=[.!?…])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => hasRussianText(sentence) && sentence.length >= 45 && sentence.length <= 260)
    .filter((sentence) => !/^[А-ЯЁ][а-яё-]{2,24}!\s*/.test(sentence))
    .filter((sentence) => !/[а-яё][.!?…][А-ЯЁA-Z]/.test(sentence))
    .filter((sentence) => !/[а-яё][A-Z][a-z]+|[a-z][А-ЯЁа-яё]/.test(sentence))
    .filter((sentence) => !/(привет,\s*хабр|привет!\s*я\s+|я\s+основатель|меня\s+зовут|сначала приведу примеры|я прош[её]л курс|иконки приложений\s*цвет\s*пятно\s*сюжет|уровень сложности|время на прочтение|охват и читатели|ответ будет «?не знаю|вы верно пишете|договориться тут не выйдет)/i.test(sentence))
    .slice(0, 3)
    .join(" ");
}

function buildFallbackSummary(post) {
  const fromRewrite = pickSummarySentences(post.rewrite || "", post.title);
  if (isGoodSummary(fromRewrite, post.title)) return fromRewrite;
  const fromSummary = pickSummarySentences(post.summary || "", post.title);
  if (isGoodSummary(fromSummary, post.title)) return fromSummary;
  const title = cleanSourceTitle(post.title || "материала");
  return `Материал разбирает тему «${title}» в контексте продуктового дизайна и цифровых интерфейсов. В карточке оставлена краткая редакторская выжимка без служебных данных, навигации и метаданных источника. Оригинальная публикация помогает подробнее изучить подход автора и понять, насколько тема применима в работе.`;
}

function hasGenericFallback(items) {
  return items.some((item) => /^Материал разбирает тему «/.test(item.summary || ""));
}

function fallbackDigestItem(post) {
  const summary = buildFallbackSummary(post);
  return {
    id: post.id,
    url: post.url,
    sourceTitle: cleanSourceTitle(post.title),
    summary,
    excerpt: "",
    rubric: inferRubric(post),
    author: post.author || "Автор не указан",
    source: post.sourceLabel || post.source,
    publishedAt: post.publishedAt || null,
    languageBadge: looksEnglish(`${post.title} ${post.summary}`) ? "Eng" : null,
  };
}

function selectMonthlyPosts(posts, digestMonthKey, usedDigestKeys) {
  const bySource = new Map();
  const seen = new Set();

  for (const post of posts) {
    const date = normalizeDate(post.publishedAt);
    if (!date || monthKeyFromDate(date) !== digestMonthKey) continue;
    const keyed = { ...post, _date: date };
    const key = articleKey(keyed);
    if (seen.has(key) || usedDigestKeys.has(key)) continue;
    seen.add(key);
    const sourcePosts = bySource.get(keyed.source) || [];
    sourcePosts.push(keyed);
    bySource.set(keyed.source, sourcePosts);
  }

  const selected = [];
  const sourceQueues = [...bySource.entries()]
    .map(([source, sourcePosts]) => [
      source,
      sourcePosts.sort((left, right) => {
        const leftTime = left._date ? left._date.getTime() : 0;
        const rightTime = right._date ? right._date.getTime() : 0;
        if (leftTime !== rightTime) return rightTime - leftTime;
        return String(left.title || "").localeCompare(String(right.title || ""), "ru");
      }),
    ])
    .filter(([, sourcePosts]) => sourcePosts.length > 0)
    .sort(([leftSource], [rightSource]) => leftSource.localeCompare(rightSource));

  let added = true;
  while (selected.length < MONTHLY_BASE_SIZE && added) {
    added = false;
    for (const [, sourcePosts] of sourceQueues) {
      if (selected.length >= MONTHLY_BASE_SIZE) break;
      const next = sourcePosts.shift();
      if (!next) continue;
      selected.push(next);
      added = true;
    }
  }

  return selected.slice(0, MONTHLY_BASE_SIZE);
}

function selectEvergreenPosts(posts, source, usedKeys, usedDigestKeys, digestMonthKey) {
  const candidates = posts
    .filter((post) => post.source === source)
    .filter((post) => !normalizeDate(post.publishedAt))
    .filter((post) => !usedDigestKeys.has(articleKey(post)))
    .filter((post) => !usedKeys.has(articleKey(post)));

  const selected = [];
  for (const post of seededShuffle(candidates, `${digestMonthKey}:${source}`)) {
    const key = articleKey(post);
    if (usedKeys.has(key)) continue;
    selected.push({ ...post, _date: normalizeDate(post.publishedAt) || new Date(0) });
    usedKeys.add(key);
    if (selected.length >= EVERGREEN_PER_SOURCE) break;
  }

  return selected;
}

function selectFloatingPosts(posts, usedKeys, usedDigestKeys, selectedKeys, digestMonthKey, limit) {
  if (limit <= 0) return [];
  const candidates = posts
    .filter((post) => FLOATING_SOURCES.has(post.source))
    .filter((post) => !normalizeDate(post.publishedAt))
    .filter((post) => !usedDigestKeys.has(articleKey(post)) && !selectedKeys.has(articleKey(post)))
    .filter((post) => !usedKeys.has(articleKey(post)));

  const selected = [];
  for (const post of seededShuffle(candidates, `${digestMonthKey}:floating`)) {
    const key = articleKey(post);
    if (usedKeys.has(key) || usedDigestKeys.has(key) || selectedKeys.has(key)) continue;
    selected.push({ ...post, _date: new Date(0) });
    usedKeys.add(key);
    if (selected.length >= limit) break;
  }

  return selected;
}

function selectYearFillPosts(posts, usedKeys, usedDigestKeys, selectedKeys, digestMonthKey, limit) {
  if (limit <= 0) return [];
  const year = digestMonthKey.slice(0, 4);
  const candidates = posts
    .filter((post) => {
      const date = normalizeDate(post.publishedAt);
      return (
        date &&
        String(date.getUTCFullYear()) === year &&
        monthKeyFromDate(date) !== digestMonthKey &&
        monthKeyFromDate(date) < digestMonthKey
      );
    })
    .filter((post) => !usedKeys.has(articleKey(post)) && !usedDigestKeys.has(articleKey(post)) && !selectedKeys.has(articleKey(post)));

  const selected = [];
  for (const post of seededShuffle(candidates, `${digestMonthKey}:year-fill`)) {
    const key = articleKey(post);
    if (usedKeys.has(key) || usedDigestKeys.has(key) || selectedKeys.has(key)) continue;
    selected.push({ ...post, _date: normalizeDate(post.publishedAt) || new Date(0) });
    usedKeys.add(key);
    if (selected.length >= limit) break;
  }

  return selected;
}

function selectReservePosts(posts, usedDigestKeys, selectedKeys, digestMonthKey, limit) {
  if (limit <= 0) return [];
  const candidates = posts
    .filter((post) => !normalizeDate(post.publishedAt))
    .filter((post) => !usedDigestKeys.has(articleKey(post)) && !selectedKeys.has(articleKey(post)));

  const selected = [];
  for (const post of seededShuffle(candidates, `${digestMonthKey}:reserve-fill`)) {
    const key = articleKey(post);
    if (usedDigestKeys.has(key) || selectedKeys.has(key)) continue;
    selected.push({ ...post, _date: new Date(0) });
    selectedKeys.add(key);
    if (selected.length >= limit) break;
  }

  return selected;
}

function selectDigestPosts(posts, digestMonthKey, usedEvergreenKeys, usedFloatingKeys, usedYearFillKeys, usedDigestKeys) {
  const monthlyPosts = selectMonthlyPosts(posts, digestMonthKey, usedDigestKeys);
  const evergreenPosts = [
    ...selectEvergreenPosts(posts, "bureau", usedEvergreenKeys, usedDigestKeys, digestMonthKey),
    ...selectEvergreenPosts(posts, "kovodstvo", usedEvergreenKeys, usedDigestKeys, digestMonthKey),
  ];
  const selectedKeys = new Set([...monthlyPosts, ...evergreenPosts].map(articleKey));
  const minimumTarget = isHistoricalDigestKey(digestMonthKey) ? HISTORICAL_SELECTION_TARGET : DIGEST_SIZE;
  const yearFillPosts = selectYearFillPosts(
    posts,
    usedYearFillKeys,
    usedDigestKeys,
    selectedKeys,
    digestMonthKey,
    Math.max(0, minimumTarget - monthlyPosts.length - evergreenPosts.length)
  );
  for (const post of yearFillPosts) selectedKeys.add(articleKey(post));
  const floatingPosts = selectFloatingPosts(
    posts,
    usedFloatingKeys,
    usedDigestKeys,
    selectedKeys,
    digestMonthKey,
    Math.max(0, minimumTarget - monthlyPosts.length - evergreenPosts.length - yearFillPosts.length)
  );
  for (const post of floatingPosts) selectedKeys.add(articleKey(post));
  const reservePosts = isHistoricalDigestKey(digestMonthKey)
    ? selectReservePosts(
        posts,
        usedDigestKeys,
        selectedKeys,
        digestMonthKey,
        Math.max(
          0,
          minimumTarget -
            monthlyPosts.length -
            evergreenPosts.length -
            yearFillPosts.length -
            floatingPosts.length
        )
      )
    : [];

  const selected = seededShuffle(
    [...monthlyPosts, ...evergreenPosts, ...yearFillPosts, ...floatingPosts, ...reservePosts],
    digestMonthKey
  ).slice(0, DIGEST_SIZE);
  for (const post of selected) usedDigestKeys.add(articleKey(post));
  return selected;
}

function monthRange(fromYear, fromMonth, toYear, toMonth) {
  const months = [];
  const cursor = new Date(Date.UTC(fromYear, fromMonth - 1, 1));
  const end = new Date(Date.UTC(toYear, toMonth - 1, 1));
  while (cursor <= end) {
    months.push(monthKeyFromDate(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function takeForMonth(months, pools, usedKeys, monthKey, count) {
  const selected = months.get(monthKey) || [];
  for (const pool of pools) {
    while (selected.length < count && pool.length > 0) {
      const post = pool.shift();
      const key = articleKey(post);
      if (usedKeys.has(key)) continue;
      selected.push(post);
      usedKeys.add(key);
    }
    if (selected.length >= count) break;
  }
  months.set(monthKey, selected);
}

function buildHistoricalSelectionMap(posts) {
  const monthKeys = monthRange(2024, 1, 2025, 12);
  const selections = new Map(monthKeys.map((monthKey) => [monthKey, []]));
  const usedKeys = new Set();
  const datedByMonth = new Map();
  const historicalDatedReserve = [];
  const otherDatedReserve = [];
  const undatedReserve = [];

  for (const post of posts) {
    const key = articleKey(post);
    if (!key) continue;
    const date = normalizeDate(post.publishedAt);
    if (!date) {
      undatedReserve.push(post);
      continue;
    }

    const postMonthKey = monthKeyFromDate(date);
    if (selections.has(postMonthKey)) {
      const monthPosts = datedByMonth.get(postMonthKey) || [];
      monthPosts.push({ ...post, _date: date });
      datedByMonth.set(postMonthKey, monthPosts);
    } else {
      otherDatedReserve.push({ ...post, _date: date });
    }
  }

  for (const monthKey of monthKeys) {
    const exactPosts = (datedByMonth.get(monthKey) || []).sort((left, right) => {
      const leftTime = left._date ? left._date.getTime() : 0;
      const rightTime = right._date ? right._date.getTime() : 0;
      if (leftTime !== rightTime) return rightTime - leftTime;
      return String(left.title || "").localeCompare(String(right.title || ""), "ru");
    });
    const selected = [];
    while (selected.length < HISTORICAL_SELECTION_TARGET && exactPosts.length > 0) {
      const post = exactPosts.shift();
      const key = articleKey(post);
      if (usedKeys.has(key)) continue;
      selected.push(post);
      usedKeys.add(key);
    }
    selections.set(monthKey, selected);
    historicalDatedReserve.push(...exactPosts);
  }

  const shuffledUndated = seededShuffle(undatedReserve, "historical:undated-reserve");
  const shuffledHistoricalDated = seededShuffle(historicalDatedReserve, "historical:dated-reserve");
  const shuffledOtherDated = seededShuffle(otherDatedReserve, "historical:other-dated-reserve");

  let changed = true;
  while (changed) {
    changed = false;
    const underfilled = monthKeys
      .filter((monthKey) => (selections.get(monthKey) || []).length < HISTORICAL_SELECTION_TARGET)
      .sort((left, right) => {
        const diff = (selections.get(left) || []).length - (selections.get(right) || []).length;
        if (diff !== 0) return diff;
        return left.localeCompare(right);
      });
    for (const monthKey of underfilled) {
      const before = (selections.get(monthKey) || []).length;
      takeForMonth(
        selections,
        [shuffledUndated, shuffledHistoricalDated, shuffledOtherDated],
        usedKeys,
        monthKey,
        HISTORICAL_SELECTION_TARGET
      );
      if ((selections.get(monthKey) || []).length > before) changed = true;
    }
  }

  return new Map(
    [...selections.entries()].map(([monthKey, selectedPosts]) => [
      monthKey,
      seededShuffle(selectedPosts, `${monthKey}:historical-selection`).slice(0, DIGEST_SIZE),
    ])
  );
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
      max_output_tokens: 12000,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "Ты редактор дайджестов по продуктовому дизайну. На основе входных статей создай русскоязычный дайджест. " +
                "Не выдумывай факты и верни карточку для каждой входной статьи, кроме явно мусорных страниц без полезного содержания. " +
                "Для каждой статьи верни summary ровно из 3 связных предложений на русском языке. " +
                "summary должен кратко раскрывать суть статьи и помогать понять, стоит ли читать дальше. " +
                "excerpt оставляй пустой строкой, если summary уже раскрывает суть тремя предложениями. " +
                "Нельзя писать шаблоны вроде 'Краткая суть', 'About Me', 'Continue reading on Medium' и любые обрывки RSS. " +
                "Нельзя переносить в summary свойства статьи, дату публикации, ник автора, время чтения, уровень сложности, охват, хабы, меню или навигацию. " +
                "Не копируй вступления от первого лица вроде 'Привет, Хабр', 'Я основатель', 'Меня зовут': перепиши их редакторски от третьего лица и сократи. " +
                "Не копируй ответы с обращением к читателю или автору письма вроде 'Виктор, ...', 'Вы верно пишете': перескажи тезис нейтральным редакторским языком. " +
                "Не копируй личные вводки вроде 'Сначала приведу примеры из своей практики' или 'Я прошел курс': извлеки общий тезис и перескажи его от третьего лица. " +
                "Не делай summary списком заголовков соседних материалов; если источник является подборкой, опиши общую тему подборки связными предложениями. " +
                "Если статья с Medium или другого источника на английском или другом языке, обязательно переведи описание на русский. " +
                "Оригинальный заголовок не меняй. Для англоязычных материалов ставь languageBadge='Eng'. " +
                "Если входной текст короткий, используй доступные заголовок, описание и фрагменты, но пиши связное описание без выдуманных конкретных фактов. " +
                "Не включай статью только если текст состоит из навигации, мусора или не относится к дизайну/продуктам. " +
                "Сохраняй перемешанный порядок входного списка: не группируй статьи одного источника подряд. " +
                "Рубрика должна быть короткой: 1-2 слова. Перед финальным JSON перечитай каждое summary и перепиши заново, если в нём остался сырой фрагмент статьи или служебные данные.",
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
                    monthKey: digestMeta.key,
                    title: digestMeta.title,
                    targetItems: DIGEST_SIZE,
                    rule:
                      "Используй только статьи из входного списка: основная часть отобрана за месяц выпуска, материалы Бюро и Ководства добавлены как evergreen без повторов, материалы без даты используются только как добор без повторов.",
                  },
                  articles: posts.map((post) => ({
                    id: post.id,
                    sourceTitle: cleanSourceTitle(post.title),
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
      .filter((item) => isGoodSummary(item.summary, item.sourceTitle))
      .slice(0, DIGEST_SIZE);
  }

  const itemMap = new Map(selectedPosts.map((post) => [post.id, post]));
  const items = [];
  const seen = new Set();
  const seenArticles = new Set();

  for (const item of generated.items || []) {
    const sourcePost = itemMap.get(item.id);
    if (!sourcePost || seen.has(sourcePost.id)) continue;
    const key = articleKey(sourcePost);
    if (seenArticles.has(key)) continue;

    const cleanSummary = sanitizeDigestText(item.summary, sourcePost.title);
    const cleanExcerpt = sanitizeDigestText(item.excerpt || "", sourcePost.title);

    if (!isGoodSummary(cleanSummary, sourcePost.title)) {
      continue;
    }

    if (cleanExcerpt && (isWeakDigestText(cleanExcerpt, sourcePost.title) || !hasRussianText(cleanExcerpt))) {
      continue;
    }

    seen.add(sourcePost.id);
    seenArticles.add(key);
    items.push({
      id: sourcePost.id,
      url: sourcePost.url,
      sourceTitle: cleanSourceTitle(item.sourceTitle || sourcePost.title),
      summary: cleanSummary,
      excerpt: "",
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

  for (const post of selectedPosts) {
    if (items.length >= DIGEST_SIZE) break;
    const key = articleKey(post);
    if (seenArticles.has(key)) continue;
    const fallback = fallbackDigestItem(post);
    if (!isGoodSummary(fallback.summary, post.title)) continue;
    seenArticles.add(key);
    items.push(fallback);
  }

  return items;
}

export async function buildDigests({ postsPath = DEFAULT_POSTS_PATH, digestsPath = DEFAULT_DIGESTS_PATH } = {}) {
  const source = JSON.parse(await fs.readFile(postsPath, "utf8"));
  const now = new Date();

  const posts = (source.posts || []).filter((post) => !isBlockedBlogPost(post));
  const digests = [];
  const usedEvergreenKeys = new Set();
  const usedFloatingKeys = new Set();
  const usedYearFillKeys = new Set();
  const historicalSelections = buildHistoricalSelectionMap(posts);
  const usedDigestKeys = new Set([...historicalSelections.values()].flat().map(articleKey));
  const cursor = new Date(Date.UTC(FIRST_DIGEST_YEAR, FIRST_DIGEST_MONTH - 1, 1));
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  while (cursor <= lastMonth) {
    const monthKey = monthKeyFromDate(cursor);
    const number =
      (cursor.getUTCFullYear() - FIRST_DIGEST_YEAR) * 12 +
      (cursor.getUTCMonth() - (FIRST_DIGEST_MONTH - 1)) +
      1;
    const digestMeta = {
      key: monthKey,
      number,
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1,
      monthLabel: MONTH_NAMES[cursor.getUTCMonth()],
      title: `Выпуск №${number}`,
    };

    const selectedPosts =
      historicalSelections.get(monthKey) ||
      selectDigestPosts(posts, monthKey, usedEvergreenKeys, usedFloatingKeys, usedYearFillKeys, usedDigestKeys);
    if (selectedPosts.length === 0) {
      digests.push({
        ...digestMeta,
        count: 0,
        items: [],
      });
    } else {
      let generated = null;
      try {
        console.log(`[build-digests] generating ${monthKey} (#${digestMeta.number})`);
        generated = await requestDigestFromOpenAI(digestMeta, selectedPosts);
      } catch (error) {
        console.warn(`[build-digests] fallback for ${monthKey}: ${error.message}`);
      }

      let items = mergeGeneratedItems(selectedPosts, generated);
      if (generated && hasGenericFallback(items)) {
        try {
          console.log(`[build-digests] retrying weak summaries ${monthKey} (#${digestMeta.number})`);
          generated = await requestDigestFromOpenAI(digestMeta, selectedPosts);
          items = mergeGeneratedItems(selectedPosts, generated);
        } catch (error) {
          console.warn(`[build-digests] retry fallback for ${monthKey}: ${error.message}`);
        }
      }
      digests.push({
        ...digestMeta,
        count: items.length,
        items: spreadSources(items, `${monthKey}:items`),
      });
    }

    const partialPayload = {
      generatedAt: new Date().toISOString(),
      latestKey: digests[digests.length - 1]?.key || null,
      digests: [...digests].sort((left, right) => right.key.localeCompare(left.key)),
    };
    await fs.mkdir(new URL(".", digestsPath), { recursive: true });
    await fs.writeFile(digestsPath, `${JSON.stringify(partialPayload, null, 2)}\n`, "utf8");
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  digests.sort((left, right) => right.key.localeCompare(left.key));

  const payload = {
    generatedAt: new Date().toISOString(),
    latestKey: digests[0]?.key || null,
    digests,
  };

  await fs.mkdir(new URL(".", digestsPath), { recursive: true });
  await fs.writeFile(digestsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildDigests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
