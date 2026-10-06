// 계좌 간 이체 자동 연결 (Transfer matching)
//  명세서를 계좌별로 하나씩 올리면, 같은 이체가 한쪽 계좌에서는 "−X 지출/미분류", 다른 계좌에서는 "+X 수입/미분류" 로
//  따로 들어옵니다. 같은 금액(센트까지, CAD)이 서로 다른 두 계좌에서 반대 부호로 며칠 안에 보이면 한 건의 이체로 합칩니다.
//   · findTransferPairs  : 후보 쌍 찾기 (O(n log n))  → 'auto'(자동 연결) | 'suggest'(확인 필요)
//   · mergeAsTransfer    : 두 거래 → 이체 한 건 (항상 같은 id 를 만들어 두 기기가 같은 결과 → 중복 없음)
//   · undoTransfer       : 연결 풀기 (원래 두 거래로 정확히 되돌림)
//   · autoMatch(api)     : 데이터를 불러올 때마다(첫 화면 · 동기화 후 · 가져오기 후) 'auto' 쌍을 한 번에 저장
//   "이체 아님"/"연결 풀기" 한 쌍은 Settings 시트의 meta.xfer_ignore 에 남겨, 모든 기기에서 다시 묶지 않습니다.
import { CONFIG } from './config.js';
import * as L from './ledger.js';
import * as M from './meta.js';
import * as sync from './sync.js';

export const IGNORE_KEY = 'meta.xfer_ignore';
export const AUTO_KEY = 'hl_xfer_auto';
export const MARKER = '[이체 상대 계좌 미확인]';
export const UNCAT_ID = '9999';
export const TRANSFER_MERCHANT = 'Transfer (이체)';
export const WINDOW_DAYS = 4;
const XF = '_xf';
const MEMO_RE = /^(auto|link)-transfer:([^:\s]+):([^:\s]+)(?:\s+(\{.*\}))?\s*$/;
const IGNORE_MAX = 3000;

// 이체처럼 보이는 문구 (은행 명세서 표기)
const WORDS = new RegExp([
  '\\b(?:TFR|TRF|XFER|TRANSFER|TRANSFERT|E-?TRANSFER|E-?TFR|EMT|PAYMENT|PYMT|PMT|PAIEMENT|THANK\\s*YOU|MERCI)\\b',
  '\\b(?:INTERNET|ONLINE|MOBILE|TELEPHONE|PHONE)\\s+(?:BANKING|BANK|TRANSFER|PAYMENT|PMT|TFR)\\b',
  '\\b(?:TO|FROM)\\s*(?:ACCT\\.?|ACCOUNT|A\\/C|SAVINGS|CHEQUING|CHQ|SAV|VISA|MC|MASTERCARD)?\\s*[#*]*\\s*\\d[\\d\\- ]{2,}',
  '이체', '송금', '카드\\s*대금', '자동\\s*납부'
].join('|'), 'i');

export const REASONS = {
  clearing: 'Passthrough (전달 자금)',
  uncategorized: 'Uncategorized (미분류)',
  migrated: 'Old app: other side unknown (이전 앱: 상대 계좌 미확인)',
  review: 'Needs review (확인 필요)',
  words: 'Transfer words (이체 문구)',
  ambiguous: 'Two possible matches (후보가 두 개)',
  duplicate: 'Already recorded as a transfer (이미 이체로 기록됨)'
};

// ───────── 이 기기 설정: 자동 연결 켜기/끄기 ─────────

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
export function isAutoMatchOn() { return lsGet(AUTO_KEY) !== '0'; }
export function setAutoMatchOn(on) { lsSet(AUTO_KEY, on ? '1' : '0'); }

// ───────── "이체 아님" 목록 (Settings: meta.xfer_ignore) ─────────

export function pairKey(idA, idB) { const a = String(idA), b = String(idB); return a < b ? a + '|' + b : b + '|' + a; }

