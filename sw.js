// เก็บไฟล์หน้าแอพไว้ในเครื่อง เพื่อให้เปิดได้แม้สัญญาณอ่อน/ไม่มีเน็ต
// ใช้แบบ "ดึงจากเน็ตก่อน ถ้าไม่ได้ค่อยใช้ของในเครื่อง" → อัปเดตไฟล์บนเว็บแล้วมือถือได้ของใหม่ทันที
const CACHE = 'voice-feedback-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // ไม่ยุ่งกับการส่งข้อมูลไป Google

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))
      )
  );
});
