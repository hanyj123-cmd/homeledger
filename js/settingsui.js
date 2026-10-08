// 설정(Settings) 화면 — 계정 · 화면 모양 · 잠금 · 가족/소유자 · 환율 · AI · 자동 분류 규칙 · 설치/업데이트 · 데이터.
//  render(api) → <div> (초록 배너 + .page > .settings-grid 카드들). api 는 ui.js 의 pageApi().
//  · 모든 저장은 로컬 우선: api.saveSettings / api.saveBatch (저장 후 화면이 새로 그려집니다).
//  · 이 기기에만 저장하는 값(자동 잠금 시간, 기본 소유자)은 localStorage (막혀 있어도 이번 방문 동안은 동작).
import { CONFIG } from './config.js';
import * as L from './ledger.js';
import * as M from './meta.js';
import * as theme from './theme.js';
import * as lock from './lock.js';
import * as pwa from './pwa.js';
import * as fx from './fx.js';
import * as ai from './ai.js';
import * as Store from './store.js';
import * as authMod from './auth.js';
import * as syncMod from './sync.js';
import { icon } from './icons.js';
import { rulesCard } from './rulesui.js';
import * as MG from './migrate.js';
import { categoriesCard } from './catform.js';
import * as prefs from './prefs.js';
import * as XF from './xfermatch.js';
import * as PB from './paybundle.js';
import * as RV from './receiptview.js';
import * as R from './receipts.js';
import * as models from './models.js';

export const IDLE_KEY = 'hl_lock_idle';
export const OWNER_KEY = 'hl_default_owner';
export const IDLE_CHOICES = [[0, 'Off (끔)', '앱을 열 때만 잠금'], [1, '1 min (1분)', ''], [5, '5 min (5분)', ''], [15, '15 min (15분)', ''], [30, '30 min (30분)', '']];
const OWNERS = CONFIG.OWNERS;

// ───────── 이 기기에만 저장하는 값 ─────────
const memOnly = {};   // localStorage 에 저장하지 못한 값(사생활 보호 모드 등)은 이번 방문 동안만 기억
const lsGet = (k) => { try { const v = localStorage.getItem(k); return v === null && k in memOnly ? memOnly[k] : v; } catch (e) { return k in memOnly ? memOnly[k] : null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); delete memOnly[k]; } catch (e) { memOnly[k] = v; } };

/** 자동 잠금 시간(분). 0 = 앱을 열 때만. 저장된 게 없거나 이상하면 5. ui.js 가 initLock({ idleMinutes: getIdleMinutes() }) 로 쓰세요. */
export function getIdleMinutes() {
  const v = lsGet(IDLE_KEY);
  if (v === null || v === '') return 5;
  const n = Number(v);
  return IDLE_CHOICES.some((c) => c[0] === n) ? n : 5;
}
export function setIdleMinutes(n) {
  const v = IDLE_CHOICES.some((c) => c[0] === Number(n)) ? Number(n) : 5;
  lsSet(IDLE_KEY, String(v));
  if (typeof lock.setIdleMinutes === 'function') { try { lock.setIdleMinutes(v); } catch (e) { /* ignore */ } }
  return v;
}
/** 이 기기에서 직접 고른 새 거래 기본 소유자 ('' = 로그인 계정에 따름) */
export function getDefaultOwnerSetting() { const v = lsGet(OWNER_KEY); return OWNERS.indexOf(v) >= 0 ? v : ''; }
export function setDefaultOwnerSetting(o) { lsSet(OWNER_KEY, OWNERS.indexOf(o) >= 0 ? o : ''); }
/** 새 거래의 기본 소유자: ① 이 기기에서 고른 값 → ② 로그인 이메일의 meta.users 매핑 → ③ Joint. openForm 에서 쓰세요. */
export function defaultOwner(users, email) {   // eslint-disable-line no-unused-vars
  const own = getDefaultOwnerSetting();
  return own || 'Joint';                         // 기본은 모두 공동(Joint)
}

// 모델 선택 카드: 속도 측정 결과와 서버에서 불러온 모델 목록 (설정을 저장하면 화면이 다시 그려지므로 모듈에 둡니다)
const modelUi = { list: null, speed: {}, busy: '', err: '' };
export function _modelUi() { return modelUi; }

// ───────── 작은 도구 ─────────
const fmtWhen = (ms) => (ms ? new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const msg = (e) => (e && e.message ? e.message : String(e));

// ───────── 설치 안내: beforeinstallprompt 는 설정 화면을 열기 전에 올 수 있어서, 이 모듈이 불러와질 때 미리 듣습니다 ─────────
let installPrompt = null;
const installSubs = new Set();
(function hookInstall() {
  if (typeof window === 'undefined' || !window.addEventListener) return;
  try {
    pwa.installPromptSupport({
      onAvailable: (p) => { installPrompt = p; installSubs.forEach((f) => f()); },
      onInstalled: () => { installPrompt = null; installSubs.forEach((f) => f()); }
    });
  } catch (e) { /* 설치 버튼이 없어도 앱은 동작 */ }
})();

// ───────── AI 답변 캐시(IndexedDB meta 의 'ai:' 키) ─────────
export async function aiCacheKeys() {
  const db = await Store.openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('meta', 'readonly').objectStore('meta').getAllKeys();
    req.onsuccess = () => resolve((req.result || []).filter((k) => typeof k === 'string' && k.indexOf('ai:') === 0));
    req.onerror = () => reject(req.error);
  });
}
export async function clearAiCache() {
  if (typeof ai.clearCache === 'function') return ai.clearCache();
  const keys = await aiCacheKeys();
  if (!keys.length) return 0;
  const db = await Store.openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    const os = tx.objectStore('meta');
    keys.forEach((k) => os.delete(k));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
  return keys.length;
}

// ───────── 거래 CSV 백업 ─────────
const unsafeStart = /^[=+\-@\t\r]/;
/** items([{txn, desc}]) → CSV 문자열 (엑셀에서 한글이 깨지지 않게 BOM 포함). 지출은 −, 수입·환불은 +. 오래된 것부터. */
export function buildCsv(items) {
  const q = (v) => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
  const text = (v) => { const s = String(v === undefined || v === null ? '' : v); return unsafeStart.test(s) ? "'" + s : s; };   // 엑셀 수식 주입 방지
  const rows = (items || []).slice().sort(L.cmpChrono);
  const out = [['Date', 'Merchant', 'Amount (CAD)', 'Category', 'Account', 'Owner', 'Memo'].map(q).join(',')];
  rows.forEach((it) => {
    const t = it.txn, d = it.desc || {};
    const amt = L.round(L.num(t.total_cad), 2) * (d.flow === 'out' ? -1 : 1);
    out.push([q(t.date), q(text(t.merchant)), (Math.abs(amt) < 0.005 ? 0 : amt).toFixed(2), q(text(d.categoryName)), q(text(d.accountName)), q(t.owner || ''), q(text(t.memo))].join(','));
  });
  return '﻿' + out.join('\r\n');
}
export function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 2000);
}

// ───────── 환율 도우미 ─────────
/** 통화별 가장 최근 환율 [{ ccy, rate, date, source }] (삭제·0 이하 제외). 데이터가 없는 통화도 줄은 남깁니다. */
export function latestFx(fxRates) {
  return CONFIG.CURRENCIES.filter((c) => c !== CONFIG.BASE_CCY).map((ccy) => {
    let best = null;
    (fxRates || []).forEach((r) => {
      if (L.truthy(r.deleted) || r.currency !== ccy || !(L.num(r.rate) > 0)) return;
      if (!best || String(r.date) > String(best.date)) best = r;
    });
    return { ccy, rate: best ? L.num(best.rate) : 0, date: best ? String(best.date) : '', source: best ? String(best.source || '') : '' };
  });
}
/** 갱신 시작일: 가장 뒤처진 통화의 3일 전부터, 한 번도 못 받은 통화가 있으면 30일 전부터 */
export function fxSince(fxRates, today) {
  const rows = latestFx(fxRates);
  return rows.some((r) => !r.date) ? fx.addDays(today, -30) : fx.addDays(rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0].date), -3);
}

// ───────── 화면 ─────────
let offTheme = null;