export function ignoredKeys(src) {
  if (src instanceof Set) return src;
  if (Array.isArray(src) && src.length && typeof src[0] === 'string') return new Set(src);
  if (Array.isArray(src)) { const v = M.readJson(src, IGNORE_KEY, []); return new Set(Array.isArray(v) ? v.map(String) : []); }
  return new Set();
}
/** "이체 아님" 쌍을 추가한 Settings 행 */
export function ignoreRow(settings, keys, now) {
  const cur = M.readJson(settings, IGNORE_KEY, []);
  const list = (Array.isArray(cur) ? cur.map(String) : []).filter((k) => keys.indexOf(k) < 0).concat(keys);
  return M.metaRow(settings, IGNORE_KEY, list.slice(-IGNORE_MAX), 'transfer pairs marked "not a transfer" (이체 아님)', now);
}

// ───────── 후보 찾기 ─────────

function dayNum(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : NaN;
}
const live = (ps) => (ps || []).filter((p) => !L.truthy(p.deleted));

/** 이 거래가 한쪽짜리 이체 후보인지 (돈 계좌 분개 1줄 + 카테고리 1줄) */
function nodeOf(it, accMap) {
  const t = it.txn;
  if (!t || L.truthy(t.deleted) || (t.receipt_id && String(t.receipt_id).trim())) return null;
  const d = it.desc || {};
  if (d.kind === 'TRANSFER' || d.kind === 'OPENING' || d.split) return null;
  const ps = live(it.ps);
  if (ps.length !== 2) return null;
  const money = ps.filter((p) => L.isMoneyAccount(accMap.get(String(p.account_id))));
  if (money.length !== 1) return null;
  const m = money[0];
  const c = ps[0] === m ? ps[1] : ps[0];
  const ca = accMap.get(String(c.account_id));
  if (!ca || ca.type === 'EQUITY' || String(c.account_id) === CONFIG.OPENING_ID) return null;
  const cents = Math.round(L.num(m.amount_cad) * 100);
  const day = dayNum(t.date);
  if (!cents || !Number.isFinite(day)) return null;
  const cat = String(c.account_id);
  const strong = [], weak = [];
  // 강한 단서: 미분류(9999) · 이전 앱의 "상대 계좌 미확인" 표시. 전달 자금(2900)만으로는 약한 단서
  // (2900 에는 친구가 보낸 E-TRANSFER 같은 "대신 내준 돈" 도 많아서, 우연히 같은 금액끼리 묶이는 것을 막습니다)
  const marked = String(t.memo || '').indexOf(MARKER) >= 0;
  if (cat === UNCAT_ID) strong.push('uncategorized');
  if (marked) strong.push('migrated');
  if (cat === CONFIG.CLEARING_ID) (marked ? strong : weak).push('clearing');
  if (String(t.status || '').toUpperCase() === 'REVIEW') weak.push('review');
  if (WORDS.test([t.merchant, t.merchant_raw, t.memo].filter(Boolean).join(' '))) weak.push('words');
  return { it, id: String(t.txn_id), day, acct: String(m.account_id), cents, m, c, strong, weak, any: strong.length + weak.length > 0 };
}

const lowerBound = (arr, day) => { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].day < day) lo = mid + 1; else hi = mid; } return lo; };

/** 이미 있는 이체(두 돈 계좌)의 각 줄 — 다른 쪽 명세서에서 온 한쪽짜리 거래가 "중복"인지 보기 위해 */
function legsOf(it, accMap, claimed) {
  const t = it.txn;
  if (!t || L.truthy(t.deleted) || !it.desc || it.desc.kind !== 'TRANSFER') return [];
  const ps = live(it.ps);
  if (ps.length !== 2 || !ps.every((p) => L.isMoneyAccount(accMap.get(String(p.account_id))))) return [];
  const day = dayNum(t.date);
  if (!Number.isFinite(day)) return [];
  const id = String(t.txn_id);
  return ps.map((p) => ({ it, id, nid: id + '@' + String(p.account_id), day, acct: String(p.account_id), cents: Math.round(L.num(p.amount_cad) * 100), leg: true }))
    .filter((g) => g.cents && !claimed.has(id + '|' + g.acct));
}

