// 화면: 거래 목록 / 입력 폼 / 계좌 / 설정
import { CONFIG } from './config.js';
import * as L from './ledger.js';
import * as sync from './sync.js';
import * as auth from './auth.js';
import * as importui from './importui.js';
import * as reports from './reports.js';
import * as receiptui from './receiptui.js';
import * as activity from './activity.js';
import * as drill from './drill.js';
import { icon, logoSvg } from './icons.js';
import * as catform from './catform.js';
import { initLayout, onLayout, layoutOf } from './layout.js';
import * as M from './meta.js';
import * as V from './valuation.js';
import * as I from './insights.js';
import * as summary from './summary.js';
import * as plan from './plan.js';
import * as wealth from './wealth.js';
import * as settingsui from './settingsui.js';
import * as theme from './theme.js';
import * as txnform from './txnform.js';
import * as xfer from './xfermatch.js';
import * as paybundle from './paybundle.js';
import * as RV from './receiptview.js';
import * as models from './models.js';

const $ = (id) => document.getElementById(id);
const fmt = (n, ccy) => L.fmtMoney(n, ccy);

export const state = { tab: 'summary', rev: 0, month: L.monthOf(L.todayStr()), query: '', acct: '', kind: '', filterOpen: false, repSel: new Set(), data: null, d: null };

// 아주 작은 DOM 도우미
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach((k) => {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'list') el.setAttribute('list', v);
      else if (k in el) { try { el[k] = v; } catch (e) { el.setAttribute(k, v); } }
      else el.setAttribute(k, v === true ? '' : v);
    });
  }
  kids.flat(Infinity).forEach((c) => {
    if (c === undefined || c === null || c === false) return;
    el.append(c && c.nodeType ? c : document.createTextNode(String(c)));
  });
  return el;
}

let toastTimer = null;
export function toast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, Math.max(2800, String(msg).length * 120));
}

// ───────── 데이터 ─────────

function derive(data) {
  const accMap = L.makeAccMap(data.accounts);
  const txns = data.txns.filter((t) => !L.truthy(t.deleted));
  const ids = new Set(txns.map((t) => String(t.txn_id)));
  const byTxn = new Map();
  data.postings.forEach((p) => {
    if (L.truthy(p.deleted)) return;
    const id = String(p.txn_id);
    if (!ids.has(id)) return;
    if (!byTxn.has(id)) byTxn.set(id, []);
    byTxn.get(id).push(p);
  });
  const items = txns.map((t) => {
    const ps = byTxn.get(String(t.txn_id)) || [];
    return { txn: t, ps, desc: L.describeTxn(t, ps, accMap) };
  });
  items.sort((a, b) => {
    if (a.txn.date !== b.txn.date) return a.txn.date < b.txn.date ? 1 : -1;
    return String(b.txn.created_at || '').localeCompare(String(a.txn.created_at || ''));
  });
  return { accMap, items, itemById: new Map(items.map((i) => [String(i.txn.txn_id), i])) };
}

async function reload() {
  state.data = await sync.loadAll();
  state.d = derive(state.data);
  state.rev++;
  state.metaCache = null;
  state.anCache = null;
  try { models.fromMeta(metaAll().gemini); } catch (e) { /* 모델 선택은 없어도 자동으로 동작 */ }
}

/** 설정(Settings 시트의 JSON) — 데이터가 바뀔 때만 다시 읽음 */
function metaAll() {
  if (!state.metaCache) state.metaCache = M.readAll(state.data.settings);
  return state.metaCache;
}
const overridesFor = (ym) => V.overridesFor(metaAll(), state.d.items, ym);

/** 요약·조언 계산 결과 (같은 데이터·같은 달·같은 날이면 한 번만 계산) */
function analysis() {
  const today = L.todayStr();
  const k = state.rev + '|' + state.month + '|' + today;
  if (!state.anCache || state.anCache.k !== k) {
    state.anCache = { k, v: I.analyze({ accounts: state.data.accounts.filter(L.isActive), items: state.d.items, accMap: state.d.accMap, budgets: state.data.budgets || [], meta: metaAll(), ym: state.month, today }) };
  }
  return state.anCache.v;
}

