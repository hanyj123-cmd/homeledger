// 화면 표시 설정 (이 기기에만 저장): 언어(한/영) · 보고서 달러 단위 반올림.
// 앱의 라벨은 모두 "English (한국어)" 형태로 쓰고, tr() 이 선택된 언어 쪽만 남깁니다.

const LANG_KEY = 'hl_lang';      // 'ko' | 'en' | '' (둘 다)
const ROUND_KEY = 'hl_round';    // '1' = 보고서 금액을 달러 단위로 반올림

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { if (v === null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

/** 'ko' | 'en' | 'both' */
export function lang() { const v = lsGet(LANG_KEY); return v === 'ko' || v === 'en' ? v : 'both'; }
export function setLang(v) { lsSet(LANG_KEY, v === 'ko' || v === 'en' ? v : ''); }

/** 보고서 금액을 달러 단위(소수점 없이)로 보일지 */
export function rounded() { return lsGet(ROUND_KEY) === '1'; }
export function setRounded(on) { lsSet(ROUND_KEY, on ? '1' : ''); }

const HANGUL = /[ㄱ-ㆎ가-힣]/;
const PAIR = /\s*\(([^()]*[ㄱ-ㆎ가-힣][^()]*)\)/g;

/**
 * "Save (저장)" → en: "Save", ko: "저장", both: 그대로.
 * 괄호 안에 한글이 있는 부분만 짝으로 봅니다. 문장 중간의 짝이 여러 개면:
 *  en → 괄호 부분만 지움, ko → 한글 부분들을 이어 붙임 (영어 부분은 버림)
 */
export function tr(s, mode) {
  const m = mode || lang();
  if (m === 'both' || typeof s !== 'string' || !HANGUL.test(s) || s.indexOf('(') < 0) return s;
  if (!/[A-Za-z]{2,}/.test(s.replace(PAIR, ''))) return s;   // 괄호 밖이 한글뿐이면 (예: "급여 (실수령)") 그대로
  if (m === 'en') {
    return s.replace(PAIR, '').replace(/\s+([.,;:!?)])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  }
  // ko: 각 "영어 (한국어)" 짝에서 영어 부분을 한국어로 바꾸고, 짝 사이의 기호(· : , 숫자 앞 기호 등)는 살립니다
  let out = '', last = 0, mm;
  const re = new RegExp(PAIR.source, 'g');
  while ((mm = re.exec(s))) {
    const chunk = s.slice(last, mm.index);
    const lead = (/^[^A-Za-z0-9]*/.exec(chunk) || [''])[0];
    out += (/[A-Za-z]/.test(chunk) ? lead : chunk) + mm[1].trim();
    last = re.lastIndex;
  }
  const rest = s.slice(last);
  out += /[A-Za-z]{3,}/.test(rest) && !/^[\s.,:;!?)·\-–—\d$%+]*$/.test(rest) ? (/^[^A-Za-z]*/.exec(rest) || [''])[0].replace(/\s+$/, '') : rest;
  return out.trim();
}

const ATTRS = ['aria-label', 'title', 'placeholder', 'alt'];
const done = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
function fixText(node, m) {
  const v = node.nodeValue;
  if (!v || !HANGUL.test(v)) return;
  const t = tr(v, m);
  if (t !== v) node.nodeValue = (/^\s/.test(v) ? ' ' : '') + t + (/\s$/.test(v) ? ' ' : '');
}
function fixEl(el, m) {
  for (const a of ATTRS) { const v = el.getAttribute && el.getAttribute(a); if (v && HANGUL.test(v)) { const t = tr(v, m); if (t !== v) el.setAttribute(a, t); } }
  // 영어와 한국어가 다른 요소로 나뉜 짝: "Account <span class="ko">(계정)</span>", "<b>Auto</b><span class="ko">자동</span>"
  if (el.nodeType === 1 && el.childElementCount === 0 && el.parentNode && !el.__hlDone) {
    const own = (el.textContent || '').trim();
    const isKo = el.classList && (el.classList.contains('ko') || el.classList.contains('sm-ko'));
    const paren = /^\(([^()]*[\u3131-\u318E\uAC00-\uD7A3][^()]*)\)$/.exec(own);
    if ((isKo && HANGUL.test(own)) || (paren && prevLatin(el))) {
      el.__hlDone = true;
      if (m === 'en') { el.textContent = ''; el.style.display = 'none'; }
      else if (m === 'ko') {
        if (paren) el.textContent = paren[1];
        const prev = prevLatin(el);
        if (prev) { if (prev.nodeType === 3) prev.nodeValue = ''; else prev.style.display = 'none'; }
        el.classList.add('hl-ko-main');
      }
    }
  }
}
// 바로 앞(공백 건너뜀)의 영어 글자 노드 또는 영어만 있는 작은 요소
function prevLatin(el) {
  let p = el.previousSibling;
  while (p && p.nodeType === 3 && !p.nodeValue.trim()) p = p.previousSibling;
  if (!p) return null;
  if (p.nodeType === 3) return /[A-Za-z]/.test(p.nodeValue) && !HANGUL.test(p.nodeValue) ? p : null;
  if (p.nodeType === 1 && p.childElementCount === 0 && /^(B|SPAN|STRONG|EM|I)$/.test(p.nodeName) && /[A-Za-z]/.test(p.textContent) && !HANGUL.test(p.textContent)) return p;
  return null;
}
/** root 아래 글자를 선택된 언어로 바꿉니다 */
export function translateTree(root, mode) {
  const m = mode || lang();
  if (m === 'both' || !root) return;
  if (root.nodeType === 3) { fixText(root, m); return; }
  if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
  if (root.nodeType === 1) fixEl(root, m);
  const doc = root.ownerDocument || root;
  const w = doc.createTreeWalker(root, 5 /* ELEMENT | TEXT */);
  let n = w.nextNode();
  while (n) {
    if (n.nodeType === 3) {
      const p = n.parentNode;
      if (!(p && (p.nodeName === 'SCRIPT' || p.nodeName === 'STYLE' || p.nodeName === 'TEXTAREA'))) fixText(n, m);
    } else if (!(n.nodeName === 'INPUT' && done && done.has(n))) fixEl(n, m);
    n = w.nextNode();
  }
}
let obs = null;
/** 문서 전체를 지켜보며 새로 그려지는 부분도 바꿉니다 (언어가 '둘 다'면 아무것도 안 함) */
export function startTranslating(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const m = lang();
  if (!d || m === 'both') return;
  d.documentElement.setAttribute('lang', m);
  d.documentElement.setAttribute('data-lang', m);
  translateTree(d.body, m);
  if (typeof MutationObserver === 'undefined') return;
  if (obs) obs.disconnect();
  obs = new MutationObserver((list) => {
    for (const r of list) {
      if (r.type === 'childList') r.addedNodes.forEach((n) => translateTree(n, m));
      else if (r.type === 'characterData') fixText(r.target, m);
      else if (r.type === 'attributes') fixEl(r.target, m);
    }
  });
  obs.observe(d.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
export function stopTranslating() { if (obs) obs.disconnect(); obs = null; }
