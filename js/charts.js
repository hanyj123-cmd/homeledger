/* Home Ledger charts — hand-written SVG/HTML charts, no dependencies.
   Needs charts.css (palette variables --c1..--c8, tooltip, legend, animation).
   Every chart function returns a wrapper <div class="ch"> with .update(newOpts) and .destroy(). */

const NS = 'http://www.w3.org/2000/svg';
const EMPTY_TEXT = 'No data yet (아직 데이터가 없습니다)';
const OTHER_NAME = 'Other (기타)';
let UID = 0;

/* ───────────────────────── small helpers ───────────────────────── */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const crisp = (v) => Math.round(v) + 0.5;
const r2 = (v) => Math.round(v * 100) / 100;
const pal = (i) => `var(--c${(i % 8) + 1})`;

function S(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      n.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (parent) parent.appendChild(n);
  return n;
}
function H(tag, cls, text, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== null && text !== undefined) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
}
function T(parent, x, y, str, cls, anchor, extra) {
  const t = S('text', { x: r2(x), y: r2(y), class: cls, 'text-anchor': anchor || 'start', ...(extra || {}) }, parent);
  t.textContent = str;
  return t;
}
const setColor = (node, prop, c) => { if (c) node.style.setProperty(prop, c); };

/** Rough text width (px) — good enough for label thinning. */
function tw(str, size = 11) {
  let w = 0;
  for (const ch of String(str)) w += ch.charCodeAt(0) > 0x2e80 ? size : size * 0.57;
  return w;
}
function ellipsize(str, maxW, size = 11) {
  str = String(str);
  if (tw(str, size) <= maxW) return str;
  let out = '';
  for (const ch of str) {
    if (tw(out + ch + '…', size) > maxW) break;
    out += ch;
  }
  return out ? out + '…' : '…';
}
/** Up to three short lines: "Semi-fixed (준고정비)" → ["Semi-", "fixed", "(준고정비)"] depending on room. */
function wrapLabel(name, maxW, size = 11) {
  name = String(name);
  if (tw(name, size) <= maxW) return [name];
  const k = name.indexOf(' (');
  const en = k > 0 ? name.slice(0, k) : name;
  const ko = k > 0 ? name.slice(k + 1) : '';
  let lines;
  if (tw(en, size) <= maxW) lines = [en];
  else {
    const m = /^(.+?[- ])(.+)$/.exec(en);
    lines = m ? [ellipsize(m[1].trim() === m[1] ? m[1] : m[1].trimEnd(), maxW, size), ellipsize(m[2], maxW, size)] : [ellipsize(en, maxW, size)];
  }
  if (ko && tw(ko, size) <= maxW) lines.push(ko);
  return lines;
}

const defFmt = (n) => (isNum(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—');
/** Compact axis formatter: 1.2k, 3M. */
export function compact(n) {
  if (!isNum(n)) return '';
  const a = Math.abs(n);
  const t = (x) => String(+x.toFixed(1));
  let s;
  if (a >= 1e9) s = t(n / 1e9) + 'B';
  else if (a >= 1e6) s = t(n / 1e6) + 'M';
  else if (a >= 1e4) s = t(n / 1e3) + 'k';
  else s = Number.isInteger(n) ? String(n) : String(+n.toFixed(2));
  if (s === '-0') s = '0';
  return s.replace('-', '−');
}
function mkFmt(f) {
  return (n) => {
    try {
      const r = (f || defFmt)(n);
      return r === null || r === undefined ? '' : String(r);
    } catch (e) {
      return String(n);
    }
  };
}
const signed = (fmt, v) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v));

function fillVals(vals, n) {
  const a = Array.isArray(vals) ? vals : [];
  return Array.from({ length: n }, (_, i) => (isNum(a[i]) ? a[i] : null));
}
const allEmpty = (arrays) => arrays.every((a) => a.every((v) => v === null || v === 0));

/** "Nice" axis: returns {d0, d1, ticks}. */
export function niceTicks(lo, hi, count = 5, fixedMin, fixedMax) {
  if (!isNum(lo)) lo = 0;
  if (!isNum(hi)) hi = 1;
  if (isNum(fixedMin)) lo = fixedMin;
  if (isNum(fixedMax)) hi = fixedMax;
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) {
    if (lo === 0) hi = 1;
    else if (lo > 0) { hi = lo * 1.2; lo = 0; } else { lo = lo * 1.2; hi = 0; }
  }
  count = Math.max(1, count);
  const raw = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
  const dec = Math.max(0, Math.min(10, 1 - Math.floor(Math.log10(step))));
  const d0 = isNum(fixedMin) ? fixedMin : Math.floor(lo / step + 1e-9) * step;
  const d1 = isNum(fixedMax) ? fixedMax : Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  const k0 = Math.ceil(d0 / step - 1e-9);
  const k1 = Math.floor(d1 / step + 1e-9);
  for (let k = k0; k <= k1 && ticks.length < 14; k++) ticks.push(+(k * step).toFixed(dec));
  return { d0: +d0.toFixed(dec), d1: +d1.toFixed(dec), ticks, step };
}

/** Percentages (largest remainder) that add up to exactly 100. */
export function percents(values, decimals = 0) {
  const vs = values.map((v) => (isNum(v) && v > 0 ? v : 0));
  const total = vs.reduce((a, b) => a + b, 0);
  if (total <= 0) return vs.map(() => 0);
  const f = Math.pow(10, decimals);
  const raw = vs.map((v) => (v / total) * 100 * f);
  const fl = raw.map(Math.floor);
  let rem = Math.round(100 * f) - fl.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - fl[i], i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rem > 0 && k < order.length; k++, rem--) fl[order[k][1]] += 1;
  return fl.map((v) => v / f);
}

/** Fritsch–Carlson monotone cubic through pts [{x,y}] → "M…C…" path data. */
export function curvePath(pts, smooth) {
  const n = pts.length;
  if (!n) return '';
  let d = `M${r2(pts[0].x)} ${r2(pts[0].y)}`;
  if (n === 1) return d;
  if (!smooth || n === 2) {
    for (let i = 1; i < n; i++) d += `L${r2(pts[i].x)} ${r2(pts[i].y)}`;
    return d;
  }
  const m = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    m.push(dx === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx);
  }
  const t = new Array(n);
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      t[i] = tau * a * m[i];
      t[i + 1] = tau * b * m[i];
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const dx = (pts[i + 1].x - pts[i].x) / 3;
    d += `C${r2(pts[i].x + dx)} ${r2(pts[i].y + t[i] * dx)} ${r2(pts[i + 1].x - dx)} ${r2(pts[i + 1].y - t[i + 1] * dx)} ${r2(pts[i + 1].x)} ${r2(pts[i + 1].y)}`;
  }
  return d;
}

