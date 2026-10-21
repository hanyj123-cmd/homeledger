// Settings 시트에 JSON 으로 저장하는 "가계부 설정" 도우미.
//  - 대출·자산·부채(이율/한도)·주식·재산세·사용자(Ms Kim 구분)·월별 메모·계획 설정 등
// 모두 Settings 시트의 (key, value) 한 줄이라서, 폰·아이패드·컴퓨터가 똑같이 보고 같이 고칩니다.
import * as L from './ledger.js';

export const KEYS_META = {
  loans: 'meta.loans',        // { 계정id: {p, pmt, start, months} }
  debts: 'meta.debts',        // { 계정id: {apr, limit, min} }
  assets: 'meta.assets',      // { 계정id: {method, cost, date, rate, salvage, life, override} }
  holdings: 'meta.holdings',  // [{sym, shares, book, acct}]
  prices: 'meta.prices',      // { TD.TO: {price, at, ccy, prev?:{price, at}} } prev = 이전 날짜의 시세 (어제 대비 표시용)
  buys: 'meta.buys',          // [{id, date, sym, acct, shares, cost, note}] 주식 매수 기록 (2주마다 사는 것 등)
  accrual: 'meta.accrual',    // {annual, since, opening, code, acct}
  users: 'meta.users',        // { 'email@x.com': 'Ms Kim' }
  plan: 'meta.plan',          // {extra, strategy, growth, horizon}
  ai: 'meta.ai',              // {enabled}
  gemini: 'meta.gemini',      // {receipt:'모델', ai:'모델'} ('' = 자동)
  fcplan: 'meta.fcplan'       // { cells: { 'YYYY-MM': { 계정id: 금액 } } } 올해 남은 달 상향식 예측
};
export const NOTE_PREFIX = 'note.';
export const SNAP_PREFIX = 'snap.';   // 'snap.2026-09' = 그 달 말 주식 기록 { at, rows:[{sym, acct, shares, book, price, ccy, orig?, fx?}] } (한 달에 한 줄)
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export function rawRow(settings, key) {
  return (settings || []).find((r) => String(r.key) === String(key) && !L.truthy(r.deleted)) || null;
}
export function readJson(settings, key, fallback) {
  const r = rawRow(settings, key);
  if (!r || r.value === undefined || r.value === '') return clone(fallback);
  if (typeof r.value === 'object') return clone(r.value);
  try { const v = JSON.parse(String(r.value)); return v === null || v === undefined ? clone(fallback) : v; } catch (e) { return clone(fallback); }
}
/** 저장할 Settings 행 (같은 key 는 언제나 같은 행 → 덮어씀) */
export function metaRow(settings, key, value, note, now) {
  const old = (settings || []).find((r) => String(r.key) === String(key)) || {};
  return Object.assign({ note: '' }, old, { key, value: JSON.stringify(value), note: note !== undefined ? note : (old.note || ''), updated_at: now || L.nowIso(), deleted: false });
}
export function deleteRow(settings, key, now) {
  const old = (settings || []).find((r) => String(r.key) === String(key));
  return old ? Object.assign({}, old, { value: '', updated_at: now || L.nowIso(), deleted: true }) : null;
}

/** 모든 설정을 한 번에 읽기 */
export function readAll(settings) {
  return {
    loans: readJson(settings, KEYS_META.loans, {}),
    debts: readJson(settings, KEYS_META.debts, {}),
    assets: readJson(settings, KEYS_META.assets, {}),
    holdings: readJson(settings, KEYS_META.holdings, []),
    prices: readJson(settings, KEYS_META.prices, {}),
    buys: readBuys(settings),
    snaps: readSnaps(settings),
    accrual: readJson(settings, KEYS_META.accrual, null),
    users: readJson(settings, KEYS_META.users, {}),
    plan: Object.assign({ extra: 0, strategy: 'avalanche', growth: 3, horizon: 12 }, readJson(settings, KEYS_META.plan, {})),
    ai: Object.assign({ enabled: true }, readJson(settings, KEYS_META.ai, {})),
    gemini: Object.assign({ receipt: '', ai: '' }, readJson(settings, KEYS_META.gemini, {}))
  };
}
/** 주식 매수 기록 (날짜 오름차순). 깨진 줄은 건너뜁니다. */
export function readBuys(settings) {
  const v = readJson(settings, KEYS_META.buys, []);
  return (Array.isArray(v) ? v : []).filter((b) => b && typeof b === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) && b.sym)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
/** 월말 주식 기록: { 'YYYY-MM': { at, rows:[...] } } */
export function readSnaps(settings) {
  const out = {};
  (settings || []).forEach((r) => {
    const k = String(r.key || '');
    if (k.indexOf(SNAP_PREFIX) !== 0 || L.truthy(r.deleted)) return;
    const ym = k.slice(SNAP_PREFIX.length);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return;
    const v = readJson(settings, k, null);
    if (v && typeof v === 'object' && Array.isArray(v.rows)) out[ym] = v;
  });
  return out;
}
export function snapRow(settings, ym, snap, now) {
  return metaRow(settings, SNAP_PREFIX + ym, snap, 'month-end stocks', now);
}
export function snapDeleteRow(settings, ym, now) { return deleteRow(settings, SNAP_PREFIX + ym, now); }

/** 월별 메모 */
export function readNote(settings, ym) {
  const r = rawRow(settings, NOTE_PREFIX + ym);
  return r ? String(r.value || '') : '';
}
export function noteRow(settings, ym, text, now) {
  const t = String(text || '').trim();
  if (!t) return deleteRow(settings, NOTE_PREFIX + ym, now);
  const old = (settings || []).find((r) => String(r.key) === NOTE_PREFIX + ym) || {};
  return Object.assign({ note: 'month note' }, old, { key: NOTE_PREFIX + ym, value: t.slice(0, 2000), updated_at: now || L.nowIso(), deleted: false });
}
/** 사용자(로그인 이메일) → 소유자 이름 */
export function ownerFor(users, email) {
  if (!email) return '';
  const e = String(email).toLowerCase();
  const k = Object.keys(users || {}).find((x) => x.toLowerCase() === e);
  return k ? users[k] : '';
}
