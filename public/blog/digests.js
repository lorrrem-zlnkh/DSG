const monthSelect = document.getElementById("month-select");
const yearSelect = document.getElementById("year-select");
const hero = document.getElementById("digest-hero");
const digestTitle = document.getElementById("digest-title");
const digestMeta = document.getElementById("digest-meta");
const digestList = document.getElementById("digest-list");
const digestEmpty = document.getElementById("digest-empty");
const sentinel = document.getElementById("digest-sentinel");

const BATCH_SIZE = 5;

let digests = [];
let currentDigest = null;
let renderedCount = 0;
let observer = null;

function decodeHtmlEntities(value) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = String(value || "");
  return textarea.value;
}

function unique(values) {
  return Array.from(new Set(values));
}

function buildOption(value, label) {
  const option = document.createElement("option");
  option.value = String(value);
  option.textContent = label;
  return option;
}

function resetList() {
  digestList.innerHTML = "";
  renderedCount = 0;
}

function createBadge(label, modifier = "") {
  const span = document.createElement("span");
  span.className = `digest-badge${modifier ? ` ${modifier}` : ""}`;
  span.textContent = label;
  return span;
}

function renderNextBatch() {
  if (!currentDigest) return;

  const nextSlice = currentDigest.items.slice(renderedCount, renderedCount + BATCH_SIZE);
  for (const item of nextSlice) {
    const article = document.createElement("a");
    article.className = "digest-item";
    article.href = item.url;
    article.target = "_blank";
    article.rel = "noreferrer";

    const title = document.createElement("div");
    title.className = "digest-item__title";
    title.textContent = decodeHtmlEntities(item.sourceTitle);

    const summary = document.createElement("p");
    summary.className = "digest-item__summary";
    const summaryText = decodeHtmlEntities(item.summary);
    const excerptText = decodeHtmlEntities(item.excerpt || "");
    const shouldAppendExcerpt = excerptText && excerptText !== summaryText;
    summary.textContent = shouldAppendExcerpt ? `${summaryText} ${excerptText}` : summaryText;

    const badges = document.createElement("div");
    badges.className = "digest-item__badges";
    badges.append(createBadge(item.rubric, "digest-badge--rubric"));
    badges.append(createBadge(item.author));
    badges.append(createBadge(item.source));
    if (item.languageBadge) {
      badges.append(createBadge(item.languageBadge, "digest-badge--language"));
    }

    article.append(title, summary, badges);
    digestList.append(article);
  }

  renderedCount += nextSlice.length;

  if (renderedCount >= currentDigest.items.length && observer) {
    observer.disconnect();
  }
}

function renderDigest(digest) {
  currentDigest = digest;
  resetList();

  if (!digest) {
    hero.hidden = true;
    digestList.hidden = true;
    digestEmpty.hidden = false;
    return;
  }

  digestTitle.textContent = digest.number ? `Выпуск №${digest.number}` : digest.title;
  digestMeta.textContent = `${digest.count} материалов · ${digest.monthLabel}, ${digest.year}`;

  hero.hidden = false;
  digestList.hidden = false;
  digestEmpty.hidden = true;

  renderNextBatch();

  if (observer) observer.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      renderNextBatch();
    }
  });
  observer.observe(sentinel);
}

function syncMonthOptions() {
  const selectedYear = Number(yearSelect.value);
  const months = digests
    .filter((digest) => digest.year === selectedYear)
    .map((digest) => ({ value: digest.month, label: digest.monthLabel }))
    .sort((a, b) => b.value - a.value);

  const currentMonth = Number(monthSelect.value);
  monthSelect.innerHTML = "";
  for (const month of months) {
    monthSelect.append(buildOption(month.value, month.label));
  }

  const hasCurrentMonth = months.some((month) => month.value === currentMonth);
  if (hasCurrentMonth) {
    monthSelect.value = String(currentMonth);
  }
}

function selectDigest() {
  const digest = digests.find(
    (entry) => entry.year === Number(yearSelect.value) && entry.month === Number(monthSelect.value)
  );
  renderDigest(digest || null);
}

function initSelectors() {
  const years = unique(digests.map((digest) => digest.year)).sort((a, b) => b - a);
  yearSelect.innerHTML = "";
  for (const year of years) {
    yearSelect.append(buildOption(year, String(year)));
  }

  if (digests[0]) {
    yearSelect.value = String(digests[0].year);
  }

  syncMonthOptions();

  if (digests[0]) {
    monthSelect.value = String(digests[0].month);
  }

  yearSelect.addEventListener("change", () => {
    syncMonthOptions();
    selectDigest();
  });

  monthSelect.addEventListener("change", selectDigest);
}

async function loadDigests() {
  let data = null;
  const isFile = location.protocol === "file:";

  if (!isFile) {
    try {
      const apiResponse = await fetch("/api/digests", { cache: "no-store" });
      if (apiResponse.ok) {
        data = await apiResponse.json();
      }
    } catch {
      // fallback to static file
    }
  }

  if (!data) {
    const url = new URL("digests.json", location.href);
    const response = await fetch(url, { cache: "no-store" });
    data = await response.json();
  }

  digests = data.digests || [];

  initSelectors();
  selectDigest();
}

loadDigests().catch(() => {
  if (location.protocol === "file:" && digestEmpty) {
    digestEmpty.textContent =
      "Дайджесты не могут загрузиться при открытии через file://. Открой страницу через локальный сервер, например http://127.0.0.1:8009/public/blog/.";
  }
  renderDigest(null);
});