/** Rounded rectangle with only one side (the data end) rounded. side: top|bottom|left|right|none|all */
function rrect(x, y, w, h, r, side) {
  x = r2(x); y = r2(y); w = r2(w); h = r2(h);
  if (w <= 0 || h <= 0) return '';
  const vertical = side === 'top' || side === 'bottom';
  r = side === 'none' ? 0 : Math.max(0, Math.min(r, vertical || side === 'all' ? w / 2 : h / 2, vertical || side === 'all' ? h : w));
  if (r === 0) return `M${x} ${y}h${w}v${h}h${-w}Z`;
  if (side === 'all') return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}Z`;
  if (side === 'top') return `M${x} ${y + h}V${y + r}a${r} ${r} 0 0 1 ${r} ${-r}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}V${y + h}Z`;
  if (side === 'bottom') return `M${x} ${y}H${x + w}V${y + h - r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}Z`;
  if (side === 'right') return `M${x} ${y}H${x + w - r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}H${x}Z`;
  /* left */
  return `M${x + w} ${y}H${x + r}a${r} ${r} 0 0 0 ${-r} ${r}v${h - 2 * r}a${r} ${r} 0 0 0 ${r} ${r}H${x + w}Z`;
}

function labelPicker(labels, centers, pitch, W) {
  const n = labels.length;
  if (!n) return [];
  const maxW = Math.max(...labels.map((l) => tw(l)));
  const step = Math.max(1, Math.ceil((maxW + 12) / Math.max(pitch, 1)));
  const idx = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  const last = idx[idx.length - 1];
  if (last !== n - 1 && (n - 1 - last) * pitch >= maxW + 12) idx.push(n - 1);
  return idx.map((i) => {
    const w = tw(labels[i]);
    const c = centers[i];
    let anchor = 'middle';
    let x = c;
    if (c - w / 2 < 2) { anchor = 'start'; x = 2; } else if (c + w / 2 > W - 2) { anchor = 'end'; x = W - 2; }
    return { i, x, anchor };
  });
}

function drawYGrid(svg, o) {
  const g = S('g', { class: 'ch-grid' }, svg);
  for (const t of o.scale.ticks) {
    const y = crisp(o.y(t));
    const isBase = t === o.scale.d0;
    if (!o.noLabels || isBase) S('line', { x1: o.left, x2: o.W - o.right, y1: y, y2: y, class: 'ch-gl' + (isBase ? ' base' : '') }, g);
    if (!o.noLabels) T(g, o.left - 8, y, o.afmt(t), 'ch-axt', 'end', { dy: '0.32em' });
  }
  if (o.zeroLine !== false && o.scale.d0 < 0 && o.scale.d1 > 0) {
    const y = crisp(o.y(0));
    S('line', { x1: o.left, x2: o.W - o.right, y1: y, y2: y, class: 'ch-zero' }, g);
  }
}
function drawRefLines(svg, o) {
  for (const r of o.refLines || []) {
    if (!r || !isNum(r.value)) continue;
    const y = crisp(o.y(r.value));
    if (y < o.top - 1 || y > o.H - o.bottom + 1) continue;
    const g = S('g', { class: 'ch-ref' }, svg);
    const ln = S('line', { x1: o.left, x2: o.W - o.right, y1: y, y2: y }, g);
    setColor(ln, 'stroke', r.color);
    if (r.label) T(g, o.left + 6, y - 5, r.label, 'ch-reft', 'start');
  }
}
function drawXLabels(svg, o) {
  const g = S('g', { class: 'ch-xl' }, svg);
  for (const p of labelPicker(o.labels, o.centers, o.pitch, o.W)) T(g, p.x, o.H - o.bottom + 17, o.labels[p.i], 'ch-axt', p.anchor);
}

function ariaFor(opts, kind, names, labels, n) {
  const title = opts.title || opts.ariaLabel || '';
  const parts = [];
  if (title) parts.push(title);
  parts.push(kind + (names.length ? ': ' + names.join(', ') : ''));
  if (n > 0 && labels && labels.length) parts.push(`${n} points from ${labels[0]} to ${labels[labels.length - 1]}`);
  return parts.join('. ');
}

/* ───────────────────────── chart base (wrapper, legend, tooltip, input) ───────────────────────── */

const normSel = (v) => (v === undefined || v === null ? null : v);

function createChart(kind, opts0, build, cfg = {}) {
  const uid = ++UID;
  const st = {
    opts: { ...(opts0 || {}) },
    hidden: new Set(),
    active: null,
    selected: normSel(opts0 && opts0.selected),
    W: 0,
    model: null,
    animated: false,
    dead: false,
    modality: 'mouse',
    lastPt: null,
  };
  const root = H('div', `ch ch-${kind}`);
  if (cfg.focusable !== false) {
    root.tabIndex = 0;
    root.setAttribute('role', 'group');
  }
  const body = H('div', 'ch-body', null, root);
  const legendEl = H('div', 'ch-legend', null, root);
  legendEl.hidden = true;
  const tip = H('div', 'ch-tip', null, root);
  tip.setAttribute('aria-hidden', 'true');
  const sr = H('div', 'ch-sr', null, root);
  sr.setAttribute('aria-live', 'polite');
  let legendKeys = '';
  let ro = null;
  let roTimer = 0;
  let raf = 0;
  let downX = 0;

  const measure = () => {
    const w = root.clientWidth;
    return w > 0 ? w : st.opts.width || 640;
  };

  /* legend */
  function syncLegend(items) {
    const show = items && items.length && st.opts.legend !== false && (items.length > 1 || st.opts.legend === true);
    if (!show) { legendEl.hidden = true; legendEl.textContent = ''; legendKeys = ''; return; }
    legendEl.hidden = false;
    const keys = items.map((i) => i.key).join('\u0001');
    if (keys !== legendKeys) {
      legendKeys = keys;
      legendEl.textContent = '';
      for (const it of items) {
        const b = H('button', 'ch-lg', null, legendEl);
        b.type = 'button';
        b.dataset.key = it.key;
        const sw = H('span', 'ch-lg-sw ' + (it.type || 'bar'), null, b);
        sw.dataset.color = it.color;
        H('span', 'ch-lg-n', it.name, b);
        b.addEventListener('click', () => {
          if (st.hidden.has(it.key)) st.hidden.delete(it.key); else st.hidden.add(it.key);
          render(false);
        });
      }
    }
    const btns = legendEl.children;
    items.forEach((it, i) => {
      const b = btns[i];
      b.setAttribute('aria-pressed', it.off ? 'false' : 'true');
      b.classList.toggle('off', !!it.off);
      const sw = b.firstChild;
      if (it.type === 'dash') {
        sw.style.background = `repeating-linear-gradient(90deg, ${it.color} 0 4px, transparent 4px 7px)`;
      } else sw.style.background = it.color;
    });
  }

  /* tooltip */
  function hideTip() {
    tip.classList.remove('on');
  }
  function fillTip(info) {
    tip.textContent = '';
    if (info.title) H('div', 'ch-tip-h', info.title, tip);
    for (const r of info.rows || []) {
      const row = H('div', 'ch-tip-r' + (r.cls ? ' ' + r.cls : ''), null, tip);
      if (r.color) {
        const sw = H('span', 'ch-tip-sw' + (r.line ? ' ln' : ''), null, row);
        sw.style.background = r.color;
      }
      H('span', 'ch-tip-n', r.name, row);
      H('span', 'ch-tip-v', r.value, row);
    }
    if (info.note) H('div', 'ch-tip-note', info.note, tip);
  }
  function placeTip(i, pt) {
    const m = st.model;
    const svg = m.el;
    const rect = svg.getBoundingClientRect();
    const k = rect.width > 0 ? rect.width / st.W : 1;
    const a = m.anchor(i);
    const ax = rect.left + a.x * k;
    const ay = rect.top + a.y * k;
    const vw = document.documentElement.clientWidth || window.innerWidth || 1024;
    const vh = window.innerHeight || document.documentElement.clientHeight || 768;
    const w = tip.offsetWidth || 150;
    const h = tip.offsetHeight || 60;
    let x = ax + 16;
    if (x + w > vw - 8) x = ax - 16 - w;
    x = clamp(x, 8, Math.max(8, vw - w - 8));
    let y;
    if (pt && st.modality === 'touch') y = pt.y - h - 28;
    else if (pt) y = pt.y - h / 2;
    else y = ay;
    y = clamp(y, 8, Math.max(8, vh - h - 8));
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
    /* correct for a transformed ancestor (fixed → relative to it) */
    const tr = tip.getBoundingClientRect();
    if (tr.width > 0) {
      const dx = tr.left - x;
      const dy = tr.top - y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        tip.style.left = x - dx + 'px';
        tip.style.top = y - dy + 'px';
      }
    }
  }
  function setActive(i, pt) {
    const m = st.model;
    if (!m || !m.n) return;
    if (i === null || i === undefined) { clearActive(); return; }
    i = clamp(i, 0, m.n - 1);
    const info = m.tip(i);
    fillTip(info);
    tip.classList.add('on');
    st.active = i;
    m.setActive(i);
    placeTip(i, pt);
    const text = info.sr || [info.title].concat((info.rows || []).map((r) => `${r.name} ${r.value}`)).join(', ');
    if (sr.textContent !== text) sr.textContent = text;
  }
  function clearActive() {
    st.active = null;
    hideTip();
    if (st.model && st.model.setActive) st.model.setActive(null);
  }
  function select(i) {
    const m = st.model;
    if (!m || i === null || i === undefined || i < 0 || i >= m.n) return;
    st.selected = i;
    m.setSelected(i);
    if (typeof st.opts.onSelect === 'function') {
      try { st.opts.onSelect(i); } catch (e) { console.error(e); }
    }
  }

  function wire(m) {
    const hit = m.hit;
    if (!hit) return;
    const idxFrom = (e) => {
      const r = m.el.getBoundingClientRect();
      const k = r.width > 0 ? st.W / r.width : 1;
      return m.indexAt((e.clientX - r.left) * k, (e.clientY - r.top) * k);
    };
    const pointAt = (e) => ({ x: e.clientX, y: e.clientY });
    const move = (e) => {
      st.modality = e.pointerType === 'touch' ? 'touch' : 'mouse';
      const i = idxFrom(e);
      if (i === null) return;
      setActive(i, pointAt(e));
    };
    hit.addEventListener('pointerdown', (e) => { downX = e.clientX; move(e); });
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') clearActive(); });
    hit.addEventListener('pointercancel', clearActive);
    hit.addEventListener('click', (e) => {
      if (e.detail !== undefined && Math.abs(e.clientX - downX) > 10 && downX !== 0) { downX = 0; return; }
      downX = 0;
      const i = idxFrom(e);
      if (i !== null) select(i);
    });
  }

  function render(animate) {
    if (st.dead) return;
    const W = measure();
    st.W = W;
    root.classList.toggle('ch-anim', !!animate);
    const m = build({ opts: st.opts, W, hidden: st.hidden, uid, animate: !!animate, state: st, root });
    st.model = m && !m.empty ? m : null;
    st.active = null;
    hideTip();
    body.textContent = '';
    root.classList.toggle('ch-is-empty', !st.model);
    if (!st.model) {
      const e = H('div', 'ch-empty', EMPTY_TEXT, body);
      e.setAttribute('role', 'status');
      syncLegend(null);
      return;
    }
    body.appendChild(m.el);
    syncLegend(m.legend);
    root.classList.toggle('ch-focusable', !!m.hit);
    if (m.hit) wire(m);
    if (m.ariaLabel) root.setAttribute('aria-label', m.ariaLabel);
    if (m.setSelected) m.setSelected(st.selected);
    if (m.after) m.after({ st, select, setActive, clearActive });
  }

  /* keyboard (cartesian charts) */
  root.addEventListener('keydown', (e) => {
    const m = st.model;
    if (e.target !== root || !m || !m.hit) return;
    const n = m.n;
    let i = st.active;
    st.modality = 'key';
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': i = i === null ? (st.selected !== null && st.selected < n ? st.selected : 0) : Math.min(n - 1, i + 1); break;
      case 'ArrowLeft': case 'ArrowUp': i = i === null ? (st.selected !== null && st.selected < n ? st.selected : n - 1) : Math.max(0, i - 1); break;
      case 'Home': i = 0; break;
      case 'End': i = n - 1; break;
      case 'Enter': case ' ':
        if (i !== null) select(i);
        e.preventDefault();
        return;
      case 'Escape': clearActive(); return;
      default: return;
    }
    e.preventDefault();
    setActive(i, null);
  });
  root.addEventListener('blur', () => { if (st.modality === 'key') clearActive(); });

  const onDocDown = (e) => { if (st.active !== null && !root.contains(e.target)) clearActive(); };
  const onScroll = () => { if (st.active !== null && st.modality !== 'key') clearActive(); };
  document.addEventListener('pointerdown', onDocDown, true);
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });

  root.update = (next) => {
    if (st.dead) return root;
    if (next) {
      Object.assign(st.opts, next);
      if ('selected' in next) st.selected = normSel(next.selected);
    }
    render(false);
    return root;
  };
  root.destroy = () => {
    st.dead = true;
    document.removeEventListener('pointerdown', onDocDown, true);
    window.removeEventListener('scroll', onScroll, true);
    if (ro) ro.disconnect();
    clearTimeout(roTimer);
    if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    root.remove();
  };

  render(false);

  const remeasure = () => {
    if (st.dead) return;
    const w = root.clientWidth;
    if (w > 0 && (w !== st.W || !st.animated)) {
      const first = !st.animated;
      st.animated = true;
      render(first);
    }
  };
  if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(remeasure);
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      clearTimeout(roTimer);
      roTimer = setTimeout(remeasure, 90);
    });
    ro.observe(root);
  }
  return root;
}

/* ───────────────────────── line chart ───────────────────────── */

function buildLine(ctx) {
  const { opts, W, hidden, uid, animate } = ctx;
  const fmt = mkFmt(opts.fmt);
  const afmt = opts.axisFmt ? mkFmt(opts.axisFmt) : compact;
  const labels = (opts.labels || []).map(String);
  const raw = opts.series || [];
  const n = Math.max(labels.length, 0, ...raw.map((s) => (s.values || []).length));
  const series = raw.map((s, i) => ({
    key: s.key !== undefined ? String(s.key) : String(i),
    name: s.name !== undefined ? s.name : s.key !== undefined ? String(s.key) : `Series ${i + 1}`,
    color: s.color || pal(i),
    dashed: !!s.dashed,
    area: !!s.area,
    width: s.width || 2,
    values: fillVals(s.values, n),
  }));
  if (!n || !series.length || allEmpty(series.map((s) => s.values))) return { empty: true };
  const labelAt = (i) => (labels[i] !== undefined ? labels[i] : String(i + 1));
  const visible = series.filter((s) => !hidden.has(s.key));
  const stacked = !!opts.stacked && visible.length > 0;
  const H_ = opts.height || (W < 420 ? 200 : 240);

  /* stacking */
  const cum = new Array(n).fill(0);
  if (stacked) {
    for (const s of visible) {
      s.lo = cum.slice();
      for (let i = 0; i < n; i++) cum[i] += s.values[i] || 0;
      s.hi = cum.slice();
    }
  }

  /* domain */
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of visible) {
    for (let i = 0; i < n; i++) {
      const vals = stacked ? [s.lo[i], s.hi[i]] : s.values[i] === null ? [] : [s.values[i]];
      for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
  }
  for (const r of opts.refLines || []) if (r && isNum(r.value)) { lo = Math.min(lo, r.value); hi = Math.max(hi, r.value); }
  if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
  const needZero = stacked || visible.some((s) => s.area);
  if (needZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); } else {
    if (lo >= 0 && lo <= hi * 0.6) lo = 0;
    if (hi <= 0 && hi >= lo * 0.6) hi = 0;
  }
  const top = (opts.refLines || []).some((r) => r && r.label) ? 16 : 10;
  const bottom = 28;
  const ph0 = H_ - top - bottom;
  const scale = niceTicks(lo, hi, clamp(Math.floor(ph0 / 46), 2, 8), opts.yMin, opts.yMax);
  const left = Math.max(30, Math.max(...scale.ticks.map((t) => tw(afmt(t)))) + 14);
  const right = 12;
  const ph = H_ - top - bottom;
  const y = (v) => top + (1 - (v - scale.d0) / (scale.d1 - scale.d0)) * ph;
  const x0 = left + 8;
  const x1 = W - right - 8;
  const step = n > 1 ? (x1 - x0) / (n - 1) : 0;
  const xs = (i) => (n > 1 ? x0 + i * step : (left + W - right) / 2);
  const ff = isNum(opts.forecastFrom) && opts.forecastFrom > 0 && opts.forecastFrom < n ? opts.forecastFrom : null;

  const svg = S('svg', { class: 'ch-svg', width: W, height: H_, viewBox: `0 0 ${W} ${H_}`, role: 'img' });
  svg.setAttribute('aria-label', ariaFor(opts, 'Line chart', series.map((s) => s.name), labels, n));
  const defs = S('defs', null, svg);

  if (ff !== null) {
    const fx = (xs(ff - 1) + xs(ff)) / 2;
    S('rect', { x: r2(fx), y: top, width: r2(W - right - fx), height: ph, class: 'ch-fc-zone' }, svg);
    T(svg, W - right - 6, top + ph - 8, 'Forecast (예상)', 'ch-fc-t', 'end');
  }
  const geo = { W, H: H_, left, right, top, bottom, scale, y, afmt, zeroLine: opts.zeroLine };
  drawYGrid(svg, geo);
  drawRefLines(svg, { ...geo, refLines: opts.refLines });
  const centers = Array.from({ length: n }, (_, i) => xs(i));
  drawXLabels(svg, { ...geo, labels: Array.from({ length: n }, (_, i) => labelAt(i)), centers, pitch: step || 60 });

  /* selected / hover guides sit under the lines */
  const selLine = S('line', { class: 'ch-sel-line', y1: top, y2: top + ph }, svg);
  const crossLine = S('line', { class: 'ch-cross', y1: top, y2: top + ph }, svg);
  selLine.style.display = 'none';
  crossLine.style.display = 'none';

  const gSeries = S('g', { class: 'ch-series' }, svg);
  const baseY = clamp(y(0), top, top + ph);
  const yAt = (s, i) => (stacked ? y(s.hi[i]) : s.values[i] === null ? null : y(s.values[i]));

  const drawOrder = stacked ? visible.slice().reverse() : visible;
  let animIdx = 0;
  for (const s of drawOrder) {
    const g = S('g', { class: 'ch-s', 'data-key': s.key }, gSeries);
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(stacked || s.values[i] !== null ? { i, x: xs(i), y: yAt(s, i) } : null);
    const runs = [];
    let cur = [];
    for (const p of pts) { if (p) cur.push(p); else if (cur.length) { runs.push(cur); cur = []; } }
    if (cur.length) runs.push(cur);

    if (stacked) {
      const run = pts;
      const upper = curvePath(run, opts.smooth);
      const lower = curvePath(run.map((p) => ({ x: p.x, y: y(s.lo[p.i]) })).reverse(), opts.smooth).replace(/^M/, 'L');
      const a = S('path', { class: 'ch-area stack', d: `${upper}${lower}Z` }, g);
      setColor(a, 'fill', s.color);
      const ln = S('path', { class: 'ch-line', d: upper, pathLength: 1 }, g);
      setColor(ln, 'stroke', s.color);
      ln.style.strokeWidth = String(1.5);
      continue;
    }
    for (const run of runs) {
      const actual = ff === null ? run : run.filter((p) => p.i < ff);
      const fc = ff === null ? [] : run.filter((p) => p.i >= ff - 1);
      if (actual.length >= 1 && s.area) {
        const gid = `chg${uid}-${animIdx++}`;
        const lg = S('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
        const s1 = S('stop', { offset: '0%', 'stop-opacity': 0.28 }, lg);
        const s2 = S('stop', { offset: '100%', 'stop-opacity': 0.02 }, lg);
        setColor(s1, 'stop-color', s.color);
        setColor(s2, 'stop-color', s.color);
        const d = `${curvePath(actual, opts.smooth)}L${r2(actual[actual.length - 1].x)} ${r2(baseY)}L${r2(actual[0].x)} ${r2(baseY)}Z`;
        S('path', { class: 'ch-area', d, fill: `url(#${gid})` }, g);
      }
      if (actual.length >= 2) {
        const ln = S('path', { class: 'ch-line' + (s.dashed ? ' dashed' : ''), d: curvePath(actual, opts.smooth), pathLength: s.dashed ? null : 1 }, g);
        setColor(ln, 'stroke', s.color);
        ln.style.strokeWidth = String(s.width);
        if (s.dashed) ln.style.strokeDasharray = '6 4';
      } else if (actual.length === 1) {
        const c = S('circle', { class: 'ch-single', cx: r2(actual[0].x), cy: r2(actual[0].y), r: 3.5 }, g);
        setColor(c, 'fill', s.color);
      }
      if (fc.length >= 2) {
        const ln = S('path', { class: 'ch-line fc', d: curvePath(fc, opts.smooth) }, g);
        setColor(ln, 'stroke', s.color);
        ln.style.strokeWidth = String(s.width);
      } else if (fc.length === 1 && actual.length === 0) {
        const c = S('circle', { class: 'ch-single fc', cx: r2(fc[0].x), cy: r2(fc[0].y), r: 3.5 }, g);
        setColor(c, 'fill', s.color);
      }
    }
    if (opts.markers) {
      for (const p of pts) {
        if (!p) continue;
        const c = S('circle', { class: 'ch-mk' + (ff !== null && p.i >= ff ? ' fc' : ''), cx: r2(p.x), cy: r2(p.y), r: 3 }, g);
        setColor(c, 'stroke', s.color);
      }
    }
  }

  /* active / selected dots */
  const mkDots = (cls) => {
    const g = S('g', { class: cls }, svg);
    return visible.map((s) => {
      const c = S('circle', { r: 5 }, g);
      setColor(c, 'fill', s.color);
      c.style.display = 'none';
      return c;
    });
  };
  const selDots = mkDots('ch-sel-dots');
  const actDots = mkDots('ch-act-dots');
  const place = (line, dots, i) => {
    if (i === null || i === undefined || i < 0 || i >= n) {
      line.style.display = 'none';
      dots.forEach((d) => { d.style.display = 'none'; });
      return;
    }
    line.style.display = '';
    line.setAttribute('x1', r2(xs(i)));
    line.setAttribute('x2', r2(xs(i)));
    visible.forEach((s, k) => {
      const yy = yAt(s, i);
      const d = dots[k];
      if (yy === null) { d.style.display = 'none'; return; }
      d.style.display = '';
      d.setAttribute('cx', r2(xs(i)));
      d.setAttribute('cy', r2(yy));
    });
  };

  const hit = S('rect', { class: 'ch-hit', x: left, y: 0, width: Math.max(0, W - left), height: H_ }, svg);
  const forecastNote = (i) => (ff !== null && i >= ff ? 'Forecast (예상)' : null);

  return {
    el: svg,
    n,
    hit,
    ariaLabel: ariaFor(opts, 'Line chart', series.map((s) => s.name), labels, n),
    indexAt: (x) => (n > 1 ? clamp(Math.round((x - x0) / step), 0, n - 1) : 0),
    anchor: (i) => ({ x: xs(i), y: top + 8 }),
    tip: (i) => {
      const rows = [];
      for (const s of visible) {
        const v = s.values[i];
        if (v === null) continue;
        rows.push({ color: s.color, line: !stacked && !s.area, name: s.name, value: fmt(v) });
      }
      if (stacked) rows.push({ name: 'Total (합계)', value: fmt(cum[i]), cls: 'tot' });
      return { title: labelAt(i), rows, note: forecastNote(i) };
    },
    setActive: (i) => place(crossLine, actDots, i),
    setSelected: (i) => place(selLine, selDots, i),
    legend: series.map((s) => ({ key: s.key, name: s.name, color: s.color, type: stacked || s.area ? 'bar' : s.dashed ? 'dash' : 'line', off: hidden.has(s.key) })),
  };
}

