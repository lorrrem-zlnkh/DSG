import fs from "node:fs/promises";
import { loadEnv } from "./lib/load-env.mjs";

loadEnv();

const POSTS_PATH = new URL("../public/blog/posts.json", import.meta.url);
const DIGESTS_PATH = new URL("../public/blog/digests.json", import.meta.url);

const DEFAULT_MODEL = process.env.OPENAI_DIGEST_MODEL || "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = 60_000;
const BATCH_SIZE = 8;
const MAX_RETRIES = 2;

const BANNED_PATTERNS = [
  /Continue reading on [^.»]+[».]?/i,
  /\bAbout Me\b/i,
  /\bMember-only story\b/i,
  /Sign in to (?:Medium|read)/i,
  /\bFollow me on\b/i,
  /\bПодпис(?:ывай|аться)\b/i,
  /\bКраткая суть\b/i,
  /^\s*[-—–·•\s.]+$/i,
];

function decodeHtmlEntities(input) {
  const text = String(input || "");
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
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

function sanitize(text) {
  return decodeHtmlEntities(text)
    .replace(/Continue reading on [^.»]+[».]?/gi, " ")
    .replace(/\bAbout Me\b[\s—-]*/gi, " ")
    .replace(/^\s*By\s+[A-Z][A-Za-z .-]+\s*$/gim, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isWeak(text) {
  const t = sanitize(text);
  if (!t) return true;
  if (t.length < 80) return true;
  if (/^[-—–\s.]+$/.test(t)) return true;
  if (/^(about me|continue reading)/i.test(t)) return true;
  return false;
}

function looksEnglish(text) {
  const t = sanitize(text);
  if (!t) return false;
  const cyrillic = (t.match(/[А-Яа-яЁё]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  if (latin < 20) return false;
  return cyrillic === 0 && latin > 3 * cyrillic;
}

function isGoodOutput(summary, excerpt) {
  const s = sanitize(summary);
  const e = sanitize(excerpt);
  if (isWeak(s) || isWeak(e)) return false;
  if (s.length < 160) return false;
  if (e.length < 80) return false;
  const combined = `${s}\n${e}`;
  for (const re of BANNED_PATTERNS) {
    if (re.test(combined)) return false;
  }
  return true;
}

async function requestRewrite(items) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        minItems: items.length,
        maxItems: items.length,
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

  const response = await fetch(`${process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"}/responses`, {
    method: "POST",
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_output_tokens: 4000,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "Ты редактор дайджестов по продуктовому дизайну. Тебе дают заголовок и сырой текст/аннотацию статьи. " +
                "Сгенерируй полезный анонс: summary (2-3 предложения) и excerpt (1-2 предложения) на русском. " +
                "Нельзя использовать мусор и шаблоны: 'About Me', 'Continue reading on Medium', 'Member-only story', призывы подписаться, ссылки, 'Краткая суть'. " +
                "Если исходный язык именно английский — переводи на русский и ставь languageBadge='Eng'. Если язык не английский (например, португальский) — languageBadge=null. " +
                "Если текст слишком пустой, по доступным сигналам (заголовок + 1-2 фразы) сделай аккуратный, правдоподобный анонс без выдуманных фактов.",
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: JSON.stringify({ items }, null, 2) }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "medium_rewrite",
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
  return JSON.parse(extractResponseText(payload));
}

async function rewriteBatchWithQuality(items) {
  let attempt = 0;
  let current = items;
  while (attempt <= MAX_RETRIES) {
    const result = await requestRewrite(current);
    const map = new Map(result.items.map((x) => [String(x.id), x]));

    const failed = [];
    for (const item of current) {
      const out = map.get(String(item.id));
      if (!out) {
        failed.push(item);
        continue;
      }
      const expectedEng = looksEnglish(`${item.title}\n${item.input}`);
      if (out.languageBadge === "Eng" && !expectedEng) out.languageBadge = null;
      if (out.languageBadge !== "Eng" && expectedEng) out.languageBadge = "Eng";
      if (!isGoodOutput(out.summary, out.excerpt)) {
        failed.push(item);
      }
    }

    if (failed.length === 0) return result;

    attempt += 1;
    if (attempt > MAX_RETRIES) return result;

    current = failed.map((x) => ({
      ...x,
      input:
        `ВАЖНО: предыдущая попытка была низкого качества. Нельзя оставлять мусор и шаблоны, ` +
        `нужно связное полезное описание, достаточно подробное, но без выдуманных фактов.\n\n` +
        x.input,
    }));
  }
  return requestRewrite(items);
}

async function main() {
  const postsPayload = JSON.parse(await fs.readFile(POSTS_PATH, "utf8"));
  const digestsPayload = JSON.parse(await fs.readFile(DIGESTS_PATH, "utf8"));

  const mediumPosts = new Map(
    (postsPayload.posts || [])
      .filter((post) => post.source === "medium")
      .map((post) => [String(post.id), post])
  );

  const dropIds = new Set();
  let rewrittenCount = 0;
  let droppedCount = 0;

  for (const digest of digestsPayload.digests || []) {
    const mediumItems = (digest.items || []).filter((item) => item.source === "Medium");
    if (mediumItems.length === 0) continue;

    const usable = [];
    for (const item of mediumItems) {
      const post = mediumPosts.get(String(item.id));
      const raw = sanitize(post?.rewrite || post?.summary || item.summary || "");
      if (isWeak(raw)) {
        dropIds.add(String(item.id));
        droppedCount += 1;
        continue;
      }
      usable.push({ item, post, raw });
    }

    if (usable.length === 0) continue;

    const requestItems = usable.map(({ item, raw }) => ({
      id: String(item.id),
      title: item.sourceTitle,
      url: item.url,
      input: raw,
    }));

    console.log(`[rebuild-medium] ${digest.key}: rewriting ${requestItems.length}/${mediumItems.length} (drop weak: ${mediumItems.length - requestItems.length})`);
    const results = [];
    for (let i = 0; i < requestItems.length; i += BATCH_SIZE) {
      const batch = requestItems.slice(i, i + BATCH_SIZE);
      const result = await rewriteBatchWithQuality(batch);
      results.push(...result.items);
    }

    const map = new Map(results.map((x) => [String(x.id), x]));

    for (const item of digest.items || []) {
      if (item.source !== "Medium") continue;
      const updated = map.get(String(item.id));
      if (!updated) continue; // weak items will be dropped below
      item.summary = sanitize(updated.summary);
      item.excerpt = sanitize(updated.excerpt);
      item.languageBadge = updated.languageBadge;
      rewrittenCount += 1;
    }

    if (dropIds.size > 0) {
      digest.items = (digest.items || []).filter((x) => !(x.source === "Medium" && dropIds.has(String(x.id))));
      digest.count = (digest.items || []).length;
    }

    await fs.writeFile(DIGESTS_PATH, `${JSON.stringify(digestsPayload, null, 2)}\n`, "utf8");
  }

  if (dropIds.size > 0) {
    postsPayload.posts = (postsPayload.posts || []).filter((p) => !(p.source === "medium" && dropIds.has(String(p.id))));
    await fs.writeFile(POSTS_PATH, `${JSON.stringify(postsPayload, null, 2)}\n`, "utf8");
  }

  console.log(`[rebuild-medium] done. Updated items: ${rewrittenCount}. Dropped weak medium posts: ${droppedCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
