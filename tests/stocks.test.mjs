// 주식 기능(전일 대비 · 매수 기록 · 월말 기록)의 순수 계산 테스트.  실행: node tests/stocks.test.mjs
import * as F from '../js/wealth-forms.js';
import * as V from '../js/valuation.js';
import * as M from '../js/meta.js';

let n = 0;
const eq = (a, b, m) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', m, '\n  got ', JSON.stringify(a), '\n  want', JSON.stringify(b)); process.exit(1); } };
const near = (a, b, m) => { n++; if (Math.abs(a - b) > 0.005) { console.error('FAIL', m, a, b); process.exit(1); } };
const noon = (d) => d + 'T17:00:00.000Z';   // 어느 시간대에서도 같은 날짜가 되도록 한낮

// ── rollPrev: 날짜가 바뀔 때만 prev 를 갈아 끼움
const a1 = { price: 100, at: noon('2026-10-19'), ccy: 'CAD' };
eq(F.rollPrev(a1, null).prev, undefined, 'first entry has no prev');
const a2 = F.rollPrev({ price: 102, at: noon('2026-10-20'), ccy: 'CAD' }, a1);
eq(a2.prev, { price: 100, at: a1.at }, 'new day rolls prev');
const a3 = F.rollPrev({ price: 103, at: noon('2026-10-20'), ccy: 'CAD' }, a2);
eq(a3.prev, { price: 100, at: a1.at }, 'same day keeps prev');
const a4 = F.rollPrev({ price: 101, at: noon('2026-10-21'), ccy: 'CAD' }, a3);
eq(a4.prev, { price: 103, at: a3.at }, 'next day rolls to latest of previous day');
eq(F.rollPrev({ price: 5, at: 'garbage' }, a1).prev, undefined, 'bad date does not invent prev');

// ── 라벨 · 하루 변동
eq(F.changeLabel(noon('2026-10-21'), noon('2026-10-20')), '어제 대비', 'yesterday label');
eq(F.changeLabel(noon('2026-10-21'), noon('2026-10-14')), '10/14 대비', 'older label');
const accMap = new Map();
const hs = [{ sym: 'TD.TO', shares: 10, book: 900, acct: '' }, { sym: 'AAPL', shares: 2, book: 400, acct: '' }, { sym: 'XEQT.TO', shares: 5, book: 150, acct: '' }];
const prices = { 'TD.TO': a4, AAPL: { price: 300, at: noon('2026-10-21'), ccy: 'USD', orig: 220, fx: 1.3636 }, 'XEQT.TO': { price: 30, at: noon('2026-10-21'), ccy: 'CAD', prev: { price: 29, at: noon('2026-10-20') } } };
const rows = F.holdingRows(hs, prices, accMap);
near(rows[0].dayDelta, -20, 'TD day delta = 10 * (101-103)');   // a4.prev = 103
eq(rows[1].dayDelta, null, 'no prev → no change');
near(rows[2].dayDelta, 5, 'XEQT day delta');
const t = F.dayTotals(rows);
near(t.delta, -15, 'total delta'); eq(t.count, 2, 'count'); eq(t.missing, 1, 'missing');
near(t.base, 1030 + 145, 'base'); near(t.pct, -15 / 1175 * 100, 'pct');

