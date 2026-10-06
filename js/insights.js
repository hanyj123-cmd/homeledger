// 요약·조언 계산 엔진 (순수 함수): 월별 추이, 재무 상태, 건강 점수, 예측, 내년 예산 제안, 구독/업체/사람별 표, 규칙 기반 조언.
// 화면(summary.js, plan.js)과 AI(ai.js)가 같은 숫자를 쓰도록 모든 숫자는 여기서 만듭니다.
import * as L from './ledger.js';
import * as R from './reports.js';
import * as B from './budget.js';
import * as V from './valuation.js';

const r2 = (v) => Math.round(v * 100) / 100;
const sum = (a) => a.reduce((s, v) => s + v, 0);
const avg = (a) => (a.length ? sum(a) / a.length : 0);
export const months = (endYm, n) => { const o = []; for (let i = n - 1; i >= 0; i--) o.push(L.shiftMonth(endYm, -i)); return o; };
const pct = (a, b) => (Math.abs(b) > 0.004 ? r2((a - b) / Math.abs(b) * 100) : null);
const US = (n) => '$' + Math.round(Math.abs(n)).toLocaleString('en-US');

// ───────── 월별 추이 ─────────
/** 한 번 훑어서 [{ym, income, expense, net, rate, fixed, semi, fun, fin, review}] */
export function monthSeries(items, accMap, ms) {
  const set = new Map(ms.map((m) => [m, { ym: m, income: 0, expense: 0, fixed: 0, semi: 0, fun: 0, fin: 0, review: 0 }]));
  items.forEach((it) => {
    const e = set.get(L.monthOf(it.txn.date));
    if (!e) return;
    it.ps.forEach((p) => {
      const a = accMap.get(String(p.account_id));
      if (!a) return;
      const v = L.num(p.amount_cad);
      if (a.type === 'INCOME') e.income -= v;
      else if (a.type === 'EXPENSE') {
        e.expense += v;
        const g = a.report_group || '확인 필요';
        if (g === '고정비') e.fixed += v; else if (g === 'semi-고정비') e.semi += v; else if (g === '유흥비') e.fun += v; else if (g === '금융비') e.fin += v; else e.review += v;
      }
    });
  });
  return ms.map((m) => {
    const e = set.get(m);
    ['income', 'expense', 'fixed', 'semi', 'fun', 'fin', 'review'].forEach((k) => { e[k] = r2(e[k]); });
    e.net = r2(e.income - e.expense);
    e.rate = e.income > 0 ? r2(e.net / e.income * 100) : null;
    return e;
  });
}

// ───────── 계좌 종류 ─────────
export function kindOf(a) {
  const st = String(a.subtype || '').toUpperCase(), nm = String(a.name || '').toUpperCase();
  if (a.type === 'ASSET') {
    if (/INVEST|TFSA|RRSP|RESP|FHSA|STOCK|BROKER/.test(st) || /TFSA|RRSP|RESP|FHSA|BROKER/.test(nm)) return 'invest';
    if (/CHEQ|CHECK|SAV|CASH|DEPOSIT/.test(st) || /CHEQ|CHECK|SAVING|CASH/.test(nm)) return 'cash';
    if (/HOME|HOUSE|PROPERTY|REAL|VEHICLE|CAR|AUTO/.test(st) || /HOME|HOUSE|CONDO|PROPERTY|VEHICLE|CAR\b|SUV/.test(nm)) return 'fixed';
    return st ? 'other' : 'cash';
  }
  if (a.type === 'LIABILITY') {
    if (/CLEAR/.test(st) || /CLEARING/.test(nm)) return 'clearing';
    if (/LOAN|MORTGAGE/.test(st) || /MORTGAGE|LOAN/.test(nm)) return 'loan';
    if (/LINE|LOC|HELOC/.test(st) || /\bLOC\b|LINE OF CREDIT|HELOC/.test(nm)) return 'loc';
    if (/ACCRU|TAX/.test(st) || /PROPERTY TAX|ACCRUED/.test(nm)) return 'accrued';
    return 'card';
  }
  return a.type.toLowerCase();
}

