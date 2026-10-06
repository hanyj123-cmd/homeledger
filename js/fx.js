// 환율(캐나다 중앙은행 Valet API, 예비: Frankfurter). 모든 환율은 "외화 1단위 = 몇 CAD" 입니다.
//  - 순수 함수(parse*, rowsToSave, rateOn)와 네트워크 함수(fetchRates, maybeAutoUpdate)로 나뉘고,
//    fetch 는 주입할 수 있어서 테스트에서 가짜로 바꿀 수 있습니다.
import { CONFIG } from './config.js';
import { nowIso, truthy, num } from './ledger.js';
import * as Store from './store.js';

export const BOC_URL = 'https://www.bankofcanada.ca/valet/observations/';
export const FRANKFURTER_URL = 'https://api.frankfurter.app/';
export const AUTO_UPDATE_EVERY_MS = 20 * 3600e3;   // 자동 갱신은 20시간에 한 번
export const RETRY_AFTER_FAIL_MS = 1 * 3600e3;     // 실패하면 1시간 동안은 다시 시도하지 않음
export const OUTLIER_LIMIT = 0.30;                  // 직전 값보다 30% 넘게 다르면 이상값으로 보고 건너뜀
const OUTLIER_WINDOW_DAYS = 14;                     // 직전 값이 이 기간 안일 때만 비교
const FETCH_TIMEOUT_MS = 15000;

export const defaultCurrencies = () => CONFIG.CURRENCIES.filter((c) => c !== CONFIG.BASE_CCY);
const validRate = (x) => typeof x === 'number' && isFinite(x) && x > 0;
const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

// ── 날짜 도우미 (YYYY-MM-DD, UTC 기준)
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const toMs = (now) => (now === undefined || now === null ? Date.now() : (typeof now === 'number' ? now : new Date(now).getTime()));
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

// ── 파싱 ──────────────────────────────────────────────────────────────
// BOC: {observations:[{d:'2026-10-02', FXUSDCAD:{v:'1.3912'}, ...}]} → [{date, currency, rate, source:'BOC'}]
export function parseBoc(json) {
  const out = [];
  const obs = (json && json.observations) || [];
  obs.forEach((o) => {
    if (!o || !isDate(o.d)) return;
    Object.keys(o).forEach((k) => {
      const m = /^FX([A-Z]{3})CAD$/.exec(k);
      if (!m || !o[k]) return;
      const rate = parseFloat(o[k].v);
      if (!validRate(rate)) return;
      out.push({ date: o.d, currency: m[1], rate, source: 'BOC' });
    });
  });
  return out;
}

// Frankfurter: {rates:{'2026-10-02':{CAD:1.39}}} → 같은 모양, source:'FRANKFURTER'
export function parseFrankfurter(json, ccy) {
  const out = [];
  const rates = (json && json.rates) || {};
  Object.keys(rates).forEach((d) => {
    if (!isDate(d) || !rates[d]) return;
    const rate = typeof rates[d].CAD === 'string' ? parseFloat(rates[d].CAD) : rates[d].CAD;
    if (!validRate(rate)) return;
    out.push({ date: d, currency: ccy, rate, source: 'FRANKFURTER' });
  });
  return out;
}

