// Simulated handheld guided capture: a phone held in portrait above a print,
// tilting toward each glare dot with hand shake, motion blur and exposure
// drift. Produces tracking-size frames plus ground-truth homographies.
import { makePhoto, makeTable, placePhoto, rng } from './helpers.mjs';

function rotX(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; }
function rotY(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; }
function rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; }
function mul(A, B) {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return C;
}

/**
 * Homography plane -> image for a camera at (cx, cy, -h) above the plane
 * (world Z points into the table), rotated by pitch/yaw/roll, focal f.
 */
export function poseH({ cx, cy, h, pitch = 0, yaw = 0, roll = 0 }, f, W, H) {
  const R = mul(rotZ(roll), mul(rotX(pitch), rotY(yaw)));
  const C = [cx, cy, -h];
  const t = [-(R[0] * C[0] + R[1] * C[1] + R[2] * C[2]), -(R[3] * C[0] + R[4] * C[1] + R[5] * C[2]), -(R[6] * C[0] + R[7] * C[1] + R[8] * C[2])];
  const M = [R[0], R[1], t[0], R[3], R[4], t[1], R[6], R[7], t[2]];
  const K = [f, 0, W / 2, 0, f, H / 2, 0, 0, 1];
  const Hm = mul(K, M);
  return Hm.map((v) => v / Hm[8]);
}

/** Camera pose that looks at world point (px, py) from position (x, y, h). */
function lookAt(x, y, h, px, py, roll) {
  // Positive yaw turns the view toward -X, positive pitch toward +Y.
  const yaw = -Math.atan2(px - x, h);
  const pitch = Math.atan2(py - y, Math.hypot(h, px - x));
  return { cx: x, cy: y, h, yaw, pitch, roll };
}

export function buildScene(cv, { photo, seed = 2 } = {}) {
  const table = makeTable(cv, 2600, 2400, seed, [96, 80, 66]);
  const ph = photo || makePhoto(cv, 900, 600, 7);
  const quad = [[850, 900], [1750, 900], [1750, 1500], [850, 1500]];
  const scene = placePhoto(cv, table, ph, quad);
  table.delete();
  if (!photo) ph.delete();
  return { scene, quad, center: [1300, 1200] };
}

/**
 * Yields { gray (small tracking frame), Htrue (ref small -> this small), t }.
 * opts: W,H camera frame; small: {short,long} tracking size; fps; blur.
 */