/** 재무 상태: 현금 / 투자 / 고정자산 / 부채 종류별 합계 */
export function position(bs, accMap) {
  const out = { cash: 0, invest: 0, fixed: 0, other: 0, card: 0, loan: 0, loc: 0, accrued: 0, clearing: 0 };
  bs.assets.forEach((l) => { const a = accMap.get(String(l.id)); const k = a ? kindOf(a) : 'other'; out[k === 'cash' || k === 'invest' || k === 'fixed' ? k : 'other'] += l.amount; });
  bs.liabilities.forEach((l) => { const a = accMap.get(String(l.id)); const k = a ? kindOf(a) : 'card'; out[k] = (out[k] || 0) + l.amount; });
  Object.keys(out).forEach((k) => { out[k] = r2(out[k]); });
  out.totalAssets = bs.totalAssets; out.totalDebt = r2(out.card + out.loan + out.loc + out.accrued + out.clearing); out.net = bs.net;
  out.liquid = r2(out.cash);
  return out;
}

/** 부채 목록 (이율·한도는 설정에서, 없으면 비어 있음) */
export function debtList(bs, accMap, meta) {
  const list = [];
  bs.liabilities.forEach((l) => {
    const a = accMap.get(String(l.id));
    if (!a) return;
    const k = kindOf(a);
    if (k === 'clearing' || l.amount <= 0.005) return;
    const d = (meta && meta.debts && meta.debts[l.id]) || {};
    const loan = meta && meta.loans && meta.loans[l.id];
    const apr = Number(d.apr) || 0;
    const limit = Number(d.limit) || 0;
    const min = loan && Number(loan.pmt) ? Number(loan.pmt) : (Number(d.min) || (k === 'card' || k === 'loc' ? Math.max(10, r2(l.amount * 0.03)) : 0));
    list.push({
      id: l.id, name: l.name, name_ko: l.name_ko, kind: k, balance: l.amount, apr, limit, min,
      util: limit > 0 ? r2(l.amount / limit * 100) : null,
      monthlyInterest: r2(l.amount * apr / 100 / 12), hasApr: apr > 0
    });
  });
  return list.sort((a, b) => (b.apr - a.apr) || (b.balance - a.balance));
}

// ───────── 건강 점수 ─────────
/**
 * 5개 항목, 각 0–20점: 저축률 · 비상금(개월) · 고정비 비중 · 카드 사용률/이자 · 부채 비율
 * 숫자가 없는 항목은 점수에서 빼고 있는 항목만으로 100점 환산합니다.
 */
