// 앱 잠금 (PIN 4~6자리).
//
//  · PIN 자체는 어디에도 저장하지 않습니다. localStorage 'hl_pin' 에는 무작위 salt + PBKDF2-SHA256 해시(+ 자릿수)만 들어갑니다.
//    (WebCrypto 를 못 쓰는 환경 — http 주소 등 — 에서는 salt 를 섞은 SHA-256 반복 해시로 대신합니다.)
//  · 틀린 횟수는 'hl_pin_throttle' 에 저장되어 새로고침해도 초기화되지 않습니다. 5번 틀리면 30초, 이후 한 번 틀릴 때마다 두 배 (최대 15분).
//  · 이것은 "옆 사람이 화면을 못 보게 하는 잠금"입니다. 기기를 직접 뒤질 수 있는 사람(개발자 도구, 저장소 삭제)을 막는 암호화가 아닙니다.
//
// 화면은 lock.css 와 함께 쓰세요. (#lock 오버레이)

import { logoSvg } from './icons.js';

export const PIN_KEY = 'hl_pin';
export const THROTTLE_KEY = 'hl_pin_throttle';
export const PBKDF2_ITERATIONS = 150000;
const JS_SHA_ITERATIONS = 30000;
const FREE_TRIES = 5;
const BASE_DELAY_MS = 30000;
const MAX_DELAY_MS = 15 * 60000;

// ───────────────────────── 시계 (테스트에서 바꿀 수 있음)
let clock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (id) => clearTimeout(id)
};
/** 테스트 전용: { now, setTimeout, clearTimeout } 로 시계를 바꿉니다. 인자 없이 부르면 원래대로. */
export function __setClockForTests(c) {
  clock = c || { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id) };
}

// ───────────────────────── 저장소 (localStorage 가 막혀 있어도 죽지 않게)
const mem = {};
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); delete mem[k]; return true; } catch (e) { mem[k] = v; return false; } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } delete mem[k]; }

// ───────────────────────── 해시
const hex = (u8) => Array.from(u8, (b) => (b < 16 ? '0' : '') + b.toString(16)).join('');
function unhex(s) {
  const out = new Uint8Array(s.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}
function randomBytes(n) {
  const out = new Uint8Array(n);
  const c = globalThis.crypto;
  if (c && c.getRandomValues) c.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}
const subtle = () => (globalThis.crypto && globalThis.crypto.subtle) || null;

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
/** 순수 JS SHA-256 (WebCrypto 가 없을 때만 씁니다) */
export function sha256(msg) {
  const l = msg.length;
  const total = (((l + 9 + 63) >> 6) << 6);
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[l] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor((l * 8) / 4294967296));
  dv.setUint32(total - 4, (l * 8) >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const o = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) o.setUint32(i * 4, H[i]);
  return out;
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** alg: 'pbkdf2-sha256' | 'sha256'. 못 쓰는 환경이면 null. */
async function derive(pin, alg, iter, salt) {
  const pinBytes = new TextEncoder().encode(String(pin));
  if (alg === 'pbkdf2-sha256') {
    const s = subtle();
    if (!s) return null;
    const key = await s.importKey('raw', pinBytes, 'PBKDF2', false, ['deriveBits']);
    return hex(new Uint8Array(await s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256)));
  }
  if (alg === 'sha256') {
    let h = sha256(concat(salt, pinBytes));
    for (let i = 0; i < iter; i++) h = sha256(concat(h, salt, pinBytes));
    return hex(h);
  }
  return null;
}
function sameHex(a, b) {          // 길이가 같으면 끝까지 비교 (일찍 끝내지 않음)
  let d = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

// ───────────────────────── PIN 기록
function readRecord() {
  const raw = lsGet(PIN_KEY);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw);
    if (r && typeof r.hash === 'string' && typeof r.salt === 'string' && typeof r.alg === 'string' && r.iter > 0) return r;
  } catch (e) { /* 망가진 기록은 없는 것으로 */ }
  return null;
}
const PIN_RE = /^\d{4,6}$/;

/** PIN 이 설정돼 있는가 */
export function hasPin() { return !!readRecord(); }

