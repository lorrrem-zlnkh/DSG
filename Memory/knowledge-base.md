# База знаний проекта DSG

> Актуально на: 2026-06-14 (обновлено в конце дня)  
> Обновлять в конце каждой рабочей сессии.

---

## 1. Проект

| Параметр | Значение |
|----------|---------|
| Название | DSG — Design Systems Guide |
| Сайт | https://dsg.lorrrem.ru |
| Репозиторий | git@github.com:lorrrem-zlnkh/DSG.git |
| Ветка | main |
| Хостинг | REG.RU (FTP/FTPS) |
| FTP IP | 31.31.198.114:21, protocol: ftps |
| FTP server-dir | / (корень, local-dir: ./public/) |
| Dev-сервер | server.mjs, порт 5173 |
| Аналитика | Яндекс Метрика, счётчик 109829058 |
| Telegram-канал | @lorrrem |
| Владелец | Denis Zelenykh |

---

## 2. Структура файлов

```
DSG/
├── public/                         ← всё, что деплоится на хостинг
│   ├── index.html                  ← главная (каталог дизайн-систем)
│   ├── styles.css                  ← все стили сайта
│   ├── site.webmanifest
│   ├── assets/
│   │   ├── brand/logo.png
│   │   ├── icons/facivon lorrem zelenykh DSG.png  ← favicon
│   │   └── zelenykh lorrem anonce.png             ← OG-изображение
│   ├── blog/
│   │   ├── index.html              ← страница дайджестов
│   │   ├── post.html               ← страница отдельного поста
│   │   ├── digests.js              ← клиентский JS рендера дайджестов
│   │   ├── digests.json            ← данные дайджестов (автогенерация, в git)
│   │   └── posts.json              ← собранные статьи (автогенерация, в git)
│   ├── bot/
│   │   ├── webhook.php             ← Telegram webhook + модерация дайджеста (PHP)
│   │   ├── config.php              ← СЕКРЕТЫ (НЕ в git, генерируется при деплое)
│   │   ├── .htaccess               ← запрет HTTP-доступа к *.json в /bot/
│   │   └── draft.json              ← черновик цикла (пишет PHP, НЕ в git)
│   └── automation/
│       └── status.json             ← статус последнего запуска автоматизации
│
├── scripts/
│   ├── fetch-blog.mjs              ← сбор статей из всех источников
│   ├── build-digests.mjs           ← генерация дайджестов через OpenAI
│   ├── run-content-automation.mjs  ← точка входа: fetch → build, lock-файл, статус
│   ├── lib/
│   │   ├── blog-quality.mjs        ← блок-листы URL и паттернов заголовков
│   │   ├── dsgners-urls.mjs        ← список URL для Dsgners/Designers
│   │   └── load-env.mjs            ← загрузка .env
│   └── [прочие вспомогательные скрипты]
│
├── .github/workflows/
│   ├── deploy-ftp.yml              ← деплой при push в main
│   ├── monthly-digest.yml          ← Monthly Digest Rebuild
│   └── pages.yml                   ← GitHub Pages (non-main ветки → staging)
│
├── Memory/
│   └── knowledge-base.md           ← этот файл
│
├── .gitignore                      ← node_modules/, .cache/, .DS_Store, .env, public/bot/config.php
└── package.json
```

---

## 3. package.json — npm скрипты

```json
{
  "name": "design-systems-guide",
  "type": "module",
  "scripts": {
    "scrape":             "sh scripts/scrape.sh",
    "fetch:blog":         "sh scripts/fetch-blog.sh",
    "content:automation": "node scripts/run-content-automation.mjs",
    "build:digests":      "node scripts/build-digests.mjs",
    "telegram:digest":    "node scripts/send-telegram-digest.mjs",
    "rebuild:medium":     "node scripts/rebuild-medium-descriptions.mjs",
    "dev":                "node server.mjs",
    "start":              "node server.mjs"
  },
  "dependencies": {
    "cheerio": "^1.1.2"
  }
}
```

---

## 4. Ветки и деплой

