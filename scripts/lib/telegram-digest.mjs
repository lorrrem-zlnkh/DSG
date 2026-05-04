import fs from "node:fs/promises";

const PUBLIC_POSTS_PATH = new URL("../../public/blog/posts.json", import.meta.url);
const PUBLIC_DIGESTS_PATH = new URL("../../public/blog/digests.json", import.meta.url);
const DRAFT_POSTS_PATH = new URL("../../.cache/draft/posts.json", import.meta.url);
const DRAFT_DIGESTS_PATH = new URL("../../.cache/draft/digests.json", import.meta.url);
const STATE_PATH = new URL("../../.cache/telegram-digest-state.json", import.meta.url);

const CHANNEL_LIMIT = 10;
const OPENAI_TIMEOUT_MS = 90_000;

function telegramApiBase() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  return token ? `https://api.telegram.org/bot${token}` : "";
}

function siteUrl() {
  return String(process.env.PUBLIC_SITE_URL || process.env.SITE_URL || "http://dsg.lorrrem.ru").replace(/\/$/, "");
}

function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function monthLabel(digest) {
  return digest?.monthLabel || digest?.key || "месяц";
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

async function copyFileEnsured(from, to) {
  await fs.mkdir(new URL(".", to), { recursive: true });
  await fs.copyFile(from, to);
}

async function telegram(method, payload = {}) {
  const base = telegramApiBase();
  if (!base) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  const response = await fetch(`${base}/${method}`, {
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

async function sendMessage(chatId, text, options = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
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

function digestUrl() {
  return `${siteUrl()}/blog`;
}

function isAdminChat(chatId) {
  const adminChatId = String(process.env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
  return adminChatId && String(chatId || "").trim() === adminChatId;
}

async function readDraftDigests() {
  return readJson(DRAFT_DIGESTS_PATH, { digests: [] });
}

async function readPublicDigests() {
  return readJson(PUBLIC_DIGESTS_PATH, { digests: [] });
}

async function latestDigest(path = "draft") {
  const payload = path === "draft" ? await readDraftDigests() : await readPublicDigests();
  return (
    (payload.digests || []).find((item) => item.key === payload.latestKey) ||
    payload.digests?.[0] ||
    null
  );
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

function draftControls(digest) {
  return {
    inline_keyboard: [
      [
        { text: "Опубликовать", callback_data: `publish:${digest.key}` },
        { text: "Обновить черновик", callback_data: `draft:${digest.key}` },
      ],
    ],
  };
}

function itemControls(digest, item) {
  return {
    inline_keyboard: [
      [{ text: "Переработать через ChatGPT", callback_data: `rework:${digest.key}:${item.id}` }],
    ],
  };
}

function digestIntro(digest, itemCount = null) {
  const countText = itemCount ? `${itemCount} материалов` : `${digest.items?.length || 0} материалов`;
  return [
    `<b>Черновик ${htmlEscape(digest.title || digest.key)}</b>`,
    `${htmlEscape(monthLabel(digest))}, ${digest.year} · ${countText}`,
    "Черновик не виден на сайте. Проверь материалы и нажми «Опубликовать», когда все готово.",
  ].join("\n");
}

async function sendDigestToAdmin(digest) {
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!adminChatId) return { sent: false, reason: "TELEGRAM_ADMIN_CHAT_ID is not set" };
  if (!digest) return { sent: false, reason: "draft digest not found" };

  await sendMessage(adminChatId, digestIntro(digest), { reply_markup: draftControls(digest) });

  for (const [index, item] of (digest.items || []).entries()) {
    const lines = [
      `<b>${index + 1}. ${htmlEscape(item.sourceTitle)}</b>`,
      `${htmlEscape(item.rubric || "Материал")} · ${htmlEscape(item.source || "")}`,
      "",
      htmlEscape(item.summary),
      item.excerpt ? `\n${htmlEscape(item.excerpt)}` : "",
      "",
      `<a href="${htmlEscape(item.url)}">Оригинал</a>`,
    ];
    await sendMessage(adminChatId, lines.filter(Boolean).join("\n"), {
      reply_markup: itemControls(digest, item),
    });
  }

  return { sent: true, key: digest.key };
}

export async function sendLatestDraftToAdmin() {
  return sendDigestToAdmin(await latestDigest("draft"));
}

function extractResponseText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.length > 0) return payload.output_text;
  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

async function rewriteDigestItem(item) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "excerpt", "rubric"],
    properties: {
      summary: { type: "string" },
      excerpt: { type: "string" },
      rubric: { type: "string" },
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
      model: process.env.OPENAI_DIGEST_MODEL || "gpt-4o-mini",
      max_output_tokens: 1400,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "Ты редактор русскоязычного дайджеста о продуктовом дизайне. Переработай материал: сделай summary ровно из 3 полезных предложений на русском, без рекламных фраз, мусора и выдуманных фактов. excerpt оставь пустым или дай одно короткое уточнение.",
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: JSON.stringify(item, null, 2) }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "digest_item_rewrite",
          schema,
          strict: true,
        },
      },
    }),
  });

  if (!response.ok) throw new Error(`OpenAI API error ${response.status}: ${await response.text()}`);
  return JSON.parse(extractResponseText(await response.json()));
}

