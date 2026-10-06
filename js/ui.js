// 화면: 거래 목록 / 입력 폼 / 계좌 / 설정
import { CONFIG } from './config.js';
import * as L from './ledger.js';
import * as sync from './sync.js';
import * as auth from './auth.js';

const $ = (id) => document.getElementById(id);
const fmt = (n, ccy) => L.fmtMoney(n, ccy);

export const state = { tab: 'txns', month: L.monthOf(L.todayStr()), query: '', data: null, d: null };

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
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
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
}

// ───────── 시작 ─────────

export async function init() {
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.addEventListener('click', () => { state.tab = b.getAttribute('data-tab'); renderAll(); });
  });
  $('fab').addEventListener('click', () => openForm(null));
  $('chip').addEventListener('click', onChip);
  sync.onStatus(renderChip);
  sync.onData(async () => { await reload(); renderBody(); });
  auth.onAuth(() => { sync.refreshStatus().then(renderChip); });
  await reload();
  await sync.refreshStatus();
  renderAll();
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
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-tab') === state.tab));
  $('fab').hidden = state.tab !== 'txns';
  renderChip();
  renderBody(true);
}

export function renderBody(force) {
  if (!state.d) return;
  if (!force && state.tab === 'txns' && $('q') && document.activeElement === $('q')) { renderList(); return; }
  if (state.tab === 'txns') renderTxns();
  else if (state.tab === 'accounts') renderAccounts();
  else renderSettings();
}

const stat = (label, value, cls) => h('div', { class: 'stat' }, h('div', { class: 'stat-l' }, label), h('div', { class: 'stat-v ' + (cls || '') }, value));

function emptyState() {
  const signedIn = !!auth.getToken();
  return h('div', { class: 'card center' },
    h('p', null, signedIn ? 'Loading your ledger… (장부를 불러오는 중입니다)' : 'Sign in to load your ledger (로그인하면 장부를 불러옵니다)'),
    signedIn ? null : h('button', { type: 'button', class: 'btn', onclick: doSignIn }, 'Sign in with Google (구글로 로그인)'));
}

// ───────── 거래 목록 ─────────

function renderTxns() {
  const v = $('view');
  v.replaceChildren();
  if (!state.data.accounts.length) { v.append(emptyState()); return; }
  const nav = h('div', { class: 'monthnav' },
    h('button', { type: 'button', class: 'icon', 'aria-label': 'Previous month (이전 달)', onclick: () => { state.month = L.shiftMonth(state.month, -1); renderTxns(); } }, '‹'),
    h('div', { class: 'monthlabel' }, L.monthLabel(state.month)),
    h('button', { type: 'button', class: 'icon', 'aria-label': 'Next month (다음 달)', onclick: () => { state.month = L.shiftMonth(state.month, 1); renderTxns(); } }, '›'));
  const search = h('input', {
    type: 'search', id: 'q', placeholder: 'Search (검색): merchant, amount, account…', value: state.query,
    oninput: (e) => { state.query = e.target.value; renderList(); }
  });
  v.append(nav, h('div', { class: 'summary', id: 'summary' }), search, h('div', { id: 'list' }));
  renderList();
}

function renderList() {
  const d = state.d;
  const list = $('list');
  const sum = $('summary');
  if (!list || !sum) return;
  const q = state.query.trim();
  const items = q ? L.searchItems(d.items, q) : d.items.filter((it) => L.monthOf(it.txn.date) === state.month);
  const s = L.monthSummary(d.items, d.accMap, state.month);
  sum.replaceChildren(
    stat('Income (수입)', '↑ ' + fmt(s.income), 'in'),
    stat('Spending (지출)', '↓ ' + fmt(s.spending), 'out'),
    stat('Net (순수입)', (s.net >= 0 ? '▲ ' : '▼ ') + fmt(Math.abs(s.net)), s.net >= 0 ? 'in' : 'out'));
  list.replaceChildren();
  if (q) list.append(h('div', { class: 'note' }, items.length + ' result(s) (검색 결과 ' + items.length + '건) — all months (전체 기간)'));
  if (!items.length) {
    list.append(h('div', { class: 'card center muted' }, q ? 'No matches (일치하는 거래가 없습니다)' : 'No transactions this month (이번 달 거래가 없습니다). Tap + to add (+ 버튼으로 추가)'));
    return;
  }
  const CAP = 200;
  let last = null;
  items.slice(0, CAP).forEach((it) => {
    if (it.txn.date !== last) { list.append(h('div', { class: 'dayhead' }, L.dayLabel(it.txn.date))); last = it.txn.date; }
    list.append(row(it));
  });
  if (items.length > CAP) list.append(h('div', { class: 'note' }, 'Showing first ' + CAP + ' (처음 ' + CAP + '건만 표시)'));
}

