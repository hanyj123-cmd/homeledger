// 영수증: 사진 준비 → 서버(Apps Script + Gemini) 호출 → 항목/세금 배분 → 장부 기록 만들기.
// 계산(배분·기록 만들기)은 화면과 무관한 순수 로직이라 테스트로 검증합니다.
import { CONFIG } from './config.js';
import * as L from './ledger.js';
import { getToken } from './auth.js';
import * as prefs from './prefs.js';
import * as scanimg from './scanimg.js';
import * as models from './models.js';

export const DEFAULT_RATES = { HST_ON: 0.13, GST: 0.05, HST_ATL: 0.15, GST_QST: 0.14975, ZERO: 0, EXEMPT: 0, NONE: 0 };
export const TAX_OPTIONS = ['HST_ON', 'GST', 'HST_ATL', 'GST_QST', 'ZERO', 'EXEMPT', 'NONE'];
export const TIP_LABEL = 'Tip';
const MAX_DIM = 1600;

// ───────── 사진 준비 (브라우저) ─────────

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(new Error('사진을 읽지 못했습니다.'));
    fr.readAsDataURL(blob);
  });
}

// 사진 내용의 지문(SHA-256). 서버를 부르기 전에 "이미 저장한 사진인지" 바로 알 수 있습니다.
export async function sha256OfBase64(b64) {
  try {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) return '';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
    return Array.from(digest).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { return ''; }
}

async function drawToJpeg(source, w, h, maxDim, quality) {
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  canvas.getContext('2d').drawImage(source, 0, 0, cw, ch);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  if (!blob) throw new Error('사진을 변환하지 못했습니다.');
  return blob;
}

// 사진 준비: 기본은 "스캔본"으로 보정합니다 (가장자리 자르기 · 그림자 펴기 · 글씨 진하게 · 1800px 이하 JPEG).
// 보정한 사진을 드라이브에 저장하고 AI 에도 같은 사진을 보내서, 올리는 양이 줄고 글씨도 더 잘 읽힙니다.
// 보정이 안 되는 환경이거나 "원본" 설정이면 예전처럼 크기만 줄입니다.
export async function prepareImage(file, mode) {
  const type = String(file.type || '').toLowerCase();
  if (type === 'application/pdf') {
    if (file.size > 6 * 1024 * 1024) throw new Error('PDF 가 너무 큽니다 (6MB 이하).');
    const base64 = await blobToBase64(file);
    return { base64, mime: 'application/pdf', fileName: file.name || 'receipt.pdf', thumb: '', sha256: await sha256OfBase64(base64), scanned: false };
  }
  const want = mode || prefs.scanMode();
  try {
    const bmp = await createImageBitmap(file);
    let blob = null, thumbBlob = null, scanned = false, cropped = false;
    if (want !== 'orig') {
      try {
        const r = await scanimg.scanBlob(bmp, bmp.width, bmp.height, { mode: want, maxDim: MAX_DIM, quality: 0.8, thumb: 240 });
        blob = r.blob; thumbBlob = r.thumbBlob; scanned = true; cropped = r.cropped;
      } catch (e) { blob = null; }   // 보정 실패 → 아래 일반 방식
    }
    if (!blob) {
      blob = await drawToJpeg(bmp, bmp.width, bmp.height, MAX_DIM, 0.82);
      thumbBlob = await drawToJpeg(bmp, bmp.width, bmp.height, 240, 0.6);
    }
    if (bmp.close) bmp.close();
    const [base64, thumb] = await Promise.all([blobToBase64(blob), blobToBase64(thumbBlob)]);
    return {
      base64, mime: 'image/jpeg', fileName: (file.name || 'receipt').replace(/\.[^.]+$/, '') + (scanned ? '-scan' : '') + '.jpg',
      thumb: 'data:image/jpeg;base64,' + thumb, sha256: await sha256OfBase64(base64), scanned, cropped
    };
  } catch (e) {
    // HEIC 등 브라우저가 못 여는 형식은 원본 그대로 (서버가 지원)
    if (file.size > 6 * 1024 * 1024) throw new Error('이 사진 형식은 크기를 줄일 수 없습니다. 사진 앱에서 JPEG 로 저장해 다시 올려 주세요.');
    const base64 = await blobToBase64(file);
    return { base64, mime: type || 'image/jpeg', fileName: file.name || 'receipt', thumb: '', sha256: await sha256OfBase64(base64), scanned: false };
  }
}

