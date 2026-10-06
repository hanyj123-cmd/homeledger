// 요약 화면의 "텍스트 버전" (순수 함수 · DOM 없음). 클립보드 복사와 테스트에서 씁니다.
// 입력은 insights.analyze() 결과(ctx)와 메모 등 — 숫자는 모두 화면과 같은 곳에서 온 것입니다.
import * as L from './ledger.js';

export const money0 = (n) => (n < 0 ? '−' : '') + '$' + Math.round(Math.abs(Number(n) || 0)).toLocaleString('en-US');
/** 소수 첫째 자리까지 (48.2777 → 48.3) */
export const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
export const TONE_KO = { bad: '조치 필요', warn: '주의', info: '참고', good: '좋음' };
export const TONE_EN = { bad: 'Act now', warn: 'Watch', info: 'Tip', good: 'Good' };

/** '2026-10' → '2026년 10월' */
export const monthKo = (ym) => ym.slice(0, 4) + '년 ' + Number(ym.slice(5, 7)) + '월';

/** ▲ $120 / ▼ $80 / 변동 없음 */
export function deltaText(d, f) {
  const fm = f || money0;
  if (!Number.isFinite(d) || Math.abs(d) < 0.5) return '변동 없음';
  return (d > 0 ? '▲ ' : '▼ ') + fm(Math.abs(d));
}

/** 건강 점수 항목의 값 표시 */
export function partValue(p) {
  if (p.unit === '%') return r1(p.value) + '%';
  if (p.unit === 'months') return r1(p.value) + '개월';
  if (p.unit === 'months of income') return '월 수입의 ' + r1(p.value) + '배';
  return p.value + (p.unit ? ' ' + p.unit : '');
}

