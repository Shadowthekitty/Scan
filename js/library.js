// Library grid, full-screen viewer and multi-select actions.
import { $, $$, toast, confirmDialog, shareOrDownload, fileNameFor, showBusy, hideBusy, formatBytes } from './util.js';
import { listScans, getScan, deleteScan, putScan } from './db.js';
import { withExif, exifDate } from './exif.js';

export class Library {
  constructor(app) {
    this.app = app;
    this.grid = $('#grid');
    this.urls = [];
    this.selected = new Set();
    this.selecting = false;
    this.records = [];

    $('#btn-select').onclick = () => this.setSelecting(!this.selecting);
    $('#sel-cancel').onclick = () => this.setSelecting(false);
    $('#sel-all').onclick = () => {
      if (this.selected.size === this.records.length) this.selected.clear();
      else this.records.forEach((r) => this.selected.add(r.id));
      this.refreshSelection();
    };
    $('#sel-share').onclick = () => this.shareSelected();
    $('#sel-delete').onclick = () => this.deleteSelected();
    this.grid.addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      if (this.suppressClick) { this.suppressClick = false; return; }
      const id = card.dataset.id;
      if (this.selecting) {
        if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
        this.refreshSelection();
      } else {
        this.app.openViewer(id);
      }
    });
    // Long-press starts selection.
    let pressTimer = null;
    this.grid.addEventListener('pointerdown', (e) => {
      this.suppressClick = false;
      const card = e.target.closest('.card');
      if (!card || this.selecting) return;
      pressTimer = setTimeout(() => {
        this.suppressClick = true;
        this.setSelecting(true);
        this.selected.add(card.dataset.id);
        this.refreshSelection();
        pressTimer = null;
      }, 550);
    });
    ['pointerup', 'pointercancel', 'pointerleave', 'pointermove'].forEach((ev) =>
      this.grid.addEventListener(ev, (e) => {
        if (ev === 'pointermove' && e.pointerType === 'mouse') return;
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      }));
  }

  async refresh() {
    let recs = [];
    try {
      recs = await listScans();
    } catch (e) {
      toast('Could not open the library: ' + e.message);
    }
    this.records = recs;
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls = [];
    $('#empty').hidden = recs.length > 0;
    $('#btn-select').hidden = recs.length === 0;
    $('#lib-count').textContent = recs.length ? `${recs.length} scan${recs.length === 1 ? '' : 's'}` : '';
    const frag = document.createDocumentFragment();
    for (const r of recs) {
      const url = URL.createObjectURL(r.thumb || r.image);
      this.urls.push(url);
      const card = document.createElement('button');
      card.className = 'card';
      card.dataset.id = r.id;
      const label = [r.meta && r.meta.date, r.meta && r.meta.caption].filter(Boolean).join(' · ');
      card.setAttribute('aria-label', label || 'Scan');
      card.innerHTML = `<img alt="" loading="lazy" src="${url}">${label ? `<span class="card-label"></span>` : ''}<span class="check"></span>`;
      if (label) card.querySelector('.card-label').textContent = label;
      frag.appendChild(card);
    }
    this.grid.replaceChildren(frag);
    this.app.capture.setLastThumb(recs.length ? this.urls[0] : null);
    this.refreshSelection();
  }

  setSelecting(on) {
    this.selecting = on;
    if (!on) this.selected.clear();
    $('#view-library').classList.toggle('selecting', on);
    $('#select-bar').hidden = !on;
    $('#fab-row').hidden = on;
    this.refreshSelection();
  }

  refreshSelection() {
    $$('.card', this.grid).forEach((c) => c.classList.toggle('picked', this.selected.has(c.dataset.id)));
    $('#sel-count').textContent = `${this.selected.size} selected`;
    $('#sel-share').disabled = $('#sel-delete').disabled = this.selected.size === 0;
  }

  async shareSelected() {
    const ids = [...this.selected];
    if (!ids.length) return;
    showBusy('Preparing…');
    try {
      const files = [];
      for (const id of ids) {
        const r = await getScan(id);
        if (r) files.push({ name: fileNameFor(r), blob: r.image });
      }
      hideBusy();
      const res = await shareOrDownload(files, `scans-${new Date().toISOString().slice(0, 10)}.zip`);
      if (res === 'downloaded') toast(files.length > 1 ? 'Downloaded as a ZIP file' : 'Downloaded');
    } catch (e) {
      hideBusy();
      toast('Could not export: ' + e.message);
    }
  }

  async deleteSelected() {
    const n = this.selected.size;
    if (!n) return;
    if (!(await confirmDialog(`Delete ${n} scan${n === 1 ? '' : 's'}? This cannot be undone.`, 'Delete', true))) return;
    for (const id of this.selected) await deleteScan(id);
    this.setSelecting(false);
    await this.refresh();
    toast(`Deleted ${n} scan${n === 1 ? '' : 's'}`);
  }
}

