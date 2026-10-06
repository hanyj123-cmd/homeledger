// 동기화: 로컬(IndexedDB) ↔ 구글 시트.
//  - 저장은 먼저 로컬 + 전송 대기열에 즉시 기록 → 화면은 바로 갱신됩니다.
//  - 대기열은 인터넷/로그인이 될 때 시트로 올라갑니다. (오프라인에서도 입력 가능)
//  - 전송 전에 시트의 키 열을 다시 읽어, 같은 행을 두 번 추가하지 않도록 합니다.
import { CONFIG, KEYS, HEADERS } from './config.js';
import * as S from './store.js';
import * as api from './sheets.js';
import { getToken } from './auth.js';
import { truthy, num, nowIso } from './ledger.js';

const status = { phase: 'auth', pending: 0, lastSync: 0, error: '', lastPullRows: 0, lastPullTotal: 0, lastPullMode: '' };
const statusCbs = [];
const dataCbs = [];
let current = null;
let again = false;
let timer = null;

export function onStatus(cb) { statusCbs.push(cb); }
export function onData(cb) { dataCbs.push(cb); }
export function getStatus() { return Object.assign({}, status); }

function setStatus(patch) {
  Object.assign(status, patch);
  statusCbs.forEach((cb) => cb(getStatus()));
}
function notifyData() { dataCbs.forEach((cb) => cb()); }

// 화면에 보여줄 "대기 N건" = 아직 시트에 못 올린 거래 수
export async function refreshPending() {
  const ops = await S.getOutbox();
  const txnOps = ops.filter((o) => o.sheet === 'Transactions').reduce((n, o) => n + o.rows.length, 0);
  const n = txnOps || (ops.length ? 1 : 0);
  setStatus({ pending: n });
  return n;
}

export async function refreshStatus() {
  await refreshPending();
  if (!getToken() && status.phase !== 'syncing') setStatus({ phase: 'auth' });
}

export async function loadAll() {
  const [accounts, taxCodes, settings, rules, fxRates, txns, postings, profiles, stmtLines, receipts, lineItems, budgets] = await Promise.all(
    CONFIG.SYNC_SHEETS.map((s) => S.getAll(s))
  );
  accounts.sort((a, b) => num(a.sort_order) - num(b.sort_order));
  return { accounts, taxCodes, settings, rules, fxRates, txns, postings, profiles, stmtLines, receipts, lineItems, budgets };
}

async function pendingIds(sheet) {
  const ops = await S.getOutbox();
  const set = new Set();
  ops.forEach((op) => {
    if (op.sheet !== sheet) return;
    op.rows.forEach((r) => set.add(String(r[KEYS[sheet]])));
  });
  return set;
}

// 전체 읽기를 이 시간(12시간)마다 한 번은 강제로 합니다. (시트를 손으로 고친 경우 등 updated_at 이 안 바뀐 변경을 잡는 안전망)
export const FULL_PULL_MAX_AGE_MS = 12 * 3600e3;

async function fullPull(names) {
  const data = await api.pullSheets(names);
  let fetched = 0;
  for (const name of names) {
    const d = data[name];
    const protect = await pendingIds(name);
    await S.mergeRemote(name, d.rows, protect);
    await S.setMeta('rowIndex:' + name, d.rowIndex);
    await S.setMeta('headers:' + name, d.headers);
    fetched += d.rows.length;
  }
  return { fetched, total: fetched };
}

