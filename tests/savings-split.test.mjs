// 저축률: 회사 매칭 포함 / 통장 기준.  실행: node tests/savings-split.test.mjs
const L = await import('../js/ledger.js');
const R = await import('../js/reports.js');
let n = 0;
const eq = (a, b, m) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', m, '\n  got ', JSON.stringify(a), '\n  want', JSON.stringify(b)); process.exit(1); } };
const acc = (id, name, type, extra) => Object.assign({ account_id: id, name, type, is_active: true, deleted: false, currency: 'CAD' }, extra || {});
const accounts = [acc('1010', 'Chequing', 'ASSET'), acc('1210', 'EOP account', 'ASSET', { subtype: 'INVESTMENT' }), acc('4010', 'Salary', 'INCOME'),
  acc('4040', 'TD EOP', 'INCOME'), acc('5110', 'Groceries', 'EXPENSE')];
const accMap = new Map(accounts.map((a) => [a.account_id, a]));
let k = 0;
const tx = (cat, money, amt, inc) => { const id = 't' + (++k); const ps = inc ? [{ txn_id: id, account_id: money, amount_cad: amt }, { txn_id: id, account_id: cat, amount_cad: -amt }] : [{ txn_id: id, account_id: cat, amount_cad: amt }, { txn_id: id, account_id: money, amount_cad: -amt }]; const t = { txn_id: id, date: '2026-10-15', currency: 'CAD' }; return { txn: t, ps, desc: L.describeTxn(t, ps, accMap) }; };
const items = [tx('4010', '1010', 8000, true), tx('4040', '1210', 600, true), tx('5110', '1010', 5000, false)];
const stmt = R.incomeStatement(items, accMap, '2026-10');
// 설정의 급여일 연동 항목이 4040 을 가리킴
const settings = [{ key: 'meta.paybundle', value: JSON.stringify({ enabled: true, items: [{ key: 'td_eop', label: 'TD EOP', incomeId: '4040', assetId: '1210', on: true }] }) }];
const ids = R.employerIncomeIds(settings, accMap);
eq(ids.has('4040'), true, 'pay-day item counted as employer money');
const sv = R.savingsSplit(stmt, ids);
eq(sv, { employer: 600, total: 41.9, cash: 37.5 }, 'incl. match 41.9%, cash only 37.5%');
// 설정이 없어도 이름(매칭 · 연금 · EOP)으로 찾음
accMap.set('4050', acc('4050', 'DC Pension match', 'INCOME'));
eq(R.employerIncomeIds([], accMap).has('4050') && R.employerIncomeIds([], accMap).has('4040'), true, 'found by name');
eq(R.employerIncomeIds([], accMap).has('4010'), false, 'salary is not employer match');
// 매칭이 없으면 두 값이 같음
const s2 = R.savingsSplit(R.incomeStatement(items.filter((it) => it.ps[1].account_id !== '4040'), accMap, '2026-10'), ids);
eq([s2.employer, s2.total === s2.cash], [0, true], 'no match → same');
console.log('savings-split tests passed (' + n + ' checks)');
