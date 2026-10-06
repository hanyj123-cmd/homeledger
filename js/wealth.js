// Wealth (자산·부채) 화면: 개요 · 집·차 · 대출 · 부채 · 주식 · 미지급.
// 설정은 Settings 시트의 JSON(meta.js)에 저장하고, V.overridesFor 가 재무상태표·계좌 잔액을 덮어씁니다.
import * as L from './ledger.js';
import * as V from './valuation.js';
import * as M from './meta.js';
import * as I from './insights.js';
import * as AI from './ai.js';
import { icon } from './icons.js';
import { layoutOf } from './layout.js';
import { lineChart, barChart, donut, hbars, compact } from './charts.js';
import * as F from './wealth-forms.js';

const TABS = [['overview', 'Overview', '개요'], ['assets', 'Assets', '자산'], ['loans', 'Loans', '대출'], ['debts', 'Debts', '부채'], ['stocks', 'Stocks', '주식'], ['accrued', 'Accrued', '미지급']];
const KIND_LABEL = {
  cash: 'Cash (현금)', invest: 'Investment (투자)', fixed: 'Fixed asset (집·차)', other: 'Other (기타)',
  card: 'Credit card (카드)', loan: 'Loan (대출)', loc: 'Credit line (한도)', accrued: 'Accrued (미지급)', clearing: 'Clearing (정산 중)'
};
const KIND_TAB = { invest: 'stocks', fixed: 'assets', loan: 'loans', card: 'debts', loc: 'debts', accrued: 'accrued' };
const TAB_LABEL = { stocks: 'Stocks', assets: 'Assets', loans: 'Loans', debts: 'Debts', accrued: 'Accrued' };
const KIND_ICON = { cash: 'coin', invest: 'chart', fixed: 'house', other: 'coin', card: 'accounts', loan: 'house', loc: 'accounts', accrued: 'calendar', clearing: 'transfer' };
const looksLikeCar = (a) => /CAR|VEHICLE|SUV|AUTO|TRUCK|CIVIC|HONDA|TOYOTA/i.test(String(a.name) + ' ' + String(a.subtype));

