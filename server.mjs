import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildDigests } from "./scripts/build-digests.mjs";
import { loadEnv } from "./scripts/lib/load-env.mjs";
import {
  getContentAutomationStatus,
  runContentAutomation,
} from "./scripts/run-content-automation.mjs";

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DIGESTS_PATH = path.join(PUBLIC_DIR, "blog", "digests.json");
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "127.0.0.1";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function monthKey(year, month) {
  return `${String(year)}-${String(month).padStart(2, "0")}`;
}

function checkAutomationToken(req) {
  const requiredToken = process.env.CONTENT_AUTOMATION_TOKEN || process.env.DIGEST_REBUILD_TOKEN;
  const requestToken = req.headers["x-automation-token"] || req.headers["x-digest-token"];
  return !requiredToken || requestToken === requiredToken;
}

async function readDigests() {
  const raw = await fs.readFile(DIGESTS_PATH, "utf8");
  return JSON.parse(raw);
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
      latestModel: process.env.OPENAI_DIGEST_MODEL || "gpt-4o-mini",
      automationConfigured: Boolean(process.env.CONTENT_AUTOMATION_TOKEN || process.env.DIGEST_REBUILD_TOKEN),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/automation/status") {
    try {
      sendJson(res, 200, await getContentAutomationStatus());
    } catch (error) {
      sendJson(res, 500, { error: "automation_status_failed", message: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/automation/run") {
    if (!checkAutomationToken(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }

    const shouldWait = url.searchParams.get("wait") === "1";
    const run = runContentAutomation();

    if (!shouldWait) {
      run.catch(() => {});
      sendJson(res, 202, {
        ok: true,
        state: "accepted",
        statusUrl: "/api/automation/status",
      });
      return true;
    }

    try {
      const status = await run;
      sendJson(res, status.ok ? 200 : 409, status);
    } catch (error) {
      sendJson(res, 500, { error: "automation_run_failed", message: error.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/digests") {
    try {
      const payload = await readDigests();
      const year = Number(url.searchParams.get("year"));
      const month = Number(url.searchParams.get("month"));

      if (year && month) {
        const digest = (payload.digests || []).find((item) => item.key === monthKey(year, month)) || null;
        sendJson(res, 200, { ...payload, digest });
        return true;
      }

      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, 500, { error: "digest_read_failed", message: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/digests/rebuild") {
    const requiredToken = process.env.DIGEST_REBUILD_TOKEN;
    const requestToken = req.headers["x-digest-token"];

    if (requiredToken && requestToken !== requiredToken) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }

    try {
      const payload = await buildDigests();
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, 500, { error: "digest_build_failed", message: error.message });
    }
    return true;
  }

  return false;
}

function safePublicPath(urlPath) {
  const pathname = decodeURIComponent(urlPath.split("?")[0]);
  const normalized = pathname === "/" ? "/index.html" : pathname;
  const fullPath = path.join(PUBLIC_DIR, normalized);
  if (!fullPath.startsWith(PUBLIC_DIR)) return null;
  return fullPath;
}

async function serveStatic(req, res, url) {
  let filePath = safePublicPath(url.pathname);
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    let stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      stat = await fs.stat(filePath);
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeType = MIME_TYPES[ext] || "application/octet-stream";
    const body = await fs.readFile(filePath);

    res.writeHead(200, {
      "Content-Type": mimeType,
      "Content-Length": stat.size,
      "Cache-Control": ext === ".json" ? "no-store" : "public, max-age=300",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

  if (await handleApi(req, res, url)) return;
  await serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`DSG server listening on http://${HOST}:${PORT}`);
});