/** PIN 설정(또는 교체). 4~6자리 숫자 "문자열"이어야 합니다 (숫자형은 앞의 0이 사라지므로 거부). */
export async function setPin(pin) {
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) throw new Error('PIN must be 4–6 digits (암호는 숫자 4~6자리)');
  const salt = randomBytes(16);
  let alg = 'pbkdf2-sha256';
  let iter = PBKDF2_ITERATIONS;
  if (!subtle()) { alg = 'sha256'; iter = JS_SHA_ITERATIONS; }
  const hash = await derive(pin, alg, iter, salt);
  const rec = { v: 1, alg, iter, len: pin.length, salt: hex(salt), hash };
  if (!lsSet(PIN_KEY, JSON.stringify(rec))) throw new Error('Cannot save PIN: storage unavailable (저장소를 쓸 수 없습니다)');
  lsDel(THROTTLE_KEY);
  if (S.inited) { S.lastActive = clock.now(); armIdle(); }
}

/** PIN 이 맞는가 (횟수 제한 없음 — 화면에서는 tryPin 을 쓰세요) */
export async function verify(pin) {
  const rec = readRecord();
  // PIN 이 없거나 형식이 틀려도 같은 양의 계산을 한 뒤 false 를 돌려줍니다 (걸리는 시간으로 알아내지 못하게)
  const salt = rec ? unhex(rec.salt) : randomBytes(16);
  const alg = rec ? rec.alg : (subtle() ? 'pbkdf2-sha256' : 'sha256');
  const iter = rec ? rec.iter : (alg === 'sha256' ? JS_SHA_ITERATIONS : PBKDF2_ITERATIONS);
  let got = null;
  try { got = await derive(typeof pin === 'string' ? pin : '', alg, iter, salt); } catch (e) { got = null; }
  if (!rec || got === null || typeof pin !== 'string' || !PIN_RE.test(pin)) return false;
  return sameHex(got, rec.hash);
}

// ───────────────────────── 틀린 횟수 제한
/** n 번째로 틀렸을 때 기다려야 하는 시간(ms). 5번까지는 0, 5번째 30초, 6번째 60초, … 최대 15분 */
export function delayFor(fails) {
  if (!(fails >= FREE_TRIES)) return 0;
  return Math.min(BASE_DELAY_MS * Math.pow(2, fails - FREE_TRIES), MAX_DELAY_MS);
}
function readThrottle() {
  try {
    const t = JSON.parse(lsGet(THROTTLE_KEY) || 'null');
    if (t && t.fails >= 0 && t.until >= 0) return { fails: t.fails | 0, until: +t.until };
  } catch (e) { /* ignore */ }
  return { fails: 0, until: 0 };
}
const writeThrottle = (t) => lsSet(THROTTLE_KEY, JSON.stringify(t));

/** { fails, remainingMs, until } — remainingMs > 0 이면 지금은 시도할 수 없음 */
export function getLockout() {
  const t = readThrottle();
  const rem = Math.min(Math.max(0, t.until - clock.now()), MAX_DELAY_MS); // 시계를 뒤로 돌려도 최대 15분
  return { fails: t.fails, remainingMs: rem, until: t.until };
}

let chain = Promise.resolve();
/**
 * 횟수 제한이 걸린 확인. 동시에 여러 번 불러도 하나씩 처리합니다.
 * → { ok, throttled, remainingMs, fails, triesLeft }
 */
export function tryPin(pin) {
  const run = chain.then(() => doTry(pin));
  chain = run.then(() => {}, () => {});
  return run;
}
async function doTry(pin) {
  if (!hasPin()) return { ok: false, throttled: false, remainingMs: 0, fails: 0, triesLeft: FREE_TRIES, reason: 'no-pin' };
  const lock = getLockout();
  if (lock.remainingMs > 0) return { ok: false, throttled: true, remainingMs: lock.remainingMs, fails: lock.fails, triesLeft: 0 };
  if (await verify(pin)) {
    lsDel(THROTTLE_KEY);
    return { ok: true, throttled: false, remainingMs: 0, fails: 0, triesLeft: FREE_TRIES };
  }
  const fails = lock.fails + 1;
  const d = delayFor(fails);
  writeThrottle({ fails, until: d ? clock.now() + d : 0 });
  return { ok: false, throttled: d > 0, remainingMs: d, fails, triesLeft: Math.max(0, FREE_TRIES - fails) };
}