// 변경분만 읽기. 문제가 생기면 예외를 던지고, 호출한 쪽이 전체 읽기로 되돌아갑니다.
// 헤더를 모르거나 바뀌었거나 행 수가 절반 넘게 줄어든 시트는 그 시트만 전체로 읽습니다.
async function deltaPull(names) {
  const headers = {};
  for (const n of names) headers[n] = await S.getMeta('headers:' + n);
  const stamps = await api.pullStamps(names, headers);
  const fullNames = [];
  const plans = {};
  const rowsToGet = {};
  for (const n of names) {
    const st = stamps[n];
    if (!st || !st.usable || !st.headersMatch) { fullNames.push(n); continue; }
    const keyPath = KEYS[n];
    const local = new Map((await S.getAll(n)).map((r) => [String(r[keyPath]), r]));
    if (local.size > 0 && st.count < local.size * 0.5) { fullNames.push(n); continue; }
    const protect = await pendingIds(n);
    const need = [];
    Object.keys(st.rowIndex).forEach((key) => {
      if (protect.has(key)) return;
      const l = local.get(key);
      const ls = l && l.updated_at !== undefined && l.updated_at !== null ? String(l.updated_at) : '';
      if (!l || ls !== st.stamps[key]) need.push(st.rowIndex[key]);
    });
    plans[n] = { st, need };
    if (need.length) rowsToGet[n] = need;
  }
  const got = Object.keys(rowsToGet).length ? await api.pullRows(rowsToGet, headers) : {};
  const full = fullNames.length ? await api.pullSheets(fullNames) : {};
  // 읽는 사이에 시트 행이 밀렸다면(다른 기기가 삽입/삭제) 받은 행의 키가 다릅니다 → 예외 → 전체 읽기
  const upserts = {};
  for (const n of Object.keys(plans)) {
    const { st, need } = plans[n];
    const keyAt = {};
    Object.keys(st.rowIndex).forEach((k) => { keyAt[st.rowIndex[k]] = k; });
    upserts[n] = need.map((row) => {
      const obj = got[n] && got[n][row];
      if (!obj || obj[KEYS[n]] !== keyAt[row]) throw new Error('delta: 행 ' + n + '!' + row + ' 이(가) 그 사이 바뀌었습니다.');
      return obj;
    });
  }
  let fetched = 0;
  let total = 0;
  for (const n of Object.keys(plans)) {
    const { st } = plans[n];
    const protect = await pendingIds(n);
    await S.mergeRemote(n, upserts[n], protect, Object.keys(st.rowIndex));
    await S.setMeta('rowIndex:' + n, st.rowIndex);
    fetched += upserts[n].length;
    total += st.count;
  }
  for (const n of fullNames) {
    const d = full[n];
    const protect = await pendingIds(n);
    await S.mergeRemote(n, d.rows, protect);
    await S.setMeta('rowIndex:' + n, d.rowIndex);
    await S.setMeta('headers:' + n, d.headers);
    fetched += d.rows.length;
    total += d.rows.length;
  }
  return { fetched, total, fullSheets: fullNames };
}

// 다시 시도해도 똑같이 실패할 오류(로그인/권한/호출 한도/서버 오류)는 전체 읽기로 넘어가지 않고 그대로 알립니다.
function isRetryableByFull(e) {
  if (e instanceof api.AuthError) return false;
  const st = e && e.status;
  if (st === 403 || st === 429 || st >= 500) return false;
  return true;
}

// 시트 → 로컬. 평소에는 바뀐 행만 읽고(opts.full 이면 전부), 12시간마다/문제 시 전체를 읽습니다.
// 돌려주는 값: { mode: 'full'|'delta', fetched, total, fullSheets }
export async function pull(opts) {
  const names = CONFIG.SYNC_SHEETS;
  const lastFull = await S.getMeta('lastFullPull');
  const age = Date.now() - (Number(lastFull) || 0);
  let res = null;
  if (!(opts && opts.full) && lastFull && age >= 0 && age < FULL_PULL_MAX_AGE_MS) {
    try {
      res = await deltaPull(names);
      res.mode = 'delta';
    } catch (e) {
      if (!isRetryableByFull(e)) throw e;
      res = null;
    }
  }
  if (!res) {
    res = await fullPull(names);
    res.mode = 'full';
    res.fullSheets = names.slice();
  }
  if (res.fullSheets.length === names.length) await S.setMeta('lastFullPull', Date.now());
  await S.setMeta('lastPull', Date.now());
  await S.setMeta('lastPullStats', { mode: res.mode, fetched: res.fetched, total: res.total, at: Date.now() });
  setStatus({ lastPullRows: res.fetched, lastPullTotal: res.total, lastPullMode: res.mode });
  return res;
}

// 보낼 행에 값이 있는데 시트 헤더에 없는 열(HEADERS 에는 있는 것)이 있으면 시트 1행에 그 열을 추가하고,
// 저장해 둔 헤더('headers:<시트>')도 바꿉니다. 그래야 값이 버려지지 않고, 변경분 읽기(headersMatch)도 계속 맞습니다.
// 헤더를 아직 모르면(한 번도 안 읽음) 나중에 추가된 열(TAIL 뒤의 열)에 값이 있을 때만 시트에서 헤더를 읽어 확인합니다.
export async function ensureColumns(sheet, stored, rows) {
  const def = HEADERS[sheet] || [];
  const base = Array.isArray(stored) && stored.length ? stored : null;
  const hasVal = (h) => rows.some((r) => r && r[h] !== undefined && r[h] !== null && r[h] !== '');
  const late = def.slice(def.indexOf('deleted') + 1);
  const missing = def.filter((h) => (base ? base.indexOf(h) < 0 : late.indexOf(h) >= 0) && hasVal(h));
  if (!missing.length) return base;
  const next = await api.ensureHeaders(sheet, missing, def);
  await S.setMeta('headers:' + sheet, next);
  return next;
}

