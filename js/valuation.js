// 대출 상환표 · 자산 감가/평가 · 주식 평가 · 발생주의 청구 · 부채 상환 시뮬레이션. (순수 계산)
// 모든 월은 'YYYY-MM', 금액은 CAD 입니다.
import * as L from './ledger.js';

const r2 = (v) => Math.round(v * 100) / 100;
const numOr0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export const lastDay = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return ym + '-' + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0');
};
export const addMonths = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const t = (y * 12 + (m - 1)) + n;
  return Math.floor(t / 12) + '-' + String(t % 12 + 1).padStart(2, '0');
};
export const monthsBetween = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));

// ───────── 할부·모기지: 매달 같은 금액을 내면 0 이 되는 대출 ─────────
// cfg = { p: 원금, pmt: 월 납입액, start: 'YYYY-MM' (첫 납입 달), months: 총 납입 횟수 }, apr = 연 이율(%)

/** 그 달 말까지 낸 횟수 (시작한 달 포함) */
export function paymentsBy(start, ym) {
  if (!start) return 0;
  return Math.max(0, monthsBetween(start.slice(0, 7), ym) + 1);
}
export const loanTerm = (cfg) => Math.round(numOr0(cfg && (cfg.months !== undefined ? cfg.months : (cfg.years || 0) * 12)));

/** 원금 P 를 n 개월에 같은 금액으로 갚는 월 납입액 */
export function loanPayment(P, apr, n) {
  const i = numOr0(apr) / 100 / 12;
  n = Math.round(numOr0(n));
  if (!n || !P) return 0;
  return i === 0 ? P / n : P * i / (1 - Math.pow(1 + i, -n));
}
/** 알고 있는 월 납입액에서 거꾸로 구한 연 이율(%) — 이분법 */
export function loanRate(P, pmt, n) {
  n = Math.round(numOr0(n));
  if (!n || !pmt || !P || pmt * n <= P) return 0;
  let lo = 0, hi = 200;
  for (let t = 0; t < 90; t++) {
    const mid = (lo + hi) / 2;
    if (loanPayment(P, mid, n) > pmt) hi = mid; else lo = mid;
  }
  return Math.round((lo + hi) / 2 * 1000) / 1000;
}
/** k 번 낸 뒤의 남은 원금 */
export function loanBalanceAt(cfg, apr, k) {
  const i = numOr0(apr) / 100 / 12;
  const P = numOr0(cfg.p), pmt = numOr0(cfg.pmt);
  const b = i === 0 ? P - pmt * k : P * Math.pow(1 + i, k) - pmt * (Math.pow(1 + i, k) - 1) / i;
  return Math.max(0, b);
}
export const loanReady = (cfg) => !!(cfg && numOr0(cfg.p) > 0 && numOr0(cfg.pmt) > 0 && cfg.start);

