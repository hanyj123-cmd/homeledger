// 쉬운 예측: 올해 평균 → 이번 달 · 다음 달 · 남은 달 ± 조정.  실행: node tests/easy-forecast.test.mjs
const L = await import('../js/ledger.js');
const YP = await import('../js/yearplan.js');

let n = 0;
const eq = (a, b, m) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', m, '\n  got ', JSON.stringify(a), '\n  want', JSON.stringify(b)); process.exit(1); } };
const acc = (id, name, type, group) => ({ account_id: id, name, type, report_group: group || '', is_active: true, deleted: false, currency: 'CAD' });
const accounts = [acc('1010', 'Chequing', 'ASSET'), acc('4010', 'Salary', 'INCOME', '수입'), acc('5110', 'Groceries', 'EXPENSE', 'semi-고정비'), acc('5010', 'Mortgage', 'EXPENSE', '고정비')];
const accMap = new Map(accounts.map((a) => [a.account_id, a]));
let seq = 0;
const tx = (date, cat, amt, inc) => {
  const id = 't' + (++seq);
  const ps = inc ? [{ txn_id: id, account_id: '1010', amount_cad: amt }, { txn_id: id, account_id: cat, amount_cad: -amt }]
    : [{ txn_id: id, account_id: cat, amount_cad: amt }, { txn_id: id, account_id: '1010', amount_cad: -amt }];
  const t = { txn_id: id, date, currency: 'CAD', total_cad: amt };
  return { txn: t, ps, desc: L.describeTxn(t, ps, accMap) };
};
const items = [];
// Jan–Oct 2026: salary 8000, groceries 600/800 alternating, mortgage 2864
for (let m = 1; m <= 10; m++) {
  const ym = '2026-' + String(m).padStart(2, '0');
  items.push(tx(ym + '-15', '4010', 8000, true), tx(ym + '-10', '5110', m % 2 ? 600 : 800), tx(ym + '-01', '5010', 2864));
}
// Nov so far: groceries 750 already
items.push(tx('2026-11-05', '5110', 750));
const m = YP.easyForecast({ items, accMap, plan: { cells: {} }, today: '2026-11-08' });
eq([m.curYm, m.nextYm, m.rest], ['2026-11', '2026-12', []], 'months: Nov now, Dec next, nothing after in 2026');
eq(m.trend.length, 10, 'average uses Jan–Oct');
eq(m.basisNote, 'year', 'basis = this year');
const g = m.lines.find((l) => l.id === '5110'), s = m.lines.find((l) => l.id === '4010');
eq(g.avg, 700, 'groceries average 700');
eq(s.avg, 8000, 'salary average 8000');
eq(g.cur.value, 750, 'this month never below what is already spent (750 > avg 700)');
eq(g.next.value, 700, 'next month starts at the average');
eq(g.step, 50, 'step ≈ 5% of 700 → 50');
eq(m.lines[0].type, 'INCOME', 'income listed first');

// ± 조정 저장 → 다시 읽으면 반영
const plan = YP.applyEasyEdits({ cells: {} }, m, new Map([['next|5110', 650], ['cur|4010', 8500]]));
eq(plan.cells['2026-12']['5110'], 650, 'next month saved in Dec cell');
const m2 = YP.easyForecast({ items, accMap, plan, today: '2026-11-08' });
eq(m2.lines.find((l) => l.id === '5110').next.value, 650, 'next month uses my number');
eq(m2.totals.cur.income, 8500, 'this month income uses my number');
// 평균으로 되돌리기
const plan2 = YP.applyEasyEdits(plan, m2, new Map([['next|5110', null]]));
eq(plan2.cells['2026-12'], undefined, 'reset removes the cell');

// 남은 달: 9월 기준이면 Nov, Dec 가 남은 달 — 한 값으로 둘 다
const m3 = YP.easyForecast({ items: items.filter((it) => it.txn.date < '2026-09'), accMap, plan: { cells: {} }, today: '2026-09-20' });
eq(m3.rest, ['2026-11', '2026-12'], 'rest months after next');
const p3 = YP.applyEasyEdits({ cells: {} }, m3, new Map([['rest|5110', 900]]));
eq([p3.cells['2026-11']['5110'], p3.cells['2026-12']['5110']], [900, 900], 'rest value written to every remaining month');
// 연말 합계 = 지난 달 실제 + 이번 + 다음 + 남은 달
const y = m.totals.year;
eq(y.income, 8000 * 10 + 8000 + 8000, 'year income = Jan–Oct actual + Nov + Dec');
// 12월 기준: 다음 달은 내년 1월, 올해 합계에는 안 들어감
const m4 = YP.easyForecast({ items, accMap, plan: { cells: {} }, today: '2026-12-03' });
eq(m4.nextYm, '2027-01', 'December → next is January');
eq(YP.niceStep(8000), 500, 'salary step 500');
console.log('easy-forecast tests passed (' + n + ' checks)');
