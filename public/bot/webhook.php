<?php
require_once __DIR__ . '/config.php';

const DRAFT_PATH   = __DIR__ . '/draft.json';
const DIGESTS_PATH = __DIR__ . '/../blog/digests.json';
const SITE_URL     = 'https://dsg.lorrrem.ru/blog/';
// Канал, куда после подтверждения публикуется дайджест отдельными карточками
// (помимо сводного анонса в CHANNEL_ID). Можно переопределить в config.php.
if (!defined('DIGEST_CHANNEL_ID')) define('DIGEST_CHANNEL_ID', '@digest_dsgn');
const TZ           = 'Europe/Moscow';
const POOL_TARGET  = 35; // целевой размер выпуска (DIGEST_SIZE) — для счётчика «добрать ещё»

// =====================================================================
// Telegram API
// =====================================================================

function tg(string $method, array $params): array {
    // Переиспользуем один curl-handle на весь запрос (keep-alive): второй и
    // последующие вызовы в рамках одного клика не делают заново TLS-хендшейк.
    static $ch = null;
    if ($ch === null) {
        $ch = curl_init();
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
        curl_setopt($ch, CURLOPT_TIMEOUT, 15);
    }

    $json = [];
    for ($attempt = 0; $attempt < 5; $attempt++) {
        curl_setopt($ch, CURLOPT_URL, 'https://api.telegram.org/bot' . BOT_TOKEN . '/' . $method);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($params));
        $result = curl_exec($ch);
        $json = json_decode($result, true) ?: [];

        if (($json['ok'] ?? false) === true) return $json;
        // Перегрузка — подождать и повторить.
        if ((int) ($json['error_code'] ?? 0) === 429) {
            $retry = (int) ($json['parameters']['retry_after'] ?? 1);
            sleep(min(max($retry, 1), 10)); // выжидаем флуд-лимит Telegram
            continue;
        }
        error_log("Telegram {$method} error: " . json_encode($json));
        return $json;
    }
    return $json;
}

// Экранирование для parse_mode=HTML (только эти три символа).
function h(string $s): string {
    return str_replace(['&', '<', '>'], ['&amp;', '&lt;', '&gt;'], $s);
}

// Заглавная первая буква (UTF-8): «июнь» → «Июнь».
function ucfirstRu(string $s): string {
    if ($s === '') return $s;
    return mb_strtoupper(mb_substr($s, 0, 1, 'UTF-8'), 'UTF-8') . mb_substr($s, 1, null, 'UTF-8');
}

// =====================================================================
// Черновик (draft.json — пишет только PHP, в git не хранится)
// =====================================================================

function loadDraft(): ?array {
    if (!is_readable(DRAFT_PATH)) return null;
    $data = json_decode(file_get_contents(DRAFT_PATH), true);
    return is_array($data) ? $data : null;
}

function saveDraft(array $draft): void {
    file_put_contents(
        DRAFT_PATH,
        json_encode($draft, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT),
        LOCK_EX
    );
}

function findItem(array $draft, string $id): ?array {
    foreach ($draft['digest']['items'] ?? [] as $item) {
        if (($item['id'] ?? '') === $id) return $item;
    }
    return null;
}

// Итоговый дайджест: применяем правки, выкидываем исключённые, пересчитываем count.
function buildFinalDigest(array $draft): array {
    $digest = $draft['digest'];
    $items  = [];
    foreach ($digest['items'] ?? [] as $item) {
        $id = $item['id'] ?? '';
        if (in_array($id, $draft['excluded'] ?? [], true)) continue;
        if (isset($draft['edits'][$id]) && $draft['edits'][$id] !== '') {
            $item['summary'] = $draft['edits'][$id];
        }
        $items[] = $item;
    }
    $digest['items'] = $items;
    $digest['count'] = count($items);
    return $digest;
}

// =====================================================================
// Пул присланных ссылок (по месяцам): pool-YYYY-MM.json (пишет только PHP)
// =====================================================================

function poolPath(string $month): string {
    return __DIR__ . "/pool-{$month}.json";
}

function currentMonth(): string {
    return (new DateTime('now', new DateTimeZone(TZ)))->format('Y-m');
}

function loadPool(string $month): array {
    $p = poolPath($month);
    if (is_readable($p)) {
        $d = json_decode(file_get_contents($p), true);
        if (is_array($d)) return $d;
    }
    return ['month' => $month, 'target' => POOL_TARGET, 'items' => [], 'notifiedReadyAt' => null];
}

function savePool(string $month, array $pool): void {
    file_put_contents(
        poolPath($month),
        json_encode($pool, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT),
        LOCK_EX
    );
}

// Нормализация URL для дедупликации: хост без www, без якоря, без трекинговых
// параметров, без хвостового слэша.
function normalizeUrl(string $url): string {
    $url = trim($url);
    $p = parse_url($url);
    if (!$p || empty($p['host'])) return mb_strtolower(rtrim($url, '/'));
    $host = preg_replace('/^www\./i', '', strtolower($p['host']));
    $path = rtrim($p['path'] ?? '', '/');
    $q = '';
    if (!empty($p['query'])) {
        parse_str($p['query'], $params);
        foreach (array_keys($params) as $k) {
            if (preg_match('/^(utm_|yclid|gclid|fbclid|ref$|from$|igshid)/i', $k)) unset($params[$k]);
        }
        if ($params) { ksort($params); $q = '?' . http_build_query($params); }
    }
    return $host . $path . $q;
}

function extractUrls(string $text): array {
    preg_match_all('~https?://[^\s<>"\']+~iu', $text, $m);
    return $m[0] ?? [];
}