export function healthScore(ctx) {
  const parts = [];
  const { series, pos, debts } = ctx;
  const last3 = series.slice(-3).filter((s) => s.income > 0 || s.expense > 0);
  const inc = avg(last3.map((s) => s.income)), exp = avg(last3.map((s) => s.expense));
  const essential = avg(last3.map((s) => s.fixed + s.semi + s.fin));
  if (inc > 0) {
    const rate = (inc - exp) / inc * 100;
    parts.push({ key: 'savings', label: 'Savings rate (저축률)', value: r2(rate), unit: '%', score: Math.max(0, Math.min(20, Math.round(rate / 20 * 20))), goal: '20% 이상', tone: rate >= 20 ? 'good' : rate >= 8 ? 'warn' : 'bad' });
  }
  if (essential > 0) {
    const mo = pos.liquid / essential;
    parts.push({ key: 'emergency', label: 'Emergency fund (비상금)', value: r2(mo), unit: 'months', score: Math.max(0, Math.min(20, Math.round(mo / 6 * 20))), goal: '필수 지출 6개월', tone: mo >= 6 ? 'good' : mo >= 3 ? 'warn' : 'bad' });
  }
  if (inc > 0) {
    const fx = avg(last3.map((s) => s.fixed)) / inc * 100;
    parts.push({ key: 'fixed', label: 'Fixed-cost share (고정비 비중)', value: r2(fx), unit: '%', score: Math.max(0, Math.min(20, Math.round((70 - fx) / 30 * 20))), goal: '수입의 50% 이하', tone: fx <= 50 ? 'good' : fx <= 65 ? 'warn' : 'bad' });
  }
  const cards = debts.filter((d) => d.kind === 'card' || d.kind === 'loc');
  const lim = sum(cards.map((d) => d.limit)), bal = sum(cards.map((d) => d.balance));
  if (cards.length) {
    if (lim > 0) {
      const u = bal / lim * 100;
      parts.push({ key: 'util', label: 'Credit use (카드 사용률)', value: r2(u), unit: '%', score: Math.max(0, Math.min(20, Math.round((60 - u) / 50 * 20))), goal: '30% 이하', tone: u <= 30 ? 'good' : u <= 60 ? 'warn' : 'bad' });
    } else {
      const m = inc > 0 ? bal / inc : 0;
      parts.push({ key: 'util', label: 'Card balance (카드 잔액)', value: r2(m), unit: 'months of income', score: Math.max(0, Math.min(20, Math.round((1 - m) * 20))), goal: '한 달 수입보다 적게', tone: m <= 0.3 ? 'good' : m <= 1 ? 'warn' : 'bad' });
    }
  } else if (pos.totalAssets > 0) {
    parts.push({ key: 'util', label: 'Credit use (카드 사용률)', value: 0, unit: '%', score: 20, goal: '30% 이하', tone: 'good' });
  }
  if (pos.totalAssets > 0) {
    const dr = pos.totalDebt / pos.totalAssets * 100;
    parts.push({ key: 'debt', label: 'Debt ratio (부채 비율)', value: r2(dr), unit: '%', score: Math.max(0, Math.min(20, Math.round((90 - dr) / 70 * 20))), goal: '자산의 50% 이하', tone: dr <= 50 ? 'good' : dr <= 80 ? 'warn' : 'bad' });
  }
  const got = parts.length;
  const total = got ? Math.round(sum(parts.map((p) => p.score)) / (got * 20) * 100) : null;
  const grade = total === null ? '—' : total >= 85 ? 'A' : total >= 70 ? 'B' : total >= 55 ? 'C' : total >= 40 ? 'D' : 'E';
  const label = total === null ? '데이터 부족' : total >= 85 ? '아주 건강해요' : total >= 70 ? '안정적이에요' : total >= 55 ? '보통이에요, 손볼 곳이 있어요' : total >= 40 ? '주의가 필요해요' : '지금 정리가 필요해요';
  return { total, grade, label, parts, avgIncome: r2(inc), avgExpense: r2(exp), essential: r2(essential) };
}

// ───────── 이번 달 예측 / 앞으로 N개월 ─────────
/** 이번 달 끝까지 얼마 쓰게 될지: 이미 쓴 것 + 아직 안 쓴 평소 지출(최근 3개월 평균 기준, 예산이 있으면 예산) */
export function monthForecast(items, accMap, budgets, ym, today) {
  const is = R.incomeStatement(items, accMap, ym);
  const prior = months(L.shiftMonth(ym, -1), 3).map((m) => R.incomeStatement(items, accMap, m));
  const bmap = B.budgetMap(budgets, ym);
  const base = new Map();
  prior.forEach((p) => p.expenseGroups.forEach((g) => g.lines.forEach((l) => base.set(l.id, (base.get(l.id) || 0) + l.amount / prior.length))));
  bmap.forEach((v, id) => base.set(id, v));
  const actual = new Map();
  is.expenseGroups.forEach((g) => g.lines.forEach((l) => actual.set(l.id, l.amount)));
  const [y, m] = ym.split('-').map(Number);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const day = L.monthOf(today) === ym ? Number(today.slice(8, 10)) : (today > ym + '-31' ? dim : 0);
  const frac = day / dim;
  let remaining = 0;
  base.forEach((b, id) => {
    const a = actual.get(id) || 0;
    const acc = accMap.get(String(id));
    const grp = acc ? acc.report_group : '';
    // 고정비: 아직 안 낸 만큼 / 변동비: 남은 날짜 비율만큼 평소 속도로 더 씀
    remaining += grp === '고정비' ? Math.max(0, b - a) : b * (1 - frac);
  });
  const doneMonth = day >= dim || (L.monthOf(today) > ym);
  const projExpense = doneMonth ? is.expense : r2(is.expense + remaining);
  const incBase = avg(prior.map((p) => p.income));
  const projIncome = doneMonth ? is.income : r2(Math.max(is.income, incBase));
  return { ym, day, dim, frac: r2(frac), actualExpense: is.expense, actualIncome: is.income, projExpense, projIncome, projNet: r2(projIncome - projExpense), remaining: r2(remaining), done: doneMonth };
}