/** 그 달 말 남은 원금 (아직 설정 전이거나 시작 전이면 null) */
export function loanBalance(cfg, apr, ym) {
  if (!loanReady(cfg)) return null;
  if (ym < cfg.start.slice(0, 7)) return null;
  const n = loanTerm(cfg) || Infinity;
  const k = Math.min(paymentsBy(cfg.start, ym), n);
  return r2(loanBalanceAt(cfg, apr, k));
}
/** 그 달 납입액을 이자 / 원금으로 나눈 값 */
export function loanSplit(cfg, apr, ym) {
  if (!loanReady(cfg)) return null;
  const i = numOr0(apr) / 100 / 12;
  const n = loanTerm(cfg) || Infinity;
  const k = paymentsBy(cfg.start, ym);
  if (k <= 0 || k > n) return { interest: 0, principal: 0, payment: 0, done: k > n };
  const prev = k === 1 ? numOr0(cfg.p) : loanBalanceAt(cfg, apr, k - 1);
  const interest = Math.max(0, prev) * i;
  const pmt = Math.min(numOr0(cfg.pmt), prev + interest);
  return { interest: r2(interest), principal: r2(pmt - interest), payment: r2(pmt), done: false };
}
/** 몇 번째 납입에서 끝나는지 (더 많이 내면 기간보다 일찍 끝납니다) */
export function loanPayoffK(cfg, apr) {
  if (!cfg || !numOr0(cfg.p) || !numOr0(cfg.pmt)) return null;
  const n = loanTerm(cfg) || 600;
  for (let k = 1; k <= n; k++) if (loanBalanceAt(cfg, apr, k) <= 0.005) return k;
  return n;
}
/** 납입액이 이자도 못 덮으면 영원히 끝나지 않습니다 */
export function loanUnderwater(cfg, apr) {
  if (!cfg || !numOr0(cfg.p) || !numOr0(cfg.pmt)) return false;
  const i = numOr0(apr) / 100 / 12;
  return i > 0 && numOr0(cfg.pmt) <= numOr0(cfg.p) * i;
}
export function loanTotalInterest(cfg, apr) {
  const k = loanPayoffK(cfg, apr);
  if (!cfg || !k) return null;
  const i = numOr0(apr) / 100 / 12;
  const last = loanBalanceAt(cfg, apr, k - 1) * (1 + i);
  return r2(numOr0(cfg.pmt) * (k - 1) + last - numOr0(cfg.p));
}
export function loanEnd(cfg, apr) {
  const k = loanPayoffK(cfg, apr);
  if (!cfg || !cfg.start || !k) return null;
  return addMonths(cfg.start.slice(0, 7), k - 1);
}
/** 차트·표용 전체 상환표 */
export function amortization(cfg, apr, maxRows) {
  if (!loanReady(cfg)) return [];
  const k = loanPayoffK(cfg, apr) || 0;
  const out = [];
  let bal = numOr0(cfg.p);
  const i = numOr0(apr) / 100 / 12;
  for (let n = 1; n <= Math.min(k, maxRows || 1200); n++) {
    const interest = Math.max(0, bal) * i;
    const pay = Math.min(numOr0(cfg.pmt), bal + interest);
    const principal = pay - interest;
    bal = Math.max(0, bal - principal);
    out.push({ k: n, ym: addMonths(cfg.start.slice(0, 7), n - 1), interest: r2(interest), principal: r2(principal), payment: r2(pay), balance: r2(bal) });
  }
  return out;
}
/** 해마다 모은 요약: [{year, interest, principal, endBalance}] */
export function amortYearly(rows) {
  const by = new Map();
  rows.forEach((r) => {
    const y = r.ym.slice(0, 4);
    const e = by.get(y) || { year: y, interest: 0, principal: 0, endBalance: 0 };
    e.interest += r.interest; e.principal += r.principal; e.endBalance = r.balance;
    by.set(y, e);
  });
  return Array.from(by.values()).map((e) => ({ year: e.year, interest: r2(e.interest), principal: r2(e.principal), endBalance: r2(e.endBalance) }));
}

// ───────── 자산: 집·차 (감가 / 상승) ─────────
// cfg = { method:'dep'(정률 감가)|'sl'(정액)|'ap'(연 상승), cost, date:'YYYY-MM-DD', rate:%, salvage, life:년, override }

