// 영수증 화면: 사진 선택 → 인식 중 → 확인/수정 → 저장
import { CONFIG } from './config.js';
import * as L from './ledger.js';
import * as R from './receipts.js';
import * as sync from './sync.js';
import * as auth from './auth.js';
import { openRemember } from './rememberui.js';
import * as RV from './receiptview.js';
import { icon } from './icons.js';

const $ = (id) => document.getElementById(id);

// api = { h, toast, state, fmt, reload, renderBody }
export function openScan(api) {
  const { h } = api;
  const ov = $('overlay');
  ov.hidden = false;
  document.body.classList.add('noscroll');
  const close = () => { ov.hidden = true; ov.replaceChildren(); document.body.classList.remove('noscroll'); };
  const shell = (title, ...body) => h('div', { class: 'backdrop' },
    h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Receipt' },
      h('div', { class: 'sheet-head' }, h('h2', null, title),
        h('button', { type: 'button', class: 'icon', 'aria-label': 'Close (닫기)', onclick: close }, '✕')),
      body));
  const show = (node) => ov.replaceChildren(node);

  function pick() {
    const err = h('div', { class: 'err', id: 'rc-err', role: 'alert' });
    const onFile = (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) run(file);
    };
    const cam = h('input', { type: 'file', accept: 'image/*', capture: 'environment', id: 'rc-cam', hidden: true, onchange: onFile });
    const lib = h('input', { type: 'file', accept: 'image/*,application/pdf', id: 'rc-file', hidden: true, onchange: onFile });
    const ready = R.apiConfigured();
    const signedIn = !!auth.getToken();
    if (!ready) err.textContent = '영수증 서버 주소가 설정되지 않았습니다. (config.js 의 RECEIPT_API_URL)';
    else if (!signedIn) err.textContent = '먼저 로그인하세요. (상단의 로그인 버튼)';
    show(shell('Scan receipt (영수증 스캔)',
      h('p', { class: 'hint' }, 'Take a photo or choose a file. AI reads items and tax, then you confirm. (사진을 찍거나 파일을 고르면 항목과 세금을 읽어 줍니다. 확인 후 저장하세요.)'),
      h('div', { class: 'btnrow' },
        h('button', { type: 'button', class: 'btn', id: 'rc-take', disabled: !ready || !signedIn, onclick: () => cam.click() }, 'Take photo (사진 찍기)'),
        h('button', { type: 'button', class: 'btn secondary', id: 'rc-choose', disabled: !ready || !signedIn, onclick: () => lib.click() }, 'Choose file (파일 선택)')),
      cam, lib, err,
      h('div', { class: 'hint' }, 'Only the receipt image is sent for reading — never card numbers or statements. (영수증 이미지만 전송됩니다. 카드번호·명세서는 보내지 않습니다.)')));
  }

  function failure(msg, retry) {
    show(shell('Scan receipt (영수증 스캔)',
      h('div', { class: 'err', id: 'rc-err', role: 'alert' }, msg),
      h('div', { class: 'btnrow' },
        h('button', { type: 'button', class: 'btn', id: 'rc-retry', onclick: retry || pick }, 'Try again (다시 시도)'),
        h('button', { type: 'button', class: 'btn secondary', onclick: close }, 'Close (닫기)'))));
  }

  // 진행 화면: 사진 미리보기와 단계 표시 (기다리는 시간이 짧게 느껴지도록)
  function busy(stage, preview) {
    const steps = [['prep', 'Photo (사진 준비)'], ['read', 'Reading (영수증 읽기)'], ['check', 'Check (확인)']];
    const at = stage === 'prep' ? 0 : 1;
    show(shell('Reading… (읽는 중)',
      h('div', { class: 'rc-busy', id: 'rc-busy' },
        preview ? h('img', { class: 'rc-prev', src: preview, alt: '' }) : h('div', { class: 'rc-prev rc-prev-empty' }),
        h('div', { class: 'rc-steps' }, steps.map((st, i) => h('div', { class: 'rc-step' + (i < at ? ' done' : i === at ? ' now' : '') }, (i < at ? '✓ ' : '') + st[1]))),
        h('div', { class: 'rc-skel' }, h('i'), h('i'), h('i'), h('i')))));
  }

  async function run(file) {
    let preview = '';
    try { preview = URL.createObjectURL(file); } catch (e) { /* 미리보기는 없어도 됨 */ }
    busy('prep', preview);
    let img;
    try { img = await R.prepareImage(file); } catch (e) { failure(e.message || String(e), pick); return; }
    img.preview = img.thumb || preview;
    // 같은 사진인지 서버를 부르기 전에 확인 → 즉시 알려 주고, 무료 사용량도 아낍니다.
    const dup = R.findDuplicate(api.state.data.receipts, api.state.data.txns, img.sha256);
    if (dup) duplicate(dup, img); else go(img);
  }

  async function go(img) {
    busy('read', img.preview);
    // 드라이브 보관은 읽기와 동시에 보냅니다.
    const stored = R.storeReceipt(img).catch((e) => ({ driveError: e.message || String(e) }));
    const t0 = Date.now();
    try {
      const cats = api.state.data.accounts.filter((a) => L.isActive(a) && a.type === 'EXPENSE').map((a) => ({ id: String(a.account_id), name: a.name }));
      const res = await R.parseReceipt(img, cats);
      const parsed = res.parsed || {};
      const meta = {
        drive: null, driveError: '', driveDone: false, sha256: img.sha256 || '', model: res.model || '', mime: img.mime,
        fileName: img.fileName, confidence: parsed.confidence, parsedJson: JSON.stringify(parsed),
        b64: img.base64, ms: Date.now() - t0, scanned: !!img.scanned    // b64: 저장하면 이 기기에도 넣어 둠 (바로 다시 볼 수 있게, 시트에는 안 들어감)
      };
      meta.stored = stored.then((r) => {
        meta.drive = r.drive || null; meta.driveError = r.driveError || ''; meta.driveDone = true;
        if (!meta.sha256 && r.sha256) meta.sha256 = r.sha256;
        return meta;
      });
      let fromId = '';
      try { fromId = localStorage.getItem('hl_last_from') || ''; } catch (e) { /* ignore */ }
      if (!api.state.d.accMap.has(String(fromId))) fromId = '';
      review(R.draftFromParsed(parsed, img, meta, { accMap: api.state.d.accMap, rules: api.state.data.rules, taxCodes: api.state.data.taxCodes, fromId }));
    } catch (e) {
      failure(e.message || String(e), pick);
    }
  }

  function duplicate(dup, img) {
    show(shell('Already saved? (이미 저장됨?)',
      h('div', { class: 'card warn-card', id: 'rc-dup' }, 'This same photo was saved on ' + dup.txn.date + ' as "' + (dup.txn.merchant || '') + '" (' + api.fmt(L.num(dup.txn.total_cad)) + '). 같은 사진이 이미 저장되어 있습니다.'),
      h('div', { class: 'btnrow' },
        h('button', { type: 'button', class: 'btn', id: 'rc-open-dup', onclick: () => { close(); openEdit(api, dup.txn.txn_id); } }, 'Open saved one (저장된 거래 열기)'),
        h('button', { type: 'button', class: 'btn secondary', id: 'rc-anyway', onclick: () => go(img) }, 'Save again anyway (그래도 새로 저장)'))));
  }

  function review(draft) { openReview(api, draft, close, show, shell); }

  pick();
  R.warmUp();
}

