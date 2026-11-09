// 거래 여러 건을 한 번에 바꾸기 (카테고리 · 소유자 · 확인 완료 · 여행 태그 · 메모 · 삭제)
// planBulk 은 순수 함수(테스트용) — 화면(아래쪽 작업 막대 · 고르기 창)은 bulkBar 가 그립니다.
import { CONFIG } from './config.js';
import * as L from './ledger.js';
import * as sync from './sync.js';
import { icon } from './icons.js';
import { rulesFromRemember } from './importer.js';

export const REASONS = {
  transfer: 'Transfer/opening has no category (이체·기초잔액은 카테고리 없음)',
  split: 'Split transaction — edit lines one by one (나눈 거래는 줄마다 직접 수정)',
  receipt: 'Receipt items in several categories (영수증 항목 여러 카테고리)',
  mismatch: 'Expense ↔ income mismatch (지출·수입 종류가 다름)',
  nocat: 'No category line found (카테고리 줄 없음)',
  sameacct: 'Same account on both sides (양쪽 계좌가 같음)',
  special: 'Not an expense/income (지출·수입이 아님)',
  notexp: 'Only spending can be a refund (지출만 환불로 바꿀 수 있어요)',
  direction: 'Money went out — income/refund needs money coming in (나간 돈은 수입·환불이 될 수 없어요)',
  opening: 'Opening balance (기초잔액)'
};
export const REASON_SHORT = {
  transfer: 'transfer (이체)', split: 'split (나눈 거래)', receipt: 'receipt (영수증)', mismatch: 'type (종류 다름)', nocat: 'no category (카테고리 없음)', sameacct: 'same account (같은 계좌)', special: 'other type (다른 종류)', notexp: 'not spending (지출 아님)', direction: 'money out (나간 돈)', opening: 'opening (기초잔액)'
};

const live = (ps) => (ps || []).filter((p) => !L.truthy(p.deleted));

/**
 * 고른 거래들에 patch 를 적용한 저장용 행들을 만듭니다 (원본은 바꾸지 않음).
 * items: [{ txn, ps, desc? }] · ids: 거래 id 들 · patch: { categoryId?, special?, transferAccountId?, owner?, status?, tripTag?, memoAppend?, delete? }
 *   special: 'PASSTHROUGH' (전달 자금 2900) 또는 'TRANSFER' (이체 — transferAccountId = 상대 계좌) 
 * opts.lineItems: LineItems 행들 (영수증 거래의 항목 카테고리도 같이 바꿈)
 * → { txns, postings, lineItems, skipped:[{id, reason}], changed, remember:[{merchant, accountId, previousAccountId}] }
 */
