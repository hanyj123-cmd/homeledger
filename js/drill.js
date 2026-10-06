// 거래 상세 패널: 손익·재무상태표·거래 탭에서 "이 줄 뒤에 있는 거래들"을 보여 주고, 그 자리에서 고칩니다.
//   · 카테고리 바꾸기 · 금액 바로 고치기(10*1.1 가능) · 메모 · 삭제 · 자세히(전체 입력 창)
//   · 여러 건 고르면 합계 · 거래 추가
// 놓이는 자리: 폰 = 아래에서 올라오는 시트 / 아이패드 = 화면 오른쪽에 붙은 칸 / 컴퓨터 = 오른쪽에서 나오는 서랍
import * as L from './ledger.js';
import * as sync from './sync.js';
import { icon } from './icons.js';
import { layoutOf } from './layout.js';
import * as receiptui from './receiptui.js';
import { openRemember } from './rememberui.js';

let cur = null;            // { api, spec, picked:Set, pickMode }
let dock = null;           // { el, fallback }  (아이패드 전용)

export function setDock(el, fallback) { dock = el ? { el, fallback } : null; }
export function isOpen() { return !!cur; }
export function currentSpec() { return cur ? cur.spec : null; }

// spec = { title, sub, months:[ym]|null, ids:[계정 id], mode:'exp'|'inc'|'acct', acctType, search }
export function show(api, spec) {
  const keep = cur && cur.spec && cur.spec.key === spec.key;
  cur = { api, spec, picked: keep ? cur.picked : new Set(), pickMode: keep ? cur.pickMode : false };
  mount();
}

export function restore(api) {
  if (!cur) return;
  cur.api = api;
  mount();
}

export function close() {
  cur = null;
  const dr = document.getElementById('drawer');
  if (dr) { dr.hidden = true; const p = document.getElementById('drawer-panel'); if (p) p.replaceChildren(); }
  document.body.classList.remove('noscroll');
  if (dock && dock.el.isConnected) { dock.el.replaceChildren(); if (dock.fallback) dock.fallback(dock.el); }
}

// ───────── 데이터 ─────────

function gather(state, spec) {
  const ids = new Set(spec.ids.map(String));
  const months = spec.months ? new Set(spec.months) : null;
  const rows = [];
  state.d.items.forEach((it) => {
    if (months && !months.has(L.monthOf(it.txn.date))) return;
    let amt = 0, hit = false;
    it.ps.forEach((p) => { if (!L.truthy(p.deleted) && ids.has(String(p.account_id))) { amt += L.num(p.amount_cad); hit = true; } });
    if (!hit) return;
    let v = amt;
    if (spec.mode === 'inc') v = -amt;
    else if (spec.mode === 'acct' && spec.acctType === 'LIABILITY') v = -amt;
    rows.push({ it, v: L.round(v, 2) });
  });
  return rows;
}

const isSimple = (state, it) => {
  const live = it.ps.filter((p) => !L.truthy(p.deleted));
  return live.length === 2 && (it.txn.currency || 'CAD') === 'CAD' && !receiptui.isReceiptTxn(state, it.txn.txn_id)
    && (it.desc.kind === 'EXPENSE' || it.desc.kind === 'INCOME') && !L.truthy(it.txn.is_passthrough);
};

// ───────── 화면 ─────────