/**
 * 이체 후보 쌍.
 * opts = { windowDays=4, ignore: Settings 행들 | Set(pairKey) | [pairKey], stmtLines }
 * → [{ type:'pair'|'duplicate', a, b, amount, days, confidence:'auto'|'suggest', reasons[], key, from, to }]
 *   type 'pair'      : 한쪽짜리 거래 둘 → 이체 한 건. a = 남길 거래(날짜가 이른 쪽, 같으면 id 작은 쪽), b = 지워질 쪽
 *   type 'duplicate' : 이미 이체로 기록된 거래(a)의 한쪽 줄과 같은 한쪽짜리 거래(b) → b 는 중복이라 지움
 *   from/to = 돈이 나간/들어온 쪽 item, fromAcct/toAcct = 계좌 id
 */
export function findTransferPairs(items, accMap, opts) {
  const o = opts || {};
  const w = Number.isFinite(o.windowDays) ? o.windowDays : WINDOW_DAYS;
  const ignore = ignoredKeys(o.ignore);
  const claimed = new Set((o.stmtLines || []).filter((s) => !L.truthy(s.deleted) && s.matched_txn_id).map((s) => String(s.matched_txn_id) + '|' + String(s.account_id)));
  const buckets = new Map();   // |센트| → { pos, neg }  (한쪽짜리끼리)
  const legB = new Map();      // 계좌|센트 → [이체 줄]
  const nodes = [];
  (items || []).forEach((it) => {
    const n = nodeOf(it, accMap);
    if (n) {
      nodes.push(n);
      const k = Math.abs(n.cents);
      let b = buckets.get(k);
      if (!b) { b = { pos: [], neg: [] }; buckets.set(k, b); }
      (n.cents > 0 ? b.pos : b.neg).push(n);
      return;
    }
    legsOf(it, accMap, claimed).forEach((g) => { const k = g.acct + '|' + g.cents; if (!legB.has(k)) legB.set(k, []); legB.get(k).push(g); });
  });
  const edges = [];
  buckets.forEach((b) => {
    if (!b.pos.length || !b.neg.length) return;
    b.neg.sort((x, y) => x.day - y.day);
    b.pos.forEach((p) => {
      for (let i = lowerBound(b.neg, p.day - w); i < b.neg.length && b.neg[i].day <= p.day + w; i++) {
        const q = b.neg[i];
        if (q.acct === p.acct || q.id === p.id) continue;
        const key = pairKey(p.id, q.id);
        if (ignore.has(key)) continue;
        const score = (p.strong.length ? 2 : 0) + (q.strong.length ? 2 : 0) + (p.any ? 1 : 0) + (q.any ? 1 : 0);
        edges.push({ type: 'pair', p, q, u: p.id, v: q.id, key, days: Math.abs(p.day - q.day), score });
      }
    });
  });
  legB.forEach((arr) => arr.sort((x, y) => x.day - y.day));
  nodes.forEach((n) => {
    const arr = legB.get(n.acct + '|' + n.cents);
    if (!arr) return;
    for (let i = lowerBound(arr, n.day - w); i < arr.length && arr[i].day <= n.day + w; i++) {
      const g = arr[i];
      const key = pairKey(n.id, g.id);
      if (ignore.has(key)) continue;
      edges.push({ type: 'duplicate', p: n, q: g, u: n.id, v: g.nid, key, days: Math.abs(n.day - g.day), score: 3 + (n.strong.length ? 2 : 0) + (n.any ? 1 : 0) });
    }
  });
  edges.sort((x, y) => x.days - y.days || y.score - x.score || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const at = new Map();
  edges.forEach((e) => { [e.u, e.v].forEach((id) => { if (!at.has(id)) at.set(id, []); at.get(id).push(e); }); });
  const used = new Set();
  const out = [];
  const emit = (e, ambiguous) => {
    const reasons = [];
    if (e.type === 'duplicate') {
      const n = e.p, g = e.q;
      n.strong.concat(n.weak).forEach((r) => reasons.push(r));
      reasons.push('duplicate');
      if (ambiguous) reasons.push('ambiguous');
      const autoOk = !ambiguous && (n.strong.length > 0 || n.weak.indexOf('words') >= 0);
      if (!autoOk && !n.any) return;
      const tp = live(g.it.ps);
      const fromP = tp.find((p) => L.num(p.amount_cad) < 0), toP = tp.find((p) => L.num(p.amount_cad) > 0);
      out.push({
        type: 'duplicate', a: g.it, b: n.it, amount: Math.abs(n.cents) / 100, days: e.days, confidence: autoOk ? 'auto' : 'suggest', reasons, key: e.key,
        from: g.it, to: g.it, fromAcct: fromP ? String(fromP.account_id) : '', toAcct: toP ? String(toP.account_id) : '', acct: n.acct
      });
      return;
    }
    const [a, b] = keepOrder(e.p, e.q);
    [a, b].forEach((n) => n.strong.concat(n.weak).forEach((r) => { if (reasons.indexOf(r) < 0) reasons.push(r); }));
    if (ambiguous) reasons.push('ambiguous');
    const autoOk = !ambiguous && ((a.strong.length && b.any) || (b.strong.length && a.any));
    // 단서가 약한 같은 금액(한쪽만 이체 문구 등)은 우연일 때가 많아 보여주지 않음
    if (!autoOk && !(a.strong.length || b.strong.length || (a.any && b.any))) return;
    out.push({
      type: 'pair', a: a.it, b: b.it, amount: Math.abs(e.p.cents) / 100, days: e.days, confidence: autoOk ? 'auto' : 'suggest', reasons, key: e.key,
      from: e.q.it, to: e.p.it, fromAcct: e.q.acct, toAcct: e.p.acct
    });
  };
  edges.forEach((e) => {
    if (used.has(e.u) || used.has(e.v)) return;
    const ties = [];
    [e.u, e.v].forEach((id) => at.get(id).forEach((x) => {
      if (x !== e && x.days === e.days && !used.has(x.u) && !used.has(x.v) && ties.indexOf(x) < 0) ties.push(x);
    }));
    used.add(e.u); used.add(e.v);
    if (!ties.length) { emit(e, false); return; }
    // 똑같이 가까운 상대가 있으면 자동으로 고르지 않습니다. 후보가 2개면 둘 다 "확인 필요"로 보여 주고,
    // 3개 이상(예: 여러 사람이 같은 금액을 보낸 회비)은 이체가 아닐 가능성이 커서 보여주지 않습니다.
    ties.forEach((x) => { used.add(x.u); used.add(x.v); });
    if (ties.length === 1) { emit(e, true); emit(ties[0], true); }
  });
  out.sort((x, y) => (x.a.txn.date < y.a.txn.date ? 1 : x.a.txn.date > y.a.txn.date ? -1 : (x.key < y.key ? -1 : 1)));
  return out;
}

function keepOrder(x, y) {
  if (x.day !== y.day) return x.day < y.day ? [x, y] : [y, x];
  return x.id < y.id ? [x, y] : [y, x];
}

let sugCache = { items: null, ign: null, on: null, accMap: null, sl: null, v: [] };
/** 확인할 후보 (자동 연결이 꺼져 있으면 'auto' 쌍도 포함). settingsOrIgnore = Settings 행 | Set | [키] */
export function pendingSuggestions(items, accMap, settingsOrIgnore, stmtLines) {
  const on = isAutoMatchOn();
  const c = sugCache;
  if (c.items === items && c.ign === settingsOrIgnore && c.on === on && c.accMap === accMap && c.sl === stmtLines) return c.v;
  const v = findTransferPairs(items, accMap, { ignore: settingsOrIgnore, stmtLines }).filter((p) => !on || p.confidence === 'suggest');
  sugCache = { items, ign: settingsOrIgnore, on, accMap, sl: stmtLines, v };
  return v;
}

// ───────── 합치기 / 풀기 ─────────

function parts(item, accMap) {
  const ps = live(item.ps);
  const m = ps.find((p) => L.isMoneyAccount(accMap.get(String(p.account_id))));
  const c = ps.find((p) => p !== m);
  return { t: item.txn, m, c };
}
const memoBase = (memo) => String(memo || '').split(MARKER).join('').replace(/\s{2,}/g, ' ').trim();
const otherDesc = (t) => String(t.merchant || t.merchant_raw || t.memo || '').replace(MARKER, '').trim();
function linkedMemo(keptMemo, other) {
  const base = memoBase(keptMemo);
  const tail = '↔ ' + (otherDesc(other) || 'other account (상대 계좌)');
  return base ? base + ' · ' + tail : tail;
}

/**
 * 두 거래 → 이체 한 건. a, b = { txn, ps } (ps = 살아 있는 분개)
 * 날짜가 이른 쪽(같으면 id 작은 쪽)을 남기고, 그 카테고리 줄을 지운 뒤 상대 계좌 줄(<id>_xf)을 붙입니다.
 * → { Transactions, Postings, StatementLines, keptId, otherId, key } (같은 입력이면 언제나 같은 행)
 */
export function mergeAsTransfer(a, b, accMap, now, opts) {
  const o = opts || {};
  const ts = now || L.nowIso();
  const A = parts(a, accMap), B = parts(b, accMap);
  if (!A.m || !A.c || !B.m || !B.c) throw new Error('이체로 합칠 수 없는 거래입니다.');
  const da = dayNum(A.t.date), db = dayNum(B.t.date);
  const aFirst = da !== db ? da < db : String(A.t.txn_id) < String(B.t.txn_id);
  const K = aFirst ? A : B, O = aFirst ? B : A;
  const keptId = String(K.t.txn_id), otherId = String(O.t.txn_id);
  const stash = { o: [String(O.m.posting_id), String(O.c.posting_id)], m: K.t.merchant === undefined ? '' : K.t.merchant, r: K.t.merchant_raw === undefined ? '' : K.t.merchant_raw, n: K.t.memo === undefined ? '' : K.t.memo, s: K.t.status === undefined ? '' : K.t.status, p: K.t.is_passthrough === undefined ? '' : K.t.is_passthrough };
  const xf = {
    posting_id: keptId + XF, txn_id: keptId, line_id: '', account_id: String(O.m.account_id),
    amount_cad: L.round(L.num(O.m.amount_cad), 2),
    amount_orig: O.m.amount_orig === '' || O.m.amount_orig === undefined ? L.round(L.num(O.m.amount_cad), 2) : O.m.amount_orig,
    currency: O.m.currency || 'CAD', fx_rate: O.m.fx_rate === undefined || O.m.fx_rate === '' ? 1 : O.m.fx_rate,
    memo: (o.manual ? 'link' : 'auto') + '-transfer:' + otherId + ':' + String(K.c.posting_id) + ' ' + JSON.stringify(stash),
    updated_at: ts, deleted: false, owner: O.m.owner || ''
  };
  const kept = Object.assign({}, K.t, {
    merchant: TRANSFER_MERCHANT, merchant_raw: K.t.merchant_raw || K.t.merchant || '',
    memo: linkedMemo(K.t.memo, O.t), status: 'MATCHED', is_passthrough: false, updated_at: ts, deleted: false
  });
  const gone = Object.assign({}, O.t, { deleted: true, updated_at: ts });
  const del = (p) => Object.assign({}, p, { deleted: true, updated_at: ts });
  const sls = (o.stmtLines || []).filter((s) => !L.truthy(s.deleted) && String(s.matched_txn_id) === otherId)
    .map((s) => Object.assign({}, s, { matched_txn_id: keptId, updated_at: ts }));
  return {
    Transactions: [kept, gone], Postings: [del(K.c), xf, del(O.m), del(O.c)], StatementLines: sls,
    keptId, otherId, key: pairKey(keptId, otherId)
  };
}

/** 이 거래가 자동/직접 연결로 만든 이체면 그 정보 */
export function linkInfo(txn, ps) {
  if (!txn) return null;
  const id = String(txn.txn_id);
  const p = live(ps).find((x) => String(x.posting_id) === id + XF && MEMO_RE.test(String(x.memo || '')));
  if (!p) return null;
  const m = MEMO_RE.exec(String(p.memo));
  let stash = null;
  try { stash = m[4] ? JSON.parse(m[4]) : null; } catch (e) { stash = null; }
  return { auto: m[1] === 'auto', otherId: m[2], catPostingId: m[3], stash, posting: p, key: pairKey(id, m[2]) };
}

/**
 * 연결 풀기: 원래 두 거래로 되돌리는 행. postings = 남긴 거래의 분개(지워진 것 포함 가능)
 * → { Transactions, Postings, StatementLines, key } | null
 */
export function undoTransfer(keptTxn, postings, allTxns, allPostings, now, stmtLines) {
  const info = linkInfo(keptTxn, postings);
  if (!info) return null;
  const ts = now || L.nowIso();
  const keptId = String(keptTxn.txn_id);
  const st = info.stash || {};
  const pById = new Map((allPostings || []).map((p) => [String(p.posting_id), p]));
  (postings || []).forEach((p) => { if (!pById.has(String(p.posting_id))) pById.set(String(p.posting_id), p); });
  const other = (allTxns || []).find((t) => String(t.txn_id) === info.otherId);
  const cat = pById.get(info.catPostingId);
  if (!other || !cat) return null;
  const restoreP = (p) => Object.assign({}, p, { deleted: false, updated_at: ts });
  const otherPs = (Array.isArray(st.o) && st.o.length ? st.o.map((id) => pById.get(String(id))).filter(Boolean)
    : (allPostings || []).filter((p) => String(p.txn_id) === info.otherId));
  const xfAcct = String(info.posting.account_id);
  const genMemo = linkedMemo(st.n, other);
  const kept = Object.assign({}, keptTxn, {
    merchant: 'm' in st ? st.m : keptTxn.merchant,
    merchant_raw: 'r' in st ? st.r : keptTxn.merchant_raw,
    memo: 'n' in st ? (String(keptTxn.memo || '') === genMemo ? st.n : keptTxn.memo) : keptTxn.memo,
    status: 's' in st ? st.s : keptTxn.status,
    is_passthrough: 'p' in st ? st.p : keptTxn.is_passthrough,
    updated_at: ts, deleted: false
  });
  const sls = (stmtLines || []).filter((s) => !L.truthy(s.deleted) && String(s.matched_txn_id) === keptId && String(s.account_id) === xfAcct)
    .map((s) => Object.assign({}, s, { matched_txn_id: info.otherId, updated_at: ts }));
  return {
    Transactions: [kept, Object.assign({}, other, { deleted: false, updated_at: ts })],
    Postings: [restoreP(cat), Object.assign({}, info.posting, { deleted: true, updated_at: ts })].concat(otherPs.map(restoreP)),
    StatementLines: sls, key: info.key, keptId, otherId: info.otherId
  };
}

// ───────── 중복 정리 (이미 이체로 기록된 거래의 한쪽 줄) ─────────

const DUP_RE = /\s*\[dup-of:([^:\]\s]+):([^\]\s]*)\]\s*$/;