function monthLabelRu(string $ym): string {
    $months = ['', 'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
               'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
    $m = (int) substr($ym, 5, 2);
    return $months[$m] ?? $ym;
}

function nextMonth(string $ym): string {
    $dt = DateTime::createFromFormat('Y-m-d', $ym . '-01', new DateTimeZone(TZ));
    if (!$dt) return $ym;
    $dt->modify('first day of next month');
    return $dt->format('Y-m');
}

// Склонение «ссылка»: 1 ссылка, 2 ссылки, 5 ссылок.
function pluralLinks(int $n): string {
    $m100 = $n % 100; $m10 = $n % 10;
    if ($m100 >= 11 && $m100 <= 14) return 'ссылок';
    if ($m10 === 1)                  return 'ссылка';
    if ($m10 >= 2 && $m10 <= 4)      return 'ссылки';
    return 'ссылок';
}

// Текст + клавиатура списка пула (для /pool и перерисовки после удаления).
function poolListPayload(string $month): array {
    $items = loadPool($month)['items'] ?? [];
    $label = ucfirstRu(monthLabelRu($month));
    if (!$items) {
        return ['text' => "📥 Пул за {$label} пуст.", 'reply_markup' => null];
    }
    $n = count($items);
    $lines = ["📥 <b>Пул за {$label}</b> — {$n} " . pluralLinks($n) . " (цель " . POOL_TARGET . "):"];
    $kb = [];
    $i = 1;
    foreach ($items as $it) {
        $lines[] = "{$i}. " . h($it['url']);
        $kb[] = [['text' => "❌ {$i}", 'callback_data' => 'pd_' . ($it['id'] ?? '')]];
        $i++;
    }
    return ['text' => implode("\n", $lines), 'reply_markup' => ['inline_keyboard' => $kb]];
}

// =====================================================================
// Рендер карточек и клавиатур
// =====================================================================

// Экранирование значения HTML-атрибута (включая кавычки) — для href.
function attrEsc(string $s): string {
    return str_replace(['&', '<', '>', '"'], ['&amp;', '&lt;', '&gt;', '&quot;'], $s);
}

// Порядковый номер материала (1-based) в дайджесте — только для карточек в
// Telegram (в публикуемый digests.json не попадает).
function itemNumber(array $draft, string $id): int {
    $i = 1;
    foreach ($draft['digest']['items'] ?? [] as $it) {
        if (($it['id'] ?? '') === $id) return $i;
        $i++;
    }
    return 0;
}

function renderCard(array $item, array $draft): string {
    $id       = $item['id'] ?? '';
    $excluded = in_array($id, $draft['excluded'] ?? [], true);
    $summary  = $draft['edits'][$id] ?? ($item['summary'] ?? '');
    $edited   = isset($draft['edits'][$id]) && $draft['edits'][$id] !== '';

    $rubric = h($item['rubric'] ?? 'Без рубрики');
    $lang   = !empty($item['languageBadge']) ? ' <i>(' . h($item['languageBadge']) . ')</i>' : '';
    $title  = h($item['sourceTitle'] ?? '');
    $url    = (string) ($item['url'] ?? '');

    // Ссылку оформляем только для валидного http(s)-URL, иначе — заголовок текстом.
    $titleHtml = preg_match('~^https?://~i', $url)
        ? '<a href="' . attrEsc($url) . '">' . $title . '</a>'
        : $title;
    $num  = itemNumber($draft, $id);
    $head = "<b>№{$num} · {$rubric}</b>\n{$titleHtml}{$lang}\n";

    if ($excluded) {
        return $head . "🚫 <i>Исключено из публикации</i>";
    }
    $body = "<i>" . h($summary) . "</i>";
    if ($edited) $body .= "\n✏️ <i>описание изменено</i>";
    return $head . $body;
}

// Текстовая версия карточки (без HTML) — фолбэк, если разметка не распарсилась.
function renderCardPlain(array $item, array $draft): string {
    $id       = $item['id'] ?? '';
    $excluded = in_array($id, $draft['excluded'] ?? [], true);
    $summary  = $draft['edits'][$id] ?? ($item['summary'] ?? '');
    $rubric   = $item['rubric'] ?? 'Без рубрики';
    $title    = $item['sourceTitle'] ?? '';
    $url      = (string) ($item['url'] ?? '');
    $lang     = !empty($item['languageBadge']) ? ' (' . $item['languageBadge'] . ')' : '';
    $num      = itemNumber($draft, $id);
    $head     = "№{$num} · {$rubric}\n{$title}{$lang}\n{$url}\n";
    if ($excluded) return $head . "🚫 Исключено из публикации";
    return $head . $summary;
}

// Ошибка именно разбора HTML (а не флуд 429 / сеть) — только тогда есть смысл
// падать в текстовый фолбэк; при флуде заголовок-ссылку сохраняем, помогает ретрай.
function isParseError(array $res): bool {
    if (($res['ok'] ?? true) === true) return false;
    if ((int) ($res['error_code'] ?? 0) !== 400) return false;
    $desc = mb_strtolower((string) ($res['description'] ?? ''));
    return strpos($desc, 'pars') !== false
        || strpos($desc, 'entit') !== false
        || strpos($desc, 'tag') !== false;
}

// Отправка карточки. По умолчанию — HTML (заголовок = ссылка). На обычный текст
// падаем ТОЛЬКО при ошибке разбора HTML; флуд/сеть лечатся ретраем tg() и
// повторным проходом в init_draft (карточка остаётся со ссылкой).
function sendCard(array $item, array $draft): array {
    $id  = $item['id'] ?? '';
    $res = tg('sendMessage', [
        'chat_id'                  => MY_CHAT_ID,
        'text'                     => renderCard($item, $draft),
        'parse_mode'               => 'HTML',
        'disable_web_page_preview' => true,
        'disable_notification'     => true, // карточки приходят тихо — пуш даёт только финал
        'reply_markup'             => cardKeyboard($id, $draft),
    ]);
    if (isParseError($res)) {
        $res = tg('sendMessage', [
            'chat_id'                  => MY_CHAT_ID,
            'text'                     => renderCardPlain($item, $draft),
            'disable_web_page_preview' => true,
            'disable_notification'     => true,
            'reply_markup'             => cardKeyboard($id, $draft),
        ]);
    }
    return $res;
}

function cardKeyboard(string $id, array $draft): array {
    if (in_array($id, $draft['excluded'] ?? [], true)) {
        return ['inline_keyboard' => [[
            ['text' => '↩️ Вернуть', 'callback_data' => 'include_' . $id],
        ]]];
    }
    return ['inline_keyboard' => [[
        ['text' => '✏️ Изменить описание', 'callback_data' => 'edit_' . $id],
        ['text' => '🚫 Исключить',          'callback_data' => 'exclude_' . $id],
    ]]];
}

function actionKeyboard(): array {
    return [
        'keyboard' => [
            [['text' => '📢 Опубликовать'], ['text' => '🕒 Отложить']],
            [['text' => '🚫 Не публиковать']],
        ],
        'resize_keyboard' => true,
        'is_persistent'   => true,
    ];
}

// Сообщение владельцу с переподнятием нижней панели (после force_reply Telegram
// иногда её скрывает — так она остаётся на месте).
function notifyOwner(string $text): void {
    tg('sendMessage', [
        'chat_id'      => MY_CHAT_ID,
        'text'         => $text,
        'parse_mode'   => 'HTML',
        'reply_markup' => actionKeyboard(),
    ]);
}

// Лёгкое переключение кнопки карточки (Исключить↔Вернуть) без перерисовки текста —
// быстрый отклик; фактическое исключение применяется при публикации.
function flipCardButton(array $draft, string $id): void {
    $msgId = $draft['cardMsgIds'][$id] ?? null;
    if (!$msgId) return;
    tg('editMessageReplyMarkup', [
        'chat_id'      => MY_CHAT_ID,
        'message_id'   => $msgId,
        'reply_markup' => cardKeyboard($id, $draft),
    ]);
}

function sendScheduleMenu(): void {
    tg('sendMessage', [
        'chat_id'      => MY_CHAT_ID,
        'text'         => 'Когда опубликовать?',
        'reply_markup' => ['inline_keyboard' => [
            [['text' => 'Сегодня 18:30',       'callback_data' => 'sched_today']],
            [['text' => 'Завтра 18:30',        'callback_data' => 'sched_tomorrow']],
            [['text' => 'Через 3 дня (18:30)', 'callback_data' => 'sched_3d']],
            [['text' => 'Ввести вручную',      'callback_data' => 'sched_manual']],
        ]],
    ]);
}

// Перерисовать карточку материала по сохранённому message_id.
function refreshCard(array $draft, string $id): void {
    $item  = findItem($draft, $id);
    $msgId = $draft['cardMsgIds'][$id] ?? null;
    if (!$item || !$msgId) return;
    $res = tg('editMessageText', [
        'chat_id'                  => MY_CHAT_ID,
        'message_id'               => $msgId,
        'text'                     => renderCard($item, $draft),
        'parse_mode'               => 'HTML',
        'disable_web_page_preview' => true,
        'reply_markup'             => cardKeyboard($id, $draft),
    ]);
    if (isParseError($res)) {
        tg('editMessageText', [
            'chat_id'                  => MY_CHAT_ID,
            'message_id'               => $msgId,
            'text'                     => renderCardPlain($item, $draft),
            'disable_web_page_preview' => true,
            'reply_markup'             => cardKeyboard($id, $draft),
        ]);
    }
}

// =====================================================================
// Дайджест-самари для анонса в канал
// =====================================================================

function rubricsSummary(array $digest, int $top = 6): string {
    $counts = [];
    foreach ($digest['items'] ?? [] as $item) {
        $rubric = $item['rubric'] ?? 'Без рубрики';
        $counts[$rubric] = ($counts[$rubric] ?? 0) + 1;
    }
    arsort($counts);

    $rubrics = array_keys($counts);
    $head    = array_slice($rubrics, 0, $top);
    $rest    = count($rubrics) - count($head);

    $summary = implode(' · ', array_map('h', $head));
    if ($rest > 0) {
        $summary .= " и ещё {$rest} " . pluralTopics($rest);
    }
    return $summary;
}

// Склонение слова «тема» по числу: 1 тема, 2 темы, 5 тем.
function pluralTopics(int $n): string {
    $mod100 = $n % 100;
    $mod10  = $n % 10;
    if ($mod100 >= 11 && $mod100 <= 14) return 'тем';
    if ($mod10 === 1)                    return 'тема';
    if ($mod10 >= 2 && $mod10 <= 4)      return 'темы';
    return 'тем';
}

// =====================================================================
// Публикация: живой digests.json на хост + анонс в канал
// =====================================================================

// Примерное время внесения изменений (сек) — оно же окно отмены публикации.
function publishEta(array $draft): int {
    $n = count($draft['edits'] ?? []) + count($draft['excluded'] ?? []);
    return max(6, min(20, 4 + $n));
}

// Запуск публикации без подтверждения: сразу ETA + кнопка прерывания, затем —
// окно отмены (sleep), после которого публикуем, если не прервали.
function startPublish(array $draft): void {
    $eta   = publishEta($draft);
    $token = bin2hex(random_bytes(4));

    $draft['status']       = 'publishing';
    $draft['publishToken'] = $token;
    saveDraft($draft);

    tg('sendMessage', [
        'chat_id'      => MY_CHAT_ID,
        'text'         => "⏳ Вношу изменения и публикую — примерно {$eta} сек.\n"
                        . "Можно прервать кнопкой ниже в любой момент.",
        'reply_markup' => ['inline_keyboard' => [[
            ['text' => '🚫 Не публиковать', 'callback_data' => 'pub_abort'],
        ]]],
    ]);

    sleep($eta); // окно прерывания: «Не публиковать» переведёт статус в paused

    $fresh = loadDraft();
    if (!$fresh
        || ($fresh['status'] ?? '') !== 'publishing'
        || ($fresh['publishToken'] ?? '') !== $token) {
        return; // прервано пользователем или запущена другая сессия
    }
    publishDraft($fresh, 'manual');
}

// Карточка для канала: тот же рендер, что владельцу, но БЕЗ кнопок и тихо
// (disable_notification). В $final правки уже вшиты в summary, исключённые убраны,
// поэтому рендерим через псевдо-черновик с пустыми edits/excluded — без пометок.
function sendChannelCard(array $item, array $pseudo, string $channelId): bool {
    $res = tg('sendMessage', [
        'chat_id'                  => $channelId,
        'text'                     => renderCard($item, $pseudo),
        'parse_mode'               => 'HTML',
        'disable_web_page_preview' => true,
        'disable_notification'     => true,
    ]);
    if (isParseError($res)) {
        $res = tg('sendMessage', [
            'chat_id'                  => $channelId,
            'text'                     => renderCardPlain($item, $pseudo),
            'disable_web_page_preview' => true,
            'disable_notification'     => true,
        ]);
    }
    return ($res['result']['message_id'] ?? null) !== null;
}

// Публикует дайджест в канал: сводный анонс (единственное сообщение С уведомлением),
// затем карточки по одной — тихо. Возвращает число доставленных карточек.
function publishCardsToChannel(array $final, string $channelId, string $headerText): int {
    // Шапка — это и есть единственное уведомление в канале.
    tg('sendMessage', [
        'chat_id'                  => $channelId,
        'text'                     => $headerText,
        'parse_mode'               => 'HTML',
        'disable_web_page_preview' => false,
    ]);

    $items  = $final['items'] ?? [];
    $pseudo = ['digest' => $final, 'edits' => [], 'excluded' => []];
    $sent   = [];

    foreach ($items as $i => $item) {
        $key = ($item['id'] ?? '') !== '' ? $item['id'] : (string) $i;
        if (sendChannelCard($item, $pseudo, $channelId)) $sent[$key] = true;
        usleep(50000); // быстрый залп: клиент группирует тихие баннеры
    }
    // Ремонтные раунды по не дошедшим карточкам (флуд/сеть) — до 3 раз.
    for ($round = 0; $round < 3; $round++) {
        $allOk = true;
        foreach ($items as $i => $item) {
            $key = ($item['id'] ?? '') !== '' ? $item['id'] : (string) $i;
            if (isset($sent[$key])) continue;
            sleep(2);
            if (sendChannelCard($item, $pseudo, $channelId)) $sent[$key] = true;
            else $allOk = false;
        }
        if ($allOk) break;
    }
    return count($sent);
}

function publishDraft(array $draft, string $mode): void {
    set_time_limit(0); // публикация карточек в канал может занять время (~35 сообщений)
    $editsN = count($draft['edits'] ?? []);
    $exclN  = count($draft['excluded'] ?? []);

    $final = buildFinalDigest($draft);
    $key   = $final['key'] ?? null;

    // 1) Обновляем живой digests.json на хосте — сайт обновляется мгновенно.
    $data = ['generatedAt' => null, 'latestKey' => null, 'digests' => []];
    if (is_readable(DIGESTS_PATH)) {
        $existing = json_decode(file_get_contents(DIGESTS_PATH), true);
        if (is_array($existing)) $data = $existing;
    }
    $digests = $data['digests'] ?? [];
    // Убираем выпуск с тем же ключом, ставим свежий в начало, сортируем по убыванию ключа.
    $digests = array_values(array_filter($digests, fn($d) => ($d['key'] ?? null) !== $key));
    array_unshift($digests, $final);
    usort($digests, fn($a, $b) => strcmp((string) ($b['key'] ?? ''), (string) ($a['key'] ?? '')));

    $data['digests']     = $digests;
    $data['latestKey']   = $digests[0]['key'] ?? $key;
    $data['generatedAt'] = gmdate('c');
    file_put_contents(
        DIGESTS_PATH,
        json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . "\n",
        LOCK_EX
    );

    // 1b) Синхронизируем опубликованный digests.json на сайт (REG.RU, FTPS).
    // Скрипт читает FTP-креды из .env; если его нет — публикация всё равно проходит.
    $synced = false;
    $syncScript = dirname(__DIR__, 2) . '/scripts/sync-site.sh';
    if (is_executable($syncScript)) {
        @exec(escapeshellarg($syncScript) . ' 2>&1', $syncOut, $syncRc);
        $synced = ($syncRc === 0);
    }

    // 2) Анонс в канал.
    $count  = (int) ($final['count'] ?? 0);
    $number = $final['number'] ?? null;
    $label  = ucfirstRu((string) ($final['monthLabel'] ?? ''));
    $year   = $final['year'] ?? '';
    $title  = $number ? "Дайджест DSG №{$number} — {$label} {$year}"
                      : "Дайджест DSG — {$label} {$year}";

    $body = "🗞 <b>" . h($title) . "</b>\n\n"
          . "Собрали {$count} материалов о дизайн-системах, дизайне интерфейсов "
          . "и продуктовом дизайне.\n\n"
          . "<b>В выпуске:</b> " . rubricsSummary($final) . "\n\n"
          . "👉 <a href=\"" . SITE_URL . "\">Читать дайджест</a>";

    // Шапка @digest_dsgn — без ссылки на самого себя.
    $text = $body . "\n\n#дайджест";

    // Анонс @lorrrem — с промо отдельного канала дайджеста.
    $lorremText = $body
                . "\n\n📩 Отдельный канал с ежемесячным дайджестом → " . DIGEST_CHANNEL_ID
                . "\n\n#дайджест";

    tg('sendMessage', [
        'chat_id'                  => CHANNEL_ID,
        'text'                     => $lorremText,
        'parse_mode'               => 'HTML',
        'disable_web_page_preview' => false,
    ]);

    // 2b) Канал дайджеста: тот же сводный анонс (единственное уведомление),
    //     затем материалы отдельными карточками — тихо, без кнопок.
    $cardsSent = 0;
    if (DIGEST_CHANNEL_ID) {
        $cardsSent = publishCardsToChannel($final, DIGEST_CHANNEL_ID, $text);
    }

    // 3) Финализируем черновик.
    $draft['status']      = 'published';
    $draft['publishedAt'] = gmdate('c');
    $draft['publishMode'] = $mode;
    saveDraft($draft);

    // 4) Оповещение о завершении + прибираем чат владельца.
    $modeLabel = $mode === 'auto'      ? ' автоматически'
               : ($mode === 'scheduled' ? ' по расписанию' : '');
    $changes = ($editsN || $exclN) ? " (правок: {$editsN}, исключено: {$exclN})" : '';
    tg('sendMessage', [
        'chat_id'      => MY_CHAT_ID,
        'text'         => "✅ Опубликовано{$modeLabel}: {$count} материалов{$changes}. "
                        . ($synced ? "Сайт обновлён" : "⚠️ сайт НЕ синхронизирован (проверь FTP)")
                        . ", анонс — в " . CHANNEL_ID
                        . ", дайджест карточками — в " . DIGEST_CHANNEL_ID . " ({$cardsSent}).",
        'reply_markup' => ['remove_keyboard' => true],
    ]);
}

// =====================================================================
// init_draft — приём свежесгенерированного дайджеста из CI
// =====================================================================

function handleInitDraft(): void {
    header('Content-Type: application/json');
    set_time_limit(0);

    $payload = json_decode(file_get_contents('php://input'), true);
    $digest  = $payload['digest'] ?? $payload;
    if (!is_array($digest) || empty($digest['items'])) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'no digest in payload']);
        return;
    }

    $draft = [
        'status'      => 'pending',
        'createdAt'   => gmdate('c'),
        'remindedAt'  => null,
        'scheduledAt' => null,
        'digest'      => $digest,
        'edits'       => [],
        'excluded'    => [],
        'cardMsgIds'  => [],
        'prompts'     => [],
    ];
    saveDraft($draft);

    $number = $digest['number'] ?? '';
    $label  = ucfirstRu((string) ($digest['monthLabel'] ?? ''));
    $year   = $digest['year'] ?? '';
    $count  = count($digest['items']);

    $hdr = tg('sendMessage', [
        'chat_id'              => MY_CHAT_ID,
        'text'                 => "🗞 <b>Черновик дайджеста DSG №" . h((string) $number) . " — {$label} {$year}</b>\n"
                                . "{$count} материалов.\n\n"
                                . "Проверь карточки ниже: можно изменить описание или исключить материал. "
                                . "Когда закончишь — кнопки внизу.",
        'parse_mode'           => 'HTML',
        'disable_notification' => true, // шапка тихо — пуш будет один, от финала
    ]);
    $draft['headerMsgId'] = $hdr['result']['message_id'] ?? null;

    $cardMsgIds = [];
    foreach ($digest['items'] as $item) {
        $mid = sendCard($item, $draft)['result']['message_id'] ?? null;
        if ($mid) $cardMsgIds[$item['id'] ?? ''] = $mid;
        usleep(50000); // быстрый залп (~50мс): клиент группирует беззвучные баннеры в одно
                       // уведомление; провалы из-за флуда добирает повторный проход ниже
    }

    // Повторные проходы по не дошедшим карточкам (разовые сетевые сбои/флуд) —
    // до 3 раундов, пока все не доставятся.
    $fails = [];
    for ($round = 0; $round < 3; $round++) {
        $fails = [];
        foreach ($digest['items'] as $item) {
            $id = $item['id'] ?? '';
            if (isset($cardMsgIds[$id])) continue;
            sleep(2);
            $res = sendCard($item, $draft);
            $mid = $res['result']['message_id'] ?? null;
            if ($mid) $cardMsgIds[$id] = $mid;
            else $fails[] = $id . ': ' . ($res['description'] ?? 'no message_id');
        }
        if (!$fails) break;
    }
    $draft['cardMsgIds'] = $cardMsgIds;

    // Единственное сообщение с пушем — приходит, когда все карточки уже добавлены.
    $ftr = tg('sendMessage', [
        'chat_id'      => MY_CHAT_ID,
        'text'         => "✅ Дайджест №" . h((string) $number) . " готов к модерации — {$count} карточек выше 👆\n"
                        . "Проверь и выбери действие внизу.",
        'parse_mode'   => 'HTML',
        'reply_markup' => actionKeyboard(),
    ]);
    $draft['footerMsgId'] = $ftr['result']['message_id'] ?? null;
    saveDraft($draft);

    echo json_encode([
        'ok'    => true,
        'count' => $count,
        'cards' => count($cardMsgIds),
        'fails' => $fails,
    ], JSON_UNESCAPED_UNICODE);
}

