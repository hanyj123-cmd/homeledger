// 올해 남은 달 상향식(bottom-up) 예측 — 카테고리 × 월 로 직접 입력하고, 그 합계로 "올해 얼마로 끝날지" 계산합니다.
//  - 이미 지난 달: 실제 기록 · 이번 달: 지금까지 실제 + 남은 예상(또는 내가 입력한 월 총액) · 앞으로의 달: 예산 → 평균(물가 반영) 순으로 자동값
//  - 내가 칸에 숫자를 넣으면 그 값이 자동값을 대신합니다 (저장은 Settings 의 meta.fcplan 한 줄)
//  - 내년 예산 제안은 이 "올해 예상 총액"을 기준으로 만듭니다 (suggestFromYear)
// 모두 순수 함수입니다 (화면 없음).
import * as L from './ledger.js';
import * as R from './reports.js';
import * as B from './budget.js';
import * as M from './meta.js';

export const KEY = 'meta.fcplan';
const r2 = (v) => Math.round(v * 100) / 100;
const sum = (a) => a.reduce((s, v) => s + v, 0);
const p2 = (n) => String(n).padStart(2, '0');
const monthsEnding = (endYm, n) => { const o = []; for (let i = n - 1; i >= 0; i--) o.push(L.shiftMonth(endYm, -i)); return o; };
export const cellKey = (ym, id) => ym + '|' + id;

/** 저장된 계획 읽기: { cells: { 'YYYY-MM': { 계정id: 금액 } } } */
export function readPlan(settings) {
  const v = M.readJson(settings, KEY, null);
  const cells = {};
  if (v && typeof v === 'object' && v.cells && typeof v.cells === 'object') {
    Object.keys(v.cells).forEach((ym) => {
      if (!/^\d{4}-\d{2}$/.test(ym) || !v.cells[ym] || typeof v.cells[ym] !== 'object') return;
      Object.keys(v.cells[ym]).forEach((id) => {
        const n = Number(v.cells[ym][id]);
        if (Number.isFinite(n) && n >= 0) { (cells[ym] = cells[ym] || {})[String(id)] = r2(n); }
      });
    });
  }
  return { cells };
}

/** 지금 저장된 계획 + 아직 저장 안 한 입력(edits: Map('월|id' → 글자)) 을 합친 새 계획. 빈 글자는 그 칸을 지움(자동값으로 되돌림) */
export function applyEdits(plan, edits) {
  const cells = JSON.parse(JSON.stringify((plan && plan.cells) || {}));
  (edits instanceof Map ? Array.from(edits.entries()) : []).forEach(([k, text]) => {
    const i = k.indexOf('|');
    const ym = k.slice(0, i), id = k.slice(i + 1);
    const t = String(text === undefined || text === null ? '' : text).trim();
    if (t === '') { if (cells[ym]) { delete cells[ym][id]; if (!Object.keys(cells[ym]).length) delete cells[ym]; } return; }
    const n = L.parseAmount(t);
    if (!Number.isFinite(n) || n < 0) return;
    (cells[ym] = cells[ym] || {})[id] = r2(n);
  });
  return { cells };
}

/** 이전 해 달은 정리해서 저장 (올해·작년 것만 남김) */
export function pruned(plan, today) {
  const keepFrom = String(Number((today || L.todayStr()).slice(0, 4)) - 1) + '-01';
  const cells = {};
  Object.keys((plan && plan.cells) || {}).forEach((ym) => { if (ym >= keepFrom && Object.keys(plan.cells[ym]).length) cells[ym] = plan.cells[ym]; });
  return { cells };
}
export function planRow(settings, plan, now, today) {
  return M.metaRow(settings, KEY, pruned(plan, today), 'forecast plan (예측 계획)', now);
}

const stmtOf = (items, accMap, ym) => R.incomeStatement(items, accMap, ym);
const hasData = (s) => s.income > 0 || s.expense > 0;

