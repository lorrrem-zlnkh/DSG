// Провайдеро-независимый запрос со structured output (JSON-schema).
//
// Управление через переменные окружения (читаются лениво, в момент вызова —
// чтобы корректно работать с loadEnv(), который грузит .env после импортов):
//   LLM_PROVIDER      = openai (по умолчанию) | claude
//   — OpenAI:  OPENAI_API_KEY, OPENAI_DIGEST_MODEL, OPENAI_BASE_URL
//   — Claude:  ANTHROPIC_API_KEY, ANTHROPIC_MODEL (по умолчанию claude-haiku-4-5-20251001)
//
// Возвращает распарсенный объект, соответствующий переданной schema.

const REQUEST_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 180_000);

export function activeProvider() {
  const provider = (process.env.LLM_PROVIDER || "openai").toLowerCase();
  return provider === "claude" || provider === "anthropic" ? "claude" : "openai";
}

export function activeModel() {
  return activeProvider() === "claude"
    ? process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001"
    : process.env.OPENAI_DIGEST_MODEL || "gpt-4o-mini";
}

// --- OpenAI (Responses API) --------------------------------------------------

function extractOpenAIText(payload) {
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

async function requestOpenAI({ system, user, schema, schemaName, maxTokens }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const model = activeModel();
  // GPT-5.x / o-series — reasoning-модели: reasoning.effort вместо temperature.
  const isReasoning = /^(gpt-5|o\d)/i.test(model);
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

  const body = {
    model,
    max_output_tokens: maxTokens || (isReasoning ? 8000 : 4000),
    input: [
      { role: "system", content: [{ type: "input_text", text: system }] },
      { role: "user", content: [{ type: "input_text", text: user }] },
    ],
    text: { format: { type: "json_schema", name: schemaName, schema, strict: true } },
  };
  if (isReasoning) body.reasoning = { effort: "low" };

  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OpenAI API error ${response.status}: ${await response.text()}`);

  return JSON.parse(extractOpenAIText(await response.json()));
}

// --- Claude (Messages API) ---------------------------------------------------

// Structured outputs у Claude не поддерживают часть ограничений JSON-schema —
// вырезаем их, иначе будет 400 (SDK делает это автоматически, на сыром HTTP — мы).
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "pattern",
]);

function sanitizeSchemaForClaude(node) {
  if (Array.isArray(node)) return node.map(sanitizeSchemaForClaude);
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
      out[key] = sanitizeSchemaForClaude(value);
    }
    return out;
  }
  return node;
}

function extractClaudeText(payload) {
  const chunks = [];
  for (const block of payload.content || []) {
    if (block.type === "text" && typeof block.text === "string") chunks.push(block.text);
  }
  return chunks.join("\n").trim();
}

async function requestClaude({ system, user, schema, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  // Нормализуем хост: убираем хвостовой слэш и /v1, чтобы добавить /v1/messages
  // независимо от формата ANTHROPIC_BASE_URL (с /v1, без, или не задан).
  const host = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com")
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");

  const response = await fetch(`${host}/v1/messages`, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: activeModel(),
      max_tokens: maxTokens || 8000,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: { type: "json_schema", schema: sanitizeSchemaForClaude(schema) } },
    }),
  });
  if (!response.ok) throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`);

  return JSON.parse(extractClaudeText(await response.json()));
}

// --- Публичный API -----------------------------------------------------------

export async function requestStructured(opts) {
  return activeProvider() === "claude" ? requestClaude(opts) : requestOpenAI(opts);
}
