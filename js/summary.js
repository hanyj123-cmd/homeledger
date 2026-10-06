// 요약(Executive Summary) 화면 — "한눈에" 보는 private-banker 스타일 요약.
//   초록 배너(순자산·수입·지출·순수입·저축률 + 지난달 대비 ▲▼) → 핵심 요약(건강 점수·KPI) → 이번 달 전망 →
//   인터랙티브 차트 6개 → 조언 카드(규칙 기반, 항상) → AI 브리핑/질문(버튼을 눌렀을 때만) → 월 메모 → 정기 결제·사람별·상위 업체 → 내보내기.
// 숫자는 모두 api.analysis() (insights.js) 에서 옵니다. 텍스트 요약은 summary-text.js.
import * as L from './ledger.js';
import * as I from './insights.js';
import * as M from './meta.js';
import * as ai from './ai.js';
import * as drill from './drill.js';
import * as T from './summary-text.js';
import { icon } from './icons.js';
import { openPrintReport } from './printreport.js';
import { layoutOf } from './layout.js';
import { barChart, lineChart, donut, hbars, waterfall, sparkline, compact } from './charts.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mshort = (m) => MON[Number(m.slice(5, 7)) - 1];
const money = T.money0;
const r1 = T.r1;
/** el 의 내용을 kids 로 교체 (배열·null 허용 — 기본 replaceChildren 은 배열을 글자로 바꿔 버림) */
function fill(el, ...kids) {
  el.textContent = '';
  kids.flat(Infinity).forEach((c) => {
    if (c === undefined || c === null || c === false) return;
    el.append(c && c.nodeType ? c : document.createTextNode(String(c)));
  });
  return el;
}
const axisMoney = (n) => (n < 0 ? '−' : '') + '$' + compact(Math.abs(n));
const sum = (a) => a.reduce((s, v) => s + v, 0);
const SVGNS = 'http://www.w3.org/2000/svg';

// 지출 그룹 (색은 style.css 의 --g-* 변수 = charts 팔레트와 같은 색)
const GROUPS = [
  { key: '고정비', field: 'fixed', en: 'Fixed', ko: '고정비', color: 'var(--g-fixed)' },
  { key: 'semi-고정비', field: 'semi', en: 'Semi-fixed', ko: '준고정비', color: 'var(--g-semi)' },
  { key: '유흥비', field: 'fun', en: 'Leisure', ko: '유흥비', color: 'var(--g-fun)' },
  { key: '금융비', field: 'fin', en: 'Financial', ko: '금융비', color: 'var(--g-fin)' },
  { key: '확인 필요', field: 'review', en: 'Review', ko: '확인 필요', color: 'var(--g-review)' }
];
const gname = (g) => g.en + ' (' + g.ko + ')';

const TONE_LABEL = { bad: 'Act now (바로 조치)', warn: 'Watch (주의)', info: 'Tip (참고)', good: 'Good (좋아요)' };
const TONE_ICON = { bad: 'alert', warn: 'alert', info: 'info', good: 'check' };

const ASK_EXAMPLES = ['이번 달 외식비가 왜 늘었어?', '내년에 저축을 늘리려면?', '카드 빚 먼저 갚을까 TFSA 에 넣을까?'];
const PRIVACY = '월별 합계·카테고리별 금액·부채 잔액 같은 집계 숫자와 정기 결제·부채 이름만 전송돼요. 개별 거래 내역·월 메모·계좌번호는 보내지 않아요.';

// 화면을 다시 그려도 남겨 둘 작은 상태 (탭을 옮기면 사라져도 됨)
const UI = { group: null, comp: 'A', catMore: false, tipsAll: false, subsAll: false, noteDraft: null, ask: null, askQ: '', aiRun: 0, lastAi: null };
export function _resetUI() { Object.assign(UI, { group: null, comp: 'A', catMore: false, tipsAll: false, subsAll: false, noteDraft: null, ask: null, askQ: '', lastAi: null }); }

const ago = (at) => {
  const m = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (m < 1) return '방금';
  if (m < 60) return m + '분 전';
  const hr = Math.round(m / 60);
  return hr + '시간 전';
};

