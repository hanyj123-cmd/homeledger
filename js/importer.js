// 명세서 가져오기: 파일 읽기(CSV/XLSX/PDF) → 열 추측 → 줄 만들기 → 중복/대사 → 기록 만들기.
// 이 파일의 계산 부분은 화면과 무관한 순수 로직이라 테스트로 검증할 수 있습니다.
//
// 금액 규칙: 명세서 줄의 amount 는 "나간 돈(+) / 들어온 돈(−)" 입니다.
//   - 입출금 계좌: 출금 +, 입금 −   - 카드: 사용 +, 결제/환불 −
import { CONFIG } from './config.js';
import * as L from './ledger.js';

export const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
export const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
export const PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

export const DEFAULT_SKIP_RE = 'opening balance|closing balance|balance forward|previous balance|starting balance|ending balance|total (debits|credits|payments|purchases)';
export const UNCATEGORIZED_ID = '9999';
export const AUTO_MATCH_SCORE = 0.85;
export const MATCH_WINDOW_DAYS = 5;

// ───────── 라이브러리 불러오기 (브라우저에서만) ─────────

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('라이브러리를 불러오지 못했습니다 (인터넷 확인): ' + url));
    document.head.append(s);
  });
}
export async function getXLSX() {
  if (!globalThis.XLSX) await loadScript(XLSX_URL);
  return globalThis.XLSX;
}
export async function getPdfJs() {
  if (!globalThis.pdfjsLib) await loadScript(PDFJS_URL);
  const lib = globalThis.pdfjsLib;
  // 다른 주소의 워커는 브라우저가 막을 수 있어, 내려받아 같은 출처의 blob 으로 실행합니다.
  try {
    const res = await fetch(PDFJS_WORKER_URL);
    const blob = new Blob([await res.text()], { type: 'text/javascript' });
    lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  } catch (e) {
    lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  }
  return lib;
}

// ───────── 파일 → 행(표) ─────────

export function parseCsv(text) {
  let s = String(text || '').replace(/^﻿/, '');
  const firstLine = s.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => firstLine.split(ch).length - 1;
  let delim = ',';
  if (count('\t') > count(',') && count('\t') >= count(';')) delim = '\t';
  else if (count(';') > count(',')) delim = ';';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

export function xlsxToRows(XLSX, buf) {
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

// PDF 의 글자 조각들을 같은 줄끼리 묶습니다. (y 좌표 기준)
export function itemsToLines(items) {
  const toks = items
    .map((it) => ({ s: String(it.str || ''), x: it.transform[4], y: it.transform[5], w: it.width || 0 }))
    .filter((t) => t.s.trim() !== '');
  toks.sort((a, b) => (Math.abs(b.y - a.y) > 2.5 ? b.y - a.y : a.x - b.x));
  const groups = [];
  toks.forEach((t) => {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.y - t.y) <= 2.5) g.items.push(t);
    else groups.push({ y: t.y, items: [t] });
  });
  return groups.map((g) => {
    g.items.sort((a, b) => a.x - b.x);
    let out = '', end = null;
    g.items.forEach((t) => {
      if (end !== null) {
        const gap = t.x - end;
        out += gap > 6 ? '  ' : gap > 1 ? ' ' : '';
      }
      out += t.s;
      end = t.x + t.w;
    });
    return out.trim();
  });
}

const PDF_DATE = /^\s*((?:\d{4}[-/]\d{1,2}[-/]\d{1,2})|(?:\d{1,2}\/\d{1,2}\/\d{2,4})|(?:[A-Za-z]{3,9}\.?\s+\d{1,2}(?:,?\s+\d{4})?)|(?:\d{1,2}\s+[A-Za-z]{3,9}\.?(?:\s+\d{4})?))(?=\s)/;
const PDF_AMT = /\s+(\(?-?\$?\d{1,3}(?:,\d{3})+\.\d{2}\)?-?|\(?-?\$?\d+\.\d{2}\)?-?)(?:\s*(CR|DR))?\s*$/i;

