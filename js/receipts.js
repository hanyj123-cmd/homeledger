// 영수증: 사진 준비 → 서버(Apps Script + Gemini) 호출 → 항목/세금 배분 → 장부 기록 만들기.
// 계산(배분·기록 만들기)은 화면과 무관한 순수 로직이라 테스트로 검증합니다.
import { CONFIG } from './config.js';
import * as L from './ledger.js';
import { getToken } from './auth.js';

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

// 큰 사진은 가로/세로 1600px 이하 JPEG 로 줄여서 보냅니다. (업로드가 빠르고 인식에는 충분)
export async function prepareImage(file) {
  const type = String(file.type || '').toLowerCase();
  if (type === 'application/pdf') {
    if (file.size > 6 * 1024 * 1024) throw new Error('PDF 가 너무 큽니다 (6MB 이하).');
    const base64 = await blobToBase64(file);
    return { base64, mime: 'application/pdf', fileName: file.name || 'receipt.pdf', thumb: '', sha256: await sha256OfBase64(base64) };
  }
  try {
    const bmp = await createImageBitmap(file);
    const blob = await drawToJpeg(bmp, bmp.width, bmp.height, MAX_DIM, 0.82);
    const thumbBlob = await drawToJpeg(bmp, bmp.width, bmp.height, 240, 0.6);
    if (bmp.close) bmp.close();
    const [base64, thumb] = await Promise.all([blobToBase64(blob), blobToBase64(thumbBlob)]);
    return {
      base64, mime: 'image/jpeg', fileName: (file.name || 'receipt').replace(/\.[^.]+$/, '') + '.jpg',
      thumb: 'data:image/jpeg;base64,' + thumb, sha256: await sha256OfBase64(base64)
    };
  } catch (e) {
    // HEIC 등 브라우저가 못 여는 형식은 원본 그대로 (서버가 지원)
    if (file.size > 6 * 1024 * 1024) throw new Error('이 사진 형식은 크기를 줄일 수 없습니다. 사진 앱에서 JPEG 로 저장해 다시 올려 주세요.');
    const base64 = await blobToBase64(file);
    return { base64, mime: type || 'image/jpeg', fileName: file.name || 'receipt', thumb: '', sha256: await sha256OfBase64(base64) };
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
  return callApi({ action: 'parseReceipt', image: img.base64, mime: img.mime, categories, save: false });
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

// 서버가 돌려준 결과 → 편집용 초안
// ctx = { accMap, rules, taxCodes, fromId, owner }
export function draftFromParsed(parsed, img, meta, ctx) {
  const ccy = parsed.currency || 'CAD';
  const rule = L.suggestRule(ctx.rules || [], parsed.merchant);
  const ruleCat = rule && ctx.accMap.get(String(rule.account_id)) && ctx.accMap.get(String(rule.account_id)).type === 'EXPENSE' ? String(rule.account_id) : '';
  const dec = L.decimals(ccy);
  const items = (parsed.items || []).map((it) => newItem({
    name: it.name, name_raw: it.name_raw || '', amountText: String(L.round(it.amount, dec)), is_discount: !!it.is_discount,
    tax_code: ccy === 'CAD' ? (it.tax_code || '') : '', category_id: it.category_id || ruleCat || '', qty: it.qty, unit_price: it.unit_price
  }));
  return {
    merchant: parsed.merchant || '', date: parsed.date || L.todayStr(), currency: ccy,
    totalText: parsed.total ? String(L.round(parsed.total, dec)) : '', taxText: parsed.tax_total === null || parsed.tax_total === undefined ? '' : String(L.round(parsed.tax_total, dec)),
    tipText: parsed.tip ? String(L.round(parsed.tip, dec)) : '', tipCategory: '', cadText: '', rateText: '',
    fromId: ctx.fromId || '', owner: ctx.owner || 'Joint', items, warnings: parsed.warnings || [], notes: parsed.notes || '',
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
