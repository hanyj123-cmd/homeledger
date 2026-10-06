// 거래 상세 패널: 손익·재무상태표·거래 탭에서 "이 줄 뒤에 있는 거래들"을 보여 주고, 그 자리에서 고칩니다.
//   · 카테고리 바꾸기 · 금액 바로 고치기(10*1.1 가능) · 메모 · 삭제 · 자세히(전체 입력 창)
//   · 여러 건 고르면 합계 · 거래 추가
// 놓이는 자리: 폰 = 아래에서 올라오는 시트 / 아이패드 = 화면 오른쪽에 붙은 칸 / 컴퓨터 = 오른쪽에서 나오는 서랍
import * as L from './ledger.js';
import * as sync from './sync.js';
import { icon } from './icons.js';
import { layoutOf } from './layout.js';
import * as receiptui from './receiptui.js';
import { openRemember } from './rememberui.js';
import * as X from './xfermatch.js';

let cur = null;            // { api, spec, picked:Set, pickMode }
let dock = null;           // { el, fallback }  (아이패드 전용)

export function setDock(el, fallback) { dock = el ? { el, fallback } : null; }
export function isOpen() { return !!cur; }
export function currentSpec() { return cur ? cur.spec : null; }

// spec = { title, sub, months:[ym]|null, ids:[계정 id], mode:'exp'|'inc'|'acct', acctType, search }
export function show(api, spec) {
  const keep = cur && cur.spec && cur.spec.key === spec.key;
  cur = { api, spec, picked: keep ? cur.picked : new Set(), pickMode: keep ? cur.pickMode : false };
  mount();
}

export function restore(api) {
  if (!cur) return;
  cur.api = api;
  mount();
}

export function close() {
  cur = null;
  const dr = document.getElementById('drawer');
  if (dr) { dr.hidden = true; const p = document.getElementById('drawer-panel'); if (p) p.replaceChildren(); }
  document.body.classList.remove('noscroll');
  if (dock && dock.el.isConnected) { dock.el.replaceChildren(); if (dock.fallback) dock.fallback(dock.el); }
}

// ───────── 데이터 ─────────

function gather(state, spec) {
  const ids = new Set(spec.ids.map(String));
  const months = spec.months ? new Set(spec.months) : null;
  const rows = [];
  state.d.items.forEach((it) => {
    if (months && !months.has(L.monthOf(it.txn.date))) return;
    let amt = 0, hit = false;
    it.ps.forEach((p) => { if (!L.truthy(p.deleted) && ids.has(String(p.account_id))) { amt += L.num(p.amount_cad); hit = true; } });
    if (!hit) return;
    let v = amt;
    if (spec.mode === 'inc') v = -amt;
    else if (spec.mode === 'acct' && spec.acctType === 'LIABILITY') v = -amt;
    rows.push({ it, v: L.round(v, 2) });
  });
  return rows;
}

const isSimple = (state, it) => {
  const live = it.ps.filter((p) => !L.truthy(p.deleted));
  return live.length === 2 && (it.txn.currency || 'CAD') === 'CAD' && !receiptui.isReceiptTxn(state, it.txn.txn_id)
    && (it.desc.kind === 'EXPENSE' || it.desc.kind === 'INCOME') && !L.truthy(it.txn.is_passthrough);
};

// ───────── 화면 ─────────

