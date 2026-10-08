// 거래 탭 (Activity). 폰 = 카드 목록 / 아이패드·컴퓨터 = 출금·입금·잔액 표 + 오른쪽 카테고리 칸
import * as L from './ledger.js';
import { icon } from './icons.js';
import { layoutOf } from './layout.js';
import * as drill from './drill.js';
import { incomeStatement } from './reports.js';
import { bulkBar } from './bulk.js';
import * as RV from './receiptview.js';
import * as M from './meta.js';

// 여러 건 선택: Esc 로 끝내기 (데스크탑) — 문서에 한 번만 연결
let escHandler = null;
let escBound = false;
let suppressNext = false;   // 길게 눌러 선택한 직후 따라오는 click 한 번은 무시

const fmtDate = (s) => {
  const d = new Date(String(s).slice(0, 10) + 'T12:00:00');
  return isNaN(d) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const shortDate = (s) => {
  const d = new Date(String(s).slice(0, 10) + 'T12:00:00');
  return isNaN(d) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

// 계좌 한 곳 기준의 영향: 자산은 +가 늘어남, 부채는 −가 "사용(늘어남)"
export function accEffect(it, acct) {
  let s = 0;
  it.ps.forEach((p) => { if (!L.truthy(p.deleted) && String(p.account_id) === String(acct.account_id)) s += L.num(p.amount_cad); });
  return acct.type === 'LIABILITY' ? -s : s;   // 양수 = 잔액(또는 갚을 금액)이 늘어남
}

// 거래 하나를 표의 출금/입금 칸으로
export function columnsOf(it, acct) {
  if (acct) {
    const eff = L.round(accEffect(it, acct), 2);
    if (acct.type === 'LIABILITY') return eff > 0 ? { out: eff } : { inn: Math.abs(eff) };   // 사용 = 출금 칸, 납부 = 입금 칸
    return eff < 0 ? { out: Math.abs(eff) } : { inn: eff };
  }
  const amt = Math.abs(L.num(it.txn.total_cad));
  const k = it.desc.kind;
  if (k === 'INCOME') return { inn: amt };
  if (k === 'EXPENSE') return it.desc.flow === 'in' ? { inn: amt } : { out: amt };
  if (k === 'PASSTHROUGH') return it.desc.flow === 'in' ? { inn: amt } : { out: amt };
  return { move: amt };
}

// 계좌 한 곳의 거래 후 잔액 (날짜 → 입력 순서 → 시간순)
export function balanceTimeline(items, acct) {
  const mine = items.filter((it) => it.ps.some((p) => !L.truthy(p.deleted) && String(p.account_id) === String(acct.account_id)));
  mine.sort(L.cmpChrono);
  let bal = 0;
  const m = new Map();
  mine.forEach((it) => { bal = L.round(bal + accEffect(it, acct), 2); m.set(String(it.txn.txn_id), bal); });
  return { map: m, balance: bal };
}

export function monthsOf(items, current) {
  const set = new Set([L.monthOf(L.todayStr()), current]);
  items.forEach((it) => set.add(L.monthOf(it.txn.date)));
  return Array.from(set).filter(Boolean).sort().reverse();
}

export function filterItems(api) {
  const { state } = api;
  const d = state.d;
  const q = (state.query || '').trim();
  let items = q ? L.searchItems(d.items, q) : d.items.filter((it) => L.monthOf(it.txn.date) === state.month);
  const acct = state.acct ? d.accMap.get(String(state.acct)) : null;
  if (acct) items = items.filter((it) => it.ps.some((p) => !L.truthy(p.deleted) && String(p.account_id) === String(acct.account_id)));
  const k = state.kind || '';
  if (k === 'REVIEW') items = items.filter((it) => L.needsCategory(it));
  else if (k === 'TRANSFER') items = items.filter((it) => it.desc.kind === 'TRANSFER' || it.desc.kind === 'OPENING' || it.desc.kind === 'PASSTHROUGH');
  else if (k) items = items.filter((it) => it.desc.kind === k);
  return items;
}

export function toCsv(api, items) {
  const { state } = api;
  const a = state.acct ? state.d.accMap.get(String(state.acct)) : null;
  const tl = a ? balanceTimeline(state.d.items, a).map : null;
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [['Date', 'Description', 'Category', 'Account', 'Withdrawals', 'Deposits', 'Balance', 'Memo'].map(esc).join(',')];
  items.forEach((it) => {
    const c = columnsOf(it, a);
    lines.push([it.txn.date, it.txn.merchant || '', it.desc.categoryName, it.desc.accountName, c.out || c.move || '', c.inn || '', tl && tl.has(String(it.txn.txn_id)) ? tl.get(String(it.txn.txn_id)) : '', it.txn.memo || ''].map(esc).join(','));
  });
  return lines.join('\r\n');
}

function download(name, text) {
  try {
    const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  } catch (e) { return false; }
}

// api = { h, fmt, state, toast, openForm, openScan, goImport, rerender, reload }
export function render(api) {
  const { h, fmt, state } = api;
  const d = state.d;
  const lay = layoutOf();
  const accounts = state.data.accounts.filter(L.isActive);
  const money = accounts.filter(L.isMoneyAccount);
  const acct = state.acct ? d.accMap.get(String(state.acct)) : null;
  if (state.acct && !acct) state.acct = '';
  const frag = document.createDocumentFragment();
  const bk = state.bulk || (state.bulk = { on: false, sel: new Set(), anchor: '' });
  // 다른 탭에 갔다 오면 선택 모드는 끝 (같은 탭 안의 다시 그리기·동기화에서는 유지)
  if (bk.on && !bk.fresh && typeof document !== 'undefined' && !document.getElementById('bk-bar')) { bk.on = false; bk.sel.clear(); bk.anchor = ''; }
  bk.fresh = false;
  let shown = [];            // 지금 목록(검색·필터·달)에 보이는 거래 id
  let bar = null;
  const setMode = (on, firstId) => {
    bk.on = !!on; bk.sel.clear(); bk.anchor = '';
    if (on && firstId) { bk.sel.add(String(firstId)); bk.anchor = String(firstId); }
    bk.fresh = !!on;
    api.rerender();
  };
  if (!escBound && typeof document !== 'undefined') {
    escBound = true;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && escHandler) escHandler(e); });
  }
  escHandler = bk.on ? () => {
    const ov = document.getElementById('overlay');
    if ((ov && !ov.hidden) || !document.getElementById('bk-bar')) return;
    setMode(false);
  } : null;

  // ── 배너
  // 한도 (부채 설정의 Limit): 카드·한도 대출 → 사용 가능 금액 / 한도 (은행 사이트처럼)
  function limitMetrics(a, bal, liab) {
    let lim = 0;
    try { const dm = M.readJson(state.data.settings, M.KEYS_META.debts, {}) || {}; lim = L.num((dm[String(a.account_id)] || {}).limit); } catch (e) { lim = 0; }
    if (!(lim > 0)) return [];
    const avail = L.round(liab ? lim - bal : bal + lim, 2);
    return [
      h('div', { class: 'metric sub', id: 'bn-avail' }, h('div', { class: 'metric-lab' }, 'Available (사용 가능)'), h('div', { class: 'metric-val' }, (avail < 0 ? '−' : '') + fmt(Math.abs(avail)))),
      h('div', { class: 'metric sub', id: 'bn-limit' }, h('div', { class: 'metric-lab' }, liab ? 'Credit limit (한도)' : 'Overdraft limit (마이너스 한도)'), h('div', { class: 'metric-val' }, fmt(lim)))];
  }
  const month = state.month;
  const monthItems = d.items.filter((it) => L.monthOf(it.txn.date) === month && (!acct || it.ps.some((p) => !L.truthy(p.deleted) && String(p.account_id) === String(acct.account_id))));
  const metrics = h('div', { class: 'metrics' });
  if (acct) {
    let inn = 0, out = 0;
    monthItems.forEach((it) => { const c = columnsOf(it, acct); inn += c.inn || 0; out += c.out || 0; });
    const bal = balanceTimeline(d.items, acct).balance;
    const liab = acct.type === 'LIABILITY';
    metrics.append(
      h('div', { class: 'metric', id: 'bn-main' }, h('div', { class: 'metric-lab' }, liab ? 'Balance owed (사용 잔액)' : 'Current balance (현재 잔액)'), h('div', { class: 'metric-val' }, fmt(bal))),
      ...limitMetrics(acct, bal, liab),
      h('div', { class: 'metric sub' }, h('div', { class: 'metric-lab' }, liab ? 'Payments · month (납부)' : 'Money in · month (입금)'), h('div', { class: 'metric-val' }, fmt(L.round(inn, 2)))),
      h('div', { class: 'metric sub' }, h('div', { class: 'metric-lab' }, liab ? 'Charges · month (사용)' : 'Money out · month (출금)'), h('div', { class: 'metric-val' }, fmt(L.round(out, 2)))));
  } else {
    const bal = L.accountBalances(accounts, d.items.flatMap((i) => i.ps));
    const nw = L.netWorth(accounts, bal);
    const s = L.monthSummary(d.items, d.accMap, month);
    metrics.append(
      h('div', { class: 'metric', id: 'bn-main' }, h('div', { class: 'metric-lab' }, 'Net worth (순자산)'), h('div', { class: 'metric-val' }, fmt(nw.net))),
      h('div', { class: 'metric sub' }, h('div', { class: 'metric-lab' }, 'Income · month (수입)'), h('div', { class: 'metric-val', id: 'bn-in' }, fmt(s.income))),
      h('div', { class: 'metric sub' }, h('div', { class: 'metric-lab' }, 'Spending · month (지출)'), h('div', { class: 'metric-val', id: 'bn-out' }, fmt(s.spending))),
      h('div', { class: 'metric sub' }, h('div', { class: 'metric-lab' }, 'Net · month (순수입)'), h('div', { class: 'metric-val', id: 'bn-net' }, (s.net < 0 ? '−' : '') + fmt(Math.abs(s.net)))));
  }
  const pick = h('label', { class: 'acct-pick' },
    h('span', { class: 'nm' }, acct ? acct.name : 'All accounts (전체 계좌)'),
    acct && acct.last4 ? h('span', { class: 'no' }, '····' + String(acct.last4).replace(/\s*,\s*/g, ' ····')) : null,
    h('span', { class: 'chev' }, icon('down', 18)),
    h('select', {
      id: 'acct-filter', 'aria-label': 'Account (계좌)',
      onchange: (e) => { state.acct = e.target.value; state.query = ''; api.rerender(); }
    },
      h('option', { value: '' }, 'All accounts (전체 계좌)'),
      h('optgroup', { label: 'Assets (자산)' }, money.filter((a) => a.type === 'ASSET').map((a) => h('option', { value: a.account_id, selected: acct && String(a.account_id) === String(acct.account_id) }, L.accLabel(a)))),
      h('optgroup', { label: 'Credit & loans (카드 · 대출)' }, money.filter((a) => a.type === 'LIABILITY').map((a) => h('option', { value: a.account_id, selected: acct && String(a.account_id) === String(acct.account_id) }, L.accLabel(a))))));
  frag.append(h('section', { class: 'banner' }, h('div', { class: 'banner-in' },
    h('div', { class: 'banner-row' }, pick, h('div', { class: 'asof' }, 'As of ', h('b', null, fmtDate(L.todayStr())))),
    metrics)));

  // ── 알약 버튼
  frag.append(h('div', { class: 'pills' },
    h('button', { type: 'button', class: 'pillbtn', id: 'add-btn', onclick: () => api.openForm(null, acct ? { fromId: String(acct.account_id) } : {}) }, icon('plus', 24), 'New ', h('span', { class: 'ko' }, '거래 추가')),
    h('button', { type: 'button', class: 'pillbtn', id: 'scan-btn', onclick: () => api.openScan() }, icon('scan', 24), 'Receipt ', h('span', { class: 'ko' }, '영수증')),
    h('button', { type: 'button', class: 'pillbtn', id: 'xfer-btn', onclick: () => api.openForm(null, { kind: 'TRANSFER', fromId: acct ? String(acct.account_id) : '' }) }, icon('transfer', 24), 'Transfer ', h('span', { class: 'ko' }, '이체')),
    h('button', { type: 'button', class: 'pillbtn', id: 'imp-btn', onclick: () => api.goImport() }, icon('import', 24), 'Import ', h('span', { class: 'ko' }, '가져오기'))));

  // ── 도구 줄
  const months = monthsOf(d.items, month);
  const step = (dir, lab) => h('button', { type: 'button', class: 'stepbtn', 'aria-label': lab, onclick: () => { state.month = L.shiftMonth(state.month, dir); state.query = ''; api.rerender(); } }, icon(dir < 0 ? 'left' : 'right', 20));
  const monthSel = h('label', { class: 'pillsel' }, icon('calendar', 20), h('span', { class: 'monthlabel' }, L.monthLabel(month)), icon('down', 18),
    h('select', { id: 'month-sel', 'aria-label': 'Month (월)', onchange: (e) => { state.month = e.target.value; state.query = ''; api.rerender(); } },
      months.map((m) => h('option', { value: m, selected: m === month }, L.monthLabel(m)))));
  const search = h('div', { class: 'search' }, icon('search', 20), h('input', {
    type: 'search', id: 'q', placeholder: 'Search (검색): merchant, amount, account…', value: state.query,
    oninput: (e) => { state.query = e.target.value; redraw(); }
  }));
  const filterBtn = h('button', { type: 'button', class: 'iconbtn', id: 'filter-btn', 'aria-label': 'Filter (필터)', 'aria-pressed': String(!!state.filterOpen), onclick: () => { state.filterOpen = !state.filterOpen; api.rerender(); } }, icon('filter', 22));
  const printBtn = h('button', { type: 'button', class: 'iconbtn', id: 'print-btn', 'aria-label': 'Print (인쇄)', onclick: () => window.print && window.print() }, icon('print', 22));
  const dlBtn = h('button', { type: 'button', class: 'iconbtn', id: 'csv-btn', 'aria-label': 'Download CSV (내려받기)', onclick: () => {
    const items = filterItems(api);
    const ok = download('home-ledger-' + (state.query ? 'search' : state.month) + '.csv', toCsv(api, items));
    api.toast(ok ? 'CSV downloaded (내려받았습니다)' : 'Download not supported (이 기기에서는 내려받기가 안 됩니다)');
  } }, icon('download', 22));
  const selBtn = h('button', {
    type: 'button', class: 'bk-selbtn' + (bk.on ? ' on' : ''), id: 'sel-btn', 'aria-pressed': String(bk.on),
    title: bk.on ? 'Done (완료) · Esc' : 'Select several to change at once (여러 건 골라서 한 번에 바꾸기)',
    onclick: () => setMode(!bk.on)
  }, icon(bk.on ? 'check' : 'select', 20), h('span', null, bk.on ? 'Done (완료)' : 'Select (선택)'));
  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'l' }, step(-1, 'Previous month (이전 달)'), monthSel, step(1, 'Next month (다음 달)')),
    search,
    h('div', { class: 'r' }, selBtn, filterBtn, printBtn, dlBtn));

  const reviewCount = d.items.filter((it) => L.monthOf(it.txn.date) === month && (L.needsCategory(it))).length;
  const chips = state.filterOpen ? h('div', { class: 'chips', id: 'kind-chips' }, [['', 'All (전체)'], ['EXPENSE', 'Expense (지출)'], ['INCOME', 'Income (수입)'], ['TRANSFER', 'Transfer (이체)'], ['REVIEW', 'Needs category (분류 필요' + (reviewCount ? ' ' + reviewCount : '') + ')']]
    .map((k) => h('button', { type: 'button', class: 'chipf' + ((state.kind || '') === k[0] ? ' on' : ''), 'data-kind': k[0], onclick: () => { state.kind = k[0]; api.rerender(); } }, k[1]))) : null;

  const list = h('div', { id: 'list' });
  const tableHost = h('div', { id: 'tbl-host' });
  const main = lay === 'phone' ? list : tableHost;

  const page = h('div', { class: 'page' }, toolbar, chips, main);
  if (lay !== 'phone') {
    // 오른쪽 칸: 이번 달 카테고리
    const side = h('div', { class: 'side', id: 'side' });
    const split = h('div', { class: 'split2' }, h('div', { class: 'main' }, tableHost), side);
    page.replaceChildren(...[toolbar, chips, split].filter(Boolean));
    if (lay === 'tablet') drill.setDock(side, (el) => el.replaceChildren(catList()));
    else drill.setDock(null);
    side.replaceChildren(catList());
  } else drill.setDock(null);
  frag.append(page);
  if (bk.on) {
    page.classList.add('bk-mode');
    bar = bulkBar(api, {
      selected: bk.sel,
      shownIds: () => shown,
      onChange: () => paintSel(),
      onDone: (saved) => { bk.on = false; bk.sel.clear(); bk.anchor = ''; if (!saved) api.rerender(); },
      onSelectAll: () => {
        const all = shown.length && shown.every((id) => bk.sel.has(id));
        if (all) shown.forEach((id) => bk.sel.delete(id)); else shown.forEach((id) => bk.sel.add(id));
        paintSel();
      }
    });
    frag.append(bar);
  }
  redraw();
  return frag;

  // ── 여러 건 선택
  function tapRow(e, id) {
    if (suppressNext) { suppressNext = false; return; }
    if (!bk.on) { api.openForm(id); return; }
    id = String(id);
    if (e && e.shiftKey && bk.anchor && bk.anchor !== id) {
      const a = shown.indexOf(bk.anchor), b = shown.indexOf(id);
      if (a >= 0 && b >= 0) {
        const add = !bk.sel.has(id) || bk.sel.has(bk.anchor);
        shown.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => { if (add) bk.sel.add(x); else bk.sel.delete(x); });
        if (window.getSelection) { try { window.getSelection().removeAllRanges(); } catch (err) { /* 무시 */ } }
        paintSel();
        return;
      }
    }
    if (bk.sel.has(id)) bk.sel.delete(id); else bk.sel.add(id);
    bk.anchor = id;
    paintSel();
  }
  // 터치에서 길게 누르면 선택 시작 (또는 선택 토글)
  function longPress(el, id) {
    let tm = null, x = 0, y = 0;
    const cancel = () => { if (tm) { clearTimeout(tm); tm = null; } };
    el.addEventListener('pointerdown', (e) => {
      suppressNext = false;
      if (e.pointerType === 'mouse') return;
      x = e.clientX; y = e.clientY;
      cancel();
      tm = setTimeout(() => {
        tm = null;
        suppressNext = true;
        try { if (navigator.vibrate) navigator.vibrate(12); } catch (err) { /* 무시 */ }
        if (!bk.on) setMode(true, id);
        else { const k = String(id); if (bk.sel.has(k)) bk.sel.delete(k); else bk.sel.add(k); bk.anchor = k; paintSel(); }
      }, 480);
    });
    el.addEventListener('pointermove', (e) => { if (tm && Math.hypot(e.clientX - x, e.clientY - y) > 10) cancel(); });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('contextmenu', (e) => { if (bk.on || suppressNext) e.preventDefault(); });
  }
  function paintSel() {
    main.querySelectorAll('[data-id]').forEach((el) => {
      const on = bk.sel.has(el.getAttribute('data-id'));
      el.classList.toggle('bk-sel', on);
      el.setAttribute(el.tagName === 'TR' ? 'aria-selected' : 'aria-pressed', String(on));
    });
    const hc = main.querySelector('#bk-head-ck');
    if (hc) {
      const n = shown.filter((id) => bk.sel.has(id)).length;
      hc.checked = !!shown.length && n === shown.length;
      hc.indeterminate = n > 0 && n < shown.length;
    }
    if (bar) bar.update();
  }
  function ckMark() { return h('span', { class: 'bk-ck', 'aria-hidden': 'true' }, icon('check', 16)); }

  // ── 이번 달 카테고리 (눌러서 그 거래들을 옆 칸/서랍에서 확인)
  function catList() {
    const is = incomeStatement(d.items, d.accMap, month);
    const box = h('div', { class: 'catlist', id: 'catlist' }, h('h3', null, 'Spending by category (카테고리별 지출)'), h('div', { class: 'sub' }, L.monthLabel(month) + ' · tap to see transactions (눌러서 거래 보기)'));
    const lines = is.expenseGroups.flatMap((g) => g.lines.map((l) => Object.assign({}, l, { grp: g.key }))).sort((a, b) => b.amount - a.amount).slice(0, 12);
    if (!lines.length) box.append(h('div', { class: 'dp-empty' }, 'No spending yet (아직 지출이 없습니다).'));
    lines.forEach((l) => {
      box.append(h('button', {
        type: 'button', class: 'catrow ' + (L.GROUP_CLASS[l.grp] || ''), 'data-acct': l.id,
        onclick: () => drill.show(drillApi(), { key: 'cat:' + l.id + ':' + month, title: l.name, sub: L.monthLabel(month), months: [month], ids: [l.id], mode: 'exp', search: l.name, addDefaults: { kind: 'EXPENSE', categoryId: l.id } })
      }, h('span', { class: 't' }, l.name), h('span', { class: 'v' }, fmt(l.amount)),
      h('span', { class: 'share-bar' }, h('i', { style: 'width:' + (is.expense ? Math.max(3, Math.round(l.amount / is.expense * 100)) : 0) + '%' }))));
    });
    return box;
  }
  function drillApi() { return api.drillApi ? api.drillApi() : api; }

  // ── 목록/표
  function redraw() {
    const items = filterItems(api);
    shown = items.map((it) => String(it.txn.txn_id));
    if (bk.on && bk.sel.size) { const keep = new Set(shown); Array.from(bk.sel).forEach((id) => { if (!keep.has(id)) bk.sel.delete(id); }); }
    const q = (state.query || '').trim();
    const a = state.acct ? d.accMap.get(String(state.acct)) : null;
    const tl = a ? balanceTimeline(d.items, a).map : null;
    if (lay === 'phone') drawList(items, q, a, tl); else drawTable(items, q, a, tl);
    if (bk.on) paintSel();
  }

  function groupClass(it) {
    const dsc = it.desc;
    const cat = d.accMap.get(String(dsc.categoryId));
    return dsc.kind === 'INCOME' ? 'g-in' : dsc.kind === 'EXPENSE' ? (L.GROUP_CLASS[cat && cat.report_group] || '') : 'g-move';
  }

  function drawList(items, q, a, tl) {
    list.replaceChildren();
    if (q) list.append(h('div', { class: 'note' }, items.length + ' result(s) (검색 결과 ' + items.length + '건) — all months (전체 기간)'));
    if (!items.length) {
      list.append(h('div', { class: 'card center muted' }, q ? 'No matches (일치하는 거래가 없습니다)' : 'No transactions this month (이번 달 거래가 없습니다). Tap New to add (위의 버튼으로 추가)'));
      return;
    }
    const CAP = 200;
    let last = null;
    items.slice(0, CAP).forEach((it) => {
      if (it.txn.date !== last) { list.append(h('div', { class: 'dayhead' }, L.dayLabel(it.txn.date))); last = it.txn.date; }
      list.append(row(it, a, tl));
    });
    if (items.length > CAP) list.append(h('div', { class: 'note' }, 'Showing first ' + CAP + ' (처음 ' + CAP + '건만 표시)'));
  }

  // 영수증 사진이 있는 거래에는 카메라 아이콘 (누르면 바로 영수증 보기)
  var rcIds = null;   // eslint-disable-line no-var -- redraw() 가 먼저 불려도 안전하게 (끌어올려짐)
  function rcSet() { return rcIds || (rcIds = (api.state.data && api.state.data.receipts) ? RV.receiptTxnIds(api.state.data) : new Set()); }
  function rcBtn(id) {
    if (!api.viewReceipt || !rcSet().has(String(id))) return null;
    return h('span', {
      class: 'row-rc', role: 'button', tabindex: bk.on ? '-1' : '0', 'data-rc': id, 'aria-label': 'View receipt (영수증 보기)', title: 'View receipt (영수증 보기)',
      onclick: (e) => { if (bk.on) return; e.stopPropagation(); e.preventDefault(); api.viewReceipt(id); },
      onkeydown: (e) => { if (!bk.on && (e.key === 'Enter' || e.key === ' ')) { e.stopPropagation(); e.preventDefault(); api.viewReceipt(id); } }
    }, icon('camera', 16));
  }

  function rowTitle(text, id, cls) {
    const rc = rcBtn(id);
    return rc ? h('div', { class: (cls || 'row-title') + ' has-rc' }, h('span', { class: 'rt' }, text), rc) : h('div', { class: cls || 'row-title' }, text);
  }

  function row(it, a, tl) {
    const t = it.txn, dsc = it.desc;
    const title = t.merchant || t.memo || dsc.categoryName;
    const sub = [dsc.categoryName, a ? null : dsc.accountName];
    if (t.merchant && t.memo) sub.push(t.memo);
    const c = columnsOf(it, a);
    const amt = c.inn ? c.inn : c.out ? c.out : c.move;
    const cls = c.inn ? 'in' : c.out ? 'out' : 'move';
    const arrow = c.inn ? '↑' : c.out ? '↓' : '⇄';
    const foreign = t.currency && t.currency !== 'CAD';
    const prov = String(t.fx_status).toUpperCase() === 'PROVISIONAL' ? '~' : '';
    const bal = tl && tl.has(String(t.txn_id)) ? tl.get(String(t.txn_id)) : null;
    const el = h('button', { type: 'button', class: 'row ' + groupClass(it) + (bk.on ? ' bk-row' : ''), 'data-id': t.txn_id, onclick: (e) => tapRow(e, t.txn_id) },
      bk.on ? ckMark() : null,
      h('div', { class: 'row-main' },
        rowTitle(title, t.txn_id),
        h('div', { class: 'row-sub' }, sub.filter(Boolean).join(' · '))),
      h('div', { class: 'row-right' },
        h('div', { class: 'row-amt ' + cls }, arrow + ' ' + fmt(amt)),
        foreign ? h('div', { class: 'row-fx' }, prov + fmt(L.num(t.total_orig), t.currency)) : null,
        bal !== null ? h('div', { class: 'row-fx' }, 'Bal ' + fmt(bal)) : null));
    longPress(el, t.txn_id);
    return el;
  }

  function drawTable(items, q, a, tl) {
    tableHost.replaceChildren();
    if (q) tableHost.append(h('div', { class: 'note' }, items.length + ' result(s) (검색 결과 ' + items.length + '건) — all months (전체 기간)'));
    if (!items.length) {
      tableHost.append(h('div', { class: 'card center muted' }, q ? 'No matches (일치하는 거래가 없습니다)' : 'No transactions this month (이번 달 거래가 없습니다). Tap New to add (위의 버튼으로 추가)'));
      return;
    }
    const wide = lay === 'desktop';
    const head = ['Date', wide ? 'Transaction description' : 'Description'];
    const th = (txt, ko, r) => h('th', { class: r ? 'r' : '' }, txt, ko ? h('span', { class: 'ko' }, ko) : null);
    const headCk = bk.on ? h('th', { class: 'bk-ckcell' }, h('input', {
      type: 'checkbox', id: 'bk-head-ck', 'aria-label': 'Select all shown (보이는 것 모두 선택)',
      onclick: (e) => { e.stopPropagation(); const all = shown.length && shown.every((id) => bk.sel.has(id)); if (all) shown.forEach((id) => bk.sel.delete(id)); else shown.forEach((id) => bk.sel.add(id)); paintSel(); }
    })) : null;
    const tr = h('tr', null, headCk, th('Date', '날짜'), th(head[1], '내역'), wide ? th('Category', '카테고리') : null, wide && !a ? th('Account', '계좌') : null, th('Withdrawals', '출금', true), th('Deposits', '입금', true), a ? th('Balance', '잔액', true) : (wide ? null : th('Account', '계좌')));
    const tb = h('tbody');
    const CAP = 300;
    let lastDay = null;
    items.slice(0, CAP).forEach((it) => {
      const t = it.txn, dsc = it.desc;
      const c = columnsOf(it, a);
      const bal = tl && tl.has(String(t.txn_id)) ? tl.get(String(t.txn_id)) : null;
      const todo = L.needsCategory(it);
      const foreign = t.currency && t.currency !== 'CAD';
      if (q && t.date !== lastDay) { /* 검색 결과는 날짜가 섞이므로 날짜 칸을 그대로 둡니다 */ }
      lastDay = t.date;
      const catEl = h('span', { class: 'catchip ' + groupClass(it) + (todo ? ' todo' : '') }, todo ? 'Needs category (분류 필요)' : (dsc.categoryName || ''));
      const descCell = h('td', { class: 'desc' },
        rowTitle(t.merchant || t.memo || dsc.categoryName, t.txn_id, 't'),
        !wide ? h('div', { class: 'm' }, catEl) : null,
        t.merchant && t.memo ? h('div', { class: 'm' }, t.memo) : null,
        foreign ? h('div', { class: 'm' }, fmt(L.num(t.total_orig), t.currency)) : null);
      const trEl = h('tr', { 'data-id': t.txn_id, class: bk.on ? 'bk-row' : '', onclick: (e) => tapRow(e, t.txn_id) },
        bk.on ? h('td', { class: 'bk-ckcell' }, ckMark()) : null,
        h('td', { class: 'd' }, q ? fmtDate(t.date) : shortDate(t.date)),
        descCell,
        wide ? h('td', null, catEl) : null,
        wide && !a ? h('td', { class: 'd' }, dsc.accountName) : null,
        h('td', { class: 'r' }, c.out ? h('span', { class: 'amt-out' }, fmt(c.out)) : c.move ? h('span', { class: 'amt-move', title: 'Transfer (이체)' }, '⇄ ' + fmt(c.move)) : ''),
        h('td', { class: 'r' }, c.inn ? h('span', { class: 'amt-in' }, fmt(c.inn)) : ''),
        a ? h('td', { class: 'r bal' }, bal !== null ? fmt(bal) : '') : (wide ? null : h('td', { class: 'd' }, dsc.accountName)));
      longPress(trEl, t.txn_id);
      tb.append(trEl);
    });
    const table = h('table', { class: 'stmt', id: 'stmt' }, h('thead', null, tr), tb);
    tableHost.append(h('div', { class: 'tbl' }, h('div', { class: 'tbl-scroll' }, table)));
    if (items.length > CAP) tableHost.append(h('div', { class: 'note' }, 'Showing first ' + CAP + ' (처음 ' + CAP + '건만 표시)'));
  }
}
