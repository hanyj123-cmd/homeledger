// Google Sheets API 호출 (브라우저에서 직접). 로그인 토큰은 auth.js 가 setTokenProvider 로 넘겨줍니다.
import { CONFIG, KEYS } from './config.js';

export class AuthError extends Error {}
// 로그인은 됐지만 "구글 시트" 권한 체크박스를 빼고 허용한 경우 (Request had insufficient authentication scopes)
export class ScopeError extends AuthError {}
let scopeHandler = () => {};
export function setScopeErrorHandler(fn) { scopeHandler = fn || (() => {}); }
export const SCOPE_MESSAGE = '구글 시트 권한이 허용되지 않았습니다. 로그인 창에서 "Google 스프레드시트 확인, 수정, 생성, 삭제" 항목을 꼭 체크한 뒤 계속을 눌러 주세요. (Sign in again and tick the Google Sheets permission)';

let tokenProvider = () => null;
export function setTokenProvider(fn) { tokenProvider = fn; }

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets/';

async function call(path, init) {
  const token = tokenProvider();
  if (!token) throw new AuthError('로그인이 필요합니다.');
  const opts = Object.assign({}, init);
  opts.headers = Object.assign({ Authorization: 'Bearer ' + token }, opts.body ? { 'Content-Type': 'application/json' } : {});
  const res = await fetch(BASE + CONFIG.SHEET_ID + path, opts);
  if (res.status === 401) throw new AuthError('로그인이 만료되었습니다.');
  if (!res.ok) {
    let msg = '';
    try { const j = await res.json(); msg = (j.error && j.error.message) || ''; } catch (e) { /* ignore */ }
    if (res.status === 403 && /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(msg)) {
      try { scopeHandler(); } catch (e) { /* ignore */ }
      throw new ScopeError(SCOPE_MESSAGE);
    }
    const err = new Error(msg || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const rangesQuery = (names, cols) => names.map((n) => 'ranges=' + encodeURIComponent(n + '!' + cols)).join('&');

export const MAX_COL = 'AZ'; // 읽는 최대 열 (52열)
export const MAX_COL_NUM = 52;

export function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// 값 한 줄 → 객체 (헤더 이름 기준). 키가 비어 있으면 null.
function rowToObj(name, headers, rowValues) {
  const keyCol = KEYS[name];
  const obj = {};
  headers.forEach((h, c) => { if (h) obj[h] = rowValues[c] === undefined ? '' : rowValues[c]; });
  const id = obj[keyCol];
  if (id === undefined || id === '') return null;
  obj[keyCol] = String(id);
  return obj;
}

// 시트 전체를 읽어 { 이름: { headers, rows: [객체], rowIndex: {id: 행번호} } } 로 돌려줍니다.
export async function pullSheets(names) {
  const data = await call('/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&' + rangesQuery(names, 'A:' + MAX_COL));
  const out = {};
  names.forEach((name, i) => {
    const values = (data.valueRanges && data.valueRanges[i] && data.valueRanges[i].values) || [];
    const headers = (values[0] || []).map(String);
    const rows = [];
    const rowIndex = {};
    for (let r = 1; r < values.length; r++) {
      const obj = rowToObj(name, headers, values[r] || []);
      if (!obj) continue;
      const key = obj[KEYS[name]];
      if (rowIndex[key]) continue; // 중복 키는 첫 행만 사용
      rowIndex[key] = r + 1;
      rows.push(obj);
    }
    out[name] = { headers, rows, rowIndex };
  });
  return out;
}

// ── 변경분만 가져오기 (delta) ────────────────────────────────────────────
// 시트마다 "키 열(A) + updated_at 열 + 1행(헤더)"만 한 번에 읽어, 어느 행이 바뀌었는지 알아냅니다.
// headersByName: { 이름: 저장해 둔 헤더 배열 }. 헤더를 모르거나 updated_at 열이 없으면 usable:false (전체 읽기 필요).
// 돌려주는 값: { 이름: { usable, headersMatch, count, rowIndex: {키: 행번호}, stamps: {키: updated_at 문자열} } }
export async function pullStamps(names, headersByName) {
  const out = {};
  const plan = [];
  names.forEach((name) => {
    const h = headersByName && headersByName[name];
    const ui = Array.isArray(h) ? h.indexOf('updated_at') : -1;
    if (!Array.isArray(h) || !h.length || h[0] !== KEYS[name] || ui < 1 || ui >= MAX_COL_NUM) { out[name] = { usable: false }; return; }
    plan.push({ name, headers: h, col: colLetter(ui + 1) });
  });
  if (!plan.length) return out;
  const ranges = [];
  plan.forEach((p) => { ranges.push(p.name + '!A:A', p.name + '!' + p.col + ':' + p.col, p.name + '!A1:' + MAX_COL + '1'); });
  const data = await call('/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&' + ranges.map((r) => 'ranges=' + encodeURIComponent(r)).join('&'));
  const vr = (i) => (data.valueRanges && data.valueRanges[i] && data.valueRanges[i].values) || [];
  plan.forEach((p, i) => {
    const keys = vr(i * 3);
    const stampCol = vr(i * 3 + 1);
    const head = ((vr(i * 3 + 2)[0]) || []).map(String);
    const rowIndex = {};
    const stamps = {};
    let count = 0;
    for (let r = 1; r < keys.length; r++) {
      const id = keys[r] && keys[r][0];
      if (id === undefined || id === '') continue;
      const key = String(id);
      if (rowIndex[key]) continue; // 중복 키는 첫 행만 사용
      rowIndex[key] = r + 1;
      const v = stampCol[r] && stampCol[r][0];
      stamps[key] = v === undefined || v === null ? '' : String(v);
      count++;
    }
    out[p.name] = { usable: true, headersMatch: JSON.stringify(head) === JSON.stringify(p.headers), count, rowIndex, stamps };
  });
  return out;
}

// 행 번호 목록 → 이어진 구간들 [[시작, 끝], ...]
export function rowRuns(rows, maxRuns) {
  const sorted = Array.from(new Set(rows)).sort((a, b) => a - b);
  const runs = [];
  sorted.forEach((r) => {
    const last = runs[runs.length - 1];
    if (last && r === last[1] + 1) last[1] = r; else runs.push([r, r]);
  });
  // 구간이 너무 많으면 한 덩어리로 합쳐서 읽습니다. (요청 크기/횟수 제한)
  if (maxRuns && runs.length > maxRuns) return [[runs[0][0], runs[runs.length - 1][1]]];
  return runs;
}

export const MAX_RANGES_PER_CALL = 100;
export const MAX_RUNS_PER_SHEET = 50;

// rowsByName: { 이름: [행번호, ...] }, headersByName: { 이름: 헤더 }.
// 돌려주는 값: { 이름: { 행번호: 객체 } }  (읽은 행이 비어 있거나 키가 없으면 그 행번호는 빠집니다)
export async function pullRows(rowsByName, headersByName) {
  const jobs = [];
  Object.keys(rowsByName).forEach((name) => {
    rowRuns(rowsByName[name], MAX_RUNS_PER_SHEET).forEach(([a, b]) => jobs.push({ name, a, b }));
  });
  const out = {};
  Object.keys(rowsByName).forEach((n) => { out[n] = {}; });
  for (let i = 0; i < jobs.length; i += MAX_RANGES_PER_CALL) {
    const chunk = jobs.slice(i, i + MAX_RANGES_PER_CALL);
    const ranges = chunk.map((j) => j.name + '!A' + j.a + ':' + MAX_COL + j.b);
    const data = await call('/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&' + ranges.map((r) => 'ranges=' + encodeURIComponent(r)).join('&'));
    chunk.forEach((j, k) => {
      const values = (data.valueRanges && data.valueRanges[k] && data.valueRanges[k].values) || [];
      const headers = headersByName[j.name] || [];
      values.forEach((rv, off) => {
        const obj = rowToObj(j.name, headers, rv || []);
        if (obj) out[j.name][j.a + off] = obj;
      });
    });
  }
  return out;
}

// 첫 번째 열(키)만 읽어 행 번호표를 새로 만듭니다. (중복 저장 방지용으로 전송 전에 호출)
export async function pullIds(names) {
  const data = await call('/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&' + rangesQuery(names, 'A:A'));
  const out = {};
  names.forEach((name, i) => {
    const values = (data.valueRanges && data.valueRanges[i] && data.valueRanges[i].values) || [];
    const idx = {};
    for (let r = 1; r < values.length; r++) {
      const id = values[r] && values[r][0];
      if (id === undefined || id === '') continue;
      const key = String(id);
      if (!idx[key]) idx[key] = r + 1;
    }
    out[name] = idx;
  });
  return out;
}

// ── 새 열 추가 ────────────────────────────────────────────────────────────
// 앱이 새 열(예: Postings 의 owner)을 쓰기 시작했는데 시트 1행(헤더)에 그 이름이 없으면,
// 1행을 새로 읽어 없는 이름만 다음 빈 열에 붙입니다. (이미 있으면 아무것도 쓰지 않음 → 여러 번 불러도 안전)
// fallback: 1행이 아예 비어 있는 새 시트일 때 쓸 전체 헤더.
// 돌려주는 값: 실제 시트의 새 헤더 배열.
export async function ensureHeaders(sheet, names, fallback) {
  const data = await call('/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&' + rangesQuery([sheet], 'A1:' + MAX_COL + '1'));
  const head = (((data.valueRanges && data.valueRanges[0] && data.valueRanges[0].values) || [])[0] || []).map((v) => (v === null || v === undefined ? '' : String(v)));
  const add = names.filter((n) => head.indexOf(n) < 0);
  if (!add.length) return head;
  const next = head.some(Boolean) ? head.concat(add) : (fallback && fallback.length ? fallback.concat(add.filter((n) => fallback.indexOf(n) < 0)) : add);
  if (next.length > MAX_COL_NUM) throw new Error(sheet + ' 시트의 열이 너무 많습니다 (' + next.length + ').');
  const write = () => call('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data: [{ range: sheet + '!A1', values: [next] }] })
  });
  try {
    await write();
  } catch (e) {
    // 시트 칸 수가 모자라면(열을 지워 둔 시트) 열을 늘린 뒤 한 번 더
    if (!(e && e.status === 400 && /grid limits|exceeds/i.test(e.message || ''))) throw e;
    const meta = await call('?fields=sheets.properties(sheetId,title,gridProperties.columnCount)');
    const sh = ((meta && meta.sheets) || []).map((x) => x.properties || {}).find((p) => p.title === sheet);
    if (!sh) throw e;
    const have = (sh.gridProperties && sh.gridProperties.columnCount) || 0;
    const need = Math.max(1, next.length - have);
    await call(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ appendDimension: { sheetId: sh.sheetId, dimension: 'COLUMNS', length: need } }] }) });
    await write();
  }
  return next;
}

