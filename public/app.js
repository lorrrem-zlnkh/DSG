const cardsEl = document.getElementById("cards");
const emptyEl = document.getElementById("empty");
const template = document.getElementById("card-template");

const toggles = Array.from(document.querySelectorAll(".toggle"));
const toggleItems = Array.from(document.querySelectorAll(".toggle__item"));
const mobileQuery = window.matchMedia("(max-width: 620px), (hover: none) and (pointer: coarse)");

let allSystems = [];
let shuffledByOrigin = new Map();
let currentOrigin = "domestic";
let lastScrollY = window.scrollY;
let scrollTicking = false;

const ORDER_STORAGE_PREFIX = "dsg:order:";

function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function safeParseJson(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getStableOrder(origin, systems) {
  const key = `${ORDER_STORAGE_PREFIX}${origin}`;
  const stored = safeParseJson(localStorage.getItem(key));
  const storedIds = Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : [];

  const byId = new Map(systems.map((s) => [s.id, s]));
  const ordered = [];
  const seen = new Set();

  for (const id of storedIds) {
    const system = byId.get(id);
    if (!system) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(system);
  }

  const remaining = [];
  for (const system of systems) {
    if (!seen.has(system.id)) remaining.push(system);
  }

  const next = ordered.concat(shuffle(remaining));

  const nextIds = next.map((s) => s.id);
  if (nextIds.length !== storedIds.length || nextIds.some((id, i) => id !== storedIds[i])) {
    localStorage.setItem(key, JSON.stringify(nextIds));
  }

  return next;
}

function buildShuffles() {
  const origins = new Set(allSystems.map((s) => s.origin));
  shuffledByOrigin = new Map();
  for (const origin of origins) {
    shuffledByOrigin.set(origin, getStableOrder(origin, allSystems.filter((s) => s.origin === origin)));
  }
}

function setToggle(origin) {
  currentOrigin = origin;
  for (const el of toggleItems) {
    el.classList.toggle("toggle__item--active", el.dataset.origin === origin);
  }
  render();
}

function syncMobileSwitchVisibility() {
  if (!mobileQuery.matches) {
    document.body.classList.remove("switch-hidden");
    lastScrollY = window.scrollY;
    return;
  }

  if (window.scrollY <= 16) {
    document.body.classList.remove("switch-hidden");
    lastScrollY = window.scrollY;
    return;
  }

  const scrollingDown = window.scrollY > lastScrollY;
  document.body.classList.toggle("switch-hidden", scrollingDown);
  lastScrollY = window.scrollY;
}

function onScroll() {
  if (scrollTicking) return;
  scrollTicking = true;

  window.requestAnimationFrame(() => {
    syncMobileSwitchVisibility();
    scrollTicking = false;
  });
}

function createCard(system) {
  const node = template.content.firstElementChild.cloneNode(true);
  const logo = node.querySelector(".card__logo");
  const logoFallback = node.querySelector(".card__logo-fallback");
  const title = node.querySelector(".card__title");
  const desc = node.querySelector(".card__desc");

  const hasLogo = Boolean(system.logo);
  if (hasLogo) {
    logo.src = `./${system.logo}`;
    logo.alt = system.title ? `Логотип: ${system.title}` : "Логотип";
    logo.style.display = "";
    logoFallback.style.display = "none";
  } else {
    logo.removeAttribute("src");
    logo.style.display = "none";
    logoFallback.style.display = "inline-flex";
    logoFallback.textContent = (system.title || "?").trim().slice(0, 2).toUpperCase();
  }
  title.textContent = system.title;
  desc.textContent = system.description;

  const links = node.querySelectorAll(".icon-link");
  for (const linkEl of links) {
    const kind = linkEl.dataset.kind;
    const href = system.links?.[kind];
    if (!href) {
      linkEl.remove();
      continue;
    }
    linkEl.href = href;
  }

  return node;
}

function render() {
  cardsEl.innerHTML = "";
  const filtered =
    shuffledByOrigin.get(currentOrigin) ||
    allSystems.filter((s) => s.origin === currentOrigin);
  for (const system of filtered) {
    cardsEl.appendChild(createCard(system));
  }
  emptyEl.hidden = filtered.length !== 0;
}

async function load() {
  const systemsRes = await fetch("./data/systems.json", { cache: "no-store" });

  const systemsData = await systemsRes.json();

  allSystems = systemsData.systems || [];
  buildShuffles();
  render();
}

for (const toggle of toggles) {
  toggle.addEventListener("click", (e) => {
    const target = e.target.closest(".toggle__item");
    if (!target) return;
    setToggle(target.dataset.origin);
  });
}

mobileQuery.addEventListener("change", syncMobileSwitchVisibility);
window.addEventListener("scroll", onScroll, { passive: true });
syncMobileSwitchVisibility();

await load();
