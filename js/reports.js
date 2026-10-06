// 손익(Income Statement)과 재무상태(Balance Sheet). 계산(순수 로직) + 화면.
import { openPrintReport } from './printreport.js';
import * as L from './ledger.js';
import * as B from './budget.js';

const UNCATEGORIZED_ID = '9999';

// ───────── 계산 ─────────

const lastDayOf = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return ym + '-' + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0');
};

// items = [{txn, ps}], accMap = Map(account_id → account), months = ['YYYY-MM', …]
export function incomeStatementOver(items, accMap, months) {
  const monthSet = new Set(months);
  const inc = new Map(), exp = new Map();
  let reviewCount = 0;
  items.forEach((it) => {
    if (!monthSet.has(L.monthOf(it.txn.date))) return;
    let review = String(it.txn.status).toUpperCase() === 'REVIEW';
    it.ps.forEach((p) => {
      const a = accMap.get(String(p.account_id));
      if (!a) return;
      const v = L.num(p.amount_cad);
      if (a.type === 'INCOME') inc.set(a.account_id, (inc.get(a.account_id) || 0) - v);
      else if (a.type === 'EXPENSE') {
        exp.set(a.account_id, (exp.get(a.account_id) || 0) + v);
        if (String(a.account_id) === UNCATEGORIZED_ID) review = true;
      }
    });
    if (review) reviewCount++;
  });
  const lineOf = (id, amount) => { const a = accMap.get(String(id)); return { id: String(id), name: a.name, name_ko: a.name_ko || '', amount: L.round(amount, 2), sort: L.num(a.sort_order), group: a.report_group || '' }; };
  // 줄 순서: 카테고리의 sort_order (보고서의 "순서 바꾸기"로 정함) → 같으면 금액 큰 순
  const bySort = (a, b) => (a.sort - b.sort) || (b.amount - a.amount);
  const incomeLines = Array.from(inc, ([id, v]) => lineOf(id, v)).filter((l) => l.amount !== 0).sort(bySort);
  const groups = new Map();
  Array.from(exp, ([id, v]) => lineOf(id, v)).filter((l) => l.amount !== 0).forEach((l) => {
    const key = l.group || '확인 필요';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  });
  const order = L.GROUP_ORDER.filter((g) => groups.has(g)).concat(Array.from(groups.keys()).filter((g) => L.GROUP_ORDER.indexOf(g) < 0));
  const expenseGroups = order.map((key) => {
    const lines = groups.get(key).sort(bySort);
    return { key, label: L.GROUP_LABELS[key] || key, total: L.round(lines.reduce((s, l) => s + l.amount, 0), 2), lines };
  });
  const income = L.round(incomeLines.reduce((s, l) => s + l.amount, 0), 2);
  const expense = L.round(expenseGroups.reduce((s, g) => s + g.total, 0), 2);
  const net = L.round(income - expense, 2);
  return { ym: months.length === 1 ? months[0] : months[0] + '…' + months[months.length - 1], months, incomeLines, income, expenseGroups, expense, net, savingsRate: income > 0 ? L.round(net / income * 100, 1) : null, reviewCount };
}

export function incomeStatement(items, accMap, ym) { return incomeStatementOver(items, accMap, [ym]); }

// 월말 기준 재무상태. 장부가 맞는지(자산 − 부채 = 자본)도 확인합니다.
export function balanceSheet(accounts, items, accMap, ym, overrides) {
  const asOf = lastDayOf(ym);
  const raw = new Map();
  items.forEach((it) => {
    if (it.txn.date > asOf) return;
    it.ps.forEach((p) => { const k = String(p.account_id); raw.set(k, (raw.get(k) || 0) + L.num(p.amount_cad)); });
  });
  const get = (id) => raw.get(String(id)) || 0;
  const live = accounts.filter((a) => L.isActive(a) || Math.abs(get(a.account_id)) > 0.005);
  const ov = overrides instanceof Map ? overrides : new Map();
  let adj = 0; // 평가·상환표로 덮어쓴 값과 장부 값의 차이 (자본에 "평가 조정" 줄로 들어갑니다)
  const lines = (type, sign) => live.filter((a) => a.type === type)
    .map((a) => {
      const id = String(a.account_id);
      const book = L.round(sign * get(a.account_id), 2);
      if ((type === 'ASSET' || type === 'LIABILITY') && ov.has(id)) {
        const v = L.round(ov.get(id), 2);
        adj += type === 'ASSET' ? v - book : book - v;
        return { id, name: a.name, name_ko: a.name_ko || '', owner: a.owner || '', amount: v, book, valued: true };
      }
      return { id, name: a.name, name_ko: a.name_ko || '', owner: a.owner || '', amount: book };
    })
    .filter((l) => Math.abs(l.amount) > 0.004 || l.valued);
  const assets = lines('ASSET', 1), liabilities = lines('LIABILITY', -1), equityLines = lines('EQUITY', -1);
  adj = L.round(adj, 2);
  if (Math.abs(adj) > 0.004) equityLines.push({ id: 'valuation-adj', name: 'Valuation adjustments', name_ko: '평가 조정', owner: '', amount: adj, synthetic: true });
  const sum = (ls) => L.round(ls.reduce((s, l) => s + l.amount, 0), 2);
  let pl = 0;
  live.forEach((a) => { if (a.type === 'INCOME' || a.type === 'EXPENSE') pl += get(a.account_id); });
  const retained = L.round(-pl, 2); // 누적 순수입 = 수입 − 지출
  const totalAssets = sum(assets), totalLiab = sum(liabilities);
  const equityTotal = L.round(sum(equityLines) + retained, 2);
  const net = L.round(totalAssets - totalLiab, 2);
  return { ym, asOf, assets, totalAssets, liabilities, totalLiab, equityLines, retained, equityTotal, net, diff: L.round(net - equityTotal, 2) };
}

// ───────── 비교 (손익: 이번 vs 이전, 예산) ─────────

/** 'M' = 그 달 하나 / 'Y' = 그 해 1월부터 그 달까지 */
export function scopeMonths(ym, scope) {
  if (scope !== 'Y') return [ym];
  const y = ym.slice(0, 4);
  const out = [];
  for (let m = 1; m <= Number(ym.slice(5, 7)); m++) out.push(y + '-' + String(m).padStart(2, '0'));
  return out;
}
/** 비교 대상: 달 = 지난달 / 올해 누계 = 작년 같은 기간 */
export function priorMonths(ym, scope) {
  if (scope !== 'Y') return [L.shiftMonth(ym, -1)];
  return scopeMonths(ym, 'Y').map((m) => (Number(m.slice(0, 4)) - 1) + m.slice(4));
}

const sortOf = (accMap, id) => { const a = accMap.get(String(id)); return a ? L.num(a.sort_order) : 1e9; };
const sumBudget = (budgets, months, id) => L.round(months.reduce((s, m) => s + (B.budgetMap(budgets, m).get(String(id)) || 0), 0), 2);

const pctChange = (cur, prev) => (Math.abs(prev) > 0.004 ? L.round((cur - prev) / Math.abs(prev) * 100, 1) : null);

/**
 * 손익 비교표. 두 기간의 줄을 합쳐서 (한쪽에만 있어도 보이게) 줄마다
 * { id, name, name_ko, cur, prev, delta, pct, budget, used } 를 만듭니다.
 * 반환: { income:{lines,cur,prev,budget}, groups:[{key,label,lines,cur,prev,budget}], expense:{cur,prev,budget}, net:{cur,prev} }
 */
export function compareIS(items, accMap, budgets, months, prevMonths) {
  const cur = incomeStatementOver(items, accMap, months);
  const prev = incomeStatementOver(items, accMap, prevMonths);
  const merge = (curLines, prevLines, withBudget) => {
    const map = new Map();
    curLines.forEach((l) => map.set(l.id, { id: l.id, name: l.name, name_ko: l.name_ko, cur: l.amount, prev: 0 }));
    prevLines.forEach((l) => { const e = map.get(l.id); if (e) e.prev = l.amount; else map.set(l.id, { id: l.id, name: l.name, name_ko: l.name_ko, cur: 0, prev: l.amount }); });
    return Array.from(map.values()).map((e) => {
      const budget = withBudget ? sumBudget(budgets, months, e.id) : 0;
      return Object.assign(e, { delta: L.round(e.cur - e.prev, 2), pct: pctChange(e.cur, e.prev), budget, used: budget > 0 ? Math.round(e.cur / budget * 100) : null });
    }).sort((a, b) => (sortOf(accMap, a.id) - sortOf(accMap, b.id)) || (b.cur - a.cur) || (b.prev - a.prev));
  };
  const total = (lines, key) => L.round(lines.reduce((s, l) => s + l[key], 0), 2);
  const incLines = merge(cur.incomeLines, prev.incomeLines, false);
  const keys = new Set();
  cur.expenseGroups.forEach((g) => keys.add(g.key)); prev.expenseGroups.forEach((g) => keys.add(g.key));
  const order = L.GROUP_ORDER.filter((g) => keys.has(g)).concat(Array.from(keys).filter((g) => L.GROUP_ORDER.indexOf(g) < 0));
  const groups = order.map((key) => {
    const cg = cur.expenseGroups.find((g) => g.key === key), pg = prev.expenseGroups.find((g) => g.key === key);
    const lines = merge(cg ? cg.lines : [], pg ? pg.lines : [], true);
    return { key, label: L.GROUP_LABELS[key] || key, lines, cur: total(lines, 'cur'), prev: total(lines, 'prev'), budget: total(lines, 'budget') };
  });
  const expCur = L.round(groups.reduce((s, g) => s + g.cur, 0), 2), expPrev = L.round(groups.reduce((s, g) => s + g.prev, 0), 2);
  const incCur = total(incLines, 'cur'), incPrev = total(incLines, 'prev');
  return {
    months, prevMonths, review: cur.reviewCount,
    income: { lines: incLines, cur: incCur, prev: incPrev },
    groups, expense: { cur: expCur, prev: expPrev, budget: L.round(groups.reduce((s, g) => s + g.budget, 0), 2) },
    net: { cur: L.round(incCur - expCur, 2), prev: L.round(incPrev - expPrev, 2) },
    savingsRate: incCur > 0 ? L.round((incCur - expCur) / incCur * 100, 1) : null
  };
}

