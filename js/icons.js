// 직접 그린 아이콘 세트 (24×24 격자 · 선 굵기 1.8 · 둥근 끝).
// 모두 한 가족으로 보이도록: 윤곽선 + 아주 옅은 면(.a) 하나. 색은 글자색(currentColor)을 따라갑니다.
// 외부 아이콘 라이브러리를 쓰지 않으므로 오프라인에서도, 어떤 크기에서도 선명합니다.

const P = {
  // ── 주 메뉴
  ledger: '<rect class="a" x="4.5" y="3.5" width="15" height="17" rx="3.2"/><rect x="4.5" y="3.5" width="15" height="17" rx="3.2"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4"/>',
  accounts: '<rect class="a" x="3" y="6" width="18" height="12.5" rx="3.2"/><rect x="3" y="6" width="18" height="12.5" rx="3.2"/><path d="M3 10.4h18M6.6 14.8h3.6"/>',
  reports: '<rect class="a" x="10.1" y="4" width="3.8" height="16" rx="1.3"/><rect x="4" y="11" width="3.8" height="9" rx="1.3"/><rect x="10.1" y="4" width="3.8" height="16" rx="1.3"/><rect x="16.2" y="8" width="3.8" height="12" rx="1.3"/>',
  import: '<path class="a" d="M4.5 15h15v2.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z" stroke="none"/><path d="M12 4v10.2M8 10.4l4 4 4-4M4.5 15v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15"/>',
  settings: '<path d="M4 7h8.2M17.8 7H20M4 12h2.2M11.8 12H20M4 17h8.2M17.8 17H20"/><circle class="a" cx="15" cy="7" r="2.8"/><circle cx="15" cy="7" r="2.8"/><circle class="a" cx="9" cy="12" r="2.8"/><circle cx="9" cy="12" r="2.8"/><circle class="a" cx="15" cy="17" r="2.8"/><circle cx="15" cy="17" r="2.8"/>',
  // ── 동작
  plus: '<path d="M12 5v14M5 12h14"/>',
  scan: '<path d="M4 8V6.2A2.2 2.2 0 0 1 6.2 4H8M16 4h1.8A2.2 2.2 0 0 1 20 6.2V8M20 16v1.8a2.2 2.2 0 0 1-2.2 2.2H16M8 20H6.2A2.2 2.2 0 0 1 4 17.8V16"/><path d="M7.6 9.4h8.8M7.6 12.6h8.8M7.6 15.8h5"/>',
  send: '<path class="a" d="M20.6 3.4 3.5 10.1l6.6 2.8 2.8 6.6z" stroke="none"/><path d="M20.6 3.4 3.5 10.1l6.6 2.8 2.8 6.6zM10.1 12.9l10.5-9.5"/>',
  transfer: '<path d="M5 8h13.2M14.6 4.4 18.2 8l-3.6 3.6M19 16H5.8M9.4 12.4 5.8 16l3.6 3.6"/>',
  download: '<path d="M12 4v11M7.4 10.9l4.6 4.6 4.6-4.6M5 19.6h14"/>',
  print: '<path class="a" d="M4 10.5A1.5 1.5 0 0 1 5.5 9h13a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 15.5z" stroke="none"/><path d="M7 9V4.6h10V9M7 17H5.5A1.5 1.5 0 0 1 4 15.5v-5A1.5 1.5 0 0 1 5.5 9h13a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H17"/><path d="M7 13.6h10V20H7z"/>',
  filter: '<path d="M4 7h4.2M13.8 7H20M4 17h9.2M18.8 17H20"/><circle class="a" cx="11" cy="7" r="2.8"/><circle cx="11" cy="7" r="2.8"/><circle class="a" cx="16" cy="17" r="2.8"/><circle cx="16" cy="17" r="2.8"/>',
  search: '<circle class="a" cx="10.8" cy="10.8" r="6.6"/><circle cx="10.8" cy="10.8" r="6.6"/><path d="m15.8 15.8 4.4 4.4"/>',
  down: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  up: '<path d="m6.5 14.5 5.5-5.5 5.5 5.5"/>',
  left: '<path d="m14.5 6.5-5.5 5.5 5.5 5.5"/>',
  right: '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
  close: '<path d="m6.2 6.2 11.6 11.6M17.8 6.2 6.2 17.8"/>',
  check: '<path d="m5.2 12.6 4.4 4.4 9.2-9.6"/>',
  edit: '<path class="a" d="m4 20 1-4.3L16.4 4.3a2.1 2.1 0 0 1 3 0l.3.3a2.1 2.1 0 0 1 0 3L8.3 19z" stroke="none"/><path d="m4 20 1-4.3L16.4 4.3a2.1 2.1 0 0 1 3 0l.3.3a2.1 2.1 0 0 1 0 3L8.3 19zM14.6 6.2l3.2 3.2"/>',
  trash: '<path d="M4.8 7h14.4M9.4 7V5.2c0-.7.5-1.2 1.2-1.2h2.8c.7 0 1.2.5 1.2 1.2V7"/><path class="a" d="M6.6 7h10.8l-.8 11.2a2 2 0 0 1-2 1.8H9.4a2 2 0 0 1-2-1.8z" stroke="none"/><path d="m6.6 7 .8 11.2a2 2 0 0 0 2 1.8h5.2a2 2 0 0 0 2-1.8L17.4 7M10.2 11v5.2M13.8 11v5.2"/>',
  sync: '<path d="M19.6 10.6A7.8 7.8 0 0 0 6 7.4L4.4 9M4.4 4.6V9h4.4M4.4 13.4A7.8 7.8 0 0 0 18 16.6l1.6-1.6M19.6 19.4V15h-4.4"/>',
  calendar: '<rect class="a" x="4" y="5.4" width="16" height="14.6" rx="3.2"/><rect x="4" y="5.4" width="16" height="14.6" rx="3.2"/><path d="M4 10h16M8.6 3.4v4M15.4 3.4v4"/>',
  list: '<path d="M9.4 7H20M9.4 12H20M9.4 17H20"/><circle cx="5" cy="7" r=".6"/><circle cx="5" cy="12" r=".6"/><circle cx="5" cy="17" r=".6"/>',
  income: '<circle class="a" cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="9"/><path d="m8.6 15.4 6.8-6.8M10.2 8.6h5.2v5.2"/>',
  spend: '<circle class="a" cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="9"/><path d="m8.6 8.6 6.8 6.8M15.4 10.2v5.2h-5.2"/>',
  balance: '<path d="M12 4v16M7.4 20h9.2M5 7.2h14"/><path class="a" d="M2.8 13.4 5 7.2l2.2 6.2a2.9 2.9 0 0 1-4.4 0zM16.8 13.4 19 7.2l2.2 6.2a2.9 2.9 0 0 1-4.4 0z" stroke="none"/><path d="M2.8 13.4 5 7.2l2.2 6.2a2.9 2.9 0 0 1-4.4 0zM16.8 13.4 19 7.2l2.2 6.2a2.9 2.9 0 0 1-4.4 0z"/>',
  budget: '<path class="a" d="M3.6 16a8.4 8.4 0 0 1 16.8 0z" stroke="none"/><path d="M3.6 16a8.4 8.4 0 0 1 16.8 0M12 16l3.8-4.6M3.6 20h16.8"/><circle cx="12" cy="16" r="1.1"/>',
  more: '<circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.5" cy="12" r="1.4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  split: '<path d="M12 4v5.4M12 9.4 6.2 14.6V20M12 9.4l5.8 5.2V20"/><circle class="a" cx="12" cy="5" r="1.9"/><circle cx="12" cy="4.6" r="1.4"/>',
  info: '<circle class="a" cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="9"/><path d="M12 11v5.2M12 7.7h.01"/>',
  alert: '<path class="a" d="M12 4.2 21 19.8H3z" stroke="none"/><path d="M12 4.2 21 19.8H3zM12 10v4.6M12 17.4h.01"/>',
  memo: '<path class="a" d="M5 5h14v10.2L15.2 19H5z" stroke="none"/><path d="M5 5h14v10.2L15.2 19H5zM15.2 19v-3.8H19M8.6 9.4h6.8M8.6 12.8h3.2"/>',
  tag: '<path class="a" d="M3.8 12.4V5.6c0-.99.8-1.8 1.8-1.8h6.8l8 8a1.8 1.8 0 0 1 0 2.5l-6.5 6.5a1.8 1.8 0 0 1-2.5 0z" stroke="none"/><path d="M3.8 12.4V5.6c0-.99.8-1.8 1.8-1.8h6.8l8 8a1.8 1.8 0 0 1 0 2.5l-6.5 6.5a1.8 1.8 0 0 1-2.5 0z"/><circle cx="8.2" cy="8.2" r="1.2"/>',
  spark: '<path class="a" d="m12 3.6 2 5.9 5.9 2-5.9 2-2 5.9-2-5.9-5.9-2 5.9-2z" stroke="none"/><path d="m12 3.6 2 5.9 5.9 2-5.9 2-2 5.9-2-5.9-5.9-2 5.9-2z"/>',
  camera: '<path class="a" d="M3.5 8.4A1.9 1.9 0 0 1 5.4 6.5h2l1.3-2h6.6l1.3 2h2a1.9 1.9 0 0 1 1.9 1.9v9.2a1.9 1.9 0 0 1-1.9 1.9H5.4a1.9 1.9 0 0 1-1.9-1.9z" stroke="none"/><path d="M3.5 8.4A1.9 1.9 0 0 1 5.4 6.5h2l1.3-2h6.6l1.3 2h2a1.9 1.9 0 0 1 1.9 1.9v9.2a1.9 1.9 0 0 1-1.9 1.9H5.4a1.9 1.9 0 0 1-1.9-1.9z"/><circle cx="12" cy="13" r="3.4"/>',
  lock: '<rect class="a" x="5" y="10.6" width="14" height="9.4" rx="2.6"/><rect x="5" y="10.6" width="14" height="9.4" rx="2.6"/><path d="M8.2 10.6V8a3.8 3.8 0 0 1 7.6 0v2.6"/>',
  open: '<path d="M13.6 4.6H19.4v5.8M19.4 4.6 11 13M17 14v3.4a2 2 0 0 1-2 2H6.6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2H10"/>',
  select: '<rect class="a" x="4" y="4" width="16" height="16" rx="4.4"/><rect x="4" y="4" width="16" height="16" rx="4.4"/><path d="m8.2 12.4 2.7 2.7 5-5.4"/>',
  sheet: '<path class="a" d="M5 4.6A1.6 1.6 0 0 1 6.6 3h7.6l4.8 4.8v11.6A1.6 1.6 0 0 1 17.4 21H6.6A1.6 1.6 0 0 1 5 19.4z" stroke="none"/><path d="M5 4.6A1.6 1.6 0 0 1 6.6 3h7.6l4.8 4.8v11.6A1.6 1.6 0 0 1 17.4 21H6.6A1.6 1.6 0 0 1 5 19.4zM14 3v5h5M8.4 13h7.2M8.4 16.6h7.2"/>'
};

