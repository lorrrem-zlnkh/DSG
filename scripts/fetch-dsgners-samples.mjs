import fs from "node:fs/promises";
import crypto from "node:crypto";

import { DSGNERS_SAMPLE_URLS } from "./lib/dsgners-urls.mjs";

const cacheDir = new URL("../.cache/blog/dsgners/", import.meta.url);
await fs.mkdir(cacheDir, { recursive: true });

for (const url of DSGNERS_SAMPLE_URLS) {
  const id = crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
  try {
    const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!response.ok) {
      console.error("skip", response.status, url);
      continue;
    }
    const html = await response.text();
    await fs.writeFile(new URL(`${id}.html`, cacheDir), html);
    await fs.writeFile(new URL(`${id}.json`, cacheDir), JSON.stringify({ id, url }));
    console.log("ok", id);
  } catch (error) {
    console.error("err", url, error.message);
  }
}