// "Jan 02  COSTCO  45.10  1,234.50" 같은 줄 → [날짜, 설명, 금액들…]
export function textLinesToRows(lines) {
  const rows = [];
  lines.forEach((line) => {
    const dm = line.match(PDF_DATE);
    if (!dm || parseDate(dm[1], 'AUTO', { year: 2000 }).error) return;
    let rest = line.slice(dm[0].length);
    const dm2 = rest.match(PDF_DATE);
    if (dm2 && !parseDate(dm2[1], 'AUTO', { year: 2000 }).error) rest = rest.slice(dm2[0].length);
    const amts = [];
    for (let i = 0; i < 3; i++) {
      const am = rest.match(PDF_AMT);
      if (!am) break;
      let a = am[1];
      if (am[2] && am[2].toUpperCase() === 'CR') a = '-' + a.replace(/^-/, '');
      amts.unshift(a);
      rest = rest.slice(0, rest.length - am[0].length);
    }
    if (!amts.length) return;
    rows.push([dm[1].trim(), rest.replace(/\s{2,}/g, ' ').trim()].concat(amts));
  });
  return rows;
}

export async function pdfToRows(pdfjs, buf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  let lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    lines = lines.concat(itemsToLines(tc.items));
  }
  return textLinesToRows(lines);
}

// 파일 하나를 행으로. file = { name, arrayBuffer() }
export async function readFileRows(file, libs) {
  const name = String(file.name || '').toLowerCase();
  const buf = await file.arrayBuffer();
  if (/\.(xlsx|xls|xlsm)$/.test(name)) {
    const X = (libs && libs.XLSX) || await getXLSX();
    return { kind: 'XLSX', rows: xlsxToRows(X, buf) };
  }
  if (/\.pdf$/.test(name)) {
    const P = (libs && libs.pdfjs) || await getPdfJs();
    return { kind: 'PDF', rows: await pdfToRows(P, buf) };
  }
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.indexOf('�') >= 0) { try { text = new TextDecoder('windows-1252').decode(buf); } catch (e) { /* keep */ } }
  return { kind: 'CSV', rows: parseCsv(text) };
}

// ───────── 값 해석 ─────────

export function parseMoney(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v === undefined || v === null ? '' : v).trim().replace(/[−–]/g, '-');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/-\s*$/.test(s)) { neg = !neg; s = s.replace(/-\s*$/, ''); }
  if (/^\s*-/.test(s)) { neg = !neg; s = s.replace(/^\s*-/, ''); }
  s = s.replace(/CAD|USD|\$|,|\s/gi, '');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = parseFloat(s);
  return neg ? -n : n;
}

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const monthNum = (w) => MON[String(w).toLowerCase().replace(/\.$/, '').slice(0, 4)] || MON[String(w).toLowerCase().slice(0, 3)] || 0;
const pad = (n) => (n < 10 ? '0' : '') + n;

function validYmd(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1)) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// 파일 이름에서 연도(와 월) 힌트: TD_Statement_2025_01.csv → {year:2025, month:1}
export function yearHintFromName(name) {
  const m = String(name || '').match(/(20\d{2})(?:[-_.\s]?(0[1-9]|1[0-2]))?(?!\d)/);
  if (!m) return null;
  return { year: +m[1], month: m[2] ? +m[2] : null };
}

// hint = { year, month }  (연도 없는 날짜용)
export function parseDate(v, fmt, hint) {
  hint = hint || {};
  fmt = fmt || 'AUTO';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return { error: 'bad date' };
    const t = new Date(v.getTime() + 12 * 3600 * 1000);
    return { iso: t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()), yearless: false };
  }
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) return parseDate(new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000), fmt, hint);
    return { error: 'not a date' };
  }
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return { error: 'empty' };
  let m, y = null, mo = 0, d = 0;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) {
    const a = +m[1], b = +m[2];
    y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    if (fmt === 'DMY') { d = a; mo = b; }
    else if (fmt === 'MDY') { mo = a; d = b; }
    else if (a > 12) { d = a; mo = b; }
    else if (b > 12) { mo = a; d = b; }
    else { mo = a; d = b; }
  } else if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/)) && monthNum(m[1])) {
    mo = monthNum(m[1]); d = +m[2]; y = m[3] ? +m[3] : null;
  } else if ((m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?(?:,?[\s-]+(\d{2}|\d{4}))?$/)) && monthNum(m[2])) {
    mo = monthNum(m[2]); d = +m[1]; y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null;
  } else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})$/))) {
    if (fmt === 'DMY') { d = +m[1]; mo = +m[2]; } else { mo = +m[1]; d = +m[2]; }
  } else return { error: 'not a date' };

  let yearless = false;
  if (y === null) {
    yearless = true;
    if (!hint.year) return { error: 'needs year', yearless: true };
    y = hint.year;
    // 1월 명세서에 12월 줄이 들어 있으면 작년
    if (hint.month && mo - hint.month > 6) y -= 1;
  }
  if (!validYmd(y, mo, d)) return { error: 'bad date' };
  return { iso: y + '-' + pad(mo) + '-' + pad(d), yearless };
}

