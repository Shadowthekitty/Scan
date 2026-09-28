/*
 * Image-processing worker. Owns OpenCV.js, captured frames and editable
 * items so the UI thread never blocks on heavy work.
 *
 * Protocol: { id, cmd, args } -> { id, ok, result } | { id, ok: false, error }
 * Progress updates are sent as { id, progress: { stage, value } }.
 */
/* global ScanPipeline */
'use strict';

importScripts('../vendor/opencv.js', 'pipeline.js');

const P = self.ScanPipeline;
let cv = null;

const ready = (async () => {
  let m = self.cv;
  if (m instanceof Promise) m = await m;
  else if (!m.Mat) await new Promise((resolve) => { m.onRuntimeInitialized = resolve; });
  cv = m;
  P.init(cv);
  try {
    const res = await fetch('../models/face_detection_yunet_2023mar.onnx');
    if (res.ok) {
      const buf = new Uint8Array(await res.arrayBuffer());
      cv.FS_createDataFile('/', 'yunet.onnx', buf, true, false, false);
      P.setFaceModel('/yunet.onnx');
    }
  } catch (e) {
    // Auto-rotation is optional.
  }
})();

const sessions = new Map();
const items = new Map();
let tracker = null;
let nextId = 1;

function errText(e) {
  if (typeof e === 'number' && cv && cv.exceptionFromPtr) {
    try { return 'OpenCV: ' + cv.exceptionFromPtr(e).msg; } catch (x) { /* fall through */ }
  }
  return (e && e.message) || String(e);
}

function imageOut(mat) {
  const img = P.imageFromMat(mat);
  return { width: img.width, height: img.height, data: img.data };
}

function transferList(result) {
  const list = [];
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (ArrayBuffer.isView(v)) { list.push(v.buffer); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    Object.values(v).forEach(walk);
  };
  walk(result);
  return list;
}

function smallGray(image) {
  const m = P.matFromImage(image);
  const g = P.toGray(m);
  m.delete();
  return g;
}

/* ---------------------------------------------------------------- */
/* Live helpers                                                      */
/* ---------------------------------------------------------------- */

// Remembers the album page colour between live frames.
const albumState = {};

function cmdDetect({ image, multi }) {
  const m = P.matFromImage(image);
  try {
    const quads = P.detectQuads(m, { multi, workSize: Math.max(image.width, image.height), minSupport: 0.5, albumState: multi ? albumState : undefined });
    return {
      quads: quads.map((q) => ({ pts: q.pts.map((p) => [p[0] / image.width, p[1] / image.height]), score: q.score })),
    };
  } finally {
    m.delete();
  }
}

function cmdTrackStart({ image, quad }) {
  if (tracker) { tracker.delete(); tracker = null; }
  const g = smallGray(image);
  try {
    tracker = P.createTracker(g, quad);
    return { features: tracker.f.pts.length / 2 };
  } finally {
    g.delete();
  }
}

function cmdTrack({ image, predict }) {
  if (!tracker) return null;
  const g = smallGray(image);
  try {
    const r = P.trackFrame(tracker, g, { predict });
    return r ? { H: r.H, inliers: r.inliers, mode: r.mode } : null;
  } finally {
    g.delete();
  }
}

function cmdTrackStop() {
  if (tracker) { tracker.delete(); tracker = null; }
  return true;
}

/* ---------------------------------------------------------------- */
/* Capture sessions                                                  */
/* ---------------------------------------------------------------- */

function cmdSessionCreate() {
  const sid = nextId++;
  sessions.set(sid, { frames: [] });
  return { sid };
}

// Frames go straight into OpenCV memory so each exists only once; the
// transferred JavaScript buffer can be garbage-collected immediately.
function cmdSessionAddFrame({ sid, image }) {
  const s = sessions.get(sid);
  if (!s) throw new Error('No such capture session');
  s.frames.push(P.matFromImage(image));
  return { count: s.frames.length };
}

function dropSession(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  s.frames.forEach((m) => { if (!m.isDeleted()) m.delete(); });
  sessions.delete(sid);
}

function cmdSessionDrop({ sid }) {
  dropSession(sid);
  return true;
}

function clampRect(x0, y0, x1, y1, W, H) {
  const x = Math.max(0, Math.floor(x0)), y = Math.max(0, Math.floor(y0));
  const r = Math.min(W, Math.ceil(x1)), b = Math.min(H, Math.ceil(y1));
  return { x, y, w: Math.max(1, r - x), h: Math.max(1, b - y) };
}