| Ветка | Куда деплоится | Назначение |
|-------|---------------|-----------|
| `main` | FTP → dsg.lorrrem.ru | Продакшн |
| любая non-main | GitHub Pages → lorrrem-zlnkh.github.io/DSG/ | Staging/тест |
| `catalog-update` | GitHub Pages | Обновление каталога дизайн-систем |
| `digest-rebuild` | GitHub Pages | Пересборка всех дайджестов |

**pages.yml** — деплоит все ветки кроме main в GitHub Pages.  
Ветку нужно добавить в Settings → Environments → `github-pages` → Deployment branches, иначе деплой упадёт с ошибкой «Branch not allowed».

---

## 5. GitHub Actions воркфлоу

### deploy-ftp.yml — деплой сайта на продакшн

**Триггеры:** push в main, workflow_dispatch

**Шаги:**
1. `actions/checkout@v4`
2. **Generate bot config** — создаёт `public/bot/config.php` из Secrets:
   ```bash
   {
     echo "<?php"
     echo "define('BOT_TOKEN',      '${TELEGRAM_BOT_TOKEN}');"
     echo "define('MY_CHAT_ID',     '${TELEGRAM_MY_ID}');"
     echo "define('CHANNEL_ID',     '@lorrrem');"
     echo "define('WEBHOOK_SECRET', '${WEBHOOK_SECRET}');"
   } > public/bot/config.php
   ```
   ⚠️ Используется `{ echo; }` а НЕ heredoc — heredoc в YAML ломается из-за отступов
3. **FTP Deploy** — `SamKirkland/FTP-Deploy-Action@v4.3.5`, timeout: 60000ms
4. **Register Telegram webhook:**
   ```bash
   curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
     -d "url=https://dsg.lorrrem.ru/bot/webhook.php" \
     -d "secret_token=${WEBHOOK_SECRET}" \
     -d "allowed_updates=[\"callback_query\",\"message\"]"
   ```
   ⚠️ `message` нужен для ответов force_reply (правка описаний) и кнопок нижней панели

### monthly-digest.yml — сборка дайджеста

**Триггеры:** `cron: '0 8 1 * *'` (1-го числа, 08:00 UTC = 11:00 МСК), workflow_dispatch

**Права:** `contents: write`

**Шаги:**
1. Checkout + Setup Node.js 20 (с кэшем npm) + `npm ci`
2. **Seed base from live site:** `curl -fsS …/blog/digests.json -o public/blog/digests.json` —
   берём за базу опубликованное состояние с хоста (хост = источник правды),
   чтобы генерация не теряла одобренные месяцы
3. `node scripts/run-content-automation.mjs` (env: OPENAI_API_KEY, OPENAI_DIGEST_MODEL=gpt-4o-mini)
4. **Commit snapshot:** коммитит зеркало опубликованного состояния (база с хоста +
   posts.json + status.json). Сгенерированный новый месяц в git НЕ попадает —
   он уходит боту на модерацию
5. **Hand off draft to bot:** `node scripts/send-telegram-digest.mjs` (env: WEBHOOK_SECRET) —
   POST последнего дайджеста на `webhook.php?action=init_draft` (заголовок `X-Bot-Secret`).
   Карточки на модерацию рассылает PHP

### digest-tick.yml — крон бота (НОВЫЙ)

**Триггеры:** `cron: '30 * * * *'` (ежечасно :30 UTC; 15:30 UTC = 18:30 МСК), workflow_dispatch

**Шаг:** `curl -fsS -H "X-Bot-Secret: …" …/webhook.php?action=tick` — бот сам решает:
напомнить (день 5), авто-опубликовать (день 6, 18:30 МСК) или дождаться отложенного времени

### GitHub Secrets (используются в воркфлоу)

| Secret | Назначение |
|--------|-----------|
| FTP_USERNAME | Логин FTP REG.RU |
| FTP_PASSWORD | Пароль FTP REG.RU |
| TELEGRAM_BOT_TOKEN | Токен бота от @BotFather |
| TELEGRAM_MY_ID | chat_id владельца (личный Telegram) |
| WEBHOOK_SECRET | Секрет для верификации Telegram webhook |
| OPENAI_API_KEY | Ключ OpenAI API |