// items: [{ obj, row }]  row 가 있으면 그 행을 덮어쓰고, 없으면 맨 아래에 추가합니다.
// 돌려주는 값: { id: 행번호 }
export async function writeRows(sheet, headers, items) {
  const keyCol = KEYS[sheet];
  const toRow = (obj) => headers.map((h) => {
    const v = obj[h];
    return v === undefined || v === null ? '' : v;
  });
  const updates = items.filter((i) => i.row);
  const appends = items.filter((i) => !i.row);
  const idx = {};
  if (updates.length) {
    await call('/values:batchUpdate', {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: updates.map((i) => ({ range: sheet + '!A' + i.row, values: [toRow(i.obj)] }))
      })
    });
    updates.forEach((i) => { idx[String(i.obj[keyCol])] = i.row; });
  }
  if (appends.length) {
    const res = await call('/values/' + encodeURIComponent(sheet + '!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
      method: 'POST',
      body: JSON.stringify({ values: appends.map((i) => toRow(i.obj)) })
    });
    const m = /!([A-Z]+)(\d+)/.exec((res.updates && res.updates.updatedRange) || '');
    if (m) {
      let row = parseInt(m[2], 10);
      appends.forEach((i) => { idx[String(i.obj[keyCol])] = row++; });
    }
  }
  return idx;
}