/** 화면 모듈(summary / plan / wealth / settings …)이 쓰는 공용 도구 모음 */
export function pageApi(extra) {
  return Object.assign({
    h, fmt, toast, state, icon,
    data: state.data, d: state.d, items: state.d.items, accounts: state.data.accounts, accMap: state.d.accMap,
    meta: metaAll, overridesFor, analysis, today: L.todayStr(),
    saveSettings: async (rows) => { await sync.saveBatch({ Settings: [].concat(rows).filter(Boolean) }, ['Settings']); await reload(); renderBody(true); },
    saveBudgets: async (rows) => { await sync.saveBatch({ Budgets: rows }, ['Budgets']); await reload(); renderBody(true); },
    saveBatch: async (puts, order) => { await sync.saveBatch(puts, order); await reload(); renderBody(true); },
    reload, rerender: () => renderBody(true),
    openForm: (id, defaults) => openForm(id, defaults),
    openScan: () => receiptui.openScan(receiptApi()),
    go: (tab, patch) => { Object.assign(state, patch || {}); state.tab = tab; drill.close(); renderAll(); },
    goSearch: (text) => { state.query = text; state.acct = ''; state.tab = 'txns'; drill.close(); renderAll(); },
    openCategoryForm: (o) => catform.openCategoryForm(pageApi(), o),
    drillApi, auth, sync, theme
  }, extra || {});
}

// ───────── 시작 ─────────

const SEC_TABS = [['accounts', 'accounts', 'Accounts', '계좌'], ['import', 'import', 'Import', '가져오기'], ['settings', 'settings', 'Settings', '설정']];

function paintThemeBtn() {
  const b = $('theme-btn');
  if (!b) return;
  const t = theme.getTheme();
  b.replaceChildren(icon(t === 'dark' ? 'moon' : t === 'light' ? 'sun' : 'auto', 20));
  const name = t === 'dark' ? 'Dark (어둡게)' : t === 'light' ? 'Light (밝게)' : 'Auto (시스템 따라)';
  b.setAttribute('aria-label', 'Theme: ' + name + ' — tap to change (누르면 바뀝니다)');
  b.title = 'Theme: ' + name;
}

function closeMore() {
  const m = document.querySelector('.moremenu');
  if (m) m.remove();
  const b = $('tab-more');
  if (b) b.setAttribute('aria-expanded', 'false');
}
function toggleMore() {
  if (document.querySelector('.moremenu')) { closeMore(); return; }
  const menu = h('div', { class: 'moremenu', role: 'menu' }, SEC_TABS.map((t) => h('button', {
    type: 'button', role: 'menuitem', class: state.tab === t[0] ? 'on' : '',
    onclick: () => { closeMore(); state.tab = t[0]; drill.close(); if (t[0] === 'import') importui.resetIfDone(); renderAll(); }
  }, icon(t[1], 22), h('span', null, t[2]), h('span', { class: 'ko' }, t[3]))));
  document.body.append(menu);
  $('tab-more').setAttribute('aria-expanded', 'true');
  setTimeout(() => document.addEventListener('click', function off(e) {
    if (!menu.contains(e.target) && e.target.closest('#tab-more') === null) { closeMore(); document.removeEventListener('click', off); }
  }), 0);
}

