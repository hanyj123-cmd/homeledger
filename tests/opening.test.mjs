// 기초잔액(마이너스 포함) 저장·다시 열기·잔액 계산 테스트.  실행: node tests/opening.test.mjs
import * as L from '../js/ledger.js';
import * as A from '../js/activity.js';

let n = 0;
const eq = (a, b, m) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', m, '\n  got ', JSON.stringify(a), '\n  want', JSON.stringify(b)); process.exit(1); } };
const acc = (id, name, type, extra) => Object.assign({ account_id: id, name, type, is_active: true, deleted: false, currency: 'CAD' }, extra || {});
const accounts = [acc('1010', 'TD Chequing', 'ASSET', { subtype: 'CHEQUING' }), acc('2010', 'Visa', 'LIABILITY', { subtype: 'CREDIT_CARD' }), acc('3010', 'Opening Balance Equity', 'EQUITY')];
const accMap = new Map(accounts.map((a) => [a.account_id, a]));
const mk = (form, existing) => L.makeRecords(L.newForm(Object.assign({ kind: 'OPENING', date: '2026-01-01', currency: 'CAD' }, form)), { accMap, existing: existing || null, now: '2026-10-21T00:00:00.000Z' });
const balances = (r) => L.accountBalances(accounts, r.postings.filter((p) => !L.truthy(p.deleted)));
const reopen = (r) => L.formFromTxn(r.txn, r.postings, accMap);

// 양수 기초잔액은 예전과 같다
let r = mk({ accountId: '1010', amountText: '1200.50' });
eq(r.error, undefined, 'positive asset ok');
eq(balances(r).get('1010'), 1200.5, 'asset +1200.50'); eq(r.txn.total_cad, 1200.5, 'total positive');
r = mk({ accountId: '2010', amountText: '300' });
eq(balances(r).get('2010'), 300, 'liability owed 300 stays positive');

// 마이너스 체킹 (자산)
r = mk({ accountId: '1010', amountText: '-150.25' });
eq(r.error, undefined, 'negative asset ok');
eq(balances(r).get('1010'), -150.25, 'overdrawn chequing -150.25');
eq(r.postings.reduce((s, p) => s + p.amount_cad, 0), 0, 'postings balance to zero');
eq([r.txn.total_cad, r.txn.total_orig], [-150.25, -150.25], 'signed totals stored');
eq(r.txn.status, 'MATCHED', 'opening is matched');

// 마이너스 카드 (초과 상환 = 돌려받을 돈)
r = mk({ accountId: '2010', amountText: '-40' });
eq(balances(r).get('2010'), -40, 'overpaid card shows -40 owed');
eq(r.postings.reduce((s, p) => s + p.amount_cad, 0), 0, 'liability postings balance');

// 계산식으로 입력해도 된다
eq(balances(mk({ accountId: '1010', amountText: '-(100+50.5)' })).get('1010'), -150.5, 'expression with leading minus');

// 다시 열어도 부호가 유지되고, 그대로 저장하면 같은 결과
r = mk({ accountId: '1010', amountText: '-150.25' });
const f = reopen(r);
eq([f.kind, f.accountId, f.amountText], ['OPENING', '1010', '-150.25'], 'reopen keeps sign');
const again = mk(f, { txn: r.txn, ps: r.postings, desc: null });
eq(again.error, undefined, 're-save ok');
eq(balances(again).get('1010'), -150.25, 're-save keeps negative');
eq(again.postings.filter((p) => !L.truthy(p.deleted)).length, 2, 're-save reuses two postings');
// 마이너스에서 플러스로 고치기
const flipped = mk(Object.assign({}, f, { amountText: '75' }), { txn: r.txn, ps: r.postings, desc: null });
eq(balances(flipped).get('1010'), 75, 'edit negative to positive');

// 0 · 빈칸 · 글자는 거절
eq(typeof mk({ accountId: '1010', amountText: '0' }).error, 'string', 'zero rejected');
eq(typeof mk({ accountId: '1010', amountText: '' }).error, 'string', 'blank rejected');
eq(typeof mk({ accountId: '1010', amountText: 'abc' }).error, 'string', 'text rejected');

// 다른 거래 종류는 여전히 마이너스를 받지 않는다
for (const kind of ['EXPENSE', 'INCOME', 'TRANSFER']) eq(typeof mk({ kind, amountText: '-5', fromId: '1010', toId: '2010', categoryId: '9999' }).error, 'string', kind + ' still rejects negative');

// 외화 마이너스 기초잔액: CAD 청구액은 크기로 입력해도 된다
r = mk({ accountId: '1010', amountText: '-100', currency: 'USD', cadText: '135' });
eq(r.error, undefined, 'fx negative ok');
eq([r.txn.total_orig, r.txn.total_cad, r.txn.fx_rate], [-100, -135, 1.35], 'fx totals signed, rate positive');
eq(balances(r).get('1010'), -135, 'fx balance in CAD negative');

// 전체 거래 목록: 마이너스 기초잔액은 − 로 표시
const item = (res) => ({ txn: res.txn, ps: res.postings, desc: L.describeTxn(res.txn, res.postings, accMap) });
eq(A.columnsOf(item(mk({ accountId: '1010', amountText: '-150.25' })), null), { move: -150.25 }, 'all-accounts view shows minus');
eq(A.columnsOf(item(mk({ accountId: '1010', amountText: '150.25' })), null), { move: 150.25 }, 'positive unchanged');
// 계좌별 목록: 마이너스는 출금 칸 (분개로 계산)
eq(A.columnsOf(item(mk({ accountId: '1010', amountText: '-150.25' })), accMap.get('1010')), { out: 150.25 }, 'account view puts it in withdrawals');

console.log('opening tests passed (' + n + ' checks)');
