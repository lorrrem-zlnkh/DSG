async function hydrateNavLinks() {
  const linkNodes = Array.from(document.querySelectorAll("[data-link]"));
  if (linkNodes.length === 0) return;

  const candidates = [
    new URL("data/site.json", document.baseURI),
    new URL("../data/site.json", document.baseURI),
    "/data/site.json",
  ];

  let data = null;
  for (const url of candidates) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) continue;
      data = await response.json();
      break;
    } catch {
      // try next candidate
    }
  }

  if (!data) return;
  const links = data?.links || {};

  for (const node of linkNodes) {
    const key = node.dataset.link;
    const href = links[key];
    if (!href) continue;
    node.href = href;
  }
}

hydrateNavLinks().catch(() => {});