// ───────── 열 추측 ─────────

const cellStr = (c) => (c === undefined || c === null ? '' : c instanceof Date ? 'date' : String(c).trim());

export function defaultProfile() {
  return {
    has_header: false, date_col: '', date_format: 'AUTO', year_source: 'COLUMN', desc_cols: '',
    debit_col: '', credit_col: '', amount_col: '', sign_flip: false, skip_rows_regex: DEFAULT_SKIP_RE
  };
}

export function colCount(rows) { return rows.reduce((m, r) => Math.max(m, r.length), 0); }

// 데이터가 시작되는 첫 줄 번호와 열 이름표
export function headerInfo(rows, dateCol) {
  const first = rows.findIndex((r) => !parseDate(r[dateCol], 'AUTO', { year: 2000 }).error);
  const n = colCount(rows);
  const labels = [];
  const hr = first > 0 ? rows[first - 1] : null;
  const looksHeader = hr && hr.filter((c) => cellStr(c)).length >= 2 &&
    hr.every((c) => parseMoney(c) === null && parseDate(c, 'AUTO', { year: 2000 }).error);
  for (let c = 0; c < n; c++) labels.push(looksHeader ? cellStr(hr[c]) : '');
  return { firstData: first, headerRow: looksHeader ? first - 1 : -1, labels };
}

export function guessProfile(rows) {
  const p = defaultProfile();
  const n = colCount(rows);
  if (!rows.length || !n) return p;
  // 날짜 열: 날짜로 읽히는 칸이 가장 많은 열
  let dateCol = -1, best = 0;
  for (let c = 0; c < n; c++) {
    let k = 0;
    rows.forEach((r) => { if (!parseDate(r[c], 'AUTO', { year: 2000 }).error) k++; });
    if (k > best) { best = k; dateCol = c; }
  }
  if (dateCol < 0) return p;
  p.date_col = String(dateCol);
  const info = headerInfo(rows, dateCol);
  p.has_header = info.headerRow === 0;
  const data = rows.filter((r) => !parseDate(r[dateCol], 'AUTO', { year: 2000 }).error);
  const total = data.length || 1;
  p.year_source = data.every((r) => parseDate(r[dateCol], 'AUTO', { year: 2000 }).yearless) ? 'FILENAME' : 'COLUMN';

  const cols = [];
  for (let c = 0; c < n; c++) {
    if (c === dateCol) continue;
    let numeric = 0, text = 0, len = 0, neg = 0, pos = 0;
    data.forEach((r) => {
      const v = r[c];
      if (cellStr(v) === '') return;
      const m = parseMoney(v);
      if (m !== null) { numeric++; if (m < 0) neg++; else if (m > 0) pos++; } else { text++; len += cellStr(v).length; }
    });
    cols.push({ c, numeric, text, avg: text ? len / text : 0, neg, pos, label: (info.labels[c] || '').toLowerCase() });
  }
  const isBal = (x) => /balance|running/.test(x.label);
  const nums = cols.filter((x) => x.numeric >= 1 && x.numeric >= x.text && !isBal(x));
  const byLabel = (re) => nums.find((x) => re.test(x.label));
  const debitL = byLabel(/debit|withdraw|paid out|money out|charge|\bout\b/);
  const creditL = byLabel(/credit|deposit|paid in|money in|\bin\b/);
  if (debitL && creditL && debitL !== creditL) {
    p.debit_col = String(debitL.c); p.credit_col = String(creditL.c);
  } else if (nums.length >= 2 && !nums.some((x) => /amount/.test(x.label))) {
    const [a, b, third] = nums;
    const complementary = (a.numeric + b.numeric) / total <= 1.3;
    if (third || complementary) { p.debit_col = String(a.c); p.credit_col = String(b.c); }
    else { p.amount_col = String(a.c); }
  } else if (nums.length) {
    const x = nums.find((q) => /amount/.test(q.label)) || nums[0];
    p.amount_col = String(x.c);
    p.sign_flip = x.neg > x.pos;
  }
  // 설명 열
  const texts = cols.filter((x) => x.text / total >= 0.4 && x.text > x.numeric);
  const named = texts.filter((x) => /desc|merchant|payee|detail|transaction|name|memo/.test(x.label));
  let desc = named.slice(0, 2);
  if (!desc.length && texts.length) desc = [texts.slice().sort((a, b) => b.avg - a.avg)[0]];
  p.desc_cols = desc.map((x) => x.c).sort((a, b) => a - b).join(',');
  return p;
}