/** 중복(b)을 지우는 행. 지운 거래의 메모 끝에 [dup-of:<이체 id>:<분개 ids>] 를 남겨 되돌릴 수 있게 합니다. */
export function absorbDuplicate(transferItem, dupItem, now, opts) {
  const o = opts || {};
  const ts = now || L.nowIso();
  const T = transferItem.txn, N = dupItem.txn;
  const tId = String(T.txn_id), nId = String(N.txn_id);
  const ps = live(dupItem.ps);
  const memo = String(N.memo || '').replace(DUP_RE, '');
  const gone = Object.assign({}, N, { memo: memo + ' [dup-of:' + tId + ':' + ps.map((p) => String(p.posting_id)).join(',') + ']', deleted: true, updated_at: ts });
  const sls = (o.stmtLines || []).filter((s) => !L.truthy(s.deleted) && String(s.matched_txn_id) === nId)
    .map((s) => Object.assign({}, s, { matched_txn_id: tId, updated_at: ts }));
  return { Transactions: [gone], Postings: ps.map((p) => Object.assign({}, p, { deleted: true, updated_at: ts })), StatementLines: sls, keptId: tId, otherId: nId, key: pairKey(tId, nId) };
}

/** 지운 중복 거래 → 어느 이체에 합쳐졌는지 */
export function dupInfo(txn) {
  const m = txn ? DUP_RE.exec(String(txn.memo || '')) : null;
  return m ? { transferId: m[1], postingIds: m[2] ? m[2].split(',') : [] } : null;
}