function row(it) {
  const t = it.txn, dsc = it.desc;
  const title = t.merchant || t.memo || dsc.categoryName;
  const sub = [dsc.categoryName, dsc.accountName];
  if (t.merchant && t.memo) sub.push(t.memo);
  const arrow = dsc.flow === 'out' ? '↓' : dsc.flow === 'in' ? '↑' : '⇄';
  const foreign = t.currency && t.currency !== 'CAD';
  const prov = String(t.fx_status).toUpperCase() === 'PROVISIONAL' ? '~' : '';
  return h('button', { type: 'button', class: 'row', onclick: () => openForm(t.txn_id) },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, title),
      h('div', { class: 'row-sub' }, sub.filter(Boolean).join(' · '))),
    h('div', { class: 'row-right' },
      h('div', { class: 'row-amt ' + dsc.flow }, arrow + ' ' + fmt(L.num(t.total_cad))),
      foreign ? h('div', { class: 'row-fx' }, prov + fmt(L.num(t.total_orig), t.currency)) : null));
}

// ───────── 계좌 ─────────

function renderAccounts() {
  const d = state.d;
  const v = $('view');
  v.replaceChildren();
  if (!state.data.accounts.length) { v.append(emptyState()); return; }
  const accounts = state.data.accounts.filter(L.isActive);
  const bal = L.accountBalances(accounts, d.items.flatMap((i) => i.ps));
  const nw = L.netWorth(accounts, bal);
  v.append(h('div', { class: 'summary' },
    stat('Assets (자산)', fmt(nw.assets), ''),
    stat('Debts (부채)', fmt(nw.liabilities), ''),
    stat('Net worth (순자산)', (nw.net >= 0 ? '▲ ' : '▼ ') + fmt(Math.abs(nw.net)), nw.net >= 0 ? 'in' : 'out')));
  if (!d.items.length) {
    v.append(h('div', { class: 'card muted' }, 'Start with opening balances (먼저 기초잔액을 입력하세요): + → Opening (기초잔액). Balances are computed from your transactions (잔액은 입력한 거래로 계산됩니다).'));
  }
  [['ASSET', 'Assets (자산)'], ['LIABILITY', 'Credit & loans (카드 · 대출)']].forEach((g) => {
    const list = accounts.filter((a) => a.type === g[0]);
    if (!list.length) return;
    v.append(h('h2', { class: 'sect' }, g[1]));
    list.forEach((a) => {
      const b = bal.get(String(a.account_id)) || 0;
      v.append(h('button', {
        type: 'button', class: 'row acc', onclick: () => { state.query = a.name; state.tab = 'txns'; renderAll(); }
      },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, L.accLabel(a)),
        h('div', { class: 'row-sub' }, [a.owner, a.institution].filter(Boolean).join(' · '))),
      h('div', { class: 'row-right' }, h('div', { class: 'row-amt ' + (b === 0 ? 'move' : '') }, fmt(b)))));
    });
  });
}

// ───────── 설정 ─────────

function renderSettings() {
  const v = $('view');
  v.replaceChildren();
  const st = sync.getStatus();
  const au = auth.getState();
  const last = st.lastSync ? new Date(st.lastSync).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' }) : '—';
  v.append(
    h('h2', { class: 'sect' }, 'Account (계정)'),
    h('div', { class: 'card' },
      h('div', null, au.signedIn ? 'Signed in (로그인됨): ' + (au.email || '') : 'Not signed in (로그인 안 됨)'),
      h('div', { class: 'muted' }, 'Last sync (마지막 동기화): ' + last + ' · Pending (대기): ' + st.pending),
      st.error ? h('div', { class: 'err' }, st.error) : null,
      h('div', { class: 'btnrow' },
        au.signedIn
          ? h('button', { type: 'button', class: 'btn', onclick: () => sync.sync() }, 'Sync now (지금 동기화)')
          : h('button', { type: 'button', class: 'btn', onclick: doSignIn }, 'Sign in (로그인)'),
        au.signedIn ? h('button', { type: 'button', class: 'btn secondary', onclick: () => { auth.signOut(); renderAll(); } }, 'Sign out (로그아웃)') : null)),
    h('h2', { class: 'sect' }, 'Data (데이터)'),
    h('div', { class: 'card' },
      h('div', { class: 'btnrow' },
        h('button', {
          type: 'button', class: 'btn secondary',
          onclick: () => { if (window.confirm('Reload everything from the sheet? (시트에서 전부 다시 불러올까요?) 전송 대기 중인 항목은 유지됩니다.')) sync.reloadFromSheet(); }
        }, 'Reload from sheet (시트에서 다시 불러오기)'),
        h('a', { class: 'btn secondary', href: 'https://docs.google.com/spreadsheets/d/' + CONFIG.SHEET_ID + '/edit', target: '_blank', rel: 'noopener' }, 'Open Google Sheet (시트 열기)'))),
    h('div', { class: 'muted small' }, 'Home Ledger v' + CONFIG.APP_VERSION));
}

