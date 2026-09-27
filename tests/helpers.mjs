// Shared helpers for the pipeline tests: load OpenCV.js in Node and build
// synthetic "photo on a table" scenes with known geometry and glare.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '..');

let cached = null;
export async function loadPipeline() {
  if (cached) return cached;
  const cvModule = require(path.join(root, 'vendor/opencv.js'));
  const cv = cvModule instanceof Promise ? await cvModule : cvModule;
  const P = require(path.join(root, 'js/pipeline.js'));
  P.init(cv);
  const model = fs.readFileSync(path.join(root, 'models/face_detection_yunet_2023mar.onnx'));
  try { cv.FS_createDataFile('/', 'yunet.onnx', new Uint8Array(model), true, false, false); } catch (e) { /* exists */ }
  P.setFaceModel('/yunet.onnx');
  cached = { cv, P };
  return cached;
}

// Deterministic PRNG so failures are reproducible.
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A busy, colourful "photo" with plenty of texture for feature matching. */
export function makePhoto(cv, w, h, seed = 1, opts = {}) {
  const r = rng(seed);
  const m = new cv.Mat(h, w, cv.CV_8UC4);
  const d = m.data;
  const c1 = [r() * 255, r() * 255, r() * 255], c2 = [r() * 255, r() * 255, r() * 255];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) d[o + c] = c1[c] * (1 - t) + c2[c] * t;
      d[o + 3] = 255;
    }
  }
  for (let i = 0; i < 70; i++) {
    const col = new cv.Scalar(r() * 255, r() * 255, r() * 255, 255);
    const cx = r() * w, cy = r() * h, sz = 8 + r() * w * 0.12;
    const kind = r();
    if (kind < 0.35) cv.circle(m, new cv.Point(cx, cy), sz / 2, col, -1, cv.LINE_AA);
    else if (kind < 0.7) cv.rectangle(m, new cv.Point(cx, cy), new cv.Point(cx + sz, cy + sz * 0.6), col, -1);
    else cv.line(m, new cv.Point(cx, cy), new cv.Point(cx + (r() - 0.5) * w * 0.4, cy + (r() - 0.5) * h * 0.4), col, 2 + r() * 5, cv.LINE_AA);
  }
  for (let i = 0; i < 6; i++) {
    cv.putText(m, 'SCAN ' + Math.floor(r() * 1000), new cv.Point(r() * w * 0.7, 30 + r() * (h - 40)),
      cv.FONT_HERSHEY_SIMPLEX, 0.6 + r(), new cv.Scalar(r() * 255, r() * 255, r() * 255, 255), 2, cv.LINE_AA);
  }
  // fine grain
  const g = m.data;
  for (let o = 0; o < g.length; o += 4) {
    const n = (r() - 0.5) * 10;
    g[o] += n; g[o + 1] += n; g[o + 2] += n;
  }
  if (opts.border) {
    cv.rectangle(m, new cv.Point(0, 0), new cv.Point(w - 1, h - 1), new cv.Scalar(245, 245, 240, 255), opts.border);
  }
  return m;
}

/** A plain-ish table surface with mild texture. */
export function makeTable(cv, w, h, seed = 7, base = [120, 90, 60]) {
  const r = rng(seed);
  const m = new cv.Mat(h, w, cv.CV_8UC4);
  const d = m.data;
  for (let y = 0; y < h; y++) {
    const grain = Math.sin(y * 0.05) * 8 + Math.sin(y * 0.013) * 10;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const n = (r() - 0.5) * 12 + grain;
      d[o] = base[0] + n; d[o + 1] = base[1] + n; d[o + 2] = base[2] + n; d[o + 3] = 255;
    }
  }
  return m;
}

/** Composite `photo` onto `table` using the quad `dstQuad` (tl, tr, br, bl). */
export function placePhoto(cv, table, photo, dstQuad) {
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, photo.cols, 0, photo.cols, photo.rows, 0, photo.rows]);
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, dstQuad.flat());
  const M = cv.getPerspectiveTransform(src, dst);
  const warped = new cv.Mat();
  cv.warpPerspective(photo, warped, M, new cv.Size(table.cols, table.rows), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
  const out = new cv.Mat(); table.copyTo(out);
  const a = warped.data, o = out.data; // read after all allocations
  for (let i = 0; i < o.length; i += 4) {
    const al = a[i + 3] / 255;
    if (al > 0) {
      o[i] = a[i] * al + o[i] * (1 - al);
      o[i + 1] = a[i + 1] * al + o[i + 1] * (1 - al);
      o[i + 2] = a[i + 2] * al + o[i + 2] * (1 - al);
    }
  }
  src.delete(); dst.delete(); M.delete(); warped.delete();
  return out;
}

/** Warp a flat scene into a camera view with homography H (scene -> view). */
export function viewOf(cv, scene, H, w, h) {
  const M = cv.matFromArray(3, 3, cv.CV_64F, H);
  const out = new cv.Mat();
  cv.warpPerspective(scene, out, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REFLECT, new cv.Scalar());
  M.delete();
  return out;
}

/** Add a soft specular highlight (whitish, additive) centred at (cx, cy). */
export function addGlare(m, cx, cy, rx, ry, strength = 200) {
  const d = m.data, w = m.cols, h = m.rows;
  const x0 = Math.max(0, Math.floor(cx - rx * 2.5)), x1 = Math.min(w, Math.ceil(cx + rx * 2.5));
  const y0 = Math.max(0, Math.floor(cy - ry * 2.5)), y1 = Math.min(h, Math.ceil(cy + ry * 2.5));
  const mask = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      const g = Math.exp(-(dx * dx + dy * dy)) * strength;
      if (g < 1) continue;
      const o = (y * w + x) * 4;
      d[o] = Math.min(255, d[o] + g); d[o + 1] = Math.min(255, d[o + 1] + g); d[o + 2] = Math.min(255, d[o + 2] + g * 0.97);
      if (g > 30) mask[y * w + x] = 1;
    }
  }
  return mask;
}

/** Homography for a camera looking at the table from a slightly moved pose. */
export function cameraH(w, h, { tx = 0, ty = 0, rot = 0, zoom = 1, px = 0, py = 0 } = {}) {
  const cx = w / 2, cy = h / 2;
  const c = Math.cos(rot) * zoom, s = Math.sin(rot) * zoom;
  // translate to centre, rotate/scale, add perspective, translate back + shift
  const A = [c, -s, 0, s, c, 0, px, py, 1];
  const T1 = [1, 0, -cx, 0, 1, -cy, 0, 0, 1];
  const T2 = [1, 0, cx + tx, 0, 1, cy + ty, 0, 0, 1];
  const mul = (X, Y) => {
    const Z = new Array(9);
    for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) Z[r * 3 + q] = X[r * 3] * Y[q] + X[r * 3 + 1] * Y[3 + q] + X[r * 3 + 2] * Y[6 + q];
    return Z;
  };
  return mul(T2, mul(A, T1));
}

export function meanAbsDiff(a, b, mask) {
  const da = a.data, db = b.data;
  let s = 0, n = 0;
  const N = a.cols * a.rows;
  for (let p = 0; p < N; p++) {
    if (mask && !mask[p]) continue;
    const o = p * 4;
    s += Math.abs(da[o] - db[o]) + Math.abs(da[o + 1] - db[o + 1]) + Math.abs(da[o + 2] - db[o + 2]);
    n += 3;
  }
  return n ? s / n : 0;
}
