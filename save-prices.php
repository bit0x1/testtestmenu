<?php
/**
 * save-prices.php — ذخیرهٔ قیمت‌ها روی وب‌هاست (cPanel / DirectAdmin / هر هاست PHP)
 * ================================================================================
 * این همان چیزی است که «کپی دستی فایل» را حذف می‌کند:
 *   در price-editor.html دکمهٔ «ذخیره» را می‌زنید → قیمت‌ها مستقیم همین‌جا
 *   در فایل prices.json نوشته می‌شود → مشتری‌ها با رفرش منو، قیمت تازه را می‌بینند.
 *
 * نصب (۳ قدم):
 *   ۱) همین فایل را کنار index.html و price-editor.html آپلود کنید (همان پوشهٔ public_html).
 *   ۲) رمز را عوض کنید: در ترمینال/SSH یا در یک فایل PHP موقت اجرا کنید
 *          php -r "echo hash('sha256','رمز-جدید-خودتان');"
 *      و خروجی را به‌جای مقدار $PASSWORD_HASH بگذارید. رمز همان رمزی است که
 *      در صفحهٔ ویرایشگر وارد می‌کنید (LOCAL_PIN در price-editor.html هم همان باشد).
 *   ۳) مطمئن شوید پوشه قابل نوشتن است (معمولاً هست؛ در غیر این صورت در cPanel
 *      روی پوشه Permissions = 755 و مالک = کاربر هاست).
 *
 * نکتهٔ امنیتی: این فایل فقط با رمز درست می‌نویسد، ولی «خواندن» منو برای همه آزاد است
 * (منو که باید عمومی باشد!). اگر می‌خواهید خودِ price-editor.html هم از بیرون باز نشود،
 * در cPanel → Directory Privacy روی پوشه رمز بگذارید یا از .htaccess نمونه استفاده کنید.
 */

// ── تنظیمات ────────────────────────────────────────────────────────────────
$PASSWORD_HASH = '9585d5ef40999b9cac5fd5676520a277efebd439388ebed45cdbabcb398108d4'; // رمز پیش‌فرض: muzeh1397
$PRICES_FILE   = __DIR__ . '/prices.json';
$BACKUP_FILE   = __DIR__ . '/prices.json.bak';
$LIMIT_FILE    = __DIR__ . '/.save-limit';
$MAX_BYTES     = 512000;      // سقف اندازهٔ prices.json
$MIN_INTERVAL  = 2;           // حداقل فاصلهٔ دو ذخیره (ثانیه) — ضد اسپم
$KEEP_META     = array('_pick', '_note', '_راهنما');

// ── سرصفحه‌ها ──────────────────────────────────────────────────────────────
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');

// ── CORS: اجازه می‌دهد صفحهٔ ویرایشگر از گوشی/لپ‌تاپ مدیر (یا هر دامنهٔ دیگری)
//    به این نقطه بنویسد. امنیت با رمز است، نه با Origin — پس باز بودن CORS خطرناک نیست.
$origin = isset($_SERVER['HTTP_ORIGIN']) ? $_SERVER['HTTP_ORIGIN'] : '';
if ($origin !== '') {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Headers: Content-Type, X-Editor-Token, Authorization');
    header('Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS');
    header('Access-Control-Max-Age: 600');
    header('Vary: Origin');
}

$method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';
if ($method === 'OPTIONS') { http_response_code(204); exit; }

function out($code, $arr) {
    http_response_code($code);
    echo json_encode($arr, JSON_UNESCAPED_UNICODE);
    exit;
}

// ── رمز ────────────────────────────────────────────────────────────────────
$token = '';
if (isset($_SERVER['HTTP_X_EDITOR_TOKEN'])) $token = $_SERVER['HTTP_X_EDITOR_TOKEN'];
elseif (!empty($_SERVER['HTTP_AUTHORIZATION'])) {
    $token = trim(str_ireplace('Bearer', '', $_SERVER['HTTP_AUTHORIZATION']));
}
// ── ضد حدسِ رمز: ۱۰ رمز غلط پشت‌سرهم = ۵ دقیقه قفل شدنِ کاملِ نوشتن ──────────
// قفل «قبل از» مقایسهٔ رمز بررسی می‌شود تا واقعاً حمله را کند کند، نه فقط پیامش را عوض کند.
$FAIL_FILE = __DIR__ . '/.save-fails';
$LOCK_SECONDS = 300; $MAX_FAILS = 10;
$fn = 0; $ft = 0;
if (is_file($FAIL_FILE)) { $fj = json_decode((string)@file_get_contents($FAIL_FILE), true);
    if (is_array($fj)) { $fn = (int)$fj['n']; $ft = (int)$fj['t']; } }
