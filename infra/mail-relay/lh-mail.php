<?php
/**
 * LeadHunter — HTTPS-ретранслятор писем с кодом входа (PHP 7.4+, без Composer).
 *
 * Принимает ТОЛЬКО POST application/json {"to","code","ttl_minutes"} с подписью HMAC-SHA256
 * и сам формирует фиксированное письмо «Код входа LeadHunter». Произвольные тема/текст принять нельзя.
 *
 * Подпись: X-LH-Signature = hex HMAC-SHA256(secret, X-LH-Timestamp . "." . X-LH-Nonce . "." . тело).
 * Конфигурация: lh-mail-config.php (образец: lh-mail-config.sample.php) ВНЕ каталога сайта.
 */
declare(strict_types=1);

const LH_MAX_BODY = 2048;
const LH_TS_SKEW = 300;

/** Ошибка с HTTP-статусом и кодом для клиента (детали — только в серверный лог). */
final class LhError extends RuntimeException
{
    public $status;
    public $errCode;

    public function __construct(int $status, string $errCode, string $detail = '')
    {
        parent::__construct($detail !== '' ? $detail : $errCode);
        $this->status = $status;
        $this->errCode = $errCode;
    }
}

function lh_respond(int $status, array $body): void
{
    if (!headers_sent()) {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store, max-age=0');
        header('Pragma: no-cache');
        header('X-Content-Type-Options: nosniff');
        header('Referrer-Policy: no-referrer');
        if ($status === 405) {
            header('Allow: POST');
        }
    }
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
}

function lh_mask_email(string $e): string
{
    $at = strrpos($e, '@');
    if ($at === false || $at < 1) {
        return '***';
    }
    $local = substr($e, 0, $at);
    $domain = substr($e, $at + 1);
    $dot = strrpos($domain, '.');
    $tld = $dot === false ? '' : substr($domain, $dot);
    return substr($local, 0, 1) . '***@' . substr($domain, 0, 1) . '***' . $tld;
}

/** Убирает адреса и управляющие символы из текста перед записью в лог. */
function lh_sanitize_log(string $s): string
{
    $s = preg_replace_callback('/[^\s<>"\']+@[^\s<>"\']+/', static function ($m) {
        return preg_match('/^.\*\*\*@.\*\*\*/', $m[0]) ? $m[0] : lh_mask_email($m[0]);
    }, $s) ?? '';
    $s = preg_replace('/[\x00-\x1f\x7f]+/', ' ', $s) ?? '';
    return substr($s, 0, 200);
}

$GLOBALS['lh_log_file'] = null;

function lh_log(string $msg): void
{
    $line = '[lh-mail] ' . gmdate('Y-m-d H:i:s') . 'Z ' . lh_sanitize_log($msg);
    @error_log($line);
    $f = $GLOBALS['lh_log_file'];
    if (is_string($f) && $f !== '') {
        if (@filesize($f) > 262144) {
            @rename($f, $f . '.1');
        }
        @file_put_contents($f, $line . "\n", FILE_APPEND | LOCK_EX);
    }
}