---

## 5. Telegram бот

### Архитектура
- PHP-скрипт на REG.RU хостинге (не нужен отдельный сервер)
- Telegram вызывает webhook при каждом callback_query
- Верификация через заголовок `X-Telegram-Bot-Api-Secret-Token`

### webhook.php — логика (модерация + авто-публикация)

**Принцип:** ничего не уходит на сайт и в канал до подтверждения владельца.
PHP — единственный, кто публикует: пишет живой `public/blog/digests.json` на хост
(сайт обновляется мгновенно) и постит анонс в канал. Без GitHub-токенов.

**Роутинг по входу:**
- `?action=init_draft` (POST из CI, заголовок `X-Bot-Secret`) → сохраняет `draft.json`,
  рассылает владельцу шапку + по карточке на каждый материал + нижнюю reply-панель
- `?action=tick` (GET из крона) → таймлайн: напоминание / авто-публикация / отложенная
- иначе апдейт Telegram (заголовок `X-Telegram-Bot-Api-Secret-Token`):
  `callback_query` + `message`, только от `MY_CHAT_ID`

**draft.json (состояние цикла):**
`status` (pending→reminded/scheduled→published/cancelled), `createdAt`, `remindedAt`,
`scheduledAt`, `digest` (объект месяца), `edits` (itemId→текст), `excluded` (itemId[]),
`cardMsgIds` (itemId→message_id для editMessageText), `prompts` (msgId→{kind,itemId} для force_reply)

**Карточка материала** — inline `✏️ Изменить описание` / `🚫 Исключить`:
- `edit_<id>` → отправляет текущее описание `<code>` (тап-копирование) + force_reply;
  ответ владельца пишется в `edits[id]`, карточка перерисовывается.
  ⚠️ Bot API НЕ умеет предзаполнить редактируемое поле ввода в обычном чате —
  реализовано как «копируемый текст + поле ответа сфокусировано»
- `exclude_<id>` / `include_<id>` → тоггл в `excluded`, кнопка меняется на `↩️ Вернуть`

**Нижняя панель (ReplyKeyboardMarkup, держится весь цикл):**
- `📢 Опубликовать` → инлайн-подтверждение `pub_confirm`/`pub_cancel` → `publishDraft('manual')`
- `🕒 Отложенная публикация` → пресеты `sched_today`/`sched_tomorrow`/`sched_3d`/`sched_manual`
  (ручной ввод `ДД.ММ ЧЧ:ММ` МСК через force_reply) → `scheduledAt`, `status=scheduled`

**Таймлайн (tick, МСК, вечернее окно hour≥18):**
- день 5 (status=pending) → напоминание с `remind_publish`/`remind_cancel`, `status=reminded`
- день 6, ≥24ч после напоминания (status=reminded) → авто-публикация `publishDraft('auto')`
- `scheduledAt` достигнут → `publishDraft('scheduled')` на ближайшем тике
- `remind_cancel` → `status=cancelled`, цикл закрыт

**publishDraft($draft, $mode):**
1. `buildFinalDigest` (применить edits, выкинуть excluded, пересчитать count)
2. Вписать месяц в живой `digests.json` на хосте (убрать дубль по key, в начало, сорт по key↓)
3. Анонс в `CHANNEL_ID` (HTML, `rubricsSummary` + ссылка на /blog/)
4. `status=published`, убрать reply-клавиатуру

### config.php (генерируется при деплое, НЕ в git)
```php
<?php
define('BOT_TOKEN',      '...');
define('MY_CHAT_ID',     '...');
define('CHANNEL_ID',     '@lorrrem');
define('WEBHOOK_SECRET', '...');
```

### SECURITY RULE
⛔ Токены бота НИКОГДА не передавать в чат/переписку.  
Только через GitHub Secrets.  
При утечке — немедленно отозвать: @BotFather → /mybots → API Token → Revoke.

---

## 6. Автоматизация контента

### run-content-automation.mjs — точка входа

