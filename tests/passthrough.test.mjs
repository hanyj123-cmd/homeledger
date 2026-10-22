import * as L from '../js/ledger.js';
import * as R from '../js/receipts.js';
import * as G from '../js/categorize.js';
import * as S from '../js/sysaccounts.js';
import { CONFIG } from '../js/config.js';
let n = 0, bad = 0;
const ok = (c, m) => { n++; if (!c) { bad++; console.log('FAIL', m); } };
const acc = (id, type, extra) => ({ account_id: id, name: id, type, is_active: true, currency: 'CAD', ...(extra || {}) });
const accounts = [acc('1010', 'ASSET', { subtype: 'CHEQUING', name: 'TD Chequing' }), acc('2010', 'LIABILITY', { subtype: 'CREDIT_CARD' }), acc('2900', 'LIABILITY', { subtype: 'CLEARING', name: 'Passthrough Clearing', sort_order: 2900 }),
  acc('5010', 'EXPENSE', { report_group: '고정비' }), acc('3010', 'EQUITY')];
// 시스템 계정 자동 생성
let miss = S.missingSystemAccounts(accounts, 'now');
ok(miss.length === 2, 'church + cash missing: ' + miss.length);
const ch = miss.find((a) => a.account_id === '2901');
ok(ch && ch.type === 'LIABILITY' && ch.subtype === 'CLEARING' && /Church/.test(ch.name), 'church clearing cloned from 2900');
const cash = miss.find((a) => a.subtype === 'CASH');
ok(cash && cash.type === 'ASSET' && cash.account_id === '1090' && cash.name_ko === '현금', 'cash account');
ok(S.missingSystemAccounts(accounts.concat(miss), 'now').length === 0, 'idempotent');
ok(S.missingSystemAccounts([], 'now').length === 0, 'empty list → nothing');
ok(S.missingSystemAccounts(accounts.concat([acc('1050', 'ASSET', { name: 'Cash' })]), 'now').filter((a) => a.subtype === 'CASH').length === 0, 'existing cash-like account respected');
const all = accounts.concat(miss);
const accMap = new Map(all.map((a) => [a.account_id, a]));
ok(!L.isMoneyAccount(accMap.get('2901')), 'church clearing is not a money account');
// 일반 거래: 교회 / 개인 전달 자금
const base = { kind: 'EXPENSE', date: '2026-10-20', amountText: '50', ccy: 'CAD', fromId: '1010', passthrough: true, owner: 'Patrick', merchant: 'Gift', memo: '' };
const mk = (o) => L.makeRecords({ ...L.newForm(), ...base, ...o }, { accMap, rules: [], existing: null, now: 'n' });
let r = mk({ passKind: 'CHURCH' });
ok(!r.error && r.postings.some((p) => p.account_id === '2901') && !r.postings.some((p) => p.account_id === '2900') && r.txn.is_passthrough, 'church → 2901 ' + (r.error || ''));
let d = L.describeTxn(r.txn, r.postings, accMap);
ok(d.kind === 'PASSTHROUGH' && d.passKind === 'CHURCH' && /교회/.test(d.categoryName), 'describe church');
r = mk({ passKind: 'PERSONAL' });
ok(r.postings.some((p) => p.account_id === '2900') && r.txn.owner === 'Patrick', 'personal → 2900 + owner');
d = L.describeTxn(r.txn, r.postings, accMap);
ok(d.passKind === 'PERSONAL', 'describe personal');
const f = L.formFromTxn(mk({ passKind: 'CHURCH' }).txn, mk({ passKind: 'CHURCH' }).postings, accMap);
ok(f.passthrough && f.passKind === 'CHURCH' && f.kind === 'EXPENSE', 'form roundtrip church');
// 영수증: 환불 / 전달 자금
const draft = (o) => ({ merchant: 'Store', date: '2026-10-20', currency: 'CAD', totalText: '60.00', taxText: '0', tipText: '', fromId: '2010', owner: 'Joint', meta: null,
  items: [R.newItem({ name: 'a', amountText: '40', category_id: '5010', tax_code: 'NONE', owner: 'Patrick' }), R.newItem({ name: 'b', amountText: '20', category_id: '5010', tax_code: 'NONE' })], ...(o || {}) });