/** 이체 id → 그 이체에 합쳐진(지운) 중복 거래들 */
export function absorbedMap(txns) {
  const out = new Map();
  (txns || []).forEach((t) => {
    if (!L.truthy(t.deleted)) return;
    const d = dupInfo(t);
    if (!d) return;
    if (!out.has(d.transferId)) out.set(d.transferId, []);
    out.get(d.transferId).push(t);
  });
  return out;
}

export function undoAbsorb(dupTxn, allPostings, now, stmtLines) {
  const d = dupInfo(dupTxn);
  if (!d) return null;
  const ts = now || L.nowIso();
  const nId = String(dupTxn.txn_id);
  const ids = new Set(d.postingIds);
  const ps = (allPostings || []).filter((p) => ids.has(String(p.posting_id)) && String(p.txn_id) === nId);
  const sls = (stmtLines || []).filter((s) => !L.truthy(s.deleted) && String(s.matched_txn_id) === d.transferId && String(s.stmt_line_id) === String(dupTxn.statement_line_id || ''))
    .map((s) => Object.assign({}, s, { matched_txn_id: nId, updated_at: ts }));
  return {
    Transactions: [Object.assign({}, dupTxn, { memo: String(dupTxn.memo || '').replace(DUP_RE, ''), deleted: false, updated_at: ts })],
    Postings: ps.map((p) => Object.assign({}, p, { deleted: false, updated_at: ts })), StatementLines: sls,
    key: pairKey(d.transferId, nId), keptId: d.transferId, otherId: nId
  };
}