- Lock-файл: `.cache/content-automation.lock` (предотвращает параллельный запуск)
- Пишет черновики в `.cache/draft/posts.json` и `.cache/draft/digests.json`
- Статус: `public/automation/status.json`
  - states: `never_run`, `running`, `draft_ready`, `failed`, `already_running`
- Экспортирует: `runContentAutomation()`, `getContentAutomationStatus()`

### Пайплайн: fetch-blog.mjs → build-digests.mjs

---

## 7. Источники статей (fetch-blog.mjs)

### Константы
```js
LOOKBACK_MS = 1000 * 60 * 60 * 24 * 365 * 3  // 3 года
REQUEST_TIMEOUT_MS = 25_000
MAX_POSTS = 1400
MAX_LINKS_PER_PAGE = 180
MAX_ARTICLES_PER_SOURCE = 120
```

### FEED_SOURCES (RSS/Atom)

| source | sourceLabel | URLs |
|--------|-------------|------|
| uxjournal | UX Journal | 3 категории (product-development, ux-design, ui-design) |
| alistapart | A List Apart | main/feed |
| apple-events | Apple Events | rss.art19.com/apple-events |
| infogra | Infogra | infogra.ru/feed |
| medium | Medium | design-pub + 17 тегов (см. ниже) |
| habr | Хабр | 16 поисковых запросов (см. ниже) |

**Medium теги:**
design-systems, ux-design, product-design, user-experience, interaction-design, design-thinking, ui-ux-design, ux-research, usability, accessibility, information-architecture, figma, **web-design, artificial-intelligence, industrial-design, design-tools**

**Habr поисковые запросы (RSS search):**
продуктовый дизайн, design system, дизайн-система, UX, UI, Figma, интерфейс, дизайн, **ИИ дизайн, искусственный интеллект дизайн, веб-дизайн, дизайн интерфейсов, дизайн пользовательского интерфейса, программы для дизайна, инструменты дизайна, промышленный дизайн**

(жирным — добавлены по Wordstat-темам в сессии 2026-06-14)

### PAGE_SOURCES (скрапинг страниц)