// =====================================================================
// Очистка: удаление сообщений черновика из чата владельца
// =====================================================================

// Удаляет сообщения текущего черновика (шапка, карточки, футер, промпты)
// + небольшой буфер по диапазону id — на случай старых черновиков без
// сохранённых id шапки/футера. Личный чат: бот удаляет только свои сообщения.
function cleanupDraftMessages(array $draft): int {
    $ids = [];
    foreach (array_values($draft['cardMsgIds'] ?? []) as $v) $ids[] = (int) $v;
    foreach (['headerMsgId', 'footerMsgId'] as $k) {
        if (!empty($draft[$k])) $ids[] = (int) $draft[$k];
    }
    foreach (array_keys($draft['prompts'] ?? []) as $pid) $ids[] = (int) $pid;
    if (!$ids) return 0;

    $from = min($ids) - 2;
    $to   = max($ids) + 15; // захватываем футер и сообщения после правок
    $deleted = 0;
    for ($id = $from; $id <= $to; $id++) {
        $res = tg('deleteMessage', ['chat_id' => MY_CHAT_ID, 'message_id' => $id]);
        if (($res['ok'] ?? false) === true) $deleted++;
    }
    return $deleted;
}

function resetDraft(): int {
    $draft = loadDraft();
    $deleted = $draft ? cleanupDraftMessages($draft) : 0;
    if (is_file(DRAFT_PATH)) @unlink(DRAFT_PATH);
    tg('sendMessage', [
        'chat_id'      => MY_CHAT_ID,
        'text'         => '🧹 Черновик и его сообщения очищены.',
        'reply_markup' => ['remove_keyboard' => true],
    ]);
    return $deleted;
}

