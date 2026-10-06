// 예산 vs 실적. 계산(순수 로직)만 담았고, 화면은 reports.js 에 있습니다.
import * as L from './ledger.js';
import { incomeStatement } from './reports.js';

export const BUDGET_TYPE = 'MONTHLY';
export const BUDGET_VINTAGE = 'CURRENT';
const UNCATEGORIZED_ID = '9999';
export const NEAR = 0.85;   // 예산의 85% 를 넘으면 "거의 다 씀"

export const budgetId = (accountId, ym) => 'bud_' + ym.replace('-', '') + '_' + accountId;

// 그 달의 예산: Map(계정 id → 금액)
export function budgetMap(budgets, ym) {
  const [y, m] = ym.split('-').map(Number);
  const map = new Map();
  (budgets || []).forEach((b) => {
    if (L.truthy(b.deleted) || L.num(b.year) !== y || L.num(b.month) !== m) return;
    const amt = L.num(b.amount_cad);
    if (amt > 0) map.set(String(b.account_id), L.round((map.get(String(b.account_id)) || 0) + amt, 2));
  });
  return map;
}

const daysIn = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

function statusOf(budget, actual) {
  if (!(budget > 0)) return actual > 0 ? 'none' : 'ok';
  const p = actual / budget;
  return p > 1 ? 'over' : p >= NEAR ? 'near' : 'ok';
}

// items = [{txn, ps}], today = 'YYYY-MM-DD' (이번 달이면 "지금까지 쓸 만큼" 기준선도 계산)
export function compare(items, accMap, budgets, ym, today) {
  const is = incomeStatement(items, accMap, ym);
  const bmap = budgetMap(budgets, ym);
  const actual = new Map();
  is.expenseGroups.forEach((g) => g.lines.forEach((l) => actual.set(l.id, l.amount)));
  const ids = new Set(Array.from(bmap.keys()).concat(Array.from(actual.keys())));
  const groups = new Map();
  ids.forEach((id) => {
    const a = accMap.get(String(id));
    if (!a || a.type !== 'EXPENSE') return;
    const budget = bmap.get(id) || 0, act = actual.get(id) || 0;
    if (!budget && !act) return;
    const key = a.report_group || '확인 필요';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      id, name: a.name, name_ko: a.name_ko || '', budget, actual: act, left: L.round(budget - act, 2),
      pct: budget > 0 ? L.round(act / budget * 100, 0) : null, status: statusOf(budget, act), uncategorized: id === UNCATEGORIZED_ID
    });
  });
  const order = L.GROUP_ORDER.filter((g) => groups.has(g)).concat(Array.from(groups.keys()).filter((g) => L.GROUP_ORDER.indexOf(g) < 0));
  const out = order.map((key) => {
    const lines = groups.get(key).sort((x, y) => (y.budget || y.actual) - (x.budget || x.actual));
    const budget = L.round(lines.reduce((s, l) => s + l.budget, 0), 2);
    const act = L.round(lines.reduce((s, l) => s + l.actual, 0), 2);
    return { key, label: L.GROUP_LABELS[key] || key, budget, actual: act, left: L.round(budget - act, 2), lines };
  });
  const totalBudget = L.round(out.reduce((s, g) => s + g.budget, 0), 2);
  const totalActual = L.round(out.reduce((s, g) => s + g.actual, 0), 2);
  const unbudgeted = L.round(out.reduce((s, g) => s + g.lines.filter((l) => !l.budget).reduce((t, l) => t + l.actual, 0), 0), 2);
  let paceFraction = null;
  if (today && L.monthOf(today) === ym) paceFraction = L.round(Number(today.slice(8, 10)) / daysIn(ym), 3);
  return {
    ym, groups: out, totalBudget, totalActual, left: L.round(totalBudget - totalActual, 2),
    pct: totalBudget > 0 ? L.round(totalActual / totalBudget * 100, 0) : null, status: statusOf(totalBudget, totalActual),
    unbudgeted, paceFraction, hasBudget: totalBudget > 0
  };
}

export function monthsFor(ym, scope) {
  const [y, m] = ym.split('-').map(Number);
  const list = [];
  const count = scope === 'month' ? 1 : scope === 'year' ? 12 - m + 1 : 12;
  for (let i = 0; i < count; i++) list.push(L.shiftMonth(ym, i));
  return list;
}

// 한 카테고리의 예산 입력 → 시트에 쓸 행들 (같은 달·카테고리는 항상 같은 id 라서 다시 저장해도 중복되지 않음)
// scope: 'month' 이번 달만 / 'year' 올해 남은 달 전부 / 'next12' 지금부터 12개월
export function setBudget(budgets, accountId, ym, amount, scope, now) {
  const byId = new Map((budgets || []).map((b) => [String(b.budget_id), b]));
  const rows = [];
  monthsFor(ym, scope || 'month').forEach((mm) => {
    const id = budgetId(accountId, mm);
    const old = byId.get(id);
    if (!(amount > 0)) { if (old && !L.truthy(old.deleted)) rows.push(Object.assign({}, old, { deleted: true, updated_at: now })); return; }
    const [y, m] = mm.split('-').map(Number);
    rows.push(Object.assign({ rationale: '', locked: '' }, old || {}, {
      budget_id: id, type: BUDGET_TYPE, vintage: BUDGET_VINTAGE, year: y, month: m, account_id: String(accountId),
      amount_cad: L.round(amount, 2), updated_at: now, deleted: false
    }));
  });
  return rows;
}

// 최근 N개월 평균 지출로 제안 (예산이 아직 없는 카테고리만, 5달러 단위로 반올림)
export function suggestFromAverage(items, accMap, budgets, ym, months) {
  const n = months || 3;
  const have = budgetMap(budgets, ym);
  const sums = new Map();
  for (let i = 1; i <= n; i++) {
    const is = incomeStatement(items, accMap, L.shiftMonth(ym, -i));
    is.expenseGroups.forEach((g) => g.lines.forEach((l) => sums.set(l.id, (sums.get(l.id) || 0) + l.amount)));
  }
  const out = new Map();
  sums.forEach((total, id) => {
    if (id === UNCATEGORIZED_ID || have.has(id)) return;
    const avg = total / n;
    if (avg < 2.5) return;
    out.set(id, Math.max(5, Math.round(avg / 5) * 5));
  });
  return out;
}

// 전월 예산 중 이번 달에 아직 없는 것
export function copyFromPrevious(budgets, ym) {
  const have = budgetMap(budgets, ym);
  const prev = budgetMap(budgets, L.shiftMonth(ym, -1));
  const out = new Map();
  prev.forEach((amt, id) => { if (!have.has(id)) out.set(id, amt); });
  return out;
}

// Map(계정 id → 금액) 을 한꺼번에 행으로
export function applyMap(budgets, entries, ym, scope, now) {
  let rows = [];
  let cur = (budgets || []).slice();
  entries.forEach((amt, id) => {
    const r = setBudget(cur, id, ym, amt, scope, now);
    rows = rows.concat(r);
    const ids = new Set(r.map((x) => x.budget_id));
    cur = cur.filter((b) => !ids.has(String(b.budget_id))).concat(r);
  });
  return rows;
}