/**
 * 올해 전망.
 * input: { items, accMap, budgets, plan, today, growth(%), extraIds(Set|array) }
 * → { year, curYm, months[이번 달~12월], lines[], monthTotals{ym:{income,expense,net}}, yearIncome, yearExpense, yearNet,
 *     soFarIncome, soFarExpense, covered, hasData }
 */
export function yearOutlook(input) {
  const { items, accMap, budgets } = input;
  const today = input.today || L.todayStr();
  const g = (input.growth === undefined ? 3 : input.growth) / 100;
  const cells = (input.plan && input.plan.cells) || {};
  const extra = new Set(Array.from(input.extraIds || []).map(String));
  const curYm = today.slice(0, 7), year = curYm.slice(0, 4);
  const all = []; for (let m = 1; m <= 12; m++) all.push(year + '-' + p2(m));
  const past = all.filter((m) => m < curYm), future = all.filter((m) => m > curYm);
  const months = [curYm].concat(future);

  // 평균 기준: 이번 달 직전 3개월 (기록이 있는 달만)
  const hist = monthsEnding(L.shiftMonth(curYm, -1), 6).map((m) => stmtOf(items, accMap, m)).filter(hasData).slice(-3);
  const nb = hist.length;
  const expBase = new Map(), incBase = new Map();
  hist.forEach((s) => {
    s.expenseGroups.forEach((gr) => gr.lines.forEach((l) => expBase.set(l.id, (expBase.get(l.id) || 0) + l.amount / nb)));
    s.incomeLines.forEach((l) => incBase.set(l.id, (incBase.get(l.id) || 0) + l.amount / nb));
  });

  // 실제 기록
  const pastStmts = past.map((m) => stmtOf(items, accMap, m));
  const cur = stmtOf(items, accMap, curYm);
  const ytd = new Map(), curAct = new Map();
  const addTo = (map, id, v) => map.set(id, (map.get(id) || 0) + v);
  pastStmts.forEach((s) => { s.expenseGroups.forEach((gr) => gr.lines.forEach((l) => addTo(ytd, l.id, l.amount))); s.incomeLines.forEach((l) => addTo(ytd, l.id, l.amount)); });
  cur.expenseGroups.forEach((gr) => gr.lines.forEach((l) => curAct.set(l.id, l.amount)));
  cur.incomeLines.forEach((l) => curAct.set(l.id, l.amount));
  const dataIdx = all.findIndex((m) => { const s = m < curYm ? pastStmts[past.indexOf(m)] : m === curYm ? cur : null; return !!s && hasData(s); });
  const covered = dataIdx < 0 ? null : 12 - dataIdx;

  const [cy, cm] = curYm.split('-').map(Number);
  const dim = new Date(Date.UTC(cy, cm, 0)).getUTCDate();
  const day = Number(today.slice(8, 10)) || 0;
  const frac = day / dim;
  const doneMonth = day >= dim;
  const bmaps = new Map(months.map((m) => [m, B.budgetMap(budgets, m)]));

  const ids = new Set();
  [ytd, curAct, expBase, incBase].forEach((mp) => mp.forEach((v, id) => { if (Math.abs(v) > 0.004) ids.add(String(id)); }));
  bmaps.forEach((bm) => bm.forEach((v, id) => ids.add(String(id))));
  months.forEach((m) => Object.keys(cells[m] || {}).forEach((id) => ids.add(String(id))));
  extra.forEach((id) => ids.add(id));

  const lines = [];
  ids.forEach((id) => {
    const a = accMap.get(id);
    if (!a || (a.type !== 'EXPENSE' && a.type !== 'INCOME')) return;
    const isInc = a.type === 'INCOME';
    const act = r2(curAct.get(id) || 0);
    const out = { id, type: a.type, name: a.name, name_ko: a.name_ko || '', group: isInc ? '수입' : (a.report_group || '확인 필요'), sort: L.num(a.sort_order), ytd: r2(ytd.get(id) || 0), curActual: act, cells: {} };
    months.forEach((m, k) => {
      let auto;
      if (m === curYm) {
        if (isInc) auto = doneMonth ? act : Math.max(act, incBase.get(id) || 0);
        else {
          const b = bmaps.get(m).has(id) ? bmaps.get(m).get(id) : (expBase.get(id) || 0);
          const rem = out.group === '고정비' ? Math.max(0, b - act) : b * (1 - frac);
          auto = doneMonth ? act : act + rem;
        }
      } else if (isInc) auto = incBase.get(id) || 0;
      else auto = bmaps.get(m).has(id) ? bmaps.get(m).get(id) : (expBase.get(id) || 0) * (1 + g * k / 12);
      auto = r2(auto);
      const raw = cells[m] && cells[m][id] !== undefined ? Number(cells[m][id]) : null;
      const plan = raw !== null && Number.isFinite(raw) && raw >= 0 ? r2(raw) : null;
      const value = m === curYm ? r2(Math.max(act, plan !== null ? plan : auto)) : (plan !== null ? plan : auto);
      out.cells[m] = { auto, plan, value };
    });
    out.future = r2(sum(months.map((m) => out.cells[m].value)));
    out.total = r2(out.ytd + out.future);
    if (Math.abs(out.total) < 0.005 && !extra.has(id) && !months.some((m) => out.cells[m].plan !== null)) return;
    lines.push(out);
  });
  const order = ['수입'].concat(L.GROUP_ORDER);
  const rank = (g) => { const i = order.indexOf(g); return i < 0 ? order.length : i; };
  lines.sort((x, y) => (rank(x.group) - rank(y.group)) || (x.sort - y.sort) || (y.total - x.total));

  const monthTotals = {};
  months.forEach((m) => {
    const income = r2(sum(lines.filter((l) => l.type === 'INCOME').map((l) => l.cells[m].value)));
    const expense = r2(sum(lines.filter((l) => l.type === 'EXPENSE').map((l) => l.cells[m].value)));
    monthTotals[m] = { income, expense, net: r2(income - expense) };
  });
  const yearIncome = r2(sum(lines.filter((l) => l.type === 'INCOME').map((l) => l.total)));
  const yearExpense = r2(sum(lines.filter((l) => l.type === 'EXPENSE').map((l) => l.total)));
  const soFarIncome = r2(sum(pastStmts.map((s) => s.income)) + cur.income);
  const soFarExpense = r2(sum(pastStmts.map((s) => s.expense)) + cur.expense);
  return { year, curYm, months, lines, monthTotals, yearIncome, yearExpense, yearNet: r2(yearIncome - yearExpense), soFarIncome, soFarExpense, covered, hasData: dataIdx >= 0 || lines.length > 0, dim, day };
}

