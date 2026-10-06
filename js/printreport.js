// 인쇄용 종합 재무 보고서 (US Letter). 화면을 그대로 찍는 대신, 별도의 HTML 문서를 만들어
// 숨긴 iframe 에 넣고 브라우저 인쇄(= PDF 미리보기 / 저장)를 엽니다.
//   openPrintReport(api, { tab, month })  — 헤더의 Print 버튼에서 호출
//   buildReportHtml(api, { tab, month })  — 완성된 HTML 문자열 (테스트용)
// 숫자는 모두 reports.js / insights.js / budget.js / valuation.js 의 같은 계산을 다시 씁니다.
// 별도 문서이므로 앱의 다크 모드와 상관없이 항상 밝은 인쇄용 색을 씁니다.
import * as L from './ledger.js';
import * as R from './reports.js';
import * as B from './budget.js';
import * as V from './valuation.js';
import * as I from './insights.js';
import * as M from './meta.js';
import { tr, lang, rounded } from './prefs.js';

// ───────── 작은 도구 ─────────
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const t = (s) => esc(tr(s));
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymParts = (ym) => [Number(ym.slice(0, 4)), Number(ym.slice(5, 7))];
/** "September 2026 (2026년 9월)" → tr */
const monthLong = (ym) => { const [y, m] = ymParts(ym); return tr(MONTHS_LONG[m - 1] + ' ' + y + ' (' + y + '년 ' + m + '월)'); };
const monthShort = (ym) => { const [y, m] = ymParts(ym); return tr(MONTHS_SHORT[m - 1] + ' ' + y + ' (' + y + '년 ' + m + '월)'); };
/** 표 머리글용 짧은 달: en/both → "Sep 2026", ko → "2026년 9월" */
const monthCol = (ym) => { const [y, m] = ymParts(ym); return lang() === 'ko' ? y + '년 ' + m + '월' : MONTHS_SHORT[m - 1] + ' ' + y; };
const dateNum = (s) => String(s).slice(0, 10);
/** 제목용: both 모드면 영어 옆에 작은 한국어 */
function biHead(pair) {
  const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(pair);
  if (!m || lang() !== 'both') return esc(tr(pair));
  return esc(m[1]) + ' <span class="hk">' + esc(m[2]) + '</span>';
}
const dateLong = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return y ? tr(MONTHS_SHORT[m - 1] + ' ' + d + ', ' + y + ' (' + y + '년 ' + m + '월 ' + d + '일)') : ''; };
/** 문장: 언어 설정에 따라 영어/한국어/둘 다(두 줄) */
function bi(en, ko) {
  const m = lang();
  if (m === 'en' || !ko) return esc(en);
  if (m === 'ko' || !en) return esc(ko);
  return esc(en) + '<span class="ko">' + esc(ko) + '</span>';
}
/** 계정 이름 "Name (한국어)" → tr */
const accName = (o) => tr(o.name_ko && o.name_ko !== o.name && /[ㄱ-ㆎ가-힣]/.test(o.name_ko) && o.name_ko.indexOf('(') < 0 && o.name_ko.indexOf(')') < 0 ? o.name + ' (' + o.name_ko + ')' : (o.name || o.name_ko || ''));

function makeFmt(whole) {
  const dec = whole ? 0 : 2;
  const rnd = (v) => (whole ? Math.round(v) : Math.round(v * 100) / 100);
  const body = (v) => Math.abs(v).toLocaleString('en-CA', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return {
    whole,
    /** 표 안의 숫자: 음수는 (괄호), 0 은 –, 양수는 보이지 않는 ")" 로 자리 맞춤 */
    cell(v, opt) {
      if (v === null || v === undefined || !Number.isFinite(v)) return '<span class="na">—</span>';
      const r = rnd(v);
      if (Math.abs(r) < (whole ? 0.5 : 0.005)) return '<span class="zero">–</span><span class="pp">)</span>';
      const cur = opt && opt.cur ? '$' : '';
      return r < 0 ? '(' + cur + body(r) + ')' : cur + body(r) + '<span class="pp">)</span>';
    },
    /** 본문용 $1,234.56 / ($1,234.56) */
    money(v) {
      if (v === null || v === undefined || !Number.isFinite(v)) return '—';
      const r = rnd(v);
      return r < 0 ? '($' + body(r) + ')' : '$' + body(r);
    },
    /** KPI 큰 숫자 — 항상 $, 음수 괄호 */
    big(v) { return this.money(v); },
    abs(v) { return '$' + body(rnd(v)); }
  };
}
const pctTxt = (v, d) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : (v < 0 ? '(' + Math.abs(v).toFixed(d === undefined ? 1 : d) + '%)' : v.toFixed(d === undefined ? 1 : d) + '%'));
const pctSigned = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : (v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '%');
const pctOf = (a, b) => (Math.abs(b) > 0.004 ? (a - b) / Math.abs(b) * 100 : null);

/**
 * 증감 표시 ▲/▼. goodUp=true 면 늘어난 것이 좋은 것(수입·자산), false 면 줄어든 것이 좋은 것(지출·부채).
 * mode: 'amt' (금액) | 'pct' (퍼센트) | 'pp' (퍼센트포인트)
 */
function chg(F, delta, goodUp, mode) {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return '<span class="na">—</span>';
  const tiny = mode === 'amt' ? (F.whole ? 0.5 : 0.005) : 0.05;
  if (Math.abs(delta) < tiny) return '<span class="flat">–</span>';
  const up = delta > 0;
  const cls = up === goodUp ? 'good' : 'bad';
  const a = Math.abs(delta);
  const txt = mode === 'amt' ? F.abs(delta).replace('$', '') : mode === 'pct' && a >= 999.5 ? '>999%' : a.toFixed(mode === 'pct' && a >= 99.95 ? 0 : 1) + (mode === 'pp' ? ' pp' : '%');
  return '<span class="chg ' + cls + '">' + (up ? '▲' : '▼') + '&#8202;' + txt + '</span>';
}

const kindLabel = {
  cash: 'Cash & deposits (현금 · 예금)', invest: 'Investments (투자)', fixed: 'Property & vehicles (부동산 · 차량)', other: 'Other assets (기타 자산)',
  card: 'Credit cards (신용카드)', loc: 'Lines of credit (마이너스 통장)', loan: 'Loans & mortgage (대출 · 모기지)', accrued: 'Accrued liabilities (미지급금)', clearing: 'Clearing (정산 계정)'
};
const kindShort = { card: 'Card (카드)', loc: 'LOC (한도대출)', loan: 'Loan (대출)', accrued: 'Accrued (미지급)', clearing: 'Clearing (정산)', other: 'Other (기타)' };
const GROUP_COLOR = { '고정비': '#1a5d1a', 'semi-고정비': '#4f9a3c', '유흥비': '#d9a21b', '금융비': '#6b7f92', '확인 필요': '#b8433a' };

// ───────── 데이터 모으기 ─────────

/** 사람별: 분개 줄에 owner 가 있으면 그 사람, 없으면 거래의 owner */
function ownerBreakdown(items, accMap, months) {
  const set = new Set(months);
  const by = new Map();
  items.forEach((it) => {
    if (!set.has(L.monthOf(it.txn.date))) return;
    it.ps.forEach((p) => {
      const a = accMap.get(String(p.account_id));
      if (!a || (a.type !== 'INCOME' && a.type !== 'EXPENSE')) return;
      const o = String(p.owner || it.txn.owner || 'Joint').trim() || 'Joint';
      const e = by.get(o) || { owner: o, income: 0, expense: 0 };
      const v = L.num(p.amount_cad);
      if (a.type === 'INCOME') e.income -= v; else e.expense += v;
      by.set(o, e);
    });
  });
  return by;
}

function householdName(accounts, meta, items) {
  const names = [];
  const add = (n) => { n = String(n || '').trim(); if (n && !/^joint$/i.test(n) && names.indexOf(n) < 0) names.push(n); };
  Object.values((meta && meta.users) || {}).forEach(add);
  (accounts || []).forEach((a) => { if (L.isActive(a)) add(a.owner); });
  if (!names.length) (items || []).slice(0, 400).forEach((it) => add(it.txn.owner));
  names.sort((a, b) => (a === 'Patrick' ? -1 : b === 'Patrick' ? 1 : 0));
  return names.length ? names.slice(0, 4).join(' & ') : tr('Household (가계)');
}

/** 보고서에 필요한 숫자를 한 번에 */
export function collect(api, opts) {
  opts = opts || {};
  const ym = opts.month || (api.state && api.state.month) || L.monthOf(api.today || L.todayStr());
  const today = api.today || L.todayStr();
  const items = api.items || [];
  const accounts = api.accounts || [];
  const accMap = api.accMap || L.makeAccMap(accounts);
  const budgets = (api.data && api.data.budgets) || [];
  const settings = (api.data && api.data.settings) || [];
  const meta = typeof api.meta === 'function' ? api.meta() : M.readAll(settings);
  const ovFor = typeof api.overridesFor === 'function' ? api.overridesFor : (m) => V.overridesFor(meta, items, m);
  const prevYm = L.shiftMonth(ym, -1);
  const ytd = R.scopeMonths(ym, 'Y');
  const ytdPrev = R.priorMonths(ym, 'Y');

  // 요약 계산 (화면의 Summary 와 같은 엔진). 재무상태는 Reports 탭처럼 모든 계정 기준.
  const ctx = I.analyze({ accounts, items, accMap, budgets, meta, ym, today });
  const bs = R.balanceSheet(accounts, items, accMap, ym, ovFor(ym));
  const bsPrev = R.balanceSheet(accounts, items, accMap, prevYm, ovFor(prevYm));
  const isCur = R.incomeStatement(items, accMap, ym);
  const isPrev = R.incomeStatement(items, accMap, prevYm);
  const isYtd = R.incomeStatementOver(items, accMap, ytd);
  const isYtdPrev = R.incomeStatementOver(items, accMap, ytdPrev);
  const budget = B.compare(items, accMap, budgets, ym, today);
  const pos = I.position(bs, accMap), posPrev = I.position(bsPrev, accMap);
  const debts = I.debtList(bs, accMap, meta);
  const plan = (meta && meta.plan) || { extra: 0, strategy: 'avalanche' };
  const strategy = plan.strategy === 'snowball' ? 'snowball' : 'avalanche';
  const pd = debts.map((d) => ({ id: d.id, name: d.name, balance: d.balance, apr: d.apr, min: d.min }));
  const payoff = debts.length ? V.payoffPlan(pd, Number(plan.extra) || 0, strategy) : null;
  const payoffMin = debts.length ? V.payoffPlan(pd, 0, strategy) : null;
  const vendors = I.vendorTable(items, accMap, [ym], 12);
  const vendorsYtd = new Map(I.vendorTable(items, accMap, ytd, 1e9).map((v) => [v.key, v]));
  const vendorCount = I.vendorTable(items, accMap, [ym], 1e9);
  const owners = ownerBreakdown(items, accMap, [ym]);
  const ownersPrev = ownerBreakdown(items, accMap, [prevYm]);
  const ownersYtd = ownerBreakdown(items, accMap, ytd);
  const ms12 = I.months(ym, 12);
  const series = ctx.series;
  const nw = ms12.map((m) => (m === ym ? bs.net : m === prevYm ? bsPrev.net : R.balanceSheet(accounts, items, accMap, m, ovFor(m)).net));
  const txCount = items.filter((it) => L.monthOf(it.txn.date) === ym).length;
  return {
    ym, prevYm, today, ytd, ytdPrev, accounts, accMap, items, meta, ctx, bs, bsPrev, isCur, isPrev, isYtd, isYtdPrev, budget,
    pos, posPrev, debts, plan: Object.assign({}, plan, { strategy }), payoff, payoffMin, vendors, vendorsYtd, vendorAll: vendorCount,
    owners, ownersPrev, ownersYtd, ms12, series, nw, txCount,
    note: M.readNote(settings, ym), household: householdName(accounts, meta, items)
  };
}

