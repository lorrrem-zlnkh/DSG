<?php
require_once __DIR__ . '/config.php';

$input = json_decode(file_get_contents('php://input'), true);
if (!$input) exit;

// Verify secret token from Telegram
$secretHeader = $_SERVER['HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN'] ?? '';
if ($secretHeader !== WEBHOOK_SECRET) exit;

function tg(string $method, array $params): array {
    $ch = curl_init('https://api.telegram.org/bot' . BOT_TOKEN . '/' . $method);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode($params),
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 10,
    ]);
    $result = curl_exec($ch);
    curl_close($ch);
    return json_decode($result, true) ?: [];
}

if (!isset($input['callback_query'])) exit;

$cb     = $input['callback_query'];
$data   = $cb['data'];
$chatId = $cb['message']['chat']['id'];
$msgId  = $cb['message']['message_id'];

if (str_starts_with($data, 'publish_')) {
    $parts  = explode('_', $data, 4); // ['publish', year, month, count]
    $year   = $parts[1];
    $month  = (int) $parts[2];
    $count  = $parts[3];

    $months = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
               'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
    $label  = $months[$month] ?? "Месяц {$month}";

    $text = "🗞 *Дайджест DSG — {$label} {$year}*\n\n"
          . "Собрали {$count} материалов по дизайн\-системам, дизайну интерфейсов и продуктовому дизайну\.\n\n"
          . "👉 [Читать дайджест](https://dsg\.lorrrem\.ru/blog/)";

    tg('sendMessage', [
        'chat_id'    => CHANNEL_ID,
        'text'       => $text,
        'parse_mode' => 'MarkdownV2',
    ]);

    tg('editMessageText', [
        'chat_id'      => $chatId,
        'message_id'   => $msgId,
        'text'         => "✅ Анонс опубликован в " . CHANNEL_ID,
        'reply_markup' => ['inline_keyboard' => []],
    ]);

    tg('answerCallbackQuery', ['callback_query_id' => $cb['id'], 'text' => 'Опубликовано!']);

} elseif ($data === 'cancel') {
    tg('editMessageText', [
        'chat_id'      => $chatId,
        'message_id'   => $msgId,
        'text'         => "❌ Публикация отменена",
        'reply_markup' => ['inline_keyboard' => []],
    ]);
    tg('answerCallbackQuery', ['callback_query_id' => $cb['id'], 'text' => 'Отменено']);
}