| source | sourceLabel | Страницы |
|--------|-------------|---------|
| apple-design | Apple Design | developer.apple.com/design/ |
| apple-events | Apple Events | apple.com/apple-events/ + newsroom |
| material | Material Design | m3.material.io/ |
| tilda-education | Tilda Education | tilda.education/en/ |
| typejournal | Type Journal | typejournal.ru/ (стр. 2–8) |
| kovodstvo | Ководство | artlebedev.ru/kovodstvo/sections/ |
| bureau | Бюро | bureau.ru/soviet/ (maxArticles: 320) |
| habr | Хабр | habr.com/ru/flows/design/articles/ (стр. 2–12) |
| uxjournal | UX Journal | 3 категории (стр. до 10) |
| infogra | Infogra | infogra.ru/ (стр. 2–12) |
| alistapart | A List Apart | alistapart.com/articles/ |
| **figma** | **Figma** | **figma.com/release-notes/** (добавлен 2026-06-13) |

### SITEMAP_SOURCES

| source | sourceLabel | Sitemaps |
|--------|-------------|---------|
| material | Material Design | m3.material.io/sitemap.xml |
| uxjournal | UX Journal | ux-journal.ru/post-sitemap.xml |
| typejournal | Type Journal | typejournal.ru/post-sitemap.xml |
| alistapart | A List Apart | alistapart.com/sitemap.xml |

### DIRECT_ARTICLE_SOURCES

| source | sourceLabel | Источник |
|--------|-------------|---------|
| designers | Dsgners | DSGNERS_SAMPLE_URLS из lib/dsgners-urls.mjs |

### Фильтрация Habr (isRelevantPost)

Пропускается если нет дизайн-сигнала:
```
/(дизайн|интерфейс|ux|ui|usability|figma|прототип|навигац|визуал|типограф|дизайн[ -]?систем|accessibility|доступност|продуктов|пользовател)/i
```
И одновременно есть программерский сигнал без дизайна:
```
/(elixir|phoenix|forth|интерпретатор|latex|c\+\+|алгоритм|параллельн|старое железо|игровые консоли|мандельброт)/i
```

### Блок-лист (blog-quality.mjs)

- Заблокированные URL: `https://habr.com/ru/articles/1027678`
- Заблокированные по паттерну заголовка: `/сделай\s+красиво.+это\s+не\s+промт.+бренд-платформа\s+за\s+8\s+часов/i`

---

## 8. Генерация дайджестов (build-digests.mjs)

### Ключевые константы
```js
DIGEST_SIZE = 35                    // целевой размер дайджеста
MONTHLY_BASE_SIZE = 31              // базовый размер из месячных статей
MIN_HISTORICAL_DIGEST_SIZE = 20
HISTORICAL_SELECTION_TARGET = 20
EVERGREEN_PER_SOURCE = 2            // материалов Бюро/Ководства на дайджест
EVERGREEN_SOURCES = ["bureau", "kovodstvo"]
FLOATING_SOURCES = ["typejournal", "tilda-education", "alistapart", "apple-design", "apple-events"]
FIRST_DIGEST_YEAR = 2024
FIRST_DIGEST_MONTH = 1
DEFAULT_MODEL = "gpt-4o-mini"       // env: OPENAI_DIGEST_MODEL
OPENAI_TIMEOUT_MS = 180_000
```

### За какой месяц строится дайджест

```js
// Дайджест всегда за ПРЕДЫДУЩИЙ месяц
const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
const currentMonthKey = monthKeyFromDate(lastMonth);
```
Запускается 1-го июня → строит дайджест за май. JavaScript корректно обрабатывает month=-1 (декабрь прошлого года).

### Кэширование (пропуск уже готовых месяцев)

```js
// Загружает существующий digests.json
// Если месяц уже есть (count > 0 && items.length > 0) → пропускает
if (monthKey !== currentMonthKey && existingDigestsMap.has(monthKey)) {
  digests.push(existingDigestsMap.get(monthKey));
  continue;
}
```
После единоразовой пересборки всех дайджестов каждый новый запуск будет регенерировать только один текущий (предыдущий) месяц.

### Алгоритм отбора статей для дайджеста

1. **selectMonthlyPosts** — статьи строго за месяц дайджеста, по одной от каждого источника (round-robin), до 31 штуки
2. **selectEvergreenPosts** — 2 материала bureau + 2 материала kovodstvo (без даты, перемешиваются с seed по месяцу)
3. **selectYearFillPosts** — добираем из того же года, если не хватает
4. **selectFloatingPosts** — floating sources (без даты), если всё ещё не хватает
5. **selectReservePosts** — для исторических месяцев, любые без даты
6. Итог перемешивается через `seededShuffle(items, digestMonthKey)`, берётся первые 35

### Генерация через OpenAI

**Endpoint:** `POST /v1/responses`  
**Модель:** gpt-4o-mini (переопределяется env OPENAI_DIGEST_MODEL)  
**max_output_tokens:** 12000  
**Формат ответа:** JSON Schema (structured output, strict: true)

**Schema ответа:**
```json
{
  "title": "string",
  "items": [{
    "id": "string",
    "sourceTitle": "string",
    "summary": "string",
    "excerpt": "string",
    "rubric": "string",
    "author": "string",
    "source": "string",
    "languageBadge": "string | null"
  }]
}
```

### OpenAI системный промпт — полные правила

**Основные:**
- Ты редактор дайджестов по продуктовому дизайну
- summary = ровно 3 связных предложения на русском
- excerpt = пустая строка (summary уже раскрывает суть)
- Оригинальный заголовок не менять
- Для англоязычных → languageBadge='Eng', перевести описание на русский
- Порядок входного списка сохранять (не группировать источники)
- Рубрика: 1–2 слова
- Перед финальным JSON перечитать каждое summary, переписать если остался шаблон

**Запрещённые шаблоны (добавлены 2026-06-14):**
- «Этот материал будет полезен тем, кто...»
- «Автор делится опытом...» без конкретики
- «В статье обсуждаются...» без предмета
- «Данная информация актуальна для...»
- Завершение третьего предложения фразой о целевой аудитории без тезиса

**Правила мероприятий (добавлены 2026-06-13):**
- Включать ТОЛЬКО от: Google, Apple, Figma, Microsoft, Adobe, Meta, Яндекс, ВКонтакте или отраслевых конференций уровня WWDC, Google I/O, Config
- Мероприятия от неизвестных организаций, школ, агентств, локальные — пропускать
- Прошедшее событие → прошедшее время («прошло», «состоялось», «представили»)
- Будущее событие → анонсная форма («пройдёт», «состоится», «объявлено»)

**Прочие запреты:**
- Нельзя писать: 'Краткая суть', 'About Me', 'Continue reading on Medium', обрывки RSS
- Нельзя переносить: дату, ник автора, время чтения, уровень сложности, охват, хабы, меню
- Не копировать вступления от первого лица ('Привет, Хабр', 'Я основатель', 'Меня зовут')
- Не копировать обращения к читателю ('Виктор, ...', 'Вы верно пишете')
- Не делать summary списком заголовков соседних материалов

### Эталонные примеры summary (few-shot, из дайджеста июнь 2026)

Вшиты в промпт как образец стиля:

1. *ИИ в дизайне:* «С ростом возможностей нейросетей многие дизайнеры начинают включать их в свои рабочие процессы, используя ИИ для создания ТЗ и прототипов. Это значительно облегчает проверку гипотез без привлечения разработчиков. Вопрос заключается в том, как именно изменить актуальные процессы с учётом новых технологий.»

2. *UX форм:* «Статья предлагает визуальный чек-лист для создания грамотного UX-дизайна форм. В ней представлены примеры успешных и неудачных решений, что поможет дизайнерам избежать распространённых ошибок при работе с формами ввода. Материал может значительно упростить процесс проектирования.»

3. *Цвет в Material Design:* «Статья рассказывает о создании доступных и персонализированных цветовых схем, отражающих иерархию продукта и его бренд. В ней рассмотрены рекомендации по комбинированию цветов для достижения максимальной эффективности. Этот подход помогает дизайнерам лучше передавать эмоциональное и визуальное восприятие продукта.»

4. *Ководство (локализация):* «В статье рассматриваются традиции использования различных единиц измерения в разных странах. Обсуждается необходимость адаптации дизайна к культурным особенностям локализаций. Поднимаются вопросы интернационализации интерфейсов.»

### Fallback (без OpenAI)

Если OpenAI недоступен или вернул слабый результат — `fallbackDigestItem()` формирует summary из `rewrite` → `summary` поля статьи. Если и они слабые → шаблонная фраза «Материал разбирает тему «{title}» в контексте продуктового дизайна...».

Повторная попытка: если в итоговых items есть `hasGenericFallback` (summary начинается с «Материал разбирает тему «») → ещё один запрос к OpenAI.

### Текущий статус дайджестов

- 30 дайджестов: 2024-01 … 2026-06
- Эталон качества: **2026-06** (июнь 2026)
- После тестирования бота → единоразовая пересборка всех 30 дайджестов по обновлённым правилам

---

## 9. Клиентский JS (public/blog/digests.js)

### DOM-элементы
```js
monthSelect, yearSelect       — селекты навигации
hero                          — #digest-hero (основной блок заголовка)
heroSk                        — #digest-hero-sk (skeleton-плейсхолдер)
digestTitle, digestMeta       — заголовок и мета
digestList                    — список карточек
digestSubscribe               — блок подписки
digestEmpty                   — блок «нет дайджеста»
sentinel                      — #digest-sentinel (для IntersectionObserver)
```

### Рендер
- `BATCH_SIZE = 5` — карточки рендерятся порциями через IntersectionObserver
- `renderDigest()` — первое действие: `if (heroSk) heroSk.hidden = true;`
- Каждая карточка `.digest-item` — ссылка `<a target="_blank" rel="noreferrer">`
- Бейджи: rubric (`.digest-badge--rubric`), source, languageBadge (`.digest-badge--language`)

---

## 10. CSS (public/styles.css)

### Дизайн-токены (:root)
```css
--bg: #0b0f19
--panel: rgba(255,255,255,0.06)
--panel-2: rgba(255,255,255,0.08)
--text: rgba(255,255,255,0.92)
--muted: rgba(255,255,255,0.64)
--border: rgba(255,255,255,0.12)
--shadow: 0 10px 30px rgba(0,0,0,0.35)
--accent: #7c3aed
--accent-2: #5b21b6
--radius: 16px
```

### Фон
```css
body::before — фиксированный градиент:
  radial-gradient(60vw 40vh at 20% 0%, rgba(124,58,237,0.23), transparent 60%)
  radial-gradient(60vw 40vh at 80% 10%, rgba(34,211,238,0.13), transparent 65%)
```

### Логотип (важная деталь каскада!)
```css
/* Базовое правило (строка ~91) */
.brand__logo {
  height: 34px;
  width: auto;
  max-width: 140px;
}