function lh_load_config(): array
{
    $candidates = [__DIR__ . '/../lh-mail-config.php', __DIR__ . '/lh-mail-config.php'];
    $path = null;
    foreach ($candidates as $i => $c) {
        if (is_file($c)) {
            $path = $c;
            if ($i === 1) {
                lh_log('ПРЕДУПРЕЖДЕНИЕ: конфигурация лежит рядом со скриптом (в каталоге сайта); перенесите её выше');
            }
            break;
        }
    }
    if ($path === null) {
        throw new LhError(500, 'config_error', 'конфигурация не найдена');
    }
    $cfg = (static function (string $p) {
        return include $p;
    })($path);
    if (!is_array($cfg)) {
        throw new LhError(500, 'config_error', 'конфигурация не вернула массив');
    }
    $secret = $cfg['secret'] ?? '';
    if (!is_string($secret) || strlen($secret) < 32) {
        throw new LhError(500, 'config_error', 'secret короче 32 символов');
    }
    $transport = $cfg['transport'] ?? 'smtp';
    if (!in_array($transport, ['smtp', 'mail'], true)) {
        throw new LhError(500, 'config_error', 'неизвестный transport');
    }
    $from = $cfg['from'] ?? '';
    if (!is_string($from) || lh_envelope_from($from) === '') {
        throw new LhError(500, 'config_error', 'некорректный from');
    }
    if ($transport === 'smtp') {
        foreach (['smtp_host', 'smtp_user', 'smtp_password'] as $k) {
            if (!isset($cfg[$k]) || !is_string($cfg[$k])) {
                throw new LhError(500, 'config_error', "нет $k");
            }
        }
    }
    $dir = $cfg['data_dir'] ?? '';
    if (!is_string($dir) || $dir === '') {
        throw new LhError(500, 'config_error', 'нет data_dir');
    }
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        throw new LhError(500, 'config_error', 'не удалось создать data_dir');
    }
    $real = realpath($dir);
    $web = realpath(__DIR__);
    if ($real === false || $web === false) {
        throw new LhError(500, 'config_error', 'data_dir недоступен');
    }
    if ($real === $web || strpos($real . DIRECTORY_SEPARATOR, $web . DIRECTORY_SEPARATOR) === 0) {
        throw new LhError(500, 'config_error', 'data_dir внутри каталога сайта');
    }
    $cfg['data_dir'] = $real;
    return $cfg;
}

function lh_envelope_from(string $from): string
{
    $addr = $from;
    if (preg_match('/<([^<>]+)>\s*$/', $from, $m)) {
        $addr = $m[1];
    }
    $addr = trim($addr);
    return (filter_var($addr, FILTER_VALIDATE_EMAIL) !== false && strlen($addr) <= 254) ? $addr : '';
}

function lh_is_https(): bool
{
    $h = $_SERVER['HTTPS'] ?? '';
    if ($h !== '' && strtolower((string)$h) !== 'off') {
        return true;
    }
    foreach (['HTTP_X_FORWARDED_PROTO', 'HTTP_X_FORWARDED_SCHEME', 'REQUEST_SCHEME'] as $k) {
        if (strtolower((string)($_SERVER[$k] ?? '')) === 'https') {
            return true;
        }
    }
    return (string)($_SERVER['SERVER_PORT'] ?? '') === '443';
}

function lh_read_body(): string
{
    $len = $_SERVER['CONTENT_LENGTH'] ?? null;
    if ($len !== null && ctype_digit((string)$len) && (int)$len > LH_MAX_BODY) {
        throw new LhError(413, 'too_large');
    }
    $in = fopen('php://input', 'rb');
    if ($in === false) {
        throw new LhError(400, 'bad_request');
    }
    $body = stream_get_contents($in, LH_MAX_BODY + 1);
    fclose($in);
    if ($body === false) {
        throw new LhError(400, 'bad_request');
    }
    if (strlen($body) > LH_MAX_BODY) {
        throw new LhError(413, 'too_large');
    }
    return $body;
}

function lh_header(string $name): string
{
    $v = $_SERVER['HTTP_' . strtoupper(str_replace('-', '_', $name))] ?? '';
    return is_string($v) ? $v : '';
}

function lh_verify_signature(string $secret, string $body): string
{
    $ts = lh_header('X-LH-Timestamp');
    $nonce = lh_header('X-LH-Nonce');
    $sig = lh_header('X-LH-Signature');
    if (!preg_match('/^[0-9]{1,12}$/D', $ts)
        || !preg_match('/^[A-Za-z0-9_-]{16,64}$/D', $nonce)
        || !preg_match('/^[0-9a-f]{64}$/Di', $sig)) {
        throw new LhError(401, 'unauthorized', 'заголовки подписи отсутствуют или некорректны');
    }
    if (abs(time() - (int)$ts) > LH_TS_SKEW) {
        throw new LhError(401, 'unauthorized', 'timestamp вне допуска');
    }
    $expected = hash_hmac('sha256', $ts . '.' . $nonce . '.' . $body, $secret);
    if (!hash_equals($expected, strtolower($sig))) {
        throw new LhError(401, 'unauthorized', 'подпись не совпала');
    }
    return $nonce;
}

