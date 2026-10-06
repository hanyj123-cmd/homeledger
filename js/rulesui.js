// 설정 화면의 "자동 분류 규칙(Rules)" 카드: 목록 · 검색 · 카테고리 변경 · 삭제 · 새 규칙 · 자주 쓰는 규칙(Quick presets).
//  - 규칙 한 줄 = { rule_id, pattern, account_id, owner, default_tax_code, is_passthrough, postings_template, hit_count, source, updated_at, deleted }
//    (ledger.learnRule 이 만드는 모양과 같음). 가맹점 이름이 pattern 을 "포함"하면(소문자·기호 제거 후) 그 카테고리를 추천합니다.
//  - 저장은 항상 api.saveBatch({ Rules: rows }, ['Rules']) (로컬 먼저 → 시트로 전송). 삭제는 deleted=true (soft delete).
//  - 순수 함수(presetPlan, presetRows, ruleList, newRuleRow)는 export 해서 테스트합니다.
import { CONFIG } from './config.js';
import * as L from './ledger.js';
import { icon } from './icons.js';

const OWNERS = CONFIG.OWNERS;
const PAGE = 40;

// ───────── 자주 쓰는 규칙 ─────────
// entries: 같은 계정 후보를 쓰는 패턴 묶음. rxs: 내 계정표에서 이름(영문/한글)으로 찾는 정규식 — 앞에 있는 것부터 시도하고, 처음으로 맞는 계정이 있는 것을 씁니다.
export const PRESETS = [
  { id: 'util', label: 'Utilities', ko: '공과금', type: 'EXPENSE', entries: [{ patterns: ['Toronto Hydro', 'Enbridge'], rxs: [/utilit|hydro|공과금|전기|수도/i] }] },
  { id: 'tel', label: 'Internet & phone', ko: '인터넷·폰', type: 'EXPENSE', entries: [{ patterns: ['Rogers', 'Bell', 'Fido', 'Telus'], rxs: [/internet|phone|mobile|통신|인터넷|휴대폰|폰/i] }] },
  { id: 'sub', label: 'Subscriptions & fun', ko: '구독·오락', type: 'EXPENSE', entries: [{ patterns: ['Netflix', 'Spotify', 'Disney'], rxs: [/subscription|구독/i, /entertainment|오락|문화/i] }] },
  { id: 'groc', label: 'Groceries', ko: '식료품', type: 'EXPENSE', entries: [{ patterns: ['Costco', 'Loblaws', 'No Frills', 'H Mart', 'T&T Supermarket'], rxs: [/grocer|식료|마트/i] }] },
  {
    id: 'trans', label: 'Transit & fuel', ko: '교통·주유', type: 'EXPENSE', entries: [
      { patterns: ['TTC', 'Presto'], rxs: [/transit|교통|대중교통/i, /gas\s*&|fuel|주유/i] },
      { patterns: ['Shell', 'Petro-Canada', 'Esso'], rxs: [/gas\s*&|fuel|주유/i, /transit|교통/i] }]
  },
  { id: 'pay', label: 'Paycheque income', ko: '급여 수입', type: 'INCOME', entries: [{ patterns: ['payroll', 'payroll deposit', 'PAY'], rxs: [/salary|payroll|wage|급여|월급/i] }] }
];

const isUncat = (a) => String(a.account_id) === '9999';
const nameHit = (a, rx) => rx.test(a.name || '') || rx.test(a.name_ko || '');

/**
 * 미리보기 계획. 반환: [{ id, label, ko, items:[{ key, pattern, norm, candidates:[account], accountId, status:'new'|'exists'|'noacct', risky }] }]
 *  - status 'exists' : 같은 패턴(정규화한 이름)의 규칙이 이미 있음 → 건너뜀
 *  - status 'noacct' : 맞는 계정이 없음 → "맞는 계정이 없어요"
 *  - risky           : 3글자 이하라서 다른 가게 이름에도 걸릴 수 있음 (처음에는 선택 해제)
 */