// ───────── SVG 차트 (인쇄용, 단순·선명) ─────────
function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 1.5 ? 1.5 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 3 ? 3 : f <= 4 ? 4 : f <= 5 ? 5 : f <= 6 ? 6 : f <= 8 ? 8 : 10) * p;
}
const kfmt = (v) => { const a = Math.abs(v); const s = a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M' : a >= 1e3 ? (a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(Math.round(a)); return (v < 0 ? '−' : '') + '$' + s; };
const mLab = (ym, i) => { const [y, m] = ymParts(ym); return MONTHS_SHORT[m - 1] + (i === 0 || m === 1 ? " ’" + String(y).slice(2) : ''); };

function barChart(series) {
  const W = 700, H = 210, l = 46, r = 8, top = 14, bot = 26;
  const iw = W - l - r, ih = H - top - bot;
  const max = niceMax(Math.max(1, ...series.map((s) => Math.max(s.income, s.expense))));
  const y = (v) => top + ih - (Math.max(0, v) / max) * ih;
  const n = series.length, gw = iw / n, bw = Math.min(17, gw * 0.34);
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = max / 4 * i, yy = y(v).toFixed(1);
    g += '<line x1="' + l + '" x2="' + (W - r) + '" y1="' + yy + '" y2="' + yy + '" class="' + (i ? 'grid' : 'axis') + '"/>';
    g += '<text x="' + (l - 6) + '" y="' + (Number(yy) + 3) + '" class="yl">' + kfmt(v) + '</text>';
  }
  series.forEach((s, i) => {
    const cx = l + gw * i + gw / 2;
    const hi = Math.max(0, y(0) - y(s.income)), he = Math.max(0, y(0) - y(s.expense));
    g += '<rect x="' + (cx - bw - 1).toFixed(1) + '" y="' + y(s.income).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hi.toFixed(1) + '" class="b-in"/>';
    g += '<rect x="' + (cx + 1).toFixed(1) + '" y="' + y(s.expense).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + he.toFixed(1) + '" class="b-out"/>';
    g += '<text x="' + cx.toFixed(1) + '" y="' + (H - 9) + '" class="xl">' + esc(mLab(s.ym, i)) + '</text>';
  });
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" role="img" aria-label="' + t('Income vs spending, 12 months (12개월 수입 · 지출)') + '">' + g + '</svg>';
}

function lineChart(ms, vals) {
  const W = 700, H = 190, l = 52, r = 64, top = 16, bot = 26;
  const iw = W - l - r, ih = H - top - bot;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (!(hi > lo)) { hi = hi + Math.max(1, Math.abs(hi) * 0.1); lo = lo - Math.max(1, Math.abs(lo) * 0.1); }
  const span = hi - lo, step = niceMax(span / 4);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  if (hi === lo) hi = lo + step;
  const x = (i) => l + (ms.length === 1 ? iw / 2 : iw * i / (ms.length - 1));
  const y = (v) => top + ih - (v - lo) / (hi - lo) * ih;
  let g = '';
  for (let v = lo, k = 0; v <= hi + step / 2 && k < 12; v += step, k++) {
    const yy = y(v).toFixed(1);
    g += '<line x1="' + l + '" x2="' + (W - r) + '" y1="' + yy + '" y2="' + yy + '" class="' + (Math.abs(v) < step / 1e6 ? 'axis' : 'grid') + '"/>';
    g += '<text x="' + (l - 6) + '" y="' + (Number(yy) + 3) + '" class="yl">' + kfmt(v) + '</text>';
  }
  const pts = vals.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1));
  const base = y(Math.max(lo, Math.min(hi, 0 > lo && 0 < hi ? 0 : lo))).toFixed(1);
  g += '<polygon points="' + x(0).toFixed(1) + ',' + base + ' ' + pts.join(' ') + ' ' + x(vals.length - 1).toFixed(1) + ',' + base + '" class="area"/>';
  g += '<polyline points="' + pts.join(' ') + '" class="ln"/>';
  vals.forEach((v, i) => { g += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="' + (i === vals.length - 1 ? 3.6 : 2.2) + '" class="' + (i === vals.length - 1 ? 'dot last' : 'dot') + '"/>'; });
  ms.forEach((m, i) => { g += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 9) + '" class="xl">' + esc(mLab(m, i)) + '</text>'; });
  const lv = vals[vals.length - 1];
  g += '<text x="' + (x(vals.length - 1) + 8).toFixed(1) + '" y="' + (y(lv) + 3.5).toFixed(1) + '" class="endl">' + kfmt(lv) + '</text>';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" role="img" aria-label="' + t('Net worth, 12 months (12개월 순자산)') + '">' + g + '</svg>';
}

function mixBar(groups, total) {
  if (!(total > 0)) return '';
  let x = 0, segs = '', leg = '';
  groups.forEach((g) => {
    if (!(g.total > 0)) return;
    const w = g.total / total * 100;
    const c = GROUP_COLOR[g.key] || '#8896a5';
    segs += '<span style="width:' + w.toFixed(2) + '%;background:' + c + '"></span>';
    leg += '<span class="lg"><i style="background:' + c + '"></i>' + t(g.label) + ' <b>' + w.toFixed(0) + '%</b></span>';
    x += w;
  });
  return '<div class="mix"><div class="mixbar">' + segs + '</div><div class="mixleg">' + leg + '</div></div>';
}

// ───────── 문서 조각 ─────────
const tbl = (cls, cols, head, body, foot) => '<table class="ft ' + (cls || '') + '"><colgroup>' + cols.map((w) => '<col' + (w ? ' style="width:' + w + '"' : '') + '>').join('') + '</colgroup><thead>' + head + '</thead><tbody>' + body + '</tbody>' + (foot ? '<tfoot>' + foot + '</tfoot>' : '') + '</table>';
const th = (cells, left) => '<tr>' + cells.map((c, i) => '<th' + (i >= (left || 1) ? ' class="n"' : '') + '>' + c + '</th>').join('') + '</tr>';

function section(id, num, title, sub, body, cls) {
  return '<section class="sec ' + (cls || '') + '" id="sec-' + id + '"><header class="sh"><span class="sn">' + String(num).padStart(2, '0') + '</span><h2>' + biHead(title) + '</h2>' + (sub ? '<span class="ss">' + sub + '</span>' : '') + '</header>' + body + '</section>';
}

function emptyNote(en) { return '<p class="empty">' + t(en) + '</p>'; }

// 1) 표지 + 2) 요약
const periodTitle = (ym) => { const [y, m] = ymParts(ym); const en = MONTHS_LONG[m - 1] + ' ' + y, ko = y + '년 ' + m + '월'; const l = lang(); return l === 'en' ? esc(en) : l === 'ko' ? esc(ko) : esc(en) + ' <span class="hk">' + esc(ko) + '</span>'; };
function coverBlock(D, F, sections) {
  const lead = '<div class="cover"><div class="brand"><span class="logo">HL</span><span class="bn">HOME LEDGER</span><span class="conf">' + t('Private & confidential (개인 · 대외비)') + '</span></div>'
    + '<h1>' + biHead('Monthly Financial Report (월간 재무 보고서)') + '</h1>'
    + '<div class="period">' + periodTitle(D.ym) + '</div>'
    + '<dl class="meta">'
    + '<div><dt>' + t('Household (가구)') + '</dt><dd>' + esc(D.household) + '</dd></div>'
    + '<div><dt>' + t('Reporting period (보고 기간)') + '</dt><dd>' + esc(dateNum(D.ym + '-01')) + ' – ' + esc(dateNum(D.bs.asOf)) + '</dd></div>'
    + '<div><dt>' + t('Year to date (연간 누계)') + '</dt><dd>' + esc(monthCol(D.ytd[0])) + ' – ' + esc(monthCol(D.ym)) + '</dd></div>'
    + '<div><dt>' + t('Prepared (작성일)') + '</dt><dd>' + esc(dateNum(D.today)) + '</dd></div>'
    + '<div><dt>' + t('Currency (통화)') + '</dt><dd>CAD' + (F.whole ? ' · ' + t('whole dollars (달러 단위)') : '') + '</dd></div>'
    + '</dl>'
    + '<ol class="toc">' + sections.map((s, i) => '<li><span>' + String(i + 1).padStart(2, '0') + '</span>' + t(s.title) + '</li>').join('') + '</ol>'
    + '</div>';
  return lead;
}

