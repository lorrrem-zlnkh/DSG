import fs from "node:fs/promises";

const SYSTEMS_PATH = new URL("../public/data/systems.json", import.meta.url);

function nowIso() {
  return new Date().toISOString();
}

function upsert(systems, item) {
  const idx = systems.findIndex((s) => s.id === item.id);
  if (idx === -1) systems.push(item);
  else systems[idx] = { ...systems[idx], ...item };
}

async function main() {
  const raw = await fs.readFile(SYSTEMS_PATH, "utf8");
  const data = JSON.parse(raw);
  const systems = Array.isArray(data.systems) ? data.systems : [];

  const foreign = [
    {
      id: "airbnb-dls",
      origin: "foreign",
      title: "Airbnb Design Language System (DLS)",
      description:
        "Дизайн-язык Airbnb; публичного официального UI kit в Figma нет, ниже — Community файл с принципами.",
      companyPageUrl: "https://karrisaarinen.com/dls/",
      logo: null,
      links: {
        site: "https://karrisaarinen.com/dls/",
        github: null,
        figma: "https://www.figma.com/community/file/1141243932242668736",
      },
      source: { curatedAt: nowIso() },
    },
    {
      id: "material-design",
      origin: "foreign",
      title: "Material Design (Google)",
      description: "Дизайн-система Google для Android, Web и других платформ.",
      companyPageUrl: "https://m3.material.io/",
      logo: null,
      links: {
        site: "https://m3.material.io/",
        github: null,
        figma: "https://www.figma.com/community/file/1035203688168086460/material-3-design-kit",
      },
      source: { curatedAt: nowIso() },
    },
    {
      id: "apple-ui-kits",
      origin: "foreign",
      title: "Apple UI Kits (iOS/iPadOS)",
      description: "Официальные UI kits Apple в Figma (через UI kits).",
      companyPageUrl: "https://developer.apple.com/design/human-interface-guidelines/",
      logo: null,
      links: {
        site: "https://developer.apple.com/design/human-interface-guidelines/",
        github: null,
        figma:
          "https://www.figma.com/community/file/1527721578857867021/ios-and-ipados-26-ui-kit",
      },
      source: { curatedAt: nowIso() },
    },
    {
      id: "ibm-carbon",
      origin: "foreign",
      title: "Carbon (IBM)",
      description: "Открытая дизайн-система IBM для продуктов и цифровых опытов.",
      companyPageUrl: "https://carbondesignsystem.com/",
      logo: null,
      links: {
        site: "https://carbondesignsystem.com/",
        github: "https://github.com/carbon-design-system/carbon",
        figma: "https://www.figma.com/design/YAnB1jKx0yCUL29j6uSLpg/-v11--Carbon-Design-System?m=auto",
      },
      source: { curatedAt: nowIso() },
    },
    {
      id: "microsoft-fluent-2",
      origin: "foreign",
      title: "Fluent 2 (Microsoft)",
      description: "Дизайн-система Microsoft; UI kits в Figma для Web/iOS.",
      companyPageUrl: "https://fluent2.microsoft.design/",
      logo: null,
      links: {
        site: "https://fluent2.microsoft.design/",
        github: null,
        figma: "https://www.figma.com/community/file/836828295772957889/Microsoft-Fluent-2-Web",
      },
      source: { curatedAt: nowIso() },
    },
    {
      id: "shopify-polaris",
      origin: "foreign",
      title: "Polaris (Shopify)",
      description: "Дизайн-система Shopify для Admin; публичные Figma ресурсы.",
      companyPageUrl: "https://polaris.shopify.com/",
      logo: null,
      links: {
        site: "https://polaris.shopify.com/",
        github: "https://github.com/Shopify/polaris",
        figma: "https://www.figma.com/community/file/1293611962331823010/polaris-components",
      },
      source: { curatedAt: nowIso() },
    },
    {
      id: "atlassian-ads",
      origin: "foreign",
      title: "Atlassian Design System (ADS)",
      description: "Дизайн-система Atlassian; публичные Figma ресурсы через Community.",
      companyPageUrl: "https://atlassian.design/design-system/",
      logo: null,
      links: {
        site: "https://atlassian.design/design-system/",
        github: null,
        figma: "https://www.figma.com/@atlassian",
      },
      source: { curatedAt: nowIso() },
    },
    {
      id: "github-primer",
      origin: "foreign",
      title: "Primer (GitHub)",
      description: "Дизайн-система GitHub; публичные библиотеки в Figma Community.",
      companyPageUrl: "https://primer.style/",
      logo: null,
      links: {
        site: "https://primer.style/",
        github: "https://github.com/primer/figma",
        figma: "https://www.figma.com/@primer",
      },
      source: { curatedAt: nowIso() },
    },
    {
      id: "salesforce-lightning",
      origin: "foreign",
      title: "Lightning (Salesforce)",
      description: "Salesforce Lightning Design System; есть Figma UI Kit.",
      companyPageUrl: "https://www.lightningdesignsystem.com/",
      logo: null,
      links: {
        site: "https://www.lightningdesignsystem.com/",
        github: null,
        figma: "https://www.figma.com/@salesforce",
      },
      source: { curatedAt: nowIso() },
    }
  ];

  for (const item of foreign) upsert(systems, item);

  systems.sort((a, b) => a.title.localeCompare(b.title, "ru"));

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