export function planBulk(items, ids, patch, accMap, now, opts) {
  const p = patch || {};
  const o = opts || {};
  const want = new Set(Array.from(ids || [], String));
  const out = { txns: [], postings: [], lineItems: [], skipped: [], changed: 0, remember: [] };
  const cat = p.categoryId != null && p.categoryId !== '' ? accMap.get(String(p.categoryId)) : null;
  if (p.categoryId != null && p.categoryId !== '' && !(cat && (cat.type === 'EXPENSE' || cat.type === 'INCOME'))) throw new Error('카테고리를 찾을 수 없습니다: ' + p.categoryId);
  const special = p.special === 'PASSTHROUGH' || p.special === 'TRANSFER' ? p.special : '';
  const xacct = special === 'TRANSFER' ? accMap.get(String(p.transferAccountId || '')) : null;
  if (special === 'TRANSFER' && !L.isMoneyAccount(xacct)) throw new Error('이체 상대 계좌를 선택하세요.');
  const passId = special === 'PASSTHROUGH' ? L.clearingIdFor(p.passKind === 'CHURCH' ? 'CHURCH' : 'PERSONAL') : '';
  if (special === 'PASSTHROUGH' && !accMap.get(passId)) throw new Error('전달 자금 계정이 없습니다 (' + passId + ').');
  const hasTrip = Object.prototype.hasOwnProperty.call(p, 'tripTag') && p.tripTag !== undefined && p.tripTag !== null;
  const trip = hasTrip ? String(p.tripTag).trim() : '';
  const memoAdd = String(p.memoAppend || '').trim();
  const owner = p.owner ? String(p.owner) : '';
  const status = p.status ? String(p.status).toUpperCase() : '';

  // 영수증 항목: 거래별로 묶기 (필요할 때만)
  let liByTxn = null;
  if (cat && o.lineItems && o.lineItems.length) {
    liByTxn = new Map();
    o.lineItems.forEach((li) => {
      if (L.truthy(li.deleted)) return;
      const k = String(li.txn_id);
      if (!want.has(k)) return;
      if (!liByTxn.has(k)) liByTxn.set(k, []);
      liByTxn.get(k).push(li);
    });
  }
  const remembered = new Set();
  const typeOf = (q) => { const a = accMap.get(String(q.account_id)); return a ? a.type : ''; };

  (items || []).forEach((it) => {
    const id = String(it.txn.txn_id);
    if (!want.has(id) || L.truthy(it.txn.deleted)) return;
    const ps = live(it.ps);

    if (p.delete) {
      out.txns.push(Object.assign({}, it.txn, { deleted: true, updated_at: now }));
      ps.forEach((q) => out.postings.push(Object.assign({}, q, { deleted: true, updated_at: now })));
      out.changed++;
      return;
    }

    const t = Object.assign({}, it.txn);
    const pmap = new Map();      // posting_id → 바뀐 분개
    const pget = (q) => { const k = String(q.posting_id); if (!pmap.has(k)) pmap.set(k, Object.assign({}, q)); return pmap.get(k); };
    let dirty = false;
    let skip = null;
    const lis = [];

    if (special) {
      const desc = it.desc || L.describeTxn(it.txn, ps, accMap);
      const clearing = ps.filter((q) => L.isClearingId(q.account_id));
      const exps = ps.filter((q) => typeOf(q) === 'EXPENSE');
      const incs = ps.filter((q) => typeOf(q) === 'INCOME');
      let target = null;
      let same = false;
      if (desc.kind === 'OPENING') skip = 'transfer';
      else if (desc.kind === 'TRANSFER') { if (special === 'PASSTHROUGH') skip = 'transfer'; else same = true; }
      else if (desc.kind === 'PASSTHROUGH') {
        if (special === 'PASSTHROUGH') { if (clearing.length === 1 && String(clearing[0].account_id) !== passId && !exps.length && !incs.length) target = clearing[0]; else same = true; }
        else if (clearing.length !== 1 || exps.length || incs.length) skip = 'split';
        else target = clearing[0];
      } else if (desc.kind === 'EXPENSE' || desc.kind === 'INCOME') {
        const cats = desc.kind === 'EXPENSE' ? exps : incs;
        if (cats.length > 1 || (exps.length && incs.length)) skip = 'split';
        else if (!cats.length) skip = 'nocat';
        else target = cats[0];
      } else skip = 'nocat';
      if (target && o.lineItems && o.lineItems.some((li) => !L.truthy(li.deleted) && String(li.txn_id) === id)) { skip = 'receipt'; target = null; }
      if (target && special === 'TRANSFER' && ps.some((q) => q !== target && String(q.account_id) === String(xacct.account_id))) { skip = 'sameacct'; target = null; }
      if (skip && !owner && !status && !hasTrip && !memoAdd) { out.skipped.push({ id, reason: skip }); return; }
      if (target) {
        pget(target).account_id = special === 'TRANSFER' ? String(xacct.account_id) : passId;
        const pass = special === 'PASSTHROUGH';
        if (L.truthy(t.is_passthrough) !== pass) t.is_passthrough = pass;
        if (String(t.status).toUpperCase() === 'REVIEW') t.status = 'MATCHED';
        dirty = true;
      }
    }

    if (cat) {
      const desc = it.desc || L.describeTxn(it.txn, ps, accMap);
      const clearing = ps.filter((q) => L.isClearingId(q.account_id));
      const exps = ps.filter((q) => typeOf(q) === 'EXPENSE');
      const incs = ps.filter((q) => typeOf(q) === 'INCOME');
      let target = null;
      if (desc.kind === 'OPENING' || desc.kind === 'TRANSFER') skip = 'transfer';
      else if (desc.kind === 'PASSTHROUGH') {
        if (clearing.length !== 1 || exps.length || incs.length) skip = 'split';
        else if (cat.type === 'INCOME' && desc.flow !== 'in') skip = 'mismatch';
        else target = clearing[0];
      } else if (desc.kind === 'EXPENSE' || desc.kind === 'INCOME') {
        const cats = desc.kind === 'EXPENSE' ? exps : incs;
        if (cats.length > 1 || (exps.length && incs.length)) skip = 'split';
        else if (!cats.length) skip = 'nocat';
        else if (cat.type !== desc.kind) skip = 'mismatch';
        else target = cats[0];
      } else skip = 'nocat';

      if (target && liByTxn && liByTxn.has(id)) {
        const mine = liByTxn.get(id);
        const used = new Set(mine.map((li) => String(li.category_account_id || '')).filter(Boolean));
        if (used.size > 1) { skip = 'receipt'; target = null; }
        else mine.forEach((li) => { if (String(li.category_account_id || '') !== String(cat.account_id)) lis.push(Object.assign({}, li, { category_account_id: String(cat.account_id), updated_at: now })); });
      }
      if (skip && !owner && !status && !hasTrip && !memoAdd) { out.skipped.push({ id, reason: skip }); return; }
      if (target) {
        const prev = String(target.account_id);
        if (prev !== String(cat.account_id)) {
          pget(target).account_id = String(cat.account_id);
          dirty = true;
          if (t.merchant && String(cat.account_id) !== '9999') {
            const k = L.normMerchant(t.merchant);
            if (k && !remembered.has(k)) { remembered.add(k); out.remember.push({ merchant: t.merchant, accountId: String(cat.account_id), previousAccountId: L.isClearingId(prev) ? '' : prev }); }
          }
        }
        if (L.truthy(t.is_passthrough) || desc.kind === 'PASSTHROUGH') { if (t.is_passthrough !== false) { t.is_passthrough = false; dirty = true; } }
        if (String(cat.account_id) !== '9999' && String(t.status).toUpperCase() === 'REVIEW') { t.status = 'MATCHED'; dirty = true; }
        if (lis.length) dirty = true;
      }
    }

    if (owner) {
      if (String(t.owner || '') !== owner) { t.owner = owner; dirty = true; }
      ps.forEach((q) => { if (String(q.owner || '') !== '') { pget(q).owner = ''; dirty = true; } });
    }
    if (status) {
      if (String(t.status).toUpperCase() === 'REVIEW' && status !== 'REVIEW') { t.status = status; dirty = true; }
    }
    if (hasTrip && String(t.trip_tag || '') !== trip) { t.trip_tag = trip; dirty = true; }
    if (memoAdd) {
      const m = String(t.memo || '').trim();
      if (!m.endsWith(memoAdd)) { t.memo = m ? m + ' · ' + memoAdd : memoAdd; dirty = true; }
    }

    if (skip) out.skipped.push({ id, reason: skip });
    if (!dirty) return;
    t.updated_at = now;
    out.txns.push(t);
    pmap.forEach((q) => { q.updated_at = now; out.postings.push(q); });
    lis.forEach((li) => out.lineItems.push(li));
    out.changed++;
  });
  return out;
}

/**
 * 환불 켜기/끄기: 지출 거래의 방향을 뒤집습니다 (돈이 계좌로 돌아오고 같은 카테고리에서 빠짐).
 * 입력 창과 같은 규칙(formFromTxn → makeRecords)으로 다시 만들어서 나눈 거래 · 외화도 맞게 바뀝니다.
 * on=true 면 환불로, false 면 일반 지출로. 이미 그 상태인 거래는 그대로 둡니다.
 */
