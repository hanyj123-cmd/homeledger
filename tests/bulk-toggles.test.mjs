// 선택한 거래: 전달 자금 · 환불 켜기/끄기.  실행: node tests/bulk-toggles.test.mjs
globalThis.__HL_TEST__ = true;
const L = await import('../js/ledger.js');
const B = await import('../js/bulk.js');
const { CONFIG } = await import('../js/config.js');

let n = 0;
const eq = (a, b, m) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', m, '\n  got ', JSON.stringify(a), '\n  want', JSON.stringify(b)); process.exit(1); } };
const acc = (id, name, type, extra) => Object.assign({ account_id: id, name, type, is_active: true, deleted: false, currency: 'CAD' }, extra || {});
const accounts = [acc('1010', 'Chequing', 'ASSET', { subtype: 'CHEQUING' }), acc('5110', 'Groceries', 'EXPENSE'), acc('4010', 'Salary', 'INCOME'),
  acc(CONFIG.CLEARING_ID, 'Passthrough', 'LIABILITY', { subtype: 'CLEARING' }), acc(CONFIG.CLEARING_CHURCH_ID, 'Passthrough – Church', 'LIABILITY', { subtype: 'CLEARING' })];
const accMap = new Map(accounts.map((a) => [a.account_id, a]));
const now = '2026-11-08T00:00:00Z';
const mk = (form) => { const r = L.makeRecords(L.newForm(Object.assign({ date: '2026-11-03', currency: 'CAD' }, form)), { accMap, existing: null, now }); return { txn: r.txn, ps: r.postings, desc: L.describeTxn(r.txn, r.postings, accMap) }; };
const apply = (it, plan) => { const t = plan.txns.find((x) => x.txn_id === it.txn.txn_id) || it.txn; const ps = it.ps.map((p) => plan.postings.find((q) => q.posting_id === p.posting_id) || p).concat(plan.postings.filter((q) => q.txn_id === it.txn.txn_id && !it.ps.some((p) => p.posting_id === q.posting_id))).filter((p) => !L.truthy(p.deleted)); return { txn: t, ps, desc: L.describeTxn(t, ps, accMap) }; };
const bal = (it, id) => L.round(it.ps.filter((p) => p.account_id === id).reduce((s, p) => s + L.num(p.amount_cad), 0), 2);

// 환불 켜기
const costco = mk({ kind: 'EXPENSE', fromId: '1010', categoryId: '5110', amountText: '80', merchant: 'Costco' });
eq([costco.desc.kind, costco.desc.flow], ['EXPENSE', 'out'], 'starts as spending');
let p = B.planRefund([costco], [costco.txn.txn_id], true, accMap, now, {});
eq(p.changed, 1, 'refund on: changed');
const ref = apply(costco, p);
eq([ref.desc.kind, ref.desc.flow], ['EXPENSE', 'in'], 'now a refund (money in)');
eq([bal(ref, '1010'), bal(ref, '5110')], [80, -80], 'chequing +80, groceries −80');
eq(B.planRefund([ref], [ref.txn.txn_id], true, accMap, now, {}).changed, 0, 'already refund → nothing');
// 환불 끄기
const back = apply(ref, B.planRefund([ref], [ref.txn.txn_id], false, accMap, now, {}));
eq([back.desc.flow, bal(back, '1010'), bal(back, '5110')], ['out', -80, 80], 'refund off → spending again');
// 수입은 환불 불가 (건너뜀)
const pay = mk({ kind: 'INCOME', toId: '1010', categoryId: '4010', amountText: '4000' });
const pi = B.planRefund([pay], [pay.txn.txn_id], true, accMap, now, {});
eq([pi.changed, pi.skipped[0].reason], [0, 'notexp'], 'income skipped');

// 전달 자금 켜기 (개인) → 교회로 바꾸기
let q = B.planBulk([costco], [costco.txn.txn_id], { special: 'PASSTHROUGH', passKind: 'PERSONAL' }, accMap, now, {});
const pt = apply(costco, q);
eq([pt.desc.kind, pt.desc.passKind], ['PASSTHROUGH', 'PERSONAL'], 'passthrough on (personal)');
q = B.planBulk([pt], [pt.txn.txn_id], { special: 'PASSTHROUGH', passKind: 'CHURCH' }, accMap, now, {});
eq(apply(pt, q).desc.passKind, 'CHURCH', 'switched to church');
// 끄기 = 카테고리 고르기 → 다시 지출
q = B.planBulk([pt], [pt.txn.txn_id], { categoryId: '5110' }, accMap, now, {});
const off = apply(pt, q);
eq([off.desc.kind, L.truthy(off.txn.is_passthrough)], ['EXPENSE', false], 'passthrough off → spending');
console.log('bulk-toggles tests passed (' + n + ' checks)');
