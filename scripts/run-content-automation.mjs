import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { buildDigests } from "./build-digests.mjs";
import { fetchBlogPosts } from "./fetch-blog.mjs";
import { loadEnv } from "./lib/load-env.mjs";

loadEnv();

const STATUS_PATH = new URL("../public/automation/status.json", import.meta.url);
const LOCK_PATH = new URL("../.cache/content-automation.lock", import.meta.url);
const DRAFT_POSTS_PATH = new URL("../.cache/draft/posts.json", import.meta.url);
const DRAFT_DIGESTS_PATH = new URL("../.cache/draft/digests.json", import.meta.url);

let inProcessRun = null;

async function writeStatus(status) {
  await fs.mkdir(new URL(".", STATUS_PATH), { recursive: true });
  await fs.writeFile(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

async function readStatus() {
  try {
    return JSON.parse(await fs.readFile(STATUS_PATH, "utf8"));
  } catch {
    return {
      ok: null,
      state: "never_run",
      updatedAt: null,
    };
  }
}

async function acquireLock() {
  await fs.mkdir(new URL(".", LOCK_PATH), { recursive: true });
  try {
    const handle = await fs.open(LOCK_PATH, "wx");
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      })
    );
    await handle.close();
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

async function releaseLock() {
  try {
    await fs.unlink(LOCK_PATH);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function publicSummary(postsPayload, digestsPayload) {
  return {
    posts: Array.isArray(postsPayload.posts) ? postsPayload.posts.length : 0,
    digests: Array.isArray(digestsPayload.digests) ? digestsPayload.digests.length : 0,
    latestKey: digestsPayload.latestKey || null,
  };
}

async function runWithLock() {
  const locked = await acquireLock();
  if (!locked) {
    const status = await readStatus();
    return {
      ok: false,
      state: "already_running",
      status,
    };
  }

  const startedAt = new Date().toISOString();
  await writeStatus({
    ok: null,
    state: "running",
    startedAt,
    updatedAt: startedAt,
  });

  try {
    const postsPayload = await fetchBlogPosts({ outPath: DRAFT_POSTS_PATH });
    const digestsPayload = await buildDigests({
      postsPath: DRAFT_POSTS_PATH,
      digestsPath: DRAFT_DIGESTS_PATH,
    });
    const finishedAt = new Date().toISOString();
    const status = {
      ok: true,
      state: "draft_ready",
      startedAt,
      finishedAt,
      updatedAt: finishedAt,
      ...publicSummary(postsPayload, digestsPayload),
    };
    await writeStatus(status);
    return status;
  } catch (error) {
    const failedAt = new Date().toISOString();
    const status = {
      ok: false,
      state: "failed",
      startedAt,
      failedAt,
      updatedAt: failedAt,
      error: error.message,
    };
    await writeStatus(status);
    throw error;
  } finally {
    await releaseLock();
  }
}

export async function getContentAutomationStatus() {
  return readStatus();
}

export async function runContentAutomation() {
  if (!inProcessRun) {
    inProcessRun = runWithLock().finally(() => {
      inProcessRun = null;
    });
  }
  return inProcessRun;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runContentAutomation()
    .then((status) => {
      console.log(JSON.stringify(status, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