function observations(D, F) {
  const c = D.isCur, p = D.isPrev, out = [];
  const m = monthShort(D.ym);
  if (c.income || c.expense) {
    const rate = c.income > 0 ? c.net / c.income * 100 : null;
    out.push(['n', bi('Income of ' + F.money(c.income) + ' against spending of ' + F.money(c.expense) + ' left ' + (c.net >= 0 ? 'net savings of ' + F.money(c.net) : 'a shortfall of ' + F.money(-c.net)) + (rate !== null ? ' — a savings rate of ' + pctSigned(rate) + '.' : '.'),
      '수입 ' + F.money(c.income) + ', 지출 ' + F.money(c.expense) + ' → ' + (c.net >= 0 ? '순저축 ' + F.money(c.net) : '부족 ' + F.money(-c.net)) + (rate !== null ? ' · 저축률 ' + pctSigned(rate) + '.' : '.'))]);
  } else out.push(['n', bi('No income or spending was recorded for ' + m + '.', m + ' 에 기록된 수입·지출이 없습니다.')]);
  if (p.expense > 0 && c.expense > 0) {
    const d = pctOf(c.expense, p.expense);
    out.push([d > 0 ? 'bad' : 'good', bi('Spending ' + (d >= 0 ? 'rose ' : 'fell ') + Math.abs(d).toFixed(1) + '% versus the prior month (' + F.money(p.expense) + ').', '지출이 지난달(' + F.money(p.expense) + ')보다 ' + Math.abs(d).toFixed(1) + '% ' + (d >= 0 ? '늘었습니다.' : '줄었습니다.'))]);
  }
  const dn = D.bs.net - D.bsPrev.net;
  if (Math.abs(D.bs.net) > 0.004 || Math.abs(D.bsPrev.net) > 0.004) out.push([dn >= 0 ? 'good' : 'bad', bi('Net worth ' + (dn >= 0 ? 'increased ' : 'decreased ') + F.money(Math.abs(dn)) + ' to ' + F.money(D.bs.net) + ' at month-end.', '월말 순자산 ' + F.money(D.bs.net) + ' — 지난달보다 ' + F.money(Math.abs(dn)) + (dn >= 0 ? ' 증가.' : ' 감소.'))]);
  const mv = I.movers(R.compareIS(D.items, D.accMap, [], [D.ym], [D.prevYm]), 2);
  if (mv.ups.length) out.push(['bad', bi('Largest increases: ' + mv.ups.map((l) => l.name + ' +' + F.money(l.delta)).join(', ') + '.', '가장 많이 늘어난 지출: ' + mv.ups.map((l) => (l.name_ko || l.name) + ' +' + F.money(l.delta)).join(', ') + '.')]);
  if (mv.downs.length) out.push(['good', bi('Largest decreases: ' + mv.downs.map((l) => l.name + ' −' + F.money(-l.delta)).join(', ') + '.', '가장 많이 줄어든 지출: ' + mv.downs.map((l) => (l.name_ko || l.name) + ' −' + F.money(-l.delta)).join(', ') + '.')]);
  if (D.budget.hasBudget) {
    const over = []; D.budget.groups.forEach((g) => g.lines.forEach((l) => { if (l.status === 'over') over.push(l); }));
    out.push([D.budget.totalActual > D.budget.totalBudget ? 'bad' : 'good', bi('Budget utilisation ' + (D.budget.pct === null ? '—' : D.budget.pct + '%') + ' of ' + F.money(D.budget.totalBudget) + (over.length ? '; ' + over.length + ' categor' + (over.length === 1 ? 'y' : 'ies') + ' over budget.' : '; all categories within budget.'),
      '예산 ' + F.money(D.budget.totalBudget) + ' 중 ' + (D.budget.pct === null ? '—' : D.budget.pct + '%') + ' 사용' + (over.length ? ' · 초과 항목 ' + over.length + '개.' : ' · 모든 항목이 예산 안.'))]);
  }
  const hi = D.debts.filter((d) => d.hasApr && d.apr >= 15 && d.balance > 50);
  if (hi.length) {
    const mi = hi.reduce((s, d) => s + d.monthlyInterest, 0);
    out.push(['bad', bi(hi.length + ' high-interest balance' + (hi.length > 1 ? 's' : '') + ' (15%+ APR) totalling ' + F.money(hi.reduce((s, d) => s + d.balance, 0)) + ' cost about ' + F.money(mi) + ' in interest per month.', '연 15% 이상 고금리 부채 ' + hi.length + '건, 합계 ' + F.money(hi.reduce((s, d) => s + d.balance, 0)) + ' — 한 달 이자 약 ' + F.money(mi) + '.')]);
  }
  if (c.reviewCount > 0) out.push(['warn', bi(c.reviewCount + ' transaction' + (c.reviewCount > 1 ? 's' : '') + ' still need a category; figures may shift once reviewed.', '분류가 필요한 거래 ' + c.reviewCount + '건 — 정리 후 숫자가 바뀔 수 있습니다.')]);
  return out;
}

const GRADE_TXT = { A: 'Very healthy (아주 건강해요)', B: 'Stable (안정적이에요)', C: 'Fair — room to improve (보통이에요, 손볼 곳이 있어요)', D: 'Needs attention (주의가 필요해요)', E: 'Needs action now (지금 정리가 필요해요)' };
function goalOf(p) {
  const g = { savings: 'At least 20% (20% 이상)', emergency: '6 mo of essentials (필수 지출 6개월)', fixed: 'At most 50% of income (수입의 50% 이하)', debt: 'At most 50% of assets (자산의 50% 이하)' }[p.key];
  if (g) return g;
  if (p.key === 'util') return p.unit === '%' ? 'At most 30% (30% 이하)' : 'Under 1 mo income (한 달 수입보다 적게)';
  return p.goal || '';
}
function kpi(label, value, sub, cls) {
  return '<div class="kpi ' + (cls || '') + '"><div class="kl">' + t(label) + '</div><div class="kv">' + value + '</div><div class="ks">' + sub + '</div></div>';
}

function execSummary(D, F) {
  const c = D.isCur, p = D.isPrev;
  const rate = c.income > 0 ? c.net / c.income * 100 : null, rateP = p.income > 0 ? p.net / p.income * 100 : null;
  const debt = D.pos.totalDebt, debtP = D.posPrev.totalDebt;
  const vs = t('vs prior month (전월 대비)');
  const H = D.ctx.health;
  const tiles = [
    kpi('Net worth (순자산)', F.big(D.bs.net), chg(F, D.bs.net - D.bsPrev.net, true, 'amt') + ' ' + vs, 'hero'),
    kpi('Income (수입)', F.big(c.income), chg(F, c.income - p.income, true, 'amt') + ' ' + vs),
    kpi('Spending (지출)', F.big(c.expense), chg(F, c.expense - p.expense, false, 'amt') + ' ' + vs),
    kpi('Net savings (순저축)', F.big(c.net), t('Savings rate (저축률)') + ' <b>' + pctSigned(rate) + '</b> ' + (rate !== null && rateP !== null ? chg(F, rate - rateP, true, 'pp') : '')),
    kpi('Total debt (총부채)', F.big(debt), chg(F, debt - debtP, false, 'amt') + ' ' + vs),
    kpi('Financial health (재무 건강)', H.total === null ? '—' : H.total + '<small>/100 · ' + esc(H.grade) + '</small>', H.total === null ? t('Not enough data (데이터 부족)') : t(GRADE_TXT[H.grade] || H.label))
  ].join('');
  const obs = observations(D, F).slice(0, lang() === 'both' ? 6 : 7).map((o) => '<li class="o-' + o[0] + '">' + o[1] + '</li>').join('');
  const m = lang();
  const tips = m !== 'en' ? (D.ctx.tips || []).filter((x) => x.tone === 'bad' || x.tone === 'warn').slice(0, m === 'both' ? 2 : 3) : [];
  const tipHtml = tips.length ? '<div class="tips"><h3>' + t('Advisor notes (조언)') + '</h3><ul>' + tips.map((x) => '<li class="o-' + esc(x.tone) + '"><b>' + esc(x.title) + '</b> ' + esc(x.body) + (x.action && m !== 'both' ? ' <em>' + esc(x.action) + '</em>' : '') + '</li>').join('') + '</ul></div>' : '';
  const health = H.parts && H.parts.length ? '<table class="ft mini health"><colgroup><col style="width:58%"><col style="width:24%"><col style="width:18%"></colgroup><thead>' + th([t('Health check (건강 점검)'), t('Value (값)'), t('Score (점수)')]) + '</thead><tbody>'
    + H.parts.map((pp) => '<tr><td><i class="dot ' + esc(pp.tone) + '"></i>' + t(pp.label) + (m === 'both' ? '' : '<span class="goal">' + t('Target (목표)') + ': ' + t(goalOf(pp)) + '</span>') + '</td><td class="n">' + esc(pp.unit === '%' ? pp.value.toFixed(1) + '%' : pp.value.toFixed(1) + ' ' + (pp.unit === 'months' ? (m === 'ko' ? '개월' : 'mo') : (m === 'ko' ? '× 수입' : '× income'))) + '</td><td class="n">' + pp.score + '<span class="muted">/20</span></td></tr>').join('') + '</tbody></table>' : '';
  const mix = mixBar(c.expenseGroups, c.expense);
  const lead = m !== 'en' && D.ctx.headline && (c.income || c.expense) ? '<p class="headline">' + esc(D.ctx.headline) + '</p>' : '';
  return '<div class="kpis">' + tiles + '</div>' + lead
    + '<div class="two"><div class="obs"><h3>' + t('Key observations (주요 사항)') + '</h3><ul>' + obs + '</ul></div>'
    + '<div class="side">' + (mix ? '<h3>' + t('Spending mix (지출 구성)') + '</h3>' + mix : '') + health + tipHtml + '</div></div>';
}

