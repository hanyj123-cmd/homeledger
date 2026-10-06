// 화면 모양 설정: 밝게/어둡게/자동 + 글자 크기.
//   · 테마  → <html data-theme="light|dark"> (자동이면 속성을 지워서 시스템 설정을 따름)
//   · 크기  → <html style="--ui-scale: 1.1"> (style.css 가 이 값으로 글자 크기를 정함)
// localStorage 가 막혀 있어도 (사생활 보호 모드 등) 죽지 않고 이번 방문 동안만 기억합니다.
// 시작할 때 applyAppearance() 를 가능한 한 일찍(첫 화면이 그려지기 전에) 부르세요.

export const THEME_KEY = 'hl_theme';
export const SCALE_KEY = 'hl_scale';
export const THEMES = ['auto', 'light', 'dark'];
export const SCALES = [0.9, 1, 1.1, 1.2, 1.35];

const mem = {};
function lsGet(k) { try { const v = localStorage.getItem(k); return v === null ? (k in mem ? mem[k] : null) : v; } catch (e) { return k in mem ? mem[k] : null; } }
function lsSet(k, v) { mem[k] = v; try { localStorage.setItem(k, v); } catch (e) { /* 이번 방문 동안만 */ } }

const root = () => (typeof document !== 'undefined' ? document.documentElement : null);

/** 저장된 테마 선택: 'auto' | 'light' | 'dark' (없거나 이상하면 'auto') */
export function getTheme() {
  const v = lsGet(THEME_KEY);
  return THEMES.indexOf(v) >= 0 ? v : 'auto';
}

function applyTheme(t) {
  const el = root();
  if (!el) return;
  if (t === 'light' || t === 'dark') el.dataset.theme = t;
  else delete el.dataset.theme;
  syncMetaThemeColor();
}

/** 테마 저장 + 적용. 모르는 값은 'auto' 로 취급. 적용된 값을 돌려줍니다. */
export function setTheme(t) {
  const v = THEMES.indexOf(t) >= 0 ? t : 'auto';
  lsSet(THEME_KEY, v);
  applyTheme(v);
  notify();
  return v;
}

/** auto → light → dark → auto. 새 값을 돌려줍니다 (헤더의 테마 버튼용) */
export function cycleTheme() {
  const cur = getTheme();
  return setTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
}

function systemMql() {
  try { return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null; } catch (e) { return null; }
}
/** 지금 실제로 보이는 모양: 'light' | 'dark' (자동이면 시스템 설정을 따름) */
export function effectiveTheme() {
  const t = getTheme();
  if (t === 'light' || t === 'dark') return t;
  const m = systemMql();
  return m && m.matches ? 'dark' : 'light';
}

const subs = new Set();
function notify() { const e = effectiveTheme(); subs.forEach((f) => { try { f(e, getTheme()); } catch (err) { console.error('[theme] listener error:', err); } }); }

/**
 * 시스템의 밝게/어둡게가 바뀌었을 때 cb(effective, selected) 를 부릅니다 (선택이 'auto' 가 아니어도 부르되
 * 실제 모양은 selected 를 따릅니다 — 차트처럼 다시 그려야 하는 곳은 effective 만 보면 됩니다).
 * setTheme 로 바뀔 때도 부릅니다. 해제 함수를 돌려줍니다.
 */
export function onSystemThemeChange(cb) {
  if (typeof cb !== 'function') return () => {};
  subs.add(cb);
  return () => subs.delete(cb);
}
let hookedMql = null;      // 참조를 붙들어 두어야 브라우저가 리스너를 지우지 않음
function hookSystem() {
  if (hookedMql) return;
  const m = systemMql();
  if (!m) return;
  hookedMql = m;
  const h = () => { syncMetaThemeColor(); notify(); };
  if (m.addEventListener) m.addEventListener('change', h); else if (m.addListener) m.addListener(h);
}

/** 저장된 글자 크기 배율 (허용된 값 중 하나, 없으면 1) */
export function getScale() {
  const n = nearestScale(parseFloat(lsGet(SCALE_KEY)));
  return n;
}
function nearestScale(n) {
  if (!isFinite(n)) return 1;
  let best = 1, d = Infinity;
  for (const s of SCALES) { const k = Math.abs(s - n); if (k < d - 1e-9) { d = k; best = s; } }
  return best;
}
function applyScale(n) {
  const el = root();
  if (el) el.style.setProperty('--ui-scale', String(n));
}
/** 글자 크기 저장 + 적용. 허용 단계(0.9, 1, 1.1, 1.2, 1.35)로 맞춰 적용된 값을 돌려줍니다. */
export function setScale(n) {
  const v = nearestScale(+n);
  lsSet(SCALE_KEY, String(v));
  applyScale(v);
  return v;
}
/** 한 단계 키우기/줄이기 (dir = +1 / -1). 끝에서는 멈춥니다. */
export function stepScale(dir) {
  const i = SCALES.indexOf(getScale());
  return setScale(SCALES[Math.min(SCALES.length - 1, Math.max(0, i + (dir < 0 ? -1 : 1)))]);
}

// 브라우저 주소창 색(theme-color)이 강제 테마와 어긋나지 않게 맞춥니다.
const BAR = { light: '#ffffff', dark: '#161a15' };
function syncMetaThemeColor() {
  if (typeof document === 'undefined') return;
  try {
    const t = getTheme();
    const metas = document.querySelectorAll('meta[name="theme-color"]');
    metas.forEach((m) => {
      if (!m.dataset.hlOrigMedia) m.dataset.hlOrigMedia = m.getAttribute('media') || '';
      if (t === 'auto') {
        if (m.dataset.hlOrigMedia) m.setAttribute('media', m.dataset.hlOrigMedia); else m.removeAttribute('media');
      } else {
        // 강제 테마: 선택한 쪽 색만 "항상" 적용되게 하고 반대쪽은 끔
        const isDarkMeta = /dark/.test(m.dataset.hlOrigMedia);
        m.setAttribute('media', (isDarkMeta === (t === 'dark')) ? 'all' : 'not all');
      }
    });
  } catch (e) { /* ignore */ }
}

/** 시작할 때 한 번: 저장된 테마와 글자 크기를 <html> 에 적용. 절대 예외를 던지지 않습니다. */
export function applyAppearance() {
  try {
    applyTheme(getTheme());
    applyScale(getScale());
    hookSystem();
  } catch (e) { /* 모양 설정 때문에 앱이 죽으면 안 됩니다 */ }
}
