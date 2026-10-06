// 급여일 연동 입력 (Pay-day linked entries)
// "TD PAY" 수입이 들어오면, 같은 날짜에 회사 적립금(EOP·DC Pension 등)도 자동으로 함께 기록합니다.
//  - 항목은 가계부 이력에서 자동 감지: "<이름> (Income)" 거래가 급여일마다 같이 있었던 것들
//  - 금액은 직전에 기록된 같은 항목의 금액을 그대로 이어받음 (달라지면 직접 고치면 됨)
//  - id 가 거래 id 로부터 정해지므로(같은 입력 → 같은 id) 폰·아이패드에서 동시에 돌아도 중복되지 않음
//  - 사용자가 지운 항목은 다시 만들지 않음
import * as L from './ledger.js';
import * as M from './meta.js';
import * as sync from './sync.js';
import { CONFIG } from './config.js';

export const KEY = 'meta.paybundle';
export const DEFAULT_TRIGGER = 'TD PAY';
const ORDER = ['Settings', 'Postings', 'Transactions'];

let running = false;

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
export const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
const incomeName = (label) => label + ' (Income)';
const savingName = (label) => label + ' (Saving)';

/** 급여 거래인가? (수입 · 전달 자금 아님 · 가맹점이 트리거 문구와 같거나 "문구 + 공백…" 으로 시작) */
export function isPayTxn(it, trigger) {
  if (!it || !it.txn || !it.desc || it.desc.kind !== 'INCOME') return false;
  if (L.truthy(it.txn.is_passthrough)) return false;
  const t = norm(trigger || DEFAULT_TRIGGER);
  const m = norm(it.txn.merchant);
  if (!t || !m) return false;
  return m === t || m.startsWith(t + ' ');
}

/** 이번 달 기준 "지난달 1일" (처음 켤 때 거슬러 올라가 채울 시작일) */
export function defaultSince(today) {
  const ym = (today || L.todayStr()).slice(0, 7);
  return L.shiftMonth(ym, -1) + '-01';
}

const money = (it, sign) => {
  const p = it.ps.find((x) => sign * L.num(x.amount_cad) > 0);
  return p || null;
};

