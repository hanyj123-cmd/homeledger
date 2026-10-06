// 화면 크기에 따라 폰 / 아이패드 / 컴퓨터 세 가지 배치를 고릅니다.
//   phone   < 700px        아래 탭 · 카드 목록 · 아래에서 올라오는 시트
//   tablet  700 – 1199px   왼쪽 아이콘 레일 · 목록 + 오른쪽 상세 분할 화면
//   desktop ≥ 1200px       왼쪽 사이드바 · 넓은 표 · 오른쪽에서 나오는 패널
export const BREAK_TABLET = 700;
export const BREAK_DESKTOP = 1200;

let forced = null;
/** 테스트·미리보기용: 'phone' | 'tablet' | 'desktop' 로 고정 (null 이면 창 크기를 따름) */
export function forceLayout(v) { forced = v || null; apply(); }

export function layoutOf() {
  if (forced) return forced;
  const w = (typeof window !== 'undefined' && window.innerWidth) || 390;
  return w >= BREAK_DESKTOP ? 'desktop' : w >= BREAK_TABLET ? 'tablet' : 'phone';
}
export const isPhone = () => layoutOf() === 'phone';
export const isTablet = () => layoutOf() === 'tablet';
export const isDesktop = () => layoutOf() === 'desktop';

const subs = [];
let current = null;
export function onLayout(cb) { subs.push(cb); }

function apply() {
  if (typeof document === 'undefined') return;
  const l = layoutOf();
  document.documentElement.setAttribute('data-layout', l);
  if (l !== current) {
    const was = current;
    current = l;
    if (was) subs.forEach((cb) => { try { cb(l, was); } catch (e) { /* 화면 갱신 실패가 앱을 막지 않게 */ } });
  }
}

let timer = null;
export function initLayout() {
  apply();
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(apply, 120); });
    window.addEventListener('orientationchange', () => setTimeout(apply, 200));
  }
}
