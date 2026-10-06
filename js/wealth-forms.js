// Wealth(자산·부채) 화면의 순수 도우미: 입력 검사(한국어 오류 메시지) · 미리보기 계산 · 시세 환산 · 발생 시계열.
// 화면(wealth.js)과 테스트가 같은 계산을 쓰도록 DOM 과 분리했습니다.
import * as L from './ledger.js';
import * as V from './valuation.js';
import * as FX from './fx.js';

export const r2 = (v) => Math.round(v * 100) / 100;
export const r4 = (v) => Math.round(v * 10000) / 10000;
const r3 = (v) => Math.round(v * 1000) / 1000;
const nz = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// ───────── 입력 읽기 ─────────
/** '' → null (비어 있음), 잘못된 글자 → NaN, 그 밖에는 숫자. "1,200", "$1200", "12%", "300*12" 도 읽습니다. */
export function parseNum(text) {
  const s = String(text === undefined || text === null ? '' : text).trim().replace(/%/g, '');
  if (!s) return null;
  return L.parseAmount(s);
}
export const isYm = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
export function isDate(s) {
  s = String(s || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
const normYm = (s) => { s = String(s || '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(0, 7) : s; };

function Res() {
  const errors = {};
  let first = '';
  return {
    err(field, msg) { if (!(field in errors)) errors[field] = msg; if (!first) first = msg; },
    bad() { return Object.keys(errors).length > 0; },
    out(extra) { return this.bad() ? { ok: false, errors, first } : Object.assign({ ok: true, errors: {}, first: '' }, extra); }
  };
}
const badNum = (v) => typeof v === 'number' && Number.isNaN(v);

// ───────── 집·차 ─────────
export const METHODS = [['dep', 'Declining %', '정률 감가'], ['sl', 'Straight-line', '정액'], ['ap', 'Appreciation %', '연 상승']];
export const METHOD_NAME = { dep: 'Declining (정률 감가)', sl: 'Straight-line (정액)', ap: 'Appreciation (연 상승)' };

export function checkAsset(f) {
  const R = Res();
  const method = ['dep', 'sl', 'ap'].indexOf(f.method) >= 0 ? f.method : 'dep';
  const cost = parseNum(f.cost), ov = parseNum(f.override), rate = parseNum(f.rate), sal = parseNum(f.salvage), life = parseNum(f.life);
  const date = String(f.date || '').trim();
  if (badNum(cost)) R.err('cost', '취득가는 숫자로 입력하세요. (예: 650000)');
  else if (cost !== null && !(cost > 0)) R.err('cost', '취득가는 0보다 커야 해요.');
  if (cost !== null && !badNum(cost) && cost > 0 && !isDate(date)) R.err('date', '취득일을 날짜로 입력하세요. (예: 2021-06-15)');
  if (badNum(ov)) R.err('override', '직접 입력 가치는 숫자로 입력하세요. 지우면 공식으로 돌아가요.');
  else if (ov !== null && ov < 0) R.err('override', '직접 입력 가치는 0 이상이어야 해요.');
  if (cost === null && ov === null) R.err('cost', '취득가나 직접 입력 가치 중 하나는 꼭 넣어 주세요.');
  if (method !== 'sl') {
    if (rate === null || badNum(rate)) R.err('rate', method === 'ap' ? '연 상승률(%)을 숫자로 입력하세요. (예: 3)' : '연 감가율(%)을 숫자로 입력하세요. 변화가 없으면 0 이에요. (예: 차 15)');
    else if (method === 'dep' && !(rate >= 0 && rate < 100)) R.err('rate', '감가율은 0 이상 100 미만으로 입력하세요.');
    else if (method === 'ap' && !(rate >= 0 && rate <= 100)) R.err('rate', '상승률은 0~100% 사이로 입력하세요. 값이 떨어지는 자산은 "Declining (정률 감가)" 을 고르세요.');
  }
  if (method !== 'ap') {
    if (badNum(sal)) R.err('salvage', '잔존가는 숫자로 입력하세요. (없으면 비워 두세요)');
    else if (sal !== null && sal < 0) R.err('salvage', '잔존가는 0 이상이어야 해요.');
    else if (sal !== null && cost !== null && !badNum(cost) && sal > cost) R.err('salvage', '잔존가가 취득가보다 클 수 없어요.');
  }
  if (method === 'sl' && (life === null || badNum(life) || !(life > 0 && life <= 100))) R.err('life', '내용연수(년)를 0 보다 크고 100 이하로 입력하세요. (예: 차 8, 집 40)');
  if (R.bad()) return R.out();
  const cfg = { method };
  if (cost !== null) { cfg.cost = r2(cost); cfg.date = date; }
  if (method !== 'sl') cfg.rate = r3(rate);
  if (method !== 'ap') cfg.salvage = sal === null ? 0 : r2(sal);
  if (method === 'sl') cfg.life = r3(life);
  if (ov !== null) cfg.override = r2(ov);
  return R.out({ cfg });
}

export const hasOverride = (cfg) => !!cfg && cfg.override !== undefined && cfg.override !== null && cfg.override !== '';

/** 그 달 말 기준으로 `years` 년 뒤의 가치. 직접 입력 가치가 있으면 그 값에서 같은 비율로 이어 계산합니다. */
export function projectAsset(cfg, ym, years) {
  if (!cfg) return null;
  const toYm = V.addMonths(ym, Math.round(nz(years) * 12));
  if (!hasOverride(cfg)) return V.assetValue(cfg, toYm);
  const base = nz(cfg.override), rate = nz(cfg.rate) / 100, sal = nz(cfg.salvage);
  if (cfg.method === 'ap') return r2(base * Math.pow(1 + rate, nz(years)));
  if (cfg.method === 'sl') {
    const life = nz(cfg.life) || 10;
    const elapsed = cfg.date ? V.yearsTo(cfg.date, ym) : 0;
    const remain = Math.max(life - elapsed, 1 / 12);
    return r2(Math.max(Math.min(sal, base), base - (base - sal) / remain * nz(years)));
  }
  return r2(Math.max(Math.min(sal, base), base * Math.pow(1 - rate, nz(years))));
}

/** 가치 추이 그래프용: 과거 `past` 개월 ~ 미래 `future` 개월 */
export function assetCurve(cfg, ym, past, future) {
  const from = V.addMonths(ym, -past), to = V.addMonths(ym, future);
  const labels = [], formula = [], cont = [];
  const noOv = Object.assign({}, cfg, { override: undefined });
  const canFormula = nz(cfg.cost) > 0;
  let i = 0;
  for (let m = from; m <= to; m = V.addMonths(m, 1), i++) {
    labels.push(m);
    formula.push(canFormula ? V.assetValue(noOv, m) : null);
    cont.push(i >= past && hasOverride(cfg) ? projectAsset(cfg, ym, (i - past) / 12) : null);
  }
  return { labels, formula, cont, nowIndex: past, canFormula };
}

// ───────── 대출 ─────────
export function checkLoan(f) {
  const R = Res();
  const p = parseNum(f.p), pmt = parseNum(f.pmt), months = parseNum(f.months), apr = parseNum(f.apr);
  const start = normYm(f.start);
  if (p === null || badNum(p) || !(p > 0)) R.err('p', '원금은 0보다 큰 숫자로 입력하세요. (예: 386200)');
  if (pmt === null || badNum(pmt) || !(pmt > 0)) R.err('pmt', '월 납입액은 0보다 큰 숫자로 입력하세요. 모르면 "월 납입액 계산" 버튼을 쓰세요.');
  if (!isYm(start)) R.err('start', '첫 납입 달을 골라 주세요. (예: 2024-03)');
  if (months === null || badNum(months) || !(months >= 1 && months <= 1200) || Math.round(months) !== months) R.err('months', '총 납입 횟수는 1~1200 사이의 정수로 입력하세요. (25년이면 300)');
  if (apr === null || badNum(apr) || !(apr >= 0 && apr <= 100)) R.err('apr', '이율(APR %)을 0~100 사이로 입력하세요. 이자가 없으면 0 이에요. 모르면 "금리 역산" 버튼을 쓰세요.');
  if (R.bad()) return R.out();
  const cfg = { p: r2(p), pmt: r2(pmt), start, months };
  const aprV = r3(apr);
  const warnings = [];
  if (V.loanUnderwater(cfg, aprV)) warnings.push('월 납입액이 이자(약 ' + L.fmtMoney(r2(cfg.p * aprV / 100 / 12)) + ')도 못 덮어서 잔액이 줄지 않아요. 납입액이나 이율을 확인하세요.');
  else {
    const left = V.loanBalanceAt(cfg, aprV, months);
    if (left > 0.5) warnings.push('정해진 ' + months + '회 안에 다 갚지 못하고 마지막에 ' + L.fmtMoney(r2(left)) + ' 가 남아요. 납입액이나 횟수를 확인하세요.');
  }
  return R.out({ cfg, apr: aprV, warnings });
}

/** 이번 달 이후에 남은 대출 (앞으로의 계산용). 이미 끝났으면 null, 아직 시작 전이면 전체. */
export function remainingLoan(cfg, apr, ym) {
  if (!V.loanReady(cfg)) return null;
  const n = V.loanTerm(cfg);
  const k0 = V.paymentsBy(cfg.start, ym);
  if (k0 <= 0) return Object.assign({}, cfg);
  const done = n ? Math.min(k0, n) : k0;
  const bal = V.loanBalanceAt(cfg, apr, done);
  if (bal <= 0.005) return null;
  return { p: r2(bal), pmt: cfg.pmt, start: V.addMonths(cfg.start.slice(0, 7), k0), months: n ? Math.max(n - k0, 1) : 0 };
}

/** 매달 `extra` 를 더 내면? (다음 납입부터) → 완납이 몇 개월 빨라지고 이자를 얼마 아끼는지 */
export function whatIf(cfg, apr, ym, extra) {
  const rem = remainingLoan(cfg, apr, ym);
  if (!rem) return null;
  const mk = (x) => {
    const c = Object.assign({}, rem, { pmt: r2(nz(rem.pmt) + x) });
    const under = V.loanUnderwater(c, apr);
    const k = under ? null : V.loanPayoffK(c, apr);
    return { cfg: c, under, k, interest: under ? null : V.loanTotalInterest(c, apr), end: under ? null : V.loanEnd(c, apr) };
  };
  const base = mk(0), plus = mk(Math.max(0, nz(extra)));
  const ok = !base.under && !plus.under && base.k !== null && plus.k !== null;
  return {
    base, plus, rem,
    savedMonths: ok ? base.k - plus.k : null,
    savedInterest: ok ? r2(base.interest - plus.interest) : null
  };
}

export function yrMo(n) {
  n = Math.max(0, Math.round(nz(n)));
  const y = Math.floor(n / 12), m = n % 12;
  if (!n) return '0개월';
  return ((y ? y + '년 ' : '') + (m ? m + '개월' : '')).trim();
}

// ───────── 부채 (이율·한도) ─────────
export function checkDebt(f) {
  const R = Res();
  const apr = parseNum(f.apr), limit = parseNum(f.limit), min = parseNum(f.min);
  if (badNum(apr) || (apr !== null && !(apr >= 0 && apr <= 100))) R.err('apr', '이율(APR %)은 0~100 사이의 숫자로 입력하세요. (예: 21.99)');
  if (badNum(limit) || (limit !== null && !(limit >= 0 && limit <= 1e9))) R.err('limit', '한도는 0 이상의 숫자로 입력하세요. (예: 5000)');
  if (badNum(min) || (min !== null && !(min >= 0 && min <= 1e9))) R.err('min', '최소 상환액은 0 이상의 숫자로 입력하세요. (예: 25)');
  if (R.bad()) return R.out();
  return R.out({ cfg: { apr: apr === null ? 0 : r3(apr), limit: limit === null ? 0 : r2(limit), min: min === null ? 0 : r2(min) } });
}
/** 사용률 색: <30 좋음, <60 주의, 그 이상 위험 */
export const utilLevel = (u) => (u === null || u === undefined ? '' : u < 30 ? 'ok' : u < 60 ? 'near' : 'over');

// ───────── 주식 ─────────
export const SYMBOL_RE = /^[A-Z0-9.\-^=]{1,15}$/;
export function checkHolding(f, holdings, idx) {
  const R = Res();
  const sym = String(f.sym || '').trim().toUpperCase();
  const shares = parseNum(f.shares), book = parseNum(f.book);
  const acct = String(f.acct || '');
  if (!SYMBOL_RE.test(sym)) R.err('sym', '종목 코드는 영문·숫자·점(.)으로 입력하세요. (예: TD.TO, AAPL)');
  if (shares === null || badNum(shares) || !(shares > 0 && shares <= 1e9)) R.err('shares', '보유 수량은 0보다 큰 숫자로 입력하세요. (예: 120)');
  if (badNum(book) || (book !== null && book < 0)) R.err('book', '원가(산 금액 합계)는 0 이상의 숫자로 입력하세요. 모르면 비워 두세요.');
  if (!R.bad() && (holdings || []).some((h, i) => i !== idx && String(h.sym).toUpperCase() === sym && String(h.acct || '') === acct)) R.err('sym', '같은 계좌에 ' + sym + ' 가 이미 있어요. 그 줄을 수정하세요.');
  if (R.bad()) return R.out();
  return R.out({ cfg: { sym, shares: Math.round(shares * 1e6) / 1e6, book: book === null ? 0 : r2(book), acct } });
}
export function checkPrice(f) {
  const R = Res();
  const price = parseNum(f.price);
  const ccy = f.ccy === 'USD' ? 'USD' : 'CAD';
  if (price === null || badNum(price) || !(price > 0)) R.err('price', '가격은 0보다 큰 숫자로 입력하세요. (예: 95.30)');
  return R.out({ price, ccy });
}

/** 시세 통화: 서버가 알려주면 그것, 아니면 종목 코드 꼬리표로 추정 (TD.TO → CAD, AAPL → USD) */
export function quoteCcy(sym, given) {
  const g = String(given || '').toUpperCase();
  if (/^[A-Z]{3}$/.test(g)) return { ccy: g, guess: false };
  const m = /\.([A-Z]+)$/.exec(String(sym).toUpperCase());
  if (m) return { ccy: 'CAD', guess: true };
  return { ccy: 'USD', guess: true };
}
/** 원래 통화 → CAD. 환율이 없으면 null */
export function toCad(price, ccy, fxRates, date) {
  if (!ccy || ccy === 'CAD') return { cad: r4(price), fx: 1 };
  const r = FX.rateOn(fxRates, ccy, date);
  if (!r || !(r > 0)) return null;
  return { cad: r4(price * r), fx: r };
}
/** 저장할 시세 한 건 */
export function priceEntry(price, ccy, fxRates, at, extra) {
  const c = toCad(price, ccy, fxRates, String(at || '').slice(0, 10));
  if (!c) return null;
  const e = { price: c.cad, at, ccy };
  if (ccy !== 'CAD') { e.orig = price; e.fx = c.fx; }
  return Object.assign(e, extra || {});
}
export function ageOf(at, now) {
  const t = Date.parse(at);
  if (!at || Number.isNaN(t)) return { text: '시각 모름', warn: true, hours: null };
  const hrs = Math.max(0, ((now === undefined ? Date.now() : now) - t) / 3600e3);
  const text = hrs < 1 ? '방금' : hrs < 24 ? Math.floor(hrs) + '시간 전' : Math.floor(hrs / 24) + '일 전';
  return { text, warn: hrs >= 96, stale: hrs >= 24, hours: hrs };
}

/** 보유 종목 표: 평가액·손익 계산 (가격이 없으면 value null) */
export function holdingRows(holdings, prices, accMap) {
  return (holdings || []).map((h, i) => {
    const q = prices && prices[h.sym];
    const price = q && nz(q.price) > 0 ? nz(q.price) : null;
    const value = price === null ? null : r2(nz(h.shares) * price);
    const book = nz(h.book);
    const a = h.acct ? accMap.get(String(h.acct)) : null;
    return {
      i, sym: h.sym, shares: nz(h.shares), book, acct: String(h.acct || ''), acctName: a ? L.accLabel(a) : '', acctOk: !!a,
      price, ccy: q ? q.ccy || 'CAD' : '', orig: q && q.orig ? q.orig : null, fx: q && q.fx ? q.fx : null, at: q ? q.at : '', guess: !!(q && q.guess), manual: !!(q && q.manual),
      value, pl: value === null || !book ? null : r2(value - book), plPct: value === null || !book ? null : r2((value - book) / book * 100)
    };
  });
}
/** 계좌별: 평가액 합계 · 시세 없는 종목 수 */
export function acctTotals(rows) {
  const m = new Map();
  rows.forEach((r) => {
    if (!r.acct) return;
    const e = m.get(r.acct) || { acct: r.acct, value: 0, book: 0, missing: 0, count: 0 };
    e.count++;
    e.book += r.book;
    if (r.value === null) e.missing++; else e.value = r2(e.value + r.value);
    m.set(r.acct, e);
  });
  return m;
}

// ───────── 발생 (재산세 등) ─────────
export function checkAccrual(f) {
  const R = Res();
  const annual = parseNum(f.annual), opening = parseNum(f.opening);
  const since = normYm(f.since);
  if (annual === null || badNum(annual) || !(annual > 0)) R.err('annual', '1년 금액은 0보다 큰 숫자로 입력하세요. (예: 4800)');
  if (!isYm(since)) R.err('since', '쌓기 시작할 달을 골라 주세요. (예: 2026-01)');
  if (badNum(opening) || (opening !== null && opening < 0)) R.err('opening', '처음 밀린 금액은 0 이상의 숫자로 입력하세요. 없으면 0 이에요.');
  if (!f.code) R.err('code', '비용 계정(낼 때 기록하는 계정)을 골라 주세요.');
  if (!f.acct) R.err('acct', '미지급 부채 계정(쌓인 금액을 보여줄 계정)을 골라 주세요.');
  if (f.code && f.acct && String(f.code) === String(f.acct)) R.err('acct', '비용 계정과 부채 계정은 서로 달라야 해요.');
  if (R.bad()) return R.out();
  return R.out({ cfg: { annual: r2(annual), since, opening: opening === null ? 0 : r2(opening), code: String(f.code), acct: String(f.acct) } });
}
/** 월별 누적: 쌓인 금액 · 낸 금액 · 낼 잔액 (현재 달 이후는 낸 금액·잔액 없음) */
export function accrualSeries(cfg, items, nowYm, count) {
  const first0 = V.addMonths(nowYm, -((count || 24) - 1));
  const first = cfg.since > first0 ? cfg.since : first0;
  let last = nowYm > V.addMonths(first, 11) ? nowYm : V.addMonths(first, 11);
  const labels = [], accrued = [], paid = [], balance = [];
  let nowIndex = -1;
  for (let m = first, i = 0; m <= last; m = V.addMonths(m, 1), i++) {
    labels.push(m);
    const acc = r2(nz(cfg.opening) + V.accruedBy(cfg, m));
    accrued.push(acc);
    if (m <= nowYm) {
      const p = r2(V.accrualPaid(cfg, items, m));
      paid.push(p);
      balance.push(r2(acc - p));
      nowIndex = i;
    } else { paid.push(null); balance.push(null); }
  }
  return { labels, accrued, paid, balance, nowIndex };
}
/** 낸 내역 (비용 계정 거래): 최신순 */
export function accrualPayments(cfg, items, nowYm, limit) {
  if (!cfg || !cfg.code || !cfg.since) return [];
  const from = cfg.since + '-01', to = V.lastDay(nowYm);
  const out = [];
  items.forEach((it) => {
    const d = it.txn.date;
    if (d < from || d > to) return;
    let v = 0;
    it.ps.forEach((p) => { if (String(p.account_id) === String(cfg.code) && !L.truthy(p.deleted)) v += L.num(p.amount_cad); });
    if (Math.abs(v) > 0.004) out.push({ date: d, merchant: it.txn.merchant || '', amount: r2(v) });
  });
  return out.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, limit || 6);
}