/** 현재 PIN 을 맞게 입력해야 지워집니다 (횟수 제한 적용). 성공하면 true */
export async function clearPin(currentPin) {
  const r = await tryPin(currentPin);
  if (!r.ok) return false;
  forceClearPin();
  return true;
}
/** 현재 PIN 확인 후 새 PIN 으로 교체. 새 PIN 형식이 틀리면 예외, 현재 PIN 이 틀리면 false */
export async function changePin(currentPin, newPin) {
  if (typeof newPin !== 'string' || !PIN_RE.test(newPin)) throw new Error('PIN must be 4–6 digits (암호는 숫자 4~6자리)');
  const r = await tryPin(currentPin);
  if (!r.ok) return false;
  await setPin(newPin);
  return true;
}
/**
 * "PIN 을 잊었어요" 용: 확인 없이 지웁니다. 호출하는 쪽에서 반드시 사용자에게 확인을 받고,
 * 필요하면 로그아웃/기기 안 데이터 삭제를 함께 하세요. 잠금 화면이 떠 있으면 닫힙니다.
 */
export function forceClearPin() {
  lsDel(PIN_KEY);
  lsDel(THROTTLE_KEY);
  if (S.locked) unlockUi();
  disarmIdle();
}

// ───────────────────────── 잠금 상태 / 화면
const S = {
  inited: false, cfg: { idleMinutes: 5, root: null, onUnlock: null, onForgot: null },
  locked: false, el: null, entered: '', busy: false, len: 6,
  lastActive: 0, hiddenAt: null, idleTimer: null, tick: null, outTimer: null, pressTimer: null,
  saved: [], prevFocus: null, subs: [], off: []
};
const rootEl = () => S.cfg.root || (typeof document !== 'undefined' ? document.body : null);
const idleMs = () => Math.max(0, +S.cfg.idleMinutes || 0) * 60000;

export function isLocked() { return S.locked; }
/** 잠김/풀림이 바뀔 때마다 cb(locked:boolean). 해제 함수를 돌려줍니다. */
export function onLockChange(cb) {
  S.subs.push(cb);
  return () => { S.subs = S.subs.filter((f) => f !== cb); };
}
function emit() { S.subs.slice().forEach((f) => { try { f(S.locked); } catch (e) { console.error('[lock] listener error:', e); } }); }

/** 지금 바로 잠급니다. PIN 이 없으면 false */
export function lockNow() {
  if (typeof document === 'undefined' || !hasPin()) return false;
  if (S.locked) return true;
  showOverlay();
  return true;
}

/**
 * 시작할 때 한 번 부르세요 (ui.init 보다 먼저).
 *   idleMinutes  이만큼 아무 입력이 없거나 화면이 가려져 있으면 다시 잠금 (기본 5, 0 이면 처음 열 때만)
 *   onUnlock     PIN 으로 풀릴 때마다 호출
 *   onForgot     주면 "PIN 을 잊으셨나요?" 버튼이 보입니다 (누르면 호출)
 *   root         잠금 화면을 붙일 요소 (기본 document.body). 그 안의 다른 요소는 inert 처리됩니다.
 * PIN 이 이미 있으면 즉시 잠금 화면을 띄웁니다. PIN 이 없어도 호출해 두면, 나중에 PIN 을 만들었을 때 바로 유휴 잠금이 동작합니다.
 * 반환: { lockNow, isLocked, destroy }
 */
export function initLock(opts = {}) {
  if (typeof document === 'undefined') return { lockNow: () => false, isLocked: () => false, destroy() {} };
  destroyLock();
  S.cfg = {
    idleMinutes: opts.idleMinutes === undefined ? 5 : opts.idleMinutes,
    root: opts.root || null,
    onUnlock: typeof opts.onUnlock === 'function' ? opts.onUnlock : null,
    onForgot: typeof opts.onForgot === 'function' ? opts.onForgot : null
  };
  S.inited = true;
  S.lastActive = clock.now();
  S.hiddenAt = null;

  const on = (t, type, fn, o) => { t.addEventListener(type, fn, o); S.off.push(() => t.removeEventListener(type, fn, o)); };
  const act = () => { if (!S.locked) S.lastActive = clock.now(); };
  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach((t) => on(document, t, act, { capture: true, passive: true }));
  on(document, 'scroll', act, { capture: true, passive: true });
  on(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') { S.hiddenAt = clock.now(); return; }
    const was = S.hiddenAt;
    S.hiddenAt = null;
    if (!hasPin() || S.locked || !(idleMs() > 0)) return;
    if (was != null && clock.now() - was >= idleMs()) lockNow();
    else checkIdle();
  });
  if (typeof window !== 'undefined') {
    on(window, 'pageshow', () => { if (document.visibilityState !== 'hidden') checkIdle(); });
    on(window, 'storage', (e) => {          // 다른 탭에서 PIN 을 지웠으면 이 탭의 잠금 화면도 닫기
      if (e.key === PIN_KEY || e.key === null) { if (!hasPin()) { if (S.locked) unlockUi(); disarmIdle(); } else armIdle(); }
    });
  }
  if (hasPin()) showOverlay(); else disarmIdle();
  armIdle();
  return { lockNow, isLocked, destroy: destroyLock };
}

