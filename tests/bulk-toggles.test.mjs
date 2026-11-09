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

// ───── 종류 · 카테고리 바꾸기 (planChange) ─────
{
  let m = 0;
  const ok = (a, b, msg) => { m++; eq(a, b, msg); };
  accounts.push(acc('2010', 'Visa', 'LIABILITY', { subtype: 'CREDIT_CARD' })); accMap.set('2010', accounts[accounts.length - 1]);
  const t2 = mk({ kind: 'TRANSFER', fromId: '1010', toId: '2010', amountText: '50', merchant: 'Payment' });
  const spend = mk({ kind: 'EXPENSE', fromId: '1010', categoryId: '5110', amountText: '30', merchant: 'Costco' });
  const deposit = mk({ kind: 'INCOME', toId: '1010', categoryId: '4010', amountText: '200', merchant: 'E-transfer in' });
  // 이체 → 지출 (보낸 쪽 계좌에서 나간 돈)
  let c = B.planChange([t2], [t2.txn.txn_id], { kind: 'EXPENSE', categoryId: '5110' }, accMap, now, {});
  let r = apply(t2, c);
  ok([r.desc.kind, r.desc.flow, bal(r, '1010'), bal(r, '5110')], ['EXPENSE', 'out', -50, 50], 'transfer → spending, chequing still −50');
  // 지출 → 이체
  c = B.planChange([spend], [spend.txn.txn_id], { kind: 'TRANSFER', accountId: '2010' }, accMap, now, {});
  r = apply(spend, c);
  ok([r.desc.kind, bal(r, '1010')], ['TRANSFER', -30], 'spending → transfer, chequing still −30');
  // 지출(나간 돈) → 수입: 건너뜀
  c = B.planChange([spend], [spend.txn.txn_id], { kind: 'INCOME', categoryId: '4010' }, accMap, now, {});
  ok([c.changed, c.skipped[0].reason], [0, 'direction'], 'money out cannot become income');
  // 수입(들어온 돈) → 환불
  c = B.planChange([deposit], [deposit.txn.txn_id], { kind: 'REFUND', categoryId: '5110' }, accMap, now, {});
  r = apply(deposit, c);
  ok([r.desc.kind, r.desc.flow, bal(r, '1010'), bal(r, '5110')], ['EXPENSE', 'in', 200, -200], 'income → refund of groceries, chequing still +200');
  // 수입 → 전달 자금 (교회)
  c = B.planChange([deposit], [deposit.txn.txn_id], { kind: 'PASSTHROUGH', passKind: 'CHURCH' }, accMap, now, {});
  r = apply(deposit, c);
  ok([r.desc.kind, r.desc.passKind, bal(r, '1010')], ['PASSTHROUGH', 'CHURCH', 200], 'income → church passthrough');
  // 여러 종류 한꺼번에 → 지출: 지출은 카테고리만, 이체는 종류까지
  c = B.planChange([spend, t2], [spend.txn.txn_id, t2.txn.txn_id], { kind: 'EXPENSE', categoryId: '5110' }, accMap, now, {});
  ok(c.changed, 1, 'mixed: spending already groceries (no change) + transfer converted');
  console.log('planChange checks passed (' + m + ')');
}
