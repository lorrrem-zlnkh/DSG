import fs from "node:fs/promises";

const SYSTEMS_PATH = new URL("../public/data/systems.json", import.meta.url);

function norm(s) {
  return String(s ?? "").trim();
}

function updateLink(system, kind, value) {
  system.links = system.links || {};
  system.links[kind] = value;
}

function deleteSystemById(systems, id) {
  const idx = systems.findIndex((s) => s.id === id);
  if (idx !== -1) systems.splice(idx, 1);
}

async function main() {
  const raw = await fs.readFile(SYSTEMS_PATH, "utf8");
  const data = JSON.parse(raw);
  const systems = Array.isArray(data.systems) ? data.systems : [];

  const byId = new Map(systems.map((s) => [s.id, s]));

  // Remove "site" links:
  for (const id of ["companies-alfabank", "companies-gazpromneft", "companies-tinkoff"]) {
    const s = byId.get(id);
    if (s) updateLink(s, "site", null);
  }

  // Delete card: Диасофт Экосистема
  deleteSystemById(systems, "companies-diasoft-ekosistema");

  // Remove Figma link: Росатом
  {
    const s = byId.get("companies-rosatom");
    if (s) updateLink(s, "figma", null);
  }

  // Update description: t2 (на основе страницы "О компании" t2)
  {
    const s = byId.get("companies-t2");
    if (s) {
      s.description = "Федеральный оператор мобильной связи: покрытие и качество, фокус на продуктовых инновациях; ребрендинг в 2024 году.";
    }
  }

  // Rewrite foreign descriptions (уникальные формулировки) + Тинькофф
  const descById = {
    "material-design":
      "Дизайн-система Google: правила, компоненты и токены для интерфейсов на Android и в вебе.",
    "apple-ui-kits":
      "Экосистема Apple HIG + UI kits: паттерны и компоненты для iOS/iPadOS, удобно собирать макеты в Figma.",
    "ibm-carbon":
      "Carbon от IBM: библиотека компонентов и гайдлайны, чтобы унифицировать продукты и ускорить сборку UI.",
    "microsoft-fluent-2":
      "Fluent 2: дизайн-язык Microsoft и наборы UI в Figma для консистентных интерфейсов на разных платформах.",
    "shopify-polaris":
      "Polaris: система Shopify для админки и приложений — компоненты, стили и иконки для быстрого старта.",
    "atlassian-ads":
      "Atlassian Design System: принципы, компоненты и паттерны для продуктов Atlassian и их экосистемы.",
    "github-primer":
      "Primer: дизайн-система GitHub — компоненты и стили для продуктовых интерфейсов и документации.",
    "salesforce-lightning":
      "Lightning Design System: компоненты и токены Salesforce для единых корпоративных интерфейсов.",
    "airbnb-dls":
      "DLS Airbnb: принципы и визуальный язык бренда; полезно как референс для паттернов и стиля.",

    "companies-tinkoff":
      "Компонентная дизайн-система с открытым кодом: библиотека UI и гайдлайны для продуктовых интерфейсов.",
  };

  for (const s of systems) {
    const next = descById[s.id];
    if (next) s.description = next;
  }

  systems.sort((a, b) => norm(a.title).localeCompare(norm(b.title), "ru"));

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

