import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { loadEnv } from "./lib/load-env.mjs";

loadEnv();

// Хэндофф свежесгенерированного дайджеста боту: PHP сохраняет черновик и сам
// рассылает владельцу карточки на модерацию. Публикация — только после
// подтверждения в Telegram (см. public/bot/webhook.php).

const SECRET = process.env.WEBHOOK_SECRET;
const INIT_URL = process.env.BOT_INIT_URL || "https://dsg.lorrrem.ru/bot/webhook.php";

// Берём свежесобранный дайджест из черновика автоматизации, иначе — из public.
const DRAFT_DIGESTS = new URL("../.cache/draft/digests.json", import.meta.url);
const PUBLIC_DIGESTS = new URL("../public/blog/digests.json", import.meta.url);

async function readLatestDigest() {
  for (const path of [DRAFT_DIGESTS, PUBLIC_DIGESTS]) {
    try {
      const data = JSON.parse(await fs.readFile(path, "utf8"));
      if (data?.digests?.[0]) return data.digests[0];
    } catch {
      // пробуем следующий источник
    }
  }
  return null;
}

async function main() {
  if (!SECRET) {
    console.error("Missing WEBHOOK_SECRET");
    process.exitCode = 1;
    return;
  }

  const digest = await readLatestDigest();
  if (!digest) {
    console.error("No digest found in .cache/draft or public/blog");
    process.exitCode = 1;
    return;
  }

  const url = `${INIT_URL}?action=init_draft`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bot-Secret": SECRET,
    },
    body: JSON.stringify({ digest }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`init_draft failed: HTTP ${res.status} — ${text}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Draft handed off to bot: ${text}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
