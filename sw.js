// 蓋調査マップ 端末版：電波がなくてもページと保存した地図を開けるようにする
const VER = 'futa-app-v19';
const TILES = 'futa-tiles';
const ASSETS = ['./', './index.html', './device.js', './config.js', './leaflet.js', './leaflet.css', './manifest.json',
  './icon-192.png', './icon-512.png', './images/layers.png', './images/layers-2x.png',
  './images/marker-icon.png', './images/marker-icon-2x.png', './images/marker-shadow.png'];
const TILE_HOST = /(^|\.)cyberjapandata\.gsi\.go\.jp$|(^|\.)tile\.openstreetmap\.org$/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VER).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VER && k !== TILES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // ドライブへの送信（POST）はそのまま
  const u = new URL(req.url);
  if (TILE_HOST.test(u.hostname)) {                       // 地図：保存済みなら端末から、なければ取りに行って保存
    e.respondWith(caches.open(TILES).then(c => c.match(req.url).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') c.put(req.url, res.clone());
      return res;
    }).catch(() => new Response('', { status: 504 })))));
    return;
  }
  if (u.origin === self.location.origin) {                // ページ本体：電波があれば最新、なければ保存分
    const net = new Promise((ok, ng) => { setTimeout(() => ng(new Error('timeout')), 4000); fetch(req).then(ok, ng); });   // 電波が弱いときは4秒で保存分に切替
    e.respondWith(net.then(res => {
      if (res.ok) { const cp = res.clone(); caches.open(VER).then(c => c.put(req, cp)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
  }
});