function build() {
  const { api, spec } = cur;
  if (spec.mode === 'xfer') return buildTransferReview();
  const { h, fmt, state } = api;
  const rows = gather(state, spec);
  const absorbed = X.absorbedMap(state.data.txns);
  const total = L.round(rows.reduce((s, r) => s + r.v, 0), 2);
  const todo = rows.filter((r) => String(r.it.desc.categoryId) === '9999' || String(r.it.txn.status).toUpperCase() === 'REVIEW').length;

  const head = h('div', { class: 'dp-head' },
    h('div', { class: 'tt' }, h('h2', null, spec.title), h('div', { class: 'ss' }, (spec.sub ? spec.sub + ' · ' : '') + rows.length + ' transaction(s) (거래 ' + rows.length + '건)')),
    h('button', { type: 'button', class: 'icon', id: 'dp-close', 'aria-label': 'Close (닫기)', onclick: close }, icon('close', 22)));

  const tot = h('div', { class: 'dp-tot' },
    h('b', { class: spec.mode === 'inc' ? 'in' : '' }, fmt(total)),
    h('span', null, spec.totalLabel || (spec.mode === 'acct' ? 'Net change (순증감)' : 'Total (합계)')),
    todo ? h('span', { style: 'color:var(--warn-ink);font-weight:600' }, '⚠ ' + todo + ' need a category (분류 필요 ' + todo + '건)') : null);

  const tools = h('div', { class: 'dp-tools' },
    h('button', { type: 'button', class: 'btn secondary sm', id: 'dp-select', onclick: () => { cur.pickMode = !cur.pickMode; if (!cur.pickMode) cur.picked.clear(); rerender(); } },
      icon('select', 18), cur.pickMode ? 'Done (선택 끝)' : 'Select (선택)'),
    h('button', { type: 'button', class: 'btn secondary sm', id: 'dp-add', onclick: () => api.openForm(null, spec.addDefaults || {}) }, icon('plus', 18), 'Add (거래 추가)'),
    spec.search ? h('button', { type: 'button', class: 'btn secondary sm', id: 'dp-open', onclick: () => { close(); api.goSearch(spec.search); } }, icon('open', 18), 'In Ledger (거래 탭)') : null);

  const sel = h('div', { class: 'dp-sel', id: 'dp-sel', hidden: true });
  const list = h('div', { class: 'dp-list', id: 'dp-list' });

  const refreshSel = () => {
    const ids = Array.from(cur.picked);
    sel.hidden = !cur.pickMode || !ids.length;
    if (sel.hidden) return;
    const sum = L.round(rows.filter((r) => cur.picked.has(String(r.it.txn.txn_id))).reduce((s, r) => s + r.v, 0), 2);
    sel.replaceChildren(h('b', null, ids.length + ' selected (선택)'), h('b', { id: 'dp-sel-sum' }, fmt(sum)),
      h('span', { class: 'muted' }, 'avg (평균) ' + fmt(L.round(sum / ids.length, 2))),
      h('button', { type: 'button', class: 'btn secondary sm', onclick: () => { rows.forEach((r) => cur.picked.add(String(r.it.txn.txn_id))); rerender(); } }, 'All (전체)'),
      h('button', { type: 'button', class: 'btn secondary sm', onclick: () => { cur.picked.clear(); rerender(); } }, 'Clear (해제)'));
    list.querySelectorAll('.dr').forEach((el) => el.classList.toggle('on', cur.picked.has(el.getAttribute('data-id'))));
    list.querySelectorAll('.dr .pk input').forEach((el) => { el.checked = cur.picked.has(el.closest('.dr').getAttribute('data-id')); });
  };

  if (!rows.length) list.append(h('div', { class: 'dp-empty' }, 'No transactions (거래가 없습니다).'));

  const catSelect = (it) => {
    const kind = it.desc.kind;
    const simple = isSimple(state, it);
    if (!simple) {
      const label = receiptui.isReceiptTxn(state, it.txn.txn_id) ? 'Receipt split (영수증 분할)' : it.desc.categoryName || it.desc.kind;
      return h('select', { disabled: true, 'aria-label': 'Category' }, h('option', null, label));
    }
    const type = kind === 'INCOME' ? 'INCOME' : 'EXPENSE';
    const accts = state.data.accounts.filter((a) => L.isActive(a) && a.type === type);
    const groups = new Map();
    accts.forEach((a) => { const g = a.report_group || (type === 'INCOME' ? '수입' : '확인 필요'); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(a); });
    const order = type === 'INCOME' ? ['수입'] : L.GROUP_ORDER;
    const keys = order.filter((g) => groups.has(g)).concat(Array.from(groups.keys()).filter((g) => order.indexOf(g) < 0));
    return h('select', {
      class: 'dp-cat', 'aria-label': 'Category (카테고리)',
      onchange: (e) => edit(it, { categoryId: e.target.value, categoryTouched: true }, true)
    }, keys.map((g) => h('optgroup', { label: L.GROUP_LABELS[g] || g }, groups.get(g).map((a) => h('option', { value: a.account_id, selected: String(a.account_id) === String(it.desc.categoryId) }, L.accLabel(a))))));
  };

  rows.forEach((r) => {
    const it = r.it, t = it.txn, dsc = it.desc;
    const id = String(t.txn_id);
    const simple = isSimple(state, it);
    const review = String(dsc.categoryId) === '9999' || String(t.status).toUpperCase() === 'REVIEW';
    const cat = state.d.accMap.get(String(dsc.categoryId));
    const amtEl = simple
      ? h('input', {
        type: 'text', inputmode: 'decimal', class: 'dp-amt', value: L.fmtNumber(Math.abs(L.num(t.total_cad)), 'CAD'), 'aria-label': 'Amount (금액)',
        onfocus: (e) => { e.target.value = String(Math.abs(L.num(t.total_cad))); e.target.select(); },
        onchange: (e) => {
          const n = L.parseAmount(e.target.value);
          if (!Number.isFinite(n) || n <= 0) { api.toast('금액을 올바르게 입력하세요.'); rerender(); return; }
          if (L.round(n, 2) !== Math.abs(L.num(t.total_cad))) edit(it, { amountText: String(L.round(n, 2)) }, false);
        }
      })
      : h('span', { class: 'ro' }, fmt(Math.abs(r.v)));
    const sign = r.v < 0 ? '−' : (spec.mode === 'acct' ? '+' : '');
    const row = h('div', { class: 'dr' + (review ? ' todo' : '') + (cur.picked.has(id) ? ' on' : ''), 'data-id': id },
      h('div', { class: 'pk' }, cur.pickMode
        ? h('input', { type: 'checkbox', 'aria-label': 'Select (선택)', checked: cur.picked.has(id), onchange: (e) => { if (e.target.checked) cur.picked.add(id); else cur.picked.delete(id); refreshSel(); } })
        : null),
      h('div', { class: 'mm' },
        h('div', { class: 'mt' }, t.merchant || t.memo || dsc.categoryName),
        h('div', { class: 'ms' }, [L.dayLabel(t.date), dsc.accountName, spec.mode === 'acct' || dsc.split ? (cat && !dsc.split ? cat.name : dsc.categoryName) : null].filter(Boolean).join(' · ')),
        dsc.split ? splitList(it, spec, fmt, h) : null,
        xferTag(it, absorbed.get(id))),
      h('div', { class: 'am' + (r.v < 0 ? ' neg' : '') }, spec.mode === 'acct' && !simple ? h('span', { class: 'ro' }, sign + fmt(Math.abs(r.v))) : amtEl),
      h('div', { class: 'ed' },
        catSelect(it),
        h('input', {
          type: 'text', class: 'dp-memo', placeholder: 'Memo (메모)', value: t.memo || '', 'aria-label': 'Memo (메모)',
          onchange: (e) => edit(it, { memo: e.target.value }, false)
        }),
        h('button', { type: 'button', class: 'rowbtn', 'aria-label': 'Details (자세히)', title: 'Details (자세히)', onclick: () => api.openForm(t.txn_id) }, icon('edit', 20)),
        h('button', {
          type: 'button', class: 'rowbtn del', 'aria-label': 'Delete (삭제)', title: 'Delete (삭제)',
          onclick: async () => {
            if (!window.confirm('Delete this transaction? (이 거래를 삭제할까요?)')) return;
            await sync.deleteTxn(t.txn_id);
            api.toast('Deleted (삭제됨)');
            await api.reload(); api.renderBody(true);
          }
        }, icon('trash', 20))));
    list.append(row);
  });

  const foot = rows.length > 8 ? h('div', { class: 'dp-foot' }, h('span', null, 'Total (합계)'), h('span', null, fmt(total))) : null;
  const panel = h('div', { class: 'dp', 'data-key': spec.key || '' }, h('div', { class: 'dp-grip' }), head, tot, tools, sel, list, foot);
  refreshSel();
  return panel;

  function rerender() { if (cur) mount(); }
}

