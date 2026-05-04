import { loadEnv } from "./lib/load-env.mjs";
import { pathToFileURL } from "node:url";

loadEnv();

const COMMANDS = [
  { command: "start", description: "Команды бота" },
  { command: "draft", description: "Приватный черновик дайджеста" },
  { command: "latest", description: "Последний опубликованный дайджест" },
  { command: "site", description: "Открыть сайт DSG" },
  { command: "id", description: "Показать ID чата" },
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function siteUrl() {
  return String(process.env.PUBLIC_SITE_URL || process.env.SITE_URL || "").replace(/\/$/, "");
}

function webhookUrl() {
  return String(process.env.TELEGRAM_WEBHOOK_URL || "").replace(/\/$/, "");
}

async function telegram(method, payload = {}) {
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
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

async function main() {
  const publicSiteUrl = siteUrl();
  const explicitWebhookUrl = webhookUrl();
  const webhookSecret = requireEnv("TELEGRAM_WEBHOOK_SECRET");
  if (!publicSiteUrl && !explicitWebhookUrl) {
    throw new Error("PUBLIC_SITE_URL, SITE_URL, or TELEGRAM_WEBHOOK_URL is required");
  }

  const webhookUrl = explicitWebhookUrl || `${publicSiteUrl}/api/telegram/webhook`;
  if (!/^https:\/\//i.test(webhookUrl)) {
    throw new Error("Telegram webhook URL must use HTTPS. Set TELEGRAM_WEBHOOK_URL to an HTTPS endpoint.");
  }
  const me = await telegram("getMe");
  await telegram("setMyCommands", { commands: COMMANDS });
  await telegram("setMyShortDescription", {
    short_description: "Ежемесячные дайджесты DSG по продуктовому дизайну.",
  });
  await telegram("setMyDescription", {
    description:
      "DSG Digest присылает приватный черновик выпуска, помогает переработать материалы через ChatGPT и публикует готовый дайджест на сайт и в Telegram-канал.",
  });
  await telegram("setWebhook", {
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });

  const webhook = await telegram("getWebhookInfo");
  console.log(
    JSON.stringify(
      {
        ok: true,
        bot: {
          id: me.id,
          username: me.username,
          firstName: me.first_name,
        },
        webhook: {
          url: webhook.url,
          pendingUpdateCount: webhook.pending_update_count,
          lastErrorDate: webhook.last_error_date || null,
          lastErrorMessage: webhook.last_error_message || null,
        },
      },
      null,
      2
    )
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