export class Viewer {
  constructor(app) {
    this.app = app;
    this.img = $('#vw-img');
    this.url = null;
    $('#vw-back').onclick = () => this.app.back();
    $('#vw-share').onclick = () => this.share();
    $('#vw-edit').onclick = () => this.app.editRecord(this.rec.id);
    $('#vw-delete').onclick = () => this.remove();
    $('#vw-info').onclick = () => this.toggleInfo();
    $('#vw-prev').onclick = () => this.step(-1);
    $('#vw-next').onclick = () => this.step(1);
    $('#vw-save-meta').onclick = () => this.saveMeta();
    this.img.addEventListener('dblclick', () => this.img.classList.toggle('zoomed'));
    // Swipe left/right to move between scans.
    let sx = null, sy = null;
    const stage = $('#vw-stage');
    stage.addEventListener('touchstart', (e) => { if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; } }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      if (sx === null || this.img.classList.contains('zoomed')) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) this.step(dx < 0 ? 1 : -1);
      sx = null;
    });
    document.addEventListener('keydown', (e) => {
      if ($('#view-viewer').hidden) return;
      if (e.key === 'ArrowLeft') this.step(-1);
      if (e.key === 'ArrowRight') this.step(1);
    });
  }

  async open(id) {
    const rec = await getScan(id);
    if (!rec) { toast('That scan no longer exists'); return false; }
    this.rec = rec;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(rec.image);
    this.img.classList.remove('zoomed');
    this.img.src = this.url;
    $('#vw-date').value = rec.meta && rec.meta.date || '';
    $('#vw-caption').value = rec.meta && rec.meta.caption || '';
    $('#vw-details').textContent = `${rec.width} × ${rec.height} px · ${formatBytes(rec.bytes || rec.image.size)} · scanned ${new Date(rec.created).toLocaleString()}`;
    const ids = this.app.library.records.map((r) => r.id);
    const i = ids.indexOf(id);
    $('#vw-prev').disabled = i <= 0;
    $('#vw-next').disabled = i < 0 || i >= ids.length - 1;
    return true;
  }

  close() {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.img.removeAttribute('src');
    $('#vw-info-panel').hidden = true;
  }

  step(d) {
    const ids = this.app.library.records.map((r) => r.id);
    const i = ids.indexOf(this.rec && this.rec.id);
    const j = i + d;
    if (i < 0 || j < 0 || j >= ids.length) return;
    this.open(ids[j]);
  }

  toggleInfo() {
    const p = $('#vw-info-panel');
    p.hidden = !p.hidden;
  }

  async share() {
    const res = await shareOrDownload([{ name: fileNameFor(this.rec), blob: this.rec.image }]);
    if (res === 'downloaded') toast('Downloaded');
  }

  async saveMeta() {
    const date = $('#vw-date').value.trim();
    const caption = $('#vw-caption').value;
    if (date && !exifDate(date)) { toast('Use a year like 1987, or 1987-06 or 1987-06-14'); return; }
    const rec = this.rec;
    rec.meta = { ...(rec.meta || {}), date, caption };
    // Rewrite the EXIF block only; the pixels stay untouched.
    rec.image = await withExif(rec.image, { date, description: caption });
    rec.updated = Date.now();
    await putScan(rec);
    toast('Details saved');
    $('#vw-info-panel').hidden = true;
    this.app.library.refresh();
  }

  async remove() {
    if (!(await confirmDialog('Delete this scan? This cannot be undone.', 'Delete', true))) return;
    await deleteScan(this.rec.id);
    toast('Deleted');
    await this.app.library.refresh();
    this.app.back();
  }
}

