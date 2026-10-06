// AI 재무 조언 + 주식 시세: Apps Script 서버(ReceiptApi.gs v4)의 `advise`, `quote` 를 부르는 얇은 클라이언트.
// 전송 방식·로그인 토큰·하루 사용 한도는 영수증 인식과 같은 서버/규칙을 씁니다. (receipts.js 의 callApi 와 같은 방식)
// 서버에는 앱이 집계한 숫자(context)만 보냅니다. 거래 원본은 보내지 않습니다.
import { CONFIG } from './config.js';
import { getToken } from './auth.js';
import { getMeta, setMeta } from './store.js';

export const TTL_MS = 12 * 60 * 60 * 1000;      // 같은 질문·같은 숫자의 AI 답변은 12시간 동안 다시 쓰기
export const TIMEOUT_MS = 45000;
export const KINDS = ['summary', 'ask', 'debt', 'plan'];
export const MAX_CONTEXT_BYTES = 30 * 1024;      // 서버 한도와 같음
export const MAX_QUESTION = 500;
const QUOTE_CHUNK = 10;                          // 서버가 한 번에 받는 종목 수
const SYMBOL_RE = /^[A-Za-z0-9.\-^=]{1,15}$/;

// ───────── 작은 도구 ─────────

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// 키 순서와 상관없이 같은 내용이면 같은 문자열
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : stable(x))).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function').sort()
    .map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

// cyrb53: 빠르고 충돌이 드문 53비트 해시 (캐시 키용, 보안용 아님)
function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function byteLen(str) {
  try { return new TextEncoder().encode(str).length; } catch (e) { return str.length * 3; }
}

function cacheKey(kind, context, question) {
  return 'ai:' + kind + ':' + hash(stable(context) + '\u0000' + (question || ''));
}

function cleanQuestion(q) { return q === undefined || q === null ? '' : String(q).trim(); }

// ───────── 사용 가능 여부 ─────────

export function aiAvailable() {
  const url = String(CONFIG.RECEIPT_API_URL || '');
  return /^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url) && !!getToken();
}

// ───────── 서버 호출 ─────────

// 서버가 돌려준 오류 → 사용자에게 보여줄 한국어 메시지
function serverError(data) {
  const msg = String((data && data.error) || '');
  const code = String((data && data.code) || '');
  if (code === 'auth' || (!code && /로그인|허용되지 않은 계정/.test(msg))) {
    return fail('auth', /허용되지 않은/.test(msg) ? msg : '로그인이 만료되었습니다. 상단의 로그인 버튼을 눌러 다시 로그인하세요.');
  }
  if (code === 'quota' || /사용 한도|인식 한도/.test(msg)) return fail('quota', '오늘 AI 사용 한도를 넘었습니다. 내일 다시 시도하세요.');
  if (code === 'rate') return fail('rate', 'AI 무료 사용량을 잠시 초과했습니다. 1분 뒤 다시 시도하세요.');
  if (code === 'unknown_action' || /알 수 없는 요청/.test(msg)) {
    return fail('outdated', '서버가 AI 기능을 아직 지원하지 않습니다. Apps Script 를 새 버전(v4)으로 다시 배포하세요.');
  }
  if (code === 'bad_request') return fail('bad_request', msg || '요청이 올바르지 않습니다.');
  if (code === 'config') return fail('config', msg || '서버 설정이 필요합니다.');
  return fail('server', 'AI 서버 오류: ' + (msg || '알 수 없는 오류'));
}

async function post(payload, opts) {
  const url = CONFIG.RECEIPT_API_URL;
  if (!url) throw fail('config', 'AI 서버 주소가 설정되지 않았습니다.');
  const token = getToken();
  if (!token) throw fail('auth', '로그인이 필요합니다. 상단의 로그인 버튼을 누르세요.');
  const fetchFn = (opts && opts.fetchFn) || (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) throw fail('offline', '이 기기에서는 AI 서버에 연결할 수 없습니다.');
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), (opts && opts.timeoutMs) || TIMEOUT_MS) : null;
  let res;
  try {
    // Apps Script 웹 앱은 text/plain 으로 보내야 브라우저의 사전 확인(CORS preflight)을 피합니다.
    res = await fetchFn(url, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ token }, payload)), signal: ctl ? ctl.signal : undefined
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw fail('timeout', 'AI 서버 응답이 너무 늦습니다. 잠시 후 다시 시도하세요.');
    throw fail('offline', '인터넷에 연결되어 있지 않거나 AI 서버에 닿지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.');
  } finally { if (timer) clearTimeout(timer); }
  let data;
  try { data = await res.json(); } catch (e) {
    if (res && res.status >= 500) throw fail('server', 'AI 서버 오류 (HTTP ' + res.status + '). 잠시 후 다시 시도하세요.');
    throw fail('parse', 'AI 서버의 응답을 읽지 못했습니다. (배포 주소와 "모든 사용자" 접근 설정을 확인하세요)');
  }
  if (!data || typeof data !== 'object') throw fail('parse', 'AI 서버의 응답을 읽지 못했습니다.');
  if (data.ok !== true) throw serverError(data);
  return data;
}

