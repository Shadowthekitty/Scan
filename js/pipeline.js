/*
 * Scan image pipeline.
 *
 * Pure image-processing functions built on OpenCV.js. The file is a classic
 * script so it can be loaded with importScripts() inside the Web Worker, and
 * it also exports itself for Node so the test-suite can exercise it.
 *
 * Coordinates are always [x, y] pixel pairs. Quads are ordered
 * top-left, top-right, bottom-right, bottom-left.
 */
(function (root) {
  'use strict';

  let cv = null;
  let faceModelPath = null;
  let faceDetector = null;
  let faceDetectorSize = null;

  function init(cvModule) { cv = cvModule; }
  function setFaceModel(path) { faceModelPath = path; }

  /* ------------------------------------------------------------------ */
  /* Mat lifetime helpers                                                */
  /* ------------------------------------------------------------------ */

  function scope() {
    const mats = [];
    const s = (m) => { mats.push(m); return m; };
    s.free = () => {
      for (const m of mats) {
        try {
          if (m && typeof m.delete === 'function' && !(m.isDeleted && m.isDeleted())) m.delete();
        } catch (e) { /* already gone */ }
      }
      mats.length = 0;
    };
    return s;
  }

  function matFromImage(img) {
    const m = new cv.Mat(img.height, img.width, cv.CV_8UC4);
    m.data.set(img.data);
    return m;
  }

  function imageFromMat(m) {
    let rgba = m;
    let tmp = null;
    if (m.type() !== cv.CV_8UC4) {
      tmp = new cv.Mat();
      const code = m.channels() === 1 ? cv.COLOR_GRAY2RGBA : cv.COLOR_RGB2RGBA;
      cv.cvtColor(m, tmp, code);
      rgba = tmp;
    }
    const out = { width: rgba.cols, height: rgba.rows, data: new Uint8ClampedArray(rgba.data) };
    if (tmp) tmp.delete();
    return out;
  }

  // Note: Mat.clone() in this OpenCV.js build shares pixel memory with the
  // source, so always copy through copyTo().
  function copyMat(src) {
    const dst = new cv.Mat();
    src.copyTo(dst);
    return dst;
  }

  function resizeMax(src, maxSide, interp) {
    const s = Math.min(1, maxSide / Math.max(src.cols, src.rows));
    const dst = new cv.Mat();
    if (s >= 1) { src.copyTo(dst); return { mat: dst, scale: 1 }; }
    const w = Math.max(1, Math.round(src.cols * s));
    const h = Math.max(1, Math.round(src.rows * s));
    cv.resize(src, dst, new cv.Size(w, h), 0, 0, interp === undefined ? cv.INTER_AREA : interp);
    return { mat: dst, scale: w / src.cols };
  }

  function toGray(src) {
    const g = new cv.Mat();
    const ch = src.channels();
    if (ch === 1) src.copyTo(g);
    else cv.cvtColor(src, g, ch === 4 ? cv.COLOR_RGBA2GRAY : cv.COLOR_RGB2GRAY);
    return g;
  }

  /* ------------------------------------------------------------------ */
  /* Small geometry toolkit                                              */
  /* ------------------------------------------------------------------ */

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  function polyArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a) / 2;
  }

  function centroid(pts) {
    let x = 0, y = 0;
    for (const p of pts) { x += p[0]; y += p[1]; }
    return [x / pts.length, y / pts.length];
  }

  function orderQuad(pts) {
    const c = centroid(pts);
    const sorted = pts.slice().sort((a, b) =>
      Math.atan2(a[1] - c[1], a[0] - c[0]) - Math.atan2(b[1] - c[1], b[0] - c[0]));
    let start = 0, best = Infinity;
    for (let i = 0; i < 4; i++) {
      const v = sorted[i][0] + sorted[i][1];
      if (v < best) { best = v; start = i; }
    }
    const out = [];
    for (let i = 0; i < 4; i++) out.push(sorted[(start + i) % 4].slice());
    return out;
  }

  function isConvexQuad(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cr) < 1e-9) return false;
      const s = Math.sign(cr);
      if (sign === 0) sign = s; else if (s !== sign) return false;
    }
    return true;
  }

  function quadAngles(q) {
    const out = [];
    for (let i = 0; i < 4; i++) {
      const p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4];
      const v1 = [p[0] - c[0], p[1] - c[1]], v2 = [n[0] - c[0], n[1] - c[1]];
      const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) + 1e-9);
      out.push(Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI);
    }
    return out;
  }

  // Intersection of two infinite lines given as point + direction.
  function intersectLines(p, d, q, e) {
    const den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-9) return null;
    const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
    return [p[0] + d[0] * t, p[1] + d[1] * t];
  }

  function pointInQuad(pt, q) {
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const xi = q[i][0], yi = q[i][1], xj = q[j][0], yj = q[j][1];
      if (((yi > pt[1]) !== (yj > pt[1])) &&
          (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi + 1e-12) + xi)) inside = !inside;
    }
    return inside;
  }

  // Approximate intersection-over-union of two quads by grid sampling.
  function quadIoU(a, b) {
    const xs = a.concat(b).map((p) => p[0]), ys = a.concat(b).map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const n = 40;
    let inter = 0, uni = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const pt = [x0 + (x1 - x0) * (i + 0.5) / n, y0 + (y1 - y0) * (j + 0.5) / n];
        const ia = pointInQuad(pt, a), ib = pointInQuad(pt, b);
        if (ia && ib) inter++;
        if (ia || ib) uni++;
      }
    }
    return uni ? inter / uni : 0;
  }

  /* 3x3 matrices stored row-major in plain arrays. */
  function mul3(A, B) {
    const C = new Array(9);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
      }
    }
    return C;
  }

  function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return null;
    const k = 1 / det;
    return [
      A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
      B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
      C * k, -(a * h - b * g) * k, (a * e - b * d) * k,
    ];
  }

  const scaleMat = (s) => [s, 0, 0, 0, s, 0, 0, 0, 1];
  const translateMat = (x, y) => [1, 0, x, 0, 1, y, 0, 0, 1];

  function applyH(H, p) {
    const w = H[6] * p[0] + H[7] * p[1] + H[8];
    return [(H[0] * p[0] + H[1] * p[1] + H[2]) / w, (H[3] * p[0] + H[4] * p[1] + H[5]) / w];
  }

  function matFromH(H) { return cv.matFromArray(3, 3, cv.CV_64F, H); }

  /* ------------------------------------------------------------------ */
  /* Photo edge detection                                                */
  /* ------------------------------------------------------------------ */

  // Reduce a convex polygon (hull) to four corners.
  function polygonToQuad(hullPts) {
    if (hullPts.length < 4) return null;
    const hull = cv.matFromArray(hullPts.length, 1, cv.CV_32SC2, hullPts.flat());
    const peri = cv.arcLength(hull, true);
    let last = null;
    for (const eps of [0.01, 0.02, 0.03, 0.045, 0.065, 0.09]) {
      const approx = new cv.Mat();
      cv.approxPolyDP(hull, approx, eps * peri, true);
      const pts = [];
      for (let i = 0; i < approx.rows; i++) pts.push([approx.data32S[i * 2], approx.data32S[i * 2 + 1]]);
      approx.delete();
      if (pts.length === 4) { hull.delete(); return pts; }
      if (pts.length < 4) break;
      last = pts;
    }
    hull.delete();
    if (!last) return null;
    // Rounded or clipped corners leave short extra edges. Keep the four
    // longest edges and intersect them.
    const edges = last.map((p, i) => ({ i, p, q: last[(i + 1) % last.length], len: dist(p, last[(i + 1) % last.length]) }));
    const top = edges.slice().sort((a, b) => b.len - a.len).slice(0, 4).sort((a, b) => a.i - b.i);
    const quad = [];
    for (let k = 0; k < 4; k++) {
      const e1 = top[k], e2 = top[(k + 1) % 4];
      const pt = intersectLines(e1.p, [e1.q[0] - e1.p[0], e1.q[1] - e1.p[1]], e2.p, [e2.q[0] - e2.p[0], e2.q[1] - e2.p[1]]);
      if (!pt) return null;
      quad.push(pt);
    }
    return quad;
  }

  function edgeSupport(edgeMap, quad) {
    const w = edgeMap.cols, h = edgeMap.rows, d = edgeMap.data;
    const per = [];
    for (let k = 0; k < 4; k++) {
      const a = quad[k], b = quad[(k + 1) % 4];
      const n = 48;
      let hit = 0, tot = 0;
      for (let i = 0; i < n; i++) {
        const t = 0.04 + 0.92 * (i + 0.5) / n;
        const x = Math.round(a[0] + (b[0] - a[0]) * t), y = Math.round(a[1] + (b[1] - a[1]) * t);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        tot++;
        if (d[y * w + x]) hit++;
      }
      per.push(tot ? hit / tot : 0);
    }
    return per;
  }

  /**
   * Find photo-shaped quadrilaterals in an RGBA Mat.
   * opts.multi: return several non-overlapping photos (album pages).
   * Returns [{ pts, score, support, area }] in source pixel coordinates.
   */
  function detectQuads(src, opts) {
    opts = opts || {};
    const multi = !!opts.multi;
    const work = opts.workSize || 512;
    const s = scope();
    try {
      const { mat: small, scale } = resizeMax(src, work);
      s(small);
      const W = small.cols, H = small.rows, imgArea = W * H;
      const gray = s(toGray(small));
      const blur = s(new cv.Mat());
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

      const rgb = s(new cv.Mat());
      cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
      const hsv = s(new cv.Mat());
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      const hsvCh = s(new cv.MatVector());
      cv.split(hsv, hsvCh);
      const lab = s(new cv.Mat());
      cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
      const labCh = s(new cv.MatVector());
      cv.split(lab, labCh);

      const cannyOf = (ch, lo, hi) => {
        const b = s(new cv.Mat());
        cv.GaussianBlur(ch, b, new cv.Size(5, 5), 0);
        const e = s(new cv.Mat());
        cv.Canny(b, e, lo, hi, 3, true);
        return e;
      };
      const eLow = cannyOf(gray, 20, 60);
      const eHigh = cannyOf(gray, 50, 150);
      // Colour edges catch prints whose brightness matches the background.
      const eColor = s(new cv.Mat());
      cv.bitwise_or(cannyOf(s(labCh.get(1)), 12, 36), cannyOf(s(labCh.get(2)), 12, 36), eColor);
      cv.bitwise_or(eColor, cannyOf(s(hsvCh.get(1)), 25, 75), eColor);
      const eAll = s(new cv.Mat());
      cv.bitwise_or(eLow, eColor, eAll);

      // Edge map used to score how well a quad's sides follow real edges.
      const support = s(new cv.Mat());
      const k5 = s(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
      cv.dilate(eAll, support, k5);

      const k3 = s(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
      const minArea = (opts.minArea !== undefined ? opts.minArea : (multi ? 0.012 : 0.05)) * imgArea;
      const raw = [];

      for (const edges of [eAll, eLow, eHigh, eColor]) {
        const closed = s(new cv.Mat());
        cv.dilate(edges, closed, k3);
        const contours = s(new cv.MatVector());
        const hier = s(new cv.Mat());
        cv.findContours(closed, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
        for (let i = 0; i < contours.size(); i++) {
          const c = contours.get(i);
          const r = cv.boundingRect(c);
          if (r.width * r.height < minArea) { c.delete(); continue; }
          const hull = new cv.Mat();
          cv.convexHull(c, hull, false, true);
          const hullArea = cv.contourArea(hull);
          const hullPts = [];
          for (let j = 0; j < hull.rows; j++) hullPts.push([hull.data32S[j * 2], hull.data32S[j * 2 + 1]]);
          hull.delete();
          c.delete();
          if (hullArea < minArea) continue;
          const q = polygonToQuad(hullPts);
          if (!q) continue;
          raw.push({ q: orderQuad(q), hullArea });
        }
      }

      const margin = 2;
      const cands = [];
      const dbg = opts.debug ? (why, q, extra) => opts.debug.push({ why, q: q.map((p) => [p[0] / scale, p[1] / scale]), extra }) : () => {};
      for (const { q, hullArea } of raw) {
        if (!isConvexQuad(q)) { dbg('concave', q); continue; }
        const area = polyArea(q);
        if (area < minArea) { dbg('small', q); continue; }
        const fill = hullArea / area;
        if (fill < 0.8 || fill > 1.2) { dbg('fill', q, fill); continue; }
        const angles = quadAngles(q);
        if (angles.some((a) => a < 45 || a > 135)) { dbg('angles', q, angles); continue; }
        if (q.some((p) => p[0] < -W * 0.05 || p[1] < -H * 0.05 || p[0] > W * 1.05 || p[1] > H * 1.05)) { dbg('outside', q); continue; }
        const onBorder = q.filter((p) => p[0] <= margin || p[1] <= margin || p[0] >= W - 1 - margin || p[1] >= H - 1 - margin).length;
        if (onBorder >= 3) { dbg('border', q); continue; }
        const sup = edgeSupport(support, q);
        const avgSup = sup.reduce((a, b) => a + b, 0) / 4;
        const minSup = Math.min(...sup);
        const supScore = 0.5 * avgSup + 0.5 * minSup;
        const angScore = Math.min(...angles.map((a) => Math.sin(a * Math.PI / 180)));
        const areaFrac = area / imgArea;
        const score = supScore * supScore * (0.45 + 0.55 * Math.sqrt(areaFrac)) * angScore;
        dbg('cand', q, { score, sup, areaFrac });
        cands.push({ q, score, support: supScore, area: areaFrac });
      }
      cands.sort((a, b) => b.score - a.score);

      // Drop near-duplicates produced by the different edge maps.
      const diag = Math.hypot(W, H);
      const uniq = [];
      for (const c of cands) {
        if (uniq.some((u) => c.q.every((p, i) => dist(p, u.q[i]) < diag * 0.025))) continue;
        uniq.push(c);
      }

      let chosen;
      if (!multi) {
        const minSupport = opts.minSupport !== undefined ? opts.minSupport : 0.45;
        chosen = uniq.filter((c) => c.support >= minSupport).slice(0, 1);
      } else {
        const good = uniq.filter((c) => c.support >= 0.55);
        const best = good.length ? good[0].score : 0;
        let kept = [];
        for (const c of good) {
          if (c.score < best * 0.3) continue;
          if (kept.some((k) => quadIoU(k.q, c.q) > 0.2 && !containsQuad(k.q, c.q) && !containsQuad(c.q, k.q))) continue;
          kept.push(c);
        }
        // Resolve containment: album pages and white print borders.
        let changed = true;
        while (changed) {
          changed = false;
          for (const outer of kept) {
            const inner = kept.filter((k) => k !== outer && containsQuad(outer.q, k.q));
            if (inner.length === 0) continue;
            if (inner.length === 1 && inner[0].area >= outer.area * 0.6) {
              // A print with a white border: keep the whole print.
              kept = kept.filter((k) => k !== inner[0]);
            } else {
              // A page holding photos: keep the photos.
              kept = kept.filter((k) => k !== outer);
            }
            changed = true;
            break;
          }
        }
        chosen = kept.slice(0, opts.maxCount || 12);
        // Stable reading order: rows top to bottom, then left to right.
        chosen.sort((a, b) => {
          const ca = centroid(a.q), cb = centroid(b.q);
          if (Math.abs(ca[1] - cb[1]) > H * 0.12) return ca[1] - cb[1];
          return ca[0] - cb[0];
        });
      }

      return chosen.map((c) => ({
        pts: c.q.map((p) => [p[0] / scale, p[1] / scale]),
        score: c.score,
        support: c.support,
        area: c.area,
      }));
    } finally {
      s.free();
    }
  }

  function containsQuad(outer, inner) {
    return inner.every((p) => pointInQuad(p, outer)) && polyArea(inner) < polyArea(outer) * 0.97;
  }

  /**
   * Snap each side of a coarse quad onto the strongest nearby edge at a
   * higher resolution, then re-intersect the sides. Sub-pixel accurate
   * corners make the final crop noticeably cleaner.
   */
  function refineQuad(src, quad, opts) {
    opts = opts || {};
    const s = scope();
    try {
      const { mat: work, scale } = resizeMax(src, opts.workSize || 1600);
      s(work);
      const gray = s(toGray(work));
      cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
      const dx = s(new cv.Mat()), dy = s(new cv.Mat());
      cv.Sobel(gray, dx, cv.CV_32F, 1, 0, 3);
      cv.Sobel(gray, dy, cv.CV_32F, 0, 1, 3);
      const W = gray.cols, H = gray.rows, gx = dx.data32F, gy = dy.data32F;
      const q = quad.map((p) => [p[0] * scale, p[1] * scale]);
      const r = Math.max(4, Math.round(Math.max(W, H) * 0.012));
      const lines = [];
      for (let k = 0; k < 4; k++) {
        const a = q[k], b = q[(k + 1) % 4];
        const len = dist(a, b);
        const d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        const n = [-d[1], d[0]];
        const pts = [];
        const vals = [];
        const N = 40;
        for (let i = 0; i < N; i++) {
          const t = 0.08 + 0.84 * (i + 0.5) / N;
          const base = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          let bestV = 0, bestO = 0;
          for (let o = -r; o <= r; o++) {
            const x = Math.round(base[0] + n[0] * o), y = Math.round(base[1] + n[1] * o);
            if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
            const v = Math.abs(gx[y * W + x] * n[0] + gy[y * W + x] * n[1]);
            if (v > bestV) { bestV = v; bestO = o; }
          }
          if (bestV > 0) { pts.push([base[0] + n[0] * bestO, base[1] + n[1] * bestO]); vals.push(bestV); }
        }
        // Ignore weak responses (occluded or low-contrast stretches).
        const sortedVals = vals.slice().sort((x, y) => x - y);
        const med = sortedVals.length ? sortedVals[Math.floor(sortedVals.length / 2)] : 0;
        const good = pts.filter((_, i) => vals[i] >= Math.max(40, med * 0.5));
        if (good.length < 8) { lines.push({ p: a, d }); continue; }
        const m = s(cv.matFromArray(good.length, 1, cv.CV_32FC2, good.flat()));
        const line = s(new cv.Mat());
        cv.fitLine(m, line, cv.DIST_HUBER, 0, 0.01, 0.01);
        const L = line.data32F;
        lines.push({ p: [L[2], L[3]], d: [L[0], L[1]] });
      }
      const out = [];
      for (let k = 0; k < 4; k++) {
        const l1 = lines[(k + 3) % 4], l2 = lines[k];
        const pt = intersectLines(l1.p, l1.d, l2.p, l2.d);
        if (!pt || dist(pt, q[k]) > r * 2.5) out.push(q[k]); else out.push(pt);
      }
      if (!isConvexQuad(out)) return quad.map((p) => p.slice());
      return out.map((p) => [p[0] / scale, p[1] / scale]);
    } finally {
      s.free();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Features, tracking and alignment                                    */
  /* ------------------------------------------------------------------ */

  function orbFeatures(gray, n) {
    const orb = new cv.ORB(n, 1.2, 8, 31, 0, 2, cv.ORB_HARRIS_SCORE, 31, 12);
    const kp = new cv.KeyPointVector();
    const desc = new cv.Mat();
    const noMask = new cv.Mat();
    orb.detectAndCompute(gray, noMask, kp, desc);
    noMask.delete();
    orb.delete();
    const pts = new Float32Array(kp.size() * 2);
    for (let i = 0; i < kp.size(); i++) {
      const p = kp.get(i).pt;
      pts[i * 2] = p.x; pts[i * 2 + 1] = p.y;
    }
    kp.delete();
    return { pts, desc, delete() { if (!desc.isDeleted()) desc.delete(); } };
  }

  function matchPairs(fa, fb, ratio) {
    const a = [], b = [];
    if (fa.desc.rows < 8 || fb.desc.rows < 8) return { a, b };
    const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
    const mv = new cv.DMatchVectorVector();
    bf.knnMatch(fa.desc, fb.desc, mv, 2);
    for (let i = 0; i < mv.size(); i++) {
      const m = mv.get(i);
      if (m.size() >= 2) {
        const m0 = m.get(0), m1 = m.get(1);
        if (m0.distance < ratio * m1.distance) {
          a.push(fa.pts[m0.queryIdx * 2], fa.pts[m0.queryIdx * 2 + 1]);
          b.push(fb.pts[m0.trainIdx * 2], fb.pts[m0.trainIdx * 2 + 1]);
        }
      }
      m.delete();
    }
    mv.delete();
    bf.delete();
    return { a, b };
  }

  function homographyFromPairs(a, b, thresh) {
    const n = a.length / 2;
    if (n < 10) return null;
    const A = cv.matFromArray(n, 1, cv.CV_32FC2, a);
    const B = cv.matFromArray(n, 1, cv.CV_32FC2, b);
    const mask = new cv.Mat();
    let Hm = null;
    try {
      Hm = cv.findHomography(A, B, cv.RANSAC, thresh, mask, 2000, 0.995);
      if (!Hm || Hm.empty()) return null;
      let inl = 0;
      for (let i = 0; i < mask.rows; i++) if (mask.data[i]) inl++;
      return { H: Array.from(Hm.data64F), inliers: inl, total: n };
    } finally {
      A.delete(); B.delete(); mask.delete();
      if (Hm) Hm.delete();
    }
  }

  // A homography is plausible if it keeps the frame convex and roughly sized.
  function homographySane(H, w, h) {
    const corners = [[0, 0], [w, 0], [w, h], [0, h]].map((p) => applyH(H, p));
    if (corners.some((p) => !isFinite(p[0]) || !isFinite(p[1]))) return false;
    if (!isConvexQuad(corners)) return false;
    const ratio = polyArea(corners) / (w * h);
    return ratio > 0.15 && ratio < 6;
  }

  /** Tracker for the guided glare-removal capture. Works on small frames. */
  function createTracker(refGray) {
    const f = orbFeatures(refGray, 900);
    return { f, w: refGray.cols, h: refGray.rows, delete() { f.delete(); } };
  }

  /** Returns { H: ref->current (3x3 array), inliers } or null. */
  function trackFrame(tracker, gray) {
    const f = orbFeatures(gray, 700);
    try {
      const { a, b } = matchPairs(tracker.f, f, 0.8);
      const r = homographyFromPairs(a, b, 4);
      if (!r || r.inliers < 18 || !homographySane(r.H, tracker.w, tracker.h)) return null;
      return r;
    } finally {
      f.delete();
    }
  }

  function sharpness(gray) {
    const lap = new cv.Mat();
    cv.Laplacian(gray, lap, cv.CV_32F, 3);
    const mean = new cv.Mat(), sd = new cv.Mat();
    cv.meanStdDev(lap, mean, sd);
    const v = sd.data64F[0] * sd.data64F[0];
    lap.delete(); mean.delete(); sd.delete();
    return v;
  }

  /**
   * Polish a frame->reference homography with pyramidal Lucas-Kanade flow.
   * The frame is first warped with the coarse estimate so that only small
   * residual motion remains, which LK measures to sub-pixel accuracy.
   */
  function refineHomography(frameGray, refGray, H, refPts) {
    const s = scope();
    try {
      const M = s(matFromH(H));
      const warped = s(new cv.Mat());
      cv.warpPerspective(frameGray, warped, M, new cv.Size(refGray.cols, refGray.rows), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0));
      const n = refPts.length / 2;
      if (n < 20) return H;
      const p0 = s(cv.matFromArray(n, 1, cv.CV_32FC2, Array.from(refPts)));
      const p1 = s(new cv.Mat());
      const status = s(new cv.Mat()), err = s(new cv.Mat());
      const crit = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 30, 0.01);
      cv.calcOpticalFlowPyrLK(refGray, warped, p0, p1, status, err, new cv.Size(21, 21), 3, crit);
      const Hinv = inv3(H);
      if (!Hinv) return H;
      const a = [], b = [];
      const P1 = p1.data32F, st = status.data;
      const W = refGray.cols, Hh = refGray.rows;
      for (let i = 0; i < n; i++) {
        if (!st[i]) continue;
        const x = P1[i * 2], y = P1[i * 2 + 1];
        if (x < 2 || y < 2 || x > W - 3 || y > Hh - 3) continue;
        const dx = x - refPts[i * 2], dy = y - refPts[i * 2 + 1];
        if (dx * dx + dy * dy > 64) continue;
        // (x, y) in the warped frame corresponds to Hinv(x, y) in the frame.
        const f = applyH(Hinv, [x, y]);
        a.push(f[0], f[1]);
        b.push(refPts[i * 2], refPts[i * 2 + 1]);
      }
      const r = homographyFromPairs(a, b, 1.0);
      if (!r || r.inliers < 30 || r.inliers < a.length / 2 * 0.3) return H;
      return r.H;
    } catch (e) {
      return H;
    } finally {
      s.free();
    }
  }

  /**
   * Estimate homographies mapping every frame onto the reference frame.
   * frames: RGBA Mats. Returns { Hs: [H|null], info: [...] }.
   */
  function alignFrames(frames, refIdx, opts) {
    opts = opts || {};
    const work = opts.workSize || 1100;
    const fine = opts.refineSize || 1600;
    const feats = [];
    const scales = [];
    const sharp = [];
    const s = scope();
    try {
      for (const fr of frames) {
        const { mat: small, scale } = resizeMax(fr, work);
        s(small);
        const g = s(toGray(small));
        feats.push(orbFeatures(g, opts.features || 3000));
        sharp.push(sharpness(g));
        scales.push(scale);
      }
      // Reference at refinement resolution, with trackable points on it.
      const { mat: refFineRGBA, scale: refFineScale } = resizeMax(frames[refIdx], fine);
      s(refFineRGBA);
      const refFine = s(toGray(refFineRGBA));
      const k = refFineScale / scales[refIdx];
      const refPts = feats[refIdx].pts.map((v) => v * k);

      const Hs = [];
      const info = [];
      for (let i = 0; i < frames.length; i++) {
        if (i === refIdx) { Hs.push([1, 0, 0, 0, 1, 0, 0, 0, 1]); info.push({ inliers: Infinity }); continue; }
        const { a, b } = matchPairs(feats[i], feats[refIdx], 0.75);
        const r = homographyFromPairs(a, b, 2.5);
        const ok = r && r.inliers >= 25 && r.inliers / r.total > 0.12 &&
          homographySane(r.H, frames[i].cols * scales[i], frames[i].rows * scales[i]);
        if (!ok) { Hs.push(null); info.push({ inliers: r ? r.inliers : 0, rejected: true }); continue; }
        // Lift to the refinement resolution and polish with optical flow.
        const { mat: frFineRGBA, scale: frFineScale } = resizeMax(frames[i], fine);
        const frFine = toGray(frFineRGBA);
        frFineRGBA.delete();
        let Hf = mul3(mul3(scaleMat(refFineScale / scales[refIdx]), r.H), scaleMat(scales[i] / frFineScale));
        if (opts.refine !== false) Hf = refineHomography(frFine, refFine, Hf, refPts);
        frFine.delete();
        // Lift to full resolution.
        const Hfull = mul3(mul3(scaleMat(1 / refFineScale), Hf), scaleMat(frFineScale));
        Hs.push(Hfull);
        info.push({ inliers: r.inliers, total: r.total });
      }
      const refSharp = sharp[refIdx] || 1;
      info.forEach((inf, i) => { inf.sharpness = sharp[i] / refSharp; });
      return { Hs, info };
    } finally {
      for (const f of feats) f.delete();
      s.free();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Glare-free merge                                                    */
  /* ------------------------------------------------------------------ */

  // Median of the first n values; sorts the typed array in place (numeric sort).
  function median(arr, n) {
    if (!n) return NaN;
    const a = arr.subarray(0, n).sort();
    return a[n >> 1];
  }

  /**
   * Blend several aligned shots so that glare (which moves between shots)
   * is replaced by the same area from a shot where it is not present.
   *
   * frames: RGBA Mats, Hs: frame->reference homographies (null to skip),
   * roi: {x, y, w, h} window of the reference frame to produce.
   * opts.consume: delete each input frame once it has been warped, which
   * keeps peak memory low on phones.
   * Returns an RGBA Mat of roi size.
   */
  function mergeFrames(frames, Hs, refIdx, roi, opts) {
    opts = opts || {};
    const progress = opts.onProgress || (() => {});
    const W = roi.w, H = roi.h, N = W * H;
    const T = translateMat(-roi.x, -roi.y);
    const used = [];
    for (let i = 0; i < frames.length; i++) if (Hs[i]) used.push(i);
    used.sort((a, b) => (a === refIdx ? -1 : b === refIdx ? 1 : a - b));
    const size = new cv.Size(W, H);
    const black = new cv.Scalar(0, 0, 0, 0);

    const warp = (i) => {
      const M = matFromH(mul3(T, Hs[i]));
      const out = new cv.Mat();
      cv.warpPerspective(frames[i], out, M, size, cv.INTER_LINEAR, cv.BORDER_CONSTANT, black);
      M.delete();
      if (opts.consume && !frames[i].isDeleted()) frames[i].delete();
      return out;
    };

    if (used.length <= 1) {
      const out = warp(refIdx);
      forceOpaque(out);
      return out;
    }

    const sigma = opts.sigma || 8;
    const otherPrior = opts.otherWeight !== undefined ? opts.otherWeight : 0.12;
    const lums = [];
    const gains = [];
    const warped = [];

    // Pass 1: warp every shot once, measure brightness, match exposure to the reference.
    used.forEach((i, idx) => {
      progress('align', idx / used.length * 0.5);
      const wm = warp(i);
      warped.push(wm);
      // Views are taken after the allocation above; heap growth detaches them.
      const d = wm.data;
      const rd = warped[0].data;
      const lum = new Uint8Array(N);
      let g = [1, 1, 1];
      if (i !== refIdx) {
        // Robust per-channel gain from pixels that look similar in both shots.
        const step = Math.max(3, Math.floor(N / 60000));
        const cap = Math.ceil(N / step);
        const rr = new Float32Array(cap), rg = new Float32Array(cap), rb = new Float32Array(cap);
        let m = 0;
        for (let p = 0; p < N; p += step) {
          const o = p * 4;
          if (d[o + 3] < 250 || rd[o + 3] < 250) continue;
          const r0 = rd[o], g0 = rd[o + 1], b0 = rd[o + 2];
          const r1 = d[o], g1 = d[o + 1], b1 = d[o + 2];
          const l0 = r0 + g0 + g0 + b0, l1 = r1 + g1 + g1 + b1;
          if (l0 < 120 || l1 < 120 || l0 > 900 || l1 > 900) continue;
          if (r1 < 8 || g1 < 8 || b1 < 8) continue;
          rr[m] = r0 / r1; rg[m] = g0 / g1; rb[m] = b0 / b1; m++;
        }
        if (m > 200) {
          g = [median(rr, m), median(rg, m), median(rb, m)].map((v) => Math.min(1.5, Math.max(0.67, v)));
        }
      }
      gains.push(g);
      const kr = 0.299 * g[0], kg = 0.587 * g[1], kb = 0.114 * g[2];
      for (let p = 0, o = 0; p < N; p++, o += 4) {
        if (d[o + 3] < 250) { lum[p] = 0; continue; }
        const l = kr * d[o] + kg * d[o + 1] + kb * d[o + 2];
        lum[p] = l < 1 ? 1 : l > 255 ? 255 : l;
      }
      lums.push(lum);
    });

    // Per-pixel reference brightness: second darkest valid shot. Glare only
    // ever adds light, so the darker readings are the trustworthy ones.
    const Lr = new Uint8Array(N);
    const n = used.length;
    for (let p = 0; p < N; p++) {
      let m1 = 256, m2 = 256, c = 0;
      for (let k = 0; k < n; k++) {
        const v = lums[k][p];
        if (!v) continue;
        c++;
        if (v < m1) { m2 = m1; m1 = v; } else if (v < m2) m2 = v;
      }
      Lr[p] = c === 0 ? 0 : c >= 3 ? m2 : m1;
    }

    // Weight lookup by brightness difference to the reference level.
    const wLut = new Float32Array(511);
    for (let dd = -255; dd <= 255; dd++) {
      wLut[dd + 255] = dd > 0 ? Math.exp(-dd / sigma) : Math.exp(dd / (3 * sigma));
    }

    const accR = new Float32Array(N), accG = new Float32Array(N), accB = new Float32Array(N), accW = new Float32Array(N);
    const blurSigma = Math.max(2, Math.max(W, H) / 700);
    const sharpInfo = opts.sharpness || [];

    // Pass 2: weight, smooth the weights, accumulate.
    used.forEach((i, idx) => {
      progress('merge', 0.5 + idx / used.length * 0.5);
      const lum = lums[idx];
      let prior = i === refIdx ? 1 : otherPrior;
      if (i !== refIdx && sharpInfo[i]) prior *= Math.min(1, Math.max(0.25, sharpInfo[i]));
      const wm = new cv.Mat(H, W, cv.CV_32F);
      const w = wm.data32F;
      for (let p = 0; p < N; p++) {
        const v = lum[p];
        w[p] = v ? prior * wLut[v - Lr[p] + 255] : 0;
      }
      cv.GaussianBlur(wm, wm, new cv.Size(0, 0), blurSigma);
      const wb = wm.data32F;
      const d = warped[idx].data;
      const g = gains[idx];
      for (let p = 0, o = 0; p < N; p++, o += 4) {
        if (!lum[p]) continue;
        const ww = wb[p] + 1e-6;
        accR[p] += ww * d[o] * g[0];
        accG[p] += ww * d[o + 1] * g[1];
        accB[p] += ww * d[o + 2] * g[2];
        accW[p] += ww;
      }
      wm.delete();
      warped[idx].delete();
      lums[idx] = null;
    });

    const out = new cv.Mat(H, W, cv.CV_8UC4);
    const od = clampedView(out);
    for (let p = 0, o = 0; p < N; p++, o += 4) {
      const ww = accW[p];
      if (ww > 0) {
        od[o] = accR[p] / ww; od[o + 1] = accG[p] / ww; od[o + 2] = accB[p] / ww;
      } else {
        od[o] = od[o + 1] = od[o + 2] = 0;
      }
      od[o + 3] = 255;
    }
    progress('merge', 1);
    return out;
  }

  // Mat.data is a plain Uint8Array: out-of-range writes wrap around instead
  // of saturating. Write through a clamped view whenever values can overflow.
  function clampedView(m) {
    const d = m.data;
    return new Uint8ClampedArray(d.buffer, d.byteOffset, d.length);
  }

  function forceOpaque(m) {
    const d = m.data;
    for (let o = 3; o < d.length; o += 4) d[o] = 255;
  }

  /* ------------------------------------------------------------------ */
  /* Rectification                                                       */
  /* ------------------------------------------------------------------ */

  const PRINT_RATIOS = [1, 1.2, 1.25, 4 / 3, 1.4, 10 / 7, 1.5, 1.593, 5 / 3, 16 / 9];

  /**
   * Real-world aspect ratio (width / height) of a rectangle seen in
   * perspective, after Zhang & He, "Whiteboard scanning and image
   * enhancement". pp = principal point, fGuess = focal length in pixels.
   */
  function rectangleAspect(quad, pp, fGuess) {
    const [tl, tr, br, bl] = quad;
    const edgeW = (dist(tl, tr) + dist(bl, br)) / 2;
    const edgeH = (dist(tl, bl) + dist(tr, br)) / 2;
    const naive = edgeW / edgeH;
    if (!pp) return naive;
    const h = (p) => [p[0], p[1], 1];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const m1 = h(tl), m2 = h(tr), m3 = h(bl), m4 = h(br);
    const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
    const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
    if (!isFinite(k2) || !isFinite(k3)) return naive;
    const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
    const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
    const [u0, v0] = pp;
    let f = fGuess;
    const den = n2[2] * n3[2];
    if (Math.abs(den) > 1e-6) {
      const f2 = -((n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + n2[2] * n3[2] * u0 * u0) +
                   (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0)) / den;
      const fe = Math.sqrt(Math.max(0, f2));
      if (f2 > 0 && fe > fGuess * 0.45 && fe < fGuess * 2.5) f = fe;
    }
    // x^T (A^-T A^-1) x with A = [[f,0,u0],[0,f,v0],[0,0,1]]
    const q = (n) => {
      const a = (n[0] - u0 * n[2]) / f, b = (n[1] - v0 * n[2]) / f;
      return a * a + b * b + n[2] * n[2];
    };
    const r = Math.sqrt(q(n2) / q(n3));
    if (!isFinite(r) || r <= 0) return naive;
    // Trust the projective estimate only when it agrees roughly with the edges.
    if (r / naive > 1.6 || naive / r > 1.6) return naive;
    return r;
  }

  function snapRatio(r) {
    const land = r >= 1;
    const x = land ? r : 1 / r;
    let best = null, bestErr = 0.025;
    for (const p of PRINT_RATIOS) {
      const e = Math.abs(x - p) / p;
      if (e < bestErr) { bestErr = e; best = p; }
    }
    if (!best) return r;
    return land ? best : 1 / best;
  }

  function outputSize(quad, opts) {
    opts = opts || {};
    const [tl, tr, br, bl] = quad;
    const edgeW = Math.max(dist(tl, tr), dist(bl, br));
    const edgeH = Math.max(dist(tl, bl), dist(tr, br));
    let ratio = rectangleAspect(quad, opts.pp, opts.focal || 1000);
    if (opts.snap !== false) ratio = snapRatio(ratio);
    let long = Math.max(edgeW, edgeH) * (opts.upscale || 1);
    long = Math.min(long, opts.maxSide || 3200);
    let w, h;
    if (ratio >= 1) { w = long; h = long / ratio; } else { h = long; w = long * ratio; }
    // Stay under the ~16.7 megapixel canvas limit of iOS Safari.
    const maxArea = opts.maxArea || 16e6;
    if (w * h > maxArea) { const k = Math.sqrt(maxArea / (w * h)); w *= k; h *= k; }
    return { width: Math.max(16, Math.round(w)), height: Math.max(16, Math.round(h)), ratio };
  }

  function rectify(src, quad, opts) {
    const { width, height } = outputSize(quad, opts);
    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flat());
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]);
    const M = cv.getPerspectiveTransform(srcPts, dstPts);
    const out = new cv.Mat();
    cv.warpPerspective(src, out, M, new cv.Size(width, height), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
    srcPts.delete(); dstPts.delete(); M.delete();
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Restoration and adjustments                                         */
  /* ------------------------------------------------------------------ */

  function histograms(rgba, step) {
    const d = rgba.data;
    const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256), hl = new Uint32Array(256);
    let n = 0;
    const stride = 4 * (step || 1);
    for (let o = 0; o < d.length; o += stride) {
      const r = d[o], g = d[o + 1], b = d[o + 2];
      hr[r]++; hg[g]++; hb[b]++;
      hl[(77 * r + 150 * g + 29 * b) >> 8]++;
      n++;
    }
    return { r: hr, g: hg, b: hb, l: hl, n };
  }

  function pct(hist, n, p) {
    const target = n * p;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= target) return i;
    }
    return 255;
  }

  function levelsLut(lo, hi, gamma) {
    const lut = new Float32Array(256);
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < 256; i++) {
      const x = Math.min(1, Math.max(0, (i - lo) / span));
      lut[i] = Math.pow(x, gamma) * 255;
    }
    return lut;
  }

  function composeLut(a, fn) {
    const out = new Float32Array(256);
    for (let i = 0; i < 256; i++) out[i] = fn(a[i] / 255) * 255;
    return out;
  }

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  /** Colour correction curves chosen from image statistics. */
  function presetCurves(rgba, preset) {
    const id = new Float32Array(256).map((_, i) => i);
    if (!preset || preset === 'none') return { r: id, g: id, b: id, clahe: 0, sat: 0, gray: false };
    const H = histograms(rgba, 3);
    if (preset === 'bw') {
      const lo = pct(H.l, H.n, 0.005), hi = pct(H.l, H.n, 0.995);
      const lut = levelsLut(Math.min(lo, 60), Math.max(hi, 180), 1);
      return { r: lut, g: lut, b: lut, clahe: 2.0, claheStrength: 0.8, sat: 0, gray: true };
    }
    if (preset === 'restore') {
      // Full per-channel stretch removes the colour cast of faded prints,
      // then per-channel gamma balances the mid-tones.
      const ch = ['r', 'g', 'b'].map((c) => {
        const lo = Math.min(pct(H[c], H.n, 0.008), 90);
        const hi = Math.max(pct(H[c], H.n, 0.992), 150);
        return { lo, hi };
      });
      const mids = ch.map((c, i) => {
        const hist = H['rgb'[i]];
        const m = pct(hist, H.n, 0.5);
        return clamp01((m - c.lo) / Math.max(1, c.hi - c.lo));
      });
      const target = Math.min(0.55, Math.max(0.35, (mids[0] + mids[1] + mids[2]) / 3));
      const luts = ch.map((c, i) => {
        const m = Math.min(0.95, Math.max(0.05, mids[i]));
        const full = Math.log(target) / Math.log(m);
        // Balance mid-tones most of the way: a faded print's cast is removed
        // while photos that are naturally warm or cool keep some character.
        const gamma = Math.min(1.5, Math.max(0.67, Math.pow(full, 0.7)));
        return levelsLut(c.lo, c.hi, gamma);
      });
      return { r: luts[0], g: luts[1], b: luts[2], clahe: 1.6, claheStrength: 0.55, sat: 0.2, gray: false };
    }
    // 'auto': gentle. Stretches the tonal range, removes part of any colour
    // cast, and leaves an already well-exposed photo almost untouched.
    const loL = pct(H.l, H.n, 0.003), hiL = pct(H.l, H.n, 0.997);
    const ch = ['r', 'g', 'b'].map((c) => {
      let lo = 0.4 * loL + 0.6 * pct(H[c], H.n, 0.003);
      let hi = 0.4 * hiL + 0.6 * pct(H[c], H.n, 0.997);
      // Never stretch more than 2.2x; keep the centre of the range.
      const span = hi - lo, minSpan = 255 / 2.2;
      if (span < minSpan) { const mid = (lo + hi) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
      return { lo, hi };
    });
    // Mid-tone correction only when the photo is clearly too dark or light.
    const medL = pct(H.l, H.n, 0.5);
    const avgLo = (ch[0].lo + ch[1].lo + ch[2].lo) / 3, avgHi = (ch[0].hi + ch[1].hi + ch[2].hi) / 3;
    const m = Math.min(0.95, Math.max(0.05, (medL - avgLo) / Math.max(1, avgHi - avgLo)));
    let gamma = 1;
    if (m < 0.28) gamma = Math.max(0.8, Math.log(0.32) / Math.log(m));
    else if (m > 0.72) gamma = Math.min(1.25, Math.log(0.68) / Math.log(m));
    const L = ch.map((c) => levelsLut(c.lo, c.hi, gamma));
    return { r: L[0], g: L[1], b: L[2], clahe: 1.2, claheStrength: 0.35, sat: 0.06, gray: false };
  }

  function toneFn(params) {
    const b = (params.brightness || 0) / 100;
    const c = (params.contrast || 0) / 100;
    const sh = (params.shadows || 0) / 100;
    const hl = (params.highlights || 0) / 100;
    const bGamma = Math.pow(2, -b * 0.9);
    const cK = c >= 0 ? 1 + c * 0.9 : 1 + c * 0.6;
    return (x) => {
      x = Math.pow(clamp01(x), bGamma);
      x = x + sh * 1.5 * x * (1 - x) * (1 - x);
      x = x + hl * 1.5 * x * x * (1 - x);
      x = (x - 0.5) * cK + 0.5;
      return clamp01(x);
    };
  }

  function applyClahe(rgba, clip, strength) {
    const s = scope();
    try {
      const rgb = s(new cv.Mat());
      cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
      const lab = s(new cv.Mat());
      cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
      const ch = s(new cv.MatVector());
      cv.split(lab, ch);
      const L = s(ch.get(0));
      const tiles = Math.max(4, Math.min(12, Math.round(Math.max(rgba.cols, rgba.rows) / 300)));
      const clahe = s(new cv.CLAHE(clip, new cv.Size(tiles, tiles)));
      const L2 = s(new cv.Mat());
      clahe.apply(L, L2);
      if (strength < 1) cv.addWeighted(L2, strength, L, 1 - strength, 0, L2);
      ch.set(0, L2);
      cv.merge(ch, lab);
      cv.cvtColor(lab, rgb, cv.COLOR_Lab2RGB);
      cv.cvtColor(rgb, rgba, cv.COLOR_RGB2RGBA);
    } finally {
      s.free();
    }
  }

  function unsharp(rgba, amount, sigma) {
    const blur = new cv.Mat();
    cv.GaussianBlur(rgba, blur, new cv.Size(0, 0), sigma);
    cv.addWeighted(rgba, 1 + amount, blur, -amount, 0, rgba);
    blur.delete();
  }

  /** Remove small dust specks and fine scratches with inpainting. */
  function removeDust(rgba, strength) {
    if (!strength) return;
    const s = scope();
    try {
      const W = rgba.cols, H = rgba.rows;
      let k = Math.max(5, Math.round(Math.max(W, H) / 320));
      if (k % 2 === 0) k++;
      const gray = s(toGray(rgba));
      const kernel = s(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)));
      const top = s(new cv.Mat()), blackhat = s(new cv.Mat());
      cv.morphologyEx(gray, top, cv.MORPH_TOPHAT, kernel);
      cv.morphologyEx(gray, blackhat, cv.MORPH_BLACKHAT, kernel);
      const thr = 62 - strength * 0.42;
      const m1 = s(new cv.Mat()), m2 = s(new cv.Mat()), mask = s(new cv.Mat());
      cv.threshold(top, m1, thr, 255, cv.THRESH_BINARY);
      cv.threshold(blackhat, m2, thr * 1.25, 255, cv.THRESH_BINARY);
      cv.bitwise_or(m1, m2, mask);
      // Keep only small blobs and thin scratches, never real detail.
      const labels = s(new cv.Mat()), stats = s(new cv.Mat()), cents = s(new cv.Mat());
      const nLab = cv.connectedComponentsWithStats(mask, labels, stats, cents, 8, cv.CV_32S);
      const keep = new Uint8Array(nLab);
      const st = stats.data32S;
      const maxBlob = k * k * 0.7;
      for (let i = 1; i < nLab; i++) {
        const bw = st[i * 5 + 2], bh = st[i * 5 + 3], area = st[i * 5 + 4];
        const thin = Math.min(bw, bh) <= k * 0.6 && area / (bw * bh) < 0.35;
        keep[i] = (area <= maxBlob || thin) && Math.max(bw, bh) < Math.max(W, H) * 0.25 ? 1 : 0;
      }
      const lab = labels.data32S, md = mask.data;
      let any = false;
      for (let p = 0; p < md.length; p++) {
        const v = keep[lab[p]] ? 255 : 0;
        md[p] = v;
        if (v) any = true;
      }
      if (!any) return;
      const k3 = s(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3)));
      cv.dilate(mask, mask, k3);
      const rgb = s(new cv.Mat()), fixed = s(new cv.Mat());
      cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
      cv.inpaint(rgb, mask, fixed, 3, cv.INPAINT_TELEA);
      cv.cvtColor(fixed, rgba, cv.COLOR_RGB2RGBA);
    } finally {
      s.free();
    }
  }

  /**
   * Render the final image from a rectified RGBA Mat and edit parameters.
   * Returns a new RGBA Mat. `detailScale` scales pixel-size dependent
   * filters so small previews look like the full export.
   */
  function render(rect, params, opts) {
    params = params || {};
    opts = opts || {};
    const out = new cv.Mat();
    rect.copyTo(out);
    const fullLong = opts.fullLong || Math.max(rect.cols, rect.rows);
    const k = Math.max(rect.cols, rect.rows) / fullLong;

    if (params.dust) removeDust(out, params.dust);

    const curves = presetCurves(out, params.preset);
    const tone = toneFn(params);
    const warm = (params.warmth || 0) / 100;
    const lr = composeLut(curves.r, (x) => clamp01(tone(x) * (1 + warm * 0.12)));
    const lg = composeLut(curves.g, (x) => clamp01(tone(x) * (1 + warm * 0.03)));
    const lb = composeLut(curves.b, (x) => clamp01(tone(x) * (1 - warm * 0.14)));
    const Lr8 = Uint8ClampedArray.from(lr), Lg8 = Uint8ClampedArray.from(lg), Lb8 = Uint8ClampedArray.from(lb);
    let d = out.data;
    for (let o = 0; o < d.length; o += 4) {
      if (curves.gray) {
        const l = (77 * d[o] + 150 * d[o + 1] + 29 * d[o + 2]) >> 8;
        d[o] = Lr8[l]; d[o + 1] = Lg8[l]; d[o + 2] = Lb8[l];
      } else {
        d[o] = Lr8[d[o]]; d[o + 1] = Lg8[d[o + 1]]; d[o + 2] = Lb8[d[o + 2]];
      }
    }

    if (curves.clahe) applyClahe(out, curves.clahe, curves.claheStrength || 0.5);

    const sat = curves.gray ? -1 : curves.sat + (params.saturation || 0) / 100;
    if (sat !== 0) {
      const f = 1 + sat;
      const d = clampedView(out);
      for (let o = 0; o < d.length; o += 4) {
        const r = d[o], g = d[o + 1], b = d[o + 2];
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        d[o] = l + (r - l) * f; d[o + 1] = l + (g - l) * f; d[o + 2] = l + (b - l) * f;
      }
    }

    const sharpen = (params.sharpness !== undefined ? params.sharpness : 0) / 100;
    if (sharpen > 0) unsharp(out, sharpen * 1.6, Math.max(0.6, 1.1 * k * Math.max(1, fullLong / 2400)));

    const rot = ((params.rotation || 0) % 4 + 4) % 4;
    if (rot) {
      const codes = [null, cv.ROTATE_90_CLOCKWISE, cv.ROTATE_180, cv.ROTATE_90_COUNTERCLOCKWISE];
      cv.rotate(out, out, codes[rot]);
    }
    if (params.flip) cv.flip(out, out, 1);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Orientation from faces                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Guess how many clockwise quarter turns make the photo upright.
   * The face detector is most confident on upright faces, so the image is
   * tried in all four orientations and the clearly most confident one wins.
   * Returns rotation 0 whenever the evidence is weak.
   */
  function detectOrientation(rgba, opts) {
    opts = opts || {};
    if (!faceModelPath || typeof cv.FaceDetectorYN !== 'function') return { rotation: 0, faces: 0 };
    const minScore = opts.minScore || 0.86;
    const margin = opts.margin || 0.035;
    const s = scope();
    try {
      const { mat: small } = resizeMax(rgba, 640);
      s(small);
      const bgr = s(new cv.Mat());
      cv.cvtColor(small, bgr, cv.COLOR_RGBA2BGR);
      const best = [0, 0, 0, 0];
      const counts = [0, 0, 0, 0];
      const codes = [null, cv.ROTATE_90_CLOCKWISE, cv.ROTATE_180, cv.ROTATE_90_COUNTERCLOCKWISE];
      for (let r = 0; r < 4; r++) {
        const img = s(new cv.Mat());
        if (r === 0) bgr.copyTo(img); else cv.rotate(bgr, img, codes[r]);
        const size = img.cols + 'x' + img.rows;
        if (!faceDetector || faceDetectorSize !== size) {
          if (faceDetector) faceDetector.delete();
          faceDetector = new cv.FaceDetectorYN(faceModelPath, '', new cv.Size(img.cols, img.rows), 0.6, 0.3, 50);
          faceDetectorSize = size;
        }
        const res = s(new cv.Mat());
        faceDetector.detect(img, res);
        const scores = [];
        for (let i = 0; i < res.rows; i++) {
          const f = res.data32F.subarray(i * 15, i * 15 + 15);
          // Ignore tiny detections: they are mostly texture false positives.
          if (Math.min(f[2], f[3]) < Math.min(img.cols, img.rows) * 0.04) continue;
          scores.push(f[14]);
        }
        scores.sort((a, b) => b - a);
        // Average of the two strongest faces rewards group photos where
        // several faces agree, while one strong face still counts.
        best[r] = scores.length ? (scores.length > 1 ? (scores[0] + scores[1]) / 2 : scores[0]) : 0;
        counts[r] = scores.filter((v) => v >= minScore).length;
      }
      let top = 0;
      for (let r = 1; r < 4; r++) if (best[r] > best[top]) top = r;
      const second = Math.max(...best.filter((_, r) => r !== top));
      let rotation = 0;
      if (top !== 0 && best[top] >= minScore && best[top] - second >= margin && best[top] - best[0] >= margin) rotation = top;
      return { rotation, faces: counts[top], scores: best };
    } catch (e) {
      return { rotation: 0, faces: 0, error: String(e && e.message || e) };
    } finally {
      s.free();
    }
  }

  const api = {
    init, setFaceModel, scope, copyMat, matFromImage, imageFromMat, resizeMax, toGray,
    orderQuad, polyArea, isConvexQuad, quadAngles, pointInQuad, quadIoU, mul3, inv3, applyH,
    scaleMat, translateMat, detectQuads, refineQuad, createTracker, trackFrame, alignFrames,
    mergeFrames, rectangleAspect, snapRatio, outputSize, rectify, presetCurves, removeDust,
    render, detectOrientation, sharpness, homographySane,
  };

  root.ScanPipeline = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