export function* handheldRun(cv, P, scene, opts = {}) {
  const W = opts.W || 720, Hh = opts.H || 1280, f = opts.f || 800;
  const fps = opts.fps || 10;
  const rand = rng(opts.seed || 11);
  const center = opts.center || [1300, 1200];
  const quad = opts.quad;
  const hgt = opts.height || 1180;
  const spread = opts.spread || 0.62;
  const k = Math.min(1, (opts.smallShort || 270) / Math.min(W, Hh), (opts.smallLong || 1e9) / Math.max(W, Hh));
  const sw = Math.round(W * k), sh = Math.round(Hh * k);
  const S = [k, 0, 0, 0, k, 0, 0, 0, 1];
  const Sinv = [1 / k, 0, 0, 0, 1 / k, 0, 0, 0, 1];
  // Key poses: ref, then each dot (camera moves part-way and tilts toward it).
  const dots = quad.map((q) => [center[0] + (q[0] - center[0]) * spread, center[1] + (q[1] - center[1]) * spread]);
  const move = opts.move !== undefined ? opts.move : 0.45;
  const keys = [{ x: center[0], y: center[1], lx: center[0], ly: center[1] }];
  for (const d of dots) keys.push({ x: center[0] + (d[0] - center[0]) * move, y: center[1] + (d[1] - center[1]) * move, lx: d[0], ly: d[1] });
  const segT = opts.segT || 1.4, holdT = opts.holdT || 0.6;
  const timeline = [];
  let t = 0;
  timeline.push({ t0: 0, t1: 0.5, a: keys[0], b: keys[0] });
  t = 0.5;
  for (let i = 1; i < keys.length; i++) {
    timeline.push({ t0: t, t1: t + segT, a: keys[i - 1], b: keys[i] }); t += segT;
    timeline.push({ t0: t, t1: t + holdT, a: keys[i], b: keys[i] }); t += holdT;
  }
  const total = t;
  const shake = opts.tapShake || 0; // extra jolt right when the shutter is tapped
  const poseAt = (tt) => {
    const seg = timeline.find((s) => tt >= s.t0 && tt <= s.t1) || timeline[timeline.length - 1];
    let u = (tt - seg.t0) / Math.max(1e-6, seg.t1 - seg.t0);
    u = u * u * (3 - 2 * u);
    const L = (a, b) => a + (b - a) * u;
    // Hand shake: a few incommensurate sines.
    const jolt = shake * Math.exp(-tt * 8);
    const sx = (Math.sin(tt * 7.1) * 6 + Math.sin(tt * 13.3) * 3) * (opts.shakeAmp || 1) + jolt * Math.sin(tt * 40);
    const sy = (Math.cos(tt * 6.3) * 6 + Math.sin(tt * 11.7) * 3) * (opts.shakeAmp || 1) + jolt * Math.cos(tt * 37);
    const sr = Math.sin(tt * 5.3) * 0.012 + Math.sin(tt * 9.1) * 0.006;
    const p = lookAt(L(seg.a.x, seg.b.x) + sx, L(seg.a.y, seg.b.y) + sy, hgt + Math.sin(tt * 3.1) * 25,
      L(seg.a.lx, seg.b.lx) + sx * 2, L(seg.a.ly, seg.b.ly) + sy * 2, sr + (opts.roll || 0));
    return p;
  };
  const Hs = (tt) => poseH(poseAt(tt), f, W, Hh);
  const refTime = opts.refTime || 0;
  const Href = mul(S, Hs(refTime));
  const HrefInv = P.inv3(Href);
  const blurN = opts.blur === false ? 1 : (opts.blurN || 3);
  const exposure = opts.exposure || 1 / 30;
  const glare = opts.glare;         // { x, y, r, strength } in normalised small-frame coords
  const gainAmp = opts.gainAmp !== undefined ? opts.gainAmp : 0.12;
  for (let i = 0; ; i++) {
    const tt = refTime + i / fps;
    if (tt > total) break;
    // Motion blur: average several sub-frames within the exposure time.
    let acc = null;
    for (let b = 0; b < blurN; b++) {
      const Hb = mul(S, Hs(tt + (b / Math.max(1, blurN - 1) - 0.5) * exposure));
      const M = cv.matFromArray(3, 3, cv.CV_64F, Hb);
      const v = new cv.Mat();
      cv.warpPerspective(scene, v, M, new cv.Size(sw, sh), cv.INTER_LINEAR, cv.BORDER_REFLECT, new cv.Scalar());
      M.delete();
      const g = P.toGray(v); v.delete();
      if (!acc) { acc = new cv.Mat(); g.convertTo(acc, cv.CV_32F); } else { const f32 = new cv.Mat(); g.convertTo(f32, cv.CV_32F); cv.add(acc, f32, acc); f32.delete(); }
      g.delete();
    }
    const gain = 1 + Math.sin(tt * 1.7) * gainAmp;
    const gray = new cv.Mat();
    acc.convertTo(gray, cv.CV_8U, gain / blurN, 0);
    acc.delete();
    const d = gray.data;
    for (let o = 0; o < d.length; o++) { const n = (rand() - 0.5) * 8; const v = d[o] + n; d[o] = v < 0 ? 0 : v > 255 ? 255 : v; }
    if (glare) {
      // A reflection of the room light: fixed relative to the camera.
      const gx = glare.x * sw, gy = glare.y * sh, gr = glare.r * Math.min(sw, sh);
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        const q = ((x - gx) ** 2 + (y - gy) ** 2) / (gr * gr);
        if (q > 6) continue;
        const o = y * sw + x; const v = d[o] + glare.strength * Math.exp(-q); d[o] = v > 255 ? 255 : v;
      }
    }
    const Htrue = mul(mul(S, Hs(tt)), HrefInv);
    const dotsSmall = dots.map((dd) => P.applyH(Href, dd));
    yield { gray, Htrue, t: tt, i, dotsSmall, size: [sw, sh] };
  }
}