/** 앞으로 n개월 (달마다 수입/지출/순수입/누적 현금) */
export function projectMonths(ctx, n, opts) {
  const growth = (opts && opts.growth !== undefined ? opts.growth : 3) / 100;
  const { items, accMap, budgets, ym } = ctx;
  const hist = months(ym, 6).map((m) => R.incomeStatement(items, accMap, m)).filter((s) => s.income > 0 || s.expense > 0);
  const incBase = avg(hist.slice(-3).map((s) => s.income));
  const catBase = new Map();
  hist.slice(-3).forEach((s) => s.expenseGroups.forEach((g) => g.lines.forEach((l) => catBase.set(l.id, (catBase.get(l.id) || 0) + l.amount / Math.min(3, hist.length)))));
  const out = [];
  let cash = ctx.liquid || 0;
  for (let i = 1; i <= n; i++) {
    const m = L.shiftMonth(ym, i);
    const bmap = B.budgetMap(budgets, m);
    let exp = 0;
    const ids = new Set(Array.from(catBase.keys()).concat(Array.from(bmap.keys())));
    ids.forEach((id) => { exp += bmap.has(id) ? bmap.get(id) : (catBase.get(id) || 0) * (1 + growth * i / 12); });
    const inc = incBase;
    cash += inc - exp;
    out.push({ ym: m, income: r2(inc), expense: r2(exp), net: r2(inc - exp), cash: r2(cash), budgeted: bmap.size > 0 });
  }
  return out;
}

// ───────── 내년(앞으로 12개월) 예산 제안 ─────────
/**
 * 카테고리마다 "근거 있는" 제안: 최근 12개월(없으면 있는 만큼) 평균 × (1 + 물가) ,
 * 지출이 들쭉날쭉한 카테고리는 중앙값에 가깝게, 계속 늘고 있으면 최근 3개월 평균을 반영.
 * → Map(id → {amount, basis, rationale, trend, months})
 */
export function suggestNextYear(items, accMap, ym, growthPct) {
  const g = (growthPct === undefined ? 3 : growthPct) / 100;
  const ms = months(ym, 12);
  const per = new Map(); // id → [월별 금액]
  ms.forEach((m, i) => {
    const is = R.incomeStatement(items, accMap, m);
    is.expenseGroups.forEach((gr) => gr.lines.forEach((l) => {
      if (l.id === '9999') return;
      if (!per.has(l.id)) per.set(l.id, new Array(ms.length).fill(0));
      per.get(l.id)[i] = l.amount;
    }));
  });
  const first = ms.findIndex((m, i) => Array.from(per.values()).some((a) => a[i] > 0));
  const span = first < 0 ? 0 : ms.length - first;
  const out = new Map();
  per.forEach((arr, id) => {
    const used = arr.slice(first < 0 ? 0 : first);
    const n = used.length;
    if (n < 2) return;
    const mean = avg(used), sorted = used.slice().sort((a, b) => a - b), med = sorted[Math.floor(n / 2)];
    const sd = Math.sqrt(avg(used.map((v) => (v - mean) ** 2)));
    const cv = mean > 0 ? sd / mean : 0;
    const recent = avg(used.slice(-3)), older = avg(used.slice(0, Math.max(1, n - 3)));
    const trendPct = older > 0 ? (recent - older) / older * 100 : 0;
    const hasData = used.filter((v) => v > 0).length;
    if (mean < 2.5 || hasData < 2) return;
    let basis = mean, why = '최근 ' + n + '개월 평균 ' + US(mean);
    if (cv > 0.6) { basis = (mean + med) / 2; why += ' · 달마다 차이가 커서 평균과 중앙값의 중간으로 잡음'; }
    else if (trendPct > 12 && n >= 5) { basis = (mean + recent) / 2; why += ' · 최근 3개월이 ' + Math.round(trendPct) + '% 올라 그 흐름 반영'; }
    else if (trendPct < -12 && n >= 5) { basis = (mean + recent) / 2; why += ' · 최근 3개월이 ' + Math.round(-trendPct) + '% 내려 그 흐름 반영'; }
    const amount = Math.max(5, Math.round(basis * (1 + g) / 5) * 5);
    why += ' · 물가 ' + (g * 100).toFixed(g * 100 % 1 ? 1 : 0) + '% 반영';
    out.set(String(id), { amount, basis: r2(mean), rationale: why, trend: r2(trendPct), months: n, volatile: cv > 0.6 });
  });
  return { map: out, span };
}