// ───────── 줄 만들기 ─────────

const FOREIGN_RE = /\b(USD|EUR|GBP|JPY|KRW|CNY|AUD|MXN)\s*(\d[\d,]*\.?\d*)|(\d[\d,]*\.?\d*)\s*(USD|EUR|GBP|JPY|KRW|CNY|AUD|MXN)\b/i;

export function foreignHint(desc) {
  const m = String(desc || '').match(FOREIGN_RE);
  if (!m) return null;
  const ccy = (m[1] || m[4]).toUpperCase();
  const amt = parseFloat(String(m[2] || m[3]).replace(/,/g, ''));
  return Number.isFinite(amt) && amt > 0 ? { currency: ccy, amount: amt } : null;
}

const POS_PREFIX = /^(pos purchase|point of sale|purchase|visa debit purchase|interac purchase|debit memo|pre-?authorized (debit|payment))\s*[-–:]?\s*/i;
export function cleanMerchant(desc) {
  let s = String(desc || '').replace(/\s+/g, ' ').trim();
  const t = s.replace(POS_PREFIX, '');
  if (t) s = t;
  return s;
}

const colIdx = (v) => (v === '' || v === undefined || v === null ? -1 : parseInt(v, 10));

// profile 을 적용해 줄 목록을 만듭니다.
// ctx = { filename, promptYear }
export function applyProfile(rows, profile, ctx) {
  const p = Object.assign(defaultProfile(), profile || {});
  ctx = ctx || {};
  const dc = colIdx(p.date_col);
  const out = { lines: [], skipped: [], needYear: false, year: null };
  if (dc < 0) return out;
  let hint = { year: null, month: null };
  const fromName = yearHintFromName(ctx.filename);
  if (p.year_source !== 'PROMPT' && fromName) hint = fromName;
  else if (ctx.promptYear) hint = { year: +ctx.promptYear, month: null };
  else if (fromName) hint = fromName;
  out.year = hint.year;
  let skipRe = null;
  try { skipRe = p.skip_rows_regex ? new RegExp(p.skip_rows_regex, 'i') : null; } catch (e) { skipRe = null; }
  const descCols = String(p.desc_cols || '').split(',').map((x) => colIdx(x.trim())).filter((x) => x >= 0);
  const di = colIdx(p.debit_col), ci = colIdx(p.credit_col), ai = colIdx(p.amount_col);
  const flip = L.truthy(p.sign_flip);

  rows.forEach((row, idx) => {
    if (idx === 0 && L.truthy(p.has_header)) return;
    const text = row.map(cellStr).join(' ');
    if (skipRe && skipRe.test(text)) { out.skipped.push({ idx, reason: 'balance line (잔액 줄)', text }); return; }
    const dt = parseDate(row[dc], p.date_format, hint);
    if (dt.error) {
      if (dt.error === 'needs year') out.needYear = true;
      if (text.trim() && dt.error !== 'empty') out.skipped.push({ idx, reason: dt.error === 'needs year' ? 'needs year (연도 필요)' : 'no date (날짜 없음)', text });
      return;
    }
    let amount = null;
    if (di >= 0 || ci >= 0) {
      const d = di >= 0 ? parseMoney(row[di]) : null;
      const c = ci >= 0 ? parseMoney(row[ci]) : null;
      if (d === null && c === null) { out.skipped.push({ idx, reason: 'no amount (금액 없음)', text }); return; }
      amount = Math.abs(d || 0) - Math.abs(c || 0);
      if (flip) amount = -amount;
    } else if (ai >= 0) {
      const v = parseMoney(row[ai]);
      if (v === null) { out.skipped.push({ idx, reason: 'no amount (금액 없음)', text }); return; }
      amount = flip ? -v : v;
    } else { out.skipped.push({ idx, reason: 'no amount column (금액 열 미지정)', text }); return; }
    amount = L.round(amount, 2);
    if (amount === 0) { out.skipped.push({ idx, reason: 'zero (0원)', text }); return; }
    const description = descCols.map((c) => cellStr(row[c])).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const fh = foreignHint(description);
    out.lines.push({
      idx, date: dt.iso, description, merchant: cleanMerchant(description),
      amount, foreign: fh
    });
  });
  return out;
}

