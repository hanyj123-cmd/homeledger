// 이전 장부(Artifacts 버전)에서 내보낸 migration 파일을 불러오는 도구.
// 파일 안의 계정·거래·분개·규칙·예산·설정을 현재 시트에 "없는 것만" 추가합니다. (여러 번 눌러도 중복되지 않음)
import { truthy } from './ledger.js';

export const FORMAT = 'homeledger-migration';
const SHEETS = ['Accounts', 'Settings', 'Rules', 'Budgets', 'Transactions', 'Postings'];
const KEY = { Accounts: 'account_id', Settings: 'key', Rules: 'rule_id', Budgets: 'budget_id', Transactions: 'txn_id', Postings: 'posting_id' };
export const CHUNK_TXNS = 400;

/** 파일 내용(문자열 또는 객체)을 검사해서 돌려줍니다. 문제가 있으면 Error. */
export function parseFile(input) {
  let d = input;
  if (typeof input === 'string') {
    try { d = JSON.parse(input); } catch (e) { throw new Error('JSON 파일이 아닙니다. (Not a JSON file)'); }
  }
  if (!d || d.format !== FORMAT) throw new Error('Home Ledger migration 파일이 아닙니다. (Not a Home Ledger migration file)');
  if (d.version !== 1) throw new Error('지원하지 않는 파일 버전입니다: ' + d.version);
  SHEETS.forEach((s) => { if (!Array.isArray(d[s])) throw new Error('파일에 ' + s + ' 목록이 없습니다.'); });
  // 거래별 분개 합이 0 인지, 분개가 가리키는 거래가 있는지
  const tx = new Set(d.Transactions.map((t) => String(t.txn_id)));
  const sum = {};
  d.Postings.forEach((p) => {
    if (!tx.has(String(p.txn_id))) throw new Error('거래 없는 분개가 있습니다: ' + p.posting_id);
    sum[p.txn_id] = (sum[p.txn_id] || 0) + Number(p.amount_cad);
  });
  const bad = Object.keys(sum).filter((k) => Math.abs(sum[k]) > 0.005);
  if (bad.length) throw new Error('차변·대변이 맞지 않는 거래가 ' + bad.length + '건 있습니다. (Unbalanced entries: ' + bad.length + ')');
  return d;
}

/** 현재 데이터와 비교해 무엇을 추가할지 계산합니다. data = { accounts, txns, postings, rules, budgets, settings } */
export function plan(file, data) {
  const live = (rows) => (rows || []).filter((r) => !truthy(r.deleted));
  const have = (rows, key) => new Set((rows || []).map((r) => String(r[key])));
  const haveAcc = have(data.accounts, 'account_id');
  const haveTxn = have(data.txns, 'txn_id');
  const havePost = have(data.postings, 'posting_id');
  const haveRule = have(data.rules, 'rule_id');
  const rulePat = new Set(live(data.rules).map((r) => String(r.pattern || '').toLowerCase()));
  const haveBud = have(data.budgets, 'budget_id');
  const haveSet = new Set(live(data.settings).filter((r) => r.value !== '' && r.value != null).map((r) => String(r.key)));

  const out = { Accounts: [], Settings: [], Rules: [], Budgets: [], Transactions: [], Postings: [] };
  const skipped = { Accounts: 0, Settings: 0, Rules: 0, Budgets: 0, Transactions: 0, Postings: 0 };
  const take = (sheet, rows, skip) => rows.forEach((r) => (skip(r) ? skipped[sheet]++ : out[sheet].push(r)));
  take('Accounts', file.Accounts, (r) => haveAcc.has(String(r.account_id)));
  take('Settings', file.Settings, (r) => haveSet.has(String(r.key)));
  take('Rules', file.Rules, (r) => haveRule.has(String(r.rule_id)) || rulePat.has(String(r.pattern || '').toLowerCase()));
  take('Budgets', file.Budgets, (r) => haveBud.has(String(r.budget_id)));
  take('Transactions', file.Transactions, (r) => haveTxn.has(String(r.txn_id)));
  const newTxn = new Set(out.Transactions.map((t) => String(t.txn_id)));
  take('Postings', file.Postings, (r) => havePost.has(String(r.posting_id)) || !newTxn.has(String(r.txn_id)));

  // 분개가 쓰는 계정이 시트에도, 이번에 추가할 목록에도 없으면 가져올 수 없습니다.
  const known = new Set([...haveAcc, ...out.Accounts.map((a) => String(a.account_id))]);
  const missing = Array.from(new Set(out.Postings.map((p) => String(p.account_id)).filter((a) => !known.has(a)))).sort();
  const dates = out.Transactions.map((t) => t.date).sort();
  return { add: out, skipped, missing, from: dates[0] || '', to: dates[dates.length - 1] || '', counts: Object.fromEntries(SHEETS.map((s) => [s, out[s].length])) };
}

/** 계획대로 저장합니다. saveBatch(puts, order) 를 여러 번 나눠서 호출. onProgress(done,total) */
export async function apply(p, saveBatch, onProgress) {
  if (p.missing.length) throw new Error('시트에 없는 계정이 있어 가져올 수 없습니다: ' + p.missing.join(', '));
  const now = new Date().toISOString();
  const stamp = (rows) => rows.map((r) => Object.assign({}, r, { updated_at: now }));
  const total = p.add.Transactions.length;
  let done = 0;
  const head = { Accounts: stamp(p.add.Accounts), Settings: stamp(p.add.Settings), Rules: stamp(p.add.Rules), Budgets: stamp(p.add.Budgets) };
  if (Object.keys(head).some((k) => head[k].length)) await saveBatch(head, ['Accounts', 'Settings', 'Rules', 'Budgets']);
  const byTxn = {};
  p.add.Postings.forEach((x) => { (byTxn[x.txn_id] = byTxn[x.txn_id] || []).push(x); });
  for (let i = 0; i < total; i += CHUNK_TXNS) {
    const tx = stamp(p.add.Transactions.slice(i, i + CHUNK_TXNS));
    const ps = [];
    tx.forEach((t) => (byTxn[t.txn_id] || []).forEach((x) => ps.push(Object.assign({}, x, { updated_at: now }))));
    await saveBatch({ Transactions: tx, Postings: ps }, ['Transactions', 'Postings']);
    done += tx.length;
    if (onProgress) onProgress(done, total);
  }
  return { transactions: total, postings: p.add.Postings.length };
}