export function openEdit(api, txnId) {
  const d = api.state.d, data = api.state.data;
  const it = d.itemById.get(String(txnId));
  if (!it) return;
  const lineItems = data.lineItems.filter((l) => String(l.txn_id) === String(txnId));
  const receipt = data.receipts.find((r) => String(r.receipt_id) === String(it.txn.receipt_id) && !L.truthy(r.deleted)) || null;
  const draft = R.draftFromExisting(it.txn, { accMap: d.accMap, postings: it.ps, lineItems, receipt });
  draft._existing = { txn: it.txn, ps: data.postings.filter((p) => String(p.txn_id) === String(txnId)), lineItems, receipt };
  const { h } = api;
  const ov = $('overlay');
  ov.hidden = false;
  document.body.classList.add('noscroll');
  const close = () => { ov.hidden = true; ov.replaceChildren(); document.body.classList.remove('noscroll'); };
  const shell = (title, ...body) => h('div', { class: 'backdrop' },
    h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Receipt' },
      h('div', { class: 'sheet-head' }, h('h2', null, title),
        h('button', { type: 'button', class: 'icon', 'aria-label': 'Close (닫기)', onclick: close }, '✕')),
      body));
  openReview(api, draft, close, (node) => ov.replaceChildren(node), shell);
}

