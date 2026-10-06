// 영수증 사진 다시 보기 · 기존 거래에 사진 붙이기.
//  · 사진은 구글 드라이브의 "Home Ledger Receipts" 폴더에 있고, 앱은 Apps Script 서버(v5 getReceipt)를 통해 가져옵니다.
//  · 한 번 본 사진은 이 기기(IndexedDB)에 최근 40장까지 저장해 두어서, 다음부터는 바로 (인터넷 없이도) 열립니다.
//  · 방금 찍은 영수증은 저장하는 순간 같은 곳에 넣어 두므로 바로 볼 수 있습니다.
import * as L from './ledger.js';
import * as R from './receipts.js';
import { getMeta, setMeta, openDB } from './store.js';
import { icon } from './icons.js';

const PREFIX = 'rcimg:';
const INDEX_KEY = 'rcimg-index';
export const MAX_CACHED = 40;
const ZOOMS = [1, 1.7, 2.6, 4];
const $ = (id) => document.getElementById(id);

export const driveUrl = (fileId) => 'https://drive.google.com/file/d/' + encodeURIComponent(fileId) + '/view';

// ───────── 이 기기에 저장해 둔 사진 ─────────

export async function cacheGet(fileId) {
  try {
    const rec = await getMeta(PREFIX + fileId);
    return rec && rec.b64 ? rec : null;
  } catch (e) { return null; }
}

/** 최근에 쓴 순서로 최대 MAX_CACHED 장 보관 (넘으면 오래된 것부터 지움) */
export async function cachePut(fileId, mime, b64) {
  if (!fileId || !b64) return false;
  try {
    await setMeta(PREFIX + fileId, { mime: mime || 'image/jpeg', b64, at: Date.now() });
    let idx = [];
    try { idx = (await getMeta(INDEX_KEY)) || []; } catch (e) { idx = []; }
    idx = idx.filter((x) => x !== fileId);
    idx.push(fileId);
    while (idx.length > MAX_CACHED) {
      const old = idx.shift();
      try {
        const db = await openDB();
        await new Promise((res, rej) => { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').delete(PREFIX + old); tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
      } catch (e) { /* 못 지워도 목록에서는 뺌 */ }
    }
    await setMeta(INDEX_KEY, idx);
    return true;
  } catch (e) { return false; }
}

export async function cacheClear() {
  let n = 0;
  try {
    const idx = (await getMeta(INDEX_KEY)) || [];
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction('meta', 'readwrite');
      const os = tx.objectStore('meta');
      idx.forEach((id) => { os.delete(PREFIX + id); n++; });
      os.delete(INDEX_KEY);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
  } catch (e) { /* 무시 */ }
  return n;
}
export async function cacheCount() { try { return ((await getMeta(INDEX_KEY)) || []).length; } catch (e) { return 0; } }

// ───────── 가져오기 ─────────

/** 거래 → 영수증 행(드라이브 파일이 있는 것) 또는 null */
export function receiptOf(data, txn) {
  if (!txn || !txn.receipt_id) return null;
  const r = (data.receipts || []).find((x) => String(x.receipt_id) === String(txn.receipt_id) && !L.truthy(x.deleted));
  return r && r.drive_file_id ? r : null;
}

/** 영수증이 있는 거래 번호들의 집합 (거래 목록에 아이콘을 붙일 때) */
export function receiptTxnIds(data) {
  const ids = new Set();
  const live = new Set((data.txns || []).filter((t) => !L.truthy(t.deleted)).map((t) => String(t.txn_id)));
  (data.receipts || []).forEach((r) => { if (!L.truthy(r.deleted) && r.drive_file_id && live.has(String(r.txn_id))) ids.add(String(r.txn_id)); });
  return ids;
}

const b64ToBlob = (b64, mime) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'image/jpeg' });
};