/* Мобильное правило (строка ~620, ПОСЛЕ базового!) */
@media (max-width: 820px) {
  .brand__logo {
    height: 28px !important;
    width: auto !important;
  }
}
```
⚠️ `!important` + расположение ПОСЛЕ базового правила обязательно — иначе каскад не сработает.

### Grid каталога
```css
.grid — repeat(3, 1fr), gap: 16px
@media (max-width: 1120px) → repeat(2, 1fr)
@media (max-width: 820px) → repeat(1, 1fr)  (предположительно)
```

### Skeleton карточек (главная)
```css
@keyframes card-sk-pulse { 0%,100% opacity:0.45; 50% opacity:1 }
.card-sk — базовый блок скелетона
.card-sk--logo — заглушка логотипа
.card-sk--title — заглушка заголовка
.card-sk--text — заглушка текста (длинная)
.card-sk--text-short — заглушка текста (короткая)
.card-sk--btn — заглушка кнопки
.card--skeleton — класс на карточке-контейнере
```
В `#cards` (главная) — 6 карточек `.card.card--skeleton` как начальный контент.

### SEO-абзац
```css
.catalog-desc {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.4;
  max-width: 560px;
}
.footer__meta .catalog-desc { margin-bottom: 4px; }
```
Находится в футере главной страницы.

