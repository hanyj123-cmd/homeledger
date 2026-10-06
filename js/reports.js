// 손익(Income Statement)과 재무상태(Balance Sheet). 계산(순수 로직) + 화면.
import * as L from './ledger.js';
import * as B from './budget.js';

const UNCATEGORIZED_ID = '9999';

// ───────── 계산 ─────────

const lastDayOf = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return ym + '-' + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0');
};

// items = [{txn, ps}], accMap = Map(account_id → account)
export function incomeStatement(items, accMap, ym) {
  const inc = new Map(), exp = new Map();
  let reviewCount = 0;
  items.forEach((it) => {
    if (L.monthOf(it.txn.date) !== ym) return;
    let review = String(it.txn.status).toUpperCase() === 'REVIEW';
    it.ps.forEach((p) => {
      const a = accMap.get(String(p.account_id));
      if (!a) return;
      const v = L.num(p.amount_cad);
      if (a.type === 'INCOME') inc.set(a.account_id, (inc.get(a.account_id) || 0) - v);
      else if (a.type === 'EXPENSE') {
        exp.set(a.account_id, (exp.get(a.account_id) || 0) + v);
        if (String(a.account_id) === UNCATEGORIZED_ID) review = true;
      }
    });
    if (review) reviewCount++;
  });
  const lineOf = (id, amount) => { const a = accMap.get(String(id)); return { id: String(id), name: a.name, name_ko: a.name_ko || '', amount: L.round(amount, 2), sort: L.num(a.sort_order), group: a.report_group || '' }; };
  const incomeLines = Array.from(inc, ([id, v]) => lineOf(id, v)).filter((l) => l.amount !== 0).sort((a, b) => b.amount - a.amount);
  const groups = new Map();
  Array.from(exp, ([id, v]) => lineOf(id, v)).filter((l) => l.amount !== 0).forEach((l) => {
    const key = l.group || '확인 필요';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  });
  const order = L.GROUP_ORDER.filter((g) => groups.has(g)).concat(Array.from(groups.keys()).filter((g) => L.GROUP_ORDER.indexOf(g) < 0));
  const expenseGroups = order.map((key) => {
    const lines = groups.get(key).sort((a, b) => b.amount - a.amount);
    return { key, label: L.GROUP_LABELS[key] || key, total: L.round(lines.reduce((s, l) => s + l.amount, 0), 2), lines };
  });
  const income = L.round(incomeLines.reduce((s, l) => s + l.amount, 0), 2);
  const expense = L.round(expenseGroups.reduce((s, g) => s + g.total, 0), 2);
  const net = L.round(income - expense, 2);
  return { ym, incomeLines, income, expenseGroups, expense, net, savingsRate: income > 0 ? L.round(net / income * 100, 1) : null, reviewCount };
}

// 월말 기준 재무상태. 장부가 맞는지(자산 − 부채 = 자본)도 확인합니다.
export function balanceSheet(accounts, items, accMap, ym) {
  const asOf = lastDayOf(ym);
  const raw = new Map();
  items.forEach((it) => {
    if (it.txn.date > asOf) return;
    it.ps.forEach((p) => { const k = String(p.account_id); raw.set(k, (raw.get(k) || 0) + L.num(p.amount_cad)); });
  });
  const get = (id) => raw.get(String(id)) || 0;
  const live = accounts.filter((a) => L.isActive(a) || Math.abs(get(a.account_id)) > 0.005);
  const lines = (type, sign) => live.filter((a) => a.type === type)
    .map((a) => ({ id: String(a.account_id), name: a.name, name_ko: a.name_ko || '', owner: a.owner || '', amount: L.round(sign * get(a.account_id), 2) }))
    .filter((l) => Math.abs(l.amount) > 0.004);
  const assets = lines('ASSET', 1), liabilities = lines('LIABILITY', -1), equityLines = lines('EQUITY', -1);
  const sum = (ls) => L.round(ls.reduce((s, l) => s + l.amount, 0), 2);
  let pl = 0;
  live.forEach((a) => { if (a.type === 'INCOME' || a.type === 'EXPENSE') pl += get(a.account_id); });
  const retained = L.round(-pl, 2); // 누적 순수입 = 수입 − 지출
  const totalAssets = sum(assets), totalLiab = sum(liabilities);
  const equityTotal = L.round(sum(equityLines) + retained, 2);
  const net = L.round(totalAssets - totalLiab, 2);
  return { ym, asOf, assets, totalAssets, liabilities, totalLiab, equityLines, retained, equityTotal, net, diff: L.round(net - equityTotal, 2) };
}