function bboxOf(quads) {
  const xs = [], ys = [];
  quads.forEach((q) => q.forEach((p) => { xs.push(p[0]); ys.push(p[1]); }));
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Turn one or more frames (RGBA Mats, owned and freed here) of the same
 * scene into editable items. mats[0] is the reference (straight-on) view.
 */
function processFrames(mats, opts, progress) {
  const ref = mats[0];
  const W = ref.cols, H = ref.rows;
  const created = [];
  try {
    progress('detect', 0);
    let found = P.detectQuads(ref, { multi: !!opts.multi, workSize: 640 }).map((q) => q.pts);
    let detected = found.length > 0;
    const hints = (opts.hintQuads || []).map((q) => q.map((p) => [p[0] * W, p[1] * H]));
    if (!found.length && hints.length) {
      found = hints;
      detected = true;
    } else if (opts.multi) {
      for (const h of hints) {
        if (!P.isConvexQuad(h)) continue;
        // The live preview showed this print steadily. If this frame broke it
        // into pieces (or kept only part of it), trust the preview's outline.
        const ha = P.polyArea(h);
        const parts = found.filter((f) => P.insideFraction(f, h) > 0.8 && P.polyArea(f) < ha * 0.9);
        const covered = parts.reduce((a, f) => a + P.polyArea(f), 0);
        if (parts.length && (parts.length >= 2 || covered < ha * 0.7)) {
          found = found.filter((f) => !parts.includes(f));
          found.push(h);
          continue;
        }
        // Keep album prints the live preview saw but this frame missed.
        if (found.some((f) => P.quadIoU(f, h) > 0.2)) continue;
        found.push(h);
      }
    }
    if (!found.length) {
      const i = Math.round(Math.min(W, H) * 0.02);
      found = [[[i, i], [W - i, i], [W - i, H - i], [i, H - i]]];
    }
    found = found.map((q) => (detected ? P.refineQuad(ref, q) : q));

    const [bx0, by0, bx1, by1] = bboxOf(found);
    // Keep room around the outline so Crop can still reach a part of the
    // print that detection left out (a white edge on a white table).
    const margin = Math.max(bx1 - bx0, by1 - by0) * (found.length > 1 ? 0.06 : 0.15) + 8;
    const roi = clampRect(bx0 - margin, by0 - margin, bx1 + margin, by1 + margin, W, H);

    let merged;
    let usedFrames = 1;
    if (mats.length > 1) {
      progress('align', 0.05);
      const { Hs, info } = P.alignFrames(mats, 0);
      usedFrames = Hs.filter(Boolean).length;
      merged = P.mergeFrames(mats, Hs, 0, roi, {
        consume: true,
        sharpness: info.map((x) => x.sharpness),
        onProgress: (stage, v) => progress(stage, 0.1 + v * 0.75),
      });
    } else {
      merged = P.copyMat(ref.roi(new cv.Rect(roi.x, roi.y, roi.w, roi.h)));
    }
    // Frames are no longer needed; free them before per-item work.
    mats.forEach((m) => { if (!m.isDeleted()) m.delete(); });
    mats.length = 0;

    progress('finish', 0.9);
    const focal = 0.8 * Math.max(W, H);
    const pp = [W / 2 - roi.x, H / 2 - roi.y];
    for (const q of found) {
      const local = q.map((p) => [p[0] - roi.x, p[1] - roi.y]);
      let base = merged;
      let quad = local;
      let ipp = pp;
      if (found.length > 1) {
        // Each photo of an album page gets its own base with a margin.
        const [x0, y0, x1, y1] = bboxOf([local]);
        const mg = Math.max(x1 - x0, y1 - y0) * 0.1 + 8;
        const r = clampRect(x0 - mg, y0 - mg, x1 + mg, y1 + mg, merged.cols, merged.rows);
        base = P.copyMat(merged.roi(new cv.Rect(r.x, r.y, r.w, r.h)));
        quad = local.map((p) => [p[0] - r.x, p[1] - r.y]);
        ipp = [pp[0] - r.x, pp[1] - r.y];
      }
      const item = newItem(base, quad, ipp, focal, detected);
      if (opts.autoRotate) {
        const preview = P.rectify(base, quad, itemRectOpts(item, 640));
        item.suggestedRotation = P.detectOrientation(preview).rotation;
        preview.delete();
      }
      created.push(item);
    }
    if (found.length > 1) merged.delete();
    progress('finish', 1);
    return {
      usedFrames,
      items: created.map(describeItem),
    };
  } catch (e) {
    mats.forEach((m) => { if (!m.isDeleted()) m.delete(); });
    created.forEach((it) => dropItem(it.id));
    throw e;
  }
}

function cmdSessionProcess({ sid, multi, autoRotate, hintQuads }, progress) {
  const s = sessions.get(sid);
  if (!s || !s.frames.length) throw new Error('Nothing was captured');
  sessions.delete(sid);
  return processFrames(s.frames, { multi, autoRotate, hintQuads }, progress);
}

function cmdImportImage({ image, multi, autoRotate }, progress) {
  return processFrames([P.matFromImage(image)], { multi, autoRotate }, progress);
}

/* ---------------------------------------------------------------- */
/* Items (one editable photo each)                                   */
/* ---------------------------------------------------------------- */

function newItem(base, quad, pp, focal, detected) {
  const item = {
    id: nextId++,
    base,
    quad,
    autoQuad: quad.map((p) => p.slice()),
    detected,
    pp,
    focal,
    rect: null,
    rectKey: '',
    preview: null,
    previewKey: '',
    suggestedRotation: 0,
  };
  items.set(item.id, item);
  return item;
}

function describeItem(item) {
  const size = P.outputSize(item.quad, itemRectOpts(item, 1e9));
  return {
    id: item.id,
    quad: item.quad,
    autoQuad: item.autoQuad,
    detected: item.detected,
    baseWidth: item.base.cols,
    baseHeight: item.base.rows,
    pp: item.pp,
    focal: item.focal,
    naturalWidth: size.width,
    naturalHeight: size.height,
    suggestedRotation: item.suggestedRotation,
  };
}

function itemRectOpts(item, maxSide, snap) {
  return { pp: item.pp, focal: item.focal, maxSide, snap: snap !== false };
}

function getItem(id) {
  const it = items.get(id);
  if (!it) throw new Error('This photo is no longer open');
  return it;
}

function dropItem(id) {
  const it = items.get(id);
  if (!it) return;
  [it.base, it.rect, it.preview].forEach((m) => { if (m && !m.isDeleted()) m.delete(); });
  items.delete(id);
}

function ensureRect(item, maxSide, snap) {
  const key = JSON.stringify([item.quad, maxSide, snap]);
  if (item.rect && item.rectKey === key) return item.rect;
  if (item.rect) item.rect.delete();
  if (item.preview) { item.preview.delete(); item.preview = null; item.previewKey = ''; }
  item.rect = P.rectify(item.base, item.quad, itemRectOpts(item, maxSide, snap));
  item.rectKey = key;
  return item.rect;
}

function ensurePreview(item, rect, maxSide) {
  const key = item.rectKey + '|' + maxSide;
  if (item.preview && item.previewKey === key) return item.preview;
  if (item.preview) item.preview.delete();
  item.preview = P.resizeMax(rect, maxSide).mat;
  item.previewKey = key;
  return item.preview;
}

function cmdItemCreate({ image, quad, pp, focal }) {
  const base = P.matFromImage(image);
  const q = quad || [[0, 0], [image.width, 0], [image.width, image.height], [0, image.height]];
  const item = newItem(base, q, pp || [image.width / 2, image.height / 2], focal || 0.8 * Math.max(image.width, image.height), !!quad);
  return describeItem(item);
}

function cmdItemBase({ id, maxSide }) {
  const it = getItem(id);
  const { mat, scale } = P.resizeMax(it.base, maxSide || 1e9);
  try {
    return { image: imageOut(mat), scale };
  } finally {
    mat.delete();
  }
}

function cmdItemSetQuad({ id, quad }) {
  const it = getItem(id);
  if (!P.isConvexQuad(quad)) throw new Error('Corners must form a convex shape');
  it.quad = quad.map((p) => [p[0], p[1]]);
  return describeItem(it);
}

function cmdItemRender({ id, params, maxSide, outputMax, snap }) {
  const it = getItem(id);
  const rect = ensureRect(it, outputMax || 3200, snap);
  const fullLong = Math.max(rect.cols, rect.rows);
  const src = maxSide && maxSide < fullLong ? ensurePreview(it, rect, maxSide) : rect;
  const out = P.render(src, params, { fullLong });
  try {
    return { image: imageOut(out) };
  } finally {
    out.delete();
  }
}

function cmdItemDelete({ id }) {
  dropItem(id);
  return true;
}

function cmdItemDeleteAll() {
  [...items.keys()].forEach(dropItem);
  return true;
}

/* ---------------------------------------------------------------- */

const handlers = {
  init: async () => ({ version: cv.getBuildInformation ? (cv.getBuildInformation().match(/Version control:\s*(\S+)/) || [])[1] : 'unknown' }),
  detect: cmdDetect,
  trackStart: cmdTrackStart,
  track: cmdTrack,
  trackStop: cmdTrackStop,
  sessionCreate: cmdSessionCreate,
  sessionAddFrame: cmdSessionAddFrame,
  sessionDrop: cmdSessionDrop,
  sessionProcess: cmdSessionProcess,
  importImage: cmdImportImage,
  itemCreate: cmdItemCreate,
  itemBase: cmdItemBase,
  itemSetQuad: cmdItemSetQuad,
  itemRender: cmdItemRender,
  itemDelete: cmdItemDelete,
  itemDeleteAll: cmdItemDeleteAll,
};

self.onmessage = async (ev) => {
  const { id, cmd, args } = ev.data || {};
  try {
    await ready;
    const h = handlers[cmd];
    if (!h) throw new Error('Unknown command ' + cmd);
    const progress = (stage, value) => self.postMessage({ id, progress: { stage, value } });
    const result = await h(args || {}, progress);
    self.postMessage({ id, ok: true, result }, transferList(result));
  } catch (e) {
    self.postMessage({ id, ok: false, error: errText(e) });
  }
};
