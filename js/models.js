// Gemini 모델 선택. 영수증 읽기는 속도가 중요해서 가벼운 모델이, AI 조언은 품질이 중요해서 더 좋은 모델이 어울립니다.
// 선택값은 Settings 시트(meta.gemini)에 저장되어 폰·아이패드·컴퓨터가 같이 쓰고, 이 기기에도 복사해 두어 오프라인에서도 동작합니다.
// 비어 있으면 "자동" = 서버(Apps Script)의 기본 순서를 따릅니다.

const LS_KEY = 'hl_models';
export const KINDS = ['receipt', 'ai'];   // receipt = 영수증 읽기, ai = AI 조언 · 거래 분류
export const NAME_RE = /^gemini-[a-z0-9][a-z0-9.\-]{1,58}$/;

// 속도는 계정·시간대에 따라 다릅니다. 실제 속도는 설정의 "속도 측정"으로 확인하세요.
export const PRESETS = [
  { id: '', en: 'Auto (server default)', ko: '자동 (서버 기본)' },
  { id: 'gemini-3.5-flash-lite', en: 'Lightest — usually fastest', ko: '가장 가벼움 · 보통 가장 빠름' },
  { id: 'gemini-3.5-flash', en: 'Balanced', ko: '균형' },
  { id: 'gemini-3-flash-preview', en: 'Preview', ko: '미리보기 버전' },
  { id: 'gemini-2.5-flash-lite', en: 'Previous generation, light', ko: '이전 세대 · 가벼움' },
  { id: 'gemini-2.5-flash', en: 'Previous generation', ko: '이전 세대' }
];

const blank = () => ({ receipt: '', ai: '' });
let cur = blank();

export function clean(name) {
  const m = String(name === undefined || name === null ? '' : name).trim().toLowerCase();
  return NAME_RE.test(m) ? m : '';
}
const sane = (o) => ({ receipt: clean(o && o.receipt), ai: clean(o && o.ai) });

function load() {
  try { const v = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); if (v && typeof v === 'object') cur = sane(v); } catch (e) { /* 저장된 값이 없거나 깨졌으면 자동 */ }
}
load();

/** 'receipt' | 'ai' → 모델 이름 ('' = 자동) */
export function get(kind) { return cur[kind] || ''; }
export function all() { return Object.assign({}, cur); }

/** 시트에서 읽은 값으로 맞추기 (ui.js 가 데이터를 불러올 때마다 부름) */
export function fromMeta(m) {
  if (!m || typeof m !== 'object') return;
  cur = sane(m);
  try { localStorage.setItem(LS_KEY, JSON.stringify(cur)); } catch (e) { /* 이번 방문 동안만 */ }
}

/** 서버에 보낼 조각: 자동이면 빈 객체 */
export function payload(kind) { const m = get(kind); return m ? { model: m } : {}; }
