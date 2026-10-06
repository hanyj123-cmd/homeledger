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
  special: 'Not an expense/income (지출·수입이 아님)'
};
export const REASON_SHORT = {
  transfer: 'transfer (이체)', split: 'split (나눈 거래)', receipt: 'receipt (영수증)', mismatch: 'type (종류 다름)', nocat: 'no category (카테고리 없음)', sameacct: 'same account (같은 계좌)', special: 'other type (다른 종류)'
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
  if (special === 'PASSTHROUGH' && !accMap.get(CONFIG.CLEARING_ID)) throw new Error('전달 자금(2900) 계정이 없습니다.');
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
      const clearing = ps.filter((q) => String(q.account_id) === CONFIG.CLEARING_ID);
      const exps = ps.filter((q) => typeOf(q) === 'EXPENSE');
      const incs = ps.filter((q) => typeOf(q) === 'INCOME');
      let target = null;
      let same = false;
      if (desc.kind === 'OPENING') skip = 'transfer';
      else if (desc.kind === 'TRANSFER') { if (special === 'PASSTHROUGH') skip = 'transfer'; else same = true; }
      else if (desc.kind === 'PASSTHROUGH') {
        if (special === 'PASSTHROUGH') same = true;
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
        pget(target).account_id = special === 'TRANSFER' ? String(xacct.account_id) : CONFIG.CLEARING_ID;
        const pass = special === 'PASSTHROUGH';
        if (L.truthy(t.is_passthrough) !== pass) t.is_passthrough = pass;
        if (String(t.status).toUpperCase() === 'REVIEW') t.status = 'MATCHED';
        dirty = true;
      }
    }

    if (cat) {
      const desc = it.desc || L.describeTxn(it.txn, ps, accMap);
      const clearing = ps.filter((q) => String(q.account_id) === CONFIG.CLEARING_ID);
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
            if (k && !remembered.has(k)) { remembered.add(k); out.remember.push({ merchant: t.merchant, accountId: String(cat.account_id), previousAccountId: prev === CONFIG.CLEARING_ID ? '' : prev }); }
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
    act('bk-cat', 'tag', 'Category (카테고리)', () => openCategory(api, ctx)),
    act('bk-owner', 'people', 'Owner (소유자)', () => openOwner(api, ctx)),
    act('bk-rev', 'check', 'Reviewed (확인 완료)', () => run(api, ctx, { status: 'MATCHED' }, { label: 'Marked reviewed (확인 완료)' })),
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

function openCategory(api, ctx) {
  const { h } = api;
  const st = api.state;
  const items = chosenItems(api, ctx);
  let pick = '';        // 카테고리 id, 또는 '__PT'(전달 자금) / '__TR'(이체)
  let xacct = '';       // 이체 상대 계좌
  let remember = false;
  const patchNow = () => (pick === '__PT' ? { special: 'PASSTHROUGH' } : pick === '__TR' ? { special: 'TRANSFER', transferAccountId: xacct } : { categoryId: pick });
  const preview = h('div', { class: 'bk-prev', id: 'bk-prev', 'aria-live': 'polite' }, 'Pick a category below (아래에서 카테고리를 고르세요)');
  const applyBtn = h('button', { type: 'button', class: 'btn', id: 'bk-apply', disabled: true, onclick: async () => {
    applyBtn.disabled = true;
    const okd = await run(api, ctx, patchNow(), { remember, label: pick === '__PT' ? 'Set to passthrough (전달 자금으로 변경)' : pick === '__TR' ? 'Set to transfer (이체로 변경)' : 'Category changed (카테고리 변경)' });
    if (okd) close(); else applyBtn.disabled = false;
  } }, 'Apply (적용)');
  const remBox = h('label', { class: 'check bk-rem' },
    h('input', { type: 'checkbox', id: 'bk-remember', onchange: (e) => { remember = e.target.checked; } }),
    h('span', null, 'Remember as rule — use this category for these merchants next time (규칙으로 기억 — 다음부터 이 가게는 자동 분류)'));
  const find = h('div', { class: 'search bk-find' }, icon('search', 20), h('input', {
    type: 'search', id: 'bk-find', placeholder: 'Find category (카테고리 찾기)', autocomplete: 'off',
    oninput: (e) => {
      const q = e.target.value.trim().toLowerCase();
      grid.querySelectorAll('.bk-cat').forEach((b) => { b.hidden = !!q && b.getAttribute('data-n').indexOf(q) < 0; });
      grid.querySelectorAll('.bk-grp').forEach((g) => { g.hidden = !g.querySelector('.bk-cat:not([hidden])'); });
    }
  }));
  const refresh = () => {
    grid.querySelectorAll('.bk-cat').forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute('data-id') === pick)));
    xrow.hidden = pick !== '__TR';
    if (!pick) return;
    if (pick === '__TR' && !xacct) { preview.textContent = 'Pick the other account below (상대 계좌를 고르세요)'; applyBtn.disabled = true; remBox.hidden = true; return; }
    let plan;
    try { plan = planBulk(items, ctx.selected, patchNow(), st.d.accMap, L.nowIso(), { lineItems: st.data.lineItems || [] }); } catch (e) { preview.textContent = e.message; applyBtn.disabled = true; return; }
    const nm = pick === '__PT' ? 'Passthrough (전달 자금)' : pick === '__TR' ? 'Transfer (이체) · ' + L.accLabel(st.d.accMap.get(xacct)) : L.accLabel(st.d.accMap.get(pick));
    preview.replaceChildren(...[
      h('b', null, nm),
      h('span', null, ' — ' + plan.changed + ' will change (' + plan.changed + '건 변경)'),
      plan.skipped.length ? h('span', { class: 'bk-skip' }, ' · skipped ' + plan.skipped.length + ' (건너뜀 ' + plan.skipped.length + '): ' + skipSummary(plan.skipped)) : null].filter(Boolean));
    applyBtn.disabled = !plan.changed;
    remBox.hidden = !plan.remember.length;
  };
  const catBtn = (id, label, cls, n) => h('button', {
    type: 'button', class: 'bk-cat ' + cls, 'data-id': id, 'data-n': n, 'aria-pressed': 'false',
    onclick: () => { pick = id; refresh(); }
  }, label);
  const moneyAccts = (st.data.accounts || []).filter((a) => L.isActive(a) && L.isMoneyAccount(a)).sort((x, y) => (L.num(x.sort_order) - L.num(y.sort_order)) || String(x.name).localeCompare(String(y.name)));
  const xsel = h('select', { id: 'bk-xacct', 'aria-label': 'Other account (상대 계좌)', onchange: (e) => { xacct = e.target.value; refresh(); } },
    [h('option', { value: '' }, 'Choose account… (계좌 선택…)')].concat(moneyAccts.map((a) => h('option', { value: a.account_id }, L.accLabel(st.d.accMap.get(String(a.account_id)) || a)))));
  const xrow = h('label', { class: 'field bk-xrow', id: 'bk-xrow', hidden: true },
    h('span', { class: 'lbl' }, 'Other account of the transfer (이체 상대 계좌)'), xsel);
  const other = h('div', { class: 'bk-grp', id: 'bk-other' },
    h('div', { class: 'bk-gh' }, 'Other types (그 밖의 유형)'),
    h('div', { class: 'bk-cl' }, [
      catBtn('__PT', 'Passthrough (전달 자금)', '', 'passthrough 전달 자금 pass'),
      catBtn('__TR', 'Transfer (이체)', '', 'transfer 이체')]),
    xrow);
  const grid = h('div', { class: 'bk-cats', id: 'bk-cats' }, [other].concat(categoryGroups(st.data.accounts).map((g) => h('div', { class: 'bk-grp' },
    h('div', { class: 'bk-gh ' + (L.GROUP_CLASS[g.key] || '') }, g.label),
    h('div', { class: 'bk-cl' }, g.list.map((a) => catBtn(String(a.account_id), L.accLabel(a), L.GROUP_CLASS[g.key] || '', (String(a.name) + ' ' + String(a.name_ko || '')).toLowerCase())))))));
  remBox.hidden = true;
  const n = ctx.selected.size;
  const close = sheet(api, 'Change category (카테고리 바꾸기)', n + ' selected (' + n + '건 선택) · splits are skipped (나눈 거래는 건너뜀)',
    h('div', null, find, grid),
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
