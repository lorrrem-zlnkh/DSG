import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { buildDigests, DIGEST_SIZE } from "./build-digests.mjs";
import { fetchBlogPosts, fetchUrlsAsPosts } from "./fetch-blog.mjs";
import { requestStructured } from "./lib/llm.mjs";
import { loadEnv } from "./lib/load-env.mjs";

loadEnv();

const STATUS_PATH = new URL("../public/automation/status.json", import.meta.url);
const LOCK_PATH = new URL("../.cache/content-automation.lock", import.meta.url);
const DRAFT_POSTS_PATH = new URL("../.cache/draft/posts.json", import.meta.url);
const DRAFT_DIGESTS_PATH = new URL("../.cache/draft/digests.json", import.meta.url);

const BOT_URL = process.env.BOT_INIT_URL || "https://dsg.lorrrem.ru/bot/webhook.php";

// Месяц дайджеста = предыдущий календарный; DIGEST_MONTH (YYYY-MM) переопределяет
// для тестового прогона (например текущий месяц).
function digestMonthKey() {
  const override = (process.env.DIGEST_MONTH || "").trim();
  if (/^\d{4}-\d{2}$/.test(override)) return override;
  const now = new Date();
  const lm = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${lm.getUTCFullYear()}-${String(lm.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Забор присланных ссылок из пула за месяц дайджеста (идемпотентно на стороне бота).
// При недоступности/отсутствии секрета — пустой пул (штатная авто-сборка).
async function consumePoolUrls() {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return [];
  try {
    const month = digestMonthKey();
    // Тестовый прогон (DIGEST_MONTH задан) — dry: смотрим выбор, не «съедаем» пул.
    const dry = /^\d{4}-\d{2}$/.test((process.env.DIGEST_MONTH || "").trim()) ? "&dry=1" : "";
    const res = await fetch(`${BOT_URL}?action=pool_consume&month=${month}${dry}`, {
      method: "POST",
      headers: { "X-Bot-Secret": secret },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.selected || []).map((s) => s.url).filter(Boolean);
  } catch {
    return [];
  }
}

// Вариант 2: нейтральный рерайт присланных материалов до сборки — тема ЛЮБАЯ,
// чтобы дизайн-промпт не «ронял» офф-топик в шаблон. Результат кладём в
// summary/rewrite/rubric поста (build-digests их сохраняет для «Подборки»).
// Best-effort: при сбое оставляем то, что распарсилось из статьи.
const MANUAL_REWRITE_SYSTEM =
  "Ты редактор подборки материалов. Перескажи присланную статью РОВНО в 3 связных " +
  "предложениях на русском, нейтральным редакторским тоном, строго по сути материала — " +
  "тема может быть любой (не обязательно про дизайн). Начинай сразу с тезиса, без слов " +
  "«Статья», «В статье», «Автор», «Материал», «В этом выпуске»; без воды вроде «будет " +
  "полезен тем, кто» и «полезный ресурс». Также дай короткую рубрику из 1–2 слов по теме.";

const MANUAL_REWRITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "rubric"],
  properties: { summary: { type: "string" }, rubric: { type: "string" } },
};

export async function rewriteManualPosts(posts) {
  for (const post of posts) {
    const text = (post.rewrite || post.summary || post.title || "").slice(0, 6000);
    if (!text) continue;
    try {
      const out = await requestStructured({
        system: MANUAL_REWRITE_SYSTEM,
        user: JSON.stringify({ title: post.title || "", text }, null, 2),
        schema: MANUAL_REWRITE_SCHEMA,
        schemaName: "manual_rewrite",
        maxTokens: 1000,
      });
      if (out && typeof out.summary === "string" && out.summary.trim()) {
        post.summary = out.summary.trim();
        post.rewrite = out.summary.trim();
        if (out.rubric && typeof out.rubric === "string") post.rubric = out.rubric.trim();
      }
    } catch (error) {
      console.warn(`[automation] нейтральный рерайт не удался для ${post.url}: ${error.message}`);
    }
  }
  return posts;
}

let inProcessRun = null;

async function writeStatus(status) {
  await fs.mkdir(new URL(".", STATUS_PATH), { recursive: true });
  await fs.writeFile(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

async function readStatus() {
  try {
    return JSON.parse(await fs.readFile(STATUS_PATH, "utf8"));
  } catch {
    return {
      ok: null,
      state: "never_run",
      updatedAt: null,
    };
  }
}

async function acquireLock() {
  await fs.mkdir(new URL(".", LOCK_PATH), { recursive: true });
  try {
    const handle = await fs.open(LOCK_PATH, "wx");
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      })
    );
    await handle.close();
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

async function releaseLock() {
  try {
    await fs.unlink(LOCK_PATH);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function publicSummary(postsPayload, digestsPayload) {
  return {
    posts: Array.isArray(postsPayload.posts) ? postsPayload.posts.length : 0,
    digests: Array.isArray(digestsPayload.digests) ? digestsPayload.digests.length : 0,
    latestKey: digestsPayload.latestKey || null,
  };
}

async function runWithLock() {
  const locked = await acquireLock();
  if (!locked) {
    const status = await readStatus();
    return {
      ok: false,
      state: "already_running",
      status,
    };
  }

  const startedAt = new Date().toISOString();
  await writeStatus({
    ok: null,
    state: "running",
    startedAt,
    updatedAt: startedAt,
  });

  try {
    // Присланные ссылки — приоритет; занимают слоты выпуска (≤ DIGEST_SIZE).
    const poolUrls = await consumePoolUrls();
    const manualPosts = poolUrls.length ? await fetchUrlsAsPosts(poolUrls) : [];
    if (manualPosts.length) await rewriteManualPosts(manualPosts); // V2: нейтральный рерайт
    console.log(`[automation] присланных ссылок в пуле: ${manualPosts.length}`);

    let postsPayload;
    if (manualPosts.length >= DIGEST_SIZE) {
      // Правило #3: если присланных ≥ DIGEST_SIZE — парсинг источников не запускаем.
      console.log("[automation] пул заполнил выпуск — пропускаю парсинг источников");
      postsPayload = { generatedAt: new Date().toISOString(), posts: manualPosts };
      await fs.mkdir(new URL(".", DRAFT_POSTS_PATH), { recursive: true });
      await fs.writeFile(DRAFT_POSTS_PATH, `${JSON.stringify(postsPayload, null, 2)}\n`, "utf8");
    } else {
      postsPayload = await fetchBlogPosts({ outPath: DRAFT_POSTS_PATH });
    }

    const digestsPayload = await buildDigests({
      postsPath: DRAFT_POSTS_PATH,
      digestsPath: DRAFT_DIGESTS_PATH,
      manualPosts,
      targetMonth: (process.env.DIGEST_MONTH || "").trim() || null,
    });
    const finishedAt = new Date().toISOString();
    const status = {
      ok: true,
      state: "draft_ready",
      startedAt,
      finishedAt,
      updatedAt: finishedAt,
      ...publicSummary(postsPayload, digestsPayload),
    };
    await writeStatus(status);
    return status;
  } catch (error) {
    const failedAt = new Date().toISOString();
    const status = {
      ok: false,
      state: "failed",
      startedAt,
      failedAt,
      updatedAt: failedAt,
      error: error.message,
    };
    await writeStatus(status);
    throw error;
  } finally {
    await releaseLock();
  }
}

export async function getContentAutomationStatus() {
  return readStatus();
}

export async function runContentAutomation() {
  if (!inProcessRun) {
    inProcessRun = runWithLock().finally(() => {
      inProcessRun = null;
    });
  }
  return inProcessRun;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runContentAutomation()
    .then((status) => {
      console.log(JSON.stringify(status, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