export function yearsTo(dateStr, ym) {
  if (!dateStr) return 0;
  const a = new Date(dateStr + 'T00:00:00'), b = new Date(lastDay(ym) + 'T00:00:00');
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.max(0, (b - a) / (365.2425 * 864e5));
}
/** 그 달 말 가치. 직접 넣은 값(override)이 있으면 언제나 그것이 우선입니다 (감정가가 공식보다 정확하니까). */
export function assetValue(cfg, ym) {
  if (!cfg) return null;
  if (cfg.override !== undefined && cfg.override !== null && cfg.override !== '') return numOr0(cfg.override);
  const cost = numOr0(cfg.cost);
  if (!cost) return null;
  if (cfg.date && ym < cfg.date.slice(0, 7)) return null;
  const yrs = yearsTo(cfg.date, ym);
  const rate = numOr0(cfg.rate) / 100, sal = numOr0(cfg.salvage);
  if (!yrs) return cost;
  if (cfg.method === 'ap') return r2(cost * Math.pow(1 + rate, yrs));
  if (cfg.method === 'sl') {
    const life = numOr0(cfg.life) || 10;
    return r2(Math.max(sal, cost - (cost - sal) * Math.min(1, yrs / life)));
  }
  return r2(Math.max(sal, cost * Math.pow(1 - rate, yrs)));
}
export function assetMonthly(cfg, ym) {
  const a = assetValue(cfg, ym), b = assetValue(cfg, addMonths(ym, -1));
  if (a === null || b === null) return 0;
  return r2(a - b);
}
export const assetTrail = (cfg, fromYm, toYm) => {
  const out = [];
  for (let m = fromYm; m <= toYm; m = addMonths(m, 1)) out.push({ ym: m, value: assetValue(cfg, m) });
  return out;
};

// ───────── 주식 ─────────
export function holdingsValue(holdings, prices) {
  return r2((holdings || []).reduce((a, h) => {
    const q = prices && prices[h.sym];
    return a + (q && q.price ? numOr0(h.shares) * numOr0(q.price) : 0);
  }, 0));
}
export const holdingsBook = (holdings) => r2((holdings || []).reduce((a, h) => a + numOr0(h.book), 0));

// ───────── 발생주의 청구 (재산세처럼 1년 치를 몇 번에 나눠 내는 것) ─────────
// cfg = { annual, since:'YYYY-MM', opening, code: 비용 계정 id, acct: 부채 계정 id }
const monthsFrom = (a, b) => monthsBetween(a, b) + 1;
export function accruedBy(cfg, ym) {
  if (!cfg || !numOr0(cfg.annual) || !cfg.since || ym < cfg.since) return 0;
  return numOr0(cfg.annual) / 12 * monthsFrom(cfg.since, ym);
}
/** 실제로 낸 돈 = 그 비용 계정에 기록된 거래 합계 (시작 달 ~ ym) */
export function accrualPaid(cfg, items, ym) {
  if (!cfg || !cfg.since || !cfg.code) return 0;
  const from = cfg.since + '-01', to = lastDay(ym);
  let sum = 0;
  items.forEach((it) => {
    const d = it.txn.date;
    if (d < from || d > to) return;
    it.ps.forEach((p) => { if (String(p.account_id) === String(cfg.code) && !L.truthy(p.deleted)) sum += L.num(p.amount_cad); });
  });
  return sum;
}
/** 지금 아직 내야 할 금액 = 처음 밀린 금액 + 쌓인 금액 − 낸 금액 */
export function accrualBalance(cfg, items, ym) {
  if (!cfg || !cfg.acct) return null;
  return r2(numOr0(cfg.opening) + accruedBy(cfg, ym) - accrualPaid(cfg, items, ym));
}

// ───────── 재무상태표에 덮어쓸 값 ─────────
/**
 * meta = { loans:{id:cfg}, debts:{id:{apr,limit}}, assets:{id:cfg}, holdings:[{sym,shares,book,acct}], prices:{}, accrual:cfg }
 * 돌려주는 값: Map(account_id → 그 달 말 값 (자산·부채 모두 양수))
 */
export function overridesFor(meta, items, ym) {
  const out = new Map();
  if (!meta) return out;
  Object.keys(meta.loans || {}).forEach((id) => {
    const apr = numOr0(meta.debts && meta.debts[id] && meta.debts[id].apr);
    const v = loanBalance(meta.loans[id], apr, ym);
    if (v !== null) out.set(String(id), v);
  });
  Object.keys(meta.assets || {}).forEach((id) => {
    const v = assetValue(meta.assets[id], ym);
    if (v !== null) out.set(String(id), v);
  });
  const byAcct = new Map();
  (meta.holdings || []).forEach((h) => {
    if (!h.acct) return;
    const q = meta.prices && meta.prices[h.sym];
    if (!q || !q.price) return;
    byAcct.set(String(h.acct), (byAcct.get(String(h.acct)) || 0) + numOr0(h.shares) * numOr0(q.price));
  });
  byAcct.forEach((v, id) => { if (!out.has(id)) out.set(id, r2(v)); });
  if (meta.accrual && meta.accrual.acct) {
    const v = accrualBalance(meta.accrual, items || [], ym);
    if (v !== null) out.set(String(meta.accrual.acct), v);
  }
  return out;
}

