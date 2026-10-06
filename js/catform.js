// 카테고리(계정) 추가 · 이름 바꾸기 · 숨기기.
// 지출/수입 카테고리뿐 아니라 은행 계좌 · 카드 · 대출도 추가할 수 있습니다. 저장은 Accounts 시트에 (로컬 우선).
import * as L from './ledger.js';
import { CONFIG } from './config.js';
import { cleanLast4 } from './receipts.js';
import { icon } from './icons.js';

export const KINDS = [
  { key: 'EXPENSE', label: 'Spending (지출)', type: 'EXPENSE' },
  { key: 'INCOME', label: 'Income (수입)', type: 'INCOME' },
  { key: 'ASSET', label: 'Bank / savings / investment (계좌 · 저축 · 투자)', type: 'ASSET' },
  { key: 'LIABILITY', label: 'Card / loan (카드 · 대출)', type: 'LIABILITY' }
];
export const EXPENSE_GROUPS = ['고정비', 'semi-고정비', '유흥비', '금융비'];
const SUBTYPES = {
  ASSET: [['CHEQUING', 'Chequing (입출금)'], ['SAVINGS', 'Savings (저축)'], ['INVESTMENT', 'Investment (투자)'], ['CASH', 'Cash (현금)'], ['REAL_ESTATE', 'Property (부동산)'], ['VEHICLE', 'Vehicle (차량)'], ['OTHER', 'Other (기타)']],
  LIABILITY: [['CREDIT_CARD', 'Credit card (신용카드)'], ['LOC', 'Line of credit (LOC)'], ['MORTGAGE', 'Mortgage (모기지)'], ['INSTALLMENT', 'Loan (대출)'], ['OTHER', 'Other (기타)']]
};
// 번호대: 그룹마다 첫 자리. (기존 번호 체계와 같음)
const RANGE = { ASSET: [1000, 1899], LIABILITY: [2000, 2889], INCOME: [4000, 4899], '고정비': [5000, 5999], 'semi-고정비': [6000, 6999], '유흥비': [7000, 7999], '금융비': [8000, 8999] };

/** 새 계정 번호: 같은 번호대에서 가장 큰 번호 + 10 (넘치면 빈 번호) */
export function nextId(accounts, type, group) {
  const r = RANGE[type === 'EXPENSE' ? (group || '유흥비') : type] || [7000, 7999];
  const used = new Set((accounts || []).map((a) => String(a.account_id)));
  const nums = (accounts || []).map((a) => parseInt(a.account_id, 10)).filter((n) => n >= r[0] && n <= r[1]);
  let n = nums.length ? Math.floor(Math.max(...nums) / 10) * 10 + 10 : r[0] + 10;
  if (n > r[1]) n = r[0] + 1;
  while (used.has(String(n)) && n <= r[1]) n++;
  if (n > r[1]) { n = r[0]; while (used.has(String(n))) n++; }
  return String(n);
}
/** 새 행의 sort_order: 같은 그룹의 마지막 바로 뒤 */
export function nextSort(accounts, type, group) {
  const same = (accounts || []).filter((a) => a.type === type && (type !== 'EXPENSE' && type !== 'INCOME' ? true : (a.report_group || '') === (group || '')));
  const all = (accounts || []).map((a) => L.num(a.sort_order));
  if (same.length) return Math.max(...same.map((a) => L.num(a.sort_order))) + 1;
  return (all.length ? Math.max(...all) : 0) + 10;
}