// ───────── 구독 · 업체 · 사람 ─────────
export function subscriptions(items, accMap, ym) {
  const ms = months(ym, 4);
  const set = new Set(ms);
  const by = new Map();
  items.forEach((it) => {
    const mo = L.monthOf(it.txn.date);
    if (!set.has(mo) || !it.txn.merchant) return;
    let v = 0, cat = '';
    it.ps.forEach((p) => { const a = accMap.get(String(p.account_id)); if (a && a.type === 'EXPENSE') { v += L.num(p.amount_cad); cat = cat || a.name; } });
    if (v <= 0) return;
    const key = L.normMerchant(it.txn.merchant);
    if (!key) return;
    if (!by.has(key)) by.set(key, { name: it.txn.merchant, cat, per: new Map() });
    const e = by.get(key);
    e.per.set(mo, (e.per.get(mo) || []).concat(v));
  });
  const out = [];
  by.forEach((e) => {
    if (e.per.size < 3) return;
    const amts = Array.from(e.per.values()).map((a) => avg(a));
    const m = avg(amts);
    if (m < 3) return;
    if (!amts.every((a) => Math.abs(a - m) / m <= 0.2)) return;
    // 한 달에 여러 번(카페, 식료품)은 구독이 아니라 습관
    if (Array.from(e.per.values()).some((a) => a.length > 2)) return;
    out.push({ name: e.name, cat: e.cat, monthly: r2(m), yearly: r2(m * 12), months: e.per.size });
  });
  return out.sort((a, b) => b.monthly - a.monthly);
}

export function vendorTable(items, accMap, ms, topN) {
  const set = new Set(ms);
  const by = new Map();
  items.forEach((it) => {
    if (!set.has(L.monthOf(it.txn.date)) || !it.txn.merchant) return;
    let v = 0, cat = '';
    it.ps.forEach((p) => { const a = accMap.get(String(p.account_id)); if (a && a.type === 'EXPENSE') { v += L.num(p.amount_cad); cat = cat || a.name; } });
    if (Math.abs(v) < 0.005) return;
    const key = L.normMerchant(it.txn.merchant) || it.txn.merchant;
    const e = by.get(key) || { key, name: it.txn.merchant, cat, total: 0, count: 0 };
    e.total += v; e.count++;
    by.set(key, e);
  });
  const all = Array.from(by.values()).map((e) => ({ key: e.key, name: e.name, cat: e.cat, total: r2(e.total), count: e.count, avg: r2(e.total / e.count) })).sort((a, b) => b.total - a.total);
  const grand = sum(all.map((x) => x.total));
  return all.slice(0, topN || 15).map((x) => Object.assign(x, { share: grand > 0 ? r2(x.total / grand * 100) : 0 }));
}

export function ownerTable(items, accMap, ms) {
  const set = new Set(ms);
  const by = new Map();
  items.forEach((it) => {
    if (!set.has(L.monthOf(it.txn.date))) return;
    const o = it.txn.owner || 'Joint';
    const e = by.get(o) || { owner: o, income: 0, expense: 0 };
    it.ps.forEach((p) => {
      const a = accMap.get(String(p.account_id));
      if (!a) return;
      if (a.type === 'INCOME') e.income -= L.num(p.amount_cad); else if (a.type === 'EXPENSE') e.expense += L.num(p.amount_cad);
    });
    by.set(o, e);
  });
  return Array.from(by.values()).map((e) => ({ owner: e.owner, income: r2(e.income), expense: r2(e.expense), net: r2(e.income - e.expense) })).filter((e) => e.income || e.expense).sort((a, b) => b.expense - a.expense);
}

