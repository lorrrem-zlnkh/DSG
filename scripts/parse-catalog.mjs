import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import * as cheerio from "cheerio";

function normalizeText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function safeSlug(input) {
  const base = normalizeText(input)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base || crypto.randomBytes(8).toString("hex");
}

function guessExtFromUrl(url) {
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname).replace(".", "").toLowerCase();
    return ext || "bin";
  } catch {
    return "bin";
  }
}

function pickLinks($item) {
  const links = { site: null, github: null, figma: null };
  const anchors = $item.find(".social-list a").toArray();
  for (const a of anchors) {
    const href = normalizeText(a.attribs?.href);
    if (!href || href === "#") continue;
    if (href.includes("github.com")) links.github = href;
    else if (href.includes("figma.com")) links.figma = href;
    else links.site = href;
  }
  return links;
}

async function main() {
  const [baseUrl, htmlPath, outPublicDir] = process.argv.slice(2);
  if (!baseUrl || !htmlPath || !outPublicDir) {
    console.error(
      "Usage: node scripts/parse-catalog.mjs <baseUrl> <htmlPath> <publicDir>"
    );
    process.exitCode = 2;
    return;
  }

  const outDir = path.resolve(outPublicDir);
  const dataDir = path.join(outDir, "data");
  await fs.mkdir(dataDir, { recursive: true });

  const html = await fs.readFile(htmlPath, "utf8");
  const $ = cheerio.load(html);

  const brandLogoUrl = $(".navbar-1-brand img").first().attr("src") || "";
  const addSystemUrl = $(".navbar-buttons a.button").first().attr("href") || "";

  const brandExt = guessExtFromUrl(brandLogoUrl);
  const brandRel = `assets/brand/logo.${brandExt}`;

  const systems = [];
  const downloads = [];
  if (brandLogoUrl) {
    downloads.push({ url: new URL(brandLogoUrl, baseUrl).toString(), rel: brandRel });
  }

  const items = $(".collection-item.w-dyn-item").toArray();
  for (const el of items) {
    const $item = $(el);
    const title = normalizeText($item.find(".our-grid-card-title").first().text());
    const description = normalizeText(
      $item.find(".our-grid-card-description").first().text()
    );

    const companySlug = safeSlug(
      title
    );

    const logoUrl = $item.find("img.our-grid-avatar").first().attr("src") || "";
    const logoExt = guessExtFromUrl(logoUrl);
    const logoRel = `assets/logos/${companySlug}.${logoExt}`;
    if (logoUrl) {
      downloads.push({ url: new URL(logoUrl, baseUrl).toString(), rel: logoRel });
    }

    systems.push({
      id: companySlug,
      origin: "domestic",
      title,
      description,
      logo: logoUrl ? logoRel : null,
      links: pickLinks($item),
    });
  }

  systems.sort((a, b) => a.title.localeCompare(b.title, "ru"));

  await fs.writeFile(
    path.join(dataDir, "systems.json"),
    JSON.stringify({ systems }, null, 2) + "\n",
    "utf8"
  );

  await fs.writeFile(
    path.join(dataDir, "site.json"),
    JSON.stringify(
      {
        brand: { logo: brandLogoUrl ? brandRel : null },
        links: {
          addSystem: addSystemUrl ? new URL(addSystemUrl, baseUrl).toString() : null,
          supportProject: null,
        },
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  // Print downloads as TSV so the shell script can fetch them without Node networking.
  process.stdout.write(
    downloads.map((d) => `${d.url}\t${d.rel}`).join("\n") + (downloads.length ? "\n" : "")
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