function handleCleanup(): void {
    header('Content-Type: application/json');
    set_time_limit(0);
    $deleted = resetDraft();
    echo json_encode(['ok' => true, 'deleted' => $deleted]);
}

// =====================================================================
// tick — крон: напоминание / авто-публикация / отложенная публикация
// =====================================================================

function sendReminder(array $draft): void {
    $draft['status']     = 'reminded';
    $draft['remindedAt'] = gmdate('c');
    saveDraft($draft);

    $final = buildFinalDigest($draft);
    $count = (int) ($final['count'] ?? 0);
    $edits = count($draft['edits'] ?? []);
    $excl  = count($draft['excluded'] ?? []);

    tg('sendMessage', [
        'chat_id'      => MY_CHAT_ID,
        'text'         => "⏰ Черновик дайджеста ждёт уже 5 дней (правок: {$edits}, исключено: {$excl}).\n"
                        . "Если ничего не сделать, завтра в 18:30 он опубликуется автоматически — {$count} материалов.",
        'reply_markup' => ['inline_keyboard' => [[
            ['text' => '✅ Опубликовать',          'callback_data' => 'remind_publish'],
            ['text' => '❌ Отменить публикацию',   'callback_data' => 'remind_cancel'],
        ]]],
    ]);
}

// Забор пула для сборки (идемпотентно): первые POOL_TARGET по времени добавления —
// в выпуск; лишние переносятся в пул следующего месяца (с тем же addedAt → снова
// в приоритете). Возвращает выбранные ссылки. Повторный вызов отдаёт то же самое.
function handlePoolConsume(string $month, bool $dry = false): void {
    header('Content-Type: application/json');
    $pool = loadPool($month);

    // Уже обработан (не dry) — отдаём сохранённый выбор.
    if (!empty($pool['consumedAt']) && !$dry) {
        echo json_encode([
            'ok' => true, 'month' => $month, 'consumedAt' => $pool['consumedAt'],
            'selected' => $pool['selected'] ?? [], 'count' => count($pool['selected'] ?? []),
            'carriedOver' => $pool['carriedOver'] ?? 0,
        ], JSON_UNESCAPED_UNICODE);
        return;
    }

    $items = $pool['items'] ?? [];
    usort($items, fn($a, $b) => strcmp((string) ($a['addedAt'] ?? ''), (string) ($b['addedAt'] ?? '')));
    $selected = array_slice($items, 0, POOL_TARGET);
    $overflow = array_slice($items, POOL_TARGET);
    $selOut   = array_map(fn($it) => ['id' => $it['id'] ?? '', 'url' => $it['url'] ?? ''], $selected);

    // dry — только просмотр выбора, без мутации (для тестовых прогонов).
    if (!$dry) {
        if ($overflow) {
            $next  = nextMonth($month);
            $np    = loadPool($next);
            $nkeys = array_column($np['items'] ?? [], 'key');
            foreach ($overflow as $it) {
                if (!in_array($it['key'] ?? '', $nkeys, true)) {
                    $np['items'][] = $it;
                    $nkeys[] = $it['key'] ?? '';
                }
            }
            savePool($next, $np);
        }
        $pool['selected'] = $selOut;
        $pool['consumedAt'] = gmdate('c');
        $pool['carriedOver'] = count($overflow);
        savePool($month, $pool);
    }

    echo json_encode([
        'ok' => true, 'month' => $month, 'dry' => $dry, 'selected' => $selOut,
        'count' => count($selOut), 'carriedOver' => count($overflow),
    ], JSON_UNESCAPED_UNICODE);
}