export function lineChart(opts) {
  return createChart('line', opts, buildLine);
}

/* ───────────────────────── bar chart (grouped / stacked, optional lines) ───────────────────────── */

function buildBar(ctx) {
  const { opts, W, hidden } = ctx;
  const fmt = mkFmt(opts.fmt);
  const afmt = opts.axisFmt ? mkFmt(opts.axisFmt) : compact;
  const horiz = !!opts.horizontal;
  const labels = (opts.labels || []).map(String);
  const rawBars = opts.series || [];
  const rawLines = horiz ? [] : opts.lines || [];
  const n = Math.max(labels.length, 0, ...rawBars.map((s) => (s.values || []).length), ...rawLines.map((s) => (s.values || []).length));
  const mk = (s, i, off) => ({
    key: s.key !== undefined ? String(s.key) : String(i + off),
    name: s.name !== undefined ? s.name : s.key !== undefined ? String(s.key) : `Series ${i + off + 1}`,
    color: s.color || pal(i + off),
    dashed: !!s.dashed,
    width: s.width || 2,
    values: fillVals(s.values, n),
  });
  const bars = rawBars.map((s, i) => mk(s, i, 0));
  const lines = rawLines.map((s, i) => mk(s, i, bars.length));
  if (!n || (!bars.length && !lines.length) || allEmpty([...bars, ...lines].map((s) => s.values))) return { empty: true };
  const labelAt = (i) => (labels[i] !== undefined ? labels[i] : String(i + 1));
  const visBars = bars.filter((s) => !hidden.has(s.key));
  const visLines = lines.filter((s) => !hidden.has(s.key));
  const stacked = opts.mode === 'stacked';

  /* domain (always includes zero) */
  let lo = 0;
  let hi = 0;
  const posSum = new Array(n).fill(0);
  const negSum = new Array(n).fill(0);
  for (const s of visBars) {
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (v === null) continue;
      if (stacked) { if (v >= 0) posSum[i] += v; else negSum[i] += v; } else { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
  }
  if (stacked) for (let i = 0; i < n; i++) { hi = Math.max(hi, posSum[i]); lo = Math.min(lo, negSum[i]); }
  for (const s of visLines) for (const v of s.values) if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (const r of opts.refLines || []) if (r && isNum(r.value)) { lo = Math.min(lo, r.value); hi = Math.max(hi, r.value); }

  const H_ = opts.height || (horiz ? Math.max(120, n * 34 + 40) : W < 420 ? 200 : 240);
  const svg = S('svg', { class: 'ch-svg', width: W, height: H_, viewBox: `0 0 ${W} ${H_}`, role: 'img' });
  const aria = ariaFor(opts, horiz ? 'Horizontal bar chart' : 'Bar chart', [...bars, ...lines].map((s) => s.name), labels, n);
  svg.setAttribute('aria-label', aria);

  const hasRefLabel = (opts.refLines || []).some((r) => r && r.label);
  const top = horiz ? 6 : hasRefLabel ? 16 : 10;
  const bottom = horiz ? 26 : 28;
  let left;
  let right = 12;
  let scale;
  const hSum = (i) => visBars.reduce((a, s) => a + (s.values[i] || 0), 0);
  const hLabels = horiz && n <= 14 && visBars.length >= 1 && (stacked || visBars.length === 1)
    ? Array.from({ length: n }, (_, i) => fmt(stacked ? hSum(i) : visBars[0].values[i] || 0))
    : null;
  if (horiz) {
    left = Math.min(Math.max(...Array.from({ length: n }, (_, i) => tw(labelAt(i)))) + 14, W * 0.42);
    scale = niceTicks(lo, hi, clamp(Math.floor((W - left - 30) / 70), 2, 7), opts.yMin, opts.yMax);
    right = Math.max(12, tw(afmt(scale.ticks[scale.ticks.length - 1])) / 2 + 4);
    if (hLabels) right = Math.max(right, Math.max(...hLabels.map((s) => tw(s, 11))) + 10);
  } else {
    scale = niceTicks(lo, hi, clamp(Math.floor((H_ - top - bottom) / 46), 2, 8), opts.yMin, opts.yMax);
    left = Math.max(30, Math.max(...scale.ticks.map((t) => tw(afmt(t)))) + 14);
  }
  const pw = W - left - right;
  const ph = H_ - top - bottom;
  const vpos = horiz
    ? (v) => left + ((v - scale.d0) / (scale.d1 - scale.d0)) * pw
    : (v) => top + (1 - (v - scale.d0) / (scale.d1 - scale.d0)) * ph;
  const band = (horiz ? ph : pw) / n;
  const c0 = (i) => (horiz ? top : left) + i * band;
  const center = (i) => c0(i) + band / 2;

  const geo = { W, H: H_, left, right, top, bottom, scale, y: vpos, afmt, zeroLine: opts.zeroLine };
  if (horiz) {
    const g = S('g', { class: 'ch-grid' }, svg);
    for (const t of scale.ticks) {
      const x = crisp(vpos(t));
      S('line', { x1: x, x2: x, y1: top, y2: H_ - bottom, class: 'ch-gl' + (t === scale.d0 ? ' base' : '') }, g);
      T(g, x, H_ - bottom + 17, afmt(t), 'ch-axt', 'middle');
    }
    if (scale.d0 < 0 && scale.d1 > 0) { const x = crisp(vpos(0)); S('line', { x1: x, x2: x, y1: top, y2: H_ - bottom, class: 'ch-zero' }, g); }
    const gl = S('g', { class: 'ch-xl' }, svg);
    for (let i = 0; i < n; i++) T(gl, left - 8, center(i), ellipsize(labelAt(i), left - 14), 'ch-axt', 'end', { dy: '0.32em' });
  } else {
    drawYGrid(svg, geo);
    drawRefLines(svg, { ...geo, refLines: opts.refLines });
    drawXLabels(svg, { ...geo, labels: Array.from({ length: n }, (_, i) => labelAt(i)), centers: Array.from({ length: n }, (_, i) => center(i)), pitch: band });
  }

  const gBand = S('g', { class: 'ch-bands' }, svg);
  const bandEls = [];
  const selBandEls = [];
  for (let i = 0; i < n; i++) {
    const rr = horiz ? { x: left, y: c0(i), width: pw, height: band } : { x: c0(i), y: top, width: band, height: ph };
    const b = S('rect', { class: 'ch-band', rx: 6, ...Object.fromEntries(Object.entries(rr).map(([k, v]) => [k, r2(v)])) }, gBand);
    bandEls.push(b);
  }
  void selBandEls;

  const gBars = S('g', { class: 'ch-bars' }, svg);
  const elsAt = Array.from({ length: n }, () => []);
  const k = visBars.length;
  const gap = 3;
  let barW;
  if (stacked) barW = Math.min(band * 0.62, 44);
  else {
    const group = Math.min(band * 0.78, k * 40 + (k - 1) * gap);
    barW = Math.max(2, (group - (k - 1) * gap) / Math.max(k, 1));
  }
  const groupW = stacked ? barW : k * barW + (k - 1) * gap;
  const endPx = new Array(n).fill(null); // outermost value-axis pixel per category (for tooltip anchor)
  const baseV = vpos(0);
  const mkBar = (i, off, v0, v1, s, round, extraCls) => {
    const a = vpos(v0);
    const b = vpos(v1);
    const lo_ = Math.min(a, b);
    const len = Math.abs(b - a);
    if (len < 0.5) return;
    const posDir = v1 >= v0;
    let d;
    if (horiz) d = rrect(lo_, c0(i) + (band - groupW) / 2 + off, len, barW, 4, round ? (posDir ? 'right' : 'left') : 'none');
    else d = rrect(c0(i) + (band - groupW) / 2 + off, lo_, barW, len, 4, round ? (posDir ? 'top' : 'bottom') : 'none');
    if (!d) return;
    const color = s.values[i] < 0 && opts.negativeColor ? opts.negativeColor : s.color;
    const p = S('path', { class: `ch-bar ${horiz ? 'h' : posDir ? 'pos' : 'neg'}${stacked ? ' seg' : ''}`, d, 'data-i': i, 'data-key': s.key }, gBars);
    p.style.setProperty('--i', String(Math.min(i, 24)));
    setColor(p, 'fill', color);
    elsAt[i].push(p);
    const ext = posDir ? Math.max(a, b) : Math.min(a, b);
    const cand = horiz ? Math.max(a, b) : Math.min(a, b);
    endPx[i] = endPx[i] === null ? cand : horiz ? Math.max(endPx[i], cand) : Math.min(endPx[i], cand);
    void ext; void extraCls;
  };
  if (stacked) {
    for (let i = 0; i < n; i++) {
      let pos = 0;
      let neg = 0;
      const lastPos = visBars.reduce((acc, s, idx) => (s.values[i] > 0 ? idx : acc), -1);
      const lastNeg = visBars.reduce((acc, s, idx) => (s.values[i] < 0 ? idx : acc), -1);
      visBars.forEach((s, idx) => {
        const v = s.values[i];
        if (v === null || v === 0) return;
        if (v > 0) { mkBar(i, 0, pos, pos + v, s, idx === lastPos); pos += v; } else { mkBar(i, 0, neg, neg + v, s, idx === lastNeg); neg += v; }
      });
    }
  } else {
    visBars.forEach((s, si) => {
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (v === null || v === 0) continue;
        mkBar(i, si * (barW + gap), 0, v, s, true);
      }
    });
  }
  void baseV;
  if (hLabels) {
    const gv = S('g', { class: 'ch-vals' }, svg);
    for (let i = 0; i < n; i++) {
      const tot = stacked ? hSum(i) : visBars[0].values[i] || 0;
      if (!tot) continue;
      const pos = stacked ? Math.max(posSum[i], 0) : Math.max(tot, 0);
      const neg = stacked ? Math.min(negSum[i], 0) : Math.min(tot, 0);
      const x = tot >= 0 ? vpos(pos) + 6 : vpos(neg) - 6;
      T(gv, x, center(i), hLabels[i], 'ch-hv', tot >= 0 ? 'start' : 'end', { dy: '0.32em' });
    }
  }

  /* line overlay */
  const gLines = S('g', { class: 'ch-series' }, svg);
  const linePts = visLines.map((s) => s.values.map((v, i) => (v === null ? null : { i, x: center(i), y: vpos(v) })));
  visLines.forEach((s, li) => {
    const g = S('g', { class: 'ch-s', 'data-key': s.key }, gLines);
    let cur = [];
    const runs = [];
    for (const p of linePts[li]) { if (p) cur.push(p); else if (cur.length) { runs.push(cur); cur = []; } }
    if (cur.length) runs.push(cur);
    for (const run of runs) {
      if (run.length >= 2) {
        const ln = S('path', { class: 'ch-line' + (s.dashed ? ' dashed' : ''), d: curvePath(run, opts.smooth), pathLength: s.dashed ? null : 1 }, g);
        setColor(ln, 'stroke', s.color);
        ln.style.strokeWidth = String(s.width);
        if (s.dashed) ln.style.strokeDasharray = '6 4';
      }
      for (const p of run) {
        const c = S('circle', { class: 'ch-mk', cx: r2(p.x), cy: r2(p.y), r: run.length === 1 ? 3.5 : 3 }, g);
        setColor(c, 'stroke', s.color);
        if (run.length === 1) setColor(c, 'fill', s.color);
      }
    }
  });
  const actDots = visLines.map((s) => {
    const c = S('circle', { class: 'ch-act-dot', r: 5 }, svg);
    setColor(c, 'fill', s.color);
    c.style.display = 'none';
    return c;
  });

  const hit = S('rect', { class: 'ch-hit', x: left, y: top, width: pw, height: ph }, svg);
  const setCls = (i, cls, on) => {
    bandEls[i] && bandEls[i].classList.toggle(cls, on);
    elsAt[i].forEach((e) => e.classList.toggle(cls, on));
  };
  let curAct = null;
  let curSel = null;
  const totalAt = (i) => visBars.reduce((a, s) => a + (s.values[i] || 0), 0);

  return {
    el: svg,
    n,
    hit,
    ariaLabel: aria,
    indexAt: (x, y) => {
      const p = horiz ? y - top : x - left;
      return clamp(Math.floor(p / band), 0, n - 1);
    },
    anchor: (i) => {
      if (horiz) return { x: endPx[i] === null ? vpos(0) : endPx[i], y: center(i) };
      return { x: center(i), y: endPx[i] === null ? top + 8 : Math.max(top + 4, endPx[i]) };
    },
    tip: (i) => {
      const rows = [];
      for (const s of visBars) {
        const v = s.values[i];
        if (v === null) continue;
        rows.push({ color: v < 0 && opts.negativeColor ? opts.negativeColor : s.color, name: s.name, value: fmt(v) });
      }
      for (const s of visLines) {
        const v = s.values[i];
        if (v === null) continue;
        rows.push({ color: s.color, line: true, name: s.name, value: fmt(v) });
      }
      if (stacked && visBars.length > 1) rows.push({ name: 'Total (합계)', value: fmt(totalAt(i)), cls: 'tot' });
      return { title: labelAt(i), rows };
    },
    setActive: (i) => {
      if (curAct !== null) setCls(curAct, 'is-act', false);
      curAct = i;
      svg.classList.toggle('has-act', i !== null);
      if (i !== null) setCls(i, 'is-act', true);
      visLines.forEach((s, li) => {
        const p = i === null ? null : linePts[li][i];
        const c = actDots[li];
        if (!p) { c.style.display = 'none'; return; }
        c.style.display = '';
        c.setAttribute('cx', r2(p.x));
        c.setAttribute('cy', r2(p.y));
      });
    },
    setSelected: (i) => {
      if (curSel !== null && curSel < n) setCls(curSel, 'is-sel', false);
      curSel = i !== null && i < n ? i : null;
      svg.classList.toggle('has-sel', curSel !== null);
      if (curSel !== null) setCls(curSel, 'is-sel', true);
    },
    legend: [...bars, ...lines].map((s, idx) => ({ key: s.key, name: s.name, color: s.color, type: idx >= bars.length ? (s.dashed ? 'dash' : 'line') : 'bar', off: hidden.has(s.key) })),
  };
}

