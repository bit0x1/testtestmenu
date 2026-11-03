/* ═══════════════════════════════════════════════════════════════
   سرویس‌ورکر اختیاری — کافه موزه رشت
   کارش: کش کردن صفحه و قیمت‌ها تا منو «بدون اینترنت» هم باز شود.
   نکته: این فایل اختیاری است. اگر کنار index.html نباشد، صفحه
   بدون آن هم کامل کار می‌کند (فقط کش مرورگر نداریم).
   ═══════════════════════════════════════════════════════════════ */
const V = 'muzeh-v3';            // هر بار که منطق عوض شد این را عوض کنید تا کش‌های قدیمی پاک شوند

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* مسیرهایی که «دادهٔ قیمت» هستند: همیشه اول شبکه، فقط در قطعی اینترنت از کش.
   اگر اینجا کش-اول باشد، قیمت تازه به گوشی مشتری نمی‌رسد! */
const DATA_RE = /(menu-data\.csv|prices\.json|api\/prices)$/;

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;            // POST ذخیرهٔ قیمت‌ها دست‌نخورده به سرور می‌رود
  let u; try { u = new URL(req.url) } catch (err) { return }
  if (u.origin !== self.location.origin) return;

  const isNav = req.mode === 'navigate';
  const isData = DATA_RE.test(u.pathname);

  e.respondWith((async () => {
    const cache = await caches.open(V);

    /* قیمت‌ها: اول شبکه (تا تغییر قیمت فوراً برسد)، در قطعی از کش */
    if (isData) {
      try {
        const r = await fetch(req, { cache: 'no-store' });
        if (r.ok) cache.put(req, r.clone());
        return r;
      } catch (err) {
        const m = await cache.match(req) || await cache.match('./prices.json');
        if (m) return m;
        return new Response('{"_offline":1}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }

    /* خودِ صفحه: اول شبکه، در قطعی از کش */
    if (isNav) {
      try { const r = await fetch(req); if (r.ok) cache.put(req, r.clone()); return r }
      catch (err) {
        const m = (await cache.match(req)) || (await cache.match('./index.html')) ||
                  (await cache.match('./menu.html')) || (await cache.match('./'));
        if (m) return m;
        throw err;
      }
    }

    /* بقیهٔ فایل‌های هم‌دامنه (آیکون، مانیفست و…) */
    const hit = await cache.match(req);
    if (hit) return hit;
    try { const r = await fetch(req); if (r.ok) cache.put(req, r.clone()); return r }
    catch (err) { return hit || Response.error() }
  })());
});