// ───────── 변화 (이번 달 vs 지난달) ─────────
export function movers(cmp, n) {
  const lines = [];
  cmp.groups.forEach((g) => g.lines.forEach((l) => lines.push(Object.assign({ group: g.label }, l))));
  const ups = lines.filter((l) => l.delta > 5).sort((a, b) => b.delta - a.delta).slice(0, n || 3);
  const downs = lines.filter((l) => l.delta < -5).sort((a, b) => a.delta - b.delta).slice(0, n || 3);
  return { ups, downs };
}

// ───────── 조언 (규칙 기반, 항상 작동) ─────────
export function buildTips(ctx) {
  const tips = [];
  const { health, cmp, fc, debts, subs, pos, budgetCmp, series, meta } = ctx;
  const add = (tone, title, body, action) => tips.push({ tone, title, body, action: action || '' });
  const part = (k) => health.parts.find((p) => p.key === k);
  const sv = part('savings'), em = part('emergency'), fx = part('fixed'), ut = part('util'), dr = part('debt');

  if (sv) {
    if (sv.value >= 20) add('good', '저축 속도가 좋아요', '최근 3개월 평균 저축률이 ' + sv.value + '% 입니다. 목표(20%)를 넘고 있어요.', '남는 돈은 이율이 높은 부채를 먼저 갚거나 TFSA/RRSP 에 넣으세요.');
    else if (sv.value >= 8) add('warn', '저축률을 조금 더 올려보세요', '저축률이 ' + sv.value + '% 입니다. 20%가 되려면 한 달에 약 ' + US(health.avgIncome * 0.2 - (health.avgIncome - health.avgExpense)) + ' 더 아껴야 해요.', '유흥비·외식에서 먼저 줄여보세요.');
    else add('bad', '저축이 거의 안 되고 있어요', '최근 3개월 평균 저축률이 ' + sv.value + '% 입니다. 수입 대부분이 지출로 나가요.', '변동비(식료품, 외식, 쇼핑)에 월 예산을 정하고 매주 확인하세요.');
  }
  if (em) {
    if (em.value < 3) add('bad', '비상금이 부족해요', '현금이 필수 지출의 ' + em.value + '개월 치입니다. 최소 3개월, 이상적으로 6개월을 권장해요.', '월급일에 먼저 일정액을 비상금 계좌로 이체하세요.');
    else if (em.value < 6) add('warn', '비상금이 어느 정도 있어요', '필수 지출 ' + em.value + '개월 치. 6개월까지는 약 ' + US(health.essential * 6 - pos.liquid) + ' 더 필요합니다.', '');
    else add('good', '비상금이 충분해요', '필수 지출의 ' + em.value + '개월 치 현금이 있어요.', '초과분은 부채 상환이나 투자로 돌려도 좋아요.');
  }
  if (fx && fx.value > 55) add(fx.value > 65 ? 'bad' : 'warn', '고정비 비중이 높아요', '수입의 ' + fx.value + '% 가 고정비입니다. 고정비는 한번 줄이면 계속 효과가 있어요.', '모기지 갱신 시 금리 비교, 통신·보험 재협상을 검토하세요.');
  const risky = debts.filter((d) => d.hasApr && d.apr >= 15 && d.balance > 50);
  if (risky.length) {
    const d = risky[0];
    add('bad', '고금리 부채부터 갚으세요', d.name + ' 잔액 ' + US(d.balance) + ' 에 연 ' + d.apr + '% 이자가 붙어 한 달에 약 ' + US(d.monthlyInterest) + ' 가 이자로 나갑니다.', '남는 돈을 이 부채에 먼저 넣으세요 (Plan 탭의 상환 시뮬레이터).');
  } else if (debts.some((d) => (d.kind === 'card' || d.kind === 'loc') && !d.hasApr && d.balance > 100)) {
    add('info', '카드 이율을 입력해 보세요', '카드·한도 잔액이 있지만 이율을 아직 안 넣으셨어요. 이율을 넣으면 이자 부담과 갚는 순서를 계산해 드려요.', 'Wealth 탭 → Debts (부채)');
  }
  if (ut && ut.unit === '%' && ut.value > 30) add(ut.value > 60 ? 'bad' : 'warn', '카드 사용률이 높아요', '한도 대비 ' + ut.value + '% 를 쓰고 있어요. 30% 이하가 신용점수에 좋습니다.', '명세서일 전에 일부를 미리 갚으면 사용률이 낮게 보고돼요.');
  if (dr && dr.value > 80) add('warn', '자산 대비 부채가 많아요', '부채가 자산의 ' + dr.value + '% 입니다. 집값 변동에 민감한 상태예요.', '');
  if (cmp) {
    const m = movers(cmp, 3);
    if (m.ups.length) add('info', '지난달보다 늘어난 지출', m.ups.map((l) => l.name + ' +' + US(l.delta)).join(' · '), '일회성인지 계속될 지출인지 확인해 보세요.');
    if (m.downs.length) add('good', '지난달보다 줄어든 지출', m.downs.map((l) => l.name + ' −' + US(l.delta)).join(' · '), '');
    if (cmp.review > 0) add('warn', '분류 안 된 거래가 있어요', cmp.review + '건이 확인 필요 상태입니다. 분류가 정확해야 조언도 정확해져요.', 'Ledger 에서 Uncategorized 필터로 정리하세요.');
  }
  if (fc && !fc.done && fc.projNet < 0) add('warn', '이번 달은 적자가 예상돼요', '이대로면 이번 달 지출이 ' + US(fc.projExpense) + ', 수입 ' + US(fc.projIncome) + ' 로 ' + US(-fc.projNet) + ' 부족합니다.', '남은 기간 변동비를 줄여야 해요.');
  if (budgetCmp && budgetCmp.hasBudget) {
    const over = [];
    budgetCmp.groups.forEach((g) => g.lines.forEach((l) => { if (l.status === 'over') over.push(l); }));
    if (over.length) add('warn', '예산을 넘긴 항목', over.slice(0, 4).map((l) => l.name + ' ' + US(l.actual - l.budget) + ' 초과').join(' · '), '');
    else add('good', '예산 안에서 지내고 있어요', '이번 달 예산 사용률 ' + (budgetCmp.pct === null ? '' : budgetCmp.pct + '%') + '.', '');
  } else add('info', '월 예산을 정해 보세요', '예산이 없으면 조언의 정확도가 떨어져요. Plan 탭에서 지난 기록으로 제안받을 수 있어요.', 'Plan → Next-year budget');
  if (subs && subs.length) {
    const t = sum(subs.map((s) => s.monthly));
    add('info', '구독·정기 결제 ' + subs.length + '건', '매달 ' + US(t) + ' (연 ' + US(t * 12) + '). ' + subs.slice(0, 3).map((s) => s.name + ' ' + US(s.monthly)).join(' · '), '안 쓰는 건 해지하세요.');
  }
  const order = { bad: 0, warn: 1, info: 2, good: 3 };
  return tips.sort((a, b) => order[a.tone] - order[b.tone]);
}