function build() {
  const { api, spec } = cur;
  const { h, fmt, state } = api;
  const rows = gather(state, spec);
  const total = L.round(rows.reduce((s, r) => s + r.v, 0), 2);
  const todo = rows.filter((r) => String(r.it.desc.categoryId) === '9999' || String(r.it.txn.status).toUpperCase() === 'REVIEW').length;

  const head = h('div', { class: 'dp-head' },
    h('div', { class: 'tt' }, h('h2', null, spec.title), h('div', { class: 'ss' }, (spec.sub ? spec.sub + ' · ' : '') + rows.length + ' transaction(s) (거래 ' + rows.length + '건)')),
    h('button', { type: 'button', class: 'icon', id: 'dp-close', 'aria-label': 'Close (닫기)', onclick: close }, icon('close', 22)));

  const tot = h('div', { class: 'dp-tot' },
    h('b', { class: spec.mode === 'inc' ? 'in' : '' }, fmt(total)),
    h('span', null, spec.totalLabel || (spec.mode === 'acct' ? 'Net change (순증감)' : 'Total (합계)')),
    todo ? h('span', { style: 'color:var(--warn-ink);font-weight:600' }, '⚠ ' + todo + ' need a category (분류 필요 ' + todo + '건)') : null);

  const tools = h('div', { class: 'dp-tools' },
    h('button', { type: 'button', class: 'btn secondary sm', id: 'dp-select', onclick: () => { cur.pickMode = !cur.pickMode; if (!cur.pickMode) cur.picked.clear(); rerender(); } },
      icon('select', 18), cur.pickMode ? 'Done (선택 끝)' : 'Select (선택)'),
    h('button', { type: 'button', class: 'btn secondary sm', id: 'dp-add', onclick: () => api.openForm(null, spec.addDefaults || {}) }, icon('plus', 18), 'Add (거래 추가)'),
    spec.search ? h('button', { type: 'button', class: 'btn secondary sm', id: 'dp-open', onclick: () => { close(); api.goSearch(spec.search); } }, icon('open', 18), 'In Ledger (거래 탭)') : null);

  const sel = h('div', { class: 'dp-sel', id: 'dp-sel', hidden: true });
  const list = h('div', { class: 'dp-list', id: 'dp-list' });

  const refreshSel = () => {
    const ids = Array.from(cur.picked);
    sel.hidden = !cur.pickMode || !ids.length;
    if (sel.hidden) return;
    const sum = L.round(rows.filter((r) => cur.picked.has(String(r.it.txn.txn_id))).reduce((s, r) => s + r.v, 0), 2);
    sel.replaceChildren(h('b', null, ids.length + ' selected (선택)'), h('b', { id: 'dp-sel-sum' }, fmt(sum)),
      h('span', { class: 'muted' }, 'avg (평균) ' + fmt(L.round(sum / ids.length, 2))),
      h('button', { type: 'button', class: 'btn secondary sm', onclick: () => { rows.forEach((r) => cur.picked.add(String(r.it.txn.txn_id))); rerender(); } }, 'All (전체)'),
      h('button', { type: 'button', class: 'btn secondary sm', onclick: () => { cur.picked.clear(); rerender(); } }, 'Clear (해제)'));
    list.querySelectorAll('.dr').forEach((el) => el.classList.toggle('on', cur.picked.has(el.getAttribute('data-id'))));
    list.querySelectorAll('.dr .pk input').forEach((el) => { el.checked = cur.picked.has(el.closest('.dr').getAttribute('data-id')); });
  };

  if (!rows.length) list.append(h('div', { class: 'dp-empty' }, 'No transactions (거래가 없습니다).'));

  const catSelect = (it) => {
    const kind = it.desc.kind;
    const simple = isSimple(state, it);
    if (!simple) {
      const label = receiptui.isReceiptTxn(state, it.txn.txn_id) ? 'Receipt split (영수증 분할)' : it.desc.categoryName || it.desc.kind;
      return h('select', { disabled: true, 'aria-label': 'Category' }, h('option', null, label));
    }
    const type = kind === 'INCOME' ? 'INCOME' : 'EXPENSE';
    const accts = state.data.accounts.filter((a) => L.isActive(a) && a.type === type);
    const groups = new Map();
    accts.forEach((a) => { const g = a.report_group || (type === 'INCOME' ? '수입' : '확인 필요'); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(a); });
    const order = type === 'INCOME' ? ['수입'] : L.GROUP_ORDER;
    const keys = order.filter((g) => groups.has(g)).concat(Array.from(groups.keys()).filter((g) => order.indexOf(g) < 0));
    return h('select', {
      class: 'dp-cat', 'aria-label': 'Category (카테고리)',
      onchange: (e) => edit(it, { categoryId: e.target.value, categoryTouched: true }, true)
    }, keys.map((g) => h('optgroup', { label: L.GROUP_LABELS[g] || g }, groups.get(g).map((a) => h('option', { value: a.account_id, selected: String(a.account_id) === String(it.desc.categoryId) }, L.accLabel(a))))));
  };

  rows.forEach((r) => {
    const it = r.it, t = it.txn, dsc = it.desc;
    const id = String(t.txn_id);
    const simple = isSimple(state, it);
    const review = String(dsc.categoryId) === '9999' || String(t.status).toUpperCase() === 'REVIEW';
    const cat = state.d.accMap.get(String(dsc.categoryId));
    const amtEl = simple
      ? h('input', {
        type: 'text', inputmode: 'decimal', class: 'dp-amt', value: L.fmtNumber(Math.abs(L.num(t.total_cad)), 'CAD'), 'aria-label': 'Amount (금액)',
        onfocus: (e) => { e.target.value = String(Math.abs(L.num(t.total_cad))); e.target.select(); },
        onchange: (e) => {
          const n = L.parseAmount(e.target.value);
          if (!Number.isFinite(n) || n <= 0) { api.toast('금액을 올바르게 입력하세요.'); rerender(); return; }
          if (L.round(n, 2) !== Math.abs(L.num(t.total_cad))) edit(it, { amountText: String(L.round(n, 2)) }, false);
        }
      })
      : h('span', { class: 'ro' }, fmt(Math.abs(r.v)));
    const sign = r.v < 0 ? '−' : (spec.mode === 'acct' ? '+' : '');
    const row = h('div', { class: 'dr' + (review ? ' todo' : '') + (cur.picked.has(id) ? ' on' : ''), 'data-id': id },
      h('div', { class: 'pk' }, cur.pickMode
        ? h('input', { type: 'checkbox', 'aria-label': 'Select (선택)', checked: cur.picked.has(id), onchange: (e) => { if (e.target.checked) cur.picked.add(id); else cur.picked.delete(id); refreshSel(); } })
        : null),
      h('div', { class: 'mm' },
        h('div', { class: 'mt' }, t.merchant || t.memo || dsc.categoryName),
        h('div', { class: 'ms' }, [L.dayLabel(t.date), dsc.accountName, spec.mode === 'acct' ? (cat ? cat.name : dsc.categoryName) : null].filter(Boolean).join(' · '))),
      h('div', { class: 'am' + (r.v < 0 ? ' neg' : '') }, spec.mode === 'acct' && !simple ? h('span', { class: 'ro' }, sign + fmt(Math.abs(r.v))) : amtEl),
      h('div', { class: 'ed' },
        catSelect(it),
        h('input', {
          type: 'text', class: 'dp-memo', placeholder: 'Memo (메모)', value: t.memo || '', 'aria-label': 'Memo (메모)',
          onchange: (e) => edit(it, { memo: e.target.value }, false)
        }),
        h('button', { type: 'button', class: 'rowbtn', 'aria-label': 'Details (자세히)', title: 'Details (자세히)', onclick: () => api.openForm(t.txn_id) }, icon('edit', 20)),
        h('button', {
          type: 'button', class: 'rowbtn del', 'aria-label': 'Delete (삭제)', title: 'Delete (삭제)',
          onclick: async () => {
            if (!window.confirm('Delete this transaction? (이 거래를 삭제할까요?)')) return;
            await sync.deleteTxn(t.txn_id);
            api.toast('Deleted (삭제됨)');
            await api.reload(); api.renderBody(true);
          }
        }, icon('trash', 20))));
    list.append(row);
  });

  const foot = rows.length > 8 ? h('div', { class: 'dp-foot' }, h('span', null, 'Total (합계)'), h('span', null, fmt(total))) : null;
  const panel = h('div', { class: 'dp', 'data-key': spec.key || '' }, h('div', { class: 'dp-grip' }), head, tot, tools, sel, list, foot);
  refreshSel();
  return panel;

  function rerender() { if (cur) mount(); }
}

