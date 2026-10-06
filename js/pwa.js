// 설치형 앱(PWA) 도우미: 서비스 워커 등록 · 새 버전 알림 · 홈 화면 설치 안내 · 온라인/오프라인 감지.
// 화면(문구, 버튼)은 호출하는 쪽(ui.js)이 만듭니다. 여기는 순수한 기능만 있습니다.

/** 이 주소에서 서비스 워커를 쓸 수 있는지 (https 또는 localhost 만) */
export function canUseSW(loc = typeof location !== 'undefined' ? location : null, nav = typeof navigator !== 'undefined' ? navigator : null) {
  if (!nav || !('serviceWorker' in nav) || !nav.serviceWorker) return false;
  if (!loc) return false;
  if (loc.protocol === 'https:') return true;
  const h = loc.hostname;
  return loc.protocol === 'http:' && (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1');
}

/** 지금 온라인인가? (브라우저가 알려 주는 값 — 완전하지는 않음) */
export function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * 서비스 워커 등록.
 *   version         앱 버전 문자열 (예: '0.12.0'). './sw.js?v=<version>' 으로 등록 → 버전이 바뀌면 새 워커가 설치됨.
 *   onUpdateReady   새 버전이 내려받아져 대기 중일 때 한 번 호출: onUpdateReady(applyFn).
 *                   applyFn() 을 부르면 새 워커로 교체하고 페이지를 한 번만 새로고침합니다.
 *   onOnlineChange  온라인/오프라인이 바뀔 때 onOnlineChange(isOnline:boolean). (등록 못 하는 환경에서도 동작)
 *   checkEveryMinutes  백그라운드 업데이트 확인 주기 (기본 60, 0 이면 끔). 탭이 다시 보일 때도 확인합니다.
 * 반환: { supported, registration, update(), isOnline(), dispose() }  (등록 불가 환경이면 supported:false)
 * 절대 예외를 던지지 않습니다 — 실패하면 콘솔에 남기고 앱은 평소처럼 동작합니다.
 */
export async function registerSW(opts = {}) {
  const { version = 'dev', onUpdateReady, onOnlineChange, checkEveryMinutes = 60 } = opts;
  const cleanups = [];
  const handle = {
    supported: false,
    registration: null,
    update: async () => {},
    isOnline,
    dispose() { cleanups.splice(0).forEach((f) => { try { f(); } catch (e) { /* ignore */ } }); }
  };

  if (typeof onOnlineChange === 'function' && typeof window !== 'undefined') {
    const on = () => safe(onOnlineChange, true);
    const off = () => safe(onOnlineChange, false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    cleanups.push(() => { window.removeEventListener('online', on); window.removeEventListener('offline', off); });
  }

  if (!canUseSW()) return handle;
  handle.supported = true;

  let reg;
  try {
    reg = await navigator.serviceWorker.register('./sw.js?v=' + encodeURIComponent(version));
  } catch (e) {
    console.warn('[pwa] service worker registration failed:', e);
    handle.supported = false;
    return handle;
  }
  handle.registration = reg;

  // ── 새 버전 감지
  const announced = new WeakSet();
  let reloading = false;
  const announce = (worker) => {
    if (!worker || announced.has(worker) || typeof onUpdateReady !== 'function') return;
    announced.add(worker);
    const apply = () => {
      if (reloading) return;
      const reloadOnce = () => {
        if (reloading) return;
        reloading = true;
        navigator.serviceWorker.removeEventListener('controllerchange', reloadOnce);
        try { location.reload(); } catch (e) { /* ignore */ }
      };
      // 이 시점부터만 듣습니다 — 첫 설치 때의 controllerchange 로는 새로고침하지 않기 위해
      navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);
      cleanups.push(() => navigator.serviceWorker.removeEventListener('controllerchange', reloadOnce));
      try { (reg.waiting || worker).postMessage('skip-waiting'); } catch (e) { console.warn('[pwa] skip-waiting failed:', e); }
    };
    safe(onUpdateReady, apply);
  };
  const watch = (worker) => {
    if (!worker) return;
    const check = () => {
      // 이미 쓰던 워커(controller)가 있을 때 'installed' 되면 = 업데이트. 처음 설치면 알릴 필요 없음.
      if (worker.state === 'installed' && navigator.serviceWorker.controller) announce(worker);
    };
    worker.addEventListener('statechange', check);
    check();
  };

  if (reg.waiting && navigator.serviceWorker.controller) announce(reg.waiting);
  if (reg.installing) watch(reg.installing);
  reg.addEventListener('updatefound', () => watch(reg.installing));

  // ── 업데이트 확인 (주기 + 탭 복귀)
  const update = async () => { try { await reg.update(); } catch (e) { /* 오프라인 등: 조용히 무시 */ } };
  handle.update = update;
  if (checkEveryMinutes > 0 && typeof setInterval === 'function') {
    const id = setInterval(update, checkEveryMinutes * 60000);
    cleanups.push(() => clearInterval(id));
  }
  if (typeof document !== 'undefined') {
    const vis = () => { if (document.visibilityState === 'visible') update(); };
    document.addEventListener('visibilitychange', vis);
    cleanups.push(() => document.removeEventListener('visibilitychange', vis));
  }
  return handle;
}

/** 홈 화면에 설치된 앱(독립 창)으로 열렸는가? */
export function isStandalone() {
  try {
    if (typeof window !== 'undefined' && window.matchMedia) {
      if (window.matchMedia('(display-mode: standalone)').matches) return true;
      if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
    }
    return typeof navigator !== 'undefined' && navigator.standalone === true; // iOS Safari
  } catch (e) { return false; }
}

/** iPhone / iPad (설치 버튼이 없어 "공유 → 홈 화면에 추가" 안내가 필요) */
export function isIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * "앱으로 설치" 버튼 지원 (Chrome / Edge / Android).
 *   onAvailable(promptFn)  설치 가능해지면 호출. promptFn() → Promise<'accepted'|'dismissed'>
 *   onInstalled()          설치가 끝나면 호출 (선택)
 * 반환: { canInstall(), prompt(), dispose() }
 */
export function installPromptSupport({ onAvailable, onInstalled } = {}) {
  let deferred = null;
  const prompt = async () => {
    if (!deferred) return 'unavailable';
    const ev = deferred;
    deferred = null;                       // 한 번만 쓸 수 있음
    try {
      await ev.prompt();
      const choice = await ev.userChoice;
      return (choice && choice.outcome) || 'dismissed';
    } catch (e) { return 'dismissed'; }
  };
  const onBefore = (e) => {
    e.preventDefault();                    // 브라우저 기본 배너 대신 앱 안의 버튼으로
    deferred = e;
    safe(onAvailable, prompt);
  };
  const onDone = () => { deferred = null; safe(onInstalled); };
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', onBefore);
    window.addEventListener('appinstalled', onDone);
  }
  return {
    canInstall: () => !!deferred,
    prompt,
    dispose() {
      if (typeof window === 'undefined') return;
      window.removeEventListener('beforeinstallprompt', onBefore);
      window.removeEventListener('appinstalled', onDone);
    }
  };
}

function safe(fn, ...args) {
  if (typeof fn !== 'function') return;
  try { fn(...args); } catch (e) { console.error('[pwa] callback error:', e); }
}
