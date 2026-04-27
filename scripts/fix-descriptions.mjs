import fs from "node:fs/promises";

const SYSTEMS_PATH = new URL("../public/data/systems.json", import.meta.url);

function normalize(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function ensurePeriod(text) {
  const t = normalize(text);
  if (!t) return t;
  if (/[.!?…]$/.test(t)) return t;
  return t + ".";
}

async function main() {
  const raw = await fs.readFile(SYSTEMS_PATH, "utf8");
  const data = JSON.parse(raw);
  const systems = Array.isArray(data.systems) ? data.systems : [];

  for (const s of systems) {
    if (s.id === "companies-t2") {
      // Remove the extra clause per user request.
      s.description = "Федеральный оператор мобильной связи.";
    }
    s.description = ensurePeriod(s.description);
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