/** 자동 잠금 시간(분)을 바꿉니다 (0 = 끔). initLock 이후에 부르세요. */
export function setIdleMinutes(n) {
  if (!S.cfg) return;
  S.cfg.idleMinutes = Number(n) || 0;
  if (S.inited) { disarmIdle(); armIdle(); }
}

/** initLock 이 붙인 것을 모두 걷어냅니다 (테스트·재초기화용) */
export function destroyLock() {
  S.off.splice(0).forEach((f) => { try { f(); } catch (e) { /* ignore */ } });
  disarmIdle();
  clock.clearTimeout(S.tick); S.tick = null;
  clock.clearTimeout(S.pressTimer); S.pressTimer = null;
  (S.lockOff || []).splice(0).forEach((f) => { try { f(); } catch (e) { /* ignore */ } });
  if (S.locked || S.el) { S.locked = false; restoreInert(); removeEl(true); document.documentElement.classList.remove('hl-locked'); }
  S.inited = false;
}

function disarmIdle() { if (S.idleTimer != null) clock.clearTimeout(S.idleTimer); S.idleTimer = null; }
function armIdle() {
  disarmIdle();
  if (!S.inited || S.locked || !hasPin() || !(idleMs() > 0)) return;
  const wait = Math.max(1000, idleMs() - (clock.now() - S.lastActive));
  S.idleTimer = clock.setTimeout(checkIdle, wait);
}
function checkIdle() {
  S.idleTimer = null;
  if (!S.inited || S.locked || !hasPin() || !(idleMs() > 0)) return;
  if (clock.now() - S.lastActive >= idleMs()) lockNow();
  else armIdle();
}

// ── 화면 만들기
const TXT = {
  title: 'Home Ledger',
  sub: 'Enter PIN (암호 입력)',
  wrong: 'Wrong PIN (암호가 틀렸습니다)',
  forgot: 'Forgot PIN? (암호를 잊으셨나요?)',
  again: 'You can try again (다시 입력하세요)'
};
const ICON_BACK = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 5.5h-11L3.5 12l6 6.5h11a1 1 0 0 0 1-1v-11a1 1 0 0 0-1-1z"/><path d="m12.5 9.5 5 5m0-5-5 5"/></svg>';
const ICON_LOCK = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.6"/><path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5"/></svg>';

function buildHtml(len) {
  const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => '<button type="button" class="lock-key" data-k="' + n + '" aria-label="' + n + '"><span>' + n + '</span></button>').join('');
  return '' +
    '<div class="lock-glow" aria-hidden="true"></div>' +
    '<div class="lock-panel">' +
    '<div class="lock-head">' +
    '<span class="lock-logo" aria-hidden="true">' + logoSvg(60, 'lock') + '<span class="lock-badge">' + ICON_LOCK + '</span></span>' +
    '<h2 class="lock-title" id="lock-title">' + TXT.title + '</h2>' +
    '<p class="lock-sub" id="lock-sub">' + TXT.sub + '</p>' +
    '</div>' +
    '<div class="lock-dots" id="lock-dots" role="img">' + '<i class="lock-dot"></i>'.repeat(len) + '</div>' +
    '<p class="lock-msg" id="lock-msg" role="status" aria-live="polite"></p>' +
    '<div class="lock-pad" role="group" aria-label="Keypad (숫자 키패드)">' + keys +
    '<span class="lock-key lock-key-gap" aria-hidden="true"></span>' +
    '<button type="button" class="lock-key" data-k="0" aria-label="0"><span>0</span></button>' +
    '<button type="button" class="lock-key lock-key-fn" data-k="back" aria-label="Delete (지우기)">' + ICON_BACK + '</button>' +
    '</div>' +
    (S.cfg.onForgot ? '<button type="button" class="lock-forgot" data-k="forgot">' + TXT.forgot + '</button>' : '') +
    '</div>';
}