export function planRefund(items, ids, on, accMap, now, opts) {
  const o = opts || {};
  const want = new Set(Array.from(ids || [], String));
  const out = { txns: [], postings: [], lineItems: [], skipped: [], changed: 0, remember: [] };
  const rcIds = new Set((o.lineItems || []).filter((li) => !L.truthy(li.deleted)).map((li) => String(li.txn_id)));
  (items || []).forEach((it) => {
    const id = String(it.txn.txn_id);
    if (!want.has(id) || L.truthy(it.txn.deleted)) return;
    const ps = live(it.ps);
    const desc = it.desc || L.describeTxn(it.txn, ps, accMap);
    if (desc.kind !== 'EXPENSE' || L.truthy(it.txn.is_passthrough)) { out.skipped.push({ id, reason: desc.kind === 'TRANSFER' || desc.kind === 'OPENING' ? 'transfer' : 'notexp' }); return; }
    if (rcIds.has(id)) { out.skipped.push({ id, reason: 'receipt' }); return; }
    const isRefund = desc.flow === 'in';
    if (isRefund === !!on) return;
    const f = L.formFromTxn(it.txn, ps, accMap);
    f.refund = !!on;
    const res = L.makeRecords(f, { accMap, existing: { txn: it.txn, ps: it.ps }, now });
    if (res.error) { out.skipped.push({ id, reason: 'special' }); return; }
    out.txns.push(res.txn);
    res.postings.forEach((q) => out.postings.push(q));
    out.changed++;
  });
  return out;
}

/**
 * 종류 바꾸기 (지출 · 수입 · 환불 · 이체 · 전달 자금). 은행 쪽 금액과 방향은 그대로 두고 상대편(카테고리 · 계좌)만 바꿉니다.
 * target = { kind: 'EXPENSE'|'INCOME'|'REFUND'|'TRANSFER'|'PASSTHROUGH', categoryId?, accountId?, passKind? }
 * opts.viewAcct: 거래 탭에서 보고 있는 계좌 (이체를 지출 · 수입으로 바꿀 때 그 계좌 쪽을 씀)
 */
export function planRetype(items, ids, target, accMap, now, opts) {
  const o = opts || {};
  const want = new Set(Array.from(ids || [], String));
  const out = { txns: [], postings: [], lineItems: [], skipped: [], changed: 0, remember: [] };
  const rcIds = new Set((o.lineItems || []).filter((li) => !L.truthy(li.deleted)).map((li) => String(li.txn_id)));
  const tk = target.kind;
  const sig = (ps) => live(ps).map((q) => String(q.account_id) + ':' + L.round(L.num(q.amount_cad), 2)).sort().join('|');
  (items || []).forEach((it) => {
    const id = String(it.txn.txn_id);
    if (!want.has(id) || L.truthy(it.txn.deleted)) return;
    const ps = live(it.ps);
    const d = it.desc || L.describeTxn(it.txn, ps, accMap);
    if (d.kind === 'OPENING') { out.skipped.push({ id, reason: 'opening' }); return; }
    if (d.split) { out.skipped.push({ id, reason: 'split' }); return; }
    if (rcIds.has(id)) { out.skipped.push({ id, reason: 'receipt' }); return; }
    const f0 = L.formFromTxn(it.txn, ps, accMap);
    // 은행 쪽 계좌와 방향
    let money, flow, other = '';
    if (d.kind === 'TRANSFER') {
      const wantIn = tk === 'INCOME' || tk === 'REFUND';
      const useTo = o.viewAcct ? String(o.viewAcct) === String(f0.toId) : wantIn;
      money = useTo ? f0.toId : f0.fromId; flow = useTo ? 'in' : 'out'; other = useTo ? f0.fromId : f0.toId;
    } else { money = d.accountId; flow = d.flow === 'in' ? 'in' : 'out'; }
    const f = Object.assign({}, f0, { split: false, lines: [], refund: false, passthrough: false, fromId: '', toId: '', categoryId: '' });
    if (tk === 'EXPENSE' || tk === 'REFUND') {
      if (tk === 'REFUND' && flow !== 'in') { out.skipped.push({ id, reason: 'direction' }); return; }
      Object.assign(f, { kind: 'EXPENSE', fromId: money, categoryId: String(target.categoryId), refund: flow === 'in' });
    } else if (tk === 'INCOME') {
      if (flow !== 'in') { out.skipped.push({ id, reason: 'direction' }); return; }
      Object.assign(f, { kind: 'INCOME', toId: money, categoryId: String(target.categoryId) });
    } else if (tk === 'TRANSFER') {
      const x = String(target.accountId || '');
      if (!x || x === String(money)) { out.skipped.push({ id, reason: 'sameacct' }); return; }
      Object.assign(f, flow === 'out' ? { kind: 'TRANSFER', fromId: money, toId: x } : { kind: 'TRANSFER', fromId: x, toId: money });
    } else if (tk === 'PASSTHROUGH') {
      Object.assign(f, flow === 'out' ? { kind: 'EXPENSE', fromId: money } : { kind: 'INCOME', toId: money }, { passthrough: true, passKind: target.passKind === 'CHURCH' ? 'CHURCH' : 'PERSONAL' });
    } else return;
    const res = L.makeRecords(f, { accMap, existing: { txn: it.txn, ps: it.ps }, now });
    if (res.error) { out.skipped.push({ id, reason: 'special' }); return; }
    const before = sig(ps), after = sig(res.postings);
    if (before === after && L.truthy(it.txn.is_passthrough) === L.truthy(res.txn.is_passthrough)) return;
    if (String(res.txn.status).toUpperCase() === 'REVIEW' && !(tk !== 'TRANSFER' && String(target.categoryId) === '9999')) res.txn.status = 'MATCHED';
    out.txns.push(res.txn);
    res.postings.forEach((q) => out.postings.push(q));
    out.changed++;
    void other;
  });
  return out;
}

/**
 * 카테고리 · 종류 바꾸기 (선택한 거래 전부).
 * 같은 종류 안에서 카테고리만 바꾸는 거래는 planBulk(영수증 항목 · 규칙 기억까지), 종류가 바뀌는 거래는 planRetype.
 */