/** 폼 값 → 저장할 Accounts 행 (오류면 { error }) */
export function makeAccountRow(accounts, f, existing, now) {
  const name = String(f.name || '').trim(), ko = String(f.name_ko || '').trim();
  if (!name && !ko) return { error: 'Enter a name (이름을 입력하세요)' };
  const type = existing ? existing.type : f.type;
  if (!['EXPENSE', 'INCOME', 'ASSET', 'LIABILITY'].includes(type)) return { error: 'Choose a type (종류를 고르세요)' };
  const group = type === 'EXPENSE' ? (EXPENSE_GROUPS.includes(f.group) || f.group === '확인 필요' ? f.group : '유흥비') : type === 'INCOME' ? '수입' : '';
  const dup = (accounts || []).find((a) => !L.truthy(a.deleted) && L.isActive(a) && a.type === type && (!existing || String(a.account_id) !== String(existing.account_id)) &&
    ((name && String(a.name).trim().toLowerCase() === name.toLowerCase()) || (ko && String(a.name_ko || '').trim() === ko)));
  if (dup) return { error: 'Already exists (이미 있어요): ' + (dup.name_ko || dup.name) };
  if (existing) {
    return { row: Object.assign({}, existing, { name: name || ko, name_ko: ko || name, report_group: (type === 'EXPENSE' || type === 'INCOME') ? group : existing.report_group || '',
      subtype: (type === 'ASSET' || type === 'LIABILITY') ? (f.subtype || existing.subtype || '') : existing.subtype || '',
      owner: (type === 'ASSET' || type === 'LIABILITY') ? (f.owner || existing.owner || 'Joint') : existing.owner || '',
      institution: f.institution !== undefined ? String(f.institution).trim() : existing.institution || '',
      last4: f.last4 !== undefined && (type === 'ASSET' || type === 'LIABILITY') ? cleanLast4(f.last4) : existing.last4 || '',
      is_active: f.active === false ? false : true, updated_at: now }) };
  }
  const id = nextId(accounts, type, group);
  return { row: {
    account_id: id, name: name || ko, name_ko: ko || name, type,
    subtype: (type === 'ASSET' || type === 'LIABILITY') ? (f.subtype || (type === 'ASSET' ? 'CHEQUING' : 'CREDIT_CARD')) : '',
    parent_id: '', owner: (type === 'ASSET' || type === 'LIABILITY') ? (f.owner || 'Joint') : '',
    institution: String(f.institution || '').trim(), currency: 'CAD', last4: (type === 'ASSET' || type === 'LIABILITY') ? cleanLast4(f.last4) : '', report_group: group,
    sort_order: nextSort(accounts, type, group), is_active: true, updated_at: now, deleted: false
  } };
}


// ───────── 삭제 (지출·수입 카테고리, 계좌·카드·대출) ─────────
// 거래가 하나도 없으면 바로 삭제, 있으면 다른 항목으로 옮긴 뒤 삭제합니다. (거래·영수증 항목·규칙·예산이 함께 옮겨집니다)
// 시스템 계정(전달 자금 · 기초 잔액 · 미분류)은 지울 수 없고, 대출·자산 평가 설정에서 쓰는 계정은 먼저 그 설정을 정리해야 합니다.
export const PROTECTED_IDS = [CONFIG.CLEARING_ID, CONFIG.OPENING_ID, '9999'];
const CHUNK = 400;

/** 이 계정을 쓰는 것들의 개수와 목록 */
export function usageOf(data, id) {
  id = String(id);
  const live = (x) => !L.truthy(x.deleted);
  const liveTxn = new Set((data.txns || []).filter(live).map((t) => String(t.txn_id)));
  const postings = (data.postings || []).filter((p) => live(p) && String(p.account_id) === id && liveTxn.has(String(p.txn_id)));
  const lineItems = (data.lineItems || []).filter((l) => live(l) && String(l.category_account_id) === id && liveTxn.has(String(l.txn_id)));
  const rules = (data.rules || []).filter((r) => live(r) && String(r.account_id) === id);
  const budgets = (data.budgets || []).filter((b) => live(b) && String(b.account_id) === id);
  const profiles = (data.profiles || []).filter((r) => live(r) && String(r.account_id) === id);
  const stmtLines = (data.stmtLines || []).filter((r) => live(r) && String(r.account_id) === id);
  const children = (data.accounts || []).filter((a) => live(a) && String(a.parent_id || '') === id);
  return { postings, lineItems, rules, budgets, profiles, stmtLines, children, txnCount: new Set(postings.map((p) => String(p.txn_id))).size };
}