// ───────── 중복 / 대사 ─────────

const prefixOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
const centsOf = (n) => Math.round(Math.abs(n) * 100) * (n < 0 ? -1 : 1);

// 같은 날짜·금액 줄이 파일 안에 여러 개여도 번호(#n)로 구분합니다.
// 이미 가져온 줄과 키가 같고 설명 앞부분도 같으면 중복입니다.
export function assignKeys(accountId, lines, existing) {
  const have = new Map();
  existing.forEach((e) => { have.set(String(e.dedupe_key), prefixOf(e.description_raw)); });
  const used = new Set();
  lines.forEach((ln) => {
    const base = accountId + '|' + ln.date + '|' + centsOf(ln.amount);
    const pre = prefixOf(ln.description);
    let n = 1;
    let dup = false;
    for (;;) {
      const key = base + '|' + n;
      if (used.has(key)) { n++; continue; }
      if (have.has(key)) {
        if (have.get(key) === pre) { dup = true; used.add(key); ln.dedupe_key = key; break; }
        n++; continue;
      }
      used.add(key); ln.dedupe_key = key; break;
    }
    ln.dup = dup;
    if (dup) {
      // "그래도 가져오기"를 고르면 쓸 새 키
      let m = n + 1;
      while (used.has(base + '|' + m) || have.has(base + '|' + m)) m++;
      ln.altKey = base + '|' + m;
      used.add(ln.altKey);
    }
  });
  return lines;
}

const dayNum = (iso) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000);

function nameSim(a, b) {
  const x = L.normMerchant(a), y = L.normMerchant(b);
  if (!x || !y) return 0.3;
  if (x === y) return 1;
  if (x.indexOf(y) >= 0 || y.indexOf(x) >= 0) return 0.9;
  const tx = new Set(x.split(' ')), ty = new Set(y.split(' '));
  let inter = 0;
  tx.forEach((t) => { if (ty.has(t)) inter++; });
  const uni = tx.size + ty.size - inter;
  return uni ? inter / uni : 0;
}

// 명세서 줄 ↔ 이미 입력된 거래 짝짓기. 점수 = 0.4 이름 + 0.3 금액 + 0.3 날짜
// items = [{txn, ps, desc}], claimed = Set("txnId|accountId")
export function matchLines(lines, accountId, items, claimed) {
  const cands = [];
  const acct = String(accountId);
  lines.forEach((ln, li) => {
    const sign = ln.amount > 0 ? -1 : 1;           // 나간 돈 → 이 계좌의 분개는 −
    const want = Math.abs(ln.amount);
    items.forEach((it, ii) => {
      if (claimed.has(String(it.txn.txn_id) + '|' + acct)) return;
      const post = it.ps.find((p) => String(p.account_id) === acct);
      if (!post) return;
      const v = L.num(post.amount_cad);
      if (Math.sign(v) !== sign || Math.abs(Math.abs(v) - want) > 0.005) return;
      const diff = Math.abs(dayNum(ln.date) - dayNum(it.txn.date));
      if (diff > MATCH_WINDOW_DAYS) return;
      const isTransfer = it.desc.kind === 'TRANSFER';
      const name = isTransfer ? 0.85 : nameSim(ln.description, it.txn.merchant || it.txn.memo || '');
      const score = 0.4 * name + 0.3 + 0.3 * (1 - diff / (MATCH_WINDOW_DAYS + 1));
      cands.push({ li, ii, score });
    });
  });
  cands.sort((a, b) => b.score - a.score);
  const res = lines.map(() => null);
  const usedLine = new Set(), usedItem = new Set();
  cands.forEach((c) => {
    if (usedLine.has(c.li) || usedItem.has(c.ii)) return;
    usedLine.add(c.li); usedItem.add(c.ii);
    res[c.li] = { txnId: String(items[c.ii].txn.txn_id), score: L.round(c.score, 2), item: items[c.ii] };
  });
  return res;
}

