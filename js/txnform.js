// 거래 입력 / 수정 창 (v0.13)
//   · 위: 제목 + 거래 종류 (지출 · 수입 · 이체 · 기초잔액)
//   · 가운데(스크롤): 큰 금액 칸(계산식 가능) · 외화 · 날짜/계좌/가맹점 · 카테고리(또는 거래 나누기) · 소유자 · 메모
//   · 아래(고정): 삭제 · 취소 · 저장
//   폰 = 아래에서 올라오는 시트, 아이패드/컴퓨터 = 가운데 창. iPhone 키보드가 올라와도 아래 버튼이 가려지지 않게
//   visualViewport 높이에 맞춥니다.
//
// 거래 나누기(split): 한 거래의 총액을 여러 줄(카테고리 · 소유자 · 메모)로 나눕니다. 줄 금액의 합계 = 총액 (센트까지).
//   분개: 돈이 나간 계좌 = −총액, 카테고리 줄 = +줄 금액 (환불·수입은 반대 부호). 줄 소유자는 Postings.owner 에 저장.
import { CONFIG } from './config.js';
import * as L from './ledger.js';
import * as sync from './sync.js';
import * as auth from './auth.js';
import * as fx from './fx.js';
import { icon } from './icons.js';
import { openRemember } from './rememberui.js';
import { lang } from './prefs.js';

// 소유자 버튼 글자: 둘 다 보기면 한글(굵게) + 영어(작게), 아니면 고른 언어 하나
const ownerKids = (o) => (lang() === 'both' && L.OWNER_KO[o] ? [(() => { const b = document.createElement('b'); b.textContent = L.OWNER_KO[o]; return b; })(), (() => { const s = document.createElement('small'); s.textContent = o; return s; })()] : L.ownerLabel(o));

const KIND_LABELS = [['EXPENSE', 'Expense (지출)'], ['INCOME', 'Income (수입)'], ['TRANSFER', 'Transfer (이체)'], ['OPENING', 'Opening (기초잔액)']];
const $ = (id) => document.getElementById(id);

let active = null; // 열려 있는 창의 정리 함수

/** 열려 있는 거래 창을 닫습니다 (없으면 아무 일도 안 함) */
export function closeForm() { if (active) active(); }

/**
 * api: { h, fmt, toast, state, reload, renderBody, defaultOwner?: string, openScan?: fn }
 * txnId: 수정할 거래 id (없으면 새 거래), defaults: { kind, fromId, toId, date, categoryId }
 */
