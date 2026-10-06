// 영수증 사진 → "스캔본" 처럼 보정: 가장자리(책상) 자르기 · 그림자/조명 고르게 · 글씨는 진하게 · 배경은 하얗게 · 크기 줄이기.
// 계산은 모두 화면과 무관한 순수 함수(픽셀 배열 → 픽셀 배열)라서 테스트로 검증합니다. 브라우저 부분(canvas)은 맨 아래 scanBlob 하나뿐.
//
// 처리 순서 (gray = 밝기 0~255)
//  1) findPaperBox : 작은 그림에서 "종이(밝은 부분)"의 네모를 찾아 책상 부분을 잘라냅니다.
//                    잘라낼 부분에 글씨 같은 것이 보이면 그쪽은 자르지 않습니다 (영수증이 잘리면 안 되니까).
//  2) enhance      : 종이 밝기가 한쪽만 어두운 것(그림자)을 나눠서 펴고, 글씨를 진하게 합니다.

export const MODES = ['scan', 'color', 'orig'];
export const DEFAULT_MAX = 1800;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** RGBA → 밝기 */
export function toGray(rgba, w, h) {
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;
  return g;
}

/** 큰 그림을 평균으로 줄이기 (칸 평균). 결과 { g, w, h, f } — f 는 줄인 배수 */
export function shrink(gray, w, h, maxSide) {
  const f = Math.max(1, Math.floor(Math.max(w, h) / maxSide));
  if (f === 1) return { g: gray, w, h, f: 1 };
  const sw = Math.max(1, Math.floor(w / f)), sh = Math.max(1, Math.floor(h / f));
  const out = new Uint8ClampedArray(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let s = 0, n = 0;
      for (let yy = 0; yy < f; yy++) { const row = (y * f + yy) * w + x * f; for (let xx = 0; xx < f; xx++) { s += gray[row + xx]; n++; } }
      out[y * sw + x] = s / n;
    }
  }
  return { g: out, w: sw, h: sh, f };
}

/** 대비가 가장 크게 갈리는 밝기 경계 (Otsu) */
export function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i] | 0]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = -1, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return { thr, sep: best / Math.max(1, total * total) };   // sep: 두 덩어리가 얼마나 뚜렷이 갈리는지
}

/** 합계 이미지(integral)로 네모 평균을 빠르게 구하기 */
function integral(gray, w, h) {
  const W = w + 1;
  const I = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += gray[y * w + x]; I[(y + 1) * W + x + 1] = I[y * W + x + 1] + row; }
  }
  return { I, W };
}
const boxMean = (ii, w, h, x, y, r) => {
  const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
  const { I, W } = ii;
  return (I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
};

/** 글씨 같은 잔무늬(작고 또렷한 어두운 점)의 비율. 책상 같은 매끈한 곳은 낮고, 영수증 글씨는 높습니다. */
export function inkRatio(gray, w, h, x0, y0, x1, y1, ii) {
  if (x1 <= x0 || y1 <= y0) return 0;
  const II = ii || integral(gray, w, h);
  let ink = 0, n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      n++;
      if (boxMean(II, w, h, x, y, 7) - gray[y * w + x] > 34) ink++;
    }
  }
  return n ? ink / n : 0;
}

/**
 * 종이 네모 찾기. 돌려주는 값 { x, y, w, h } (원래 그림 기준 픽셀) 또는 null (자를 필요 없음/자르면 위험).
 * 보수적으로: 종이가 화면의 30%~93% 이고, 잘라낼 띠에 글씨 같은 것이 없을 때만 그쪽을 자릅니다.
 */