/** 대출·자산 평가·보유 종목·재산세 설정에서 이 계정을 쓰는 곳 (있으면 지울 수 없음) */
export function metaRefs(meta, id) {
  id = String(id);
  const m = meta || {};
  const out = [];
  if (m.loans && Object.prototype.hasOwnProperty.call(m.loans, id)) out.push('Loan details (대출 정보)');
  if (m.debts && Object.prototype.hasOwnProperty.call(m.debts, id)) out.push('Interest rate & limit (이율 · 한도)');
  if (m.assets && Object.prototype.hasOwnProperty.call(m.assets, id)) out.push('Asset value (자산 평가)');
  if ((m.holdings || []).some((x) => String(x.acct || '') === id)) out.push('Stock holdings (보유 종목)');
  if (m.accrual && String(m.accrual.acct || '') === id) out.push('Property-tax accrual (재산세 적립)');
  return out;
}

/** 옮길 수 있는 곳: 같은 종류의 켜져 있는 계정 (지출은 "미분류"로도 옮길 수 있음) */
export function moveTargets(accounts, account) {
  const id = String(account.account_id);
  return (accounts || []).filter((a) => !L.truthy(a.deleted) && String(a.account_id) !== id && a.type === account.type &&
    (L.isActive(a) || false) && (a.type === 'EXPENSE' ? true : String(a.account_id) !== CONFIG.CLEARING_ID && String(a.account_id) !== CONFIG.OPENING_ID));
}

/** 지울 수 있는지 (이유와 함께) */
export function deleteCheck(data, meta, account) {
  const id = String(account.account_id);
  if (PROTECTED_IDS.indexOf(id) >= 0) return { ok: false, why: 'This is a system account and cannot be deleted (시스템 계정이라 지울 수 없어요).' };
  if (!['EXPENSE', 'INCOME', 'ASSET', 'LIABILITY'].includes(account.type)) return { ok: false, why: 'This kind cannot be deleted here (이 종류는 여기서 지울 수 없어요).' };
  const u = usageOf(data, id);
  if (u.children.length) return { ok: false, why: 'It has sub-accounts (하위 계정이 있어요). Delete or move those first (먼저 정리하세요).' };
  const refs = metaRefs(meta, id);
  if (refs.length) return { ok: false, why: 'Used in settings (설정에서 쓰고 있어요): ' + refs.join(', ') + '. Remove it there first, or Hide it instead (먼저 거기서 지우거나 "숨기기"를 쓰세요).' };
  return { ok: true, usage: u, inUse: !!(u.postings.length || u.lineItems.length || u.stmtLines.length) };
}

/**
 * 삭제 계획. destId 는 거래가 있을 때 옮겨 갈 같은 종류의 계정.
 * → { error } 또는 { steps: [{ puts, order }], counts }  (steps 를 차례로 저장하면 되고, 마지막에 계정이 지워집니다 — 중간에 멈춰도 데이터는 안전)
 */