export function planChange(items, ids, target, accMap, now, opts) {
  const want = new Set(Array.from(ids || [], String));
  const chosen = (items || []).filter((it) => want.has(String(it.txn.txn_id)));
  const kindOf = (it) => it.desc || L.describeTxn(it.txn, live(it.ps), accMap);
  const sameKind = (it) => {
    const d = kindOf(it);
    if (target.kind === 'EXPENSE') return d.kind === 'EXPENSE';
    if (target.kind === 'INCOME') return d.kind === 'INCOME';
    if (target.kind === 'REFUND') return d.kind === 'EXPENSE' && d.flow === 'in';
    return false;
  };
  const a = chosen.filter(sameKind), b = chosen.filter((it) => !sameKind(it));
  const p1 = a.length ? planBulk(a, a.map((it) => String(it.txn.txn_id)), { categoryId: target.categoryId }, accMap, now, opts) : null;
  const p2 = b.length ? planRetype(b, b.map((it) => String(it.txn.txn_id)), target, accMap, now, opts) : null;
  const out = { txns: [], postings: [], lineItems: [], skipped: [], changed: 0, remember: [] };
  [p1, p2].forEach((p) => { if (!p) return; ['txns', 'postings', 'lineItems', 'skipped', 'remember'].forEach((k) => { out[k] = out[k].concat(p[k] || []); }); out.changed += p.changed; });
  return out;
}

/** 건너뛴 이유 요약: "split (나눈 거래) 2, transfer (이체) 1" */
export function skipSummary(skipped) {
  const n = new Map();
  (skipped || []).forEach((s) => n.set(s.reason, (n.get(s.reason) || 0) + 1));
  return Array.from(n.entries()).map(([k, v]) => (REASON_SHORT[k] || k) + ' ' + v).join(', ');
}

/** 저장할 시트와 순서 */
export function batchOf(plan, rules, isDelete) {
  const puts = { Transactions: plan.txns, Postings: plan.postings };
  if (plan.lineItems && plan.lineItems.length) puts.LineItems = plan.lineItems;
  if (rules && rules.length) puts.Rules = rules;
  const order = isDelete ? ['Transactions', 'Postings', 'LineItems', 'Rules'] : ['Postings', 'LineItems', 'Transactions', 'Rules'];
  return { puts, order: order.filter((s) => puts[s] && puts[s].length) };
}

// ───────── 화면 ─────────

const ownerLabel = (o) => (typeof L.ownerLabel === 'function' ? L.ownerLabel(o) : o);

/**
 * 아래쪽 작업 막대.
 * ctx = { selected: Set, shownIds: () => string[], onChange(), onDone(), onSelectAll() }
 * api = 거래 탭 api (h, fmt, state, toast, rerender, reload?/drillApi?)
 */
export function bulkBar(api, ctx) {
  const { h } = api;
  const count = h('b', { class: 'bk-count', id: 'bk-count', 'aria-live': 'polite' });
  const allBtn = h('button', { type: 'button', class: 'bk-link', id: 'bk-all', onclick: () => ctx.onSelectAll() });
  const clearBtn = h('button', { type: 'button', class: 'bk-link', id: 'bk-clear', onclick: () => { ctx.selected.clear(); ctx.onChange(); } }, 'Clear (해제)');
  const doneBtn = h('button', { type: 'button', class: 'bk-x', id: 'bk-done', 'aria-label': 'Done — leave selection (선택 끝내기)', title: 'Done (완료) · Esc', onclick: () => ctx.onDone() }, icon('close', 22));
  const act = (id, ic, label, fn, cls) => h('button', { type: 'button', class: 'bk-act' + (cls ? ' ' + cls : ''), id, onclick: fn }, icon(ic, 22), h('span', null, label));
  const acts = [
    act('bk-cat', 'tag', 'Type & category (종류 · 카테고리)', () => openCategory(api, ctx)),
    act('bk-owner', 'people', 'Owner (소유자)', () => openOwner(api, ctx)),
    act('bk-rev', 'check', 'Reviewed (확인 완료)', () => run(api, ctx, { status: 'MATCHED' }, { label: 'Marked reviewed (확인 완료)' })),
    act('bk-pass', 'transfer', 'Passthrough (전달 자금)', () => openPass(api, ctx)),
    act('bk-refund', 'undo', 'Refund (환불)', () => openRefund(api, ctx)),
    act('bk-trip', 'calendar', 'Trip tag (여행 태그)', () => openTrip(api, ctx)),
    act('bk-memo', 'memo', 'Memo (메모)', () => openMemo(api, ctx)),
    act('bk-del', 'trash', 'Delete (삭제)', () => doDelete(api, ctx), 'danger')
  ];
  const bar = h('div', { class: 'bk-bar', id: 'bk-bar', role: 'toolbar', 'aria-label': 'Selected transactions (선택한 거래)' },
    h('div', { class: 'bk-in' },
      h('div', { class: 'bk-top' }, doneBtn, count, h('span', { class: 'bk-sp' }), allBtn, clearBtn),
      h('div', { class: 'bk-acts' }, acts)));
  bar.update = () => {
    const n = ctx.selected.size;
    const shown = ctx.shownIds();
    count.textContent = n ? n + ' selected (' + n + '건 선택)' : 'Tap rows to select (눌러서 선택)';
    const all = shown.length && shown.every((id) => ctx.selected.has(id));
    allBtn.textContent = all ? 'Unselect shown (보이는 것 해제)' : 'Select all shown · ' + shown.length + ' (보이는 것 모두)';
    allBtn.disabled = !shown.length;
    clearBtn.hidden = !n;
    acts.forEach((b) => { b.disabled = !n; });
  };
  bar.update();
  return bar;
}

function chosenItems(api, ctx) {
  const d = api.state.d;
  return Array.from(ctx.selected).map((id) => d.itemById.get(String(id))).filter(Boolean);
}

async function reloadAll(api) {
  const da = api.drillApi ? api.drillApi() : null;
  const rl = api.reload || (da && da.reload);
  if (rl) await rl();
  api.rerender();
}

