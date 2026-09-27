// Editor: corners, rotation, restoration looks, fine adjustments and details.
import { $, $$, toast, paint, showBusy, hideBusy, confirmDialog } from './util.js';
import { getSettings } from './settings.js';
import { saveDoc } from './saver.js';
import { exifDate } from './exif.js';

const ADJUST = [
  ['brightness', 'Brightness'],
  ['contrast', 'Contrast'],
  ['shadows', 'Shadows'],
  ['highlights', 'Highlights'],
  ['saturation', 'Saturation'],
  ['warmth', 'Warmth'],
];

const PRESETS = [
  ['none', 'Original'],
  ['auto', 'Auto'],
  ['restore', 'Restore faded'],
  ['bw', 'Black & white'],
];

export class Editor {
  constructor(app) {
    this.app = app;
    this.worker = app.worker;
    this.root = $('#view-editor');
    this.stage = $('#ed-stage');
    this.canvas = $('#ed-canvas');
    this.compareCanvas = $('#ed-compare-canvas');
    this.cropCanvas = $('#ed-crop');
    this.spinner = $('#ed-spinner');
    this.tab = 'enhance';
    this.buildControls();

    $('#ed-back').onclick = () => this.cancel();
    $('#ed-save').onclick = () => this.save();
    $$('.ed-tabs button').forEach((b) => { b.onclick = () => this.setTab(b.dataset.tab); });
    $('#rot-left').onclick = () => { this.doc.params.rotation = (this.doc.params.rotation + 3) % 4; this.changed(); };
    $('#rot-right').onclick = () => { this.doc.params.rotation = (this.doc.params.rotation + 1) % 4; this.changed(); };
    $('#rot-flip').onclick = () => { this.doc.params.flip = !this.doc.params.flip; this.changed(); };
    $('#crop-auto').onclick = () => { this.cropQuad = this.doc.info.autoQuad.map((p) => p.slice()); this.drawCrop(); };
    $('#crop-full').onclick = () => {
      const w = this.doc.info.baseWidth, h = this.doc.info.baseHeight;
      this.cropQuad = [[0, 0], [w, 0], [w, h], [0, h]];
      this.drawCrop();
    };
    $('#crop-apply').onclick = () => this.setTab('enhance');
    $('#adj-reset').onclick = () => {
      ADJUST.forEach(([k]) => { this.doc.params[k] = 0; });
      this.syncControls();
      this.changed();
    };
    $('#meta-date').oninput = (e) => {
      this.doc.meta.date = e.target.value.trim();
      const bad = this.doc.meta.date && !exifDate(this.doc.meta.date);
      $('#meta-date-hint').textContent = bad ? 'Use a year like 1987, or 1987-06 or 1987-06-14' : 'Photo apps will sort the scan under this date';
      $('#meta-date-hint').classList.toggle('bad', !!bad);
      this.dirty = true;
    };
    $('#meta-caption').oninput = (e) => { this.doc.meta.caption = e.target.value; this.dirty = true; };

    const cmp = $('#ed-compare');
    const on = (e) => { e.preventDefault(); this.showCompare(true); };
    const off = () => this.showCompare(false);
    cmp.addEventListener('pointerdown', on);
    cmp.addEventListener('pointerup', off);
    cmp.addEventListener('pointerleave', off);
    cmp.addEventListener('pointercancel', off);
    cmp.addEventListener('contextmenu', (e) => e.preventDefault());

    this.bindCropPointer();
    new ResizeObserver(() => { if (this.tab === 'crop' && this.doc) this.drawCrop(); }).observe(this.stage);
  }

  buildControls() {
    const chips = $('#preset-chips');
    chips.innerHTML = PRESETS.map(([k, label]) => `<button class="chip" data-preset="${k}">${label}</button>`).join('');
    chips.querySelectorAll('.chip').forEach((c) => {
      c.onclick = () => { this.doc.params.preset = c.dataset.preset; this.syncControls(); this.changed(); };
    });
    const mk = (key, label, min, max) => `
      <label class="slider"><span class="slider-label">${label}</span>
        <input type="range" min="${min}" max="${max}" step="1" data-param="${key}">
        <output data-out="${key}">0</output></label>`;
    $('#adjust-sliders').innerHTML = ADJUST.map(([k, l]) => mk(k, l, -100, 100)).join('');
    $('#enhance-sliders').innerHTML = mk('dust', 'Dust &amp; scratches', 0, 100) + mk('sharpness', 'Sharpen', 0, 100);
    $$('input[data-param]', this.root).forEach((inp) => {
      inp.oninput = () => {
        this.doc.params[inp.dataset.param] = +inp.value;
        $(`output[data-out="${inp.dataset.param}"]`, this.root).textContent = inp.value;
        this.changed();
      };
      // Double-tap a slider to reset it.
      inp.ondblclick = () => { inp.value = 0; inp.oninput(); };
    });
  }