/** Запоминает nonce; повтор (в окне допуска) отвергается. Подпись к этому моменту уже проверена. */
function lh_claim_nonce(string $dataDir, string $nonce): void
{
    $dir = $dataDir . '/nonces';
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        throw new LhError(500, 'internal', 'нет каталога nonce');
    }
    $now = time();
    $marker = $dir . '/.cleaned';
    if (!is_file($marker) || $now - (int)@filemtime($marker) > 60) {
        @touch($marker);
        $files = @scandir($dir) ?: [];
        foreach ($files as $f) {
            if ($f === '.' || $f === '..' || $f === '.cleaned') {
                continue;
            }
            $p = $dir . '/' . $f;
            if ($now - (int)@filemtime($p) > 2 * LH_TS_SKEW + 60) {
                @unlink($p);
            }
        }
    }
    $fh = @fopen($dir . '/' . hash('sha256', $nonce), 'x');   // 'x' — атомарное «создать, если нет»
    if ($fh === false) {
        if (is_file($dir . '/' . hash('sha256', $nonce))) {
            throw new LhError(401, 'unauthorized', 'повтор nonce');
        }
        throw new LhError(500, 'internal', 'не удалось записать nonce');
    }
    fclose($fh);
}

/** @return array{0:string,1:string,2:int} [to, code, ttl] */
function lh_parse_payload(string $body): array
{
    $d = json_decode($body, true);
    if (!is_array($d) || (count($d) > 0 && array_keys($d) === range(0, count($d) - 1))) {
        throw new LhError(400, 'bad_request', 'тело не объект JSON');
    }
    foreach (array_keys($d) as $k) {
        if (!in_array($k, ['to', 'code', 'ttl_minutes'], true)) {
            throw new LhError(400, 'bad_request', 'лишнее поле');
        }
    }
    $to = $d['to'] ?? null;
    $code = $d['code'] ?? null;
    $ttl = array_key_exists('ttl_minutes', $d) ? $d['ttl_minutes'] : 10;
    if (!is_string($to) || strlen($to) > 254 || filter_var($to, FILTER_VALIDATE_EMAIL) === false
        || preg_match('/[\x00-\x20\x7f-\xff<>,;"\'\\\\]/', $to)) {
        throw new LhError(400, 'bad_request', 'некорректный to');
    }
    if (!is_string($code) || !preg_match('/^[0-9]{6}$/D', $code)) {
        throw new LhError(400, 'bad_request', 'некорректный code');
    }
    if (!is_int($ttl) || $ttl < 1 || $ttl > 60) {
        throw new LhError(400, 'bad_request', 'некорректный ttl_minutes');
    }
    return [$to, $code, $ttl];
}