export function findPaperBox(gray, w, h) {
  const sm = shrink(gray, w, h, 140);
  const { g, w: sw, h: sh, f } = sm;
  const { thr, sep } = otsu(g);
  if (sep < 0.012) return null;                              // 밝고 어두운 덩어리가 뚜렷하지 않음 (영수증이 화면 가득)
  const T = thr * 0.92;                                      // 종이 그림자도 종이로 치도록 살짝 너그럽게
  const colCnt = new Int32Array(sw), rowCnt = new Int32Array(sh);
  let bright = 0;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if (g[y * sw + x] > T) { colCnt[x]++; rowCnt[y]++; bright++; }
  if (bright / (sw * sh) < 0.12) return null;
  const maxCol = Math.max(...colCnt), maxRow = Math.max(...rowCnt);
  const first = (arr, lim) => { for (let i = 0; i < arr.length; i++) if (arr[i] >= lim) return i; return 0; };
  const last = (arr, lim) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] >= lim) return i; return arr.length - 1; };
  let bx0 = first(colCnt, maxCol * 0.25), bx1 = last(colCnt, maxCol * 0.25) + 1;
  let by0 = first(rowCnt, maxRow * 0.25), by1 = last(rowCnt, maxRow * 0.25) + 1;
  // 가장자리 여백
  const mx = Math.ceil(sw * 0.015), my = Math.ceil(sh * 0.015);
  bx0 = Math.max(0, bx0 - mx); by0 = Math.max(0, by0 - my); bx1 = Math.min(sw, bx1 + mx); by1 = Math.min(sh, by1 + my);
  // 원래 크기로 되돌리기
  let X0 = bx0 * f, Y0 = by0 * f, X1 = Math.min(w, bx1 * f), Y1 = Math.min(h, by1 * f);
  // 잘라낼 띠(위·아래·왼쪽·오른쪽)에 글씨가 보이면 그쪽은 자르지 않음
  const ii = integral(gray, w, h);
  const STRIP_INK = 0.025;
  if (Y0 > 0 && inkRatio(gray, w, h, 0, 0, w, Y0, ii) > STRIP_INK) Y0 = 0;
  if (Y1 < h && inkRatio(gray, w, h, 0, Y1, w, h, ii) > STRIP_INK) Y1 = h;
  if (X0 > 0 && inkRatio(gray, w, h, 0, 0, X0, h, ii) > STRIP_INK) X0 = 0;
  if (X1 < w && inkRatio(gray, w, h, X1, 0, w, h, ii) > STRIP_INK) X1 = w;
  const area = ((X1 - X0) * (Y1 - Y0)) / (w * h);
  if (area > 0.93 || area < 0.3) return null;
  return { x: Math.round(X0), y: Math.round(Y0), w: Math.round(X1 - X0), h: Math.round(Y1 - Y0) };
}

/** RGBA 에서 네모 부분만 잘라 새 배열로 */
export function cropRgba(rgba, w, h, box) {
  const out = new Uint8ClampedArray(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) {
    const src = ((box.y + y) * w + box.x) * 4;
    out.set(rgba.subarray(src, src + box.w * 4), y * box.w * 4);
  }
  return out;
}