// 3) 손익계산서
function incomeStatementSec(D, F) {
  const c = D.isCur, p = D.isPrev, y = D.isYtd;
  if (!(c.income || c.expense || p.income || p.expense || y.income || y.expense)) return emptyNote('No income or spending recorded yet (아직 기록된 수입 · 지출이 없어요)');
  const idx = (lines) => new Map(lines.map((l) => [l.id, l]));
  const ci = idx(c.incomeLines), pi = idx(p.incomeLines), yi = idx(y.incomeLines);
  const cg = new Map(), pg = new Map(), yg = new Map();
  c.expenseGroups.forEach((g) => g.lines.forEach((l) => cg.set(l.id, l)));
  p.expenseGroups.forEach((g) => g.lines.forEach((l) => pg.set(l.id, l)));
  y.expenseGroups.forEach((g) => g.lines.forEach((l) => yg.set(l.id, l)));
  const amt = (m, id) => (m.get(id) ? m.get(id).amount : 0);
  const inc = c.income;
  const row = (cls, label, cv, pv, yv, goodUp) => '<tr class="' + cls + '"><td>' + label + '</td><td class="n">' + F.cell(cv) + '</td><td class="n">' + F.cell(pv) + '</td><td class="n">' + chg(F, cv - pv, goodUp, 'amt') + '</td><td class="n pct">' + (Math.abs(pv) > 0.004 ? chg(F, pctOf(cv, pv), goodUp, 'pct') : '<span class="na">—</span>') + '</td><td class="n">' + F.cell(yv) + '</td><td class="n pct muted">' + (inc > 0 && cv ? pctTxt(cv / inc * 100) : '') + '</td></tr>';
  const ids = (a, b, d, typeFilter) => {
    const s = new Set(); [a, b, d].forEach((m) => m.forEach((_, k) => s.add(k)));
    return Array.from(s).filter((id) => { const ac = D.accMap.get(String(id)); return !typeFilter || (ac && typeFilter(ac)); });
  };
  let body = '</tbody><tbody class="g"><tr class="hd"><td colspan="7">' + t('Income (수입)') + '</td></tr>';
  ids(ci, pi, yi).sort((a, b) => (amt(ci, b) - amt(ci, a)) || (amt(yi, b) - amt(yi, a))).forEach((id) => {
    const l = ci.get(id) || pi.get(id) || yi.get(id);
    body += row('ln', esc(accName(l)), amt(ci, id), amt(pi, id), amt(yi, id), true);
  });
  body += row('sub', t('Total income (수입 합계)'), c.income, p.income, y.income, true);
  let pend = '<tr class="gap"><td colspan="7"></td></tr><tr class="hd"><td colspan="7">' + t('Expenses (지출)') + '</td></tr>';
  const keys = []; [c, p, y].forEach((s) => s.expenseGroups.forEach((g) => { if (keys.indexOf(g.key) < 0) keys.push(g.key); }));
  const order = L.GROUP_ORDER.filter((k) => keys.indexOf(k) >= 0).concat(keys.filter((k) => L.GROUP_ORDER.indexOf(k) < 0));
  order.forEach((key) => {
    const gc = c.expenseGroups.find((g) => g.key === key), gp = p.expenseGroups.find((g) => g.key === key), gy = y.expenseGroups.find((g) => g.key === key);
    const lineIds = new Set(); [gc, gp, gy].forEach((g) => g && g.lines.forEach((l) => lineIds.add(l.id)));
    const arr = Array.from(lineIds).sort((a, b) => (amt(cg, b) - amt(cg, a)) || (amt(yg, b) - amt(yg, a)));
    let grp = '<tr class="grp"><td><i class="sw" style="background:' + (GROUP_COLOR[key] || '#8896a5') + '"></i>' + t(L.GROUP_LABELS[key] || key) + '</td><td class="n">' + F.cell(gc ? gc.total : 0) + '</td><td class="n">' + F.cell(gp ? gp.total : 0) + '</td><td class="n">' + chg(F, (gc ? gc.total : 0) - (gp ? gp.total : 0), false, 'amt') + '</td><td class="n pct">' + (gp && gp.total ? chg(F, pctOf(gc ? gc.total : 0, gp.total), false, 'pct') : '<span class="na">—</span>') + '</td><td class="n">' + F.cell(gy ? gy.total : 0) + '</td><td class="n pct muted">' + (inc > 0 && gc && gc.total ? pctTxt(gc.total / inc * 100) : '') + '</td></tr>';
    arr.forEach((id) => { const l = cg.get(id) || pg.get(id) || yg.get(id); grp += row('ln ind', esc(accName(l)), amt(cg, id), amt(pg, id), amt(yg, id), false); });
    body += '</tbody><tbody class="g">' + pend + grp;
    pend = '';
  });
  body += '</tbody><tbody class="tot">' + pend + row('sub', t('Total expenses (지출 합계)'), c.expense, p.expense, y.expense, false);
  body += row('net', t('Net income (순수입)'), c.net, p.net, y.net, true);
  const sr = (s) => (s.income > 0 ? s.net / s.income * 100 : null);
  body += '<tr class="rate"><td>' + t('Savings rate (저축률)') + '</td><td class="n">' + pctTxt(sr(c)) + '</td><td class="n">' + pctTxt(sr(p)) + '</td><td class="n">' + (sr(c) !== null && sr(p) !== null ? chg(F, sr(c) - sr(p), true, 'pp') : '') + '</td><td></td><td class="n">' + pctTxt(sr(y)) + '</td><td></td></tr>';
  const head = th([t('Category (항목)'), esc(monthCol(D.ym)), esc(monthCol(D.prevYm)), t('Change (증감)'), '%', t('Year to date (연간 누계)'), t('% of income (수입 대비 %)')]);
  const ytdNote = '<p class="fn">' + t('Year to date (연간 누계)') + ': ' + esc(monthShort(D.ytd[0])) + ' – ' + esc(monthShort(D.ym)) + ' · ' + t('Prior-year same period (작년 같은 기간)') + ': ' + F.money(D.isYtdPrev.net) + ' ' + t('net (순수입)') + (c.reviewCount ? ' · ' + c.reviewCount + ' ' + t('transactions need review (확인 필요 거래)') : '') + '</p>';
  return tbl('is', ['29.5%', '12.5%', '12.5%', '12%', '10%', '13.5%', '10%'], head, body) + ytdNote;
}

// 4) 재무상태표
function balanceSheetSec(D, F) {
  const b = D.bs, p = D.bsPrev;
  if (!b.assets.length && !b.liabilities.length && !p.assets.length && !p.liabilities.length) return emptyNote('No account balances yet (아직 계좌 잔액이 없어요)');
  const prevOf = (list) => new Map(list.map((l) => [l.id, l.amount]));
  const pa = prevOf(p.assets), pl = prevOf(p.liabilities), pe = prevOf(p.equityLines);
  let valued = false;
  const row = (cls, label, cv, pv, goodUp) => '<tr class="' + cls + '"><td>' + label + '</td><td class="n">' + F.cell(cv) + '</td><td class="n">' + F.cell(pv) + '</td><td class="n">' + chg(F, cv - pv, goodUp, 'amt') + '</td><td class="n pct">' + (Math.abs(pv) > 0.004 ? chg(F, pctOf(cv, pv), goodUp, 'pct') : '<span class="na">—</span>') + '</td></tr>';
  const block = (title, cur, prevMap, prevList, kinds, goodUp, totalLabel, total, totalPrev) => {
    let out = '', pend = (goodUp ? '' : '<tr class="gap"><td colspan="5"></td></tr>') + '<tr class="hd"><td colspan="5">' + t(title) + '</td></tr>';
    const all = cur.slice();
    prevList.forEach((l) => { if (!cur.some((x) => x.id === l.id)) all.push(Object.assign({}, l, { amount: 0 })); });
    const byKind = new Map();
    all.forEach((l) => {
      const a = D.accMap.get(String(l.id)); let k = a ? I.kindOf(a) : 'other';
      if (goodUp && ['cash', 'invest', 'fixed'].indexOf(k) < 0) k = 'other';
      if (!byKind.has(k)) byKind.set(k, []);
      byKind.get(k).push(l);
    });
    kinds.filter((k) => byKind.has(k)).concat(Array.from(byKind.keys()).filter((k) => kinds.indexOf(k) < 0)).forEach((k) => {
      const ls = byKind.get(k).sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount));
      const st = ls.reduce((s, l) => s + l.amount, 0), sp = ls.reduce((s, l) => s + (prevMap.get(l.id) || 0), 0);
      let g = '<tr class="grp"><td>' + t(kindLabel[k] || k) + '</td><td class="n">' + F.cell(st) + '</td><td class="n">' + F.cell(sp) + '</td><td class="n">' + chg(F, st - sp, goodUp, 'amt') + '</td><td class="n pct">' + (Math.abs(sp) > 0.004 ? chg(F, pctOf(st, sp), goodUp, 'pct') : '<span class="na">—</span>') + '</td></tr>';
      ls.forEach((l) => {
        if (l.valued) valued = true;
        const own = l.owner && !/^joint$/i.test(l.owner) ? ' <span class="own">' + esc(l.owner) + '</span>' : '';
        g += row('ln ind', esc(accName(l)) + (l.valued ? '<sup>†</sup>' : '') + own, l.amount, prevMap.get(l.id) || 0, goodUp);
      });
      out += '</tbody><tbody class="g">' + pend + g;
      pend = '';
    });
    out += '</tbody><tbody class="tot">' + pend + row('sub', t(totalLabel), total, totalPrev, goodUp);
    return out;
  };
  let body = block('Assets (자산)', b.assets, pa, p.assets, ['cash', 'invest', 'fixed', 'other'], true, 'Total assets (자산 합계)', b.totalAssets, p.totalAssets);
  body += block('Liabilities (부채)', b.liabilities, pl, p.liabilities, ['card', 'loc', 'loan', 'accrued', 'clearing'], false, 'Total liabilities (부채 합계)', b.totalLiab, p.totalLiab);
  body += '</tbody><tbody class="g"><tr class="gap"><td colspan="5"></td></tr><tr class="hd"><td colspan="5">' + t('Equity (자본)') + '</td></tr>';
  const eq = b.equityLines.slice();
  p.equityLines.forEach((l) => { if (!eq.some((x) => x.id === l.id)) eq.push(Object.assign({}, l, { amount: 0 })); });
  eq.forEach((l) => { body += row('ln ind', esc(accName(l)), l.amount, pe.get(l.id) || 0, true); });
  body += row('ln ind', t('Cumulative net income (누적 순수입)'), b.retained, p.retained, true);
  body += row('sub', t('Total equity (자본 합계)'), b.equityTotal, p.equityTotal, true);
  body += '</tbody><tbody class="tot">' + row('net', t('Net worth — assets less liabilities (순자산 = 자산 − 부채)'), b.net, p.net, true);
  const ratio = b.totalAssets > 0 ? b.totalLiab / b.totalAssets * 100 : null;
  const liquid = D.pos.cash;
  const essential = D.ctx.health.essential;
  const facts = '<div class="facts">'
    + '<div><span>' + t('Debt-to-assets (부채 비율)') + '</span><b>' + pctTxt(ratio) + '</b></div>'
    + '<div><span>' + t('Liquid cash (현금성 자산)') + '</span><b>' + F.money(liquid) + '</b></div>'
    + '<div><span>' + t('Emergency cover (비상금)') + '</span><b>' + (essential > 0 ? (liquid / essential).toFixed(1) + ' ' + esc(tr('mo (개월)')) : '—') + '</b></div>'
    + '<div><span>' + t('Books balance check (장부 검증)') + '</span><b class="' + (Math.abs(b.diff) < 0.01 ? 'good' : 'bad') + '">' + (Math.abs(b.diff) < 0.01 ? '✓ ' + t('Balanced (일치)') : F.money(b.diff)) + '</b></div>'
    + '</div>';
  const head = th([t('Account (계정)'), esc(dateNum(b.asOf)), esc(dateNum(p.asOf)), t('Change (증감)'), '%']);
  return facts + tbl('bs', ['42%', '16%', '16%', '15%', '11%'], head, body) + (valued ? '<p class="fn">† ' + t('Valued by loan schedule, depreciation or market price rather than book balance; the difference appears as a valuation adjustment in equity (대출 상환표 · 감가상각 · 시세로 평가한 값 — 장부와의 차이는 자본의 평가 조정)') + '</p>' : '');
}