// ───────── 이체 자동 연결 (js/xfermatch.js) ─────────

/** 이체로 보이는 거래 확인 창 (거래 탭 · 설정에서 엽니다) */
export function showTransferReview(api) {
  const sn = typeof document !== 'undefined' && document.getElementById('xf-snack');
  if (sn) sn.remove();   // 알림이 확인 창의 버튼을 가리지 않도록 (되돌리기는 창 아래 "연결된 이체"에서)
  show(api, { key: 'xfer-review', mode: 'xfer', title: 'Possible transfers (이체로 보이는 거래)', ids: [] });
}

// 자동/직접 연결된 이체, 또는 중복을 정리한 이체 → 표시 + 연결 풀기
function xferTag(it, dups) {
  const { api } = cur;
  const { h } = api;
  const info = X.linkInfo(it.txn, it.ps);
  if (!info && !(dups && dups.length)) return null;
  const keys = [];
  if (info) keys.push(info.key);
  (dups || []).forEach((d) => keys.push(X.pairKey(it.txn.txn_id, d.txn_id)));
  const label = info ? (info.auto ? 'Auto-linked (자동 연결됨)' : 'Linked (연결됨)') : 'Duplicate removed (중복 정리됨)';
  return h('div', { class: 'xf-tag' },
    h('span', { class: 'xf-badge' }, icon('transfer', 16), label),
    h('button', { type: 'button', class: 'xf-unlink', 'data-key': keys.join(','), onclick: () => doUnlink(keys) }, info ? 'Unlink (연결 풀기)' : 'Undo (되돌리기)'));
}

