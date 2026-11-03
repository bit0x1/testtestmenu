/**
 * Cloudflare Pages Function — /api/prices
 * =======================================
 * اگر منو را روی Cloudflare Pages (یا هر هاست استاتیک ابری) گذاشته‌اید، این فایل
 * جای prices.json را می‌گیرد: ویرایشگر قیمت با دکمهٔ «ذخیره» همین‌جا می‌نویسد و
 * منوی مشتری از همین‌جا می‌خواند. هیچ سرور مجازی لازم نیست.
 *
 * نصب (۵ دقیقه):
 *   ۱) پوشهٔ functions را کنار بقیهٔ فایل‌های سایت در پروژهٔ Pages بگذارید:
 *        functions/api/prices.js
 *      (Cloudflare به‌طور خودکار آن را به مسیر /api/prices نگاشت می‌کند)
 *   ۲) یک KV بسازید:  Workers & Pages → KV → Create  (نام: muzeh)
 *      سپس در تنظیمات پروژهٔ Pages → Functions → KV namespace bindings
 *      یک binding با نام  MUZEH_KV  به آن KV اضافه کنید.
 *   ۳) رمز مدیر: در Pages → Settings → Environment variables یک متغیر
 *        MUZEH_TOKEN_SHA256 = خروجی دستور  php -r "echo hash('sha256','رمز');"
 *      (یا هر ابزار sha256 دیگری) بسازید. همان رمزی که در ویرایشگر وارد می‌کنید.
 *
 * نکته: index.html اول به /api/prices نگاه می‌کند و اگر نبود به prices.json می‌رسد؛
 * پس روی هاست cPanel (که save-prices.php دارد) این فایل لازم نیست.
 */

const KEY = 'prices.json';
const BAK = 'prices.json.bak';
const MAX_BYTES = 512000;
const KEEP_META = ['_pick', '_note', '_راهنما'];

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status, extra) {
  const h = new Headers(extra || {});
  h.set('Content-Type', 'application/json; charset=utf-8');
  h.set('Cache-Control', 'no-store, max-age=0');
  return new Response(JSON.stringify(data), { status: status || 200, headers: h });
}

function clean(obj) {
  const out = {}; let n = 0;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { out, n: 0 };
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof k !== 'string' || !k || k.length > 200) continue;
    if (k[0] === '_') { if (KEEP_META.indexOf(k) >= 0 && typeof v === 'string' && v.length < 500) out[k] = v; continue; }
    if (v === 'soldout') { out[k] = 'soldout'; n++; continue; }
    if (typeof v === 'number' && isFinite(v) && v >= 0 && v <= 200000) { out[k] = Math.round(v * 100) / 100; n++; continue; }
    if (Array.isArray(v) && v.length && v.length <= 6) {
      const arr = [];
      for (const pair of v) {
        if (Array.isArray(pair) && pair.length === 2 && typeof pair[1] === 'number' &&
            pair[1] >= 0 && pair[1] <= 200000) arr.push([String(pair[0]).slice(0, 40), Math.round(pair[1] * 100) / 100]);
      }
      if (arr.length) { out[k] = arr; n++; }
      continue;
    }
  }
  return { out, n };
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const kv = env.MUZEH_KV;
  const method = request.method;

  // CORS برای همان دامنه (و برای درخواست‌های بدون Origin مثل curl)
  const origin = request.headers.get('Origin');
  const cors = {};
  if (origin) { cors['Access-Control-Allow-Origin'] = origin; cors['Access-Control-Allow-Credentials'] = 'true'; }
  cors['Access-Control-Allow-Headers'] = 'Content-Type, X-Editor-Token, Authorization';
  cors['Access-Control-Allow-Methods'] = 'GET, POST, PUT, OPTIONS';
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if (!kv) return json({ ok: false, error: 'KV binding MUZEH_KV is not set' }, 500, cors);

  // ── خواندن: عمومی (منوی مشتری باید بدون رمز قیمت ببیند) ──
  if (method === 'GET') {
    const v = await kv.get(KEY);
    if (v === null) return json({ ok: false, error: 'not saved yet' }, 404, cors);
    const h = new Headers(cors); h.set('Content-Type', 'application/json; charset=utf-8');
    h.set('Cache-Control', 'no-store, max-age=0'); h.set('X-Allow-Save', '1');
    return new Response(v, { status: 200, headers: h });
  }

  if (method !== 'POST' && method !== 'PUT') return json({ ok: false, error: 'method not allowed' }, 405, cors);

  // ── نوشتن: فقط با رمز مدیر ──
  const want = env.MUZEH_TOKEN_SHA256 || '';
  let token = request.headers.get('X-Editor-Token') || '';
  if (!token) {
    const auth = request.headers.get('Authorization') || '';
    token = auth.replace(/^Bearer\s+/i, '').trim();
  }
  if (!want) return json({ ok: false, err: 'setup', msg: 'MUZEH_TOKEN_SHA256 در تنظیمات Pages ست نشده' }, 500, cors);

  // ضد حدسِ رمز: ۱۰ تلاش غلط = ۵ دقیقه قفل (شمارنده در KV با انقضا)
  const LOCK_SECONDS = 300, MAX_FAILS = 10;
  const raw = await kv.get('lockfail');
  let fn = 0, ft = 0;
  if (raw) { try { const j = JSON.parse(raw); fn = j.n | 0; ft = j.t | 0; } catch (e) {} }
  const now = Math.floor(Date.now() / 1000);
  if (now - ft > LOCK_SECONDS) fn = 0;
  if (fn >= MAX_FAILS) {
    return json({ ok: false, err: 'lock',
      msg: 'رمز غلط زیاد تکرار شد؛ نوشتن تا ' + Math.max(1, Math.floor((LOCK_SECONDS - (now - ft)) / 60)) + ' دقیقهٔ دیگر قفل است' }, 429, cors);
  }
  const good = (await sha256hex(token)) === want;
  if (!good) {
    await kv.put('lockfail', JSON.stringify({ n: fn + 1, t: now }), { expirationTtl: LOCK_SECONDS });
    return json({ ok: false, err: 'token', msg: 'رمز مدیر اشتباه است' }, 401, cors);
  }
  if (fn > 0) await kv.delete('lockfail');

  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'body must be JSON' }, 400, cors); }
  if (body && body._check) return json({ ok: true, check: true }, 200, cors);

  const { out, n } = clean(body);
  if (!n) return json({ ok: false, error: 'no valid prices to save' }, 400, cors);
  const text = JSON.stringify(out, null, 2);
  if (text.length > MAX_BYTES) return json({ ok: false, error: 'too large' }, 413, cors);

  const prev = await kv.get(KEY);
  if (prev !== null) await kv.put(BAK, prev);           // پشتیبان نسخهٔ قبلی
  await kv.put(KEY, text);
  return json({ ok: true, items: n, at: new Date().toISOString(), via: 'cloudflare' }, 200, cors);
}
