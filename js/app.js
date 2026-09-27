// App shell: navigation, import, settings and the scan -> edit -> save flow.
import { WorkerClient } from './worker-client.js';
import { $, $$, toast, showBusy, hideBusy, decodeImage, confirmDialog, formatBytes } from './util.js';
import { getSettings, setSetting } from './settings.js';
import { CaptureView } from './capture.js';
import { Editor } from './editor.js';
import { Library, Viewer, Review } from './library.js';
import { defaultParams, saveDoc } from './saver.js';
import { getScan, requestPersistence, storageEstimate, listScans, deleteScan } from './db.js';

const VIEWS = ['library', 'capture', 'review', 'editor', 'viewer'];
export const APP_VERSION = '1.2';

class App {
  constructor() {
    this.worker = new WorkerClient('js/worker.js');
    this.stack = ['library'];
    this.capture = new CaptureView(this);
    this.editor = new Editor(this);
    this.library = new Library(this);
    this.viewer = new Viewer(this);
    this.review = new Review(this);

    $('#btn-scan').onclick = () => this.push('capture');
    $('#btn-import').onclick = () => this.pickFiles();
    $('#btn-empty-scan').onclick = () => this.push('capture');
    $('#file-input').onchange = (e) => this.importFiles([...e.target.files]).finally(() => { e.target.value = ''; });
    $('#btn-settings').onclick = () => this.openSettings();

    history.replaceState({ depth: 1 }, '');
    window.addEventListener('popstate', () => this.onPop());
    document.addEventListener('visibilitychange', () => {
      if (this.top !== 'capture') return;
      const st = this.capture.state;
      if (document.hidden) { if (st === 'aim' || st === 'guided' || st === 'starting') this.capture.close(); }
      else if (st === 'off') this.capture.open();
    });

    // Drag & drop images onto the page to import them.
    document.addEventListener('dragover', (e) => { e.preventDefault(); });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer && e.dataTransfer.files || [])].filter((f) => f.type.startsWith('image/'));
      if (files.length && this.top === 'library') this.importFiles(files);
    });

    this.engineStatus();
    this.library.refresh();
    requestPersistence();
    this.handleLaunchAction();
  }

  get top() { return this.stack[this.stack.length - 1]; }

  async engineStatus() {
    const el = $('#engine');
    el.hidden = false;
    el.textContent = 'Preparing scanner…';
    try {
      await this.worker.ready;
      el.hidden = true;
    } catch (e) {
      el.textContent = 'Scanner engine failed to load: ' + e.message;
    }
  }

  handleLaunchAction() {
    const p = new URLSearchParams(location.search);
    if (p.get('action') === 'scan') this.push('capture');
  }

  /* ---------------- navigation ---------------- */

  show(view) {
    VIEWS.forEach((v) => { $('#view-' + v).hidden = v !== view; });
    document.body.dataset.view = view;
  }

  push(view) {
    const prev = this.top;
    this.leave(prev, false);
    this.stack.push(view);
    history.pushState({ depth: this.stack.length }, '');
    this.show(view);
    this.enter(view);
  }

  // Programmatic close of the current view (no confirmation).
  pop() {
    return new Promise((resolve) => {
      this.popResolve = resolve;
      this.popping = true;
      history.back();
    });
  }

  // Back button in the UI behaves like the system back button.
  back() { history.back(); }

  async onPop() {
    if (this.stack.length <= 1) return;
    const top = this.top;
    if (!this.popping && (top === 'editor' || (top === 'review' && this.review.docs.length))) {
      // Undo the history step, then ask before leaving.
      history.pushState({ depth: this.stack.length }, '');
      if (top === 'editor') { this.editor.cancel(); return; }
      const n = this.review.docs.length;
      if (await confirmDialog(`Discard ${n} unsaved photo${n === 1 ? '' : 's'}?`, 'Discard', true)) {
        this.review.discardAll();
        this.pop();
      }
      return;
    }
    this.popping = false;
    this.stack.pop();
    this.leave(top, true);
    this.show(this.top);
    this.enter(this.top);
    if (this.popResolve) { const r = this.popResolve; this.popResolve = null; r(); }
  }

  enter(view) {
    if (view === 'library') this.library.refresh();
    if (view === 'capture') this.capture.open();
  }

  leave(view, removed) {
    if (view === 'capture') this.capture.close();
    if (view === 'viewer' && removed) this.viewer.close();
  }

  /* ---------------- flows ---------------- */

  pickFiles() { $('#file-input').click(); }

  async importFiles(files) {
    if (!files.length) return;
    const s = getSettings();
    const docs = [];
    try {
      showBusy('Preparing scanner…');
      await this.worker.ready;
      for (let i = 0; i < files.length; i++) {
        showBusy(`Opening ${files.length > 1 ? `${i + 1} of ${files.length}` : 'photo'}…`, i / files.length);
        const img = await decodeImage(files[i]);
        const res = await this.worker.call('importImage', { image: img, multi: s.multi, autoRotate: s.autoRotate },
          { transfer: [img.data.buffer], onProgress: (st, v) => showBusy(`Processing ${files.length > 1 ? `${i + 1} of ${files.length}` : 'photo'}…`, (i + v) / files.length) });
        res.items.forEach((it) => docs.push(this.newDoc(it)));
      }
      hideBusy();
    } catch (e) {
      hideBusy();
      toast('Import failed: ' + e.message, 4000);
      docs.forEach((d) => this.worker.call('itemDelete', { id: d.itemId }).catch(() => {}));
      return;
    }
    this.openDocs(docs, 'import');
  }

  newDoc(info) {
    return {
      itemId: info.id,
      info,
      params: defaultParams(info.suggestedRotation),
      meta: { date: '', caption: '' },
      isNew: true,
    };
  }

  /** Called by the capture screen with freshly processed items. */
  async openResults(items, { source }) {
    const docs = items.map((it) => this.newDoc(it));
    if (source === 'camera' && getSettings().autoSave) {
      try {
        for (let i = 0; i < docs.length; i++) {
          showBusy('Saving…', i / docs.length);
          await saveDoc(this.worker, docs[i]);
          this.worker.call('itemDelete', { id: docs[i].itemId }).catch(() => {});
        }
        hideBusy();
        toast(docs.length > 1 ? `Saved ${docs.length} photos` : 'Saved');
        await this.library.refresh();
        this.capture.open();
        return;
      } catch (e) {
        hideBusy();
        toast('Saving failed: ' + e.message, 4000);
      }
    }
    this.openDocs(docs, source);
  }

  openDocs(docs, source) {
    if (!docs.length) { toast('No photo found'); if (this.top === 'capture') this.capture.open(); return; }
    if (docs.length === 1) {
      this.editDoc(docs[0], source);
    } else {
      docs.forEach((d) => { d.keepOnCancel = true; });
      this.push('review');
      this.review.open(docs, source);
    }
  }

  editDoc(doc, source) {
    const fromReview = this.top === 'review';
    this.push('editor');
    this.editor.open(doc, {
      onSaved: async () => {
        await this.library.refresh();
        if (fromReview) {
          this.review.docSaved(doc);
          toast('Saved');
          await this.pop();
          if (this.review.docs.length) this.review.refresh();
          else this.afterSaved(this.review.source);
          return;
        }
        toast('Saved');
        this.afterSaved(source);
      },
      onCancel: async (d) => {
        if (!fromReview) this.worker.call('itemDelete', { id: d.itemId }).catch(() => {});
        await this.pop();
        if (fromReview) this.review.refresh();
      },
    });
  }

  // After saving: scans from the camera go back to the camera for the next photo.
  async afterSaved(source) {
    await this.pop();
    if (source === 'record' && this.top === 'viewer' && this.viewer.rec) this.viewer.open(this.viewer.rec.id);
  }

  async openViewer(id) {
    this.push('viewer');
    const ok = await this.viewer.open(id);
    if (!ok) await this.pop();
  }

  async editRecord(id) {
    const rec = await getScan(id);
    if (!rec) return;
    showBusy('Opening…');
    try {
      await this.worker.ready;
      const img = await decodeImage(rec.base || rec.image);
      const info = await this.worker.call('itemCreate', {
        image: img,
        quad: rec.base ? rec.quad : null,
        pp: rec.base ? rec.pp : null,
        focal: rec.base ? rec.focal : null,
      }, { transfer: [img.data.buffer] });
      hideBusy();
      const doc = {
        itemId: info.id,
        info,
        params: rec.base ? { ...defaultParams(), ...rec.params } : defaultParams(),
        meta: { ...(rec.meta || {}) },
        recordId: rec.id,
        created: rec.created,
        baseBlob: rec.base || null,
      };
      this.editDoc(doc, 'record');
    } catch (e) {
      hideBusy();
      toast('Could not open the scan: ' + e.message);
    }
  }

  /* ---------------- settings ---------------- */

  async openSettings() {
    const dlg = $('#settings');
    const s = getSettings();
    $$('[data-setting]', dlg).forEach((el) => {
      const k = el.dataset.setting;
      if (el.type === 'checkbox') el.checked = !!s[k];
      else el.value = String(s[k]);
      el.onchange = () => {
        let v = el.type === 'checkbox' ? el.checked : el.value;
        if (typeof s[k] === 'number') v = Number(v);
        setSetting(k, v);
        this.capture.syncToggles();
      };
    });
    const est = await storageEstimate();
    const scans = await listScans().catch(() => []);
    $('#storage-info').textContent = `Version ${APP_VERSION} · ${scans.length} scan${scans.length === 1 ? '' : 's'}` +
      (est ? ` · ${formatBytes(est.usage)} used of ${formatBytes(est.quota)} available` : '');
    $('#settings-delete-all').onclick = async () => {
      if (!scans.length) return;
      if (!(await confirmDialog(`Delete all ${scans.length} scans? This cannot be undone.`, 'Delete all', true))) return;
      for (const r of scans) await deleteScan(r.id);
      dlg.close();
      this.library.refresh();
      toast('Library cleared');
    };
    $('#settings-close').onclick = () => dlg.close();
    dlg.showModal();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('Scan was updated. Close and reopen the app to use the new version.', 6000);
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
