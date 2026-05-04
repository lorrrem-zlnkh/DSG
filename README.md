# DSG
Каталог дизайн-систем и ежемесячные дайджесты по продуктовому дизайну.

## API integration

- `GET /api/health` — checks server status and whether `OPENAI_API_KEY` is configured.
- `GET /api/digests` — returns `public/blog/digests.json`.
- `POST /api/digests/rebuild` — rebuilds digests through OpenAI Responses API and rewrites `public/blog/digests.json`.
- `GET /api/automation/status` — returns the latest autonomous content run status.
- `POST /api/automation/run` — starts the full autonomous pipeline: fetch sources, rewrite/build digests through OpenAI, and publish updated files into `public`.

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

The bot sends the latest monthly digest to the owner for review, lets individual articles be marked as "in rework", blocks publishing until rework is cleared, then updates `public/blog/digests.json` and posts the digest to a Telegram channel.

Set these server-side environment variables:

```bash
TELEGRAM_BOT_TOKEN=123456:telegram-bot-token
TELEGRAM_ADMIN_CHAT_ID=123456789
TELEGRAM_CHANNEL_ID=@your_channel
PUBLIC_SITE_URL=https://your-domain.example
DIGEST_REVIEW_DAY=1
DIGEST_REVIEW_HOUR=10
```

Run the bot as a long-lived process:

```bash
npm run digest:bot
```

Bot commands:

- `/draft` — send the latest digest for review.
- `/draft 2026-04` — send a specific digest.
- `/status` — show articles marked for rework.
- `/publish` — publish to the site and Telegram channel if nothing is in rework.
- `/publish_force` — publish even with rework items.

For site deployment after approval, run the bot on the same host that serves the site, or set `DIGEST_SITE_PUBLISH_URL` to a protected deploy hook. Do not point it to `/api/automation/run`: that endpoint rebuilds content and can bypass the reviewed draft. As an alternative, set `DIGEST_SITE_PUBLISH_COMMAND` to a host-local deploy command that only publishes the reviewed `public` files.

## Host-side automation

The automation must run on the hosting server, not on a local desktop. Keep `OPENAI_API_KEY` and `CONTENT_AUTOMATION_TOKEN` only in server-side environment variables.

For Node hosting, set `HOST=0.0.0.0` in the hosting environment when the platform expects the app to bind to a public interface, then run:

```bash
npm install
npm run start
```

Add a hosting cron job, for example daily:

```bash
curl -fsS -X POST -H "x-automation-token: $CONTENT_AUTOMATION_TOKEN" https://your-domain.example/api/automation/run
```

The endpoint returns immediately with `202 Accepted`; check `/api/automation/status` for completion. If your hosting cron supports long requests, add `?wait=1` to wait for the run result.

If the site is served as static files, run this command in the deployed project directory and publish the `public` directory with your host's deployment mechanism:

```bash
npm run content:automation
```

The OpenAI API key is used only server-side, so it is never exposed in browser code.
