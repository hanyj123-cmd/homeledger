// 거래 탭의 소유자 칩: 누구 몫인지 표시 · 한 건 바꾸기.  실행: node tests/owner-quick.test.mjs
globalThis.__HL_TEST__ = true;
const L = await import('../js/ledger.js');
const B = await import('../js/bulk.js');

let n = 0;
const eq = (a, b, m) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', m, '\n  got ', JSON.stringify(a), '\n  want', JSON.stringify(b)); process.exit(1); } };
const acc = (id, name, type) => ({ account_id: id, name, type, is_active: true, deleted: false, currency: 'CAD' });
const accounts = [acc('1010', 'Chequing', 'ASSET'), acc('5110', 'Groceries', 'EXPENSE'), acc('5210', 'Dining', 'EXPENSE')];
const accMap = new Map(accounts.map((a) => [a.account_id, a]));
const mk = (owner, lines) => {
  const ps = lines.map(([a, v, o], i) => ({ posting_id: 'p' + i, txn_id: 't1', account_id: a, amount_cad: v, owner: o || '' }));
  const txn = { txn_id: 't1', date: '2026-10-03', owner, merchant: 'Costco', total_cad: 50, currency: 'CAD', status: 'MATCHED' };
  return { txn, ps, desc: L.describeTxn(txn, ps, accMap) };
};

eq(B.ownerOfItem(mk('Patrick', [['5110', 50], ['1010', -50]])), 'Patrick', 'simple txn uses txn owner');
eq(B.ownerOfItem(mk('', [['5110', 50], ['1010', -50]])), 'Joint', 'blank owner is Joint');
eq(B.ownerOfItem(mk('Joint', [['5110', 30, 'Patrick'], ['5210', 20, 'Ms Kim'], ['1010', -50]])), 'MIXED', 'split with two owners is MIXED');
eq(B.ownerOfItem(mk('Joint', [['5110', 30, 'Ms Kim'], ['5210', 20, 'Ms Kim'], ['1010', -50]])), 'Ms Kim', 'split with one owner shows that owner');

// 한 건 바꾸기: 거래 소유자가 바뀌고 줄 소유자는 비워져 거래 소유자를 따름
const it = mk('Joint', [['5110', 50, 'Joint'], ['1010', -50]]);
const plan = B.planBulk([it], ['t1'], { owner: 'Patrick' }, accMap, '2026-11-08T00:00:00Z', { lineItems: [] });
eq(plan.changed, 1, 'one txn changed');
const { puts } = B.batchOf(plan, [], false);
eq((puts.Transactions || []).map((t) => t.owner), ['Patrick'], 'txn owner saved');
eq((puts.Postings || []).every((p) => !p.owner), true, 'line owners cleared');
console.log('owner-quick tests passed (' + n + ' checks)');