/** 사진 가져오기: 이 기기에 있으면 바로, 없으면 서버에서. → { b64, mime, fromCache } */
export async function loadReceipt(fileId, opts) {
  const hit = await cacheGet(fileId);
  if (hit && !(opts && opts.refresh)) return { b64: hit.b64, mime: hit.mime, fromCache: true };
  const call = (opts && opts.callApi) || R.callApi;
  let res;
  try { res = await call({ action: 'getReceipt', fileId }); } catch (e) {
    if (hit) return { b64: hit.b64, mime: hit.mime, fromCache: true };
    const m = String((e && e.message) || e);
    if (/알 수 없는 요청/.test(m)) { const err = new Error('서버가 아직 "영수증 보기"를 지원하지 않습니다. Apps Script 를 새 버전(v5)으로 다시 배포하세요.'); err.code = 'outdated'; throw err; }
    throw e;
  }
  if (!res.image) throw new Error('서버가 사진을 보내지 않았습니다.');
  await cachePut(fileId, res.mime, res.image);
  return { b64: res.image, mime: res.mime || 'image/jpeg', fromCache: false };
}

// ───────── 보기 창 ─────────

// 보기 창은 #overlay 가 아니라 따로 만든 층에 띄웁니다. 거래 입력창이나 영수증 확인창 위에 떠도 그 창의 입력 내용이 지워지지 않게.
function mountHost() {
  const el = document.createElement('div');
  el.className = 'rv-host';
  document.body.append(el);
  const wasLocked = document.body.classList.contains('noscroll');
  document.body.classList.add('noscroll');
  return { el, remove() { el.remove(); if (!wasLocked) document.body.classList.remove('noscroll'); } };
}

let openUrl = '';
function revoke() { if (openUrl) { try { URL.revokeObjectURL(openUrl); } catch (e) { /* 무시 */ } openUrl = ''; } }

/**
 * 영수증 보기 창.
 *  spec = { title, sub, fileId?, local?: { b64, mime }, fileName?, onReplace?: fn }
 *  fileId 가 있으면 가져오고, local 이 있으면 (아직 저장 전의) 그 사진을 그대로 보여줍니다.
 */
