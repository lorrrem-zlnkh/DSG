<?php
require_once __DIR__ . '/config.php';

const DRAFT_PATH   = __DIR__ . '/draft.json';
const DIGESTS_PATH = __DIR__ . '/../blog/digests.json';
const SITE_URL     = 'https://dsg.lorrrem.ru/blog/';
const TZ           = 'Europe/Moscow';

// =====================================================================
// Telegram API
// =====================================================================

function tg(string $method, array $params): array {
    $json = [];
    for ($attempt = 0; $attempt < 3; $attempt++) {
        $ch = curl_init('https://api.telegram.org/bot' . BOT_TOKEN . '/' . $method);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode($params),
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 15,
        ]);
        $result = curl_exec($ch);
        curl_close($ch);
        $json = json_decode($result, true) ?: [];

        if (($json['ok'] ?? false) === true) return $json;
        // Перегрузка — подождать и повторить.
        if ((int) ($json['error_code'] ?? 0) === 429) {
            $retry = (int) ($json['parameters']['retry_after'] ?? 1);
            sleep(min(max($retry, 1), 5));
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
// Рендер карточек и клавиатур
// =====================================================================

function renderCard(array $item, array $draft): string {
    $id       = $item['id'] ?? '';
    $excluded = in_array($id, $draft['excluded'] ?? [], true);
    $summary  = $draft['edits'][$id] ?? ($item['summary'] ?? '');
    $edited   = isset($draft['edits'][$id]) && $draft['edits'][$id] !== '';

    $rubric = h($item['rubric'] ?? 'Без рубрики');
    $lang   = !empty($item['languageBadge']) ? ' <i>(' . h($item['languageBadge']) . ')</i>' : '';
    $title  = h($item['sourceTitle'] ?? '');
    $url    = h($item['url'] ?? '');

    $head = "<b>{$rubric}</b>\n<a href=\"{$url}\">{$title}</a>{$lang}\n";

    if ($excluded) {
        return $head . "🚫 <i>Исключено из публикации</i>";
    }
    $body = "<i>" . h($summary) . "</i>";
    if ($edited) $body .= "\n✏️ <i>описание изменено</i>";
    return $head . $body;
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
            [['text' => '📢 Опубликовать'], ['text' => '🕒 Отложенная публикация']],
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

function sendPublishConfirm(): void {
    tg('sendMessage', [
        'chat_id'      => MY_CHAT_ID,
        'text'         => 'Опубликовать дайджест на сайт и анонс в ' . CHANNEL_ID . '?',
        'reply_markup' => ['inline_keyboard' => [[
            ['text' => '✅ Да, опубликовать', 'callback_data' => 'pub_confirm'],
            ['text' => '❌ Отмена',           'callback_data' => 'pub_cancel'],
        ]]],
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
    tg('editMessageText', [
        'chat_id'                  => MY_CHAT_ID,
        'message_id'               => $msgId,
        'text'                     => renderCard($item, $draft),
        'parse_mode'               => 'HTML',
        'disable_web_page_preview' => true,
        'reply_markup'             => cardKeyboard($id, $draft),
    ]);
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

function publishDraft(array $draft, string $mode): void {
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

    // 2) Анонс в канал.
    $count  = (int) ($final['count'] ?? 0);
    $number = $final['number'] ?? null;
    $label  = ucfirstRu((string) ($final['monthLabel'] ?? ''));
    $year   = $final['year'] ?? '';
    $title  = $number ? "Дайджест DSG №{$number} — {$label} {$year}"
                      : "Дайджест DSG — {$label} {$year}";

    $text = "🗞 <b>" . h($title) . "</b>\n\n"
          . "Собрали {$count} материалов о дизайн-системах, дизайне интерфейсов "
          . "и продуктовом дизайне.\n\n"
          . "<b>В выпуске:</b> " . rubricsSummary($final) . "\n\n"
          . "👉 <a href=\"" . SITE_URL . "\">Читать дайджест</a>";

    tg('sendMessage', [
        'chat_id'                  => CHANNEL_ID,
        'text'                     => $text,
        'parse_mode'               => 'HTML',
        'disable_web_page_preview' => false,
    ]);

    // 3) Финализируем черновик.
    $draft['status']      = 'published';
    $draft['publishedAt'] = gmdate('c');
    $draft['publishMode'] = $mode;
    saveDraft($draft);

    // 4) Прибираем чат владельца.
    $modeLabel = $mode === 'auto'      ? ' автоматически'
               : ($mode === 'scheduled' ? ' по расписанию' : '');
    tg('sendMessage', [
        'chat_id'      => MY_CHAT_ID,
        'text'         => "✅ Дайджест опубликован{$modeLabel} на сайт, анонс — в " . CHANNEL_ID . ".",
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
        'chat_id'    => MY_CHAT_ID,
        'text'       => "🗞 <b>Черновик дайджеста DSG №" . h((string) $number) . " — {$label} {$year}</b>\n"
                      . "{$count} материалов.\n\n"
                      . "Проверь карточки ниже: можно изменить описание или исключить материал. "
                      . "Когда закончишь — кнопки внизу.",
        'parse_mode' => 'HTML',
    ]);
    $draft['headerMsgId'] = $hdr['result']['message_id'] ?? null;

    $cardMsgIds = [];
    foreach ($digest['items'] as $item) {
        $id  = $item['id'] ?? '';
        $res = tg('sendMessage', [
            'chat_id'                  => MY_CHAT_ID,
            'text'                     => renderCard($item, $draft),
            'parse_mode'               => 'HTML',
            'disable_web_page_preview' => true,
            'reply_markup'             => cardKeyboard($id, $draft),
        ]);
        if (!empty($res['result']['message_id'])) {
            $cardMsgIds[$id] = $res['result']['message_id'];
        }
        usleep(40000); // бережём лимит Telegram (~1 сообщение/сек в чат)
    }
    $draft['cardMsgIds'] = $cardMsgIds;

    $ftr = tg('sendMessage', [
        'chat_id'      => MY_CHAT_ID,
        'text'         => "👇 Когда закончишь модерацию — выбери действие.",
        'reply_markup' => actionKeyboard(),
    ]);
    $draft['footerMsgId'] = $ftr['result']['message_id'] ?? null;
    saveDraft($draft);

    echo json_encode(['ok' => true, 'count' => $count, 'cards' => count($cardMsgIds)]);
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

function handleTick(): void {
    header('Content-Type: application/json');
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
        $id   = substr($data, 5);
        $item = findItem($draft, $id);
        if (!$item) {
            tg('answerCallbackQuery', ['callback_query_id' => $cb['id'], 'text' => 'Материал не найден']);
            return;
        }
        $current = $draft['edits'][$id] ?? ($item['summary'] ?? '');
        $res = tg('sendMessage', [
            'chat_id'      => MY_CHAT_ID,
            'text'         => "✏️ Текущее описание (нажми, чтобы скопировать):\n\n"
                            . "<code>" . h($current) . "</code>\n\n"
                            . "Отправь новое описание <b>ответом на это сообщение</b>.",
            'parse_mode'   => 'HTML',
            'reply_markup' => [
                'force_reply'             => true,
                'input_field_placeholder' => 'Новое описание',
                'selective'               => true,
            ],
        ]);
        $pid = $res['result']['message_id'] ?? null;
        if ($pid) {
            $draft['prompts'][(string) $pid] = ['kind' => 'edit', 'itemId' => $id];
            saveDraft($draft);
        }
        tg('answerCallbackQuery', ['callback_query_id' => $cb['id']]);
        return;
    }

    if (str_starts_with($data, 'exclude_')) {
        $id = substr($data, 8);
        if (!in_array($id, $draft['excluded'], true)) $draft['excluded'][] = $id;
        saveDraft($draft);
        refreshCard($draft, $id);
        tg('answerCallbackQuery', ['callback_query_id' => $cb['id'], 'text' => 'Материал исключён']);
        return;
    }

    if (str_starts_with($data, 'include_')) {
        $id = substr($data, 8);
        $draft['excluded'] = array_values(array_filter($draft['excluded'], fn($x) => $x !== $id));
        saveDraft($draft);
        refreshCard($draft, $id);
        tg('answerCallbackQuery', ['callback_query_id' => $cb['id'], 'text' => 'Материал возвращён']);
        return;
    }

    if ($data === 'pub_confirm' || $data === 'remind_publish') {
        if ($msgId) {
            tg('editMessageReplyMarkup', [
                'chat_id'      => MY_CHAT_ID,
                'message_id'   => $msgId,
                'reply_markup' => ['inline_keyboard' => []],
            ]);
        }
        publishDraft($draft, 'manual');
        tg('answerCallbackQuery', ['callback_query_id' => $cb['id'], 'text' => '✅ Опубликовано', 'show_alert' => true]);
        return;
    }

    if ($data === 'pub_cancel') {
        if ($msgId) {
            tg('editMessageText', [
                'chat_id'    => MY_CHAT_ID,
                'message_id' => $msgId,
                'text'       => 'Публикация отменена. Черновик остаётся активным.',
            ]);
        }
        tg('answerCallbackQuery', ['callback_query_id' => $cb['id']]);
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
        sendPublishConfirm();
        tg('answerCallbackQuery', ['callback_query_id' => $cb['id']]);
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

    // 1) Ответы на force_reply (правка описания / ввод времени).
    $replyTo = $msg['reply_to_message']['message_id'] ?? null;
    if ($draft && $replyTo !== null && isset($draft['prompts'][(string) $replyTo])) {
        $ctx = $draft['prompts'][(string) $replyTo];
        unset($draft['prompts'][(string) $replyTo]);

        if (($ctx['kind'] ?? '') === 'edit') {
            $id = $ctx['itemId'] ?? '';
            if ($text === '') {
                saveDraft($draft);
                tg('sendMessage', ['chat_id' => MY_CHAT_ID, 'text' => 'Пустое описание — пропускаю.']);
                return;
            }
            $draft['edits'][$id] = $text;
            saveDraft($draft);
            refreshCard($draft, $id);
            notifyOwner('✅ Описание обновлено.');
            return;
        }

        if (($ctx['kind'] ?? '') === 'schedule') {
            $ts = parseScheduleInput($text);
            if (!$ts) {
                saveDraft($draft);
                notifyOwner('Не понял дату. Формат: ДД.ММ ЧЧ:ММ, например 20.06 18:30');
                return;
            }
            scheduleAt($draft, $ts, null);
            return;
        }
    }

    // 2) Кнопки нижней панели.
    if ($text === '📢 Опубликовать') {
        if (!$draft || in_array($draft['status'] ?? '', ['published', 'cancelled'], true)) {
            tg('sendMessage', ['chat_id' => MY_CHAT_ID, 'text' => 'Активного черновика нет.', 'reply_markup' => ['remove_keyboard' => true]]);
            return;
        }
        sendPublishConfirm();
        return;
    }

    if ($text === '🕒 Отложенная публикация') {
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