const ctx = { accMap, taxCodes: [], rules: [], existing: null, now: 'n' };
let rr = R.makeReceiptRecords(draft({ refund: true }), ctx);
let live = rr.postings.filter((p) => !p.deleted);
ok(!rr.error && live.find((p) => p.account_id === '2010').amount_cad === 60 && live.filter((p) => p.account_id === '5010').every((p) => p.amount_cad < 0), 'refund flips signs');
ok(Math.abs(live.reduce((s, p) => s + p.amount_cad, 0)) < 0.005, 'refund balanced');
ok(rr.txn.total_cad === 60, 'refund total stays positive');
let back = R.draftFromExisting(rr.txn, { accMap, postings: rr.postings, lineItems: rr.lineItems, receipt: null });
ok(back.refund === true && back.pass === '', 'refund roundtrip');
rr = R.makeReceiptRecords(draft({ pass: 'PERSONAL' }), ctx);
live = rr.postings.filter((p) => !p.deleted);
ok(!rr.error && live.filter((p) => p.account_id === '2900').length === 2 && !live.some((p) => p.account_id === '5010'), 'personal passthrough receipt: per-owner clearing postings: ' + (rr.error || live.length));
ok(live.filter((p) => p.account_id === '2900').map((p) => p.owner || 'Joint').sort().join() === 'Joint,Patrick', 'owners kept per item');
ok(rr.txn.is_passthrough === true && rr.lineItems.every((l) => l.category_account_id === '2900'), 'txn flagged + items in clearing');
ok(rr.rule === null, 'no rule learned for passthrough');
back = R.draftFromExisting(rr.txn, { accMap, postings: rr.postings, lineItems: rr.lineItems, receipt: null });
ok(back.pass === 'PERSONAL' && back.refund === false, 'passthrough roundtrip');
rr = R.makeReceiptRecords(draft({ pass: 'CHURCH', refund: true }), ctx);
live = rr.postings.filter((p) => !p.deleted);
ok(live.every((p) => p.account_id === '2010' || p.account_id === '2901') && live.find((p) => p.account_id === '2010').amount_cad === 60, 'church refund');
ok(R.makeReceiptRecords(draft({ pass: 'CHURCH' }), { ...ctx, accMap: new Map(accounts.map((a) => [a.account_id, a])) }).error, 'missing church account → clear error');
// 환불 영수증은 들어온 돈 줄과 맞춤
const stm = { txn: { txn_id: 's', date: '2026-10-20', statement_line_id: 'x', receipt_id: '', deleted: false }, ps: [{ account_id: '2010', amount_cad: 60 }] };
ok(R.findStatementMatches([stm], { fromId: '2010', totalCad: 60, date: '2026-10-20', merchant: 'Store', refund: true }).length === 1 && R.findStatementMatches([stm], { fromId: '2010', totalCad: 60, date: '2026-10-20', merchant: 'Store' }).length === 0, 'refund matches money-in statement line only');
// ATM → 현금
const guess = G.makeGuesser({ rules: [], items: [], accounts: all, accMap, statementAccountId: '1010' });
const g = guess('ATM WITHDRAWAL TD 1234', 'out');
ok(g && g.accountId === '1090', 'ATM withdrawal → cash: ' + JSON.stringify(g));
ok(!guess('ATM DEPOSIT', 'in'), 'deposit not guessed');
ok(guess('CASH ADVANCE FEE', 'out') === null || guess('CASH ADVANCE FEE', 'out').accountId !== undefined, 'no crash');
console.log(n - bad + '/' + n + ' ok'); process.exit(bad ? 1 : 0);