export function isReceiptTxn(state, txnId) {
  const it = state.d.itemById.get(String(txnId));
  if (!it || !it.txn.receipt_id) return false;
  return state.data.lineItems.some((l) => String(l.txn_id) === String(txnId) && !L.truthy(l.deleted));
}

function openReview(api, draft, close, show, shell) {
  const { h, fmt } = api;
  const data = api.state.data, d = api.state.d;
  const editing = !!draft._existing;
  let saving = false;
  const accounts = data.accounts.filter(L.isActive);
  const money = accounts.filter(L.isMoneyAccount);
  const taxCodes = data.taxCodes;
  const mkOpt = (sel) => (a) => h('option', { value: a.account_id, selected: String(a.account_id) === String(sel) }, L.accLabel(a));
  const blank = () => h('option', { value: '' }, 'Select… (선택)');
  const moneyOptions = (sel) => [blank(),
    h('optgroup', { label: 'Assets (자산)' }, money.filter((a) => a.type === 'ASSET').map(mkOpt(sel))),
    h('optgroup', { label: 'Credit & loans (카드 · 대출)' }, money.filter((a) => a.type === 'LIABILITY').map(mkOpt(sel)))];
  const catOptions = (sel) => {
    const groups = new Map();
    accounts.filter((a) => a.type === 'EXPENSE').forEach((a) => {
      const g = a.report_group || '확인 필요';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(a);
    });
    const keys = L.GROUP_ORDER.filter((g) => groups.has(g)).concat(Array.from(groups.keys()).filter((g) => L.GROUP_ORDER.indexOf(g) < 0));
    return [blank()].concat(keys.map((g) => h('optgroup', { label: L.GROUP_LABELS[g] || g }, groups.get(g).map(mkOpt(sel)))));
  };
  const taxOptions = (sel) => [h('option', { value: '' }, 'Tax? (세금 종류)')].concat(R.TAX_OPTIONS.map((c) => h('option', { value: c, selected: c === sel }, c)));
  const field = (label, control, hint) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), control, hint || null);
  let errEl = null;

  function draw() { show(build()); }

  function build() {
    const ccy = draft.currency;
    const dec = L.decimals(ccy);
    const sumEl = h('div', { class: 'rc-sum', id: 'rc-sum' });
    const updateSum = () => {
      const al = R.computeAllocation(draft, taxCodes);
      const parts = [
        h('div', { class: 'rc-line' }, h('span', null, 'Items (항목 합계)'), h('span', null, fmt(al.subtotal, ccy))),
        h('div', { class: 'rc-line' }, h('span', null, 'Tax (세금)'), h('span', null, fmt(al.taxApplied, ccy))),
        al.tip ? h('div', { class: 'rc-line' }, h('span', null, 'Tip (팁)'), h('span', null, fmt(al.tip, ccy))) : null,
        h('div', { class: 'rc-line strong' }, h('span', null, 'Computed (계산 합계)'), h('span', null, fmt(al.computedTotal, ccy))),
        h('div', { class: 'rc-line strong' }, h('span', null, 'Receipt total (영수증 총액)'), h('span', null, al.total ? fmt(al.total, ccy) : '—'))
      ];
      sumEl.replaceChildren(...parts.filter(Boolean));
      if (al.total && Math.abs(al.diff) >= 0.005) {
        sumEl.append(h('div', { class: 'err', id: 'rc-diff', role: 'alert' }, 'Off by ' + fmt(Math.abs(al.diff), ccy) + (al.diff > 0 ? ' (items too low · 항목이 모자람)' : ' (items too high · 항목이 많음)')),
          h('button', { type: 'button', class: 'btn secondary', id: 'rc-adjust', onclick: () => { R.addAdjustment(draft, taxCodes); draw(); } }, 'Add adjustment line (조정 항목 추가)'));
      } else if (al.total && !al.errors.length) {
        sumEl.append(h('div', { class: 'hint ok-hint', id: 'rc-ok' }, '✓ Matches the receipt total (영수증 총액과 일치)'));
      }
    };

    const itemCard = (it, idx) => {
      const del = h('button', { type: 'button', class: 'icon rc-del', 'aria-label': 'Remove item (항목 삭제)', onclick: () => { draft.items.splice(idx, 1); draw(); } }, '✕');
      const upd = () => updateSum();
      return h('div', { class: 'card rc-item' + (it.is_discount ? ' disc' : ''), 'data-idx': idx },
        h('div', { class: 'rc-item-top' },
          h('input', { type: 'text', class: 'rc-name', 'aria-label': 'Item name (품명)', value: it.name, placeholder: 'Item (품명)', autocomplete: 'off', oninput: (e) => { it.name = e.target.value; } }),
          h('input', { type: 'text', class: 'rc-amt', 'aria-label': 'Amount (금액)', inputmode: 'decimal', value: it.amountText, placeholder: '0.00', autocomplete: 'off',
            oninput: (e) => { it.amountText = e.target.value; upd(); } }),
          del),
        h('div', { class: 'rc-item-bot' },
          h('select', { class: 'rc-cat', 'aria-label': 'Category (카테고리)', onchange: (e) => { it.category_id = e.target.value; } }, catOptions(it.category_id)),
          ccy === 'CAD' ? h('select', { class: 'rc-tax', 'aria-label': 'Tax (세금)', onchange: (e) => { it.tax_code = e.target.value; upd(); } }, taxOptions(it.tax_code)) : null),
        h('label', { class: 'check rc-disc' },
          h('input', { type: 'checkbox', checked: it.is_discount, onchange: (e) => { it.is_discount = e.target.checked; draw(); } }),
          h('span', null, 'Discount / coupon — subtract (할인 · 쿠폰: 금액 차감)')));
    };

    const rows = [];
    if (draft.thumb) {
      // 썸네일을 누르면 방금 만든 스캔본을 크게 볼 수 있어요 (저장하기 전에 사진이 잘 나왔는지 확인)
      const big = draft.meta && draft.meta.b64 ? { b64: draft.meta.b64, mime: draft.meta.mime } : null;
      rows.push(big
        ? h('button', { type: 'button', class: 'rc-thumb-btn', id: 'rc-thumb', 'aria-label': 'View scan (스캔본 크게 보기)', onclick: () => RV.openViewer(api, { title: 'Scan preview (스캔 미리보기)', sub: draft.merchant || '', local: big, fileName: draft.meta.fileName }) },
          h('img', { class: 'rc-thumb', src: draft.thumb, alt: 'receipt', width: 60, height: 80 }))
        : h('img', { class: 'rc-thumb', src: draft.thumb, alt: 'receipt', width: 60, height: 80 }));
    } else if (editing && draft.meta && draft.meta.drive && draft.meta.drive.fileId) {
      rows.push(h('button', { type: 'button', class: 'txf-receipt wide', id: 'rc-view', onclick: () => RV.openViewer(api, {
        title: draft.merchant || 'Receipt (영수증)', sub: draft.date, fileId: draft.meta.drive.fileId, fileName: draft.meta.drive.fileName
      }) }, icon('camera', 18), h('span', null, 'View receipt (영수증 보기)'), draft.meta.drive.fileName ? h('span', { class: 'txf-fn' }, draft.meta.drive.fileName) : null, icon('right', 16)));
    }
    if (!editing && draft.meta && typeof draft.meta.ms === 'number') {
      const sec = (draft.meta.ms / 1000).toFixed(1);
      rows.push(h('div', { class: 'hint rc-took', id: 'rc-took' }, 'Read in ' + sec + ' s' + (draft.meta.model ? ' · ' + draft.meta.model : '') + (draft.meta.scanned ? ' · scan (스캔본)' : '') + ' (읽는 데 ' + sec + '초). Too slow? Pick another model in Settings → AI model (느리면 설정 → AI 모델에서 바꿔 보세요).'));
    }
    if (draft.meta && draft.meta.driveError) rows.push(h('div', { class: 'note' }, 'Photo was not saved to Drive (사진은 드라이브에 저장되지 않았습니다): ' + draft.meta.driveError));
    (draft.warnings || []).forEach((w) => rows.push(h('div', { class: 'card warn-card rc-warn' }, '⚠ ' + w)));
    if (draft.notes) rows.push(h('div', { class: 'note' }, draft.notes));

    rows.push(field('Merchant (가맹점)', h('input', { type: 'text', id: 'rc-merchant', value: draft.merchant, autocomplete: 'off', oninput: (e) => { draft.merchant = e.target.value; } })));
    rows.push(h('div', { class: 'two' },
      field('Date (날짜)', h('input', { type: 'date', id: 'rc-date', value: draft.date, onchange: (e) => { draft.date = e.target.value; } })),
      field('Currency (통화)', h('select', { id: 'rc-ccy', onchange: (e) => { draft.currency = e.target.value; if (draft.currency !== 'CAD') draft.items.forEach((i) => { i.tax_code = ''; }); draw(); } },
        CONFIG.CURRENCIES.map((c) => h('option', { value: c, selected: c === ccy }, c))))));
    rows.push(field('Paid from (결제 계좌)', h('select', { id: 'rc-from', onchange: (e) => {
      draft.fromId = e.target.value;
      const a = d.accMap.get(String(draft.fromId));
      // 소유자는 기본 Joint (계좌 소유자로 바꾸지 않음)
    } }, moneyOptions(draft.fromId))));
    rows.push(field('Owner (소유자)', h('select', { id: 'rc-owner', onchange: (e) => { draft.owner = e.target.value; } },
      CONFIG.OWNERS.map((o) => h('option', { value: o, selected: o === draft.owner }, L.ownerLabel(o))))));

    rows.push(h('h2', { class: 'sect' }, 'Items (항목) · ' + draft.items.length));
    draft.items.forEach((it, i) => rows.push(itemCard(it, i)));
    rows.push(h('button', { type: 'button', class: 'btn secondary', id: 'rc-additem', onclick: () => {
      const last = draft.items[draft.items.length - 1];
      draft.items.push(R.newItem({ category_id: last ? last.category_id : '', tax_code: ccy === 'CAD' && last ? last.tax_code : '' }));
      draw();
    } }, '+ Add item (항목 추가)'));

    rows.push(h('h2', { class: 'sect' }, 'Totals (합계)'));
    rows.push(h('div', { class: 'two' },
      field('Tax on receipt (영수증 세금)', h('input', { type: 'text', id: 'rc-tax', inputmode: 'decimal', value: draft.taxText, placeholder: '0.00', autocomplete: 'off', oninput: (e) => { draft.taxText = e.target.value; updateSum(); } })),
      field('Tip (팁)', h('input', { type: 'text', id: 'rc-tip', inputmode: 'decimal', value: draft.tipText, placeholder: '0.00', autocomplete: 'off', oninput: (e) => { draft.tipText = e.target.value; updateSum(); } }))));
    rows.push(field('Receipt total (영수증 총액)', h('input', { type: 'text', id: 'rc-total', inputmode: 'decimal', value: draft.totalText, placeholder: '0.00', autocomplete: 'off', oninput: (e) => { draft.totalText = e.target.value; updateSum(); } })));
    if (ccy !== 'CAD') {
      rows.push(h('div', { class: 'two' },
        field('CAD charged (CAD 청구액)', h('input', { type: 'text', id: 'rc-cad', inputmode: 'decimal', value: draft.cadText, autocomplete: 'off', oninput: (e) => { draft.cadText = e.target.value; } })),
        field('FX rate (환율)', h('input', { type: 'text', id: 'rc-rate', inputmode: 'decimal', value: draft.rateText, placeholder: 'CAD per 1 ' + ccy, autocomplete: 'off', oninput: (e) => { draft.rateText = e.target.value; } }))));
    }
    rows.push(sumEl);
    updateSum();

    errEl = h('div', { class: 'err', id: 'rc-save-err', role: 'alert' });
    rows.push(errEl);
    rows.push(h('div', { class: 'btnrow' },
      h('button', { type: 'button', class: 'btn', id: 'rc-save', onclick: onSave }, 'Save (저장)'),
      h('button', { type: 'button', class: 'btn secondary', onclick: close }, 'Cancel (취소)'),
      editing ? h('button', { type: 'button', class: 'btn danger', id: 'rc-del-txn', onclick: async () => {
        if (!window.confirm('Delete this transaction? (이 거래를 삭제할까요?)')) return;
        await sync.deleteTxn(draft._existing.txn.txn_id);
        close(); api.toast('Deleted (삭제됨)'); await api.reload(); api.renderBody(true);
      } }, 'Delete (삭제)') : null));
    return shell(editing ? 'Edit receipt (영수증 수정)' : 'Check receipt (영수증 확인)', rows);
  }

  async function onSave() {
    if (saving) return;
    const pre = R.makeReceiptRecords(draft, { accMap: d.accMap, taxCodes, rules: data.rules, existing: draft._existing || null, now: L.nowIso() });
    if (pre.error) { errEl.textContent = pre.error; return; }
    saving = true;
    const btn = $('rc-save');
    if (btn) btn.disabled = true;
    try {
      // 사진 보관이 아직 끝나지 않았으면 잠깐(최대 20초) 기다렸다가 파일 정보를 함께 저장합니다.
      if (draft.meta && draft.meta.stored && !draft.meta.driveDone) {
        errEl.textContent = 'Finishing photo upload… (사진 보관 마무리 중)';
        await Promise.race([draft.meta.stored, new Promise((r) => setTimeout(r, 20000))]);
        errEl.textContent = '';
      }
      const res = R.makeReceiptRecords(draft, { accMap: d.accMap, taxCodes, rules: data.rules, existing: draft._existing || null, now: L.nowIso() });
      if (res.error) { saving = false; if (btn) btn.disabled = false; errEl.textContent = res.error; return; }
      const puts = { Transactions: [res.txn], Postings: res.postings, LineItems: res.lineItems };
      const order = ['Receipts', 'LineItems', 'Postings', 'Transactions'];
      if (res.receipt) puts.Receipts = [res.receipt];
      await sync.saveBatch(puts, order);
      if (res.receipt && res.receipt.drive_file_id && draft.meta && draft.meta.b64) { try { await RV.cachePut(res.receipt.drive_file_id, draft.meta.mime, draft.meta.b64); } catch (e) { /* 못 넣어도 저장은 완료 */ } }
      if (draft.fromId) { try { localStorage.setItem('hl_last_from', draft.fromId); } catch (e) { /* ignore */ } }
      if (res.txn.date && L.monthOf(res.txn.date) !== api.state.month && !api.state.query) api.state.month = L.monthOf(res.txn.date);
      close();
      api.toast(auth.getToken() ? 'Saved (저장됨)' : 'Saved offline — will upload after sign-in (오프라인 저장, 로그인 후 전송)');
      await api.reload();
      api.renderBody(true);
      const cur = res.rule ? L.suggestRule(data.rules, res.txn.merchant) : null;
      if (!editing && res.rule && !(cur && String(cur.account_id) === String(res.rule.account_id))) {
        await openRemember({ h, toast: api.toast, accMap: d.accMap, data: api.state.data, reload: api.reload },
          [{ merchant: res.txn.merchant, accountId: String(res.rule.account_id), previousAccountId: cur ? String(cur.account_id) : '' }]);
      }
    } catch (e) {
      saving = false;
      if (btn) btn.disabled = false;
      errEl.textContent = '저장하지 못했습니다: ' + (e.message || e);
    }
  }

  draw();
}