---

## 11. SEO

### Главная (index.html)
- **title:** «Каталог дизайн-систем — UI Kit, дизайн интерфейсов, Figma | DSG»
- **description:** «Актуальный каталог дизайн-систем для продуктового дизайна и дизайна интерфейсов. Российские и зарубежные UI Kit — ссылки на гайдлайны, Figma и GitHub.»
- **keywords:** дизайн система, дизайн-система, design system, ui kit, дизайн интерфейсов, дизайн пользовательского интерфейса, ux дизайн, продуктовый дизайн, figma, storybook, гайдлайны, ui ux и др.

### OG теги (на всех страницах)
```html
<meta property="og:image" content="https://dsg.lorrrem.ru/assets/zelenykh%20lorrem%20anonce.png" />
<meta property="og:image:secure_url" content="https://dsg.lorrrem.ru/assets/zelenykh%20lorrem%20anonce.png" />
<meta property="og:image:type" content="image/png" />
<meta property="og:image:width" content="720" />
<meta property="og:image:height" content="440" />
<meta property="vk:image" content="https://dsg.lorrrem.ru/assets/zelenykh%20lorrem%20anonce.png" />
```
Для VK нужен `og:image:secure_url` (https) — без него ВКонтакте не подтягивает картинку.  
Кэш VK чистить через: vk.com/dev/pages?act=debugger

### Favicon
```html
<link rel="icon" href="./assets/icons/facivon lorrem zelenykh DSG.png" type="image/png" />
```

---

## 12. Известные проблемы и их решения