export function planDelete(data, meta, account, destId, now) {
  const chk = deleteCheck(data, meta, account);
  if (!chk.ok) return { error: chk.why };
  const u = chk.usage;
  const id = String(account.account_id);
  const raw = L.rawAccount((data.accounts || []).find((a) => String(a.account_id) === id) || account);
  let dest = null;
  if (chk.inUse) {
    dest = moveTargets(data.accounts, raw).find((a) => String(a.account_id) === String(destId));
    if (!dest) return { error: 'Choose where to move the transactions (거래를 옮길 곳을 고르세요).' };
  } else if (destId) {
    dest = moveTargets(data.accounts, raw).find((a) => String(a.account_id) === String(destId)) || null;
  }
  const moved = (x, key) => Object.assign({}, x, { [key]: dest ? String(dest.account_id) : x[key], updated_at: now });
  const gone = (x) => Object.assign({}, x, { deleted: true, updated_at: now });
  const rowsBy = { Postings: [], LineItems: [], Rules: [], Budgets: [], ImportProfiles: [], StatementLines: [] };

  if (dest) {
    u.postings.forEach((p) => rowsBy.Postings.push(moved(p, 'account_id')));
    u.lineItems.forEach((l) => rowsBy.LineItems.push(moved(l, 'category_account_id')));
    u.rules.forEach((r) => rowsBy.Rules.push(moved(r, 'account_id')));
    u.profiles.forEach((r) => rowsBy.ImportProfiles.push(moved(r, 'account_id')));
    u.stmtLines.forEach((r) => rowsBy.StatementLines.push(moved(r, 'account_id')));
    // 예산: 같은 달에 옮겨 갈 곳에도 예산이 있으면 합치고, 없으면 그대로 옮김
    const same = (a, b) => String(a.type) === String(b.type) && String(a.vintage) === String(b.vintage) && String(a.year) === String(b.year) && String(a.month) === String(b.month);
    const destBudgets = (data.budgets || []).filter((b) => !L.truthy(b.deleted) && String(b.account_id) === String(dest.account_id));
    u.budgets.forEach((b) => {
      const t = destBudgets.find((x) => same(x, b));
      if (t) {
        rowsBy.Budgets.push(Object.assign({}, t, { amount_cad: L.round(L.num(t.amount_cad) + L.num(b.amount_cad), 2), updated_at: now }));
        rowsBy.Budgets.push(gone(b));
      } else rowsBy.Budgets.push(moved(b, 'account_id'));
    });
  } else {
    u.rules.forEach((r) => rowsBy.Rules.push(gone(r)));
    u.budgets.forEach((b) => rowsBy.Budgets.push(gone(b)));
    u.profiles.forEach((r) => rowsBy.ImportProfiles.push(gone(r)));
  }

  const steps = [];
  const order = ['Postings', 'LineItems', 'Rules', 'Budgets', 'ImportProfiles', 'StatementLines'];
  let cur = {}, n = 0;
  const flush = () => { if (n) { steps.push({ puts: cur, order: Object.keys(cur) }); cur = {}; n = 0; } };
  order.forEach((sheet) => {
    rowsBy[sheet].forEach((row) => {
      (cur[sheet] = cur[sheet] || []).push(row);
      if (++n >= CHUNK) flush();
    });
  });
  flush();
  steps.push({ puts: { Accounts: [Object.assign({}, raw, { deleted: true, is_active: false, updated_at: now })] }, order: ['Accounts'] });
  return {
    steps, dest: dest ? String(dest.account_id) : '',
    counts: { transactions: u.txnCount, postings: u.postings.length, items: u.lineItems.length, rules: u.rules.length, budgets: u.budgets.length }
  };
}