  syncControls() {
    const p = this.doc.params;
    $$('#preset-chips .chip').forEach((c) => c.classList.toggle('on', c.dataset.preset === p.preset));
    $$('input[data-param]', this.root).forEach((inp) => {
      inp.value = p[inp.dataset.param] || 0;
      $(`output[data-out="${inp.dataset.param}"]`, this.root).textContent = inp.value;
    });
    $('#meta-date').value = this.doc.meta.date || '';
    $('#meta-caption').value = this.doc.meta.caption || '';
    $('#meta-date').oninput({ target: $('#meta-date') });
    this.dirty = false;
  }

  /**
   * doc: { itemId, info, params, meta, recordId?, created?, baseBlob?, isNew }
   * handlers: { onSaved(rec), onClose(saved) }
   */
  open(doc, handlers = {}) {
    this.doc = doc;
    this.doc.meta = this.doc.meta || { date: '', caption: '' };
    this.doc.quad = (doc.quad || doc.info.quad).map((p) => p.slice());
    this.handlers = handlers;
    this.lastImage = null;
    this.compareImage = null;
    this.canvas.width = 1;
    this.canvas.height = 1;
    $('#ed-title').textContent = doc.recordId ? 'Edit scan' : 'New scan';
    this.syncControls();
    this.dirty = !!doc.isNew;
    this.setTab('enhance');
    this.updateInfo();
    this.render();
  }

  previewSize() {
    const r = this.stage.getBoundingClientRect();
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    return Math.max(480, Math.min(1800, Math.round(Math.max(r.width, r.height) * dpr)));
  }

  changed() {
    this.dirty = true;
    this.compareImage = null;
    this.render();
  }

  render() {
    if (!this.doc) return;
    if (this.rendering) { this.pending = true; return; }
    this.rendering = true;
    this.pending = false;
    const s = getSettings();
    const t = setTimeout(() => { this.spinner.hidden = false; }, 250);
    this.worker.call('itemRender', {
      id: this.doc.itemId, params: this.doc.params, maxSide: this.previewSize(), outputMax: s.outputMax, snap: s.snap,
    }).then((r) => {
      this.lastImage = r.image;
      paint(this.canvas, r.image);
    }).catch((e) => toast('Preview failed: ' + e.message))
      .finally(() => {
        clearTimeout(t);
        this.spinner.hidden = true;
        this.rendering = false;
        if (this.pending) this.render();
      });
  }

  async showCompare(on) {
    if (!this.doc || this.tab === 'crop') return;
    this.comparing = on;
    if (!on) { this.compareCanvas.hidden = true; this.canvas.hidden = false; return; }
    if (!this.compareImage) {
      const s = getSettings();
      const p = { preset: 'none', rotation: this.doc.params.rotation, flip: this.doc.params.flip };
      try {
        const r = await this.worker.call('itemRender', { id: this.doc.itemId, params: p, maxSide: this.previewSize(), outputMax: s.outputMax, snap: s.snap });
        this.compareImage = r.image;
      } catch (e) { return; }
    }
    if (!this.comparing) return;
    paint(this.compareCanvas, this.compareImage);
    this.compareCanvas.hidden = false;
    this.canvas.hidden = true;
  }

  updateInfo() {
    const i = this.doc.info;
    const s = getSettings();
    const long = Math.min(s.outputMax, Math.max(i.naturalWidth, i.naturalHeight));
    const k = long / Math.max(i.naturalWidth, i.naturalHeight);
    let w = Math.round(i.naturalWidth * k), h = Math.round(i.naturalHeight * k);
    if (this.doc.params.rotation % 2) [w, h] = [h, w];
    $('#meta-info').textContent = `Saved size about ${w} × ${h} px${i.detected ? '' : ' · edges not found automatically, check the corners'}`;
  }

  /* ---------------- tabs ---------------- */