// ───────── 서버 호출 ─────────

export function apiConfigured() { return !!CONFIG.RECEIPT_API_URL; }

// Apps Script 웹 앱은 text/plain 으로 보내야 브라우저의 사전 확인(CORS preflight)을 피합니다.
export async function callApi(payload) {
  if (!CONFIG.RECEIPT_API_URL) throw new Error('영수증 서버 주소가 설정되지 않았습니다.');
  const token = getToken();
  if (!token) throw new Error('로그인이 필요합니다. 상단의 로그인 버튼을 누르세요.');
  let res;
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 70000) : null;
  try {
    res = await fetch(CONFIG.RECEIPT_API_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ token }, payload)), signal: ctl ? ctl.signal : undefined
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('영수증 서버 응답이 너무 늦습니다. 잠시 후 다시 시도하세요.');
    throw new Error('영수증 서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.');
  } finally { if (timer) clearTimeout(timer); }
  let data;
  try { data = await res.json(); } catch (e) {
    throw new Error('영수증 서버의 응답을 읽지 못했습니다. (배포 주소와 "모든 사용자" 접근 설정을 확인하세요)');
  }
  if (!data || data.ok !== true) throw new Error((data && data.error) || '영수증 서버 오류');
  return data;
}

export function ping() { return callApi({ action: 'ping' }); }

// 읽기와 드라이브 보관을 따로(동시에) 보내서, 보관 시간이 읽는 시간에 더해지지 않게 합니다.
export function parseReceipt(img, categories) {
  return callApi(Object.assign({ action: 'parseReceipt', image: img.base64, mime: img.mime, categories, save: false }, models.payload('receipt')));
}

export function storeReceipt(img) {
  return callApi({ action: 'saveReceipt', image: img.base64, mime: img.mime, fileName: img.fileName });
}

// 서버가 잠들어 있으면 첫 요청이 느립니다. 스캔 창을 여는 순간 미리 깨워 둡니다. (실패해도 무시)
let lastWarm = 0;
export function warmUp() {
  if (!apiConfigured() || !getToken() || Date.now() - lastWarm < 240000) return Promise.resolve(false);
  lastWarm = Date.now();
  return ping().then(() => true, () => { lastWarm = 0; return false; });
}

// ───────── 항목 / 세금 배분 ─────────

export function rateOf(code, taxCodes) {
  if (!code) return null;
  const row = (taxCodes || []).find((t) => String(t.tax_code) === String(code) && !L.truthy(t.deleted));
  if (row && row.rate !== '' && row.rate !== undefined) {
    const r = L.num(row.rate);
    return r > 1 ? r / 100 : r;   // 13 또는 0.13 둘 다 허용
  }
  return Object.prototype.hasOwnProperty.call(DEFAULT_RATES, code) ? DEFAULT_RATES[code] : null;
}

export function newItem(over) {
  return Object.assign({ name: '', name_raw: '', amountText: '', is_discount: false, tax_code: '', category_id: '', qty: null, unit_price: null }, over || {});
}

// ───────── 영어(한국어) 이중 표기 · 세금/팁 줄 바로잡기 ─────────

const nameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9가-힣]+/g, '');
/** 항목 이름: 영어와 한국어를 함께 "English (한국어)" 한 칸으로. 한쪽만 있으면 그대로. */
export function bilingualName(it) {
  const en = String((it && it.name_en) || '').trim(), ko = String((it && it.name_ko) || '').trim(), nm = String((it && it.name) || '').trim();
  if (en && ko) return nameKey(en) === nameKey(ko) ? en : en + ' (' + ko + ')';
  return en || ko || nm;
}
const TAX_NAME_RE = /^\s*(?:hst|gst|pst|qst|vat|(?:sales\s+)?tax|세금|부가세|부가가치세)(?![a-z])(?![-\s]*(?:free|exempt|면세))/i;
const TIP_NAME_RE = /^\s*(?:tip|gratuity|service\s+charge|팁|봉사료)(?![a-z])/i;
export const isTaxName = (n) => TAX_NAME_RE.test(String(n || ''));
export const isTipName = (n) => TIP_NAME_RE.test(String(n || ''));