// ───────── 미리보기 ─────────

// ctx = { accountId, accMap, rules, items, stmtLines }
export function buildPreview(parsedLines, ctx) {
  const accountId = String(ctx.accountId);
  const all = (ctx.stmtLines || []).filter((s) => !L.truthy(s.deleted));
  const mine = all.filter((s) => String(s.account_id) === accountId);
  assignKeys(accountId, parsedLines, mine);
  const claimed = new Set(all.filter((s) => s.matched_txn_id).map((s) => String(s.matched_txn_id) + '|' + s.account_id));
  const fresh = parsedLines.filter((l) => !l.dup);
  const matches = matchLines(fresh, accountId, ctx.items || [], claimed);
  const mById = new Map(fresh.map((l, i) => [l, matches[i]]));
  return parsedLines.map((ln) => {
    const rule = L.suggestRule(ctx.rules || [], ln.merchant);
    let target = rule ? String(rule.account_id) : '';
    if (!target || !ctx.accMap.has(target) || target === accountId) target = ctx.accMap.has(UNCATEGORIZED_ID) ? UNCATEGORIZED_ID : '';
    const m = mById.get(ln) || null;
    let action = 'NEW';
    if (ln.dup) action = 'SKIP';
    else if (m && m.score >= AUTO_MATCH_SCORE) action = 'MATCH';
    return { line: ln, action, target, ruleId: rule ? rule.rule_id : '', match: m, touched: false };
  });
}

export function previewTotals(rows) {
  const t = { count: rows.length, news: 0, matched: 0, dups: 0, skipped: 0, out: 0, inn: 0 };
  rows.forEach((r) => {
    if (r.line.dup) t.dups++;
    if (r.action === 'NEW') t.news++;
    else if (r.action === 'MATCH') t.matched++;
    else t.skipped++;
    if (r.line.amount > 0) t.out += r.line.amount; else t.inn += -r.line.amount;
  });
  t.out = L.round(t.out, 2); t.inn = L.round(t.inn, 2);
  return t;
}

// ───────── 기록 만들기 ─────────