export function barChart(opts) {
  return createChart('bar', opts, buildBar);
}

/* ───────────────────────── waterfall ───────────────────────── */

/** Running totals: [{key,name,type,value,start,end}] */
export function waterfallSteps(steps) {
  const out = [];
  let run = 0;
  (steps || []).forEach((s, i) => {
    const type = s && s.type === 'total' ? 'total' : 'delta';
    let v = s && isNum(s.value) ? s.value : null;
    let start;
    let end;
    if (type === 'total') {
      if (v === null) v = run;
      start = 0;
      end = v;
      run = v;
    } else {
      if (v === null) v = 0;
      start = run;
      end = run + v;
      run = end;
    }
    out.push({ key: s && s.key !== undefined ? String(s.key) : String(i), name: s && s.name !== undefined ? s.name : String(i + 1), type, value: v, start, end, color: s && s.color });
  });
  return out;
}

function buildWaterfall(ctx) {
  const { opts, W } = ctx;
  const fmt = mkFmt(opts.fmt);
  const afmt = opts.axisFmt ? mkFmt(opts.axisFmt) : compact;
  const steps = waterfallSteps(opts.steps);
  const n = steps.length;
  if (!n || steps.every((s) => s.value === 0)) return { empty: true };
  let lo = 0;
  let hi = 0;
  for (const s of steps) { lo = Math.min(lo, s.start, s.end); hi = Math.max(hi, s.start, s.end); }
  const H_ = opts.height || (W < 420 ? 240 : 280);
  const top = 22;
  const narrow = W < 420;
  const fs = narrow ? 10 : 11;
  let scale = niceTicks(lo, hi, clamp(Math.floor((H_ - top - 46) / 46), 2, 7), opts.yMin, opts.yMax);
  const left = narrow ? 6 : Math.max(30, Math.max(...scale.ticks.map((t) => tw(afmt(t)))) + 14);
  const right = narrow ? 6 : 8;
  const pw = W - left - right;
  const wlines = steps.map((s) => wrapLabel(s.name, (pw / n) * 1.08, fs));
  const bottom = 18 + 13 * Math.max(...wlines.map((l) => l.length), 1);
  scale = niceTicks(lo, hi, clamp(Math.floor((H_ - top - bottom) / 46), 2, 7), opts.yMin, opts.yMax);
  const ph = H_ - top - bottom;
  const y = (v) => top + (1 - (v - scale.d0) / (scale.d1 - scale.d0)) * ph;
  const band = pw / n;
  const barW = Math.min(band * 0.64, 60);
  const svg = S('svg', { class: 'ch-svg', width: W, height: H_, viewBox: `0 0 ${W} ${H_}`, role: 'img' });
  const final = steps[n - 1];
  const aria = ariaFor(opts, 'Waterfall chart', steps.map((s) => s.name), null, n) + `. Ends at ${fmt(final.end)}`;
  svg.setAttribute('aria-label', aria);
  drawYGrid(svg, { W, H: H_, left, right, top, bottom, scale, y, afmt, zeroLine: true, noLabels: narrow });

  const gx = S('g', { class: 'ch-xl' }, svg);
  steps.forEach((s, i) => {
    wlines[i].forEach((ln, li) => T(gx, left + band * i + band / 2, H_ - bottom + 16 + li * 13, ln, 'ch-axt', 'middle', narrow ? { style: 'font-size:10px' } : null));
  });

  const gBands = S('g', { class: 'ch-bands' }, svg);
  const bandEls = steps.map((s, i) => S('rect', { class: 'ch-band', rx: 6, x: r2(left + band * i), y: top, width: r2(band), height: ph }, gBands));
  const gConn = S('g', { class: 'ch-conns' }, svg);
  const gBars = S('g', { class: 'ch-bars' }, svg);
  const gLbl = S('g', { class: 'ch-vals' }, svg);
  const elsAt = [];
  const colorOf = (s) => s.color || (s.type === 'total' ? 'var(--ch-total)' : s.value >= 0 ? 'var(--ch-pos)' : 'var(--ch-neg)');
  steps.forEach((s, i) => {
    const x = left + band * i + (band - barW) / 2;
    const ya = y(s.start);
    const yb = y(s.end);
    const yt = Math.min(ya, yb);
    const hgt = Math.max(Math.abs(yb - ya), 1.5);
    const p = S('path', { class: `ch-bar wf ${s.type === 'total' ? 'total' : s.value >= 0 ? 'up' : 'dn'}`, d: rrect(x, yt, barW, hgt, 4, 'all'), 'data-i': i, 'data-key': s.key, 'data-start': s.start, 'data-end': s.end }, gBars);
    p.style.setProperty('--i', String(Math.min(i, 24)));
    if (s.color) setColor(p, 'fill', s.color);
    elsAt.push([p]);
    if (i < n - 1) {
      const cy = crisp(y(s.end));
      S('line', { class: 'ch-conn', x1: r2(x + barW), x2: r2(left + band * (i + 1) + (band - barW) / 2), y1: cy, y2: cy }, gConn);
    }
    /* value label */
    const full = s.type === 'total' ? fmt(s.value) : signed(fmt, s.value);
    const short = s.type === 'total' ? afmt(s.value) : (s.value >= 0 ? '+' : '−') + afmt(Math.abs(s.value));
    const lab = tw(full, 11) <= band - 2 ? full : tw(short, 11) <= band - 2 ? short : '';
    if (lab) {
      const up = s.end >= s.start;
      const t = T(gLbl, x + barW / 2, up ? yt - 6 : yt + hgt + 13, lab, 'ch-vt' + (s.type === 'total' ? ' total' : ''), 'middle');
      t.setAttribute('data-i', i);
    }
  });
  const hit = S('rect', { class: 'ch-hit', x: left, y: top, width: pw, height: ph + bottom - 8 }, svg);
  let curAct = null;
  let curSel = null;
  const setCls = (i, cls, on) => { bandEls[i].classList.toggle(cls, on); elsAt[i].forEach((e) => e.classList.toggle(cls, on)); };
  return {
    el: svg,
    n,
    hit,
    steps,
    ariaLabel: aria,
    indexAt: (x) => clamp(Math.floor((x - left) / band), 0, n - 1),
    anchor: (i) => ({ x: left + band * i + band / 2, y: Math.min(y(steps[i].start), y(steps[i].end)) }),
    tip: (i) => {
      const s = steps[i];
      const col = colorOf(s);
      const rows = s.type === 'total'
        ? [{ color: col, name: 'Total (합계)', value: fmt(s.end) }]
        : [{ color: col, name: 'Change (변동)', value: signed(fmt, s.value) }, { name: 'Running total (누계)', value: fmt(s.end), cls: 'tot' }];
      return { title: s.name, rows };
    },
    setActive: (i) => {
      if (curAct !== null) setCls(curAct, 'is-act', false);
      curAct = i;
      svg.classList.toggle('has-act', i !== null);
      if (i !== null) setCls(i, 'is-act', true);
    },
    setSelected: (i) => {
      if (curSel !== null && curSel < n) setCls(curSel, 'is-sel', false);
      curSel = i !== null && i < n ? i : null;
      svg.classList.toggle('has-sel', curSel !== null);
      if (curSel !== null) setCls(curSel, 'is-sel', true);
    },
    legend: null,
  };
}

