// 장부 핵심 로직 (화면·네트워크와 무관한 순수 함수)
// 분개 규칙: 차변(+) / 대변(−) 부호 금액, 한 거래의 합계는 항상 0.
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
  return new Map(accounts.map((a) => [String(a.account_id), a]));
}

// ───────── 분개 설명 ─────────

export function describeTxn(txn, postings, accMap) {
  const get = (id) => accMap.get(String(id));
  const nameOf = (id) => { const a = get(id); return a ? a.name : String(id); };
  const out = { kind: 'TRANSFER', flow: 'move', categoryId: '', categoryName: '', accountId: '', accountName: '', fromName: '', toName: '' };
  const isId = (p, id) => String(p.account_id) === String(id);
  const opening = postings.find((p) => isId(p, CONFIG.OPENING_ID));
  const clearing = postings.find((p) => isId(p, CONFIG.CLEARING_ID));
  const exp = postings.find((p) => { const a = get(p.account_id); return a && a.type === 'EXPENSE'; });
  const inc = postings.find((p) => { const a = get(p.account_id); return a && a.type === 'INCOME'; });

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
  } else if (exp) {
    const other = postings.find((p) => p !== exp);
    out.kind = 'EXPENSE';
    out.flow = num(exp.amount_cad) >= 0 ? 'out' : 'in';
    out.categoryId = String(exp.account_id);
    out.categoryName = nameOf(exp.account_id);
    if (other) { out.accountId = String(other.account_id); out.accountName = nameOf(other.account_id); }
  } else if (inc) {
    const other = postings.find((p) => p !== inc);
    out.kind = 'INCOME';
    out.flow = 'in';
    out.categoryId = String(inc.account_id);
    out.categoryName = nameOf(inc.account_id);
    if (other) { out.accountId = String(other.account_id); out.accountName = nameOf(other.account_id); }
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
    tripTag: '', passthrough: false, categoryTouched: false, ownerTouched: false
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
    f.kind = 'EXPENSE'; f.fromId = d.accountId; f.categoryId = d.categoryId;
  } else if (d.kind === 'INCOME') {
    f.kind = 'INCOME'; f.toId = d.accountId; f.categoryId = d.categoryId;
  } else if (d.kind === 'OPENING') {
    f.kind = 'OPENING'; f.accountId = d.accountId;
  } else {
    f.kind = 'TRANSFER'; f.fromId = d.fromId || ''; f.toId = d.toId || '';
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

export function suggestRule(rules, merchant) {
  const norm = normMerchant(merchant);
  if (!norm) return null;
  const live = rules.filter((r) => !truthy(r.deleted) && r.pattern);
  const exact = live.find((r) => normMerchant(r.pattern) === norm);
  if (exact) return exact;
  let best = null;
  live.forEach((r) => {
    const p = normMerchant(r.pattern);
    if (p.length >= 3 && norm.indexOf(p) >= 0 && (!best || p.length > normMerchant(best.pattern).length)) best = r;
  });
  return best;
}

export function learnRule(rules, merchant, accountId, now) {
  const norm = normMerchant(merchant);
  if (!norm || !accountId) return null;
  const existing = rules.find((r) => !truthy(r.deleted) && normMerchant(r.pattern) === norm);
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
  const categoryId = passthrough ? CONFIG.CLEARING_ID : form.categoryId;
  let lines;

  if (kind === 'EXPENSE') {
    if (!isMoneyAccount(A(form.fromId))) return { error: '결제 계좌를 선택하세요.' };
    const c = A(categoryId);
    if (!c || !(c.type === 'EXPENSE' || String(c.account_id) === CONFIG.CLEARING_ID)) return { error: '카테고리를 선택하세요.' };
    lines = [[categoryId, 1], [form.fromId, -1]];
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
  // 수정 시 기존 분개 행을 최대한 재사용: 같은 계정끼리 먼저 짝지은 뒤, 남은 것을 순서대로 채움
  const used = new Set();
  const assigned = lines.map(() => null);
  lines.forEach((ln, i) => {
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
    return {
      posting_id: assigned[i] ? assigned[i].posting_id : newId('p'),
      txn_id: txnId, line_id: '', account_id: String(ln[0]),
      amount_cad: sign * cad, amount_orig: sign * amount, currency: ccy, fx_rate: rate,
      memo: '', updated_at: now, deleted: false
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
  if ((kind === 'EXPENSE' || kind === 'INCOME') && !passthrough && txn.merchant) {
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
      d.fromName, d.toName, String(num(t.total_cad)), num(t.total_cad).toFixed(2),
      num(t.total_cad).toLocaleString('en-CA', { minimumFractionDigits: 2 }),
      String(num(t.total_orig))].join(' ').toLowerCase();
    return tokens.every((tok) => hay.indexOf(tok) >= 0);
  });
}
