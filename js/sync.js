// 동기화: 로컬(IndexedDB) ↔ 구글 시트.
//  - 저장은 먼저 로컬 + 전송 대기열에 즉시 기록 → 화면은 바로 갱신됩니다.
//  - 대기열은 인터넷/로그인이 될 때 시트로 올라갑니다. (오프라인에서도 입력 가능)
//  - 전송 전에 시트의 키 열을 다시 읽어, 같은 행을 두 번 추가하지 않도록 합니다.
import { CONFIG, KEYS, HEADERS } from './config.js';
import * as S from './store.js';
import * as api from './sheets.js';
import { getToken } from './auth.js';
import { truthy, num, nowIso } from './ledger.js';

const status = { phase: 'auth', pending: 0, lastSync: 0, error: '' };
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

export async function pull() {
  const data = await api.pullSheets(CONFIG.SYNC_SHEETS);
  for (const name of CONFIG.SYNC_SHEETS) {
    const d = data[name];
    const protect = await pendingIds(name);
    await S.mergeRemote(name, d.rows, protect);
    await S.setMeta('rowIndex:' + name, d.rowIndex);
    await S.setMeta('headers:' + name, d.headers);
  }
  await S.setMeta('lastPull', Date.now());
}

export async function flush() {
  const ops = await S.getOutbox();
  if (!ops.length) return;
  const sheets = Array.from(new Set(ops.map((o) => o.sheet)));
  const fresh = await api.pullIds(sheets);
  for (const s of sheets) await S.setMeta('rowIndex:' + s, fresh[s] || {});
  for (const op of ops) {
    const headers = (await S.getMeta('headers:' + op.sheet)) || HEADERS[op.sheet];
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
    if (e instanceof api.AuthError) setStatus({ phase: 'auth' });
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