export function waterfall(opts) {
  return createChart('waterfall', opts, buildWaterfall);
}

/* ───────────────────────── donut ───────────────────────── */

function buildDonut(ctx) {
  const { opts, W, uid, animate, state } = ctx;
  const fmt = mkFmt(opts.fmt);
  let slices = (opts.slices || [])
    .map((s, i) => ({ key: s.key !== undefined ? String(s.key) : String(i), name: s.name !== undefined ? String(s.name) : String(s.key), value: s.value, color: s.color || pal(i) }))
    .filter((s) => isNum(s.value) && s.value > 0);
  const total0 = slices.reduce((a, s) => a + s.value, 0);
  if (!slices.length || total0 <= 0) return { empty: true };
  const minPct = isNum(opts.minPct) ? opts.minPct : 0;
  if (minPct > 0) {
    const small = slices.filter((s) => (s.value / total0) * 100 < minPct);
    if (small.length >= 2) {
      const rest = slices.filter((s) => !small.includes(s));
      rest.push({ key: '__other', name: OTHER_NAME, value: small.reduce((a, s) => a + s.value, 0), color: 'var(--ch-other)', members: small });
      slices = rest;
    }
  }
  const total = slices.reduce((a, s) => a + s.value, 0);
  const minShare = Math.min(...slices.map((s) => (s.value / total) * 100));
  const dec = minShare < 1 ? 1 : 0;
  const pcts = percents(slices.map((s) => s.value), dec);
  slices.forEach((s, i) => { s.pct = pcts[i]; });
  const pctStr = (p) => p.toFixed(dec) + '%';

  const wide = W >= 470;
  const size = Math.round(opts.size || (wide ? 220 : clamp(W - 40, 170, 232)));
  const cx = size / 2;
  const R = size / 2 - 6;
  const r0 = R * 0.66;
  const wrap = H('div', 'ch-donut' + (wide ? ' wide' : ''));
  const fig = H('div', 'ch-dfig', null, wrap);
  fig.style.width = fig.style.height = size + 'px';
  const svg = S('svg', { class: 'ch-svg', width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img' }, fig);
  const aria = ariaFor(opts, 'Donut chart', slices.map((s) => `${s.name} ${pctStr(s.pct)}`), null, 0);
  svg.setAttribute('aria-label', aria);
  const defs = S('defs', null, svg);
  const gS = S('g', { class: 'ch-slices' }, svg);
  if (animate) {
    const mid = (R + r0) / 2;
    const mk = S('mask', { id: `chm${uid}`, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: size, height: size }, defs);
    S('circle', { class: 'ch-sweep-m', cx, cy: cx, r: r2(mid), 'stroke-width': r2(R - r0 + 8), pathLength: 1, transform: `rotate(-90 ${cx} ${cx})` }, mk);
    gS.setAttribute('mask', `url(#chm${uid})`);
  }
  const pt = (r, a) => [cx + r * Math.cos(a), cx + r * Math.sin(a)];
  let a = -Math.PI / 2;
  const sliceEls = new Map();
  for (const s of slices) {
    const sweep = Math.min((s.value / total) * Math.PI * 2, Math.PI * 2 - 0.0001);
    const a1 = a + sweep;
    const [ox0, oy0] = pt(R, a);
    const [ox1, oy1] = pt(R, a1);
    const [ix1, iy1] = pt(r0, a1);
    const [ix0, iy0] = pt(r0, a);
    const lg = sweep > Math.PI ? 1 : 0;
    const d = `M${r2(ox0)} ${r2(oy0)}A${r2(R)} ${r2(R)} 0 ${lg} 1 ${r2(ox1)} ${r2(oy1)}L${r2(ix1)} ${r2(iy1)}A${r2(r0)} ${r2(r0)} 0 ${lg} 0 ${r2(ix0)} ${r2(iy0)}Z`;
    const p = S('path', { class: 'ch-slice', d, 'data-key': s.key }, gS);
    setColor(p, 'fill', s.color);
    p.style.transformOrigin = `${cx}px ${cx}px`;
    sliceEls.set(s.key, p);
    a = a1;
  }
  const hole = r0 * 2 - 20;
  const center = H('div', 'ch-dcenter', null, fig);
  center.style.width = hole + 'px';
  const cL = H('span', 'ch-dc-l', null, center);
  const cV = H('strong', 'ch-dc-v', null, center);
  const cS = H('span', 'ch-dc-s', null, center);
  const list = H('ul', 'ch-dlist', null, wrap);
  const rowEls = new Map();
  for (const s of slices) {
    const li = H('li', null, null, list);
    const b = H('button', 'ch-drow', null, li);
    b.type = 'button';
    b.dataset.key = s.key;
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', `${s.name}: ${fmt(s.value)}, ${pctStr(s.pct)}`);
    const sw = H('span', 'ch-dsw', null, b);
    sw.style.background = s.color;
    H('span', 'ch-dn', s.name, b);
    H('span', 'ch-dv', fmt(s.value), b);
    H('span', 'ch-dp', pctStr(s.pct), b);
    rowEls.set(s.key, b);
  }

  let active = null;
  let selKey = state.selected !== undefined && state.selected !== null && sliceEls.has(String(state.selected)) ? String(state.selected) : null;
  const find = (k) => slices.find((s) => s.key === k);
  const paintCenter = () => {
    const s = find(active !== null ? active : selKey);
    if (s) {
      cL.textContent = s.name;
      cV.textContent = fmt(s.value);
      cS.textContent = pctStr(s.pct);
    } else {
      cL.textContent = opts.centerLabel !== undefined ? opts.centerLabel : 'Total (합계)';
      cV.textContent = opts.centerValue !== undefined ? opts.centerValue : fmt(total);
      cS.textContent = '';
    }
  };
  const apply = () => {
    wrap.classList.toggle('has-act', active !== null);
    wrap.classList.toggle('has-sel', selKey !== null);
    for (const [k, p] of sliceEls) {
      p.classList.toggle('is-act', k === active);
      p.classList.toggle('is-sel', k === selKey);
      rowEls.get(k).classList.toggle('is-act', k === active);
      rowEls.get(k).classList.toggle('is-sel', k === selKey);
      rowEls.get(k).setAttribute('aria-pressed', k === selKey ? 'true' : 'false');
    }
    paintCenter();
  };
  const choose = (k) => {
    selKey = k;
    state.selected = k;
    apply();
    if (typeof opts.onSelect === 'function') {
      try { opts.onSelect(k); } catch (e) { console.error(e); }
    }
  };
  for (const [k, p] of sliceEls) {
    p.addEventListener('pointerenter', () => { active = k; apply(); });
    p.addEventListener('pointerleave', () => { active = null; apply(); });
    p.addEventListener('click', () => choose(k));
  }
  for (const [k, b] of rowEls) {
    b.addEventListener('pointerenter', () => { active = k; apply(); });
    b.addEventListener('pointerleave', () => { if (document.activeElement !== b) { active = null; apply(); } });
    b.addEventListener('focus', () => { active = k; apply(); });
    b.addEventListener('blur', () => { active = null; apply(); });
    b.addEventListener('click', () => choose(k));
    b.addEventListener('keydown', (e) => {
      const btns = [...rowEls.values()];
      const i = btns.indexOf(b);
      let j = null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') j = (i + 1) % btns.length;
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') j = (i - 1 + btns.length) % btns.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = btns.length - 1;
      if (j !== null) { e.preventDefault(); btns[j].focus(); }
    });
  }
  apply();
  return { el: wrap, n: 0, ariaLabel: aria, legend: null, slices };
}

export function donut(opts) {
  return createChart('donut', opts, buildDonut, { focusable: false });
}

/* ───────────────────────── ranked horizontal bars ───────────────────────── */

function buildHbars(ctx) {
  const { opts, state } = ctx;
  const fmt = mkFmt(opts.fmt);
  const rows = (opts.rows || []).map((r, i) => ({ ...r, key: r.key !== undefined ? String(r.key) : String(i), name: r.name !== undefined ? String(r.name) : String(r.key), _i: i }));
  if (!rows.length || rows.every((r) => !isNum(r.value) || r.value === 0)) return { empty: true };
  const maxV = isNum(opts.max) && opts.max > 0 ? opts.max : Math.max(...rows.map((r) => (isNum(r.value) ? r.value : 0)), ...rows.map((r) => (isNum(r.marker) ? r.marker : 0)), 1e-9);
  const pctW = (v) => clamp((v / maxV) * 100, 0, 100);
  const list = H('div', 'ch-hbars-list');
  list.setAttribute('role', 'list');
  const clickable = typeof opts.onSelect === 'function';
  const selKey = state.selected !== undefined && state.selected !== null ? String(state.selected) : null;
  const els = new Map();
  for (const r of rows) {
    const v = isNum(r.value) ? r.value : 0;
    let status = r.status;
    if (!status && isNum(r.marker) && r.marker > 0) status = v > r.marker ? 'over' : v >= r.marker * 0.85 ? 'near' : 'ok';
    const row = H(clickable ? 'button' : 'div', 'ch-hrow' + (status ? ' ' + status : '') + (selKey === r.key ? ' is-sel' : ''), null, list);
    if (clickable) row.type = 'button'; else row.setAttribute('role', 'listitem');
    row.dataset.key = r.key;
    const head = H('div', 'ch-hhead', null, row);
    H('span', 'ch-hname', r.name, head);
    const val = H('span', 'ch-hval', null, head);
    H('b', null, fmt(v), val);
    if (isNum(r.pct)) H('i', null, `${+r.pct.toFixed(1)}%`, val);
    const track = H('div', 'ch-htrack', null, row);
    const fill = H('span', 'ch-hfill', null, track);
    fill.style.width = r2(pctW(v)) + '%';
    fill.style.setProperty('--i', String(Math.min(r._i, 20)));
    if (r.color && (!status || status === 'ok')) fill.style.background = r.color;
    if (isNum(r.marker)) {
      const mk = H('span', 'ch-hmark', null, track);
      mk.style.left = r2(pctW(r.marker)) + '%';
      mk.title = fmt(r.marker);
    }
    if (r.sub) H('div', 'ch-hsub', String(r.sub), row);
    if (status === 'over') H('span', 'ch-sr', 'Over budget (예산 초과)', row);
    else if (status === 'near') H('span', 'ch-sr', 'Near limit (한도 근접)', row);
    if (clickable) {
      row.addEventListener('click', () => {
        state.selected = r.key;
        for (const [k, e] of els) e.classList.toggle('is-sel', k === r.key);
        try { opts.onSelect(r.key, r); } catch (e) { console.error(e); }
      });
    }
    els.set(r.key, row);
  }
  return { el: list, n: 0, legend: null, ariaLabel: opts.title || opts.ariaLabel || 'Ranked bars' };
}

export function hbars(opts) {
  return createChart('hbars', opts, buildHbars, { focusable: false });
}

/* ───────────────────────── sparkline ───────────────────────── */

export function sparkline(values, o = {}) {
  const w = o.width || 80;
  const h = o.height || 24;
  const color = o.color || 'var(--green)';
  const pad = 3;
  const svg = S('svg', { class: 'ch-spark', width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  if (o.label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', o.label); } else svg.setAttribute('aria-hidden', 'true');
  const vals = (Array.isArray(values) ? values : []).map((v) => (isNum(v) ? v : null));
  const fin = vals.filter((v) => v !== null);
  if (!fin.length) {
    S('line', { class: 'ch-spark-empty', x1: pad, x2: w - pad, y1: h / 2, y2: h / 2 }, svg);
    return svg;
  }
  let lo = Math.min(...fin);
  let hi = Math.max(...fin);
  if (hi === lo) { lo -= 1; hi += 1; }
  const n = vals.length;
  const xs = (i) => (n > 1 ? pad + (i * (w - 2 * pad)) / (n - 1) : w / 2);
  const ys = (v) => pad + (1 - (v - lo) / (hi - lo)) * (h - 2 * pad);
  const run = [];
  vals.forEach((v, i) => { if (v !== null) run.push({ x: xs(i), y: ys(v) }); });
  const gid = `chs${++UID}`;
  if (o.fill && run.length >= 2) {
    const defs = S('defs', null, svg);
    const lg = S('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    const a = S('stop', { offset: '0%', 'stop-opacity': 0.3 }, lg);
    const b = S('stop', { offset: '100%', 'stop-opacity': 0 }, lg);
    setColor(a, 'stop-color', color);
    setColor(b, 'stop-color', color);
    S('path', { class: 'ch-spark-area', d: `${curvePath(run, true)}L${r2(run[run.length - 1].x)} ${h}L${r2(run[0].x)} ${h}Z`, fill: `url(#${gid})` }, svg);
  }
  if (run.length >= 2) {
    const p = S('path', { class: 'ch-spark-line', d: curvePath(run, true) }, svg);
    setColor(p, 'stroke', color);
  }
  if (o.last !== false && (o.last || run.length === 1)) {
    const l = run[run.length - 1];
    const c = S('circle', { class: 'ch-spark-dot', cx: r2(l.x), cy: r2(l.y), r: 2.5 }, svg);
    setColor(c, 'fill', color);
  }
  return svg;
}