export function render(api) {
  const { h, toast } = api;
  const A = api.auth || authMod;
  const SY = api.sync || syncMod;
  const meta = typeof api.meta === 'function' ? api.meta() : M.readAll(api.data.settings);
  const root = h('div', { class: 'settings-root' });

  // 카드 머리말 (아이콘 + 영어 + 한글)
  const head = (ic, en, ko) => h('div', { class: 'set-h' }, h('span', { class: 'set-ic' }, icon(ic, 22)), h('h2', null, en + ' ', h('span', { class: 'ko' }, '(' + ko + ')')));
  const note = (...k) => h('p', { class: 'set-note' }, ...k);
  const kv = (k, v, id) => h('div', { class: 'set-kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v', id: id || null }, v));
  const card = (id, ...kids) => h('section', { class: 'card set-card', id }, ...kids);
  /** 다시 그릴 수 있는 카드: draw() 가 만든 내용으로 카드를 통째로 바꿈 */
  const live = (id, draw) => {
    const el = h('section', { class: 'card set-card', id });
    const redraw = () => el.replaceChildren(...draw(redraw, el).flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));
    redraw();
    return el;
  };

  const au = A.getState();
  const st = SY.getStatus();

  // ═════ 배너 ═════
  const bmet = (label, value, id) => h('div', { class: 'metric sub', id }, h('div', { class: 'metric-lab' }, label), h('div', { class: 'metric-val set-bval' }, value));
  root.append(h('section', { class: 'banner nopills' }, h('div', { class: 'banner-in' },
    h('div', { class: 'banner-row' }, h('div', { class: 'acct-pick' }, h('span', { class: 'nm' }, 'Settings (설정)'))),
    h('div', { class: 'metrics' },
      bmet('Signed in as (로그인)', au.signedIn ? (au.email || 'Signed in') : 'Not signed in', 'set-b-user'),
      bmet('Last sync (마지막 동기화)', st.lastSync ? fmtWhen(st.lastSync) : '—', 'set-b-sync'),
      bmet('Version (버전)', 'v' + CONFIG.APP_VERSION, 'set-b-ver')))));

  // ═════ 1. 계정 ═════
  const secAccount = live('set-account', (redraw, self) => {
    const a = A.getState(), s = SY.getStatus();
    const phase = s.phase === 'syncing' ? 'Syncing… (동기화 중)' : !a.signedIn ? 'Sign in needed (로그인 필요)' : s.phase === 'offline' ? 'Offline (오프라인)' : s.phase === 'error' ? 'Error (오류)' : 'Synced (동기화됨)';
    const pull = s.lastPullMode === 'delta'
      ? 'Changes only (변경분만 가져옴 · delta): ' + s.lastPullRows + ' changed of ' + s.lastPullTotal + ' rows (' + s.lastPullTotal + '행 중 ' + s.lastPullRows + '행)'
      : s.lastPullMode === 'full' ? 'Full download (전체 다운로드): ' + s.lastPullTotal + ' rows (' + s.lastPullTotal + '행)' : 'Not synced yet (아직 동기화 전)';
    const needConsent = typeof A.needsConsent === 'function' && A.needsConsent();
    return [
      head('sync', 'Account', '계정'),
      kv('Status (상태)', a.signedIn ? 'Signed in (로그인됨)' : 'Not signed in (로그인 안 됨)', 'set-acc-status'),
      kv('Email (이메일)', a.email || '—', 'set-acc-email'),
      kv('Sync (동기화)', phase, 'set-acc-phase'),
      kv('Last sync (마지막 동기화)', s.lastSync ? fmtWhen(s.lastSync) : '—', 'set-acc-last'),
      kv('Pending (대기)', String(s.pending) + (s.pending ? ' — will upload when online (연결되면 전송됩니다)' : ''), 'set-acc-pending'),
      kv('Last download (마지막 가져오기)', pull, 'set-acc-pull'),
      s.error ? h('div', { class: 'err', id: 'set-acc-err', role: 'alert' }, s.error) : null,
      needConsent ? h('div', { class: 'set-warn', role: 'alert' }, '구글 시트 권한이 빠졌어요. 로그인 창에서 "Google 스프레드시트 확인, 수정, 생성, 삭제" 항목을 꼭 체크하세요. (Tick the Google Sheets permission when signing in)') : null,
      h('div', { class: 'btnrow' },
        a.signedIn
          ? h('button', {
            type: 'button', class: 'btn', id: 'set-sync', disabled: s.phase === 'syncing',
            onclick: async () => { toast('Syncing… (동기화 중)'); await SY.sync(); redraw(); const s2 = SY.getStatus(); toast(s2.error ? 'Sync problem (동기화 문제): ' + s2.error : 'Synced (동기화됨)'); }
          }, icon('sync', 18), 'Sync now (지금 동기화)')
          : h('button', {
            type: 'button', class: 'btn', id: 'set-signin',
            onclick: async () => {
              try { await A.signIn(); toast('Signed in (로그인되었습니다)'); SY.sync(); } catch (e) { toast(msg(e) || '로그인에 실패했습니다.'); }
              api.rerender();
            }
          }, 'Sign in (로그인)'),
        a.signedIn ? h('button', { type: 'button', class: 'btn secondary', id: 'set-signout', onclick: () => { A.signOut(); api.rerender(); } }, 'Sign out (로그아웃)') : null)
    ];
  });

  // ═════ 2. 화면 ═════
  const secAppearance = live('set-appearance', (redraw, self) => {
    const cur = theme.getTheme();
    const sc = theme.getScale();
    const idx = theme.SCALES.indexOf(sc);
    const T = [['auto', 'auto', 'Auto', '자동'], ['light', 'sun', 'Light', '밝게'], ['dark', 'moon', 'Dark', '어둡게']];
    return [
      head('sun', 'Appearance', '화면'),
      h('div', { class: 'set-themes', role: 'radiogroup', 'aria-label': 'Theme (화면 모드)' }, T.map((t) => h('button', {
        type: 'button', class: 'set-tile' + (cur === t[0] ? ' on' : ''), role: 'radio', 'aria-checked': String(cur === t[0]), 'data-theme-opt': t[0],
        onclick: () => { theme.setTheme(t[0]); redraw(); }
      }, icon(t[1], 26), h('b', null, t[2]), h('span', { class: 'ko' }, t[3])))),
      note('Auto follows your device (자동은 기기의 밝게/어둡게 설정을 따라갑니다). The ', h('span', { class: 'set-inl' }, icon('sun', 15)), ' button at the top also changes this (화면 위쪽 버튼으로도 바꿀 수 있어요).'),
      h('h3', { class: 'set-sub' }, 'Language (언어)'),
      h('div', { class: 'segtd set-lang', role: 'radiogroup', id: 'set-lang' }, [['ko', '한국어'], ['en', 'English'], ['both', 'Both (둘 다)']].map(([v, lab]) => h('button', {
        type: 'button', role: 'radio', class: prefs.lang() === v ? 'on' : '', 'aria-checked': String(prefs.lang() === v), 'data-lang-opt': v,
        onclick: () => { if (prefs.lang() === v) return; prefs.setLang(v); try { if (!globalThis.__HL_TEST__) location.reload(); } catch (e) { /* ignore */ } redraw(); }
      }, lab))),
      note('Menus and labels show only the language you pick. The 한/EN button at the top switches too (고른 언어로만 메뉴가 보여요. 위쪽 한/EN 버튼으로도 바꿀 수 있어요).'),
      h('h3', { class: 'set-sub' }, 'Text size (글자 크기)'),
      h('div', { class: 'set-scale' },
        h('button', { type: 'button', class: 'set-step', id: 'set-scale-down', 'aria-label': 'Smaller text (글자 작게)', disabled: idx <= 0, onclick: () => { theme.stepScale(-1); redraw(); } }, 'A−'),
        h('div', { class: 'set-scale-mid', id: 'set-scale-val', 'aria-live': 'polite' },
          h('b', null, Math.round(sc * 100) + '%'),
          h('span', { class: 'set-dots', 'aria-hidden': 'true' }, theme.SCALES.map((_, i) => h('i', { class: i === idx ? 'on' : '' })))),
        h('button', { type: 'button', class: 'set-step', id: 'set-scale-up', 'aria-label': 'Larger text (글자 크게)', disabled: idx >= theme.SCALES.length - 1, onclick: () => { theme.stepScale(1); redraw(); } }, 'A+'),
        h('button', { type: 'button', class: 'btn secondary sm', id: 'set-scale-reset', disabled: sc === 1, onclick: () => { theme.setScale(1); redraw(); } }, 'Reset (기본)')),
      h('div', { class: 'set-preview', 'aria-label': 'Preview (미리보기)' },
        h('div', { class: 'pv-row' }, h('b', null, 'Groceries (식료품)'), h('span', { class: 'out' }, '−$84.20')),
        h('div', { class: 'pv-sub' }, 'Costco · Patrick · Today (오늘)'),
        h('div', { class: 'pv-sub' }, '이 정도 크기로 글자가 보입니다.'))
    ];
  });
  // 헤더의 테마 버튼으로 바뀌었을 때도 이 카드의 선택 표시를 맞춥니다 (카드가 화면에서 사라졌으면 구독을 끊음)
  if (offTheme) { offTheme(); offTheme = null; }
  offTheme = theme.onSystemThemeChange(() => {
    if (!secAppearance.isConnected) { if (offTheme) { offTheme(); offTheme = null; } return; }
    const cur = theme.getTheme();
    secAppearance.querySelectorAll('[data-theme-opt]').forEach((b) => { const on = b.getAttribute('data-theme-opt') === cur; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
  });

  // ═════ 3. 잠금 ═════
  const secSecurity = live('set-security', (redraw, self) => {
    let mode = self.__mode || '';
    const state = self.__msg || { text: '', err: false };
    const setMode = (m, mm) => { self.__mode = m; self.__msg = mm || { text: '', err: false }; redraw(); };
    const hasPinSet = lock.hasPin();
    const bioOn = lock.hasBio();
    const has = lock.isLockEnabled();
    const bioSup = lock.bioSupported();
    if (bioSup && self.__bioAvail === undefined) { self.__bioAvail = null; lock.bioAvailable().then((v) => { self.__bioAvail = !!v; redraw(); }, () => { self.__bioAvail = false; redraw(); }); }
    const bioAvail = self.__bioAvail !== false && bioSup;
    const idle = getIdleMinutes();
    const pinField = (id, label) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), h('input', {
      type: 'password', id, inputmode: 'numeric', pattern: '[0-9]*', maxlength: '6', autocomplete: 'off', placeholder: '••••',
      oninput: (e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 6); if (v !== e.target.value) e.target.value = v; },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const f = e.target.closest('.set-pinform'); const b = f && f.querySelector('[data-submit]'); if (b) b.click(); } }
    }));
    const val = (id) => { const el = self.querySelector('#' + id); return el ? el.value : ''; };
    const msgEl = h('div', { class: state.err ? 'err' : 'ok-hint', id: 'set-pin-msg', role: 'status' }, state.text);
    const fail = (t) => { msgEl.className = 'err'; msgEl.textContent = t; };
    const wrongPin = () => {
      const lo = lock.getLockout();
      if (lo.remainingMs > 0) { const s = Math.ceil(lo.remainingMs / 1000); return 'Too many attempts. Try again in ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + ' (너무 많이 틀렸어요. 잠시 후 다시 시도하세요)'; }
      return 'Current PIN is wrong (현재 암호가 틀렸어요)';
    };
    const checkNew = () => {
      const p1 = val('set-pin-new'), p2 = val('set-pin-new2');
      if (!/^\d{4,6}$/.test(p1)) { fail('PIN must be 4–6 digits (암호는 숫자 4~6자리)'); return null; }
      if (p1 !== p2) { fail('The two PINs differ (두 번 입력한 암호가 달라요)'); return null; }
      return p1;
    };
    let form = null;
    if (mode === 'set') {
      form = h('div', { class: 'set-pinform' }, pinField('set-pin-new', 'New PIN (새 암호, 숫자 4~6자리)'), pinField('set-pin-new2', 'Confirm PIN (한 번 더)'),
        h('div', { class: 'btnrow' },
          h('button', {
            type: 'button', class: 'btn', id: 'set-pin-save', 'data-submit': '1', onclick: async () => {
              const p = checkNew(); if (!p) return;
              try { await lock.setPin(p); toast('PIN set (암호가 설정되었어요)'); setMode('', { text: 'PIN set (암호가 설정되었어요)', err: false }); } catch (e) { fail(msg(e)); }
            }
          }, 'Save PIN (암호 저장)'),
          h('button', { type: 'button', class: 'btn secondary', onclick: () => setMode('') }, 'Cancel (취소)')));
    } else if (mode === 'change') {
      form = h('div', { class: 'set-pinform' }, pinField('set-pin-cur', 'Current PIN (현재 암호)'), pinField('set-pin-new', 'New PIN (새 암호)'), pinField('set-pin-new2', 'Confirm new PIN (새 암호 확인)'),
        h('div', { class: 'btnrow' },
          h('button', {
            type: 'button', class: 'btn', id: 'set-pin-save', 'data-submit': '1', onclick: async () => {
              const p = checkNew(); if (!p) return;
              try {
                const ok = await lock.changePin(val('set-pin-cur'), p);
                if (!ok) { fail(wrongPin()); return; }
                toast('PIN changed (암호를 바꿨어요)'); setMode('', { text: 'PIN changed (암호를 바꿨어요)', err: false });
              } catch (e) { fail(msg(e)); }
            }
          }, 'Change PIN (암호 변경)'),
          h('button', { type: 'button', class: 'btn secondary', onclick: () => setMode('') }, 'Cancel (취소)')));
    } else if (mode === 'remove') {
      form = h('div', { class: 'set-pinform' }, pinField('set-pin-cur', 'Current PIN (현재 암호)'),
        h('div', { class: 'btnrow' },
          h('button', {
            type: 'button', class: 'btn danger', id: 'set-pin-remove', 'data-submit': '1', onclick: async () => {
              try {
                const ok = await lock.clearPin(val('set-pin-cur'));
                if (!ok) { fail(wrongPin()); return; }
                toast('PIN removed (암호를 해제했어요)'); setMode('', { text: 'PIN removed (암호를 해제했어요)', err: false });
              } catch (e) { fail(msg(e)); }
            }
          }, 'Remove PIN (암호 해제)'),
          h('button', { type: 'button', class: 'btn secondary', onclick: () => setMode('') }, 'Cancel (취소)')));
    }
    return [
      head('lock', 'Security', '잠금'),
      kv('App lock (앱 잠금)', h('span', { class: 'set-pill ' + (has ? 'ok' : 'off') }, has ? 'On (켜짐)' : 'Off (꺼짐)'), 'set-pin-state'),
      h('div', { class: 'set-switchrow', id: 'set-bio-row' },
        h('div', null, h('b', null, 'Device unlock (기기 인증)'),
          h('div', { class: 'hint', id: 'set-bio-hint' }, !bioSup ? 'Not available in this browser (이 브라우저에서는 쓸 수 없어요). Open the installed app over https (설치한 앱에서 열어 보세요).'
            : !bioAvail ? 'Set up Face ID, fingerprint or a device passcode in your phone settings first (기기 설정에서 Face ID · 지문 · 화면 잠금을 먼저 설정하세요).'
              : bioOn ? 'On — Face ID, fingerprint or device passcode is asked when the app opens (앱을 열 때 Face ID · 지문 · 기기 암호로 확인합니다).'
                : 'Ask for Face ID, fingerprint or device passcode when the app opens (앱을 열 때 Face ID · 지문 · 기기 암호로 한 번 더 확인합니다).')),
        h('button', {
          type: 'button', class: 'set-switch' + (bioOn ? ' on' : ''), id: 'set-bio-toggle', role: 'switch', 'aria-checked': String(bioOn), disabled: !bioOn && !bioAvail,
          'aria-label': bioOn ? 'Turn device unlock off (기기 인증 끄기)' : 'Turn device unlock on (기기 인증 켜기)',
          onclick: async (e) => {
            const b = e.currentTarget;
            if (bioOn) { lock.disableBio(); toast('Device unlock off (기기 인증을 껐어요)'); setMode('', { text: 'Device unlock off (기기 인증을 껐어요)', err: false }); return; }
            b.disabled = true;
            try { await lock.enableBio(); toast('Device unlock on (기기 인증을 켰어요)'); setMode('', { text: 'Device unlock on — you will be asked next time you open the app (다음에 앱을 열 때부터 확인합니다)', err: false }); }
            catch (err) { b.disabled = false; fail(msg(err)); }
          }
        }, h('i'))),
      form,
      form ? null : h('div', { class: 'btnrow' },
        has ? [
          h('button', { type: 'button', class: 'btn', id: 'set-lock-now', onclick: () => { if (!lock.lockNow()) toast('Turn on a lock first (먼저 잠금을 켜세요)'); } }, icon('lock', 18), 'Lock now (지금 잠그기)'),
          hasPinSet ? h('button', { type: 'button', class: 'btn secondary', id: 'set-pin-change', onclick: () => setMode('change') }, 'Change PIN (암호 변경)') : null,
          hasPinSet ? h('button', { type: 'button', class: 'btn danger', id: 'set-pin-off', onclick: () => setMode('remove') }, 'Remove PIN (암호 해제)') : null,
          !hasPinSet ? h('button', { type: 'button', class: 'btn secondary', id: 'set-pin-set', onclick: () => setMode('set') }, 'Set backup PIN (보조 암호 설정)') : null
        ] : h('button', { type: 'button', class: 'btn', id: 'set-pin-set', onclick: () => setMode('set') }, icon('lock', 18), 'Set PIN (암호 설정)')),
      msgEl,
      h('label', { class: 'field set-idle' }, h('span', { class: 'lbl' }, 'Auto-lock after (자동 잠금 시간)'),
        h('select', {
          id: 'set-idle', disabled: !has, 'aria-label': 'Auto-lock after (자동 잠금 시간)',
          onchange: (e) => { const v = setIdleMinutes(e.target.value); toast(v ? 'Auto-lock: ' + v + ' min (' + v + '분 후 자동 잠금)' : 'Lock only when the app opens (앱을 열 때만 잠금)'); }
        }, IDLE_CHOICES.map((c) => h('option', { value: String(c[0]), selected: c[0] === idle }, c[1] + (c[2] ? ' — ' + c[2] : ''))))),
      !has ? h('div', { class: 'hint' }, 'Turn on device unlock or set a PIN first (기기 인증을 켜거나 암호를 먼저 설정하세요).') : null,
      bioOn && !hasPinSet ? h('div', { class: 'hint', id: 'set-bio-nopin' }, 'Tip: also set a backup PIN, in case Face ID does not work (Face ID 가 안 될 때를 위해 보조 암호도 만들어 두세요).') : null,
      note('This is a convenience lock for this device, not encryption. Google sign-in is separate. (이 기기의 편의 잠금이며 암호화가 아닙니다. 구글 로그인은 별도입니다.)')
    ];
  });

  // ═════ 4. 가족 · 소유자 ═════
  const secFamily = live('set-family', (redraw, self) => {
    const users = meta.users || {};
    const draft = self.__draft || (self.__draft = Object.keys(users).map((e) => ({ email: e, owner: users[e] })));
    const email = A.getState().email || '';
    const mine = M.ownerFor(users, email);
    const dflt = getDefaultOwnerSetting();
    const dirty = JSON.stringify(draft.filter((r) => r.email.trim()).map((r) => [r.email.trim().toLowerCase(), r.owner]).sort()) !== JSON.stringify(Object.keys(users).map((e) => [e.toLowerCase(), users[e]]).sort());
    const ownerOpts = (sel) => OWNERS.map((o) => h('option', { value: o, selected: o === sel }, L.ownerLabel(o)));
    const addEmail = h('input', { type: 'text', id: 'set-fam-new-email', inputmode: 'email', autocapitalize: 'off', autocomplete: 'off', placeholder: 'name@gmail.com', value: self.__addEmail !== undefined ? self.__addEmail : (email && !mine ? email : '') , 'aria-label': 'Email (이메일)', oninput: (e) => { self.__addEmail = e.target.value; } });
    const addOwner = h('select', { id: 'set-fam-new-owner', 'aria-label': 'Owner (소유자)', onchange: (e) => { self.__addOwner = e.target.value; } }, ownerOpts(self.__addOwner || 'Ms Kim'));
    const err = h('div', { class: 'err', id: 'set-fam-err', role: 'alert' });
    const save = async () => {
      const out = {}; const seen = new Set();
      for (const r of draft) {
        const e = r.email.trim();
        if (!e) continue;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { err.textContent = 'Check the email (이메일 형식을 확인하세요): ' + e; return; }
        if (seen.has(e.toLowerCase())) { err.textContent = 'Duplicate email (같은 이메일이 두 번 있어요): ' + e; return; }
        seen.add(e.toLowerCase());
        out[e] = r.owner;
      }
      err.textContent = '';
      try {
        await api.saveSettings(M.metaRow(api.data.settings, M.KEYS_META.users, out, 'users', L.nowIso()));
        toast('Saved (저장됨)');
      } catch (e) { err.textContent = '저장하지 못했습니다: ' + msg(e); }
    };
    return [
      head('people', 'Family & access', '가족 · 소유자'),
      kv('This account (이 계정)', email ? email + ' → ' + (mine ? L.ownerLabel(mine) : 'not mapped (아직 지정 안 됨)') : 'Not signed in (로그인 안 됨)', 'set-fam-mine'),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Default owner for new transactions on this device (이 기기에서 새 거래의 기본 소유자)'),
        h('select', {
          id: 'set-def-owner', onchange: (e) => { setDefaultOwnerSetting(e.target.value); toast(e.target.value ? 'New transactions start as ' + e.target.value + ' (새 거래는 ' + L.ownerLabel(e.target.value, 'ko') + '(으)로 시작)' : 'New transactions start as Joint (새 거래는 공동으로 시작)'); redraw(); }
        }, h('option', { value: '', selected: !dflt }, 'Joint — default (공동 · 기본)'), ownerOpts(dflt))),
      h('div', { class: 'hint', id: 'set-def-owner-now' }, 'Right now (지금): ' + L.ownerLabel(defaultOwner(users, email))),
      h('h3', { class: 'set-sub' }, 'Who is who (이메일 → 소유자)'),
      draft.length ? null : h('div', { class: 'set-empty' }, 'No accounts mapped yet (아직 지정한 계정이 없어요).'),
      h('div', { class: 'set-map' }, draft.map((r, i) => h('div', { class: 'map-row', 'data-i': i },
        h('input', { type: 'text', class: 'map-email', inputmode: 'email', autocapitalize: 'off', autocomplete: 'off', value: r.email, 'aria-label': 'Email (이메일)', oninput: (e) => { r.email = e.target.value; } }),
        h('select', { class: 'map-owner', 'aria-label': 'Owner (소유자)', onchange: (e) => { r.owner = e.target.value; } }, ownerOpts(r.owner)),
        h('button', { type: 'button', class: 'rr-del', 'aria-label': 'Remove (삭제)', title: 'Remove (삭제)', onclick: () => { draft.splice(i, 1); redraw(); } }, icon('trash', 20))))),
      h('div', { class: 'map-row add' }, addEmail, addOwner,
        h('button', {
          type: 'button', class: 'btn secondary', id: 'set-fam-add', onclick: () => {
            const e = addEmail.value.trim();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { err.textContent = 'Check the email (이메일 형식을 확인하세요).'; return; }
            if (draft.some((r) => r.email.trim().toLowerCase() === e.toLowerCase())) { err.textContent = 'Already in the list (이미 목록에 있어요).'; return; }
            draft.push({ email: e, owner: addOwner.value }); self.__addEmail = ''; self.__addOwner = addOwner.value; redraw();
          }
        }, icon('plus', 18), 'Add (추가)')),
      err,
      h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn', id: 'set-fam-save', disabled: !dirty, onclick: save }, 'Save (저장)'),
        dirty ? h('span', { class: 'set-pill warn' }, 'Unsaved (저장 전)') : null),
      note('Ms Kim: when signing in with Google, tick "See, edit, create and delete your Google Sheets spreadsheets" (구글 로그인 창에서 "Google 스프레드시트 확인, 수정, 생성, 삭제" 항목을 꼭 체크하세요). The sheet must also be shared with her Google account as Editor (시트도 Ms Kim 구글 계정에 편집자로 공유되어 있어야 합니다).')
    ];
  });

  // ═════ 5. 환율 ═════
  const secCurrency = live('set-currency', (redraw, self) => {
    const rows = latestFx(api.data.fxRates);
    const newest = rows.reduce((m, r) => (r.date > m ? r.date : m), '');
    const busy = self.__busy;
    const errTxt = self.__err || '';
    const lastCheck = h('span', { id: 'set-fx-check' }, self.__checked || '…');
    if (!self.__checked) {
      Promise.resolve().then(() => Store.getMeta('fx:last')).then((t) => { self.__checked = t ? fmtWhen(Number(t)) : '—'; lastCheck.textContent = self.__checked; }, () => { lastCheck.textContent = '—'; });
    }
    return [
      head('coin', 'Currency', '환율'),
      h('div', { class: 'set-fxgrid', id: 'set-fx-table' }, rows.map((r) => {
        const per = r.rate > 0 && r.rate < 0.05 ? 100 : 1;
        return h('div', { class: 'fx-row', 'data-ccy': r.ccy },
          h('b', null, r.ccy),
          h('span', { class: 'fx-rate' }, r.rate > 0 ? per + ' ' + r.ccy + ' = ' + L.round(r.rate * per, 4).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + ' CAD' : 'No rate yet (환율 없음)'),
          h('span', { class: 'fx-date muted' }, r.date ? r.date + (r.source ? ' · ' + r.source.toLowerCase() : '') : ''));
      })),
      kv('Latest rate date (최근 환율 날짜)', newest || '—', 'set-fx-newest'),
      kv('Last checked (마지막 갱신 시도)', lastCheck),
      errTxt ? h('div', { class: 'err', id: 'set-fx-err', role: 'alert' }, errTxt) : null,
      h('div', { class: 'btnrow' }, h('button', {
        type: 'button', class: 'btn', id: 'set-fx-update', disabled: !!busy,
        onclick: async () => {
          self.__busy = true; self.__err = ''; redraw();
          try {
            const fetched = await fx.fetchRates({ since: fxSince(api.data.fxRates, L.todayStr()), currencies: fx.defaultCurrencies() });
            const add = fx.rowsToSave(fetched, api.data.fxRates);
            try { await Store.setMeta('fx:last', Date.now()); } catch (e) { /* ignore */ }
            self.__checked = '';
            self.__busy = false;
            if (add.length) { await api.saveBatch({ FxRates: add }, ['FxRates']); toast('Added ' + add.length + ' new rates (새 환율 ' + add.length + '건 추가)'); }
            else { redraw(); toast('Already up to date (이미 최신 환율입니다)'); }
          } catch (e) {
            self.__busy = false;
            const m = msg(e);
            self.__err = m + (/Failed to fetch|NetworkError|Load failed|CORS/i.test(m) ? ' (인터넷 연결이나 브라우저 보안 설정 때문에 막혔을 수 있어요.)' : '');
            redraw();
          }
        }
      }, icon('sync', 18), busy ? 'Updating… (갱신 중)' : 'Update rates now (환율 지금 갱신)')),
      note('Rates come from the Bank of Canada (캐나다 중앙은행) and refresh by themselves about once a day when you open the app (앱을 열면 하루에 한 번쯤 자동 갱신됩니다). Foreign purchases use the CAD amount on your card statement when you enter it (카드 청구액을 입력하면 그 값이 우선입니다).')
    ];
  });

  // ═════ 6. AI ═════
  const secAi = live('set-ai', (redraw, self) => {
    const enabled = meta.ai ? meta.ai.enabled !== false : true;
    const avail = ai.aiAvailable();
    const cacheEl = h('span', { id: 'set-ai-cache' }, '…');
    aiCacheKeys().then((k) => { cacheEl.textContent = k.length + ' saved (저장된 답변 ' + k.length + '개)'; }, () => { cacheEl.textContent = '—'; });
    return [
      head('spark', 'AI assistant', 'AI 도우미'),
      kv('Available (사용 가능)', h('span', { class: 'set-pill ' + (avail ? 'ok' : 'off') }, avail ? 'Ready (사용 가능)' : (A.getState().signedIn ? 'Server not ready (서버 설정 필요)' : 'Sign in first (로그인 필요)')), 'set-ai-avail'),
      h('div', { class: 'set-switchrow' },
        h('div', null, h('b', null, 'AI features (AI 기능)'), h('div', { class: 'hint' }, enabled ? 'On — buttons for AI advice are shown (AI 조언 버튼이 보입니다).' : 'Off — AI buttons are hidden (AI 버튼을 숨깁니다).')),
        h('button', {
          type: 'button', class: 'set-switch' + (enabled ? ' on' : ''), id: 'set-ai-toggle', role: 'switch', 'aria-checked': String(enabled), 'aria-label': enabled ? 'Turn AI off (AI 끄기)' : 'Turn AI on (AI 켜기)',
          onclick: async () => {
            try {
              await api.saveSettings(M.metaRow(api.data.settings, M.KEYS_META.ai, Object.assign({}, meta.ai || {}, { enabled: !enabled }), 'ai', L.nowIso()));
              toast(!enabled ? 'AI on (AI 기능을 켰어요)' : 'AI off (AI 기능을 껐어요)');
            } catch (e) { toast('저장하지 못했습니다: ' + msg(e)); }
          }
        }, h('i'))),
      kv('Saved answers (저장된 AI 답변)', cacheEl),
      h('div', { class: 'btnrow' }, h('button', {
        type: 'button', class: 'btn secondary', id: 'set-ai-clear',
        onclick: async () => {
          try { const n = await clearAiCache(); toast(n ? n + ' saved answers cleared (저장된 답변 ' + n + '개를 지웠어요)' : 'Nothing to clear (지울 답변이 없어요)'); redraw(); } catch (e) { toast('지우지 못했습니다: ' + msg(e)); }
        }
      }, icon('trash', 18), 'Clear saved AI answers (저장된 AI 답변 지우기)')),
      note('AI advice is free but has a daily limit (무료이지만 하루 사용 한도가 있어요). Only summarized numbers are sent, never your raw transactions (집계된 숫자만 보내고 거래 원본은 보내지 않습니다). AI runs only when you tap a button (버튼을 누를 때만 실행됩니다). Rule-based tips always work (규칙 기반 조언은 항상 보입니다).')
    ];
  });


  // ═════ 6-2. 영수증 사진 (스캔본 · 드라이브) ═════
  const secReceipts = live('set-receipts', (redraw, self) => {
    const mode = prefs.scanMode();
    const cnt = h('span', { id: 'set-rc-cache' }, '…');
    RV.cacheCount().then((n) => { cnt.textContent = n + ' photo' + (n === 1 ? '' : 's') + ' (사진 ' + n + '장)'; }, () => { cnt.textContent = '—'; });
    return [
      head('camera', 'Receipt photos', '영수증 사진'),
      h('h3', { class: 'set-sub' }, 'Save as (저장 방식)'),
      h('div', { class: 'segtd set-scan', role: 'radiogroup', id: 'set-scan' }, [['scan', 'Scan (스캔본)'], ['color', 'Color scan (컬러 스캔)'], ['orig', 'Original (원본)']].map(([v, lab]) => h('button', {
        type: 'button', role: 'radio', class: mode === v ? 'on' : '', 'aria-checked': String(mode === v), 'data-scan-opt': v,
        onclick: () => { prefs.setScanMode(v); toast(v === 'orig' ? 'Original photos (원본 그대로 저장)' : v === 'color' ? 'Color scan (컬러 스캔본으로 저장)' : 'Black & white scan (흑백 스캔본으로 저장)'); redraw(); }
      }, lab))),
      note('Scan: the desk around the paper is cropped, shadows are evened out and the text is darkened, so it looks like a scanner copy and uploads faster (스캔본: 종이 주변 책상을 자르고 그림자를 펴고 글씨를 진하게 해서 스캐너로 뜬 것처럼 저장해요. 용량이 작아 업로드도 빨라요). This setting is for this device only (이 기기에만 적용).'),
      h('h3', { class: 'set-sub' }, 'Where are they? (어디에 저장되나요)'),
      note('Google Drive folder "Home Ledger Receipts" (구글 드라이브의 "Home Ledger Receipts" 폴더). In the Ledger, tap the camera icon on a transaction to view the receipt any time (거래 목록의 카메라 아이콘을 누르면 언제든 다시 볼 수 있어요). To add a photo to an older transaction, open it and tap "Attach receipt photo" (예전 거래에는 거래를 열어 "영수증 사진 붙이기").'),
      kv('Kept on this device (이 기기에 저장된 사진)', cnt),
      h('div', { class: 'btnrow' }, h('button', {
        type: 'button', class: 'btn secondary', id: 'set-rc-clear',
        onclick: async () => { const n = await RV.cacheClear(); toast(n ? n + ' photos removed from this device (이 기기에서 사진 ' + n + '장을 지웠어요. 드라이브에는 그대로 있어요)' : 'Nothing to remove (지울 사진이 없어요)'); redraw(); }
      }, icon('trash', 18), 'Clear device copies (이 기기의 사본 지우기)'))
    ];
  });

  // ═════ 6-3. Gemini 모델 선택 ═════
  const secModel = live('set-model', (redraw, self) => {
    const cur = Object.assign({ receipt: '', ai: '' }, meta.gemini || {});
    const avail = ai.aiAvailable();
    const known = [];
    models.PRESETS.forEach((p) => { if (p.id) known.push(p.id); });
    (modelUi.list || []).forEach((m) => { if (known.indexOf(m) < 0) known.push(m); });
    ['receipt', 'ai'].forEach((k) => { if (cur[k] && known.indexOf(cur[k]) < 0) known.push(cur[k]); });
    const ms = (m) => { const r = modelUi.speed[m]; return r ? (r.err ? ' — ✕' : ' — ' + (r.ms / 1000).toFixed(1) + ' s') : ''; };
    const preset = (id) => models.PRESETS.find((p) => p.id === id);
    const optLabel = (id) => (id ? id + (preset(id) ? ' · ' + preset(id).en + ' (' + preset(id).ko + ')' : '') : preset('').en + ' (' + preset('').ko + ')') + (id ? ms(id) : '');
    const save = async (kind, val) => {
      try {
        await api.saveSettings(M.metaRow(api.data.settings, M.KEYS_META.gemini, Object.assign({}, cur, { [kind]: models.clean(val) }), 'gemini', L.nowIso()));
        toast(val ? 'Model: ' + val + ' (모델을 바꿨어요)' : 'Model: auto (자동으로 돌아갔어요)');
      } catch (e) { toast('저장하지 못했습니다: ' + msg(e)); }
    };
    const picker = (kind, labelEn, labelKo) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, labelEn + ' (' + labelKo + ')'),
      h('select', { id: 'set-model-' + kind, 'aria-label': labelEn + ' (' + labelKo + ')', onchange: (e) => save(kind, e.target.value) },
        h('option', { value: '', selected: !cur[kind] }, optLabel('')),
        known.map((m) => h('option', { value: m, selected: cur[kind] === m }, optLabel(m)))));
    const runTest = async (name) => {
      const t0 = Date.now();
      try {
        let target = name;
        if (!target) { const p = await R.callApi({ action: 'ping' }); target = p.model; }
        const r = await R.callApi({ action: 'testModel', model: target });
        modelUi.speed[target] = { ms: r.ms || (Date.now() - t0), err: '' };
        if (!name) modelUi.speed[''] = modelUi.speed[target];
        return target;
      } catch (e) { const k = name || '(auto)'; modelUi.speed[k] = { ms: 0, err: msg(e) }; modelUi.err = msg(e); throw e; }
    };
    const testOne = async (kind) => {
      modelUi.busy = kind; modelUi.err = ''; redraw();
      try { await runTest(cur[kind]); } catch (e) { /* 오류는 아래에 표시 */ }
      modelUi.busy = ''; redraw();
    };
    const testAll = async () => {
      modelUi.busy = 'all'; modelUi.err = ''; redraw();
      const list = models.PRESETS.filter((p) => p.id).map((p) => p.id).concat((modelUi.list || []).filter((m) => !models.PRESETS.some((p) => p.id === m)).slice(0, 4));
      for (const m of list) { try { await runTest(m); } catch (e) { /* 안 되는 모델은 ✕ 로 표시 */ } redraw(); }
      modelUi.busy = ''; modelUi.err = ''; redraw();
    };
    const loadList = async () => {
      modelUi.busy = 'list'; modelUi.err = ''; redraw();
      try { const r = await R.callApi({ action: 'listModels' }); modelUi.list = r.models || []; toast((modelUi.list.length) + ' models found (쓸 수 있는 모델 ' + modelUi.list.length + '개)'); }
      catch (e) { modelUi.err = /알 수 없는 요청/.test(msg(e)) ? '서버가 아직 모델 선택을 지원하지 않습니다. Apps Script 를 새 버전(v5)으로 다시 배포하세요. (Redeploy Apps Script as v5)' : msg(e); }
      modelUi.busy = ''; redraw();
    };
    const rows = Object.keys(modelUi.speed).filter((k) => k && modelUi.speed[k]).sort((a, b) => (modelUi.speed[a].err ? 1 : 0) - (modelUi.speed[b].err ? 1 : 0) || modelUi.speed[a].ms - modelUi.speed[b].ms);
    const customIn = h('input', { type: 'text', id: 'set-model-custom', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'gemini-…', 'aria-label': 'Model name (모델 이름)' });
    const useCustom = (kind) => { const v = models.clean(customIn.value); if (!v) { toast('Check the name (모델 이름을 확인하세요: gemini-로 시작)'); return; } save(kind, v); };
    const busy = !!modelUi.busy;
    return [
      head('spark', 'AI model (speed)', 'AI 모델 · 속도'),
      !avail ? h('div', { class: 'set-warn', id: 'set-model-off' }, A.getState().signedIn ? 'The server is not ready (서버 설정이 필요합니다).' : 'Sign in first (먼저 로그인하세요).') : null,
      note('Receipt reading feels slow? Pick a lighter model. "Test speed" tells you the real time on your account (영수증 읽기가 느리면 더 가벼운 모델을 고르세요. "속도 측정"으로 내 계정에서 실제로 몇 초 걸리는지 볼 수 있어요). Shared by everyone using this ledger (이 장부를 쓰는 가족 모두에게 같이 적용돼요).'),
      picker('receipt', 'Receipt reading', '영수증 읽기'),
      picker('ai', 'AI advice & auto-categorize', 'AI 조언 · 자동 분류'),
      h('div', { class: 'btnrow' },
        h('button', { type: 'button', class: 'btn', id: 'set-model-test-all', disabled: !avail || busy, onclick: testAll }, icon('sync', 18), modelUi.busy === 'all' ? 'Testing… (측정 중)' : 'Compare speed (속도 비교)'),
        h('button', { type: 'button', class: 'btn secondary', id: 'set-model-test', disabled: !avail || busy, onclick: () => testOne('receipt') }, modelUi.busy === 'receipt' ? 'Testing… (측정 중)' : 'Test receipt model (영수증 모델 측정)'),
        h('button', { type: 'button', class: 'btn secondary', id: 'set-model-list', disabled: !avail || busy, onclick: loadList }, modelUi.busy === 'list' ? 'Loading… (불러오는 중)' : 'Load my models (내 모델 목록)')),
      rows.length ? h('div', { class: 'set-speed', id: 'set-speed' }, rows.map((m) => {
        const r = modelUi.speed[m];
        return h('div', { class: 'sp-row' + (r.err ? ' bad' : ''), 'data-model': m },
          h('b', null, m),
          h('span', { class: 'sp-ms' }, r.err ? '✕ ' + (r.err.length > 60 ? r.err.slice(0, 60) + '…' : r.err) : (r.ms / 1000).toFixed(1) + ' s'),
          r.err ? null : h('button', { type: 'button', class: 'btn secondary sm', 'data-use': 'receipt', onclick: () => save('receipt', m) }, 'Use for receipts (영수증에)'),
          r.err ? null : h('button', { type: 'button', class: 'btn secondary sm', 'data-use': 'ai', onclick: () => save('ai', m) }, 'Use for AI (AI에)'));
      })) : null,
      modelUi.err ? h('div', { class: 'err', id: 'set-model-err', role: 'alert' }, modelUi.err) : null,
      h('h3', { class: 'set-sub' }, 'Other model name (직접 입력)'),
      h('div', { class: 'map-row add' }, customIn,
        h('button', { type: 'button', class: 'btn secondary', id: 'set-model-use-r', onclick: () => useCustom('receipt') }, 'Receipts (영수증)'),
        h('button', { type: 'button', class: 'btn secondary', id: 'set-model-use-a', onclick: () => useCustom('ai') }, 'AI')),
      note('If the chosen model does not work, the server tries the next one automatically, so nothing breaks (고른 모델이 안 되면 서버가 알아서 다음 모델로 넘어가요). Speed depends on the time of day and your free quota (속도는 시간대와 무료 사용량에 따라 달라져요).')
    ];
  });

  // ═════ 7. 규칙 (rulesui.js) ═════
  const secRules = rulesCard(Object.assign({}, api, { icon }));

  // ═════ 8. 설치 · 업데이트 ═════
  const secInstall = live('set-install', (redraw, self) => {
    const standalone = pwa.isStandalone();
    const ios = pwa.isIOS();
    const online = pwa.isOnline();
    const upd = self.__upd || { text: '', err: false, reg: null };
    const unsub = () => installSubs.delete(self.__sub);
    if (!self.__sub) { self.__sub = () => { if (!self.isConnected) { unsub(); return; } redraw(); }; installSubs.add(self.__sub); }
    let how;
    if (standalone) how = h('div', { class: 'set-pill ok', id: 'set-installed' }, 'Installed — running as an app (앱으로 설치되어 실행 중)');
    else if (ios) {
      how = h('div', { id: 'set-ios' },
        h('p', { class: 'set-note first' }, 'iPhone / iPad: add it to your Home Screen to use it like an app (홈 화면에 추가하면 앱처럼 쓸 수 있어요).'),
        h('ol', { class: 'set-steps' },
          h('li', null, 'Open this page in Safari (사파리에서 이 페이지를 엽니다).'),
          h('li', null, 'Tap the Share button ', h('span', { class: 'set-inl' }, icon('open', 16)), ' (아래 또는 위의 공유 버튼 □↑ 을 누릅니다).'),
          h('li', null, 'Choose "Add to Home Screen" (홈 화면에 추가를 고릅니다).'),
          h('li', null, 'Tap Add (추가). 이제 홈 화면의 Home Ledger 아이콘으로 엽니다.')));
    } else if (installPrompt) {
      how = h('div', null, h('p', { class: 'set-note first' }, 'Install it as an app on this device (이 기기에 앱으로 설치할 수 있어요).'),
        h('div', { class: 'btnrow' }, h('button', {
          type: 'button', class: 'btn', id: 'set-install-btn',
          onclick: async () => { const p = installPrompt; installPrompt = null; const r = p ? await p() : 'unavailable'; self.__upd = { text: r === 'accepted' ? 'Installed (설치했어요)' : 'Not installed (설치하지 않았어요)', err: false }; redraw(); }
        }, icon('download', 18), 'Install app (앱 설치)')));
    } else {
      how = h('p', { class: 'set-note first', id: 'set-install-hint' }, 'Android / Chrome: open the browser menu ⋮ and choose "Install app" or "Add to Home screen" (브라우저 메뉴 ⋮ 에서 "앱 설치" 또는 "홈 화면에 추가"를 고르세요). The install button appears here when your browser allows it (브라우저가 허용하면 여기에 설치 버튼이 나타납니다).');
    }
    const doCheck = async () => {
      self.__upd = { text: 'Checking… (확인 중)', err: false }; redraw();
      let r;
      try { r = await checkUpdate(); } catch (e) { r = { state: 'error', error: msg(e) }; }
      self.__upd = r.state === 'ready' ? { text: 'A new version is ready (새 버전이 준비됐어요).', err: false, reg: r.reg }
        : r.state === 'latest' ? { text: 'You have the latest version (최신 버전입니다).', err: false }
          : r.state === 'nosw' ? { text: 'This browser has no automatic updates here — reload the page to get the newest version (이 환경에서는 자동 업데이트가 없어요. 페이지를 새로고침하면 최신 버전을 받습니다).', err: false, reload: true }
            : r.state === 'offline' ? { text: 'Could not check — are you offline? (확인하지 못했어요. 인터넷 연결을 확인하세요)', err: true }
              : { text: '확인하지 못했습니다: ' + (r.error || ''), err: true };
      redraw();
    };
    return [
      head('download', 'Install & updates', '설치 · 업데이트'),
      how,
      kv('App version (앱 버전)', 'v' + CONFIG.APP_VERSION, 'set-version'),
      kv('Connection (연결)', online ? 'Online (온라인)' : 'Offline (오프라인)', 'set-online'),
      h('div', { class: 'btnrow' },
        h('button', { type: 'button', class: 'btn secondary', id: 'set-check-update', onclick: doCheck }, icon('sync', 18), 'Check for update (업데이트 확인)'),
        upd.reg ? h('button', { type: 'button', class: 'btn', id: 'set-apply-update', onclick: () => applyUpdate(upd.reg) }, 'Reload now (지금 새로 불러오기)') : null,
        upd.reload ? h('button', { type: 'button', class: 'btn', id: 'set-reload', onclick: () => { try { location.reload(); } catch (e) { /* ignore */ } } }, 'Reload (새로고침)') : null),
      upd.text ? h('div', { class: upd.err ? 'err' : 'ok-hint', id: 'set-update-msg', role: 'status' }, upd.text) : null,
      note('Works offline: you can add transactions without internet; they upload when you are back online (인터넷이 없어도 입력할 수 있고, 연결되면 자동으로 시트에 전송됩니다).')
    ];
  });

  // ═════ 9. 데이터 ═════
  const secData = live('set-data', () => [
    head('sheet', 'Data', '데이터'),
    h('div', { class: 'btnrow stack' },
      h('button', {
        type: 'button', class: 'btn secondary', id: 'set-reload-sheet',
        onclick: async () => { if (window.confirm('Reload everything from the sheet? (시트에서 전부 다시 불러올까요?) 전송 대기 중인 항목은 유지됩니다.')) { try { await SY.reloadFromSheet(); toast('Reloaded (다시 불러왔어요)'); } catch (e) { toast('불러오지 못했습니다: ' + msg(e)); } } }
      }, icon('sync', 18), 'Reload from sheet (시트에서 다시 불러오기)'),
      h('a', { class: 'btn secondary', id: 'set-open-sheet', href: 'https://docs.google.com/spreadsheets/d/' + CONFIG.SHEET_ID + '/edit', target: '_blank', rel: 'noopener' }, icon('open', 18), 'Open Google Sheet (시트 열기)'),
      h('button', {
        type: 'button', class: 'btn', id: 'set-csv',
        onclick: () => {
          try { downloadText('homeledger-' + L.todayStr() + '.csv', buildCsv(api.items), 'text/csv;charset=utf-8'); toast('CSV downloaded (거래 ' + api.items.length + '건을 내려받았어요)'); } catch (e) { toast('Download not supported (이 기기에서는 내려받기가 안 됩니다)'); }
        }
      }, icon('download', 18), 'Download all transactions as CSV (거래 전체 CSV 백업)')),
    note('The CSV has date, merchant, amount in CAD (spending is negative), category, account, owner and memo (날짜 · 가맹점 · 금액(CAD, 지출은 −) · 카테고리 · 계좌 · 소유자 · 메모). Your real backup is the Google Sheet (진짜 원본은 구글 시트입니다).')
  ]);

  // ═════ 10. 이전 장부 가져오기 (migrate.js) ═════
  const secMigrate = live('set-migrate', (redraw, self) => {
    const pl = self.__plan || null;
    const total = pl ? pl.counts.Transactions : 0;
    const readFile = (file) => {
      if (!file) return;
      self.__err = ''; self.__done = null; self.__plan = null;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const f = MG.parseFile(String(rd.result || ''));
          self.__plan = MG.plan(f, { accounts: api.data.accounts, txns: api.data.txns, postings: api.data.postings, rules: api.data.rules, budgets: api.data.budgets, settings: api.data.settings });
        } catch (e) { self.__err = msg(e); }
        redraw();
      };
      rd.onerror = () => { self.__err = '파일을 읽지 못했습니다. (Could not read the file)'; redraw(); };
      rd.readAsText(file);
    };
    const doImport = async () => {
      self.__busy = true; self.__err = ''; self.__prog = '0 / ' + total; redraw();
      try {
        const res = await MG.apply(pl, (puts, order) => SY.saveBatch(puts, order), (d, t) => { self.__prog = d + ' / ' + t; const el = document.getElementById('set-mig-prog'); if (el) el.textContent = self.__prog; });
        self.__done = res; self.__plan = null; self.__busy = false;
        try { await api.reload(); } catch (e) { /* ignore */ }
        redraw();
        toast('Imported ' + res.transactions + ' transactions (거래 ' + res.transactions + '건을 가져왔어요)');
      } catch (e) { self.__busy = false; self.__err = msg(e); redraw(); }
    };
    const row = (en, ko, n, skip) => h('div', { class: 'set-kv' }, h('span', { class: 'k' }, en + ' (' + ko + ')'), h('span', { class: 'v' }, String(n) + (skip ? ' · already there ' + skip + ' (이미 있음 ' + skip + ')' : '')));
    return [
      head('download', 'Import old ledger', '이전 장부 가져오기'),
      note('Load the migration file (homeledger-migration.json) from your old Artifacts ledger. Only items that are not in the sheet yet are added, so it is safe to try twice (이전 Artifacts 장부에서 만든 파일을 불러옵니다. 시트에 없는 것만 추가되어 두 번 눌러도 중복되지 않아요).'),
      h('label', { class: 'btn secondary set-file', for: 'set-mig-file' }, icon('download', 18), 'Choose file (파일 선택)'),
      h('input', { type: 'file', id: 'set-mig-file', accept: '.json,application/json', class: 'set-file-in', onchange: (e) => readFile(e.target.files && e.target.files[0]) }),
      self.__err ? h('div', { class: 'err', id: 'set-mig-err', role: 'alert' }, self.__err) : null,
      pl ? h('div', { id: 'set-mig-plan' },
        row('Transactions', '거래', pl.counts.Transactions, pl.skipped.Transactions),
        row('Entries', '분개', pl.counts.Postings, pl.skipped.Postings),
        row('New accounts', '새 계정', pl.counts.Accounts, pl.skipped.Accounts),
        row('Rules', '규칙', pl.counts.Rules, pl.skipped.Rules),
        row('Budgets', '예산', pl.counts.Budgets, pl.skipped.Budgets),
        row('Settings', '설정', pl.counts.Settings, pl.skipped.Settings),
        pl.from ? kv('Period (기간)', pl.from + ' → ' + pl.to) : null,
        pl.missing.length ? h('div', { class: 'err', role: 'alert' }, '시트에 없는 계정이 있어요: ' + pl.missing.join(', ') + '. (Accounts missing in the sheet)') : null,
        h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn', id: 'set-mig-go', disabled: !!self.__busy || !!pl.missing.length || !(pl.counts.Transactions || pl.counts.Accounts || pl.counts.Settings || pl.counts.Rules || pl.counts.Budgets), onclick: doImport },
          self.__busy ? 'Importing… (가져오는 중) ' : 'Import now (지금 가져오기)', self.__busy ? h('span', { id: 'set-mig-prog' }, self.__prog || '') : null)),
        pl.counts.Transactions === 0 && !pl.counts.Accounts ? h('div', { class: 'ok-hint' }, 'Nothing new to add (새로 추가할 항목이 없어요).') : null) : null,
      self.__done ? h('div', { class: 'ok-hint', id: 'set-mig-done', role: 'status' }, 'Done: ' + self.__done.transactions + ' transactions, ' + self.__done.postings + ' entries (완료: 거래 ' + self.__done.transactions + '건, 분개 ' + self.__done.postings + '건). Check Summary and Accounts next (써머리와 계정 탭을 확인하세요).') : null,
      note('Transfers that could not be matched are parked in "Passthrough Clearing" (짝이 없는 이체는 "전달 자금" 계정에 임시로 들어 있어요). Review them from the Transactions tab (거래 탭에서 확인하세요).')
    ];
  });

  // ═════ 이체 자동 연결 (xfermatch.js) ═════
  const secXfer = live('set-xfer', (redraw) => {
    const on = XF.isAutoMatchOn();
    let pend = 0;
    try { pend = XF.pendingSuggestions(api.items, api.accMap, api.data.settings, api.data.stmtLines).length; } catch (e) { pend = 0; }
    return [
      head('transfer', 'Transfers between accounts', '계좌 간 이체'),
      h('div', { class: 'set-switchrow' },
        h('div', null, h('b', null, 'Link transfers automatically (이체 자동 연결)'),
          h('div', { class: 'hint' }, 'When the same amount goes out of one account and into another within a few days, it becomes one Transfer — also when the other statement is uploaded later (같은 금액이 며칠 안에 한 계좌에서 나가고 다른 계좌로 들어오면 하나의 이체로 합쳐요. 다른 쪽 명세서를 나중에 올려도 새로고침 때 자동으로 연결돼요).')),
        h('button', { type: 'button', class: 'set-switch' + (on ? ' on' : ''), id: 'set-xfer-toggle', role: 'switch', 'aria-checked': String(on), 'aria-label': 'Link transfers automatically (이체 자동 연결)',
          onclick: () => { XF.setAutoMatchOn(!on); toast(!on ? 'Auto-link on (자동 연결 켬)' : 'Auto-link off (자동 연결 끔)'); redraw(); if (!on) { try { XF.autoMatch && api.reload && api.reload(); } catch (e) { /* ignore */ } } } }, h('i'))),
      kv('Possible transfers to check (확인할 이체 후보)', String(pend), 'set-xfer-pend'),
      note('Possible transfers that are not certain are listed at the top of the Ledger tab for you to confirm (확실하지 않은 후보는 거래 탭 맨 위에서 확인할 수 있어요). Linked transfers can be unlinked from their details (연결된 이체는 상세 화면에서 풀 수 있어요).')
    ];
  });

  // ═════ 급여일 연동 입력 (paybundle.js) ═════
  const secPay = live('set-pay', (redraw) => {
    const cfg = PB.readCfg(api.data.settings);
    const on = !!(cfg && cfg.enabled !== false);
    const names = (id) => { const a = api.accMap.get(String(id)); return a ? a.name : String(id); };
    const runApi = () => ({ state: api.state, reload: api.reload, renderBody: api.rerender, toast });
    const save = async (next, msg) => {
      await api.saveSettings(PB.cfgRow(api.data.settings, next, L.nowIso()));
      if (msg) toast(msg);
    };
    const detect = () => PB.detectFromHistory(api.items, api.accMap, (cfg && cfg.trigger) || PB.DEFAULT_TRIGGER);
    const turnOn = async () => {
      if (cfg) { await save(Object.assign({}, cfg, { enabled: !on }), !on ? 'Pay-day entries on (급여일 연동 켬)' : 'Pay-day entries off (급여일 연동 끔)'); }
      else {
        const det = detect();
        if (!det.length) { toast('No linked items found in your history yet (이력에서 연동 항목을 아직 못 찾았어요)'); return; }
        await save({ enabled: true, trigger: PB.DEFAULT_TRIGGER, since: PB.defaultSince(), items: det }, 'Pay-day entries on (급여일 연동 켬)');
      }
      if (!on) PB.autoRun(runApi());
    };
    const itemRow = (it, i) => {
      const upd = (patch) => save(Object.assign({}, cfg, { items: cfg.items.map((x, j) => (j === i ? Object.assign({}, x, patch) : x)) }));
      return h('div', { class: 'pay-item', 'data-key': it.key },
        h('div', { class: 'pay-main' },
          h('b', null, it.label),
          h('div', { class: 'hint' }, names(it.incomeId) + ' → ' + names(it.assetId) + ' · ' + L.fmtMoney(it.amount || 0, 'CAD'))),
        h('div', { class: 'pay-checks' },
          h('label', { class: 'pay-chk' }, h('input', { type: 'checkbox', class: 'pay-on', checked: it.on !== false, onchange: (e) => upd({ on: e.target.checked }) }), h('span', null, 'Add (추가)')),
          h('label', { class: 'pay-chk' }, h('input', { type: 'checkbox', class: 'pay-sav', checked: !!it.saving, onchange: (e) => upd({ saving: e.target.checked }) }), h('span', null, '+ (Saving) entry (저축 짝)'))));
    };
    return [
      head('transfer', 'Pay-day linked entries', '급여일 연동 입력'),
      h('div', { class: 'set-switchrow' },
        h('div', null, h('b', null, 'Add them automatically on pay day (급여일에 자동으로 추가)'),
          h('div', { class: 'hint' }, 'When a pay entry such as TD PAY is recorded, the employer-plan entries (EOP, DC Pension…) are added on the same date with the last amount (급여가 기록되면 같은 날짜에 회사 적립금 항목을 직전 금액으로 함께 넣어요). If an amount changes, just edit that entry (금액이 달라지면 해당 거래만 고치면 돼요).')),
        h('button', { type: 'button', class: 'set-switch' + (on ? ' on' : ''), id: 'set-pay-toggle', role: 'switch', 'aria-checked': String(on), 'aria-label': 'Add pay-day entries automatically (급여일 연동 자동 입력)', onclick: turnOn }, h('i'))),
      cfg ? [
        h('div', { class: 'pay-fields' },
          h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Pay entry name (급여 거래 이름)'),
            h('input', { type: 'text', id: 'set-pay-trigger', autocomplete: 'off', autocapitalize: 'off', value: cfg.trigger || PB.DEFAULT_TRIGGER, onchange: (e) => save(Object.assign({}, cfg, { trigger: e.target.value.trim() || PB.DEFAULT_TRIGGER })) })),
          h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Fill in from (이 날짜부터 채우기)'),
            h('input', { type: 'date', id: 'set-pay-since', value: cfg.since || '', onchange: (e) => { if (e.target.value) save(Object.assign({}, cfg, { since: e.target.value })); } }))),
        h('div', { class: 'pay-list', id: 'set-pay-list' }, (cfg.items || []).length ? cfg.items.map(itemRow) : h('div', { class: 'hint' }, 'No items yet (아직 항목이 없어요).')),
        h('div', { class: 'btnrow' },
          h('button', { type: 'button', class: 'btn secondary sm', id: 'set-pay-detect', onclick: async () => {
            const r = PB.mergeDetected(cfg, detect());
            if (!r.added) { toast('No new items found (새 항목이 없어요)'); return; }
            await save(r.cfg, 'Found ' + r.added + ' new item(s) (새 항목 ' + r.added + '개를 찾았어요)');
          } }, 'Find items from history (이력에서 항목 찾기)'),
          h('button', { type: 'button', class: 'btn sm', id: 'set-pay-run', disabled: !on, onclick: async () => {
            const n = await PB.autoRun(runApi());
            if (!n) toast('Nothing to add — all pay days are filled (추가할 게 없어요 — 모든 급여일이 채워져 있어요)');
          } }, 'Fill in now (지금 채우기)'))
      ] : null,
      note('Entries you delete are not added again (지운 항목은 다시 만들지 않아요). Existing entries are never changed (이미 있는 거래는 건드리지 않아요).')
    ];
  });

  // ═════ 배치 ═════
  const grid = h('div', { class: 'settings-grid set-wrap' }, secAccount, secAppearance, secSecurity, secFamily, secCurrency, secAi, secModel, secReceipts, secXfer, secPay, categoriesCard(api, icon), secInstall, secData, secMigrate, secRules);   // 규칙 카드는 길어서 맨 아래 (접어 둠)
  root.append(h('div', { class: 'page set-page', }, grid,
    h('div', { class: 'set-foot' },
      h('div', { class: 'muted small', id: 'set-foot-ver' }, 'Home Ledger v' + CONFIG.APP_VERSION),
      h('div', { class: 'muted small' }, 'Personal budgeting tool — not financial, tax or legal advice (개인용 가계부이며 세무·회계·법률 자문이 아닙니다).'))));
  return root;
}

// ───────── 업데이트 확인 / 적용 ─────────
async function checkUpdate() {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
  if (!sw || !sw.getRegistration) return { state: 'nosw' };
  const reg = await sw.getRegistration();
  if (!reg) return { state: 'nosw' };
  try { await reg.update(); } catch (e) { return { state: 'offline' }; }
  if (reg.waiting) return { state: 'ready', reg };
  if (reg.installing) {
    const w = reg.installing;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 8000);
      w.addEventListener('statechange', () => { if (w.state === 'installed' || w.state === 'activated' || w.state === 'redundant') { clearTimeout(t); resolve(); } });
    });
    if (reg.waiting) return { state: 'ready', reg };
  }
  return { state: 'latest' };
}
function applyUpdate(reg) {
  const sw = navigator.serviceWorker;
  let done = false;
  const go = () => { if (done) return; done = true; try { location.reload(); } catch (e) { /* ignore */ } };
  try { sw.addEventListener('controllerchange', go); } catch (e) { /* ignore */ }
  try { (reg.waiting || reg.installing || reg.active).postMessage('skip-waiting'); } catch (e) { go(); }
  setTimeout(go, 3000);
}

export { checkUpdate };
