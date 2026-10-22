import * as I from '../js/importer.js';
let n = 0, bad = 0;
const ok = (c, m) => { n++; if (!c) { bad++; console.log('FAIL', m); } };
// TD 스크린샷 (최신이 위, 들어온 돈 +)
const shot1 = { lines: [
  { date: '2026-10-19', description: 'E-TRANSFER ***PJ5', amount: 25.10, balance: 473.88 },
  { date: '2026-10-19', description: 'SEND E-TFR ***n83', amount: -20.00, balance: 448.78 },
  { date: '2026-10-19', description: 'SEND E-TFR ***VZC', amount: -32.27, balance: 468.78 },
  { date: '2026-10-19', description: 'LH070 TFR-FR 3225360', amount: 500.00, balance: 501.05 },
  { date: '2026-10-19', description: 'SEND E-TFR ***j3x', amount: -200.00, balance: 1.05 }
] };
let r = I.linesFromImages([shot1]);
ok(r.lines.length === 5, 'five lines');
ok(r.lines[0].amount === -25.10 && r.lines[1].amount === 20, 'sign: in → negative(app), out → positive');
ok(r.lines.every((l) => !l.warn), 'real screenshot balances all add up');
const wrong = { lines: shot1.lines.map((l, i) => (i === 2 ? { ...l, balance: 460.00 } : l)) };
const rw = I.linesFromImages([wrong]);
ok(rw.lines.filter((l) => l.warn).map((l) => l.idx).join() === '1,2', 'bad balance flags the neighbouring lines: ' + rw.lines.map((l) => !!l.warn).join());
ok(I.linesFromImages([shot1], { flip: true }).lines[0].amount === 25.10, 'flip');
// 겹치는 화면
const shot2 = { lines: [shot1.lines[3], shot1.lines[4], { date: '2026-10-15', description: 'PAYROLL', amount: 201.05, balance: 202.10 }] };
r = I.linesFromImages([shot1, shot2]);
ok(r.lines.length === 6 && r.skipped.some((s) => /overlap/.test(s.reason)), 'overlap removed: ' + r.lines.length);
ok(I.linesFromImages([{ lines: [{ date: 'x', description: 'a', amount: 1 }, { date: '2026-10-01', description: 'b', amount: 'abc' }] }]).skipped.length === 2, 'bad rows skipped');
// 느슨한 중복
const acc = (id, type) => ({ account_id: id, name: id, type, is_active: true, currency: 'CAD' });
const accMap = new Map([['1010', acc('1010', 'ASSET')], ['9999', acc('9999', 'EXPENSE')], ['5010', acc('5010', 'EXPENSE')]]);
const stmtLines = [{ stmt_line_id: 's1', account_id: '1010', date: '2026-10-18', amount: 20, description_raw: 'Send E-Tfr n83 Joe', matched_txn_id: 't1', deleted: false }];
const txn = { txn_id: 't2', date: '2026-10-20', merchant: 'Rent share', deleted: false, receipt_id: '', source: 'MANUAL' };
const items = [{ txn: { txn_id: 't1', date: '2026-10-18', merchant: 'x', deleted: false }, ps: [{ account_id: '1010', amount_cad: -20 }], desc: { kind: 'EXPENSE' } },
  { txn, ps: [{ account_id: '1010', amount_cad: -32.27 }], desc: { kind: 'EXPENSE' } }];
const prev = I.buildPreview(I.linesFromImages([shot1]).lines, { accountId: '1010', accMap, accounts: Array.from(accMap.values()), rules: [], items, stmtLines, loose: true });
const act = (i) => prev[i].action;
ok(act(1) === 'SKIP' && prev[1].line.dupLoose, 'already-imported statement line (name differs, date ±1) skipped');
ok(act(2) === 'MATCH', 'matches existing manual txn by amount/date: ' + act(2));
ok(act(0) === 'NEW' && act(3) === 'NEW', 'others new');
const prev2 = I.buildPreview(I.linesFromImages([shot1]).lines, { accountId: '1010', accMap, accounts: Array.from(accMap.values()), rules: [], items, stmtLines, loose: false });
ok(prev2[1].action === 'NEW', 'strict mode unchanged (no loose skip)');
// 같은 금액 두 줄 — 기존 한 줄만 소모
const two = [{ date: '2026-10-18', description: 'SEND E-TFR A', amount: -20 }, { date: '2026-10-18', description: 'SEND E-TFR B', amount: -20 }];
const prev3 = I.buildPreview(I.linesFromImages([{ lines: two }]).lines, { accountId: '1010', accMap, accounts: Array.from(accMap.values()), rules: [], items: [], stmtLines, loose: true });
ok(prev3.filter((p) => p.action === 'SKIP').length === 1 && prev3.filter((p) => p.action === 'NEW').length === 1, 'one existing absorbs only one line');
const rec = I.buildRecords(prev, { accountId: '1010', accMap, rules: [], profile: null, now: '2026-10-22T00:00:00Z' });
ok(rec.counts.skipped === 1 && rec.counts.matched === 1 && rec.counts.created === 3, 'records: ' + JSON.stringify(rec.counts));
console.log(n - bad + '/' + n + ' ok'); process.exit(bad ? 1 : 0);
