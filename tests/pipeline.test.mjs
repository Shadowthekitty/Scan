import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadPipeline, makePhoto, makeTable, placePhoto, viewOf, addGlare, cameraH, meanAbsDiff, rng,
} from './helpers.mjs';

const { cv, P } = await loadPipeline();

const VIEW_W = 1600, VIEW_H = 1200;
const SCENE_QUAD = [[450, 380], [1350, 400], [1340, 1000], [440, 985]];

function buildScene(opts = {}) {
  const photo = makePhoto(cv, 900, 600, opts.seed || 3, opts);
  const table = makeTable(cv, 1800, 1400);
  const scene = placePhoto(cv, table, photo, SCENE_QUAD);
  table.delete();
  return { photo, scene };
}

function maxCornerError(a, b) {
  return Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
}

test('detects the photo and refines its corners', () => {
  const { photo, scene } = buildScene();
  const H = cameraH(VIEW_W, VIEW_H, { tx: -100, ty: -100, rot: 0.06, zoom: 1.0, px: 0.00005, py: -0.00004 });
  const view = viewOf(cv, scene, H, VIEW_W, VIEW_H);
  const truth = SCENE_QUAD.map((p) => P.applyH(H, p));
  const found = P.detectQuads(view);
  assert.equal(found.length, 1, 'one photo found');
  const coarse = found[0].pts;
  const coarseErr = maxCornerError(coarse, truth);
  const fine = P.refineQuad(view, coarse);
  const fineErr = maxCornerError(fine, truth);
  console.log(`corner error: coarse ${coarseErr.toFixed(2)}px, refined ${fineErr.toFixed(2)}px`);
  assert.ok(coarseErr < 20, 'coarse corners within 20px');
  assert.ok(fineErr < 2.5, 'refined corners within 2.5px');
  assert.ok(fineErr <= coarseErr + 0.5, 'refinement does not make it worse');
  photo.delete(); scene.delete(); view.delete();
});

test('finds several photos on an album page', () => {
  const table = makeTable(cv, 1600, 1200, 11, [35, 35, 38]);
  let page = table;
  const quads = [
    [[120, 120], [700, 130], [695, 520], [115, 510]],
    [[860, 150], [1460, 140], [1470, 560], [865, 570]],
    [[300, 680], [900, 700], [890, 1090], [290, 1075]],
  ];
  quads.forEach((q, i) => {
    const ph = makePhoto(cv, 600, 400, 20 + i);
    const next = placePhoto(cv, page, ph, q);
    if (page !== table) page.delete();
    page = next;
    ph.delete();
  });
  const found = P.detectQuads(page, { multi: true });
  assert.equal(found.length, 3, 'three photos found');
  for (const q of quads) {
    const match = found.find((f) => maxCornerError(f.pts, q) < 25);
    assert.ok(match, 'each photo matched');
  }
  table.delete(); page.delete();
});