export async function init() {
  initLayout();
  theme.applyAppearance();
  paintThemeBtn();
  $('theme-btn')?.addEventListener('click', () => {
    const t = theme.cycleTheme();
    paintThemeBtn();
    toast(t === 'dark' ? 'Dark mode (어두운 화면)' : t === 'light' ? 'Light mode (밝은 화면)' : 'Auto — follows your device (기기 설정을 따라갑니다)');
  });
  theme.onSystemThemeChange(() => paintThemeBtn());
  $('tab-more')?.addEventListener('click', toggleMore);
  const logo = $('logo');
  if (logo) logo.innerHTML = logoSvg(34);
  document.querySelectorAll('.tabs [data-ic]').forEach((el) => { el.replaceChildren(icon(el.getAttribute('data-ic'), 24)); });
  document.querySelectorAll('.tabs button[data-tab]').forEach((b) => {
    b.addEventListener('click', () => {
      closeMore();
      state.tab = b.getAttribute('data-tab');
      drill.close();
      if (state.tab === 'import') importui.resetIfDone();
      renderAll();
    });
  });
  $('fab').addEventListener('click', () => openForm(null));
  $('fab-scan').addEventListener('click', () => receiptui.openScan(receiptApi()));
  $('chip').addEventListener('click', onChip);
  $('drawer-scrim')?.addEventListener('click', () => drill.close());
  onLayout(() => { if (state.d) renderAll(); });
  sync.onStatus(renderChip);
  sync.onData(async () => { await reload(); renderBody(); autoTasks(); });   // 이체 자동 연결 · 급여일 연동 입력 (동기화·가져오기 후)
  auth.onAuth(() => { sync.refreshStatus().then(renderChip); });
  await reload();
  await sync.refreshStatus();
  renderAll();
  autoTasks();   // 이체 자동 연결 · 급여일 연동 입력 (처음 불러온 뒤)
}
const xferApi = () => ({ h, toast, state, reload, renderBody });
// 자동 작업은 차례로 (같은 시트를 동시에 쓰지 않도록)
async function autoTasks() {
  try { await paybundle.autoRun(xferApi()); } catch (e) { console.error(e); }
  try { await xfer.autoMatch(xferApi()); } catch (e) { console.error(e); }
}

export async function doSignIn() {
  try {
    await auth.signIn();
    toast('Signed in (로그인되었습니다)');
    sync.sync();
  } catch (e) {
    toast(e.message || '로그인에 실패했습니다.');
  }
  renderChip();
}

function onChip() {
  if (!auth.getToken()) doSignIn();
  else sync.sync();
}

export function renderChip() {
  const chip = $('chip');
  if (!chip) return;
  const s = sync.getStatus();
  const signedIn = !!auth.getToken();
  const pend = s.pending ? ' · ' + s.pending : '';
  let text, cls, title = '';
  if (s.phase === 'syncing') { text = '↻ Syncing… (동기화 중)'; cls = 'busy'; }
  else if (!signedIn || s.phase === 'auth') { text = '● Sign in (로그인 필요)' + pend; cls = 'warn'; }
  else if (s.phase === 'offline') { text = '○ Offline (오프라인)' + pend; cls = 'warn'; }
  else if (s.phase === 'error') { text = '⚠ Sync error (오류)' + pend; cls = 'bad'; title = s.error; }
  else if (s.pending) { text = '↑ Pending (대기 ' + s.pending + '건)'; cls = 'busy'; }
  else { text = '● Synced (동기화됨)'; cls = 'ok'; }
  chip.textContent = text;
  chip.className = 'chip ' + cls;
  chip.title = title;
}

function renderAll() {
  document.querySelectorAll('.tabs button[data-tab]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-tab') === state.tab));
  $('tab-more')?.classList.toggle('on', SEC_TABS.some((t) => t[0] === state.tab));
  $('fab').hidden = state.tab !== 'txns';
  $('fab-scan').hidden = state.tab !== 'txns';
  renderChip();
  renderBody(true);
}

export function renderBody(force) {
  if (!state.d) return;
  if (!force && state.tab === 'import' && importui._state().parsed && !importui._state().done) return;
  if (!force && state.tab === 'txns' && $('q') && document.activeElement === $('q')) return;
  if (state.tab === 'summary') renderPage(summary);
  else if (state.tab === 'plan') renderPage(plan);
  else if (state.tab === 'wealth') renderPage(wealth);
  else if (state.tab === 'txns') renderTxns();
  else if (state.tab === 'accounts') renderAccounts();
  else if (state.tab === 'reports') renderReports();
  else if (state.tab === 'import') renderImport();
  else renderPage(settingsui, renderSettings);
  if (state.tab === 'txns' || state.tab === 'reports' || state.tab === 'summary') drill.restore(drillApi()); else drill.close();
  if (typeof window !== 'undefined' && window.scrollTo && force === true && !state.keepScroll) { /* 탭을 바꿨을 때만 위로 */ }
}

/** 새 화면 모듈을 그리기. 모듈이 오류를 내도 다른 탭은 멀쩡하게 */
function renderPage(mod, fallback) {
  const v = $('view');
  v.replaceChildren();
  if (!state.data.accounts.length) { v.append(emptyState()); return; }
  try {
    v.append(mod.render(pageApi()));
  } catch (e) {
    console.error(e);
    if (fallback) { fallback(); return; }
    v.append(h('div', { class: 'card warn-card', role: 'alert' }, '이 화면을 그리는 중 오류가 났어요: ' + (e && e.message ? e.message : e) + ' — 다른 탭은 정상입니다. 새로고침 해보세요.'));
  }
}