// ───────── 사람별 · 업체별 ─────────
// insights.js 도 reports.js 를 불러오는 순환 import 이지만, 두 파일 모두 "함수 선언"만 쓰고 불러오는 즉시 서로를 호출하지 않으므로 안전합니다.

/** 소유자별 수입·지출·순수입 (months 기간) + 비교 기간(prevMonths) 지출 증감 + 지출 비중. 지출 많은 순. */
/**
 * 소유자별 수입·지출. 나눈 거래(split)는 줄마다 owner 가 있을 수 있으므로 p.owner || txn.owner || 'Joint' 로 나눕니다.
 * 반환: [{owner, income, expense, net}] 지출 많은 순 (insights.ownerTable 과 같은 모양)
 */
export function ownerTotals(items, accMap, ms) {
  const set = new Set(ms);
  const by = new Map();
  items.forEach((it) => {
    if (!set.has(L.monthOf(it.txn.date))) return;
    it.ps.forEach((p) => {
      const a = accMap.get(String(p.account_id));
      if (!a || (a.type !== 'INCOME' && a.type !== 'EXPENSE')) return;
      const o = String(p.owner || it.txn.owner || 'Joint').trim() || 'Joint';
      const e = by.get(o) || { owner: o, income: 0, expense: 0 };
      if (a.type === 'INCOME') e.income -= L.num(p.amount_cad); else e.expense += L.num(p.amount_cad);
      by.set(o, e);
    });
  });
  return Array.from(by.values()).map((e) => ({ owner: e.owner, income: L.round(e.income, 2), expense: L.round(e.expense, 2), net: L.round(e.income - e.expense, 2) }))
    .filter((e) => e.income || e.expense).sort((a, b) => b.expense - a.expense);
}

export function peopleReport(items, accMap, months, prevMonths) {
  const cur = ownerTotals(items, accMap, months);
  const prev = new Map(ownerTotals(items, accMap, prevMonths || []).map((e) => [e.owner, e]));
  const income = L.round(cur.reduce((s, e) => s + e.income, 0), 2);
  const expense = L.round(cur.reduce((s, e) => s + e.expense, 0), 2);
  const rows = cur.map((e) => {
    const p = prev.get(e.owner);
    const pe = p ? p.expense : 0;
    return Object.assign({}, e, { prevExpense: pe, delta: L.round(e.expense - pe, 2), share: expense > 0 ? L.round(e.expense / expense * 100, 1) : 0 });
  });
  const prevExpense = L.round(Array.from(prev.values()).reduce((s, e) => s + e.expense, 0), 2);
  return { rows, income, expense, net: L.round(income - expense, 2), prevExpense, delta: L.round(expense - prevExpense, 2) };
}

/** 업체(가맹점)별 지출 상위 topN. 같은 가게(대소문자·번호 달라도)는 합칩니다. 반환: { rows:[{key,name,cat,total,count,avg,share}], total, count } */
export function vendorReport(items, accMap, months, topN) {
  const all = I.vendorTable(items, accMap, months, 1e9);
  return { rows: all.slice(0, topN || 25), total: L.round(all.reduce((s, v) => s + v.total, 0), 2), count: all.length };
}

// ───────── 화면 ─────────

import { icon } from './icons.js';
import { layoutOf } from './layout.js';
import * as drill from './drill.js';
import * as I from './insights.js';
import * as P from './prefs.js';
import { makeSortable } from './reorder.js';

let mode = 'IS';
let scope = 'M';
let reo = null;   // 손익 "순서 바꾸기" 중일 때: { lists: Map(그룹 → [account_id…]) } (저장 전까지는 화면에만)
export function setMode(m) { mode = m; reo = null; }
export function isReordering() { return !!reo; }
export function setScope(s) { scope = s === 'Y' ? 'Y' : 'M'; }