export class Review {
  constructor(app) {
    this.app = app;
    this.docs = [];
    this.urls = [];
    $('#rv-back').onclick = () => this.app.back();
    $('#rv-save-all').onclick = () => this.saveAll();
    $('#rv-grid').addEventListener('click', (e) => {
      const card = e.target.closest('.rv-card');
      if (!card) return;
      const doc = this.docs.find((d) => String(d.itemId) === card.dataset.id);
      if (!doc) return;
      if (e.target.closest('.rv-remove')) this.removeDoc(doc);
      else this.app.editDoc(doc);
    });
  }

  async open(docs, source) {
    this.docs = docs;
    this.source = source;
    await this.refresh();
  }

  async refresh() {
    $('#rv-title').textContent = `${this.docs.length} photo${this.docs.length === 1 ? '' : 's'} found`;
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls = [];
    const grid = $('#rv-grid');
    grid.replaceChildren();
    const { encodeJpeg } = await import('./util.js');
    const { getSettings } = await import('./settings.js');
    const s = getSettings();
    for (const d of this.docs) {
      const card = document.createElement('div');
      card.className = 'rv-card';
      card.dataset.id = d.itemId;
      card.innerHTML = `<div class="rv-img"></div><button class="rv-remove icon-btn small" aria-label="Remove">✕</button>`;
      grid.appendChild(card);
      try {
        const r = await this.app.worker.call('itemRender', { id: d.itemId, params: d.params, maxSide: 420, outputMax: s.outputMax, snap: s.snap });
        const url = URL.createObjectURL(await encodeJpeg(r.image, 0.85));
        this.urls.push(url);
        card.querySelector('.rv-img').style.backgroundImage = `url("${url}")`;
      } catch (e) { /* keep placeholder */ }
    }
  }

  async removeDoc(doc) {
    this.docs = this.docs.filter((d) => d !== doc);
    this.app.worker.call('itemDelete', { id: doc.itemId }).catch(() => {});
    if (!this.docs.length) { this.app.back(); return; }
    this.refresh();
  }

  docSaved(doc) {
    this.docs = this.docs.filter((d) => d !== doc);
  }

  async saveAll() {
    const { saveDoc } = await import('./saver.js');
    const n = this.docs.length;
    let i = 0;
    try {
      for (const d of this.docs.slice()) {
        showBusy(`Saving ${i + 1} of ${n}…`, i / n);
        await saveDoc(this.app.worker, d, (v) => showBusy(`Saving ${i + 1} of ${n}…`, (i + v) / n));
        this.app.worker.call('itemDelete', { id: d.itemId }).catch(() => {});
        this.docSaved(d);
        i++;
      }
      hideBusy();
      toast(`Saved ${n} photo${n === 1 ? '' : 's'}`);
      this.app.afterSaved(this.source);
    } catch (e) {
      hideBusy();
      toast('Saving failed: ' + e.message, 4000);
      this.refresh();
    }
  }

  discardAll() {
    this.docs.forEach((d) => this.app.worker.call('itemDelete', { id: d.itemId }).catch(() => {}));
    this.docs = [];
  }
}