/** 상세 패널(drill)이 쓰는 도구 모음 */
function drillApi() {
  return {
    h, fmt, toast, state, reload, renderBody,
    openForm: (id, defaults) => openForm(id, defaults),
    viewReceipt: (id) => RV.viewTxnReceipt(receiptApi(), id),
    goSearch: (text) => { state.query = text; state.acct = ''; state.tab = 'txns'; drill.close(); renderAll(); }
  };
}

function emptyState() {
  const signedIn = !!auth.getToken();
  return h('div', { class: 'card center' },
    h('p', null, signedIn ? 'Loading your ledger… (장부를 불러오는 중입니다)' : 'Sign in to load your ledger (로그인하면 장부를 불러옵니다)'),
    signedIn ? null : h('button', { type: 'button', class: 'btn', onclick: doSignIn }, 'Sign in with Google (구글로 로그인)'));
}

/** 가져오기·계좌·설정 화면의 위쪽 초록 띠 */
function banner(title, metrics) {
  const m = h('div', { class: 'metrics' });
  (metrics || []).forEach((x) => m.append(h('div', { class: 'metric' + (x.sub ? ' sub' : ''), id: x.id || null }, h('div', { class: 'metric-lab' }, x.label), h('div', { class: 'metric-val' }, x.value))));
  return h('section', { class: 'banner nopills' }, h('div', { class: 'banner-in' },
    h('div', { class: 'banner-row' }, h('div', { class: 'acct-pick' }, h('span', { class: 'nm' }, title))), metrics && metrics.length ? m : null));
}

// ───────── 거래 목록 (Ledger) ─────────

function renderTxns() {
  const v = $('view');
  v.replaceChildren();
  if (!state.data.accounts.length) { v.append(emptyState()); return; }
  v.append(activity.render({
    h, fmt, toast, state,
    rerender: () => renderTxns(),
    openForm: (id, defaults) => openForm(id, defaults),
    openScan: () => receiptui.openScan(receiptApi()),
    viewReceipt: (id) => RV.viewTxnReceipt(receiptApi(), id),
    goImport: () => { state.tab = 'import'; importui.resetIfDone(); drill.close(); renderAll(); },
    drillApi
  }));
  xferNotice(v);
}

/** 거래 탭 위쪽: 이체로 보이는 거래가 있으면 알림 (누르면 확인 창) */
function xferNotice(v) {
  const n = xfer.pendingSuggestions(state.d.items, state.d.accMap, state.data.settings, state.data.stmtLines).length;
  if (!n) return;
  const note = h('button', { type: 'button', class: 'xf-notice', id: 'xf-notice', onclick: () => drill.showTransferReview(drillApi()) },
    icon('transfer', 20), h('span', null, n + ' possible transfer' + (n === 1 ? '' : 's') + ' to check (이체로 보이는 거래 ' + n + '건 확인하기)'), icon('right', 18));
  const pg = v.querySelector('.page');
  if (pg) pg.prepend(note); else v.append(note);
}

// ───────── 보고서 (손익 · 재무상태) ─────────

function renderReports() {
  const v = $('view');
  v.replaceChildren();
  if (!state.data.accounts.length) { v.append(emptyState()); return; }
  v.append(reports.render({
    h, fmt, toast, state, items: state.d.items, accounts: state.data.accounts, accMap: state.d.accMap, data: state.data, overridesFor, pageApi,
    saveBudgets: async (rows) => { await sync.saveBatch({ Budgets: rows }, ['Budgets']); await reload(); renderReports(); },
    saveBatch: async (puts, order) => { await sync.saveBatch(puts, order); await reload(); renderReports(); },
    openCategoryForm: (o) => catform.openCategoryForm(Object.assign(pageApi(), { saveBatch: async (puts, order) => { await sync.saveBatch(puts, order); await reload(); renderReports(); } }), o),
    rerender: () => { renderReports(); drill.restore(drillApi()); },
    openForm: (id, defaults) => openForm(id, defaults),
    goSearch: (text) => { state.query = text; state.acct = ''; state.tab = 'txns'; drill.close(); renderAll(); },
    drillApi
  }));
}

