// 구글 로그인 (Google Identity Services). 토큰은 1시간짜리입니다.
// 앱을 닫았다 열어도 만료 전까지 유지되도록 기기에 보관하고, 만료되면 다음 터치 때 조용히 갱신을 시도합니다.
import { CONFIG } from './config.js';
import { setTokenProvider, setScopeErrorHandler, SCOPE_MESSAGE } from './sheets.js';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
let needConsent = false;   // 권한 체크박스를 빼고 로그인했다면, 다음 로그인은 동의 화면을 반드시 다시 보여 줍니다

const SS_KEY = 'hl_token';
const EMAIL_KEY = 'hl_email';

let tokenClient = null;
let token = null;
let expiresAt = 0;
let email = '';
let pending = null;
let silent = false;
const listeners = [];

export function onAuth(fn) { listeners.push(fn); }
function emit() { listeners.forEach((fn) => fn(getState())); }

export function getToken() {
  return token && Date.now() < expiresAt - 60000 ? token : null;
}

export function getState() {
  return { signedIn: !!getToken(), email };
}

function persist() {
  const blob = JSON.stringify({ token, expiresAt });
  try { localStorage.setItem(SS_KEY, blob); } catch (e) { /* 저장 불가 환경 */ }
  try { sessionStorage.setItem(SS_KEY, blob); } catch (e) { /* ignore */ }
  try { if (email) localStorage.setItem(EMAIL_KEY, email); } catch (e) { /* ignore */ }
}

function restore() {
  [() => localStorage, () => sessionStorage].forEach((store) => {
    try {
      const s = JSON.parse(store().getItem(SS_KEY) || 'null');
      if (s && s.token && s.expiresAt > Date.now() + 60000 && s.expiresAt > expiresAt) { token = s.token; expiresAt = s.expiresAt; }
    } catch (e) { /* ignore */ }
  });
  try { email = localStorage.getItem(EMAIL_KEY) || ''; } catch (e) { /* ignore */ }
}

function initClient() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: onToken,
    error_callback: (e) => {
      silent = false;
      if (pending) { pending.reject(new Error('로그인이 취소되었거나 팝업이 차단되었습니다. (' + ((e && e.type) || 'error') + ')')); pending = null; }
    }
  });
}

async function onToken(resp) {
  silent = false;
  if (!resp || resp.error) {
    if (pending) { pending.reject(new Error((resp && (resp.error_description || resp.error)) || '로그인 실패')); pending = null; }
    return;
  }
  // 구글은 권한 항목을 하나씩 뺄 수 있게 해 줍니다. 시트 권한이 빠졌으면 토큰을 버리고 다시 안내합니다.
  if (typeof google !== 'undefined' && google.accounts.oauth2.hasGrantedAllScopes
      && !google.accounts.oauth2.hasGrantedAllScopes(resp, SHEETS_SCOPE)) {
    needConsent = true;
    token = null; expiresAt = 0;
    try { google.accounts.oauth2.revoke(resp.access_token, () => {}); } catch (e) { /* ignore */ }
    emit();
    if (pending) { pending.reject(new Error(SCOPE_MESSAGE)); pending = null; }
    return;
  }
  needConsent = false;
  token = resp.access_token;
  expiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } });
    const u = await r.json();
    if (u && u.email) email = u.email;
  } catch (e) { /* 이메일은 없어도 동작 */ }
  persist();
  emit();
  if (pending) { pending.resolve(getState()); pending = null; }
}

export function init() {
  setTokenProvider(getToken);
  setScopeErrorHandler(() => { needConsent = true; token = null; expiresAt = 0; try { localStorage.removeItem(SS_KEY); sessionStorage.removeItem(SS_KEY); } catch (e) { /* ignore */ } emit(); });
  restore();
  let tries = 0;
  const wait = () => {
    if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) { initClient(); return; }
    if (++tries < 100) setTimeout(wait, 200);
  };
  wait();
  armSilentRefresh();
}

// 토큰이 없거나 만료됐고 이전에 로그인한 계정이 있으면, 화면을 처음 터치할 때 조용히(화면 없이) 갱신을 시도합니다.
// 터치 동작 안에서 실행하므로 팝업이 차단되지 않습니다. 실패해도 아무 일도 일어나지 않고, 로그인 버튼으로 하면 됩니다.
function armSilentRefresh() {
  if (typeof document === 'undefined' || !document.addEventListener) return;
  const h = (ev) => {
    if (getToken()) return;
    if (!email || !tokenClient || pending || silent || needConsent) return;
    const t = ev && ev.target;
    if (t && t.closest && t.closest('#chip, .btn')) return; // 로그인 버튼 자체를 누른 경우는 그쪽에서 처리
    silent = true;
    try { tokenClient.requestAccessToken({ prompt: 'none', hint: email }); } catch (e) { silent = false; }
  };
  document.addEventListener('pointerdown', h, true);
}

// 버튼 클릭 안에서 호출해야 팝업이 차단되지 않습니다.
export function signIn() {
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) initClient();
      if (!tokenClient) { reject(new Error('구글 로그인 스크립트를 아직 불러오지 못했습니다. 잠시 후 다시 눌러 주세요.')); return; }
    }
    silent = false;
    pending = { resolve, reject };
    tokenClient.requestAccessToken(Object.assign(email ? { hint: email } : {}, needConsent ? { prompt: 'consent' } : {}));
  });
}

export function signOut() {
  if (token && typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
    try { google.accounts.oauth2.revoke(token, () => {}); } catch (e) { /* ignore */ }
  }
  token = null;
  expiresAt = 0;
  try { sessionStorage.removeItem(SS_KEY); } catch (e) { /* ignore */ }
  try { localStorage.removeItem(SS_KEY); } catch (e) { /* ignore */ }
  emit();
}

export function needsConsent() { return needConsent; }