export async function flush() {
  const ops = await S.getOutbox();
  if (!ops.length) return;
  const sheets = Array.from(new Set(ops.map((o) => o.sheet)));
  const fresh = await api.pullIds(sheets);
  for (const s of sheets) await S.setMeta('rowIndex:' + s, fresh[s] || {});
  for (const op of ops) {
    const headers = (await ensureColumns(op.sheet, await S.getMeta('headers:' + op.sheet), op.rows)) || HEADERS[op.sheet];
    const idx = (await S.getMeta('rowIndex:' + op.sheet)) || {};
    const keyCol = KEYS[op.sheet];
    const items = op.rows.map((r) => ({ obj: r, row: idx[String(r[keyCol])] || null }));
    const written = await api.writeRows(op.sheet, headers && headers.length ? headers : HEADERS[op.sheet], items);
    await S.setMeta('rowIndex:' + op.sheet, Object.assign(idx, written));
    await S.deleteOutbox(op.seq);
    await refreshPending();
  }
}

async function runOnce() {
  if (!getToken()) { await refreshStatus(); return; }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) { await refreshPending(); setStatus({ phase: 'offline' }); return; }
  setStatus({ phase: 'syncing', error: '' });
  try {
    await flush();
    await pull();
    setStatus({ phase: 'idle', lastSync: Date.now(), error: '' });
  } catch (e) {
    if (e instanceof api.AuthError) setStatus({ phase: 'auth', error: e instanceof api.ScopeError ? e.message : '' });
    else if (e instanceof TypeError) setStatus({ phase: 'offline' });
    else setStatus({ phase: 'error', error: String((e && e.message) || e) });
  } finally {
    await refreshPending();
    notifyData();
  }
}

// 이미 동기화 중이면 끝난 뒤 한 번 더 돌도록 예약하고, 같은 약속(Promise)을 돌려줍니다.
export function sync() {
  if (current) { again = true; return current; }
  current = (async () => {
    try {
      do { again = false; await runOnce(); } while (again);
    } catch (e) {
      setStatus({ phase: 'error', error: String((e && e.message) || e) });
    } finally {
      current = null;
    }
  })();
  return current;
}

// 거래 저장: txnFirst 가 true 면 거래 행을 먼저 올립니다. (삭제 시: 거래가 지워지면 분개는 무시되므로 안전)
export async function saveRecords(rec, opts) {
  const txnFirst = !!(opts && opts.txnFirst);
  const puts = { Transactions: [rec.txn], Postings: rec.postings };
  const opT = { sheet: 'Transactions', rows: [rec.txn] };
  const opP = { sheet: 'Postings', rows: rec.postings };
  const ops = txnFirst ? [opT, opP] : [opP, opT];
  if (rec.rule) {
    puts.Rules = [rec.rule];
    ops.push({ sheet: 'Rules', rows: [rec.rule] });
  }
  await S.commit(puts, ops);
  await refreshPending();
  notifyData();
  sync();
}

// 여러 시트를 한 번에 저장 (명세서 가져오기용). order 순서대로 시트에 올립니다.
export async function saveBatch(puts, order) {
  const ops = [];
  const real = {};
  order.forEach((sheet) => {
    const rows = puts[sheet];
    if (!rows || !rows.length) return;
    real[sheet] = rows;
    ops.push({ sheet, rows });
  });
  await S.commit(real, ops);
  await refreshPending();
  notifyData();
  sync();
}

export async function deleteTxn(txnId) {
  const txn = await S.get('Transactions', String(txnId));
  if (!txn) return;
  const now = nowIso();
  const allPostings = await S.getAll('Postings');
  const mine = allPostings.filter((p) => String(p.txn_id) === String(txnId) && !truthy(p.deleted));
  const t2 = Object.assign({}, txn, { deleted: true, updated_at: now });
  const p2 = mine.map((p) => Object.assign({}, p, { deleted: true, updated_at: now }));
  await saveRecords({ txn: t2, postings: p2, rule: null }, { txnFirst: true });
}

// 로컬 캐시를 비우고 시트에서 다시 받아옵니다. (전송 대기 중인 항목은 보존)
export async function reloadFromSheet() {
  for (const s of CONFIG.SYNC_SHEETS) {
    const protect = await pendingIds(s);
    if (!protect.size) await S.clearStore(s);
  }
  await S.setMeta('lastFullPull', 0); // 다음 동기화는 반드시 전체 읽기
  await sync();
}

export function startAutoSync() {
  if (timer) return;
  timer = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (getToken()) sync();
  }, CONFIG.AUTO_SYNC_MS);
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', () => { sync(); });
    window.addEventListener('offline', () => { setStatus({ phase: 'offline' }); });
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && getToken()) sync(); });
  }
}