  async setTab(tab) {
    if (this.tab === 'crop' && tab !== 'crop') await this.applyCrop();
    this.tab = tab;
    $$('.ed-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    $$('.ed-panel').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
    const crop = tab === 'crop';
    this.cropCanvas.hidden = !crop;
    this.canvas.hidden = crop;
    this.compareCanvas.hidden = true;
    $('#ed-compare').hidden = crop;
    if (crop) await this.enterCrop();
  }

  async enterCrop() {
    this.cropQuad = this.doc.quad.map((p) => p.slice());
    if (!this.baseCanvas || this.baseFor !== this.doc.itemId) {
      this.spinner.hidden = false;
      try {
        const r = await this.worker.call('itemBase', { id: this.doc.itemId, maxSide: 1600 });
        this.baseCanvas = this.baseCanvas || document.createElement('canvas');
        paint(this.baseCanvas, r.image);
        this.baseScale = r.scale;
        this.baseFor = this.doc.itemId;
      } catch (e) {
        toast('Could not load the photo: ' + e.message);
      } finally {
        this.spinner.hidden = true;
      }
    }
    this.buildViewCanvas();
    this.drawCrop();
  }

  // The crop view shows the photo turned the same way as the result.
  buildViewCanvas() {
    if (!this.baseCanvas) return;
    const r = ((this.doc.params.rotation || 0) % 4 + 4) % 4;
    const flip = !!this.doc.params.flip;
    const bw = this.baseCanvas.width, bh = this.baseCanvas.height;
    const vw = r % 2 ? bh : bw, vh = r % 2 ? bw : bh;
    this.view = { r, flip, bw, bh, vw, vh };
    this.viewCanvas = this.viewCanvas || document.createElement('canvas');
    this.viewCanvas.width = vw;
    this.viewCanvas.height = vh;
    const ctx = this.viewCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (flip) { ctx.translate(vw, 0); ctx.scale(-1, 1); }
    if (r === 1) { ctx.translate(bh, 0); ctx.rotate(Math.PI / 2); }
    if (r === 2) { ctx.translate(bw, bh); ctx.rotate(Math.PI); }
    if (r === 3) { ctx.translate(0, bw); ctx.rotate(-Math.PI / 2); }
    ctx.drawImage(this.baseCanvas, 0, 0);
  }

  // Base-preview pixel <-> oriented view pixel.
  toView(p) {
    const { r, flip, bw, bh, vw } = this.view;
    let q;
    if (r === 0) q = [p[0], p[1]];
    else if (r === 1) q = [bh - p[1], p[0]];
    else if (r === 2) q = [bw - p[0], bh - p[1]];
    else q = [p[1], bw - p[0]];
    if (flip) q[0] = vw - q[0];
    return q;
  }

  fromView(q) {
    const { r, flip, bw, bh, vw } = this.view;
    const u = flip ? vw - q[0] : q[0], v = q[1];
    if (r === 0) return [u, v];
    if (r === 1) return [v, bh - u];
    if (r === 2) return [bw - u, bh - v];
    return [bw - v, u];
  }

  async applyCrop() {
    const q = this.cropQuad;
    if (!q || JSON.stringify(q) === JSON.stringify(this.doc.quad)) return;
    try {
      const info = await this.worker.call('itemSetQuad', { id: this.doc.itemId, quad: q });
      this.doc.quad = q.map((p) => p.slice());
      this.doc.info = { ...this.doc.info, naturalWidth: info.naturalWidth, naturalHeight: info.naturalHeight };
      this.updateInfo();
      this.changed();
    } catch (e) {
      toast(e.message);
    }
  }

  /* ---------------- crop drawing & interaction ---------------- */

  cropLayout() {
    const r = this.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const pad = 30;
    const bw = this.viewCanvas ? this.viewCanvas.width : 1, bh = this.viewCanvas ? this.viewCanvas.height : 1;
    const f = Math.min((r.width - pad * 2) / bw, (r.height - pad * 2) / bh);
    return {
      dpr, cssW: r.width, cssH: r.height, f,
      ox: (r.width - bw * f) / 2, oy: (r.height - bh * f) / 2,
      k: this.baseScale || 1,
    };
  }

  toCss(L, p) {
    const v = this.toView([p[0] * L.k, p[1] * L.k]);
    return [L.ox + v[0] * L.f, L.oy + v[1] * L.f];
  }

  fromCss(L, p) {
    const b = this.fromView([(p[0] - L.ox) / L.f, (p[1] - L.oy) / L.f]);
    return [b[0] / L.k, b[1] / L.k];
  }

  drawCrop() {
    if (!this.viewCanvas || !this.cropQuad) return;
    const L = this.cropLayout();
    const c = this.cropCanvas;
    const W = Math.round(L.cssW * L.dpr), H = Math.round(L.cssH * L.dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = c.getContext('2d');
    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    ctx.clearRect(0, 0, L.cssW, L.cssH);
    const bw = this.viewCanvas.width * L.f, bh = this.viewCanvas.height * L.f;
    ctx.drawImage(this.viewCanvas, L.ox, L.oy, bw, bh);
    const pts = this.cropQuad.map((p) => this.toCss(L, p));
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.ox, L.oy, bw, bh);
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill('evenodd');
    ctx.restore();
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#8ab4ff';
    ctx.stroke();
    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p[0], p[1], this.dragIdx === i ? 14 : 11, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#8ab4ff';
      ctx.stroke();
    });
    if (this.dragIdx !== null && this.dragIdx !== undefined) this.drawLoupe(ctx, L, pts[this.dragIdx]);
  }

  drawLoupe(ctx, L, p) {
    const R = 62, zoom = 3;
    const left = p[0] > L.cssW / 2;
    const cx = left ? R + 12 : L.cssW - R - 12, cy = R + 12;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    const z = L.f * zoom;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.viewCanvas, cx - (p[0] - L.ox) * zoom, cy - (p[1] - L.oy) * zoom, this.viewCanvas.width * z, this.viewCanvas.height * z);
    // Quad edges inside the loupe.
    const pts = this.cropQuad.map((q) => this.toCss(L, q)).map((q) => [cx + (q[0] - p[0]) * zoom, cy + (q[1] - p[1]) * zoom]);
    ctx.beginPath();
    pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
    ctx.closePath();
    ctx.strokeStyle = '#8ab4ff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy); ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  bindCropPointer() {
    const c = this.cropCanvas;
    this.dragIdx = null;
    const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    c.addEventListener('pointerdown', (e) => {
      if (!this.cropQuad) return;
      const L = this.cropLayout();
      const p = pos(e);
      let best = null, bd = 44;
      this.cropQuad.forEach((q, i) => {
        const s = this.toCss(L, q);
        const d = Math.hypot(s[0] - p[0], s[1] - p[1]);
        if (d < bd) { bd = d; best = i; }
      });
      if (best === null) return;
      this.dragIdx = best;
      const s = this.toCss(L, this.cropQuad[best]);
      this.dragOffset = [s[0] - p[0], s[1] - p[1]];
      c.setPointerCapture(e.pointerId);
      this.drawCrop();
    });
    c.addEventListener('pointermove', (e) => {
      if (this.dragIdx === null) return;
      const L = this.cropLayout();
      const p = pos(e);
      const q = this.fromCss(L, [p[0] + this.dragOffset[0], p[1] + this.dragOffset[1]]);
      const w = this.doc.info.baseWidth, h = this.doc.info.baseHeight;
      q[0] = Math.max(0, Math.min(w, q[0]));
      q[1] = Math.max(0, Math.min(h, q[1]));
      this.cropQuad[this.dragIdx] = q;
      this.drawCrop();
    });
    const end = () => { if (this.dragIdx !== null) { this.dragIdx = null; this.drawCrop(); } };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  /* ---------------- save / cancel ---------------- */

  async save() {
    if (this.tab === 'crop') await this.applyCrop();
    showBusy('Saving…', 0);
    try {
      const rec = await saveDoc(this.worker, this.doc, (v) => showBusy('Saving…', v));
      hideBusy();
      this.worker.call('itemDelete', { id: this.doc.itemId }).catch(() => {});
      const h = this.handlers;
      this.doc = null;
      if (h.onSaved) h.onSaved(rec);
    } catch (e) {
      hideBusy();
      toast('Saving failed: ' + e.message, 4000);
    }
  }

  async cancel() {
    if (!this.doc) return;
    if (this.dirty && !this.doc.keepOnCancel) {
      const msg = this.doc.recordId ? 'Discard your changes?' : 'Discard this scan?';
      if (!(await confirmDialog(msg, 'Discard', true))) return;
    }
    const h = this.handlers;
    const doc = this.doc;
    this.doc = null;
    if (h.onCancel) h.onCancel(doc);
  }
}