/** 계획 → 한 번에 저장 → 다시 그리기 · 결과 알림 */
async function run(api, ctx, patch, o) {
  const opts = o || {};
  const st = api.state;
  const items = chosenItems(api, ctx);
  let plan;
  try { plan = planBulk(items, ctx.selected, patch, st.d.accMap, L.nowIso(), { lineItems: st.data.lineItems || [] }); } catch (e) { api.toast(e.message || String(e)); return false; }
  const rules = opts.remember && plan.remember.length ? rulesFromRemember(plan.remember, st.data.rules || [], L.nowIso()) : [];
  const skipTxt = plan.skipped.length ? ' · skipped ' + plan.skipped.length + ' (건너뜀 ' + plan.skipped.length + '): ' + skipSummary(plan.skipped) : '';
  if (!plan.changed && !rules.length) { api.toast('Nothing to change (바꿀 것이 없습니다)' + skipTxt); return false; }
  const { puts, order } = batchOf(plan, rules, !!patch.delete);
  try {
    await sync.saveBatch(puts, order);
  } catch (e) { api.toast('Could not save (저장하지 못했습니다): ' + (e.message || e)); return false; }
  ctx.selected.clear();
  ctx.onDone(true);
  await reloadAll(api);
  api.toast((opts.label || 'Updated (변경)') + ' ' + plan.changed + ' (' + plan.changed + '건)' + (rules.length ? ' · rules ' + rules.length + ' (규칙 ' + rules.length + ')' : '') + skipTxt);
  return true;
}

async function doDelete(api, ctx) {
  const n = ctx.selected.size;
  if (!n) return;
  if (!window.confirm('Delete ' + n + ' transaction(s)? (거래 ' + n + '건을 삭제할까요?)')) return;
  await run(api, ctx, { delete: true }, { label: 'Deleted (삭제)' });
}

