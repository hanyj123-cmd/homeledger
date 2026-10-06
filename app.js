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
import * as prefs from './js/prefs.js';
import { icon } from './js/icons.js';
import { openPrintReport } from './js/printreport.js';

// 머리 오른쪽: 인쇄 · 한/영 버튼
function setupHeaderButtons() {
  const lb = document.getElementById('lang-btn');
  if (lb) {
    const cur = prefs.lang();
    lb.textContent = cur === 'ko' ? '한' : cur === 'en' ? 'EN' : '한/A';
    const next = cur === 'ko' ? 'en' : 'ko';
    const lab = cur === 'ko' ? 'Language: Korean — tap for English (언어: 한국어 — 누르면 영어)' : cur === 'en' ? 'Language: English — tap for Korean (언어: 영어 — 누르면 한국어)' : 'Language: both — tap for Korean only (언어: 둘 다 — 누르면 한국어만)';
    lb.setAttribute('aria-label', lab); lb.title = lab;
    lb.addEventListener('click', () => { prefs.setLang(next); try { location.reload(); } catch (e) { /* ignore */ } });
  }
  // 탭을 바꿀 때만 화면이 부드럽게 올라오는 효과 (자동 동기화로 다시 그릴 때는 효과 없음)
  const view = document.getElementById('view');
  let enterTimer = null;
  const enter = () => { if (!view) return; view.classList.add('hl-enter'); clearTimeout(enterTimer); enterTimer = setTimeout(() => view.classList.remove('hl-enter'), 700); };
  enter();
  document.addEventListener('click', (e) => { if (e.target && e.target.closest && e.target.closest('.tabs button[data-tab], .moremenu button')) enter(); }, true);
  const pb = document.getElementById('print-btn');
  if (pb) {
    pb.replaceChildren(icon('print', 20));
    pb.addEventListener('click', () => {
      try { openPrintReport(ui.pageApi(), { tab: ui.state.tab }); } catch (e) { console.error('[print]', e); }
    });
  }
}

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
  try { prefs.startTranslating(document); } catch (e) { console.error('[lang]', e); }
  setupHeaderButtons();
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