test('aligns shots and removes glare better than any single shot', () => {
  const { photo, scene } = buildScene({ seed: 5 });
  const poses = [
    { tx: 0, ty: 0, rot: 0.0, zoom: 1.0 },
    { tx: 160, ty: 120, rot: 0.04, zoom: 1.05, px: 0.00008 },
    { tx: -170, ty: 110, rot: -0.03, zoom: 0.97, py: 0.00007 },
    { tx: 150, ty: -130, rot: 0.02, zoom: 1.02, px: -0.00006 },
    { tx: -140, ty: -120, rot: -0.05, zoom: 1.0, py: -0.00005 },
  ].map((p) => cameraH(VIEW_W, VIEW_H, { ...p, tx: p.tx - 100, ty: p.ty - 100 }));
  const glarePos = [[800, 560], [620, 440], [1000, 460], [650, 700], [980, 720]];

  const clean = viewOf(cv, scene, poses[0], VIEW_W, VIEW_H);
  const frames = poses.map((H, i) => {
    const v = viewOf(cv, scene, H, VIEW_W, VIEW_H);
    // Slight exposure differences between shots.
    if (i > 0) { const d = v.data; const g = 1 + (i % 2 ? 0.06 : -0.05); for (let o = 0; o < d.length; o += 4) { d[o] = Math.min(255, d[o] * g); d[o + 1] = Math.min(255, d[o + 1] * g); d[o + 2] = Math.min(255, d[o + 2] * g); } }
    return v;
  });
  const glareMask = addGlare(frames[0], glarePos[0][0], glarePos[0][1], 110, 80);
  for (let i = 1; i < frames.length; i++) addGlare(frames[i], glarePos[i][0], glarePos[i][1], 110, 80);

  const t0 = Date.now();
  const { Hs, info } = P.alignFrames(frames, 0);
  const tAlign = Date.now() - t0;
  // Check alignment accuracy against ground truth.
  const truthQuad = SCENE_QUAD.map((p) => P.applyH(poses[0], p));
  for (let i = 1; i < frames.length; i++) {
    assert.ok(Hs[i], `frame ${i} aligned`);
    const trueToRef = P.mul3(poses[0], P.inv3(poses[i]));
    const err = Math.max(...truthQuad.map((p) => {
      const inFrame = P.applyH(P.inv3(trueToRef), p);
      const back = P.applyH(Hs[i], inFrame);
      return Math.hypot(back[0] - p[0], back[1] - p[1]);
    }));
    console.log(`frame ${i}: inliers ${info[i].inliers}, corner reprojection error ${err.toFixed(2)}px`);
    assert.ok(err < 2, `frame ${i} alignment within 2px`);
  }

  const xs = truthQuad.map((p) => p[0]), ys = truthQuad.map((p) => p[1]);
  const roi = { x: Math.floor(Math.min(...xs)) - 20, y: Math.floor(Math.min(...ys)) - 20 };
  roi.w = Math.ceil(Math.max(...xs)) + 20 - roi.x;
  roi.h = Math.ceil(Math.max(...ys)) + 20 - roi.y;
  const t1 = Date.now();
  const merged = P.mergeFrames(frames, Hs, 0, roi, { sharpness: info.map((x) => x.sharpness) });
  const tMerge = Date.now() - t1;

  const crop = (m) => P.copyMat(m.roi(new cv.Rect(roi.x, roi.y, roi.w, roi.h)));
  const cleanCrop = crop(clean), refCrop = crop(frames[0]);
  const maskCrop = new Uint8Array(roi.w * roi.h);
  for (let y = 0; y < roi.h; y++) for (let x = 0; x < roi.w; x++) maskCrop[y * roi.w + x] = glareMask[(y + roi.y) * VIEW_W + (x + roi.x)];

  const glareBefore = meanAbsDiff(refCrop, cleanCrop, maskCrop);
  const glareAfter = meanAbsDiff(merged, cleanCrop, maskCrop);
  const overall = meanAbsDiff(merged, cleanCrop);
  console.log(`glare MAE before ${glareBefore.toFixed(1)}, after ${glareAfter.toFixed(1)}; overall MAE ${overall.toFixed(2)}; align ${tAlign}ms merge ${tMerge}ms`);
  assert.ok(glareBefore > 60, 'test glare is strong');
  assert.ok(glareAfter < 4, 'glare removed');
  assert.ok(overall < 2, 'rest of the photo preserved');

  [photo, scene, clean, cleanCrop, refCrop, merged, ...frames].forEach((m) => m.delete());
});

test('rectifies to the true print aspect ratio', () => {
  const { photo, scene } = buildScene({ seed: 9 });
  const H = cameraH(VIEW_W, VIEW_H, { tx: -100, ty: -60, rot: 0.03, px: 0.00012, py: 0.00006 });
  const view = viewOf(cv, scene, H, VIEW_W, VIEW_H);
  const quad = P.refineQuad(view, P.detectQuads(view)[0].pts);
  const pp = [VIEW_W / 2, VIEW_H / 2];
  const size = P.outputSize(quad, { pp, focal: 1400, snap: false });
  console.log(`aspect estimate ${size.ratio.toFixed(3)} (true 1.500)`);
  assert.ok(Math.abs(size.ratio - 1.5) < 0.06, 'aspect within 4%');
  const snapped = P.outputSize(quad, { pp, focal: 1400 });
  assert.equal(Math.round(snapped.ratio * 1000), 1500, 'snaps to 3:2');

  const out = P.rectify(view, quad, { pp, focal: 1400, maxSide: 3000 });
  assert.ok(Math.abs(out.cols / out.rows - 1.5) < 0.01, 'output has 3:2 shape');
  const rect = new cv.Mat();
  cv.resize(out, rect, new cv.Size(900, 600), 0, 0, cv.INTER_AREA);
  out.delete();
  // Compare with the original print, ignoring a thin border.
  const inner = (m) => P.copyMat(m.roi(new cv.Rect(12, 12, 876, 576)));
  const a = inner(rect), b = inner(photo);
  const mae = meanAbsDiff(a, b);
  console.log(`rectified vs original MAE ${mae.toFixed(2)}`);
  assert.ok(mae < 14, 'rectified content matches the print');
  [photo, scene, view, rect, a, b].forEach((m) => m.delete());
});