// ── 고르기 창 (#overlay 의 시트)
export function sheet(api, title, sub, body, foot) {
  const { h } = api;
  const ov = document.getElementById('overlay');
  if (!ov) return null;
  ov.hidden = false;
  document.body.classList.add('noscroll');
  const close = () => { ov.hidden = true; ov.replaceChildren(); document.body.classList.remove('noscroll'); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  const sh = h('div', { class: 'sheet bk-sheet', role: 'dialog', 'aria-label': title },
    h('div', { class: 'sheet-head' }, h('h2', null, title),
      h('button', { type: 'button', class: 'icon', id: 'bk-close', 'aria-label': 'Close (닫기)', onclick: () => close() }, icon('close', 22))),
    sub ? h('p', { class: 'hint' }, sub) : null,
    body, foot || null);
  const bd = h('div', { class: 'backdrop', onclick: (e) => { if (e.target === bd) close(); } }, sh);
  ov.replaceChildren(bd);
  return close;
}

export function categoryGroups(accounts) {
  const groups = [];
  const by = new Map();
  (accounts || []).filter((a) => L.isActive(a) && (a.type === 'EXPENSE' || a.type === 'INCOME')).forEach((a) => {
    const g = a.type === 'INCOME' ? '수입' : (a.report_group && a.report_group !== '수입' ? a.report_group : '확인 필요');
    if (!by.has(g)) by.set(g, []);
    by.get(g).push(a);
  });
  const order = L.GROUP_ORDER.concat(['수입']);
  order.filter((g) => by.has(g)).concat(Array.from(by.keys()).filter((g) => order.indexOf(g) < 0)).forEach((g) => {
    const list = by.get(g).slice().sort((x, y) => (L.num(x.sort_order) - L.num(y.sort_order)) || String(x.name).localeCompare(String(y.name)));
    groups.push({ key: g, label: L.GROUP_LABELS[g] || g, list });
  });
  return groups;
}

// 종류 · 카테고리 바꾸기: 지출 · 수입 · 환불 · 이체 · 전달 자금
const TYPE_TABS = [
  ['EXPENSE', 'Spending (지출)'], ['INCOME', 'Income (수입)'], ['REFUND', 'Refund (환불)'], ['TRANSFER', 'Transfer (이체)'], ['PASSTHROUGH', 'Passthrough (전달 자금)']
];
function openCategory(api, ctx, startTab) {
  const { h } = api;
  const st = api.state;
  const items = chosenItems(api, ctx);
  const n = ctx.selected.size;
  // 처음 탭: 선택한 거래 대부분의 종류
  const cnt = {};
  items.forEach((it) => { const d = it.desc; const k = d.kind === 'EXPENSE' && d.flow === 'in' ? 'REFUND' : d.kind; cnt[k] = (cnt[k] || 0) + 1; });
  let tab = startTab || Object.keys(cnt).filter((k) => TYPE_TABS.some((t) => t[0] === k)).sort((x, y) => cnt[y] - cnt[x])[0] || 'EXPENSE';
  let pick = '';          // 카테고리 id · 계좌 id · 'PERSONAL'|'CHURCH'
  let remember = false;
  const target = () => (tab === 'TRANSFER' ? { kind: tab, accountId: pick } : tab === 'PASSTHROUGH' ? { kind: tab, passKind: pick } : { kind: tab, categoryId: pick });
  const opts = () => ({ lineItems: st.data.lineItems || [], viewAcct: st.acct || '' });
  const preview = h('div', { class: 'bk-prev', id: 'bk-prev', 'aria-live': 'polite' });
  const applyBtn = h('button', { type: 'button', class: 'btn', id: 'bk-apply', disabled: true }, 'Apply (적용)');
  const remBox = h('label', { class: 'check bk-rem' },
    h('input', { type: 'checkbox', id: 'bk-remember', onchange: (e) => { remember = e.target.checked; } }),
    h('span', null, 'Remember as rule — use this category for these merchants next time (규칙으로 기억 — 다음부터 이 가게는 자동 분류)'));
  remBox.hidden = true;
  const tabsEl = h('div', { class: 'segtd sm bk-types', role: 'tablist', id: 'bk-types', 'aria-label': 'Type (종류)' });
  const body = h('div', { class: 'bk-cats', id: 'bk-cats' });
  const find = h('input', { type: 'search', id: 'bk-find', placeholder: 'Find (찾기)', autocomplete: 'off', oninput: () => filter() });
  const findBox = h('div', { class: 'search bk-find' }, icon('search', 20), find);
  const note = h('p', { class: 'hint bk-tnote', id: 'bk-tnote' });
  const NOTES = {
    EXPENSE: 'Money out becomes spending; money in becomes a refund of that category (나간 돈 → 지출, 들어온 돈 → 그 카테고리 환불).',
    INCOME: 'Only money that came in can be income (들어온 돈만 수입이 돼요).',
    REFUND: 'Money that came back — reduces that category\'s spending. Only money in (돌아온 돈 · 들어온 돈만).',
    TRANSFER: 'Between your own accounts — not income or spending (내 계좌끼리 · 수입·지출 아님).',
    PASSTHROUGH: 'Money handled for someone else — left out of income and spending (다른 사람 몫 · 수입·지출에서 빠짐).'
  };
  function filter() {
    const q = find.value.trim().toLowerCase();
    body.querySelectorAll('.bk-cat').forEach((b) => { b.hidden = !!q && (b.getAttribute('data-n') || '').indexOf(q) < 0; });
    body.querySelectorAll('.bk-grp').forEach((g) => { g.hidden = !g.querySelector('.bk-cat:not([hidden])'); });
  }
  const btn = (id, label, cls, nm) => h('button', { type: 'button', class: 'bk-cat ' + (cls || ''), 'data-id': id, 'data-n': nm || label.toLowerCase(), 'aria-pressed': String(id === pick), onclick: () => { pick = id; refresh(); } }, label);
  function drawBody() {
    tabsEl.replaceChildren(...TYPE_TABS.map(([k, lab]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(k === tab), class: k === tab ? 'on' : '', 'data-type': k, onclick: () => { if (tab !== k) { tab = k; pick = ''; drawBody(); refresh(); } } }, lab, cnt[k] ? h('span', { class: 'ko' }, ' ' + cnt[k]) : null)));
    note.textContent = NOTES[tab];
    findBox.hidden = tab === 'PASSTHROUGH';
    find.value = '';
    let kids;
    if (tab === 'TRANSFER') {
      const accts = (st.data.accounts || []).filter((a) => L.isActive(a) && L.isMoneyAccount(a)).sort((x, y) => (L.num(x.sort_order) - L.num(y.sort_order)) || String(x.name).localeCompare(String(y.name)));
      kids = [h('div', { class: 'bk-grp' }, h('div', { class: 'bk-gh' }, 'Other account (상대 계좌)'), h('div', { class: 'bk-cl' }, accts.map((a) => btn(String(a.account_id), L.accLabel(st.d.accMap.get(String(a.account_id)) || a), '', (String(a.name) + ' ' + String(a.name_ko || '')).toLowerCase()))))];
    } else if (tab === 'PASSTHROUGH') {
      const church = !!st.d.accMap.get(CONFIG.CLEARING_CHURCH_ID);
      kids = [h('div', { class: 'bk-grp' }, h('div', { class: 'bk-cl' }, [btn('PERSONAL', 'Personal (개인)'), church ? btn('CHURCH', 'Church (교회)') : null].filter(Boolean)))];
    } else {
      const want = tab === 'INCOME' ? '수입' : null;
      kids = categoryGroups(st.data.accounts).filter((g) => (want ? g.key === want : g.key !== '수입')).map((g) => h('div', { class: 'bk-grp' },
        h('div', { class: 'bk-gh ' + (L.GROUP_CLASS[g.key] || '') }, g.label),
        h('div', { class: 'bk-cl' }, g.list.map((a) => btn(String(a.account_id), L.accLabel(a), L.GROUP_CLASS[g.key] || '', (String(a.name) + ' ' + String(a.name_ko || '')).toLowerCase())))));
    }
    body.replaceChildren(...kids);
  }
  function refresh() {
    body.querySelectorAll('.bk-cat').forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute('data-id') === pick)));
    if (!pick) { preview.textContent = tab === 'TRANSFER' ? 'Pick the other account (상대 계좌를 고르세요)' : tab === 'PASSTHROUGH' ? 'Pick personal or church (개인 · 교회를 고르세요)' : 'Pick a category (카테고리를 고르세요)'; applyBtn.disabled = true; remBox.hidden = true; return; }
    let plan;
    try { plan = planChange(items, ctx.selected, target(), st.d.accMap, L.nowIso(), opts()); } catch (e) { preview.textContent = e.message; applyBtn.disabled = true; return; }
    const tl = TYPE_TABS.find((t) => t[0] === tab)[1];
    const nm = tab === 'PASSTHROUGH' ? (pick === 'CHURCH' ? 'Church (교회)' : 'Personal (개인)') : L.accLabel(st.d.accMap.get(pick));
    preview.replaceChildren(...[h('b', null, tl + ' · ' + nm),
      h('span', null, ' — ' + plan.changed + ' will change (' + plan.changed + '건 변경)'),
      plan.skipped.length ? h('span', { class: 'bk-skip' }, ' · skipped ' + plan.skipped.length + ' (건너뜀 ' + plan.skipped.length + '): ' + skipSummary(plan.skipped)) : null].filter(Boolean));
    applyBtn.disabled = !plan.changed;
    remBox.hidden = !plan.remember.length;
  }
  applyBtn.addEventListener('click', async () => {
    applyBtn.disabled = true;
    let plan;
    try { plan = planChange(items, ctx.selected, target(), st.d.accMap, L.nowIso(), opts()); } catch (e) { api.toast(e.message || String(e)); applyBtn.disabled = false; return; }
    const rules = remember && plan.remember.length ? rulesFromRemember(plan.remember, st.data.rules || [], L.nowIso()) : [];
    if (!plan.changed && !rules.length) { api.toast('Nothing to change (바꿀 것이 없습니다)'); applyBtn.disabled = false; return; }
    const { puts, order } = batchOf(plan, rules, false);
    try { await sync.saveBatch(puts, order); } catch (e) { api.toast('Could not save (저장하지 못했습니다): ' + (e.message || e)); applyBtn.disabled = false; return; }
    close();
    ctx.selected.clear(); ctx.onDone(true);
    await reloadAll(api);
    api.toast('Changed (변경) ' + plan.changed + ' (' + plan.changed + '건)' + (rules.length ? ' · rules ' + rules.length + ' (규칙 ' + rules.length + ')' : '') + (plan.skipped.length ? ' · skipped ' + plan.skipped.length + ' (건너뜀): ' + skipSummary(plan.skipped) : ''));
  });
  drawBody(); refresh();
  const close = sheet(api, 'Change type & category (종류 · 카테고리 바꾸기)', n + ' selected (' + n + '건 선택) · bank amounts stay the same (은행 금액은 그대로)',
    h('div', null, tabsEl, note, findBox, body),
    h('div', { class: 'bk-foot' }, preview, remBox, h('div', { class: 'btnrow' }, applyBtn, h('button', { type: 'button', class: 'btn secondary', onclick: () => close() }, 'Cancel (취소)'))));
}