// ───────── 부채 상환 시뮬레이션 (눈덩이 / 눈사태) ─────────
/**
 * debts = [{ id, name, balance, apr, min }]  extra = 매달 추가로 낼 수 있는 금액
 * strategy: 'avalanche' (이율 높은 것부터) | 'snowball' (잔액 작은 것부터) | 'none' (최소 납입만)
 * 돌려주는 값: { months, totalInterest, totalPaid, order:[{id,name,month}], timeline:[{month, total, [id]: balance}], neverEnds }
 */
export function payoffPlan(debts, extra, strategy, opts) {
  const maxMonths = (opts && opts.maxMonths) || 600;
  const ds = (debts || []).filter((d) => numOr0(d.balance) > 0.005).map((d) => ({ id: String(d.id), name: d.name, bal: numOr0(d.balance), apr: numOr0(d.apr), min: numOr0(d.min) }));
  if (!ds.length) return { months: 0, totalInterest: 0, totalPaid: 0, order: [], timeline: [], neverEnds: false, strategy };
  const rank = (a, b) => (strategy === 'snowball' ? a.bal - b.bal : b.apr - a.apr) || a.bal - b.bal;
  const budget = ds.reduce((s, d) => s + d.min, 0) + Math.max(0, numOr0(extra));
  let totalInterest = 0, totalPaid = 0, month = 0;
  const order = [];
  const timeline = [Object.assign({ month: 0, total: r2(ds.reduce((s, d) => s + d.bal, 0)) }, ...ds.map((d) => ({ [d.id]: r2(d.bal) })))];
  while (ds.some((d) => d.bal > 0.005) && month < maxMonths) {
    month++;
    ds.forEach((d) => { if (d.bal > 0) { const it = d.bal * d.apr / 100 / 12; d.bal += it; totalInterest += it; } });
    let pool = strategy === 'none' ? 0 : budget;
    // 1) 모두 최소 납입
    ds.forEach((d) => {
      if (d.bal <= 0) return;
      const pay = Math.min(d.bal, d.min);
      d.bal -= pay; totalPaid += pay;
      if (strategy !== 'none') pool -= pay;
    });
    // 2) 남은 돈을 우선순위대로 (최소 납입이 0인 부채도 포함)
    if (strategy !== 'none') {
      const left = ds.filter((d) => d.bal > 0.005).sort(rank);
      for (const d of left) {
        if (pool <= 0.005) break;
        const pay = Math.min(d.bal, pool);
        d.bal -= pay; pool -= pay; totalPaid += pay;
      }
    } else {
      // 최소 납입만으로는 이자도 못 덮는 부채는 끝나지 않습니다
    }
    ds.forEach((d) => { if (d.bal <= 0.005 && d.bal !== 0) { d.bal = 0; } });
    ds.forEach((d) => { if (d.bal === 0 && !d.done) { d.done = true; order.push({ id: d.id, name: d.name, month }); } });
    timeline.push(Object.assign({ month, total: r2(ds.reduce((s, d) => s + Math.max(0, d.bal), 0)) }, ...ds.map((d) => ({ [d.id]: r2(Math.max(0, d.bal)) }))));
  }
  const neverEnds = ds.some((d) => d.bal > 0.005);
  return { months: month, totalInterest: r2(totalInterest), totalPaid: r2(totalPaid), order, timeline, neverEnds, strategy, monthlyBudget: r2(budget) };
}