// ───────── 거래 입력/수정 폼 ─────────

const KIND_LABELS = [['EXPENSE', 'Expense (지출)'], ['INCOME', 'Income (수입)'], ['TRANSFER', 'Transfer (이체)'], ['OPENING', 'Opening (기초잔액)']];

export function openForm(txnId) {
  const d = state.d;
  const data = state.data;
  const existing = txnId ? d.itemById.get(String(txnId)) : null;
  let f;
  if (existing) f = L.formFromTxn(existing.txn, existing.ps, d.accMap);
  else {
    f = L.newForm();
    try { f.fromId = localStorage.getItem('hl_last_from') || ''; } catch (e) { /* ignore */ }
    if (!d.accMap.has(String(f.fromId))) f.fromId = '';
  }
  const ov = $('overlay');
  ov.hidden = false;
  document.body.classList.add('noscroll');
  let errEl = null;
  let saving = false;

  const accounts = data.accounts.filter(L.isActive);
  const money = accounts.filter(L.isMoneyAccount);
  const close = () => { ov.hidden = true; ov.replaceChildren(); document.body.classList.remove('noscroll'); };

  const mkOpt = (sel) => (a) => h('option', { value: a.account_id, selected: String(a.account_id) === String(sel) }, L.accLabel(a));
  const blank = () => h('option', { value: '' }, 'Select… (선택)');
  const moneyOptions = (sel) => [blank(),
    h('optgroup', { label: 'Assets (자산)' }, money.filter((a) => a.type === 'ASSET').map(mkOpt(sel))),
    h('optgroup', { label: 'Credit & loans (카드 · 대출)' }, money.filter((a) => a.type === 'LIABILITY').map(mkOpt(sel)))];
  const catOptions = (type, sel) => {
    const groups = new Map();
    accounts.filter((a) => a.type === type).forEach((a) => {
      const g = a.report_group || (type === 'INCOME' ? '수입' : '확인 필요');
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(a);
    });
    const order = type === 'INCOME' ? ['수입'] : L.GROUP_ORDER;
    const keys = order.filter((g) => groups.has(g)).concat(Array.from(groups.keys()).filter((g) => order.indexOf(g) < 0));
    return [blank()].concat(keys.map((g) => h('optgroup', { label: L.GROUP_LABELS[g] || g }, groups.get(g).map(mkOpt(sel)))));
  };

  const autoOwner = (accId) => {
    if (f.ownerTouched) return;
    const a = d.accMap.get(String(accId));
    if (a && (a.owner === 'Patrick' || a.owner === 'Ms Kim')) f.owner = a.owner;
  };

  function field(label, control, hint) {
    return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), control, hint || null);
  }

  function build() {
    const isFx = f.currency !== 'CAD';
    const dec = L.decimals(f.currency);
    const previewEl = h('div', { class: 'hint', id: 'amt-preview' });
    const fxEl = h('div', { class: 'hint', id: 'fx-hint' });

    const updateHints = () => {
      const n = L.parseAmount(f.amountText);
      const isExpr = /[^0-9.,\s$]/.test(f.amountText || '');
      previewEl.textContent = isExpr && Number.isFinite(n) ? '= ' + fmt(L.round(n, dec), f.currency) : '';
      if (!isFx) { fxEl.textContent = ''; return; }
      const cad = L.parseAmount(f.cadText);
      const rate = L.parseAmount(f.rateText);
      if (cad > 0 && n > 0) fxEl.textContent = 'Effective rate (적용 환율): ' + L.round(cad / n, 6) + ' CAD per ' + f.currency;
      else if (rate > 0 && n > 0) fxEl.textContent = '≈ ' + fmt(L.round(n * rate, 2)) + ' — provisional until the CAD charge is known (카드 청구액을 알면 정확한 값으로 바꾸세요)';
      else fxEl.textContent = 'Enter the CAD charged or an FX rate (CAD 청구액 또는 환율 입력)';
    };

    const amountInput = h('input', {
      type: 'text', id: 'f-amount', placeholder: '0.00  (10*1.1 가능)', value: f.amountText, autocomplete: 'off', inputmode: 'decimal',
      oninput: (e) => { f.amountText = e.target.value; updateHints(); },
      onblur: (e) => {
        const n = L.parseAmount(f.amountText);
        if (Number.isFinite(n) && n > 0) { f.amountText = String(L.round(n, dec)); e.target.value = L.fmtNumber(L.round(n, dec), f.currency); }
        updateHints();
      }
    });
    const opBtn = (label, ch) => h('button', {
      type: 'button', class: 'op',
      onclick: () => { f.amountText = (f.amountText || '') + ch; amountInput.value = f.amountText; updateHints(); amountInput.focus(); }
    }, label);

    const rows = [];

    // 종류
    rows.push(h('div', { class: 'seg', role: 'tablist' }, KIND_LABELS.map((k) => h('button', {
      type: 'button', class: f.kind === k[0] ? 'on' : '',
      onclick: () => {
        f.kind = k[0]; f.categoryId = ''; f.categoryTouched = false;
        if (k[0] !== 'EXPENSE' && k[0] !== 'INCOME') f.passthrough = false;
        draw();
      }
    }, k[1]))));

    rows.push(field('Date (날짜)', h('input', { type: 'date', id: 'f-date', value: f.date, onchange: (e) => { f.date = e.target.value; } })));

    rows.push(field(f.kind === 'OPENING' ? 'Balance (잔액: 보유액 또는 갚을 금액)' : 'Amount (금액)',
      h('div', { class: 'amtrow' },
        amountInput,
        h('select', {
          id: 'f-ccy', class: 'ccy', 'aria-label': 'Currency (통화)',
          onchange: (e) => {
            f.currency = e.target.value;
            if (f.currency !== 'CAD' && !f.rateText) { const r = L.latestRate(data.fxRates, f.currency); if (r) f.rateText = String(r); }
            draw();
          }
        }, CONFIG.CURRENCIES.map((c) => h('option', { value: c, selected: c === f.currency }, c)))),
      h('div', null, h('div', { class: 'ops' }, opBtn('+', '+'), opBtn('−', '-'), opBtn('×', '*'), opBtn('÷', '/'), opBtn('(', '('), opBtn(')', ')')), previewEl)));

    if (isFx) {
      rows.push(h('div', { class: 'two' },
        field('CAD charged (CAD 청구액)', h('input', {
          type: 'text', id: 'f-cad', inputmode: 'decimal', placeholder: 'e.g. 138.50', value: f.cadText, autocomplete: 'off',
          oninput: (e) => { f.cadText = e.target.value; updateHints(); }
        })),
        field('FX rate (환율)', h('input', {
          type: 'text', id: 'f-rate', inputmode: 'decimal', placeholder: 'CAD per 1 ' + f.currency, value: f.rateText, autocomplete: 'off',
          oninput: (e) => { f.rateText = e.target.value; updateHints(); }
        }))));
      rows.push(fxEl);
    }

    if (f.kind === 'EXPENSE') {
      rows.push(field('Paid from (결제 계좌)', h('select', {
        id: 'f-from', onchange: (e) => { f.fromId = e.target.value; autoOwner(f.fromId); draw(); }
      }, moneyOptions(f.fromId))));
    } else if (f.kind === 'INCOME') {
      rows.push(field('Deposited to (입금 계좌)', h('select', {
        id: 'f-to', onchange: (e) => { f.toId = e.target.value; autoOwner(f.toId); draw(); }
      }, moneyOptions(f.toId))));
    } else if (f.kind === 'TRANSFER') {
      rows.push(field('From (보내는 계좌)', h('select', { id: 'f-from', onchange: (e) => { f.fromId = e.target.value; } }, moneyOptions(f.fromId))));
      rows.push(field('To (받는 계좌 · 카드 대금은 카드 선택)', h('select', { id: 'f-to', onchange: (e) => { f.toId = e.target.value; } }, moneyOptions(f.toId))));
    } else {
      rows.push(field('Account (계좌)', h('select', {
        id: 'f-acct', onchange: (e) => { f.accountId = e.target.value; autoOwner(f.accountId); draw(); }
      }, moneyOptions(f.accountId))));
    }

    if (f.kind === 'EXPENSE' || f.kind === 'INCOME') {
      rows.push(field('Merchant / Payer (가맹점 · 출처)', h('input', {
        type: 'text', id: 'f-merchant', value: f.merchant, list: 'merchants', autocomplete: 'off',
        oninput: (e) => { f.merchant = e.target.value; },
        onchange: (e) => {
          f.merchant = e.target.value;
          const r = L.suggestRule(data.rules, f.merchant);
          if (!r || f.categoryTouched || f.passthrough) return;
          const a = d.accMap.get(String(r.account_id));
          if (a && ((f.kind === 'EXPENSE' && a.type === 'EXPENSE') || (f.kind === 'INCOME' && a.type === 'INCOME'))) { f.categoryId = String(r.account_id); draw(); }
        }
      })));
      rows.push(h('label', { class: 'check' },
        h('input', { type: 'checkbox', id: 'f-pass', checked: f.passthrough, onchange: (e) => { f.passthrough = e.target.checked; draw(); } }),
        h('span', null, 'Passthrough (전달 자금 · 손익에서 제외)')));
      if (!f.passthrough) {
        rows.push(field(f.kind === 'EXPENSE' ? 'Category (카테고리)' : 'Income type (수입 항목)', h('select', {
          id: 'f-cat', onchange: (e) => { f.categoryId = e.target.value; f.categoryTouched = true; }
        }, catOptions(f.kind === 'EXPENSE' ? 'EXPENSE' : 'INCOME', f.categoryId))));
      }
    }

    rows.push(field('Memo (메모)', h('input', { type: 'text', id: 'f-memo', value: f.memo, autocomplete: 'off', oninput: (e) => { f.memo = e.target.value; } })));
    rows.push(field('Owner (소유자)', h('select', {
      id: 'f-owner', onchange: (e) => { f.owner = e.target.value; f.ownerTouched = true; }
    }, CONFIG.OWNERS.map((o) => h('option', { value: o, selected: o === f.owner }, o)))));
    rows.push(h('details', { class: 'more' },
      h('summary', null, 'More (더 보기)'),
      field('Trip tag (여행 태그)', h('input', { type: 'text', id: 'f-trip', value: f.tripTag, placeholder: 'e.g. Japan 2026', oninput: (e) => { f.tripTag = e.target.value; } }))));

    errEl = h('div', { class: 'err', id: 'f-err', role: 'alert' });
    rows.push(errEl);

    const saveBtn = h('button', { type: 'button', class: 'btn', id: 'f-save', onclick: onSave }, 'Save (저장)');
    rows.push(h('div', { class: 'btnrow' },
      saveBtn,
      h('button', { type: 'button', class: 'btn secondary', onclick: close }, 'Cancel (취소)'),
      existing ? h('button', {
        type: 'button', class: 'btn danger', id: 'f-del',
        onclick: async () => {
          if (!window.confirm('Delete this transaction? (이 거래를 삭제할까요?)')) return;
          await sync.deleteTxn(existing.txn.txn_id);
          close(); toast('Deleted (삭제됨)');
        }
      }, 'Delete (삭제)') : null));

    const merchants = Array.from(new Set(d.items.map((i) => i.txn.merchant).filter(Boolean))).slice(0, 150);
    updateHints();
    return h('div', { class: 'backdrop' },
      h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Transaction form' },
        h('div', { class: 'sheet-head' },
          h('h2', null, existing ? 'Edit transaction (거래 수정)' : 'New transaction (새 거래)'),
          h('button', { type: 'button', class: 'icon', 'aria-label': 'Close (닫기)', onclick: close }, '✕')),
        h('datalist', { id: 'merchants' }, merchants.map((m) => h('option', { value: m }))),
        rows));
  }

  async function onSave() {
    if (saving) return;
    const res = L.makeRecords(f, { accMap: d.accMap, rules: data.rules, existing, now: L.nowIso() });
    if (res.error) { errEl.textContent = res.error; return; }
    saving = true;
    $('f-save').disabled = true;
    try {
      await sync.saveRecords(res);
      if (f.kind === 'EXPENSE' && f.fromId) { try { localStorage.setItem('hl_last_from', f.fromId); } catch (e) { /* ignore */ } }
      if (res.txn.date && L.monthOf(res.txn.date) !== state.month && !state.query) state.month = L.monthOf(res.txn.date);
      close();
      toast(auth.getToken() ? 'Saved (저장됨)' : 'Saved offline — will upload after sign-in (오프라인 저장, 로그인 후 전송)');
      await reload();
      renderBody(true);
    } catch (e) {
      saving = false;
      $('f-save').disabled = false;
      errEl.textContent = '저장하지 못했습니다: ' + (e.message || e);
    }
  }

  function draw() { ov.replaceChildren(build()); }
  draw();
  if (!existing) { const a = $('f-amount'); if (a) a.focus(); }
}