/** 한 달 요약 텍스트 (한국어). o = { ctx, ym, note, owners, vendors, ai, today } */
export function buildSummaryText(o) {
  const { ctx, ym } = o;
  const out = [];
  const cur = ctx.cur, prev = ctx.prev;
  const hasPrev = prev && (prev.income || prev.expense);
  out.push('우리집 가계부 요약 — ' + monthKo(ym));
  out.push('');
  out.push('[핵심 요약]');
  out.push(ctx.headline);
  const nwD = ctx.bs.net - ctx.bsPrev.net;
  out.push('- 순자산 ' + money0(ctx.bs.net) + ' (지난달 대비 ' + deltaText(nwD) + ')');
  out.push('- 수입 ' + money0(cur.income) + (hasPrev ? ' (' + deltaText(cur.income - prev.income) + ')' : '')
    + ' · 지출 ' + money0(cur.expense) + (hasPrev ? ' (' + deltaText(cur.expense - prev.expense) + ')' : '')
    + ' · 순수입 ' + money0(cur.net));
  if (cur.rate !== null && cur.rate !== undefined) out.push('- 저축률 ' + r1(cur.rate) + '%' + (hasPrev && prev.rate !== null ? ' (지난달 ' + r1(prev.rate) + '%)' : ''));
  out.push('- 자산 ' + money0(ctx.pos.totalAssets) + ' · 부채 ' + money0(ctx.pos.totalDebt) + ' · 현금 ' + money0(ctx.pos.cash));
  const hs = ctx.health;
  if (hs && hs.total !== null) {
    out.push('- 재무 건강 ' + hs.total + '점 (' + hs.grade + ') — ' + hs.label);
    hs.parts.forEach((p) => out.push('    · ' + p.label + ' ' + partValue(p) + ' (목표 ' + p.goal + ') [' + TONE_KO[p.tone] + ']'));
  }

  // 지출 구성
  const grp = [['고정비', cur.fixed], ['준고정비', cur.semi], ['유흥비', cur.fun], ['금융비', cur.fin]];
  if (cur.review > 0) grp.push(['확인 필요', cur.review]);
  if (cur.expense > 0) {
    out.push('');
    out.push('[지출 구성]');
    out.push(grp.filter((g) => g[1] > 0).map((g) => g[0] + ' ' + money0(g[1]) + ' (' + Math.round(g[1] / cur.expense * 100) + '%)').join(' · '));
    const top = [];
    ctx.cmp.groups.forEach((g) => g.lines.forEach((l) => { if (l.cur > 0) top.push(l); }));
    top.sort((a, b) => b.cur - a.cur);
    if (top.length) out.push('상위: ' + top.slice(0, 5).map((l) => l.name + ' ' + money0(l.cur) + (l.budget > 0 ? ' (예산 ' + money0(l.budget) + ')' : '')).join(' · '));
  }

  // 전망
  const fc = ctx.fc;
  if (fc) {
    out.push('');
    out.push(fc.done ? '[월 결과]' : '[이번 달 전망]');
    if (fc.done) out.push('지출 ' + money0(fc.actualExpense) + ' · 수입 ' + money0(fc.actualIncome) + ' · 남은 돈 ' + money0(fc.actualIncome - fc.actualExpense));
    else {
      out.push('지금까지 지출 ' + money0(fc.actualExpense) + ' (' + fc.day + '일째 / ' + fc.dim + '일)');
      out.push('월말 예상: 지출 ' + money0(fc.projExpense) + ' · 수입 ' + money0(fc.projIncome) + ' · ' + (fc.projNet >= 0 ? '남는 돈 ' : '부족 ') + money0(Math.abs(fc.projNet)));
    }
    const bc = ctx.budgetCmp;
    if (bc && bc.hasBudget) out.push('예산 사용 ' + (bc.pct === null ? '' : bc.pct + '% ') + '(' + money0(bc.totalActual) + ' / ' + money0(bc.totalBudget) + ')');
  }

  // 조언
  if (ctx.tips && ctx.tips.length) {
    out.push('');
    out.push('[조언]');
    ctx.tips.forEach((t, i) => out.push((i + 1) + '. [' + TONE_KO[t.tone] + '] ' + t.title + ' — ' + t.body + (t.action ? ' → ' + t.action : '')));
  }

  // 정기 결제 · 상위 업체 · 사람별
  if (ctx.subs && ctx.subs.length) {
    const m = ctx.subs.reduce((s, x) => s + x.monthly, 0);
    out.push('');
    out.push('[정기 결제] 매달 ' + money0(m) + ' (연 ' + money0(m * 12) + ')');
    out.push(ctx.subs.slice(0, 8).map((s) => s.name + ' ' + money0(s.monthly)).join(' · '));
  }
  if (o.vendors && o.vendors.length) {
    out.push('');
    out.push('[상위 업체]');
    out.push(o.vendors.slice(0, 8).map((v) => v.name + ' ' + money0(v.total)).join(' · '));
  }
  if (o.owners && o.owners.length > 1) {
    out.push('');
    out.push('[사람별]');
    o.owners.forEach((w) => out.push(w.owner + ': 수입 ' + money0(w.income) + ' · 지출 ' + money0(w.expense) + ' · 순 ' + money0(w.net)));
  }

  // AI 브리핑 (화면에 있을 때만)
  const a = o.ai;
  if (a && (a.headline || (a.actions && a.actions.length))) {
    out.push('');
    out.push('[AI 브리핑]');
    if (a.headline) out.push(a.headline);
    (a.actions || []).slice(0, 5).forEach((x, i) => out.push((i + 1) + '. ' + x.title + (x.impact ? ' (' + x.impact + ')' : '')));
    if (a.caveat) out.push('* ' + a.caveat);
  }

  // 월 메모
  const note = String(o.note || '').trim();
  if (note) {
    out.push('');
    out.push('[월 메모]');
    out.push(note);
  }
  out.push('');
  out.push('— Home Ledger · ' + (o.today || L.todayStr()) + ' 기준');
  return out.join('\n');
}
