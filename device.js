// 蓋調査マップ 端末版（iPad に保存して使う版）
// ・調査データと写真は、まずこの端末（iPad）の中に保存します（電波がなくても使えます）
// ・電波のある所で「⇅ ドライブに更新」を押すと、たまった分をまとめて Google ドライブ／スプレッドシートへ送ります
// ・地図のページから呼んでいる google.script.run を、ここで「端末の中への保存」に置き換えています
(function () {
  'use strict';

  // ---------- 端末の中の保存場所（IndexedDB） ----------
  const DBN = 'futaDevice', ST = 'kv';
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((ok, ng) => {
      const r = indexedDB.open(DBN, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(ST);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ng(r.error);
    });
    return dbp;
  }
  async function kget(k) {
    const d = await db();
    return new Promise((ok, ng) => { const q = d.transaction(ST).objectStore(ST).get(k); q.onsuccess = () => ok(q.result); q.onerror = () => ng(q.error); });
  }
  async function kset(k, v) {
    const d = await db();
    return new Promise((ok, ng) => { const t = d.transaction(ST, 'readwrite'); t.objectStore(ST).put(v, k); t.oncomplete = () => ok(); t.onerror = () => ng(t.error); });
  }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}

  // data: サーバーの getMapData と同じ形（端末での入力を反映済み）
  // queue: まだドライブに送っていない操作（登録・一時保存・未調査に戻す）。写真もここに入る
  // tmap: 端末で新規登録した仮番号 → 採番されたリンクキー
  const S = { data: null, queue: [], seq: 0, tmap: {}, ready: null, syncing: false };
  S.ready = (async () => {
    try {
      S.data = (await kget('data')) || null;
      S.queue = (await kget('queue')) || [];
      S.seq = (await kget('seq')) || 0;
      S.tmap = (await kget('tmap')) || {};
    } catch (e) { alert('この端末に保存できません（プライベートブラウズでは使えません）：' + e.message); }
  })();
  async function saveAll() {
    await kset('data', S.data); await kset('queue', S.queue); await kset('seq', S.seq); await kset('tmap', S.tmap);
    badge();
  }

  // ---------- Google（スプレッドシート側のウェブアプリ）への通信 ----------
  async function api(fn, args) {
    if (!window.API_URL || API_URL.indexOf('https://script.google.com/') !== 0) throw new Error('config.js に Google のウェブアプリのURLが入っていません');
    const ac = window.AbortController ? new AbortController() : null;
    const tm = setTimeout(() => ac && ac.abort(), 120000);
    try {
      const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ fn: fn, args: args || [] }), redirect: 'follow', signal: ac ? ac.signal : undefined });
      const txt = await res.text();
      let j;
      try { j = JSON.parse(txt); } catch (e) { throw new Error('Googleから正しい返事がありません（ウェブアプリのURL・デプロイの「アクセス：全員」を確認）'); }
      if (!j.ok) throw new Error(j.error);
      return j.r;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('通信がタイムアウトしました（電波の良い所でもう一度）');
      if (e instanceof TypeError) throw new Error('通信できません（電波を確認してください）');
      throw e;
    } finally { clearTimeout(tm); }
  }

  const ptOf = ms => (S.data && S.data.pts || []).find(p => String(p[0]) === String(ms));
  const nowIso = () => new Date().toISOString();
  const copy = o => JSON.parse(JSON.stringify(o));

  // ---------- google.script.run の代わり（端末の中で処理） ----------
  const LOCAL = {
    async login(id, pw) { return api('login', [id, pw]); },
    async logout(token) { try { await api('logout', [token]); } catch (e) {} return true; },

    async getMapData(token) {
      await S.ready;
      if (S.data) return JSON.stringify(S.data);
      // まだ端末にデータがない → 電波があればドライブから取り込む
      if (navigator.onLine === false) throw new Error('この端末にまだ人孔データがありません。電波のある所で開いてください');
      const r = await api('getMapData', [token]);
      S.data = JSON.parse(r);
      S.data.pts.forEach(p => { p[0] = String(p[0]); });
      await saveAll();
      return r;
    },

    async saveSurvey(d) {
      await S.ready;
      if (!S.data) throw new Error('端末に人孔データがありません');
      const id = ++S.seq;
      const op = { id: id, fn: 'saveSurvey', at: nowIso(), d: copy(d) };
      delete op.d.token;
      op.d.surveyedAt = op.at;                          // 実際に調査した日時（あとで更新してもこの日で登録）
      let ms = String(d.mslink || '');
      let p;
      if (d.isNew && !ms) {                             // 端末で新規登録 → 仮番号（更新時に正式なリンクキーになる）
        ms = '仮' + id; op.tmp = ms;
        p = [ms, '', d.newLat, d.newLon, '', '新規', {}, '', '', '', {}, null, {}, {}];
        S.data.pts.push(p);
      } else {
        p = ptOf(ms);
        if (!p) throw new Error('リンクキー ' + ms + ' が端末のデータにありません');
      }
      const ids = Object.assign({}, p[12] || {});
      ['fukei', 'futa'].forEach(k => { if (d[k]) ids[k] = 'L:' + id + ':' + k; });
      if (d.temp) {
        p[4] = '一時保存'; p[11] = d.draft || {};
      } else {
        const sv = Object.assign({}, d.sv || {});
        sv._date = ''; sv._worker = d.chosain || '';
        sv._lat = d.pos ? String(d.pos.lat) : ((p[13] || {})._lat || '');
        sv._lon = d.pos ? String(d.pos.lon) : ((p[13] || {})._lon || '');
        if (d.isNew || p[5] === '新規') { sv._lat = ''; sv._lon = ''; }
        p[4] = d.status || ''; p[11] = null; p[13] = sv;
      }
      p[12] = ids; p[14] = 1;                          // 14：端末で変更あり（未送信）
      S.queue.push(op);
      await saveAll();
      return { ok: true, mslink: ms, isNew: !!op.tmp, status: p[4], draft: p[11], ids: ids, sv: p[13] };
    },

    async resetSurvey(ms, token) {
      await S.ready;
      const p = ptOf(ms);
      S.queue.push({ id: ++S.seq, fn: 'resetSurvey', at: nowIso(), ms: String(ms) });
      if (p) { p[4] = ''; p[11] = null; p[12] = {}; p[13] = {}; p[14] = 1; }
      await saveAll();
      return { ok: true };
    },

    // 写真：端末で撮ったもの（L:…）は端末から、ドライブのものは電波があれば取り寄せる
    async getPhotos(ids, token) {
      await S.ready;
      const out = {}, remote = {};
      Object.keys(ids || {}).forEach(k => {
        const v = String(ids[k] || '');
        const m = v.match(/^L:(\d+):(\w+)$/);
        if (m) { const op = S.queue.find(o => o.id === Number(m[1])); if (op && op.d && op.d[m[2]]) out[k] = op.d[m[2]]; }
        else if (v) remote[k] = v;
      });
      if (Object.keys(remote).length && navigator.onLine !== false) {
        try { Object.assign(out, await api('getPhotos', [remote, token])); } catch (e) {}
      }
      return out;
    },
  };

  function runner() {
    let ok = () => {}, ng = () => {};
    const r = new Proxy({}, {
      get(_, name) {
        if (name === 'withSuccessHandler') return f => { ok = f; return r; };
        if (name === 'withFailureHandler') return f => { ng = f; return r; };
        if (name === 'withUserObject') return () => r;
        return function () {
          const args = arguments;
          Promise.resolve().then(() => {
            if (!LOCAL[name]) throw new Error('端末版では使えません：' + String(name));
            return LOCAL[name].apply(null, args);
          }).then(v => ok(v), e => ng(e instanceof Error ? e : new Error(String(e))));
        };
      },
    });
    return r;
  }
  window.google = { script: {
    get run() { return runner(); },
    url: { getLocation(cb) { const prm = {}; new URLSearchParams(location.search).forEach((v, k) => { prm[k] = v; }); cb({ parameter: prm }); } },
  } };

  // ---------- 「ドライブに更新」 ----------
  async function sync() {
    if (S.syncing) return;
    if (typeof cur !== 'undefined' && cur) { msg('入力中は更新できません（登録か一時保存をしてから）', 2500); return; }
    if (navigator.onLine === false) { msg('電波がありません。電波のある所で押してください', 2500); return; }
    if (!TOKEN) { showLogin('ドライブに送るには、ログインしてください'); return; }
    await S.ready;
    S.syncing = true; badge();
    const total = S.queue.length;
    let done = 0;
    try {
      while (S.queue.length) {
        const op = S.queue[0];
        msg('ドライブに送信中… ' + (done + 1) + '／' + total + '（画面を閉じないでください）');
        if (op.fn === 'saveSurvey') {
          const d = Object.assign({}, op.d, { token: TOKEN });
          if (S.tmap[d.mslink]) d.mslink = S.tmap[d.mslink];
          if (op.tmp && S.tmap[op.tmp]) { d.isNew = false; d.mslink = S.tmap[op.tmp]; }   // 途中で止まったときの続き
          if (/^仮/.test(String(d.mslink))) throw new Error('仮番号 ' + d.mslink + ' の正式なリンクキーが分かりません');
          const r = await api('saveSurvey', [d]);
          if (op.tmp) S.tmap[op.tmp] = String(r.mslink);
        } else if (op.fn === 'resetSurvey') {
          const ms = S.tmap[op.ms] || op.ms;
          if (!/^仮/.test(ms)) await api('resetSurvey', [ms, TOKEN]);
        }
        S.queue.shift(); done++;
        await saveAll();
      }
      msg('最新の状況をドライブから取り込み中…');
      const r = await api('getMapData', [TOKEN]);
      S.data = JSON.parse(r);
      S.data.pts.forEach(p => { p[0] = String(p[0]); });
      S.tmap = {};
      await saveAll();
      S.syncing = false; badge();
      load();
      setTimeout(() => msg(done ? 'ドライブに更新しました（' + done + '件）' : '最新の状況を取り込みました', 3000), 400);
    } catch (e) {
      S.syncing = false; badge();
      const m = String(e.message || e);
      if (m.indexOf('LOGIN_REQUIRED') >= 0) {
        TOKEN = ''; try { localStorage.removeItem('futaToken'); } catch (x) {}
        msg('', 1);
        showLogin('ログインの期限が切れました。ログイン後にもう一度「ドライブに更新」を押してください');
        return;
      }
      msg('途中で止まりました（' + done + '／' + total + '件 送信済み。残りは端末に残っています）：' + m, 6000);
    }
  }

  // ---------- 地図（背景）を端末に保存 ----------
  function tileList(tmpl, b, z0, z1) {
    const out = [];
    for (let z = z0; z <= z1; z++) {
      const n = Math.pow(2, z);
      const x0 = Math.floor((b.getWest() + 180) / 360 * n), x1 = Math.floor((b.getEast() + 180) / 360 * n);
      const ty = lat => Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);
      const y0 = ty(b.getNorth()), y1 = ty(b.getSouth());
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(tmpl.replace('{z}', z).replace('{x}', x).replace('{y}', y));
    }
    return out;
  }
  async function saveTiles() {
    if (navigator.onLine === false) { msg('電波がありません', 2000); return; }
    if (!window.caches) { msg('この端末では地図を保存できません', 2500); return; }
    let lyr = null;
    map.eachLayer(l => { if (l._url && /cyberjapandata/.test(l._url)) lyr = l; });
    if (!lyr) {
      if (!confirm('地図を保存できるのは「地理院」の地図です。\n「地理院 淡色地図」に切り替えて保存しますか？')) return;
      map.eachLayer(l => { if (l._url && /openstreetmap/.test(l._url)) map.removeLayer(l); });
      base['地理院 淡色地図'].addTo(map); lyr = base['地理院 淡色地図'];
    }
    const z = map.getZoom();
    if (z < 13) { msg('もう少し拡大して（調査する範囲を画面に出して）から押してください', 3000); return; }
    const urls = tileList(lyr._url.replace('{s}', 'a'), map.getBounds().pad(0.1), Math.max(13, z - 2), 18);
    const mb = Math.round(urls.length * (/seamlessphoto/.test(lyr._url) ? 0.035 : 0.012));
    if (urls.length > 6000) { msg('範囲が広すぎます（' + urls.length + '枚）。もう少し拡大してから押してください', 3500); return; }
    if (!confirm('今の画面の範囲の地図（' + urls.length + '枚・約' + mb + 'MB）をこの端末に保存します。\nWi-Fiなど電波の良い所で行ってください。よろしいですか？')) return;
    const c = await caches.open('futa-tiles');
    let i = 0, ok = 0;
    async function worker() {
      while (i < urls.length) {
        const u = urls[i++];
        try {
          if (await c.match(u)) { ok++; continue; }
          let res;
          try { res = await fetch(u, { mode: 'cors' }); } catch (e) { res = await fetch(u, { mode: 'no-cors' }); }
          if (res.ok || res.type === 'opaque') { await c.put(u, res); ok++; }
        } catch (e) {}
        if (i % 25 === 0) msg('地図を保存中… ' + i + '／' + urls.length);
      }
    }
    await Promise.all([1, 2, 3, 4, 5, 6].map(worker));
    msg('地図を保存しました（' + ok + '／' + urls.length + '枚）。電波がなくてもこの範囲は表示されます', 3500);
  }

  // ---------- 画面に「端末版」の操作ボタンを追加 ----------
  function badge() {
    const b = document.getElementById('dvBox'); if (!b) return;
    const n = S.queue.length;
    document.getElementById('dvCount').textContent = S.syncing ? '送信中…' : (n ? '未送信 ' + n + '件' : '未送信なし');
    document.getElementById('dvCount').style.color = n ? '#b45309' : '#2e7d32';
    document.getElementById('dvNet').textContent = navigator.onLine === false ? '圏外' : '電波あり';
    document.getElementById('dvNet').style.background = navigator.onLine === false ? '#9e9e9e' : '#1e88e5';
  }
  function addUi() {
    const css = document.createElement('style');
    css.textContent =
      '#dvBox{position:absolute;bottom:80px;right:10px;max-width:46vw;z-index:1000;background:rgba(255,255,255,.95);padding:8px 10px;border-radius:8px;' +
      'box-shadow:0 1px 4px rgba(0,0,0,.3);font-size:13px;text-align:right;line-height:1.5}' +
      '#dvBox button{display:block;width:100%;margin-top:6px;padding:9px 10px;border:0;border-radius:6px;font-size:14px}' +
      '#dvSync{background:#e65100;color:#fff;font-weight:bold}#dvTiles{background:#eceff1;color:#1f4e78}' +
      '#dvNet{display:inline-block;color:#fff;border-radius:4px;padding:0 6px;margin-right:6px;font-size:12px}' +
      '@media (min-width:700px){#dvBox{bottom:auto;top:74px;max-width:none;font-size:14px}#dvBox button{font-size:15px}}';
    document.head.appendChild(css);
    const box = document.createElement('div');
    box.id = 'dvBox';
    box.innerHTML = '<div><b style="color:#e65100">端末版</b>　<span id="dvNet"></span><span id="dvCount"></span></div>' +
      '<button id="dvSync" type="button">⇅ ドライブに更新</button>' +
      '<button id="dvTiles" type="button">🗺 この範囲の地図を保存</button>';
    document.body.appendChild(box);
    document.getElementById('dvSync').onclick = sync;
    document.getElementById('dvTiles').onclick = saveTiles;
    window.addEventListener('online', badge); window.addEventListener('offline', badge);
    S.ready.then(badge);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addUi); else addUi();

  // ---------- オフラインでも開けるようにする ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }
  window.futaDevice = { sync: sync, saveTiles: saveTiles, S: S };
})();