export function render(api) {
  const { h, fmt, state } = api;
  const ws = state.wl || (state.wl = {});
  ['edit', 'years', 'extra', 'msg', 'pick', 'open'].forEach((k) => { if (!ws[k]) ws[k] = {}; });
  if (!ws.tab) ws.tab = 'overview';
  const month = state.month;
  const prevMonth = L.shiftMonth(month, -1);
  const ctx = api.analysis();
  const meta = api.meta();
  const accMap = api.accMap;
  const accounts = api.accounts.filter(L.isActive);
  const bs = ctx.bs, bsPrev = ctx.bsPrev;
  const today = api.today || L.todayStr();
  const charts = [];
  const track = (c) => { charts.push(c); return c; };
  const kindOf = (a) => I.kindOf(a);
  const byId = (lines) => new Map(lines.map((l) => [String(l.id), l]));
  const bsA = byId(bs.assets), bsL = byId(bs.liabilities);
  const prevMap = new Map(bsPrev.assets.concat(bsPrev.liabilities).map((l) => [String(l.id), l.amount]));
  const bookOf = (line) => (line ? (line.book !== undefined ? line.book : line.amount) : 0);

  // ───── 작은 도구 ─────
  const el = (tag, cls, ...kids) => h(tag, cls ? { class: cls } : null, ...kids);
  const signed = (v) => (v < 0 ? '−' : '') + fmt(Math.abs(v));
  const pct = (v, d) => { const f = Math.pow(10, d === undefined ? 1 : d); return (Math.round(v * f) / f) + '%'; };
  function chg(delta, goodUp) {
    if (Math.abs(delta) < 0.005) return h('span', { class: 'chg flat' }, '—');
    const good = goodUp ? delta > 0 : delta < 0;
    return h('span', { class: 'chg ' + (good ? 'good' : 'bad') }, h('span', { class: 'arw' }, delta > 0 ? '▲' : '▼'), fmt(Math.abs(delta)));
  }
  function chgPct(cur, base, goodUp) {
    if (!(Math.abs(base) > 0.004)) return null;
    const p = (cur - base) / Math.abs(base) * 100;
    if (Math.abs(p) < 0.05) return h('span', { class: 'chg flat' }, '0%');
    const good = goodUp ? p > 0 : p < 0;
    return h('span', { class: 'chg ' + (good ? 'good' : 'bad') }, h('span', { class: 'arw' }, p > 0 ? '▲' : '▼'), pct(Math.abs(p)));
  }
  const tile = (label, value, sub, cls, id) => h('div', { class: 'wl-tile' + (cls ? ' ' + cls : ''), id: id || null }, el('div', 'l', label), el('div', 'v', value), sub ? el('div', 's', sub) : null);
  const kv = (k, v, id) => h('div', { class: 'wl-kv', id: id || null }, el('span', 'k', k), el('span', 'v', v));
  const note = (...kids) => el('div', 'wl-note', ...kids);
  const warn = (...kids) => h('div', { class: 'wl-warn', role: 'alert' }, icon('alert', 18), el('div', null, ...kids));
  const info = (...kids) => h('div', { class: 'wl-info' }, icon('info', 18), el('div', null, ...kids));
  const goEl = (label) => el('span', 'go', el('span', 'gt', label), ' ›');
  const sectTitle = (en, ko) => h('h3', { class: 'wl-h' }, en, ' ', el('span', 'ko', ko));
  const acctSub = (a) => [a.owner, a.institution].filter(Boolean).join(' · ');
  const rowOf = (key, value, why) => M.metaRow(api.data.settings, key, value, why, L.nowIso());

  async function save(rows, okMsg, btn) {
    if (btn) btn.disabled = true;
    try {
      await api.saveSettings(rows);
      if (okMsg) api.toast(okMsg);
    } catch (e) {
      if (btn) btn.disabled = false;
      api.toast('저장하지 못했어요: ' + (e && e.message ? e.message : e) + ' (인터넷 연결을 확인하고 다시 눌러 주세요)');
    }
  }
  function setTab(t) {
    ws.tab = t;
    seg.querySelectorAll('button').forEach((b) => { const on = b.getAttribute('data-tab') === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    paint();
    if (typeof seg.scrollIntoView === 'function' && layoutOf() === 'phone') { try { seg.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { /* 스크롤 실패는 무시 */ } }
  }

  // 폼 도우미
  const inp = (id, value, o) => {
    o = o || {};
    return h('input', { type: o.type || 'text', id, value: value === undefined || value === null ? '' : String(value), inputmode: o.type ? null : 'decimal', placeholder: o.ph || null, autocomplete: 'off', 'aria-label': o.label || null, min: o.min, max: o.max, step: o.step, class: o.cls || null });
  };
  const field = (label, input, hint, cls) => h('label', { class: 'field wl-f' + (cls ? ' ' + cls : '') }, el('span', 'lbl', label), input, hint ? el('span', 'hint', hint) : null);
  const markBad = (inputs, errors) => {
    Object.keys(inputs).forEach((k) => { const i = inputs[k]; if (!i) return; const bad = !!(errors && errors[k]); i.classList.toggle('bad', bad); if (bad) i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid'); });
  };
  const sel = (id, options, value, onchange) => h('select', { id, onchange: onchange || null }, options.map((o) => h('option', { value: o[0], selected: String(o[0]) === String(value) }, o[1])));

  // ───── 배너 · 위쪽 도구 · 탭 ─────
  const dn = L.round(bs.net - bsPrev.net, 2);
  const metric = (lab, val, sub, id) => h('div', { class: 'metric' + (sub ? ' sub' : ''), id: id || null }, el('div', 'metric-lab', lab), el('div', 'metric-val', val));
  const banner = h('section', { class: 'banner nopills wl-banner' }, h('div', { class: 'banner-in' },
    h('div', { class: 'banner-row' }, el('div', 'acct-pick', h('span', { class: 'nm' }, 'Wealth (자산·부채)')), el('div', 'asof', 'As of ', h('b', null, L.monthLabel(month)))),
    h('div', { class: 'metrics' },
      metric('Net worth (순자산)', signed(bs.net), false, 'wl-net'),
      metric('Assets (자산)', fmt(bs.totalAssets), true, 'wl-assets'),
      metric('Debts (부채)', fmt(bs.totalLiab), true, 'wl-debts'),
      metric('vs last month (전월 대비)', Math.abs(dn) < 0.005 ? '—' : (dn >= 0 ? '▲ ' : '▼ ') + fmt(Math.abs(dn)), true, 'wl-delta'))));

  const stepBtn = (dir, lab) => h('button', { type: 'button', class: 'stepbtn', 'aria-label': lab, onclick: () => { state.month = L.shiftMonth(state.month, dir); api.rerender(); } }, icon(dir < 0 ? 'left' : 'right', 20));
  const monthList = Array.from(new Set(api.items.map((it) => L.monthOf(it.txn.date)).concat([L.monthOf(today), month]))).sort().reverse();
  const monthSel = h('label', { class: 'pillsel' }, icon('calendar', 20), el('span', 'monthlabel', L.monthLabel(month)), icon('down', 18),
    h('select', { id: 'wl-month', 'aria-label': 'Month (월)', onchange: (e) => { state.month = e.target.value; api.rerender(); } }, monthList.map((m) => h('option', { value: m, selected: m === month }, L.monthLabel(m)))));
  const toolbar = el('div', 'toolbar', el('div', 'l', stepBtn(-1, 'Previous month (이전 달)'), monthSel, stepBtn(1, 'Next month (다음 달)')));

  const seg = h('div', { class: 'segtd wl-seg', role: 'tablist', id: 'wl-seg' }, TABS.map((t) => h('button', {
    type: 'button', id: 'wl-tab-' + t[0], role: 'tab', 'data-tab': t[0], class: ws.tab === t[0] ? 'on' : '', 'aria-selected': String(ws.tab === t[0]),
    onclick: () => setTab(t[0])
  }, t[1], el('span', 'ko', t[2]))));
  const body = h('div', { class: 'wl-body', id: 'wl-body' });
  const page = h('div', { class: 'page wl-page' }, seg, toolbar, body);
  const root = h('div', { class: 'wl' }, banner, page);

  function paint() {
    charts.splice(0).forEach((c) => { try { c.destroy(); } catch (e) { /* 이미 정리됨 */ } });
    body.replaceChildren();
    const fn = { overview, assets, loans, debts, stocks, accrued }[ws.tab] || overview;
    try { body.append(fn()); } catch (e) {
      console.error(e);
      body.append(h('div', { class: 'card warn-card', role: 'alert' }, '이 탭을 그리는 중 오류가 났어요: ' + (e && e.message ? e.message : e) + ' — 다른 탭은 정상입니다.'));
    }
  }

  // ═════════════════════ 개요 ═════════════════════
  function overview() {
    const wrap = el('div', 'wl-stack');
    const pos = ctx.pos;

    // 순자산 추이
    const first = ctx.nwSeries[0], lastV = ctx.nwSeries[ctx.nwSeries.length - 1];
    const span = L.round(lastV - first, 2);
    const lo = Math.min(...ctx.nwSeries), hi = Math.max(...ctx.nwSeries);
    const nwMin = lo > 0 && hi - lo < lo * 0.5 ? Math.floor((lo - (hi - lo) * 0.6) / 10000) * 10000 : undefined;
    wrap.append(h('section', { class: 'card wl-card', id: 'wl-nw-card' },
      el('div', 'wl-head', el('div', 'ti', sectTitle('Net worth trend', '순자산 추이'), el('span', 'sub', '최근 12개월 · ' + L.monthLabel(ctx.months[0]) + ' → ' + L.monthLabel(month))), el('div', 'tr', chg(span, true))),
      el('div', 'wl-chart', track(lineChart({
        title: 'Net worth, last 12 months', labels: ctx.months.map(L.monthLabel), height: 240, smooth: true, yMin: nwMin, fmt: (n) => fmt(n), selected: ctx.months.length - 1,
        series: [{ key: 'nw', name: 'Net worth (순자산)', color: 'var(--c1)', values: ctx.nwSeries, area: true }]
      }))),
      note('순자산 = 자산 − 부채. 집·차·주식·대출을 설정해 두면 그 평가·상환표 값이 반영돼요.')));

    // 구성 도넛
    const sl = (key, name, value, color) => ({ key, name, value, color });
    const aSlices = [sl('cash', 'Cash (현금)', pos.cash, 'var(--c1)'), sl('invest', 'Investments (투자)', pos.invest, 'var(--c2)'), sl('fixed', 'Fixed assets (집·차)', pos.fixed, 'var(--c3)'), sl('other', 'Other (기타)', pos.other, 'var(--c5)')];
    const dSlices = [sl('card', 'Cards (카드)', pos.card, 'var(--c4)'), sl('loan', 'Loans (대출)', pos.loan, 'var(--c8)'), sl('loc', 'Credit lines (한도)', pos.loc, 'var(--c6)'), sl('accrued', 'Accrued (미지급)', pos.accrued, 'var(--c7)'), sl('clearing', 'Clearing (정산 중)', pos.clearing, 'var(--ch-other)')];
    const donutCard = (id, en, ko, slices, total, centerLabel) => h('section', { class: 'card wl-card', id },
      el('div', 'wl-head', el('div', 'ti', sectTitle(en, ko))),
      track(donut({ title: en, fmt: (n) => fmt(n), slices, centerLabel, centerValue: '$' + compact(total), minPct: 0 })));
    wrap.append(el('div', 'wl-cols',
      donutCard('wl-donut-assets', 'Assets mix', '자산 구성', aSlices, bs.totalAssets, 'Assets (자산)'),
      donutCard('wl-donut-debts', 'Debts mix', '부채 구성', dSlices, bs.totalLiab, 'Debts (부채)')));

    // 장부 vs 평가
    const valued = bs.assets.map((l) => Object.assign({ liab: false }, l)).concat(bs.liabilities.map((l) => Object.assign({ liab: true }, l))).filter((l) => l.valued);
    if (valued.length) {
      const adj = (bs.equityLines.find((l) => l.id === 'valuation-adj') || { amount: 0 }).amount;
      const bookNet = L.round(bs.net - adj, 2);
      wrap.append(h('section', { class: 'card wl-card', id: 'wl-valued' },
        el('div', 'wl-head', el('div', 'ti', sectTitle('Book vs valued', '장부 vs 평가'))),
        el('p', 'wl-p', '집·차 가치, 대출 상환표, 주식 시세로 계산한 값은 거래 기록(장부)과 다를 수 있어요. 그 차이는 재무상태표의 자본에 ', h('b', null, 'Valuation adjustments (평가 조정)'), ' 줄로 따로 보여서 장부가 항상 맞아요.'),
        el('div', 'wl-tiles',
          tile('Net worth by books (장부 기준)', signed(bookNet), '거래 기록만으로'),
          tile('Net worth, valued (평가 반영)', signed(bs.net), '지금 화면의 순자산'),
          tile('Valuation adjustment (평가 조정)', h('span', null, chg(adj, true)), adj >= 0 ? '평가가 장부보다 높아요' : '평가가 장부보다 낮아요', Math.abs(adj) < 0.005 ? 'flat' : '', 'wl-adj')),
        el('div', 'wl-list',
          valued.map((l) => {
            const book = bookOf(l), diff = L.round(l.liab ? book - l.amount : l.amount - book, 2);
            const a = accMap.get(String(l.id)); const k = a ? kindOf(a) : 'other';
            return h('button', { type: 'button', class: 'wl-row', 'data-acct': l.id, onclick: () => { if (KIND_TAB[k]) setTab(KIND_TAB[k]); } },
              el('span', 'mid', el('span', 't', l.name), el('span', 's', 'Book (장부) ' + fmt(book) + ' → Valued (평가) ' + fmt(l.amount))),
              el('span', 'amt', chg(diff, true)),
              KIND_TAB[k] ? goEl(TAB_LABEL[KIND_TAB[k]]) : null);
          }))));
    }

    // 설정 체크
    const todo = [];
    accounts.forEach((a) => {
      const id = String(a.account_id), k = kindOf(a);
      if (k === 'fixed' && !meta.assets[id]) todo.push(['assets', a.name, '가치(감가·상승)를 아직 설정하지 않았어요']);
      if (k === 'loan' && !meta.loans[id]) todo.push(['loans', a.name, '상환표를 아직 설정하지 않았어요 (장부 잔액을 그대로 써요)']);
      if ((k === 'card' || k === 'loc') && bsL.has(id) && !(meta.debts[id] && meta.debts[id].apr)) todo.push(['debts', a.name, '이율(APR)을 넣으면 이자를 계산해요']);
      if (k === 'invest' && !(meta.holdings || []).some((x) => String(x.acct) === id) && bsA.has(id)) todo.push(['stocks', a.name, '보유 종목을 넣으면 시세로 평가해요']);
    });
    if (todo.length) {
      wrap.append(h('section', { class: 'card wl-card', id: 'wl-todo' },
        el('div', 'wl-head', el('div', 'ti', sectTitle('Set up checklist', '설정하면 좋은 것'))),
        el('div', 'wl-list', todo.slice(0, 8).map((t) => h('button', { type: 'button', class: 'wl-row', onclick: () => setTab(t[0]) },
          el('span', 'mid', el('span', 't', t[1]), el('span', 's', t[2])), goEl(TAB_LABEL[t[0]]))))));
    }

    // 계좌 목록
    const rowFor = (l, isLiab) => {
      const a = accMap.get(String(l.id));
      const k = a ? kindOf(a) : isLiab ? 'card' : 'other';
      const delta = L.round(l.amount - (prevMap.get(String(l.id)) || 0), 2);
      const tab = KIND_TAB[k];
      return h('button', {
        type: 'button', class: 'wl-row', 'data-acct': l.id, 'data-kind': k, 'data-go': tab || 'ledger',
        onclick: () => { if (tab) setTab(tab); else api.go('txns', { acct: String(l.id), query: '', kind: '' }); }
      },
      el('span', 'ico k-' + k, icon(KIND_ICON[k] || 'coin', 20)),
      el('span', 'mid', el('span', 't', a ? L.accLabel(a) : l.name), el('span', 's', KIND_LABEL[k] + (l.valued ? ' · 평가 반영' : ''))),
      el('span', 'amt', el('b', null, fmt(l.amount)), chg(delta, !isLiab)),
      goEl(tab ? TAB_LABEL[tab] : 'Ledger'));
    };
    const listCard = (id, en, ko, lines, total, isLiab) => h('section', { class: 'card wl-card wl-listcard', id },
      el('div', 'wl-head', el('div', 'ti', sectTitle(en, ko)), el('div', 'tr', el('b', null, fmt(total)))),
      lines.length ? el('div', 'wl-list', lines.slice().sort((a, b) => b.amount - a.amount).map((l) => rowFor(l, isLiab))) : el('div', 'wl-empty', '아직 없어요'));
    wrap.append(el('div', 'wl-cols',
      listCard('wl-list-assets', 'Assets', '자산', bs.assets, bs.totalAssets, false),
      listCard('wl-list-debts', 'Debts', '부채', bs.liabilities, bs.totalLiab, true)));
    return wrap;
  }

  // ═════════════════════ 자산 (집·차) ═════════════════════
  function assets() {
    const wrap = el('div', 'wl-stack');
    wrap.append(info('집·차 같은 고정자산의 가치를 ', h('b', null, '감가상각 · 상승률'), '로 계산해 재무상태표에 넣어요. 감정가나 시세를 아는 값을 ', h('b', null, '직접 입력 가치'), '에 넣으면 언제나 그 값이 우선이고, 지우면 공식으로 돌아가요.'));
    const list = accounts.filter((a) => a.type === 'ASSET' && (kindOf(a) === 'fixed' || meta.assets[String(a.account_id)] || ws.pick.assets === String(a.account_id)));
    if (!list.length) wrap.append(h('div', { class: 'card muted', id: 'wl-assets-empty' }, '집·차 계정이 아직 없어요. 아래에서 자산 계정을 골라 설정할 수 있어요.'));
    list.forEach((a) => wrap.append(assetCard(a)));
    const others = accounts.filter((a) => a.type === 'ASSET' && !list.includes(a));
    if (others.length) {
      const s = sel('wl-asset-pick', [['', 'Choose an account (계정 고르기)']].concat(others.map((a) => [a.account_id, L.accLabel(a)])), '');
      wrap.append(h('section', { class: 'card wl-card', id: 'wl-asset-add' },
        el('div', 'wl-head', el('div', 'ti', sectTitle('Asset setup', '자산 설정'), el('span', 'sub', '집·차가 아닌 다른 자산 계정도 가치를 직접 계산할 수 있어요 (예: 귀금속, 사업 지분)'))),
        el('div', 'wl-addrow', s, h('button', { type: 'button', class: 'btn secondary', id: 'wl-asset-add-btn', onclick: () => { if (!s.value) { api.toast('계정을 먼저 고르세요 (Choose an account)'); return; } ws.pick.assets = s.value; ws.edit['asset:' + s.value] = true; paint(); } }, icon('plus', 18), 'Add (추가)'))));
    }
    return wrap;
  }

  function assetCard(a) {
    const id = String(a.account_id), cfg = meta.assets[id] || null, key = 'asset:' + id;
    const book = bookOf(bsA.get(id));
    const editing = !!ws.edit[key];
    const card = h('section', { class: 'card wl-card', id: 'wl-asset-' + id, 'data-acct': id });
    const editBtn = editing ? null : h('button', { type: 'button', class: 'btn secondary sm', id: 'wl-a-edit-' + id, onclick: () => { ws.edit[key] = true; paint(); } }, icon('edit', 16), cfg ? 'Edit (수정)' : 'Set up (설정)');
    card.append(el('div', 'wl-head', el('div', 'ti', h('b', null, L.accLabel(a)), el('span', 'sub', acctSub(a) || KIND_LABEL[kindOf(a)])), editBtn));

    let calc = null;
    const curCfg = () => { if (form) { const r = F.checkAsset(form.read()); if (r.ok) return r.cfg; } return cfg; };
    let form = null;
    if (editing) {
      form = assetForm(a, cfg, book, () => { if (calc) calc.update(); });
      card.append(form.el);
    }
    if (!cfg) {
      if (!editing) card.append(el('div', 'wl-body-p', el('div', 'wl-kv', el('span', 'k', 'Book balance (장부 잔액)'), el('span', 'v', fmt(book))), note('아직 가치를 설정하지 않아서 거래 기록의 잔액을 그대로 써요. "Set up (설정)" 을 눌러 취득가와 감가·상승률을 넣어 보세요.')));
      if (editing) { calc = assetCalc(a, curCfg); card.append(calc.el); calc.update(); }
      return card;
    }
    // 숫자
    const val = V.assetValue(cfg, month), prev = V.assetValue(cfg, prevMonth);
    const ov = F.hasOverride(cfg);
    const monthly = val !== null && prev !== null ? L.round(val - prev, 2) : 0;
    const cost = Number(cfg.cost) || 0;
    const total = val !== null && cost ? L.round(val - cost, 2) : null;
    const how = ov ? 'Appraisal (직접 입력 가치) 사용 중' : F.METHOD_NAME[cfg.method || 'dep'] + (cfg.method === 'sl' ? ' · ' + cfg.life + '년' : ' · 연 ' + (cfg.rate || 0) + '%');
    const left = el('div', 'wl-col',
      el('div', 'wl-tiles',
        tile('Current value (현재 가치)', val === null ? '—' : fmt(val), val === null ? '취득일 전이에요' : how, 'big', 'wl-a-val-' + id),
        tile('This month (이번 달 변화)', ov ? '—' : h('span', null, chg(monthly, true)), ov ? '직접 입력 가치는 달마다 바뀌지 않아요' : '전월 ' + (prev === null ? '—' : fmt(prev)), '', 'wl-a-mon-' + id),
        tile('Since purchase (취득가 대비)', total === null ? '—' : h('span', null, chg(total, true), ' ', chgPct(val, cost, true)), cost ? '취득가 ' + fmt(cost) + (cfg.date ? ' · ' + cfg.date : '') : '취득가 없음', '', 'wl-a-tot-' + id),
        tile('Book balance (장부 잔액)', fmt(book), val === null ? '' : Math.abs(val - book) < 0.5 ? '평가와 같아요' : '평가와 차이 ' + fmt(Math.abs(val - book)) + ' → 자본의 평가 조정', '', 'wl-a-book-' + id)),
      ov ? note('감정가 ' + fmt(cfg.override) + ' 가 공식보다 우선해요. 공식으로 돌아가려면 "Edit (수정)" 에서 직접 입력 가치를 지우세요.') : null);
    calc = assetCalc(a, curCfg);
    const curve = F.assetCurve(cfg, month, 24, 60);
    const series = [];
    if (curve.canFormula) series.push({ key: 'f', name: ov ? 'Formula (공식 추정)' : 'Value (가치)', color: 'var(--c3)', values: curve.formula, area: !ov });
    if (ov) series.push({ key: 'o', name: 'From your value (직접 입력 가치에서)', color: 'var(--c1)', values: curve.cont, width: 2.5 });
    const allV = series.flatMap((x) => x.values).filter((v) => typeof v === 'number' && isFinite(v));
    const aMin = allV.length ? Math.max(0, Math.floor(Math.min(...allV) * 0.9 / 1000) * 1000) : 0;
    const chart = series.length
      ? track(lineChart({ yMin: aMin, title: L.accLabel(a) + ' value over time', labels: curve.labels.map(L.monthLabel), series, fmt: (n) => fmt(n), height: 240, smooth: true, forecastFrom: curve.nowIndex + 1, selected: curve.nowIndex }))
      : el('div', 'wl-empty', '취득가를 넣으면 가치 추이 그래프를 그려요');
    const right = el('div', 'wl-col', el('div', 'wl-sub', 'Value over time (가치 추이) · 과거 2년 ~ 앞으로 5년'), el('div', 'wl-chart', chart), calc.el);
    card.append(el('div', 'wl-inner', left, right));
    calc.update();
    return card;
  }

  // "N년 뒤 가치" 계산기
  function assetCalc(a, getCfg) {
    const id = String(a.account_id);
    const years = h('input', { type: 'text', id: 'wl-a-' + id + '-yr', inputmode: 'decimal', value: String(ws.years[id] === undefined ? 5 : ws.years[id]), 'aria-label': 'Years from now (몇 년 뒤)', autocomplete: 'off' });
    const range = h('input', { type: 'range', id: 'wl-a-' + id + '-yr-range', min: 0, max: 40, step: 1, value: String(Math.min(40, Number(years.value) || 0)), 'aria-label': 'Years slider (년 슬라이더)' });
    const out = h('div', { class: 'wl-calc-out', id: 'wl-a-' + id + '-out', 'aria-live': 'polite' });
    function update() {
      const c = getCfg();
      const y = F.parseNum(years.value);
      out.replaceChildren();
      if (!c) { out.append(el('div', 'wl-empty', '먼저 위에서 설정을 저장하면 계산해 드려요')); return; }
      if (y === null || Number.isNaN(y) || y < 0 || y > 100) { out.append(el('div', 'wl-err-s', '0~100 사이의 숫자(년)를 입력하세요')); return; }
      ws.years[id] = y;
      const now = V.assetValue(c, month), then = F.projectAsset(c, month, y);
      if (then === null) { out.append(el('div', 'wl-empty', '그 시점에는 아직 취득 전이에요')); return; }
      const when = L.monthLabel(V.addMonths(month, Math.round(y * 12)));
      out.append(...[el('div', 'big', fmt(then)), el('div', 's', when + ' 기준'),
        now === null ? null : el('div', 'chgs', chg(then - now, true), ' ', chgPct(then, now, true), el('span', 'muted', ' 지금 ' + fmt(now) + ' 대비')),
        F.hasOverride(c) ? el('div', 's', '직접 입력 가치에서 같은 비율로 이어서 계산했어요') : null].filter(Boolean));
    }
    years.addEventListener('input', () => { const v = F.parseNum(years.value); if (v !== null && !Number.isNaN(v)) range.value = String(Math.min(40, Math.max(0, v))); update(); });
    range.addEventListener('input', () => { years.value = range.value; update(); });
    const chips = el('div', 'wl-chips', [1, 3, 5, 10, 20].map((n) => h('button', { type: 'button', class: 'chipf', 'data-y': n, onclick: () => { years.value = String(n); range.value = String(n); update(); } }, n + '년')));
    const box = el('div', 'wl-calc', el('div', 'wl-sub', 'Value in N years (N년 뒤 가치)'),
      el('div', 'wl-calc-row', range, el('div', 'wl-yrbox', years, el('span', null, '년'))), chips, out);
    return { el: box, update };
  }

  function assetForm(a, cfg, book, onPreview) {
    const id = String(a.account_id), key = 'asset:' + id;
    const car = looksLikeCar(a);
    const init = cfg || { method: car ? 'dep' : 'ap', cost: book > 0 ? book : '', date: '', rate: car ? 15 : 3, salvage: 0, life: car ? 8 : 40 };
    const d = {
      method: init.method || 'dep', cost: init.cost === undefined ? '' : init.cost, date: init.date || '', rate: init.rate === undefined ? '' : init.rate,
      salvage: init.salvage === undefined ? '' : init.salvage, life: init.life === undefined ? '' : init.life, override: F.hasOverride(init) ? init.override : ''
    };
    const pre = (n) => 'wl-a-' + id + '-' + n;
    const I = {
      cost: inp(pre('cost'), d.cost, { ph: '예: 650000', label: 'Purchase price (취득가)' }),
      date: inp(pre('date'), d.date, { type: 'date', label: 'Purchase date (취득일)' }),
      rate: inp(pre('rate'), d.rate, { ph: '예: 15', label: 'Rate % per year (연 %)' }),
      salvage: inp(pre('salvage'), d.salvage, { ph: '예: 3000', label: 'Salvage value (잔존가)' }),
      life: inp(pre('life'), d.life, { ph: '예: 8', label: 'Useful life years (내용연수)' }),
      override: inp(pre('override'), d.override, { ph: '비워 두면 공식으로 계산', label: 'Your own value (직접 입력 가치)' })
    };
    const fields = {
      cost: field('Purchase price (취득가) $', I.cost), date: field('Purchase date (취득일)', I.date),
      rate: field('Rate per year (연 %)', I.rate, null, 'f-rate'), salvage: field('Salvage value (잔존가) $', I.salvage, '다 쓴 뒤에도 남는 값', 'f-salvage'),
      life: field('Useful life (내용연수, 년)', I.life, '이 기간에 걸쳐 같은 금액씩 줄어요', 'f-life')
    };
    const clearBtn = h('button', { type: 'button', class: 'btn secondary sm', id: pre('override-clear'), onclick: () => { I.override.value = ''; refresh(); } }, 'Clear (지우기)');
    const ovField = h('div', { class: 'field wl-f wl-ov' }, el('span', 'lbl', 'Your own value (직접 입력 가치) $'), el('div', 'wl-ovrow', I.override, clearBtn),
      el('span', 'hint', '감정가·시세를 알면 넣으세요. 넣으면 공식보다 항상 우선이에요. 지우면 공식으로 돌아가요.'));
    const methodHint = el('div', 'hint wl-mhint');
    const segEl = el('div', 'seg three-seg wl-methods', F.METHODS.map((m) => h('button', {
      type: 'button', id: pre('m-' + m[0]), 'data-m': m[0], class: d.method === m[0] ? 'on' : '', onclick: () => { d.method = m[0]; paintMethod(); refresh(); }
    }, m[1], el('span', 'ko', ' ' + m[2]))));
    const err = h('div', { class: 'err', id: pre('err'), role: 'alert' });
    const pv = h('div', { class: 'wl-preview', id: pre('pv'), 'aria-live': 'polite' });
    function paintMethod() {
      segEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-m') === d.method));
      fields.rate.hidden = d.method === 'sl'; fields.salvage.hidden = d.method === 'ap'; fields.life.hidden = d.method !== 'sl';
      methodHint.textContent = d.method === 'dep' ? '해마다 남은 가치의 일정 %가 줄어요 (자동차에 많이 써요). 예: 연 15%.'
        : d.method === 'sl' ? '내용연수 동안 취득가에서 잔존가까지 매년 같은 금액이 줄어요.' : '해마다 가치가 일정 % 올라요 (집값 상승). 예: 연 3%.';
      fields.rate.querySelector('.lbl').textContent = d.method === 'ap' ? 'Appreciation per year (연 상승 %)' : 'Decline per year (연 감가 %)';
    }
    const read = () => ({ method: d.method, cost: I.cost.value, date: I.date.value, rate: I.rate.value, salvage: I.salvage.value, life: I.life.value, override: I.override.value });
    function refresh() {
      const r = F.checkAsset(read());
      markBad(I, r.errors);
      pv.replaceChildren();
      if (r.ok) {
        const now = V.assetValue(r.cfg, month), later = F.projectAsset(r.cfg, month, 5);
        pv.append(el('b', null, 'Preview (미리보기): '), '지금 ', el('b', null, now === null ? '—' : fmt(now)), ' · 5년 뒤 ', el('b', null, later === null ? '—' : fmt(later)));
        err.textContent = '';
      }
      if (onPreview) onPreview();
    }
    Object.keys(I).forEach((k) => I[k].addEventListener('input', refresh));
    let confirmDel = false;
    const delBtn = cfg ? h('button', { type: 'button', class: 'btn danger', id: pre('remove'), onclick: () => {
      if (!confirmDel) { confirmDel = true; delBtn.textContent = 'Tap again to remove (한 번 더 누르면 삭제)'; return; }
      const assetsMap = Object.assign({}, api.meta().assets); delete assetsMap[id];
      ws.edit[key] = false;
      save(rowOf(M.KEYS_META.assets, assetsMap, 'assets'), '자산 설정을 지웠어요. 장부 잔액을 다시 써요.', delBtn);
    } }, icon('trash', 16), 'Remove setup (설정 삭제)') : null;
    const el_ = h('div', { class: 'wl-form', id: pre('form') },
      el('div', 'wl-sub', cfg ? 'Edit valuation (가치 설정 수정)' : 'Set up valuation (가치 설정)'),
      segEl, methodHint,
      el('div', 'two wl-two', fields.cost, fields.date), el('div', 'two wl-two', fields.rate, fields.salvage, fields.life), ovField, pv, err,
      el('div', 'btnrow',
        h('button', { type: 'button', class: 'btn', id: pre('save'), onclick: (e) => {
          const r = F.checkAsset(read());
          markBad(I, r.errors);
          if (!r.ok) { err.textContent = r.first; return; }
          err.textContent = '';
          const assetsMap = Object.assign({}, api.meta().assets); assetsMap[id] = r.cfg;
          ws.edit[key] = false; ws.pick.assets = ws.pick.assets === id ? '' : ws.pick.assets;
          save(rowOf(M.KEYS_META.assets, assetsMap, 'assets'), '저장했어요. 재무상태표에 반영됩니다.', e.currentTarget);
        } }, icon('check', 18), 'Save (저장)'),
        h('button', { type: 'button', class: 'btn secondary', id: pre('cancel'), onclick: () => { ws.edit[key] = false; if (ws.pick.assets === id && !cfg) ws.pick.assets = ''; paint(); } }, 'Cancel (취소)'),
        delBtn));
    paintMethod();
    refresh();
    return { el: el_, read };
  }

  // ═════════════════════ 대출 ═════════════════════
  function loans() {
    const wrap = el('div', 'wl-stack');
    wrap.append(info('모기지·할부 같은 대출은 ', h('b', null, '원금 · 월 납입액 · 이율 · 횟수'), '를 넣으면 상환표를 만들어요. 재무상태표는 ', h('b', null, '상환표 잔액'), '을 쓰고, 장부(거래 기록) 잔액과 다르면 그 차이는 자본의 평가 조정으로 표시돼요.'));
    const list = accounts.filter((a) => a.type === 'LIABILITY' && (kindOf(a) === 'loan' || meta.loans[String(a.account_id)] || ws.pick.loans === String(a.account_id)));
    if (!list.length) wrap.append(h('div', { class: 'card muted', id: 'wl-loans-empty' }, '대출 계정이 아직 없어요. 아래에서 다른 부채 계정을 대출로 설정할 수 있어요.'));
    list.forEach((a) => wrap.append(loanCard(a)));
    const others = accounts.filter((a) => a.type === 'LIABILITY' && kindOf(a) !== 'clearing' && !list.includes(a));
    if (others.length) {
      const s = sel('wl-loan-pick', [['', 'Choose an account (계정 고르기)']].concat(others.map((a) => [a.account_id, L.accLabel(a)])), '');
      wrap.append(h('section', { class: 'card wl-card', id: 'wl-loan-add' },
        el('div', 'wl-head', el('div', 'ti', sectTitle('Add another loan', '다른 계정을 대출로 추가'), el('span', 'sub', '카드·한도 계정이라도 매달 같은 금액을 내는 할부라면 여기서 설정할 수 있어요'))),
        el('div', 'wl-addrow', s, h('button', { type: 'button', class: 'btn secondary', id: 'wl-loan-add-btn', onclick: () => { if (!s.value) { api.toast('계정을 먼저 고르세요 (Choose an account)'); return; } ws.pick.loans = s.value; ws.edit['loan:' + s.value] = true; paint(); } }, icon('plus', 18), 'Add (추가)'))));
    }
    return wrap;
  }

  function loanCard(a) {
    const id = String(a.account_id), cfg = meta.loans[id] || null, key = 'loan:' + id;
    const apr = Number(meta.debts[id] && meta.debts[id].apr) || 0;
    const line = bsL.get(id);
    const book = bookOf(line);
    const editing = !!ws.edit[key];
    const ready = V.loanReady(cfg);
    const card = h('section', { class: 'card wl-card', id: 'wl-loan-' + id, 'data-acct': id });
    const editBtn = editing ? null : h('button', { type: 'button', class: 'btn secondary sm', id: 'wl-l-edit-' + id, onclick: () => { ws.edit[key] = true; paint(); } }, icon('edit', 16), cfg ? 'Edit (수정)' : 'Set up (설정)');
    card.append(el('div', 'wl-head', el('div', 'ti', h('b', null, L.accLabel(a)), el('span', 'sub', acctSub(a) || KIND_LABEL[kindOf(a)])), editBtn));
    if (editing) card.append(loanForm(a, cfg, apr, book));
    if (!ready) {
      if (!editing) card.append(el('div', 'wl-body-p', kv('Book balance (장부 잔액)', fmt(book)), note('아직 상환표를 설정하지 않아서 거래 기록의 잔액을 그대로 써요. "Set up (설정)" 을 눌러 원금·납입액·이율을 넣어 보세요.')));
      return card;
    }
    const start = cfg.start.slice(0, 7);
    const started = month >= start;
    const sched = V.loanBalance(cfg, apr, month);
    const diff = sched === null ? 0 : L.round(book - sched, 2);
    const split = V.loanSplit(cfg, apr, month);
    const k = V.loanPayoffK(cfg, apr);
    const under = V.loanUnderwater(cfg, apr);
    const endYm = V.loanEnd(cfg, apr);
    const totalInt = V.loanTotalInterest(cfg, apr);
    const done = V.paymentsBy(cfg.start, month);
    const remainK = k === null ? null : Math.max(0, k - Math.max(0, done));
    const rem = F.remainingLoan(cfg, apr, month);
    const remInt = rem ? V.loanTotalInterest(rem, apr) : 0;
    const rows = V.amortization(cfg, apr);
    const yearly = V.amortYearly(rows);

    const tiles = el('div', 'wl-tiles',
      tile('Schedule balance (상환표 잔액)', sched === null ? '—' : fmt(sched), started ? L.monthLabel(month) + ' 말 기준' : L.monthLabel(start) + ' 부터 시작해요', 'big', 'wl-l-sched-' + id),
      tile('Book balance (장부 잔액)', fmt(book), '거래 기록 기준', '', 'wl-l-book-' + id),
      tile('Monthly payment (월 납입액)', fmt(cfg.pmt), '이율 ' + apr + '% · ' + cfg.months + '회', '', 'wl-l-pmt-' + id),
      tile('Payoff (완납 예정)', under || !endYm ? '—' : L.monthLabel(endYm), under || remainK === null ? '' : remainK > 0 ? '앞으로 ' + F.yrMo(remainK) : '모두 갚았어요', '', 'wl-l-end-' + id));
    const explain = !started ? note('첫 납입 달(' + L.monthLabel(start) + ') 전이라서 지금은 장부 잔액을 써요.')
      : Math.abs(diff) < 0.5 ? note('장부 잔액과 상환표 잔액이 같아요.')
        : el('div', 'wl-diff', el('b', null, '재무상태표는 상환표 잔액을 씁니다'), ' · 차이 ', chg(diff, true), ' 는 자본의 "평가 조정" 으로 표시돼요.',
          note(diff > 0 ? '장부 잔액이 더 커요: 납입을 비용으로만 적었거나 원금 상환이 장부에 아직 안 들어갔을 수 있어요.' : '장부 잔액이 더 작아요: 장부에 이미 더 많이 갚은 것으로 기록돼 있어요.'));
    const monthBox = split && split.payment ? el('div', 'wl-splitbox', el('div', 'wl-sub', 'This month\'s payment (이번 달 납입액)'),
      el('div', 'wl-split', h('span', { class: 'i', style: 'flex:' + Math.max(split.interest, 0.0001) }), h('span', { class: 'p', style: 'flex:' + Math.max(split.principal, 0.0001) })),
      el('div', 'wl-split-l', el('span', null, el('i', 'sw i'), 'Interest (이자) ', el('b', null, fmt(split.interest))), el('span', null, el('i', 'sw p'), 'Principal (원금) ', el('b', null, fmt(split.principal))), el('span', null, 'Total ', el('b', null, fmt(split.payment))))) : null;
    const warnBox = [];
    if (under) warnBox.push(warn('월 납입액이 이자(약 ' + fmt(L.round(cfg.p * apr / 100 / 12, 2)) + ')도 못 덮어서 잔액이 줄지 않아요. 납입액이나 이율을 확인하세요.'));
    else { const left = V.loanBalanceAt(cfg, apr, V.loanTerm(cfg) || 600); if (V.loanTerm(cfg) && left > 0.5) warnBox.push(warn('정해진 ' + cfg.months + '회 안에 다 갚지 못하고 마지막에 ' + fmt(L.round(left, 2)) + ' 가 남아요.')); }
    const costs = el('div', 'wl-tiles two',
      tile('Total interest (전체 이자)', under || totalInt === null ? '—' : fmt(totalInt), '대출을 다 갚을 때까지', '', 'wl-l-tint-' + id),
      tile('Interest still to pay (앞으로 낼 이자)', under || !rem ? '—' : fmt(remInt), rem ? '지금부터 완납까지' : '남은 이자 없음', '', 'wl-l-rint-' + id));

    const left = el('div', 'wl-col', tiles, explain, monthBox, warnBox, costs, whatIfBox(a, cfg, apr));
    // 차트
    const years = yearly.map((y) => y.year);
    const curYear = month.slice(0, 4);
    const bars = barChart({
      title: L.accLabel(a) + ' payments by year', labels: years, mode: 'stacked', height: 240, fmt: (n) => fmt(n),
      series: [{ key: 'pr', name: 'Principal (원금)', color: 'var(--c1)', values: yearly.map((y) => y.principal) }, { key: 'in', name: 'Interest (이자)', color: 'var(--c4)', values: yearly.map((y) => y.interest) }],
      selected: years.indexOf(curYear) >= 0 ? years.indexOf(curYear) : undefined,
      onSelect: (i) => { const tr = card.querySelectorAll('.wl-ytbl tbody tr'); tr.forEach((r, j) => r.classList.toggle('on', j === i)); }
    });
    track(bars);
    const balLabels = ['Start'].concat(years);
    const ffIdx = years.findIndex((y) => y > curYear);
    const balChart = track(lineChart({
      title: L.accLabel(a) + ' balance by year', labels: balLabels, height: 200, smooth: true, fmt: (n) => fmt(n),
      series: [{ key: 'b', name: 'Balance (잔액)', color: 'var(--c2)', area: true, values: [cfg.p].concat(yearly.map((y) => y.endBalance)) }],
      forecastFrom: ffIdx > 0 ? ffIdx + 1 : undefined
    }));
    const yTable = h('table', { class: 'wl-tbl wl-ytbl' }, h('thead', null, h('tr', null, ['Year (연도)', 'Interest (이자)', 'Principal (원금)', 'Balance (잔액)'].map((t, i) => h('th', { class: i ? 'r' : '' }, t)))),
      h('tbody', null, yearly.map((y) => h('tr', { class: y.year === curYear ? 'on' : '' }, h('td', null, y.year), h('td', { class: 'r' }, fmt(y.interest)), h('td', { class: 'r' }, fmt(y.principal)), h('td', { class: 'r' }, fmt(y.endBalance))))));
    const det = h('details', { class: 'wl-det', id: 'wl-l-monthly-' + id }, h('summary', null, 'Monthly schedule (월별 상환표) · ' + rows.length + '회'));
    let filled = false;
    det.addEventListener('toggle', () => {
      if (!det.open || filled) return;
      filled = true;
      const curK = Math.max(1, done);
      det.append(el('div', 'wl-tblwrap', h('table', { class: 'wl-tbl' }, h('thead', null, h('tr', null, ['#', 'Month (달)', 'Payment (납입)', 'Interest (이자)', 'Principal (원금)', 'Balance (잔액)'].map((t, i) => h('th', { class: i > 1 ? 'r' : '' }, t)))),
        h('tbody', null, rows.map((r) => h('tr', { class: r.k === curK ? 'on' : '' }, h('td', null, r.k), h('td', null, r.ym), h('td', { class: 'r' }, fmt(r.payment)), h('td', { class: 'r' }, fmt(r.interest)), h('td', { class: 'r' }, fmt(r.principal)), h('td', { class: 'r' }, fmt(r.balance))))))));
    });
    const right = el('div', 'wl-col',
      el('div', 'wl-sub', 'Principal vs interest by year (연도별 원금·이자)'), el('div', 'wl-chart', bars),
      el('div', 'wl-sub', 'Remaining balance (남은 잔액)'), el('div', 'wl-chart', balChart),
      el('div', 'wl-sub', 'By year (연도별 요약) · 막대를 누르면 해당 연도가 표시돼요'), el('div', 'wl-tblwrap', yTable), det);
    card.append(el('div', 'wl-inner', left, right));
    return card;
  }

  // What-if: 매달 +$X
  function whatIfBox(a, cfg, apr) {
    const id = String(a.account_id);
    const inpEl = h('input', { type: 'text', id: 'wl-l-' + id + '-extra', inputmode: 'decimal', placeholder: '예: 200', value: ws.extra[id] === undefined ? '' : String(ws.extra[id]), autocomplete: 'off', 'aria-label': 'Extra per month (매달 추가 상환)' });
    const out = h('div', { class: 'wl-whatif-out', id: 'wl-l-' + id + '-wi', 'aria-live': 'polite' });
    function update() {
      const v = F.parseNum(inpEl.value);
      out.replaceChildren();
      if (v === null) { out.append(el('div', 'muted', '금액을 넣거나 아래 버튼을 눌러 보세요. (저장되지 않는 계산이에요)')); return; }
      if (Number.isNaN(v) || v < 0 || v > 1e7) { out.append(el('div', 'wl-err-s', '0 이상의 금액을 입력하세요 (예: 200)')); return; }
      ws.extra[id] = inpEl.value;
      const w = F.whatIf(cfg, apr, month, v);
      if (!w) { out.append(el('div', 'muted', '이미 다 갚았어요')); return; }
      if (w.base.under) { out.append(warn('지금 납입액은 이자도 못 덮어요. 먼저 납입액이나 이율을 확인하세요.')); return; }
      if (w.plus.under) { out.append(warn('추가 금액을 더해도 이자를 못 덮어요.')); return; }
      if (v === 0) { out.append(el('div', 'muted', '지금처럼 내면 ' + (w.base.end ? L.monthLabel(w.base.end) : '—') + ' 에 끝나고, 앞으로 이자 ' + fmt(w.base.interest) + ' 를 내요.')); return; }
      out.append(el('div', 'wl-win', icon('check', 18), el('div', null, '완납이 ', el('b', null, F.yrMo(w.savedMonths) + ' 빨라지고'), ', 이자 ', el('b', null, fmt(w.savedInterest)), ' 를 아껴요.')),
        el('div', 'wl-cmp', el('span', null, '지금: ' + (w.base.end ? L.monthLabel(w.base.end) : '—') + ' · 이자 ' + fmt(w.base.interest)), el('span', null, '+' + fmt(v) + '/월: ' + (w.plus.end ? L.monthLabel(w.plus.end) : '—') + ' · 이자 ' + fmt(w.plus.interest))));
    }
    inpEl.addEventListener('input', update);
    const chips = el('div', 'wl-chips', [100, 250, 500, 1000].map((n) => h('button', { type: 'button', class: 'chipf', 'data-x': n, onclick: () => { inpEl.value = String(n); update(); } }, '+$' + n.toLocaleString('en-US'))));
    const box = el('div', 'wl-whatif', el('div', 'wl-sub', 'What if I pay more? (추가 상환하면?)'),
      el('div', 'wl-hint2', '다음 납입부터 매달 더 내면 완납이 얼마나 빨라지는지 계산해요.'),
      el('div', 'wl-extra', el('span', null, '+$'), inpEl, el('span', null, '/ month (매달)')), chips, out);
    update();
    return box;
  }

  function loanForm(a, cfg, apr, book) {
    const id = String(a.account_id), key = 'loan:' + id;
    const pre = (n) => 'wl-l-' + id + '-' + n;
    const nowStart = month;
    const I = {
      p: inp(pre('p'), cfg ? cfg.p : (book > 0 ? book : ''), { ph: '예: 386200', label: 'Principal (원금)' }),
      pmt: inp(pre('pmt'), cfg ? cfg.pmt : '', { ph: '예: 2150', label: 'Monthly payment (월 납입액)' }),
      start: inp(pre('start'), cfg ? cfg.start : nowStart, { type: 'month', label: 'First payment month (첫 납입 달)' }),
      months: inp(pre('months'), cfg ? cfg.months : '', { ph: '예: 300', label: 'Number of payments (총 납입 횟수)' }),
      apr: inp(pre('apr'), cfg || apr ? apr : '', { ph: '예: 4.79', label: 'APR % (연 이율)' })
    };
    const helper = h('div', { class: 'wl-helper', id: pre('helper'), 'aria-live': 'polite' });
    const err = h('div', { class: 'err', id: pre('err'), role: 'alert' });
    const pv = h('div', { class: 'wl-preview', id: pre('pv'), 'aria-live': 'polite' });
    const read = () => ({ p: I.p.value, pmt: I.pmt.value, start: I.start.value, months: I.months.value, apr: I.apr.value });
    function refresh() {
      const r = F.checkLoan(read());
      markBad(I, r.errors);
      pv.replaceChildren();
      if (r.ok) {
        const end = V.loanEnd(r.cfg, r.apr), ti = V.loanTotalInterest(r.cfg, r.apr);
        const under = V.loanUnderwater(r.cfg, r.apr);
        pv.append(el('b', null, 'Preview (미리보기): '), under ? '납입액이 이자를 못 덮어요' : '완납 ' + (end ? L.monthLabel(end) : '—') + ' · 전체 이자 ' + (ti === null ? '—' : fmt(ti)));
        r.warnings.forEach((w) => pv.append(el('div', 'wl-err-s', w)));
        err.textContent = '';
      }
    }
    Object.keys(I).forEach((k) => I[k].addEventListener('input', refresh));
    const calcPmt = h('button', { type: 'button', class: 'btn secondary sm', id: pre('calc-pmt'), onclick: () => {
      const p = F.parseNum(I.p.value), ap = F.parseNum(I.apr.value), n = F.parseNum(I.months.value);
      if (!(p > 0) || ap === null || Number.isNaN(ap) || !(n >= 1)) { helper.textContent = '월 납입액을 계산하려면 원금 · 이율 · 총 납입 횟수를 먼저 넣으세요.'; helper.className = 'wl-helper bad'; return; }
      const v = F.r2(V.loanPayment(p, ap, Math.round(n)));
      I.pmt.value = String(v); helper.className = 'wl-helper'; helper.textContent = '원금 ' + fmt(p) + ' · 이율 ' + ap + '% · ' + Math.round(n) + '회 → 월 납입액 ' + fmt(v) + ' 를 넣었어요.'; refresh();
    } }, icon('spark', 16), 'Calculate payment (월 납입액 계산)');
    const calcRate = h('button', { type: 'button', class: 'btn secondary sm', id: pre('calc-rate'), onclick: () => {
      const p = F.parseNum(I.p.value), pm = F.parseNum(I.pmt.value), n = F.parseNum(I.months.value);
      if (!(p > 0) || !(pm > 0) || !(n >= 1)) { helper.textContent = '이율을 거꾸로 구하려면 원금 · 월 납입액 · 총 납입 횟수를 먼저 넣으세요.'; helper.className = 'wl-helper bad'; return; }
      const v = V.loanRate(p, pm, Math.round(n));
      if (!(v > 0)) { helper.textContent = '납입액 × 횟수(' + fmt(pm * Math.round(n)) + ')가 원금(' + fmt(p) + ')보다 크지 않아서 이율을 구할 수 없어요. 이자가 없다면 0 을 넣으세요.'; helper.className = 'wl-helper bad'; return; }
      I.apr.value = String(v); helper.className = 'wl-helper'; helper.textContent = '원금 ' + fmt(p) + ' · 월 ' + fmt(pm) + ' · ' + Math.round(n) + '회 → 이율 약 ' + v + '% 를 넣었어요.'; refresh();
    } }, icon('spark', 16), 'Solve rate (금리 역산)');
    let confirmDel = false;
    const delBtn = cfg ? h('button', { type: 'button', class: 'btn danger', id: pre('remove'), onclick: () => {
      if (!confirmDel) { confirmDel = true; delBtn.textContent = 'Tap again to remove (한 번 더 누르면 삭제)'; return; }
      const m = Object.assign({}, api.meta().loans); delete m[id];
      ws.edit[key] = false;
      save(rowOf(M.KEYS_META.loans, m, 'loans'), '상환표 설정을 지웠어요. 장부 잔액을 다시 써요.', delBtn);
    } }, icon('trash', 16), 'Remove setup (설정 삭제)') : null;
    return h('div', { class: 'wl-form', id: pre('form') },
      el('div', 'wl-sub', cfg ? 'Edit loan (대출 수정)' : 'Set up loan (대출 설정)'),
      el('div', 'hint wl-mhint', '원금은 첫 납입 직전의 대출 잔액이에요. 이미 몇 번 낸 대출이라면 "지금 남은 금액 · 다음 납입 달 · 남은 횟수"를 넣어도 돼요.'),
      el('div', 'two wl-two', field('Principal (원금) $', I.p), field('Monthly payment (월 납입액) $', I.pmt)),
      el('div', 'two wl-two', field('APR (연 이율 %)', I.apr), field('Payments (총 납입 횟수)', I.months, '25년 = 300회')),
      field('First payment month (첫 납입 달)', I.start),
      el('div', 'btnrow wl-helpers', calcPmt, calcRate), helper, pv, err,
      el('div', 'btnrow',
        h('button', { type: 'button', class: 'btn', id: pre('save'), onclick: (e) => {
          const r = F.checkLoan(read());
          markBad(I, r.errors);
          if (!r.ok) { err.textContent = r.first; return; }
          err.textContent = '';
          const cur = api.meta();
          const loansMap = Object.assign({}, cur.loans); loansMap[id] = r.cfg;
          const debtsMap = Object.assign({}, cur.debts); debtsMap[id] = Object.assign({}, debtsMap[id], { apr: r.apr });
          ws.edit[key] = false; if (ws.pick.loans === id) ws.pick.loans = '';
          save([rowOf(M.KEYS_META.loans, loansMap, 'loans'), rowOf(M.KEYS_META.debts, debtsMap, 'debts')], '저장했어요. 재무상태표에 반영됩니다.', e.currentTarget);
        } }, icon('check', 18), 'Save (저장)'),
        h('button', { type: 'button', class: 'btn secondary', id: pre('cancel'), onclick: () => { ws.edit[key] = false; if (ws.pick.loans === id && !cfg) ws.pick.loans = ''; paint(); } }, 'Cancel (취소)'),
        delBtn));
  }

  // ═════════════════════ 부채 ═════════════════════
  function debts() {
    const wrap = el('div', 'wl-stack');
    const debtMap = new Map(ctx.debts.map((d) => [String(d.id), d]));
    const liabs = accounts.filter((a) => a.type === 'LIABILITY' && kindOf(a) !== 'clearing');
    const rows = liabs.map((a) => {
      const id = String(a.account_id);
      const d = debtMap.get(id);
      if (d) return Object.assign({}, d, { a });
      const dd = meta.debts[id] || {};
      return { a, id, name: a.name, name_ko: a.name_ko, kind: kindOf(a), balance: 0, apr: Number(dd.apr) || 0, limit: Number(dd.limit) || 0, min: Number(dd.min) || 0, util: null, monthlyInterest: 0, hasApr: Number(dd.apr) > 0 };
    });
    const live = ctx.debts;
    const totalBal = L.round(live.reduce((s, d) => s + d.balance, 0), 2);
    const mInt = L.round(live.reduce((s, d) => s + d.monthlyInterest, 0), 2);
    const withApr = live.filter((d) => d.hasApr);
    const wApr = withApr.length ? L.round(withApr.reduce((s, d) => s + d.apr * d.balance, 0) / withApr.reduce((s, d) => s + d.balance, 0), 2) : 0;
    const missing = live.filter((d) => !d.hasApr && d.balance > 0.005);
    const credit = live.filter((d) => (d.kind === 'card' || d.kind === 'loc') && d.limit > 0);
    const credBal = credit.reduce((s, d) => s + d.balance, 0), credLim = credit.reduce((s, d) => s + d.limit, 0);
    const credUtil = credLim > 0 ? L.round(credBal / credLim * 100, 1) : null;

    wrap.append(h('section', { class: 'card wl-card', id: 'wl-debt-sum' },
      el('div', 'wl-head', el('div', 'ti', sectTitle('Debt cost', '부채 비용'), el('span', 'sub', L.monthLabel(month) + ' 잔액 기준 · 이자 = 잔액 × 이율 ÷ 12'))),
      el('div', 'wl-tiles',
        tile('Total debt (총 부채)', fmt(totalBal), live.length + '개 부채', 'big', 'wl-d-total'),
        tile('Interest per month (월 이자 추정)', fmt(mInt), withApr.length ? '가중 평균 이율 ' + wApr + '%' : '이율을 넣으면 계산해요', '', 'wl-d-mint'),
        tile('Interest per year (연 환산)', fmt(L.round(mInt * 12, 2)), '이자로만 나가는 돈', '', 'wl-d-yint'),
        tile('Card use (카드·한도 사용률)', credUtil === null ? '—' : pct(credUtil), credUtil === null ? '한도를 넣으면 계산해요' : credUtil < 30 ? '좋아요 (30% 미만)' : credUtil < 60 ? '조금 높아요' : '높아요 (60% 이상)', credUtil === null ? '' : 'u-' + F.utilLevel(credUtil), 'wl-d-util')),
      missing.length ? note(missing.length + '개 부채(' + missing.slice(0, 3).map((d) => d.name).join(', ') + (missing.length > 3 ? ' 외' : '') + ')는 이율을 아직 안 넣어서 이자 합계에 빠져 있어요.') : null));

    const hot = withApr.filter((d) => d.balance > 0.005).sort((a, b) => b.apr - a.apr || b.balance - a.balance)[0];
    if (hot) {
      wrap.append(h('section', { class: 'card wl-card wl-hot', id: 'wl-d-hot' },
        el('div', 'wl-head', el('div', 'ti', sectTitle('Costliest debt', '가장 비싼 부채'))),
        el('div', 'wl-hotbody', el('b', null, hot.name), ' — 연 ', el('b', null, pct(hot.apr, 2)), ', 잔액 ', fmt(hot.balance), ', 한 달 이자 약 ', el('b', null, fmt(hot.monthlyInterest))),
        note('여유 돈이 생기면 이율이 가장 높은 이 부채부터 갚는 게 이자를 가장 많이 아껴요 (눈사태 방식).'),
        h('button', { type: 'button', class: 'btn', id: 'wl-d-plan', onclick: () => api.go('plan') }, icon('plan', 18), 'Payoff simulator in Plan (부채 상환 계획) ›')));
    } else {
      wrap.append(h('section', { class: 'card wl-card', id: 'wl-d-hot' }, el('div', 'wl-hotbody muted', '이율을 넣으면 가장 비싼 부채와 갚는 순서를 알려 드려요.'),
        h('button', { type: 'button', class: 'btn secondary', id: 'wl-d-plan', onclick: () => api.go('plan') }, icon('plan', 18), 'Plan (부채 상환 계획) ›')));
    }
    const hrows = withApr.filter((d) => d.monthlyInterest > 0.004).sort((a, b) => b.monthlyInterest - a.monthlyInterest).map((d) => ({ key: d.id, name: d.name, value: d.monthlyInterest, sub: pct(d.apr, 2) + ' on ' + fmt(d.balance) }));
    if (hrows.length > 1) wrap.append(h('section', { class: 'card wl-card', id: 'wl-d-hb' }, el('div', 'wl-head', el('div', 'ti', sectTitle('Interest by debt', '부채별 월 이자'))), track(hbars({ fmt: (n) => fmt(n), rows: hrows }))));

    const grid = el('div', 'wl-debtgrid');
    rows.sort((x, y) => ((y.balance > 0.005) - (x.balance > 0.005)) || (y.apr - x.apr) || (y.balance - x.balance));
    rows.forEach((d) => grid.append(debtCard(d)));
    if (!rows.length) grid.append(el('div', 'card muted', '카드·대출 계정이 아직 없어요.'));
    wrap.append(grid);
    return wrap;
  }

  function debtCard(d) {
    const id = String(d.a.account_id), key = 'debt:' + id;
    const editing = !!ws.edit[key];
    const isLoan = d.kind === 'loan' && meta.loans[id];
    const lvl = F.utilLevel(d.util);
    const card = h('section', { class: 'card wl-card wl-debt', id: 'wl-debt-' + id, 'data-acct': id, 'data-kind': d.kind });
    card.append(el('div', 'wl-head',
      el('div', 'ti', h('b', null, L.accLabel(d.a)), el('span', 'sub', KIND_LABEL[d.kind] + (acctSub(d.a) ? ' · ' + acctSub(d.a) : ''))),
      editing ? null : h('button', { type: 'button', class: 'btn secondary sm', id: 'wl-d-edit-' + id, onclick: () => { ws.edit[key] = true; paint(); } }, icon('edit', 16), 'Edit (수정)')));
    card.append(el('div', 'wl-debt-main', el('div', 'bal', fmt(d.balance)),
      el('div', 'chips2', el('span', 'pillt' + (d.apr ? '' : ' none'), d.apr ? 'APR ' + pct(d.apr, 2) : 'APR 없음'),
        d.monthlyInterest > 0 ? el('span', 'pillt', '월 이자 ' + fmt(d.monthlyInterest)) : null,
        d.min ? el('span', 'pillt', '최소 ' + fmt(d.min) + (isLoan ? ' (대출 납입액)' : '')) : null)));
    if (d.limit > 0) {
      const u = d.util === null ? 0 : d.util;
      card.append(el('div', 'wl-util', el('div', 'wl-util-h', el('span', null, 'Limit (한도) ' + fmt(d.limit)), el('b', 'u-' + lvl, 'Used (사용률) ' + pct(u))),
        h('div', { class: 'bar wl-bar', role: 'img', 'aria-label': 'Credit use ' + pct(u) }, h('span', { class: 'bar-fill ' + (lvl === 'ok' ? '' : lvl), style: 'width:' + Math.min(100, Math.max(u, 1)) + '%' }), h('i', { class: 'tick', style: 'left:30%' }), h('i', { class: 'tick', style: 'left:60%' })),
        el('div', 'wl-util-s', '30% 미만 좋음 · 60% 이상 위험 · 남은 한도 ' + fmt(Math.max(0, L.round(d.limit - d.balance, 2))))));
    }
    if (editing) card.append(debtForm(d, isLoan));
    return card;
  }

  function debtForm(d, isLoan) {
    const id = String(d.a.account_id), key = 'debt:' + id;
    const old = meta.debts[id] || {};
    const pre = (n) => 'wl-d-' + id + '-' + n;
    const I = {
      apr: inp(pre('apr'), old.apr || '', { ph: '예: 21.99', label: 'APR % (연 이율)' }),
      limit: inp(pre('limit'), old.limit || '', { ph: '예: 5000', label: 'Credit limit (한도)' }),
      min: inp(pre('min'), isLoan ? '' : (old.min || ''), { ph: isLoan ? '대출 납입액을 써요' : '예: 25', label: 'Minimum payment (최소 상환)' })
    };
    if (isLoan) I.min.disabled = true;
    const err = h('div', { class: 'err', id: pre('err'), role: 'alert' });
    return h('div', { class: 'wl-form', id: pre('form') },
      el('div', 'two wl-two', field('APR (연 이율 %)', I.apr), field('Limit (한도) $', I.limit, d.kind === 'card' || d.kind === 'loc' ? '카드·한도가 아니면 비워도 돼요' : '비워도 돼요')),
      field('Minimum payment (최소 상환) $', I.min, isLoan ? '대출 탭에서 정한 월 납입액을 그대로 써요' : '비우면 잔액의 3%(최소 $10)로 가정해요'),
      err,
      el('div', 'btnrow',
        h('button', { type: 'button', class: 'btn', id: pre('save'), onclick: (e) => {
          const r = F.checkDebt({ apr: I.apr.value, limit: I.limit.value, min: I.min.value });
          markBad(I, r.errors);
          if (!r.ok) { err.textContent = r.first; return; }
          const debtsMap = Object.assign({}, api.meta().debts);
          const merged = Object.assign({}, debtsMap[id], r.cfg);
          if (isLoan) merged.min = (debtsMap[id] && debtsMap[id].min) || 0;
          debtsMap[id] = merged;
          ws.edit[key] = false;
          save(rowOf(M.KEYS_META.debts, debtsMap, 'debts'), '저장했어요.', e.currentTarget);
        } }, icon('check', 18), 'Save (저장)'),
        h('button', { type: 'button', class: 'btn secondary', id: pre('cancel'), onclick: () => { ws.edit[key] = false; paint(); } }, 'Cancel (취소)')));
  }

  // ═════════════════════ 주식 ═════════════════════
  function stocks() {
    const wrap = el('div', 'wl-stack');
    const hs = meta.holdings || [];
    const rows = F.holdingRows(hs, meta.prices, accMap);
    const priced = rows.filter((r) => r.value !== null);
    const totalV = L.round(priced.reduce((s, r) => s + r.value, 0), 2);
    const totalBook = L.round(priced.reduce((s, r) => s + r.book, 0), 2);
    const totalPl = L.round(totalV - totalBook, 2);
    const ages = rows.filter((r) => r.at).map((r) => F.ageOf(r.at));
    const oldest = ages.length ? ages.reduce((a, b) => (a.hours >= b.hours ? a : b)) : null;
    const msg = ws.msg.stocks;
    const status = h('div', { class: 'wl-status' + (msg ? ' ' + msg.kind : ''), id: 'wl-s-status', role: 'status', 'aria-live': 'polite' }, msg ? msg.text : '');
    const upd = h('button', { type: 'button', class: 'btn', id: 'wl-s-update', onclick: () => updatePrices(upd, status) }, icon('sync', 18), 'Update prices (시세 갱신)');
    const addBtn = h('button', { type: 'button', class: 'btn secondary', id: 'wl-s-add', onclick: () => { ws.edit['hold:new'] = true; paint(); } }, icon('plus', 18), 'Add holding (종목 추가)');
    wrap.append(h('section', { class: 'card wl-card', id: 'wl-s-sum' },
      el('div', 'wl-head', el('div', 'ti', sectTitle('Holdings value', '보유 종목 평가'), el('span', 'sub', 'CAD 기준 · 평가액 = 수량 × 시세'))),
      el('div', 'wl-tiles',
        tile('Market value (평가액)', rows.length ? fmt(totalV) : '—', priced.length < rows.length ? '시세가 없는 종목 ' + (rows.length - priced.length) + '개는 빠져 있어요' : rows.length + '개 종목', 'big', 'wl-s-total'),
        tile('Cost (원가)', rows.length ? fmt(totalBook) : '—', '산 금액 합계', '', 'wl-s-book'),
        tile('Gain / loss (손익)', rows.length && totalBook ? h('span', null, chg(totalPl, true), ' ', chgPct(totalV, totalBook, true)) : '—', totalBook ? '원가 대비' : '원가를 넣으면 계산해요', '', 'wl-s-pl'),
        tile('Prices as of (시세 시각)', oldest ? oldest.text : '—', oldest ? (oldest.warn ? '오래됐어요 — 갱신하세요' : '가장 오래된 종목 기준') : '아직 시세가 없어요', oldest && oldest.warn ? 'u-over' : '', 'wl-s-age')),
      el('div', 'btnrow wl-actions', upd, addBtn), status,
      info('종목을 투자 계좌에 연결하면, 그 계좌의 잔액이 ', h('b', null, '보유 종목 평가액의 합계'), '로 바뀌어 재무상태표에 들어가요 (그 계좌의 현금은 따로 계산되지 않아요). 시세는 버튼을 누를 때만 가져오고, 로그인이 필요해요. 미국 종목(USD)은 환율로 CAD 로 바꿔 저장해요.')));

    if (ws.edit['hold:new']) wrap.append(holdingForm(null, -1));
    const list = el('div', 'wl-holds');
    if (!rows.length && !ws.edit['hold:new']) list.append(h('div', { class: 'card muted', id: 'wl-s-empty' }, '보유 종목이 아직 없어요. "Add holding (종목 추가)" 로 종목 코드와 수량을 넣으세요. (예: TD.TO 120주)'));
    rows.forEach((r) => list.append(holdingCard(r)));
    wrap.append(list);

    // 계좌별 합계
    const tot = F.acctTotals(rows);
    if (tot.size) {
      const box = h('section', { class: 'card wl-card', id: 'wl-s-accts' }, el('div', 'wl-head', el('div', 'ti', sectTitle('By account', '계좌별 평가'), el('span', 'sub', '평가액이 해당 계좌의 잔액을 덮어써요'))));
      tot.forEach((t) => {
        const a = accMap.get(t.acct);
        const bookBal = bookOf(bsA.get(t.acct));
        const line = bsA.get(t.acct);
        const diff = L.round(t.value - (line && line.book !== undefined ? line.book : bookBal), 2);
        box.append(el('div', 'wl-acctrow', el('div', 'mid', el('b', null, a ? L.accLabel(a) : t.acct), el('div', 'wl-s', t.count + '개 종목'
          + (t.missing ? ' · 시세 없는 종목 ' + t.missing + '개' : ''))),
        el('div', 'amt', el('b', null, fmt(t.value)), el('span', 'wl-s', '장부 ' + fmt(line && line.book !== undefined ? line.book : bookBal) + ' · 차이 '), chg(diff, true))));
        if (t.missing) box.append(warn((a ? a.name : t.acct) + ' 계좌는 시세가 없는 종목이 있어, 평가액이 실제보다 적게 보일 수 있어요. 시세를 갱신하거나 가격을 직접 입력하세요.'));
      });
      wrap.append(box);
    }
    const unlinked = rows.filter((r) => !r.acct || !r.acctOk);
    if (unlinked.length) wrap.append(note('계좌에 연결하지 않은 종목(' + unlinked.map((r) => r.sym).join(', ') + ')은 이 화면에서만 계산하고 재무상태표에는 들어가지 않아요.'));
    return wrap;
  }

  function holdingCard(r) {
    const key = 'hold:' + r.i;
    if (ws.edit[key]) return holdingForm(meta.holdings[r.i], r.i);
    const age = r.at ? F.ageOf(r.at) : null;
    const priceKey = 'price:' + r.i;
    const card = h('section', { class: 'card wl-card wl-hold', id: 'wl-hold-' + r.i, 'data-sym': r.sym });
    card.append(el('div', 'wl-head',
      el('div', 'ti', el('b', 'sym', r.sym), el('span', 'sub', (r.acctName || '계좌 연결 안 됨') + ' · ' + r.shares.toLocaleString('en-US', { maximumFractionDigits: 6 }) + '주')),
      el('div', 'tr',
        h('button', { type: 'button', class: 'rowbtn', id: 'wl-hold-edit-' + r.i, 'aria-label': 'Edit ' + r.sym + ' (수정)', onclick: () => { ws.edit[key] = true; paint(); } }, icon('edit', 20)))));
    card.append(el('div', 'wl-tiles',
      tile('Value (평가액)', r.value === null ? '시세 없음' : fmt(r.value), r.price === null ? '아래에서 가격을 입력하세요' : fmt(r.price) + ' / 주' + (r.ccy && r.ccy !== 'CAD' ? ' (' + r.ccy + ' ' + r.orig + ' × ' + r.fx + ')' : ''), r.value === null ? 'u-near' : 'big', 'wl-hold-val-' + r.i),
      tile('Cost (원가)', r.book ? fmt(r.book) : '—', r.book && r.shares ? '주당 ' + fmt(L.round(r.book / r.shares, 4)) : '', '', 'wl-hold-book-' + r.i),
      tile('Gain / loss (손익)', r.pl === null ? '—' : h('span', null, chg(r.pl, true), ' ', chgPct(r.value, r.book, true)), r.pl === null ? '원가와 시세가 있어야 계산해요' : '원가 대비', '', 'wl-hold-pl-' + r.i)));
    const metaLine = [];
    if (age) metaLine.push(el('span', 'wl-age' + (age.warn ? ' warn' : age.stale ? ' stale' : ''), 'Price (시세) ' + age.text + (age.warn ? ' · 오래됐어요' : '')));
    if (r.guess) metaLine.push(el('span', 'wl-age', '통화를 ' + r.ccy + ' 로 추정했어요'));
    if (r.manual) metaLine.push(el('span', 'wl-age', '직접 입력한 가격'));
    if (metaLine.length) card.append(el('div', 'wl-metaline', metaLine));
    // 가격 직접 입력
    const open = !!ws.edit[priceKey];
    if (!open) card.append(el('div', 'btnrow', h('button', { type: 'button', class: 'btn secondary sm', id: 'wl-hold-price-' + r.i, onclick: () => { ws.edit[priceKey] = true; paint(); } }, 'Enter price (가격 직접 입력)')));
    else card.append(priceForm(r));
    return card;
  }
  function priceForm(r) {
    const key = 'price:' + r.i;
    const pre = (n) => 'wl-hold-' + r.i + '-' + n;
    const q = meta.prices[r.sym];
    const I = { price: inp(pre('price'), q && q.orig ? q.orig : q ? q.price : '', { ph: '예: 95.30', label: 'Price per share (주당 가격)' }) };
    const ccy = sel(pre('ccy'), [['CAD', 'CAD'], ['USD', 'USD']], q && q.ccy === 'USD' ? 'USD' : (r.sym.indexOf('.') < 0 ? 'USD' : 'CAD'));
    const err = h('div', { class: 'err', id: pre('err'), role: 'alert' });
    return h('div', { class: 'wl-form', id: pre('priceform') },
      el('div', 'wl-priceline', field('Price per share (주당 가격)', I.price), field('Currency (통화)', ccy)),
      err,
      el('div', 'btnrow',
        h('button', { type: 'button', class: 'btn', id: pre('price-save'), onclick: (e) => {
          const c = F.checkPrice({ price: I.price.value, ccy: ccy.value });
          markBad(I, c.errors);
          if (!c.ok) { err.textContent = c.first; return; }
          const now = L.nowIso();
          const entry = F.priceEntry(c.price, c.ccy, api.data.fxRates, now, { manual: true });
          if (!entry) { err.textContent = c.ccy + ' 환율이 아직 없어서 CAD 로 바꿀 수 없어요. 먼저 환율을 갱신하거나 CAD 가격을 입력하세요.'; return; }
          const prices = Object.assign({}, api.meta().prices); prices[r.sym] = entry;
          ws.edit[key] = false;
          save(rowOf(M.KEYS_META.prices, prices, 'prices'), r.sym + ' 가격을 저장했어요.', e.currentTarget);
        } }, icon('check', 18), 'Save price (저장)'),
        h('button', { type: 'button', class: 'btn secondary', id: pre('price-cancel'), onclick: () => { ws.edit[key] = false; paint(); } }, 'Cancel (취소)')));
  }

  function holdingForm(h0, idx) {
    const key = idx < 0 ? 'hold:new' : 'hold:' + idx;
    const pre = (n) => 'wl-h-' + (idx < 0 ? 'new' : idx) + '-' + n;
    const I = {
      sym: inp(pre('sym'), h0 ? h0.sym : '', { ph: '예: TD.TO', label: 'Ticker (종목 코드)' }),
      shares: inp(pre('shares'), h0 ? h0.shares : '', { ph: '예: 120', label: 'Shares (수량)' }),
      book: inp(pre('book'), h0 && h0.book ? h0.book : '', { ph: '예: 9800', label: 'Total cost (원가 합계)' })
    };
    I.sym.setAttribute('inputmode', 'text'); I.sym.setAttribute('autocapitalize', 'characters'); I.sym.setAttribute('spellcheck', 'false');
    const invest = accounts.filter((a) => a.type === 'ASSET').sort((x, y) => (kindOf(y) === 'invest') - (kindOf(x) === 'invest'));
    const acct = sel(pre('acct'), [['', 'Not linked (연결 안 함)']].concat(invest.map((a) => [a.account_id, L.accLabel(a)])), h0 ? h0.acct || '' : (invest.find((a) => kindOf(a) === 'invest') || {}).account_id || '');
    const err = h('div', { class: 'err', id: pre('err'), role: 'alert' });
    let confirmDel = false;
    const delBtn = h0 ? h('button', { type: 'button', class: 'btn danger', id: pre('remove'), onclick: () => {
      if (!confirmDel) { confirmDel = true; delBtn.textContent = 'Tap again to remove (한 번 더 누르면 삭제)'; return; }
      const list = (api.meta().holdings || []).slice(); list.splice(idx, 1);
      ws.edit[key] = false;
      save(rowOf(M.KEYS_META.holdings, list, 'holdings'), h0.sym + ' 를 지웠어요.', delBtn);
    } }, icon('trash', 16), 'Remove (삭제)') : null;
    return h('section', { class: 'card wl-card wl-form', id: pre('form') },
      el('div', 'wl-sub', h0 ? 'Edit holding (종목 수정)' : 'Add holding (종목 추가)'),
      el('div', 'two wl-two', field('Ticker (종목 코드)', I.sym, '캐나다 종목은 .TO (예: TD.TO)'), field('Shares (수량)', I.shares)),
      el('div', 'two wl-two', field('Total cost (원가 합계) $', I.book, '산 금액 전체 (수수료 포함). 손익 계산에 써요'), field('Account (투자 계좌)', acct, '고르면 그 계좌 잔액을 평가액으로 바꿔요')),
      err,
      el('div', 'btnrow',
        h('button', { type: 'button', class: 'btn', id: pre('save'), onclick: (e) => {
          const cur = (api.meta().holdings || []).slice();
          const r = F.checkHolding({ sym: I.sym.value, shares: I.shares.value, book: I.book.value, acct: acct.value }, cur, idx);
          markBad(I, r.errors);
          if (!r.ok) { err.textContent = r.first; return; }
          if (idx < 0) cur.push(r.cfg); else cur[idx] = r.cfg;
          ws.edit[key] = false;
          save(rowOf(M.KEYS_META.holdings, cur, 'holdings'), '저장했어요. "Update prices (시세 갱신)" 으로 시세를 가져오세요.', e.currentTarget);
        } }, icon('check', 18), 'Save (저장)'),
        h('button', { type: 'button', class: 'btn secondary', id: pre('cancel'), onclick: () => { ws.edit[key] = false; paint(); } }, 'Cancel (취소)'),
        delBtn));
  }

  async function updatePrices(btn, status) {
    const hs = api.meta().holdings || [];
    const syms = Array.from(new Set(hs.map((x) => String(x.sym).toUpperCase())));
    const say = (kind, text) => { if (kind === 'busy') delete ws.msg.stocks; else ws.msg.stocks = { kind, text }; status.className = 'wl-status ' + kind; status.textContent = text; };
    if (!syms.length) { say('bad', '먼저 보유 종목을 추가하세요.'); return; }
    btn.disabled = true;
    say('busy', '시세를 가져오는 중이에요… (' + syms.join(', ') + ')');
    let res;
    try {
      res = await (api.quote || AI.quote)(syms);
    } catch (e) {
      btn.disabled = false;
      const code = e && e.code;
      const m = (e && e.message) || '시세를 가져오지 못했어요.';
      say('bad', m + (code === 'auth' ? '' : '') + ' 지금은 각 종목의 "Enter price (가격 직접 입력)" 으로 가격을 넣을 수 있어요.');
      return;
    }
    const quotes = (res && res.quotes) || {};
    const now = L.nowIso();
    const prices = Object.assign({}, api.meta().prices);
    const gotList = [], missing = [], noFx = [];
    syms.forEach((s) => {
      const q = quotes[s];
      if (!q || !(Number(q.price) > 0)) { missing.push(s); return; }
      const c = F.quoteCcy(s, q.currency);
      const entry = F.priceEntry(Number(q.price), c.ccy, api.data.fxRates, q.asOf || now, c.guess ? { guess: true } : null);
      if (!entry) { noFx.push(s + ' (' + c.ccy + ')'); return; }
      prices[s] = entry; gotList.push(s);
    });
    const parts = [];
    if (gotList.length) parts.push(gotList.length + '개 종목 시세를 갱신했어요.');
    if (missing.length) parts.push('시세를 찾지 못한 종목: ' + missing.join(', ') + ' — 종목 코드가 맞는지 확인하거나(캐나다 종목은 .TO) 가격을 직접 입력하세요.');
    if (noFx.length) parts.push('환율이 없어 CAD 로 바꾸지 못한 종목: ' + noFx.join(', ') + ' — Settings 에서 환율을 갱신하거나 가격을 직접 입력하세요.');
    const kind = gotList.length && !missing.length && !noFx.length ? 'ok' : gotList.length ? 'warn' : 'bad';
    say(kind, parts.join(' '));
    if (!gotList.length) { btn.disabled = false; return; }
    await save(rowOf(M.KEYS_META.prices, prices, 'prices'), null, btn);
  }

  // ═════════════════════ 미지급 (재산세 등) ═════════════════════
  function accrued() {
    const wrap = el('div', 'wl-stack');
    const cfg = meta.accrual;
    const editing = !!ws.edit['accrual'] || !cfg;
    wrap.append(info('1년치를 몇 번에 나눠 내는 세금(재산세 등)은 ', h('b', null, '매달 1/12 씩 쌓인다'), '고 계산해요. 쌓인 금액에서 실제로 낸 금액을 빼면 ', h('b', null, '지금 낼 잔액'), '이고, 그 값이 재무상태표의 미지급 부채로 들어가요. 월 비용이 들쭉날쭉하지 않게 한 달 치 부담(연 ÷ 12)을 알 수 있어요.'));
    if (editing) wrap.append(accrualForm(cfg));
    if (cfg) wrap.append(accrualResult(cfg));
    return wrap;
  }

  function accrualResult(cfg) {
    const accrued = V.accruedBy(cfg, month);
    const paid = V.accrualPaid(cfg, api.items, month);
    const bal = V.accrualBalance(cfg, api.items, month);
    const opening = Number(cfg.opening) || 0;
    const codeA = accMap.get(String(cfg.code)), acctA = accMap.get(String(cfg.acct));
    const started = month >= cfg.since;
    const box = h('section', { class: 'card wl-card', id: 'wl-ac-result' });
    box.append(el('div', 'wl-head', el('div', 'ti', sectTitle('Accrued so far', '지금까지 쌓인 금액'), el('span', 'sub', (codeA ? codeA.name : cfg.code) + ' → ' + (acctA ? acctA.name : cfg.acct))),
      ws.edit['accrual'] ? null : h('button', { type: 'button', class: 'btn secondary sm', id: 'wl-ac-edit', onclick: () => { ws.edit['accrual'] = true; paint(); } }, icon('edit', 16), 'Edit (수정)')));
    box.append(el('div', 'wl-tiles',
      tile('Accrued (쌓인 금액)', fmt(L.round(accrued, 2)), started ? V.monthsBetween(cfg.since, month) + 1 + '개월 × ' + fmt(L.round(cfg.annual / 12, 2)) : L.monthLabel(cfg.since) + ' 부터 쌓아요', '', 'wl-ac-accrued'),
      tile('Paid (실제 낸 금액)', fmt(L.round(paid, 2)), '비용 계정에 기록된 합계', '', 'wl-ac-paid'),
      tile('Balance due (지금 낼 잔액)', bal === null ? '—' : fmt(bal), bal !== null && bal < 0 ? '미리 낸 금액(선납)이에요' : '처음 밀린 ' + fmt(opening) + ' 포함', bal !== null && bal > 0.005 ? 'big u-near' : 'big', 'wl-ac-bal'),
      tile('Per month (월 환산 비용)', fmt(L.round(cfg.annual / 12, 2)), '연 ' + fmt(cfg.annual) + ' ÷ 12', '', 'wl-ac-month')));
    box.append(note('낼 잔액 = 처음 밀린 금액 ' + fmt(opening) + ' + 쌓인 금액 ' + fmt(L.round(accrued, 2)) + ' − 낸 금액 ' + fmt(L.round(paid, 2)) + ' = ' + (bal === null ? '—' : fmt(bal))));
    const s = F.accrualSeries(cfg, api.items, month, 24);
    box.append(el('div', 'wl-sub', 'Accrued vs paid (쌓인 금액 vs 낸 금액) · 누적'),
      el('div', 'wl-chart', track(lineChart({
        title: 'Accrual', labels: s.labels.map(L.monthLabel), height: 240, fmt: (n) => fmt(n), forecastFrom: s.nowIndex >= 0 && s.nowIndex < s.labels.length - 1 ? s.nowIndex + 1 : undefined, selected: s.nowIndex >= 0 ? s.nowIndex : undefined,
        series: [{ key: 'acc', name: 'Accrued (쌓인 금액)', color: 'var(--c3)', values: s.accrued }, { key: 'paid', name: 'Paid (낸 금액)', color: 'var(--c1)', values: s.paid }, { key: 'bal', name: 'Balance due (낼 잔액)', color: 'var(--c4)', values: s.balance, dashed: true }]
      }))));
    const pays = F.accrualPayments(cfg, api.items, month, 6);
    box.append(el('div', 'wl-sub', 'Payments counted (낸 내역)'),
      pays.length ? el('div', 'wl-list', pays.map((p) => el('div', 'wl-payrow', el('span', 'd', p.date), el('span', 'm', p.merchant || '—'), el('b', null, fmt(p.amount)))))
        : el('div', 'wl-empty', '아직 낸 내역이 없어요. 비용 계정(' + (codeA ? codeA.name : cfg.code) + ')으로 거래를 기록하면 여기에 잡혀요.'));
    return box;
  }

  function accrualForm(cfg) {
    const pre = (n) => 'wl-ac-' + n;
    const exp = accounts.filter((a) => a.type === 'EXPENSE');
    const liab = accounts.filter((a) => a.type === 'LIABILITY' && kindOf(a) !== 'clearing').sort((x, y) => (kindOf(y) === 'accrued') - (kindOf(x) === 'accrued'));
    const guessCode = (exp.find((a) => /PROPERTY TAX|재산세/i.test(a.name + a.name_ko)) || {}).account_id || '';
    const guessAcct = (liab.find((a) => kindOf(a) === 'accrued') || {}).account_id || '';
    const I = {
      annual: inp(pre('annual'), cfg ? cfg.annual : '', { ph: '예: 4800', label: 'Annual amount (1년 금액)' }),
      since: inp(pre('since'), cfg ? cfg.since : month.slice(0, 4) + '-01', { type: 'month', label: 'Start month (쌓기 시작한 달)' }),
      opening: inp(pre('opening'), cfg ? cfg.opening : '0', { ph: '예: 0', label: 'Opening owed (처음 밀린 금액)' })
    };
    const code = sel(pre('code'), [['', 'Choose an expense account (비용 계정 고르기)']].concat(exp.map((a) => [a.account_id, L.accLabel(a)])), cfg ? cfg.code : guessCode);
    const acct = sel(pre('acct'), [['', 'Choose a liability account (부채 계정 고르기)']].concat(liab.map((a) => [a.account_id, L.accLabel(a)])), cfg ? cfg.acct : guessAcct);
    const err = h('div', { class: 'err', id: pre('err'), role: 'alert' });
    const pv = h('div', { class: 'wl-preview', id: pre('pv') });
    const read = () => ({ annual: I.annual.value, since: I.since.value, opening: I.opening.value, code: code.value, acct: acct.value });
    function refresh() {
      const r = F.checkAccrual(read());
      markBad(Object.assign({}, I, { code, acct }), r.errors);
      pv.replaceChildren();
      if (r.ok) { pv.append(el('b', null, 'Preview (미리보기): '), '한 달에 ' + fmt(L.round(r.cfg.annual / 12, 2)) + ' 씩 쌓여요 · ' + L.monthLabel(month) + ' 까지 ' + fmt(L.round(V.accruedBy(r.cfg, month), 2))); err.textContent = ''; }
    }
    Object.keys(I).forEach((k) => I[k].addEventListener('input', refresh));
    code.addEventListener('change', refresh); acct.addEventListener('change', refresh);
    let confirmDel = false;
    const delBtn = cfg ? h('button', { type: 'button', class: 'btn danger', id: pre('remove'), onclick: () => {
      if (!confirmDel) { confirmDel = true; delBtn.textContent = 'Tap again to remove (한 번 더 누르면 삭제)'; return; }
      ws.edit['accrual'] = false;
      const row = M.deleteRow(api.data.settings, M.KEYS_META.accrual, L.nowIso());
      save(row, '미지급 설정을 지웠어요. 부채 계정은 장부 잔액을 다시 써요.', delBtn);
    } }, icon('trash', 16), 'Remove setup (설정 삭제)') : null;
    const f = h('section', { class: 'card wl-card wl-form', id: pre('form') },
      el('div', 'wl-head', el('div', 'ti', sectTitle('Accrual setup', '미지급 설정'))),
      el('div', 'two wl-two', field('Annual amount (1년 금액) $', I.annual, '예: 재산세 연 $4,800'), field('Start month (쌓기 시작한 달)', I.since)),
      field('Opening owed (처음 밀린 금액) $', I.opening, '시작 전부터 아직 못 낸 금액이 있으면 넣으세요 (없으면 0)'),
      el('div', 'two wl-two', field('Expense account (비용 계정)', code, '낼 때 거래를 기록하는 계정'), field('Liability account (미지급 부채 계정)', acct, '쌓인 금액이 보일 계정. 목록에 없으면 Settings 에서 계정을 추가하세요')),
      pv, err,
      el('div', 'btnrow',
        h('button', { type: 'button', class: 'btn', id: pre('save'), onclick: (e) => {
          const r = F.checkAccrual(read());
          markBad(Object.assign({}, I, { code, acct }), r.errors);
          if (!r.ok) { err.textContent = r.first; return; }
          ws.edit['accrual'] = false;
          save(rowOf(M.KEYS_META.accrual, r.cfg, 'accrual'), '저장했어요. 재무상태표에 반영됩니다.', e.currentTarget);
        } }, icon('check', 18), 'Save (저장)'),
        cfg ? h('button', { type: 'button', class: 'btn secondary', id: pre('cancel'), onclick: () => { ws.edit['accrual'] = false; paint(); } }, 'Cancel (취소)') : null,
        delBtn));
    refresh();
    return f;
  }

  paint();
  return root;
}