/** 맨 위 한 줄 요약 */
export function headline(ctx) {
  const { cur, prev, health, fc } = ctx;
  const bits = [];
  if (cur && (cur.income || cur.expense)) {
    const d = prev && prev.expense ? pct(cur.expense, prev.expense) : null;
    bits.push((L.monthLabel(cur.ym)) + ' 지출 ' + US(cur.expense) + (d === null ? '' : ' (지난달 대비 ' + (d >= 0 ? '+' : '−') + Math.abs(Math.round(d)) + '%)') + ', 수입 ' + US(cur.income) + ', ' + (cur.net >= 0 ? '남은 돈 ' : '부족 ') + US(cur.net) + '.');
  } else bits.push('이번 달 기록이 아직 없어요.');
  if (fc && !fc.done && fc.day > 0) bits.push('이대로면 월말에 ' + (fc.projNet >= 0 ? US(fc.projNet) + ' 남을' : US(-fc.projNet) + ' 부족할') + ' 것 같아요.');
  if (health && health.total !== null) bits.push('재무 건강 ' + health.total + '점 (' + health.grade + ').');
  return bits.join(' ');
}

/** 한 번에 모두 계산: 화면과 AI 가 같이 씁니다 */
export function analyze(input) {
  const { accounts, items, accMap, budgets, meta, ym, today } = input;
  const ms12 = months(ym, 12);
  const series = monthSeries(items, accMap, ms12);
  const overridesFor = (m) => V.overridesFor(meta, items, m);
  const bs = R.balanceSheet(accounts, items, accMap, ym, overridesFor(ym));
  const bsPrev = R.balanceSheet(accounts, items, accMap, L.shiftMonth(ym, -1), overridesFor(L.shiftMonth(ym, -1)));
  const nwSeries = ms12.map((m) => (m === ym ? bs : m === L.shiftMonth(ym, -1) ? bsPrev : R.balanceSheet(accounts, items, accMap, m, overridesFor(m))).net);
  const pos = position(bs, accMap);
  const debts = debtList(bs, accMap, meta);
  const health = healthScore({ series, pos, debts });
  const cmp = R.compareIS(items, accMap, budgets, [ym], [L.shiftMonth(ym, -1)]);
  const budgetCmp = B.compare(items, accMap, budgets, ym, today);
  const fc = monthForecast(items, accMap, budgets, ym, today);
  const subs = subscriptions(items, accMap, ym);
  const cur = series[series.length - 1], prev = series[series.length - 2];
  const ctx = { series, bs, bsPrev, pos, debts, health, cmp, budgetCmp, fc, subs, cur, prev, meta, nwSeries, months: ms12, ym };
  ctx.tips = buildTips(ctx);
  ctx.headline = headline(ctx);
  return ctx;
}