/** 항목 한 줄을 세금 또는 팁 칸으로 옮기기 (kind: 'tax' | 'tip'). 옮겼으면 true */
export function moveItemTo(draft, idx, kind) {
  const it = draft.items[idx];
  if (!it || it.is_discount) return false;
  const a = L.parseAmount(it.amountText);
  if (!Number.isFinite(a) || a <= 0) return false;
  const key = kind === 'tip' ? 'tipText' : 'taxText';
  const dec = L.decimals(draft.currency || 'CAD');
  const cur = String(draft[key]).trim() === '' ? 0 : L.parseAmount(draft[key]);
  draft[key] = String(L.round((Number.isFinite(cur) ? cur : 0) + a, dec));
  draft.items.splice(idx, 1);
  return true;
}
/** 세금 ↔ 팁 서로 바꾸기 */
export function swapTaxTip(draft) {
  const t = draft.taxText;
  draft.taxText = draft.tipText;
  draft.tipText = t;
}
/** 총액에 맞춰 세금(또는 팁) 채우기. 영수증 소계가 있으면 그것을, 없으면 항목 합계를 기준으로 계산. { ok, value } | { error } */
export function fillFromTotal(draft, taxCodes, which) {
  const al = computeAllocation(draft, taxCodes);
  if (!al.total) return { error: '영수증 총액을 먼저 입력하세요.' };
  const sub = String(draft.subtotalText || '').trim() === '' ? NaN : L.parseAmount(draft.subtotalText);
  const base = Number.isFinite(sub) && sub > 0 ? sub : al.subtotal;
  const dec = al.dec;
  if (which === 'tip') {
    const tax = String(draft.taxText).trim() === '' ? al.taxApplied : L.parseAmount(draft.taxText);
    const v = L.round(al.total - base - (Number.isFinite(tax) ? tax : 0), dec);
    if (v < 0) return { error: '항목 + 세금이 이미 총액보다 큽니다.' };
    draft.tipText = v ? String(v) : '';
    return { ok: true, value: v };
  }
  const tip = al.tip;
  const v = L.round(al.total - base - tip, dec);
  if (v < 0) return { error: '항목 + 팁이 이미 총액보다 큽니다.' };
  draft.taxText = v ? String(v) : '';
  return { ok: true, value: v };
}

// ───────── 결제수단 추측 (영수증에 찍힌 카드 뒷4자리 · 카드 종류 → 내 계좌) ─────────

/** 계좌의 "뒷 4자리" 칸 → 4자리 목록. "1234, 5678" · "····1234" 처럼 쓸 수 있고, 카드번호 전체를 넣어도 마지막 4자리만 남깁니다 */
export function last4List(v) {
  const t = String(v === undefined || v === null ? '' : v);
  const out = [];
  const add = (x) => { if (out.indexOf(x) < 0) out.push(x); };
  if (!/[,;/·•]/.test(t) && t.replace(/[\s-]/g, '').replace(/\D/g, '').length >= 13 && /^[\d\s*xX•·-]+$/.test(t)) {
    add(t.replace(/\D/g, '').slice(-4));   // 카드번호 전체를 붙여 넣은 경우
    return out;
  }
  t.split(/\D+/).forEach((run) => { if (run.length >= 4) add(run.slice(-4)); });
  return out;
}
export const cleanLast4 = (v) => last4List(v).join(', ');

const GENERIC_WORDS = new Set(['card', 'credit', 'debit', 'visa', 'mastercard', 'master', 'mc', 'amex', 'american', 'express', 'discover', 'interac', 'the', 'and', 'bank', 'of', 'canada', 'canadian', 'cash', 'gift']);
const NETWORKS = [['visa', /visa/], ['mastercard', /master\s*card|\bmc\b|mastercard/], ['amex', /amex|american\s*express/]];
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9가-힣 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * 영수증의 카드 정보로 "결제 계좌"를 추측합니다.
 * parsed = { card_last4, card_brand, payment_method }, accounts = Accounts 행들(원본)
 * → { id, how: 'last4'|'brand'|'cash'|'only' } 또는 null.  last4 는 확실, 나머지는 "추측"이라 화면에서 확인하라고 알려 줍니다.
 */
