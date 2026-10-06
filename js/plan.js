// Plan (계획) 화면: Forecast (예측) · Next-year budget (내년 예산) · Debt payoff (부채 상환)
// 숫자 계산은 insights.js / budget.js / valuation.js 가 하고, 여기서는 화면과 "만약에(what-if)" 계산만 합니다.
import * as L from './ledger.js';
import * as B from './budget.js';
import * as M from './meta.js';
import * as V from './valuation.js';
import * as I from './insights.js';
import * as R from './reports.js';
import * as YP from './yearplan.js';
import * as ai from './ai.js';
import { lineChart, compact } from './charts.js';
import { icon } from './icons.js';
import { layoutOf } from './layout.js';

// ───────── 모듈 상태 (탭 이동·저장 후 다시 그려도 유지) ─────────
let tab = 'fc';
const S = {
  growthDraft: null,
  fc: { scope: 'all', cut: 10, inc: 0, cutText: '', incText: '', sel: null },
  ny: { start: null, scope: 'next12', incl: new Map(), edits: new Map(), month: '', confirming: false, done: null, basis: 'year' },
  bu: { sel: null, edits: new Map(), added: new Set() },
  debt: { strategy: null, includeMortgage: false, extraDraft: null, target: '24' }
};
export const setTab = (t) => { if (t === 'fc' || t === 'ny' || t === 'debt') tab = t; };
export const getTab = () => tab;

// ───────── 작은 도구 ─────────
const r2 = (v) => Math.round(v * 100) / 100;
const sum = (a) => a.reduce((s, v) => s + v, 0);
const avg = (a) => (a.length ? sum(a) / a.length : 0);
const m0 = (n) => (Math.round(n) < 0 ? '−' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortMon = (ym) => MON[Number(ym.slice(5, 7)) - 1] + ' ’' + ym.slice(2, 4);
const numIn = (s) => { const n = L.parseAmount(String(s == null ? '' : s)); return Number.isFinite(n) ? n : NaN; };
const nCat = (n) => n + (n === 1 ? ' category' : ' categories');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const put = (el, ...kids) => { el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); };
const axisMoney = (n) => (n < 0 ? '−' : '') + '$' + compact(Math.abs(n));
const spanLabel = (n) => n + ' mo' + (n >= 12 ? ' (' + Math.floor(n / 12) + 'y ' + (n % 12) + 'm)' : '');

export const STRATS = [
  ['avalanche', 'Avalanche', '이율 높은 것부터'],
  ['snowball', 'Snowball', '잔액 작은 것부터'],
  ['none', 'Minimum only', '최소 납입만']
];

// ───────── 순수 계산 (테스트에서도 씀) ─────────

/** 카테고리별로 앞으로 n개월 지출 (I.projectMonths 와 같은 규칙: 예산이 있으면 예산, 없으면 최근 3개월 평균 × 물가) */
export function catProjection(pctx, growthPct, n) {
  const g = growthPct / 100;
  const { items, accMap, budgets, ym } = pctx;
  const hist = I.months(ym, 6).map((m) => R.incomeStatement(items, accMap, m)).filter((s) => s.income > 0 || s.expense > 0);
  const base = new Map();
  hist.slice(-3).forEach((s) => s.expenseGroups.forEach((gr) => gr.lines.forEach((l) => base.set(l.id, (base.get(l.id) || 0) + l.amount / Math.min(3, hist.length)))));
  const out = [];
  for (let i = 1; i <= n; i++) {
    const m = L.shiftMonth(ym, i);
    const bmap = B.budgetMap(budgets, m);
    const cats = new Map();
    new Set(Array.from(base.keys()).concat(Array.from(bmap.keys()))).forEach((id) => {
      cats.set(id, bmap.has(id) ? bmap.get(id) : (base.get(id) || 0) * (1 + g * i / 12));
    });
    out.push({ ym: m, cats });
  }
  return out;
}

/** "만약에": 고른 범위의 지출을 cutPct% 줄이고 수입이 incPct% 늘면 1년 뒤 현금이 얼마나 달라지나 (저장 안 함) */
export function whatIf(cats, rows, accMap, scope, cutPct, incPct) {
  const groupOf = (id) => { const a = accMap.get(String(id)); return (a && a.report_group) || '확인 필요'; };
  const inScope = (id) => scope === 'all' || (scope.indexOf('grp:') === 0 ? groupOf(id) === scope.slice(4) : scope === 'cat:' + id);
  let scopeTotal = 0, incTotal = 0, cum = 0;
  const cashSeries = [];
  cats.forEach((p, i) => {
    let s = 0;
    p.cats.forEach((v, id) => { if (inScope(id)) s += v; });
    scopeTotal += s;
    incTotal += rows[i].income;
    cum += s * (cutPct || 0) / 100 + rows[i].income * (incPct || 0) / 100;
    cashSeries.push(r2(rows[i].cash + cum));
  });
  const saved = scopeTotal * (cutPct || 0) / 100, added = incTotal * (incPct || 0) / 100;
  const extra = saved + added;
  const base = rows.length ? rows[rows.length - 1].cash : 0;
  return { scopeTotal: r2(scopeTotal), saved: r2(saved), added: r2(added), extra: r2(extra), perMonth: r2(extra / Math.max(1, rows.length)), cash0: base, cash1: r2(base + extra), cashSeries };
}

export const isMortgage = (d) => d.kind === 'loan' && (/mortgage|모기지|주택/i.test((d.name || '') + ' ' + (d.name_ko || '')) || d.balance >= 100000);
/** 상환 시뮬레이션에 넣을 부채 (발생 부채는 항상 제외, 모기지는 선택) */
export const planDebts = (debts, includeMortgage) => (debts || []).filter((d) => d.kind !== 'accrued' && (includeMortgage || !isMortgage(d)));

/** 목표 개월 안에 다 갚으려면 매달 얼마를 더 내야 하나 (이분법, 센트 단위로 올림) */
export function extraForTarget(debts, strategy, targetMonths) {
  const ok = (x) => { const p = V.payoffPlan(debts, x, strategy); return !p.neverEnds && p.months <= targetMonths; };
  if (!debts.length || !(targetMonths >= 1)) return null;
  if (ok(0)) return { extra: 0, already: true };
  let lo = 0, hi = Math.max(1, sum(debts.map((d) => d.balance * (1 + d.apr / 1200)))) + 1;
  for (let i = 0; i < 70; i++) { const mid = (lo + hi) / 2; if (ok(mid)) hi = mid; else lo = mid; }
  let e = Math.ceil(hi * 100) / 100;
  while (!ok(e) && e < hi + 1) e = r2(e + 0.01);
  return { extra: e, already: false };
}

/** 전략 세 가지 비교 + 추천 (총 이자가 가장 적은 쪽) */
export function comparePlans(debts, extra) {
  const plans = {};
  STRATS.forEach(([k]) => { plans[k] = V.payoffPlan(debts, extra, k); });
  let rec = null;
  ['avalanche', 'snowball'].forEach((k) => {
    const p = plans[k];
    if (p.neverEnds) return;
    if (!rec || p.totalInterest < plans[rec].totalInterest - 0.005) rec = k;
  });
  return { plans, rec };
}