export function render(api) {
  const { h, state } = api;
  const lay = layoutOf();
  drill.setDock(null);                       // 이 화면에는 오른쪽 고정 칸이 없으니 상세는 시트/서랍으로
  const ym = state.month;
  const today = api.today || L.todayStr();
  const isNow = ym === L.monthOf(today);
  const root = h('div', { class: 'sm-root', id: 'sm-root', 'data-month': ym });

  const lab = (en, ko) => [en + ' ', h('span', { class: 'sm-ko' }, '(' + ko + ')')];
  const D = () => (api.drillApi ? api.drillApi() : api);

  if (!api.items || !api.items.length) { root.append(emptyView()); return root; }

  const ctx = api.analysis();
  const cur = ctx.cur, prev = ctx.prev;
  const hasPrev = !!(prev && (prev.income || prev.expense));
  const noData = !(cur.income || cur.expense);

  // ───────── 작은 부품 ─────────
  const sp = (cls, ...kids) => h('span', { class: cls }, ...kids);
  /** 지난달 대비 ▲▼ (색: 좋아지면 초록, 나빠지면 빨강) */
  function chg(delta, goodUp, cls, unit) {
    const tiny = unit === 'pp' ? 0.05 : 0.5;
    if (delta === null || !Number.isFinite(delta) || Math.abs(delta) < tiny) return sp('chg flat ' + (cls || ''), '—');
    const good = goodUp ? delta > 0 : delta < 0;
    const txt = unit === 'pp' ? (Math.round(Math.abs(delta) * 10) / 10) + ' pp' : money(Math.abs(delta));
    return sp('chg ' + (good ? 'good' : 'bad') + ' ' + (cls || ''), sp('arw', delta > 0 ? '▲' : '▼'), txt);
  }
  const sectHead = (id, en, ko, sub) => h('h2', { class: 'sect sm-sect', id }, lab(en, ko), sub ? sp('sm-sect-sub', sub) : null);
  const cardHead = (en, ko, sub) => h('div', { class: 'sm-h' }, h('h3', null, lab(en, ko)), sub ? sp('sm-sub', sub) : null);
  const goOpen = (spec) => drill.show(D(), spec);
  const openCat = (l) => goOpen({
    key: 'exp:' + l.id + ':' + ym, title: l.name, sub: L.monthLabel(ym), months: [ym], ids: [l.id], mode: 'exp', search: l.name,
    addDefaults: { kind: 'EXPENSE', categoryId: l.id }
  });
  const goMonth = (m) => { if (m && m !== state.month) { state.month = m; api.rerender(); } };

  // ───────── 인쇄용 머리 (화면에는 안 보임) ─────────
  root.append(h('div', { class: 'sm-printhead' }, h('b', null, 'Home Ledger'), ' · Executive summary (요약) · ', L.monthLabel(ym)));

  // ───────── 1) 배너 ─────────
  const nwD = L.round(ctx.bs.net - ctx.bsPrev.net, 2);
  const asOf = isNow ? today : ctx.bs.asOf;
  const asOfLabel = (() => { const d = new Date(String(asOf).slice(0, 10) + 'T12:00:00'); return isNaN(d) ? asOf : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); })();
  const bm = (id, en, ko, val, chipEl) => h('div', { class: 'sm-m', id }, h('div', { class: 'lab' }, lab(en, ko)), h('div', { class: 'val' }, val), chipEl);
  const rateD = hasPrev && cur.rate !== null && prev.rate !== null ? cur.rate - prev.rate : null;
  root.append(h('section', { class: 'banner sm-banner' }, h('div', { class: 'banner-in' },
    h('div', { class: 'banner-row' },
      h('div', { class: 'acct-pick' }, h('span', { class: 'nm' }, 'Executive summary (요약) · ' + L.monthLabel(ym))),
      h('div', { class: 'asof' }, (isNow ? 'Through ' : 'As of '), h('b', null, asOfLabel))),
    h('div', { class: 'sm-hero' },
      h('div', { class: 'sm-nw', id: 'sm-nw' },
        h('div', { class: 'lab' }, lab('Net worth', '순자산')),
        h('div', { class: 'val' }, money(ctx.bs.net)),
        h('div', { class: 'sm-nwd' }, chg(nwD, true, 'sm-bchip'), sp('cap', 'vs last month (지난달 대비)'))),
      h('div', { class: 'sm-sub4' },
        bm('sm-b-in', 'Income', '수입', money(cur.income), hasPrev ? chg(cur.income - prev.income, true, 'sm-bchip') : null),
        bm('sm-b-out', 'Spending', '지출', money(cur.expense), hasPrev ? chg(cur.expense - prev.expense, false, 'sm-bchip') : null),
        bm('sm-b-net', 'Net', '순수입', money(cur.net), hasPrev ? chg(cur.net - prev.net, true, 'sm-bchip') : null),
        bm('sm-b-rate', 'Savings rate', '저축률', cur.rate === null ? '—' : r1(cur.rate) + '%', rateD !== null ? chg(rateD, true, 'sm-bchip', 'pp') : null))))));

  // ───────── 알약 버튼 ─────────
  const pill = (id, ic, en, ko, onclick) => h('button', { type: 'button', class: 'pillbtn', id, onclick }, icon(ic, 24), en + ' ', sp('ko', '(' + ko + ')'));
  root.append(h('div', { class: 'pills sm-pills' },
    pill('sm-p-new', 'plus', 'New', '거래 추가', () => api.openForm(null, {})),
    pill('sm-p-ai', 'spark', 'AI advice', 'AI 조언', () => { const el = document.getElementById('sm-ai'); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }),
    pill('sm-p-copy', 'sheet', 'Copy', '요약 복사', () => doCopy()),
    pill('sm-p-print', 'print', 'Print', '인쇄', () => doPrint())));

  const page = h('div', { class: 'page sm-page' });
  root.append(page);

  // ───────── 달 이동 ─────────
  const stepBtn = (dir, lbl) => h('button', { type: 'button', class: 'stepbtn', id: dir < 0 ? 'sm-prev' : 'sm-next', 'aria-label': lbl, onclick: () => goMonth(L.shiftMonth(state.month, dir)) }, icon(dir < 0 ? 'left' : 'right', 20));
  const months = Array.from(new Set(api.items.map((it) => L.monthOf(it.txn.date)).concat([L.monthOf(today), ym]))).sort().reverse();
  const monthSel = h('label', { class: 'pillsel' }, icon('calendar', 20), sp('monthlabel', L.monthLabel(ym)), icon('down', 18),
    h('select', { id: 'sm-month', 'aria-label': 'Month (월)', onchange: (e) => goMonth(e.target.value) }, months.map((m) => h('option', { value: m, selected: m === ym }, L.monthLabel(m)))));
  page.append(h('div', { class: 'toolbar sm-toolbar' },
    h('div', { class: 'l' }, stepBtn(-1, 'Previous month (이전 달)'), monthSel, stepBtn(1, 'Next month (다음 달)'),
      isNow ? null : h('button', { type: 'button', class: 'chipf sm-now', id: 'sm-now', onclick: () => goMonth(L.monthOf(today)) }, 'This month (이번 달)'))));

  if (noData) {
    page.append(h('div', { class: 'card sm-nodata', id: 'sm-nodata' }, icon('info', 22),
      h('div', null, h('b', null, L.monthLabel(ym) + ' — 이 달에는 아직 수입·지출 기록이 없어요.'),
        h('div', { class: 'muted' }, '(No income or spending recorded for this month yet.) 다른 달로 옮기거나 거래를 추가해 보세요.')),
      h('button', { type: 'button', class: 'btn sm', id: 'sm-nodata-add', onclick: () => api.openForm(null, {}) }, 'Add (거래 추가)')));
  }

  // ───────── 2) Executive Summary 카드 ─────────
  page.append(execCard());
  function execCard() {
    const hs = ctx.health;
    const card = h('section', { class: 'card sm-card sm-exec', id: 'sm-exec' });
    card.append(cardHead('Executive summary', '핵심 요약', L.monthLabel(ym)));
    card.append(h('p', { class: 'sm-headline', id: 'sm-headline' }, ctx.headline));

    // 건강 점수 링 + 5개 항목
    const grid = h('div', { class: 'sm-exec-grid' });
    const tone = hs.total === null ? 'info' : hs.total >= 70 ? 'good' : hs.total >= 55 ? 'warn' : 'bad';
    const R = 54, C = 2 * Math.PI * R;
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 140 140'); svg.setAttribute('class', 'sm-ring-svg'); svg.setAttribute('aria-hidden', 'true');
    const mk = (cls, extra) => { const c = document.createElementNS(SVGNS, 'circle'); c.setAttribute('cx', '70'); c.setAttribute('cy', '70'); c.setAttribute('r', String(R)); c.setAttribute('class', cls); Object.keys(extra || {}).forEach((k) => c.setAttribute(k, extra[k])); return c; };
    svg.append(mk('sm-ring-bg'));
    if (hs.total !== null) {
      const fg = mk('sm-ring-fg', { 'stroke-dasharray': C.toFixed(1), 'stroke-dashoffset': (C * (1 - hs.total / 100)).toFixed(1) });
      fg.style.setProperty('--sm-c', C.toFixed(1));
      svg.append(fg);
    }
    const ring = h('div', { class: 'sm-ring t-' + tone, id: 'sm-ring', role: 'img', 'aria-label': hs.total === null ? 'Financial health: not enough data' : 'Financial health score ' + hs.total + ' of 100, grade ' + hs.grade },
      svg, h('div', { class: 'c' }, h('div', { class: 'n', id: 'sm-score' }, hs.total === null ? '—' : String(hs.total)), h('div', { class: 'of' }, '/ 100')));
    const health = h('div', { class: 'sm-health' },
      h('div', { class: 'sm-hl' }, lab('Financial health', '재무 건강')),
      ring,
      h('div', { class: 'sm-grade t-' + tone, id: 'sm-grade' }, hs.total === null ? 'Not enough data' : 'Grade ' + hs.grade),
      h('div', { class: 'sm-gl' }, hs.label));
    const parts = h('ul', { class: 'sm-parts', id: 'sm-parts' });
    hs.parts.forEach((p) => {
      parts.append(h('li', { class: 'sm-part t-' + p.tone, 'data-key': p.key },
        h('span', { class: 'nm' }, h('span', { class: 'sm-dot', 'aria-hidden': 'true' }), p.label),
        h('span', { class: 'v' }, T.partValue(p)),
        h('span', { class: 'sm-bar', role: 'img', 'aria-label': p.score + ' of 20' }, h('i', { style: 'width:' + Math.max(3, Math.round(p.score / 20 * 100)) + '%' })),
        h('span', { class: 'goal' }, 'Goal (목표): ' + p.goal + ' · ' + p.score + '/20')));
    });
    if (!hs.parts.length) parts.append(h('li', { class: 'sm-part-empty muted' }, 'Add income and balances to see your score (수입과 잔액을 입력하면 점수가 나와요).'));
    grid.append(health, parts);
    card.append(grid);

    // KPI 타일 (12개월 스파크라인)
    const ser = ctx.series;
    const avgOf = (arr) => { const v = arr.filter((x) => x !== null && Number.isFinite(x)); return v.length ? sum(v) / v.length : null; };
    const tile = (id, en, ko, val, chipEl, values, color, foot) => h('div', { class: 'sm-kpi', id }, h('div', { class: 'lab' }, lab(en, ko)), h('div', { class: 'val' }, val),
      h('div', { class: 'row' }, chipEl || sp('chg flat', '—'), sparkline(values, { width: 104, height: 34, color, fill: true, last: true, label: en + ' trend, 12 months' })),
      h('div', { class: 'avg' }, foot));
    const incA = avgOf(ser.filter((s) => s.income > 0).map((s) => s.income));
    const expA = avgOf(ser.filter((s) => s.expense > 0).map((s) => s.expense));
    const rateA = avgOf(ser.map((s) => s.rate));
    const nwC = ctx.nwSeries[ctx.nwSeries.length - 1] - ctx.nwSeries[0];
    card.append(h('div', { class: 'sm-kpis', id: 'sm-kpis' },
      tile('sm-k-nw', 'Net worth', '순자산', money(ctx.bs.net), chg(nwD, true), ctx.nwSeries, 'var(--c2)', ['12-mo change (12개월 변화) ', chg(nwC, true)]),
      tile('sm-k-in', 'Income', '수입', money(cur.income), hasPrev ? chg(cur.income - prev.income, true) : null, ser.map((s) => s.income), 'var(--c1)', '12-mo avg (12개월 평균) ' + (incA === null ? '—' : money(incA))),
      tile('sm-k-out', 'Spending', '지출', money(cur.expense), hasPrev ? chg(cur.expense - prev.expense, false) : null, ser.map((s) => s.expense), 'var(--c4)', '12-mo avg (12개월 평균) ' + (expA === null ? '—' : money(expA))),
      tile('sm-k-rate', 'Savings rate', '저축률', cur.rate === null ? '—' : r1(cur.rate) + '%', rateD !== null ? chg(rateD, true, '', 'pp') : null, ser.map((s) => s.rate), 'var(--c7)', '12-mo avg (12개월 평균) ' + (rateA === null ? '—' : Math.round(rateA * 10) / 10 + '%'))));
    return card;
  }

  // ───────── 3) 이번 달 전망 ─────────
  page.append(forecastCard());
  function forecastCard() {
    const fc = ctx.fc, bc = ctx.budgetCmp;
    const title = fc.done ? ['Month result', '월 결과'] : isNow ? ['This month outlook', '이번 달 전망'] : ['Forecast', '예상'];
    const card = h('section', { class: 'card sm-card sm-fc', id: 'sm-forecast' });
    const deficit = !fc.done && fc.projNet < 0;
    if (deficit) card.classList.add('sm-deficit');
    card.append(cardHead(title[0], title[1], fc.done ? 'Closed (마감된 달)' : 'Day ' + fc.day + ' of ' + fc.dim + ' (' + fc.day + '일째 / ' + fc.dim + '일)'));
    const stat = (id, en, ko, val, sub, cls) => h('div', { class: 'sm-stat ' + (cls || ''), id }, h('div', { class: 'lab' }, lab(en, ko)), h('div', { class: 'val' }, val), sub ? h('div', { class: 'sub' }, sub) : null);
    const stats = h('div', { class: 'sm-stats' });
    if (fc.done) {
      const left = L.round(fc.actualIncome - fc.actualExpense, 2);
      stats.append(
        stat('sm-f-spent', 'Spending', '지출', money(fc.actualExpense), 'Whole month (한 달 전체)'),
        stat('sm-f-inc', 'Income', '수입', money(fc.actualIncome), ''),
        stat('sm-f-left', left >= 0 ? 'Left over' : 'Shortfall', left >= 0 ? '남은 돈' : '부족', (left >= 0 ? '▲ ' : '▼ ') + money(Math.abs(left)), cur.rate === null ? '' : 'Savings rate (저축률) ' + r1(cur.rate) + '%', left >= 0 ? 'good' : 'bad'));
    } else {
      stats.append(
        stat('sm-f-spent', 'Spent so far', '지금까지 지출', money(fc.actualExpense), fc.projExpense > 0 ? Math.round(fc.actualExpense / fc.projExpense * 100) + '% of expected (예상의)' : ''),
        stat('sm-f-exp', 'Expected spending', '월말 예상 지출', money(fc.projExpense), 'Usual pace (평소 속도 기준)'),
        stat('sm-f-inc', 'Expected income', '월말 예상 수입', money(fc.projIncome), fc.actualIncome > 0 ? 'Received so far (지금까지) ' + money(fc.actualIncome) : ''),
        stat('sm-f-left', fc.projNet >= 0 ? 'Left over' : 'Shortfall', fc.projNet >= 0 ? '남는 돈 예상' : '부족 예상', (fc.projNet >= 0 ? '▲ ' : '▼ ') + money(Math.abs(fc.projNet)), fc.projIncome > 0 ? 'Savings rate (저축률) ' + Math.round(fc.projNet / fc.projIncome * 1000) / 10 + '%' : '', fc.projNet >= 0 ? 'good' : 'bad'));
    }
    card.append(stats);
    if (deficit) {
      card.append(h('div', { class: 'sm-warnbox', id: 'sm-deficit', role: 'alert' }, icon('alert', 20),
        h('div', null, h('b', null, '월말에 ' + money(-fc.projNet) + ' 부족할 것 같아요'), ' (Deficit expected). 남은 ' + Math.max(0, fc.dim - fc.day) + '일 동안 변동비(식료품·외식·쇼핑)를 줄이면 막을 수 있어요.')));
    } else if (!fc.done && fc.day > 0) {
      card.append(h('p', { class: 'sm-fc-ok' }, '이대로면 월말에 약 ' + money(fc.projNet) + ' 남을 것 같아요.'));
    }
    if (bc && bc.hasBudget) {
      const pct = bc.pct === null ? 0 : bc.pct;
      const bar = h('div', { class: 'bar sm-budget', id: 'sm-budget', role: 'img', 'aria-label': pct + '% of budget used' }, h('i', { class: 'bar-fill ' + bc.status, style: 'width:' + Math.max(0, Math.min(100, pct)) + '%' }));
      if (bc.paceFraction !== null && bc.paceFraction !== undefined) bar.append(h('b', { class: 'bar-pace', style: 'left:' + Math.round(bc.paceFraction * 100) + '%' }));
      card.append(h('div', { class: 'sm-bwrap' },
        h('div', { class: 'sm-brow' }, h('b', null, lab('Budget used', '예산 사용'), ' ' + pct + '%'), sp('muted', money(bc.totalActual) + ' of ' + money(bc.totalBudget))),
        bar,
        h('div', { class: 'note' }, bc.status === 'over' ? '예산을 ' + money(bc.totalActual - bc.totalBudget) + ' 넘겼어요 (Over budget).' : money(bc.left) + ' left (남음)'
          + (bc.paceFraction !== null ? ' · 검은 선 = 오늘까지 쓸 만큼 (' + Math.round(bc.paceFraction * 100) + '%)' : ''))));
    } else {
      card.append(h('div', { class: 'note', id: 'sm-nobudget' }, 'No budget for this month (이 달 예산이 없어요). ', h('button', { type: 'button', class: 'linkbtn', onclick: () => api.go('plan') }, 'Set a budget (예산 정하기)')));
    }
    return card;
  }

  // ───────── 4) 인터랙티브 차트 ─────────
  page.append(sectHead('sm-charts-h', 'Charts', '차트', 'Tap to explore (눌러서 살펴보세요)'));
  const cgrid = h('div', { class: 'sm-grid', id: 'sm-grid' });
  page.append(cgrid);
  const CH = lay === 'desktop' ? 280 : 240;
  const ccard = (id, cls, en, ko, hint) => { const c = h('section', { class: 'card sm-card sm-cc ' + cls, id }); c.append(cardHead(en, ko)); if (hint) c.append(h('div', { class: 'sm-hint' }, hint)); return c; };
  const labels12 = ctx.months.map(mshort);
  const curIdx = ctx.months.indexOf(ym);

  // (a) 12개월 수입 vs 지출 + 순수입
  {
    const c = ccard('sm-c-bars', 'sm-a', 'Income vs spending', '수입 대 지출', 'Tap a bar to open that month (막대를 누르면 그 달로 이동해요)');
    const inc = ctx.series.map((s) => s.income), out = ctx.series.map((s) => s.expense), net = ctx.series.map((s) => s.net);
    const chart = barChart({
      title: 'Income vs spending, ' + L.monthLabel(ctx.months[0]) + ' to ' + L.monthLabel(ym), labels: labels12, mode: 'grouped', height: CH, fmt: money, axisFmt: axisMoney, selected: curIdx,
      series: [{ key: 'in', name: 'Income (수입)', color: 'var(--c1)', values: inc }, { key: 'out', name: 'Spending (지출)', color: 'var(--c2)', values: out }],
      lines: [{ key: 'net', name: 'Net (순수입)', color: 'var(--c3)', values: net }],
      onSelect: (i) => goMonth(ctx.months[i])
    });
    c.append(chart);
    const n = ctx.series.filter((s) => s.income || s.expense).length || 1;
    c.append(h('div', { class: 'sm-readout', id: 'sm-bars-note' }, h('b', null, '12-mo average (12개월 평균): '),
      'income ' + money(sum(inc) / n) + ' · spending ' + money(sum(out) / n) + ' · net ' + money(sum(net) / n) + ' / month'));
    cgrid.append(c);
  }

  // (b) 순자산 추이
  {
    const c = ccard('sm-c-nw', 'sm-b', 'Net worth trend', '순자산 추이', 'Tap a point for details (점을 누르면 자세히)');
    const vals = ctx.nwSeries;
    const lo = Math.min(...vals), hi = Math.max(...vals);
    let yMin;
    if (lo > 0 && hi - lo < hi * 0.5) { const pad = Math.max((hi - lo) * 0.35, hi * 0.02); const raw = lo - pad; const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1)))) / 2; yMin = Math.max(0, Math.floor(raw / mag) * mag); }
    const readout = h('div', { class: 'sm-readout', id: 'sm-nw-note' });
    const paint = (i) => {
      const d = i > 0 ? vals[i] - vals[i - 1] : null;
      fill(readout, h('b', null, L.monthLabel(ctx.months[i]) + ' · ' + money(vals[i])), ' ', d === null ? null : [chg(d, true), sp('muted', ' vs previous month (전월 대비)')],
        i !== curIdx ? [' ', h('button', { type: 'button', class: 'linkbtn', id: 'sm-nw-go', onclick: () => goMonth(ctx.months[i]) }, 'Open this month (이 달로 이동)')] : null);
    };
    const chart = lineChart({
      title: 'Net worth, last 12 months', labels: labels12, height: CH, fmt: money, axisFmt: axisMoney, smooth: true, markers: false, yMin, selected: curIdx, legend: false,
      series: [{ key: 'nw', name: 'Net worth (순자산)', color: 'var(--c2)', values: vals, area: true, width: 2.5 }],
      onSelect: (i) => paint(i)
    });
    c.append(chart, readout);
    paint(curIdx);
    cgrid.append(c);
  }

  // (c) 지출 그룹 도넛  +  (d) 카테고리 hbars (c 를 누르면 d 가 걸러짐)
  const groupSlices = GROUPS.map((g) => ({ key: g.key, name: gname(g), value: cur[g.field] || 0, color: g.color })).filter((s) => s.value > 0);
  if (UI.group && !groupSlices.some((s) => s.key === UI.group)) UI.group = null;
  let groupDonut = null;
  let paintCats = () => {};
  {
    const c = ccard('sm-c-groups', 'sm-c', 'Spending by group', '지출 그룹', 'Tap a slice to filter the categories (조각을 누르면 카테고리가 걸러져요)');
    groupDonut = donut({
      title: 'Spending by group, ' + L.monthLabel(ym), fmt: money, slices: groupSlices, selected: UI.group, centerLabel: L.monthLabel(ym) + ' spending (지출)', centerValue: money(cur.expense),
      onSelect: (k) => setGroup(k, true)
    });
    c.append(groupDonut);
    cgrid.append(c);
  }
  const catIndex = new Map();
  function setGroup(k, fromDonut) {
    UI.group = k || null; UI.catMore = false;
    if (!fromDonut && groupDonut) groupDonut.update({ selected: UI.group });
    paintCats();
  }
  {
    const c = ccard('sm-c-cats', 'sm-d', 'Top categories', '상위 카테고리', 'Tap a row to see its transactions (줄을 누르면 거래 목록)');
    const chips = h('div', { class: 'chips sm-chips', id: 'sm-cat-chips' });
    const more = h('button', { type: 'button', class: 'btn secondary sm', id: 'sm-cat-more' });
    const note = h('div', { class: 'sm-readout', id: 'sm-cat-note' });
    const hb = hbars({
      title: 'Top spending categories', fmt: money, rows: [],
      onSelect: (key) => { const l = catIndex.get(String(key)); if (l) openCat(l); }
    });
    paintCats = () => {
      catIndex.clear();
      const list = [];
      ctx.cmp.groups.forEach((g) => {
        if (UI.group && g.key !== UI.group) return;
        const gd = GROUPS.find((x) => x.key === g.key);
        g.lines.forEach((l) => { if (l.cur > 0) list.push({ l, gd }); });
      });
      list.sort((a, b) => b.l.cur - a.l.cur);
      const total = sum(list.map((x) => x.l.cur));
      const shown = UI.catMore ? list.slice(0, 20) : list.slice(0, 8);
      const rows = shown.map(({ l, gd }) => {
        catIndex.set(String(l.id), l);
        const sub = [];
        if (l.budget > 0) sub.push(l.cur > l.budget ? money(l.cur - l.budget) + ' over budget (예산 초과)' : Math.round(l.cur / l.budget * 100) + '% of budget (예산 대비)');
        if (Math.abs(l.delta) >= 1) sub.push((l.delta > 0 ? '▲ ' : '▼ ') + money(Math.abs(l.delta)) + ' vs last month (지난달 대비)');
        return {
          key: String(l.id), name: l.name + (l.name_ko && l.name_ko !== l.name ? ' (' + l.name_ko + ')' : ''), value: l.cur, marker: l.budget > 0 ? l.budget : undefined,
          sub: sub.join(' · '), pct: total > 0 ? l.cur / total * 100 : undefined, color: gd ? gd.color : undefined
        };
      });
      hb.update({ rows });
      fill(chips, 
        h('button', { type: 'button', class: 'chipf' + (!UI.group ? ' on' : ''), id: 'sm-g-all', onclick: () => setGroup(null) }, 'All (전체)'),
        GROUPS.filter((g) => (cur[g.field] || 0) > 0).map((g) => h('button', { type: 'button', class: 'chipf' + (UI.group === g.key ? ' on' : ''), 'data-group': g.key, onclick: () => setGroup(g.key) }, gname(g))));
      more.hidden = list.length <= 8;
      more.textContent = UI.catMore ? 'Show fewer (접기)' : 'Show all ' + list.length + ' (' + list.length + '개 모두 보기)';
      note.textContent = list.length ? (UI.group ? gname(GROUPS.find((g) => g.key === UI.group)) + ' total (합계) ' : 'Total (합계) ') + money(total) + ' · ' + list.length + ' categories (카테고리 ' + list.length + '개)' : '';
    };
    more.onclick = () => { UI.catMore = !UI.catMore; paintCats(); };
    c.append(chips, hb, h('div', { class: 'sm-more' }, more), note);
    cgrid.append(c);
    paintCats();
  }

  // (e) 폭포: 수입 → 그룹별 지출 → 남는 돈
  {
    const c = ccard('sm-c-flow', 'sm-e', 'Where the money went', '돈의 흐름', 'Income → spending groups → what is left (수입 → 지출 → 남는 돈)');
    const steps = [{ key: 'in', name: 'Income (수입)', value: cur.income, type: 'total', color: 'var(--ch-pos)' }];
    GROUPS.forEach((g) => { const v = cur[g.field] || 0; if (v > 0) steps.push({ key: g.field, name: gname(g), value: -v, type: 'delta', color: g.color }); });
    steps.push({ key: 'left', name: cur.net >= 0 ? 'Left (남는 돈)' : 'Short (부족)', type: 'total', color: cur.net >= 0 ? 'var(--ch-pos)' : 'var(--ch-neg)' });
    c.append(waterfall({ title: 'Cash flow for ' + L.monthLabel(ym), steps, fmt: money, axisFmt: axisMoney, height: CH }));
    c.append(h('div', { class: 'sm-readout' }, h('b', null, cur.net >= 0 ? 'Left over (남는 돈) ' : 'Shortfall (부족) '), chg(cur.net, true), cur.rate !== null ? sp('muted', ' · savings rate (저축률) ' + r1(cur.rate) + '%') : null));
    cgrid.append(c);
  }

  // (f) 자산 / 부채 구성
  {
    const c = ccard('sm-c-comp', 'sm-f', 'Assets & debts', '자산·부채 구성', 'Tap a slice or row (조각이나 줄을 눌러 보세요)');
    const pos = ctx.pos;
    const data = (k) => (k === 'A'
      ? { label: 'Total assets (총자산)', total: pos.totalAssets, slices: [
        { key: 'cash', name: 'Cash (현금)', value: pos.cash, color: 'var(--c1)' }, { key: 'invest', name: 'Investments (투자)', value: pos.invest, color: 'var(--c7)' },
        { key: 'fixed', name: 'Home & vehicles (집·차)', value: pos.fixed, color: 'var(--c2)' }, { key: 'other', name: 'Other (기타)', value: pos.other, color: 'var(--c5)' }] }
      : { label: 'Total debts (총부채)', total: pos.totalDebt, slices: [
        { key: 'card', name: 'Credit cards (카드)', value: pos.card, color: 'var(--c4)' }, { key: 'loan', name: 'Loans & mortgage (대출·모기지)', value: pos.loan, color: 'var(--c6)' },
        { key: 'loc', name: 'Line of credit (신용한도)', value: pos.loc, color: 'var(--c8)' }, { key: 'accrued', name: 'Accrued (미지급)', value: pos.accrued, color: 'var(--c3)' }] });
    const seg = h('div', { class: 'segtd sm', role: 'tablist', id: 'sm-comp-seg' }, [['A', 'Assets', '자산'], ['D', 'Debts', '부채']].map((x) => h('button', {
      type: 'button', id: 'sm-comp-' + x[0], role: 'tab', 'data-k': x[0], class: UI.comp === x[0] ? 'on' : '', 'aria-selected': String(UI.comp === x[0]),
      onclick: () => { UI.comp = x[0]; paint(); }
    }, lab(x[1], x[2]))));
    const d0 = data(UI.comp);
    const ch = donut({ title: 'Assets and debts', fmt: money, slices: d0.slices, centerLabel: d0.label, centerValue: money(d0.total) });
    const note = h('div', { class: 'sm-readout', id: 'sm-comp-note' });
    function paint() {
      const d = data(UI.comp);
      seg.querySelectorAll('button').forEach((b) => { const on = b.getAttribute('data-k') === UI.comp; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
      ch.update({ slices: d.slices, centerLabel: d.label, centerValue: money(d.total), selected: null });
      const ratio = pos.totalAssets > 0 ? Math.round(pos.totalDebt / pos.totalAssets * 100) : null;
      fill(note, h('b', null, 'Net worth (순자산) ' + money(pos.net)), ratio === null ? null : sp('muted', ' · debt ratio (부채 비율) ' + ratio + '% of assets (자산 대비)'));
    }
    c.append(seg, ch, note);
    paint();
    cgrid.append(c);
  }

  // ───────── 5) 조언 (규칙 기반 · 항상 표시) ─────────
  page.append(sectHead('sm-tips-h', "Advisor's notes", '조언', 'Rule-based, always on (규칙 기반 · 항상 표시)'));
  {
    const tips = ctx.tips || [];
    const wrap = h('div', { class: 'sm-tips', id: 'sm-tips' });
    const LIMIT = 5;
    tips.forEach((t, i) => wrap.append(h('article', { class: 'sm-tip t-' + t.tone + (i >= LIMIT ? ' more' : ''), 'data-tone': t.tone, hidden: i >= LIMIT && !UI.tipsAll },
      h('div', { class: 'ic-wrap' }, icon(TONE_ICON[t.tone] || 'info', 20)),
      h('div', { class: 'tb' },
        h('div', { class: 'th' }, sp('sm-tone', TONE_LABEL[t.tone] || t.tone), h('h3', null, t.title)),
        h('p', null, t.body),
        t.action ? h('div', { class: 'act' }, sp('arr', '→'), sp(null, t.action)) : null))));
    if (!tips.length) wrap.append(h('div', { class: 'card muted' }, '아직 드릴 조언이 없어요. 거래가 쌓이면 여기에 나타나요.'));
    page.append(wrap);
    if (tips.length > LIMIT) {
      const b = h('button', { type: 'button', class: 'btn secondary sm sm-noprint', id: 'sm-tips-more' });
      const paint = () => { wrap.querySelectorAll('.sm-tip.more').forEach((el) => { el.hidden = !UI.tipsAll; }); b.textContent = UI.tipsAll ? 'Show fewer (접기)' : 'Show all ' + tips.length + ' notes (' + tips.length + '개 모두 보기)'; };
      b.onclick = () => { UI.tipsAll = !UI.tipsAll; paint(); };
      paint();
      page.append(h('div', { class: 'sm-more' }, b));
    }
  }

  // ───────── 6) AI 브리핑 / 질문 ─────────
  page.append(sectHead('sm-ai-h', 'AI briefing', 'AI 브리핑', 'Only when you tap (버튼을 눌렀을 때만 실행)'));
  const aiHost = h('section', { class: 'card sm-card sm-ai', id: 'sm-ai' });
  page.append(aiHost);
  root.smReady = mountAI(aiHost);

  function availability() {
    if (ctx.meta && ctx.meta.ai && ctx.meta.ai.enabled === false) return { ok: false, why: 'AI 기능이 설정에서 꺼져 있어요. Settings (설정)에서 켜면 쓸 수 있어요.' };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, why: '오프라인이에요. 인터넷에 연결되면 AI 브리핑을 받을 수 있어요. (위의 조언 카드는 오프라인에서도 그대로 보여요.)' };
    let ok = false;
    try { ok = ai.aiAvailable(); } catch (e) { ok = false; }
    if (ok) return { ok: true };
    const signed = !!(api.auth && api.auth.getToken && api.auth.getToken());
    return { ok: false, why: signed ? 'AI 서버 주소가 설정되지 않았어요. 설정(Settings)을 확인하세요.' : '로그인이 필요해요. 위쪽의 로그인 버튼(Sign in)을 누른 뒤 다시 와 주세요. (위의 조언 카드는 로그인 없이도 보여요.)' };
  }

  function errHint(e) {
    switch (e && e.code) {
      case 'auth': return '로그인 상태를 확인하세요. 로그인 후 다시 눌러 주세요.';
      case 'quota': return '하루 무료 한도를 모두 썼어요. 내일 다시 시도하거나, 위의 조언 카드를 참고하세요.';
      case 'rate': return '너무 자주 눌렀어요. 1분쯤 뒤에 다시 눌러 주세요.';
      case 'offline': case 'timeout': return '연결을 확인한 뒤 다시 눌러 주세요. 눌러야만 요청이 가요.';
      case 'outdated': return 'Apps Script 를 v4 로 다시 배포해야 해요.';
      case 'bad_request': return '입력을 확인한 뒤 다시 시도하세요.';
      default: return '잠시 뒤에 다시 시도하세요.';
    }
  }
  const errView = (e) => h('div', { class: 'sm-err', role: 'alert' }, icon('alert', 20), h('div', null, h('b', null, (e && e.message) || '알 수 없는 오류가 났어요.'), h('div', { class: 'hint' }, errHint(e))));
  function adviceView(d, opts) {
    const box = h('div', { class: 'sm-adv' });
    if (opts && opts.q) box.append(h('p', { class: 'sm-adv-q' }, sp('qmark', 'Q'), opts.q));
    if (d.headline) box.append(h('p', { class: 'sm-adv-h' }, d.headline));
    if (d.answer) d.answer.split(/\n{1,}/).filter(Boolean).forEach((p) => box.append(h('p', { class: 'sm-adv-a' }, p)));
    (d.sections || []).forEach((s) => box.append(h('div', { class: 'sm-adv-sec t-' + s.tone }, h('h4', null, sp('sm-tone', TONE_LABEL[s.tone] || s.tone), s.title), h('ul', null, s.points.map((p) => h('li', null, p))))));
    if (d.actions && d.actions.length) {
      box.append(h('div', { class: 'sm-adv-act' }, h('h4', null, lab('Next steps', '다음 할 일')),
        h('ol', null, d.actions.map((a) => h('li', null, h('b', null, a.title), a.why ? h('div', { class: 'why' }, a.why) : null, a.impact ? sp('sm-impact', a.impact) : null)))));
    }
    if (d.caveat) box.append(h('p', { class: 'sm-caveat' }, d.caveat));
    return box;
  }

  function mountAI(host) {
    const aiCtx = I.aiContext(ctx);
    const run = ++UI.aiRun;
    const live = () => run === UI.aiRun && host.isConnected;
    const av = availability();
    const S = { data: null, at: 0, err: null, busy: false };
    const Q = { busy: false, err: null };

    const goBtn = h('button', { type: 'button', class: 'btn', id: 'sm-ai-go', disabled: !av.ok, onclick: () => runSummary(!!S.data) });
    const meta = h('div', { class: 'sm-ai-meta', id: 'sm-ai-meta' });
    const out = h('div', { class: 'sm-ai-out', id: 'sm-ai-out', 'aria-live': 'polite' });
    const qIn = h('input', { type: 'text', id: 'sm-q', maxlength: String(ai.MAX_QUESTION), autocomplete: 'off', enterkeyhint: 'send', placeholder: '궁금한 점을 적어 보세요 (Ask anything)', value: UI.askQ, disabled: !av.ok,
      oninput: () => { UI.askQ = qIn.value; count.textContent = qIn.value.length + ' / ' + ai.MAX_QUESTION; },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); runAsk(); } } });
    const count = h('span', { class: 'sm-count', id: 'sm-q-count' }, qIn.value.length + ' / ' + ai.MAX_QUESTION);
    const askBtn = h('button', { type: 'button', class: 'btn', id: 'sm-ask-go', disabled: !av.ok, onclick: () => runAsk() }, icon('send', 18), 'Ask (질문하기)');
    const qErr = h('div', { class: 'err', id: 'sm-ask-err', role: 'alert' });
    const aOut = h('div', { class: 'sm-ai-out', id: 'sm-ask-out', 'aria-live': 'polite' });
    const chips = h('div', { class: 'chips sm-ex', id: 'sm-ex' }, ASK_EXAMPLES.map((q, i) => h('button', { type: 'button', class: 'chipf', 'data-i': String(i), disabled: !av.ok, onclick: () => { qIn.value = q; UI.askQ = q; count.textContent = q.length + ' / ' + ai.MAX_QUESTION; qIn.focus(); } }, q)));

    host.append(
      h('div', { class: 'sm-ai-head' }, h('span', { class: 'sm-ai-ic' }, icon('spark', 22)), h('div', null, h('h3', null, lab('AI briefing', 'AI 브리핑')), h('div', { class: 'sm-sub' }, '이번 달 숫자를 보고 private banker 처럼 짚어 드려요.'))),
      av.ok ? '' : h('div', { class: 'sm-ai-off', id: 'sm-ai-why', role: 'status' }, icon('info', 20), h('div', null, av.why)),
      h('div', { class: 'btnrow sm-noprint' }, goBtn),
      meta, out,
      h('hr', { class: 'sm-hr' }),
      h('h3', { class: 'sm-q-h' }, lab('Ask a question', '질문하기')),
      h('div', { class: 'sm-ask-row sm-noprint' }, qIn, askBtn),
      h('div', { class: 'sm-qmeta sm-noprint' }, count),
      qErr, chips, aOut,
      h('p', { class: 'sm-priv', id: 'sm-priv' }, icon('lock', 14), PRIVACY));

    function paintS() {
      goBtn.className = 'btn' + (S.data ? ' secondary' : '');
      goBtn.disabled = !av.ok || S.busy;
      if (S.busy) fill(goBtn, sp('sm-spin'), 'Analyzing… (분석 중이에요, 보통 10~20초)');
      else fill(goBtn, icon(S.data ? 'sync' : 'spark', 18), S.data ? 'Refresh (새로 받기)' : 'Get AI briefing (AI 브리핑 받기)');
      if (S.data) UI.lastAi = { ym, data: S.data };
      meta.textContent = S.data && !S.busy ? ago(S.at) + '에 받은 브리핑이에요 · 12시간 안에는 같은 숫자로 다시 묻지 않아요' : '';
      if (S.err) fill(out, errView(S.err));
      else if (S.data) fill(out, adviceView(S.data));
      else if (S.busy) fill(out, h('div', { class: 'sm-skel' }, h('i'), h('i'), h('i')));
      else fill(out, h('p', { class: 'sm-ai-hint' }, av.ok ? '버튼을 누르면 AI 가 현금 흐름·부채·지출 변화를 종합해 요약과 다음 할 일을 알려 드려요. 누르기 전에는 아무것도 전송되지 않아요.' : ''));
    }
    async function runSummary(force) {
      if (S.busy || !av.ok) return;
      S.busy = true; S.err = null; paintS();
      try {
        const d = await ai.advise('summary', aiCtx, { force: !!force });
        if (!live()) return;
        const rec = await ai.cachedAdvice('summary', aiCtx);
        S.data = d; S.at = rec ? rec.at : Date.now();
      } catch (e) { if (!live()) return; S.err = e; }
      S.busy = false; if (live()) paintS();
    }
    function paintA() {
      askBtn.disabled = !av.ok || Q.busy;
      if (Q.busy) fill(askBtn, sp('sm-spin'), 'Thinking… (생각 중)'); else fill(askBtn, icon('send', 18), 'Ask (질문하기)');
      qErr.textContent = '';
      if (Q.err && Q.err.local) { qErr.textContent = Q.err.message; fill(aOut); return; }
      if (Q.err) fill(aOut, errView(Q.err));
      else if (Q.busy) fill(aOut, h('div', { class: 'sm-skel' }, h('i'), h('i')));
      else if (UI.ask && UI.ask.ym === ym) fill(aOut, adviceView(UI.ask.data, { q: UI.ask.q }));
      else fill(aOut);
    }
    async function runAsk() {
      if (Q.busy || !av.ok) return;
      const q = qIn.value.trim();
      UI.askQ = qIn.value;
      if (!q) { Q.err = { local: true, message: '질문을 입력하세요. 아래 예시를 눌러 채울 수도 있어요.' }; paintA(); return; }
      if (q.length > ai.MAX_QUESTION) { Q.err = { local: true, message: '질문이 너무 길어요 (최대 ' + ai.MAX_QUESTION + '자, 지금 ' + q.length + '자).' }; paintA(); return; }
      Q.busy = true; Q.err = null; paintA();
      try {
        const d = await ai.advise('ask', aiCtx, { question: q });
        if (!live()) return;
        UI.ask = { ym, q, data: d, at: Date.now() };
      } catch (e) { if (!live()) return; Q.err = e; }
      Q.busy = false; if (live()) paintA();
    }
    paintS(); paintA();
    // 저장된 답변이 있으면 바로 보여 줌 (서버를 부르지 않음)
    return (async () => {
      if (!av.ok) return;
      const hit = await ai.cachedAdvice('summary', aiCtx);
      if (hit && live() && !S.data && !S.busy) { S.data = hit.data; S.at = hit.at; paintS(); }
    })();
  }

  // ───────── 7) 월 메모 ─────────
  page.append(sectHead('sm-note-h', 'Month note', '월 메모', L.monthLabel(ym)));
  const savedNote = M.readNote(api.data.settings, ym);
  const draft = UI.noteDraft && UI.noteDraft.ym === ym ? UI.noteDraft.text : null;
  const noteArea = h('textarea', { id: 'sm-note', rows: '4', maxlength: '2000', placeholder: '예: 이번 달은 여행 때문에 외식이 늘었어요. 다음 달은 줄이기.', 'aria-label': 'Month note (월 메모)' });
  noteArea.value = draft !== null ? draft : savedNote;
  const noteFlag = h('span', { class: 'sm-unsaved', id: 'sm-note-flag', hidden: true }, '● Not saved yet (저장 안 됨)');
  const noteCnt = h('span', { class: 'sm-count', id: 'sm-note-count' });
  const notePrint = h('div', { class: 'sm-printonly sm-noteprint', id: 'sm-note-print' });
  const noteSave = h('button', { type: 'button', class: 'btn', id: 'sm-note-save', onclick: saveNote }, icon('check', 18), 'Save note (메모 저장)');
  const syncNote = () => {
    const v = noteArea.value;
    noteCnt.textContent = v.length + ' / 2000';
    noteFlag.hidden = v.trim() === savedNote.trim();
    notePrint.textContent = v.trim();
    notePrint.hidden = !v.trim();
  };
  noteArea.addEventListener('input', () => { UI.noteDraft = { ym, text: noteArea.value }; syncNote(); });
  async function saveNote() {
    if (noteSave.disabled) return;
    const text = noteArea.value;
    const row = M.noteRow(api.data.settings, ym, text, L.nowIso());
    if (!row) { api.toast('Nothing to save (저장할 내용이 없어요)'); return; }
    noteSave.disabled = true;
    try {
      await api.saveSettings(row);
      UI.noteDraft = null;
      api.toast(text.trim() ? 'Note saved (메모 저장됨)' : 'Note cleared (메모를 지웠어요)');
    } catch (e) { noteSave.disabled = false; api.toast('저장하지 못했어요: ' + (e && e.message ? e.message : e)); }
  }
  page.append(h('section', { class: 'card sm-card sm-note', id: 'sm-note-card' },
    noteArea, h('div', { class: 'sm-note-bar sm-noprint' }, noteCnt, noteFlag, noteSave),
    notePrint,
    h('div', { class: 'hint sm-noprint' }, '달마다 따로 저장돼요. 요약 복사와 인쇄에도 함께 들어가요. (Saved per month, included in copy and print.)')));
  syncNote();

  // ───────── 8) 정기 결제 · 사람별 · 상위 업체 ─────────
  page.append(sectHead('sm-lists-h', 'Subscriptions, people & vendors', '정기 결제 · 사람별 · 업체'));
  const vendors = I.vendorTable(api.items, api.accMap, [ym], 8);
  const owners = I.ownerTable(api.items, api.accMap, [ym]);
  const trio = h('div', { class: 'sm-trio', id: 'sm-trio' });
  page.append(trio);
  {
    const subs = ctx.subs || [];
    const c = h('section', { class: 'card sm-card sm-subs', id: 'sm-subs' }, cardHead('Subscriptions', '정기 결제', 'Same amount every month (매달 비슷한 금액)'));
    if (!subs.length) c.append(h('div', { class: 'sm-empty muted' }, '아직 정기 결제로 보이는 거래가 없어요. 3개월 이상 비슷한 금액이 반복되면 나타나요.'));
    else {
      const tm = sum(subs.map((s) => s.monthly));
      c.append(h('div', { class: 'sm-sumline', id: 'sm-subs-total' }, h('b', null, money(tm)), ' / month (월)', sp('muted', ' · ' + money(tm * 12) + ' / year (연)')));
      const list = h('div', { class: 'sm-list' });
      const LIM = 6;
      subs.forEach((s, i) => list.append(h('button', { type: 'button', class: 'sm-row' + (i >= LIM ? ' more' : ''), 'data-name': s.name, hidden: i >= LIM && !UI.subsAll, onclick: () => api.goSearch(s.name) },
        h('span', { class: 't' }, s.name, s.cat ? h('span', { class: 's' }, s.cat) : null), h('span', { class: 'v' }, money(s.monthly), h('span', { class: 's' }, money(s.yearly) + ' / yr')))));
      c.append(list);
      if (subs.length > LIM) {
        const b = h('button', { type: 'button', class: 'btn secondary sm sm-noprint', id: 'sm-subs-more' });
        const paint = () => { list.querySelectorAll('.sm-row.more').forEach((el) => { el.hidden = !UI.subsAll; }); b.textContent = UI.subsAll ? 'Show fewer (접기)' : 'Show all ' + subs.length + ' (' + subs.length + '건 모두 보기)'; };
        b.onclick = () => { UI.subsAll = !UI.subsAll; paint(); };
        paint();
        c.append(h('div', { class: 'sm-more' }, b));
      }
    }
    trio.append(c);
  }
  {
    const c = h('section', { class: 'card sm-card sm-people', id: 'sm-people' }, cardHead('People', '사람별', L.monthLabel(ym)));
    if (!owners.length) c.append(h('div', { class: 'sm-empty muted' }, '이 달의 수입·지출 기록이 없어요.'));
    else {
      const tb = h('table', { class: 'sm-mini' }, h('thead', null, h('tr', null, h('th', null, 'Owner (소유자)'), h('th', null, 'Income (수입)'), h('th', null, 'Spending (지출)'), h('th', null, 'Net (순)'))));
      const body = h('tbody');
      owners.forEach((o) => body.append(h('tr', { 'data-owner': o.owner }, h('td', null, o.owner), h('td', null, money(o.income)), h('td', null, money(o.expense)), h('td', { class: o.net >= 0 ? 'in' : 'neg' }, (o.net >= 0 ? '▲ ' : '▼ ') + money(Math.abs(o.net))))));
      if (owners.length > 1) body.append(h('tr', { class: 'tot' }, h('td', null, 'Total (합계)'), h('td', null, money(sum(owners.map((o) => o.income)))), h('td', null, money(sum(owners.map((o) => o.expense)))), h('td', null, money(sum(owners.map((o) => o.net))))));
      tb.append(body);
      c.append(h('div', { class: 'sm-tscroll' }, tb));
    }
    trio.append(c);
  }
  {
    const c = h('section', { class: 'card sm-card sm-vendors', id: 'sm-vendors' }, cardHead('Top vendors', '상위 업체 8곳', L.monthLabel(ym)));
    if (!vendors.length) c.append(h('div', { class: 'sm-empty muted' }, '이 달에는 업체 이름이 있는 지출이 없어요.'));
    else {
      const list = h('div', { class: 'sm-list' });
      vendors.forEach((v) => list.append(h('button', { type: 'button', class: 'sm-row', 'data-name': v.name, onclick: () => api.goSearch(v.name) },
        h('span', { class: 't' }, v.name, h('span', { class: 's' }, (v.cat ? v.cat + ' · ' : '') + v.count + '×, ' + r1(v.share) + '%')),
        h('span', { class: 'v' }, money(v.total), h('span', { class: 'sm-share' }, h('i', { style: 'width:' + Math.max(3, Math.min(100, Math.round(v.share * 2.2))) + '%' }))))));
      c.append(list);
    }
    trio.append(c);
  }

  // ───────── 9) 내보내기 ─────────
  page.append(sectHead('sm-exp-h', 'Export', '내보내기'));
  const fallbackBox = h('div', { class: 'sm-copyfb sm-noprint', id: 'sm-copy-fb', hidden: true });
  page.append(h('section', { class: 'card sm-card sm-export sm-noprint', id: 'sm-export' },
    h('div', { class: 'btnrow' },
      h('button', { type: 'button', class: 'btn', id: 'sm-print', onclick: () => doPrint() }, icon('print', 18), 'Print / Save PDF (인쇄 · PDF 저장)'),
      h('button', { type: 'button', class: 'btn secondary', id: 'sm-copy', onclick: () => doCopy() }, icon('sheet', 18), 'Copy summary (요약 복사)')),
    h('div', { class: 'hint' }, '인쇄 창에서 "PDF 로 저장"을 고르면 파일이 돼요. 복사한 글은 메신저·메일에 바로 붙여 넣을 수 있어요.'),
    fallbackBox));
  page.append(h('div', { class: 'sm-printfoot' }, 'Home Ledger · ' + L.monthLabel(ym) + ' · printed ' + today));

  function summaryText() {
    return T.buildSummaryText({ ctx, ym, note: noteArea.value, owners, vendors, ai: UI.lastAi && UI.lastAi.ym === ym ? UI.lastAi.data : null, today });
  }
  async function doCopy() {
    const text = summaryText();
    const ok = await copyText(text);
    if (ok) { api.toast('Copied (복사했어요) — 메신저·메일에 붙여 넣으세요'); fallbackBox.hidden = true; return; }
    api.toast('Could not copy (자동 복사가 안 돼요) — 아래 글을 길게 눌러 복사하세요');
    const ta = h('textarea', { readonly: true, rows: '10', id: 'sm-copy-text', 'aria-label': 'Summary text (요약 글)' });
    ta.value = text;
    fill(fallbackBox, ta);
    fallbackBox.hidden = false;
    try { ta.focus(); ta.select(); } catch (e) { /* ignore */ }
  }
  function doPrint() {
    try { openPrintReport(api.pageApi ? api.pageApi() : api, { tab: 'summary' }); } catch (e) { api.toast('Could not open print (인쇄 창을 열지 못했어요)'); }
  }

  // ───────── 빈 상태 ─────────
  function emptyView() {
    const v = h('div', { class: 'sm-empty-wrap' });
    v.append(h('section', { class: 'banner sm-banner' }, h('div', { class: 'banner-in' }, h('div', { class: 'banner-row' }, h('div', { class: 'acct-pick' }, h('span', { class: 'nm' }, 'Executive summary (요약)'))),
      h('div', { class: 'sm-hero' }, h('div', { class: 'sm-nw' }, h('div', { class: 'lab' }, lab('Net worth', '순자산')), h('div', { class: 'val' }, '$0'))))));
    v.append(h('div', { class: 'page sm-page' }, h('div', { class: 'card center sm-empty-card', id: 'sm-empty' },
      h('div', { class: 'sm-empty-ic' }, icon('summary', 40)),
      h('h2', null, '아직 거래가 없어요'), h('div', { class: 'muted' }, 'No transactions yet — your summary appears as soon as you add some.'),
      h('p', null, '첫 거래를 추가하면 이 화면에 순자산·월별 추이·재무 건강 점수·조언이 나타나요.'),
      h('div', { class: 'btnrow sm-center' },
        h('button', { type: 'button', class: 'btn', id: 'sm-empty-add', onclick: () => api.openForm(null, {}) }, icon('plus', 18), 'Add first (첫 거래 추가)'),
        h('button', { type: 'button', class: 'btn secondary', id: 'sm-empty-import', onclick: () => api.go('import') }, icon('import', 18), 'Import (가져오기)')))));
    return v;
  }

  return root;
}

/** 클립보드 복사 (navigator.clipboard 가 없거나 막히면 textarea + execCommand) */
export async function copyText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch (e) { /* 아래 대체 방법으로 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px';
    document.body.append(ta);
    ta.focus(); ta.select();
    try { ta.setSelectionRange(0, text.length); } catch (e) { /* ignore */ }
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
    ta.remove();
    return !!ok;
  } catch (e) { return false; }
}