// ───────── 명세서 가져오기 ─────────

function renderImport() {
  const v = $('view');
  v.replaceChildren();
  if (!state.data.accounts.length) { v.append(emptyState()); return; }
  v.append(banner('Import statement (명세서 가져오기)'));
  const pg = h('div', { class: 'page imp-page' });
  v.append(pg);
  pg.append(importui.render({
    h, toast, state, fmt,
    accounts: state.data.accounts, accMap: state.d.accMap, data: state.data, items: state.d.items,
    reload: async () => { await reload(); },
    goToTxns: (month) => { if (month) state.month = month; state.query = ''; state.acct = ''; state.tab = 'txns'; renderAll(); }
  }));
}

// ───────── 계좌 ─────────

let accOwner = '';   // 계좌 목록 소유자 필터 (태블릿·PC)
const ACC_GROUPS = [
  ['cash', 'Banking', '은행'], ['invest', 'Investments', '투자'], ['fixed', 'Home & car', '집·차'], ['other', 'Other assets', '기타 자산'],
  ['card', 'Credit cards', '신용카드'], ['loc', 'Lines of credit', '한도 대출'], ['loan', 'Loans and mortgages', '대출·모기지'],
  ['accrued', 'Accrued', '미지급'], ['clearing', 'Clearing', '정산 중']
];
function goAcct(id) { state.acct = String(id); state.query = ''; state.kind = ''; state.tab = 'txns'; drill.close(); renderAll(); }