// ── 매수 기록
eq(F.checkBuy({ date: '2026-10-14', sym: 'td.to', shares: '5', cost: '480.5', acct: '12' }, '2026-10-21').cfg, { date: '2026-10-14', sym: 'TD.TO', acct: '12', shares: 5, cost: 480.5, note: '' }, 'buy ok');
eq(F.checkBuy({ date: '2026-10-30', sym: 'TD.TO', shares: '5', cost: '1' }, '2026-10-21').ok, false, 'future date rejected');
eq(F.checkBuy({ date: '2026-10-14', sym: 'TD.TO', shares: '0', cost: '1' }, '2026-10-21').ok, false, 'zero shares rejected');
eq(F.checkBuy({ date: '2026-10-14', sym: 'TD.TO', shares: '2', cost: '' }, '2026-10-21').ok, false, 'missing cost rejected');
const base = [{ sym: 'TD.TO', shares: 100, book: 9000, acct: '12' }];
const buy = { sym: 'TD.TO', acct: '12', shares: 5, cost: 480.5 };
const after = F.applyBuy(base, buy);
eq(after, [{ sym: 'TD.TO', shares: 105, book: 9480.5, acct: '12' }], 'applyBuy adds');
eq(base[0].shares, 100, 'applyBuy does not mutate');
eq(F.revertBuy(after, buy).list, base, 'revert undoes apply');
eq(F.applyBuy(base, { sym: 'XEQT.TO', acct: '12', shares: 3, cost: 90 }).length, 2, 'new symbol added');
const sh = F.revertBuy(base, { sym: 'TD.TO', acct: '12', shares: 500, cost: 1 });
eq([sh.short, sh.list.length], [true, 0], 'revert more than owned removes and flags short');
eq(F.revertBuy(base, { sym: 'ZZZ', acct: '12', shares: 1, cost: 1 }).found, false, 'revert unknown flagged');
eq(F.addDays('2026-10-14', 14), '2026-10-28', 'addDays');
eq(F.addDays('2026-12-25', 14), '2027-01-08', 'addDays year wrap');
const nb = F.nextBuyDefaults([{ date: '2026-10-07', sym: 'TD.TO', acct: '12', shares: 5, cost: 480 }], base, '2026-10-21');
eq(nb, { date: '2026-10-21', sym: 'TD.TO', acct: '12', shares: '5', cost: '480' }, 'next default is +14d capped at today');
eq(F.nextBuyDefaults([{ date: '2026-09-01', sym: 'TD.TO', acct: '12', shares: 5, cost: 480 }], base, '2026-10-21').date, '2026-09-15', 'next default +14d');

// ── 그 날의 보유 = 지금 − 그 후 매수
const cur = [{ sym: 'TD.TO', shares: 110, book: 10000, acct: '12' }, { sym: 'XEQT.TO', shares: 4, book: 120, acct: '12' }];
const buys = [
  { date: '2026-09-15', sym: 'TD.TO', acct: '12', shares: 5, cost: 450 },
  { date: '2026-10-06', sym: 'TD.TO', acct: '12', shares: 5, cost: 480 },
  { date: '2026-10-06', sym: 'XEQT.TO', acct: '12', shares: 4, cost: 120 }
];
const sep = F.holdingsAt(cur, buys, '2026-09-30');
eq(sep, [{ sym: 'TD.TO', acct: '12', shares: 105, book: 9520 }], 'Sept-end: later buys removed, XEQT not owned yet');
eq(F.holdingsAt(cur, buys, '2026-10-31').length, 2, 'Oct-end sees everything');

// ── 월말 기록 저장 검사
const fx = [{ fx_id: '1', date: '2026-09-30', currency: 'USD', rate: 1.35, source: 'x', deleted: false }];
const okSnap = F.checkSnap({ rows: [{ sym: 'TD.TO', acct: '12', shares: '105', price: '80', ccy: 'CAD', book: '9520' }, { sym: 'AAPL', acct: '12', shares: '2', price: '200', ccy: 'USD', book: '' }, { sym: 'XEQT.TO', acct: '12', shares: '', price: '', ccy: 'CAD', book: '' }] }, fx, '2026-09', '2026-10-21T00:00:00Z');
eq(okSnap.ok, true, 'snap ok');
eq(okSnap.snap.rows.length, 2, 'blank row skipped');
eq(okSnap.snap.rows[1], { sym: 'AAPL', acct: '12', shares: 2, book: 0, price: 270, ccy: 'USD', orig: 200, fx: 1.35 }, 'USD converted at month-end rate');
eq(F.checkSnap({ rows: [{ sym: 'AAPL', acct: '', shares: '2', price: '200', ccy: 'USD', book: '' }] }, [], '2026-09').ok, false, 'USD without fx rate rejected');
eq(F.checkSnap({ rows: [{ sym: 'TD.TO', acct: '', shares: '5', price: '', ccy: 'CAD', book: '' }] }, [], '2026-09').errors['0:price'] !== undefined, true, 'shares without price flagged on price');
eq(F.checkSnap({ rows: [] }, [], '2026-09').ok, false, 'empty snapshot rejected');
near(F.snapTotals(okSnap.snap).value, 105 * 80 + 2 * 270, 'snap total');

