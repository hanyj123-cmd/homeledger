/* Home Ledger — Step 2: 구글 로그인 + 시트 연결 테스트
 *
 * 이 파일의 CLIENT_ID 와 SHEET_ID 는 비밀값이 아닙니다.
 * (공개 저장소에 올려도 안전합니다. 시트는 공유된 구글 계정으로 로그인해야만 열립니다.)
 */
const CONFIG = {
  CLIENT_ID: '73033444727-eihfhc1s2pnls6uqo677202nl88fpm4i.apps.googleusercontent.com',
  SHEET_ID: '1CsPFT6-ERWMSzEVZu0wgqY_wWOy7Km8YGQj-Eo4eoTc',
  SCOPES: 'https://www.googleapis.com/auth/spreadsheets openid email',
  EXPECTED_TABS: ['Accounts', 'TaxCodes', 'FxRates', 'Settings', 'Transactions', 'Postings',
    'LineItems', 'Receipts', 'ImportProfiles', 'StatementLines', 'Rules', 'Budgets',
    'Balances', 'Debts', 'AuditLog']
};

let tokenClient = null;
let accessToken = null;

const $ = function (id) { return document.getElementById(id); };

function setStatus(text, isFail) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (isFail ? ' fail' : '');
}

function addCheck(kind, text) {
  const li = document.createElement('li');
  li.className = kind; // ok | fail | hint
  const icon = kind === 'ok' ? '✓ ' : kind === 'fail' ? '✗ ' : '';
  li.textContent = icon + text;
  $('checks').appendChild(li);
}

// ───────────── Sheets API ─────────────

async function sheetsApi(path) {
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + CONFIG.SHEET_ID + path;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!res.ok) {
    let msg = '';
    try {
      const j = await res.json();
      msg = (j.error && j.error.message) || '';
    } catch (e) { /* 본문이 JSON 이 아닐 수 있음 */ }
    const err = new Error(msg || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function explainError(err) {
  const m = (err.message || '').toLowerCase();
  if (err.status === 401) return '로그인이 만료되었습니다. 다시 로그인해 주세요.';
  if (err.status === 404) return '시트를 찾을 수 없습니다. 시트 ID가 맞는지 확인해 주세요.';
  if (err.status === 403 && (m.indexOf('has not been used') >= 0 || m.indexOf('disabled') >= 0)) {
    return 'Google Cloud 프로젝트에서 Google Sheets API가 켜져 있지 않습니다. (라이브러리에서 "사용" 필요)';
  }
  if (err.status === 403) return '이 계정에는 시트 접근 권한이 없습니다. 시트를 이 구글 계정에 공유해 주세요.';
  return err.message || '알 수 없는 오류';
}

function countRows(valueRange) {
  const v = valueRange && valueRange.values ? valueRange.values.length : 0;
  return Math.max(0, v - 1); // 헤더 제외
}

async function runChecks() {
  $('checks').innerHTML = '';
  setStatus('시트 확인 중…');

  // 1) 로그인한 계정
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    const u = await res.json();
    addCheck('ok', 'Signed in (로그인): ' + (u.email || '계정 확인됨'));
  } catch (e) {
    addCheck('ok', 'Signed in (로그인)');
  }

  // 2) 시트 연결 + 탭 목록
  let tabs = [];
  try {
    const meta = await sheetsApi('?fields=properties.title,sheets.properties.title');
    tabs = (meta.sheets || []).map(function (s) { return s.properties.title; });
    addCheck('ok', 'Sheet connected (시트 연결): ' + meta.properties.title);
  } catch (err) {
    addCheck('fail', 'Sheet connection (시트 연결) — ' + explainError(err));
    setStatus('시트에 연결하지 못했습니다.', true);
    return;
  }

  const missing = CONFIG.EXPECTED_TABS.filter(function (t) { return tabs.indexOf(t) < 0; });
  if (missing.length === 0) {
    addCheck('ok', 'Tabs (탭): ' + CONFIG.EXPECTED_TABS.length + '/' + CONFIG.EXPECTED_TABS.length + ' 확인');
  } else {
    addCheck('fail', 'Tabs (탭): 없는 탭 ' + missing.join(', ') + ' — Apps Script에서 setupSheets를 다시 실행하세요.');
  }

  // 3) 초기값 읽기
  if (['Accounts', 'TaxCodes', 'Settings'].every(function (t) { return tabs.indexOf(t) >= 0; })) {
    try {
      const data = await sheetsApi('/values:batchGet?ranges=Accounts!A:A&ranges=TaxCodes!A:A&ranges=Settings!A:A');
      const r = data.valueRanges || [];
      const a = countRows(r[0]);
      const t = countRows(r[1]);
      const s = countRows(r[2]);
      const ok = a > 0 && t > 0 && s > 0;
      addCheck(ok ? 'ok' : 'fail',
        'Seed data (초기값): 계좌 ' + a + ' / 세금코드 ' + t + ' / 설정 ' + s +
        (ok ? '' : ' — 비어 있습니다. setupSheets를 다시 실행하세요.'));
    } catch (err) {
      addCheck('fail', 'Seed data (초기값 읽기) — ' + explainError(err));
    }
  }

  const failed = $('checks').querySelectorAll('li.fail').length;
  if (failed === 0) {
    setStatus('모두 정상입니다. 다음 단계로 넘어갈 수 있습니다.');
    addCheck('hint', '이 화면 캡처 또는 위 내용을 Claude에게 알려 주세요.');
  } else {
    setStatus('확인이 필요한 항목이 ' + failed + '개 있습니다.', true);
  }
}

// ───────────── 로그인 ─────────────

function onToken(resp) {
  if (!resp || resp.error) {
    setStatus('로그인에 실패했습니다: ' + ((resp && (resp.error_description || resp.error)) || '알 수 없는 오류'), true);
    return;
  }
  accessToken = resp.access_token;
  $('signin').hidden = true;
  $('signout').hidden = false;
  runChecks();
}

function signOut() {
  if (accessToken && window.google && google.accounts && google.accounts.oauth2) {
    google.accounts.oauth2.revoke(accessToken, function () {});
  }
  accessToken = null;
  $('checks').innerHTML = '';
  $('signin').hidden = false;
  $('signout').hidden = true;
  setStatus('로그아웃되었습니다.');
}

function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: onToken,
    error_callback: function (e) {
      setStatus('로그인이 취소되었거나 팝업이 차단되었습니다. (' + ((e && e.type) || 'error') + ')', true);
    }
  });
  $('signin').disabled = false;
  setStatus('로그인 버튼을 눌러 주세요.');
}

function waitForGoogle(tries) {
  if (window.google && google.accounts && google.accounts.oauth2) {
    initAuth();
    return;
  }
  if (tries > 50) {
    setStatus('구글 로그인 스크립트를 불러오지 못했습니다. 인터넷 연결이나 광고 차단 기능을 확인해 주세요.', true);
    return;
  }
  setTimeout(function () { waitForGoogle(tries + 1); }, 200);
}

function start() {
  $('signin').addEventListener('click', function () { tokenClient.requestAccessToken(); });
  $('signout').addEventListener('click', signOut);
  waitForGoogle(0);
}

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('DOMContentLoaded', start);
}