test('restore preset brings a faded, colour-cast print back', async () => {
  const original = makePhoto(cv, 600, 400, 13);
  const faded = P.copyMat(original);
  const d = faded.data;
  // Fade: low contrast, lifted blacks, magenta/red cast.
  for (let o = 0; o < d.length; o += 4) {
    d[o] = 90 + d[o] * 0.45; d[o + 1] = 60 + d[o + 1] * 0.35; d[o + 2] = 80 + d[o + 2] * 0.4;
  }
  const before = meanAbsDiff(faded, original);
  for (const preset of ['none', 'auto', 'restore', 'bw']) {
    const out = P.render(faded, { preset, sharpness: 20, rotation: 1, saturation: 5, warmth: 10, brightness: 5, contrast: 5, shadows: 10, highlights: -10 });
    assert.equal(out.cols, 400, `${preset}: rotated`);
    out.delete();
  }
  const restored = P.render(faded, { preset: 'restore' });
  const auto = P.render(faded, { preset: 'auto' });
  const afterRestore = meanAbsDiff(restored, original);
  const afterAuto = meanAbsDiff(auto, original);
  console.log(`difference from the unfaded print: faded ${before.toFixed(1)}, auto ${afterAuto.toFixed(1)}, restore ${afterRestore.toFixed(1)}`);
  assert.ok(afterRestore < before * 0.5, 'restore undoes most of the fading');
  assert.ok(afterAuto < before * 0.8, 'auto improves it too');
  // A real, well-exposed photo should come through Auto nearly unchanged.
  const { gunzipSync } = await import('node:zlib');
  const fs = await import('node:fs');
  const raw = gunzipSync(fs.readFileSync(new URL('./fixtures/astronaut-320.rgb.gz', import.meta.url)));
  const rgb = new cv.Mat(320, 320, cv.CV_8UC3);
  rgb.data.set(raw);
  const good = new cv.Mat();
  cv.cvtColor(rgb, good, cv.COLOR_RGB2RGBA);
  const untouched = P.render(good, { preset: 'auto' });
  const drift = meanAbsDiff(untouched, good);
  console.log(`auto on a good photo changes it by ${drift.toFixed(1)}`);
  assert.ok(drift < 8, 'auto leaves a good photo mostly alone');
  [original, faded, restored, auto, rgb, good, untouched].forEach((m) => m.delete());
});

test('dust removal cleans specks but keeps the image', () => {
  const photo = makePhoto(cv, 1200, 800, 17);
  const orig = P.copyMat(photo);
  const d = photo.data;
  const specks = [];
  for (let i = 0; i < 60; i++) {
    const x = 20 + Math.floor((i * 97) % 1160), y = 20 + Math.floor((i * 53) % 760);
    specks.push([x, y]);
    const v = i % 2 ? 255 : 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const o = ((y + dy) * 1200 + x + dx) * 4; d[o] = d[o + 1] = d[o + 2] = v;
    }
  }
  const mask = new Uint8Array(1200 * 800);
  for (const [x, y] of specks) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) mask[(y + dy) * 1200 + x + dx] = 1;
  const before = meanAbsDiff(photo, orig, mask);
  const cleaned = P.copyMat(photo);
  P.removeDust(cleaned, 70);
  const after = meanAbsDiff(cleaned, orig, mask);
  const inv = mask.map((v) => 1 - v);
  const collateral = meanAbsDiff(cleaned, orig, inv);
  console.log(`dust MAE ${before.toFixed(1)} -> ${after.toFixed(1)}, elsewhere ${collateral.toFixed(2)}`);
  assert.ok(after < before * 0.5, 'specks mostly removed');
  assert.ok(collateral < 2.5, 'little change elsewhere');
  [photo, orig, cleaned].forEach((m) => m.delete());
});