// ── 네트워크 ───────────────────────────────────────────────────────────
async function getJson(fetchFn, url) {
  let timer = null;
  const init = {};
  if (typeof AbortController !== 'undefined') {
    const ac = new AbortController();
    init.signal = ac.signal;
    timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  }
  try {
    const res = await fetchFn(url, init);
    if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const bocUrl = (since, currencies) => BOC_URL + currencies.map((c) => 'FX' + c + 'CAD').join(',') + '/json?start_date=' + since;
export const frankfurterUrl = (since, ccy) => FRANKFURTER_URL + since + '..?base=' + ccy + '&symbols=CAD';

// since: 'YYYY-MM-DD' (이 날짜부터). 돌려주는 값: [{date, currency, rate, source}]
// BOC 를 먼저 시도하고, 못 받은 통화만 Frankfurter 로 채웁니다. 전부 실패하면 한글 메시지의 Error.
export async function fetchRates(opts) {
  const o = opts || {};
  const fetchFn = o.fetchFn || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  const currencies = (o.currencies || defaultCurrencies()).filter((c) => c !== CONFIG.BASE_CCY);
  const since = isDate(o.since) ? o.since : ymd(Date.now() - 30 * 86400e3);
  if (!fetchFn) throw new Error('환율을 가져올 수 없습니다. (네트워크 기능 없음)');
  if (!currencies.length) return [];
  let rows = [];
  let missing = currencies.slice();
  let bocErr = null;
  try {
    const json = await getJson(fetchFn, bocUrl(since, currencies));
    rows = parseBoc(json).filter((r) => currencies.includes(r.currency));
    const got = new Set(rows.map((r) => r.currency));
    // 관측값이 하나도 없으면(주말·휴일 등) 정상적으로 "새 값 없음", 일부 통화만 빠졌으면 그 통화만 예비로 채움
    missing = ((json && json.observations) || []).length ? currencies.filter((c) => !got.has(c)) : [];
  } catch (e) {
    bocErr = e;
  }
  let fbErr = null;
  let fbOk = 0;
  for (const c of missing) {
    try {
      const json = await getJson(fetchFn, frankfurterUrl(since, c));
      rows = rows.concat(parseFrankfurter(json, c));
      fbOk++;
    } catch (e) {
      fbErr = e;
    }
  }
  if (!rows.length && (bocErr || fbErr) && !fbOk) {
    throw new Error('환율을 가져오지 못했습니다. 인터넷 연결을 확인하고 잠시 후 다시 시도해 주세요. (캐나다 중앙은행·Frankfurter 모두 응답 없음)');
  }
  return rows;
}

// ── 계산 ──────────────────────────────────────────────────────────────
// fxRates(시트 FxRates 행들)에서 ccy 의 date 이전(포함) 가장 최근 환율. 없으면 가장 최근 값, 그래도 없으면 null.
// CAD 는 항상 1. (ledger.latestRate 와 같은 규칙: 삭제/0 이하 값은 무시, 같은 날짜가 여럿이면 먼저 나온 행)
export function rateOn(fxRates, ccy, date) {
  if (ccy === CONFIG.BASE_CCY) return 1;
  let on = null;
  let latest = null;
  (fxRates || []).forEach((r) => {
    if (truthy(r.deleted) || r.currency !== ccy || !(num(r.rate) > 0)) return;
    const d = String(r.date);
    if (!latest || d > String(latest.date)) latest = r;
    if (date && d <= String(date) && (!on || d > String(on.date))) on = r;
  });
  const hit = on || latest;
  return hit ? num(hit.rate) : null;
}

// 가져온 값 중에서 "저장할 새 행"만 골라 FxRates 시트 행으로 만듭니다.
//  - 같은 fx_id 가 이미 있으면(지운 행 포함) 건너뜀 → 몇 번을 불러도 같은 결과
//  - 같은 날짜·통화로 직접 입력한 행이 있으면 그 값을 우선
//  - 0 이하/무한대 값, 직전 값(14일 이내)과 30% 넘게 다른 값은 건너뜀
export function rowsToSave(fetchedRows, existingFxRates, opts) {
  const now = (opts && opts.now) || nowIso();
  const existing = existingFxRates || [];
  const ids = new Set(existing.map((r) => String(r.fx_id)));
  const dayKey = new Set(existing.filter((r) => !truthy(r.deleted)).map((r) => r.currency + '|' + r.date));
  const seen = new Set();
  const cands = (fetchedRows || []).filter((r) => r && isDate(r.date) && r.currency && validRate(Number(r.rate)))
    .map((r) => Object.assign({}, r, { rate: Number(r.rate) }))
    .sort((a, b) => (a.currency === b.currency ? (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) : (a.currency < b.currency ? -1 : 1)));
  const out = [];
  const prev = {}; // 통화별 직전 값 {date, rate}
  const prior = (ccy, date) => {
    let best = null;
    existing.forEach((r) => {
      if (truthy(r.deleted) || r.currency !== ccy || !(num(r.rate) > 0) || String(r.date) >= date) return;
      if (!best || String(r.date) > best.date) best = { date: String(r.date), rate: num(r.rate) };
    });
    return best;
  };
  cands.forEach((r) => {
    const id = 'fx_' + r.date + '_' + r.currency;
    if (ids.has(id) || seen.has(id) || dayKey.has(r.currency + '|' + r.date)) return;
    seen.add(id);
    let p = prior(r.currency, r.date);
    const q = prev[r.currency];
    if (q && (!p || q.date > p.date)) p = q;
    if (p && p.date >= addDays(r.date, -OUTLIER_WINDOW_DAYS) && Math.abs(r.rate / p.rate - 1) > OUTLIER_LIMIT) return;
    prev[r.currency] = { date: r.date, rate: r.rate };
    out.push({ fx_id: id, date: r.date, currency: r.currency, rate: r.rate, source: r.source || '', updated_at: now, deleted: false });
  });
  return out;
}

// ── 자동 갱신 ──────────────────────────────────────────────────────────
// 앱을 열 때 부르면 됩니다. 20시간에 한 번만 실제로 가져오고, 절대 예외를 던지지 않습니다.
// 돌려주는 값: 새로 저장한 행 수 (실패/건너뜀이면 0)
export async function maybeAutoUpdate(opts) {
  const o = opts || {};
  const store = o.store || Store;
  const nowMs = toMs(o.now);
  const metaGet = async (k) => { try { return Number(await store.getMeta(k)) || 0; } catch (e) { return 0; } };
  const metaSet = async (k, v) => { try { await store.setMeta(k, v); } catch (e) { /* 무시 */ } };
  if (typeof o.saveRows !== 'function') return 0;
  try {
    const last = await metaGet('fx:last');
    if (last && nowMs - last >= 0 && nowMs - last < AUTO_UPDATE_EVERY_MS) return 0;
    const fail = await metaGet('fx:lastFail');
    if (fail && nowMs - fail >= 0 && nowMs - fail < RETRY_AFTER_FAIL_MS) return 0;
    const existing = o.fxRates || [];
    const currencies = o.currencies || defaultCurrencies();
    // 가장 "뒤처진" 통화 기준으로 3일 전부터. 한 번도 못 받은 통화가 있으면 30일 전부터.
    const latestOf = (c) => existing.reduce((m, r) => (!truthy(r.deleted) && r.currency === c && String(r.date) > m ? String(r.date) : m), '');
    const lasts = currencies.map(latestOf);
    const since = !lasts.length || lasts.some((d) => !d) ? ymd(nowMs - 30 * 86400e3) : addDays(lasts.reduce((m, d) => (d < m ? d : m)), -3);
    const fetched = await fetchRates({ fetchFn: o.fetchFn, since, currencies });
    const rows = rowsToSave(fetched, existing, { now: new Date(nowMs).toISOString() });
    if (rows.length) await o.saveRows(rows);
    await metaSet('fx:last', nowMs);
    return rows.length;
  } catch (e) {
    await metaSet('fx:lastFail', nowMs);
    return 0;
  }
}
