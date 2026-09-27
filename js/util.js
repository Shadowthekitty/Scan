// Small DOM and image helpers shared by the views.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

const busy = { el: null, text: null, bar: null, depth: 0 };
export function showBusy(text, value) {
  if (!busy.el) { busy.el = $('#busy'); busy.text = $('#busy-text'); busy.bar = $('#busy-bar'); }
  busy.el.hidden = false;
  if (text) busy.text.textContent = text;
  if (typeof value === 'number') {
    busy.bar.parentElement.hidden = false;
    busy.bar.style.width = Math.round(Math.max(0, Math.min(1, value)) * 100) + '%';
  } else {
    busy.bar.parentElement.hidden = true;
  }
}
export function hideBusy() { if (busy.el) busy.el.hidden = true; }

export function confirmDialog(message, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    const dlg = $('#confirm');
    $('#confirm-text').textContent = message;
    const ok = $('#confirm-ok');
    ok.textContent = okLabel;
    ok.classList.toggle('danger', danger);
    const done = (v) => { dlg.close(); resolve(v); };
    ok.onclick = () => done(true);
    $('#confirm-cancel').onclick = () => done(false);
    dlg.oncancel = () => resolve(false);
    dlg.showModal();
  });
}

/** Draw a worker image result ({width, height, data}) into a canvas. */
export function paint(canvas, image) {
  if (canvas.width !== image.width) canvas.width = image.width;
  if (canvas.height !== image.height) canvas.height = image.height;
  const data = image.data instanceof Uint8ClampedArray ? image.data : new Uint8ClampedArray(image.data.buffer);
  canvas.getContext('2d').putImageData(new ImageData(data, image.width, image.height), 0, 0);
}

let encCanvas = null;
export function encodeJpeg(image, quality = 0.92) {
  encCanvas = encCanvas || document.createElement('canvas');
  paint(encCanvas, image);
  return new Promise((resolve, reject) => {
    encCanvas.toBlob((b) => {
      // Release the backing store; iOS limits total canvas memory.
      encCanvas.width = 1; encCanvas.height = 1;
      if (b) resolve(b); else reject(new Error('Could not encode the image'));
    }, 'image/jpeg', quality);
  });
}

/** Decode an image Blob/File to {width, height, data}, capped in size. */
export async function decodeImage(blob, maxPixels = 16e6) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (e) {
    bmp = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This file could not be opened as an image')); };
      img.src = url;
    });
  }
  const w0 = bmp.width, h0 = bmp.height;
  const k = Math.min(1, Math.sqrt(maxPixels / (w0 * h0)));
  const w = Math.round(w0 * k), h = Math.round(h0 * k);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  const data = ctx.getImageData(0, 0, w, h);
  c.width = 1; c.height = 1;
  return { width: w, height: h, data: data.data };
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Share files with the OS share sheet (e.g. "Save to Photos"), else download. */
export async function shareOrDownload(files, zipName) {
  const list = files.map((f) => new File([f.blob], f.name, { type: f.blob.type || 'image/jpeg' }));
  if (navigator.canShare && navigator.canShare({ files: list })) {
    try {
      await navigator.share({ files: list });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  if (files.length === 1) { download(files[0].blob, files[0].name); return 'downloaded'; }
  const { makeZip } = await import('./zip.js');
  download(await makeZip(files), zipName || 'scans.zip');
  return 'downloaded';
}

export function fileNameFor(rec, idx) {
  const d = new Date(rec.created);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const when = rec.meta && rec.meta.date ? String(rec.meta.date).replace(/[^\d-]/g, '') + '_' : '';
  const cap = rec.meta && rec.meta.caption ? '_' + rec.meta.caption.trim().slice(0, 40).replace(/[^\p{L}\p{N} _-]+/gu, '').replace(/\s+/g, '-') : '';
  return `${when}Scan_${stamp}${idx ? '_' + idx : ''}${cap}.jpg`;
}

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function formatBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export const vibrate = (ms) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* ignore */ } };
