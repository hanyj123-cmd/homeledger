// 카테고리(계정) 추가 · 이름 바꾸기 · 숨기기.
// 지출/수입 카테고리뿐 아니라 은행 계좌 · 카드 · 대출도 추가할 수 있습니다. 저장은 Accounts 시트에 (로컬 우선).
import * as L from './ledger.js';

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
      is_active: f.active === false ? false : true, updated_at: now }) };
  }
  const id = nextId(accounts, type, group);
  return { row: {
    account_id: id, name: name || ko, name_ko: ko || name, type,
    subtype: (type === 'ASSET' || type === 'LIABILITY') ? (f.subtype || (type === 'ASSET' ? 'CHEQUING' : 'CREDIT_CARD')) : '',
    parent_id: '', owner: (type === 'ASSET' || type === 'LIABILITY') ? (f.owner || 'Joint') : '',
    institution: String(f.institution || '').trim(), currency: 'CAD', last4: '', report_group: group,
    sort_order: nextSort(accounts, type, group), is_active: true, updated_at: now, deleted: false
  } };
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
          h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Owner (소유자)'),
            seg('cf-owner', ['Patrick', 'Ms Kim', 'JY Han', 'Joint'].map((o) => [o, L.ownerLabel(o)]), st.owner, (v) => { st.owner = v; }))
        ] : null
      ].flat(Infinity).filter(Boolean));
    }
    draw();
    const save = async (active) => {
      err.textContent = '';
      const res = makeAccountRow(api.data.accounts, { type: st.type, group: st.group, subtype: st.subtype, owner: st.owner, name: nameIn.value, name_ko: koIn.value, institution: instIn.value, active }, existing, L.nowIso());
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
        h('div', { class: 'sheet-head' }, h('h2', { id: 'cf-title' }, existing ? 'Edit category (카테고리 수정)' : 'Add category (카테고리 추가)'),
          h('button', { type: 'button', class: 'icon', 'aria-label': 'Close (닫기)', onclick: () => close(null) }, '✕')),
        body, err,
        h('div', { class: 'btnrow cf-actions' },
          h('button', { type: 'button', class: 'btn', id: 'cf-save', onclick: () => save(true) }, existing ? 'Save (저장)' : 'Add (추가)'),
          h('button', { type: 'button', class: 'btn secondary', onclick: () => close(null) }, 'Cancel (취소)'),
          existing && L.isActive(existing) ? h('button', { type: 'button', class: 'btn danger', id: 'cf-hide', onclick: () => save(false) }, 'Hide (숨기기)') : null,
          existing && !L.isActive(existing) ? h('button', { type: 'button', class: 'btn secondary', id: 'cf-show', onclick: () => save(true) }, 'Show again (다시 보이기)') : null),
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
              L.isActive(a) ? null : h('span', { class: 'set-pill off' }, 'Hidden (숨김)'),
              h('span', { class: 'cf-go', 'aria-hidden': 'true' }, '›'))))),
          h('button', { type: 'button', class: 'btn secondary cf-add', 'data-group': g, onclick: async () => { const r = await openCategoryForm(api, { type: tab, report_group: g }); if (r) draw(); } }, '+ ', 'Add (추가)'));
      }),
      h('label', { class: 'check cf-hidden' }, h('input', { type: 'checkbox', checked: showHidden, onchange: (e) => { showHidden = e.target.checked; draw(); } }), ' Show hidden (숨긴 항목 보기)'),
      h('p', { class: 'set-note' }, 'Tap a name to rename or hide it. To change the order, use Reports → Reorder (이름을 누르면 바꾸거나 숨길 수 있어요. 순서는 보고서 → 순서 바꾸기에서).')].flat(Infinity).filter(Boolean));
  };
  draw();
  return el;
}