export function guessPayAccount(parsed, accounts) {
  const p = parsed || {};
  const money = (accounts || []).filter((a) => L.isActive(a) && L.isMoneyAccount(a));
  const l4 = /^\d{4}$/.test(String(p.card_last4 || '')) ? String(p.card_last4) : '';
  if (l4) {
    const hit = money.filter((a) => last4List(a.last4).indexOf(l4) >= 0);
    if (hit.length) return { id: String(hit[0].account_id), how: 'last4', ambiguous: hit.length > 1 };
  }
  const text = norm((p.card_brand || '') + ' ' + (p.payment_method === 'CASH' ? 'cash' : ''));
  const method = String(p.payment_method || '').toUpperCase();
  const net = NETWORKS.find((n) => n[1].test(text));
  const isCash = method === 'CASH' || /\bcash\b|현금/.test(text);
  const isDebit = method === 'DEBIT' || /interac|debit/.test(text);
  const isCredit = method === 'CREDIT' || !!net || /credit/.test(text);
  const hay = (a) => norm([a.institution, a.name, a.name_ko].join(' '));
  let pool = [];
  let how = 'brand';
  if (isCash) { pool = money.filter((a) => a.subtype === 'CASH' || /\bcash\b|현금/.test(hay(a))); how = 'cash'; }
  else if (isDebit && !isCredit) pool = money.filter((a) => a.type === 'ASSET' && (a.subtype === 'CHEQUING' || a.subtype === 'SAVINGS' || !a.subtype));
  else if (isCredit) pool = money.filter((a) => a.type === 'LIABILITY' && (a.subtype === 'CREDIT_CARD' || !a.subtype));
  if (!pool.length) return null;
  const words = text.split(' ').filter((w) => w.length >= 2 && !GENERIC_WORDS.has(w));
  const scored = pool.map((a) => {
    const h = hay(a);
    let sc = 0;
    words.forEach((w) => { if (h.indexOf(w) >= 0) sc += 2; });
    if (net && net[1].test(h)) sc += 1;
    return { a, sc };
  }).sort((x, y) => y.sc - x.sc);
  if (scored[0].sc > 0 && (scored.length === 1 || scored[0].sc > scored[1].sc)) return { id: String(scored[0].a.account_id), how };
  if (pool.length === 1 && !words.length) return { id: String(pool[0].account_id), how: how === 'cash' ? 'cash' : 'only' };
  return null;
}

// 서버가 돌려준 결과 → 편집용 초안
// ctx = { accMap, rules, taxCodes, fromId, owner }
export function draftFromParsed(parsed, img, meta, ctx) {
  const ccy = parsed.currency || 'CAD';
  const rule = L.suggestRule(ctx.rules || [], parsed.merchant);
  const ruleCat = rule && ctx.accMap.get(String(rule.account_id)) && ctx.accMap.get(String(rule.account_id)).type === 'EXPENSE' ? String(rule.account_id) : '';
  const dec = L.decimals(ccy);
  const payGuess = ctx.accounts ? guessPayAccount(parsed, ctx.accounts) : null;
  // 세금·팁이 "항목"으로 읽혔으면 세금·팁 칸으로 옮깁니다 (항목에 그대로 두면 카테고리가 엉뚱하게 붙고 합계가 두 번 더해져요)
  let movedTax = 0, movedTip = 0, movedAny = false;
  const rawItems = (parsed.items || []).filter((it) => {
    if (it.is_discount) return true;
    if (isTaxName(it.name)) { movedTax += Number(it.amount) || 0; movedAny = true; return false; }
    if (isTipName(it.name)) { movedTip += Number(it.amount) || 0; movedAny = true; return false; }
    return true;
  });
  const items = rawItems.map((it) => newItem({
    name: bilingualName(it), name_raw: it.name_raw || '', amountText: String(L.round(it.amount, dec)), is_discount: !!it.is_discount,
    tax_code: ccy === 'CAD' ? (it.tax_code || '') : '', category_id: it.category_id || ruleCat || '', qty: it.qty, unit_price: it.unit_price
  }));
  const taxVal = parsed.tax_total === null || parsed.tax_total === undefined ? (movedTax > 0 ? movedTax : null) : parsed.tax_total;
  const tipVal = parsed.tip ? parsed.tip : (movedTip > 0 ? movedTip : 0);
  const moveWarn = movedAny ? ['Tax / tip lines that were read as items were moved to the Tax and Tip boxes (품목으로 읽힌 세금·팁 줄을 세금·팁 칸으로 옮겼어요).'] : [];
  return {
    merchant: parsed.merchant || '', date: parsed.date || L.todayStr(), currency: ccy,
    totalText: parsed.total ? String(L.round(parsed.total, dec)) : '', taxText: taxVal === null ? '' : String(L.round(taxVal, dec)),
    tipText: tipVal ? String(L.round(tipVal, dec)) : '', tipCategory: '', cadText: '', rateText: '',
    subtotalText: parsed.subtotal ? String(L.round(parsed.subtotal, dec)) : '',
    ai: { tax: taxVal === null ? '' : String(L.round(taxVal, dec)), tip: tipVal ? String(L.round(tipVal, dec)) : '', subtotal: parsed.subtotal ? String(L.round(parsed.subtotal, dec)) : '', total: parsed.total ? String(L.round(parsed.total, dec)) : '' },
    fromId: (payGuess && payGuess.id) || ctx.fromId || '', owner: ctx.owner || 'Joint', items, warnings: moveWarn.concat(parsed.warnings || []), notes: parsed.notes || '',
    pay: /^\d{4}$/.test(String(parsed.card_last4 || '')) || parsed.card_brand || parsed.payment_method
      ? { last4: /^\d{4}$/.test(String(parsed.card_last4 || '')) ? String(parsed.card_last4) : '', brand: parsed.card_brand || '', method: parsed.payment_method || '', how: payGuess ? payGuess.how : '', guessId: payGuess ? payGuess.id : '', ambiguous: !!(payGuess && payGuess.ambiguous) } : null,
    thumb: (img && img.thumb) || '', meta: meta || null, existing: null
  };
}

