// 장부 핵심 로직 (화면·네트워크와 무관한 순수 함수)
// 분개 규칙: 차변(+) / 대변(−) 부호 금액, 한 거래의 합계는 항상 0.
import { lang } from './prefs.js';
import { CONFIG } from './config.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = (n) => String(n).padStart(2, '0');

export const GROUP_LABELS = {
  '수입': 'Income (수입)',
  '고정비': 'Fixed (고정비)',
  'semi-고정비': 'Semi-fixed (semi-고정비)',
  '유흥비': 'Leisure (유흥비)',
  '금융비': 'Financial (금융비)',
  '확인 필요': 'Review (확인 필요)'
};
// 카테고리 그룹 → 색 표시용 CSS 클래스 (왼쪽 색 막대)
export const GROUP_CLASS = { '수입': 'g-in', '고정비': 'g-fixed', 'semi-고정비': 'g-semi', '유흥비': 'g-fun', '금융비': 'g-fin', '확인 필요': 'g-review' };
export const GROUP_ORDER = ['고정비', 'semi-고정비', '유흥비', '금융비', '확인 필요'];

// ───────── 값 변환 ─────────

export const truthy = (v) => v === true || (typeof v === 'string' && v.trim().toUpperCase() === 'TRUE');

export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function decimals(ccy) { return ccy === 'JPY' || ccy === 'KRW' ? 0 : 2; }

export function round(n, d) {
  if (d === undefined) d = 2;
  const f = Math.pow(10, d);
  const s = n < 0 ? -1 : 1;
  return s * Math.round(Math.abs(n) * f + 1e-9) / f;
}

export function nowIso() { return new Date().toISOString(); }

export function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

export function monthOf(dateStr) { return String(dateStr || '').slice(0, 7); }

export function shiftMonth(ym, delta) {
  const parts = ym.split('-');
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1 + delta, 1);
  return d.getFullYear() + '-' + p2(d.getMonth() + 1);
}

export function monthLabel(ym) {
  const parts = ym.split('-');
  return MONTHS[Number(parts[1]) - 1] + ' ' + parts[0];
}

export function dayLabel(dateStr) {
  const parts = String(dateStr).split('-').map(Number);
  if (parts.length !== 3 || !parts[0]) return String(dateStr);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  return DOW[d.getDay()] + ', ' + MONTHS[parts[1] - 1] + ' ' + parts[2];
}

export function newId(prefix) {
  let u;
  if (typeof crypto !== 'undefined' && crypto.randomUUID) u = crypto.randomUUID().replace(/-/g, '');
  else u = Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  return prefix + '_' + u.slice(0, 20);
}

