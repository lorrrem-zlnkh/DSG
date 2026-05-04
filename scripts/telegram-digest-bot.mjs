import { exec as execCallback } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

import { loadEnv } from "./lib/load-env.mjs";

loadEnv();

const exec = promisify(execCallback);

const DIGESTS_PATH = new URL("../public/blog/digests.json", import.meta.url);
const STATE_PATH = new URL("../.cache/telegram-digest-bot-state.json", import.meta.url);
const TELEGRAM_API_BASE = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const POLL_INTERVAL_MS = Number(process.env.DIGEST_BOT_POLL_INTERVAL_MS || 3_000);
const REVIEW_DAY = Number(process.env.DIGEST_REVIEW_DAY || 1);
const REVIEW_HOUR = Number(process.env.DIGEST_REVIEW_HOUR || 10);
const SITE_URL = String(process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
const SITE_PUBLISH_URL = process.env.DIGEST_SITE_PUBLISH_URL || "";
const SITE_PUBLISH_TOKEN = process.env.DIGEST_SITE_PUBLISH_TOKEN || process.env.CONTENT_AUTOMATION_TOKEN || "";
const SITE_PUBLISH_COMMAND = process.env.DIGEST_SITE_PUBLISH_COMMAND || "";

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`${name} is required`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function chunkMessages(lines, limit = 3600) {
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, payload) {
  await fs.mkdir(new URL(".", path), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readState() {
  return readJson(STATE_PATH, {
    updateOffset: 0,
    reviews: {},
    latestReviewKey: null,
    lastScheduledReviewKey: null,
  });
}

async function writeState(state) {
  await writeJson(STATE_PATH, state);
}

async function readDigests() {
  return readJson(DIGESTS_PATH, { digests: [] });
}

function digestUrl(digest) {
  if (!SITE_URL || !digest) return "";
  return `${SITE_URL}/blog/?year=${digest.year}&month=${digest.month}`;
}

function reviewKey(digest) {
  return digest ? digest.key : null;
}

function normalizeChatId(value) {
  return String(value || "").trim();
}

function isAdminChat(chatId) {
  const allowed = normalizeChatId(process.env.TELEGRAM_ADMIN_CHAT_ID);
  return allowed && normalizeChatId(chatId) === allowed;
}

async function telegram(method, payload = {}) {
  const response = await fetch(`${TELEGRAM_API_BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(`Telegram ${method} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.result;
}

async function sendAdmin(text, options = {}) {
  return telegram("sendMessage", {
    chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...options,
  });
}

async function answerCallback(callbackQueryId, text = "") {
  return telegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  });
}

function createReviewFromDigest(digest) {
  const statuses = {};
  for (const item of digest.items || []) {
    statuses[item.id] = {
      state: "ready",
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    key: reviewKey(digest),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    publishedAt: null,
    digest,
    statuses,
  };
}

async function getOrCreateReview(state, requestedKey = null) {
  const payload = await readDigests();
  const digest =
    (payload.digests || []).find((item) => item.key === requestedKey) ||
    (payload.digests || []).find((item) => item.key === payload.latestKey) ||
    payload.digests?.[0];

  if (!digest) throw new Error("В digests.json нет выпусков");

  const key = reviewKey(digest);
  if (!state.reviews[key]) {
    state.reviews[key] = createReviewFromDigest(digest);
  } else {
    const current = state.reviews[key];
    state.reviews[key] = {
      ...current,
      digest,
      updatedAt: new Date().toISOString(),
      statuses: {
        ...Object.fromEntries((digest.items || []).map((item) => [item.id, { state: "ready" }])),
        ...current.statuses,
      },
    };
  }

  state.latestReviewKey = key;
  await writeState(state);
  return state.reviews[key];
}

function itemStatus(review, item) {
  return review.statuses?.[item.id]?.state || "ready";
}

function reworkItems(review) {
  return (review.digest.items || []).filter((item) => itemStatus(review, item) === "rework");
}

function reviewSummary(review) {
  const digest = review.digest;
  const rework = reworkItems(review);
  const url = digestUrl(digest);
  return [
    `<b>${htmlEscape(digest.title || `Выпуск ${digest.key}`)}</b>`,
    `${htmlEscape(digest.monthLabel)}, ${digest.year} · ${digest.count || digest.items?.length || 0} материалов`,
    rework.length ? `В доработке: ${rework.length}` : "Все материалы готовы к публикации",
    url ? `<a href="${htmlEscape(url)}">Открыть на сайте</a>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function reviewControls(review) {
  return {
    inline_keyboard: [
      [
        { text: "Опубликовать", callback_data: `publish:${review.key}` },
        { text: "Статус", callback_data: `status:${review.key}` },
      ],
    ],
  };
}

function itemControls(review, item) {
  const status = itemStatus(review, item);
  return {
    inline_keyboard: [
      [
        {
          text: status === "rework" ? "Снять доработку" : "В доработку",
          callback_data: `${status === "rework" ? "ready" : "rework"}:${review.key}:${item.id}`,
        },
      ],
    ],
  };
}

async function sendReview(review) {
  await sendAdmin(reviewSummary(review), { reply_markup: reviewControls(review) });

  for (const [index, item] of (review.digest.items || []).entries()) {
    const label = item.languageBadge ? ` · ${htmlEscape(item.languageBadge)}` : "";
    const text = [
      `<b>${index + 1}. ${htmlEscape(item.sourceTitle)}</b>`,
      `${htmlEscape(item.rubric)} · ${htmlEscape(item.source)}${label}`,
      htmlEscape(item.summary),
      `<a href="${htmlEscape(item.url)}">Открыть статью</a>`,
    ].join("\n");
    await sendAdmin(text, { reply_markup: itemControls(review, item) });
    await sleep(70);
  }
}

async function sendStatus(review) {
  const rework = reworkItems(review);
  if (rework.length === 0) {
    await sendAdmin(`${reviewSummary(review)}\n\nНет статей в доработке.`, {
      reply_markup: reviewControls(review),
    });
    return;
  }

  const lines = [
    reviewSummary(review),
    "",
    "<b>Статьи в доработке:</b>",
    ...rework.map((item, index) => `${index + 1}. ${htmlEscape(item.sourceTitle)} — ${htmlEscape(item.url)}`),
  ];
  for (const chunk of chunkMessages(lines)) {
    await sendAdmin(chunk, { reply_markup: reviewControls(review) });
  }
}

async function mergeDigestToPublic(review) {
  const payload = await readDigests();
  const digests = payload.digests || [];
  const nextDigest = {
    ...review.digest,
    count: review.digest.items?.length || review.digest.count || 0,
  };
  const existingIndex = digests.findIndex((digest) => digest.key === nextDigest.key);
  if (existingIndex >= 0) {
    digests[existingIndex] = nextDigest;
  } else {
    digests.push(nextDigest);
  }
  digests.sort((left, right) => right.key.localeCompare(left.key));

  await writeJson(DIGESTS_PATH, {
    ...payload,
    generatedAt: new Date().toISOString(),
    latestKey: digests[0]?.key || nextDigest.key,
    digests,
  });
}

async function publishSite(review) {
  await mergeDigestToPublic(review);

  if (SITE_PUBLISH_URL) {
    const headers = SITE_PUBLISH_TOKEN ? { "x-automation-token": SITE_PUBLISH_TOKEN } : {};
    const response = await fetch(SITE_PUBLISH_URL, { method: "POST", headers });
    if (!response.ok) {
      throw new Error(`Site publish webhook failed: ${response.status} ${await response.text()}`);
    }
    return "webhook";
  }

  if (SITE_PUBLISH_COMMAND) {
    await exec(SITE_PUBLISH_COMMAND, {
      cwd: new URL("..", import.meta.url),
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    return "command";
  }

  return "files";
}

function channelDigestMessages(review) {
  const digest = review.digest;
  const url = digestUrl(digest);
  const header = [
    `<b>${htmlEscape(digest.title || `Дайджест ${digest.key}`)}</b>`,
    `${htmlEscape(digest.monthLabel)}, ${digest.year}`,
    url ? `<a href="${htmlEscape(url)}">Полный выпуск на сайте</a>` : "",
    "",
  ].filter(Boolean);

  const itemLines = (digest.items || []).map((item, index) => {
    const title = htmlEscape(item.sourceTitle);
    const href = htmlEscape(item.url);
    return `${index + 1}. <a href="${href}">${title}</a> — ${htmlEscape(item.summary)}`;
  });

  return chunkMessages([...header, ...itemLines], 3600);
}

async function publishChannel(review) {
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!channelId) return false;

  const messages = channelDigestMessages(review);
  for (const text of messages) {
    await telegram("sendMessage", {
      chat_id: channelId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    await sleep(400);
  }

  return true;
}

async function publishReview(state, key, force = false) {
  const review = state.reviews[key];
  if (!review) throw new Error("Черновик не найден");

  const blocked = reworkItems(review);
  if (blocked.length > 0 && !force) {
    await sendStatus(review);
    await sendAdmin("Публикация остановлена: есть статьи в доработке. Используй /publish_force, если нужно опубликовать принудительно.");
    return;
  }

  const siteMode = await publishSite(review);
  const channelPublished = await publishChannel(review);
  review.publishedAt = new Date().toISOString();
  review.updatedAt = review.publishedAt;
  await writeState(state);

  await sendAdmin(
    [
      "Дайджест опубликован.",
      `Сайт: ${siteMode}`,
      `Telegram-канал: ${channelPublished ? "отправлен" : "не настроен TELEGRAM_CHANNEL_ID"}`,
    ].join("\n")
  );
}

function parseCommand(text) {
  const [command, ...args] = String(text || "").trim().split(/\s+/);
  return {
    command: command?.replace(/@\w+$/, ""),
    args,
  };
}

async function handleCommand(message) {
  if (!isAdminChat(message.chat.id)) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: "Этот бот принимает команды только от владельца.",
    });
    return;
  }

  const state = await readState();
  const { command, args } = parseCommand(message.text);

  if (command === "/start" || command === "/help") {
    await sendAdmin(
      [
        "<b>Команды дайджест-бота</b>",
        "/draft — прислать последний выпуск на вычитку",
        "/draft 2026-04 — прислать конкретный выпуск",
        "/status — показать статьи в доработке",
        "/publish — опубликовать после вычитки",
        "/publish_force — опубликовать, даже если есть доработка",
      ].join("\n")
    );
    return;
  }

  if (command === "/draft") {
    const review = await getOrCreateReview(state, args[0] || null);
    await sendReview(review);
    return;
  }

  if (command === "/status") {
    const key = args[0] || state.latestReviewKey;
    if (!key || !state.reviews[key]) {
      await sendAdmin("Черновик не найден. Сначала используй /draft.");
      return;
    }
    await sendStatus(state.reviews[key]);
    return;
  }

  if (command === "/publish" || command === "/publish_force") {
    const key = args[0] || state.latestReviewKey;
    if (!key) {
      await sendAdmin("Черновик не найден. Сначала используй /draft.");
      return;
    }
    await publishReview(state, key, command === "/publish_force");
    return;
  }

  await sendAdmin("Неизвестная команда. Используй /help.");
}

async function handleCallback(callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  if (!isAdminChat(chatId)) {
    await answerCallback(callbackQuery.id, "Нет доступа");
    return;
  }

  const state = await readState();
  const [action, key, itemId] = String(callbackQuery.data || "").split(":");
  const review = state.reviews[key];
  if (!review) {
    await answerCallback(callbackQuery.id, "Черновик не найден");
    return;
  }

  if (action === "rework" || action === "ready") {
    const item = (review.digest.items || []).find((entry) => entry.id === itemId);
    if (!item) {
      await answerCallback(callbackQuery.id, "Статья не найдена");
      return;
    }
    review.statuses[item.id] = {
      state: action === "rework" ? "rework" : "ready",
      updatedAt: new Date().toISOString(),
    };
    review.updatedAt = new Date().toISOString();
    await writeState(state);
    await telegram("editMessageReplyMarkup", {
      chat_id: callbackQuery.message.chat.id,
      message_id: callbackQuery.message.message_id,
      reply_markup: itemControls(review, item),
    });
    await answerCallback(callbackQuery.id, action === "rework" ? "Добавлено в доработку" : "Снято с доработки");
    return;
  }

  if (action === "status") {
    await answerCallback(callbackQuery.id);
    await sendStatus(review);
    return;
  }

  if (action === "publish") {
    await answerCallback(callbackQuery.id, "Публикую");
    await publishReview(state, key, false);
  }
}

async function pollUpdates() {
  const state = await readState();
  const updates = await telegram("getUpdates", {
    offset: state.updateOffset || 0,
    timeout: 25,
    allowed_updates: ["message", "callback_query"],
  });

  for (const update of updates) {
    state.updateOffset = update.update_id + 1;
    await writeState(state);
    try {
      if (update.message?.text) await handleCommand(update.message);
      if (update.callback_query) await handleCallback(update.callback_query);
    } catch (error) {
      console.error(error);
      await sendAdmin(`Ошибка: ${htmlEscape(error.message)}`).catch(() => {});
    }
  }
}

async function maybeSendScheduledReview() {
  const now = new Date();
  if (now.getDate() !== REVIEW_DAY || now.getHours() !== REVIEW_HOUR) return;

  const state = await readState();
  const payload = await readDigests();
  const digest = (payload.digests || []).find((item) => item.key === payload.latestKey) || payload.digests?.[0];
  const key = reviewKey(digest);
  if (!key || state.lastScheduledReviewKey === key) return;

  const review = await getOrCreateReview(state, key);
  state.lastScheduledReviewKey = key;
  await writeState(state);
  await sendReview(review);
}

async function main() {
  requireEnv("TELEGRAM_BOT_TOKEN");
  requireEnv("TELEGRAM_ADMIN_CHAT_ID");

  console.log("Telegram digest bot started");
  while (true) {
    try {
      await maybeSendScheduledReview();
      await pollUpdates();
    } catch (error) {
      console.error(error);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