/** 가계부 이력에서 급여일 연동 항목 찾기 */
export function detectFromHistory(items, accMap, trigger) {
  const pays = items.filter((it) => isPayTxn(it, trigger));
  const payDates = new Set(pays.map((it) => it.txn.date));
  if (!payDates.size) return [];
  const byLabel = new Map();
  const savingKeys = new Set();
  items.forEach((it) => {
    const m = String(it.txn.merchant || '');
    let x = /^(.+?)\s*\(\s*Income\s*\)\s*$/i.exec(m);
    if (x && payDates.has(it.txn.date) && it.desc.kind === 'INCOME') {
      const k = norm(x[1]);
      if (!byLabel.has(k)) byLabel.set(k, { label: x[1].trim(), occ: [] });
      byLabel.get(k).occ.push(it);
      return;
    }
    x = /^(.+?)\s*\(\s*Saving\s*\)\s*$/i.exec(m);
    if (x && payDates.has(it.txn.date) && it.desc.kind === 'PASSTHROUGH') savingKeys.add(norm(x[1]) + '|' + it.txn.date);
  });
  const need = Math.min(2, payDates.size);
  const out = [];
  byLabel.forEach((g, k) => {
    const dates = new Set(g.occ.map((it) => it.txn.date));
    if (dates.size < need) return;
    g.occ.sort((a, b) => (a.txn.date < b.txn.date ? 1 : a.txn.date > b.txn.date ? -1 : 0));
    const last = g.occ[0];
    const asset = money(last, 1);
    const inc = money(last, -1);
    if (!asset || !inc) return;
    const a = accMap.get(String(asset.account_id));
    if (!a || !L.isMoneyAccount(a)) return;
    out.push({
      key: slug(g.label), label: g.label,
      assetId: String(asset.account_id), incomeId: String(inc.account_id),
      saving: savingKeys.has(k + '|' + last.txn.date),
      on: true, amount: L.round(L.num(last.txn.total_cad), 2)
    });
  });
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/** 이력에서 다시 찾은 항목을 기존 설정에 합치기 (사용자가 바꾼 켜기/끄기·저축 줄은 유지) */
export function mergeDetected(cfg, detected) {
  const have = new Map((cfg.items || []).map((i) => [i.key, i]));
  const items = (cfg.items || []).slice();
  let added = 0;
  detected.forEach((d) => {
    if (have.has(d.key)) return;
    items.push(d);
    added++;
  });
  return { cfg: Object.assign({}, cfg, { items }), added };
}

export function itemId(payTxnId, key, saving) { return 'pb_' + String(payTxnId) + '_' + key + (saving ? '_s' : ''); }

/** 만들어야 할 거래 계산 (순수 함수: 저장하지 않음) */
export function plan(items, rawTxns, cfg, opts) {
  const out = { txns: [], postings: [], created: [] };
  if (!cfg || cfg.enabled === false || !(cfg.items || []).length) return out;
  const now = (opts && opts.now) || L.nowIso();
  const since = cfg.since || '0000-00-00';
  const trigger = cfg.trigger || DEFAULT_TRIGGER;
  const rawIds = new Set((rawTxns || []).map((t) => String(t.txn_id)));   // 지워진 것 포함 → 지운 항목은 되살리지 않음
  const seen = new Set();            // date|이름 (이미 있는 거래)
  const hist = new Map();            // 이름 → [{date, amount}]
  items.forEach((it) => {
    seen.add(it.txn.date + '|' + norm(it.txn.merchant));
    const m = norm(it.txn.merchant);
    if (m.endsWith('(income)') && it.desc.kind === 'INCOME') {
      if (!hist.has(m)) hist.set(m, []);
      hist.get(m).push({ date: it.txn.date, amount: L.num(it.txn.total_cad) });
    }
  });
  const amountFor = (label, date, fallback) => {
    const arr = hist.get(norm(incomeName(label))) || [];
    let best = null;
    arr.forEach((r) => { if (r.date <= date && (!best || r.date >= best.date)) best = r; });
    if (!best) arr.forEach((r) => { if (!best || r.date < best.date) best = r; });
    const v = best ? best.amount : L.num(fallback);
    return L.round(v, 2);
  };
  const pays = items.filter((it) => it.txn.date >= since && isPayTxn(it, trigger))
    .sort((a, b) => (a.txn.date < b.txn.date ? -1 : a.txn.date > b.txn.date ? 1 : String(a.txn.created_at || '').localeCompare(String(b.txn.created_at || ''))));

  const build = (pay, it, label, amt, saving) => {
    const id = itemId(pay.txn.txn_id, it.key, saving);
    const tid = id;
    const kindName = saving ? savingName(label) : incomeName(label);
    const txn = {
      txn_id: tid, date: pay.txn.date, posted_date: '', merchant: kindName, merchant_raw: '', memo: 'Auto-added with ' + (pay.txn.merchant || trigger),
      currency: 'CAD', subtotal_orig: amt, tax_orig: '', tip_orig: '', total_orig: amt, fx_rate: 1, fx_source: '', fx_status: 'ACTUAL', total_cad: amt,
      source: 'PAYROLL', status: 'MATCHED', owner: pay.txn.owner || 'Joint', trip_tag: '', is_passthrough: !!saving,
      receipt_id: '', statement_line_id: '', created_at: now, updated_at: now, deleted: false
    };
    const mk = (suffix, acct, sign) => ({
      posting_id: 'pbp_' + tid.slice(3) + '_' + suffix, txn_id: tid, line_id: '', account_id: String(acct),
      amount_cad: L.round(sign * amt, 2), amount_orig: L.round(sign * amt, 2), currency: 'CAD', fx_rate: 1,
      memo: '', owner: '', updated_at: now, deleted: false
    });
    const ps = saving
      ? [mk('a', it.assetId, -1), mk('b', CONFIG.CLEARING_ID, 1)]
      : [mk('a', it.assetId, 1), mk('b', it.incomeId, -1)];
    return { txn, ps };
  };

  pays.forEach((pay) => {
    cfg.items.forEach((it) => {
      if (it.on === false || !it.key || !it.label) return;
      const id = itemId(pay.txn.txn_id, it.key, false);
      if (rawIds.has(id)) return;
      if (seen.has(pay.txn.date + '|' + norm(incomeName(it.label)))) return;
      const amt = amountFor(it.label, pay.txn.date, it.amount);
      if (!(amt > 0)) return;
      const one = build(pay, it, it.label, amt, false);
      out.txns.push(one.txn); out.postings.push.apply(out.postings, one.ps);
      seen.add(pay.txn.date + '|' + norm(incomeName(it.label)));
      if (!hist.has(norm(incomeName(it.label)))) hist.set(norm(incomeName(it.label)), []);
      hist.get(norm(incomeName(it.label))).push({ date: pay.txn.date, amount: amt });
      out.created.push({ date: pay.txn.date, label: it.label, amount: amt, saving: false });
      // 저축(전달 자금) 짝 — 이력처럼 쓰는 항목에서만, 그리고 수입 줄을 새로 만들 때 함께만
      const sid = itemId(pay.txn.txn_id, it.key, true);
      if (it.saving && !rawIds.has(sid) && !seen.has(pay.txn.date + '|' + norm(savingName(it.label)))) {
        const two = build(pay, it, it.label, amt, true);
        out.txns.push(two.txn); out.postings.push.apply(out.postings, two.ps);
        seen.add(pay.txn.date + '|' + norm(savingName(it.label)));
        out.created.push({ date: pay.txn.date, label: it.label, amount: amt, saving: true });
      }
    });
  });
  return out;
}

export function readCfg(settings) { return M.readJson(settings, KEY, null); }
export function cfgRow(settings, cfg, now) { return M.metaRow(settings, KEY, cfg, 'pay-day linked entries (급여일 연동 입력)', now); }

/** 앱이 데이터를 읽을 때마다 부르는 자동 실행 (api: ui.js 의 xferApi) */
export async function autoRun(api) {
  if (running) return 0;
  const st = api && api.state;
  if (!st || !st.data || !st.d || !st.data.accounts || !st.data.accounts.length || !st.d.items.length) return 0;
  running = true;
  try {
    const now = L.nowIso();
    let cfg = readCfg(st.data.settings);
    const puts = {};
    if (!cfg) {
      const det = detectFromHistory(st.d.items, st.d.accMap, DEFAULT_TRIGGER);
      if (!det.length) return 0;
      cfg = { enabled: true, trigger: DEFAULT_TRIGGER, since: defaultSince(), items: det };
      puts.Settings = [cfgRow(st.data.settings, cfg, now)];
    }
    if (cfg.enabled === false) return 0;
    const pl = plan(st.d.items, st.data.txns, cfg, { now });
    if (!pl.txns.length && !puts.Settings) return 0;
    if (pl.txns.length) { puts.Transactions = pl.txns; puts.Postings = pl.postings; }
    await sync.saveBatch(puts, ORDER);
    if (api.reload) await api.reload();
    if (api.renderBody) api.renderBody();
    const n = pl.created.filter((c) => !c.saving).length;
    if (n && api.toast) api.toast('Added ' + n + ' pay-day entries (급여일 연동 입력 ' + n + '건을 자동으로 추가했어요)');
    return n;
  } catch (e) {
    console.error('pay-day entries', e);
    return 0;
  } finally {
    running = false;
  }
}