/** Лимиты: ≤N писем/час на получателя и ≤M/сутки всего. Счётчики — в одном JSON под flock. */
function lh_rate_limit(string $dataDir, string $to, array $cfg): void
{
    $perRcpt = (int)($cfg['max_per_recipient_per_hour'] ?? 5);
    $perDay = (int)($cfg['max_per_day'] ?? 300);
    $lock = @fopen($dataDir . '/rate.lock', 'c');
    if ($lock === false || !flock($lock, LOCK_EX)) {
        throw new LhError(500, 'internal', 'нет блокировки лимитов');
    }
    try {
        $file = $dataDir . '/rate.json';
        $st = is_file($file) ? json_decode((string)@file_get_contents($file), true) : null;
        $day = gmdate('Ymd');
        $now = time();
        if (!is_array($st) || ($st['day'] ?? '') !== $day) {
            $st = ['day' => $day, 'total' => 0, 'rcpt' => $st['rcpt'] ?? []];
        }
        if (!is_array($st['rcpt'])) {
            $st['rcpt'] = [];
        }
        foreach ($st['rcpt'] as $h => $times) {
            $times = array_values(array_filter(is_array($times) ? $times : [], static function ($t) use ($now) {
                return is_int($t) && $now - $t < 3600;
            }));
            if ($times) {
                $st['rcpt'][$h] = $times;
            } else {
                unset($st['rcpt'][$h]);
            }
        }
        $key = hash('sha256', strtolower($to));
        $mine = $st['rcpt'][$key] ?? [];
        if ((int)$st['total'] >= $perDay) {
            throw new LhError(429, 'rate_limited', 'дневной лимит');
        }
        if (count($mine) >= $perRcpt) {
            throw new LhError(429, 'rate_limited', 'лимит на получателя');
        }
        $mine[] = $now;
        $st['rcpt'][$key] = $mine;
        $st['total'] = (int)$st['total'] + 1;
        $tmp = $dataDir . '/rate.json.tmp';
        if (@file_put_contents($tmp, json_encode($st)) === false || !@rename($tmp, $file)) {
            throw new LhError(500, 'internal', 'не удалось записать лимиты');
        }
        @chmod($file, 0600);
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

function lh_plural_minutes(int $n): string
{
    $m10 = $n % 10;
    $m100 = $n % 100;
    if ($m10 === 1 && $m100 !== 11) {
        return $n . ' минута';
    }
    if ($m10 >= 2 && $m10 <= 4 && ($m100 < 12 || $m100 > 14)) {
        return $n . ' минуты';
    }
    return $n . ' минут';
}

/** @return array{0:string,1:string,2:string} [тема, text, html] — фиксированный шаблон */
function lh_render(string $code, int $ttl): array
{
    $subject = 'Код входа LeadHunter: ' . $code;
    $footer = 'Код действует ' . lh_plural_minutes($ttl) . '. Если вы не запрашивали вход — просто проигнорируйте письмо.';
    $text = "LeadHunter\r\n\r\nВаш код для входа: $code\r\n\r\n$footer\r\n";
    $spaced = implode('&nbsp;', str_split($code));
    $sans = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
    $mono = "'SF Mono',Menlo,Consolas,'Courier New',monospace";
    $html = <<<HTML
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>$subject</title>
</head>
<body style="margin:0;padding:0;background:#f6f7f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f7f5;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#ffffff;border-radius:16px;border:1px solid #e3e8e5;">
<tr><td style="padding:32px 32px 8px 32px;font-family:$sans;">
<div style="font-size:15px;font-weight:700;letter-spacing:.02em;color:#116c57;">LeadHunter</div>
<h1 style="margin:20px 0 8px 0;font-size:22px;line-height:1.3;font-weight:700;color:#1b2927;">Код для входа</h1>
<p style="margin:0;font-size:15px;line-height:1.5;color:#1b2927;">Введите этот код на странице входа:</p>
</td></tr>
<tr><td align="center" style="padding:20px 32px;">
<div style="font-family:$mono;font-size:36px;line-height:1.2;font-weight:700;letter-spacing:.18em;color:#116c57;background:#f6f7f5;border-radius:12px;padding:18px 12px;">$spaced</div>
</td></tr>
<tr><td style="padding:0 32px 32px 32px;font-family:$sans;">
<p style="margin:0;font-size:13px;line-height:1.5;color:#1b2927;">$footer</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>

HTML;
    return [$subject, $text, str_replace("\n", "\r\n", $html)];
}

function lh_b64_lines(string $s): string
{
    return chunk_split(base64_encode($s), 76, "\r\n");
}

/** @return array{0:string,1:string} [заголовки (без To/Subject — для mail()), тело multipart] плюс общие части */
function lh_build_message(array $cfg, string $to, string $code, int $ttl): array
{
    [$subject, $text, $html] = lh_render($code, $ttl);
    $boundary = '=_lh_' . bin2hex(random_bytes(12));
    $envFrom = lh_envelope_from($cfg['from']);
    $domain = substr($envFrom, (int)strrpos($envFrom, '@') + 1);
    $headers = [
        'Date: ' . date('r'),
        'From: ' . $cfg['from'],
        'Message-ID: <' . bin2hex(random_bytes(12)) . '@' . $domain . '>',
        'MIME-Version: 1.0',
        'Auto-Submitted: auto-generated',
        'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
    ];
    $body = "This is a multi-part message in MIME format.\r\n\r\n"
        . '--' . $boundary . "\r\n"
        . "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
        . lh_b64_lines($text)
        . '--' . $boundary . "\r\n"
        . "Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
        . lh_b64_lines($html)
        . '--' . $boundary . "--\r\n";
    $encSubject = '=?UTF-8?B?' . base64_encode($subject) . '?=';
    return [$headers, $body, $encSubject];
}

/** Минимальный SMTP-клиент (SSL 465 / STARTTLS 587), проверка сертификата включена. */
final class LhSmtp
{
    private $fp;
    private $cfg;

    public function __construct(array $cfg)
    {
        $this->cfg = $cfg;
    }

    private function read(): array
    {
        $code = 0;
        $text = [];
        for ($i = 0; $i < 100; $i++) {
            $line = fgets($this->fp, 1024);
            if ($line === false) {
                throw new RuntimeException('SMTP: соединение закрыто или таймаут');
            }
            $line = rtrim($line, "\r\n");
            if (!preg_match('/^(\d{3})([ -])?(.*)$/s', $line, $m)) {
                throw new RuntimeException('SMTP: непонятный ответ сервера');
            }
            $code = (int)$m[1];
            $text[] = $m[3];
            if (($m[2] ?? ' ') !== '-') {
                return [$code, $text];
            }
        }
        throw new RuntimeException('SMTP: слишком длинный ответ');
    }

    private function write(string $s): void
    {
        $n = @fwrite($this->fp, $s);
        if ($n === false || $n < strlen($s)) {
            throw new RuntimeException('SMTP: ошибка записи');
        }
    }

    /** @param int[] $ok */
    private function cmd(string $line, array $ok, string $stage): array
    {
        $this->write($line . "\r\n");
        return $this->expect($ok, $stage);
    }

    private function expect(array $ok, string $stage): array
    {
        [$code, $text] = $this->read();
        if (!in_array($code, $ok, true)) {
            throw new RuntimeException("SMTP: $stage -> $code " . implode(' ', $text));
        }
        return [$code, $text];
    }

    private function ehlo(): array
    {
        $name = preg_replace('/[^A-Za-z0-9.-]/', '', (string)($_SERVER['SERVER_NAME'] ?? 'localhost')) ?: 'localhost';
        [, $lines] = $this->cmd('EHLO ' . $name, [250], 'EHLO');
        return array_map('strtoupper', $lines);
    }

    public function send(string $envFrom, string $to, array $headers, string $subject, string $body): void
    {
        $c = $this->cfg;
        $host = (string)$c['smtp_host'];
        $port = (int)($c['smtp_port'] ?? 465);
        $sec = (string)($c['smtp_security'] ?? 'ssl');
        if (!in_array($sec, ['ssl', 'starttls', 'none'], true)) {
            throw new RuntimeException('SMTP: неизвестный smtp_security');
        }
        if ($sec === 'none' && empty($c['allow_insecure_smtp_for_tests'])) {
            throw new RuntimeException('SMTP: smtp_security=none запрещён');
        }
        $ctx = stream_context_create(['ssl' => [
            'verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => $host,
            'SNI_enabled' => true, 'allow_self_signed' => false,
        ]]);
        $scheme = $sec === 'ssl' ? 'ssl' : 'tcp';
        $fp = @stream_socket_client("$scheme://$host:$port", $errno, $errstr, 10, STREAM_CLIENT_CONNECT, $ctx);
        if ($fp === false) {
            throw new RuntimeException("SMTP: не удалось подключиться ($errno)");
        }
        $this->fp = $fp;
        stream_set_timeout($fp, 15);
        try {
            $this->expect([220], 'приветствие');
            $caps = $this->ehlo();
            if ($sec === 'starttls') {
                $this->cmd('STARTTLS', [220], 'STARTTLS');
                $method = STREAM_CRYPTO_METHOD_TLS_CLIENT;
                if (defined('STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT')) {
                    $method = STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | (defined('STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT') ? STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT : 0);
                }
                if (@stream_socket_enable_crypto($fp, true, $method) !== true) {
                    throw new RuntimeException('SMTP: не удалось включить TLS');
                }
                $caps = $this->ehlo();
            }
            $user = (string)$c['smtp_user'];
            if ($user !== '') {
                $this->auth($user, (string)$c['smtp_password'], $caps);
            }
            $this->cmd('MAIL FROM:<' . $envFrom . '>', [250], 'MAIL FROM');
            $this->cmd('RCPT TO:<' . $to . '>', [250, 251], 'RCPT TO');
            $this->cmd('DATA', [354], 'DATA');
            $all = implode("\r\n", array_merge($headers, ['To: ' . $to, 'Subject: ' . $subject])) . "\r\n\r\n" . $body;
            $all = preg_replace('/\r\n|\r|\n/', "\r\n", $all) ?? $all;
            $all = preg_replace('/^\./m', '..', $all) ?? $all;   // dot-stuffing
            if (substr($all, -2) !== "\r\n") {
                $all .= "\r\n";
            }
            $this->write($all . ".\r\n");
            $this->expect([250], 'конец DATA');
            try {
                $this->cmd('QUIT', [221], 'QUIT');
            } catch (Throwable $e) {
                // письмо уже принято
            }
        } finally {
            @fclose($fp);
        }
    }

    private function auth(string $user, string $pass, array $caps): void
    {
        $mode = (string)($this->cfg['smtp_auth'] ?? 'auto');
        $adv = '';
        foreach ($caps as $l) {
            if (strpos($l, 'AUTH') === 0) {
                $adv .= ' ' . substr($l, 4) . ' ';
            }
        }
        $plain = strpos($adv, ' PLAIN ') !== false;
        $login = strpos($adv, ' LOGIN ') !== false;
        if ($mode === 'auto') {
            $mode = $plain ? 'plain' : ($login ? 'login' : '');
        }
        if ($mode === 'plain') {
            $this->cmd('AUTH PLAIN ' . base64_encode("\0" . $user . "\0" . $pass), [235], 'AUTH');
        } elseif ($mode === 'login') {
            $this->cmd('AUTH LOGIN', [334], 'AUTH');
            $this->cmd(base64_encode($user), [334], 'AUTH');
            $this->cmd(base64_encode($pass), [235], 'AUTH');
        } else {
            throw new RuntimeException('SMTP: сервер не предлагает AUTH PLAIN/LOGIN');
        }
    }
}

function lh_deliver(array $cfg, string $to, string $code, int $ttl): void
{
    [$headers, $body, $subject] = lh_build_message($cfg, $to, $code, $ttl);
    $envFrom = lh_envelope_from($cfg['from']);
    if (($cfg['transport'] ?? 'smtp') === 'mail') {
        $ok = @mail($to, $subject, $body, implode("\r\n", $headers), '-f' . $envFrom);
        if (!$ok) {
            throw new RuntimeException('mail(): функция вернула false');
        }
        return;
    }
    (new LhSmtp($cfg))->send($envFrom, $to, $headers, $subject, $body);
}

function lh_main(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        lh_respond(405, ['ok' => false, 'code' => 'method_not_allowed']);
        return;
    }
    try {
        @set_time_limit(40);
        $cfg = lh_load_config();
        $GLOBALS['lh_log_file'] = $cfg['data_dir'] . '/lh-mail.log';
        if (empty($cfg['allow_insecure_http_for_tests']) && !lh_is_https()) {
            throw new LhError(400, 'https_required');
        }
        $ct = strtolower((string)($_SERVER['CONTENT_TYPE'] ?? ''));
        if (strpos($ct, 'application/json') !== 0) {
            throw new LhError(400, 'bad_request', 'Content-Type не JSON');
        }
        $body = lh_read_body();
        $nonce = lh_verify_signature($cfg['secret'], $body);
        lh_claim_nonce($cfg['data_dir'], $nonce);
        [$to, $code, $ttl] = lh_parse_payload($body);
        lh_rate_limit($cfg['data_dir'], $to, $cfg);
        try {
            lh_deliver($cfg, $to, $code, $ttl);
        } catch (Throwable $e) {
            lh_log('отправка на ' . lh_mask_email($to) . ' не удалась: ' . $e->getMessage());
            throw new LhError(502, 'send_failed');
        }
        lh_log('отправлено на ' . lh_mask_email($to));
        lh_respond(200, ['ok' => true]);
    } catch (LhError $e) {
        if ($e->status >= 500 || $e->status === 401 || $e->status === 429) {
            lh_log('отказ ' . $e->status . ' ' . $e->errCode . ': ' . $e->getMessage());
        }
        lh_respond($e->status, ['ok' => false, 'code' => $e->errCode]);
    } catch (Throwable $e) {
        lh_log('внутренняя ошибка: ' . get_class($e) . ': ' . $e->getMessage());
        lh_respond(500, ['ok' => false, 'code' => 'internal']);
    }
}

if (PHP_SAPI !== 'cli' || getenv('LH_MAIL_FORCE_RUN') === '1') {
    lh_main();
}