if (time() - $ft > $LOCK_SECONDS) { $fn = 0; }
if ($fn >= $MAX_FAILS) {
    out(429, array('ok' => false, 'err' => 'lock',
        'msg' => 'رمز غلط زیاد تکرار شد؛ نوشتن تا ' . max(1, (int)(($LOCK_SECONDS - (time() - $ft)) / 60)) . ' دقیقهٔ دیگر قفل است'));
}
if (function_exists('hash_equals')) {
    $ok = hash_equals($PASSWORD_HASH, hash('sha256', (string)$token));
} else {
    $ok = (hash('sha256', (string)$token) === $PASSWORD_HASH);
}
if (!$ok) {
    $fn++; @file_put_contents($FAIL_FILE, json_encode(array('n' => $fn, 't' => time())));
    out(401, array('ok' => false, 'err' => 'token', 'msg' => 'رمز مدیر اشتباه است'));
}
if ($fn > 0) @unlink($FAIL_FILE);   // رمز درست خورد → شمارنده صفر

// ── GET: برگرداندن قیمت‌های فعلی (بدون بدنهٔ درخواست) ───────────────────────
if ($method === 'GET') {
    if (is_file($PRICES_FILE)) {
        $cur = json_decode(file_get_contents($PRICES_FILE), true);
        if (is_array($cur)) out(200, $cur);
    }
    out(404, array('ok' => false, 'error' => 'prices.json not found yet'));
}

$body = file_get_contents('php://input');
$data = json_decode($body, true);
if (!is_array($data)) out(400, array('ok' => false, 'error' => 'body must be a JSON object'));

// فقط بررسی رمز (از صفحهٔ ورود ویرایشگر) — چیزی نوشته نمی‌شود
if (isset($data['_check'])) {
    $warn = ($PASSWORD_HASH === '9585d5ef40999b9cac5fd5676520a277efebd439388ebed45cdbabcb398108d4')
        ? 'رمز هنوز پیش‌فرض است؛ عوضش کنید' : '';
    out(200, array('ok' => true, 'check' => true, 'warn' => $warn));
}

if ($method !== 'POST' && $method !== 'PUT') out(405, array('ok' => false, 'error' => 'method not allowed'));

// ── ضد اسپم ────────────────────────────────────────────────────────────────
if (is_file($LIMIT_FILE) && (time() - (int)@file_get_contents($LIMIT_FILE)) < $MIN_INTERVAL) {
    out(429, array('ok' => false, 'error' => 'too fast', 'msg' => 'کمی صبر کنید و دوباره ذخیره را بزنید'));
}

// ── اعتبارسنجی و تمیزکردن ──────────────────────────────────────────────────
$clean = array(); $n = 0;
foreach ($data as $k => $v) {
    if (!is_string($k) || $k === '' || strlen($k) > 200) continue;
    if (substr($k, 0, 1) === '_') {
        if (in_array($k, $KEEP_META, true) && is_string($v) && strlen($v) < 500) $clean[$k] = $v;
        continue;
    }
    if ($v === 'soldout') { $clean[$k] = 'soldout'; $n++; continue; }
    if (is_int($v) || is_float($v)) {
        $v = round((float)$v, 2);
        if ($v >= 0 && $v <= 200000) { $clean[$k] = $v; $n++; }
        continue;
    }
    if (is_array($v) && count($v) > 0 && count($v) <= 6) {
        $arr = array();
        foreach ($v as $pair) {
            if (is_array($pair) && count($pair) === 2 && (is_int($pair[1]) || is_float($pair[1]))) {
                $p = round((float)$pair[1], 2);
                if ($p >= 0 && $p <= 200000) $arr[] = array(substr((string)$pair[0], 0, 40), $p);
            }
        }
        if ($arr) { $clean[$k] = $arr; $n++; }
        continue;
    }
}
if ($n === 0) out(400, array('ok' => false, 'error' => 'no valid prices to save'));

$json = json_encode($clean, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
if ($json === false) out(500, array('ok' => false, 'error' => 'encode failed'));
if (strlen($json) > $MAX_BYTES) out(413, array('ok' => false, 'error' => 'prices.json too large'));

// ── نوشتن اتمیک + پشتیبان ──────────────────────────────────────────────────
if (is_file($PRICES_FILE)) @copy($PRICES_FILE, $BACKUP_FILE);
$tmp = $PRICES_FILE . '.tmp';
$fh = @fopen($tmp, 'w');
if (!$fh) {
    out(500, array('ok' => false, 'error' => 'cannot write',
        'msg' => 'پوشه قابل نوشتن نیست — در cPanel روی پوشه: Permissions = 755 و مالک = کاربر هاست'));
}
fwrite($fh, $json . "\n");
fflush($fh);
if (function_exists('fsync')) @fsync($fh);
fclose($fh);
if (!@rename($tmp, $PRICES_FILE)) {
    @unlink($tmp);
    out(500, array('ok' => false, 'error' => 'rename failed', 'msg' => 'نوشتن prices.json ناموفق بود'));
}
@chmod($PRICES_FILE, 0644);
@file_put_contents($LIMIT_FILE, (string)time());

out(200, array('ok' => true, 'items' => $n, 'at' => date('c'), 'via' => 'php'));
