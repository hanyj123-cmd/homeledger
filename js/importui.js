// 명세서 가져오기 화면. ui.js 에서 render(api) 로 불러 씁니다.
//   api = { h, toast, state, fmt, accounts, accMap, data, items, reload, goToTxns }
import * as L from './importer.js';
import * as Lg from './ledger.js';
import * as sync from './sync.js';
import { openRemember } from './rememberui.js';
import { SOURCE_LABEL, askAI } from './categorize.js';
import { CONFIG } from './config.js';

// 화면이 바뀌어도 작업 중이던 내용을 유지합니다.
const S = {
  accountId: '', fileName: '', kind: '', rows: [], profile: null, profileFrom: '', promptYear: String(new Date().getFullYear()),
  parsed: null, preview: [], busy: false, error: '', libs: null, done: null, aiBusy: false, aiMsg: ''
};

export function reset() {
  Object.assign(S, { fileName: '', kind: '', rows: [], profile: null, profileFrom: '', parsed: null, preview: [], busy: false, error: '', done: null, aiBusy: false, aiMsg: '' });
}

export function resetIfDone() { if (S.done) reset(); }

// 테스트용: 라이브러리를 직접 넣어줄 수 있습니다.
export function setLibs(libs) { S.libs = libs; }
export function _state() { return S; }

