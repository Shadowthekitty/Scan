// Render an open item at full quality and store it in the library.
import { encodeJpeg, uid } from './util.js';
import { withExif } from './exif.js';
import { putScan } from './db.js';
import { getSettings } from './settings.js';

export function defaultParams(suggestedRotation = 0) {
  const s = getSettings();
  return {
    preset: s.preset,
    rotation: suggestedRotation || 0,
    flip: false,
    brightness: 0,
    contrast: 0,
    shadows: 0,
    highlights: 0,
    saturation: 0,
    warmth: 0,
    sharpness: s.sharpen,
    dust: 0,
  };
}

/**
 * doc: { itemId, info, quad, params, meta, recordId?, created?, baseBlob? }
 * Returns the saved record.
 */
export async function saveDoc(worker, doc, onProgress = () => {}) {
  const s = getSettings();
  const common = { id: doc.itemId, params: doc.params, outputMax: s.outputMax, snap: s.snap };
  onProgress(0.1);
  const full = await worker.call('itemRender', common);
  const width = full.image.width, height = full.image.height;
  onProgress(0.45);
  let image = await encodeJpeg(full.image, s.quality);
  image = await withExif(image, { date: doc.meta && doc.meta.date, description: doc.meta && doc.meta.caption });
  onProgress(0.6);
  const small = await worker.call('itemRender', { ...common, maxSide: 480 });
  const thumb = await encodeJpeg(small.image, 0.8);
  onProgress(0.7);

  // Keep the uncropped, glare-free source so the scan can be re-edited later.
  let base = doc.baseBlob;
  let k = 1;
  if (!base) {
    const b = await worker.call('itemBase', { id: doc.itemId, maxSide: 4096 });
    base = await encodeJpeg(b.image, 0.92);
    k = b.scale;
  }
  onProgress(0.9);
  const quad = (doc.quad || doc.info.quad).map((p) => [p[0] * k, p[1] * k]);
  const rec = {
    id: doc.recordId || uid(),
    created: doc.created || Date.now(),
    updated: Date.now(),
    width,
    height,
    params: { ...doc.params },
    meta: { date: '', caption: '', ...(doc.meta || {}) },
    quad,
    pp: doc.info.pp.map((v) => v * k),
    focal: doc.info.focal * k,
    image,
    thumb,
    base,
    bytes: image.size,
  };
  await putScan(rec);
  onProgress(1);
  return rec;
}
