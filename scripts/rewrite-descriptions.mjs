import fs from "node:fs/promises";

const SYSTEMS_PATH = new URL("../public/data/systems.json", import.meta.url);

function normalize(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function shorten(text, max = 110) {
  const t = normalize(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trim() + "…";
}

function rewriteDomestic(title, description) {
  const d = normalize(description);
  if (!d) return "";

  // Make it коротко + по делу: 1 фраза, без "—" и лишних уточнений.
  let out = d
    .replace(/^([A-Za-z0-9_-]+)\s*—\s*/u, "")
    .replace(/\s*\([^)]*\)\s*/g, (m) => (m.length > 18 ? " " : m))
    .replace(/\s{2,}/g, " ")
    .trim();

  // If it doesn't start with a capital, prefix with the title.
  const first = out[0] || "";
  if (first && first === first.toLowerCase()) out = `${title}: ${out}`;

  return shorten(out, 120);
}

const foreignOverrides = {
  "material-design": "Material Design — дизайн-система Google для продуктов на Android, Web и не только.",
  "apple-ui-kits": "Human Interface Guidelines и UI kits Apple для iOS/iPadOS в Figma.",
  "ibm-carbon": "Carbon — дизайн-система IBM: компоненты, шаблоны и гайдлайны для цифровых продуктов.",
  "microsoft-fluent-2": "Fluent 2 — дизайн-система Microsoft; наборы UI в Figma для Web и платформ.",
  "shopify-polaris": "Polaris — дизайн-система Shopify для интерфейсов админки и приложений.",
  "atlassian-ads": "Atlassian Design System — компоненты и принципы для продуктов Atlassian.",
  "github-primer": "Primer — дизайн-система GitHub для продуктовых интерфейсов.",
  "salesforce-lightning": "Lightning Design System — дизайн-система Salesforce с компонентами и токенами.",
  "airbnb-dls": "Airbnb DLS — дизайн-язык Airbnb: принципы, паттерны и визуальная система.",
};

async function main() {
  const raw = await fs.readFile(SYSTEMS_PATH, "utf8");
  const data = JSON.parse(raw);
  const systems = Array.isArray(data.systems) ? data.systems : [];

  for (const s of systems) {
    if (s.origin === "foreign") {
      if (foreignOverrides[s.id]) s.description = foreignOverrides[s.id];
      else s.description = shorten(s.description, 120);
      continue;
    }
    s.description = rewriteDomestic(s.title, s.description);
  }

  await fs.writeFile(
    SYSTEMS_PATH,
    JSON.stringify({ systems }, null, 2) + "\n",
    "utf8"
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