/** AI 에 보낼 요약 숫자 (거래 원본 없이, 30KB 미만) */
export function aiContext(ctx, extra) {
  const r = (x) => Math.round(x);
  return Object.assign({
    month: ctx.ym,
    currency: 'CAD',
    thisMonth: { income: r(ctx.cur.income), expense: r(ctx.cur.expense), net: r(ctx.cur.net), fixed: r(ctx.cur.fixed), semi: r(ctx.cur.semi), leisure: r(ctx.cur.fun), financial: r(ctx.cur.fin) },
    lastMonth: ctx.prev ? { income: r(ctx.prev.income), expense: r(ctx.prev.expense), net: r(ctx.prev.net) } : null,
    forecast: ctx.fc ? { projectedExpense: r(ctx.fc.projExpense), projectedIncome: r(ctx.fc.projIncome), projectedNet: r(ctx.fc.projNet), dayOfMonth: ctx.fc.day } : null,
    last12: ctx.series.map((s) => ({ m: s.ym, in: r(s.income), out: r(s.expense) })),
    netWorthLast12: ctx.nwSeries.map(r),
    position: { cash: r(ctx.pos.cash), invest: r(ctx.pos.invest), fixedAssets: r(ctx.pos.fixed), cards: r(ctx.pos.card), loans: r(ctx.pos.loan), lineOfCredit: r(ctx.pos.loc), netWorth: r(ctx.pos.net) },
    debts: ctx.debts.map((d) => ({ name: d.name, kind: d.kind, balance: r(d.balance), apr: d.apr, limit: d.limit, minPayment: r(d.min), monthlyInterest: r(d.monthlyInterest) })),
    health: { score: ctx.health.total, parts: ctx.health.parts.map((p) => ({ k: p.key, v: p.value, u: p.unit, score: p.score })) },
    topCategories: ctx.cmp.groups.flatMap((g) => g.lines.map((l) => ({ g: g.key, n: l.name, cur: r(l.cur), prev: r(l.prev), budget: r(l.budget) }))).sort((a, b) => b.cur - a.cur).slice(0, 18),
    subscriptions: ctx.subs.slice(0, 10).map((s) => ({ n: s.name, monthly: r(s.monthly) })),
    budgetUsedPct: ctx.budgetCmp && ctx.budgetCmp.hasBudget ? ctx.budgetCmp.pct : null,
    reviewCount: ctx.cmp.review
  }, extra || {});
}
