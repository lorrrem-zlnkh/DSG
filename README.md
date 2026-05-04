# DSG
Каталог дизайн-систем и ежемесячные дайджесты по продуктовому дизайну.

## API integration

- `GET /api/health` — checks server status and whether `OPENAI_API_KEY` is configured.
- `GET /api/digests` — returns `public/blog/digests.json`.
- `POST /api/digests/rebuild` — rebuilds digests through OpenAI Responses API and rewrites `public/blog/digests.json`.
- `GET /api/automation/status` — returns the latest autonomous content run status.
- `POST /api/automation/run` — starts the full autonomous pipeline: fetch sources and build a private draft through OpenAI into `.cache/draft`.
- `POST /api/telegram/webhook` — receives Telegram bot updates.

If `CONTENT_AUTOMATION_TOKEN` is set, send it in `x-automation-token`. The older digest rebuild endpoint still accepts `DIGEST_REBUILD_TOKEN` in `x-digest-token`.

## Local run

```bash
npm install
cp .env.example .env
npm run dev
```

## Digest build

```bash
npm run fetch:blog
```

## Telegram digest review bot

The monthly automation creates a private draft in `.cache/draft`. The draft is not visible on the site. The Telegram webhook bot sends the full draft to the owner, lets any material be sent back to ChatGPT for rewriting, and publishes the approved digest to the site and channel only after the `Опубликовать` button is pressed.

## Host-side automation

The automation must run on the hosting server, not on a local desktop. Keep `OPENAI_API_KEY` and `CONTENT_AUTOMATION_TOKEN` only in server-side environment variables.

For Node hosting, set `HOST=0.0.0.0` in the hosting environment when the platform expects the app to bind to a public interface, then run:

```bash
npm install
npm run start
```

Add a hosting cron job once a month, for example at 10:00 on the first day of each month. It creates a private draft and sends it to the admin bot chat:

```bash
0 10 1 * * curl -fsS -X POST -H "x-automation-token: $CONTENT_AUTOMATION_TOKEN" http://dsg.lorrrem.ru/api/automation/run
```

The endpoint returns immediately with `202 Accepted`; check `/api/automation/status` for completion. If your hosting cron supports long requests, add `?wait=1` to wait for the run result. The public site is updated only after the admin presses `Опубликовать` in Telegram.

If the site is served as static files, run this command in the deployed project directory and publish the `public` directory with your host's deployment mechanism:

```bash
npm run content:automation
```

The OpenAI API key is used only server-side, so it is never exposed in browser code.

## Telegram bot and channel

Required server-side variables:

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ADMIN_CHAT_ID=...
TELEGRAM_CHANNEL_ID=@lorrrem
TELEGRAM_WEBHOOK_SECRET=long-random-secret
PUBLIC_SITE_URL=http://dsg.lorrrem.ru
# Telegram requires HTTPS for webhooks. Use this when PUBLIC_SITE_URL is HTTP:
# TELEGRAM_WEBHOOK_URL=https://dsg.lorrrem.ru/api/telegram/webhook
```

Add the bot as an administrator in the Telegram channel and allow it to post messages. Telegram requires HTTPS for webhooks, so enable SSL for `dsg.lorrrem.ru` or set `TELEGRAM_WEBHOOK_URL` to another HTTPS endpoint that routes to this app. Then register the webhook:

```bash
curl -fsS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"$PUBLIC_SITE_URL/api/telegram/webhook\",\"secret_token\":\"$TELEGRAM_WEBHOOK_SECRET\"}"
```

Useful bot commands:

```text
/start
/draft
/latest
/site
/id
```

`/draft` works only for `TELEGRAM_ADMIN_CHAT_ID`. The bot sends the full private draft with buttons: `Переработать через ChatGPT` for each material and `Опубликовать` for the whole digest. Publishing copies the draft into `public` and sends 10 materials to `TELEGRAM_CHANNEL_ID` with the configured intro and the `Смотреть больше новостей` link to `http://dsg.lorrrem.ru/blog`.

To configure the bot through Telegram API from the host, set the Telegram env variables and run:

```bash
npm run telegram:setup
```