// 5) 예산 vs 실적
function budgetSec(D, F) {
  const bc = D.budget;
  if (!bc.hasBudget) return emptyNote('No budget set for this month. Set monthly budgets in the Plan tab to see variance analysis here (이번 달 예산이 없어요. Plan 탭에서 월 예산을 정하면 여기에 차이 분석이 나와요)');
  const bar = (pct, st) => (pct === null ? '' : '<span class="ubar"><span class="' + st + '" style="width:' + Math.min(100, pct) + '%"></span></span>');
  const row = (cls, label, b, a, pct, st) => '<tr class="' + cls + '"><td>' + label + '</td><td class="n">' + F.cell(b) + '</td><td class="n">' + F.cell(a) + '</td><td class="n ' + (b - a < -0.004 ? 'neg' : '') + '">' + F.cell(b - a) + '</td><td class="n pct">' + (pct === null ? '<span class="na">—</span>' : '<span class="' + st + '">' + pct + '%</span>') + '</td><td class="barc">' + bar(pct, st) + '</td></tr>';
  let body = '';
  bc.groups.forEach((g) => {
    const gp = g.budget > 0 && g.actual >= 0 ? Math.round(g.actual / g.budget * 100) : null;
    let s = row('grp', '<i class="sw" style="background:' + (GROUP_COLOR[g.key] || '#8896a5') + '"></i>' + t(g.label), g.budget, g.actual, gp, gp === null ? 'none' : gp > 100 ? 'over' : gp >= 85 ? 'near' : 'ok');
    g.lines.forEach((l) => { s += row('ln ind' + (l.budget ? '' : ' unb'), esc(accName(l)) + (l.budget ? '' : ' <span class="tag">' + t('unbudgeted (예산 없음)') + '</span>'), l.budget, l.actual, l.actual < 0 ? null : l.pct, l.status); });
    body += '</tbody><tbody class="g">' + s;
  });
  body += '</tbody><tbody class="tot">' + row('net', t('Total (합계)'), bc.totalBudget, bc.totalActual, bc.pct, bc.status);
  const head = th([t('Category (항목)'), t('Budget (예산)'), t('Actual (실제)'), t('Variance (차이)'), t('Used (사용률)'), '']);
  const pace = bc.paceFraction !== null ? ' · ' + t('Month elapsed (경과)') + ' ' + Math.round(bc.paceFraction * 100) + '%' : '';
  return tbl('bud', ['38%', '13.5%', '13.5%', '13.5%', '9%', '12.5%'], head, body)
    + '<p class="fn">' + t('Variance = budget − actual; negative (in parentheses) means over budget (차이 = 예산 − 실제, 괄호는 초과)') + (bc.unbudgeted > 0 ? ' · ' + t('Unbudgeted spending (예산 없는 지출)') + ' ' + F.money(bc.unbudgeted) : '') + pace + '</p>';
}

// 6) 부채
function debtSec(D, F) {
  const ds = D.debts;
  if (!ds.length) return emptyNote('No outstanding debt at month-end (월말 기준 부채가 없어요)');
  let body = '';
  ds.forEach((d) => {
    body += '<tr class="ln"><td>' + esc(accName(d)) + '</td><td class="muted">' + t(kindShort[d.kind] || d.kind) + '</td><td class="n">' + F.cell(d.balance) + '</td><td class="n">' + (d.hasApr ? d.apr.toFixed(2) + '%' : '<span class="na">—</span>') + '</td><td class="n">' + (d.limit ? F.cell(d.limit) : '<span class="na">—</span>') + '</td><td class="n">' + (d.util === null ? '<span class="na">—</span>' : '<span class="' + (d.util > 60 ? 'bad' : d.util > 30 ? 'warnc' : '') + '">' + d.util.toFixed(0) + '%</span>') + '</td><td class="n">' + F.cell(d.min) + '</td><td class="n">' + (d.hasApr ? F.cell(d.monthlyInterest) : '<span class="na">—</span>') + '</td></tr>';
  });
  const tb = ds.reduce((s, d) => s + d.balance, 0), tm = ds.reduce((s, d) => s + d.min, 0), ti = ds.reduce((s, d) => s + d.monthlyInterest, 0);
  const lim = ds.filter((d) => d.limit > 0), tl = lim.reduce((s, d) => s + d.limit, 0), tlb = lim.reduce((s, d) => s + d.balance, 0);
  const foot = '<tr class="net"><td>' + t('Total (합계)') + '</td><td></td><td class="n">' + F.cell(tb) + '</td><td class="n">' + (tb > 0 ? (ds.reduce((s, d) => s + d.apr * d.balance, 0) / tb).toFixed(2) + '%' : '') + '</td><td class="n">' + (tl ? F.cell(tl) : '') + '</td><td class="n">' + (tl ? (tlb / tl * 100).toFixed(0) + '%' : '') + '</td><td class="n">' + F.cell(tm) + '</td><td class="n">' + F.cell(ti) + '</td></tr>';
  const head = th([t('Debt (부채)'), t('Type (종류)'), t('Balance (잔액)'), 'APR', t('Limit (한도)'), t('Used (사용률)'), t('Min. payment (최소 납입)'), t('Interest / mo (월 이자)')], 2);
  let plan = '';
  const P = D.payoff, P0 = D.payoffMin;
  if (P && P.months) {
    const stratName = D.plan.strategy === 'snowball' ? 'Snowball — smallest balance first (눈덩이 — 잔액 작은 것부터)' : 'Avalanche — highest rate first (눈사태 — 이율 높은 것부터)';
    const end = (n) => monthShort(V.addMonths(D.ym, n));
    const saved = P0 && !P0.neverEnds ? P0.totalInterest - P.totalInterest : null;
    const extra = Number(D.plan.extra) || 0;
    plan = '<div class="payoff"><h3>' + t('Payoff plan (상환 계획)') + '</h3><div class="pgrid">'
      + '<div><span>' + t('Strategy (방식)') + '</span><b>' + t(stratName) + '</b></div>'
      + '<div><span>' + t('Monthly payment (월 상환액)') + '</span><b>' + F.money(P.monthlyBudget) + (extra ? ' <small>(' + t('incl. extra (추가 포함)') + ' ' + F.money(extra) + ')</small>' : '') + '</b></div>'
      + '<div><span>' + t('Debt-free (상환 완료)') + '</span><b>' + (P.neverEnds ? t('Not within 50 years (50년 안에 끝나지 않음)') : esc(end(P.months)) + ' <small>· ' + P.months + ' ' + esc(tr('months (개월)')) + '</small>') + '</b></div>'
      + '<div><span>' + t('Total interest (총 이자)') + '</span><b>' + F.money(P.totalInterest) + '</b></div>'
      + (extra > 0 && saved !== null ? '<div><span>' + t('Interest saved vs minimums (최소 납입 대비 절약)') + '</span><b class="good">' + F.money(saved) + '</b></div>' : '')
      + '</div>'
      + (P.order.length ? '<ol class="porder">' + P.order.slice(0, 8).map((o) => { const a = D.accMap.get(String(o.id)); return '<li><span>' + esc(a ? accName(a) : o.name) + '</span><b>' + esc(end(o.month)) + '</b></li>'; }).join('') + '</ol>' : '')
      + '</div>';
  }
  return tbl('debt', ['24%', '13%', '13%', '9%', '12%', '7.5%', '11.5%', '10%'], head, body, foot) + plan
    + '<p class="fn">' + t('Minimum payments use loan schedules where set, otherwise 3% of card/LOC balances; APR and limits come from Wealth → Debts (최소 납입은 대출 상환표 또는 카드 잔액의 3% · 이율과 한도는 Wealth → Debts 설정)') + '</p>';
}

// 7) 12개월 추이
function trendSec(D, F) {
  const s = D.series;
  const any = s.some((x) => x.income || x.expense) || D.nw.some((v) => Math.abs(v) > 0.004);
  if (!any) return emptyNote('Trends appear after the first month of records (첫 달 기록 후 추이가 나와요)');
  const legend = '<div class="legend"><span><i class="b-in"></i>' + t('Income (수입)') + '</span><span><i class="b-out"></i>' + t('Spending (지출)') + '</span></div>';
  let rows = '';
  s.forEach((x, i) => {
    rows += '<tr class="ln' + (x.ym === D.ym ? ' cur' : '') + '"><td>' + esc(monthCol(x.ym)) + '</td><td class="n">' + F.cell(x.income) + '</td><td class="n">' + F.cell(x.expense) + '</td><td class="n">' + F.cell(x.net) + '</td><td class="n pct">' + (x.rate === null ? '<span class="na">—</span>' : pctTxt(x.rate)) + '</td><td class="n">' + F.cell(D.nw[i]) + '</td></tr>';
  });
  const ti = s.reduce((a, x) => a + x.income, 0), te = s.reduce((a, x) => a + x.expense, 0);
  const act = s.filter((x) => x.income || x.expense).length || 1;
  const foot = '<tr class="sub"><td>' + t('12-month total (12개월 합계)') + '</td><td class="n">' + F.cell(ti) + '</td><td class="n">' + F.cell(te) + '</td><td class="n">' + F.cell(ti - te) + '</td><td class="n pct">' + (ti > 0 ? pctTxt((ti - te) / ti * 100) : '—') + '</td><td class="n">' + chg(F, D.nw[D.nw.length - 1] - D.nw[0], true, 'amt') + '</td></tr>'
    + '<tr class="rate"><td>' + t('Monthly average (월평균)') + '</td><td class="n">' + F.cell(ti / act) + '</td><td class="n">' + F.cell(te / act) + '</td><td class="n">' + F.cell((ti - te) / act) + '</td><td></td><td></td></tr>';
  const head = th([t('Month (월)'), t('Income (수입)'), t('Spending (지출)'), t('Net (순수입)'), t('Savings rate (저축률)'), t('Net worth (순자산)')]);
  return '<div class="charts"><figure class="fig"><figcaption>' + t('Income vs spending (수입 vs 지출)') + legend + '</figcaption>' + barChart(s) + '</figure>'
    + '<figure class="fig"><figcaption>' + t('Net worth at month-end (월말 순자산)') + '</figcaption>' + lineChart(D.ms12, D.nw) + '</figure></div>'
    + tbl('trend', ['24%', '15.5%', '15.5%', '15%', '13%', '17%'], head, rows, foot);
}

