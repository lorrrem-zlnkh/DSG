const cardsEl = document.getElementById("cards");
const emptyEl = document.getElementById("empty");
const template = document.getElementById("card-template");

const toggle = document.querySelector(".toggle");
const toggleItems = Array.from(document.querySelectorAll(".toggle__item"));

const addTop = document.getElementById("add-system-top");
const addBottom = document.getElementById("add-system-bottom");
const support = document.getElementById("support-project");

let allSystems = [];
let shuffledByOrigin = new Map();
let currentOrigin = "domestic";

function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildShuffles() {
  const origins = new Set(allSystems.map((s) => s.origin));
  shuffledByOrigin = new Map();
  for (const origin of origins) {
    shuffledByOrigin.set(
      origin,
      shuffle(allSystems.filter((s) => s.origin === origin))
    );
  }
}

function setToggle(origin) {
  currentOrigin = origin;
  for (const el of toggleItems) {
    el.classList.toggle("toggle__item--active", el.dataset.origin === origin);
  }
  render();
}

function setExternalLinks(site) {
  const addUrl = site?.links?.addSystem || "#";
  addTop.href = addUrl;
  addBottom.href = addUrl;

  const supportUrl = site?.links?.supportProject;
  if (supportUrl) {
    support.href = supportUrl;
    support.removeAttribute("aria-disabled");
    support.style.pointerEvents = "";
    support.style.opacity = "";
  } else {
    support.href = "#";
    support.setAttribute("aria-disabled", "true");
    support.style.pointerEvents = "none";
    support.style.opacity = "0.6";
  }
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
    logo.alt = "";
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
  const [systemsRes, siteRes] = await Promise.all([
    fetch("./data/systems.json", { cache: "no-store" }),
    fetch("./data/site.json", { cache: "no-store" }),
  ]);

  const systemsData = await systemsRes.json();
  const siteData = await siteRes.json();

  allSystems = systemsData.systems || [];
  buildShuffles();
  setExternalLinks(siteData);
  render();
}

toggle.addEventListener("click", (e) => {
  const target = e.target.closest(".toggle__item");
  if (!target) return;
  setToggle(target.dataset.origin);
});

await load();