const sgn = (it) => (it.is_discount ? -1 : 1);

// 항목별 세금과 총액 확인. 장부에 쓰는 값은 모두 여기서 나옵니다.
export function computeAllocation(draft, taxCodes) {
  const dec = L.decimals(draft.currency || 'CAD');
  const r = (n) => L.round(n, dec);
  const lines = [];
  const errors = [];
  draft.items.forEach((it, idx) => {
    if (String(it.amountText).trim() === '' && !String(it.name).trim()) return;
    const a = L.parseAmount(it.amountText);
    if (!Number.isFinite(a) || a < 0) { errors.push('항목 ' + (idx + 1) + ' 의 금액을 확인하세요.'); return; }
    lines.push({ item: it, idx, amount: r(sgn(it) * a), rate: rateOf(it.tax_code, taxCodes), tax: 0 });
  });
  const T = String(draft.taxText).trim() === '' ? null : L.parseAmount(draft.taxText);
  if (T !== null && (!Number.isFinite(T) || T < 0)) errors.push('세금 금액을 확인하세요.');

  lines.forEach((ln) => { if (ln.rate !== null) ln.tax = r(ln.amount * ln.rate); });
  if (T !== null && Number.isFinite(T)) {
    const unknown = lines.filter((ln) => ln.rate === null);
    const knownSum = r(lines.filter((ln) => ln.rate !== null).reduce((s, ln) => s + ln.tax, 0));
    if (unknown.length) {
      // 세금 종류를 모르는 항목에는 영수증 세금에서 남은 만큼을 금액 비례로 나눕니다.
      const remaining = r(T - knownSum);
      const base = unknown.reduce((s, ln) => s + Math.abs(ln.amount), 0);
      let given = 0;
      unknown.forEach((ln, i) => {
        const part = i === unknown.length - 1 ? r(remaining - given) : (base ? r(remaining * Math.abs(ln.amount) / base) : 0);
        ln.tax = part; given = r(given + part);
      });
    } else {
      // 모두 알려진 세율인데 영수증 세금과 몇 센트 다르면(반올림) 가장 큰 과세 항목에 맞춥니다.
      const diff = r(T - knownSum);
      if (Math.abs(diff) > 0) {
        const taxable = lines.filter((ln) => ln.rate && ln.rate > 0);
        const pool = taxable.length ? taxable : lines;
        if (pool.length) pool.slice().sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount))[0].tax = r(pool.slice().sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount))[0].tax + diff);
      }
    }
  }
  lines.forEach((ln) => { ln.gross = r(ln.amount + ln.tax); });

  const tip = String(draft.tipText).trim() === '' ? 0 : L.parseAmount(draft.tipText);
  if (!Number.isFinite(tip) || tip < 0) errors.push('팁 금액을 확인하세요.');
  const subtotal = r(lines.reduce((s, ln) => s + ln.amount, 0));
  const taxApplied = r(lines.reduce((s, ln) => s + ln.tax, 0));
  const tipAmt = Number.isFinite(tip) ? r(tip) : 0;
  const computedTotal = r(subtotal + taxApplied + tipAmt);
  const total = L.parseAmount(draft.totalText);
  const totalOk = Number.isFinite(total) && total > 0;
  if (!totalOk) errors.push('영수증 총액을 입력하세요.');
  const diff = totalOk ? r(total - computedTotal) : 0;
  return { lines, subtotal, taxApplied, tip: tipAmt, computedTotal, total: totalOk ? r(total) : 0, diff, errors, dec };
}