| Проблема | Причина | Решение |
|----------|---------|---------|
| Heredoc в YAML не закрывается | Отступы перед `EOF` — терминатор не совпадает | Использовать `{ echo "..."; } > file` |
| Mobile logo не меняет размер | Медиа-правило стояло ДО базового `.brand__logo` | Перенести `@media` ПОСЛЕ базового + `!important` |
| VK не подтягивает OG картинку | Нет `og:image:secure_url` (https) | Добавить `og:image:secure_url` + `vk:image` |
| Telegram webhook 404 | Устаревший/отозванный токен бота | Получить новый: @BotFather → /mybots → API Token |
| Skeleton дайджеста накладывается | `#digest-hero` изначально скрыт — skeleton занимал не то место | Добавить `#digest-hero-sk` плейсхолдер того же размера |
| Digest rebuild регенерирует все месяцы | Не было кэша | Загружать существующий digests.json, пропускать готовые |
| Wordstat scraping | CAPTCHA + JS-рендеринг | Нецелесообразен; для API нужен Яндекс.Директ аккаунт |

---

## 13. Каталог дизайн-систем (public/data/systems.json)

### Текущее состояние (2026-06-14): 46 систем

**Структура записи:**
```json
{
  "id": "companies-alfabank",
  "origin": "domestic",        // "domestic" | "foreign"
  "title": "Альфа-Банк",
  "description": "...",
  "logo": "assets/logos/companies-alfabank.png",
  "links": {
    "site": null,
    "github": "https://...",
    "figma": null
  }
}
```

**Отечественные (26):**
Альфа-Банк, БАРС Груп, Вконтакте, Газпром нефть, Госуслуги, Дизайн государственных систем, Контур, МегаФон, Райффайзенбанк, Рамблер, Росатом, Ростелеком, Тинькофф, Центр Финансовых Технологий, Яндекс, Atomaro, B2B Center, BSS, Cloud.ru, Gravity UI, HSE, ISPsystem, IVI, Mail.ru Group, Semrush, t2

**Зарубежные (17):**
Airbnb DLS, Apple UI Kits, Atlassian, Buzzfeed Solid, Carbon (IBM), Fluent 2 (Microsoft), FutureLearn, IBM Design Language, Lightning (Salesforce), MailChimp, Material Design (Google), Nordnet, Polaris (Shopify), Primer (GitHub), SAP Fiori, Ubuntu, Yelp

Удалены намеренно: BBC GEL, Lonely Planet Rizzo, WeWork Plasma

**Логотипы:**
- Отечественные: `public/assets/logos/companies-{id}.png`
- Зарубежные: `public/assets/logos/foreign/{id}.png`

**Ветка с обновлением:** `catalog-update` (нужно разрешить в GitHub Pages environments для staging)

**Источники парсинга каталога:**
- https://ux-journal.ru/design-systems-club-global-version-katalog-zarubezhnyh-dizajn-sistem.html
- https://vc.ru/design/972707-...
- artlebedev.ru/design-systems/ (возвращал пустую страницу)
- designsystemsrepo.com (пользователь отклонил парсинг)

---

## 14. Статус задач (2026-06-14)

| Задача | Статус |
|--------|--------|
| FTP деплой настроен | ✅ |
| Telegram бот подключён (webhook) | ✅ |
| Monthly Digest воркфлоу работает | ✅ |
| Дайджест строится за предыдущий месяц | ✅ |
| Кэш — пропуск готовых месяцев | ✅ |
| Figma Release Notes как источник | ✅ |
| Wordstat темы добавлены в Habr/Medium | ✅ |
| Few-shot примеры + запрет шаблонов в промпте | ✅ |
| Правила мероприятий в промпте | ✅ |
| GitHub Pages staging (non-main ветки) | ✅ |
| **Модерация дайджеста ботом (карточки, правка, исключение)** | 🆕 реализовано, нужен тест на хосте |
| **Публикация на сайт+канал только после подтверждения** | 🆕 реализовано |
| **Авто-публикация (день 5 напоминание → день 6 18:30)** | 🆕 реализовано, нужен прогон tick |
| **digest-tick.yml (часовой крон)** | 🆕 добавлен |
| **Тест бота после деплоя** | ⏳ ожидаем |
| **Единоразовая пересборка ВСЕХ дайджестов** | 📋 после теста бота |
| После пересборки — только один месяц за раз | 📋 уже реализовано |
| **Каталог: новые системы добавлены, 3 удалены** | ✅ смерджено в main (43 системы) |
