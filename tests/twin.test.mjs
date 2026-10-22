import * as R from '../js/receipts.js';
let n = 0, bad = 0;
const ok = (c, m) => { n++; if (!c) { bad++; console.log('FAIL', m); } };
const acc = (id, type) => ({ account_id: id, name: id, type, is_active: true, currency: 'CAD' });
const accMap = new Map([['2010', acc('2010', 'LIABILITY')], ['5010', acc('5010', 'EXPENSE')], ['9999', acc('9999', 'EXPENSE')]]);
const P = (id, t, a, c) => ({ posting_id: id, txn_id: t, account_id: a, amount_cad: c, deleted: false });
const rec = { txn: { txn_id: 'r', date: '2026-09-10', receipt_id: 'rc', statement_line_id: '', deleted: false, merchant: 'Costco Wholesale', source: 'RECEIPT' }, ps: [P('a', 'r', '5010', 203.78), P('b', 'r', '2010', -203.78)] };
const stm = { txn: { txn_id: 's', date: '2026-09-11', posted_date: '2026-09-11', receipt_id: '', statement_line_id: 'sl1', deleted: false, merchant: 'COSTCO WHOLESALE W524', source: 'STATEMENT' }, ps: [P('c', 's', '9999', 203.78), P('d', 's', '2010', -203.78)] };
const items = [rec, stm];
ok(R.findTwin(items, rec, accMap).length === 1 && R.findTwin(items, stm, accMap).length === 1, 'both directions');
ok(R.findTwin([rec, { ...stm, txn: { ...stm.txn, date: '2026-09-30' } }], rec, accMap).length === 0, 'far date');
ok(R.findTwin([rec, { ...stm, ps: [P('c', 's', '9999', 203.79), P('d', 's', '2010', -203.79)] }], rec, accMap).length === 0, 'amount differs');
const m = R.mergeTwins(rec, stm, [{ stmt_line_id: 'sl1', matched_txn_id: 's', deleted: false }], 'now');
ok(m.Transactions[0].txn_id === 'r' && m.Transactions[0].statement_line_id === 'sl1' && m.Transactions[0].posted_date === '2026-09-11', 'kept gets stmt link');
ok(m.Transactions[1].txn_id === 's' && m.Transactions[1].deleted === true, 'stmt txn deleted');
ok(m.Postings.length === 2 && m.Postings.every((p) => p.deleted && p.txn_id === 's'), 'stmt postings deleted');
ok(m.StatementLines[0].matched_txn_id === 'r', 'stmt line repointed');
ok(R.findTwin([{ ...rec, txn: { ...rec.txn, statement_line_id: 'sl1' } }, stm], stm, accMap).length === 0, 'already linked → no twin');
// 나눈 거래(카테고리 3줄)도 카드 쪽 합계로 같은 거래를 찾아야 함
{
  const acc2 = new Map([['2010', acc('2010', 'LIABILITY')], ['5010', acc('5010', 'EXPENSE')], ['5020', acc('5020', 'EXPENSE')], ['5030', acc('5030', 'EXPENSE')], ['9999', acc('9999', 'EXPENSE')]]);
  const sp = { txn: { ...rec.txn, txn_id: 'r2' }, ps: [P('a', 'r2', '5010', 100), P('a2', 'r2', '5020', 60.5), P('a3', 'r2', '5030', 43.28), P('b', 'r2', '2010', -203.78)] };
  ok(R.findTwin([sp, stm], sp, acc2).length === 1 && R.findTwin([sp, stm], stm, acc2).length === 1, 'split receipt twin');
  const m2 = R.mergeTwins(sp, stm, [], 'now');
  ok(m2.Transactions[0].txn_id === 'r2' && m2.Postings.length === 2, 'split kept intact');
}
console.log(n - bad + '/' + n + ' ok'); process.exit(bad ? 1 : 0);