// 총액이 안 맞을 때 한 번에 맞추는 "조정 항목" (diff 만큼)
export function addAdjustment(draft, taxCodes) {
  const al = computeAllocation(draft, taxCodes);
  if (!al.errors.length && Math.abs(al.diff) >= 0.005) {
    draft.items.push(newItem({ name: 'Adjustment (조정)', amountText: String(Math.abs(al.diff)), is_discount: al.diff < 0, tax_code: 'NONE', category_id: (draft.items.find((i) => i.category_id) || {}).category_id || '' }));
  }
  return draft;
}

// ───────── 장부 기록 만들기 ─────────

function pairExisting(oldList, keyOf, newKeys) {
  const used = new Set();
  const assigned = newKeys.map(() => null);
  newKeys.forEach((k, i) => {
    const j = oldList.findIndex((o, x) => !used.has(x) && keyOf(o) === k);
    if (j >= 0) { used.add(j); assigned[i] = oldList[j]; }
  });
  newKeys.forEach((k, i) => {
    if (assigned[i]) return;
    const j = oldList.findIndex((o, x) => !used.has(x));
    if (j >= 0) { used.add(j); assigned[i] = oldList[j]; }
  });
  return { assigned, leftovers: oldList.filter((o, x) => !used.has(x)) };
}

