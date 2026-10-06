// Google Sheets API 호출 (브라우저에서 직접). 로그인 토큰은 auth.js 가 setTokenProvider 로 넘겨줍니다.
import { CONFIG, KEYS } from './config.js';

export class AuthError extends Error {}

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
    const err = new Error(msg || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const rangesQuery = (names, cols) => names.map((n) => 'ranges=' + encodeURIComponent(n + '!' + cols)).join('&');

// 시트 전체를 읽어 { 이름: { headers, rows: [객체], rowIndex: {id: 행번호} } } 로 돌려줍니다.
export async function pullSheets(names) {
  const data = await call('/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&' + rangesQuery(names, 'A:AZ'));
  const out = {};
  names.forEach((name, i) => {
    const values = (data.valueRanges && data.valueRanges[i] && data.valueRanges[i].values) || [];
    const headers = (values[0] || []).map(String);
    const keyCol = KEYS[name];
    const rows = [];
    const rowIndex = {};
    for (let r = 1; r < values.length; r++) {
      const obj = {};
      headers.forEach((h, c) => { if (h) obj[h] = values[r][c] === undefined ? '' : values[r][c]; });
      const id = obj[keyCol];
      if (id === undefined || id === '') continue;
      const key = String(id);
      obj[keyCol] = key;
      if (rowIndex[key]) continue; // 중복 키는 첫 행만 사용
      rowIndex[key] = r + 1;
      rows.push(obj);
    }
    out[name] = { headers, rows, rowIndex };
  });
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