function openOwner(api, ctx) {
  const { h } = api;
  const n = ctx.selected.size;
  const owners = (CONFIG.OWNERS || ['Patrick', 'Ms Kim', 'Joint']);
  const close = sheet(api, 'Change owner (소유자 바꾸기)', n + ' selected (' + n + '건 선택) · every line gets this owner (모든 줄에 적용)',
    h('div', { class: 'bk-owners', id: 'bk-owners' }, owners.map((o) => h('button', {
      type: 'button', class: 'bk-owner', 'data-owner': o,
      onclick: async () => { await run(api, ctx, { owner: o }, { label: 'Owner changed (소유자 변경)' }); close(); }
    }, icon('people', 22), h('span', null, ownerLabel(o))))));
}

// 전달 자금 켜기 · 끄기
function openPass(api, ctx) {
  const { h } = api;
  const items = chosenItems(api, ctx);
  const n = items.length;
  const isPass = (it) => (it.desc && it.desc.kind === 'PASSTHROUGH') || L.truthy(it.txn.is_passthrough);
  const nOn = items.filter(isPass).length;
  const hasChurch = !!api.state.d.accMap.get(CONFIG.CLEARING_CHURCH_ID);
  const opt = (id, ic, title, sub, fn) => h('button', { type: 'button', class: 'bk-opt', id, onclick: fn }, icon(ic, 22), h('span', null, h('b', null, title), h('small', null, sub)));
  const close = sheet(api, 'Passthrough (전달 자금)', n + ' selected (' + n + '건 선택) · ' + nOn + ' already passthrough (이미 전달 자금 ' + nOn + '건)',
    h('div', { class: 'bk-opts', id: 'bk-pass-opts' },
      opt('bk-pass-on', 'people', 'Turn on — personal (켜기 · 개인)', 'Money passed on for someone else; left out of income and spending (다른 사람 몫 · 수입·지출에서 빠짐)',
        async () => { close(); await run(api, ctx, { special: 'PASSTHROUGH', passKind: 'PERSONAL' }, { label: 'Passthrough on (전달 자금 켬)' }); }),
      hasChurch ? opt('bk-pass-church', 'people', 'Turn on — church (켜기 · 교회)', 'Church money you collect or pay out (교회 돈)',
        async () => { close(); await run(api, ctx, { special: 'PASSTHROUGH', passKind: 'CHURCH' }, { label: 'Passthrough on — church (교회 전달 자금)' }); }) : null,
      opt('bk-pass-off', 'tag', 'Turn off (끄기)', 'Back to spending or income — pick the category next (다시 지출·수입으로 · 다음에 카테고리 선택)',
        () => { close(); openCategory(api, ctx, 'EXPENSE'); })));
  return close;
}

// 환불 켜기 · 끄기
function openRefund(api, ctx) {
  const { h } = api;
  const st = api.state;
  const items = chosenItems(api, ctx);
  const n = items.length;
  const nOn = items.filter((it) => it.desc && it.desc.kind === 'EXPENSE' && it.desc.flow === 'in').length;
  const go = async (on) => {
    close();
    let plan;
    try { plan = planRefund(items, ctx.selected, on, st.d.accMap, L.nowIso(), { lineItems: st.data.lineItems || [] }); } catch (e) { api.toast(e.message || String(e)); return; }
    const skipTxt = plan.skipped.length ? ' · skipped ' + plan.skipped.length + ' (건너뜀): ' + skipSummary(plan.skipped) : '';
    if (!plan.changed) { api.toast('Nothing to change (바꿀 것이 없습니다)' + skipTxt); return; }
    const { puts, order } = batchOf(plan, [], false);
    try { await sync.saveBatch(puts, order); } catch (e) { api.toast('Could not save (저장하지 못했습니다): ' + (e.message || e)); return; }
    ctx.selected.clear(); ctx.onDone(true);
    await reloadAll(api);
    api.toast((on ? 'Marked as refund (환불로 바꿈) ' : 'Refund off (환불 해제) ') + plan.changed + ' (' + plan.changed + '건)' + skipTxt);
  };
  const opt = (id, ic, title, sub, fn) => h('button', { type: 'button', class: 'bk-opt', id, onclick: fn }, icon(ic, 22), h('span', null, h('b', null, title), h('small', null, sub)));
  const close = sheet(api, 'Refund (환불)', n + ' selected (' + n + '건 선택) · ' + nOn + ' already refunds (이미 환불 ' + nOn + '건)',
    h('div', { class: 'bk-opts', id: 'bk-refund-opts' },
      opt('bk-refund-on', 'undo', 'Turn on (켜기)', 'Money came back — reduces that category\'s spending (돈이 돌아옴 · 그 카테고리 지출에서 빠짐)', () => go(true)),
      opt('bk-refund-off', 'tag', 'Turn off (끄기)', 'Normal spending again (다시 일반 지출로)', () => go(false))));
  return close;
}

function existingTrips(api) {
  const s = new Set();
  api.state.d.items.forEach((it) => { const t = String(it.txn.trip_tag || '').trim(); if (t) s.add(t); });
  return Array.from(s).sort();
}