test('tracker follows camera motion', () => {
  const { photo, scene } = buildScene({ seed: 21 });
  const small = (H) => {
    const v = viewOf(cv, scene, H, VIEW_W, VIEW_H);
    const s = new cv.Mat(); cv.resize(v, s, new cv.Size(480, 360), 0, 0, cv.INTER_AREA);
    const g = P.toGray(s); v.delete(); s.delete(); return g;
  };
  const H0 = cameraH(VIEW_W, VIEW_H, { tx: -100, ty: -100 });
  const H1 = cameraH(VIEW_W, VIEW_H, { tx: 60, ty: 40, rot: 0.05 });
  const g0 = small(H0), g1 = small(H1);
  const tr = P.createTracker(g0);
  const t = Date.now();
  const r = P.trackFrame(tr, g1);
  console.log(`track ${Date.now() - t}ms, inliers ${r && r.inliers}`);
  assert.ok(r, 'tracked');
  const S = P.scaleMat(480 / VIEW_W);
  const truth = P.mul3(S, P.mul3(H1, P.mul3(P.inv3(H0), P.inv3(S))));
  const p = [240, 180];
  const a = P.applyH(r.H, p), b = P.applyH(truth, p);
  assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 3, 'tracked position within 3px');
  tr.delete(); g0.delete(); g1.delete(); photo.delete(); scene.delete();
});

test('turns sideways portraits upright and leaves other photos alone', async () => {
  const { gunzipSync } = await import('node:zlib');
  const fs = await import('node:fs');
  const raw = gunzipSync(fs.readFileSync(new URL('./fixtures/astronaut-320.rgb.gz', import.meta.url)));
  const rgb = new cv.Mat(320, 320, cv.CV_8UC3);
  rgb.data.set(raw);
  const rgba = new cv.Mat();
  cv.cvtColor(rgb, rgba, cv.COLOR_RGB2RGBA);
  // Place it on a larger print so the face is a realistic size.
  const print = new cv.Mat(560, 700, cv.CV_8UC4, new cv.Scalar(70, 90, 60, 255));
  rgba.copyTo(print.roi(new cv.Rect(300, 150, 320, 320)));
  const codes = [null, cv.ROTATE_90_COUNTERCLOCKWISE, cv.ROTATE_180, cv.ROTATE_90_CLOCKWISE];
  for (let turned = 0; turned < 4; turned++) {
    const img = new cv.Mat();
    if (turned === 0) print.copyTo(img); else cv.rotate(print, img, codes[turned]);
    // Turning the print counter-clockwise by `turned` quarters needs `turned` clockwise quarters to fix.
    const r = P.detectOrientation(img);
    assert.equal(r.rotation, turned, `print turned ${turned} quarter(s)`);
    img.delete();
  }
  const other = makePhoto(cv, 700, 500, 31);
  assert.equal(P.detectOrientation(other).rotation, 0, 'no faces, no rotation');
  [rgb, rgba, print, other].forEach((m) => m.delete());
});