function renderAccounts() {
  const d = state.d;
  const v = $('view');
  v.replaceChildren();
  if (!state.data.accounts.length) { v.append(emptyState()); return; }
  const accounts = state.data.accounts.filter(L.isActive);
  const bal = L.accountBalances(accounts, d.items.flatMap((i) => i.ps));
  overridesFor(L.monthOf(L.todayStr())).forEach((v, id) => { if (bal.has(id)) bal.set(id, v); });
  const nw = L.netWorth(accounts, bal);
  const phone = layoutOf() === 'phone';
  const bn = banner('Accounts (계좌)', [
    { label: 'Net worth (순자산)', value: (nw.net < 0 ? '−' : '') + fmt(Math.abs(nw.net)), id: 'ac-net' },
    { label: 'Assets (자산)', value: fmt(nw.assets), sub: true },
    { label: 'Debts (부채)', value: fmt(nw.liabilities), sub: true }]);
  v.append(bn);
  const pg = h('div', { class: 'page' });
  if (!phone) {
    bn.classList.remove('nopills');
    v.append(h('div', { class: 'pills', id: 'acl-pills' },
      h('button', { type: 'button', class: 'pillbtn', id: 'acl-new', onclick: () => openForm(null, {}) }, icon('plus', 24), 'New ', h('span', { class: 'ko' }, '거래 추가')),
      h('button', { type: 'button', class: 'pillbtn', id: 'acl-xfer', onclick: () => openForm(null, { kind: 'TRANSFER' }) }, icon('transfer', 24), 'Make a transfer ', h('span', { class: 'ko' }, '이체')),
      h('button', { type: 'button', class: 'pillbtn', id: 'acl-imp', onclick: () => { state.tab = 'import'; importui.resetIfDone(); drill.close(); renderAll(); } }, icon('import', 24), 'Import ', h('span', { class: 'ko' }, '가져오기'))));
  }
  v.append(pg);
  if (!d.items.length) {
    pg.append(h('div', { class: 'card muted' }, 'Start with opening balances (먼저 기초잔액을 입력하세요): New → Opening (기초잔액). Balances are computed from your transactions (잔액은 입력한 거래로 계산됩니다).'));
  }
  if (phone) {
    [['ASSET', 'Assets (자산)'], ['LIABILITY', 'Credit & loans (카드 · 대출)']].forEach((g) => {
      const list = accounts.filter((a) => a.type === g[0]);
      if (!list.length) return;
      pg.append(h('h2', { class: 'sect' }, g[1]));
      const grid = h('div', { class: 'acc-grid' });
      pg.append(grid);
      list.forEach((a) => {
        const b = bal.get(String(a.account_id)) || 0;
        grid.append(h('button', { type: 'button', class: 'acc-card' + (a.type === 'LIABILITY' ? ' liab' : ''), 'data-acct': a.account_id, onclick: () => goAcct(a.account_id) },
          h('div', { class: 'ty' }, a.type === 'LIABILITY' ? 'Credit / loan' : 'Account'),
          h('div', { class: 'nm' }, L.accLabel(a)),
          h('div', { class: 'ow' }, [a.owner, a.institution].filter(Boolean).join(' · ') || ' '),
          h('div', { class: 'bl' }, fmt(b))));
      });
    });
    return;
  }

  // ── 태블릿·PC: 은행 사이트처럼 그룹별 목록
  const owners = [];
  accounts.forEach((a) => { const o = String(a.owner || '').trim(); if (o && owners.indexOf(o) < 0) owners.push(o); });
  if (accOwner && owners.indexOf(accOwner) < 0) accOwner = '';
  const shown = accounts.filter((a) => (a.type === 'ASSET' || a.type === 'LIABILITY') && (!accOwner || String(a.owner || '').trim() === accOwner));
  // 외화 계좌: 원래 통화 잔액
  const orig = new Map();
  d.items.forEach((it) => it.ps.forEach((p) => {
    if (L.truthy(p.deleted)) return;
    const k = String(p.account_id);
    orig.set(k, (orig.get(k) || 0) + L.num(p.amount_orig !== '' && p.amount_orig !== undefined ? p.amount_orig : p.amount_cad));
  }));
  const fx = (a) => {
    const cur = String(a.currency || 'CAD').toUpperCase();
    if (cur === 'CAD') return null;
    const r = orig.get(String(a.account_id)) || 0;
    return cur + ' ' + fmt(L.round(a.type === 'LIABILITY' ? -r : r, 2));
  };
  const head = h('div', { class: 'acl-head' },
    h('h1', { class: 'acl-title' }, 'My accounts ', h('span', { class: 'ko' }, '내 계좌')),
    owners.length > 1 ? h('div', { class: 'acl-seg', role: 'group', 'aria-label': 'Owner (소유자)' },
      [['', 'All (전체)']].concat(owners.map((o) => [o, o])).map(([k, lab]) => h('button', { type: 'button', class: accOwner === k ? 'on' : '', 'aria-pressed': String(accOwner === k), 'data-owner': k,
        onclick: () => { accOwner = k; renderAccounts(); } }, lab))) : null);
  const panel = h('div', { class: 'acl', id: 'acl' });
  ACC_GROUPS.forEach(([k, en, ko]) => {
    const list = shown.filter((a) => I.kindOf(a) === k);
    if (!list.length) return;
    if (k === 'clearing' && list.every((a) => Math.abs(bal.get(String(a.account_id)) || 0) < 0.005)) return;
    const tot = L.round(list.reduce((s2, a) => s2 + (bal.get(String(a.account_id)) || 0), 0), 2);
    const fxTot = new Map();
    list.forEach((a) => { const c = String(a.currency || 'CAD').toUpperCase(); if (c !== 'CAD') { const r = orig.get(String(a.account_id)) || 0; fxTot.set(c, (fxTot.get(c) || 0) + (a.type === 'LIABILITY' ? -r : r)); } });
    panel.append(h('div', { class: 'acl-g', 'data-group': k },
      h('div', { class: 'acl-gh' }, h('span', { class: 'acl-gn' }, en, ' ', h('span', { class: 'ko' }, ko)),
        h('span', { class: 'acl-gt' }, h('b', null, (tot < 0 ? '−' : '') + fmt(Math.abs(tot))), Array.from(fxTot.entries()).map(([c, n]) => h('b', { class: 'acl-fx' }, c + ' ' + fmt(L.round(n, 2)))))),
      list.map((a) => {
        const b = bal.get(String(a.account_id)) || 0;
        const f = fx(a);
        const sub = [a.last4 ? '····' + String(a.last4).replace(/\s*,\s*/g, ' ····') : '', a.institution, a.owner].filter(Boolean).join(' · ');
        return h('button', { type: 'button', class: 'acl-row', 'data-acct': a.account_id, onclick: () => goAcct(a.account_id), 'aria-label': L.accLabel(a) + ' ' + fmt(b) },
          h('span', { class: 'acl-nm' }, h('span', { class: 'acl-link' }, a.name), a.name_ko && a.name_ko !== a.name ? h('span', { class: 'ko' }, ' ' + a.name_ko) : null, sub ? h('span', { class: 'acl-no' }, sub) : null),
          h('span', { class: 'acl-bal' }, f ? h('span', { class: 'acl-fx' }, f) : null, h('span', { class: f ? 'acl-cad' : '' }, (b < 0 ? '−' : '') + fmt(Math.abs(b)) + (f ? ' CAD' : ''))),
          h('span', { class: 'acl-go' }, icon('right', 20)));
      })));
  });
  if (!panel.childNodes.length) panel.append(h('div', { class: 'muted acl-empty' }, 'No accounts for this owner (이 소유자의 계좌가 없어요).'));
  pg.append(head, panel);
}