async function edit(it, patch, askRemember) {
  const { api } = cur;
  const { state } = api;
  const f = L.formFromTxn(it.txn, it.ps, state.d.accMap);
  Object.assign(f, patch);
  const res = L.makeRecords(f, { accMap: state.d.accMap, rules: state.data.rules, existing: it, now: L.nowIso() });
  if (res.error) { api.toast(res.error); mount(); return; }
  const cand = res.rule; res.rule = null;
  const prev = cand ? L.suggestRule(state.data.rules, res.txn.merchant) : null;
  const ask = askRemember && cand && !(prev && String(prev.account_id) === String(cand.account_id))
    ? [{ merchant: res.txn.merchant, accountId: String(cand.account_id), previousAccountId: prev ? String(prev.account_id) : '' }] : [];
  try {
    await sync.saveRecords(res);
    await api.reload();
    api.renderBody(true);
    api.toast('Saved (저장됨)');
    if (ask.length) await openRemember({ h: api.h, toast: api.toast, accMap: api.state.d.accMap, data: api.state.data, reload: api.reload }, ask);
  } catch (e) {
    api.toast('저장하지 못했습니다: ' + (e.message || e));
  }
}

function mount() {
  if (!cur) return;
  const panel = build();
  const oldList = document.querySelector('#dp-list');
  const top = oldList ? oldList.scrollTop : 0;
  const lay = layoutOf();
  const dr = document.getElementById('drawer');
  if (lay === 'tablet' && dock && dock.el.isConnected) {
    dr.hidden = true;
    dock.el.replaceChildren(panel);
    document.body.classList.remove('noscroll');
  } else {
    const host = document.getElementById('drawer-panel');
    host.replaceChildren(panel);
    dr.hidden = false;
    const scrim = document.getElementById('drawer-scrim');
    scrim.onclick = close;
    if (lay === 'phone') document.body.classList.add('noscroll');
  }
  const nl = document.querySelector('#dp-list');
  if (nl && top) nl.scrollTop = top;
}
