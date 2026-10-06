/* Home Ledger service worker (오프라인 지원).
 *
 * 등록: js/pwa.js 가 './sw.js?v=<앱 버전>' 으로 등록합니다. 버전 문자열이 바뀌면
 *   (1) 서비스 워커 주소가 달라져 브라우저가 새 워커를 설치하고,
 *   (2) 캐시 이름이 hl-<버전> 으로 바뀌어 예전 파일과 섞이지 않습니다.
 *
 * 전략
 *   install   앱 껍데기(PRECACHE)를 내려받아 저장. 일부가 실패해도 설치는 계속하되 콘솔에 남깁니다.
 *             새 워커는 페이지가 postMessage('skip-waiting') 을 보낼 때만 바로 교체됩니다
 *             ("새 버전이 있습니다 — 새로고침" 버튼).
 *   activate  hl-* 중 현재 버전이 아닌 캐시 삭제, 열려 있는 탭 넘겨받기(clients.claim).
 *   fetch     같은 출처 GET 만 다룹니다.
 *               · 페이지 이동(navigation) → 네트워크 우선(3초), 안 되면 저장해 둔 index.html
 *               · 같은 출처 정적 파일(js/css/png/webmanifest…) → 저장본을 먼저 주고 뒤에서 갱신(stale-while-revalidate)
 *               · Google Fonts(fonts.googleapis.com / fonts.gstatic.com) → 같은 방식, 글꼴 전용 캐시
 *             그 밖의 모든 요청(sheets.googleapis.com, script.google.com, accounts.google.com,
 *             bankofcanada.ca, api.frankfurter.app, 모든 POST …)은 손대지 않고 그대로 통과시킵니다.
 *
 * 파일을 추가하면 아래 PRECACHE 에도 넣으세요. (tests: sw.test.mjs 가 빠진 파일을 잡아 줍니다)
 */
'use strict';

const VERSION = (() => {
  try { return new URL(self.location.href).searchParams.get('v') || 'dev'; } catch (e) { return 'dev'; }
})();
const CACHE_PREFIX = 'hl-';
const CACHE = CACHE_PREFIX + VERSION;
const FONT_CACHE = CACHE_PREFIX + 'fonts'; // 글꼴은 버전이 바뀌어도 유지
const NAV_TIMEOUT_MS = 3000;

// 앱 껍데기. 경로는 sw.js 기준 상대 경로.
const PRECACHE = [
  './',
  './index.html',
  './style.css',
  './charts.css',
  './lock.css',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './app.js',
  './js/activity.js',
  './js/ai.js',
  './js/auth.js',
  './js/budget.js',
  './js/categorize.js',
  './js/charts.js',
  './js/config.js',
  './js/drill.js',
  './js/fx.js',
  './js/icons.js',
  './js/importer.js',
  './js/importui.js',
  './js/layout.js',
  './js/ledger.js',
  './js/lock.js',
  './js/pwa.js',
  './js/receiptui.js',
  './js/receipts.js',
  './js/rememberui.js',
  './js/reports.js',
  './js/sheets.js',
  './js/store.js',
  './js/sync.js',
  './js/theme.js',
  './js/insights.js',
  './js/meta.js',
  './js/plan.js',
  './js/rulesui.js',
  './js/migrate.js',
  './js/settingsui.js',
  './js/summary-text.js',
  './js/summary.js',
  './js/prefs.js',
  './js/catform.js',
  './js/reorder.js',
  './js/txnform.js',
  './js/printreport.js',
  './js/bulk.js',
  './js/xfermatch.js',
  './js/scanimg.js',
  './js/models.js',
  './js/receiptview.js',
  './js/valuation.js',
  './js/wealth-forms.js',
  './js/wealth.js',
  './js/ui.js'
];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const STATIC_EXT = /\.(?:js|mjs|css|png|jpe?g|webp|svg|ico|webmanifest|woff2?)$/i;

const ORIGIN = self.location.origin;
const SCOPE_PATH = new URL('./', self.location.href).pathname; // 예: /homeledger/
const INDEX_URL = new URL('./index.html', self.location.href).href;
const ROOT_URL = new URL('./', self.location.href).href;

const log = (...a) => { try { console.log('[hl-sw ' + VERSION + ']', ...a); } catch (e) { /* ignore */ } };
const warn = (...a) => { try { console.warn('[hl-sw ' + VERSION + ']', ...a); } catch (e) { /* ignore */ } };