/** 삭제 확인 창 (거래가 있으면 옮길 곳을 고르게 함) → 지워졌으면 true */
export function openDeleteForm(api, account) {
  const { h } = api;
  const raw = L.rawAccount(account);
  const label = (a) => (api.accMap && api.accMap.get(String(a.account_id)) ? L.accLabel(api.accMap.get(String(a.account_id))) : L.accLabel(a));
  return new Promise((resolve) => {
    const ov = document.getElementById('overlay');
    if (!ov) { resolve(false); return; }
    ov.hidden = false;
    document.body.classList.add('noscroll');
    let done = false, busy = false;
    const close = (ok) => { if (done) return; done = true; ov.hidden = true; ov.replaceChildren(); document.body.classList.remove('noscroll'); document.removeEventListener('keydown', onKey, true); resolve(!!ok); };
    const onKey = (e) => { if (e.key === 'Escape' && !busy) { e.preventDefault(); close(false); } };
    document.addEventListener('keydown', onKey, true);
    const meta = typeof api.meta === 'function' ? api.meta() : {};
    const chk = deleteCheck(api.data, meta, raw);
    const err = h('div', { class: 'err', id: 'cd-err', role: 'alert' });
    const prog = h('div', { class: 'hint', id: 'cd-prog', 'aria-live': 'polite' });
    let dest = '';
    const targets = moveTargets(api.data.accounts, raw);
    const kindWord = raw.type === 'EXPENSE' ? 'category (카테고리)' : raw.type === 'INCOME' ? 'income category (수입 카테고리)' : 'account (계좌)';
    const body = [];
    if (!chk.ok) {
      body.push(h('div', { class: 'card warn-card', id: 'cd-block' }, chk.why));
    } else {
      const u = chk.usage;
      if (chk.inUse) {
        body.push(h('p', { id: 'cd-use' }, 'This ' + kindWord + ' has ' + u.txnCount + ' transaction' + (u.txnCount === 1 ? '' : 's') + (u.rules.length ? ', ' + u.rules.length + ' rule' + (u.rules.length === 1 ? '' : 's') : '') + (u.budgets.length ? ', ' + u.budgets.length + ' budget line' + (u.budgets.length === 1 ? '' : 's') : '') +
          ' (이 항목에 거래 ' + u.txnCount + '건' + (u.rules.length ? ', 규칙 ' + u.rules.length + '개' : '') + (u.budgets.length ? ', 예산 ' + u.budgets.length + '줄' : '') + '이 있어요). They will be moved first (먼저 아래 항목으로 옮겨요):'));
        body.push(h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Move to (옮길 곳)'),
          h('select', { id: 'cd-dest', onchange: (e) => { dest = e.target.value; } },
            h('option', { value: '' }, 'Select… (선택)'),
            targets.map((a) => h('option', { value: a.account_id }, label(a) + (String(a.account_id) === '9999' ? ' — needs a category later (나중에 분류)' : ''))))));
        if (raw.type === 'ASSET' || raw.type === 'LIABILITY') body.push(h('p', { class: 'hint' }, 'Balances move with the transactions. A transfer between the two accounts becomes a zero-net entry (두 계좌 사이의 이체는 합계 0인 기록이 됩니다).'));
      } else {
        body.push(h('p', { id: 'cd-unused' }, 'Nothing uses it yet, so it can be deleted safely (아직 쓰는 거래가 없어서 안전하게 지울 수 있어요).' + (u.rules.length || u.budgets.length ? ' Its ' + (u.rules.length ? u.rules.length + ' rule(s) ' : '') + (u.budgets.length ? u.budgets.length + ' budget line(s) ' : '') + 'will be removed too (함께 지워지는 규칙·예산이 있어요).' : '')));
      }
    }
    const go = async () => {
      if (busy) return;
      err.textContent = '';
      const plan = planDelete(api.data, meta, raw, dest, L.nowIso());
      if (plan.error) { err.textContent = plan.error; return; }
      busy = true;
      const btn = document.getElementById('cd-go'); if (btn) btn.disabled = true;
      try {
        const total = plan.steps.length;
        const rawSave = api.sync && api.sync.saveBatch ? api.sync.saveBatch : null;
        for (let i = 0; i < total; i++) {
          const st = plan.steps[i];
          prog.textContent = total > 1 ? 'Saving… (저장 중) ' + (i + 1) + ' / ' + total : '';
          if (i < total - 1 && rawSave) await rawSave(st.puts, st.order);
          else await api.saveBatch(st.puts, st.order);
        }
        api.toast('Deleted (삭제했어요): ' + (raw.name_ko || raw.name) + (plan.dest ? ' — moved ' + plan.counts.transactions + ' transactions (거래 ' + plan.counts.transactions + '건을 옮겼어요)' : ''));
        close(true);
      } catch (e) { busy = false; if (btn) btn.disabled = false; err.textContent = '삭제하지 못했습니다 (Could not delete): ' + ((e && e.message) || e); }
    };
    ov.replaceChildren(h('div', { class: 'backdrop', onclick: (e) => { if (e.target === e.currentTarget && !busy) close(false); } },
      h('div', { class: 'sheet cf-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cd-title' },
        h('div', { class: 'sheet-head' }, h('h2', { id: 'cd-title' }, 'Delete “' + (raw.name_ko || raw.name) + '”? (삭제할까요?)'),
          h('button', { type: 'button', class: 'icon', 'aria-label': 'Close (닫기)', onclick: () => { if (!busy) close(false); } }, '✕')),
        body, prog, err,
        h('div', { class: 'btnrow cf-actions' },
          chk.ok ? h('button', { type: 'button', class: 'btn danger', id: 'cd-go', onclick: go }, icon('trash', 18), chk.inUse ? 'Move & delete (옮기고 삭제)' : 'Delete (삭제)') : null,
          h('button', { type: 'button', class: 'btn secondary', id: 'cd-cancel', onclick: () => { if (!busy) close(false); } }, chk.ok ? 'Cancel (취소)' : 'Close (닫기)')),
        chk.ok ? h('p', { class: 'hint' }, 'Tip: "Hide" keeps everything and only removes it from pick lists (거래를 그대로 두고 선택 목록에서만 빼려면 "숨기기"를 쓰세요).') : null)));
  });
}