// ── 월말 변화: 새로 산 돈 vs 시세 변동
const snaps = {
  '2026-08': { rows: [{ sym: 'TD.TO', acct: '12', shares: 100, book: 8500, price: 80 }] },
  '2026-09': { rows: [{ sym: 'TD.TO', acct: '12', shares: 105, book: 8950, price: 82 }] }
};
const series = F.snapSeries(snaps, buys);
eq(series.map((r) => r.ym), ['2026-08', '2026-09'], 'series order');
eq(series[0].delta, null, 'first has no delta');
near(series[1].delta, 105 * 82 - 100 * 80, 'delta'); near(series[1].bought, 450, 'bought in Sept'); near(series[1].market, 8610 - 8000 - 450, 'market part');
eq(series[1].adjacent, true, 'adjacent months');

// ── 재무상태표: 지난 달은 월말 기록, 이번 달은 지금 시세
const meta = { holdings: [{ sym: 'TD.TO', shares: 110, book: 10000, acct: '12' }], prices: { 'TD.TO': { price: 90, at: noon('2026-10-21') } }, snaps };
near(V.overridesFor(meta, [], '2026-09', { todayYm: '2026-10' }).get('12'), 105 * 82, 'Sept uses snapshot');
near(V.overridesFor(meta, [], '2026-10', { todayYm: '2026-10' }).get('12'), 110 * 90, 'current month uses live prices');
near(V.overridesFor(meta, [], '2026-07', { todayYm: '2026-10' }).get('12'), 110 * 90, 'month without snapshot keeps old behaviour');
near(V.overridesFor({ holdings: meta.holdings, prices: meta.prices, snaps: { '2026-10': snaps['2026-09'] } }, [], '2026-10', { todayYm: '2026-10' }).get('12'), 110 * 90, 'snapshot of the current month is ignored until the month is over');

// ── 저장소: 시트 줄 → 기록 / 매수
const settings = [
  { key: 'meta.buys', value: JSON.stringify([{ id: 'b2', date: '2026-10-06', sym: 'TD.TO' }, { id: 'b1', date: '2026-09-15', sym: 'TD.TO' }, { id: 'bad', date: 'nope', sym: 'X' }]), deleted: false },
  { key: 'snap.2026-09', value: JSON.stringify(snaps['2026-09']), deleted: false },
  { key: 'snap.2026-08', value: JSON.stringify(snaps['2026-08']), deleted: true },
  { key: 'snap.garbage', value: '{}', deleted: false }
];
const all = M.readAll(settings);
eq(all.buys.map((b) => b.id), ['b1', 'b2'], 'buys sorted and filtered');
eq(Object.keys(all.snaps), ['2026-09'], 'only live snapshots with valid month');
eq(M.snapRow(settings, '2026-10', { at: 'x', rows: [] }, 'now').key, 'snap.2026-10', 'snapRow key');
eq(M.snapDeleteRow(settings, '2026-09', 'now').deleted, true, 'snapDeleteRow marks deleted');
eq(M.snapDeleteRow(settings, '2030-01', 'now'), null, 'delete of missing is null');

console.log('stocks tests passed (' + n + ' checks)');