const fmtDate = (s) => { const d = new Date(String(s).slice(0, 10) + 'T12:00:00'); return isNaN(d) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
const rangeLabel = (ms) => (ms.length === 1 ? L.monthLabel(ms[0]) : L.monthLabel(ms[0]) + ' – ' + L.monthLabel(ms[ms.length - 1]));

// api = { h, fmt, state, items, accounts, accMap, data, toast, saveBudgets, rerender, goSearch, openForm, drillApi }
export function render(api) {
  const { h, state } = api;
  // "달러 단위" 켜짐 → 표시만 반올림 (계산은 그대로 센트 단위)
  const whole = P.rounded();
  const fmt = (n, ccy) => {
    if (!whole) return api.fmt(n, ccy);
    const r = Math.round(Number(n) || 0);
    return api.fmt(r === 0 ? 0 : r, ccy).replace(/\.0+$/, '');
  };
  const lay = layoutOf();
  const frag = document.createDocumentFragment();
  const D = () => (api.drillApi ? api.drillApi() : api);
  if (!state.repSel) state.repSel = new Set();
  const month = state.month;

  // 자료
  const ranged = mode === 'IS' || mode === 'WHO' || mode === 'VENDOR';   // 월 / 올해 누계를 고를 수 있는 보기
  const curMs = scopeMonths(month, ranged ? scope : 'M');
  const prvMs = priorMonths(month, ranged ? scope : 'M');
  const cmp = mode === 'IS' ? compareIS(api.items, api.accMap, api.data.budgets || [], curMs, prvMs) : null;
  const bs = mode === 'BS' ? balanceSheet(api.accounts, api.items, api.accMap, month, api.overridesFor ? api.overridesFor(month) : undefined) : null;
  const bsPrev = mode === 'BS' ? balanceSheet(api.accounts, api.items, api.accMap, L.shiftMonth(month, -1), api.overridesFor ? api.overridesFor(L.shiftMonth(month, -1)) : undefined) : null;
  const today = L.todayStr();
  const bg = mode === 'BG' ? B.compare(api.items, api.accMap, api.data.budgets || [], month, today) : null;
  const who = mode === 'WHO' ? peopleReport(api.items, api.accMap, curMs, prvMs) : null;
  const vend = mode === 'VENDOR' ? vendorReport(api.items, api.accMap, curMs, 25) : null;

  // ── 배너
  const metrics = h('div', { class: 'metrics' });
  const metric = (lab, val, sub, id) => h('div', { class: 'metric' + (sub ? ' sub' : ''), id: id || null }, h('div', { class: 'metric-lab' }, lab), h('div', { class: 'metric-val' }, val));
  if (cmp) {
    const lab = scope === 'Y' ? 'YTD' : L.monthLabel(month);
    metrics.append(
      metric('Net income · ' + lab + ' (순수입)', (cmp.net.cur < 0 ? '−' : '') + fmt(Math.abs(cmp.net.cur)), false, 'bn-net'),
      metric('Income (수입)', fmt(cmp.income.cur), true, 'bn-in'),
      metric('Spending (지출)', fmt(cmp.expense.cur), true, 'bn-out'),
      cmp.savingsRate !== null ? metric('Savings rate (저축률)', cmp.savingsRate + '%', true, 'bn-rate') : null);
  } else if (bs) {
    const dn = L.round(bs.net - bsPrev.net, 2);
    metrics.append(
      metric('Net worth (순자산)', (bs.net < 0 ? '−' : '') + fmt(Math.abs(bs.net)), false, 'bn-net'),
      metric('Assets (자산)', fmt(bs.totalAssets), true),
      metric('Debts (부채)', fmt(bs.totalLiab), true),
      metric('vs last month (전월 대비)', (dn >= 0 ? '▲ ' : '▼ ') + fmt(Math.abs(dn)), true));
  } else if (bg) {
    metrics.append(
      metric(bg.left >= 0 ? 'Left (남은 예산)' : 'Over (초과)', (bg.left < 0 ? '−' : '') + fmt(Math.abs(bg.left)), false, 'bn-net'),
      metric('Budget (예산)', fmt(bg.totalBudget), true),
      metric('Spent (지출)', fmt(bg.totalActual), true),
      bg.pct !== null ? metric('Used (사용)', bg.pct + '%', true) : null);
  }
  else if (who) {
    const lab = scope === 'Y' ? 'YTD' : L.monthLabel(month);
    const top = who.rows[0];
    metrics.append(
      metric('Net income · ' + lab + ' (순수입)', (who.net < 0 ? '−' : '') + fmt(Math.abs(who.net)), false, 'bn-net'),
      metric('Income (수입)', fmt(who.income), true, 'bn-in'),
      metric('Spending (지출)', fmt(who.expense), true, 'bn-out'),
      top ? metric('Top spender (지출 1위)', top.owner, true, 'bn-top') : null);
  } else if (vend) {
    const lab = scope === 'Y' ? 'YTD' : L.monthLabel(month);
    const top = vend.rows[0];
    metrics.append(
      metric('Vendor spending · ' + lab + ' (업체 지출)', fmt(vend.total), false, 'bn-net'),
      metric('Vendors (업체 수)', String(vend.count), true, 'bn-count'),
      top ? metric('Top vendor (1위)', top.name, true, 'bn-top') : null,
      vend.total > 0 && vend.rows.length ? metric('Top ' + vend.rows.length + ' share (상위 비중)', L.round(vend.rows.reduce((x, v) => x + v.total, 0) / vend.total * 100, 1) + '%', true, 'bn-share') : null);
  }
  frag.append(h('section', { class: 'banner' }, h('div', { class: 'banner-in' },
    h('div', { class: 'banner-row' },
      h('div', { class: 'acct-pick' }, h('span', { class: 'nm' }, 'Household reports (가계 보고서)')),
      h('div', { class: 'asof' }, mode === 'BS' ? 'As of ' : 'Through ', h('b', null, fmtDate(mode === 'BS' && bs ? bs.asOf : today)))),
    metrics)));

  frag.append(h('div', { class: 'pills' },
    h('button', { type: 'button', class: 'pillbtn', id: 'rep-new', onclick: () => api.openForm(null, {}) }, icon('plus', 24), 'New ', h('span', { class: 'ko' }, '거래 추가')),
    h('button', { type: 'button', class: 'pillbtn', id: 'rep-csv', onclick: exportCsv }, icon('download', 24), 'Export ', h('span', { class: 'ko' }, '내려받기')),
    h('button', { type: 'button', class: 'pillbtn', id: 'rep-print', onclick: () => { try { openPrintReport(api.pageApi ? api.pageApi() : api, { tab: 'reports' }); } catch (e) { api.toast('Could not open print (인쇄 창을 열지 못했어요)'); } } }, icon('print', 24), 'Print ', h('span', { class: 'ko' }, '인쇄')),
    h('button', { type: 'button', class: 'pillbtn', id: 'rep-ledger', onclick: () => api.goSearch('') }, icon('ledger', 24), 'Ledger ', h('span', { class: 'ko' }, '거래 탭'))));

  // ── 페이지
  const seg = h('div', { class: 'segtd five', role: 'tablist' },
    [['IS', 'Income', '손익'], ['BS', 'Balance', '재무'], ['BG', 'Budget', '예산'], ['WHO', 'People', '사람별'], ['VENDOR', 'Vendors', '업체별']].map((m) => h('button', {
      type: 'button', id: 'rep-' + m[0], role: 'tab', class: mode === m[0] ? 'on' : '', 'aria-selected': String(mode === m[0]),
      onclick: () => { if (mode !== m[0]) reo = null; mode = m[0]; if (m[0] === 'WHO' || m[0] === 'VENDOR') drill.close(); api.rerender(); }
    }, m[1], h('span', { class: 'ko' }, m[2]))));
  const stepBtn = (dir, lab) => h('button', { type: 'button', class: 'stepbtn', 'aria-label': lab, onclick: () => { state.month = L.shiftMonth(state.month, dir); api.rerender(); } }, icon(dir < 0 ? 'left' : 'right', 20));
  const months = Array.from(new Set(api.items.map((it) => L.monthOf(it.txn.date)).concat([L.monthOf(today), month]))).sort().reverse();
  const monthSel = h('label', { class: 'pillsel' }, icon('calendar', 20), h('span', { class: 'monthlabel' }, L.monthLabel(month)), icon('down', 18),
    h('select', { id: 'rep-month', 'aria-label': 'Month (월)', onchange: (e) => { state.month = e.target.value; api.rerender(); } }, months.map((m) => h('option', { value: m, selected: m === month }, L.monthLabel(m)))));
  const scopeSeg = ranged ? h('div', { class: 'segtd sm', role: 'tablist' },
    [['M', 'Month', '월'], ['Y', 'Year to date', '올해 누계']].map((s) => h('button', { type: 'button', id: 'rep-scope-' + s[0], class: scope === s[0] ? 'on' : '', onclick: () => { scope = s[0]; api.rerender(); } }, s[1], h('span', { class: 'ko' }, s[2])))) : null;
  const roundBtn = h('button', { type: 'button', class: 'rep-round' + (whole ? ' on' : ''), id: 'rep-round', role: 'switch', 'aria-checked': String(whole), title: 'Show amounts without cents (센트 없이 보기)',
    onclick: () => { P.setRounded(!whole); api.rerender(); } }, h('span', { class: 'sw', 'aria-hidden': 'true' }, h('i')), h('span', { class: 'lab' }, 'Whole dollars (달러 단위)'));
  const toolbar = h('div', { class: 'toolbar rep-toolbar' }, h('div', { class: 'l' }, stepBtn(-1, 'Previous month (이전 달)'), monthSel, stepBtn(1, 'Next month (다음 달)')), h('div', { class: 'r' }, scopeSeg, roundBtn,
    mode === 'IS' && !reo ? h('button', { type: 'button', class: 'btn secondary is-reorder', id: 'rep-reorder', onclick: () => startReorder() }, h('span', { class: 'grip', 'aria-hidden': 'true' }), 'Reorder (순서 바꾸기)') : null));
  const page = h('div', { class: 'page' }, seg, toolbar);
  frag.append(page);

  const selbar = h('div', { class: 'selbar', id: 'rep-selbar', hidden: true });
  const body = h('div', { id: mode === 'IS' ? 'rep-is' : mode === 'BS' ? 'rep-bs' : mode === 'BG' ? 'rep-bg' : mode === 'WHO' ? 'rep-who' : 'rep-vendor' });
  const reordering = mode === 'IS' && !!reo;
  const useDock = lay === 'tablet' && mode !== 'WHO' && mode !== 'VENDOR' && !reordering;   // 사람별·업체별은 줄을 누르면 거래 탭으로 가므로 오른쪽 칸이 필요 없음
  const grid = h('div', { class: 'rep-grid' + (useDock ? ' docked' : '') + (reordering ? ' reordering' : '') }, body);
  if (useDock) {
    const dock = h('div', { class: 'dock', id: 'dock' });
    const fill = (el) => el.replaceChildren(h('div', { class: 'dock-empty' }, icon('list', 34), h('div', null, mode === 'IS' ? 'Tap an amount to see its transactions here. (금액을 누르면 거래가 여기에 나옵니다.)' : 'Tap a line to see its transactions here. (줄을 누르면 거래가 여기에 나옵니다.)')));
    fill(dock);
    drill.setDock(dock, fill);
    grid.append(dock);
  } else drill.setDock(null);

  if (mode === 'IS') drawIS(); else if (mode === 'BS') drawBS(); else if (mode === 'BG') drawBG(); else if (mode === 'WHO') drawWHO(); else drawVENDOR();
  page.append(selbar, grid);
  return frag;

  // ───── 공통 ─────
  function chg(delta, goodUp, big) {
    if (Math.abs(delta) < 0.005) return h('span', { class: 'chg flat' }, '—');
    const good = goodUp ? delta > 0 : delta < 0;
    return h('span', { class: 'chg ' + (good ? 'good' : 'bad') }, h('span', { class: 'arw' }, delta > 0 ? '▲' : '▼'), fmt(Math.abs(delta)));
  }
  function pctEl(cur, prev, goodUp) {
    const p = pctChange(cur, prev);
    if (p === null) return h('span', { class: 'chg flat' }, cur ? 'new' : '—');
    const delta = cur - prev;
    if (Math.abs(delta) < 0.005) return h('span', { class: 'chg flat' }, '0%');
    const good = goodUp ? delta > 0 : delta < 0;
    return h('span', { class: 'chg ' + (good ? 'good' : 'bad') }, h('span', { class: 'arw' }, delta > 0 ? '▲' : '▼'), Math.abs(p) + '%');
  }
  function openLine(l, kind, ms, extra) {
    D() && drill.show(D(), Object.assign({
      key: kind + ':' + l.id + ':' + ms.join(','), title: l.name, sub: rangeLabel(ms), months: ms, ids: [l.id],
      mode: kind === 'inc' ? 'inc' : 'exp', search: l.name, addDefaults: { kind: kind === 'inc' ? 'INCOME' : 'EXPENSE', categoryId: l.id }
    }, extra || {}));
  }
  function exportCsv() {
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [];
    if (cmp) {
      lines.push(['Section', 'Account', rangeLabel(curMs), rangeLabel(prvMs), 'Change', 'Change %', 'Budget'].map(q).join(','));
      cmp.income.lines.forEach((l) => lines.push(['Income', l.name, l.cur, l.prev, l.delta, l.pct === null ? '' : l.pct, ''].map(q).join(',')));
      cmp.groups.forEach((g) => g.lines.forEach((l) => lines.push([g.label, l.name, l.cur, l.prev, l.delta, l.pct === null ? '' : l.pct, l.budget || ''].map(q).join(','))));
      lines.push(['Net', '', cmp.net.cur, cmp.net.prev, L.round(cmp.net.cur - cmp.net.prev, 2), '', ''].map(q).join(','));
    } else if (bs) {
      lines.push(['Section', 'Account', 'Owner', bs.asOf, bsPrev.asOf, 'Change'].map(q).join(','));
      const pm = new Map(); bsPrev.assets.concat(bsPrev.liabilities).forEach((l) => pm.set(l.id, l.amount));
      bs.assets.forEach((l) => lines.push(['Asset', l.name, l.owner, l.amount, pm.get(l.id) || 0, L.round(l.amount - (pm.get(l.id) || 0), 2)].map(q).join(',')));
      bs.liabilities.forEach((l) => lines.push(['Liability', l.name, l.owner, l.amount, pm.get(l.id) || 0, L.round(l.amount - (pm.get(l.id) || 0), 2)].map(q).join(',')));
      lines.push(['Net worth', '', '', bs.net, bsPrev.net, L.round(bs.net - bsPrev.net, 2)].map(q).join(','));
    } else if (who) {
      lines.push(['Owner', 'Income', 'Spending', 'Net', rangeLabel(prvMs) + ' spending', 'Spending change', 'Spending share %'].map(q).join(','));
      who.rows.forEach((r) => lines.push([r.owner, r.income, r.expense, r.net, r.prevExpense, r.delta, r.share].map(q).join(',')));
      lines.push(['Total', who.income, who.expense, who.net, who.prevExpense, who.delta, ''].map(q).join(','));
    } else if (vend) {
      lines.push(['Rank', 'Vendor', 'Category', 'Total', 'Count', 'Average', 'Share %'].map(q).join(','));
      vend.rows.forEach((r, i) => lines.push([i + 1, r.name, r.cat, r.total, r.count, r.avg, r.share].map(q).join(',')));
    } else if (bg) {
      lines.push(['Group', 'Category', 'Budget', 'Spent', 'Left'].map(q).join(','));
      bg.groups.forEach((g) => g.lines.forEach((l) => lines.push([g.label, l.name, l.budget, l.actual, l.left].map(q).join(','))));
    }
    try {
      const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'home-ledger-' + mode + '-' + month + '.csv'; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      api.toast('CSV downloaded (내려받았습니다)');
    } catch (e) { api.toast('Download not supported (이 기기에서는 내려받기가 안 됩니다)'); }
  }

  // ───── 손익 ─────
  // 카테고리 이름(줄)을 누르면 선택 → 위 초록 막대에 합계. 금액을 누르면 그 줄의 거래가 열림.
  function drawIS() {
    if (reo) { drawReorder(); return; }
    const lab = scope === 'Y' ? ['Year to date', '올해 누계'] : ['This month', '이번 달'];
    const plab = scope === 'Y' ? ['Same period last year', '작년 같은 기간'] : ['Last month', '지난달'];
    body.append(h('div', { class: 'is-hint', id: 'rep-is-hint' }, icon('info', 18),
      h('span', null, lay === 'phone'
        ? 'Tap a name to add it to a total · tap an amount to see transactions. (이름을 누르면 합계에 더하고, 금액을 누르면 거래가 열립니다.)'
        : 'Tap a name to add it to a running total; tap an amount to see its transactions (the prior amount opens that period). (이름을 누르면 합계에 더하고, 금액을 누르면 거래가 열립니다. 이전 금액을 누르면 그 기간 거래가 열립니다.)')));
    if (cmp.review) {
      body.append(h('button', { type: 'button', class: 'card warn-card', id: 'rep-review', onclick: () => api.goSearch('Uncategorized') },
        cmp.review + ' transaction(s) need a category (카테고리 확인이 필요한 거래 ' + cmp.review + '건) — tap to review (눌러서 확인)'));
    }
    if (!cmp.income.lines.length && !cmp.groups.length) {
      body.append(h('div', { class: 'card center muted' }, 'No income or spending in this period (이 기간에 수입·지출이 없습니다).'));
      return;
    }
    const sections = [];
    if (cmp.income.lines.length) sections.push({ kind: 'inc', key: '수입', label: 'Income (수입)', cls: 'g-in', lines: cmp.income.lines, cur: cmp.income.cur, prev: cmp.income.prev, budget: 0 });
    cmp.groups.forEach((g) => sections.push({ kind: 'exp', key: g.key, label: g.label, cls: L.GROUP_CLASS[g.key] || '', lines: g.lines, cur: g.cur, prev: g.prev, budget: g.budget }));
    const lineIndex = new Map();
    sections.forEach((s) => s.lines.forEach((l) => lineIndex.set(l.id, { l, s })));

    const markRows = () => {
      body.querySelectorAll('[data-line]').forEach((el) => {
        const on = state.repSel.has(el.getAttribute('data-line'));
        el.classList.toggle('on', on);
        el.setAttribute('aria-pressed', String(on));
      });
      const ids = Array.from(state.repSel).filter((id) => lineIndex.has(id));
      selbar.hidden = !ids.length;
      if (!ids.length) { selbar.replaceChildren(); return; }
      let c = 0, p = 0; const names = [];
      ids.forEach((id) => { const e = lineIndex.get(id); c += e.l.cur; p += e.l.prev; names.push(e.l.name); });
      selbar.replaceChildren(h('b', null, ids.length + ' selected (선택)'), h('b', { id: 'rep-sel-sum' }, fmt(L.round(c, 2))),
        h('span', { class: 'nms' }, names.join(', ')),
        h('span', { class: 'prv' }, plab[0] + ' ' + fmt(L.round(p, 2))),
        h('button', { type: 'button', class: 'btn', id: 'rep-sel-view', onclick: () => D() && drill.show(D(), { key: 'multi:' + ids.join(',') + curMs.join(','), title: ids.length + ' lines (줄)', sub: rangeLabel(curMs), months: curMs, ids, mode: 'exp', totalLabel: 'Selected total (선택 합계)', addDefaults: {} }) }, 'View (거래 보기)'),
        h('button', { type: 'button', class: 'btn ghost', id: 'rep-sel-clear', onclick: () => { state.repSel.clear(); markRows(); } }, 'Clear (해제)'));
    };
    const togglePick = (id) => { if (state.repSel.has(id)) state.repSel.delete(id); else state.repSel.add(id); markRows(); };
    const rowKeys = (id) => (e) => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePick(id); } };
    // 금액 버튼: 누르면 거래 상세 (줄 선택은 하지 않음)
    const amtBtn = (l, s, which, kids, extraCls) => h('button', {
      type: 'button', class: 'amt' + (extraCls ? ' ' + extraCls : '') + ((which === 'prev' ? l.prev : l.cur) ? '' : ' zero'), 'data-amt': which,
      'aria-label': (which === 'prev' ? plab[0] : lab[0]) + ' · ' + l.name + ' — transactions (거래 보기)',
      onclick: (e) => { e.stopPropagation(); openLine(l, s.kind, which === 'prev' ? prvMs : curMs); }
    }, kids);

    if (lay === 'phone') {
      sections.forEach((s) => {
        body.append(h('div', { class: 'rl-sec ' + s.cls }, h('h3', null, s.label), h('b', null, fmt(s.cur))));
        const box = h('div', { class: 'ledger is-list ' + s.cls });
        const isExp = s.kind === 'exp';
        s.lines.forEach((l) => {
          box.append(h('div', { class: 'rl-row pick ' + s.cls, role: 'button', tabindex: '0', 'aria-pressed': 'false', 'data-line': l.id, 'data-acct': l.id, onclick: () => togglePick(l.id), onkeydown: rowKeys(l.id) },
            h('div', { class: 't' }, l.name),
            h('div', { class: 's' }, plab[0] + ' ' + fmt(l.prev) + (l.budget ? ' · budget (예산) ' + fmt(l.budget) : '')),
            amtBtn(l, s, 'cur', [h('span', { class: 'v' }, fmt(l.cur)), h('span', { class: 'c' }, pctEl(l.cur, l.prev, !isExp))], 'rl-amt'),
            s.cur ? h('div', { class: 'share-bar' }, h('i', { style: 'width:' + Math.max(l.cur > 0 ? 3 : 0, Math.round(Math.abs(l.cur) / Math.max(Math.abs(s.cur), 1) * 100)) + '%' })) : null));
        });
        body.append(box);
      });
      const net = h('div', { class: 'card', id: 'rep-net' }, h('div', { class: 'rc-line strong' }, h('span', null, 'Net income (순수입)'), h('span', null, (cmp.net.cur < 0 ? '−' : '') + fmt(Math.abs(cmp.net.cur)))),
        h('div', { class: 'rc-line' }, h('span', null, plab[0]), h('span', null, (cmp.net.prev < 0 ? '−' : '') + fmt(Math.abs(cmp.net.prev)))));
      body.append(net);
    } else {
      const wide = lay === 'desktop';
      const slim = lay === 'tablet';   // 아이패드: 오른쪽 칸이 있으므로 열을 줄입니다
      const th = (en, ko) => h('th', null, en, h('span', { class: 'ko' }, ko));
      const tr = h('tr', null, th('Account', '계정'), th(lab[0], lab[1]), slim ? null : th(plab[0], plab[1]), slim ? null : th('Change', '증감'), th('Change %', '증감률'), wide ? th('Budget', '예산') : null, wide ? th('Used', '사용률') : null);
      const tb = h('tbody');
      sections.forEach((s) => {
        const isExp = s.kind === 'exp';
        tb.append(h('tr', { class: 'sec ' + s.cls }, h('td', { colspan: wide ? 7 : slim ? 3 : 5 }, s.label)));
        s.lines.forEach((l) => {
          const goodUp = !isExp;
          tb.append(h('tr', { class: 'line pick ' + s.cls, tabindex: '0', 'aria-pressed': 'false', 'data-line': l.id, 'data-acct': l.id, onclick: (e) => { if (!e.target.closest('[data-amt]')) togglePick(l.id); }, onkeydown: rowKeys(l.id) },
            h('td', { class: 'nm' }, h('div', { class: 'nmcell' }, h('div', { class: 't' }, l.name, l.name_ko && l.name_ko !== l.name ? h('div', { class: 's' }, l.name_ko) : null))),
            h('td', { class: 'amtcell' }, amtBtn(l, s, 'cur', fmt(l.cur))),
            slim ? null : h('td', { class: 'amtcell', 'data-prior': '1' }, amtBtn(l, s, 'prev', fmt(l.prev), 'prior')),
            slim ? null : h('td', null, chg(l.delta, goodUp)),
            h('td', null, pctEl(l.cur, l.prev, goodUp)),
            wide ? h('td', null, l.budget ? fmt(l.budget) : '') : null,
            wide ? h('td', null, l.used !== null ? h('span', { class: 'chg ' + (l.used > 100 ? 'bad' : l.used >= 85 ? '' : 'good') }, l.used + '%') : '') : null));
        });
        tb.append(h('tr', { class: 'sub', 'data-sec': s.key, style: 'cursor:pointer', onclick: () => D() && drill.show(D(), { key: 'sec:' + s.key + curMs.join(','), title: s.label, sub: rangeLabel(curMs), months: curMs, ids: s.lines.map((l) => l.id), mode: s.kind === 'inc' ? 'inc' : 'exp', search: '', addDefaults: {} }) },
          h('td', { class: 'nm' }, 'Total ' + s.label), h('td', null, fmt(s.cur)), slim ? null : h('td', null, fmt(s.prev)), slim ? null : h('td', null, chg(L.round(s.cur - s.prev, 2), !isExp)), h('td', null, pctEl(s.cur, s.prev, !isExp)),
          wide ? h('td', null, s.budget ? fmt(s.budget) : '') : null, wide ? h('td', null, s.budget ? Math.round(s.cur / s.budget * 100) + '%' : '') : null));
      });
      tb.append(h('tr', { class: 'net', id: 'rep-net' }, h('td', { class: 'nm' }, 'Net income (순수입)'), h('td', null, (cmp.net.cur < 0 ? '−' : '') + fmt(Math.abs(cmp.net.cur))), slim ? null : h('td', null, (cmp.net.prev < 0 ? '−' : '') + fmt(Math.abs(cmp.net.prev))), slim ? null : h('td', null, chg(L.round(cmp.net.cur - cmp.net.prev, 2), true)), h('td', null, pctEl(cmp.net.cur, cmp.net.prev, true)), wide ? h('td') : null, wide ? h('td') : null));
      body.append(h('div', { class: 'tbl' }, h('div', { class: 'tbl-scroll' }, h('table', { class: 'rpt pickable', id: 'rpt-is' }, h('thead', null, tr), tb))));
    }
    markRows();
  }

  // ───── 손익: 카테고리 순서 바꾸기 ─────
  // 수입 / 고정비 / semi-고정비 / 유흥비 / 금융비 / 확인 필요 그룹 안에서 순서를 바꾸고, 같은 종류(지출끼리)면 다른 그룹으로도 옮길 수 있습니다.
  // 저장하면 Accounts 시트의 sort_order (그룹을 옮겼으면 report_group 도) 를 바꿉니다.
  function catAccounts() {
    return api.accounts.filter((a) => (a.type === 'INCOME' || a.type === 'EXPENSE') && L.isActive(a));
  }
  function groupKeyOf(a) {
    if (a.type === 'INCOME') return '수입';
    const g = a.report_group || '확인 필요';
    return g === '수입' ? '확인 필요' : g;
  }
  function typeOfGroup(key) { return key === '수입' ? 'INCOME' : 'EXPENSE'; }
  function reoKeys() {
    const extra = Array.from(reo.lists.keys()).filter((k) => k !== '수입' && L.GROUP_ORDER.indexOf(k) < 0);
    return ['수입'].concat(L.GROUP_ORDER, extra);
  }
  // 지금 계정 목록과 맞춥니다 (새로 추가된 카테고리는 그 그룹 끝에, 없어진 것은 뺌)
  function syncReo() {
    const accs = catAccounts().slice().sort((a, b) => L.num(a.sort_order) - L.num(b.sort_order));
    const have = new Set(accs.map((a) => String(a.account_id)));
    if (!reo.lists) reo.lists = new Map();
    reo.lists.forEach((ids, k) => reo.lists.set(k, ids.filter((id) => have.has(id))));
    const placed = new Set(); reo.lists.forEach((ids) => ids.forEach((id) => placed.add(id)));
    ['수입'].concat(L.GROUP_ORDER).forEach((k) => { if (!reo.lists.has(k)) reo.lists.set(k, []); });
    accs.forEach((a) => {
      const id = String(a.account_id);
      if (placed.has(id)) return;
      const k = groupKeyOf(a);
      if (!reo.lists.has(k)) reo.lists.set(k, []);
      reo.lists.get(k).push(id);
    });
  }
  function startReorder() {
    reo = { lists: null };
    syncReo();
    drill.close();
    api.rerender();
  }
  function cancelReorder() { reo = null; api.rerender(); }
  function changedRows() {
    const seq = [];
    reoKeys().forEach((k) => (reo.lists.get(k) || []).forEach((id) => seq.push({ id, key: k })));
    const accOf = (id) => L.rawAccount(api.accMap.get(String(id)));
    let vals = seq.map((e) => L.num(accOf(e.id).sort_order)).sort((a, b) => a - b);
    if (vals.some((v, i) => i > 0 && v <= vals[i - 1])) {   // 같은 번호가 있으면 새로 매김
      const base = vals.length ? Math.max(0, vals[0]) : 0;
      vals = seq.map((e, i) => base + i);
    }
    const now = L.nowIso();
    const rows = [];
    seq.forEach((e, i) => {
      const a = accOf(e.id);
      const moved = groupKeyOf(a) !== e.key;
      const group = moved ? e.key : (a.report_group || '');
      if (L.num(a.sort_order) !== vals[i] || moved) rows.push(Object.assign({}, a, { sort_order: vals[i], report_group: group, updated_at: now }));
    });
    return rows;
  }
  async function saveReorder(btn) {
    const rows = changedRows();
    if (!rows.length) { reo = null; api.toast('No changes (바뀐 것이 없습니다)'); api.rerender(); return; }
    const saveBatch = api.saveBatch || (api.pageApi && api.pageApi().saveBatch);
    if (!saveBatch) { api.toast('Cannot save here (여기서는 저장할 수 없습니다)'); return; }
    const keep = reo;
    if (btn) btn.disabled = true;
    try {
      reo = null;
      await saveBatch({ Accounts: rows }, ['Accounts']);
      api.toast('Order saved (순서 저장됨)');
    } catch (e) {
      reo = keep; if (btn) btn.disabled = false;
      api.toast('Save failed (저장 실패): ' + (e && e.message ? e.message : e));
    }
  }

  function drawReorder() {
    syncReo();
    const openCat = api.openCategoryForm || (api.pageApi && api.pageApi().openCategoryForm);
    const keys = reoKeys();
    const posOf = (id) => { for (const k of keys) { const i = (reo.lists.get(k) || []).indexOf(id); if (i >= 0) return { k, i }; } return null; };
    const sameTypeKeys = (k) => keys.filter((x) => typeOfGroup(x) === typeOfGroup(k));
    const wrap = h('div', { class: 'ro-wrap', id: 'ro-wrap' });
    const status = h('span', { class: 'ro-count', id: 'ro-count', 'aria-live': 'polite' });
    const saveBtn = h('button', { type: 'button', class: 'btn', id: 'ro-save', onclick: (e) => saveReorder(e.currentTarget) }, icon('check', 18), 'Save (저장)');
    body.append(h('div', { class: 'ro-intro', id: 'ro-head' },
      h('div', { class: 'ro-title' }, h('span', { class: 'grip big', 'aria-hidden': 'true' }), h('div', null,
        h('b', null, 'Reorder categories (카테고리 순서 바꾸기)'),
        h('div', { class: 'ro-help' }, 'Drag the handle, or use ▲ ▼. Spending categories can move to another group. (손잡이를 끌거나 ▲ ▼ 를 누르세요. 지출 카테고리는 다른 그룹으로도 옮길 수 있습니다.)')))));
    body.append(h('div', { class: 'ro-bar', id: 'ro-bar' }, status, h('div', { class: 'ro-actions' }, h('button', { type: 'button', class: 'btn secondary', id: 'ro-cancel', onclick: cancelReorder }, 'Cancel (취소)'), saveBtn)));
    body.append(wrap);

    const move = (id, dir) => {
      const p = posOf(id); if (!p) return;
      const list = reo.lists.get(p.k);
      const j = p.i + dir;
      if (j >= 0 && j < list.length) { list.splice(p.i, 1); list.splice(j, 0, id); }
      else {
        // 그룹 끝에서 더 가면 옆 그룹(같은 종류)으로
        const tk = sameTypeKeys(p.k); const gi = tk.indexOf(p.k) + dir;
        if (id === UNCATEGORIZED_ID || gi < 0 || gi >= tk.length) return;
        list.splice(p.i, 1);
        const to = reo.lists.get(tk[gi]);
        if (dir < 0) to.push(id); else to.unshift(id);
      }
      paint(id, dir < 0 ? 'up' : 'down');
    };

    function paint(focusId, focusDir) {
      const rows = changedRows();
      status.textContent = rows.length ? rows.length + ' changed (바뀜)' : 'No changes yet (아직 그대로)';
      saveBtn.classList.toggle('pulse', rows.length > 0);
      status.classList.toggle('has', rows.length > 0);
      wrap.replaceChildren();
      keys.forEach((k) => {
        const ids = reo.lists.get(k) || [];
        const extraGroup = k !== '수입' && L.GROUP_ORDER.indexOf(k) < 0;
        if (extraGroup && !ids.length) return;
        const cls = L.GROUP_CLASS[k] || '';
        const tk = sameTypeKeys(k); const gi = tk.indexOf(k);
        const list = h('div', { class: 'ro-list ' + cls, 'data-group': k, 'data-type': typeOfGroup(k) });
        ids.forEach((id, i) => {
          const a = api.accMap.get(id);
          const firstAll = i === 0 && (gi === 0 || id === UNCATEGORIZED_ID);
          const lastAll = i === ids.length - 1 && (gi === tk.length - 1 || id === UNCATEGORIZED_ID);
          list.append(h('div', { class: 'ro-item ' + cls, 'data-id': id, 'data-type': a.type },
            h('span', { class: 'ro-grip', role: 'img', 'aria-label': 'Drag to reorder (끌어서 순서 바꾸기)', title: 'Drag to reorder (끌어서 순서 바꾸기)' }, h('span', { class: 'grip' })),
            h('div', { class: 'ro-name' }, h('b', null, a.name), a.name_ko && a.name_ko !== a.name ? h('span', { class: 's' }, a.name_ko) : null),
            h('button', { type: 'button', class: 'ro-mv', 'data-up': id, disabled: firstAll, 'aria-label': 'Move up (위로)', onclick: () => move(id, -1) }, '▲'),
            h('button', { type: 'button', class: 'ro-mv', 'data-down': id, disabled: lastAll, 'aria-label': 'Move down (아래로)', onclick: () => move(id, 1) }, '▼')));
        });
        if (!ids.length) list.append(h('div', { class: 'ro-empty', 'data-ro-tail': '1' }, 'Drop here (여기에 놓기)'));
        if (openCat) list.append(h('button', { type: 'button', class: 'ro-add', 'data-ro-tail': '1', 'data-add': k, onclick: () => openCat({ type: typeOfGroup(k), report_group: k }) }, icon('plus', 18), 'Add category (카테고리 추가)'));
        wrap.append(h('section', { class: 'ro-sec ' + cls, 'data-group': k },
          h('h3', { class: 'ro-sec-h' }, h('span', null, L.GROUP_LABELS[k] || k), h('span', { class: 'ro-n' }, String(ids.length))), list));
      });
      if (focusId) {
        const el = wrap.querySelector('.ro-item[data-id="' + focusId + '"]');
        if (el) {
          el.classList.add('dropped'); setTimeout(() => el.classList.remove('dropped'), 400);
          if (focusDir === 'none') return;
          const b = el.querySelector(focusDir === 'up' ? '[data-up]' : '[data-down]');
          const target = b && !b.disabled ? b : el.querySelector('.ro-mv:not([disabled])');
          if (target && target.focus) target.focus({ preventScroll: false });
        }
      }
    }
    paint();
    makeSortable(wrap, {
      list: '.ro-list', item: '.ro-item', handle: '.ro-grip',
      canDrop: (el, list) => el.getAttribute('data-type') === list.getAttribute('data-type') && (el.getAttribute('data-id') !== UNCATEGORIZED_ID || list.getAttribute('data-group') === '확인 필요'),
      onDrop: (el) => {
        wrap.querySelectorAll('.ro-list').forEach((l) => reo.lists.set(l.getAttribute('data-group'), Array.from(l.querySelectorAll('.ro-item')).map((x) => x.getAttribute('data-id'))));
        paint(el.getAttribute('data-id'), 'none');
      }
    });
  }

  // ───── 재무상태 ─────
  function drawBS() {
    const pm = new Map(); bsPrev.assets.concat(bsPrev.liabilities).forEach((l) => pm.set(l.id, l.amount));
    const card = (title, ko, lines, total, ptotal, isLiab) => {
      const box = h('div', { class: 'tbl' }, h('div', { class: 'bscard-h' }, h('h3', null, title + ' ', h('span', { class: 'muted', style: 'font-weight:500;font-size:.8em' }, ko)), h('b', null, fmt(total))));
      if (!lines.length) box.append(h('div', { class: 'dp-empty' }, '—'));
      lines.forEach((l) => {
        const prevAmt = pm.get(l.id) || 0;
        const delta = L.round(l.amount - prevAmt, 2);
        box.append(h('button', { type: 'button', class: 'bsrow', 'data-acct': l.id, onclick: () => D() && drill.show(D(), { key: 'acct:' + l.id + ':' + month, title: l.name, sub: L.monthLabel(month) + ' activity (이번 달 거래)', months: [month], ids: [l.id], mode: 'acct', acctType: isLiab ? 'LIABILITY' : 'ASSET', search: l.name, totalLabel: 'Net change this month (이번 달 순증감)', addDefaults: isLiab ? { fromId: l.id } : { fromId: l.id } }) },
          h('span', { class: 'ic-wrap', style: 'color:var(--green-ink)' }, icon(isLiab ? 'accounts' : 'balance', 22)),
          h('span', { class: 't' }, l.name, l.owner ? h('div', { class: 's' }, l.owner) : null),
          h('span', { class: 'v' }, fmt(l.amount)),
          h('span', { class: 'c' }, chg(delta, !isLiab))));
      });
      box.append(h('div', { class: 'bstot' }, h('span', null, 'Total ' + title), h('span', null, fmt(total))));
      return box;
    };
    const two = h('div', { class: 'bsgrid two' },
      card('Assets', '자산', bs.assets, bs.totalAssets, bsPrev.totalAssets, false),
      card('Credit & loans', '카드 · 대출', bs.liabilities, bs.totalLiab, bsPrev.totalLiab, true));
    body.append(two);
    const dn = L.round(bs.net - bsPrev.net, 2);
    body.append(h('div', { class: 'card', id: 'rep-networth' },
      h('div', { class: 'rc-line strong' }, h('span', null, 'Net worth (순자산)'), h('span', null, (bs.net < 0 ? '−' : '') + fmt(Math.abs(bs.net)))),
      h('div', { class: 'rc-line' }, h('span', null, 'Last month (전월)'), h('span', null, (bsPrev.net < 0 ? '−' : '') + fmt(Math.abs(bsPrev.net)))),
      h('div', { class: 'rc-line' }, h('span', null, 'Change (증감)'), chg(dn, true))));
    body.append(h('details', { class: 'card', id: 'rep-equity' },
      h('summary', null, 'Equity (자본) · ' + fmt(bs.equityTotal)),
      bs.equityLines.map((l) => h('div', { class: 'row-sub' }, l.name + ': ' + fmt(l.amount))),
      h('div', { class: 'row-sub' }, 'Cumulative net income (누적 순수입): ' + fmt(bs.retained))));
    if (Math.abs(bs.diff) > 0.01) {
      body.append(h('div', { class: 'card warn-card', id: 'rep-diff', role: 'alert' },
        'Books out of balance by ' + fmt(bs.diff) + ' (장부가 맞지 않습니다: 자산 − 부채 ≠ 자본). Check opening balances and recent edits (기초잔액과 최근 수정 내역을 확인하세요).'));
    }
  }

  // ───── 사람별 ─────
  function drawWHO() {
    const plab = scope === 'Y' ? 'Same period last year (작년 같은 기간)' : 'Last month (지난달)';
    if (!who.rows.length) {
      body.append(h('div', { class: 'card center muted', id: 'who-empty' }, 'No income or spending in this period (이 기간에 수입·지출이 없습니다).'));
      return;
    }
    const top = Math.max.apply(null, who.rows.map((r) => Math.max(r.income, r.expense)).concat([1]));
    const barPair = (r) => h('div', { class: 'who-bars', 'aria-hidden': 'true' },
      h('div', { class: 'share-bar inc' }, h('i', { style: 'width:' + Math.round(r.income / top * 100) + '%' })),
      h('div', { class: 'share-bar exp' }, h('i', { style: 'width:' + Math.round(r.expense / top * 100) + '%' })));
    const netTxt = (v) => (v < 0 ? '−' : '') + fmt(Math.abs(v));
    const go = (owner) => api.goSearch(owner);
    body.append(h('div', { class: 'note' }, 'Tap a person to see their transactions (이름을 누르면 그 사람의 거래를 봅니다). Bars: income (수입, green) and spending (지출) compared across people (사람 사이 비교).'));
    if (lay === 'phone') {
      const box = h('div', { class: 'who-list', id: 'who-list' });
      who.rows.forEach((r) => box.append(h('button', { type: 'button', class: 'who-card', 'data-owner': r.owner, onclick: () => go(r.owner) },
        h('div', { class: 'wc-top' }, h('b', { class: 'wc-name' }, r.owner), h('span', { class: 'wc-net ' + (r.net < 0 ? 'out' : 'in') }, netTxt(r.net), h('span', { class: 'wc-netlab' }, ' net (순수입)'))),
        h('div', { class: 'wc-line' }, h('span', null, 'Income (수입)'), h('b', null, fmt(r.income))),
        h('div', { class: 'wc-line' }, h('span', null, 'Spending (지출)'), h('b', null, fmt(r.expense)), chg(r.delta, false)),
        barPair(r),
        h('div', { class: 'wc-sub' }, plab + ' ' + fmt(r.prevExpense) + ' · ' + r.share + '% of spending (지출 비중)'))));
      body.append(box);
      body.append(h('div', { class: 'card', id: 'who-total' },
        h('div', { class: 'rc-line strong' }, h('span', null, 'Total net income (전체 순수입)'), h('span', null, netTxt(who.net))),
        h('div', { class: 'rc-line' }, h('span', null, 'Income (수입)'), h('span', null, fmt(who.income))),
        h('div', { class: 'rc-line' }, h('span', null, 'Spending (지출)'), h('span', null, fmt(who.expense)))));
    } else {
      const th = (en, ko) => h('th', null, en, h('span', { class: 'ko' }, ko));
      const tb = h('tbody');
      who.rows.forEach((r) => tb.append(h('tr', { class: 'line', 'data-owner': r.owner, tabindex: '0', onclick: () => go(r.owner), onkeydown: (e) => { if (e.key === 'Enter') go(r.owner); } },
        h('td', { class: 'nm' }, h('b', null, r.owner)),
        h('td', null, fmt(r.income)), h('td', null, fmt(r.expense)),
        h('td', { class: r.net < 0 ? 'out' : 'in' }, netTxt(r.net)),
        h('td', null, chg(r.delta, false)),
        h('td', null, r.share + '%'),
        h('td', { class: 'barcell' }, barPair(r)))));
      tb.append(h('tr', { class: 'net', id: 'who-total' }, h('td', { class: 'nm' }, 'Total (전체)'), h('td', null, fmt(who.income)), h('td', null, fmt(who.expense)), h('td', null, netTxt(who.net)), h('td', null, chg(who.delta, false)), h('td', null, '100%'), h('td')));
      body.append(h('div', { class: 'tbl' }, h('div', { class: 'tbl-scroll' }, h('table', { class: 'rpt plain', id: 'rpt-who' },
        h('thead', null, h('tr', null, th('Person', '사람'), th('Income', '수입'), th('Spending', '지출'), th('Net', '순수입'), th('vs ' + (scope === 'Y' ? 'last year' : 'last month'), scope === 'Y' ? '작년 대비' : '전월 대비'), th('Share', '지출 비중'), th('Compare', '비교'))), tb))));
    }
  }

  // ───── 업체별 ─────
  function drawVENDOR() {
    if (!vend.rows.length) {
      body.append(h('div', { class: 'card center muted', id: 'vendor-empty' }, 'No spending in this period (이 기간에 지출이 없습니다).'));
      return;
    }
    const maxShare = Math.max.apply(null, vend.rows.map((v) => v.share).concat([1]));
    const go = (v) => api.goSearch(v.key || v.name);
    body.append(h('div', { class: 'note' }, 'Top ' + vend.rows.length + ' of ' + vend.count + ' vendors by spending (지출이 많은 업체 상위). Same shop with different spelling is combined (철자가 달라도 같은 가게는 합칩니다). Tap one to see its transactions (눌러서 거래 보기).'));
    if (lay === 'phone') {
      const box = h('div', { class: 'ledger', id: 'vendor-list' });
      vend.rows.forEach((v, i) => box.append(h('button', { type: 'button', class: 'vd-card', 'data-vendor': v.key, onclick: () => go(v) },
        h('span', { class: 'vd-rank' }, String(i + 1)),
        h('span', { class: 'vd-main' }, h('b', { class: 'vd-name' }, v.name), h('span', { class: 'vd-sub' }, [v.cat, v.count + '× (건)', 'avg (평균) ' + fmt(v.avg)].filter(Boolean).join(' · '))),
        h('span', { class: 'vd-tot' }, h('b', null, fmt(v.total)), h('span', { class: 'vd-pct' }, v.share + '%')),
        h('span', { class: 'share-bar' }, h('i', { style: 'width:' + Math.max(2, Math.round(v.share / maxShare * 100)) + '%' })))));
      body.append(box);
    } else {
      const th = (en, ko) => h('th', null, en, h('span', { class: 'ko' }, ko));
      const tb = h('tbody');
      vend.rows.forEach((v, i) => tb.append(h('tr', { class: 'line', 'data-vendor': v.key, tabindex: '0', onclick: () => go(v), onkeydown: (e) => { if (e.key === 'Enter') go(v); } },
        h('td', { class: 'nm' }, h('div', { class: 'nmcell' }, h('span', { class: 'vd-rank' }, String(i + 1)), h('div', { class: 't' }, v.name, v.cat ? h('div', { class: 's' }, v.cat) : null))),
        h('td', null, fmt(v.total)), h('td', null, String(v.count)), h('td', null, fmt(v.avg)), h('td', null, v.share + '%'),
        h('td', { class: 'barcell' }, h('div', { class: 'share-bar' }, h('i', { style: 'width:' + Math.max(2, Math.round(v.share / maxShare * 100)) + '%' }))))));
      const shown = L.round(vend.rows.reduce((x, v) => x + v.total, 0), 2);
      tb.append(h('tr', { class: 'net', id: 'vendor-total' }, h('td', { class: 'nm' }, 'Top ' + vend.rows.length + ' total (상위 합계)'), h('td', null, fmt(shown)), h('td', null, String(vend.rows.reduce((x, v) => x + v.count, 0))), h('td'), h('td', null, vend.total > 0 ? L.round(shown / vend.total * 100, 1) + '%' : ''), h('td')));
      body.append(h('div', { class: 'tbl' }, h('div', { class: 'tbl-scroll' }, h('table', { class: 'rpt plain', id: 'rpt-vendor' },
        h('thead', null, h('tr', null, th('Vendor', '업체'), th('Total', '합계'), th('Count', '건수'), th('Average', '평균'), th('Share', '비중'), th('', ''))), tb))));
    }
  }

  // ───── 예산 ─────
  function drawBG() {
    const c = bg;
    const prevCopy = B.copyFromPrevious(api.data.budgets || [], month);
    const avg = B.suggestFromAverage(api.items, api.accMap, api.data.budgets || [], month, 3);
    body.append(h('div', { class: 'bg-actions' },
      h('button', { type: 'button', class: 'btn secondary', id: 'bg-copy', disabled: !prevCopy.size, onclick: () => confirmFill(prevCopy, 'Copy last month (전월 예산 복사)') }, icon('sheet', 18), 'Copy last month (전월 복사)'),
      h('button', { type: 'button', class: 'btn secondary', id: 'bg-avg', disabled: !avg.size, onclick: () => confirmFill(avg, 'Fill from 3-month average (최근 3개월 평균으로 채우기)') }, icon('spark', 18), 'Fill from average (평균으로 채우기)')));
    if (!c.groups.length) {
      body.append(h('div', { class: 'card center muted', id: 'bg-empty' }, 'No budget or spending this month (이번 달 예산·지출이 없습니다). Use the buttons above (위 버튼으로 시작하세요).'));
      return;
    }
    if (c.hasBudget) {
      body.append(bar(c.pct === null ? 0 : c.pct, c.status, c.paceFraction, 'bg-total'));
      const pace = c.paceFraction !== null ? ' · Day ' + Number(today.slice(8, 10)) + ' (오늘까지 ' + Math.round(c.paceFraction * 100) + '% 경과)' : '';
      body.append(h('div', { class: 'note' }, c.pct + '% used (사용) ' + pace));
    }
    if (c.unbudgeted > 0) body.append(h('div', { class: 'note' }, 'No budget yet for ' + fmt(c.unbudgeted) + ' of spending (예산이 없는 지출). Tap a row to set one (눌러서 설정).'));
    const cols = h('div', { class: 'bg-cols' });
    c.groups.forEach((g) => {
      const gc = L.GROUP_CLASS[g.key] || '';
      const sec = h('div', null, h('h2', { class: 'sect grp ' + gc }, g.label + ' · ' + fmt(g.actual) + ' / ' + fmt(g.budget)));
      const led = h('div', { class: 'bg-list' });
      g.lines.slice().sort((a, b) => sortOf(api.accMap, a.id) - sortOf(api.accMap, b.id)).forEach((l) => led.append(h('div', { class: 'bg-item' },
        h('button', { type: 'button', class: 'row bg-row ' + gc, 'data-acct': l.id, onclick: () => openEditor(l) },
          h('div', { class: 'row-main' },
            h('div', { class: 'row-title' }, l.name),
            h('div', { class: 'row-sub' }, l.budget ? fmt(l.actual) + ' of ' + fmt(l.budget) + ' (' + l.pct + '%)' : fmt(l.actual) + ' — no budget (예산 없음)'),
            l.budget ? bar(Math.min(l.pct, 100), l.status, c.paceFraction, '') : null),
          h('div', { class: 'row-right' },
            l.budget ? h('div', { class: 'row-amt ' + (l.left >= 0 ? 'in' : 'out') }, (l.left >= 0 ? '' : '−') + fmt(Math.abs(l.left))) : h('div', { class: 'row-amt move' }, '+ Set (설정)'),
            l.budget ? h('div', { class: 'row-fx' }, l.left >= 0 ? 'left (남음)' : 'over (초과)') : null)),
        h('button', { type: 'button', class: 'rowbtn', 'aria-label': 'Transactions (거래 보기)', title: 'Transactions (거래 보기)', 'data-go': l.id,
          onclick: () => D() && drill.show(D(), { key: 'bg:' + l.id + ':' + month, title: l.name, sub: L.monthLabel(month), months: [month], ids: [l.id], mode: 'exp', search: l.name, addDefaults: { kind: 'EXPENSE', categoryId: l.id } }) }, icon('list', 22)))));
      sec.append(led);
      cols.append(sec);
    });
    body.append(cols);
  }

  function bar(pct, status, pace, id) {
    const fill = h('i', { class: 'bar-fill ' + status, style: 'width:' + Math.max(0, Math.min(100, pct)) + '%' });
    const wrap = h('div', { class: 'bar', id: id || null, role: 'img', 'aria-label': pct + '% used' }, fill);
    if (pace !== null && pace !== undefined) wrap.append(h('b', { class: 'bar-pace', style: 'left:' + Math.round(pace * 100) + '%' }));
    return wrap;
  }

  async function save(rows, msg) {
    if (!rows.length) return;
    await api.saveBudgets(rows);
    api.toast(msg || 'Saved (저장됨)');
  }

  function scopeSelect(id) {
    return h('select', { id, 'aria-label': 'Apply to (적용 범위)' },
      h('option', { value: 'month' }, 'This month only (이번 달만)'),
      h('option', { value: 'year' }, 'Rest of this year (올해 남은 달 전부)'),
      h('option', { value: 'next12' }, 'Next 12 months (지금부터 12개월)'));
  }

  function openEditor(line) {
    const ov = document.getElementById('overlay');
    ov.hidden = false; document.body.classList.add('noscroll');
    const close = () => { ov.hidden = true; ov.replaceChildren(); document.body.classList.remove('noscroll'); };
    const err = h('div', { class: 'err', id: 'bg-err', role: 'alert' });
    const amt = h('input', { type: 'text', id: 'bg-amount', inputmode: 'decimal', autocomplete: 'off', value: line.budget ? String(line.budget) : '', placeholder: 'e.g. 600' });
    const scopeEl = scopeSelect('bg-scope');
    const doSave = async (amount) => {
      const rows = B.setBudget(api.data.budgets || [], line.id, state.month, amount, scopeEl.value, L.nowIso());
      if (!rows.length) { close(); return; }
      close(); await save(rows, amount > 0 ? 'Budget saved (예산 저장됨)' : 'Budget removed (예산 삭제됨)');
    };
    ov.replaceChildren(h('div', { class: 'backdrop' }, h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Budget' },
      h('div', { class: 'sheet-head' }, h('h2', null, line.name), h('button', { type: 'button', class: 'icon', 'aria-label': 'Close (닫기)', onclick: close }, icon('close', 22))),
      h('div', { class: 'hint' }, L.monthLabel(state.month) + ' · spent so far (지금까지 지출) ' + fmt(line.actual)),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Monthly budget (월 예산, CAD)'), amt),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Apply to (적용 범위)'), scopeEl),
      err,
      h('div', { class: 'btnrow' },
        h('button', { type: 'button', class: 'btn', id: 'bg-save', onclick: () => {
          const n = L.parseAmount(amt.value);
          if (!Number.isFinite(n) || n <= 0) { err.textContent = '0보다 큰 금액을 입력하세요. (삭제는 "Remove")'; return; }
          doSave(L.round(n, 2));
        } }, 'Save (저장)'),
        h('button', { type: 'button', class: 'btn secondary', onclick: close }, 'Cancel (취소)'),
        line.budget ? h('button', { type: 'button', class: 'btn danger', id: 'bg-remove', onclick: () => doSave(0) }, 'Remove (삭제)') : null))));
    amt.focus();
  }

  function confirmFill(entries, title) {
    const ov = document.getElementById('overlay');
    ov.hidden = false; document.body.classList.add('noscroll');
    const close = () => { ov.hidden = true; ov.replaceChildren(); document.body.classList.remove('noscroll'); };
    const scopeEl = scopeSelect('bg-fill-scope');
    const names = Array.from(entries, ([id, v]) => { const a = api.accMap.get(String(id)); return (a ? a.name : id) + ' ' + fmt(v); });
    ov.replaceChildren(h('div', { class: 'backdrop' }, h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Fill budget' },
      h('div', { class: 'sheet-head' }, h('h2', null, title), h('button', { type: 'button', class: 'icon', 'aria-label': 'Close (닫기)', onclick: close }, icon('close', 22))),
      h('div', { class: 'hint', id: 'bg-fill-list' }, entries.size + ' categories (카테고리 ' + entries.size + '개): ' + names.slice(0, 12).join(', ') + (names.length > 12 ? ' …' : '')),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Apply to (적용 범위)'), scopeEl),
      h('div', { class: 'btnrow' },
        h('button', { type: 'button', class: 'btn', id: 'bg-fill-go', onclick: async () => {
          const rows = B.applyMap(api.data.budgets || [], entries, state.month, scopeEl.value, L.nowIso());
          close(); await save(rows, 'Budgets saved (예산 저장됨)');
        } }, 'Apply (적용)'),
        h('button', { type: 'button', class: 'btn secondary', onclick: close }, 'Cancel (취소)')))));
  }
}