// ───────────────────────── install / activate / message

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

async function precache() {
  const cache = await caches.open(CACHE);
  const results = await Promise.allSettled(PRECACHE.map(async (path) => {
    const url = new URL(path, self.location.href).href;
    // cache:'reload' → 브라우저 HTTP 캐시(GitHub Pages 는 10분)를 건너뛰고 서버에서 직접 받음
    const res = await fetch(new Request(url, { cache: 'reload' }));
    if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
    await cache.put(url, res);
  }));
  const failed = [];
  results.forEach((r, i) => { if (r.status === 'rejected') failed.push(PRECACHE[i] + ' (' + (r.reason && r.reason.message || r.reason) + ')'); });
  if (failed.length) warn('precache: ' + failed.length + ' of ' + PRECACHE.length + ' failed — ' + failed.join(', '));
  else log('precached ' + PRECACHE.length + ' files');
  return failed;
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const stale = keys.filter((k) => k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE && k !== FONT_CACHE);
    await Promise.all(stale.map((k) => caches.delete(k)));
    if (stale.length) log('removed old caches: ' + stale.join(', '));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const d = event.data;
  if (d === 'skip-waiting' || (d && d.type === 'skip-waiting')) self.skipWaiting();
});

// ───────────────────────── fetch

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // POST 등은 손대지 않음
  if (req.headers && req.headers.get && req.headers.get('range')) return; // 구간 요청(동영상 등)은 통과
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  if (FONT_HOSTS.indexOf(url.hostname) >= 0) {
    event.respondWith(staleWhileRevalidate(event, req, FONT_CACHE, false));
    return;
  }
  if (url.origin !== ORIGIN) return;                      // 다른 출처는 전부 통과
  if (url.pathname.indexOf(SCOPE_PATH) !== 0) return;     // 같은 도메인의 다른 프로젝트 사이트는 건드리지 않음
  if (/\/sw\.js$/.test(url.pathname)) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(event, req, url));
    return;
  }
  if (STATIC_EXT.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, req, CACHE, true));
  }
  // 그 밖의 같은 출처 요청: 통과
});

function cacheable(res) {
  return !!res && (res.ok || res.type === 'opaque') && res.status !== 206;
}

async function staleWhileRevalidate(event, req, cacheName, revalidate) {
  const cache = await caches.open(cacheName);
  let cached = await cache.match(req);
  if (!cached && req.url.indexOf('?') >= 0) cached = await cache.match(req, { ignoreSearch: true });
  // 같은 출처 파일은 조건부 요청(no-cache)으로 새 것인지만 확인 → 변하지 않았으면 304 로 거의 공짜
  const netReq = revalidate ? new Request(req, { cache: 'no-cache' }) : req;
  const update = fetch(netReq).then((res) => {
    if (cacheable(res)) { const copy = res.clone(); return cache.put(req, copy).then(() => res, () => res); }
    return res;
  });
  if (cached) {
    event.waitUntil(update.catch(() => { /* 오프라인이면 저장본으로 충분 */ }));
    return cached;
  }
  try { return await update; } catch (e) { return Response.error(); }
}

async function networkFirstNavigation(event, req, url) {
  const cache = await caches.open(CACHE);
  const isShell = url.pathname === SCOPE_PATH || url.pathname === SCOPE_PATH + 'index.html';
  const net = fetch(req).then((res) => {
    if (res && res.ok && !res.redirected && res.type !== 'opaqueredirect' && isShell) {
      const copy = res.clone();
      return cache.put(INDEX_URL, copy).then(() => res, () => res);
    }
    return res;
  });
  net.catch(() => { /* 아래에서 처리 */ });

  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), NAV_TIMEOUT_MS); });
  let first = null;
  try { first = await Promise.race([net, timeout]); } catch (e) { first = null; }
  clearTimeout(timer);

  if (first && first.ok) return first;

  const cached = (await cache.match(INDEX_URL)) || (await cache.match(ROOT_URL));
  if (cached) {
    event.waitUntil(net.catch(() => { /* 뒤에서 계속 갱신 */ }));
    return cached;
  }
  if (first) return first;           // 저장본이 없으면 서버가 준 오류 화면이라도 보여 줌
  try { return await net; } catch (e) { return Response.error(); }
}