// Оповещение в последний день месяца (≥15:00 МСК): материалы приняты, готовимся к сборке.
function poolReadyNotice(): void {
    $now = new DateTime('now', new DateTimeZone(TZ));
    $lastDay = (int) $now->format('j') === (int) $now->format('t');
    if (!$lastDay || (int) $now->format('G') < 15) return;

    $month = $now->format('Y-m');
    $pool  = loadPool($month);
    if (!empty($pool['notifiedReadyAt'])) return;

    $pool['notifiedReadyAt'] = gmdate('c');
    savePool($month, $pool);

    $count = count($pool['items']);
    tg('sendMessage', [
        'chat_id' => MY_CHAT_ID,
        'text'    => "📦 Материалы приняты — {$count} " . pluralLinks($count) . " за "
                   . ucfirstRu(monthLabelRu($month)) . ". Готовлюсь к сборке дайджеста.",
    ]);
}

function handleTick(): void {
    header('Content-Type: application/json');

    // В последний день месяца с 15:00 МСК — оповещение «материалы приняты»
    // (независимо от состояния черновика; один раз за месяц).
    poolReadyNotice();

    $draft = loadDraft();
    if (!$draft) {
        echo json_encode(['ok' => true, 'note' => 'no draft']);
        return;
    }
    $status = $draft['status'] ?? '';
    // paused — авто-публикация приостановлена владельцем (ждём ручного действия).
    if (in_array($status, ['published', 'cancelled', 'paused'], true)) {
        echo json_encode(['ok' => true, 'status' => $status]);
        return;
    }

    $now    = new DateTime('now', new DateTimeZone(TZ));
    $nowTs  = $now->getTimestamp();
    $hour   = (int) $now->format('G');
    $evening = $hour >= 18; // вечернее окно (≈18:30 МСК; устойчиво к задержкам крона)

    // Отложенная публикация.
    if ($status === 'scheduled' && !empty($draft['scheduledAt'])) {
        $ts = strtotime($draft['scheduledAt']);
        if ($ts !== false && $nowTs >= $ts) {
            publishDraft($draft, 'scheduled');
            echo json_encode(['ok' => true, 'action' => 'scheduled_publish']);
            return;
        }
        echo json_encode(['ok' => true, 'status' => 'scheduled', 'waiting' => true]);
        return;
    }

    // Авто-публикация через сутки после напоминания.
    if ($status === 'reminded' && !empty($draft['remindedAt'])) {
        $remTs = strtotime($draft['remindedAt']);
        if ($remTs !== false && ($nowTs - $remTs) >= 24 * 3600 && $evening) {
            publishDraft($draft, 'auto');
            echo json_encode(['ok' => true, 'action' => 'auto_publish']);
            return;
        }
        echo json_encode(['ok' => true, 'status' => 'reminded', 'waiting' => true]);
        return;
    }

    // Напоминание на 5-й день.
    if ($status === 'pending' && !empty($draft['createdAt'])) {
        $createdTs = strtotime($draft['createdAt']);
        if ($createdTs !== false && ($nowTs - $createdTs) >= 5 * 24 * 3600 && $evening) {
            sendReminder($draft);
            echo json_encode(['ok' => true, 'action' => 'reminder']);
            return;
        }
    }

    echo json_encode(['ok' => true, 'status' => $status]);
}

