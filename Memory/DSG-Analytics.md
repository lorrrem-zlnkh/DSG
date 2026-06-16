---
tags: [project/dsg, analytics, architecture]
updated: 2026-06-16
---

# DSG — Design Systems Guide: Полная аналитика проекта

## 1. Общее описание

**DSG (Design Systems Guide)** — русскоязычный справочник дизайн-систем и ежемесячный дайджест статей о дизайне, UX/UI, типографике и продуктовом мышлении.

| Параметр | Значение |
|---|---|
| Продакшн-адрес | https://dsg.lorrrem.ru |
| Staging (GitHub Pages) | https://lorrrem-zlnkh.github.io/DSG/ |
| Репозиторий | github.com/lorrrem-zlnkh/DSG |
| Тип сайта | Статический (без сборщика) |
| Runtime | Node.js 24 (ESM) — только для скриптов |
| Хостинг прод | REG.RU shared (FTP-деплой) |
| Хостинг staging | GitHub Pages |
| Telegram-канал | @lorrrem |
| Владелец | Denis Zelenykh |

---

## 2. Архитектура системы

```
┌─────────────────────────────────────────────────────┐
│                  Контентный пайплайн                 │
│                                                     │
│  GitHub Actions (cron: 1-е число, 08:00 UTC)        │
│       │                                             │
│       ▼                                             │
│  fetch-blog.mjs ──► RSS / HTML-парсинг ──► posts.json│
│       │                                             │
│       ▼                                             │
│  build-digests.mjs ──► LLM API ──► draft/digests.json│
│       │                                             │
│       ▼                                             │
│  rewrite-digest-descriptions.mjs (quality pass)     │
│       │                                             │
│       ▼                                             │
│  send-telegram-digest.mjs ──► webhook.php?init_draft │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│              Бот-модератор (Telegram)                │
│                                                     │
│  webhook.php (PHP на REG.RU)                        │
│  ┌──────────────────────────────────────┐           │
│  │  init_draft ─► карточки владельцу   │           │
│  │  callback_query: edit / exclude      │           │
│  │  /publish ─► digests.json на хосте  │           │
│  │             + пост в @lorrrem        │           │
│  └──────────────────────────────────────┘           │
│                                                     │
│  digest-tick.yml (cron: каждый час :30)             │
│  └─► curl webhook.php?action=tick                   │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│                 Деплой-пайплайн                     │
│                                                     │
│  push main ─► deploy-ftp.yml                       │
│               ├─ генерирует config.php из Secrets   │
│               ├─ FTP → REG.RU (dsg.lorrrem.ru)      │
│               └─ setWebhook Telegram                │
│                                                     │
│  push non-main ─► pages.yml                        │
│               └─ GitHub Pages (staging)             │
└─────────────────────────────────────────────────────┘
```

---

## 3. Структура файлов