export function openViewer(api, spec) {
  const { h } = api;
  const host = mountHost();
  let zoom = 0;
  let dead = false;
  const close = () => { if (dead) return; dead = true; revoke(); host.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);

  const stage = h('div', { class: 'rv-stage', id: 'rv-stage' }, h('div', { class: 'rv-load', id: 'rv-load' }, h('div', { class: 'rv-spin' }), h('div', null, 'Loading receipt… (영수증 불러오는 중)')));
  const bar = h('div', { class: 'rv-bar', id: 'rv-bar' });
  const drive = spec.fileId ? h('a', { class: 'btn secondary rv-drive', id: 'rv-drive', href: driveUrl(spec.fileId), target: '_blank', rel: 'noopener' }, icon('open', 18), 'Open in Drive (드라이브에서 열기)') : null;

  host.el.replaceChildren(h('div', { class: 'backdrop', onclick: (e) => { if (e.target === e.currentTarget) close(); } },
    h('div', { class: 'sheet rv-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Receipt (영수증)' },
      h('div', { class: 'sheet-head' },
        h('div', { class: 'rv-tt' }, h('h2', null, spec.title || 'Receipt (영수증)'), spec.sub ? h('div', { class: 'rv-sub' }, spec.sub) : null),
        h('button', { type: 'button', class: 'icon', id: 'rv-close', 'aria-label': 'Close (닫기)', onclick: close }, '✕')),
      stage, bar)));

  const showError = (msg) => {
    stage.replaceChildren(h('div', { class: 'rv-err', id: 'rv-err', role: 'alert' }, h('div', null, msg),
      h('div', { class: 'btnrow' },
        h('button', { type: 'button', class: 'btn', id: 'rv-retry', onclick: () => start(true) }, 'Try again (다시 시도)'),
        drive)));
    bar.replaceChildren();
  };

  function paint(b64, mime) {
    revoke();
    const blob = b64ToBlob(b64, mime);
    openUrl = URL.createObjectURL(blob);
    if (/pdf/i.test(mime || '')) {
      stage.replaceChildren(h('div', { class: 'rv-err', id: 'rv-pdf' }, h('div', null, 'This receipt is a PDF (PDF 영수증입니다).'),
        h('div', { class: 'btnrow' }, h('a', { class: 'btn', id: 'rv-pdf-open', href: openUrl, target: '_blank', rel: 'noopener' }, icon('open', 18), 'Open PDF (PDF 열기)'), drive)));
      bar.replaceChildren();
      return;
    }
    const img = h('img', { class: 'rv-img', id: 'rv-img', src: openUrl, alt: 'Receipt (영수증)', draggable: false });
    const apply = () => { img.style.width = (ZOOMS[zoom] * 100) + '%'; stage.classList.toggle('zoomed', zoom > 0); zl.textContent = zoom === 0 ? 'Fit (맞춤)' : Math.round(ZOOMS[zoom] * 100) + '%'; };
    const zl = h('span', { class: 'rv-zl', id: 'rv-zl', 'aria-live': 'polite' });
    const step = (d) => { zoom = Math.max(0, Math.min(ZOOMS.length - 1, zoom + d)); apply(); };
    img.addEventListener('dblclick', () => { zoom = zoom ? 0 : 2; apply(); });
    stage.replaceChildren(img);
    const canShare = typeof navigator !== 'undefined' && navigator.canShare && typeof File !== 'undefined' && (() => { try { return navigator.canShare({ files: [new File([blob], 'x.jpg', { type: blob.type })] }); } catch (e) { return false; } })();
    const fname = (spec.fileName || 'receipt') + (/\.\w{3,4}$/.test(spec.fileName || '') ? '' : '.jpg');
    bar.replaceChildren(
      h('div', { class: 'rv-zoom', role: 'group', 'aria-label': 'Zoom (확대 · 축소)' },
        h('button', { type: 'button', class: 'btn secondary sm', id: 'rv-out', 'aria-label': 'Zoom out (축소)', onclick: () => step(-1) }, '−'), zl,
        h('button', { type: 'button', class: 'btn secondary sm', id: 'rv-in', 'aria-label': 'Zoom in (확대)', onclick: () => step(1) }, '+')),
      h('div', { class: 'rv-acts' },
        h('a', { class: 'btn secondary sm', id: 'rv-save', href: openUrl, download: fname }, icon('download', 18), 'Save (저장)'),
        canShare ? h('button', { type: 'button', class: 'btn secondary sm', id: 'rv-share', onclick: async () => { try { await navigator.share({ files: [new File([blob], fname, { type: blob.type })] }); } catch (e) { /* 취소 */ } } }, icon('send', 18), 'Share (공유)') : null,
        drive ? drive : null,
        spec.onReplace ? h('button', { type: 'button', class: 'btn secondary sm', id: 'rv-replace', onclick: () => { close(); spec.onReplace(); } }, icon('camera', 18), 'Replace photo (사진 바꾸기)') : null));
    apply();
  }

  async function start(refresh) {
    stage.replaceChildren(h('div', { class: 'rv-load', id: 'rv-load' }, h('div', { class: 'rv-spin' }), h('div', null, 'Loading receipt… (영수증 불러오는 중)')));
    try {
      if (spec.local) { paint(spec.local.b64, spec.local.mime); return; }
      const r = await loadReceipt(spec.fileId, { refresh: !!refresh });
      if (dead) return;
      paint(r.b64, r.mime);
    } catch (e) {
      if (dead) return;
      showError((e && e.message) || String(e));
    }
  }
  start(false);
  return { close };
}

/** 거래 번호로 열기. 영수증이 없으면 붙이기 안내 */
export function viewTxnReceipt(api, txnId) {
  const data = api.state.data;
  const it = api.state.d.itemById.get(String(txnId));
  const rc = it ? receiptOf(data, it.txn) : null;
  if (!rc) { api.toast('No receipt photo (영수증 사진이 없는 거래입니다)'); return null; }
  const t = it.txn;
  return openViewer(api, {
    title: t.merchant || 'Receipt (영수증)', sub: [t.date, api.fmt ? api.fmt(L.num(t.total_cad)) : ''].filter(Boolean).join(' · '),
    fileId: rc.drive_file_id, fileName: rc.file_name, onReplace: () => attach(api, txnId)
  });
}

// ───────── 기존 거래에 사진 붙이기 ─────────

/** 순수 계산: 거래 + 저장된 파일 정보 → 저장할 행 (이미 영수증이 있으면 이전 행은 지움 표시) */
export function makeAttachRecords(txn, info, oldReceipt, now) {
  const receiptId = L.newId('rc');
  const m = info || {};
  const receipt = {
    receipt_id: receiptId, txn_id: txn.txn_id, drive_file_id: (m.drive && m.drive.fileId) || '', file_name: (m.drive && m.drive.fileName) || m.fileName || '',
    mime: m.mime || '', sha256: m.sha256 || '', parse_status: 'ATTACHED', parse_model: '', parsed_json: '', confidence: '', error: m.driveError || '',
    uploaded_at: now, updated_at: now, deleted: false
  };
  const newTxn = Object.assign({}, txn, { receipt_id: receiptId, updated_at: now });
  const old = oldReceipt ? Object.assign({}, oldReceipt, { deleted: true, updated_at: now }) : null;
  return { receipt, txn: newTxn, old };
}