function showOverlay() {
  const root = rootEl();
  if (!root) return;
  removeEl(true);
  const rec = readRecord();
  S.len = (rec && rec.len >= 4 && rec.len <= 6) ? rec.len : 6;
  S.entered = '';
  S.busy = false;
  const el = document.createElement('div');
  el.id = 'lock';
  el.className = 'lock';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'lock-title');
  el.setAttribute('aria-describedby', 'lock-sub lock-msg');
  el.tabIndex = -1;
  el.innerHTML = buildHtml(S.len);
  S.prevFocus = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  applyInert(root, el);
  root.appendChild(el);
  S.el = el;
  S.locked = true;
  document.documentElement.classList.add('hl-locked');
  clock.clearTimeout(S.idleTimer); S.idleTimer = null;

  el.addEventListener('click', onClick);
  S.lockOff = [];
  const on = (t, type, fn, o) => { t.addEventListener(type, fn, o); S.lockOff.push(() => t.removeEventListener(type, fn, o)); };
  on(document, 'keydown', onKey, true);
  on(document, 'focusin', onFocusIn, true);

  renderDots();
  refreshLockout(true);
  try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  emit();
}

function unlockUi() {
  if (!S.locked) return;
  S.locked = false;
  clock.clearTimeout(S.tick); S.tick = null;
  (S.lockOff || []).splice(0).forEach((f) => f());
  restoreInert();
  document.documentElement.classList.remove('hl-locked');
  const el = S.el;
  S.entered = '';
  if (el) {
    el.classList.add('is-out');
    el.setAttribute('aria-hidden', 'true');
    S.outTimer = clock.setTimeout(() => removeEl(true), 220);
  }
  const pf = S.prevFocus; S.prevFocus = null;
  if (pf && document.contains(pf)) { try { pf.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  S.lastActive = clock.now();
  armIdle();
  emit();
}
function removeEl(now) {
  clock.clearTimeout(S.outTimer); S.outTimer = null;
  if (S.el) { if (S.el.parentNode) S.el.parentNode.removeChild(S.el); S.el = null; }
  const stray = typeof document !== 'undefined' && document.getElementById('lock');
  if (now && stray && stray.parentNode && stray.classList.contains('lock')) stray.parentNode.removeChild(stray);
}

function applyInert(root, overlay) {
  S.saved = [];
  Array.from(root.children).forEach((ch) => {
    if (ch === overlay || /^(SCRIPT|STYLE|LINK|META)$/.test(ch.tagName) || ch.id === 'lock') return;
    S.saved.push({ el: ch, inert: ch.hasAttribute('inert'), ah: ch.getAttribute('aria-hidden') });
    ch.setAttribute('inert', '');
    ch.setAttribute('aria-hidden', 'true');
  });
}
function restoreInert() {
  S.saved.splice(0).forEach((s) => {
    if (!s.inert) s.el.removeAttribute('inert');
    if (s.ah === null) s.el.removeAttribute('aria-hidden'); else s.el.setAttribute('aria-hidden', s.ah);
  });
}

function renderDots() {
  if (!S.el) return;
  const dots = S.el.querySelectorAll('.lock-dot');
  dots.forEach((d, i) => d.classList.toggle('on', i < S.entered.length));
  const box = S.el.querySelector('#lock-dots');
  if (box) box.setAttribute('aria-label', S.entered.length + ' of ' + S.len + ' digits entered (' + S.entered.length + '/' + S.len + '자리 입력됨)');
}
function setMsg(text, err) {
  const m = S.el && S.el.querySelector('#lock-msg');
  if (!m) return;
  m.textContent = text || '';
  m.classList.toggle('err', !!err);
}
function restart(cls, ms) {
  const el = S.el; if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;                       // 애니메이션을 처음부터 다시
  el.classList.add(cls);
  clock.setTimeout(() => { if (S.el === el) el.classList.remove(cls); }, ms);
}
function fmt(ms) {
  const s = Math.ceil(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function setPadDisabled(off) {
  if (!S.el) return;
  S.el.classList.toggle('is-wait', off);
  S.el.querySelectorAll('.lock-pad button').forEach((b) => { b.disabled = off; });
  if (off && S.el.contains(document.activeElement) && document.activeElement !== S.el) { try { S.el.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
}
/** 대기 시간이 남아 있으면 키패드를 막고 카운트다운을 보여 줍니다 */
function refreshLockout(initial) {
  clock.clearTimeout(S.tick); S.tick = null;
  if (!S.locked || !S.el) return;
  const { remainingMs } = getLockout();
  if (remainingMs > 0) {
    setPadDisabled(true);
    setMsg('Too many attempts. Try again in ' + fmt(remainingMs) + ' (잠시 후 다시 시도하세요)', true);
    S.tick = clock.setTimeout(() => refreshLockout(false), 1000);
  } else if (S.el.classList.contains('is-wait')) {
    setPadDisabled(false);
    setMsg(TXT.again, false);
  } else if (initial) {
    setMsg('', false);
  }
}

async function submit() {
  if (S.busy || !S.locked) return;
  const pin = S.entered;
  S.busy = true;
  S.el.setAttribute('aria-busy', 'true');
  let r;
  try { r = await tryPin(pin); } catch (e) { r = { ok: false, throttled: false, fails: 0, triesLeft: FREE_TRIES }; }
  S.busy = false;
  if (!S.el) return;
  S.el.removeAttribute('aria-busy');
  if (r.ok || r.reason === 'no-pin') { unlockUi(); safeCall(S.cfg.onUnlock); return; }
  S.entered = '';
  renderDots();
  restart('is-shake', 460);
  restart('is-error', 700);
  try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) { /* ignore */ }
  if (r.throttled) refreshLockout(false);
  else if (r.triesLeft <= 2) setMsg(TXT.wrong + ' · ' + r.triesLeft + (r.triesLeft === 1 ? ' try left' : ' tries left') + ' (' + r.triesLeft + '번 남음)', true);
  else setMsg(TXT.wrong, true);
}

function press(k) {
  if (!S.locked || S.busy || (S.el && S.el.classList.contains('is-wait'))) return;
  if (k === 'back') { S.entered = S.entered.slice(0, -1); renderDots(); return; }
  if (!/^\d$/.test(k) || S.entered.length >= S.len) return;
  if (S.el.querySelector('#lock-msg').textContent && !S.el.classList.contains('is-wait')) setMsg('', false);
  S.entered += k;
  renderDots();
  if (S.entered.length === S.len) submit();
}
function flash(k) {
  const b = S.el && S.el.querySelector('[data-k="' + k + '"]');
  if (!b) return;
  b.classList.add('is-press');
  clock.clearTimeout(S.pressTimer);
  S.pressTimer = clock.setTimeout(() => b.classList.remove('is-press'), 110);
}
function onClick(e) {
  const b = e.target.closest && e.target.closest('[data-k]');
  if (!b || b.disabled) return;
  if (b.dataset.k === 'forgot') { safeCall(S.cfg.onForgot); return; }
  press(b.dataset.k);
}
function onKey(e) {
  if (!S.locked || e.isComposing) return;
  if (e.key === 'Tab') { trapTab(e); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^\d$/.test(e.key)) {
    e.preventDefault();
    if (!e.repeat) { flash(e.key); press(e.key); }
  } else if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault(); flash('back'); press('back');
  } else if (e.key === 'Enter') {
    if (e.target && e.target.closest && e.target.closest('button')) return;     // 포커스된 버튼은 자기 일을 하게
    e.preventDefault();
    if (S.entered.length >= 4 && S.entered.length < S.len && !S.busy) submit();
  }
}
function trapTab(e) {
  const f = Array.from(S.el.querySelectorAll('button:not([disabled])'));
  if (!f.length) { e.preventDefault(); S.el.focus({ preventScroll: true }); return; }
  const first = f[0], last = f[f.length - 1], cur = document.activeElement;
  if (!S.el.contains(cur) || cur === S.el) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
  if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
}
function onFocusIn(e) {
  if (S.locked && S.el && !S.el.contains(e.target)) { try { S.el.focus({ preventScroll: true }); } catch (err) { /* ignore */ } }
}
function safeCall(fn) { if (typeof fn !== 'function') return; try { fn(); } catch (e) { console.error('[lock] callback error:', e); } }
