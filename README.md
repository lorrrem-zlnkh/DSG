# DSG
Каталог дизайн-систем и ежемесячные дайджесты по продуктовому дизайну.

## API integration

- `GET /api/health` — checks server status and whether `OPENAI_API_KEY` is configured.
- `GET /api/digests` — returns `public/blog/digests.json`.
- `POST /api/digests/rebuild` — rebuilds digests through OpenAI Responses API and rewrites `public/blog/digests.json`.
- `GET /api/automation/status` — returns the latest autonomous content run status.
- `POST /api/automation/run` — starts the full autonomous pipeline: fetch sources and build a private draft through OpenAI into `.cache/draft`.

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

## Host-side automation

The automation must run on the hosting server, not on a local desktop. Keep `OPENAI_API_KEY` and `CONTENT_AUTOMATION_TOKEN` only in server-side environment variables.

For Node hosting, set `HOST=0.0.0.0` in the hosting environment when the platform expects the app to bind to a public interface, then run:

```bash
npm install
npm run start
```

Add a hosting cron job once a month, for example at 10:00 on the first day of each month. It creates a private draft:

```bash
0 10 1 * * curl -fsS -X POST -H "x-automation-token: $CONTENT_AUTOMATION_TOKEN" http://dsg.lorrrem.ru/api/automation/run
```

The endpoint returns immediately with `202 Accepted`; check `/api/automation/status` for completion. If your hosting cron supports long requests, add `?wait=1` to wait for the run result.

If the site is served as static files, run this command in the deployed project directory and publish the `public` directory with your host's deployment mechanism:

```bash
npm run content:automation
```

The OpenAI API key is used only server-side, so it is never exposed in browser code.