// ctx = { accMap, taxCodes, now, existing: {txn, ps, lineItems, receipt} | null }
export function makeReceiptRecords(draft, ctx) {
  const now = ctx.now || L.nowIso();
  const accMap = ctx.accMap;
  const A = (id) => accMap.get(String(id));
  const ccy = draft.currency || 'CAD';
  const al = computeAllocation(draft, ctx.taxCodes);
  if (al.errors.length) return { error: al.errors[0] };
  if (!al.lines.length) return { error: '항목이 하나도 없습니다.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date || '')) return { error: '날짜를 입력하세요.' };
  if (!L.isMoneyAccount(A(draft.fromId))) return { error: '결제 계좌를 선택하세요.' };
  if (Math.abs(al.diff) >= 0.005) return { error: '항목 합계 + 세금 + 팁이 영수증 총액과 ' + L.fmtNumber(Math.abs(al.diff), ccy) + ' 다릅니다. 항목을 고치거나 "조정 항목 추가"를 누르세요.' };
  const noCat = al.lines.find((ln) => { const c = A(ln.item.category_id); return !c || !(c.type === 'EXPENSE'); });
  if (noCat) return { error: '"' + (noCat.item.name || '항목 ' + (noCat.idx + 1)) + '" 의 카테고리를 선택하세요.' };

  // 카테고리별 합계 (팁은 가장 큰 항목의 카테고리, 또는 직접 고른 카테고리)
  const bigCat = al.lines.slice().sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount))[0].item.category_id;
  const tipCat = al.tip > 0 ? (A(draft.tipCategory) && A(draft.tipCategory).type === 'EXPENSE' ? draft.tipCategory : bigCat) : '';
  const groups = new Map();
  al.lines.forEach((ln) => groups.set(String(ln.item.category_id), L.round((groups.get(String(ln.item.category_id)) || 0) + ln.gross, al.dec)));
  if (al.tip > 0) groups.set(String(tipCat), L.round((groups.get(String(tipCat)) || 0) + al.tip, al.dec));
  const cats = Array.from(groups.keys());

  // 통화: 외화면 CAD 청구액(정확) 또는 환율(임시)
  let rate = 1, cadTotal = al.total, fxStatus = 'ACTUAL', fxSource = '';
  if (ccy !== 'CAD') {
    const cadIn = L.parseAmount(draft.cadText), rateIn = L.parseAmount(draft.rateText);
    if (cadIn > 0) { cadTotal = L.round(cadIn, 2); rate = L.round(cadTotal / al.total, 6); fxSource = 'MANUAL'; }
    else if (rateIn > 0) { rate = rateIn; cadTotal = L.round(al.total * rate, 2); fxStatus = 'PROVISIONAL'; fxSource = 'MANUAL'; }
    else return { error: '외화 영수증은 CAD 청구액 또는 환율을 입력하세요.' };
  }
  const cadOf = new Map();
  let allocated = 0;
  cats.forEach((c) => { const v = ccy === 'CAD' ? groups.get(c) : L.round(groups.get(c) * rate, 2); cadOf.set(c, v); allocated = L.round(allocated + v, 2); });
  const fix = L.round(cadTotal - allocated, 2);
  if (fix !== 0) {
    const big = cats.slice().sort((x, y) => Math.abs(cadOf.get(y)) - Math.abs(cadOf.get(x)))[0];
    cadOf.set(big, L.round(cadOf.get(big) + fix, 2));
  }

  const ex = ctx.existing || null;
  const txnId = ex ? ex.txn.txn_id : L.newId('t');
  const oldPs = ex ? ex.ps.filter((p) => !L.truthy(p.deleted)) : [];
  const accIds = cats.concat([String(draft.fromId)]);
  const pairP = pairExisting(oldPs, (p) => String(p.account_id), accIds);
  const mkP = (accId, i, orig, cad) => ({
    posting_id: pairP.assigned[i] ? pairP.assigned[i].posting_id : L.newId('p'), txn_id: txnId, line_id: '', account_id: String(accId),
    amount_cad: cad, amount_orig: orig, currency: ccy, fx_rate: rate, memo: '', updated_at: now, deleted: false
  });
  const postings = cats.map((c, i) => mkP(c, i, groups.get(c), cadOf.get(c)));
  postings.push(mkP(draft.fromId, cats.length, -al.total, -cadTotal));
  pairP.leftovers.forEach((p) => postings.push(Object.assign({}, p, { deleted: true, updated_at: now })));
  const sum = postings.filter((p) => !L.truthy(p.deleted)).reduce((s, p) => s + p.amount_cad, 0);
  if (Math.abs(sum) > 0.005) return { error: '차변과 대변이 맞지 않습니다.' };

  // 항목 행 (팁은 별도 행)
  const rows = al.lines.map((ln) => ({
    name: ln.item.name || '(item)', name_raw: ln.item.name_raw || ln.item.name || '', qty: ln.item.qty, unit_price: ln.item.unit_price,
    amount: ln.amount, is_discount: !!ln.item.is_discount, tax_code: ln.item.tax_code || '', tax: ln.tax, cat: String(ln.item.category_id)
  }));
  if (al.tip > 0) rows.push({ name: TIP_LABEL, name_raw: TIP_LABEL, qty: null, unit_price: null, amount: al.tip, is_discount: false, tax_code: 'NONE', tax: 0, cat: String(tipCat) });
  const oldLines = ex ? (ex.lineItems || []).filter((l) => !L.truthy(l.deleted)).sort((a, b) => L.num(a.line_no) - L.num(b.line_no)) : [];
  const confidence = draft.meta && draft.meta.confidence !== undefined && draft.meta.confidence !== null ? draft.meta.confidence : '';
  const lineItems = rows.map((rw, i) => ({
    line_id: oldLines[i] ? oldLines[i].line_id : L.newId('l'), txn_id: txnId, line_no: i + 1, item_name: rw.name, item_name_raw: rw.name_raw,
    qty: rw.qty === null || rw.qty === undefined ? '' : rw.qty, unit_price: rw.unit_price === null || rw.unit_price === undefined ? '' : rw.unit_price,
    line_amount: rw.amount, is_discount: rw.is_discount, tax_code: rw.tax_code, tax_amount: rw.tax, category_account_id: rw.cat,
    ai_confidence: confidence, user_confirmed: true, updated_at: now, deleted: false
  }));
  oldLines.slice(rows.length).forEach((l) => lineItems.push(Object.assign({}, l, { deleted: true, updated_at: now })));

  // 영수증 원본 기록 (새 영수증일 때만)
  let receipt = null;
  const receiptId = ex && ex.txn.receipt_id ? ex.txn.receipt_id : (draft.meta ? L.newId('rc') : '');
  if (!ex && draft.meta) {
    const m = draft.meta;
    receipt = {
      receipt_id: receiptId, txn_id: txnId, drive_file_id: (m.drive && m.drive.fileId) || '', file_name: (m.drive && m.drive.fileName) || m.fileName || '',
      mime: m.mime || '', sha256: m.sha256 || '', parse_status: 'PARSED', parse_model: m.model || '', parsed_json: String(m.parsedJson || '').slice(0, 45000),
      confidence, error: m.driveError || '', uploaded_at: now, updated_at: now, deleted: false
    };
  }

  const base = ex ? ex.txn : {};
  const tax = al.taxApplied;
  const txn = Object.assign({}, base, {
    txn_id: txnId, date: draft.date, merchant: (draft.merchant || '').trim(), memo: base.memo || '', currency: ccy,
    subtotal_orig: al.subtotal, tax_orig: tax, tip_orig: al.tip || '', total_orig: al.total, fx_rate: rate, fx_source: fxSource, fx_status: fxStatus,
    total_cad: cadTotal, source: base.source || 'RECEIPT', status: base.status || 'PENDING_MATCH', owner: draft.owner || 'Joint',
    is_passthrough: false, receipt_id: receiptId, created_at: base.created_at || now, updated_at: now, deleted: false
  });
  const rule = draft.merchant && cats.length === 1 ? L.learnRule(ctx.rules || [], draft.merchant, cats[0], now) : null;
  return { txn, postings, lineItems, receipt, rule, alloc: al };
}