test('album page: finds whole prints, not rectangles inside them', () => {
  const W = 1800, H = 1300;
  const table = makeTable(cv, W, H, 5, [115, 85, 60]);
  // A cream album page on the table.
  const pageQuad = [[140, 110], [1660, 130], [1650, 1190], [150, 1170]];
  const paper = new cv.Mat(1000, 1400, cv.CV_8UC4, new cv.Scalar(228, 220, 198, 255));
  let scene = placePhoto(cv, table, paper, pageQuad);
  paper.delete();
  const Hpage = (() => {
    const src = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, 1400, 0, 1400, 1000, 0, 1000]);
    const dst = cv.matFromArray(4, 1, cv.CV_32FC2, pageQuad.flat());
    const M = cv.getPerspectiveTransform(src, dst);
    const h = Array.from(M.data64F);
    src.delete(); dst.delete(); M.delete();
    return h;
  })();
  // Prints: one with a white border, one with a big dark "TV" rectangle
  // inside, one plain. makePhoto also draws many small rectangles.
  const prints = [
    { rect: [110, 120, 520, 360], seed: 41, border: 22 },
    { rect: [780, 110, 480, 360], seed: 42, tv: true },
    { rect: [420, 560, 560, 360], seed: 43 },
  ];
  const truth = [];
  for (const p of prints) {
    const ph = makePhoto(cv, 600, 420, p.seed, { border: p.border });
    if (p.tv) {
      cv.rectangle(ph, new cv.Point(150, 90), new cv.Point(470, 330), new cv.Scalar(15, 15, 15, 255), -1);
      cv.rectangle(ph, new cv.Point(175, 115), new cv.Point(445, 305), new cv.Scalar(200, 160, 90, 255), -1);
    }
    const [x, y, w, h] = p.rect;
    const q = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map((pt) => P.applyH(Hpage, pt));
    const next = placePhoto(cv, scene, ph, q);
    scene.delete();
    scene = next;
    ph.delete();
    truth.push(q);
  }
  const found = P.detectQuads(scene, { multi: true, workSize: 640 });
  const err = (a, b) => Math.max(...a.map((pt, i) => Math.hypot(pt[0] - b[i][0], pt[1] - b[i][1])));
  console.log(`album page: found ${found.length} of ${truth.length}`);
  assert.equal(found.length, truth.length, 'one outline per print, nothing extra');
  for (const t of truth) assert.ok(found.some((f) => err(f.pts, t) < 30), 'each print outlined whole');
  table.delete(); scene.delete();
});

test('keeps white parts of a print on a light surface', () => {
  // A print with a white border, and one with a bright white sky under an
  // uneven skyline, each lying on an off-white table.
  const make = (kind, seed) => {
    const r = rng(seed);
    const W = 1600, H = 1200;
    const table = new cv.Mat(H, W, cv.CV_8UC4, new cv.Scalar(238, 237, 233, 255));
    const td = table.data;
    for (let o = 0; o < td.length; o += 4) { const n = (r() - 0.5) * 6; td[o] += n; td[o + 1] += n; td[o + 2] += n; }
    let photo = makePhoto(cv, 900, 600, 50 + seed);
    if (kind === 'border') {
      const b = new cv.Mat();
      const inner = new cv.Mat();
      cv.resize(photo, inner, new cv.Size(820, 520));
      cv.copyMakeBorder(inner, b, 40, 40, 40, 40, cv.BORDER_CONSTANT, new cv.Scalar(246, 245, 240, 255));
      photo.delete(); inner.delete();
      photo = b;
    } else {
      const d = photo.data;
      let h = 200;
      for (let x = 0; x < 900; x++) {
        if (x % 40 === 0) h = 170 + Math.round(r() * 70);
        for (let y = 0; y < h; y++) {
          const o = (y * 900 + x) * 4, v = 252 - y * 0.1;
          d[o] = v; d[o + 1] = v; d[o + 2] = v;
        }
      }
    }
    const q = [[330, 250], [1290, 268], [1276, 925], [318, 902]];
    const scene = placePhoto(cv, table, photo, q);
    table.delete(); photo.delete();
    return { scene, q };
  };
  for (const [kind, seed] of [['border', 1], ['border', 2], ['sky', 1], ['sky', 2], ['sky', 3]]) {
    const { scene, q } = make(kind, seed);
    const f = P.detectQuads(scene, { workSize: 640 });
    const quad = P.refineQuad(scene, f[0].pts);
    const ratio = P.polyArea(quad) / P.polyArea(q);
    console.log(`${kind} (${seed}): outline covers ${(ratio * 100).toFixed(0)}% of the print`);
    assert.ok(ratio > 0.97 && ratio < 1.03, `${kind}: whole print kept`);
    scene.delete();
  }
});