```
DSG/
├── public/                      # Весь фронтенд — деплоится на хостинг as-is
│   ├── index.html               # SPA-оболочка каталога
│   ├── blog/
│   │   ├── index.html           # Страница дайджестов
│   │   ├── digests.json         # Данные дайджестов (публикует бот)
│   │   └── posts.json           # Кэш статей (1400 шт., 3 года)
│   ├── data/
│   │   ├── systems.json         # Каталог: 43 системы (26 РФ + 17 зарубежных)
│   │   └── site.json            # Ссылки (tg, cloudtips)
│   ├── assets/
│   │   ├── brand/logo.svg
│   │   ├── logos/               # Логотипы систем
│   │   │   ├── companies-*.png  # Отечественные
│   │   │   └── foreign/         # Зарубежные
│   │   └── css/, js/
│   ├── automation/
│   │   └── status.json          # Статус последнего прогона автоматизации
│   └── bot/
│       ├── webhook.php          # Telegram-бот модератор (~700 строк PHP)
│       ├── config.php           # Генерируется из Secrets при деплое (не в git)
│       ├── draft.json           # Текущий черновик на модерации (не в git)
│       └── pool-YYYY-MM.json    # Пул ссылок от владельца (не в git)
│
├── scripts/                     # Node.js 24 ESM-автоматизация
│   ├── run-content-automation.mjs   # Точка входа — lock + orchestrator
│   ├── fetch-blog.mjs               # Парсер источников
│   ├── build-digests.mjs            # LLM-генератор дайджестов
│   ├── send-telegram-digest.mjs     # Хэндофф черновика боту
│   ├── rewrite-digest-descriptions.mjs  # quality pass (Sonnet)
│   ├── rebuild-medium-descriptions.mjs  # Разовый ретроактивный рерайт
│   └── lib/
│       ├── llm.mjs              # Провайдер-абстракция (OpenAI / Claude)
│       ├── blog-quality.mjs     # Фильтрация мусорных описаний
│       ├── load-env.mjs         # Загрузка .env
│       └── dsgners-urls.mjs     # Список URL dsgners.ru
│
├── .github/workflows/
│   ├── deploy-ftp.yml           # push main → FTP → webhook
│   ├── monthly-digest.yml       # cron 1-е число → дайджест
│   ├── pages.yml                # non-main → GitHub Pages
│   ├── digest-tick.yml          # cron каждый час → tick
│   ├── bot-diag.yml             # ручной workflow — диагностика webhook
│   ├── bot-cleanup.yml          # ручная очистка бота
│   └── bot-resend.yml           # ручная переотправка дайджеста
│
├── Memory/
│   ├── knowledge-base.md        # Актуальная база знаний проекта
│   └── DSG-Analytics.md         # Этот файл
│
├── package.json                 # dependencies: cheerio ^1.1.2
├── server.mjs                   # Локальный дев-сервер
└── CLAUDE.md                    # Правила для Claude Code (все чаты)
```

---

## 4. Каталог дизайн-систем

### Состав (43 системы, на 2026-06-16)

| Origin | Количество |
|---|---|
| Отечественные | 26 |
| Зарубежные | 17 |
| **Итого** | **43** |

### Структура записи `systems.json`

```json
{
  "id": "material",
  "origin": "foreign",
  "title": "Material Design",
  "description": "...",
  "logo": "assets/logos/foreign/material.png",
  "links": {
    "site": "https://m3.material.io/",
    "github": "https://github.com/material-components",
    "figma": "https://..."
  }
}
```

### Зарубежные системы (17)

Apple HIG, Material Design, Ant Design, Carbon (IBM), Fluent (Microsoft), Atlassian, Salesforce Lightning, Shopify Polaris, Buzzfeed Solid, FutureLearn, IBM Design Language, MailChimp, SAP Fiori, Ubuntu, Yelp, Nordnet, + одна ещё

### Источники для пополнения каталога

- designsystemsrepo.com
- vc.ru / ux-journal.ru / artlebedev.ru

---

## 5. Контентная автоматизация

### 5.1 Источники статей

**RSS/Atom-фиды:**

