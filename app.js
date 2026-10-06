// Home Ledger 시작점. (화면/로직은 js/ 폴더 안의 파일들에 있습니다)
import * as auth from './js/auth.js';
import * as sync from './js/sync.js';
import * as ui from './js/ui.js';

export async function start() {
  auth.onAuth((s) => { if (s.signedIn) sync.sync(); });
  auth.init();
  await ui.init();
  sync.startAutoSync();
  if (auth.getToken()) sync.sync();
}

if (typeof document !== 'undefined' && !globalThis.__HL_TEST__) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