export function render(api) {
  const { h, fmt } = api;
  const root = h('div', { id: 'import-root' });
  draw();
  return root;

  function draw() {
    root.replaceChildren();
    if (S.done) { root.append(doneCard()); return; }
    root.append(pickCard());
    if (S.error) root.append(h('div', { class: 'err', role: 'alert', id: 'imp-err' }, S.error));
    if (S.parsed) {
      root.append(layoutCard(), reviewCard());
    }
  }

  function moneyAccounts() { return api.accounts.filter(Lg.isMoneyAccount); }

  function pickCard() {
    const money = moneyAccounts();
    const opt = (a) => h('option', { value: a.account_id, selected: String(a.account_id) === String(S.accountId) }, Lg.accLabel(a));
    const sel = h('select', {
      id: 'imp-acct', onchange: (e) => { S.accountId = e.target.value; if (S.rows.length) loadProfileAndParse(); else draw(); }
    },
    h('option', { value: '' }, 'Select account… (계좌 선택)'),
    h('optgroup', { label: 'Assets (자산)' }, money.filter((a) => a.type === 'ASSET').map(opt)),
    h('optgroup', { label: 'Credit & loans (카드 · 대출)' }, money.filter((a) => a.type === 'LIABILITY').map(opt)));
    const file = h('input', {
      type: 'file', id: 'imp-file', accept: '.csv,.xlsx,.xls,.pdf,text/csv',
      onchange: (e) => { const f = e.target.files && e.target.files[0]; if (f) onFile(f); }
    });
    return h('div', { class: 'card' },
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Account (이 명세서의 계좌)'), sel),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'File (파일: CSV · XLSX · PDF)'), file),
      S.fileName ? h('div', { class: 'muted small' }, S.fileName + ' · ' + S.kind + (S.kind === 'PDF' ? ' — best-effort: check every line (PDF는 시도형입니다. 모든 줄을 꼭 확인하세요)' : '')) : null,
      h('div', { class: 'muted small' }, 'Files are read on this device only (파일은 이 기기에서만 읽습니다 — 외부로 전송되지 않습니다).'));
  }

  async function onFile(file) {
    if (!S.accountId) { S.error = 'Select the account first (먼저 계좌를 선택하세요).'; draw(); return; }
    S.error = ''; S.busy = true;
    try {
      const res = await L.readFileRows(file, S.libs);
      S.fileName = file.name; S.kind = res.kind; S.rows = res.rows;
      if (!S.rows.length) { S.error = 'No rows found (읽을 수 있는 줄이 없습니다). ' + (res.kind === 'PDF' ? 'PDF 가 스캔 이미지이거나 형식이 다를 수 있습니다. CSV/XLSX 를 권장합니다.' : ''); S.parsed = null; draw(); return; }
      loadProfileAndParse();
    } catch (e) {
      S.error = 'Could not read the file (파일을 읽지 못했습니다): ' + (e && e.message ? e.message : e);
      S.parsed = null; draw();
    } finally { S.busy = false; }
  }

  function loadProfileAndParse() {
    const row = api.data.profiles.find((p) => String(p.account_id) === String(S.accountId) && !Lg.truthy(p.deleted));
    const saved = L.profileFromRow(row);
    const guessed = L.guessProfile(S.rows);
    // 저장된 설정이 이 파일에서도 날짜를 읽을 수 있을 때만 사용
    if (saved && saved.date_col !== '') {
      const t = L.applyProfile(S.rows, saved, { filename: S.fileName, promptYear: S.promptYear });
      if (t.lines.length) { S.profile = saved; S.profileFrom = 'saved'; reparse(); return; }
    }
    S.profile = guessed; S.profileFrom = 'guessed';
    reparse();
  }

  function reparse() {
    S.error = '';
    const parsed = L.applyProfile(S.rows, S.profile, { filename: S.fileName, promptYear: S.promptYear });
    S.parsed = parsed;
    S.preview = L.buildPreview(parsed.lines, {
      accountId: S.accountId, accMap: api.accMap, accounts: api.accounts, rules: api.data.rules, items: api.items, stmtLines: api.data.stmtLines
    });
    draw();
  }

  // ───── 열 설정 ─────
  function layoutCard() {
    const p = S.profile;
    const n = L.colCount(S.rows);
    const info = L.headerInfo(S.rows, p.date_col === '' ? 0 : parseInt(p.date_col, 10));
    const colName = (c) => 'Col ' + (c + 1) + (info.labels[c] ? ' · ' + info.labels[c] : '');
    const colOpts = (cur, allowNone) => [allowNone ? h('option', { value: '' }, '— none (없음) —') : null]
      .concat(Array.from({ length: n }, (_, c) => h('option', { value: String(c), selected: String(c) === String(cur) }, colName(c))));
    const set = (k) => (e) => { S.profile[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; reparse(); };
    const descSel = (idx) => {
      const cols = String(p.desc_cols || '').split(',').filter((x) => x !== '');
      return h('select', {
        id: 'imp-desc' + idx,
        onchange: (e) => {
          const cur = String(S.profile.desc_cols || '').split(',').filter((x) => x !== '');
          cur[idx] = e.target.value;
          S.profile.desc_cols = cur.filter((x) => x !== '' && x !== undefined).join(',');
          reparse();
        }
      }, colOpts(cols[idx], idx > 0));
    };
    const twoCols = !!(p.debit_col !== '' || p.credit_col !== '');
    const open = S.profileFrom === 'guessed' || (S.parsed && !S.parsed.lines.length);
    const sampleRows = S.rows.slice(0, 6);
    return h('details', { class: 'card', open: open, id: 'imp-layout' },
      h('summary', null, 'Column layout (열 설정) — ' + (S.profileFrom === 'saved' ? 'saved for this account (저장된 설정 사용 중)' : 'auto-detected (자동 추측 · 확인하세요)')),
      h('div', { class: 'two' },
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Date column (날짜 열)'), h('select', { id: 'imp-datecol', onchange: set('date_col') }, colOpts(p.date_col, false))),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Date format (날짜 형식)'), h('select', { id: 'imp-datefmt', onchange: set('date_format') },
          [['AUTO', 'Auto (자동)'], ['MDY', 'MM/DD/YYYY'], ['DMY', 'DD/MM/YYYY'], ['YMD', 'YYYY-MM-DD']].map((o) => h('option', { value: o[0], selected: p.date_format === o[0] }, o[1]))))),
      h('div', { class: 'two' },
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Description (설명 열)'), descSel(0)),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Description 2 (설명 열 2, 선택)'), descSel(1))),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Amount layout (금액 구성)'), h('select', {
        id: 'imp-mode',
        onchange: (e) => {
          if (e.target.value === 'two') { S.profile.amount_col = ''; S.profile.debit_col = S.profile.debit_col || ''; }
          else { S.profile.debit_col = ''; S.profile.credit_col = ''; }
          S.modeTwo = e.target.value === 'two';
          draw();
        }
      }, h('option', { value: 'one', selected: !twoCols && !S.modeTwo }, 'One amount column (금액 1열)'),
      h('option', { value: 'two', selected: twoCols || !!S.modeTwo }, 'Debit + Credit columns (출금/입금 2열)'))),
      (twoCols || S.modeTwo)
        ? h('div', { class: 'two' },
          h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Debit · out (출금 열)'), h('select', { id: 'imp-debit', onchange: set('debit_col') }, colOpts(p.debit_col, true))),
          h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Credit · in (입금 열)'), h('select', { id: 'imp-credit', onchange: set('credit_col') }, colOpts(p.credit_col, true))))
        : h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Amount column (금액 열)'), h('select', { id: 'imp-amount', onchange: set('amount_col') }, colOpts(p.amount_col, true))),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Rows to ignore, regex (무시할 줄 패턴)'),
        h('input', { type: 'text', id: 'imp-skip', value: p.skip_rows_regex, onchange: set('skip_rows_regex') })),
      h('div', { class: 'note' }, 'First rows of the file (파일의 첫 줄들):'),
      h('div', { class: 'rawtable' }, sampleRows.map((r) => h('div', { class: 'rawrow' }, r.slice(0, n).map((c, i) => (i ? ' | ' : '') + String(c instanceof Date ? 'date' : c).slice(0, 24)).join('')))));
  }

  // ───── 미리보기 ─────
  function reviewCard() {
    const parsed = S.parsed;
    const wrap = h('div', { id: 'imp-review' });
    if (parsed.needYear) {
      wrap.append(h('div', { class: 'card' },
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Year for dates without a year (연도가 없는 날짜의 연도)'),
          h('input', { type: 'text', id: 'imp-year', inputmode: 'numeric', value: S.promptYear, onchange: (e) => { S.promptYear = e.target.value; if (S.profile.year_source === 'COLUMN') S.profile.year_source = 'PROMPT'; reparse(); } })),
        h('div', { class: 'muted small' }, 'Tip: a file name like TD_2025_01.csv sets the year automatically (파일 이름에 2025_01 이 있으면 자동 인식).')));
    }
    if (!parsed.lines.length) {
      wrap.append(h('div', { class: 'card muted' }, 'No lines could be read yet (읽힌 줄이 없습니다). Adjust the column layout above (위의 열 설정을 조정하세요).'),
        skippedNote() || '');
      return wrap;
    }
    const t = L.previewTotals(S.preview);
    const flipBox = h('label', { class: 'check' },
      h('input', { type: 'checkbox', id: 'imp-flip', checked: Lg.truthy(S.profile.sign_flip), onchange: (e) => { S.profile.sign_flip = e.target.checked; reparse(); } }),
      h('span', null, 'Flip sign (부호 반대로) — use if purchases show as ↑ in (사용 내역이 ↑ 로 보이면 체크)'));
    wrap.append(
      h('div', { class: 'summary' },
        stat('Out (나간 돈)', '↓ ' + fmt(t.out), 'out'),
        stat('In (들어온 돈)', '↑ ' + fmt(t.inn), 'in'),
        stat('Lines (줄)', t.count + (t.dups ? ' · dup ' + t.dups : ''), '')),
      flipBox,
      h('div', { class: 'note', id: 'imp-sum' }, 'New (신규) ' + t.news + ' · Linked to existing (기존 거래와 연결) ' + t.matched + ' · Skipped (제외) ' + t.skipped),
      h('div', { class: 'note', id: 'imp-auto' }, autoSummary()),
      aiBox() || '',
      skippedNote() || '');
    const list = h('div', { id: 'imp-lines' });
    const targetOpts = buildTargetOptions();
    const selects = new Map();
    S.preview.forEach((r, i) => list.append(lineRow(r, i, targetOpts, selects)));
    wrap.append(list);
    wrap.append(h('div', { class: 'err', id: 'imp-commit-err', role: 'alert' }),
      h('div', { class: 'btnrow' },
        h('button', { type: 'button', class: 'btn', id: 'imp-commit', disabled: t.news + t.matched === 0, onclick: onCommit },
          'Import ' + (t.news + t.matched) + ' line(s) (' + (t.news + t.matched) + '건 가져오기)'),
        h('button', { type: 'button', class: 'btn secondary', onclick: () => { reset(); draw(); } }, 'Cancel (취소)')));
    return wrap;
  }

  function pending() { return S.preview.filter((r) => r.action === 'NEW' && String(r.target) === L.UNCATEGORIZED_ID && !r.touched); }
  function autoSummary() {
    const nw = S.preview.filter((r) => r.action === 'NEW');
    const auto = nw.filter((r) => r.source && !r.touched).length;
    return 'Auto-categorized (자동 분류) ' + auto + ' · Needs your pick (직접 선택 필요) ' + pending().length;
  }
  function aiBox() {
    const left = pending();
    const names = Array.from(new Set(left.map((r) => r.line.merchant).filter(Boolean)));
    if (!names.length && !S.aiMsg) return null;
    return h('div', { class: 'card', id: 'imp-ai' },
      names.length ? h('button', { type: 'button', class: 'btn secondary', id: 'imp-ai-btn', disabled: S.aiBusy, onclick: runAI },
        S.aiBusy ? 'Asking AI… (물어보는 중)' : '✨ Ask AI for the remaining ' + names.length + ' (남은 ' + names.length + '곳 AI에게 물어보기)') : null,
      names.length ? h('div', { class: 'muted small' }, 'Only store names are sent — no amounts, dates or accounts. (가게 이름만 전송됩니다. 금액·날짜·계좌는 보내지 않습니다.)') : null,
      S.aiMsg ? h('div', { class: 'note', id: 'imp-ai-msg' }, S.aiMsg) : null);
  }
  async function runAI() {
    const left = pending();
    const names = Array.from(new Set(left.map((r) => r.line.merchant).filter(Boolean)));
    S.aiBusy = true; S.aiMsg = ''; draw();
    try {
      const got = await askAI(names, api.accounts);
      let n = 0;
      S.preview.forEach((r) => {
        const g = got.get(r.line.merchant);
        if (g && r.action === 'NEW' && String(r.target) === L.UNCATEGORIZED_ID && !r.touched && g.accountId !== String(S.accountId)) { r.target = g.accountId; r.source = 'ai'; r.confidence = g.confidence; n++; }
      });
      S.aiMsg = n ? 'AI categorized ' + n + ' line(s) — please check them (AI가 ' + n + '줄을 분류했습니다. 꼭 확인하세요).' : 'AI could not decide these (AI도 판단하지 못했습니다).';
    } catch (e) {
      S.aiMsg = 'AI failed (AI 실패): ' + (e && e.message ? e.message : e);
    }
    S.aiBusy = false; draw();
  }

  function stat(label, value, cls) {
    return h('div', { class: 'stat' }, h('div', { class: 'stat-l' }, label), h('div', { class: 'stat-v ' + (cls || '') }, value));
  }

  function skippedNote() {
    const sk = (S.parsed && S.parsed.skipped) || [];
    if (!sk.length) return null;
    const bal = sk.filter((x) => /balance/.test(x.reason)).length;
    const other = sk.length - bal;
    return h('details', { class: 'note', id: 'imp-skipped' },
      h('summary', null, 'Ignored rows (무시된 줄): ' + sk.length + (bal ? ' — balance ' + bal : '') + (other ? ', other ' + other : '')),
      sk.slice(0, 40).map((x) => h('div', { class: 'rawrow' }, '#' + (x.idx + 1) + ' ' + x.reason + ': ' + String(x.text).slice(0, 70))));
  }

  // 대상 계정 목록(카테고리 + 이체 상대 계좌)을 한 번만 만들고 줄마다 복사합니다.
  function buildTargetOptions() {
    const sel = h('select');
    const acc = api.accounts.filter((a) => Lg.isActive(a));
    const grp = (label, list) => {
      if (!list.length) return;
      sel.append(h('optgroup', { label }, list.map((a) => h('option', { value: a.account_id }, Lg.accLabel(a)))));
    };
    const exp = acc.filter((a) => a.type === 'EXPENSE');
    Lg.GROUP_ORDER.forEach((g) => grp(Lg.GROUP_LABELS[g] || g, exp.filter((a) => (a.report_group || '확인 필요') === g)));
    grp('Other expenses (기타 지출)', exp.filter((a) => Lg.GROUP_ORDER.indexOf(a.report_group || '확인 필요') < 0));
    grp('Income (수입)', acc.filter((a) => a.type === 'INCOME'));
    grp('Transfer to account (계좌 이체 · 카드 대금)', acc.filter((a) => Lg.isMoneyAccount(a) && String(a.account_id) !== String(S.accountId)));
    grp('Passthrough (전달 자금)', acc.filter((a) => String(a.account_id) === CONFIG.CLEARING_ID));
    return sel;
  }

  function lineRow(r, i, targetOpts, selects) {
    const ln = r.line;
    const out = ln.amount > 0;
    const actions = [['NEW', 'New (신규 거래)']];
    if (r.match) actions.unshift(['MATCH', 'Link to existing (기존 거래와 연결)']);
    actions.push(['SKIP', ln.dup ? 'Skip — duplicate (중복·제외)' : 'Skip (제외)']);
    if (ln.dup) { actions.splice(0, actions.length, ['SKIP', 'Skip — already imported (이미 가져옴)'], ['NEW', 'Import anyway (그래도 가져오기)']); }
    const tSel = targetOpts.cloneNode(true);
    tSel.value = r.target;
    tSel.className = 'imp-target';
    tSel.setAttribute('aria-label', 'Category (카테고리)');
    tSel.addEventListener('change', () => {
      r.target = tSel.value; r.touched = true; r.source = 'user'; setBadge();
      const norm = Lg.normMerchant(ln.merchant);
      if (norm) S.preview.forEach((o, j) => {
        if (o !== r && !o.touched && o.action === 'NEW' && Lg.normMerchant(o.line.merchant) === norm) {
          o.target = r.target; o.source = 'user';
          const s2 = selects.get(j);
          if (s2) { s2.value = r.target; s2.closest('.imp-line').classList.remove('review'); }
        }
      });
      tSel.closest('.imp-line').classList.toggle('review', tSel.value === L.UNCATEGORIZED_ID);
      const au = root.querySelector('#imp-auto'); if (au) au.textContent = autoSummary();
    });
    selects.set(i, tSel);
    const aSel = h('select', {
      class: 'imp-action', 'aria-label': 'Action (처리)',
      onchange: (e) => { r.action = e.target.value; refreshSummaryOnly(); toggle(); }
    }, actions.map((a) => h('option', { value: a[0], selected: a[0] === r.action }, a[1])));
    const targetWrap = h('div', { class: 'imp-targetwrap' }, tSel);
    const matchNote = h('div', { class: 'row-sub' });
    const toggle = () => {
      targetWrap.hidden = r.action !== 'NEW';
      matchNote.textContent = r.action === 'MATCH' && r.match
        ? '→ ' + (r.match.item.txn.merchant || r.match.item.txn.memo || r.match.item.desc.categoryName) + ' · ' + r.match.item.txn.date + ' · match ' + Math.round(r.match.score * 100) + '%'
        : (r.match && r.action !== 'MATCH' ? 'possible match (유사 거래): ' + (r.match.item.txn.merchant || '') + ' ' + Math.round(r.match.score * 100) + '%' : '');
      el.classList.toggle('skipped', r.action === 'SKIP');
      if (typeof setBadge === 'function') setBadge();
    };
    const badge = h('span', { class: 'src' });
    const setBadge = () => {
      const lab = r.source && SOURCE_LABEL[r.source];
      badge.textContent = lab && r.target !== L.UNCATEGORIZED_ID ? lab : '';
      badge.className = 'src' + (r.source ? ' src-' + r.source : '');
      badge.hidden = !badge.textContent || r.action !== 'NEW';
    };
    const el = h('div', { class: 'card imp-line' + (r.target === L.UNCATEGORIZED_ID ? ' review' : '') },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, ln.merchant || '(no description)'),
        h('div', { class: 'row-sub' }, ln.date + (ln.foreign ? ' · ' + ln.foreign.currency + ' ' + ln.foreign.amount : ''))),
      h('div', { class: 'row-amt ' + (out ? 'out' : 'in') }, (out ? '↓ ' : '↑ ') + fmt(Math.abs(ln.amount))),
      matchNote,
      h('div', { class: 'two' }, aSel, targetWrap),
      badge);
    toggle(); setBadge();
    return el;
  }

  function refreshSummaryOnly() {
    const t = L.previewTotals(S.preview);
    const sum = root.querySelector('#imp-sum');
    if (sum) sum.textContent = 'New (신규) ' + t.news + ' · Linked to existing (기존 거래와 연결) ' + t.matched + ' · Skipped (제외) ' + t.skipped;
    const b = root.querySelector('#imp-commit');
    if (b) { b.disabled = t.news + t.matched === 0; b.textContent = 'Import ' + (t.news + t.matched) + ' line(s) (' + (t.news + t.matched) + '건 가져오기)'; }
  }

  async function onCommit() {
    const errEl = root.querySelector('#imp-commit-err');
    const btn = root.querySelector('#imp-commit');
    const bad = S.preview.find((r) => r.action === 'NEW' && !api.accMap.has(String(r.target)));
    if (bad) { errEl.textContent = 'Choose a category for every new line (신규 줄마다 카테고리를 선택하세요): ' + bad.line.date + ' ' + bad.line.merchant; return; }
    btn.disabled = true;
    try {
      // 저장할 열 설정에는 실제로 쓴 연도 방식을 기록
      const prof = Object.assign({}, S.profile);
      if (S.parsed.lines.length && L.yearHintFromName(S.fileName) && prof.year_source !== 'COLUMN') prof.year_source = 'FILENAME';
      const rec = L.buildRecords(S.preview, {
        accountId: S.accountId, accMap: api.accMap, rules: api.data.rules, profile: prof, now: Lg.nowIso()
      });
      await sync.saveBatch(rec.puts, ['Postings', 'Transactions', 'StatementLines', 'Rules', 'ImportProfiles']);
      const dates = S.preview.filter((r) => r.action !== 'SKIP').map((r) => r.line.date).sort();
      S.done = { counts: rec.counts, month: dates.length ? Lg.monthOf(dates[dates.length - 1]) : '', review: S.preview.filter((r) => r.action === 'NEW' && String(r.target) === L.UNCATEGORIZED_ID).length };
      await api.reload();
      draw();
      if (rec.remember && rec.remember.length) await openRemember(api, rec.remember);
    } catch (e) {
      btn.disabled = false;
      errEl.textContent = 'Import failed (가져오기 실패): ' + (e && e.message ? e.message : e);
    }
  }

  function doneCard() {
    const d = S.done;
    return h('div', { class: 'card center', id: 'imp-done' },
      h('p', null, 'Imported (가져오기 완료): ' + d.counts.created + ' new (신규), ' + d.counts.matched + ' linked (연결), ' + d.counts.skipped + ' skipped (제외)'),
      d.review ? h('p', { class: 'muted' }, d.review + ' line(s) are Uncategorized (미분류 ' + d.review + '건) — search "Uncategorized" in Transactions to fix (거래 탭에서 검색해 고치세요).') : null,
      h('div', { class: 'btnrow' },
        h('button', { type: 'button', class: 'btn', id: 'imp-view', onclick: () => { const m = d.month; reset(); api.goToTxns(m); } }, 'View transactions (거래 보기)'),
        h('button', { type: 'button', class: 'btn secondary', id: 'imp-another', onclick: () => { reset(); draw(); } }, 'Import another (다른 파일 가져오기)')));
  }
}