/** 후보 하나를 저장할 행으로 */
export function applyPair(pair, accMap, now, opts) {
  return pair.type === 'duplicate' ? absorbDuplicate(pair.a, pair.b, now, opts) : mergeAsTransfer(pair.a, pair.b, accMap, now, opts);
}

// ───────── 저장 도우미 ─────────

const ORDER = ['Transactions', 'Postings', 'StatementLines', 'Settings'];
function combine(list) {
  const out = { Transactions: [], Postings: [], StatementLines: [], Settings: [] };
  list.forEach((r) => { if (r) ['Transactions', 'Postings', 'StatementLines'].forEach((k) => { out[k] = out[k].concat(r[k] || []); }); });
  return out;
}

/** 직접 연결 (확인 카드의 "이체로 연결") */
export async function linkPair(api, pair) {
  const st = api.state;
  const rows = applyPair(pair, st.d.accMap, L.nowIso(), { manual: true, stmtLines: st.data.stmtLines });
  await sync.saveBatch(combine([rows]), ORDER);
  return rows;
}

/** "이체 아님": 다시 묶지 않도록 기억 */
export async function rejectPair(api, pair) {
  const st = api.state;
  await sync.saveBatch({ Settings: [ignoreRow(st.data.settings, [pair.key], L.nowIso())] }, ['Settings']);
}