function openTrip(api, ctx) {
  const { h } = api;
  const n = ctx.selected.size;
  const trips = existingTrips(api);
  const inp = h('input', { type: 'text', id: 'bk-trip-in', placeholder: 'e.g. Japan 2026 (예: 일본 2026)', autocomplete: 'off', enterkeyhint: 'done', list: 'bk-trips' });
  const go = async (tag) => { await run(api, ctx, { tripTag: tag }, { label: tag ? 'Trip tag set (여행 태그 지정)' : 'Trip tag removed (여행 태그 지움)' }); close(); };
  const close = sheet(api, 'Trip tag (여행 태그)', n + ' selected (' + n + '건 선택)',
    h('div', null,
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Tag (태그)'), inp, h('datalist', { id: 'bk-trips' }, trips.map((t) => h('option', { value: t })))),
      trips.length ? h('div', { class: 'bk-chips' }, trips.slice(-8).map((t) => h('button', { type: 'button', class: 'chipf', onclick: () => { inp.value = t; } }, t))) : null),
    h('div', { class: 'btnrow' },
      h('button', { type: 'button', class: 'btn', id: 'bk-trip-set', onclick: () => { const v = inp.value.trim(); if (!v) { inp.focus(); return; } go(v); } }, 'Apply (적용)'),
      h('button', { type: 'button', class: 'btn danger', id: 'bk-trip-clear', onclick: () => go('') }, 'Remove tag (태그 지우기)')));
}

function openMemo(api, ctx) {
  const { h } = api;
  const n = ctx.selected.size;
  const inp = h('input', { type: 'text', id: 'bk-memo-in', placeholder: 'Added to the end of each memo (각 메모 끝에 덧붙임)', autocomplete: 'off', enterkeyhint: 'done' });
  const close = sheet(api, 'Add to memo (메모 덧붙이기)', n + ' selected (' + n + '건 선택)',
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Text (내용)'), inp),
    h('div', { class: 'btnrow' },
      h('button', { type: 'button', class: 'btn', id: 'bk-memo-add', onclick: async () => { const v = inp.value.trim(); if (!v) { inp.focus(); return; } await run(api, ctx, { memoAppend: v }, { label: 'Memo added (메모 추가)' }); close(); } }, 'Apply (적용)'),
      h('button', { type: 'button', class: 'btn secondary', onclick: () => close() }, 'Cancel (취소)')));
}

// ───────── 한 건 바로 고치기 (거래 탭 · 상세 패널에서 공통) ─────────

/** 거래 한 건이 누구 몫인지: 'Patrick' 같은 한 사람, 나눈 줄의 소유자가 서로 다르면 'MIXED' */
export function ownerOfItem(it) {
  const t = it.txn;
  const live = (it.ps || []).filter((p) => !L.truthy(p.deleted) && String(p.owner || '').trim());
  const base = String(t.owner || '').trim() || 'Joint';
  const set = new Set(live.map((p) => String(p.owner).trim()));
  if (it.desc && it.desc.split && it.desc.lines) it.desc.lines.forEach((l) => set.add(String(l.owner || base).trim() || base));
  if (set.size > 1) return 'MIXED';
  return set.size === 1 ? Array.from(set)[0] : base;
}

/** 거래 한 건에 patch({ owner } 등)를 적용해 저장하고 다시 그립니다. 성공하면 true */
export async function patchOne(api, it, patch, label) {
  const st = api.state;
  const id = String(it.txn.txn_id);
  let plan;
  try { plan = planBulk([it], [id], patch, st.d.accMap, L.nowIso(), { lineItems: st.data.lineItems || [] }); } catch (e) { api.toast(e.message || String(e)); return false; }
  if (!plan.changed) { api.toast('Nothing to change (바꿀 것이 없습니다)' + (plan.skipped.length ? ': ' + skipSummary(plan.skipped) : '')); return false; }
  const { puts, order } = batchOf(plan, [], false);
  try { await sync.saveBatch(puts, order); } catch (e) { api.toast('Could not save (저장하지 못했습니다): ' + (e.message || e)); return false; }
  const da = api.drillApi ? api.drillApi() : null;
  const rl = api.reload || (da && da.reload);
  if (rl) await rl();
  if (api.rerender) api.rerender(); else if (api.renderBody) api.renderBody(true);
  if (label) api.toast(label);
  return true;
}

/**
 * 소유자 바로 바꾸기 (한 건). 줄마다 소유자가 다른 나눈 거래는 줄 편집 화면을 엽니다.
 * api: { h, state, toast, reload?|drillApi?, rerender?|renderBody?, openForm }
 */
export function pickOwner(api, it) {
  const { h } = api;
  const cur = ownerOfItem(it);
  if (cur === 'MIXED') { api.openForm(it.txn.txn_id, { startSplit: true }); return; }
  const owners = (CONFIG.OWNERS || ['Patrick', 'Ms Kim', 'Joint']);
  const name = it.txn.merchant || it.txn.memo || (it.desc && it.desc.categoryName) || '';
  const close = sheet(api, 'Who is this for? (누구 거래인가요?)', name + ' · ' + L.fmtNumber(Math.abs(L.num(it.txn.total_cad)), 'CAD'),
    h('div', { class: 'bk-owners', id: 'own-pick' }, owners.map((o) => h('button', {
      type: 'button', class: 'bk-owner' + (o === cur ? ' on' : ''), 'data-owner': o, 'aria-pressed': String(o === cur),
      onclick: async () => {
        if (o === cur) { close(); return; }
        close();
        await patchOne(api, it, { owner: o }, 'Owner: ' + ownerLabel(o) + ' (소유자 변경)');
      }
    }, icon('people', 22), h('span', null, ownerLabel(o))))));
  return close;
}

/** 거래 나누기: 영수증 항목이 있으면 항목별 편집(카테고리 · 소유자), 없으면 거래 입력 창을 나누기 상태로 엽니다 */
export function splitTxn(api, it) {
  api.openForm(it.txn.txn_id, { startSplit: true });
}