// ───────── 화면 ─────────
export function render(api) {
  const { h, state } = api;
  const lay = layoutOf();
  const phone = lay === 'phone', desktop = lay === 'desktop';
  const meta = api.meta();
  const ctx = api.analysis();
  const today = api.today;
  // 올해 남은 달을 내가 직접 입력해 두었으면(상향식) 이번 달 예상도 그 입력을 따릅니다
  const savedPlan = YP.readPlan(api.data.settings);
  let fc = ctx.fc;
  if (L.monthOf(today) === state.month && !ctx.fc.done && savedPlan.cells[state.month] && Object.keys(savedPlan.cells[state.month]).length) {
    const g0 = Number(meta.plan.growth);
    const ol0 = YP.yearOutlook({ items: api.items, accMap: api.accMap, budgets: api.data.budgets || [], plan: savedPlan, today, growth: Number.isFinite(g0) ? g0 : 3 });
    const t0 = ol0.monthTotals[state.month];
    if (t0) fc = Object.assign({}, ctx.fc, { projExpense: t0.expense, projIncome: t0.income, projNet: r2(t0.income - t0.expense), remaining: r2(Math.max(0, t0.expense - ctx.fc.actualExpense)) });
  }
  const inProg = L.monthOf(today) === state.month && !fc.done;
  // 이번 달이 한창 진행 중이면 "지난 3개월(완료된 달)" 로 예측하고, 이번 달 남은 몫은 현금 시작점에 더함
  const pItems = inProg ? api.items.filter((it) => L.monthOf(it.txn.date) !== state.month) : api.items;
  const startCash = r2((ctx.pos.liquid || 0) + (inProg ? fc.projNet - (fc.actualIncome - fc.actualExpense) : 0));
  const pctx = Object.assign({}, ctx, { items: pItems, accMap: api.accMap, budgets: api.data.budgets || [], ym: state.month, liquid: startCash });
  const basisYm = inProg ? L.shiftMonth(state.month, -1) : state.month;

  if (S.ny.month !== state.month) { S.ny.month = state.month; S.ny.edits = new Map(); S.ny.confirming = false; }
  const savedGrowth = Number(meta.plan.growth);
  if (S.growthDraft !== null && Math.abs(S.growthDraft - savedGrowth) < 1e-9) S.growthDraft = null;
  const curGrowth = () => (S.growthDraft !== null ? S.growthDraft : (Number.isFinite(savedGrowth) ? savedGrowth : 3));
  const savedStrat = ['avalanche', 'snowball', 'none'].indexOf(meta.plan.strategy) >= 0 ? meta.plan.strategy : 'avalanche';
  const savedExtra = Number(meta.plan.extra) || 0;
  const dStrat = () => S.debt.strategy || savedStrat;
  const dExtra = () => (S.debt.extraDraft !== null ? S.debt.extraDraft : savedExtra);

  // ── 공통 부품
  const badge = (txt, cls, title) => h('span', { class: 'pl-badge ' + (cls || ''), title: title || null }, txt);
  const arrow = (v, goodUp, text) => {
    if (Math.abs(v) < 0.5) return h('span', { class: 'chg flat' }, '—');
    const good = goodUp === false ? v < 0 : v > 0;
    return h('span', { class: 'chg ' + (good ? 'good' : 'bad') }, h('span', { class: 'arw' }, v > 0 ? '▲' : '▼'), text !== undefined ? text : m0(Math.abs(v)));
  };
  const chip = (label, on, fn, id, extra) => h('button', { type: 'button', class: 'pl-chip' + (on ? ' on' : '') + (extra ? ' ' + extra : ''), id: id || null, 'aria-pressed': String(!!on), onclick: fn }, label);
  const heading = (en, ko, right) => h('div', { class: 'pl-h' }, h('h3', null, en, ' ', h('span', { class: 'ko' }, '(' + ko + ')')), right || null);
  const stepBtn = (dir, lab) => h('button', { type: 'button', class: 'stepbtn', 'aria-label': lab, onclick: () => { state.month = L.shiftMonth(state.month, dir); api.rerender(); } }, icon(dir < 0 ? 'left' : 'right', 20));
  const aiOn = () => meta.ai.enabled !== false;
  const goWealth = () => api.go('wealth');

  async function savePlan(patch, msg) {
    const row = M.metaRow(api.data.settings, M.KEYS_META.plan, Object.assign({}, api.meta().plan, patch), 'plan', L.nowIso());
    await api.saveSettings(row);
    api.toast(msg || 'Saved (저장됨)');
  }

  // ── AI 결과 (두 곳에서 같이 씀)
  function aiBlock(res, at, cached) {
    const wrap = h('div', { class: 'pl-ai' });
    if (cached) wrap.append(h('div', { class: 'pl-ai-meta' }, icon('info', 16), 'Saved result from ' + new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' (저장된 결과)'));
    if (res.headline) wrap.append(h('div', { class: 'pl-ai-head' }, res.headline));
    res.sections.forEach((s) => wrap.append(h('div', { class: 'pl-ai-sec ' + s.tone }, h('div', { class: 'pl-ai-t' }, s.title), h('ul', null, s.points.map((p) => h('li', null, p))))));
    if (res.actions.length) {
      wrap.append(h('div', { class: 'pl-ai-t act' }, 'Next steps (다음 할 일)'));
      res.actions.forEach((a) => wrap.append(h('div', { class: 'pl-ai-act' }, h('b', null, a.title), a.why ? h('div', { class: 'why' }, a.why) : null, a.impact ? h('div', { class: 'imp' }, a.impact) : null)));
    }
    if (res.answer) wrap.append(h('div', { class: 'pl-ai-ans' }, res.answer));
    if (res.caveat) wrap.append(h('div', { class: 'note' }, res.caveat));
    return wrap;
  }
  function aiPanel(kind, getContext, ids, label, hint) {
    const out = h('div', { class: 'pl-ai-out', id: ids.out, 'aria-live': 'polite' });
    const canRun = aiOn() && ai.aiAvailable();
    const btn = h('button', { type: 'button', class: 'btn', id: ids.btn, disabled: !canRun, onclick: () => run(false) }, icon('spark', 18), label);
    const note = !aiOn() ? 'AI is turned off in Settings (설정에서 AI 가 꺼져 있어요).' : !ai.aiAvailable() ? 'Sign in and go online to use AI (로그인하고 인터넷에 연결되면 쓸 수 있어요).' : hint;
    async function run(force) {
      let context;
      try { context = getContext(); } catch (e) { out.replaceChildren(h('div', { class: 'card warn-card', role: 'alert' }, e.message)); return; }
      btn.disabled = true;
      out.replaceChildren(h('div', { class: 'pl-ai-wait' }, 'Analyzing… (분석 중이에요, 최대 45초)'));
      try {
        const res = await ai.advise(kind, context, { force: !!force });
        out.replaceChildren(aiBlock(res, Date.now(), false), h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn secondary sm', id: ids.btn + '-again', onclick: () => run(true) }, 'Ask again (다시 분석)')));
      } catch (e) {
        out.replaceChildren(h('div', { class: 'card warn-card', id: ids.out + '-err', role: 'alert' }, (e && e.message) || 'AI 오류가 났어요.'));
      } finally { btn.disabled = !canRun; }
    }
    // 저장된(12시간 이내) 답이 있으면 먼저 보여줌 — 서버는 부르지 않음
    try {
      ai.cachedAdvice(kind, getContext()).then((hit) => {
        if (hit && !out.childNodes.length) out.replaceChildren(aiBlock(hit.data, hit.at, true), h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn secondary sm', id: ids.btn + '-again', disabled: !canRun, onclick: () => run(true) }, 'Ask again (다시 분석)')));
      }).catch(() => {});
    } catch (e) { /* 캐시를 못 읽어도 화면은 정상 */ }
    return h('div', { class: 'card pl-aicard', id: ids.card }, h('div', { class: 'pl-ai-top' }, btn, h('div', { class: 'note', id: ids.hint }, note)), out);
  }

  // 물가 상승률 입력 (Forecast · Next-year 공용)
  function growthCtl(onChange, idp) {
    const inp = h('input', { type: 'text', id: idp + 'growth', inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Inflation / growth percent (물가 상승률 %)', value: String(r2(curGrowth())) });
    const saveBtn = h('button', { type: 'button', class: 'btn sm', id: idp + 'growth-save', hidden: true, onclick: async () => { await savePlan({ growth: curGrowth() }, 'Assumption saved (가정 저장됨)'); } }, 'Save (저장)');
    const dirty = () => { saveBtn.hidden = S.growthDraft === null; };
    const set = (v, fromInput) => {
      const n = clamp(Math.round(v * 10) / 10, -20, 50);
      S.growthDraft = Math.abs(n - savedGrowth) < 1e-9 ? null : n;
      if (!fromInput) inp.value = String(n);
      dirty(); onChange();
    };
    inp.addEventListener('input', () => {
      const n = numIn(inp.value);
      if (!Number.isFinite(n) || n < -20 || n > 50) { inp.setAttribute('aria-invalid', 'true'); return; }
      inp.removeAttribute('aria-invalid');
      set(n, true);
    });
    dirty();
    return h('div', { class: 'pl-assume' },
      h('label', { class: 'lbl', for: idp + 'growth' }, 'Inflation / growth (물가 상승률 %, 연)'),
      h('div', { class: 'pl-inline' },
        h('button', { type: 'button', class: 'stepbtn', id: idp + 'g-dn', 'aria-label': 'Lower (내리기)', onclick: () => set(curGrowth() - 0.5) }, h('b', null, '−')),
        inp, h('span', { class: 'unit' }, '%'),
        h('button', { type: 'button', class: 'stepbtn', id: idp + 'g-up', 'aria-label': 'Raise (올리기)', onclick: () => set(curGrowth() + 0.5) }, h('b', null, '+')),
        saveBtn));
  }

  // ───────────────────────────────────── 올해 남은 달 · 상향식 ─────────────────────────────────────
  // 카테고리 × 월 로 직접 입력 → 올해 연말 예상. (yearplan.js 가 계산, 여기서는 화면만)
  function buildBu() {
    const card = h('div', { class: 'card pl-bu', id: 'pl-bu' });
    const curYm = L.monthOf(today);
    const sel = () => (S.bu.sel && S.bu.sel > curYm && S.bu.sel.slice(0, 4) === curYm.slice(0, 4) ? S.bu.sel : curYm);
    const planNow = () => YP.applyEdits(savedPlan, S.bu.edits);
    const outlook = () => YP.yearOutlook({ items: api.items, accMap: api.accMap, budgets: api.data.budgets || [], plan: planNow(), today, growth: curGrowth(), extraIds: S.bu.added });
    let ol = outlook();
    const refs = { tiles: {}, mline: null, rows: new Map(), grp: new Map(), save: null, dirty: null, clear: null };
    const dirtyNow = () => JSON.stringify(planNow().cells) !== JSON.stringify(savedPlan.cells);
    const hasAnyPlan = () => Object.keys(planNow().cells).length > 0;

    const tile = (key, lab) => {
      const v = h('div', { class: 'pl-stat-v', id: 'pl-bu-' + key }), sub = h('div', { class: 'pl-stat-s', id: 'pl-bu-' + key + '-s' });
      refs.tiles[key] = { v, sub };
      return h('div', { class: 'pl-stat' }, h('div', { class: 'pl-stat-l' }, lab), v, sub);
    };
    function paintTiles() {
      const t = refs.tiles;
      t.inc.v.textContent = m0(ol.yearIncome);
      t.inc.sub.textContent = 'so far (지금까지) ' + m0(ol.soFarIncome) + ' + rest (남은 예상) ' + m0(ol.yearIncome - ol.soFarIncome);
      t.exp.v.textContent = m0(ol.yearExpense);
      t.exp.sub.textContent = 'so far (지금까지) ' + m0(ol.soFarExpense) + ' + rest (남은 예상) ' + m0(ol.yearExpense - ol.soFarExpense);
      t.net.v.textContent = (ol.yearNet < 0 ? '−' : '') + m0(Math.abs(ol.yearNet)).replace('−', '');
      t.net.sub.replaceChildren(arrow(ol.yearNet, true, ol.yearNet >= 0 ? 'surplus (흑자)' : 'deficit (적자)'));
    }
    function paintMonthLine() {
      const m = sel(), t = ol.monthTotals[m];
      refs.mline.replaceChildren(h('b', null, L.monthLabel(m)), ': income (수입) ' + m0(t.income) + ' · spending (지출) ' + m0(t.expense) + ' · ', arrow(t.net, true));
    }
    function paintDirty() {
      const d = dirtyNow();
      refs.save.disabled = !d;
      refs.dirty.textContent = d ? 'Unsaved changes (저장 안 된 변경이 있어요)' : '';
      refs.clear.hidden = !hasAnyPlan();
    }
    function lineOf(id) { return ol.lines.find((l) => l.id === id); }
    function paintRow(l, refsRow) {
      const m = sel(), c = l.cells[m];
      const isCur = m === curYm;
      const bits = ['auto (자동) ' + m0(c.auto)];
      if (isCur && l.curActual) bits.push('so far (지금까지) ' + m0(l.curActual));
      refsRow.sub.textContent = bits.join(' · ');
      refsRow.year.textContent = 'Year (올해) ' + m0(l.total);
      refsRow.reset.hidden = refsRow.input.value.trim() === '';
      refsRow.input.placeholder = String(Math.round(c.auto));
    }
    function refresh() {
      ol = outlook();
      paintTiles(); paintMonthLine(); paintDirty();
      refs.rows.forEach((r, id) => { const l = lineOf(id); if (l) paintRow(l, r); });
      refs.grp.forEach((el, g) => { const m = sel(); el.textContent = m0(sum(ol.lines.filter((l) => l.group === g).map((l) => l.cells[m].value))); });
    }
    const valueOf = (m, id) => {
      const k = YP.cellKey(m, id);
      if (S.bu.edits.has(k)) return S.bu.edits.get(k);
      const v = savedPlan.cells[m] && savedPlan.cells[m][id];
      return v === undefined ? '' : String(v);
    };
    function rowEl(l) {
      const m = sel();
      const key = YP.cellKey(m, l.id);
      const input = h('input', { type: 'text', class: 'pl-bu-in', inputmode: 'decimal', autocomplete: 'off', 'data-id': l.id, 'aria-label': (l.name || l.id) + ' — ' + L.monthLabel(m) + ' (금액)', value: valueOf(m, l.id), placeholder: '',
        oninput: () => { S.bu.edits.set(key, input.value); refresh(); } });
      const sub = h('span', { class: 'pl-bu-auto' }), year = h('span', { class: 'pl-bu-year' });
      const reset = h('button', { type: 'button', class: 'pl-bu-act', 'data-act': 'reset', onclick: () => { S.bu.edits.set(key, ''); input.value = ''; refresh(); } }, 'Auto (자동으로)');
      const copy = h('button', { type: 'button', class: 'pl-bu-act', 'data-act': 'copy', onclick: () => {
        const v = lineOf(l.id).cells[sel()].value;
        ol.months.filter((x) => x > sel()).forEach((x) => S.bu.edits.set(YP.cellKey(x, l.id), String(v)));
        toast('Copied to the later months (남은 달에 같은 금액을 넣었어요)'); refresh();
      } }, 'Same for rest (남은 달 동일)');
      const r = { input, sub, year, reset };
      refs.rows.set(l.id, r);
      return h('div', { class: 'pl-bu-row', 'data-id': l.id },
        h('div', { class: 'pl-bu-nm' }, l.name, l.name_ko && l.name_ko !== l.name ? h('span', { class: 'ko' }, ' ' + l.name_ko) : null), input,
        h('div', { class: 'pl-bu-sub' }, sub, year, reset, l.type === 'EXPENSE' || l.type === 'INCOME' ? copy : null));
    }
    const toast = api.toast;

    async function save() {
      const next = planNow();
      await api.saveSettings(YP.planRow(api.data.settings, next, L.nowIso(), today));
      S.bu.edits = new Map();
      toast('Forecast saved (예측 저장됨)');
    }
    function clearAll() {
      const cur = planNow();
      Object.keys(cur.cells).forEach((m) => Object.keys(cur.cells[m]).forEach((id) => S.bu.edits.set(YP.cellKey(m, id), '')));
      draw();
    }

    function draw() {
      ol = outlook();
      refs.rows = new Map(); refs.grp = new Map();
      const m = sel();
      const chips = h('div', { class: 'pl-chips pl-bu-chips', role: 'group', 'aria-label': 'Month (월)' }, ol.months.map((x) => chip(shortMon(x) + (x === curYm ? ' · now (이번 달)' : ''), x === m, () => { S.bu.sel = x; draw(); }, 'pl-bu-m-' + x.slice(5), 'pl-bu-chip')));
      refs.mline = h('div', { class: 'pl-bu-mline', id: 'pl-bu-mline' });
      const body = [];
      const groups = [];
      ol.lines.forEach((l) => { if (groups.indexOf(l.group) < 0) groups.push(l.group); });
      groups.forEach((g) => {
        const gt = h('b', { class: 'pl-bu-gt' });
        refs.grp.set(g, gt);
        body.push(h('div', { class: 'pl-bu-gh', 'data-group': g }, h('span', null, g === '수입' ? 'Income (수입)' : (L.GROUP_LABELS[g] || g)), gt));
        ol.lines.filter((l) => l.group === g).forEach((l) => body.push(rowEl(l)));
      });
      if (!ol.lines.length) body.push(h('div', { class: 'note' }, 'No records yet (아직 기록이 없어요). 아래에서 카테고리를 추가해 직접 입력할 수도 있어요.'));
      // 카테고리 추가
      const shown = new Set(ol.lines.map((l) => l.id));
      const addable = api.accounts.filter((a) => (a.type === 'EXPENSE' || a.type === 'INCOME') && L.isActive(a) && !shown.has(String(a.account_id)));
      const addSel = h('select', { id: 'pl-bu-add', 'aria-label': 'Add a category (카테고리 추가)', onchange: (e) => { if (e.target.value) { S.bu.added.add(e.target.value); draw(); } } },
        [h('option', { value: '' }, '+ Add a category (카테고리 추가)')].concat(['INCOME', 'EXPENSE'].map((ty) => h('optgroup', { label: ty === 'INCOME' ? 'Income (수입)' : 'Spending (지출)' }, addable.filter((a) => a.type === ty).map((a) => h('option', { value: a.account_id }, L.accLabel(a)))))));
      refs.save = h('button', { type: 'button', class: 'btn', id: 'pl-bu-save', onclick: save }, icon('check', 18), 'Save forecast (예측 저장)');
      refs.dirty = h('span', { class: 'pl-bu-dirty', id: 'pl-bu-dirty' });
      refs.clear = h('button', { type: 'button', class: 'btn secondary sm', id: 'pl-bu-clear', onclick: clearAll }, 'Clear my entries (내 입력 지우기)');
      card.replaceChildren(
        heading('Rest of this year — bottom-up', '올해 남은 달 · 카테고리별 입력'),
        h('div', { class: 'note' }, 'Type what you expect for each category and month. Leave a box empty to keep the automatic number. The year-end total below becomes the base for the Next-year budget (카테고리마다 남은 달의 예상 금액을 넣으세요. 비워 두면 자동 계산이고, 아래 연말 합계가 내년 예산의 기준이 돼요).'),
        h('div', { class: 'pl-stats' }, tile('inc', 'Year income (올해 예상 수입)'), tile('exp', 'Year spending (올해 예상 지출)'), tile('net', 'Left over (올해 남는 돈)')),
        h('div', { class: 'lbl pl-gap' }, 'Month to edit (입력할 달)'), chips, refs.mline,
        h('div', { class: 'pl-bu-list', id: 'pl-bu-list' }, body),
        h('label', { class: 'field pl-bu-addrow' }, addSel),
        h('div', { class: 'pl-apply-row pl-bu-save' }, refs.dirty, refs.clear, refs.save),
        h('div', { class: 'note' }, 'The charts and table below use the saved forecast (아래 그래프와 표는 저장된 예측을 써요).'));
      ol.lines.forEach((l) => { const r = refs.rows.get(l.id); if (r) paintRow(l, r); });
      paintTiles(); paintMonthLine(); paintDirty();
      refs.grp.forEach((el, g) => { el.textContent = m0(sum(ol.lines.filter((l) => l.group === g).map((l) => l.cells[m].value))); });
    }
    draw();
    return card;
  }

  // ───────────────────────────────────── 1) Forecast ─────────────────────────────────────
  function buildFc() {
    const frag = h('div', { class: 'pl-grid pl-fc' });
    const col = h('div', { class: 'pl-col' });
    const top = h('div', { class: 'pl-top' });
    const chartBox = h('div', { class: 'pl-chartbox' });
    const side = h('div', { class: 'pl-side' });
    const tableBox = h('div', { class: 'pl-tablebox' });
    col.append(top, buildBu(), chartBox, tableBox);
    frag.append(col, side);
    let model = null;

    // 이번 달
    const months = Array.from(new Set(api.items.map((it) => L.monthOf(it.txn.date)).concat([L.monthOf(today), state.month]))).sort().reverse();
    const monthSel = h('label', { class: 'pillsel' }, icon('calendar', 20), h('span', { class: 'monthlabel' }, L.monthLabel(state.month)), icon('down', 18),
      h('select', { id: 'pl-month', 'aria-label': 'Month (월)', onchange: (e) => { state.month = e.target.value; api.rerender(); } }, months.map((m) => h('option', { value: m, selected: m === state.month }, L.monthLabel(m)))));
    const prev = ctx.prev;
    const spentPct = fc.projExpense > 0 ? clamp(fc.actualExpense / fc.projExpense * 100, 0, 100) : 0;
    const stat = (lab, val, sub, cls, id) => h('div', { class: 'pl-stat' + (cls ? ' ' + cls : ''), id: id || null }, h('div', { class: 'pl-stat-l' }, lab), h('div', { class: 'pl-stat-v' }, val), sub ? h('div', { class: 'pl-stat-s' }, sub) : null);
    top.append(
      h('div', { class: 'toolbar' }, h('div', { class: 'l' }, stepBtn(-1, 'Previous month (이전 달)'), monthSel, stepBtn(1, 'Next month (다음 달)'))),
      h('div', { class: 'card pl-month', id: 'pl-fc-month' },
        heading(fc.done ? 'Month result' : 'This month so far', fc.done ? '이번 달 결과' : '이번 달 현재', fc.done ? badge('Closed (마감)', 'info') : badge('Day ' + fc.day + ' of ' + fc.dim + ' (' + fc.dim + '일 중 ' + fc.day + '일째)', 'info')),
        h('div', { class: 'pl-stats' },
          stat(fc.done ? 'Spending (지출)' : 'Month-end spending (월말 예상 지출)', m0(fc.projExpense), prev && prev.expense ? h('span', null, arrow(fc.projExpense - prev.expense, false), ' vs last month (지난달)') : null, '', 'pl-fc-exp'),
          stat(fc.done ? 'Income (수입)' : 'Month-end income (월말 예상 수입)', m0(fc.projIncome), prev && prev.income ? h('span', null, arrow(fc.projIncome - prev.income, true), ' vs last month (지난달)') : null, '', 'pl-fc-inc'),
          stat(fc.projNet >= 0 ? 'Left over (남는 돈)' : 'Short (부족)', (fc.projNet < 0 ? '−' : '') + m0(Math.abs(fc.projNet)).replace('−', ''), h('span', null, arrow(fc.projNet, true, fc.projNet >= 0 ? 'surplus (흑자)' : 'deficit (적자)')), fc.projNet >= 0 ? 'good' : 'bad', 'pl-fc-net')),
        fc.done ? null : h('div', { class: 'pl-prog', 'aria-label': 'Spent so far' },
          h('div', { class: 'bar' }, h('i', { class: 'bar-fill ' + (fc.projNet < 0 ? 'over' : 'ok'), style: 'width:' + Math.round(spentPct) + '%' }), h('b', { class: 'bar-pace', style: 'left:' + Math.round(fc.frac * 100) + '%' })),
          h('div', { class: 'note' }, 'Spent so far (지금까지 지출) ' + m0(fc.actualExpense) + ' · expected more (앞으로 예상) ' + m0(fc.remaining)))),
      growthCtl(() => drawModel(), 'pl-'),
      h('div', { class: 'note' }, 'Based on the last 3 full months. Months with a budget use the budget, and the numbers you type in the box below come first (최근 3개월 평균 기준, 예산이 있는 달은 예산, 아래 상향식 입력이 있으면 그것이 우선이에요).'));

    // 앞으로 12개월 모델
    function makeModel() {
      const growth = curGrowth();
      const rows = I.projectMonths(pctx, 12, { growth, plan: savedPlan });
      const cats = catProjection(pctx, growth, 12);
      const pastMonths = I.months(state.month, 6).filter((m) => !(inProg && m === state.month));
      const pts = [];
      pastMonths.forEach((m) => {
        const s = ctx.series.find((x) => x.ym === m);
        const has = s && (s.income > 0 || s.expense > 0);
        pts.push({ ym: m, actual: true, income: has ? s.income : null, expense: has ? s.expense : null, net: has ? s.net : null, cash: null, budgeted: false });
      });
      if (inProg) pts.push({ ym: state.month, actual: false, partial: true, income: fc.projIncome, expense: fc.projExpense, net: fc.projNet, cash: startCash, budgeted: false });
      else if (pts.length) pts[pts.length - 1].cash = ctx.pos.liquid;
      const ff = pts.length - (inProg ? 1 : 0);   // 첫 예상 점의 위치 (이번 달이 진행 중이면 이번 달부터 예상)
      rows.forEach((r) => pts.push({ ym: r.ym, actual: false, income: r.income, expense: r.expense, net: r.net, cash: r.cash, budgeted: r.budgeted, planned: r.planned }));
      const noData = rows.every((r) => r.income === 0 && r.expense === 0);
      return { growth, rows, cats, pts, ff: ff > 0 ? ff : null, noData };
    }
    const wiOf = () => whatIf(model.cats, model.rows, api.accMap, S.fc.scope, S.fc.cut, S.fc.inc);

    let chartIO = null, chartCash = null;
    const selNote = h('div', { class: 'pl-selnote', id: 'pl-fc-sel', 'aria-live': 'polite' });
    const interp = h('div', { class: 'pl-interp', id: 'pl-fc-interp' });
    const wiRes = h('div', { class: 'pl-wi-res', id: 'pl-wi-res', 'aria-live': 'polite' });

    function ioSeries() {
      return [
        { key: 'in', name: 'Income (수입)', color: 'var(--c1)', values: model.pts.map((p) => p.income) },
        { key: 'out', name: 'Spending (지출)', color: 'var(--c4)', values: model.pts.map((p) => p.expense) }
      ];
    }
    function cashSeries() {
      const wi = wiOf();
      const pts = model.pts, off = pts.length - 12;
      const series = [{ key: 'cash', name: 'Cash (누적 현금)', color: 'var(--c2)', values: pts.map((p) => p.cash), width: 2.5 }];
      if (Math.abs(wi.extra) >= 0.5) {
        series.push({ key: 'wi', name: 'With what-if (만약에 적용)', color: 'var(--c3)', dashed: true, width: 2.5, values: pts.map((p, i) => (i >= off ? wi.cashSeries[i - off] : (i === off - 1 && p.cash !== null ? p.cash : null))) });
      }
      return series;
    }
    function detail(i) {
      const p = model.pts[i];
      if (!p) return '';
      const kids = [h('b', null, L.monthLabel(p.ym)), p.actual ? ' (actual 실제)' : p.partial ? ' (this month, expected 이번 달 예상)' : ' (forecast 예상)', p.budgeted ? ' ' : null, p.budgeted ? badge('budget', 'good') : null, p.planned ? ' ' : null, p.planned ? badge('plan', 'info') : null, ': '];
      if (p.income === null) kids.push('no records (기록 없음)');
      else kids.push('income (수입) ', m0(p.income), ' · spending (지출) ', m0(p.expense), ' · net (순수입) ', arrow(p.net, true), p.cash !== null ? ' · cash (현금) ' + m0(p.cash) : '');
      return kids;
    }
    function drawChart() {
      const base = { labels: model.pts.map((p) => shortMon(p.ym)), fmt: m0, axisFmt: axisMoney, forecastFrom: model.ff, height: phone ? 190 : 230, selected: model.ff === null ? undefined : model.ff };
      const onSel = (i, other) => { S.fc.sel = i; selNote.replaceChildren(h('span', null, detail(i))); markRow(i); if (other()) other().update({ selected: i }); };
      const o1 = Object.assign({}, base, { title: 'Income and spending (수입·지출)', series: ioSeries(), onSelect: (i) => onSel(i, () => chartCash) });
      const o2 = Object.assign({}, base, { title: 'Cumulative cash (누적 현금)', series: cashSeries(), onSelect: (i) => onSel(i, () => chartIO) });
      if (chartIO && chartCash) { chartIO.update(o1); chartCash.update(o2); return; }
      chartIO = lineChart(o1); chartCash = lineChart(o2);
      chartIO.id = 'pl-chart-io'; chartCash.id = 'pl-chart-cash';
      chartBox.replaceChildren(h('div', { class: 'card pl-chartcard' },
        heading('Past 6 months + next 12 (최근 6개월 + 앞으로 12개월)', '실제 → 예측'),
        h('div', { class: 'pl-cap' }, 'Income and spending (수입·지출)'), chartIO,
        h('div', { class: 'pl-cap gap' }, 'Cumulative cash (누적 현금)'), chartCash,
        selNote, interp));
    }
    function interpText() {
      const rows = model.rows;
      if (model.noData) return h('span', null, '기록이 아직 부족해요. 거래가 쌓이면 앞으로의 흐름을 계산해 드려요.');
      const last = rows[rows.length - 1];
      const delta = last.cash - pctx.liquid;
      const worst = rows.reduce((a, b) => (b.net < a.net ? b : a));
      const neg = rows.find((r) => r.cash < 0);
      const kids = ['지금 속도라면 12개월 뒤 현금은 ', h('b', null, m0(last.cash)), ' 예요 (지금보다 ', arrow(delta, true), '). '];
      if (neg) kids.push(h('span', { class: 'pl-neg' }, '⚠ ' + L.monthLabel(neg.ym) + ' 부터 현금이 마이너스가 될 수 있어요. '));
      if (worst.net < 0) kids.push('가장 부담스러운 달은 ', h('b', null, L.monthLabel(worst.ym)), ' — 지출 ', m0(worst.expense), ', 순수입 ', arrow(worst.net, true), '.');
      else kids.push('가장 빠듯한 달도 ', h('b', null, L.monthLabel(worst.ym)), ' 에 ', m0(worst.net), ' 남아요.');
      return h('span', null, kids);
    }

    // 월별 표 (폰: 카드, 태블릿·컴퓨터: 표)
    function drawTable() {
      const worst = model.noData ? null : model.rows.reduce((a, b) => (b.net < a.net ? b : a));
      const head = heading('Month by month (월별)', '예상 수입·지출·현금');
      if (phone) {
        const list = h('div', { class: 'bg-list pl-mlist' }, model.rows.map((r) => h('div', { class: 'pl-mrow', 'data-ym': r.ym },
          h('div', { class: 'pl-mrow-l' }, h('div', { class: 't' }, L.monthLabel(r.ym), ' ', r.budgeted ? badge('budget', 'good') : null, r.planned ? badge('plan', 'info') : null, worst && r.ym === worst.ym && worst.net < 0 ? badge('tightest', 'warn') : null),
            h('div', { class: 's' }, 'In ' + m0(r.income) + ' · Out ' + m0(r.expense) + ' · Cash ' + m0(r.cash))),
          h('div', { class: 'pl-mrow-r' }, arrow(r.net, true)))));
        tableBox.replaceChildren(h('div', { class: 'pl-tbl-wrap' }, head, list));
      } else {
        const tb = h('tbody');
        model.rows.forEach((r) => tb.append(h('tr', { class: 'line', 'data-ym': r.ym },
          h('td', null, L.monthLabel(r.ym), ' ', r.budgeted ? badge('budget', 'good') : null, r.planned ? badge('plan', 'info') : null, worst && r.ym === worst.ym && worst.net < 0 ? badge('tightest', 'warn') : null),
          h('td', null, m0(r.income)), h('td', null, m0(r.expense)), h('td', null, arrow(r.net, true)), h('td', null, m0(r.cash)))));
        tableBox.replaceChildren(h('div', { class: 'pl-tbl-wrap' }, head, h('div', { class: 'tbl tbl-scroll' }, h('table', { class: 'pl-tbl', id: 'pl-fc-table' },
          h('thead', null, h('tr', null, h('th', null, 'Month ', h('span', { class: 'ko' }, '월')), h('th', null, 'Income ', h('span', { class: 'ko' }, '수입')), h('th', null, 'Spending ', h('span', { class: 'ko' }, '지출')), h('th', null, 'Net ', h('span', { class: 'ko' }, '순수입')), h('th', null, 'Cash ', h('span', { class: 'ko' }, '누적 현금')))), tb))));
      }
      if (S.fc.sel !== null) markRow(S.fc.sel);
    }
    function markRow(i) {
      const p = model.pts[i];
      tableBox.querySelectorAll('[data-ym]').forEach((r) => r.classList.toggle('on', !!p && r.getAttribute('data-ym') === p.ym));
    }

    // What-if
    function drawWi() {
      const wi = wiOf();
      const kids = [];
      if (model.noData) kids.push(h('div', { class: 'note' }, '기록이 쌓이면 계산할 수 있어요.'));
      else if (Math.abs(wi.extra) < 0.5) kids.push(h('div', { class: 'note' }, 'Pick a cut or an income change above (위에서 줄일 비율이나 수입 변화를 고르세요).'));
      else {
        kids.push(h('div', { class: 'pl-wi-big', id: 'pl-wi-extra' }, arrow(wi.extra, true, m0(Math.abs(wi.extra))), h('span', { class: 'lab' }, wi.extra >= 0 ? ' more cash in 12 months (12개월 누적 더 남는 돈)' : ' less cash in 12 months (12개월 누적 덜 남는 돈)')));
        const line = (a, b, id) => h('div', { class: 'pl-wi-line', id: id || null }, h('span', null, a), h('span', null, b));
        kids.push(
          line('Spending change (지출 변화)', arrow(-wi.saved, false), 'pl-wi-saved'),
          wi.added ? line('Income change (수입 변화)', arrow(wi.added, true), 'pl-wi-added') : null,
          line('Per month (월 환산)', m0(wi.perMonth) + ' / mo'),
          line('Cash after 12 months (12개월 뒤 현금)', m0(wi.cash0) + ' → ' + m0(wi.cash1), 'pl-wi-cash'));
      }
      put(wiRes, kids);
    }
    function wiCtl() {
      const scopeSel = h('select', { id: 'pl-wi-scope', 'aria-label': 'What to cut (줄일 대상)', onchange: (e) => { S.fc.scope = e.target.value; refreshWi(); } });
      const tot = new Map();
      model.cats.forEach((p) => p.cats.forEach((v, id) => tot.set(id, (tot.get(id) || 0) + v)));
      const grpTot = new Map();
      tot.forEach((v, id) => { const a = api.accMap.get(String(id)); const g = (a && a.report_group) || '확인 필요'; grpTot.set(g, (grpTot.get(g) || 0) + v); });
      const og1 = h('optgroup', { label: 'Everything (전체)' }, h('option', { value: 'all', selected: S.fc.scope === 'all' }, 'All spending (전체 지출)'));
      const og2 = h('optgroup', { label: 'Groups (그룹)' }, L.GROUP_ORDER.filter((g) => grpTot.has(g)).map((g) => h('option', { value: 'grp:' + g, selected: S.fc.scope === 'grp:' + g }, (L.GROUP_LABELS[g] || g) + ' · ' + m0(grpTot.get(g) / 12) + '/mo')));
      const topCats = Array.from(tot.entries()).filter(([id]) => id !== '9999').sort((a, b) => b[1] - a[1]).slice(0, 10);
      const og3 = h('optgroup', { label: 'Top categories (주요 카테고리)' }, topCats.map(([id, v]) => { const a = api.accMap.get(String(id)); return h('option', { value: 'cat:' + id, selected: S.fc.scope === 'cat:' + id }, (a ? a.name : id) + ' · ' + m0(v / 12) + '/mo'); }));
      scopeSel.append(og1, og2, og3);
      if (!Array.from(scopeSel.options).some((o) => o.value === S.fc.scope)) S.fc.scope = 'all';
      const cutIn = h('input', { type: 'text', id: 'pl-wi-cut', inputmode: 'decimal', autocomplete: 'off', placeholder: 'Custom % (직접 입력)', 'aria-label': 'Custom cut percent (줄일 % 직접 입력)', value: S.fc.cutText,
        oninput: () => { const n = numIn(cutIn.value); S.fc.cutText = cutIn.value; if (Number.isFinite(n) && n >= -100 && n <= 100) { S.fc.cut = n; cutIn.removeAttribute('aria-invalid'); refreshWi(); } else if (cutIn.value.trim() === '') { S.fc.cut = 0; refreshWi(); } else cutIn.setAttribute('aria-invalid', 'true'); } });
      const incIn = h('input', { type: 'text', id: 'pl-wi-inc', inputmode: 'decimal', autocomplete: 'off', placeholder: 'Custom % (직접 입력)', 'aria-label': 'Custom income percent (수입 증가 % 직접 입력)', value: S.fc.incText,
        oninput: () => { const n = numIn(incIn.value); S.fc.incText = incIn.value; if (Number.isFinite(n) && n >= -100 && n <= 200) { S.fc.inc = n; incIn.removeAttribute('aria-invalid'); refreshWi(); } else if (incIn.value.trim() === '') { S.fc.inc = 0; refreshWi(); } else incIn.setAttribute('aria-invalid', 'true'); } });
      const cutChips = h('div', { class: 'pl-chips', role: 'group', 'aria-label': 'Cut (줄이기)' });
      const incChips = h('div', { class: 'pl-chips', role: 'group', 'aria-label': 'Income (수입)' });
      const paintChips = () => {
        cutChips.replaceChildren(...[[0, 'None (안 줄임)'], [10, '−10%'], [20, '−20%']].map(([v, t]) => chip(t, S.fc.cut === v && !S.fc.cutText, () => { S.fc.cut = v; S.fc.cutText = ''; cutIn.value = ''; cutIn.removeAttribute('aria-invalid'); refreshWi(); }, 'pl-wi-cut-' + v)));
        incChips.replaceChildren(...[[0, '+0%'], [3, '+3%'], [5, '+5%']].map(([v, t]) => chip(t, S.fc.inc === v && !S.fc.incText, () => { S.fc.inc = v; S.fc.incText = ''; incIn.value = ''; incIn.removeAttribute('aria-invalid'); refreshWi(); }, 'pl-wi-inc-' + v)));
      };
      wiCtl.paint = paintChips;
      paintChips();
      return h('div', { class: 'card pl-wi', id: 'pl-wi' },
        heading('What if… (시나리오)', '저장되지 않아요'),
        h('div', { class: 'note' }, 'Try a change and see the 12-month result right away. Nothing is saved (바꿔 보고 1년 결과를 바로 확인하세요. 저장되지 않아요).'),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Cut spending on (줄일 지출)'), scopeSel),
        h('div', { class: 'lbl' }, 'Cut by (줄일 비율)'), cutChips, cutIn,
        h('div', { class: 'lbl pl-gap' }, 'Income change (수입 변화)'), incChips, incIn,
        wiRes);
    }
    function refreshWi() { if (wiCtl.paint) wiCtl.paint(); drawWi(); if (chartCash) chartCash.update({ series: cashSeries() }); }

    function drawModel() {
      model = makeModel();
      side.replaceChildren(wiCtl());
      drawWi();
      drawTable();
      interp.replaceChildren(interpText());
      if (model.noData) {
        chartIO = null; chartCash = null;
        chartBox.replaceChildren(h('div', { class: 'card center muted', id: 'pl-fc-empty' }, 'Not enough history yet (아직 기록이 부족해요). 거래가 쌓이면 앞으로 12개월을 보여드려요.'));
      } else {
        drawChart();
        if (model.ff !== null) selNote.replaceChildren(h('span', null, detail(S.fc.sel !== null && model.pts[S.fc.sel] ? S.fc.sel : model.ff)));
      }
      paintBanner();
    }
    drawModel();
    return frag;
  }

  // ───────────────────────────────────── 2) Next-year budget ─────────────────────────────────────
  function buildNy() {
    const frag = h('div', { class: 'pl-grid pl-ny' });
    const col = h('div', { class: 'pl-col' });
    const top = h('div', { class: 'pl-top' });
    const listBox = h('div', { class: 'pl-nylist' });
    const side = h('div', { class: 'pl-side' });
    col.append(top, listBox, side);
    frag.append(col);
    const budgets = api.data.budgets || [];
    const defStart = L.monthOf(today);
    const startYm = () => S.ny.start || defStart;
    let sg = null, rows = [], groups = [], incAvg = 0, expAvg = 0, yo = null, useYear = false;
    const scopeMonths = () => B.monthsFor(startYm(), S.ny.scope);
    const refs = { total: null, sum: null, grp: new Map(), apply: null, cnt: null };

    const incl = (r) => (r.locked ? false : (S.ny.incl.has(r.id) ? S.ny.incl.get(r.id) : !r.hasExisting));
    const amountOf = (r) => (S.ny.edits.has(r.id) ? S.ny.edits.get(r.id) : r.sugg);
    const effOf = (r) => (incl(r) ? amountOf(r) : (r.startBudget || r.existing || r.basis));

    function calc() {
      const growth = curGrowth();
      yo = YP.yearOutlook({ items: api.items, accMap: api.accMap, budgets, plan: savedPlan, today, growth });
      const fromYear = S.ny.basis === 'year' ? YP.suggestFromYear(yo, growth) : null;
      useYear = !!(fromYear && fromYear.map.size);
      sg = useYear ? fromYear : I.suggestNextYear(api.items, api.accMap, basisYm, growth);
      const ms = scopeMonths();
      const bms = ms.map((m) => B.budgetMap(budgets, m));
      const lockN = new Map();
      const msSet = new Set(ms);
      budgets.forEach((b) => { if (!L.truthy(b.deleted) && L.truthy(b.locked) && msSet.has(b.year + '-' + String(b.month).padStart(2, '0'))) lockN.set(String(b.account_id), (lockN.get(String(b.account_id)) || 0) + 1); });
      rows = [];
      sg.map.forEach((v, id) => {
        const a = api.accMap.get(String(id));
        if (!a || a.type !== 'EXPENSE') return;
        const cur = bms.map((m) => m.get(String(id)) || 0);
        const existing = cur.find((x) => x > 0) || 0;
        const nLock = lockN.get(String(id)) || 0;
        rows.push({ id: String(id), name: a.name, name_ko: a.name_ko, group: a.report_group || '확인 필요', basis: v.basis, sugg: v.amount, rationale: v.rationale, volatile: v.volatile, trend: v.trend, months: v.months, existing, startBudget: cur[0], hasExisting: existing > 0, locked: nLock >= ms.length, lockedSome: nLock > 0 && nLock < ms.length });
      });
      groups = L.GROUP_ORDER.map((g) => ({ key: g, label: L.GROUP_LABELS[g] || g, rows: rows.filter((r) => r.group === g).sort((a, b) => b.sugg - a.sugg) })).filter((g) => g.rows.length);
      if (useYear && yo.covered) {
        incAvg = yo.yearIncome / yo.covered;
        expAvg = yo.yearExpense / yo.covered;
      } else {
        const upto = ctx.series.filter((s) => s.ym <= basisYm).slice(-3).filter((s) => s.income > 0 || s.expense > 0);
        incAvg = avg(upto.filter((s) => s.income > 0).map((s) => s.income));
        expAvg = avg(upto.map((s) => s.expense));
      }
    }
    const totals = () => {
      const total = sum(rows.map(effOf));
      const chosen = rows.filter(incl);
      return { total, count: chosen.length, plan: sum(chosen.map(amountOf)), savings: incAvg - total, pct: incAvg > 0 ? (incAvg - total) / incAvg * 100 : null };
    };

    const aiCtx = () => {
      const chosen = rows.filter(incl).map((r) => ({ n: r.name, amount: r2(amountOf(r)), basis: Math.round(r.basis) }));
      if (!chosen.length) throw new Error('먼저 점검할 카테고리를 한 개 이상 고르세요.');
      return I.aiContext(ctx, { proposedBudget: chosen, growth: curGrowth(), startMonth: startYm(), avgMonthlyIncome: Math.round(incAvg) });
    };

    // 요약 카드
    const sumBox = h('div', { class: 'card pl-nysum', id: 'pl-ny-sum' });
    function drawSum() {
      const t = totals();
      const ratio = incAvg > 0 ? t.total / incAvg * 100 : 0;
      const tone = t.pct === null ? '' : t.pct >= 20 ? 'good' : t.pct >= 8 ? 'near' : 'bad';
      const st = ratio > 100 ? 'over' : ratio > 92 ? 'near' : 'ok';
      put(sumBox,
        heading('Budget vs income (예산 vs 수입)', '월 기준'),
        h('div', { class: 'pl-stats' },
          h('div', { class: 'pl-stat' }, h('div', { class: 'pl-stat-l' }, 'Budget total (예산 합계)'), h('div', { class: 'pl-stat-v', id: 'pl-ny-total' }, m0(t.total)), h('div', { class: 'pl-stat-s' }, expAvg > 0 ? h('span', null, arrow(t.total - expAvg, false), ' vs now (현재 평균 ' + m0(expAvg) + ')') : '')),
          h('div', { class: 'pl-stat' }, h('div', { class: 'pl-stat-l' }, (useYear ? 'Avg income (올해 월평균 수입)' : 'Avg income (최근 3개월 평균 수입)')), h('div', { class: 'pl-stat-v', id: 'pl-ny-inc' }, incAvg > 0 ? m0(incAvg) : '—')),
          h('div', { class: 'pl-stat ' + tone }, h('div', { class: 'pl-stat-l' }, 'Expected savings (예상 저축)'), h('div', { class: 'pl-stat-v', id: 'pl-ny-save' }, t.pct === null ? '—' : (t.savings < 0 ? '−' : '') + m0(Math.abs(t.savings)).replace('−', '') + ' (' + Math.round(t.pct) + '%)'),
            t.pct === null ? null : h('div', { class: 'pl-stat-s' }, h('span', { class: 'chg ' + (tone === 'good' ? 'good' : tone === 'bad' ? 'bad' : '') }, h('span', { class: 'arw' }, t.savings >= 0 ? '▲' : '▼'), t.pct >= 20 ? 'on target (목표 달성)' : t.pct >= 8 ? 'a bit low (조금 낮아요)' : 'low (낮아요)')))),
        incAvg > 0 ? h('div', { class: 'bar', role: 'img', 'aria-label': Math.round(ratio) + '% of income' }, h('i', { class: 'bar-fill ' + st, style: 'width:' + clamp(ratio, 0, 100) + '%' })) : null,
        h('div', { class: 'note' }, (useYear ? 'Based on ' + sg.span + ' months of this year (올해 ' + sg.span + '개월 기준).' : 'Based on ' + sg.span + ' months of records (최근 ' + sg.span + '개월 기록 기준).')+ ' Unchecked rows count at their current budget or average (체크 해제한 항목은 현재 예산 또는 평균으로 계산). Small or new categories are left out (소액·신규 항목은 제외).'),
        sg.span < 6 ? h('div', { class: 'pl-warnline' }, icon('alert', 16), 'Short history — treat as rough (기록이 짧아서 대략적인 제안이에요).') : null);
      refs.cnt && (refs.cnt.textContent = t.count + ' selected');
      if (refs.apply) refs.apply.disabled = t.count === 0;
      refs.grp.forEach((el, key) => { const g = groups.find((x) => x.key === key); if (g) el.textContent = m0(sum(g.rows.map(effOf))) + '/mo'; });
      paintBanner();
    }

    // 입력 줄 (표 · 카드 공통)
    function amtInput(r) {
      const inp = h('input', { type: 'text', class: 'pl-amt', inputmode: 'decimal', autocomplete: 'off', 'data-acct': r.id, value: String(Math.round(amountOf(r) * 100) / 100), 'aria-label': 'Suggested amount for ' + r.name + ' (제안 금액)',
        oninput: () => {
          const n = numIn(inp.value);
          if (!Number.isFinite(n) || n < 0) { inp.setAttribute('aria-invalid', 'true'); return; }
          inp.removeAttribute('aria-invalid');
          if (Math.abs(n - r.sugg) < 0.005) S.ny.edits.delete(r.id); else S.ny.edits.set(r.id, r2(n));
          if (!r.locked && !incl(r)) { S.ny.incl.set(r.id, true); syncRow(r.id); }
          S.ny.done = null; S.ny.confirming = false; hideConfirm();
          drawSum();
        } });
      return inp;
    }
    const rowEls = new Map();
    function syncRow(id) {
      const r = rows.find((x) => x.id === id);
      (rowEls.get(id) || []).forEach((el) => {
        el.classList.toggle('off', !incl(r));
        const b = el.querySelector('.pl-chk');
        if (b) { b.setAttribute('aria-pressed', String(incl(r))); b.querySelector('.pickc').classList.toggle('on', incl(r)); }
      });
    }
    function chk(r) {
      const b = h('button', { type: 'button', class: 'pl-chk', 'data-acct': r.id, disabled: r.locked, 'aria-pressed': String(incl(r)), 'aria-label': 'Include ' + r.name + ' (포함)',
        onclick: () => { S.ny.incl.set(r.id, !incl(r)); S.ny.done = null; syncRow(r.id); hideConfirm(); drawSum(); } }, h('span', { class: 'pickc' + (incl(r) ? ' on' : '') }, icon('check', 15)));
      return b;
    }
    const badges = (r) => [r.volatile ? badge('Volatile (들쭉날쭉)', 'warn') : null, r.locked ? badge('Locked (잠김)', 'info') : r.lockedSome ? badge('Some months locked (일부 달 잠김)', 'info') : r.hasExisting ? badge('Has budget (예산 있음)', 'info') : null, r.trend > 12 && r.months >= 5 ? badge('Rising (오름)', 'warn') : r.trend < -12 && r.months >= 5 ? badge('Falling (내림)', 'good') : null];
    const why = (r) => h('div', { class: 'pl-why', 'data-why': r.id }, r.rationale);
    const curTxt = (r) => (r.hasExisting ? m0(r.startBudget || r.existing) : '—');

    function drawList() {
      refs.grp = new Map(); rowEls.clear();
      if (!rows.length) {
        listBox.replaceChildren(h('div', { class: 'card center muted', id: 'pl-ny-empty' }, 'Not enough spending history to suggest a budget (예산을 제안할 만큼 기록이 아직 없어요). 2개월 이상 거래가 쌓이면 나타나요.'));
        return;
      }
      const out = [];
      groups.forEach((g) => {
        const gc = L.GROUP_CLASS[g.key] || '';
        const subEl = h('span', { class: 'pl-sub', 'data-sub': g.key }, m0(sum(g.rows.map(effOf))) + '/mo');
        refs.grp.set(g.key, subEl);
        const head = h('div', { class: 'pl-grp ' + gc }, h('h2', { class: 'sect grp' }, g.label), subEl);
        if (phone) {
          const cards = g.rows.map((r) => {
            const card = h('div', { class: 'pl-ncard ' + gc + (incl(r) ? '' : ' off'), 'data-acct': r.id },
              h('div', { class: 'pl-ncard-top' }, chk(r), h('div', { class: 'pl-ncard-name' }, h('div', { class: 't' }, r.name), h('div', { class: 'b' }, badges(r)))),
              h('div', { class: 'pl-ncard-nums' },
                h('div', null, h('div', { class: 'l' }, avgLbl()), h('div', { class: 'v' }, m0(r.basis))),
                h('div', null, h('div', { class: 'l' }, 'Suggested (제안액)'), amtInput(r)),
                h('div', null, h('div', { class: 'l' }, 'Current (현재 예산)'), h('div', { class: 'v' }, curTxt(r)))),
              why(r));
            rowEls.set(r.id, [card]);
            return card;
          });
          out.push(head, h('div', { class: 'pl-cards' }, cards));
        } else {
          const tb = h('tbody');
          g.rows.forEach((r) => {
            const tr = h('tr', { class: 'pl-nrow ' + gc + (incl(r) ? '' : ' off'), 'data-acct': r.id },
              h('td', { class: 'c' }, chk(r)),
              h('td', { class: 'nm' }, h('div', { class: 't' }, r.name, ' ', badges(r)), desktop ? null : why(r)),
              h('td', { class: 'r' }, m0(r.basis)),
              h('td', { class: 'r' }, amtInput(r)),
              desktop ? h('td', { class: 'w' }, why(r)) : null,
              h('td', { class: 'r' }, curTxt(r)));
            rowEls.set(r.id, [tr]);
            tb.append(tr);
          });
          out.push(head, h('div', { class: 'tbl tbl-scroll' }, h('table', { class: 'pl-tbl pl-ntbl' },
            h('thead', null, h('tr', null, h('th', { class: 'c' }), h('th', { class: 'nm' }, 'Category ', h('span', { class: 'ko' }, '카테고리')), h('th', { class: 'r' }, useYear ? 'This year avg ' : 'Recent avg ', h('span', { class: 'ko' }, useYear ? '올해 월평균' : '최근 평균')), h('th', { class: 'r' }, 'Suggested ', h('span', { class: 'ko' }, '제안액')),
              desktop ? h('th', { class: 'w' }, 'Why ', h('span', { class: 'ko' }, '근거')) : null, h('th', { class: 'r' }, 'Current ', h('span', { class: 'ko' }, '현재 예산')))), tb)));
        }
      });
      out.push(dock);
      listBox.replaceChildren(...out);
    }

    // 적용 (확인 단계 카드 → 저장)
    const confirmBox = h('div', { id: 'pl-ny-confirm-box' });
    const doneBox = h('div', { id: 'pl-ny-done-box' });
    const dock = h('div', { class: 'pl-dock', id: 'pl-ny-dock' });
    function hideConfirm() { S.ny.confirming = false; confirmBox.replaceChildren(); applyRow.hidden = false; }
    function entriesNow() {
      const e = new Map();
      rows.filter(incl).forEach((r) => { const a = amountOf(r); if (a > 0) e.set(r.id, r2(a)); });
      return e;
    }
    // 저장할 행 만들기: 근거 문장을 넣고, 잠긴 달은 건드리지 않음
    function buildOut(e) {
      const start = startYm();
      const now = L.nowIso();
      const byId = new Map(rows.map((r) => [r.id, r]));
      const rat = (id) => { const r = byId.get(String(id)); if (!r) return ''; return S.ny.edits.has(r.id) ? r.rationale + ' · 제안 ' + m0(r.sugg) + ' 에서 직접 ' + m0(S.ny.edits.get(r.id)) + ' 로 수정' : r.rationale; };
      const old = new Map(budgets.map((b) => [String(b.budget_id), b]));
      let skipped = 0, overwrite = 0;
      const out = B.applyMap(budgets, e, start, S.ny.scope, now).map((x) => (e.has(String(x.account_id)) && !L.truthy(x.deleted) ? Object.assign({}, x, { rationale: rat(x.account_id) }) : x)).filter((x) => {
        const o = old.get(String(x.budget_id));
        if (o && !L.truthy(o.deleted) && L.truthy(o.locked)) { skipped++; return false; }
        if (o && !L.truthy(o.deleted) && L.num(o.amount_cad) > 0 && Math.abs(L.num(o.amount_cad) - L.num(x.amount_cad)) >= 0.005) overwrite++;
        return true;
      });
      return { out, skipped, overwrite, start, months: scopeMonths().length };
    }
    function showConfirm() {
      const e = entriesNow();
      if (!e.size) return;
      S.ny.confirming = true;
      applyRow.hidden = true;
      const protectedRows = rows.filter((r) => !incl(r) && (r.hasExisting || r.locked));
      const ms = scopeMonths();
      const pl = buildOut(e);
      confirmBox.replaceChildren(h('div', { class: 'card pl-confirm', id: 'pl-ny-confirm', role: 'alertdialog', 'aria-label': 'Confirm apply (적용 확인)' },
        h('div', { class: 'pl-confirm-t' }, icon('check', 20), 'Apply this budget? (이 예산을 적용할까요?)'),
        h('ul', null,
          h('li', null, h('b', null, nCat(e.size) + ' (카테고리 ' + e.size + '개)'), ' × ' + ms.length + ' month' + (ms.length > 1 ? 's' : '') + ' (' + ms.length + '개월) = ' + pl.out.length + ' rows (행)'),
          h('li', null, L.monthLabel(ms[0]) + ' → ' + L.monthLabel(ms[ms.length - 1]) + ' · total ' + m0(sum(Array.from(e.values()))) + '/mo (월 합계)'),
          h('li', null, 'Reasons are saved with each row (근거 문장이 각 행에 함께 저장돼요).'),
          pl.overwrite ? h('li', { id: 'pl-ny-overwrite', class: 'pl-neg' }, 'Replaces ' + pl.overwrite + ' existing budget rows. This cannot be undone (이미 있는 예산 ' + pl.overwrite + '행을 덮어써요. 되돌릴 수 없어요).') : null,
          pl.skipped ? h('li', { id: 'pl-ny-skipped' }, pl.skipped + ' locked rows are left alone (잠긴 ' + pl.skipped + '행은 건드리지 않아요).') : null,
          protectedRows.length ? h('li', null, h('b', null, 'Kept as is (그대로 유지): '), protectedRows.map((r) => r.name).join(', ')) : null),
        h('div', { class: 'btnrow' },
          h('button', { type: 'button', class: 'btn', id: 'pl-ny-go', onclick: doApply }, icon('check', 18), 'Confirm and save (확인하고 저장)'),
          h('button', { type: 'button', class: 'btn secondary', id: 'pl-ny-cancel', onclick: hideConfirm }, 'Cancel (취소)'))));
      const el = confirmBox.firstChild;
      if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (x) { /* 스크롤 실패는 무시 */ } }
    }
    async function doApply() {
      const e = entriesNow();
      if (!e.size) return;
      const { out, start, months, skipped } = buildOut(e);
      if (!out.length) { api.toast('Nothing to save (저장할 내용이 없어요)'); return; }
      const btn = document.getElementById('pl-ny-go');
      if (btn) btn.disabled = true;
      S.ny.confirming = false;
      S.ny.done = { count: e.size, months, start, total: sum(Array.from(e.values())), rows: out.length, skipped, scope: S.ny.scope };
      S.ny.edits = new Map(); S.ny.incl = new Map();
      try {
        await api.saveBudgets(out);
        api.toast('Budget saved (예산 저장됨): ' + nCat(e.size) + ' × ' + months + ' month' + (months > 1 ? 's' : ''));
      } catch (err) {
        S.ny.done = null;
        api.toast('Could not save (저장하지 못했어요): ' + ((err && err.message) || err));
        if (btn) btn.disabled = false;
      }
    }
    function drawDone() {
      const d = S.ny.done;
      if (!d) { doneBox.replaceChildren(); return; }
      doneBox.replaceChildren(h('div', { class: 'card pl-done', id: 'pl-ny-done' },
        h('div', { class: 'pl-confirm-t' }, icon('check', 20), 'Saved (저장했어요)'),
        h('div', null, nCat(d.count) + ' × ' + d.months + ' month' + (d.months > 1 ? 's' : '') + ' from ' + L.monthLabel(d.start) + ', ' + m0(d.total) + '/mo (' + d.count + '개 카테고리, ' + L.monthLabel(d.start) + ' 부터 ' + d.months + '개월)' + (d.skipped ? ' · ' + d.skipped + ' locked rows kept (잠긴 ' + d.skipped + '행 유지)' : '') + '.'),
        h('div', { class: 'btnrow' },
          h('button', { type: 'button', class: 'btn', id: 'pl-ny-open', onclick: () => { R.setMode('BG'); api.go('reports', { month: d.start }); } }, icon('reports', 18), 'See it in Reports → Budget (예산에서 확인)'),
          h('button', { type: 'button', class: 'btn secondary', id: 'pl-ny-dismiss', onclick: () => { S.ny.done = null; drawDone(); } }, 'Close (닫기)'))));
    }

    // 위쪽 설정 카드
    function monthOpts() {
      const base = L.monthOf(today);
      return [0, 1, 2, 3, 4, 5, 6].map((i) => { const m = L.shiftMonth(base, i); return h('option', { value: m, selected: m === startYm() }, L.monthLabel(m) + (i === 1 ? ' — next month (다음 달)' : i === 0 ? ' — this month (이번 달)' : '')); });
    }
    function redo() { calc(); paintBasis(); hideConfirm(); drawList(); drawSum(); }
    const startSel = h('select', { id: 'pl-ny-start', 'aria-label': 'Start month (시작 달)', onchange: (e) => { S.ny.start = e.target.value; S.ny.done = null; S.ny.incl = new Map(); paintScope(); redo(); drawDone(); } }, monthOpts());
    const SCOPES = [['month', 'This month only', '이번 달만'], ['year', 'Rest of the year', '올해 남은 달'], ['next12', 'Next 12 months', '앞으로 12개월']];
    const scopeChips = h('div', { class: 'pl-chips pl-scopes', role: 'group', 'aria-label': 'Apply to (적용 범위)' });
    const scopeNote = h('div', { class: 'note', id: 'pl-ny-scopenote' });
    function paintScope() {
      scopeChips.replaceChildren(...SCOPES.map(([k, en, ko]) => h('button', { type: 'button', class: 'pl-chip pl-chip2' + (S.ny.scope === k ? ' on' : ''), id: 'pl-ny-sc-' + k, 'aria-pressed': String(S.ny.scope === k),
        onclick: () => { S.ny.scope = k; S.ny.done = null; S.ny.incl = new Map(); paintScope(); redo(); drawDone(); } }, en, h('span', { class: 'ko' }, ko))));
      const ms = scopeMonths();
      scopeNote.textContent = L.monthLabel(ms[0]) + (ms.length > 1 ? ' → ' + L.monthLabel(ms[ms.length - 1]) : '') + ' · ' + ms.length + ' month' + (ms.length > 1 ? 's' : '') + ' (' + ms.length + '개월). Existing budgets in these months get replaced (이 기간의 기존 예산은 바뀌어요).';
    }
    refs.cnt = h('span', { class: 'pl-cnt', id: 'pl-ny-cnt' });
    refs.apply = h('button', { type: 'button', class: 'btn', id: 'pl-ny-apply', onclick: showConfirm }, icon('check', 18), 'Apply (적용)');
    const applyRow = h('div', { class: 'pl-apply-row', id: 'pl-ny-applyrow' }, refs.cnt, h('button', { type: 'button', class: 'btn secondary sm', id: 'pl-ny-reset', onclick: () => { S.ny.edits = new Map(); S.ny.incl = new Map(); redo(); } }, 'Reset (초기화)'), refs.apply);
    dock.append(doneBox, confirmBox, applyRow);
    const basisChips = h('div', { class: 'pl-chips pl-basis', role: 'group', 'aria-label': 'Based on (기준)' });
    const basisNote = h('div', { class: 'note', id: 'pl-ny-basisnote' });
    const yearBanner = h('div', { class: 'pl-yb', id: 'pl-ny-yearbanner' });
    function paintBasis() {
      const B2 = [['year', "This year's forecast", '올해 예상'], ['recent', 'Last 12 months', '최근 12개월']];
      basisChips.replaceChildren(...B2.map(([k, en, ko]) => h('button', { type: 'button', class: 'pl-chip pl-chip2' + (S.ny.basis === k ? ' on' : ''), id: 'pl-ny-b-' + k, 'aria-pressed': String(S.ny.basis === k),
        onclick: () => { S.ny.basis = k; S.ny.done = null; S.ny.incl = new Map(); S.ny.edits = new Map(); paintBasis(); redo(); drawDone(); } }, en, h('span', { class: 'ko' }, ko))));
      basisNote.textContent = useYear
        ? 'Each suggestion = this year\'s expected total (actual so far + your forecast for the rest) ÷ months, plus inflation (올해 실제 + 남은 달 예상을 합친 연말 합계 ÷ 개월 + 물가로 만든 제안이에요. 금액은 고칠 수 있어요).'
        : (S.ny.basis === 'year' ? 'No year forecast to use yet, so the recent average is shown (올해 예상을 만들 기록이 아직 없어 최근 평균으로 보여줘요). ' : '') + 'Each suggestion is the recent average plus inflation, with the reason in plain words (최근 평균 + 물가로 만든 제안이에요. 금액은 고칠 수 있어요).';
      if (useYear && yo) {
        yearBanner.hidden = false;
        yearBanner.replaceChildren(h('div', { class: 'pl-yb-t' }, 'This year\'s outlook (올해 예상)'),
          h('div', { class: 'pl-yb-r' }, 'Income (수입) ', h('b', null, m0(yo.yearIncome)), ' · Spending (지출) ', h('b', null, m0(yo.yearExpense)), ' · ', arrow(yo.yearNet, true, yo.yearNet >= 0 ? 'left over (남음)' : 'short (부족)')),
          h('button', { type: 'button', class: 'pl-link', id: 'pl-ny-togc', onclick: () => { const b = document.getElementById('pl-tab-fc'); if (b) b.click(); } }, 'Edit the forecast (예측 고치기) ›'));
      } else { yearBanner.hidden = true; yearBanner.replaceChildren(); }
    }
    const avgLbl = () => (useYear ? 'This year avg (올해 월평균)' : 'Recent avg (최근 평균)');
    calc();
    paintBasis();
    paintScope();
    top.append(
      h('div', { class: 'card pl-nyctl' },
        heading('Next-year budget (내년 예산)', '지난 기록으로 제안'),
        h('div', { class: 'lbl' }, 'Based on (기준)'), basisChips, basisNote,
        yearBanner,
        h('div', { class: 'pl-ctl-row' },
          h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Start month (시작 달)'), startSel),
          growthCtl(() => { S.ny.done = null; redo(); }, 'pl-ny-')),
        h('div', { class: 'lbl pl-gap' }, 'Apply to (적용 범위)'), scopeChips, scopeNote,
        h('div', { class: 'note' }, 'Check the list below, then tap Apply at the bottom (아래 목록을 확인하고 맨 아래 적용 버튼을 누르세요).')),
      sumBox);
    side.append(aiPanel('plan', aiCtx, { btn: 'pl-ny-ai', out: 'pl-ny-ai-out', card: 'pl-ny-aicard', hint: 'pl-ny-ai-hint' }, 'Review this budget with AI (AI 로 점검)', 'Sends only totals, never your transactions. Free quota is limited, so it runs only when you tap (거래 원본은 보내지 않아요. 누를 때만 실행돼요).'));

    drawList(); drawSum(); drawDone();
    if (S.ny.confirming) showConfirm();
    return frag;
  }

  // ───────────────────────────────────── 3) Debt payoff ─────────────────────────────────────
  function buildDebt() {
    const frag = h('div', { class: 'pl-grid pl-debt' });
    const all = allDebts;
    if (!all.length) {
      frag.append(h('div', { class: 'card center pl-party', id: 'pl-debt-free' }, h('div', { class: 'big' }, '🎉'), h('h3', null, 'Debt-free! (부채가 없어요)'), h('div', { class: 'muted' }, '카드·대출·한도 잔액이 모두 0 이에요. 남는 돈은 비상금과 투자로 보내세요.')));
      return frag;
    }
    const hasMort = all.some(isMortgage);
    const col = h('div', { class: 'pl-col' });
    const top = h('div', { class: 'pl-top' });
    const out = h('div', { class: 'pl-dout' });
    const side = h('div', { class: 'pl-side' });
    col.append(top, out);
    frag.append(col, side);

    if (S.debt.strategy === savedStrat) S.debt.strategy = null;
    if (S.debt.extraDraft !== null && Math.abs(S.debt.extraDraft - savedExtra) < 0.005) S.debt.extraDraft = null;
    const strat = dStrat, curExtra = dExtra;
    let list = [], res = null;

    // ── 입력 카드 (한 번만 만들고 안의 값만 바꿈)
    const extraIn = h('input', { type: 'text', id: 'pl-extra', inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Extra per month (매달 추가 상환액)', value: String(r2(curExtra())) });
    const saveBtn = h('button', { type: 'button', class: 'btn sm', id: 'pl-plan-save', hidden: true, onclick: async () => { const patch = { extra: r2(curExtra()), strategy: strat() }; await savePlan(patch, 'Plan saved (계획 저장됨)'); S.debt.extraDraft = null; S.debt.strategy = null; } }, 'Save (저장)');
    const dirty = () => { saveBtn.hidden = !(Math.abs(curExtra() - savedExtra) >= 0.005 || strat() !== savedStrat); };
    let tmr = null;
    extraIn.addEventListener('input', () => {
      const n = numIn(extraIn.value);
      if (!Number.isFinite(n) || n < 0 || n > 1e7) { extraIn.setAttribute('aria-invalid', 'true'); return; }
      extraIn.removeAttribute('aria-invalid');
      S.debt.extraDraft = Math.abs(n - savedExtra) < 0.005 ? null : r2(n);
      dirty();
      clearTimeout(tmr); tmr = setTimeout(draw, 120);
    });
    const segEl = h('div', { class: 'segtd pl-seg2', role: 'tablist', 'aria-label': 'Strategy (전략)' });
    function paintStrat() {
      segEl.replaceChildren(...STRATS.map(([k, en, ko]) => h('button', { type: 'button', role: 'tab', id: 'pl-st-' + k, class: strat() === k ? 'on' : '', 'aria-selected': String(strat() === k), onclick: () => pick(k) }, en, h('span', { class: 'ko' }, ko))));
    }
    function pick(k) { S.debt.strategy = k; paintStrat(); dirty(); draw(); }
    const mortBtn = hasMort ? h('button', { type: 'button', class: 'pl-toggle', id: 'pl-mort', 'aria-pressed': String(S.debt.includeMortgage), onclick: () => { S.debt.includeMortgage = !S.debt.includeMortgage; mortBtn.setAttribute('aria-pressed', String(S.debt.includeMortgage)); mortBtn.classList.toggle('on', S.debt.includeMortgage); mortTxt(); draw(); } }, h('span', { class: 'knob' }), h('span', { class: 'tx' })) : null;
    const mortTxt = () => { if (mortBtn) mortBtn.querySelector('.tx').textContent = S.debt.includeMortgage ? 'Mortgage included (모기지 포함)' : 'Mortgage excluded (모기지 제외)'; };
    if (mortBtn) { mortBtn.classList.toggle('on', S.debt.includeMortgage); mortTxt(); }
    top.append(h('div', { class: 'card pl-dctl' },
      heading('Payoff plan (상환 계획)', '카드·한도·소액 대출'),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Extra per month (매달 추가 상환액)'),
        h('div', { class: 'pl-inline' }, h('span', { class: 'unit' }, '$'), extraIn, saveBtn)),
      h('div', { class: 'lbl' }, 'Strategy (전략)'), segEl, mortBtn ? h('div', { class: 'pl-mortrow' }, mortBtn) : null,
      h('div', { class: 'note' }, 'Minimum payments come first, the extra goes to the target debt (최소 납입은 항상 내고, 추가 금액은 목표 부채에 먼저 넣어요).')));
    paintStrat();

    // ── 결과 영역
    const charts = [];
    function draw() {
      dirty();
      charts.splice(0).forEach((c) => { try { c.destroy(); } catch (e) { /* 이미 사라진 차트 */ } });
      list = planDebts(all, S.debt.includeMortgage);
      const extra = curExtra();
      const nodes = [];
      if (!list.length) {
        res = null;
        nodes.push(h('div', { class: 'card center muted', id: 'pl-debt-onlymort' }, 'No cards, lines of credit or small loans — only the mortgage is left (카드·한도·소액 대출은 없고 모기지만 남았어요). Use the mortgage switch above to include it (위 스위치로 포함할 수 있어요).'));
        out.replaceChildren(...nodes); side.replaceChildren(); paintBanner(); return;
      }
      res = comparePlans(list, extra);
      nodes.push(debtListEl(), compareEl(), chartsEl(), interestEl());
      out.replaceChildren(...nodes);
      side.replaceChildren(targetEl(), aiPanel('debt', debtAiCtx, { btn: 'pl-debt-ai', out: 'pl-debt-ai-out', card: 'pl-debt-aicard', hint: 'pl-debt-ai-hint' }, 'Debt briefing (부채 AI 브리핑)', 'Sends only balances, rates and the plan numbers (잔액·이율·계획 숫자만 보내요). Runs only when you tap (누를 때만 실행).'));
      paintBanner();
    }
    const aprMissing = () => list.filter((d) => !d.hasApr);
    function debtAiCtx() {
      const pl = res.plans;
      const sm = (k) => ({ months: pl[k].months, neverEnds: pl[k].neverEnds, totalInterest: Math.round(pl[k].totalInterest), payoffOrder: pl[k].order.slice(0, 6).map((o) => o.name + ' (' + o.month + 'mo)') });
      return I.aiContext(ctx, { payoff: { extraPerMonth: Math.round(curExtra()), selected: strat(), recommended: res.rec, includesMortgage: S.debt.includeMortgage, missingApr: aprMissing().map((d) => d.name), avalanche: sm('avalanche'), snowball: sm('snowball'), minimumOnly: sm('none') } });
    }

    // 부채 목록
    function debtListEl() {
      const missing = aprMissing();
      const box = h('div', { class: 'pl-dlist', id: 'pl-dlist' });
      box.append(heading('Your debts (부채 목록)', '이율·한도·최소 납입은 Wealth 탭에서 설정'));
      if (missing.length) {
        box.append(h('div', { class: 'card warn-card pl-aprwarn', id: 'pl-apr-warn', role: 'alert' },
          h('div', null, icon('alert', 18), ' ' + missing.length + ' debt' + (missing.length > 1 ? 's have' : ' has') + ' no interest rate (이율이 없어요): ' + missing.map((d) => d.name).join(', ') + '. Calculated as 0% for now (지금은 이율 0 으로 계산해요) — 실제 이자는 더 많아요.'),
          h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn sm', id: 'pl-go-wealth', onclick: goWealth }, 'Enter the rate in Wealth (이율을 입력하세요 → Wealth)'))));
      }
      const noMin = list.filter((d) => !(d.min > 0));
      if (noMin.length) box.append(h('div', { class: 'note' }, 'No minimum payment set for ' + noMin.map((d) => d.name).join(', ') + ' (최소 납입이 없어서 추가 금액이 없으면 끝나지 않아요).'));
      const sched = (d) => !!(meta.loans && meta.loans[d.id] && Number(meta.loans[d.id].pmt) > 0);
      const worst = list.slice().sort((a, b) => b.monthlyInterest - a.monthlyInterest)[0];
      if (phone) {
        box.append(h('div', { class: 'pl-dcards' }, list.map((d) => h('div', { class: 'pl-dcard' + (worst && d.id === worst.id && d.monthlyInterest > 0 ? ' hot' : ''), 'data-debt': d.id },
          h('div', { class: 'pl-dcard-top' }, h('div', { class: 't' }, d.name, ' ', d.hasApr ? badge(d.apr + '% APR', d.apr >= 15 ? 'warn' : 'info') : badge('No APR (이율 없음)', 'warn'), sched(d) ? badge('Schedule (상환표)', 'info') : null), h('div', { class: 'v' }, m0(d.balance))),
          h('div', { class: 'pl-dcard-sub' }, 'Min ' + (d.min > 0 ? m0(d.min) : '—') + (d.limit > 0 ? ' · Limit ' + m0(d.limit) + ' · Used ' + Math.round(d.util) + '%' : '') + ' · Interest ' + m0(d.monthlyInterest) + '/mo'),
          d.limit > 0 ? h('div', { class: 'bar' }, h('i', { class: 'bar-fill ' + (d.util > 60 ? 'over' : d.util > 30 ? 'near' : 'ok'), style: 'width:' + clamp(d.util, 0, 100) + '%' })) : null))));
      } else {
        box.append(h('div', { class: 'tbl tbl-scroll' }, h('table', { class: 'pl-tbl', id: 'pl-dtable' },
          h('thead', null, h('tr', null, h('th', null, 'Debt ', h('span', { class: 'ko' }, '부채')), h('th', null, 'Balance ', h('span', { class: 'ko' }, '잔액')), h('th', null, 'APR ', h('span', { class: 'ko' }, '이율')), h('th', null, 'Limit · use ', h('span', { class: 'ko' }, '한도·사용률')), h('th', null, 'Minimum ', h('span', { class: 'ko' }, '최소 납입')), h('th', null, 'Interest / mo ', h('span', { class: 'ko' }, '월 이자')))),
          h('tbody', null, list.map((d) => h('tr', { class: worst && d.id === worst.id && d.monthlyInterest > 0 ? 'hot' : '', 'data-debt': d.id },
            h('td', null, d.name, ' ', sched(d) ? badge('Schedule (상환표)', 'info') : null), h('td', null, m0(d.balance)),
            h('td', null, d.hasApr ? badge(d.apr + '%', d.apr >= 15 ? 'warn' : 'info') : badge('— none', 'warn')),
            h('td', null, d.limit > 0 ? m0(d.limit) + ' · ' + Math.round(d.util) + '%' : '—'), h('td', null, d.min > 0 ? m0(d.min) : '—'), h('td', null, m0(d.monthlyInterest))))))));
      }
      if (!S.debt.includeMortgage && hasMort) {
        const mo = all.filter(isMortgage);
        box.append(h('div', { class: 'note', id: 'pl-mort-note' }, 'Not included (제외): ' + mo.map((d) => d.name + ' ' + m0(d.balance)).join(', ') + '. Turn the switch above on to include it (위 스위치를 켜면 포함돼요).'));
      }
      return box;
    }

    // 전략 비교
    const dateOf = (p) => (p.neverEnds ? 'Never (끝나지 않음)' : L.monthLabel(V.addMonths(state.month, p.months)));
    const monthsOf = (p) => (p.neverEnds ? '50+ years (50년 넘게)' : spanLabel(p.months));
    const savedOf = (k) => { const n = res.plans.none; if (k === 'none' || n.neverEnds || res.plans[k].neverEnds) return null; return r2(n.totalInterest - res.plans[k].totalInterest); };
    const orderOf = (p) => (p.order.length ? p.order.slice(0, 3).map((o) => o.name).join(' → ') + (p.order.length > 3 ? ' …' : '') : '—');
    function compareEl() {
      const box = h('div', { class: 'pl-compare', id: 'pl-compare' });
      box.append(heading('Compare strategies (전략 비교)', '눌러서 선택'));
      const cur = strat();
      const sv = (k) => { const v = savedOf(k); return v === null ? (k === 'none' ? '—' : 'n/a (비교 불가)') : h('span', { class: v >= 0 ? 'chg good' : 'chg bad' }, h('span', { class: 'arw' }, v >= 0 ? '▼' : '▲'), m0(Math.abs(v))); };
      if (phone) {
        box.append(h('div', { class: 'pl-cmp-cards' }, STRATS.map(([k, en, ko]) => { const p = res.plans[k]; return h('button', { type: 'button', class: 'pl-cmp-card' + (cur === k ? ' on' : ''), id: 'pl-cmp-' + k, 'data-strat': k, 'aria-pressed': String(cur === k), onclick: () => pick(k) },
          h('div', { class: 'hd' }, h('b', null, en, ' ', h('span', { class: 'ko' }, '(' + ko + ')')), res.rec === k ? badge('Recommended (추천)', 'good') : null),
          h('div', { class: 'kv' }, h('span', null, 'Debt-free in (완납까지)'), h('b', { class: 'm' }, monthsOf(p))),
          h('div', { class: 'kv' }, h('span', null, 'Debt-free month (완납 월)'), h('b', { class: 'd' }, dateOf(p))),
          h('div', { class: 'kv' }, h('span', null, 'Total interest (총 이자)'), h('b', { class: 'i' }, p.neverEnds ? '—' : m0(p.totalInterest))),
          h('div', { class: 'kv' }, h('span', null, 'Interest saved (절약한 이자)'), h('b', { class: 's' }, sv(k))),
          h('div', { class: 'kv ord' }, h('span', null, 'Order (끝나는 순서)'), h('b', { class: 'o' }, orderOf(p)))); })));
      } else {
        box.append(h('div', { class: 'tbl tbl-scroll' }, h('table', { class: 'pl-tbl pl-cmp', id: 'pl-cmp-table' },
          h('thead', null, h('tr', null, h('th', null, 'Strategy ', h('span', { class: 'ko' }, '전략')), h('th', null, 'Debt-free in ', h('span', { class: 'ko' }, '완납까지')), h('th', null, 'Month ', h('span', { class: 'ko' }, '완납 월')), h('th', null, 'Total interest ', h('span', { class: 'ko' }, '총 이자')), h('th', null, 'Saved vs minimum ', h('span', { class: 'ko' }, '절약한 이자')), h('th', { class: 'o' }, 'Finish order ', h('span', { class: 'ko' }, '끝나는 순서')))),
          h('tbody', null, STRATS.map(([k, en, ko]) => { const p = res.plans[k]; return h('tr', { class: 'line' + (cur === k ? ' on' : ''), id: 'pl-cmp-' + k, 'data-strat': k, tabindex: 0, role: 'button', 'aria-pressed': String(cur === k), onclick: () => pick(k), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(k); } } },
            h('td', null, h('b', null, en), ' ', h('span', { class: 'ko' }, ko), ' ', res.rec === k ? badge('Recommended (추천)', 'good') : null), h('td', { class: 'm' }, monthsOf(p)), h('td', { class: 'd' }, dateOf(p)), h('td', { class: 'i' }, p.neverEnds ? '—' : m0(p.totalInterest)), h('td', { class: 's' }, sv(k)), h('td', { class: 'o' }, orderOf(p))); })))));
      }
      const p = res.plans[cur];
      if (p.neverEnds) box.append(h('div', { class: 'card warn-card', id: 'pl-never', role: 'alert' }, icon('alert', 18), ' With this plan some debts never get paid off (이 계획으로는 끝나지 않는 부채가 있어요). Raise the extra amount or enter minimum payments in Wealth (추가 금액을 늘리거나 Wealth 에서 최소 납입을 입력하세요).'));
      else if (res.rec && cur !== res.rec && !res.plans[res.rec].neverEnds && cur !== 'none') box.append(h('div', { class: 'note' }, 'Tip (팁): ' + STRATS.find((s) => s[0] === res.rec)[1] + ' would save ' + m0(p.totalInterest - res.plans[res.rec].totalInterest) + ' more interest (이자를 더 아낄 수 있어요).'));
      return box;
    }

    // 차트
    function chartsEl() {
      const cur = strat();
      const ends = ['avalanche', 'snowball', 'none'].map((k) => (res.plans[k].neverEnds ? 0 : res.plans[k].months));
      const sel = res.plans[cur];
      const Hm = clamp(Math.max(...ends, sel.neverEnds ? 36 : sel.months), 12, 120);
      const labels = Array.from({ length: Hm + 1 }, (_, i) => shortMon(V.addMonths(state.month, i)));
      const at = (p, i, key) => { const t = p.timeline[i]; if (t) return t[key] || 0; return 0; };
      const colorOf = { avalanche: 'var(--c1)', snowball: 'var(--c2)', none: 'var(--c4)' };
      const c1 = lineChart({
        title: 'Total debt by strategy (전략별 총 부채 잔액)', labels, fmt: m0, axisFmt: axisMoney, height: phone ? 220 : 270,
        series: STRATS.map(([k, en]) => ({ key: k, name: en, color: colorOf[k], dashed: k === 'none', values: Array.from({ length: Hm + 1 }, (_, i) => r2(at(res.plans[k], i, 'total'))) }))
      });
      const sHm = clamp(sel.neverEnds ? 36 : sel.months, 6, 120);
      const c2 = lineChart({
        title: 'Debt by account — ' + STRATS.find((s) => s[0] === cur)[1] + ' (부채별 잔액)', labels: Array.from({ length: sHm + 1 }, (_, i) => shortMon(V.addMonths(state.month, i))), stacked: true, fmt: m0, axisFmt: axisMoney, height: phone ? 220 : 270,
        series: list.map((d, i) => ({ key: d.id, name: d.name, color: 'var(--c' + ((i % 8) + 1) + ')', values: Array.from({ length: sHm + 1 }, (_, k) => r2(at(sel, k, String(d.id)))) }))
      });
      charts.push(c1, c2);
      return h('div', { class: 'pl-dcharts', id: 'pl-dcharts' },
        h('div', { class: 'card' }, heading('Total debt over time (시간에 따른 총 부채)', '세 전략'), c1, h('div', { class: 'note' }, Hm >= 120 ? 'Showing the first 10 years (처음 10년만 보여요).' : 'Tap the chart to see each month (차트를 누르면 월별 값이 보여요).')),
        h('div', { class: 'card' }, heading('Which debt shrinks when (어느 부채가 언제 줄어드나)', '선택한 전략'), c2));
    }

    // 이자 부담
    function interestEl() {
      const mi = sum(list.map((d) => d.monthlyInterest));
      const worst = list.slice().sort((a, b) => b.monthlyInterest - a.monthlyInterest)[0];
      const rich = list.filter((d) => d.hasApr).sort((a, b) => b.apr - a.apr)[0];
      return h('div', { class: 'card pl-interest', id: 'pl-interest' },
        heading('Interest you pay now (지금 내는 이자)', '이율이 있는 부채 기준'),
        h('div', { class: 'pl-stats' },
          h('div', { class: 'pl-stat' }, h('div', { class: 'pl-stat-l' }, 'Per month (월 이자)'), h('div', { class: 'pl-stat-v', id: 'pl-int-mo' }, m0(mi))),
          h('div', { class: 'pl-stat' }, h('div', { class: 'pl-stat-l' }, 'Per year (연 환산)'), h('div', { class: 'pl-stat-v', id: 'pl-int-yr' }, m0(mi * 12))),
          h('div', { class: 'pl-stat bad' }, h('div', { class: 'pl-stat-l' }, 'Most expensive (가장 비싼 부채)'), h('div', { class: 'pl-stat-v sm', id: 'pl-int-top' }, worst && worst.monthlyInterest > 0 ? worst.name : '—'), worst && worst.monthlyInterest > 0 ? h('div', { class: 'pl-stat-s' }, m0(worst.monthlyInterest) + '/mo · ' + worst.apr + '%') : null)),
        rich && rich.apr >= 15 ? h('div', { class: 'pl-warnline' }, icon('alert', 16), rich.name + ' costs ' + rich.apr + '% a year (연 ' + rich.apr + '%). Paying it first saves the most (가장 먼저 갚으면 이자를 제일 많이 아껴요).') : null);
    }

    // 목표 날짜로 역산
    function targetEl() {
      const resBox = h('div', { class: 'pl-tg-res', id: 'pl-tg-res', 'aria-live': 'polite' });
      const inp = h('input', { type: 'text', id: 'pl-tg-months', inputmode: 'numeric', autocomplete: 'off', 'aria-label': 'Months until debt-free (목표 개월 수)', value: S.debt.target });
      const calc = () => {
        S.debt.target = inp.value;
        const n = Math.round(numIn(inp.value));
        if (!(n >= 1) || n > 600) { resBox.replaceChildren(h('div', { class: 'note' }, 'Enter 1–600 months (1~600 개월 사이로 입력하세요).')); return; }
        const sk = strat() === 'none' ? 'avalanche' : strat();
        const r = extraForTarget(list, sk, n);
        if (!r) { resBox.replaceChildren(); return; }
        const when = L.monthLabel(V.addMonths(state.month, n));
        if (r.already) {
          const p = V.payoffPlan(list, 0, sk);
          resBox.replaceChildren(h('div', { class: 'pl-tg-big', id: 'pl-tg-extra' }, 'No extra needed (추가 금액 없이 가능)'), h('div', { class: 'note' }, 'Minimum payments already clear everything by ' + when + ' (최소 납입만으로 ' + when + ' 까지 끝나요). Interest ' + m0(p.totalInterest) + '.'));
          return;
        }
        const p = V.payoffPlan(list, r.extra, sk);
        const none = res.plans.none;
        const base = sum(list.map((d) => d.min));
        put(resBox,
          h('div', { class: 'pl-tg-big', id: 'pl-tg-extra', 'data-extra': String(r.extra) }, '+' + fmtMoney2(r.extra), h('span', { class: 'lab' }, ' extra per month (매달 추가)')),
          h('div', { class: 'pl-wi-line' }, h('span', null, 'Debt-free (완납)'), h('span', null, when + ' · ' + spanLabel(p.months))),
          h('div', { class: 'pl-wi-line' }, h('span', null, 'Total paid per month (월 총 납입)'), h('span', null, m0(base + r.extra))),
          h('div', { class: 'pl-wi-line' }, h('span', null, 'Total interest (총 이자)'), h('span', null, m0(p.totalInterest) + (none.neverEnds ? '' : ''))),
          none.neverEnds ? null : h('div', { class: 'pl-wi-line' }, h('span', null, 'Saved vs minimum (최소 납입 대비)'), h('span', null, arrow(none.totalInterest - p.totalInterest, true))),
          h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn secondary sm', id: 'pl-tg-use', onclick: () => { extraIn.value = String(r.extra); S.debt.extraDraft = Math.abs(r.extra - savedExtra) < 0.005 ? null : r.extra; if (S.debt.strategy === 'none' || strat() === 'none') S.debt.strategy = 'avalanche'; paintStrat(); extraIn.dispatchEvent(new Event('input', { bubbles: true })); } }, 'Use this amount (이 금액 적용)')),
          h('div', { class: 'note' }, 'Uses ' + STRATS.find((s) => s[0] === sk)[1] + '. Not saved until you tap Save (저장 버튼을 누르기 전에는 저장되지 않아요).'));
      };
      inp.addEventListener('input', calc);
      const chips = h('div', { class: 'pl-chips' }, [12, 24, 36, 60].map((n) => chip(n + ' mo', false, () => { inp.value = String(n); calc(); }, 'pl-tg-' + n)));
      const card = h('div', { class: 'card pl-target', id: 'pl-target' },
        heading('Plan for a payoff date (목표 날짜로 역산)', '며칠까지 다 갚고 싶다면'),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Debt-free in how many months? (몇 개월 안에 갚을까요?)'), h('div', { class: 'pl-inline' }, inp, h('span', { class: 'unit' }, 'months (개월)'))),
        chips, resBox);
      calc();
      return card;
    }
    const fmtMoney2 = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    draw();
    return frag;
  }

  // ───────────────────────────────────── 틀 ─────────────────────────────────────
  const root = h('div', { class: 'plan', id: 'plan-root' });
  const bannerHost = h('section', { class: 'banner nopills', id: 'pl-banner' });
  const page = h('div', { class: 'page', id: 'pl-page' });
  const body = h('div', { id: 'pl-body' });
  const seg = h('div', { class: 'segtd pl-seg', role: 'tablist', 'aria-label': 'Plan sections (계획 구역)' });
  const TABS = [['fc', 'Forecast', '예측'], ['ny', 'Next-year budget', '내년 예산'], ['debt', 'Debt payoff', '부채 상환']];

  // ── 배너: 세 숫자(이번 달 남는 돈 · 12개월 저축 · 부채 완납)는 어느 구역에서나 보이고, 가정을 바꾸면 바로 바뀝니다
  const allDebts = ctx.debts.filter((d) => d.kind !== 'accrued');
  const bnCache = { fc: new Map(), debt: new Map() };
  function bnFc() {
    const g = curGrowth();
    if (!bnCache.fc.has(g)) {
      const rows = I.projectMonths(pctx, 12, { growth: g });
      const noData = rows.every((r) => r.income === 0 && r.expense === 0);
      const past = ctx.series.filter((x) => !(inProg && x.ym === state.month) && (x.income > 0 || x.expense > 0));
      const save12 = noData ? null : r2(sum(rows.map((r) => r.net)));
      bnCache.fc.set(g, { rows, noData, save12, pastYear: past.length >= 3 ? r2(avg(past.map((x) => x.net)) * 12) : null });
    }
    return bnCache.fc.get(g);
  }
  function bnDebt() {
    if (!allDebts.length) return { state: 'free' };
    const list = planDebts(allDebts, S.debt.includeMortgage);
    if (!list.length) return { state: 'onlymort' };
    const key = [dStrat(), dExtra(), S.debt.includeMortgage].join('|');
    if (!bnCache.debt.has(key)) bnCache.debt.set(key, { state: 'plan', p: V.payoffPlan(list, dExtra(), dStrat()), none: V.payoffPlan(list, 0, 'none') });
    return bnCache.debt.get(key);
  }
  function paintBanner() {
    const bchip = (v, goodUp, text, cap) => (Math.abs(v) < 0.5
      ? h('div', { class: 'pl-bd' }, h('span', { class: 'pl-bchip flat' }, '—'), cap ? h('span', { class: 'cap' }, cap) : null)
      : h('div', { class: 'pl-bd' }, h('span', { class: 'pl-bchip ' + ((goodUp === false ? v < 0 : v > 0) ? 'good' : 'bad') }, h('span', { class: 'arw' }, v > 0 ? '▲' : '▼'), text), cap ? h('span', { class: 'cap' }, cap) : null));
    const bm = (id, en, ko, val, d, cls) => h('div', { class: 'pl-bm' + (cls ? ' ' + cls : ''), id }, h('div', { class: 'lab' }, en, ' ', h('span', { class: 'ko' }, '(' + ko + ')')), h('div', { class: 'val' }, val), d || null);
    const prevNet = ctx.prev && (ctx.prev.income > 0 || ctx.prev.expense > 0) ? ctx.prev.net : null;
    const f = bnFc();
    const net = bm('bn-net', fc.done ? 'Net this month' : 'Left this month', fc.done ? '이번 달 순수입' : '이번 달 예상 남는 돈', (fc.projNet < 0 ? '−' : '') + m0(Math.abs(fc.projNet)).replace('−', ''),
      prevNet === null ? h('div', { class: 'pl-bd' }, h('span', { class: 'cap' }, 'No last month to compare (지난달 기록 없음)')) : bchip(fc.projNet - prevNet, true, m0(Math.abs(fc.projNet - prevNet)), 'vs last month (지난달 대비)'), 'hero');
    const sv = bm('bn-save12', '12-month savings', '12개월 예상 저축', f.save12 === null ? '—' : (f.save12 < 0 ? '−' : '') + m0(Math.abs(f.save12)).replace('−', ''),
      f.save12 === null ? h('div', { class: 'pl-bd' }, h('span', { class: 'cap' }, 'Needs more records (기록이 더 필요해요)')) : f.pastYear === null ? h('div', { class: 'pl-bd' }, h('span', { class: 'cap' }, 'Next 12 months (앞으로 12개월)')) : bchip(f.save12 - f.pastYear, true, m0(Math.abs(f.save12 - f.pastYear)), 'vs now (현재 페이스 대비)'));
    const bd = bnDebt();
    let dv, dd;
    if (bd.state === 'free') { dv = 'Debt-free (부채 없음)'; dd = h('div', { class: 'pl-bd' }, h('span', { class: 'cap' }, 'No cards or loans (카드·대출 없음)')); }
    else if (bd.state === 'onlymort') { dv = '—'; dd = h('div', { class: 'pl-bd' }, h('span', { class: 'cap' }, 'Only the mortgage is left (모기지만 남음)')); }
    else if (bd.p.neverEnds) { dv = 'Never (끝나지 않음)'; dd = h('div', { class: 'pl-bd' }, h('span', { class: 'pl-bchip bad' }, h('span', { class: 'arw' }, '▲'), 'raise payments (납입 늘리기)')); }
    else {
      dv = L.monthLabel(V.addMonths(state.month, bd.p.months));
      dd = bd.none.neverEnds ? h('div', { class: 'pl-bd' }, h('span', { class: 'pl-bchip good' }, h('span', { class: 'arw' }, '▼'), 'only with extra (추가 상환 덕분)'))
        : bchip(bd.p.months - bd.none.months, false, Math.abs(bd.p.months - bd.none.months) + ' mo', 'vs minimum only (최소 납입만 대비)');
    }
    const df = bm('bn-debtfree', 'Debt-free', '부채 완납 예상', dv, dd);
    bannerHost.replaceChildren(h('div', { class: 'banner-in' },
      h('div', { class: 'banner-row' }, h('div', { class: 'acct-pick' }, h('span', { class: 'nm' }, 'Plan (계획)')), h('div', { class: 'asof' }, 'As of ', h('b', null, L.monthLabel(state.month)))),
      h('div', { class: 'pl-bms' }, net, sv, df)));
  }
  function paintSeg() {
    seg.replaceChildren(...TABS.map(([k, en, ko]) => h('button', { type: 'button', role: 'tab', id: 'pl-tab-' + k, class: tab === k ? 'on' : '', 'aria-selected': String(tab === k), onclick: () => { tab = k; show(); } }, en, h('span', { class: 'ko' }, ko))));
  }
  function show() {
    paintSeg();
    let el;
    try { el = tab === 'fc' ? buildFc() : tab === 'ny' ? buildNy() : buildDebt(); } catch (e) {
      console.error(e);
      el = h('div', { class: 'card warn-card', role: 'alert' }, '이 구역을 그리는 중 오류가 났어요: ' + (e && e.message ? e.message : e));
    }
    body.replaceChildren(el);
    paintBanner();
  }
  page.append(seg, body);
  root.append(bannerHost, page);
  show();
  return root;
}