async function doUnlink(keys) {
  const { api } = cur;
  try {
    const n = await X.unlink(api, keys);
    await api.reload(); api.renderBody(true);
    if (cur) mount();
    api.toast(n ? 'Unlinked — back to two separate transactions (연결을 풀었어요 — 원래 두 거래로 돌아갔습니다)' : 'Nothing to unlink (풀 연결이 없습니다)');
  } catch (e) { api.toast('되돌리지 못했습니다: ' + (e.message || e)); }
}

function buildTransferReview() {
  const { api, spec } = cur;
  const { h, fmt, state } = api;
  const accMap = state.d.accMap;
  const pairs = X.pendingSuggestions(state.d.items, accMap, state.data.settings, state.data.stmtLines);
  const accName = (id) => { const a = accMap.get(String(id)); return a ? a.name : String(id || ''); };
  const desc = (t) => String(t.merchant || t.merchant_raw || t.memo || '').replace(X.MARKER, '').trim() || '—';
  const busy = (btn) => { btn.closest('.xf-card').classList.add('busy'); btn.closest('.xf-card').querySelectorAll('button').forEach((b) => { b.disabled = true; }); };
  const after = async (msg) => { await api.reload(); api.renderBody(true); if (cur) mount(); api.toast(msg); };

  const head = h('div', { class: 'dp-head' },
    h('div', { class: 'tt' }, h('h2', null, spec.title),
      h('div', { class: 'ss' }, pairs.length ? pairs.length + ' to check (확인할 거래 ' + pairs.length + '건)' : 'All clear (확인할 거래 없음)')),
    h('button', { type: 'button', class: 'icon', id: 'dp-close', 'aria-label': 'Close (닫기)', onclick: close }, icon('close', 22)));

  const auto = h('label', { class: 'xf-auto' },
    h('input', { type: 'checkbox', id: 'xf-auto', checked: X.isAutoMatchOn(), onchange: (e) => { X.setAutoMatchOn(e.target.checked); if (e.target.checked) X.autoMatch(api); mount(); } }),
    h('span', null, 'Link automatically when both sides arrive (양쪽이 들어오면 자동으로 연결)'));
  const intro = h('div', { class: 'xf-intro' },
    h('p', null, 'Same amount out of one account and into another within ' + X.WINDOW_DAYS + ' days. Linking makes it one transfer, so it is not spending or income. (같은 금액이 한 계좌에서 나가고 ' + X.WINDOW_DAYS + '일 안에 다른 계좌로 들어왔어요. 연결하면 이체 한 건이 되어 지출·수입에서 빠져요.)'),
    auto);

  const list = h('div', { class: 'dp-list xf-list', id: 'xf-list' }, intro);   // 설명은 목록과 함께 스크롤 (폰에서 목록 공간 확보)
  if (!pairs.length) list.append(h('div', { class: 'dp-empty' }, 'No possible transfers right now (지금은 이체로 보이는 거래가 없어요).'));

  const side = (lab, cls, it, acctId, sign, amt) => h('div', { class: 'xf-side ' + cls },
    h('span', { class: 'xf-lab' }, lab),
    h('div', { class: 'xf-main' },
      h('div', { class: 'xf-acct' }, accName(acctId)),
      h('div', { class: 'xf-desc' }, L.dayLabel(it.txn.date) + ' · ' + desc(it.txn))),
    h('span', { class: 'xf-amt ' + (sign < 0 ? 'neg' : 'pos') }, (sign < 0 ? '−' : '+') + fmt(amt)));

  pairs.forEach((p) => {
    const dup = p.type === 'duplicate';
    const daysTxt = p.days === 0 ? 'Same day (같은 날)' : p.days + ' day' + (p.days === 1 ? '' : 's') + ' apart (' + p.days + '일 차이)';
    const chips = h('div', { class: 'xf-why' }, p.reasons.map((r) => h('span', { class: 'xf-chip' + (r === 'ambiguous' ? ' warn' : '') }, X.REASONS[r] || r)));
    let sides;
    if (dup) {
      const dupAcct = p.acct;
      const sgn = L.num((p.b.ps.find((x) => String(x.account_id) === String(dupAcct)) || {}).amount_cad);
      sides = [
        h('div', { class: 'xf-side xf-t' }, h('span', { class: 'xf-lab' }, 'Transfer (이체)'),
          h('div', { class: 'xf-main' }, h('div', { class: 'xf-acct' }, accName(p.fromAcct) + ' → ' + accName(p.toAcct)), h('div', { class: 'xf-desc' }, L.dayLabel(p.a.txn.date) + ' · ' + desc(p.a.txn))),
          h('span', { class: 'xf-amt' }, fmt(p.amount))),
        side('Duplicate (중복)', 'xf-d', p.b, dupAcct, sgn < 0 ? -1 : 1, p.amount)];
    } else {
      sides = [side('Out (나감)', 'xf-o', p.from, p.fromAcct, -1, p.amount), side('In (들어옴)', 'xf-i', p.to, p.toAcct, 1, p.amount)];
    }
    list.append(h('div', { class: 'xf-card', 'data-key': p.key, 'data-type': p.type },
      h('div', { class: 'xf-top' }, h('b', { class: 'xf-total' }, fmt(p.amount)), h('span', { class: 'xf-days' }, daysTxt)),
      dup ? h('p', { class: 'xf-note' }, 'This looks like the other side of a transfer you already have. Remove the extra copy? (이미 있는 이체의 반대쪽과 같아 보여요. 중복을 지울까요?)') : null,
      sides, chips,
      h('div', { class: 'xf-btns' },
        h('button', {
          type: 'button', class: 'btn xf-link', onclick: async (e) => {
            busy(e.currentTarget);
            try { await X.linkPair(api, p); await after(dup ? 'Duplicate removed (중복을 지웠어요)' : 'Linked as a transfer (이체로 연결했어요)'); } catch (err) { api.toast('저장하지 못했습니다: ' + (err.message || err)); mount(); }
          }
        }, icon(dup ? 'trash' : 'transfer', 18), dup ? 'Remove duplicate (중복 지우기)' : 'Link as transfer (이체로 연결)'),
        h('button', {
          type: 'button', class: 'btn secondary xf-reject', onclick: async (e) => {
            busy(e.currentTarget);
            try { await X.rejectPair(api, p); await after('OK — kept separate (따로 두었어요)'); } catch (err) { api.toast('저장하지 못했습니다: ' + (err.message || err)); mount(); }
          }
        }, dup ? 'Keep both (둘 다 두기)' : 'Not a transfer (이체 아님)'))));
  });

  // 최근 연결된 이체 (되돌리기)
  const absorbed = X.absorbedMap(state.data.txns);
  const linked = state.d.items.filter((it) => it.desc.kind === 'TRANSFER' && (X.linkInfo(it.txn, it.ps) || absorbed.has(String(it.txn.txn_id)))).slice(0, 40);
  if (linked.length) {
    list.append(h('h3', { class: 'xf-sect' }, 'Linked transfers (연결된 이체) · ' + linked.length));
    linked.forEach((it) => list.append(h('div', { class: 'xf-row', 'data-id': it.txn.txn_id },
      h('div', { class: 'xf-main' },
        h('div', { class: 'xf-acct' }, (it.desc.fromName || '') + ' → ' + (it.desc.toName || '')),
        h('div', { class: 'xf-desc' }, L.dayLabel(it.txn.date) + ' · ' + desc(Object.assign({}, it.txn, { merchant: it.txn.merchant_raw || it.txn.merchant }))),
        xferTag(it, absorbed.get(String(it.txn.txn_id)))),
      h('span', { class: 'xf-amt' }, fmt(Math.abs(L.num(it.txn.total_cad)))))));
  }
  return h('div', { class: 'dp xf-review', 'data-key': spec.key }, h('div', { class: 'dp-grip' }), head, list);
}