// =====================================================================
// Отложенная публикация — разбор времени (МСК)
// =====================================================================

function parseScheduleInput(string $text): ?int {
    if (!preg_match('/(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\s+(\d{1,2}):(\d{2})/u', $text, $m)) {
        return null;
    }
    $tz       = new DateTimeZone(TZ);
    $now      = new DateTime('now', $tz);
    $hasYear  = !empty($m[3]);
    $year     = $hasYear ? $m[3] : $now->format('Y');
    if (strlen((string) $year) === 2) $year = '20' . $year;

    $dt = DateTime::createFromFormat(
        'Y-n-j G:i',
        sprintf('%s-%d-%d %d:%02d', $year, (int) $m[2], (int) $m[1], (int) $m[4], (int) $m[5]),
        $tz
    );
    if (!$dt) return null;
    // Год не указан и дата уже прошла → переносим на следующий год.
    if (!$hasYear && $dt->getTimestamp() < $now->getTimestamp()) {
        $dt->modify('+1 year');
    }
    return $dt->getTimestamp();
}

function fmtMsk(int $ts): string {
    $dt = new DateTime('@' . $ts);
    $dt->setTimezone(new DateTimeZone(TZ));
    return $dt->format('d.m.Y H:i') . ' МСК';
}

function scheduleAt(array $draft, int $ts, ?int $msgId): void {
    $draft['scheduledAt'] = gmdate('c', $ts);
    $draft['status']      = 'scheduled';
    saveDraft($draft);
    $when = '🕒 Запланировано на ' . fmtMsk($ts) . '.';
    if ($msgId) {
        tg('editMessageText', ['chat_id' => MY_CHAT_ID, 'message_id' => $msgId, 'text' => $when]);
    } else {
        tg('sendMessage', ['chat_id' => MY_CHAT_ID, 'text' => $when]);
    }
}

// =====================================================================
// Обработка callback_query (нажатия инлайн-кнопок)
// =====================================================================