async function updateDraftItem(digestKey, itemId) {
  const payload = await readDraftDigests();
  const digest = (payload.digests || []).find((item) => item.key === digestKey);
  if (!digest) throw new Error("Черновик не найден");
  const item = (digest.items || []).find((entry) => String(entry.id) === String(itemId));
  if (!item) throw new Error("Материал не найден");

  const rewritten = await rewriteDigestItem(item);
  item.summary = rewritten.summary;
  item.excerpt = rewritten.excerpt || "";
  item.rubric = rewritten.rubric || item.rubric;
  digest.updatedAt = new Date().toISOString();
  payload.generatedAt = new Date().toISOString();
  await writeJson(DRAFT_DIGESTS_PATH, payload);
  return { digest, item };
}

function channelMessage(digest) {
  const items = (digest.items || []).slice(0, CHANNEL_LIMIT);
  const lines = [
    `Всем привет! Сегодня мы, с моим ИИ ассистентом, подготовили дайджест о дизайне привычных вещей, за ${htmlEscape(monthLabel(digest))}. Тут подборка наиболее актуальных новостей за месяц.`,
    "",
    ...items.map((item, index) => `${index + 1}. <b>${htmlEscape(item.sourceTitle)}</b>\n${htmlEscape(item.summary)}`),
    "",
    `<a href="${htmlEscape(digestUrl())}">Смотреть больше новостей</a>`,
  ];
  return lines.join("\n");
}

async function publishDraft(digestKey) {
  const draftPayload = await readDraftDigests();
  const digest = (draftPayload.digests || []).find((item) => item.key === digestKey) || draftPayload.digests?.[0];
  if (!digest) throw new Error("Черновик не найден");

  await copyFileEnsured(DRAFT_POSTS_PATH, PUBLIC_POSTS_PATH);
  await copyFileEnsured(DRAFT_DIGESTS_PATH, PUBLIC_DIGESTS_PATH);

  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (channelId) {
    await sendMessage(channelId, channelMessage(digest));
  }

  await writeJson(STATE_PATH, {
    lastPublishedKey: digest.key,
    publishedAt: new Date().toISOString(),
  });
  return { published: true, key: digest.key };
}

export function checkTelegramWebhookSecret(req) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return true;
  return req.headers["x-telegram-bot-api-secret-token"] === expected;
}

export async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function handleCommand(message) {
  const chatId = message.chat.id;
  const command = String(message.text || "").trim().split(/\s+/)[0].replace(/@\w+$/, "");

  if (command === "/start" || command === "/help") {
    await sendMessage(
      chatId,
      [
        "<b>DSG Digest</b>",
        "/draft — прислать приватный черновик дайджеста",
        "/latest — последний опубликованный дайджест",
        "/site — открыть сайт",
        "/id — показать ID этого чата",
      ].join("\n")
    );
    return { ok: true };
  }

  if (command === "/id") {
    await sendMessage(chatId, `Chat ID: <code>${htmlEscape(chatId)}</code>`);
    return { ok: true };
  }

  if (command === "/site") {
    await sendMessage(chatId, `<a href="${htmlEscape(siteUrl())}">Открыть DSG</a>`);
    return { ok: true };
  }

  if (command === "/latest") {
    const digest = await latestDigest("public");
    await sendMessage(chatId, digest ? channelMessage(digest) : "Опубликованные дайджесты пока не найдены.");
    return { ok: true };
  }

  if (command === "/draft") {
    if (!isAdminChat(chatId)) {
      await sendMessage(chatId, "Черновики доступны только владельцу.");
      return { ok: true };
    }
    await sendDigestToAdmin(await latestDigest("draft"));
    return { ok: true };
  }

  await sendMessage(chatId, "Неизвестная команда. Используй /help.");
  return { ok: true };
}

async function handleCallback(callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  if (!isAdminChat(chatId)) {
    await answerCallback(callbackQuery.id, "Нет доступа");
    return { ok: true };
  }

  const [action, digestKey, itemId] = String(callbackQuery.data || "").split(":");

  if (action === "draft") {
    await answerCallback(callbackQuery.id, "Отправляю черновик");
    await sendDigestToAdmin(await latestDigest("draft"));
    return { ok: true };
  }

  if (action === "rework") {
    await answerCallback(callbackQuery.id, "Отправил в ChatGPT");
    const { digest, item } = await updateDraftItem(digestKey, itemId);
    await sendMessage(
      chatId,
      [`<b>Переработано: ${htmlEscape(item.sourceTitle)}</b>`, "", htmlEscape(item.summary)].join("\n"),
      { reply_markup: itemControls(digest, item) }
    );
    return { ok: true };
  }

  if (action === "publish") {
    await answerCallback(callbackQuery.id, "Публикую");
    const result = await publishDraft(digestKey);
    await sendMessage(chatId, `Опубликовано на сайт и в канал: ${htmlEscape(result.key)}`);
    return { ok: true };
  }

  await answerCallback(callbackQuery.id);
  return { ok: true };
}

export async function handleTelegramUpdate(update) {
  if (update.callback_query) return handleCallback(update.callback_query);
  const message = update.message || update.edited_message;
  if (message?.text) return handleCommand(message);
  return { ok: true, ignored: true };
}
