// "이 분류를 앞으로도 쓸까요?" — 내가 직접 고른 분류만 물어보고, 체크한 것만 규칙으로 저장합니다.
import * as L from './ledger.js';
import * as sync from './sync.js';
import { rulesFromRemember } from './importer.js';

// entries = [{ merchant, accountId, previousAccountId }]
// api = { h, toast, accMap, data, reload }   → 닫힐 때 끝나는 약속(Promise)
export function openRemember(api, entries) {
  const list = (entries || []).filter((e) => e && e.merchant && api.accMap.has(String(e.accountId)));
  if (!list.length) return Promise.resolve(false);
  const { h } = api;
  return new Promise((resolve) => {
    const ov = document.getElementById('overlay');
    ov.hidden = false;
    document.body.classList.add('noscroll');
    const close = (saved) => { ov.hidden = true; ov.replaceChildren(); document.body.classList.remove('noscroll'); resolve(saved); };
    const checks = list.map(() => true);
    const name = (id) => { const a = api.accMap.get(String(id)); return a ? L.accLabel(a) : String(id); };
    const err = h('div', { class: 'err', id: 'rm-err', role: 'alert' });
    const rows = list.map((e, i) => h('label', { class: 'check rm-row' },
      h('input', { type: 'checkbox', checked: true, 'data-i': i, onchange: (ev) => { checks[i] = ev.target.checked; } }),
      h('span', null,
        h('b', null, e.merchant), ' → ', h('b', { class: 'rm-cat' }, name(e.accountId)),
        e.previousAccountId ? h('span', { class: 'muted' }, '  (was 이전: ' + name(e.previousAccountId) + ')') : null)));
    ov.replaceChildren(h('div', { class: 'backdrop' }, h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Remember categories' },
      h('div', { class: 'sheet-head' }, h('h2', null, 'Remember this? (기억할까요?)'),
        h('button', { type: 'button', class: 'icon', 'aria-label': 'Close (닫기)', onclick: () => close(false) }, '✕')),
      h('p', { class: 'hint' }, 'Use these categories automatically from now on? Untick any you want to decide each time. (다음부터 이 가게는 자동으로 이렇게 분류할까요? 매번 정하고 싶은 것은 체크를 풀어 주세요.)'),
      h('div', { id: 'rm-list' }, rows),
      err,
      h('div', { class: 'btnrow' },
        h('button', { type: 'button', class: 'btn', id: 'rm-yes', onclick: async () => {
          const chosen = list.filter((_, i) => checks[i]);
          if (!chosen.length) { close(false); return; }
          try {
            const rules = rulesFromRemember(chosen, api.data.rules, L.nowIso());
            await sync.saveBatch({ Rules: rules }, ['Rules']);
            close(true);
            api.toast('Remembered ' + chosen.length + ' (' + chosen.length + '곳 기억함)');
            if (api.reload) await api.reload();
          } catch (e) { err.textContent = '저장하지 못했습니다: ' + (e.message || e); }
        } }, 'Remember (기억하기)'),
        h('button', { type: 'button', class: 'btn secondary', id: 'rm-no', onclick: () => close(false) }, 'Not now (이번만)')))));
  });
}