export function presetPlan(accounts, rules) {
  const live = (accounts || []).filter((a) => L.isActive(a) && !isUncat(a));
  const have = new Set((rules || []).filter((r) => !L.truthy(r.deleted)).map((r) => L.normMerchant(r.pattern)));
  return PRESETS.map((g) => ({
    id: g.id, label: g.label, ko: g.ko,
    items: g.entries.flatMap((e) => {
      let cands = [];
      for (const rx of e.rxs) {
        cands = live.filter((a) => a.type === g.type && nameHit(a, rx)).sort((a, b) => L.num(a.sort_order) - L.num(b.sort_order));
        if (cands.length) break;
      }
      return e.patterns.map((p) => {
        const norm = L.normMerchant(p);
        return {
          key: g.id + ':' + norm, pattern: p, norm, candidates: cands, accountId: cands.length ? String(cands[0].account_id) : '',
          status: have.has(norm) ? 'exists' : (cands.length ? 'new' : 'noacct'), risky: norm.length <= 3
        };
      });
    })
  }));
}

/** 처음 선택 상태: 새로 만들 수 있고 위험하지 않은 것만 */
export function defaultSelection(plan) {
  const s = new Set();
  plan.forEach((g) => g.items.forEach((it) => { if (it.status === 'new' && !it.risky) s.add(it.key); }));
  return s;
}

/** 선택한 항목 → 저장할 Rules 행들. 이미 있는 패턴·계정이 없는 항목·중복은 건너뜁니다. choices: Map(key → 고른 account_id) */
export function presetRows(plan, selected, choices, rules, now) {
  const have = new Set((rules || []).filter((r) => !L.truthy(r.deleted)).map((r) => L.normMerchant(r.pattern)));
  const out = [];
  plan.forEach((g) => g.items.forEach((it) => {
    if (!selected.has(it.key) || have.has(it.norm) || !it.norm) return;
    const acc = (choices && choices.get(it.key)) || it.accountId;
    if (!acc || !it.candidates.some((a) => String(a.account_id) === String(acc))) return;
    have.add(it.norm);
    out.push({
      rule_id: L.newId('r'), pattern: it.norm, account_id: String(acc), owner: '', default_tax_code: '',
      is_passthrough: '', postings_template: '', hit_count: 0, source: 'PRESET', updated_at: now, deleted: false
    });
  }));
  return out;
}

/**
 * 직접 만든 새 규칙 → 저장할 행. 같은 패턴이 이미 있으면 그 규칙의 분류(와 소유자)만 바꿉니다.
 * 반환: { row, mode:'new'|'update'|'same' } 또는 { error }
 */
export function newRuleRow(rules, pattern, accountId, owner, now, match) {
  const norm = L.normMerchant(pattern);
  if (!norm) return { error: '패턴(가맹점 이름)을 입력하세요. 글자나 숫자가 있어야 합니다.' };
  if (!accountId) return { error: '카테고리를 선택하세요.' };
  const own = OWNERS.indexOf(owner) >= 0 ? owner : '';
  const starts = match === 'starts' || /^\s*\^/.test(String(pattern));
  const pat = (starts ? '^' : '') + norm;
  const key = L.ruleKey(pat);
  const existing = (rules || []).find((r) => !L.truthy(r.deleted) && L.ruleKey(r.pattern) === key);
  if (existing) {
    if (String(existing.account_id) === String(accountId) && String(existing.owner || '') === own) return { mode: 'same', row: existing };
    return { mode: 'update', row: Object.assign({}, existing, { account_id: String(accountId), owner: own, source: existing.source || 'MANUAL', updated_at: now, deleted: false }) };
  }
  const row = L.learnRule(starts ? [] : (rules || []).filter((r) => !L.isStartsRule(r)), norm, accountId, now);
  return { mode: 'new', row: Object.assign({}, row, { pattern: pat, hit_count: 0, owner: own, source: 'MANUAL' }) };
}