function handleCallback(array $cb): void {
    $chatId = $cb['message']['chat']['id'] ?? null;
    if ((string) $chatId !== (string) MY_CHAT_ID) {
        tg('answerCallbackQuery', ['callback_query_id' => $cb['id']]);
        return;
    }

    $data  = $cb['data'] ?? '';
    $msgId = $cb['message']['message_id'] ?? null;

    // Удаление ссылки из пула — работает независимо от черновика.
    if (str_starts_with($data, 'pd_')) {
        $id    = substr($data, 3);
        $month = currentMonth();
        $pool  = loadPool($month);
        $before = count($pool['items'] ?? []);
        $pool['items'] = array_values(array_filter($pool['items'] ?? [], fn($x) => ($x['id'] ?? '') !== $id));
        savePool($month, $pool);
        tg('answerCallbackQuery', [
            'callback_query_id' => $cb['id'],
            'text'              => $before > count($pool['items']) ? '❌ Ссылка удалена' : 'Не найдено',
        ]);
        if ($msgId) {
            $p = poolListPayload($month);
            tg('editMessageText', [
                'chat_id'                  => MY_CHAT_ID,
                'message_id'               => $msgId,
                'text'                     => $p['text'],
                'parse_mode'               => 'HTML',
                'disable_web_page_preview' => true,
                'reply_markup'             => $p['reply_markup'] ?? ['inline_keyboard' => []],
            ]);
        }
        return;
    }

    $draft = loadDraft();

    if ($draft === null || in_array($draft['status'] ?? '', ['published', 'cancelled'], true)) {
        tg('answerCallbackQuery', [
            'callback_query_id' => $cb['id'],
            'text'              => 'Активного черновика нет.',
            'show_alert'        => true,
        ]);
        return;
    }

    if (str_starts_with($data, 'edit_')) {
        // Оптимистично: мгновенный toast-подсказка, без сообщения и без запроса
        // на сервер. Новое описание владелец шлёт ответом прямо на карточку.
        tg('answerCallbackQuery', [
            'callback_query_id' => $cb['id'],
            'text'              => '✏️ Ответь на эту карточку новым описанием',
        ]);
        return;
    }

    if (str_starts_with($data, 'exclude_')) {
        $id = substr($data, 8);
        tg('answerCallbackQuery', ['callback_query_id' => $cb['id'], 'text' => '🚫 Исключено']);
        if (!in_array($id, $draft['excluded'], true)) $draft['excluded'][] = $id;
        saveDraft($draft);
        flipCardButton($draft, $id); // лёгкое переключение кнопки; обработка — при публикации
        return;
    }

    if (str_starts_with($data, 'include_')) {
        $id = substr($data, 8);
        tg('answerCallbackQuery', ['callback_query_id' => $cb['id'], 'text' => '↩️ Возвращено']);
        $draft['excluded'] = array_values(array_filter($draft['excluded'], fn($x) => $x !== $id));
        saveDraft($draft);
        flipCardButton($draft, $id);
        return;
    }

    if ($data === 'remind_publish') {
        tg('answerCallbackQuery', ['callback_query_id' => $cb['id']]);
        if ($msgId) {
            tg('editMessageReplyMarkup', [
                'chat_id'      => MY_CHAT_ID,
                'message_id'   => $msgId,
                'reply_markup' => ['inline_keyboard' => []],
            ]);
        }
        startPublish($draft);
        return;
    }

    if ($data === 'pub_abort') {
        tg('answerCallbackQuery', ['callback_query_id' => $cb['id'], 'text' => '🚫 Прервано']);
        $draft['status'] = 'paused';
        saveDraft($draft);
        if ($msgId) {
            tg('editMessageText', [
                'chat_id'    => MY_CHAT_ID,
                'message_id' => $msgId,
                'text'       => '🚫 Публикация прервана. Черновик сохранён — можно опубликовать позже.',
            ]);
        }
        return;
    }

    if ($data === 'remind_cancel') {
        $draft['status'] = 'cancelled';
        saveDraft($draft);
        if ($msgId) {
            tg('editMessageReplyMarkup', [
                'chat_id'      => MY_CHAT_ID,
                'message_id'   => $msgId,
                'reply_markup' => ['inline_keyboard' => []],
            ]);
        }
        tg('sendMessage', [
            'chat_id'      => MY_CHAT_ID,
            'text'         => '❌ Публикация отменена. В этом цикле дайджест не выйдет.',
            'reply_markup' => ['remove_keyboard' => true],
        ]);
        tg('answerCallbackQuery', ['callback_query_id' => $cb['id']]);
        return;
    }

    if ($data === 'paused_publish') {
        tg('answerCallbackQuery', ['callback_query_id' => $cb['id']]);
        startPublish($draft);
        return;
    }

    if ($data === 'paused_schedule') {
        sendScheduleMenu();
        tg('answerCallbackQuery', ['callback_query_id' => $cb['id']]);
        return;
    }

    if (str_starts_with($data, 'sched_')) {
        $which = substr($data, 6);
        if ($which === 'manual') {
            $res = tg('sendMessage', [
                'chat_id'      => MY_CHAT_ID,
                'text'         => 'Отправь дату и время <b>ответом</b> в формате ДД.ММ ЧЧ:ММ (МСК), например 20.06 18:30.',
                'parse_mode'   => 'HTML',
                'reply_markup' => ['force_reply' => true, 'input_field_placeholder' => 'ДД.ММ ЧЧ:ММ'],
            ]);
            $pid = $res['result']['message_id'] ?? null;
            if ($pid) {
                $draft['prompts'][(string) $pid] = ['kind' => 'schedule'];
                saveDraft($draft);
            }
            tg('answerCallbackQuery', ['callback_query_id' => $cb['id']]);
            return;
        }

        $dt = new DateTime('now', new DateTimeZone(TZ));
        $dt->setTime(18, 30, 0);
        if ($which === 'tomorrow') $dt->modify('+1 day');
        elseif ($which === '3d')   $dt->modify('+3 days');
        scheduleAt($draft, $dt->getTimestamp(), $msgId);
        tg('answerCallbackQuery', ['callback_query_id' => $cb['id'], 'text' => 'Запланировано']);
        return;
    }

    tg('answerCallbackQuery', ['callback_query_id' => $cb['id']]);
}

// =====================================================================
// Обработка message (ответы force_reply и нижняя панель)
// =====================================================================