// 서버가 이미 정리해 주지만, 화면이 깨지지 않도록 한 번 더 모양을 맞춥니다.
function shapeAdvice(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw fail('parse', 'AI 답변을 읽지 못했습니다. 다시 시도하세요.');
  const s = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
  const out = {
    headline: s(d.headline),
    sections: (Array.isArray(d.sections) ? d.sections : []).filter((x) => x && typeof x === 'object').map((x) => ({
      title: s(x.title), tone: ['good', 'warn', 'bad', 'info'].indexOf(x.tone) >= 0 ? x.tone : 'info',
      points: (Array.isArray(x.points) ? x.points : []).map(s).filter(Boolean)
    })),
    actions: (Array.isArray(d.actions) ? d.actions : []).filter((x) => x && typeof x === 'object')
      .map((x) => ({ title: s(x.title), why: s(x.why), impact: s(x.impact) })),
    answer: s(d.answer), caveat: s(d.caveat)
  };
  if (!out.headline && !out.answer && !out.sections.length && !out.actions.length) throw fail('parse', 'AI 답변이 비어 있습니다. 다시 시도하세요.');
  return out;
}

// ───────── 조언 ─────────

// 저장된 답변과 저장 시각. 없거나 12시간이 지났으면 null. (서버를 부르지 않음, 절대 throw 하지 않음)
export async function cachedAdvice(kind, context, question) {
  try {
    const rec = await getMeta(cacheKey(kind, context, cleanQuestion(question)));
    const age = rec && typeof rec.at === 'number' ? Date.now() - rec.at : NaN;
    if (rec && rec.data && typeof rec.data === 'object' && age >= -60000 && age < TTL_MS) return { at: rec.at, data: rec.data };
  } catch (e) { /* 저장소를 못 읽으면 캐시 없음으로 */ }
  return null;
}

const inflight = new Map();

// advise('summary'|'ask'|'debt'|'plan', context, { question, force, fetchFn }) → data
// data = { headline, sections:[{title,tone,points[]}], actions:[{title,why,impact}], answer, caveat }
export function advise(kind, context, opts) {
  opts = opts || {};
  if (KINDS.indexOf(kind) < 0) return Promise.reject(fail('bad_request', '지원하지 않는 분석 종류입니다.'));
  if (!context || typeof context !== 'object' || Array.isArray(context) || !Object.keys(context).length) {
    return Promise.reject(fail('bad_request', '분석할 데이터가 없습니다.'));
  }
  const question = cleanQuestion(opts.question);
  if (kind === 'ask' && !question) return Promise.reject(fail('bad_request', '질문을 입력하세요.'));
  if (question.length > MAX_QUESTION) return Promise.reject(fail('bad_request', '질문이 너무 깁니다. (최대 ' + MAX_QUESTION + '자)'));
  let json;
  try { json = JSON.stringify(context); } catch (e) { return Promise.reject(fail('bad_request', '분석할 데이터를 변환하지 못했습니다.')); }
  if (byteLen(json) > MAX_CONTEXT_BYTES) return Promise.reject(fail('bad_request', '분석할 데이터가 너무 큽니다. (최대 30KB) 기간을 줄여 주세요.'));

  const key = cacheKey(kind, context, question);
  if (inflight.has(key)) return inflight.get(key);   // 같은 요청을 연달아 누르면 한 번만 보냄 (한도 절약)
  const run = (async () => {
    if (!opts.force) {
      const hit = await cachedAdvice(kind, context, question);
      if (hit) return hit.data;
    }
    const res = await post({ action: 'advise', kind, context, question: question || undefined, lang: 'ko' }, opts);
    const data = shapeAdvice(res.data);
    try { await setMeta(key, { at: Date.now(), data }); } catch (e) { /* 저장 실패해도 답변은 보여줌 */ }
    return data;
  })();
  inflight.set(key, run);
  const done = () => { inflight.delete(key); };
  run.then(done, done);
  return run;
}

// ───────── 시세 ─────────

// quote(['TD.TO','AAPL']) → { quotes: { 'TD.TO': { price, currency, asOf } }, missing: ['AAPL'] }
// 종목 코드는 대문자로 바뀌어 돌아옵니다. 10개가 넘으면 나눠서 부릅니다.
export async function quote(symbols, opts) {
  const list = [];
  (Array.isArray(symbols) ? symbols : []).forEach((x) => {
    const t = String(x === undefined || x === null ? '' : x).trim();
    if (!SYMBOL_RE.test(t)) throw fail('bad_request', '올바르지 않은 종목 코드입니다: ' + t.slice(0, 20));
    const u = t.toUpperCase();
    if (list.indexOf(u) < 0) list.push(u);
  });
  if (!list.length) return { quotes: {}, missing: [] };
  const quotes = {};
  let missing = [];
  for (let i = 0; i < list.length; i += QUOTE_CHUNK) {
    const res = await post({ action: 'quote', symbols: list.slice(i, i + QUOTE_CHUNK) }, opts);
    Object.assign(quotes, res.quotes && typeof res.quotes === 'object' ? res.quotes : {});
    missing = missing.concat(Array.isArray(res.missing) ? res.missing : []);
  }
  return { quotes, missing };
}