/** 이 규칙에 걸리는 기존 거래 id (가맹점 이름 또는 은행 원문 기준, 카테고리가 이미 같은 것은 제외) */
export function matchingTxnIds(items, rule) {
  const out = [];
  (items || []).forEach((it) => {
    const t = it.txn;
    if (L.truthy(t.deleted)) return;
    const hit = L.ruleMatches(rule, L.normMerchant(t.merchant)) || L.ruleMatches(rule, L.normMerchant(t.merchant_raw));
    if (!hit) return;
    const d = it.desc || it.d || {};
    if (d.categoryId && String(d.categoryId) === String(rule.account_id)) return;
    out.push(String(t.txn_id));
  });
  return out;
}

/** 목록: 삭제 안 된 규칙을 많이 쓴 순 → 이름순. q 는 패턴·카테고리·소유자·출처에서 찾음 */
export function ruleList(rules, accMap, q) {
  const tokens = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const live = (rules || []).filter((r) => !L.truthy(r.deleted) && r.pattern);
  const nameOf = (r) => { const a = accMap.get(String(r.account_id)); return a ? L.accLabel(a) : ''; };
  const list = live.filter((r) => {
    if (!tokens.length) return true;
    const hay = [r.pattern, nameOf(r), r.owner, r.source].join(' ').toLowerCase();
    return tokens.every((t) => hay.indexOf(t) >= 0);
  });
  return list.sort((a, b) => (L.num(b.hit_count) - L.num(a.hit_count)) || String(a.pattern).localeCompare(String(b.pattern)));
}

export const isPassthroughRule = (r) => L.truthy(r.is_passthrough) || String(r.account_id) === CONFIG.CLEARING_ID;

// ───────── 화면 ─────────

// 다시 그려져도(저장하면 화면이 새로 만들어집니다) 검색어·펼침 상태가 남도록 모듈에 보관
const S = { q: '', shown: PAGE, sel: null, choices: new Map(), presetOpen: false, newOwner: '', match: 'contains', applyOld: true };
export function __resetRulesState() { S.q = ''; S.shown = PAGE; S.sel = null; S.choices = new Map(); S.presetOpen = false; S.newOwner = ''; S.match = 'contains'; S.applyOld = true; }

/** 카테고리 드롭다운 <select>. 지출(그룹별) · 수입 · 전달 자금. 현재 값이 목록에 없어도 그대로 보이게 합니다. */
export function catSelect(api, sel, attrs) {
  const { h } = api;
  const accounts = (api.accounts || []).filter(L.isActive);
  const known = new Set();
  const mk = (a) => { known.add(String(a.account_id)); return h('option', { value: String(a.account_id), selected: String(a.account_id) === String(sel) }, L.accLabel(a)); };
  const groups = new Map();
  accounts.filter((a) => a.type === 'EXPENSE' && !isUncat(a)).forEach((a) => {
    const g = a.report_group || '확인 필요';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(a);
  });
  const keys = L.GROUP_ORDER.filter((g) => groups.has(g)).concat(Array.from(groups.keys()).filter((g) => L.GROUP_ORDER.indexOf(g) < 0));
  const opts = [h('option', { value: '' }, 'Select… (선택)')];
  keys.forEach((g) => opts.push(h('optgroup', { label: L.GROUP_LABELS[g] || g }, groups.get(g).map(mk))));
  const inc = accounts.filter((a) => a.type === 'INCOME');
  if (inc.length) opts.push(h('optgroup', { label: 'Income (수입)' }, inc.map(mk)));
  const clearing = accounts.find((a) => String(a.account_id) === CONFIG.CLEARING_ID);
  if (clearing) opts.push(h('optgroup', { label: 'Passthrough (전달 자금)' }, [mk(clearing)]));
  if (sel && !known.has(String(sel))) {
    const a = (api.accMap && api.accMap.get(String(sel))) || null;
    opts.splice(1, 0, h('option', { value: String(sel), selected: true }, a ? L.accLabel(a) : '(missing 없는 계정 ' + sel + ')'));
  }
  return h('select', Object.assign({ 'aria-label': 'Category (카테고리)' }, attrs || {}), opts);
}

