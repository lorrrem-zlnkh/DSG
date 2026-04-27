import fs from "node:fs/promises";

const SYSTEMS_PATH = new URL("../public/data/systems.json", import.meta.url);

function ensurePeriod(text) {
  const t = String(text ?? "").trim();
  if (!t) return t;
  if (/[.!?…]$/.test(t)) return t;
  return t + ".";
}

async function main() {
  const raw = await fs.readFile(SYSTEMS_PATH, "utf8");
  const data = JSON.parse(raw);
  const systems = Array.isArray(data.systems) ? data.systems : [];

  const patch = {
    "airbnb-dls": {
      title: "Airbnb Design Language System",
      description:
        "DLS Airbnb: Принципы и визуальный язык бренда, продукта в сфере аренды жилья.",
      logo: "assets/logos/foreign-airbnb.svg",
    },
    "apple-ui-kits": {
      title: "Apple UI Kits",
      description: "Экосистема Apple, крупного технического бренда.",
      logo: "assets/logos/foreign-apple.svg",
    },
    "atlassian-ads": {
      title: "Atlassian Design System",
      description: "Принципы, компоненты и паттерны для продуктов Atlassian и их экосистемы.",
      logo: "assets/logos/foreign-atlassian.svg",
    },
    "ibm-carbon": {
      title: "Carbon",
      description: "Дизайн-система крупного разработчика ПО и производителя гаджетов.",
      logo: "assets/logos/foreign-carbon.svg",
    },
    "microsoft-fluent-2": {
      title: "Fluent 2",
      description: "Дизайн-язык Microsoft и её продуктов.",
      logo: "assets/logos/foreign-fluent.svg",
    },
    "salesforce-lightning": {
      title: "Lightning",
      description: "Компоненты и токены Salesforce для единых корпоративных интерфейсов.",
      logo: "assets/logos/foreign-lightning.svg",
    },
    "material-design": {
      title: "Material Design",
      description:
        "Дизайн-система Google: правила, компоненты и токены для интерфейсов на Android и в вебе.",
      logo: "assets/logos/foreign-material.svg",
    },
    "shopify-polaris": {
      title: "Polaris",
      description:
        "Система Shopify для админки и приложений — компоненты, стили и иконки для быстрого старта.",
      logo: "assets/logos/foreign-polaris.svg",
    },
    "github-primer": {
      title: "Primer",
      description:
        "Дизайн-система GitHub — компоненты и стили для продуктовых интерфейсов и документации.",
      logo: "assets/logos/foreign-primer.svg",
    },
  };

  for (const s of systems) {
    const p = patch[s.id];
    if (!p) continue;
    s.title = p.title;
    s.description = ensurePeriod(p.description);
    s.logo = p.logo;
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