/** 올해 예상 총액 → 내년 월 예산 제안 (suggestNextYear 와 같은 모양: { map: Map(id → {amount, basis, rationale, trend, months, volatile}), span }) */
export function suggestFromYear(outlook, growthPct) {
  const g = (growthPct === undefined ? 3 : growthPct) / 100;
  const out = new Map();
  const n = outlook && outlook.covered;
  if (!n) return { map: out, span: 0 };
  const US = (v) => '$' + Math.round(Math.abs(v)).toLocaleString('en-US');
  outlook.lines.forEach((l) => {
    if (l.type !== 'EXPENSE' || l.id === '9999') return;
    const monthly = l.total / n;
    if (monthly < 2.5) return;
    const actual = l.ytd + l.curActual;
    const amount = Math.max(5, Math.round(monthly * (1 + g) / 5) * 5);
    const why = '올해 예상 ' + US(l.total) + ' (실제 ' + US(actual) + ' + 앞으로 예상 ' + US(l.total - actual) + ') ÷ ' + n + '개월 = 월 ' + US(monthly) + ' · 물가 ' + (g * 100).toFixed((g * 100) % 1 ? 1 : 0) + '% 반영';
    out.set(l.id, { amount, basis: r2(monthly), rationale: why, trend: 0, months: n, volatile: false, yearTotal: l.total });
  });
  return { map: out, span: n };
}