const ownerSelect = (h, sel, attrs) => h('select', Object.assign({ 'aria-label': 'Owner (소유자)' }, attrs || {}),
  h('option', { value: '', selected: !sel }, 'Any owner (상관없음)'), OWNERS.map((o) => h('option', { value: o, selected: o === sel }, L.ownerLabel(o))));

async function saveRows(api, rows, okMsg) {
  try {
    await api.saveBatch({ Rules: rows }, ['Rules']);
    if (okMsg) api.toast(okMsg);
    return true;
  } catch (e) {
    api.toast('저장하지 못했습니다: ' + (e && e.message ? e.message : e));
    return false;
  }
}

/** 규칙 카드(<section>) 를 만듭니다. */
export function rulesCard(api) {
  const { h } = api;
  const rules = api.data.rules || [];
  const accMap = api.accMap;
  const total = ruleList(rules, accMap, '').length;

  // 규칙이 많아 설정 화면이 길어지므로 평소에는 접어 두고, 제목을 누르면 펼칩니다 (펼침 상태는 다시 그려도 유지)
  if (S.open === undefined) S.open = false;
  const chev = h('span', { class: 'fold-chev', 'aria-hidden': 'true' }, icon('down', 22));
  const foldTxt = () => total + ' · ' + (S.open ? 'Close (접기)' : 'Open (펼치기)');
  const foldCount = h('span', { class: 'fold-count', id: 'rules-fold-count' }, foldTxt());
  const head = h('button', {
    type: 'button', class: 'set-h set-fold' + (S.open ? ' open' : ''), id: 'rules-toggle', 'aria-expanded': String(!!S.open), 'aria-controls': 'rules-body',
    onclick: () => {
      S.open = !S.open;
      const b = document.getElementById('rules-body');
      if (b) b.hidden = !S.open;
      head.classList.toggle('open', S.open);
      head.setAttribute('aria-expanded', String(S.open));
      foldCount.textContent = foldTxt();
    }
  }, h('span', { class: 'set-ic' }, icon('tag', 22)),
  h('h2', null, 'Auto-categorize rules ', h('span', { class: 'ko' }, '(자동 분류 규칙)')),
  foldCount, chev);
  const intro = h('p', { class: 'set-note' }, 'When a merchant name contains or starts with a word, that category is used automatically, e.g. starts with TGTG → Coffee (가게 이름에 단어가 들어 있거나 그 단어로 시작하면 자동으로 그 카테고리로 분류해요. 예: TGTG 로 시작 → 카페). Upper/lower case and symbols are ignored; the longest word wins (대소문자·기호는 무시, 가장 긴 단어가 우선).');

  // ── 목록
  const listBox = h('div', { class: 'rule-list', id: 'rule-list' });
  const countEl = h('div', { class: 'set-note', id: 'rule-count', role: 'status' });
  const moreBtn = h('button', { type: 'button', class: 'btn secondary sm', id: 'rule-more', onclick: () => { S.shown += PAGE; drawList(); } }, 'Show more (더 보기)');
  const search = h('input', {
    type: 'search', id: 'rule-q', value: S.q, placeholder: 'Search rules (규칙 검색)', autocomplete: 'off', 'aria-label': 'Search rules (규칙 검색)',
    oninput: (e) => { S.q = e.target.value; S.shown = PAGE; drawList(); }
  });

  function ruleRow(r) {
    const hits = L.num(r.hit_count);
    const pass = isPassthroughRule(r);
    const save = (patch, msg) => saveRows(api, [Object.assign({}, r, patch, { updated_at: L.nowIso(), deleted: false })], msg);
    return h('div', { class: 'rule-row', 'data-rule': r.rule_id },
      h('div', { class: 'rr-pat' }, h('b', { class: 'rr-p' }, String(r.pattern).replace(/^\s*\^/, '')),
        L.isStartsRule(r) ? h('span', { class: 'set-tag starts' }, 'Starts with (~로 시작)') : h('span', { class: 'set-tag dim' }, 'Contains (포함)'),
        pass ? h('span', { class: 'set-tag pass' }, 'Passthrough (전달 자금)') : null,
        h('span', { class: 'set-tag' }, hits + '× used (적중)'),
        r.source ? h('span', { class: 'set-tag dim' }, String(r.source).toLowerCase()) : null),
      catSelect(api, r.account_id, { class: 'rr-cat', onchange: (e) => { if (e.target.value) save({ account_id: e.target.value }, 'Category changed (카테고리를 바꿨어요)'); } }),
      ownerSelect(h, r.owner || '', { class: 'rr-own', onchange: (e) => save({ owner: e.target.value }, 'Owner changed (소유자를 바꿨어요)') }),
      h('button', {
        type: 'button', class: 'rr-del', 'aria-label': 'Delete rule ' + r.pattern + ' (규칙 삭제)', title: 'Delete (삭제)',
        onclick: async () => {
          if (!window.confirm('Delete the rule "' + r.pattern + '"? (이 규칙을 삭제할까요?) 이미 입력한 거래는 바뀌지 않습니다.')) return;
          await saveRows(api, [Object.assign({}, r, { deleted: true, updated_at: L.nowIso() })], 'Rule deleted (규칙을 삭제했어요)');
        }
      }, icon('trash', 20)));
  }

  function drawList() {
    const list = ruleList(rules, accMap, S.q);
    const part = list.slice(0, S.shown);
    listBox.replaceChildren();
    if (!list.length) {
      listBox.append(h('div', { class: 'set-empty' }, total
        ? 'No rule matches your search (검색과 맞는 규칙이 없어요).'
        : 'No rules yet (아직 규칙이 없어요). Add one below or use the quick presets (아래에서 추가하거나 자주 쓰는 규칙을 쓰세요).'));
    } else part.forEach((r) => listBox.append(ruleRow(r)));
    countEl.textContent = S.q ? list.length + ' of ' + total + ' rules (규칙 ' + total + '개 중 ' + list.length + '개)' : total + ' rules (규칙 ' + total + '개)';
    moreBtn.hidden = list.length <= S.shown;
  }

  // ── 새 규칙
  const newPat = h('input', {
    type: 'text', id: 'rule-new-pat', placeholder: 'e.g. Costco  (가맹점 이름 일부)', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Pattern (패턴)',
    oninput: () => { preview(); const n = L.normMerchant(newPat.value); normHint.textContent = n ? 'Saved as (저장 형태): "' + n + '"' + (n.length < 3 ? ' — 3 letters or fewer only matches the exact name (3글자 미만은 이름이 똑같을 때만 걸려요)' : '') : ''; }
  });
  const normHint = h('div', { class: 'hint', id: 'rule-new-hint' });
  const newCat = catSelect(api, '', { id: 'rule-new-cat' });
  const newOwn = ownerSelect(h, S.newOwner, { id: 'rule-new-own', onchange: (e) => { S.newOwner = e.target.value; } });
  const newErr = h('div', { class: 'err', id: 'rule-new-err', role: 'alert' });
  if (!S.match) S.match = 'contains';
  if (S.applyOld === undefined) S.applyOld = true;
  const matchSeg = h('div', { class: 'segtd rule-match', id: 'rule-new-match', role: 'radiogroup', 'aria-label': 'Match (맞추는 방법)' });
  const drawMatch = () => matchSeg.replaceChildren(...[['contains', 'Contains (포함)'], ['starts', 'Starts with (~로 시작)']].map(([v, lab]) => h('button', {
    type: 'button', role: 'radio', class: S.match === v ? 'on' : '', 'aria-checked': String(S.match === v), 'data-match': v,
    onclick: () => { S.match = v; drawMatch(); preview(); }
  }, lab)));
  const previewEl = h('div', { class: 'hint', id: 'rule-new-preview', role: 'status' });
  const applyBox = h('input', { type: 'checkbox', id: 'rule-new-apply', checked: S.applyOld, onchange: (e) => { S.applyOld = e.target.checked; } });
  const draftRule = () => ({ pattern: (S.match === 'starts' ? '^' : '') + L.normMerchant(newPat.value), account_id: newCat.value });
  function preview() {
    const n = L.normMerchant(newPat.value);
    if (!n) { previewEl.textContent = ''; return; }
    const all = matchingTxnIds(api.items, Object.assign(draftRule(), { account_id: '__none__' })).length;
    previewEl.textContent = all ? all + ' existing transactions match (기존 거래 ' + all + '건이 해당돼요)' : 'No existing transactions match yet (아직 해당하는 거래가 없어요)';
  }
  drawMatch();
  async function addRule() {
    const res = newRuleRow(rules, newPat.value, newCat.value, newOwn.value, L.nowIso(), S.match);
    if (res.error) { newErr.textContent = res.error; return; }
    const ids = S.applyOld ? matchingTxnIds(api.items, res.row) : [];
    if (res.mode === 'same' && !ids.length) { newErr.textContent = 'This rule already exists (이미 같은 규칙이 있어요).'; return; }
    newErr.textContent = '';
    let plan = null;
    if (ids.length) {
      const B = await import('./bulk.js');
      const patch = { categoryId: String(res.row.account_id) };
      if (res.row.owner) patch.owner = res.row.owner;
      plan = B.planBulk(api.items, ids, patch, accMap, L.nowIso());
      const b = B.batchOf(plan, res.mode === 'same' ? [] : [res.row], false);
      try {
        await api.saveBatch(b.puts, b.order);
        api.toast((res.mode === 'same' ? '' : 'Rule added (규칙을 추가했어요) · ') + plan.changed + ' existing changed (기존 거래 ' + plan.changed + '건 변경)' + (plan.skipped.length ? ' · skipped ' + plan.skipped.length + ' (건너뜀 ' + plan.skipped.length + ')' : ''));
        S.q = '';
      } catch (e) { api.toast('저장하지 못했습니다: ' + (e && e.message ? e.message : e)); }
      return;
    }
    const ok = await saveRows(api, [res.row], res.mode === 'update' ? 'Existing rule updated (기존 규칙의 분류를 바꿨어요)' : 'Rule added (규칙을 추가했어요)');
    if (ok) { S.q = ''; }
  }
  const addBox = h('div', { class: 'rule-add' },
    h('h3', { class: 'set-sub' }, 'Add a rule (새 규칙 추가)'),
    h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Match (맞추는 방법)'), matchSeg),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Word (단어 · 가맹점 이름 일부, 예: TGTG)'), newPat, normHint, previewEl),
    h('div', { class: 'two-set' },
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Category (카테고리)'), newCat),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Owner (소유자, 옵션)'), newOwn)),
    h('label', { class: 'check rule-apply' }, applyBox, ' Also change matching past transactions (해당하는 기존 거래도 바꾸기)'),
    newErr,
    h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn', id: 'rule-add', onclick: addRule }, icon('plus', 18), 'Add rule (규칙 추가)')));

  // ── 자주 쓰는 규칙
  const plan = presetPlan(api.accounts, rules);
  if (!S.sel) S.sel = defaultSelection(plan);
  const sel = S.sel;
  const presetBox = h('details', { class: 'rule-presets', id: 'rule-presets', open: S.presetOpen, ontoggle: (e) => { S.presetOpen = e.target.open; } },
    h('summary', null, 'Quick presets (자주 쓰는 규칙)'));
  const presetBody = h('div', { class: 'pr-body' });
  const addSel = h('button', { type: 'button', class: 'btn', id: 'preset-add' });
  function drawPresets() {
    presetBody.replaceChildren(h('p', { class: 'set-note' }, 'Matched to your own accounts by name (내 계좌표의 이름으로 자동 연결). Untick what you do not want, then add (원하지 않는 것은 체크를 풀고 추가하세요).'));
    plan.forEach((g) => {
      const open = g.items.filter((it) => it.status === 'new');
      const allOn = open.length > 0 && open.every((it) => sel.has(it.key));
      const grp = h('div', { class: 'pr-group', 'data-preset': g.id },
        h('label', { class: 'check pr-head' },
          h('input', {
            type: 'checkbox', checked: allOn, disabled: !open.length, 'aria-label': g.label + ' (' + g.ko + ')',
            onchange: (e) => { open.forEach((it) => { if (e.target.checked) sel.add(it.key); else sel.delete(it.key); }); drawPresets(); }
          }),
          h('span', null, h('b', null, g.label), ' ', h('span', { class: 'ko' }, '(' + g.ko + ')'))));
      g.items.forEach((it) => {
        const can = it.status === 'new';
        const acc = it.accountId && (S.choices.get(it.key) || it.accountId);
        grp.append(h('div', { class: 'pr-item' + (can ? '' : ' off'), 'data-key': it.key },
          h('label', { class: 'check' },
            h('input', {
              type: 'checkbox', checked: can && sel.has(it.key), disabled: !can, 'aria-label': it.pattern,
              onchange: (e) => { if (e.target.checked) sel.add(it.key); else sel.delete(it.key); drawPresets(); }
            }),
            h('span', { class: 'pr-pat' }, it.pattern)),
          h('span', { class: 'pr-arrow', 'aria-hidden': 'true' }, '→'),
          it.status === 'noacct' ? h('span', { class: 'set-tag warn' }, 'No matching account (맞는 계정이 없어요)')
            : it.candidates.length > 1 && can
              ? h('select', {
                class: 'pr-sel', 'aria-label': it.pattern + ' category', onchange: (e) => { S.choices.set(it.key, e.target.value); }
              }, it.candidates.map((a) => h('option', { value: String(a.account_id), selected: String(a.account_id) === String(acc) }, L.accLabel(a))))
              : h('span', { class: 'pr-acc' }, L.accLabel(accMap.get(String(it.accountId)) || { name: it.accountId })),
          it.status === 'exists' ? h('span', { class: 'set-tag dim' }, 'Already there (이미 있음)') : null,
          can && it.risky ? h('span', { class: 'set-tag warn', title: 'Short names can match other merchants' }, 'Short — may match others (짧아서 다른 가게에도 걸려요)') : null));
      });
      presetBody.append(grp);
    });
    const n = plan.reduce((c, g) => c + g.items.filter((it) => it.status === 'new' && sel.has(it.key)).length, 0);
    addSel.textContent = 'Add selected (선택한 것 추가)' + (n ? ' · ' + n : '');
    addSel.disabled = !n;
    presetBody.append(h('div', { class: 'btnrow' }, addSel));
  }
  addSel.addEventListener('click', async () => {
    const rows = presetRows(plan, sel, S.choices, rules, L.nowIso());
    if (!rows.length) { api.toast('Nothing new to add (추가할 새 규칙이 없어요)'); return; }
    S.sel = null; S.choices = new Map();
    await saveRows(api, rows, rows.length + ' rules added (규칙 ' + rows.length + '개를 추가했어요)');
  });
  presetBox.append(presetBody);

  drawList();
  drawPresets();
  return h('section', { class: 'card set-card wide', id: 'set-rules' }, head,
    h('div', { class: 'rules-body', id: 'rules-body', hidden: !S.open }, intro,
      h('div', { class: 'rule-tools' }, h('div', { class: 'search' }, icon('search', 20), search), countEl),
      listBox, h('div', { class: 'btnrow center' }, moreBtn), addBox, presetBox));
}
