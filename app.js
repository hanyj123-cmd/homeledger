// Home Ledger 시작점. (화면/로직은 js/ 폴더 안의 파일들에 있습니다)
import * as auth from './js/auth.js';
import * as sync from './js/sync.js';
import * as ui from './js/ui.js';
import * as theme from './js/theme.js';
import * as lock from './js/lock.js';
import * as fx from './js/fx.js';
import * as settingsui from './js/settingsui.js';
import { registerSW } from './js/pwa.js';
import { CONFIG } from './js/config.js';

// 로그인 후 환율을 하루 한 번 자동으로 최신화 (실패해도 조용히 넘어갑니다)
async function autoFx() {
  try {
    if (!auth.getToken() || globalThis.__HL_TEST__) return;
    const data = await sync.loadAll();
    await fx.maybeAutoUpdate({
      fxRates: data.fxRates,
      saveRows: (rows) => sync.saveBatch({ FxRates: rows }, ['FxRates']),
      fetchFn: (...a) => fetch(...a)
    });
  } catch (e) { /* 환율 자동 갱신은 부가 기능 */ }
}

function showUpdateBanner(apply) {
  if (document.getElementById('update-banner')) return;
  const b = document.createElement('div');
  b.id = 'update-banner';
  b.className = 'update-banner';
  b.setAttribute('role', 'status');
  const t = document.createElement('span');
  t.textContent = 'New version available (새 버전이 있어요)';
  const go = document.createElement('button');
  go.type = 'button'; go.className = 'btn'; go.textContent = 'Update (업데이트)';
  go.addEventListener('click', () => { go.disabled = true; apply(); });
  const later = document.createElement('button');
  later.type = 'button'; later.className = 'btn secondary'; later.textContent = 'Later (나중에)';
  later.addEventListener('click', () => b.remove());
  b.append(t, go, later);
  document.body.append(b);
}

export async function start() {
  theme.applyAppearance();
  try {
    lock.initLock({
      idleMinutes: settingsui.getIdleMinutes(),
      onForgot: () => {
        if (window.confirm('잠금을 열 수 없나요? 잠금(PIN·기기 인증)을 모두 지우면 이 기기에서 로그아웃되고, 다시 구글 로그인이 필요합니다. 계속할까요?')) {
          lock.forceClearPin();
          try { auth.signOut(); } catch (e) { /* ignore */ }
        }
      }
    });
  } catch (e) { console.error('[lock]', e); }
  auth.onAuth((s) => { if (s.signedIn) sync.sync().then(autoFx); });
  auth.init();
  await ui.init();
  sync.startAutoSync();
  if (auth.getToken()) sync.sync().then(autoFx);
  registerSW({
    version: CONFIG.APP_VERSION,
    onUpdateReady: showUpdateBanner,
    onOnlineChange: () => { try { sync.refreshStatus().then(ui.renderChip); } catch (e) { /* ignore */ } }
  });
}

if (typeof document !== 'undefined' && !globalThis.__HL_TEST__) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
