# DSG
Каталог дизайн-систем и ежемесячные дайджесты по продуктовому дизайну.

## API integration

- `GET /api/health` — checks server status and whether `OPENAI_API_KEY` is configured.
- `GET /api/digests` — returns `public/blog/digests.json`.
- `POST /api/digests/rebuild` — rebuilds digests through OpenAI Responses API and rewrites `public/blog/digests.json`.

If `DIGEST_REBUILD_TOKEN` is set, send it in `x-digest-token`.

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

The rebuild script uses `OPENAI_API_KEY` server-side, so the key is never exposed in browser code.