// ctx = { accountId, accMap, rules, profile(저장할 열 설정), importId, now }
export function buildRecords(rows, ctx) {
  const now = ctx.now || L.nowIso();
  const accountId = String(ctx.accountId);
  const acct = ctx.accMap.get(accountId);
  const importId = ctx.importId || L.newId('imp');
  const puts = { Transactions: [], Postings: [], StatementLines: [], Rules: [], ImportProfiles: [] };
  const rules = (ctx.rules || []).slice();
  const ruleOut = new Map();
  const counts = { created: 0, matched: 0, skipped: 0 };
  const owner0 = acct && (acct.owner === 'Patrick' || acct.owner === 'Ms Kim') ? acct.owner : 'Joint';

  rows.forEach((r) => {
    const ln = r.line;
    if (r.action === 'SKIP') { counts.skipped++; return; }
    const slId = L.newId('s');
    const key = ln.dup ? ln.altKey : ln.dedupe_key;
    const sl = {
      stmt_line_id: slId, import_id: importId, account_id: accountId, date: ln.date,
      description_raw: ln.description, merchant_norm: L.normMerchant(ln.merchant), amount: ln.amount, currency: 'CAD',
      foreign_amount_hint: ln.foreign ? ln.foreign.amount : '', foreign_currency_hint: ln.foreign ? ln.foreign.currency : '',
      dedupe_key: key, match_status: '', matched_txn_id: '', match_score: '', rule_id: r.ruleId || '',
      updated_at: now, deleted: false
    };
    if (r.action === 'MATCH' && r.match) {
      const t = r.match.item.txn;
      puts.Transactions.push(Object.assign({}, t, { posted_date: ln.date, statement_line_id: t.statement_line_id || slId, status: 'MATCHED', updated_at: now }));
      sl.match_status = 'MATCHED'; sl.matched_txn_id = String(t.txn_id); sl.match_score = r.match.score;
      counts.matched++;
    } else {
      const target = ctx.accMap.get(String(r.target));
      if (!target) throw new Error('카테고리가 없는 줄이 있습니다: ' + ln.date + ' ' + ln.description);
      const cad = Math.abs(ln.amount);
      const txnId = L.newId('t');
      const out = ln.amount > 0;
      const mk = (accId, sign) => ({
        posting_id: L.newId('p'), txn_id: txnId, line_id: '', account_id: String(accId),
        amount_cad: sign * cad, amount_orig: sign * cad, currency: 'CAD', fx_rate: 1, memo: '', updated_at: now, deleted: false
      });
      const pass = String(target.account_id) === CONFIG.CLEARING_ID;
      const rule = L.suggestRule(rules, ln.merchant);
      puts.Postings.push(out ? mk(target.account_id, 1) : mk(accountId, 1), out ? mk(accountId, -1) : mk(target.account_id, -1));
      puts.Transactions.push({
        txn_id: txnId, date: ln.date, posted_date: ln.date, merchant: ln.merchant, merchant_raw: ln.description, memo: '',
        currency: 'CAD', subtotal_orig: cad, tax_orig: '', tip_orig: '', total_orig: cad, fx_rate: 1, fx_source: '', fx_status: 'ACTUAL',
        total_cad: cad, source: 'STATEMENT', status: String(target.account_id) === UNCATEGORIZED_ID ? 'REVIEW' : 'MATCHED',
        owner: (rule && rule.owner) || owner0, trip_tag: '', is_passthrough: pass, receipt_id: '', statement_line_id: slId,
        created_at: now, updated_at: now, deleted: false
      });
      sl.match_status = 'CREATED'; sl.matched_txn_id = txnId;
      counts.created++;
      if (String(target.account_id) !== UNCATEGORIZED_ID && L.normMerchant(ln.merchant)) {
        const learned = L.learnRule(rules, ln.merchant, target.account_id, now);
        if (learned) {
          const i = rules.findIndex((x) => x.rule_id === learned.rule_id);
          if (i >= 0) rules[i] = learned; else rules.push(learned);
          ruleOut.set(learned.rule_id, learned);
          sl.rule_id = learned.rule_id;
        }
      }
    }
    puts.StatementLines.push(sl);
  });
  puts.Rules = Array.from(ruleOut.values());
  if (ctx.profile) {
    const p = ctx.profile;
    puts.ImportProfiles.push({
      profile_id: 'prof_' + accountId, account_id: accountId, has_header: L.truthy(p.has_header), date_col: p.date_col,
      date_format: p.date_format, year_source: p.year_source, desc_cols: p.desc_cols, debit_col: p.debit_col,
      credit_col: p.credit_col, amount_col: p.amount_col, sign_flip: L.truthy(p.sign_flip), skip_rows_regex: p.skip_rows_regex,
      updated_at: now, deleted: false
    });
  }
  return { puts, counts, importId };
}

// 저장된 열 설정 → profile 객체
export function profileFromRow(row) {
  if (!row || L.truthy(row.deleted)) return null;
  const s = (v) => (v === undefined || v === null ? '' : String(v));
  return {
    has_header: L.truthy(row.has_header), date_col: s(row.date_col), date_format: s(row.date_format) || 'AUTO',
    year_source: s(row.year_source) || 'COLUMN', desc_cols: s(row.desc_cols), debit_col: s(row.debit_col),
    credit_col: s(row.credit_col), amount_col: s(row.amount_col), sign_flip: L.truthy(row.sign_flip),
    skip_rows_regex: s(row.skip_rows_regex) || DEFAULT_SKIP_RE
  };
}