// ───────── 화면 ─────────

let mode = 'IS';
export function setMode(m) { mode = m; }

// api = { h, fmt, state, items, accounts, accMap, rerender, goSearch(text) }
export function render(api) {
  const { h, fmt, state } = api;
  const root = document.createDocumentFragment();
  const seg = h('div', { class: 'seg three-seg' },
    [['IS', 'Income (손익)'], ['BS', 'Balance (재무)'], ['BG', 'Budget (예산)']].map((m) => h('button', {
      type: 'button', id: 'rep-' + m[0], class: mode === m[0] ? 'on' : '', onclick: () => { mode = m[0]; api.rerender(); }
    }, m[1])));
  const nav = h('div', { class: 'monthnav' },
    h('button', { type: 'button', class: 'icon', 'aria-label': 'Previous month (이전 달)', onclick: () => { state.month = L.shiftMonth(state.month, -1); api.rerender(); } }, '‹'),
    h('div', { class: 'monthlabel' }, L.monthLabel(state.month)),
    h('button', { type: 'button', class: 'icon', 'aria-label': 'Next month (다음 달)', onclick: () => { state.month = L.shiftMonth(state.month, 1); api.rerender(); } }, '›'));
  function stat(label, value, cls) {
    return h('div', { class: 'stat' }, h('div', { class: 'stat-l' }, label), h('div', { class: 'stat-v ' + (cls || '') + (String(value).length >= 12 ? ' long' : '') }, value));
  }
  const lineRow = (l, arrow, cls, share, gcls) => h('button', { type: 'button', class: 'row rep-row ' + (gcls || ''), onclick: () => api.goSearch(l.name) },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, l.name),
      share !== undefined ? h('div', { class: 'row-sub' }, share + '% of spending (지출 비중)') : null),
    h('div', { class: 'row-right' }, h('div', { class: 'row-amt ' + cls }, (arrow ? arrow + ' ' : '') + fmt(l.amount))));

  const body = mode === 'IS' ? drawIS() : mode === 'BS' ? drawBS() : drawBG();
  const masthead = h('div', { class: 'masthead' }, seg, nav);
  const tiles = body.querySelector('.summary');
  if (tiles) masthead.append(tiles);
  root.append(masthead, body);

  return root;

  function drawIS() {
    const prev = incomeStatement(api.items, api.accMap, L.shiftMonth(state.month, -1));
    const r = incomeStatement(api.items, api.accMap, state.month);
    const box = h('div', { id: 'rep-is' });
    box.append(h('div', { class: 'summary' },
      stat('Income (수입)', '↑ ' + fmt(r.income), 'in'),
      stat('Spending (지출)', '↓ ' + fmt(r.expense), 'out'),
      stat('Net (순수입)', (r.net >= 0 ? '▲ ' : '▼ ') + fmt(Math.abs(r.net)), r.net >= 0 ? 'in' : 'out')));
    if (r.savingsRate !== null) box.append(h('div', { class: 'note' }, 'Savings rate (저축률): ' + r.savingsRate + '% · Last month net (전월 순수입): ' + fmt(prev.net)));
    if (r.reviewCount) {
      box.append(h('button', { type: 'button', class: 'card warn-card', id: 'rep-review', onclick: () => api.goSearch('Uncategorized') },
        r.reviewCount + ' transaction(s) need a category (카테고리 확인이 필요한 거래 ' + r.reviewCount + '건) — tap to review (눌러서 확인)'));
    }
    if (!r.incomeLines.length && !r.expenseGroups.length) {
      box.append(h('div', { class: 'card center muted' }, 'No income or spending this month (이번 달 수입·지출이 없습니다).'));
      return box;
    }
    if (r.incomeLines.length) {
      box.append(h('h2', { class: 'sect grp g-in' }, 'Income (수입) · ' + fmt(r.income)));
      const led = h('div', { class: 'ledger' });
      r.incomeLines.forEach((l) => led.append(lineRow(l, '↑', 'in', undefined, 'g-in')));
      box.append(led);
    }
    r.expenseGroups.forEach((g) => {
      const pct = r.expense ? Math.round(g.total / r.expense * 100) : 0;
      const pg = prev.expenseGroups.find((x) => x.key === g.key);
      const gc = L.GROUP_CLASS[g.key] || '';
      box.append(h('h2', { class: 'sect grp ' + gc }, g.label + ' · ' + fmt(g.total) + ' (' + pct + '%)'));
      if (pg) box.append(h('div', { class: 'note' }, 'Last month (전월): ' + fmt(pg.total)));
      const led = h('div', { class: 'ledger' });
      g.lines.forEach((l) => led.append(lineRow(l, '↓', 'out', r.expense ? Math.round(l.amount / r.expense * 100) : 0, gc)));
      box.append(led);
    });
    return box;
  }

  function drawBS() {
    const b = balanceSheet(api.accounts, api.items, api.accMap, state.month);
    const box = h('div', { id: 'rep-bs' });
    box.append(h('div', { class: 'summary' },
      stat('Assets (자산)', fmt(b.totalAssets), ''),
      stat('Debts (부채)', fmt(b.totalLiab), ''),
      stat('Net worth (순자산)', (b.net >= 0 ? '▲ ' : '▼ ') + fmt(Math.abs(b.net)), b.net >= 0 ? 'in' : 'out')));
    box.append(h('div', { class: 'note' }, 'As of (기준일): ' + b.asOf));
    const section = (title, lines, total) => {
      box.append(h('h2', { class: 'sect' }, title + ' · ' + fmt(total)));
      if (!lines.length) { box.append(h('div', { class: 'card muted' }, '—')); return; }
      const led = h('div', { class: 'ledger' });
      lines.forEach((l) => led.append(h('div', { class: 'row rep-row static' },
        h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, l.name), h('div', { class: 'row-sub' }, l.owner)),
        h('div', { class: 'row-right' }, h('div', { class: 'row-amt' }, fmt(l.amount))))));
      box.append(led);
    };
    section('Assets (자산)', b.assets, b.totalAssets);
    section('Credit & loans (카드 · 대출)', b.liabilities, b.totalLiab);
    box.append(h('details', { class: 'card', id: 'rep-equity' },
      h('summary', null, 'Equity (자본) · ' + fmt(b.equityTotal)),
      b.equityLines.map((l) => h('div', { class: 'row-sub' }, l.name + ': ' + fmt(l.amount))),
      h('div', { class: 'row-sub' }, 'Cumulative net income (누적 순수입): ' + fmt(b.retained))));
    if (Math.abs(b.diff) > 0.01) {
      box.append(h('div', { class: 'card warn-card', id: 'rep-diff', role: 'alert' },
        'Books out of balance by ' + fmt(b.diff) + ' (장부가 맞지 않습니다: 자산 − 부채 ≠ 자본). Check opening balances and recent edits (기초잔액과 최근 수정 내역을 확인하세요).'));
    }
    return box;
  }

  function drawBG() {
    const data = api.data || {};
    const today = L.todayStr();
    const budgets = data.budgets || [];
    const c = B.compare(api.items, api.accMap, budgets, state.month, today);
    const box = h('div', { id: 'rep-bg' });
    const leftLabel = c.left >= 0 ? 'Left (남음)' : 'Over (초과)';
    box.append(h('div', { class: 'summary' },
      stat('Budget (예산)', fmt(c.totalBudget), ''),
      stat('Spent (지출)', '↓ ' + fmt(c.totalActual), 'out'),
      stat(leftLabel, (c.left >= 0 ? '▲ ' : '▼ ') + fmt(Math.abs(c.left)), c.left >= 0 ? 'in' : 'out')));

    const prevCopy = B.copyFromPrevious(budgets, state.month);
    const avg = B.suggestFromAverage(api.items, api.accMap, budgets, state.month, 3);
    const actions = h('div', { class: 'actions bg-actions' });
    actions.append(
      h('button', { type: 'button', class: 'btn secondary', id: 'bg-copy', disabled: !prevCopy.size, onclick: () => confirmFill(prevCopy, 'Copy last month (전월 예산 복사)') }, 'Copy last month (전월 복사)'),
      h('button', { type: 'button', class: 'btn secondary', id: 'bg-avg', disabled: !avg.size, onclick: () => confirmFill(avg, 'Fill from 3-month average (최근 3개월 평균으로 채우기)') }, 'Fill from average (평균으로)'));
    box.append(actions);

    if (!c.groups.length) {
      box.append(h('div', { class: 'card center muted', id: 'bg-empty' }, 'No budget or spending this month (이번 달 예산·지출이 없습니다). Use the buttons above (위 버튼으로 시작하세요).'));
      return box;
    }
    if (c.hasBudget) {
      box.append(bar(c.pct === null ? 0 : c.pct, c.status, c.paceFraction, 'bg-total'));
      const pace = c.paceFraction !== null ? ' · Day ' + Number(today.slice(8, 10)) + ' (오늘까지 ' + Math.round(c.paceFraction * 100) + '% 경과)' : '';
      box.append(h('div', { class: 'note' }, c.pct + '% used (사용) ' + pace));
    }
    if (c.unbudgeted > 0) box.append(h('div', { class: 'note' }, 'No budget yet for ' + fmt(c.unbudgeted) + ' of spending (예산이 없는 지출). Tap a row to set one (눌러서 설정).'));
    c.groups.forEach((g) => {
      const gc = L.GROUP_CLASS[g.key] || '';
      box.append(h('h2', { class: 'sect grp ' + gc }, g.label + ' · ' + fmt(g.actual) + ' / ' + fmt(g.budget)));
      const led = h('div', { class: 'ledger' });
      g.lines.forEach((l) => led.append(h('button', { type: 'button', class: 'row bg-row ' + gc, 'data-acct': l.id, onclick: () => openEditor(l) },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' }, l.name),
          h('div', { class: 'row-sub' }, l.budget ? fmt(l.actual) + ' of ' + fmt(l.budget) + ' (' + l.pct + '%)' : fmt(l.actual) + ' — no budget (예산 없음)'),
          l.budget ? bar(Math.min(l.pct, 100), l.status, c.paceFraction, '') : null),
        h('div', { class: 'row-right' },
          l.budget ? h('div', { class: 'row-amt ' + (l.left >= 0 ? 'in' : 'out') }, (l.left >= 0 ? '' : '−') + fmt(Math.abs(l.left))) : h('div', { class: 'row-amt move' }, '+ Set (설정)'),
          l.budget ? h('div', { class: 'row-fx' }, l.left >= 0 ? 'left (남음)' : 'over (초과)') : null))));
      box.append(led);
    });
    return box;
  }

  function bar(pct, status, pace, id) {
    const fill = h('i', { class: 'bar-fill ' + status, style: 'width:' + Math.max(0, Math.min(100, pct)) + '%' });
    const wrap = h('div', { class: 'bar', id: id || null, role: 'img', 'aria-label': pct + '% used' }, fill);
    if (pace !== null && pace !== undefined) wrap.append(h('b', { class: 'bar-pace', style: 'left:' + Math.round(pace * 100) + '%' }));
    return wrap;
  }

  async function save(rows, msg) {
    if (!rows.length) return;
    await api.saveBudgets(rows);
    api.toast(msg || 'Saved (저장됨)');
  }

  function scopeSelect(id) {
    return h('select', { id, 'aria-label': 'Apply to (적용 범위)' },
      h('option', { value: 'month' }, 'This month only (이번 달만)'),
      h('option', { value: 'year' }, 'Rest of this year (올해 남은 달 전부)'),
      h('option', { value: 'next12' }, 'Next 12 months (지금부터 12개월)'));
  }

  function openEditor(line) {
    const ov = document.getElementById('overlay');
    ov.hidden = false; document.body.classList.add('noscroll');
    const close = () => { ov.hidden = true; ov.replaceChildren(); document.body.classList.remove('noscroll'); };
    const err = h('div', { class: 'err', id: 'bg-err', role: 'alert' });
    const amt = h('input', { type: 'text', id: 'bg-amount', inputmode: 'decimal', autocomplete: 'off', value: line.budget ? String(line.budget) : '', placeholder: 'e.g. 600' });
    const scope = scopeSelect('bg-scope');
    const doSave = async (amount) => {
      const rows = B.setBudget(api.data.budgets || [], line.id, state.month, amount, scope.value, L.nowIso());
      if (!rows.length) { close(); return; }
      close(); await save(rows, amount > 0 ? 'Budget saved (예산 저장됨)' : 'Budget removed (예산 삭제됨)');
    };
    ov.replaceChildren(h('div', { class: 'backdrop' }, h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Budget' },
      h('div', { class: 'sheet-head' }, h('h2', null, line.name), h('button', { type: 'button', class: 'icon', 'aria-label': 'Close (닫기)', onclick: close }, '✕')),
      h('div', { class: 'hint' }, L.monthLabel(state.month) + ' · spent so far (지금까지 지출) ' + fmt(line.actual)),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Monthly budget (월 예산, CAD)'), amt),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Apply to (적용 범위)'), scope),
      err,
      h('div', { class: 'btnrow' },
        h('button', { type: 'button', class: 'btn', id: 'bg-save', onclick: () => {
          const n = L.parseAmount(amt.value);
          if (!Number.isFinite(n) || n <= 0) { err.textContent = '0보다 큰 금액을 입력하세요. (삭제는 "Remove")'; return; }
          doSave(L.round(n, 2));
        } }, 'Save (저장)'),
        h('button', { type: 'button', class: 'btn secondary', onclick: close }, 'Cancel (취소)'),
        line.budget ? h('button', { type: 'button', class: 'btn danger', id: 'bg-remove', onclick: () => doSave(0) }, 'Remove (삭제)') : null))));
    amt.focus();
  }

  function confirmFill(entries, title) {
    const ov = document.getElementById('overlay');
    ov.hidden = false; document.body.classList.add('noscroll');
    const close = () => { ov.hidden = true; ov.replaceChildren(); document.body.classList.remove('noscroll'); };
    const scope = scopeSelect('bg-fill-scope');
    const names = Array.from(entries, ([id, v]) => { const a = api.accMap.get(String(id)); return (a ? a.name : id) + ' ' + fmt(v); });
    ov.replaceChildren(h('div', { class: 'backdrop' }, h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Fill budget' },
      h('div', { class: 'sheet-head' }, h('h2', null, title), h('button', { type: 'button', class: 'icon', 'aria-label': 'Close (닫기)', onclick: close }, '✕')),
      h('div', { class: 'hint', id: 'bg-fill-list' }, entries.size + ' categories (카테고리 ' + entries.size + '개): ' + names.slice(0, 12).join(', ') + (names.length > 12 ? ' …' : '')),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Apply to (적용 범위)'), scope),
      h('div', { class: 'btnrow' },
        h('button', { type: 'button', class: 'btn', id: 'bg-fill-go', onclick: async () => {
          const rows = B.applyMap(api.data.budgets || [], entries, state.month, scope.value, L.nowIso());
          close(); await save(rows, 'Budgets saved (예산 저장됨)');
        } }, 'Apply (적용)'),
        h('button', { type: 'button', class: 'btn secondary', onclick: close }, 'Cancel (취소)')))));
  }
}
