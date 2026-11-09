// 사람별 보고서의 금액 = 그 금액을 눌러 여는 거래 목록의 합계.  실행: node tests/who-drill.test.mjs
globalThis.__HL_TEST__ = true;
const L = await import('../js/ledger.js');
const R = await import('../js/reports.js');
const D = await import('../js/drill.js');

let n = 0;
const eq = (a, b, m) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', m, '\n  got ', JSON.stringify(a), '\n  want', JSON.stringify(b)); process.exit(1); } };
const acc = (id, name, type) => ({ account_id: id, name, type, is_active: true, deleted: false, currency: 'CAD' });
const accounts = [acc('1010', 'Chequing', 'ASSET'), acc('4010', 'Salary', 'INCOME'), acc('5110', 'Groceries', 'EXPENSE'), acc('5210', 'Dining', 'EXPENSE')];
const accMap = new Map(accounts.map((a) => [a.account_id, a]));
let seq = 0;
const txn = (date, owner, merchant, lines) => {
  const id = 't' + (++seq);
  const ps = lines.map(([acct, amt, pOwner], i) => ({ posting_id: id + '-' + i, txn_id: id, account_id: acct, amount_cad: amt, owner: pOwner || '' }));
  const t = { txn_id: id, date, owner, merchant, total_cad: 0, currency: 'CAD' };
  return { txn: t, ps, desc: L.describeTxn(t, ps, accMap) };
};
const items = [
  txn('2026-10-03', 'Patrick', 'Costco', [['5110', 120.5], ['1010', -120.5]]),
  txn('2026-10-05', 'Ms Kim', 'Costco', [['5110', 80], ['1010', -80]]),
  // 나눈 거래: 한 줄은 Patrick, 한 줄은 Ms Kim — 금액 검색으로는 절대 맞출 수 없는 경우
  txn('2026-10-07', 'Joint', 'Galleria', [['5110', 40.25, 'Patrick'], ['5210', 30, 'Ms Kim'], ['1010', -70.25]]),
  txn('2026-10-15', 'Patrick', 'Payroll', [['1010', 4180.42], ['4010', -4180.42]]),
  txn('2026-09-28', 'Patrick', 'Costco (last month)', [['5110', 999], ['1010', -999]]),
  // 메모·가게 이름에 사람 이름이 들어 있어도 섞이면 안 된다
  txn('2026-10-20', 'Ms Kim', 'Gift for Patrick', [['5210', 55], ['1010', -55]])
];
const months = ['2026-10'];
const rows = R.ownerTotals(items, accMap, months);
const state = { d: { items, accMap } };
const incIds = ['4010'], expIds = ['5110', '5210'];
const total = (spec) => L.round(D.gather(state, spec).reduce((s, r) => s + r.v, 0), 2);
const count = (spec) => D.gather(state, spec).length;

rows.forEach((r) => {
  eq(total({ ids: expIds, months, mode: 'exp', owner: r.owner }), r.expense, r.owner + ' spending matches');
  eq(total({ ids: incIds, months, mode: 'inc', owner: r.owner }), r.income, r.owner + ' income matches');
  eq(total({ ids: incIds.concat(expIds), months, mode: 'inc', owner: r.owner }), r.net, r.owner + ' net matches');
});
const pat = rows.find((r) => r.owner === 'Patrick');
eq(pat.expense, 160.75, 'Patrick spending = 120.50 + 40.25 split line');
eq(count({ ids: expIds, months, mode: 'exp', owner: 'Patrick' }), 2, 'Patrick spending: 2 transactions (no last month, no "Gift for Patrick")');
eq(count({ ids: expIds, months, mode: 'exp', owner: 'Ms Kim' }), 3, 'Ms Kim spending: Costco, her split line, gift');
// owner 없으면 예전과 같다
eq(total({ ids: expIds, months, mode: 'exp' }), 325.75, 'no owner filter = everyone');
console.log('who-drill tests passed (' + n + ' checks)');