export function openForm(api, txnId, defaults) {
  if (active) active(true);
  const { h, fmt, toast, state } = api;
  const d = state.d;
  const data = state.data;
  const existing = txnId ? d.itemById.get(String(txnId)) : null;
  let f;
  if (existing) f = L.formFromTxn(existing.txn, existing.ps, d.accMap);
  else {
    f = L.newForm();
    try { f.fromId = localStorage.getItem('hl_last_from') || ''; } catch (e) { /* ignore */ }
    if (!d.accMap.has(String(f.fromId))) f.fromId = '';
    if (api.defaultOwner) f.owner = api.defaultOwner;
    const df = defaults || {};
    if (df.kind) f.kind = df.kind;
    if (df.fromId) f.fromId = String(df.fromId);
    if (df.toId) f.toId = String(df.toId);
    if (df.date) f.date = df.date;
    if (df.categoryId) { f.categoryId = String(df.categoryId); f.categoryTouched = true; }
  }
  f.autoLine = -1; // 나누기에서 "자동으로 나머지를 받는 줄" (처음 나눌 때 첫 줄)

  const ov = $('overlay');
  const opener = document.activeElement;
  ov.hidden = false;
  document.body.classList.add('noscroll');
  let saving = false;
  let errText = '';
  let closed = false;

  const accounts = data.accounts.filter(L.isActive);
  const money = accounts.filter(L.isMoneyAccount);
  const merchants = Array.from(new Set(d.items.map((i) => i.txn.merchant).filter(Boolean))).slice(0, 150);

  // ── 바깥 틀 (한 번만 만들고, 안쪽만 다시 그립니다 → 애니메이션·스크롤이 튀지 않음)
  const head = h('div', { class: 'txf-head' });
  const body = h('div', { class: 'txf-body' });
  const foot = h('div', { class: 'txf-foot' });
  const sheet = h('div', { class: 'sheet txf', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'txf-title' },
    head, body, foot, h('datalist', { id: 'merchants' }, merchants.map((m) => h('option', { value: m }))));
  const bd = h('div', { class: 'backdrop txf-bd' }, sheet);
  bd.addEventListener('mousedown', (e) => { if (e.target === bd) bd._downOnScrim = true; });
  bd.addEventListener('click', (e) => { if (e.target === bd && bd._downOnScrim) close(); bd._downOnScrim = false; });
  ov.replaceChildren(bd);

  // ── iPhone 키보드: 보이는 영역(visualViewport) 높이에 맞춰 창을 줄입니다
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  const fit = () => {
    if (!vv) return;
    bd.style.setProperty('--txf-vh', Math.round(vv.height) + 'px');
    bd.style.top = Math.round(vv.offsetTop) + 'px';
    bd.style.height = Math.round(vv.height) + 'px';
    bd.style.bottom = 'auto';
  };
  if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit(); }
  const onFocusIn = (e) => {
    const el = e.target;
    if (!body.contains(el) || !el.matches('input, select, textarea')) return;
    setTimeout(() => {
      if (closed || !el.isConnected) return;
      const r = el.getBoundingClientRect(), b = body.getBoundingClientRect();
      if (r.top < b.top + 8 || r.bottom > b.bottom - 8) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 260);
  };
  sheet.addEventListener('focusin', onFocusIn);

  // ── 키보드: Esc 닫기 · Ctrl/⌘+Enter 또는 Ctrl/⌘+S 저장 · Tab 은 창 안에서만 돎
  const onKey = (e) => {
    if (closed || ov.hidden || !ov.contains(sheet)) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.key === 's' || e.key === 'S')) { e.preventDefault(); onSave(); return; }
    if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && /^(text|date|search)$/.test(e.target.type) && !e.target.getAttribute('list')) {
      // 컴퓨터(마우스·키보드)에서는 Enter = 저장. 터치 기기에서는 키보드만 내립니다 (iPhone '완료' 키로 실수 저장 방지)
      e.preventDefault();
      const fine = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: fine)').matches;
      e.target.blur();
      if (fine) onSave();
      return;
    }
    if (e.key === 'Tab') {
      const items = Array.from(sheet.querySelectorAll('button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea, a[href], summary'))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey);

  function close(instant) {
    if (closed) return;
    closed = true;
    active = null;
    document.removeEventListener('keydown', onKey);
    if (vv) { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); }
    const mine = ov.contains(bd);
    if (!mine) return; // 다른 창이 이미 overlay 를 쓰고 있으면 건드리지 않음
    ov.hidden = true;
    ov.replaceChildren();
    document.body.classList.remove('noscroll');
    // 닫힘 애니메이션: 창을 잠깐 body 로 옮겨 내려가며 사라지게 (상태는 이미 닫힘)
    const reduce = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!instant && !reduce && typeof window !== 'undefined' && !window.__HL_NO_ANIM__ && !globalThis.__HL_TEST__) {
      bd.classList.add('txf-out');
      bd.setAttribute('aria-hidden', 'true');
      bd.inert = true;
      document.body.append(bd);
      setTimeout(() => bd.remove(), 240);
    }
    if (opener && opener.isConnected && opener.focus) { try { opener.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }
  active = close;

  // ── 선택 목록
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
    // 이미 저장된 줄의 카테고리가 숨김(비활성) 계정이어도 보이게
    if (sel && !accounts.some((a) => String(a.account_id) === String(sel)) && d.accMap.has(String(sel))) {
      const a = d.accMap.get(String(sel));
      if (a.type === type) { if (!groups.has('확인 필요')) groups.set('확인 필요', []); groups.get('확인 필요').push(a); }
    }
    const order = type === 'INCOME' ? ['수입'] : L.GROUP_ORDER;
    const keys = order.filter((g) => groups.has(g)).concat(Array.from(groups.keys()).filter((g) => order.indexOf(g) < 0));
    return [blank()].concat(keys.map((g) => h('optgroup', { label: L.GROUP_LABELS[g] || g }, groups.get(g).map(mkOpt(sel)))));
  };

  const autoOwner = (accId) => {
    if (f.ownerTouched) return;
    const a = d.accMap.get(String(accId));
    // 소유자는 기본 Joint (계좌 소유자로 바꾸지 않음)
  };

  // ── 작은 부품
  const lbl = (text, ic) => h('span', { class: 'lbl' }, ic ? icon(ic, 15) : null, text);
  const field = (label, control, opts) => h('label', { class: 'field txf-f' + (opts && opts.wide ? ' wide' : '') }, lbl(label, opts && opts.icon), control, (opts && opts.hint) || null);
  const group = (title, kids, opts) => h('section', { class: 'txf-group' + (opts && opts.cls ? ' ' + opts.cls : ''), 'aria-label': title },
    h('div', { class: 'txf-gh' }, h('h3', null, title), (opts && opts.action) || null),
    h('div', { class: 'txf-grid' }, kids));
  const toggle = (id, label, checked, onchange, sub) => h('label', { class: 'txf-switch' },
    h('input', { type: 'checkbox', id, role: 'switch', checked, onchange }),
    h('span', { class: 'txf-switch-ui', 'aria-hidden': 'true' }),
    h('span', { class: 'txf-switch-t' }, label, sub ? h('small', null, sub) : null));

  const isCatKind = () => f.kind === 'EXPENSE' || f.kind === 'INCOME';
  const canSplit = () => isCatKind() && !f.passthrough;
  const splitOn = () => canSplit() && f.split;

  // 나누기 상태 (자동 줄 계산 포함)
  function applyAuto() {
    if (!splitOn() || f.autoLine < 0 || !f.lines[f.autoLine]) return;
    const dec = L.decimals(f.currency);
    const total = L.round(L.parseAmount(f.amountText), dec);
    if (!Number.isFinite(total)) return;
    const others = f.lines.reduce((s, l, i) => {
      if (i === f.autoLine) return s;
      const n = L.parseAmount(l.amountText);
      return s + (Number.isFinite(n) ? L.round(n, dec) : 0);
    }, 0);
    const rest = L.round(total - others, dec);
    f.lines[f.autoLine].amountText = rest > 0 ? String(rest) : '';
  }

  function splitStatus() {
    const bal = L.splitBalance(f);
    const ccy = f.currency;
    if (!(bal.total > 0)) return { ok: false, tone: 'warn', text: 'Enter the total amount first (먼저 총액을 입력하세요)', bal };
    if (bal.remaining > 0) return { ok: false, tone: 'warn', text: fmt(bal.remaining, ccy) + ' left to assign (남은 금액 ' + fmt(bal.remaining, ccy) + ')', bal };
    if (bal.remaining < 0) return { ok: false, tone: 'bad', text: 'Over by ' + fmt(-bal.remaining, ccy) + ' (초과 ' + fmt(-bal.remaining, ccy) + ')', bal };
    if (bal.blank >= 0) return { ok: false, tone: 'warn', text: 'Line ' + (bal.blank + 1) + ' needs an amount (' + (bal.blank + 1) + '번째 줄 금액 필요)', bal };
    return { ok: true, tone: 'ok', text: 'Balanced — lines add up to the total (합계가 총액과 맞습니다)', bal };
  }

  // 줄별 CAD 미리보기 (외화일 때)
  function lineCads() {
    if (f.currency === 'CAD') return null;
    const dec = L.decimals(f.currency);
    const total = L.round(L.parseAmount(f.amountText), dec);
    const cadIn = L.parseAmount(f.cadText), rateIn = L.parseAmount(f.rateText);
    const cad = cadIn > 0 ? L.round(cadIn, 2) : rateIn > 0 && total > 0 ? L.round(total * rateIn, 2) : NaN;
    if (!(total > 0) || !(cad > 0)) return null;
    const bal = L.splitBalance(f);
    if (bal.remaining !== 0) return bal.amounts.map((a) => (Number.isFinite(a) ? L.round(a * cad / total, 2) : NaN));
    return L.allocateCad(bal.amounts.map((a) => (Number.isFinite(a) ? a : 0)), total, cad);
  }

  // ── 그리기
  function build() {
    const isFx = f.currency !== 'CAD';
    const dec = L.decimals(f.currency);
    const previewEl = h('div', { class: 'hint txf-preview', id: 'amt-preview', 'aria-live': 'polite' });
    const fxEl = h('div', { class: 'hint', id: 'fx-hint', 'aria-live': 'polite' });

    const updateHints = () => {
      const n = L.parseAmount(f.amountText);
      const isExpr = /[^0-9.,\s$]/.test(f.amountText || '');
      previewEl.textContent = isExpr && Number.isFinite(n) ? '= ' + fmt(L.round(n, dec), f.currency) : '';
      if (isFx) {
        const cad = L.parseAmount(f.cadText);
        const rate = L.parseAmount(f.rateText);
        if (cad > 0 && n > 0) fxEl.textContent = 'Effective rate (적용 환율): ' + L.round(cad / n, 6) + ' CAD per ' + f.currency;
        else if (rate > 0 && n > 0) fxEl.textContent = '≈ ' + fmt(L.round(n * rate, 2)) + ' — provisional until the CAD charge is known (카드 청구액을 알면 정확한 값으로 바꾸세요)';
        else fxEl.textContent = 'Enter the CAD charged or an FX rate (CAD 청구액 또는 환율 입력)';
      } else fxEl.textContent = '';
      if (splitOn()) { applyAuto(); refreshSplit(); }
    };

    // ── 머리: 제목 + 닫기 + 종류
    const sub = existing
      ? [L.dayLabel(existing.txn.date), existing.txn.merchant || existing.desc.categoryName].filter(Boolean).join(' · ')
      : '';
    const kinds = h('div', { class: 'seg txf-kinds', role: 'radiogroup', 'aria-label': 'Type (거래 종류)' }, KIND_LABELS.map((k) => h('button', {
      type: 'button', class: f.kind === k[0] ? 'on' : '', role: 'radio', 'aria-checked': f.kind === k[0] ? 'true' : 'false', 'data-kind': k[0],
      onclick: () => {
        if (f.kind === k[0]) return;
        f.kind = k[0]; f.categoryId = ''; f.categoryTouched = false; f.refund = false; f.split = false; f.lines = []; f.autoLine = -1;
        if (k[0] !== 'EXPENSE' && k[0] !== 'INCOME') f.passthrough = false;
        draw();
      }
    }, k[1])));
    const headKids = [
      h('div', { class: 'txf-grip', 'aria-hidden': 'true' }),
      h('div', { class: 'txf-titlerow' },
        h('div', { class: 'txf-tt' },
          h('h2', { id: 'txf-title' }, existing ? 'Edit transaction (거래 수정)' : 'New transaction (새 거래)'),
          sub ? h('div', { class: 'txf-sub' }, sub) : null),
        !existing && api.openScan ? h('button', {
          type: 'button', class: 'txf-scan', id: 'f-scan', 'aria-label': 'Scan a receipt instead (영수증 스캔으로 입력)',
          onclick: () => { close(true); api.openScan(); }
        }, icon('scan', 18), h('span', null, 'Scan (스캔)')) : null,
        h('button', { type: 'button', class: 'icon txf-x', 'aria-label': 'Close (닫기)', onclick: () => close() }, icon('close', 22))),
      kinds];

    // ── 금액 (큰 칸)
    const amountInput = h('input', {
      type: 'text', id: 'f-amount', class: 'txf-amt-in', placeholder: '0.00', value: niceAmt(f.amountText, f.currency, 'f-amount'), autocomplete: 'off', inputmode: 'decimal',
      enterkeyhint: 'done', 'aria-label': f.kind === 'OPENING' ? 'Balance (잔액)' : 'Amount (금액)',
      oninput: (e) => { f.amountText = e.target.value; updateHints(); },
      onblur: (e) => {
        const n = L.parseAmount(f.amountText);
        if (Number.isFinite(n) && n > 0) { f.amountText = String(L.round(n, dec)); e.target.value = L.fmtNumber(L.round(n, dec), f.currency); }
        updateHints();
      }
    });
    const opBtn = (label, ch, aria) => h('button', {
      type: 'button', class: 'op', 'aria-label': aria,
      onmousedown: (e) => e.preventDefault(),
      onclick: () => { f.amountText = (f.amountText || '') + ch; amountInput.value = f.amountText; updateHints(); amountInput.focus(); }
    }, label);
    const ccySel = h('select', {
      id: 'f-ccy', class: 'ccy txf-ccy', 'aria-label': 'Currency (통화)',
      onchange: (e) => {
        f.currency = e.target.value;
        if (f.currency !== 'CAD' && !f.rateText) { const r = fx.rateOn(data.fxRates, f.currency, f.date) || L.latestRate(data.fxRates, f.currency); if (r) f.rateText = String(r); }
        draw();
      }
    }, CONFIG.CURRENCIES.map((c) => h('option', { value: c, selected: c === f.currency }, c)));
    const tone = f.kind === 'INCOME' || (f.kind === 'EXPENSE' && f.refund) ? 'in' : f.kind === 'EXPENSE' ? 'out' : 'move';
    const hero = h('div', { class: 'txf-hero ' + tone },
      h('div', { class: 'txf-hero-top' },
        h('span', { class: 'lbl' }, f.kind === 'OPENING' ? 'Balance (잔액: 보유액 또는 갚을 금액)' : f.kind === 'EXPENSE' && f.refund ? 'Refund amount (환불 금액)' : 'Amount (금액)'),
        ccySel),
      h('div', { class: 'txf-amt amtrow' }, h('span', { class: 'txf-sym', 'aria-hidden': 'true' }, symOf(f.currency)), amountInput),
      h('div', { class: 'ops txf-ops', role: 'group', 'aria-label': 'Calculator (계산기)' },
        opBtn('+', '+', 'Plus (더하기)'), opBtn('−', '-', 'Minus (빼기)'), opBtn('×', '*', 'Times (곱하기)'), opBtn('÷', '/', 'Divide (나누기)'), opBtn('(', '(', 'Open bracket (여는 괄호)'), opBtn(')', ')', 'Close bracket (닫는 괄호)')),
      previewEl);

    const parts = [hero];

    if (isFx) {
      parts.push(h('section', { class: 'txf-group txf-fx', 'aria-label': 'Foreign currency (외화)' },
        h('div', { class: 'txf-gh' }, h('h3', null, 'Foreign currency (외화)'), h('span', { class: 'txf-ccytag' }, f.currency + ' → CAD')),
        h('div', { class: 'txf-grid' },
          field('CAD charged (CAD 청구액)', h('input', {
            type: 'text', id: 'f-cad', inputmode: 'decimal', placeholder: 'e.g. 138.50', value: f.cadText, autocomplete: 'off',
            oninput: (e) => { f.cadText = e.target.value; updateHints(); }
          })),
          field('FX rate (환율)', h('input', {
            type: 'text', id: 'f-rate', inputmode: 'decimal', placeholder: 'CAD per 1 ' + f.currency, value: f.rateText, autocomplete: 'off',
            oninput: (e) => { f.rateText = e.target.value; updateHints(); }
          }))),
        fxEl));
    }

    // ── 세부 정보: 날짜 · 계좌 · 가맹점
    const det = [field('Date (날짜)', h('input', { type: 'date', id: 'f-date', value: f.date, onchange: (e) => { f.date = e.target.value; } }), { icon: 'calendar' })];
    if (f.kind === 'EXPENSE') {
      det.push(field(f.refund ? 'Refunded to (환불 받은 계좌)' : 'Paid from (결제 계좌)', h('select', {
        id: 'f-from', onchange: (e) => { f.fromId = e.target.value; autoOwner(f.fromId); draw(); }
      }, moneyOptions(f.fromId)), { icon: 'accounts' }));
    } else if (f.kind === 'INCOME') {
      det.push(field('Deposited to (입금 계좌)', h('select', {
        id: 'f-to', onchange: (e) => { f.toId = e.target.value; autoOwner(f.toId); draw(); }
      }, moneyOptions(f.toId)), { icon: 'accounts' }));
    } else if (f.kind === 'TRANSFER') {
      det.push(field('From (보내는 계좌)', h('select', { id: 'f-from', onchange: (e) => { f.fromId = e.target.value; } }, moneyOptions(f.fromId)), { icon: 'accounts' }));
      det.push(field('To (받는 계좌 · 카드 대금은 카드 선택)', h('select', { id: 'f-to', onchange: (e) => { f.toId = e.target.value; } }, moneyOptions(f.toId)), { icon: 'transfer', wide: true }));
    } else {
      det.push(field('Account (계좌)', h('select', {
        id: 'f-acct', onchange: (e) => { f.accountId = e.target.value; autoOwner(f.accountId); draw(); }
      }, moneyOptions(f.accountId)), { icon: 'accounts' }));
    }
    if (isCatKind()) {
      det.push(field(f.kind === 'EXPENSE' ? 'Merchant (가맹점)' : 'Payer (출처)', h('input', {
        type: 'text', id: 'f-merchant', value: f.merchant, list: 'merchants', autocomplete: 'off', enterkeyhint: 'next',
        placeholder: f.kind === 'EXPENSE' ? 'e.g. Costco' : 'e.g. Employer (회사)',
        oninput: (e) => { f.merchant = e.target.value; },
        onchange: (e) => {
          f.merchant = e.target.value;
          const r = L.suggestRule(data.rules, f.merchant);
          if (!r || f.categoryTouched || f.passthrough || f.split) return;
          const a = d.accMap.get(String(r.account_id));
          if (a && ((f.kind === 'EXPENSE' && a.type === 'EXPENSE') || (f.kind === 'INCOME' && a.type === 'INCOME'))) { f.categoryId = String(r.account_id); draw(); }
        }
      }), { icon: 'store', wide: true }));
    }
    parts.push(group('Details (세부 정보)', det));

    // ── 카테고리 / 나누기
    if (isCatKind()) {
      const catType = f.kind === 'EXPENSE' ? 'EXPENSE' : 'INCOME';
      let content;
      let action = null;
      if (f.passthrough) {
        content = [h('div', { class: 'txf-note wide' }, icon('info', 16), 'Passthrough money is kept out of income & spending (전달 자금은 손익에서 빠집니다)')];
      } else if (splitOn()) {
        action = h('button', { type: 'button', class: 'txf-link', id: 'f-split', 'aria-pressed': 'true', onclick: unsplit }, icon('close', 16), 'Undo split (나누기 취소)');
        content = [splitEditor(catType)];
      } else {
        action = h('button', { type: 'button', class: 'txf-link', id: 'f-split', 'aria-pressed': 'false', onclick: startSplit }, icon('split', 16), 'Split (거래 나누기)');
        content = [h('div', { class: 'field txf-f wide' }, h('select', {
          id: 'f-cat', 'aria-label': f.kind === 'EXPENSE' ? 'Category (카테고리)' : 'Income type (수입 항목)',
          onchange: (e) => { f.categoryId = e.target.value; f.categoryTouched = true; }
        }, catOptions(catType, f.categoryId)))];
      }
      parts.push(group(splitOn() ? 'Split lines (나눈 줄)' : f.kind === 'EXPENSE' ? 'Category (카테고리)' : 'Income type (수입 항목)', content, { action, cls: 'txf-catgrp' + (splitOn() ? ' txf-splitgrp' : '') }));
    }

    // ── 소유자 · 옵션
    const ownerSeg = h('div', { class: 'txf-own', role: 'radiogroup', 'aria-label': 'Owner (소유자)' }, CONFIG.OWNERS.map((o) => h('button', {
      type: 'button', role: 'radio', class: f.owner === o ? 'on' : '', 'aria-checked': f.owner === o ? 'true' : 'false', 'data-owner': o,
      onclick: () => {
        const was = f.owner;
        f.owner = o; f.ownerTouched = true;
        // 나눈 줄 중 원래 소유자를 그대로 따르던 줄은 같이 바꿈
        if (splitOn()) f.lines.forEach((l) => { if (l.owner === was) l.owner = o; });
        draw();
      }
    }, ownerKids(o))));
    const ownKids = [h('div', { class: 'field txf-f wide' }, lbl(splitOn() ? 'Owner — new lines use this (소유자 · 새 줄 기본값)' : 'Owner (소유자)', 'people'), ownerSeg,
      h('input', { type: 'hidden', id: 'f-owner', value: f.owner }))];
    if (isCatKind()) {
      if (f.kind === 'EXPENSE') {
        ownKids.push(toggle('f-refund', 'Refund — money came back (환불: 돈이 돌아옴)', f.refund, (e) => { f.refund = e.target.checked; draw(); }));
      }
      ownKids.push(toggle('f-pass', 'Passthrough (전달 자금 · 손익에서 제외)', f.passthrough, (e) => {
        if (e.target.checked && splitOn() && !window.confirm('Passthrough cannot be split. Remove the split lines? (전달 자금은 나눌 수 없습니다. 나눈 줄을 없앨까요?)')) { e.target.checked = false; return; }
        f.passthrough = e.target.checked;
        if (f.passthrough) { f.split = false; f.lines = []; }
        draw();
      }, 'e.g. paying for someone who pays you back (대신 내고 돌려받는 돈)'));
    }
    parts.push(group('Owner & options (소유자 · 옵션)', ownKids));

    // ── 메모
    const noteKids = [
      field('Memo (메모)', h('input', { type: 'text', id: 'f-memo', value: f.memo, autocomplete: 'off', enterkeyhint: 'done', placeholder: 'Optional (선택)', oninput: (e) => { f.memo = e.target.value; } }), { icon: 'memo' }),
      field('Trip tag (여행 태그)', h('input', { type: 'text', id: 'f-trip', value: f.tripTag, autocomplete: 'off', enterkeyhint: 'done', placeholder: 'e.g. Japan 2026', oninput: (e) => { f.tripTag = e.target.value; } }), { icon: 'tag' })];
    const rc = existing ? receiptOf(existing.txn) : null;
    if (rc) {
      noteKids.push(h('a', { class: 'txf-receipt wide', id: 'f-receipt', href: 'https://drive.google.com/file/d/' + encodeURIComponent(rc.drive_file_id) + '/view', target: '_blank', rel: 'noopener' },
        icon('camera', 18), h('span', null, 'View receipt (영수증 보기)'), rc.file_name ? h('span', { class: 'txf-fn' }, rc.file_name) : null, icon('open', 16)));
    }
    parts.push(group('Notes (메모)', noteKids, { cls: 'txf-notes' }));

    parts.push(h('div', { class: 'err', id: 'f-err', role: 'alert' }, errText));

    // ── 아래 고정 버튼
    const st = splitOn() ? splitStatus() : null;
    const saveBtn = h('button', { type: 'button', class: 'btn', id: 'f-save', onclick: onSave, disabled: !!(st && !st.ok) || saving },
      icon('check', 18), saving ? 'Saving… (저장 중)' : 'Save (저장)');
    const footKids = [
      st ? h('div', { class: 'txf-footmsg ' + st.tone, id: 'f-split-msg', role: 'status', 'aria-live': 'polite', hidden: st.ok }, st.ok ? icon('check', 16) : icon('alert', 16), h('span', null, st.text)) : null,
      h('div', { class: 'txf-btns' },
        existing ? h('button', {
          type: 'button', class: 'btn danger txf-del', id: 'f-del', 'aria-label': 'Delete (삭제)',
          onclick: async () => {
            if (!window.confirm('Delete this transaction? (이 거래를 삭제할까요?)')) return;
            await sync.deleteTxn(existing.txn.txn_id);
            close(); toast('Deleted (삭제됨)');
          }
        }, icon('trash', 18), h('span', { class: 'txf-del-t' }, 'Delete (삭제)')) : null,
        h('span', { class: 'txf-sp' }),
        h('button', { type: 'button', class: 'btn secondary', id: 'f-cancel', onclick: () => close() }, 'Cancel (취소)'),
        saveBtn)];

    updateHints();
    // 컴퓨터에서는 두 칸(왼쪽: 금액·세부·소유자 / 오른쪽: 카테고리·나누기·메모), 폰·아이패드는 한 줄로 (CSS order 로 순서 지정)
    const colB = new Set();
    parts.forEach((el, i) => {
      el.style.order = String(i + 1);
      if (el.classList.contains('txf-catgrp') || el.classList.contains('txf-notes') || el.id === 'f-err') colB.add(el);
    });
    const cols = [h('div', { class: 'txf-col' }, parts.filter((el) => !colB.has(el))), h('div', { class: 'txf-col' }, parts.filter((el) => colB.has(el)))];
    return { headKids, parts: cols, footKids };
  }

  // ── 거래 나누기 편집기
  let splitRefs = null;
  function splitEditor(catType) {
    const ccy = f.currency;
    const dec = L.decimals(ccy);
    const rows = h('div', { class: 'txf-lines', id: 'f-lines' });
    const bar = h('div', { class: 'txf-sbar-fill' });
    const sbarText = h('div', { class: 'txf-sbar-t', id: 'f-split-status' });
    const lineEls = [];
    f.lines.forEach((ln, i) => {
      const amt = h('input', {
        type: 'text', inputmode: 'decimal', class: 'sl-amt', id: 'f-sl-amt-' + i, value: niceAmt(ln.amountText, ccy, 'f-sl-amt-' + i), autocomplete: 'off', enterkeyhint: 'done',
        placeholder: '0.00', 'aria-label': 'Line ' + (i + 1) + ' amount (' + (i + 1) + '번째 줄 금액)',
        oninput: (e) => { ln.amountText = e.target.value; if (f.autoLine === i) f.autoLine = -1; applyAuto(); refreshSplit(i); },
        onblur: (e) => {
          const n = L.parseAmount(ln.amountText);
          if (Number.isFinite(n) && n !== 0) { ln.amountText = String(L.round(n, dec)); e.target.value = L.fmtNumber(L.round(n, dec), ccy); }
          refreshSplit();
        }
      });
      const cadEl = h('div', { class: 'sl-cad', id: 'f-sl-cad-' + i });
      const autoTag = h('span', { class: 'sl-auto', id: 'f-sl-auto-' + i, hidden: f.autoLine !== i }, 'Auto (자동)');
      const row = h('div', { class: 'sl', 'data-i': i },
        h('div', { class: 'sl-no', 'aria-hidden': 'true' }, String(i + 1)),
        h('select', {
          class: 'sl-cat', id: 'f-sl-cat-' + i, 'aria-label': 'Line ' + (i + 1) + ' category (' + (i + 1) + '번째 줄 카테고리)',
          onchange: (e) => { ln.categoryId = e.target.value; f.categoryTouched = true; }
        }, catOptions(catType, ln.categoryId)),
        h('div', { class: 'sl-amtwrap' }, h('span', { class: 'sl-sym', 'aria-hidden': 'true' }, symOf(ccy)), amt, autoTag),
        h('button', {
          type: 'button', class: 'sl-rest', id: 'f-sl-rest-' + i, title: 'Put the rest on this line (나머지를 이 줄에)',
          'aria-label': 'Put the rest on line ' + (i + 1) + ' (나머지를 ' + (i + 1) + '번째 줄에)',
          onclick: () => { restTo(i); }
        }, 'Rest (나머지)'),
        h('select', {
          class: 'sl-own', id: 'f-sl-own-' + i, 'aria-label': 'Line ' + (i + 1) + ' owner (' + (i + 1) + '번째 줄 소유자)',
          onchange: (e) => { ln.owner = e.target.value; }
        }, CONFIG.OWNERS.map((o) => h('option', { value: o, selected: o === ln.owner }, L.ownerLabel(o)))),
        h('input', {
          type: 'text', class: 'sl-memo', id: 'f-sl-memo-' + i, value: ln.memo || '', autocomplete: 'off', enterkeyhint: 'done',
          placeholder: 'Memo (메모)', 'aria-label': 'Line ' + (i + 1) + ' memo (' + (i + 1) + '번째 줄 메모)',
          oninput: (e) => { ln.memo = e.target.value; }
        }),
        h('button', {
          type: 'button', class: 'sl-del', id: 'f-sl-del-' + i, disabled: f.lines.length <= 1,
          'aria-label': 'Remove line ' + (i + 1) + ' (' + (i + 1) + '번째 줄 삭제)', title: 'Remove line (줄 삭제)',
          onclick: () => removeLine(i)
        }, icon('trash', 18)),
        cadEl);
      lineEls.push({ amt, cadEl, autoTag });
      rows.append(row);
    });
    splitRefs = { bar, sbarText, lineEls };
    const box = h('div', { class: 'txf-split wide' },
      h('div', { class: 'txf-sbar', id: 'f-split-bar' },
        h('div', { class: 'txf-sbar-track', 'aria-hidden': 'true' }, bar), sbarText),
      rows,
      h('div', { class: 'txf-split-acts' },
        h('button', { type: 'button', class: 'btn secondary sm', id: 'f-sl-add', onclick: addLine }, icon('plus', 18), 'Add line (줄 추가)'),
        h('button', { type: 'button', class: 'btn secondary sm', id: 'f-sl-even', onclick: evenly }, icon('split', 18), 'Split evenly (똑같이 나누기)')));
    setTimeout(() => refreshSplit(), 0);
    return box;
  }

  // 입력할 때마다: 남은 금액 · 막대 · 저장 버튼 · 자동 줄 값 · CAD 미리보기 (다시 그리지 않음 → 커서 유지)
  function refreshSplit(typingIdx) {
    if (!splitRefs || !splitOn()) return;
    const st = splitStatus();
    const { bal } = st;
    const ccy = f.currency;
    const pct = bal.total > 0 ? Math.max(0, Math.min(100, (bal.sum / bal.total) * 100)) : 0;
    splitRefs.bar.style.width = pct.toFixed(1) + '%';
    splitRefs.bar.className = 'txf-sbar-fill ' + st.tone;
    splitRefs.sbarText.replaceChildren(
      h('span', null, 'Assigned (배분) ', h('b', null, fmt(bal.sum, ccy)), ' / ' + (bal.total > 0 ? fmt(bal.total, ccy) : '—')),
      h('span', { class: 'txf-rem ' + st.tone }, bal.remaining === 0 && bal.total > 0 ? 'Balanced (맞음) ✓' : (bal.remaining < 0 ? 'Over (초과) ' : 'Left (남음) ') + (Number.isFinite(bal.remaining) ? fmt(Math.abs(bal.remaining), ccy) : '—')));
    const cads = lineCads();
    splitRefs.lineEls.forEach((le, i) => {
      if (i !== typingIdx && f.lines[i] && document.activeElement !== le.amt) {
        le.amt.value = niceAmt(f.lines[i].amountText, ccy);
      }
      le.autoTag.hidden = f.autoLine !== i;
      le.cadEl.textContent = cads && Number.isFinite(cads[i]) && cads[i] !== 0 ? '≈ ' + fmt(cads[i]) : '';
    });
    const save = $('f-save');
    if (save) save.disabled = !st.ok || saving;
    const msg = $('f-split-msg');
    if (msg) {
      msg.className = 'txf-footmsg ' + st.tone;
      msg.hidden = st.ok;
      msg.replaceChildren(icon(st.ok ? 'check' : 'alert', 16), h('span', null, st.text));
    }
  }

  function startSplit() {
    const dec = L.decimals(f.currency);
    const total = L.round(L.parseAmount(f.amountText), dec);
    f.split = true;
    f.lines = [
      { categoryId: f.categoryId || '', amountText: total > 0 ? String(total) : '', owner: f.owner, memo: '' },
      { categoryId: '', amountText: '', owner: f.owner, memo: '' }];
    f.autoLine = 0;
    errText = '';
    draw();
    const c = $('f-sl-cat-1');
    if (c) { try { c.focus({ preventScroll: false }); } catch (e) { /* ignore */ } }
  }
  function unsplit() {
    const filled = f.lines.filter((l) => l.categoryId || L.parseAmount(l.amountText)).length;
    if (filled > 1 && !window.confirm('Undo the split? The transaction will use one category. (나누기를 취소하고 카테고리 하나로 합칠까요?)')) return;
    const bal = L.splitBalance(f);
    let big = 0;
    bal.amounts.forEach((a, i) => { if (Math.abs(a || 0) > Math.abs(bal.amounts[big] || 0)) big = i; });
    f.categoryId = (f.lines[big] && f.lines[big].categoryId) || (f.lines[0] && f.lines[0].categoryId) || '';
    f.split = false; f.lines = []; f.autoLine = -1;
    errText = '';
    draw();
  }
  function addLine() {
    const st = L.splitBalance(f);
    const rest = st.remaining > 0 ? String(st.remaining) : '';
    if (f.autoLine >= 0) f.autoLine = -1;
    f.lines.push({ categoryId: '', amountText: rest, owner: f.owner, memo: '' });
    draw();
    const c = $('f-sl-cat-' + (f.lines.length - 1));
    if (c) { try { c.focus(); } catch (e) { /* ignore */ } }
  }
  function removeLine(i) {
    if (f.lines.length <= 1) return;
    f.lines.splice(i, 1);
    if (f.autoLine === i) f.autoLine = -1; else if (f.autoLine > i) f.autoLine--;
    applyAuto();
    draw();
  }
  function evenly() {
    const dec = L.decimals(f.currency);
    const total = L.round(L.parseAmount(f.amountText), dec);
    if (!(total > 0)) { errText = '먼저 총액을 입력하세요. (Enter the total first)'; draw(); return; }
    const parts = L.splitEvenly(total, f.lines.length, dec);
    f.lines.forEach((l, i) => { l.amountText = String(parts[i]); });
    f.autoLine = -1;
    draw();
  }
  function restTo(i) {
    const dec = L.decimals(f.currency);
    const total = L.round(L.parseAmount(f.amountText), dec);
    if (!(total > 0)) { errText = '먼저 총액을 입력하세요. (Enter the total first)'; draw(); return; }
    const others = f.lines.reduce((s, l, j) => { if (j === i) return s; const n = L.parseAmount(l.amountText); return s + (Number.isFinite(n) ? L.round(n, dec) : 0); }, 0);
    const rest = L.round(total - others, dec);
    f.lines[i].amountText = rest !== 0 ? String(rest) : '';
    if (f.autoLine !== i) f.autoLine = -1;
    errText = rest <= 0 ? '다른 줄의 합계가 이미 총액 이상입니다. (Other lines already use up the total)' : '';
    draw();
  }

  // ── 저장
  async function onSave() {
    if (saving || closed) return;
    const errEl = $('f-err');
    if (splitOn()) {
      const st = splitStatus();
      if (!st.ok) { errText = st.text; if (errEl) errEl.textContent = st.text; return; }
    }
    const form = Object.assign({}, f, { split: splitOn() });
    const res = L.makeRecords(form, { accMap: d.accMap, rules: data.rules, existing, now: L.nowIso() });
    if (res.error) { errText = res.error; if (errEl) { errEl.textContent = res.error; errEl.scrollIntoView && errEl.scrollIntoView({ block: 'nearest' }); } return; }
    // 규칙은 자동으로 만들지 않고, 새로 정한 분류일 때만 저장 후에 물어봅니다. (나눈 거래는 묻지 않음)
    const cand = res.rule; res.rule = null;
    const cur = cand ? L.suggestRule(data.rules, res.txn.merchant) : null;
    const ask = cand && !(cur && String(cur.account_id) === String(cand.account_id)) && f.categoryTouched !== false && (!existing || existing.desc.split || String(existing.desc.categoryId) !== String(f.categoryId))
      ? [{ merchant: res.txn.merchant, accountId: String(cand.account_id), previousAccountId: cur ? String(cur.account_id) : '' }] : [];
    saving = true;
    const sb = $('f-save');
    if (sb) { sb.disabled = true; }
    try {
      await sync.saveRecords(res);
      if (f.kind === 'EXPENSE' && f.fromId) { try { localStorage.setItem('hl_last_from', f.fromId); } catch (e) { /* ignore */ } }
      if (res.txn.date && L.monthOf(res.txn.date) !== state.month && !state.query) state.month = L.monthOf(res.txn.date);
      close();
      toast(auth.getToken() ? 'Saved (저장됨)' : 'Saved offline — will upload after sign-in (오프라인 저장, 로그인 후 전송)');
      await api.reload();
      api.renderBody(true);
      if (ask.length) await openRemember({ h, toast, accMap: state.d.accMap, data: state.data, reload: api.reload }, ask);
    } catch (e) {
      saving = false;
      if (sb) sb.disabled = false;
      errText = '저장하지 못했습니다: ' + (e.message || e);
      const el = $('f-err');
      if (el) el.textContent = errText;
    }
  }

  function receiptOf(txn) {
    if (!txn.receipt_id) return null;
    const r = (data.receipts || []).find((x) => String(x.receipt_id) === String(txn.receipt_id) && !L.truthy(x.deleted));
    return r && r.drive_file_id ? r : null;
  }

  // 다시 그리기: 스크롤 위치 · 포커스 · 커서를 유지
  function draw() {
    const act = document.activeElement;
    const focusId = act && sheet.contains(act) ? act.id : '';
    let selS = null, selE = null;
    try { if (focusId && act.setSelectionRange && act.type === 'text') { selS = act.selectionStart; selE = act.selectionEnd; } } catch (e) { /* ignore */ }
    const top = body.scrollTop;
    const b = build();
    head.replaceChildren(...b.headKids);
    body.replaceChildren(...b.parts);
    foot.replaceChildren(...b.footKids.filter(Boolean));
    body.scrollTop = top;
    if (focusId) {
      const el = $(focusId);
      if (el && el.focus) {
        try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
        try { if (selS !== null && el.setSelectionRange) el.setSelectionRange(selS, selE); } catch (e) { /* ignore */ }
      }
    }
    if (f.split && splitOn()) refreshSplit();
  }

  draw();
  if (!existing) {
    const a = $('f-amount');
    // 폰에서는 창이 다 올라온 뒤에 키보드를 띄워야 화면이 덜 흔들립니다
    if (a) { try { a.focus({ preventScroll: true }); } catch (e) { a.focus(); } }
  }
  return { close, form: f };
}

// 저장된 숫자 "86.4" → 화면에는 "86.40" (계산식이나 입력 중인 칸은 그대로)
function niceAmt(text, ccy, id) {
  const t = String(text == null ? '' : text);
  if (!/^-?[\d,]*\.?\d*$/.test(t.trim()) || !t.trim()) return t;
  if (id && typeof document !== 'undefined' && document.activeElement && document.activeElement.id === id) return t;
  const n = L.parseAmount(t);
  return Number.isFinite(n) && n !== 0 ? (n < 0 ? '-' : '') + L.fmtNumber(Math.abs(L.round(n, L.decimals(ccy))), ccy) : t;
}

const SYM = { CAD: '$', USD: 'US$', KRW: '₩', JPY: '¥', EUR: '€', GBP: '£', CNY: 'CN¥', AUD: 'A$', MXN: 'MX$' };
function symOf(ccy) { return SYM[ccy] || ccy; }