// 나눈 거래: 줄마다 카테고리 · 소유자 · 메모 · 금액 (이 상세에 해당하는 줄은 굵게)
function splitList(it, spec, fmt, h) {
  const ids = new Set((spec.ids || []).map(String));
  const ccy = it.txn.currency || 'CAD';
  return h('ul', { class: 'dr-split', 'aria-label': L.SPLIT_LABEL(it.desc.split) },
    it.desc.lines.map((l) => h('li', { class: ids.has(l.accountId) ? 'hit' : '' },
      h('span', { class: 'n' }, l.name),
      h('span', { class: 'o' }, [L.ownerLabel(l.owner || it.txn.owner || 'Joint'), l.memo].filter(Boolean).join(' · ')),
      h('span', { class: 'a' }, (l.cad < 0 ? '−' : '') + fmt(Math.abs(l.cad)) + (ccy !== 'CAD' ? ' (' + fmt(Math.abs(l.orig), ccy) + ')' : '')))));
}

async function edit(it, patch, askRemember) {
  const { api } = cur;
  const { state } = api;
  const f = L.formFromTxn(it.txn, it.ps, state.d.accMap);
  Object.assign(f, patch);
  const res = L.makeRecords(f, { accMap: state.d.accMap, rules: state.data.rules, existing: it, now: L.nowIso() });
  if (res.error) { api.toast(res.error); mount(); return; }
  const cand = res.rule; res.rule = null;
  const prev = cand ? L.suggestRule(state.data.rules, res.txn.merchant) : null;
  const ask = askRemember && cand && !(prev && String(prev.account_id) === String(cand.account_id))
    ? [{ merchant: res.txn.merchant, accountId: String(cand.account_id), previousAccountId: prev ? String(prev.account_id) : '' }] : [];
  try {
    await sync.saveRecords(res);
    await api.reload();
    api.renderBody(true);
    api.toast('Saved (저장됨)');
    if (ask.length) await openRemember({ h: api.h, toast: api.toast, accMap: api.state.d.accMap, data: api.state.data, reload: api.reload }, ask);
  } catch (e) {
    api.toast('저장하지 못했습니다: ' + (e.message || e));
  }
}

function mount() {
  if (!cur) return;
  const panel = build();
  const oldList = document.querySelector('#dp-list');
  const top = oldList ? oldList.scrollTop : 0;
  const lay = layoutOf();
  const dr = document.getElementById('drawer');
  if (lay === 'tablet' && dock && dock.el.isConnected) {
    dr.hidden = true;
    dock.el.replaceChildren(panel);
    document.body.classList.remove('noscroll');
  } else {
    const host = document.getElementById('drawer-panel');
    host.replaceChildren(panel);
    dr.hidden = false;
    const scrim = document.getElementById('drawer-scrim');
    scrim.onclick = close;
    if (lay === 'phone') document.body.classList.add('noscroll');
  }
  const nl = document.querySelector('#dp-list');
  if (nl && top) nl.scrollTop = top;
}
