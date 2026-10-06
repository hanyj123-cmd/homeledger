// 구글 로그인 (Google Identity Services). 토큰은 1시간짜리라 새로고침해도 유지되도록 세션에 보관합니다.
import { CONFIG } from './config.js';
import { setTokenProvider } from './sheets.js';

const SS_KEY = 'hl_token';
const EMAIL_KEY = 'hl_email';

let tokenClient = null;
let token = null;
let expiresAt = 0;
let email = '';
let pending = null;
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
  try { sessionStorage.setItem(SS_KEY, JSON.stringify({ token, expiresAt })); } catch (e) { /* 저장 불가 환경 */ }
  try { if (email) localStorage.setItem(EMAIL_KEY, email); } catch (e) { /* ignore */ }
}

function restore() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SS_KEY) || 'null');
    if (s && s.token && s.expiresAt > Date.now() + 60000) { token = s.token; expiresAt = s.expiresAt; }
  } catch (e) { /* ignore */ }
  try { email = localStorage.getItem(EMAIL_KEY) || ''; } catch (e) { /* ignore */ }
}

function initClient() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: onToken,
    error_callback: (e) => {
      if (pending) { pending.reject(new Error('로그인이 취소되었거나 팝업이 차단되었습니다. (' + ((e && e.type) || 'error') + ')')); pending = null; }
    }
  });
}

async function onToken(resp) {
  if (!resp || resp.error) {
    if (pending) { pending.reject(new Error((resp && (resp.error_description || resp.error)) || '로그인 실패')); pending = null; }
    return;
  }
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
  restore();
  let tries = 0;
  const wait = () => {
    if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) { initClient(); return; }
    if (++tries < 100) setTimeout(wait, 200);
  };
  wait();
}

// 버튼 클릭 안에서 호출해야 팝업이 차단되지 않습니다.
export function signIn() {
  return new Promise((resolve, reject) => {
    if (!tokenClient) { reject(new Error('구글 로그인 스크립트를 아직 불러오지 못했습니다. 잠시 후 다시 눌러 주세요.')); return; }
    pending = { resolve, reject };
    tokenClient.requestAccessToken(email ? { hint: email } : {});
  });
}

export function signOut() {
  if (token && typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
    try { google.accounts.oauth2.revoke(token, () => {}); } catch (e) { /* ignore */ }
  }
  token = null;
  expiresAt = 0;
  try { sessionStorage.removeItem(SS_KEY); } catch (e) { /* ignore */ }
  emit();
}