/** 연결 풀기 rows (data = { txns, postings, stmtLines }). keys = pairKey 목록 → [{Transactions, Postings, StatementLines, key}] */
export function unlinkRows(data, keys, now) {
  const ts = now || L.nowIso();
  const byId = new Map(data.txns.map((t) => [String(t.txn_id), t]));
  const byTxn = new Map();
  data.postings.forEach((p) => { const k = String(p.txn_id); if (!byTxn.has(k)) byTxn.set(k, []); byTxn.get(k).push(p); });
  const res = [];
  [].concat(keys).forEach((key) => {
    const ids = String(key).split('|');
    for (const id of ids) {
      const t = byId.get(id);
      if (!t || L.truthy(t.deleted)) continue;
      const other = ids.find((x) => x !== id);
      const info = linkInfo(t, byTxn.get(id) || []);
      if (info && info.otherId === other) {
        const r = undoTransfer(t, byTxn.get(id) || [], data.txns, data.postings, ts, data.stmtLines);
        if (r) { res.push(r); return; }
      }
      const dup = byId.get(other);
      const d = dup && L.truthy(dup.deleted) ? dupInfo(dup) : null;
      if (d && d.transferId === id) {
        const r = undoAbsorb(dup, data.postings, ts, data.stmtLines);
        if (r) { res.push(r); return; }
      }
    }
  });
  return res;
}