export const ICON_NAMES = Object.keys(P);

/** SVG 문자열 */
export function svg(name, size, cls) {
  const body = P[name];
  if (!body) return '';
  const s = size || 20;
  return '<svg class="ic' + (cls ? ' ' + cls : '') + '" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
}

/** DOM 요소 */
export function icon(name, size, cls) {
  const t = document.createElement('template');
  t.innerHTML = svg(name, size, cls);
  return t.content.firstChild || document.createTextNode('');
}

// 로고: 둥근 초록 면 위에 지붕과 장부 줄. (집 + 장부 = 우리집 장부)
export const LOGO_PATHS =
  '<path d="M13.5 31 32 14.8 50.5 31" stroke="#fff" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
  '<path d="M19 28.6V46a3.4 3.4 0 0 0 3.4 3.4h19.2A3.4 3.4 0 0 0 45 46V28.6" stroke="#fff" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
  '<path d="M25.5 35.2h13M25.5 41.4h8" stroke="#feef60" stroke-width="3.4" stroke-linecap="round" fill="none"/>';

export function logoSvg(size, id) {
  const g = 'lg' + (id || '');
  return '<svg class="logo" width="' + size + '" height="' + size + '" viewBox="0 0 64 64" role="img" aria-label="Home Ledger"><defs><linearGradient id="' + g + '" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4fb52c"/><stop offset="1" stop-color="#2c7a1a"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#' + g + ')"/>' + LOGO_PATHS + '</svg>';
}