/** 사진 고르기 → 스캔본으로 보정 → 드라이브 저장 → 거래에 연결 */
export function attach(api, txnId) {
  const { h } = api;
  const it = api.state.d.itemById.get(String(txnId));
  if (!it) return;
  const host = mountHost();
  const close = () => host.remove();
  const err = h('div', { class: 'err', id: 'at-err', role: 'alert' });
  const ready = R.apiConfigured();
  const run = async (file) => {
    if (!file) return;
    err.textContent = '';
    show(true);
    try {
      const img = await R.prepareImage(file);
      const dup = R.findDuplicate(api.state.data.receipts, api.state.data.txns, img.sha256);
      if (dup && String(dup.txn.txn_id) !== String(txnId) && !window.confirm('This photo is already saved on another transaction. Attach anyway? (같은 사진이 다른 거래에 이미 있습니다. 그래도 붙일까요?)')) { show(false); return; }
      const st = await R.storeReceipt(img);
      if (st.driveError || !(st.drive && st.drive.fileId)) throw new Error(st.driveError || '드라이브에 저장하지 못했습니다.');
      const old = receiptOf(api.state.data, it.txn);
      const rec = makeAttachRecords(it.txn, { drive: st.drive, fileName: img.fileName, mime: img.mime, sha256: img.sha256 || st.sha256 }, old, L.nowIso());
      await cachePut(st.drive.fileId, img.mime, img.base64);
      const puts = { Receipts: [rec.receipt].concat(rec.old ? [rec.old] : []), Transactions: [rec.txn] };
      await api.saveBatch(puts, ['Receipts', 'Transactions']);
      close();
      api.toast('Receipt attached (영수증을 붙였어요)');
    } catch (e) { show(false); err.textContent = (e && e.message) || String(e); }
  };
  const cam = h('input', { type: 'file', accept: 'image/*', capture: 'environment', id: 'at-cam', hidden: true, onchange: (e) => run(e.target.files && e.target.files[0]) });
  const lib = h('input', { type: 'file', accept: 'image/*,application/pdf', id: 'at-file', hidden: true, onchange: (e) => run(e.target.files && e.target.files[0]) });
  const body = h('div', { class: 'at-body', id: 'at-body' });
  function show(busy) {
    body.replaceChildren(...[].concat(busy
      ? h('div', { class: 'rv-load', id: 'at-busy' }, h('div', { class: 'rv-spin' }), h('div', null, 'Scanning & saving to Drive… (스캔본으로 보정해 드라이브에 저장 중)'))
      : [h('p', { class: 'hint' }, 'The photo is saved as a clean scan in your Google Drive and linked to this transaction (사진은 깨끗한 스캔본으로 구글 드라이브에 저장되고 이 거래에 연결됩니다).'),
        h('div', { class: 'btnrow' },
          h('button', { type: 'button', class: 'btn', id: 'at-take', disabled: !ready, onclick: () => cam.click() }, icon('camera', 18), 'Take photo (사진 찍기)'),
          h('button', { type: 'button', class: 'btn secondary', id: 'at-choose', disabled: !ready, onclick: () => lib.click() }, 'Choose file (파일 선택)')),
        !ready ? h('div', { class: 'err' }, '영수증 서버 주소가 설정되지 않았습니다.') : null]).filter(Boolean));
  }
  show(false);
  host.el.replaceChildren(h('div', { class: 'backdrop', onclick: (e) => { if (e.target === e.currentTarget) close(); } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Attach receipt (영수증 붙이기)' },
      h('div', { class: 'sheet-head' }, h('h2', null, 'Attach receipt (영수증 붙이기)'), h('button', { type: 'button', class: 'icon', 'aria-label': 'Close (닫기)', onclick: close }, '✕')),
      h('div', { class: 'hint at-for' }, (it.txn.merchant || it.desc.categoryName || '') + ' · ' + it.txn.date),
      body, cam, lib, err)));
}
