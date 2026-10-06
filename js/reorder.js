// 손가락(터치)·마우스 둘 다 되는 끌어서 순서 바꾸기. (HTML5 drag & drop 은 iPhone Safari 에서 잘 안 되므로 pointer 이벤트로 직접 구현)
//
// makeSortable(root, {
//   list: '.ro-list',          // 항목을 담는 목록(여러 개 가능 = 그룹). 항목은 그 목록의 바로 아래 자식
//   item: '.ro-item',          // 끌 수 있는 항목
//   handle: '.ro-grip',        // 잡는 곳 (touch-action:none 이어야 iOS 가 화면을 스크롤하지 않음)
//   canDrop(itemEl, listEl),   // 이 목록으로 옮겨도 되는지 (예: 수입 ↔ 지출 금지)
//   onDrop(itemEl, fromList, toList)   // 놓은 뒤 (DOM 은 이미 옮겨져 있음)
// }) → { destroy() }
//
// 위치 계산은 getBoundingClientRect 만 씁니다 (elementFromPoint 를 쓰지 않아 테스트에서도 흉내 낼 수 있음).

export function makeSortable(root, opt) {
  const o = Object.assign({ list: '.ro-list', item: '.ro-item', handle: '.ro-grip', canDrop: () => true, onDrop: () => {} }, opt || {});
  let drag = null;

  const lists = () => Array.from(root.querySelectorAll(o.list));
  const itemsOf = (list) => Array.from(list.children).filter((c) => c.matches && c.matches(o.item));
  const rectOf = (el) => el.getBoundingClientRect();
  const layoutTop = (el) => rectOf(el).top - (drag && el === drag.el ? drag.ty : 0);

  function onDown(e) {
    if (drag) return;
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    const handle = e.target.closest && e.target.closest(o.handle);
    if (!handle || !root.contains(handle)) return;
    const el = handle.closest(o.item);
    if (!el) return;
    e.preventDefault();
    const r = rectOf(el);
    drag = { el, from: el.parentNode, pid: e.pointerId, grab: e.clientY - r.top, ty: 0, y: e.clientY, raf: 0 };
    try { handle.setPointerCapture && e.pointerId !== undefined && handle.setPointerCapture(e.pointerId); } catch (err) { /* jsdom */ }
    el.classList.add('dragging');
    root.classList.add('ro-active');
    const doc = root.ownerDocument;
    doc.addEventListener('pointermove', onMove, { passive: false });
    doc.addEventListener('pointerup', onUp);
    doc.addEventListener('pointercancel', onUp);
    autoScroll();
  }

  function place(y) {
    const el = drag.el;
    // 1) 손가락이 있는 목록 고르기 (세로로 가장 가까운 목록, 넣을 수 있는 것만)
    let best = null, bestD = Infinity;
    lists().forEach((l) => {
      if (l !== drag.el.parentNode && !o.canDrop(el, l)) return;
      const r = rectOf(l);
      const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (d < bestD) { bestD = d; best = l; }
    });
    if (!best) return;
    // 2) 목록 안에서 들어갈 자리: 손가락보다 가운데가 아래인 첫 항목 앞
    const sibs = itemsOf(best).filter((c) => c !== el);
    let before = null;
    for (const c of sibs) { const r = rectOf(c); if (y < r.top + r.height / 2) { before = c; break; } }
    if (el.parentNode !== best || el.nextElementSibling !== before) {
      if (before) best.insertBefore(el, before);
      else {
        // 목록 끝 (목록 안에 "추가" 버튼 같은 다른 자식이 있으면 그 앞)
        const tail = Array.from(best.children).find((c) => c !== el && !c.matches(o.item) && c.hasAttribute('data-ro-tail'));
        best.insertBefore(el, tail || null);
      }
    }
  }

  function onMove(e) {
    if (!drag || (drag.pid !== undefined && e.pointerId !== undefined && e.pointerId !== drag.pid)) return;
    e.preventDefault();
    drag.y = e.clientY;
    update();
  }

  function update() {
    place(drag.y);
    // 끌고 있는 항목이 손가락을 따라오게 (자리는 이미 옮겼으니 원래 자리와의 차이만큼만 이동)
    const top0 = layoutTop(drag.el);
    drag.ty = drag.y - drag.grab - top0;
    drag.el.style.transform = 'translateY(' + Math.round(drag.ty) + 'px)';
  }

  // 화면 위/아래 끝에 가까우면 천천히 스크롤
  function autoScroll() {
    const win = root.ownerDocument.defaultView;
    if (!win || !win.requestAnimationFrame) return;
    const step = () => {
      if (!drag) return;
      const H = win.innerHeight || 0, edge = 70;
      let dy = 0;
      if (drag.y < edge + 60) dy = -Math.ceil((edge + 60 - drag.y) / 6);
      else if (drag.y > H - edge) dy = Math.ceil((drag.y - (H - edge)) / 6);
      if (dy) { win.scrollBy(0, dy); update(); }
      drag.raf = win.requestAnimationFrame(step);
    };
    drag.raf = win.requestAnimationFrame(step);
  }

  function onUp() {
    if (!drag) return;
    const d = drag;
    drag = null;
    const doc = root.ownerDocument;
    doc.removeEventListener('pointermove', onMove);
    doc.removeEventListener('pointerup', onUp);
    doc.removeEventListener('pointercancel', onUp);
    if (d.raf && doc.defaultView && doc.defaultView.cancelAnimationFrame) doc.defaultView.cancelAnimationFrame(d.raf);
    d.el.style.transform = '';
    d.el.classList.remove('dragging');
    d.el.classList.add('dropped');
    setTimeout(() => d.el.classList.remove('dropped'), 400);
    root.classList.remove('ro-active');
    o.onDrop(d.el, d.from, d.el.parentNode);
  }

  root.addEventListener('pointerdown', onDown);
  return { destroy() { root.removeEventListener('pointerdown', onDown); if (drag) onUp(); } };
}