// ───────── 설정 ─────────

function renderSettings() {
  const v = $('view');
  v.replaceChildren();
  const st = sync.getStatus();
  const au = auth.getState();
  const last = st.lastSync ? new Date(st.lastSync).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' }) : '—';
  v.append(banner('Settings (설정)'));
  const pg = h('div', { class: 'page' }, h('div', { class: 'settings-grid' },
    h('div', null,
      h('h2', { class: 'sect' }, 'Account (계정)'),
      h('div', { class: 'card' },
        h('div', null, au.signedIn ? 'Signed in (로그인됨): ' + (au.email || '') : 'Not signed in (로그인 안 됨)'),
        h('div', { class: 'muted' }, 'Last sync (마지막 동기화): ' + last + ' · Pending (대기): ' + st.pending),
        st.error ? h('div', { class: 'err' }, st.error) : null,
        h('div', { class: 'btnrow' },
          au.signedIn
            ? h('button', { type: 'button', class: 'btn', onclick: () => sync.sync() }, 'Sync now (지금 동기화)')
            : h('button', { type: 'button', class: 'btn', onclick: doSignIn }, 'Sign in (로그인)'),
          au.signedIn ? h('button', { type: 'button', class: 'btn secondary', onclick: () => { auth.signOut(); renderAll(); } }, 'Sign out (로그아웃)') : null))),
    h('div', null,
      h('h2', { class: 'sect' }, 'Data (데이터)'),
      h('div', { class: 'card' },
        h('div', { class: 'btnrow' },
          h('button', {
            type: 'button', class: 'btn secondary',
            onclick: () => { if (window.confirm('Reload everything from the sheet? (시트에서 전부 다시 불러올까요?) 전송 대기 중인 항목은 유지됩니다.')) sync.reloadFromSheet(); }
          }, 'Reload from sheet (시트에서 다시 불러오기)'),
          h('a', { class: 'btn secondary', href: 'https://docs.google.com/spreadsheets/d/' + CONFIG.SHEET_ID + '/edit', target: '_blank', rel: 'noopener' }, 'Open Google Sheet (시트 열기)'))))),
    h('div', { class: 'muted small' }, 'Home Ledger v' + CONFIG.APP_VERSION));
  v.append(pg);
}

// ───────── 거래 입력/수정 폼 (js/txnform.js) ─────────

const receiptApi = () => ({ h, toast, state, fmt, reload, renderBody, saveBatch: async (puts, order) => { await sync.saveBatch(puts, order); await reload(); renderBody(true); } });

export function openForm(txnId, defaults) {
  if (txnId && receiptui.isReceiptTxn(state, txnId)) { receiptui.openEdit(receiptApi(), txnId); return; }
  let defaultOwner = '';
  if (!txnId) { try { defaultOwner = settingsui.defaultOwner(metaAll().users, auth.getState().email) || ''; } catch (e) { /* 기본값 유지 */ } }
  txnform.openForm({ h, fmt, toast, state, reload, renderBody, defaultOwner, openScan: () => receiptui.openScan(receiptApi()),
    viewReceipt: (id) => RV.viewTxnReceipt(receiptApi(), id), attachReceipt: (id) => RV.attach(receiptApi(), id) }, txnId, defaults);
}