/**
 * 카테고리 추가/수정 창.
 * opts = { type, report_group, account (수정할 원래 행) }   → 저장되면 새 행으로 resolve, 닫으면 null
 * api 는 pageApi (h, toast, data, saveBatch)
 */
export function openCategoryForm(api, opts) {
  const o = opts || {};
  const { h } = api;
  const existing = o.account ? L.rawAccount(o.account) : null;
  return new Promise((resolve) => {
    const ov = document.getElementById('overlay');
    if (!ov) { resolve(null); return; }
    ov.hidden = false;
    document.body.classList.add('noscroll');
    let done = false;
    const close = (row) => { if (done) return; done = true; ov.hidden = true; ov.replaceChildren(); document.body.classList.remove('noscroll'); document.removeEventListener('keydown', onKey, true); resolve(row || null); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } };
    document.addEventListener('keydown', onKey, true);
    const st = {
      type: existing ? existing.type : (o.type || 'EXPENSE'),
      group: existing ? (existing.report_group || '') : (o.report_group && o.report_group !== '수입' ? o.report_group : '유흥비'),
      subtype: existing ? existing.subtype : '', owner: existing ? (existing.owner || 'Joint') : 'Joint'
    };
    const err = h('div', { class: 'err', id: 'cf-err', role: 'alert' });
    const body = h('div', { class: 'cf-body' });
    const nameIn = h('input', { id: 'cf-name', type: 'text', autocomplete: 'off', maxlength: '60', value: existing ? existing.name || '' : '', placeholder: 'e.g. Pet care' });
    const koIn = h('input', { id: 'cf-ko', type: 'text', autocomplete: 'off', maxlength: '60', value: existing ? existing.name_ko || '' : '', placeholder: '예: 반려동물' });
    const instIn = h('input', { id: 'cf-inst', type: 'text', autocomplete: 'off', maxlength: '40', value: existing ? existing.institution || '' : '', placeholder: 'TD, RBC …' });
    const l4In = h('input', { id: 'cf-last4', type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '40', value: existing ? existing.last4 || '' : '', placeholder: '1234  (' + '여러 장이면 1234, 5678)' });
    const seg = (id, items, cur, on) => h('div', { class: 'segtd cf-seg', id, role: 'radiogroup' }, items.map(([v, lab]) => h('button', {
      type: 'button', class: v === cur ? 'on' : '', role: 'radio', 'aria-checked': String(v === cur), 'data-v': v, onclick: () => { on(v); draw(); }
    }, lab)));
    function draw() {
      const t = st.type;
      body.replaceChildren(...[
        existing ? null : h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Type (종류)'),
          seg('cf-type', KINDS.map((k) => [k.key, k.label]), t, (v) => { st.type = v; })),
        t === 'EXPENSE' ? h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Group (그룹)'),
          seg('cf-group', EXPENSE_GROUPS.map((g) => [g, L.GROUP_LABELS[g] || g]), st.group, (v) => { st.group = v; })) : null,
        (t === 'ASSET' || t === 'LIABILITY') ? h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Kind (세부 종류)'),
          seg('cf-sub', SUBTYPES[t], st.subtype || SUBTYPES[t][0][0], (v) => { st.subtype = v; })) : null,
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Name in English (영어 이름)'), nameIn),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Name in Korean (한국어 이름)'), koIn),
        (t === 'ASSET' || t === 'LIABILITY') ? [
          h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Bank (금융기관)'), instIn),
          h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Card / account last 4 digits (카드 · 계좌 뒷 4자리)'), l4In,
            h('span', { class: 'hint' }, 'Used to pick this account when a receipt shows the card number (영수증에 카드 번호가 나오면 이 계좌를 자동 선택). Several cards: 1234, 5678 (여러 장이면 쉼표로). Last 4 digits only (뒷 4자리만).')),
          h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Owner (소유자)'),
            seg('cf-owner', ['Patrick', 'Ms Kim', 'JY Han', 'Joint'].map((o) => [o, L.ownerLabel(o)]), st.owner, (v) => { st.owner = v; }))
        ] : null
      ].flat(Infinity).filter(Boolean));
    }
    draw();
    const save = async (active) => {
      err.textContent = '';
      const res = makeAccountRow(api.data.accounts, { type: st.type, group: st.group, subtype: st.subtype, owner: st.owner, name: nameIn.value, name_ko: koIn.value, institution: instIn.value, last4: l4In.value, active }, existing, L.nowIso());
      if (res.error) { err.textContent = res.error; return; }
      try {
        await api.saveBatch({ Accounts: [res.row] }, ['Accounts']);
        api.toast(existing ? (active === false ? 'Hidden (숨겼어요)' : 'Saved (저장했어요)') : 'Added (추가했어요): ' + (res.row.name_ko || res.row.name));
        close(res.row);
      } catch (e) { err.textContent = '저장하지 못했습니다 (Could not save): ' + ((e && e.message) || e); }
    };
    const inUse = existing && (api.data.postings || []).some((p) => String(p.account_id) === String(existing.account_id) && !L.truthy(p.deleted));
    ov.replaceChildren(h('div', { class: 'backdrop', onclick: (e) => { if (e.target === e.currentTarget) close(null); } },
      h('div', { class: 'sheet cf-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cf-title' },
        h('div', { class: 'sheet-head' }, h('h2', { id: 'cf-title' }, (st.type === 'ASSET' || st.type === 'LIABILITY') ? (existing ? 'Edit account (계좌 · 카드 수정)' : 'Add account (계좌 · 카드 추가)') : (existing ? 'Edit category (카테고리 수정)' : 'Add category (카테고리 추가)')),
          h('button', { type: 'button', class: 'icon', 'aria-label': 'Close (닫기)', onclick: () => close(null) }, '✕')),
        body, err,
        h('div', { class: 'btnrow cf-actions' },
          h('button', { type: 'button', class: 'btn', id: 'cf-save', onclick: () => save(true) }, existing ? 'Save (저장)' : 'Add (추가)'),
          h('button', { type: 'button', class: 'btn secondary', onclick: () => close(null) }, 'Cancel (취소)'),
          existing && L.isActive(existing) ? h('button', { type: 'button', class: 'btn danger', id: 'cf-hide', onclick: () => save(false) }, 'Hide (숨기기)') : null,
          existing && !L.isActive(existing) ? h('button', { type: 'button', class: 'btn secondary', id: 'cf-show', onclick: () => save(true) }, 'Show again (다시 보이기)') : null,
          existing ? h('button', { type: 'button', class: 'btn danger outline', id: 'cf-delete', onclick: async () => {
            const prev = Array.from(ov.childNodes);
            const ok = await openDeleteForm(api, existing);
            if (ok) { close(null); return; }
            ov.hidden = false; document.body.classList.add('noscroll'); ov.replaceChildren(...prev);   // 취소하면 수정 창으로 돌아옴
          } }, icon('trash', 18), 'Delete (삭제)') : null),
        existing ? h('p', { class: 'hint' }, inUse ? 'Hiding keeps past transactions; it only disappears from pick lists (숨겨도 지난 거래는 그대로이고, 선택 목록에서만 사라집니다).' : 'Hidden categories can be shown again from Settings (숨긴 항목은 설정에서 다시 보이게 할 수 있어요).') : null)));
    setTimeout(() => { try { nameIn.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 30);
  });
}