// 종이 밝기 지도: 칸마다 평균을 내고, 가까운 칸 중 가장 밝은 값(글씨에 눌리지 않도록)을 쓴 뒤 부드럽게 합니다.
function paperLevel(gray, w, h) {
  const cell = Math.max(8, Math.round(Math.max(w, h) / 80));
  const cw = Math.max(1, Math.ceil(w / cell)), ch = Math.max(1, Math.ceil(h / cell));
  const mean = new Float32Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let s = 0, n = 0;
      const y1 = Math.min(h, (cy + 1) * cell), x1 = Math.min(w, (cx + 1) * cell);
      for (let y = cy * cell; y < y1; y++) { const row = y * w; for (let x = cx * cell; x < x1; x++) { s += gray[row + x]; n++; } }
      mean[cy * cw + cx] = n ? s / n : 255;
    }
  }
  const R = 2;
  const mx = new Float32Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let m = 0;
      for (let yy = Math.max(0, cy - R); yy <= Math.min(ch - 1, cy + R); yy++) for (let xx = Math.max(0, cx - R); xx <= Math.min(cw - 1, cx + R); xx++) if (mean[yy * cw + xx] > m) m = mean[yy * cw + xx];
      mx[cy * cw + cx] = m;
    }
  }
  const sm = new Float32Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let s = 0, n = 0;
      for (let yy = Math.max(0, cy - 1); yy <= Math.min(ch - 1, cy + 1); yy++) for (let xx = Math.max(0, cx - 1); xx <= Math.min(cw - 1, cx + 1); xx++) { s += mx[yy * cw + xx]; n++; }
      sm[cy * cw + cx] = s / n;
    }
  }
  // 픽셀마다 쌍선형으로 읽어 오기
  return (x, y) => {
    const fx = clamp(x / cell - 0.5, 0, cw - 1), fy = clamp(y / cell - 0.5, 0, ch - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(cw - 1, x0 + 1), y1 = Math.min(ch - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const a = sm[y0 * cw + x0] * (1 - tx) + sm[y0 * cw + x1] * tx, b = sm[y1 * cw + x0] * (1 - tx) + sm[y1 * cw + x1] * tx;
    return a * (1 - ty) + b * ty;
  };
}

/**
 * 스캔본 보정 (제자리에서 RGBA 를 고침).
 *  mode 'scan' = 흑백, 'color' = 색 유지.
 *  종이 밝기로 나눠 조명을 고르게 한 뒤, 글씨 쪽을 더 진하게(대비 늘리기).
 * 돌려주는 값: { black, white } (적용한 밝기 범위)
 */
export function enhance(rgba, w, h, mode) {
  const gray = toGray(rgba, w, h);
  const level = paperLevel(gray, w, h);
  const norm = new Uint8ClampedArray(w * h);   // 조명 보정 후 밝기
  const gain = new Float32Array(w * h);
  const hist = new Array(256).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const bg = Math.max(60, level(x, y));
      const gn = 255 / bg;
      gain[i] = gn;
      const v = clamp(gray[i] * gn, 0, 255);
      norm[i] = v; hist[v | 0]++;
    }
  }
  // 글씨(어두운 쪽 1%)를 검정 쪽으로, 종이(240 이상)는 흰색으로
  let acc = 0, black = 0;
  const target = w * h * 0.01;
  for (let t = 0; t < 256; t++) { acc += hist[t]; if (acc >= target) { black = t; break; } }
  black = clamp(black, 0, 120);
  const white = 238;
  const span = Math.max(40, white - black);
  const map = new Uint8ClampedArray(256);
  for (let t = 0; t < 256; t++) {
    const u = clamp((t - black) / span, 0, 1);
    map[t] = 255 * (u * u * (3 - 2 * u) * 0.35 + u * 0.65);   // 선형과 부드러운 S 곡선을 섞음
  }
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    if (mode === 'color') {
      // 색 유지: 같은 비율로 키운 뒤, 밝기 변화만큼 색 전체를 같이 움직임
      const n = norm[i], m = map[n];
      const k = n > 0 ? m / n : 1;
      const g = gain[i];
      rgba[j] = clamp(rgba[j] * g * k, 0, 255);
      rgba[j + 1] = clamp(rgba[j + 1] * g * k, 0, 255);
      rgba[j + 2] = clamp(rgba[j + 2] * g * k, 0, 255);
    } else {
      const m = map[norm[i]];
      rgba[j] = m; rgba[j + 1] = m; rgba[j + 2] = m;
    }
    rgba[j + 3] = 255;
  }
  return { black, white };
}

// ───────── 브라우저: 파일 → 스캔본 JPEG ─────────

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
const toBlob = (canvas, type, q) => new Promise((res) => canvas.toBlob(res, type, q));

/**
 * source(ImageBitmap 등)를 스캔본으로. opts = { mode: 'scan'|'color', maxDim, quality, thumb }
 * → { blob, thumbBlob, width, height, cropped: bool }
 */
export async function scanBlob(source, srcW, srcH, opts) {
  const o = Object.assign({ mode: 'scan', maxDim: DEFAULT_MAX, quality: 0.8, thumb: 240 }, opts || {});
  const scale = Math.min(1, o.maxDim / Math.max(srcW, srcH));
  let w = Math.max(1, Math.round(srcW * scale)), h = Math.max(1, Math.round(srcH * scale));
  const c1 = canvasOf(w, h);
  const x1 = c1.getContext('2d', { willReadFrequently: true });
  x1.drawImage(source, 0, 0, w, h);
  let img = x1.getImageData(0, 0, w, h);
  let rgba = img.data;
  let cropped = false;
  const box = findPaperBox(toGray(rgba, w, h), w, h);
  if (box) { rgba = cropRgba(rgba, w, h, box); w = box.w; h = box.h; cropped = true; }
  enhance(rgba, w, h, o.mode);
  const out = canvasOf(w, h);
  const ox = out.getContext('2d');
  ox.putImageData(new ImageData(rgba, w, h), 0, 0);
  const blob = await toBlob(out, 'image/jpeg', o.quality);
  if (!blob) throw new Error('사진을 변환하지 못했습니다.');
  let thumbBlob = null;
  if (o.thumb) {
    const ts = Math.min(1, o.thumb / Math.max(w, h));
    const tc = canvasOf(Math.max(1, Math.round(w * ts)), Math.max(1, Math.round(h * ts)));
    tc.getContext('2d').drawImage(out, 0, 0, tc.width, tc.height);
    thumbBlob = await toBlob(tc, 'image/jpeg', 0.6);
  }
  return { blob, thumbBlob, width: w, height: h, cropped };
}