// 이미 저장한 영수증 사진인지 (같은 사진 = 같은 sha256)
export function findDuplicate(receipts, txns, sha) {
  if (!sha) return null;
  const rc = (receipts || []).find((r) => !L.truthy(r.deleted) && r.sha256 === sha);
  if (!rc) return null;
  const t = (txns || []).find((x) => !L.truthy(x.deleted) && String(x.txn_id) === String(rc.txn_id));
  return t ? { receipt: rc, txn: t } : null;
}

// 저장된 영수증 거래 → 편집용 초안 (ctx = { accMap, postings(거래의 분개), lineItems(거래의 항목), receipt })
export function draftFromExisting(txn, ctx) {
  const ccy = txn.currency || 'CAD';
  const dec = L.decimals(ccy);
  const lines = (ctx.lineItems || []).filter((l) => !L.truthy(l.deleted)).sort((a, b) => L.num(a.line_no) - L.num(b.line_no));
  const from = (ctx.postings || []).filter((p) => !L.truthy(p.deleted)).find((p) => L.isMoneyAccount(ctx.accMap.get(String(p.account_id))));
  const tipLine = lines.find((l) => String(l.item_name) === TIP_LABEL && String(l.tax_code) === 'NONE');
  const items = lines.filter((l) => l !== tipLine).map((l) => newItem({
    name: l.item_name, name_raw: l.item_name_raw, amountText: String(L.round(Math.abs(L.num(l.line_amount)), dec)),
    is_discount: L.truthy(l.is_discount), tax_code: l.tax_code || '', category_id: String(l.category_account_id || ''),
    qty: l.qty === '' ? null : L.num(l.qty), unit_price: l.unit_price === '' ? null : L.num(l.unit_price)
  }));
  const m = ctx.receipt ? { drive: { fileId: ctx.receipt.drive_file_id, fileName: ctx.receipt.file_name }, sha256: ctx.receipt.sha256, confidence: ctx.receipt.confidence } : null;
  return {
    merchant: txn.merchant || '', date: txn.date, currency: ccy, totalText: String(L.round(L.num(txn.total_orig), dec)),
    taxText: String(L.round(L.num(txn.tax_orig), dec)), tipText: tipLine ? String(L.round(L.num(tipLine.line_amount), dec)) : '',
    tipCategory: tipLine ? String(tipLine.category_account_id || '') : '',
    cadText: ccy !== 'CAD' && String(txn.fx_status).toUpperCase() !== 'PROVISIONAL' ? String(L.num(txn.total_cad)) : '',
    rateText: ccy !== 'CAD' && String(txn.fx_status).toUpperCase() === 'PROVISIONAL' ? String(L.num(txn.fx_rate)) : '',
    fromId: from ? String(from.account_id) : '', owner: txn.owner || 'Joint', items, warnings: [], notes: '', thumb: '', meta: m, existing: true
  };
}