/** 연결 풀기/중복 되살리기 (여러 건 한 번에). 푼 쌍은 다시 자동으로 묶지 않습니다. → 푼 건수 */
export async function unlink(api, keys) {
  const data = api.state.data;
  const now = L.nowIso();
  const res = unlinkRows(data, keys, now);
  if (!res.length) return 0;
  const puts = combine(res);
  puts.Settings = [ignoreRow(data.settings, res.map((r) => r.key), now)];
  await sync.saveBatch(puts, ORDER);
  return res.length;
}

// ───────── 자동 연결 ─────────

let running = false;
const applied = new Set();     // 이번 실행 동안 이미 저장한 쌍 (저장 실패 등으로 같은 쌍을 계속 반복하지 않도록)
let lastLinked = [];

export function _reset() { running = false; applied.clear(); lastLinked = []; }
export function lastAutoLinked() { return lastLinked.slice(); }

/**
 * 데이터를 불러온 뒤마다 부릅니다. api = { state, reload, renderBody, toast?, h? }
 * → 연결한 건수
 */
export async function autoMatch(api) {
  if (running || !isAutoMatchOn()) return 0;
  const st = api && api.state;
  if (!st || !st.data || !st.d || !st.data.accounts || !st.data.accounts.length || !st.d.items.length) return 0;
  running = true;
  try {
    const pairs = findTransferPairs(st.d.items, st.d.accMap, { ignore: st.data.settings, stmtLines: st.data.stmtLines })
      .filter((p) => p.confidence === 'auto' && !applied.has(p.key));
    if (!pairs.length) return 0;
    const now = L.nowIso();
    const rows = pairs.map((p) => applyPair(p, st.d.accMap, now, { stmtLines: st.data.stmtLines }));
    rows.forEach((r) => applied.add(r.key));
    await sync.saveBatch(combine(rows), ORDER);
    lastLinked = rows.map((r) => r.key);
    if (api.reload) await api.reload();
    if (api.renderBody) api.renderBody();
    snack(api, rows.length, lastLinked.slice());
    return rows.length;
  } catch (e) {
    console.error('transfer auto-match', e);
    return 0;
  } finally {
    running = false;
  }
}

// 되돌리기 버튼이 있는 알림 (ui.js 의 toast 는 글자만 지원)
let snackTimer = null;
function snack(api, n, keys) {
  if (typeof document === 'undefined' || !document.body) return;
  let el = document.getElementById('xf-snack');
  if (el) el.remove();
  el = document.createElement('div');
  el.id = 'xf-snack';
  el.className = 'xf-snack';
  el.setAttribute('role', 'status');
  const msg = document.createElement('span');
  msg.textContent = 'Linked ' + n + ' transfer' + (n === 1 ? '' : 's') + ' automatically (이체 ' + n + '건을 자동으로 연결했어요)';
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.id = 'xf-undo';
  undo.textContent = 'Undo (되돌리기)';
  undo.addEventListener('click', async () => {
    el.remove();
    try {
      const k = await unlink(api, keys);
      if (api.reload) await api.reload();
      if (api.renderBody) api.renderBody(true);
      if (api.toast) api.toast('Unlinked ' + k + ' (이체 ' + k + '건 연결을 풀었어요)');
    } catch (e) { if (api.toast) api.toast('되돌리지 못했습니다: ' + (e.message || e)); }
  });
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'xf-x';
  x.setAttribute('aria-label', 'Close (닫기)');
  x.textContent = '×';
  x.addEventListener('click', () => el.remove());
  el.append(msg, undo, x);
  document.body.append(el);
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => { if (el.isConnected) el.remove(); }, 12000);
}