/** 설정 화면용 카드: 그룹별 카테고리 목록 + 추가/수정 */
export function categoriesCard(api, icon) {
  const { h } = api;
  const el = h('section', { class: 'card set-card', id: 'set-cats' });
  let tab = 'EXPENSE';
  let showHidden = false;
  const draw = () => {
    const accs = (api.data.accounts || []).filter((a) => !L.truthy(a.deleted));
    const list = accs.filter((a) => a.type === tab && (showHidden || L.isActive(a)) && String(a.account_id) !== '9999');
    const groups = tab === 'EXPENSE' ? EXPENSE_GROUPS.concat(['확인 필요']) : [''];
    const disp = (a) => { const m = api.accMap && api.accMap.get(String(a.account_id)); return m ? m.name : a.name; };
    const sub = (a) => { const m = api.accMap && api.accMap.get(String(a.account_id)); return m ? m.name_ko : a.name_ko; };
    el.replaceChildren(...[
      h('div', { class: 'set-h' }, h('span', { class: 'set-ic' }, icon('tag', 22)), h('h2', null, 'Categories & accounts ', h('span', { class: 'ko' }, '(카테고리 · 계좌)'))),
      h('div', { class: 'segtd cf-tabs', role: 'tablist' }, KINDS.map((k) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(k.key === tab), class: k.key === tab ? 'on' : '', 'data-kind': k.key, onclick: () => { tab = k.key; draw(); } }, k.label.replace(/ \/ .*\(/, ' ('))) ),
      groups.map((g) => {
        const rows = list.filter((a) => tab !== 'EXPENSE' || (a.report_group || '확인 필요') === g || (g === '확인 필요' && !EXPENSE_GROUPS.includes(a.report_group)));
        if (!rows.length && g === '확인 필요') return null;
        return h('div', { class: 'cf-group' },
          g ? h('div', { class: 'cf-gh' }, L.GROUP_LABELS[g] || g) : null,
          h('ul', { class: 'cf-list' }, rows.map((a) => h('li', { class: 'cf-item' + (L.isActive(a) ? '' : ' off') },
            h('button', { type: 'button', class: 'cf-row', 'data-acc': a.account_id, onclick: async () => { const r = await openCategoryForm(api, { account: a }); if (r) draw(); } },
              h('span', { class: 'cf-n' }, disp(a), sub(a) && sub(a) !== disp(a) ? h('small', null, sub(a)) : null),
              a.last4 && (a.type === 'ASSET' || a.type === 'LIABILITY') ? h('span', { class: 'cf-l4' }, '····' + String(a.last4).replace(/\s*,\s*/g, ' ····')) : null,
              L.isActive(a) ? null : h('span', { class: 'set-pill off' }, 'Hidden (숨김)'),
              h('span', { class: 'cf-go', 'aria-hidden': 'true' }, '›')),
            PROTECTED_IDS.indexOf(String(a.account_id)) >= 0 ? null
              : h('button', { type: 'button', class: 'cf-trash', 'data-del': a.account_id, 'aria-label': 'Delete (삭제): ' + disp(a), title: 'Delete (삭제)', onclick: async () => { const ok = await openDeleteForm(api, a); if (ok) draw(); } }, icon('trash', 20))))),
          h('button', { type: 'button', class: 'btn secondary cf-add', 'data-group': g, onclick: async () => { const r = await openCategoryForm(api, { type: tab, report_group: g }); if (r) draw(); } }, '+ ', 'Add (추가)'));
      }),
      h('label', { class: 'check cf-hidden' }, h('input', { type: 'checkbox', checked: showHidden, onchange: (e) => { showHidden = e.target.checked; draw(); } }), ' Show hidden (숨긴 항목 보기)'),
      h('p', { class: 'set-note' }, 'Tap a name to rename or hide it, or the trash can to delete it (이름을 누르면 바꾸거나 숨길 수 있고, 휴지통을 누르면 삭제해요). If it has transactions you choose where to move them (거래가 있으면 옮길 곳을 고릅니다). To change the order, use Reports → Reorder (순서는 보고서 → 순서 바꾸기에서).')].flat(Infinity).filter(Boolean));
  };
  draw();
  return el;
}