// 금액 입력창용 계산기: "10*1.1", "$1,200 - 35.5" 같은 식을 안전하게 계산합니다. (eval 사용 안 함)
export function parseAmount(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? input : NaN;
  let s = String(input == null ? '' : input).toLowerCase();
  s = s.replace(/[,\s$]/g, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/x/g, '*');
  if (!s) return NaN;
  let i = 0;
  const peek = () => s[i];
  function number() {
    const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if (!m) throw new Error('num');
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function factor() {
    const c = peek();
    if (c === '-') { i++; return -factor(); }
    if (c === '+') { i++; return factor(); }
    if (c === '(') {
      i++;
      const v = expr();
      if (peek() !== ')') throw new Error('paren');
      i++;
      return v;
    }
    return number();
  }
  function term() {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = s[i++];
      const r = factor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  try {
    const v = expr();
    if (i !== s.length || !Number.isFinite(v)) return NaN;
    return v;
  } catch (e) {
    return NaN;
  }
}

const SYMBOLS = { CAD: '$', USD: 'US$', KRW: '₩', JPY: '¥', EUR: '€', GBP: '£', CNY: 'CN¥', AUD: 'A$', MXN: 'MX$' };

export function fmtMoney(n, ccy) {
  ccy = ccy || 'CAD';
  const d = decimals(ccy);
  const body = Math.abs(n).toLocaleString('en-CA', { minimumFractionDigits: d, maximumFractionDigits: d });
  return (n < 0 ? '-' : '') + (SYMBOLS[ccy] || ccy + ' ') + body;
}

export function fmtNumber(n, ccy) {
  const d = decimals(ccy || 'CAD');
  return n.toLocaleString('en-CA', { minimumFractionDigits: d, maximumFractionDigits: d });
}

// ───────── 계좌 ─────────

export const isActive = (a) => !truthy(a.deleted) && !(a.is_active === false || String(a.is_active).toUpperCase() === 'FALSE');

export function accLabel(a) {
  const ko = a.name_ko && a.name_ko !== a.name ? ' (' + a.name_ko + ')' : '';
  return a.name + ko;
}

export const isMoneyAccount = (a) => !!a && (a.type === 'ASSET' || a.type === 'LIABILITY') && a.subtype !== 'CLEARING';

export function makeAccMap(accounts) {
  // 한/영 설정에 맞춰 화면에 보일 이름만 바꾼 복사본을 씁니다. 원래 행은 __row 로 (저장할 때는 반드시 원래 행을 쓰세요)
  const m = lang();
  return new Map(accounts.map((a) => {
    if (m === 'both') return [String(a.account_id), a];
    const c = Object.assign({}, a, m === 'ko' ? { name: a.name_ko || a.name, name_ko: '', name_en: a.name } : { name_ko: '', name_en: a.name });
    Object.defineProperty(c, '__row', { value: a, enumerable: false });
    return [String(a.account_id), c];
  }));
}
/** 가족 구성원 표시 이름 (저장 값은 영어: Patrick / Ms Kim / JY Han / Joint) */
export const OWNER_KO = { Patrick: '한윤종', 'Ms Kim': '김명순', 'MS Kim': '김명순', 'JY Han': '한재영', Joint: '공동' };
export function ownerLabel(o, mode) {
  const v = String(o || 'Joint');
  const ko = OWNER_KO[v];
  if (!ko) return v;
  const m = mode || lang();
  return m === 'ko' ? ko : m === 'en' ? v : ko + ' (' + v + ')';
}
/** accMap 에서 꺼낸 계정의 원래 시트 행 */
export const rawAccount = (a) => (a && a.__row) || a;

// ───────── 분개 설명 ─────────

export const SPLIT_LABEL = (n) => 'Split · ' + n + ' (나눔 ' + n + ')';

export function describeTxn(txn, postings, accMap) {
  const get = (id) => accMap.get(String(id));
  const nameOf = (id) => { const a = get(id); return a ? a.name : String(id); };
  const out = { kind: 'TRANSFER', flow: 'move', categoryId: '', categoryName: '', accountId: '', accountName: '', fromName: '', toName: '' };
  const isId = (p, id) => String(p.account_id) === String(id);
  const typeOf = (p) => { const a = get(p.account_id); return a ? a.type : ''; };
  const opening = postings.find((p) => isId(p, CONFIG.OPENING_ID));
  const clearing = postings.find((p) => isId(p, CONFIG.CLEARING_ID));
  const exps = postings.filter((p) => typeOf(p) === 'EXPENSE');
  const incs = postings.filter((p) => typeOf(p) === 'INCOME');
  const exp = exps[0];
  const inc = incs[0];
  // 돈이 오간 계좌(자산·부채) — 나눈 거래(분개 여러 줄)에서도 카테고리 줄이 아닌 쪽을 고릅니다
  const moneyOf = (cats) => postings.find((p) => cats.indexOf(p) < 0 && (typeOf(p) === 'ASSET' || typeOf(p) === 'LIABILITY'))
    || postings.find((p) => cats.indexOf(p) < 0);

  if (opening) {
    const other = postings.find((p) => !isId(p, CONFIG.OPENING_ID));
    out.kind = 'OPENING';
    out.categoryName = 'Opening balance (기초잔액)';
    if (other) { out.accountId = String(other.account_id); out.accountName = nameOf(other.account_id); }
  } else if (clearing) {
    const other = postings.find((p) => !isId(p, CONFIG.CLEARING_ID));
    out.kind = 'PASSTHROUGH';
    out.categoryId = CONFIG.CLEARING_ID;
    out.categoryName = 'Passthrough (전달 자금)';
    if (other) {
      out.accountId = String(other.account_id);
      out.accountName = nameOf(other.account_id);
      out.flow = num(other.amount_cad) < 0 ? 'out' : 'in';
    }
  } else if (exp || inc) {
    const cats = exp ? exps : incs;
    const other = moneyOf(cats);
    out.kind = exp ? 'EXPENSE' : 'INCOME';
    if (exp) out.flow = other ? (num(other.amount_cad) <= 0 ? 'out' : 'in') : (num(exp.amount_cad) >= 0 ? 'out' : 'in');
    else out.flow = 'in';
    out.categoryId = String(cats[0].account_id);
    out.categoryName = nameOf(cats[0].account_id);
    if (other) { out.accountId = String(other.account_id); out.accountName = nameOf(other.account_id); }
    if (cats.length > 1) {
      // 거래 나누기: 카테고리 줄이 여러 개 (금액은 지출/수입 방향 기준 +)
      const dir = exp ? (out.flow === 'in' ? -1 : 1) : -1;
      out.split = cats.length;
      out.lines = cats.map((p) => ({
        postingId: String(p.posting_id || ''), accountId: String(p.account_id), name: nameOf(p.account_id),
        cad: round(dir * num(p.amount_cad), 2), orig: round(dir * num(p.amount_orig === '' || p.amount_orig === undefined ? p.amount_cad : p.amount_orig), 6),
        owner: String(p.owner || ''), memo: String(p.memo || '')
      }));
      const big = out.lines.reduce((b, l) => (Math.abs(l.cad) > Math.abs(b.cad) ? l : b), out.lines[0]);
      out.categoryId = out.lines.some((l) => l.accountId === '9999') ? '9999' : big.accountId;
      out.categoryName = SPLIT_LABEL(cats.length);
    }
  } else {
    const to = postings.find((p) => num(p.amount_cad) > 0);
    const from = postings.find((p) => num(p.amount_cad) < 0);
    out.kind = 'TRANSFER';
    out.categoryName = 'Transfer (이체)';
    if (to) { out.toId = String(to.account_id); out.toName = nameOf(to.account_id); }
    if (from) { out.fromId = String(from.account_id); out.fromName = nameOf(from.account_id); }
    out.accountName = out.fromName && out.toName ? out.fromName + ' → ' + out.toName : '';
  }
  return out;
}

// ───────── 입력 폼 ↔ 기록 ─────────

export function newForm(defaults) {
  return Object.assign({
    kind: 'EXPENSE', date: todayStr(), amountText: '', currency: 'CAD', cadText: '', rateText: '',
    fromId: '', toId: '', categoryId: '', accountId: '', merchant: '', memo: '', owner: 'Joint',
    tripTag: '', passthrough: false, refund: false, categoryTouched: false, ownerTouched: false,
    split: false, lines: []
  }, defaults || {});
}

export function formFromTxn(txn, postings, accMap) {
  const d = describeTxn(txn, postings, accMap);
  const ccy = txn.currency || 'CAD';
  const provisional = String(txn.fx_status || '').toUpperCase() === 'PROVISIONAL';
  const f = newForm({
    date: txn.date, amountText: String(num(txn.total_orig)), currency: ccy,
    cadText: ccy === 'CAD' || provisional ? '' : String(num(txn.total_cad)),
    rateText: ccy === 'CAD' ? '' : String(num(txn.fx_rate) || ''),
    merchant: txn.merchant || '', memo: txn.memo || '', owner: txn.owner || 'Joint',
    tripTag: txn.trip_tag || '', passthrough: truthy(txn.is_passthrough),
    categoryTouched: true, ownerTouched: true
  });
  if (d.kind === 'PASSTHROUGH') {
    f.kind = d.flow === 'out' ? 'EXPENSE' : 'INCOME';
    f.passthrough = true;
    if (f.kind === 'EXPENSE') f.fromId = d.accountId; else f.toId = d.accountId;
  } else if (d.kind === 'EXPENSE') {
    f.kind = 'EXPENSE'; f.fromId = d.accountId; f.categoryId = d.categoryId; f.refund = d.flow === 'in';
  } else if (d.kind === 'INCOME') {
    f.kind = 'INCOME'; f.toId = d.accountId; f.categoryId = d.categoryId;
  } else if (d.kind === 'OPENING') {
    f.kind = 'OPENING'; f.accountId = d.accountId;
  } else {
    f.kind = 'TRANSFER'; f.fromId = d.fromId || ''; f.toId = d.toId || '';
  }
  if (d.split && (f.kind === 'EXPENSE' || f.kind === 'INCOME')) {
    // 나눈 거래: 줄마다 카테고리·금액(원래 통화)·소유자·메모
    const dec = decimals(ccy);
    f.split = true;
    f.categoryId = d.lines[0].accountId;
    f.lines = d.lines.map((l) => ({
      postingId: l.postingId, categoryId: l.accountId, amountText: String(round(l.orig, dec)),
      owner: l.owner || f.owner || 'Joint', memo: l.memo
    }));
  }
  return f;
}

export function normMerchant(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/[^a-z0-9가-힣\s]/g, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 규칙 패턴이 "^"로 시작하면 "이 글자로 시작", 아니면 "포함" */
export const isStartsRule = (r) => /^\s*\^/.test(String((r && r.pattern) || ''));
export const ruleKey = (pattern) => (/^\s*\^/.test(String(pattern || '')) ? '^' : '') + normMerchant(pattern);
/** 이 규칙이 가맹점 이름(정규화된 norm)에 걸리는가 */
export function ruleMatches(r, norm) {
  const p = normMerchant(r.pattern);
  if (!p || !norm) return false;
  if (isStartsRule(r)) return norm === p || norm.indexOf(p + ' ') === 0 || (p.length >= 2 && norm.indexOf(p) === 0);
  return norm === p || (p.length >= 3 && norm.indexOf(p) >= 0);
}
export function suggestRule(rules, merchant) {
  const norm = normMerchant(merchant);
  if (!norm) return null;
  const live = rules.filter((r) => !truthy(r.deleted) && r.pattern);
  const exact = live.find((r) => !isStartsRule(r) && normMerchant(r.pattern) === norm);
  if (exact) return exact;
  let best = null, bestLen = -1;
  live.forEach((r) => {
    if (!ruleMatches(r, norm)) return;
    const len = normMerchant(r.pattern).length + (isStartsRule(r) ? 0.5 : 0);   // 길이가 같으면 "시작" 규칙이 우선
    if (len > bestLen) { best = r; bestLen = len; }
  });
  return best;
}

export function learnRule(rules, merchant, accountId, now) {
  const norm = normMerchant(merchant);
  if (!norm || !accountId) return null;
  const existing = rules.find((r) => !truthy(r.deleted) && !isStartsRule(r) && normMerchant(r.pattern) === norm);
  if (existing) {
    const same = String(existing.account_id) === String(accountId);
    return Object.assign({}, existing, {
      account_id: String(accountId),
      hit_count: same ? num(existing.hit_count) + 1 : 1,
      updated_at: now, deleted: false
    });
  }
  return {
    rule_id: newId('r'), pattern: norm, account_id: String(accountId), owner: '', default_tax_code: '',
    is_passthrough: '', postings_template: '', hit_count: 1, source: 'LEARNED', updated_at: now, deleted: false
  };
}

export function latestRate(fxRates, ccy) {
  let best = null;
  (fxRates || []).forEach((r) => {
    if (truthy(r.deleted) || r.currency !== ccy || !(num(r.rate) > 0)) return;
    if (!best || String(r.date) > String(best.date)) best = r;
  });
  return best ? num(best.rate) : 0;
}

// ───────── 거래 나누기 (split) ─────────

const toMinor = (n, dec) => Math.round(round(n, dec) * Math.pow(10, dec));

/** 나눈 줄의 합계 확인 (센트 단위). { ok, total, sum, remaining, dec, amounts:[원래 통화 금액|NaN] } */
export function splitBalance(form) {
  const ccy = form.currency || 'CAD';
  const dec = decimals(ccy);
  const total = round(parseAmount(form.amountText), dec);
  const amounts = (form.lines || []).map((l) => { const n = parseAmount(l.amountText); return Number.isFinite(n) ? round(n, dec) : NaN; });
  const sumMinor = amounts.reduce((s, a) => s + (Number.isFinite(a) ? toMinor(a, dec) : 0), 0);
  const totMinor = Number.isFinite(total) ? toMinor(total, dec) : NaN;
  const f = Math.pow(10, dec);
  const remaining = Number.isFinite(totMinor) ? (totMinor - sumMinor) / f : NaN;
  const blank = amounts.findIndex((a) => !Number.isFinite(a) || a === 0);
  return { ok: Number.isFinite(totMinor) && totMinor > 0 && remaining === 0 && blank < 0, total, sum: sumMinor / f, remaining, dec, amounts, blank };
}

/** 총액을 n 줄로 똑같이 나누기 (남는 센트는 앞 줄부터 1씩) */
export function splitEvenly(total, n, dec) {
  if (!(n > 0)) return [];
  const t = toMinor(total, dec);
  const base = Math.trunc(t / n);
  let rest = t - base * n;
  const f = Math.pow(10, dec);
  return Array.from({ length: n }, () => { let v = base; if (rest > 0) { v++; rest--; } else if (rest < 0) { v--; rest++; } return v / f; });
}

/** 원래 통화 줄 금액 → CAD 금액. 합계가 정확히 totalCad 가 되도록 반올림 차이는 가장 큰 줄에 붙입니다. */
export function allocateCad(origAmounts, totalOrig, totalCad) {
  if (!origAmounts.length) return [];
  const cents = origAmounts.map((a) => Math.round(round(totalOrig ? a * totalCad / totalOrig : 0, 2) * 100));
  const want = Math.round(totalCad * 100);
  const diff = want - cents.reduce((s, c) => s + c, 0);
  if (diff) {
    let big = 0;
    origAmounts.forEach((a, i) => { if (Math.abs(a) > Math.abs(origAmounts[big])) big = i; });
    cents[big] += diff;
  }
  return cents.map((c) => c / 100);
}

// 폼 입력 → 거래 1건 + 분개들. 실패하면 { error }.
export function makeRecords(form, ctx) {
  const accMap = ctx.accMap;
  const rules = ctx.rules || [];
  const existing = ctx.existing || null;
  const now = ctx.now || nowIso();
  const kind = form.kind;
  const ccy = form.currency || 'CAD';

  const amount = round(parseAmount(form.amountText), decimals(ccy));
  if (!(amount > 0)) return { error: '금액을 올바르게 입력하세요.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date || '')) return { error: '날짜를 입력하세요.' };

  let cad, rate, fxStatus, fxSource = '';
  if (ccy === 'CAD') {
    cad = round(amount, 2); rate = 1; fxStatus = 'ACTUAL';
  } else {
    const cadIn = parseAmount(form.cadText);
    const rateIn = parseAmount(form.rateText);
    if (cadIn > 0) { cad = round(cadIn, 2); rate = round(cad / amount, 6); fxStatus = 'ACTUAL'; fxSource = 'MANUAL'; }
    else if (rateIn > 0) { cad = round(amount * rateIn, 2); rate = rateIn; fxStatus = 'PROVISIONAL'; fxSource = 'MANUAL'; }
    else return { error: '외화 거래는 CAD 청구액 또는 환율을 입력하세요.' };
  }
  if (!(cad > 0)) return { error: 'CAD 금액이 0입니다. 입력값을 확인하세요.' };

  const A = (id) => accMap.get(String(id));
  const passthrough = !!form.passthrough && (kind === 'EXPENSE' || kind === 'INCOME');
  const split = !!form.split && !passthrough && (kind === 'EXPENSE' || kind === 'INCOME') && (form.lines || []).length > 0;
  let categoryId = passthrough ? CONFIG.CLEARING_ID : form.categoryId;
  let lines;
  let splitLines = null; // [{ categoryId, orig, cad, owner, memo, postingId }]

  if (split) {
    const catType = kind === 'EXPENSE' ? 'EXPENSE' : 'INCOME';
    const moneyId = kind === 'EXPENSE' ? form.fromId : form.toId;
    if (!isMoneyAccount(A(moneyId))) return { error: kind === 'EXPENSE' ? '결제 계좌를 선택하세요.' : '입금 계좌를 선택하세요.' };
    const bal = splitBalance(form);
    for (let i = 0; i < form.lines.length; i++) {
      const c = A(form.lines[i].categoryId);
      if (!c || c.type !== catType) return { error: (i + 1) + '번째 줄의 ' + (kind === 'EXPENSE' ? '카테고리' : '수입 항목') + '를 선택하세요.' };
      if (!Number.isFinite(bal.amounts[i]) || bal.amounts[i] === 0) return { error: (i + 1) + '번째 줄의 금액을 입력하세요.' };
    }
    if (bal.remaining !== 0) {
      return { error: '나눈 금액의 합계가 총액과 다릅니다 (' + (bal.remaining > 0 ? '남은 금액 ' : '초과 ') + fmtMoney(Math.abs(bal.remaining), ccy) + ').' };
    }
    const cads = allocateCad(bal.amounts, amount, cad);
    splitLines = form.lines.map((l, i) => ({
      categoryId: String(l.categoryId), orig: bal.amounts[i], cad: cads[i],
      owner: l.owner || form.owner || 'Joint', memo: (l.memo || '').trim(), postingId: l.postingId || ''
    }));
    categoryId = splitLines[0].categoryId;
    // 지출: 카테고리 + / 계좌 −  (환불은 반대) · 수입: 계좌 + / 수입 항목 −
    const catSign = kind === 'EXPENSE' ? (form.refund ? -1 : 1) : -1;
    lines = [[moneyId, -catSign, cad, amount, '', '', '']]
      .concat(splitLines.map((l) => [l.categoryId, catSign, l.cad, l.orig, l.owner, l.memo, l.postingId]));
    if (kind === 'EXPENSE' && !form.refund) lines = lines.slice(1).concat(lines.slice(0, 1));
  } else if (kind === 'EXPENSE') {
    if (!isMoneyAccount(A(form.fromId))) return { error: '결제 계좌를 선택하세요.' };
    const c = A(categoryId);
    if (!c || !(c.type === 'EXPENSE' || String(c.account_id) === CONFIG.CLEARING_ID)) return { error: '카테고리를 선택하세요.' };
    lines = form.refund ? [[form.fromId, 1], [categoryId, -1]] : [[categoryId, 1], [form.fromId, -1]];
  } else if (kind === 'INCOME') {
    if (!isMoneyAccount(A(form.toId))) return { error: '입금 계좌를 선택하세요.' };
    const c = A(categoryId);
    if (!c || !(c.type === 'INCOME' || String(c.account_id) === CONFIG.CLEARING_ID)) return { error: '수입 항목을 선택하세요.' };
    lines = [[form.toId, 1], [categoryId, -1]];
  } else if (kind === 'TRANSFER') {
    if (!isMoneyAccount(A(form.fromId)) || !isMoneyAccount(A(form.toId))) return { error: '보내는 계좌와 받는 계좌를 선택하세요.' };
    if (String(form.fromId) === String(form.toId)) return { error: '보내는 계좌와 받는 계좌가 같습니다.' };
    lines = [[form.toId, 1], [form.fromId, -1]];
  } else if (kind === 'OPENING') {
    const a = A(form.accountId);
    if (!isMoneyAccount(a)) return { error: '계좌를 선택하세요.' };
    if (!A(CONFIG.OPENING_ID)) return { error: 'Opening Balance Equity(3010) 계정이 없습니다.' };
    lines = a.type === 'ASSET' ? [[form.accountId, 1], [CONFIG.OPENING_ID, -1]] : [[CONFIG.OPENING_ID, 1], [form.accountId, -1]];
  } else {
    return { error: '거래 종류를 선택하세요.' };
  }

  const txnId = existing ? existing.txn.txn_id : newId('t');
  const oldPostings = existing ? existing.ps.filter((p) => !truthy(p.deleted)) : [];
  // 수정 시 기존 분개 행을 최대한 재사용: 나눈 줄은 원래 분개 id 로, 그다음 같은 계정끼리, 남은 것을 순서대로 채움
  const used = new Set();
  const assigned = lines.map(() => null);
  lines.forEach((ln, i) => {
    if (!ln[6]) return;
    const k = oldPostings.findIndex((p, j) => !used.has(j) && String(p.posting_id) === String(ln[6]));
    if (k >= 0) { used.add(k); assigned[i] = oldPostings[k]; }
  });
  lines.forEach((ln, i) => {
    if (assigned[i]) return;
    const k = oldPostings.findIndex((p, j) => !used.has(j) && String(p.account_id) === String(ln[0]));
    if (k >= 0) { used.add(k); assigned[i] = oldPostings[k]; }
  });
  lines.forEach((ln, i) => {
    if (assigned[i]) return;
    const k = oldPostings.findIndex((p, j) => !used.has(j));
    if (k >= 0) { used.add(k); assigned[i] = oldPostings[k]; }
  });
  const postings = lines.map((ln, i) => {
    const sign = ln[1];
    const lc = ln.length > 2 ? ln[2] : cad;
    const lo = ln.length > 2 ? ln[3] : amount;
    return {
      posting_id: assigned[i] ? assigned[i].posting_id : newId('p'),
      txn_id: txnId, line_id: '', account_id: String(ln[0]),
      amount_cad: round(sign * lc, 2), amount_orig: round(sign * lo, decimals(ccy)), currency: ccy, fx_rate: rate,
      memo: ln[5] || '', owner: ln[4] || '', updated_at: now, deleted: false
    };
  });
  oldPostings.forEach((p, j) => {
    if (!used.has(j)) postings.push(Object.assign({}, p, { deleted: true, updated_at: now }));
  });
  const sum = postings.filter((p) => !truthy(p.deleted)).reduce((s, p) => s + p.amount_cad, 0);
  if (Math.abs(sum) > 0.005) return { error: '차변과 대변이 맞지 않습니다.' };

  const base = existing ? existing.txn : {};
  const txn = Object.assign({}, base, {
    txn_id: txnId, date: form.date, merchant: (form.merchant || '').trim(), memo: (form.memo || '').trim(),
    currency: ccy, subtotal_orig: amount, total_orig: amount, fx_rate: rate, fx_source: fxSource, fx_status: fxStatus,
    total_cad: cad, source: base.source || 'MANUAL',
    status: kind === 'OPENING' ? 'MATCHED' : (base.status || 'PENDING_MATCH'),
    owner: form.owner || 'Joint', trip_tag: (form.tripTag || '').trim(), is_passthrough: passthrough,
    created_at: base.created_at || now, updated_at: now, deleted: false
  });

  let rule = null;
  if ((kind === 'EXPENSE' || kind === 'INCOME') && !passthrough && !split && txn.merchant) {
    rule = learnRule(rules, txn.merchant, categoryId, now);
  }
  return { txn, postings, rule };
}

// ───────── 집계 ─────────

// 유효한 분개만 (삭제되지 않았고, 거래가 살아 있는 것)
export function activePostings(txns, postings) {
  const live = new Set(txns.filter((t) => !truthy(t.deleted)).map((t) => String(t.txn_id)));
  return postings.filter((p) => !truthy(p.deleted) && live.has(String(p.txn_id)));
}

export function monthSummary(items, accMap, ym) {
  let income = 0, spending = 0;
  items.forEach((it) => {
    if (monthOf(it.txn.date) !== ym) return;
    it.ps.forEach((p) => {
      const a = accMap.get(String(p.account_id));
      if (!a) return;
      if (a.type === 'INCOME') income -= num(p.amount_cad);
      else if (a.type === 'EXPENSE') spending += num(p.amount_cad);
    });
  });
  return { income: round(income), spending: round(spending), net: round(income - spending) };
}

// 계좌별 잔액: 자산은 +합계, 부채는 −합계(= 갚아야 할 금액)
export function accountBalances(accounts, activePs) {
  const raw = new Map();
  activePs.forEach((p) => {
    const k = String(p.account_id);
    raw.set(k, (raw.get(k) || 0) + num(p.amount_cad));
  });
  const res = new Map();
  accounts.forEach((a) => {
    const r = raw.get(String(a.account_id)) || 0;
    res.set(String(a.account_id), a.type === 'LIABILITY' ? round(-r) : round(r));
  });
  return res;
}

export function netWorth(accounts, balances) {
  let assets = 0, liabilities = 0;
  accounts.forEach((a) => {
    if (!isActive(a)) return;
    const b = balances.get(String(a.account_id)) || 0;
    if (a.type === 'ASSET') assets += b;
    else if (a.type === 'LIABILITY') liabilities += b;
  });
  return { assets: round(assets), liabilities: round(liabilities), net: round(assets - liabilities) };
}

// 검색: 날짜·가맹점·메모·금액·계좌·카테고리·태그를 한 번에 (단어를 모두 포함해야 일치)
export function searchItems(items, query) {
  const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return items;
  return items.filter((it) => {
    const t = it.txn, d = it.desc;
    const hay = [t.date, t.merchant, t.memo, t.trip_tag, t.owner, t.currency, d.categoryName, d.accountName,
      (d.lines || []).map((l) => l.name + ' ' + l.owner + ' ' + l.memo).join(' '),
      d.fromName, d.toName, String(num(t.total_cad)), num(t.total_cad).toFixed(2),
      num(t.total_cad).toLocaleString('en-CA', { minimumFractionDigits: 2 }),
      String(num(t.total_orig))].join(' ').toLowerCase();
    return tokens.every((tok) => hay.indexOf(tok) >= 0);
  });
}