| Источник | Ключевые URL |
|---|---|
| UX Journal | ux-journal.ru/category/*/feed/ |
| A List Apart | alistapart.com/main/feed/ |
| Apple Events | rss.art19.com/apple-events |
| Infogra | infogra.ru/feed |
| Medium | medium.com/feed/tag/design-systems + 16 тегов |
| Type Journal | typejournal.ru/feed |
| Хабр | habr.com/ru/rss/search/?q=… (15 запросов) |

**HTML-парсинг страниц:**

| Источник | Метод |
|---|---|
| Apple Design | developer.apple.com/design/ — извлечение ссылок |
| Material Design | m3.material.io/sitemap.xml |
| Tilda Education | tilda.education/en/ |
| Type Journal | typejournal.ru (WP пагинация стр. 2–8) |
| Ководство | artlebedev.ru/kovodstvo/sections/ |
| Бюро Горбунова | bureau.ru/soviet/ (макс. 320 материалов) |
| Хабр | habr.com/ru/flows/design/ пагинация |
| UX Journal | 3 категории × пагинация |
| Infogra | WP пагинация |
| A List Apart | alistapart.com/articles/ |
| Figma | figma.com/release-notes/ |

**Прямые URL / API:**

| Источник | Метод |
|---|---|
| Dsgners.ru | Inertia.js (Accept: application/json → Editor.js блоки) |

**Параметры парсинга:**
- `LOOKBACK_MS` = 3 года
- `MAX_POSTS` = 1400
- `MAX_LINKS_PER_PAGE` = 180
- `MAX_ARTICLES_PER_SOURCE` = 120

### 5.2 Обработка текста

**Цепочка обработки для каждой статьи:**

1. `fetchText` / `fetchJson` — HTTP с таймаутом 25 с, User-Agent DSGDigestBot/1.0
2. `parseArticle` (cheerio) — title (og:title → title → h1), author, publishedAt, body
3. `sanitizeArticleText` — strip HTML, убрать Habr-таксономию, шумовые паттерны
4. `toSummary` — первые 260 символов
5. `toRewrite` — до 12 предложений, сгруппированных в абзацы
6. `isUsefulInput` + `isRelevantPost` — фильтрация мусора

**Особые случаи:**
- Хабр: проверка `isRelevantPost` — обязателен дизайн-сигнал (UX/UI/дизайн/figma…), нет чисто IT-тем
- Бюро: URL формата `/soviet/YYYYMMDD/` → дата из URL
- Dsgners.ru: Editor.js JSON → `dsgnersBlocksToText` → стандартный пост
- Дедупликация: по URL + по titleKey (source:title)

### 5.3 LLM-генерация дайджеста

**`build-digests.mjs` — логика формирования выпуска:**

```
DIGEST_SIZE = 35 статей на выпуск
MONTHLY_BASE_SIZE = 31 (свежие статьи)
HISTORICAL_SELECTION_TARGET = 20 (для архивных выпусков 2024)
EVERGREEN_PER_SOURCE = 2 (bureau, kovodstvo — вечнозелёные)
FLOATING_SOURCES = typejournal, tilda-education, alistapart, apple-design, apple-events
```

**Инферрирование рубрики (локально, без LLM):**

| Ключевые слова | Рубрика |
|---|---|
| token/токен | Токены |
| research/исследован | Исследования |
| system/система/component | Дизайн-системы |
| figma/prototype | Инструменты |
| product/продукт/метрик | Продукт |
| остальное | Практика |

**Качественный проход (`rewrite-digest-descriptions.mjs`):**
- Claude Sonnet 4.6 — свежий фетч каждой статьи + переписывание описания
- Анти-штамп gate — фильтрует клише («Материал разбирает тему…»)
- Некритичный шаг: при сбое пайплайн продолжается с описаниями от build-digests

### 5.4 Пул ссылок от владельца

Владелец присылает ссылки через Telegram-бота в любое время. Они накапливаются в `pool-YYYY-MM.json` по месяцам. При сборке дайджеста:

1. CI вызывает `?action=pool_consume&month=YYYY-MM` — бот отдаёт выбранные URL
2. Скрипт фетчит их как статьи + нейтральный рерайт (не дизайн-промпт!)
3. Если присланных `≥ DIGEST_SIZE` — RSS-парсинг пропускается

**Нейтральный рерайт (`MANUAL_REWRITE_SYSTEM`):** 3 предложения на русском, любая тема, без клише.

---

## 6. Бот-модератор (webhook.php)

### Жизненный цикл дайджеста

```
CI генерирует черновик
    │
    ▼
send-telegram-digest.mjs → POST /webhook.php?action=init_draft
    │                       (JSON с дайджестом)
    ▼
PHP сохраняет draft.json
PHP отправляет карточки владельцу (тихие уведомления)
    │
    ▼
Владелец в Telegram:
  ✏️ Изменить описание → force_reply → PHP сохраняет правку
  🚫 Исключить → помечает excluded
  ↩️ Вернуть → убирает из excluded
  /pool → список присланных ссылок
  /publish → публикует финальный дайджест
    │
    ▼
PHP:
  1. buildFinalDigest (применяет правки, убирает excluded)
  2. Дописывает в digests.json на хосте (публичный файл)
  3. Публикует пост в Telegram-канал @lorrrem
```

### Telegram-команды

| Команда / callback | Действие |
|---|---|
| `/publish` | Опубликовать текущий черновик |
| `/pool` | Показать пул ссылок за текущий месяц |
| `edit_<id>` | Начать редактирование описания (force_reply) |
| `exclude_<id>` | Исключить материал |
| `include_<id>` | Вернуть материал |
| `pd_<id>` | Удалить ссылку из пула |
| `?action=pool_add` | Добавить URL в пул (из сообщения) |
| `?action=pool_consume` | CI забирает URL пула |
| `?action=tick` | Heartbeat (каждый час) |
| `?action=init_draft` | Приём черновика от CI |

### Безопасность бота

- Все эндпоинты проверяют `X-Bot-Secret` → `WEBHOOK_SECRET`
- Callback-запросы проверяются по `MY_CHAT_ID` (только владелец)
- `BOT_TOKEN`, `MY_CHAT_ID`, `WEBHOOK_SECRET` — только через GitHub Secrets
- `config.php` генерируется при каждом FTP-деплое, не хранится в git
- **SECURITY RULE: Токены НИКОГДА не передавать в чат. При утечке → @BotFather → /mybots → Revoke token**

### Карточка в Telegram (HTML)

```
№1 · Дизайн-системы
<a href="https://...">Заголовок статьи</a> (en)
<i>Краткое описание...</i>
✏️ описание изменено  ← если редактировалось
```

Кнопки: `✏️ Изменить описание` | `🚫 Исключить`

---

## 7. GitHub Actions Workflows

### deploy-ftp.yml

**Триггер:** push main, workflow_dispatch  
**Действия:**
1. Генерирует `public/bot/config.php` из Secrets (4 константы PHP)
2. FTP-деплой `public/` → REG.RU 31.31.198.114 (FTPS, порт 21)
3. `curl setWebhook` → регистрирует `webhook.php` в Telegram API

**Secrets:** `FTP_USERNAME`, `FTP_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_MY_ID`, `WEBHOOK_SECRET`

### monthly-digest.yml

**Триггер:** cron `0 8 1 * *` (1-е число, 08:00 UTC / 11:00 МСК), workflow_dispatch (с опцией `month: YYYY-MM`)  
**Действия:**
1. `curl dsg.lorrrem.ru/blog/digests.json` → seed базы (хост = источник правды)
2. `run-content-automation.mjs` (LLM_PROVIDER=claude, ANTHROPIC_MODEL=claude-sonnet-4-6)
3. `rewrite-digest-descriptions.mjs` (quality pass, Sonnet, некритичный)
4. Коммит зеркала опубликованного состояния (посты + статус)
5. `send-telegram-digest.mjs` → хэндофф боту

**Secrets:** `ANTHROPIC_API_KEY`, `WEBHOOK_SECRET`  
**Permissions:** `contents: write`

### pages.yml

**Триггер:** push к любой ветке кроме main  
**Действия:** деплой `public/` на GitHub Pages  
**Ветки staging:** catalog-update, digest-rebuild + любые non-main

### digest-tick.yml

**Триггер:** cron каждый час в :30  
**Действия:** `curl webhook.php?action=tick`  
**Назначение:** heartbeat для отложенных действий бота (напоминания, автопаблиш)

### bot-diag.yml / bot-cleanup.yml / bot-resend.yml

Ручные workflow для диагностики/обслуживания бота.

---

## 8. LLM-интеграция

### Провайдер-абстракция (`scripts/lib/llm.mjs`)

```
LLM_PROVIDER=openai (по умолчанию) | claude
```

**OpenAI:**
- Эндпоинт: `POST /v1/responses` (Responses API)
- Модель по умолчанию: `gpt-4o-mini`
- Reasoning-модели (gpt-5.x, o-series): `reasoning: {effort: "low"}` вместо temperature
- Structured output: `text.format.type = "json_schema"`

**Claude (Anthropic):**
- Эндпоинт: `POST /v1/messages`
- Модель по умолчанию: `claude-haiku-4-5-20251001`
- В monthly-digest.yml — `claude-sonnet-4-6`
- Structured output: `output_config.format.type = "json_schema"`
- Санитизация схемы: убираются `minItems`, `maxItems`, `minLength`, `pattern` и др. (не поддерживаются Anthropic)
- Таймаут: 180 с

**Переменные окружения:**

| Переменная | Назначение |
|---|---|
| `LLM_PROVIDER` | `openai` или `claude` |
| `OPENAI_API_KEY` | Ключ OpenAI |
| `OPENAI_DIGEST_MODEL` | Модель (по умолч. gpt-4o-mini) |
| `OPENAI_BASE_URL` | Базовый URL API |
| `ANTHROPIC_API_KEY` | Ключ Anthropic |
| `ANTHROPIC_MODEL` | Модель (по умолч. claude-haiku-4-5-20251001) |
| `ANTHROPIC_BASE_URL` | Базовый URL (опционально) |
| `LLM_TIMEOUT_MS` | Таймаут запроса (по умолч. 180 000 мс) |

**Потенциал Prompt Caching (Anthropic):** при кэшировании системного промпта экономия до 90% токенов. Актуально при сборке дайджеста (один большой системный промпт + N запросов).

---

## 9. Фронтенд

**Тип:** чистый статический HTML/CSS/JS, без фреймворка и сборщика.

**Страницы:**
- `/` — каталог систем (фильтрация по origin, поиск)
- `/blog/` — дайджесты (список выпусков + раскрытие)
- `/automation/status.json` — публичный статус последнего прогона

**Данные:**
- `data/systems.json` → каталог (43 записи)
- `blog/digests.json` → дайджесты (публикует PHP-бот)
- `blog/posts.json` → исходные статьи (1400 шт., для дебага)

**Деплой:** `public/` деплоится as-is через FTP в корень хостинга. Никакого build-шага нет.

---

## 10. Зависимости

### npm (Node.js)

| Пакет | Версия | Назначение |
|---|---|---|
| cheerio | ^1.1.2 | HTML-парсинг статей |

**Node.js:** `>=24` (ESM, `import * as cheerio` — не default import)

### PHP (REG.RU shared hosting)

- PHP ≥7.4 (curl, json, mbstring)
- Никаких Composer-зависимостей — всё в одном файле `webhook.php`

### GitHub Actions (actions)

| Action | Версия | Назначение |
|---|---|---|
| actions/checkout | v4 | Чекаут репозитория |
| actions/setup-node | v4 | Node.js 24 |
| SamKirkland/FTP-Deploy-Action | v4.3.5 | FTP-деплой |

### Внешние API

| Сервис | Использование |
|---|---|
| Telegram Bot API | Модерация + публикация в канал |
| OpenAI API (Responses) | Генерация описаний (gpt-4o-mini) |
| Anthropic API (Messages) | Генерация + quality rewrite (Haiku/Sonnet) |
| REG.RU FTP | Хостинг продакшна |
| GitHub Pages | Staging |

---

## 11. Ветки и деплой

```
main ──────────────────► FTP → dsg.lorrrem.ru (прод)
                          └─ deploy-ftp.yml

catalog-update ────────► GitHub Pages (staging)
digest-rebuild ────────► GitHub Pages (staging)  
любая non-main ────────► GitHub Pages (staging)
                          └─ pages.yml
```

**Правило:** никогда не пушить напрямую в main без проверки на staging.

**Перед коммитом обязательно:**
1. `git fetch origin`
2. `git log --oneline --all -8`
3. `git status`
4. При расхождении: `git pull --rebase`, затем push

---

## 12. Secrets (GitHub)

| Secret | Используется в |
|---|---|
| `FTP_USERNAME` | deploy-ftp.yml |
| `FTP_PASSWORD` | deploy-ftp.yml |
| `TELEGRAM_BOT_TOKEN` | deploy-ftp.yml (config.php + setWebhook) |
| `TELEGRAM_MY_ID` | deploy-ftp.yml (config.php) |
| `WEBHOOK_SECRET` | deploy-ftp.yml + monthly-digest.yml |
| `ANTHROPIC_API_KEY` | monthly-digest.yml |
| `OPENAI_API_KEY` | опционально, если LLM_PROVIDER=openai |

---

## 13. Локальная разработка

```bash
# Дев-сервер (раздаёт public/)
npm run dev          # node server.mjs → http://localhost:3000

# Контентная автоматизация
ANTHROPIC_API_KEY=... LLM_PROVIDER=claude node scripts/run-content-automation.mjs

# Только фетч статей
node scripts/fetch-blog.mjs

# Только сборка дайджестов
node scripts/build-digests.mjs

# Хэндофф черновика боту
WEBHOOK_SECRET=... node scripts/send-telegram-digest.mjs
```

**`.env` файл** (не в git):
```
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
LLM_PROVIDER=claude
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
WEBHOOK_SECRET=...
DIGEST_MONTH=2026-06   # для тестового прогона на текущий месяц
```

---

## 14. Статус проекта (2026-06-16)

| Функциональность | Статус |
|---|---|
| Каталог (43 системы) | ✅ Работает |
| Дайджесты (автосборка) | ✅ Работает |
| Quality rewrite (Sonnet) | ✅ Работает |
| Telegram-бот модерации | ✅ Работает |
| Пул ссылок от владельца | ✅ Работает |
| FTP-деплой в прод | ✅ Работает |
| GitHub Pages staging | ✅ Работает |
| LLM: поддержка Claude | ✅ Реализована (Haiku + Sonnet) |
| Prompt Caching | 🔲 Не реализован (потенциал -90% стоимости) |
| Тесты | 🔲 Отсутствуют |
| TypeScript | 🔲 Не применяется |

---

## 15. Известные особенности и нюансы

- **Node 24 / cheerio:** `import * as cheerio from 'cheerio'` — работает; `import cheerio from 'cheerio'` — нет (нет default export в ESM)
- **config.php не в git:** генерируется при каждом деплое из Secrets; для локальной разработки нужен вручную
- **Хост = источник правды:** `digests.json` живёт на хосте, в git — только зеркало последнего опубликованного состояния. CI всегда seed с хоста перед сборкой
- **Несколько чатов Claude параллельно:** возможны конфликты коммитов → обязательный `git fetch` перед коммитом
- **REG.RU shared hosting:** PHP без CLI, без cron (cron = GitHub Actions). FTP-протокол FTPS, IP 31.31.198.114
- **GitHub Pages env protection:** новые non-main ветки нужно добавлять в Settings → Environments → github-pages → Deployment branches
- **DIGEST_MONTH=текущий месяц:** тестовый прогон — pool_consume идёт с `dry=1` (не съедает пул) + не проверяет live-сайт на дубликат
- **Флуд-лимит Telegram:** бот ждёт `retry_after` + до 5 попыток при 429
- **Карточки приходят тихо** (`disable_notification: true`) — только финальный `/publish` шумный

---

## 16. Контакты и ресурсы

| Ресурс | URL / контакт |
|---|---|
| Добавить систему | t.me/denis_zelenykh |
| Поддержать проект | pay.cloudtips.ru/p/27204e72 |
| Telegram-канал | @lorrrem |
| База знаний | Memory/knowledge-base.md |