// Uneven light, lens blur and sensor noise, as in a phone photo.
function phoneCamera(scene, r) {
  const W = scene.cols, H = scene.rows, d = scene.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const g = 1 + 0.07 * ((x / W - 0.5) + (y / H - 0.5)) - 0.2 * ((x / W - 0.5) ** 2 + (y / H - 0.5) ** 2);
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) d[o + c] = d[o + c] * g;
    }
  }
  cv.GaussianBlur(scene, scene, new cv.Size(0, 0), 0.9);
  const e = scene.data;
  for (let o = 0; o < e.length; o += 4) { const n = (r() - 0.5) * 8; e[o] += n; e[o + 1] += n; e[o + 2] += n; }
}

test('finds a corner hidden by a white shirt on a white table', () => {
  // A white shirt covers the print's lower left corner; there the print's
  // edge barely differs from the table. The outline must not cut across.
  const q = [[330, 250], [1290, 268], [1276, 925], [318, 902]];
  for (const seed of [1, 2, 3]) {
    const table = new cv.Mat(1200, 1600, cv.CV_8UC4, new cv.Scalar(236, 234, 229, 255));
    const photo = makePhoto(cv, 900, 600, 50 + seed);
    const d = photo.data;
    for (let y = 0; y < 600; y++) {
      for (let x = 0; x < 900; x++) {
        if ((x / 430) ** 2 + ((600 - y) / 330) ** 2 > 1) continue;
        // Folds: soft shading across the shirt.
        const v = 248 * (0.84 + 0.08 * Math.sin(x / 37 + y / 53) + 0.06 * Math.sin(y / 29 - x / 61));
        const o = (y * 900 + x) * 4;
        d[o] = v; d[o + 1] = v; d[o + 2] = v + 2;
      }
    }
    const scene = placePhoto(cv, table, photo, q);
    table.delete(); photo.delete();
    phoneCamera(scene, rng(seed));
    const f = P.detectQuads(scene, { workSize: 640 });
    const ratio = P.polyArea(P.refineQuad(scene, f[0].pts)) / P.polyArea(q);
    // The same at live preview size.
    const small = new cv.Mat();
    cv.resize(scene, small, new cv.Size(400, 300), 0, 0, cv.INTER_AREA);
    const fl = P.detectQuads(small, { workSize: 400, minSupport: 0.5 });
    const lratio = fl.length ? P.polyArea(fl[0].pts.map((p) => [p[0] * 4, p[1] * 4])) / P.polyArea(q) : 0;
    console.log(`white shirt (${seed}): outline covers ${(ratio * 100).toFixed(0)}% of the print, live ${(lratio * 100).toFixed(0)}%`);
    assert.ok(ratio > 0.97 && ratio < 1.03, 'whole print kept');
    assert.ok(lratio > 0.95 && lratio < 1.05, 'whole print kept live');
    small.delete(); scene.delete();
  }
});

test('does not grow onto lines of the surface', () => {
  // A print whose lower part is close to the wood it lies on, with grain
  // lines parallel to its bottom edge. The outline must stay on the print.
  const q = [[330, 250], [1290, 262], [1280, 915], [322, 900]];
  for (const seed of [1, 2, 4]) {
    const r = rng(seed + 20);
    const W = 1600, H = 1200;
    const table = new cv.Mat(H, W, cv.CV_8UC4, new cv.Scalar(214, 190, 160, 255));
    const td = table.data;
    const dark = new Float32Array(H);
    for (let i = 0; i < 40; i++) {
      const y0 = r() * H, depth = 10 + r() * 20;
      for (let y = 0; y < H; y++) dark[y] += depth * Math.exp(-((y - y0) ** 2) / 8);
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4, n = (r() - 0.5) * 4 - dark[y];
        td[o] += n; td[o + 1] += n; td[o + 2] += n;
      }
    }
    const photo = makePhoto(cv, 900, 600, 60 + seed);
    cv.rectangle(photo, new cv.Point(0, 470), new cv.Point(900, 600), new cv.Scalar(150, 140, 125, 255), -1);
    const scene = placePhoto(cv, table, photo, q);
    table.delete(); photo.delete();
    const f = P.detectQuads(scene, { workSize: 640 });
    const ratio = P.polyArea(P.refineQuad(scene, f[0].pts)) / P.polyArea(q);
    console.log(`print on grained wood (${seed}): outline covers ${(ratio * 100).toFixed(0)}% of the print`);
    assert.ok(ratio > 0.97 && ratio < 1.03, 'stayed on the print');
    scene.delete();
  }
});