// 8) 업체 · 사람
function vendorsPeopleSec(D, F) {
  let out = '';
  const vs = D.vendors;
  if (vs.length) {
    const tot = D.vendorAll.reduce((s, v) => s + v.total, 0);
    let body = '';
    vs.forEach((v, i) => {
      const y = D.vendorsYtd.get(v.key);
      const cat = D.accMap.get(String((Array.from(D.accMap.values()).find((a) => a.name === v.cat) || {}).account_id));
      body += '<tr class="ln"><td class="rk">' + (i + 1) + '</td><td class="mer"><span>' + esc(cleanMerchant(v.name)) + '</span></td><td class="muted cat"><span>' + esc(cat ? accName(cat) : v.cat) + '</span></td><td class="n">' + v.count + '</td><td class="n">' + F.cell(v.total) + '</td><td class="n pct">' + (tot > 0 ? (v.total / tot * 100).toFixed(1) + '%' : '') + '</td><td class="n">' + F.cell(y ? y.total : v.total) + '</td></tr>';
    });
    const top = vs.reduce((s, v) => s + v.total, 0);
    const foot = '<tr class="sub"><td></td><td>' + t('Top merchants (상위 업체)') + ' ' + vs.length + ' / ' + D.vendorAll.length + '</td><td></td><td class="n">' + vs.reduce((s, v) => s + v.count, 0) + '</td><td class="n">' + F.cell(top) + '</td><td class="n pct">' + (tot > 0 ? (top / tot * 100).toFixed(1) + '%' : '') + '</td><td></td></tr>';
    out += '<div class="keep"><h3>' + t('Top merchants this month (이번 달 상위 업체)') + '</h3>' + tbl('ven', ['4%', '33%', '23%', '7%', '12%', '8%', '13%'], th(['#', t('Merchant (업체)'), t('Category (항목)'), t('Count (건수)'), esc(monthCol(D.ym)), t('Share (비중)'), t('Year to date (연간 누계)')], 3), body, foot) + '</div>';
  } else out += '<h3>' + t('Top merchants this month (이번 달 상위 업체)') + '</h3>' + emptyNote('No merchant spending this month (이번 달 업체 지출이 없어요)');
  const os = Array.from(D.owners.values()).filter((e) => Math.abs(e.income) > 0.004 || Math.abs(e.expense) > 0.004).sort((a, b) => b.expense - a.expense);
  if (os.length) {
    const te = os.reduce((s, e) => s + e.expense, 0), ti = os.reduce((s, e) => s + e.income, 0);
    let body = '';
    os.forEach((e) => {
      const p = D.ownersPrev.get(e.owner), y = D.ownersYtd.get(e.owner);
      const pe = p ? p.expense : 0;
      body += '<tr class="ln"><td>' + esc(e.owner === 'Joint' ? tr('Joint (공동)') : e.owner) + '</td><td class="n">' + F.cell(e.income) + '</td><td class="n">' + F.cell(e.expense) + '</td><td class="n pct">' + (te > 0 ? (e.expense / te * 100).toFixed(1) + '%' : '') + '<span class="sbar"><span style="width:' + (te > 0 ? Math.max(0, e.expense / te * 100).toFixed(1) : 0) + '%"></span></span></td><td class="n">' + chg(F, e.expense - pe, false, 'amt') + '</td><td class="n">' + F.cell(y ? y.expense : 0) + '</td></tr>';
    });
    const foot = '<tr class="net"><td>' + t('Total (합계)') + '</td><td class="n">' + F.cell(ti) + '</td><td class="n">' + F.cell(te) + '</td><td class="n pct">100%</td><td class="n">' + chg(F, te - Array.from(D.ownersPrev.values()).reduce((s, e) => s + e.expense, 0), false, 'amt') + '</td><td class="n">' + F.cell(Array.from(D.ownersYtd.values()).reduce((s, e) => s + e.expense, 0)) + '</td></tr>';
    out += '<div class="keep"><h3>' + t('Spending by person (사람별 지출)') + '</h3>' + tbl('ppl', ['24%', '15%', '15%', '18%', '13%', '15%'], th([t('Person (사람)'), t('Income (수입)'), t('Spending (지출)'), t('Share (비중)'), t('vs prior (전월 대비)'), t('Year to date (연간 누계)')]), body, foot)
      + '<p class="fn">' + t('Split lines are attributed to the person on each line; otherwise to the transaction owner (나눈 줄은 줄마다의 사람, 아니면 거래의 사람 기준)') + '</p></div>';
  }
  return out;
}
const cleanMerchant = (s) => String(s || '').replace(/\s{2,}/g, ' ').replace(/\s+#?\d{3,}.*$/, (m) => (m.length > 18 ? '' : m)).trim();

// 9) 메모 · 고지
function notesSec(D) {
  const note = String(D.note || '').trim();
  return (note ? '<div class="note"><h3>' + t('Month note (이번 달 메모)') + '</h3><p>' + esc(note).replace(/\n/g, '<br>') + '</p></div>' : '')
    + '<div class="disc"><p><b>' + t('Basis of preparation (작성 기준)') + '</b> ' + bi('Figures are prepared from the household ledger on a double-entry basis in Canadian dollars. Foreign-currency transactions are converted at the recorded rate. Balances for loans, property, vehicles and investments may reflect schedules or market values rather than book balances.', '가계부 복식부기 기록을 캐나다 달러로 정리한 숫자입니다. 외화 거래는 기록된 환율로 바꿨고, 대출·부동산·차량·투자 잔액은 상환표나 시세로 평가한 값일 수 있습니다.') + '</p>'
    + '<p><b>' + t('Disclaimer (고지)') + '</b> ' + t('Personal budgeting tool — not financial advice (개인 가계부 도구 — 투자 · 재무 자문이 아닙니다)') + '. ' + bi('Advisor notes are rule-based suggestions for discussion only.', '조언은 규칙에 따른 참고 의견입니다.') + '</p>'
    + '<p class="gen">' + t('Generated by Home Ledger (Home Ledger 에서 생성)') + ' · ' + esc(dateLong(D.today)) + ' · ' + D.txCount + ' ' + t('transactions this month (이번 달 거래)') + '</p></div>';
}

// ───────── 스타일 ─────────
const CSS = (footL) => `
@page { size: letter; margin: 0.55in 0.6in 0.62in;
  @bottom-left { content: "${footL}"; font: 7pt -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; color: #6a737d; vertical-align: top; padding-top: 6pt; }
  @bottom-right { content: counter(page) " / " counter(pages); font: 7pt -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; color: #6a737d; vertical-align: top; padding-top: 6pt; }
}
.hlr { --g: #007a33; --g2: #00561f; --gl: #e8f3ea; --ink: #1d232a; --mu: #5f6b76; --rule: #cfd6dc; --rule2: #e6eaee; --good: #18794e; --bad: #c0362c; --warn: #b7791f; --fill: #f5f7f8;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", Roboto, Helvetica, Arial, sans-serif;
  color: var(--ink); background: #fff; font-size: 8.6pt; line-height: 1.38; -webkit-print-color-adjust: exact; print-color-adjust: exact; font-variant-numeric: tabular-nums lining-nums; }
.hlr * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.hlr h1, .hlr h2, .hlr h3, .hlr p, .hlr ul, .hlr ol, .hlr dl, .hlr figure { margin: 0; padding: 0; }
.hlr .ko { display: block; color: var(--mu); font-size: .93em; }
.hlr .muted { color: var(--mu); }
.hlr .good { color: var(--good); } .hlr .bad { color: var(--bad); } .hlr .warnc { color: var(--warn); }
.hlr .na, .hlr .zero, .hlr .flat { color: #a3acb5; }
.hlr .pp { visibility: hidden; }
/* 표지 */
.hlr .cover { border-top: 5pt solid var(--g); padding: 12pt 0 10pt; border-bottom: .75pt solid var(--rule); margin-bottom: 12pt; display: grid; grid-template-columns: 1fr auto; column-gap: 18pt; }
.hlr .brand { grid-column: 1 / -1; display: flex; align-items: center; gap: 7pt; font-size: 7.4pt; letter-spacing: .14em; color: var(--g2); font-weight: 700; margin-bottom: 8pt; }
.hlr .logo { display: inline-grid; place-items: center; width: 17pt; height: 17pt; border-radius: 3pt; background: var(--g); color: #fff; font-size: 7.4pt; letter-spacing: 0; }
.hlr .conf { margin-left: auto; font-weight: 600; color: var(--mu); letter-spacing: .06em; text-transform: uppercase; font-size: 6.6pt; }
.hlr h1 { grid-column: 1; font-size: 18pt; line-height: 1.15; font-weight: 700; letter-spacing: -.01em; color: #111; }
.hlr .period { grid-column: 1; font-size: 13pt; color: var(--g); font-weight: 600; margin-top: 3pt; }
.hlr .meta { grid-column: 1; display: flex; flex-wrap: wrap; gap: 4pt 20pt; margin-top: 10pt; }
.hlr .meta dt { font-size: 6.6pt; text-transform: uppercase; letter-spacing: .08em; color: var(--mu); font-weight: 600; }
.hlr .meta dd { margin: 1pt 0 0; font-weight: 600; font-size: 8.6pt; }
.hlr .toc { grid-column: 2; grid-row: 2 / span 3; list-style: none; border-left: .75pt solid var(--rule); padding-left: 12pt; font-size: 7.6pt; color: var(--mu); align-self: start; }
.hlr .toc li { padding: 1.2pt 0; white-space: nowrap; }
.hlr .toc span { display: inline-block; width: 15pt; color: var(--g); font-weight: 700; }
/* 섹션 */
.hlr .sec { margin-top: 16pt; }
.hlr .sec.pb { break-before: page; page-break-before: always; margin-top: 0; }
.hlr .sh { display: flex; align-items: baseline; gap: 8pt; border-bottom: 1.4pt solid var(--g); padding-bottom: 3.5pt; margin-bottom: 8pt; break-after: avoid; page-break-after: avoid; }
.hlr .sn { font-size: 9pt; font-weight: 800; color: var(--g); }
.hlr h2 { font-size: 12.5pt; font-weight: 700; letter-spacing: -.005em; }
.hlr .ss { margin-left: auto; font-size: 7.4pt; color: var(--mu); }
.hlr h3 { font-size: 8.4pt; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--g2); margin: 10pt 0 5pt; break-after: avoid; page-break-after: avoid; }
/* KPI */
.hlr .kpis { display: grid; grid-template-columns: repeat(3, 1fr); border: .75pt solid var(--rule); border-radius: 4pt; overflow: hidden; break-inside: avoid; }
.hlr .kpi { padding: 8pt 10pt 8pt; border-right: .75pt solid var(--rule2); border-bottom: .75pt solid var(--rule2); min-height: 52pt; }
.hlr .kpi:nth-child(3n) { border-right: 0; } .hlr .kpi:nth-child(n+4) { border-bottom: 0; }
.hlr .kpi.hero { background: var(--gl); }
.hlr .kl { font-size: 6.8pt; text-transform: uppercase; letter-spacing: .07em; color: var(--mu); font-weight: 600; }
.hlr .kv { font-size: 15pt; font-weight: 700; margin-top: 2pt; letter-spacing: -.01em; white-space: nowrap; }
.hlr .kv small { font-size: 8pt; color: var(--mu); font-weight: 600; margin-left: 2pt; }
.hlr .ks { font-size: 7.2pt; color: var(--mu); margin-top: 2pt; }
.hlr .chg { font-weight: 600; white-space: nowrap; }
.hlr .headline { margin-top: 9pt; padding: 7pt 10pt; background: var(--fill); border-left: 2.5pt solid var(--g); font-size: 8.6pt; break-inside: avoid; }
.hlr .two { display: grid; grid-template-columns: 1.08fr 1fr; gap: 16pt; margin-top: 2pt; }
.hlr .obs ul, .hlr .tips ul { list-style: none; }
.hlr .obs li, .hlr .tips li { position: relative; padding: 2.6pt 0 2.6pt 11pt; border-bottom: .5pt solid var(--rule2); break-inside: avoid; }
.hlr .obs li:before, .hlr .tips li:before { content: ""; position: absolute; left: 0; top: 6.4pt; width: 5pt; height: 5pt; border-radius: 50%; background: #9aa5b1; }
.hlr li.o-good:before { background: var(--good); } .hlr li.o-bad:before { background: var(--bad); } .hlr li.o-warn:before { background: var(--warn); } .hlr li.o-n:before { background: var(--g); }
.hlr .goal { display: block; font-size: 6.6pt; color: var(--mu); padding-left: 11pt; }
.hlr .hk { white-space: nowrap; font-weight: 500; color: var(--mu); font-size: .72em; margin-left: 4pt; letter-spacing: 0; }
.hlr .side .mini { margin-top: 2pt; } .hlr .side h3:first-child, .hlr .obs h3:first-child { margin-top: 10pt; }
.hlr .tips li { font-size: 7.8pt; } .hlr .tips em { color: var(--mu); font-style: normal; display: block; }
.hlr .mix { break-inside: avoid; }
.hlr .mixbar { display: flex; height: 9pt; border-radius: 2pt; overflow: hidden; background: var(--rule2); }
.hlr .mixbar span { display: block; height: 100%; border-right: .75pt solid #fff; }
.hlr .mixleg { display: flex; flex-wrap: wrap; gap: 3pt 10pt; margin-top: 4pt; font-size: 7.3pt; color: var(--mu); }
.hlr .mixleg i { display: inline-block; width: 6.5pt; height: 6.5pt; border-radius: 1.5pt; margin-right: 3pt; vertical-align: -.5pt; }
.hlr .mixleg b { color: var(--ink); }
/* 표 */
.hlr table.ft { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 8pt; }
.hlr .ft thead { display: table-header-group; }
.hlr .ft tfoot { display: table-row-group; }
.hlr .ft th { font-size: 6.7pt; text-transform: uppercase; letter-spacing: .05em; color: var(--mu); font-weight: 700; text-align: left; padding: 4pt 5pt 3.5pt; border-bottom: 1pt solid var(--ink); vertical-align: bottom; line-height: 1.25; }
.hlr .ft th.n { text-align: right; }
.hlr .ft td { padding: 2.4pt 5pt; border-bottom: .5pt solid var(--rule2); vertical-align: top; overflow: hidden; text-overflow: ellipsis; }
.hlr .ft td.n { text-align: right; white-space: nowrap; }
.hlr .ft tr { break-inside: avoid; page-break-inside: avoid; }
.hlr .ft tbody.g { break-inside: avoid; page-break-inside: avoid; }
.hlr .ft tbody.tot { break-inside: avoid; page-break-inside: avoid; }
.hlr .ft tr.ind td:first-child { padding-left: 14pt; }
.hlr .ft tr.hd td { font-weight: 800; font-size: 7.6pt; text-transform: uppercase; letter-spacing: .06em; color: var(--g2); padding-top: 6pt; border-bottom: .75pt solid var(--rule); }
.hlr .ft tr.grp td { font-weight: 700; background: var(--fill); border-bottom: .5pt solid var(--rule); }
.hlr .ft tr.sub td { font-weight: 700; border-top: .75pt solid var(--ink); border-bottom: .75pt solid var(--rule); }
.hlr .ft tr.net td { font-weight: 800; border-top: .75pt solid var(--ink); border-bottom: 2.2pt double var(--ink); background: var(--gl); font-size: 8.4pt; }
.hlr .ft tr.rate td { color: var(--mu); font-style: italic; border-bottom: 0; }
.hlr .ft tr.gap td { border: 0; padding: 2pt; }
.hlr .ft tr.cur td { background: var(--gl); font-weight: 700; }
.hlr .ft td.neg { color: var(--bad); }
.hlr .ft .pct { font-size: 7.4pt; }
.hlr .sw { display: inline-block; width: 5pt; height: 9pt; border-radius: 1pt; margin-right: 5pt; vertical-align: -1.5pt; }
.hlr .dot { display: inline-block; width: 6pt; height: 6pt; border-radius: 50%; margin-right: 5pt; background: #9aa5b1; vertical-align: 0; }
.hlr .dot.good { background: var(--good); } .hlr .dot.warn { background: var(--warn); } .hlr .dot.bad { background: var(--bad); }
.hlr .mini { margin-top: 10pt; font-size: 7.6pt; } .hlr .mini td { padding: 2.2pt 4pt; }
.hlr .own { font-size: 6.6pt; color: var(--mu); border: .5pt solid var(--rule); border-radius: 6pt; padding: 0 3.5pt; margin-left: 3pt; font-weight: 500; }
.hlr sup { color: var(--g); font-weight: 700; }
.hlr .tag { font-size: 6.4pt; color: var(--mu); font-style: italic; }
.hlr tr.unb td { color: var(--mu); }
.hlr .ubar { display: block; height: 5pt; background: var(--rule2); border-radius: 3pt; overflow: hidden; margin-top: 2.5pt; }
.hlr .ubar span { display: block; height: 100%; background: var(--good); }
.hlr .ubar .near { background: var(--warn); } .hlr .ubar .over { background: var(--bad); }
.hlr span.over { color: var(--bad); font-weight: 700; } .hlr span.near { color: var(--warn); font-weight: 700; }
.hlr td.barc { padding-right: 2pt; }
.hlr .sbar { display: inline-block; width: 34pt; height: 4.5pt; background: var(--rule2); border-radius: 2pt; overflow: hidden; margin-left: 5pt; vertical-align: 0; }
.hlr .sbar span { display: block; height: 100%; background: var(--g); }
.hlr td.mer span, .hlr td.cat span { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hlr td.rk { color: var(--mu); }
.hlr .fn { font-size: 6.9pt; color: var(--mu); margin-top: 4pt; break-before: avoid; }
.hlr .empty { color: var(--mu); padding: 9pt 10pt; background: var(--fill); border-radius: 3pt; font-style: italic; }
.hlr .facts { display: grid; grid-template-columns: repeat(4, 1fr); border: .75pt solid var(--rule); border-radius: 3pt; margin-bottom: 8pt; break-inside: avoid; }
.hlr .facts div { padding: 5pt 8pt; border-right: .75pt solid var(--rule2); }
.hlr .facts div:last-child { border-right: 0; }
.hlr .facts span, .hlr .pgrid span { display: block; font-size: 6.6pt; text-transform: uppercase; letter-spacing: .06em; color: var(--mu); font-weight: 600; }
.hlr .facts b { font-size: 10pt; }
.hlr .payoff { margin-top: 4pt; border: .75pt solid var(--rule); border-radius: 3pt; padding: 0 10pt 8pt; break-inside: avoid; }
.hlr .pgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6pt 14pt; }
.hlr .pgrid b { font-size: 8.8pt; } .hlr .pgrid small { color: var(--mu); font-weight: 500; }
.hlr .porder { list-style: none; counter-reset: po; display: grid; grid-template-columns: repeat(2, 1fr); gap: 0 18pt; margin-top: 7pt; border-top: .5pt solid var(--rule2); padding-top: 4pt; font-size: 7.6pt; }
.hlr .porder li { counter-increment: po; display: flex; justify-content: space-between; padding: 1.6pt 0; border-bottom: .5pt dotted var(--rule); }
.hlr .porder li span:before { content: counter(po) ". "; color: var(--g); font-weight: 700; }
/* 차트 */
.hlr .charts { display: grid; grid-template-columns: 1fr; gap: 8pt; margin-bottom: 8pt; }
.hlr .fig { break-inside: avoid; border: .75pt solid var(--rule2); border-radius: 3pt; padding: 6pt 8pt 2pt; }
.hlr figcaption { font-size: 7.6pt; font-weight: 700; color: var(--ink); display: flex; align-items: center; gap: 12pt; }
.hlr .legend { margin-left: auto; display: flex; gap: 10pt; font-weight: 500; color: var(--mu); font-size: 7.2pt; }
.hlr .legend i { display: inline-block; width: 8pt; height: 8pt; border-radius: 1.5pt; margin-right: 3pt; vertical-align: -1pt; }
.hlr .legend i.b-in { background: var(--g); } .hlr .legend i.b-out { background: #a7b3bf; }
.hlr svg.chart { width: 100%; height: auto; display: block; }
.hlr svg .grid { stroke: #e3e8ec; stroke-width: .8; } .hlr svg .axis { stroke: #8a96a3; stroke-width: 1; }
.hlr svg text { font-family: inherit; font-size: 9.5px; fill: #6a737d; }
.hlr svg .yl { text-anchor: end; } .hlr svg .xl { text-anchor: middle; }
.hlr svg .b-in { fill: #007a33; } .hlr svg .b-out { fill: #a7b3bf; }
.hlr svg .ln { fill: none; stroke: #007a33; stroke-width: 2; stroke-linejoin: round; }
.hlr svg .area { fill: #007a33; fill-opacity: .08; }
.hlr svg .dot { fill: #fff; stroke: #007a33; stroke-width: 1.4; } .hlr svg .dot.last { fill: #007a33; }
.hlr svg .endl { font-weight: 700; fill: #1d232a; font-size: 10px; }
/* 메모 */
.hlr .note { border: .75pt solid var(--rule); border-left: 2.5pt solid var(--g); padding: 2pt 10pt 8pt; margin-top: 4pt; break-inside: avoid; }
.hlr .note h3 { margin-top: 6pt; }
.hlr .disc { margin-top: 12pt; padding-top: 6pt; border-top: .75pt solid var(--rule); font-size: 7.2pt; color: var(--mu); break-inside: avoid; }
.hlr .disc p { margin-bottom: 4pt; } .hlr .disc b { color: var(--ink); }
.hlr .disc .ko { display: inline; margin-left: 3pt; }
.hlr .disc .gen { margin-top: 6pt; font-size: 6.8pt; }
.hlr .keep { break-inside: avoid; }
@media screen { .hlr { max-width: 7.3in; margin: 24px auto; } }
`;

// ───────── 조립 ─────────
const SECTIONS = {
  trend: { title: 'Performance trends — 12 months (12개월 추이)', fn: trendSec },
  is: { title: 'Income statement (손익계산서)', fn: incomeStatementSec },
  bs: { title: 'Balance sheet (재무상태표)', fn: balanceSheetSec },
  budget: { title: 'Budget vs actual (예산 대비 실적)', fn: budgetSec },
  debt: { title: 'Debt & payoff (부채 · 상환)', fn: debtSec },
  vendors: { title: 'Merchants & people (업체 · 사람별)', fn: vendorsPeopleSec },
  notes: { title: 'Notes (메모 · 고지)', fn: notesSec }
};
const TAB_FOCUS = { reports: 'is', wealth: 'bs', plan: 'budget', txns: 'vendors', accounts: 'bs' };

export function buildReportHtml(api, opts) {
  opts = opts || {};
  const D = collect(api, opts);
  const F = makeFmt(rounded());
  let order = ['trend', 'is', 'bs', 'budget', 'debt', 'vendors', 'notes'];
  const focus = TAB_FOCUS[opts.tab];
  if (focus) order = [focus].concat(order.filter((k) => k !== focus));
  // 큰 섹션은 새 쪽에서 시작 (작은 섹션은 이어서)
  // 기록이 거의 없으면(새 사용자) 쪽 나눔 없이 이어서
  const breakers = D.items.length >= 15 ? new Set(['is', 'bs']) : new Set();
  const secs = [{ id: 'exec', title: 'Executive summary (요약)' }].concat(order.map((k) => ({ id: k, title: SECTIONS[k].title })));
  let body = coverBlock(D, F, secs);
  body += section('exec', 1, 'Executive summary (요약)', esc(monthLong(D.ym)) + ' · ' + t('vs prior month (전월 대비)'), execSummary(D, F), 'first');
  order.forEach((k, i) => {
    const cls = ((i === 0 && D.items.length >= 15) || breakers.has(k)) ? 'pb' : '';
    let sub = '';
    if (k === 'is') sub = t('CAD, for the month and year to date (월간 · 연간 누계)');
    else if (k === 'bs') sub = t('As at month-end (월말 기준)') + ' · ' + esc(dateLong(D.bs.asOf));
    else if (k === 'trend') sub = esc(monthShort(D.ms12[0])) + ' – ' + esc(monthShort(D.ym));
    else if (k === 'budget') sub = esc(monthLong(D.ym));
    else if (k === 'debt') sub = t('As at month-end (월말 기준)');
    body += section(k, i + 2, SECTIONS[k].title, sub, SECTIONS[k].fn(D, F), cls + (focus === k ? ' focus' : ''));
  });
  const footL = ('Home Ledger · ' + tr('Monthly Financial Report (월간 재무 보고서)') + ' · ' + monthShort(D.ym) + ' · ' + tr('Private & confidential (대외비)')).replace(/["\\]/g, '');
  const title = 'Home Ledger Report ' + D.ym;
  const lg = lang() === 'en' ? 'en' : 'ko';
  return '<!doctype html><html lang="' + lg + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + esc(title) + '</title>'
    + '<style>' + CSS(footL) + 'html,body{margin:0;padding:0;background:#fff;}</style></head><body><div class="hlr" data-month="' + esc(D.ym) + '">' + body + '</div></body></html>';
}

/** 인쇄용 CSS 와 본문만 (iOS 처럼 iframe 인쇄가 불안정한 곳에서 현재 문서에 넣어 인쇄할 때) */
function splitHtml(html) {
  const css = (/<style>([\s\S]*?)<\/style>/.exec(html) || ['', ''])[1];
  const body = (/<body>([\s\S]*)<\/body>/.exec(html) || ['', ''])[1];
  return { css, body };
}

const isIOS = () => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
};

let cleanup = null;

/**
 * 종합 보고서를 만들어 인쇄(PDF 미리보기)를 엽니다.
 * opts: { tab, month, mode: 'iframe' | 'inline' }  (mode 를 안 주면 iOS 는 inline, 나머지는 iframe)
 */
export function openPrintReport(api, opts) {
  opts = opts || {};
  const toast = (m) => { try { if (api && typeof api.toast === 'function') api.toast(m); } catch (e) { /* ignore */ } };
  if (cleanup) { try { cleanup(); } catch (e) { /* ignore */ } cleanup = null; }
  let html;
  try { html = buildReportHtml(api, opts); } catch (e) {
    console.error(e);
    toast(tr('Could not build the report (보고서를 만들지 못했어요)') + ': ' + (e && e.message ? e.message : e));
    return Promise.resolve(false);
  }
  const doc = document;
  const oldTitle = doc.title;
  const ym = (/data-month="([^"]+)"/.exec(html) || ['', ''])[1];
  const pdfName = 'HomeLedger_Report_' + ym;
  const mode = opts.mode || (isIOS() ? 'inline' : 'iframe');
  return new Promise((resolve) => {
    let done = false, timer = null;
    const finish = (removeNow) => {
      if (done) return; done = true;
      clearTimeout(timer);
      doc.title = oldTitle;
      cleanup = removeNow;
      // 인쇄 창이 닫힌 뒤 조금 있다가 지웁니다 (Safari 는 afterprint 후에도 잠깐 문서를 씁니다)
      setTimeout(() => { if (cleanup === removeNow) { try { removeNow(); } catch (e) { /* ignore */ } cleanup = null; } }, 1500);
    };
    try {
      if (mode === 'inline') {
        const { css, body } = splitHtml(html);
        const style = doc.createElement('style');
        style.id = 'hl-print-style';
        style.textContent = css + '\n@media screen { #hl-print-root { display: none !important; } }\n@media print { html, body { background: #fff !important; color: #000 !important; margin: 0 !important; padding: 0 !important; height: auto !important; overflow: visible !important; } body > *:not(#hl-print-root) { display: none !important; } #hl-print-root { display: block !important; } }';
        const root = doc.createElement('div');
        root.id = 'hl-print-root';
        root.innerHTML = body;
        doc.head.appendChild(style);
        doc.body.appendChild(root);
        const remove = () => { style.remove(); root.remove(); };
        cleanup = remove;
        const onAfter = () => { window.removeEventListener('afterprint', onAfter); finish(remove); };
        window.addEventListener('afterprint', onAfter);
        doc.title = pdfName;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          try { window.print(); } catch (e) { toast(tr('Printing is not available here (여기서는 인쇄할 수 없어요)')); }
          timer = setTimeout(() => finish(remove), 120000);
          resolve(true);
        }));
        return;
      }
      const frame = doc.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('title', 'print');
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:8.5in;height:11in;border:0;opacity:0;pointer-events:none;z-index:-1;';
      doc.body.appendChild(frame);
      const remove = () => frame.remove();
      cleanup = remove;
      const w = frame.contentWindow;
      const fd = w.document;
      fd.open(); fd.write(html); fd.close();
      const go = () => {
        const onAfter = () => { w.removeEventListener('afterprint', onAfter); finish(remove); };
        w.addEventListener('afterprint', onAfter);
        doc.title = pdfName;
        try { w.focus(); w.print(); } catch (e) {
          toast(tr('Printing is not available here (여기서는 인쇄할 수 없어요)'));
          finish(remove); resolve(false); return;
        }
        // print() 가 막히지 않는 브라우저를 위한 안전장치
        timer = setTimeout(() => finish(remove), 120000);
        resolve(true);
      };
      const ready = fd.fonts && fd.fonts.ready ? fd.fonts.ready : Promise.resolve();
      Promise.race([ready, new Promise((r) => setTimeout(r, 600))]).then(() => {
        (w.requestAnimationFrame || setTimeout)(() => (w.requestAnimationFrame || setTimeout)(go));
      });
    } catch (e) {
      console.error(e);
      doc.title = oldTitle;
      toast(tr('Could not open the print preview (인쇄 미리보기를 열지 못했어요)') + ': ' + (e && e.message ? e.message : e));
      resolve(false);
    }
  });
}