function handleMessage(array $msg): void {
    $chatId = $msg['chat']['id'] ?? null;
    if ((string) $chatId !== (string) MY_CHAT_ID) return;

    $text  = trim((string) ($msg['text'] ?? ''));
    $draft = loadDraft();

    // 0) Команда сброса: удалить сообщения черновика и очистить состояние.
    if ($text === '/reset' || $text === '/clear') {
        resetDraft();
        return;
    }

    // 0b) Список пула с кнопками удаления.
    if ($text === '/pool' || $text === '/links' || $text === '/материалы') {
        $p = poolListPayload(currentMonth());
        $params = ['chat_id' => MY_CHAT_ID, 'text' => $p['text'], 'parse_mode' => 'HTML', 'disable_web_page_preview' => true];
        if ($p['reply_markup']) $params['reply_markup'] = $p['reply_markup'];
        tg('sendMessage', $params);
        return;
    }

    $replyTo = $msg['reply_to_message']['message_id'] ?? null;

    // 1) Ответ на ввод времени (force_reply отложенной публикации).
    if ($draft && $replyTo !== null && isset($draft['prompts'][(string) $replyTo])) {
        unset($draft['prompts'][(string) $replyTo]);
        $ts = parseScheduleInput($text);
        if (!$ts) {
            saveDraft($draft);
            notifyOwner('Не понял дату. Формат: ДД.ММ ЧЧ:ММ, например 20.06 18:30');
            return;
        }
        scheduleAt($draft, $ts, null);
        return;
    }

    // 2) Правка описания — ответ прямо на карточку (без промпта).
    if ($draft && $replyTo !== null) {
        $cardId = array_search($replyTo, $draft['cardMsgIds'] ?? [], true);
        if ($cardId !== false && $text !== '') {
            $draft['edits'][(string) $cardId] = $text;
            saveDraft($draft);
            refreshCard($draft, (string) $cardId); // показываем новое описание на карточке
            // убираем сообщение-ответ, чтобы не засорять список карточек
            if (!empty($msg['message_id'])) {
                tg('deleteMessage', ['chat_id' => MY_CHAT_ID, 'message_id' => $msg['message_id']]);
            }
            return;
        }
    }

    // 3) Приём ссылок в пул месяца — работает в любое время, без активного черновика.
    $urls = extractUrls($text);
    if ($urls) {
        $month = currentMonth();
        $pool  = loadPool($month);
        $keys  = array_column($pool['items'], 'key');
        $added = 0; $dup = 0;
        foreach ($urls as $u) {
            $key = normalizeUrl($u);
            if (in_array($key, $keys, true)) { $dup++; continue; }
            $pool['items'][] = ['id' => substr(md5($key), 0, 8), 'url' => $u, 'key' => $key, 'addedAt' => gmdate('c')];
            $keys[] = $key; $added++;
        }
        savePool($month, $pool);

        $count  = count($pool['items']);
        $remain = max(0, POOL_TARGET - $count);
        $label  = monthLabelRu($month);
        $lines  = [];
        if ($added) $lines[] = "✅ Добавлено в пул: {$added}.";
        if ($dup)   $lines[] = "↪️ Уже были в пуле: {$dup}.";
        $lines[] = "📥 В пуле за {$label}: {$count} " . pluralLinks($count) . ".";
        $lines[] = $remain > 0
            ? "До цели (" . POOL_TARGET . ") — добрать ещё {$remain}."
            : "Цель (" . POOL_TARGET . ") набрана.";
        tg('sendMessage', [
            'chat_id'                  => MY_CHAT_ID,
            'text'                     => implode("\n", $lines),
            'disable_web_page_preview' => true,
        ]);
        return;
    }

    // 4) Кнопки нижней панели.
    if ($text === '📢 Опубликовать') {
        if (!$draft || in_array($draft['status'] ?? '', ['published', 'cancelled'], true)) {
            tg('sendMessage', ['chat_id' => MY_CHAT_ID, 'text' => 'Активного черновика нет.', 'reply_markup' => ['remove_keyboard' => true]]);
            return;
        }
        startPublish($draft); // без подтверждения, с ETA и окном отмены
        return;
    }

    if ($text === '🕒 Отложить' || $text === '🕒 Отложенная публикация') {
        if (!$draft || in_array($draft['status'] ?? '', ['published', 'cancelled'], true)) {
            tg('sendMessage', ['chat_id' => MY_CHAT_ID, 'text' => 'Активного черновика нет.', 'reply_markup' => ['remove_keyboard' => true]]);
            return;
        }
        sendScheduleMenu();
        return;
    }

    if ($text === '🚫 Не публиковать') {
        if (!$draft || in_array($draft['status'] ?? '', ['published', 'cancelled'], true)) {
            tg('sendMessage', ['chat_id' => MY_CHAT_ID, 'text' => 'Активного черновика нет.', 'reply_markup' => ['remove_keyboard' => true]]);
            return;
        }
        $draft['status'] = 'paused';
        saveDraft($draft);
        tg('sendMessage', [
            'chat_id'      => MY_CHAT_ID,
            'text'         => '⏸ Публикация приостановлена. Авто-публикация не сработает — '
                            . 'опубликуешь, когда будешь готов. Карточки можно править дальше.',
            'reply_markup' => ['inline_keyboard' => [[
                ['text' => '📢 Опубликовать', 'callback_data' => 'paused_publish'],
                ['text' => '🕒 Задать время', 'callback_data' => 'paused_schedule'],
            ]]],
        ]);
        return;
    }
    // Остальные сообщения игнорируем.
}

// =====================================================================
// Роутинг
// =====================================================================

function ciSecretOk(): bool {
    $h = $_SERVER['HTTP_X_BOT_SECRET'] ?? '';
    $q = $_GET['secret'] ?? '';
    return ($h !== '' && hash_equals(WEBHOOK_SECRET, $h))
        || ($q !== '' && hash_equals(WEBHOOK_SECRET, $q));
}

// Под CLI файл подключается как библиотека (юнит-тесты) — роутинг не запускаем.
if (PHP_SAPI !== 'cli') {
    $action = $_GET['action'] ?? '';

    if ($action === 'init_draft') {
        if (!ciSecretOk()) { http_response_code(403); exit; }
        handleInitDraft();
        exit;
    }

    if ($action === 'tick') {
        if (!ciSecretOk()) { http_response_code(403); exit; }
        handleTick();
        exit;
    }

    if ($action === 'cleanup') {
        if (!ciSecretOk()) { http_response_code(403); exit; }
        handleCleanup();
        exit;
    }

    // Пул присланных ссылок за месяц — для сборки дайджеста в CI.
    if ($action === 'pool') {
        if (!ciSecretOk()) { http_response_code(403); exit; }
        header('Content-Type: application/json');
        echo json_encode(loadPool($_GET['month'] ?? currentMonth()), JSON_UNESCAPED_UNICODE);
        exit;
    }

    // Забор пула для сборки: первые 35 в выпуск, лишние — в след. месяц (идемпотентно).
    // dry=1 — просмотр выбора без мутации (тестовые прогоны).
    if ($action === 'pool_consume') {
        if (!ciSecretOk()) { http_response_code(403); exit; }
        handlePoolConsume($_GET['month'] ?? currentMonth(), !empty($_GET['dry']));
        exit;
    }

    // Апдейт от Telegram.
    $secretHeader = $_SERVER['HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN'] ?? '';
    if ($secretHeader !== WEBHOOK_SECRET) exit;

    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input) exit;

    if (isset($input['callback_query'])) {
        handleCallback($input['callback_query']);
    } elseif (isset($input['message'])) {
        handleMessage($input['message']);
    }
    exit;
}
