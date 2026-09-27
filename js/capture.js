// Capture screen: live photo detection, then guided extra shots for glare removal.
import { Camera } from './camera.js';
import { $, toast, showBusy, hideBusy, vibrate } from './util.js';
import { getSettings, setSetting } from './settings.js';

const LIVE_SIZE = 400;
const DOT_SPREAD = 0.62;
// Keep showing the dots this long after tracking drops out.
const TRACK_GRACE_MS = 1500;

const STAGES = {
  detect: 'Finding the photo…',
  align: 'Aligning shots…',
  merge: 'Removing glare…',
  finish: 'Finishing…',
};

function applyH(H, p) {
  const w = H[6] * p[0] + H[7] * p[1] + H[8];
  return [(H[0] * p[0] + H[1] * p[1] + H[2]) / w, (H[3] * p[0] + H[4] * p[1] + H[5]) / w];
}

export class CaptureView {
  constructor(app) {
    this.app = app;
    this.worker = app.worker;
    this.root = $('#view-capture');
    this.video = $('#cam-video');
    this.overlay = $('#cam-overlay');
    this.ctx = this.overlay.getContext('2d');
    this.hintEl = $('#cam-hint');
    this.progressEl = $('#cam-progress');
    this.camera = new Camera(this.video);
    this.state = 'off';
    this.quads = [];
    this.missed = 0;
    this.running = false;
    this.wakeLock = null;

    $('#cam-close').onclick = () => this.app.back();
    $('#cam-shutter').onclick = () => this.onShutter();
    $('#cam-done').onclick = () => this.finish();
    $('#cam-import').onclick = () => this.app.pickFiles();
    $('#cam-library').onclick = () => this.app.back();
    $('#cam-torch').onclick = () => this.toggleTorch();
    $('#cam-mode').onclick = () => this.toggleMode();
    $('#cam-glare').onclick = () => this.toggleGlare();
    this.syncToggles();
  }

  syncToggles() {
    const s = getSettings();
    $('#cam-mode-label').textContent = s.multi ? 'Album page' : 'Single photo';
    $('#cam-mode').classList.toggle('on', s.multi);
    $('#cam-glare-label').textContent = s.glare ? 'Glare removal on' : 'Glare removal off';
    $('#cam-glare').classList.toggle('on', s.glare);
  }

  toggleMode() {
    if (this.state !== 'aim') return;
    setSetting('multi', !getSettings().multi);
    this.quads = [];
    this.syncToggles();
    toast(getSettings().multi ? 'Album page: finds every photo on the page' : 'Single photo');
  }

  toggleGlare() {
    if (this.state !== 'aim') return;
    setSetting('glare', !getSettings().glare);
    this.syncToggles();
  }

  async toggleTorch() {
    this.torch = !this.torch;
    const ok = await this.camera.setTorch(this.torch);
    if (!ok) { this.torch = false; toast('Flashlight not available'); }
    $('#cam-torch').classList.toggle('on', !!this.torch);
  }

  hint(text) { this.hintEl.textContent = text || ''; this.hintEl.hidden = !text; }

  setLastThumb(url) {
    const btn = $('#cam-library');
    btn.style.backgroundImage = url ? `url("${url}")` : '';
  }

  async open() {
    this.syncToggles();
    this.state = 'starting';
    this.quads = [];
    this.setGuidedUi(false);
    if (!Camera.supported()) {
      this.hint(window.isSecureContext
        ? 'No camera found. You can still import photos.'
        : 'The camera needs a secure (https) connection. You can still import photos.');
      return;
    }
    this.hint('Starting camera…');
    try {
      await this.camera.start(getSettings().camera);
    } catch (e) {
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      this.hint(denied ? 'Camera permission was denied. Allow it in your browser settings, or import photos instead.'
        : 'Could not start the camera. You can still import photos.');
      this.state = 'off';
      return;
    }
    if (this.state !== 'starting') { this.camera.stop(); return; }
    $('#cam-torch').hidden = !this.camera.hasTorch();
    this.hint('Preparing scanner…');
    try {
      await this.worker.ready;
    } catch (e) {
      this.hint('The scanner engine failed to load: ' + e.message);
      return;
    }
    if (this.state !== 'starting') return;
    this.state = 'aim';
    this.hint('Fit the photo in the frame, then tap the button');
    this.requestWakeLock();
    this.startLoop();
  }

  close() {
    this.state = 'off';
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.camera.stop();
    this.torch = false;
    $('#cam-torch').classList.remove('on');
    if (this.sid) { this.worker.call('sessionDrop', { sid: this.sid }).catch(() => {}); this.sid = null; }
    this.worker.call('trackStop').catch(() => {});
    if (this.wakeLock) { this.wakeLock.release().catch(() => {}); this.wakeLock = null; }
  }

  async requestWakeLock() {
    try {
      if ('wakeLock' in navigator) this.wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { /* optional */ }
  }

  /* ---------------- live loop ---------------- */

  startLoop() {
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      this.resizeOverlay();
      this.updateMotion();
      if (this.state === 'aim') this.maybeDetect();
      else if (this.state === 'guided') this.maybeTrack();
      this.draw();
    };
    this.raf = requestAnimationFrame(tick);
  }

  // Smoothed picture motion, with an adaptive floor for noisy or dim scenes.
  updateMotion() {
    // Sample at roughly camera frame rate; comparing two screen refreshes
    // that show the same camera frame would read as "no motion".
    const now = performance.now();
    if (now - (this.lastMotion || 0) < 60) return;
    this.lastMotion = now;
    const m = this.camera.motion();
    if (!isFinite(m)) return;
    this.motionLevel = this.motionLevel === undefined ? m : this.motionLevel * 0.5 + m * 0.5;
    this.motionFloor = Math.min((this.motionFloor || m) * 1.02 + 0.02, this.motionLevel);
    const steady = this.motionLevel < Math.max(3, this.motionFloor * 2);
    this.steadyFrames = steady ? (this.steadyFrames || 0) + 1 : 0;
    if (this.steadyWaiter && (this.steadyFrames >= 3 || performance.now() > this.steadyWaiter.deadline)) {
      const w = this.steadyWaiter;
      this.steadyWaiter = null;
      w.resolve();
    }
  }

  get steady() { return (this.steadyFrames || 0) >= 2; }

  // Resolves once the phone has been still for a few frames (or on timeout).
  waitSteady(maxMs) {
    return new Promise((resolve) => { this.steadyWaiter = { resolve, deadline: performance.now() + maxMs }; });
  }

  resizeOverlay() {
    const r = this.overlay.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (this.overlay.width !== w || this.overlay.height !== h) {
      this.overlay.width = w;
      this.overlay.height = h;
    }
    this.dpr = dpr;
  }

  // Where the video is drawn inside the overlay (object-fit: contain).
  displayRect() {
    const cw = this.overlay.width, ch = this.overlay.height;
    const vw = this.camera.width || 4, vh = this.camera.height || 3;
    const s = Math.min(cw / vw, ch / vh);
    const w = vw * s, h = vh * s;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }

  toScreen(pn) {
    const r = this.displayRect();
    return [r.x + pn[0] * r.w, r.y + pn[1] * r.h];
  }

  maybeDetect() {
    const now = performance.now();
    if (this.detecting || now - (this.lastDetect || 0) < 80) return;
    const img = this.camera.grabSmall(LIVE_SIZE);
    if (!img) return;
    this.detecting = true;
    this.lastDetect = now;
    this.worker.call('detect', { image: img, multi: getSettings().multi }, { transfer: [img.data.buffer] })
      .then((r) => { if (this.state === 'aim') this.updateQuads(r.quads); })
      .catch(() => {})
      .finally(() => { this.detecting = false; });
  }

  updateQuads(found) {
    if (!found.length) {
      this.missed++;
      if (this.missed > 5) this.quads = [];
      return;
    }
    this.missed = 0;
    if (found.length !== this.quads.length) {
      this.quads = found.map((q) => ({ pts: q.pts.map((p) => p.slice()) }));
      return;
    }
    // Smooth corners to keep the outline steady.
    const cen = (pts) => [pts.reduce((a, p) => a + p[0], 0) / 4, pts.reduce((a, p) => a + p[1], 0) / 4];
    const used = new Set();
    this.quads = this.quads.map((old) => {
      const c = cen(old.pts);
      let best = -1, bd = Infinity;
      found.forEach((f, i) => {
        if (used.has(i)) return;
        const fc = cen(f.pts);
        const d = Math.hypot(fc[0] - c[0], fc[1] - c[1]);
        if (d < bd) { bd = d; best = i; }
      });
      used.add(best);
      const f = found[best];
      if (bd > 0.15) return { pts: f.pts.map((p) => p.slice()) };
      return { pts: old.pts.map((p, k) => [p[0] * 0.45 + f.pts[k][0] * 0.55, p[1] * 0.45 + f.pts[k][1] * 0.55]) };
    });
  }

  /* ---------------- drawing ---------------- */

  draw() {
    const ctx = this.ctx;
    const W = this.overlay.width, H = this.overlay.height;
    ctx.clearRect(0, 0, W, H);
    const dpr = this.dpr || 1;
    if (this.state === 'aim' || this.state === 'capturing') {
      for (const q of this.quads) this.drawQuad(q.pts.map((p) => this.toScreen(p)), dpr, 1);
    } else if (this.state === 'guided') {
      const r = this.displayRect();
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const R = Math.min(r.w, r.h) * 0.085;
      const recent = this.H && (this.trackOk || performance.now() - this.lastTrackOk < TRACK_GRACE_MS);
      if (recent) {
        const outline = this.guideQuad.map((p) => this.toScreen([applyH(this.H, p)[0] / this.trackW, applyH(this.H, p)[1] / this.trackH]));
        this.drawQuad(outline, dpr, this.trackOk ? 0.45 : 0.2);
        ctx.globalAlpha = this.trackOk ? 1 : 0.45;
        for (const d of this.dots) {
          if (d.done) continue;
          const q = applyH(this.H, d.p);
          const s = this.toScreen([q[0] / this.trackW, q[1] / this.trackH]);
          d.screen = s;
          ctx.beginPath();
          ctx.arc(s[0], s[1], R * 0.42, 0, Math.PI * 2);
          ctx.fillStyle = d.near ? '#8ab4ff' : 'rgba(255,255,255,0.95)';
          ctx.shadowColor = 'rgba(0,0,0,0.5)';
          ctx.shadowBlur = 8 * dpr;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.lineWidth = 4 * dpr;
      ctx.strokeStyle = this.trackOk ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.4)';
      ctx.stroke();
      const doneCount = this.dots.filter((d) => d.done).length;
      if (doneCount) {
        ctx.beginPath();
        ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * doneCount / this.dots.length);
        ctx.strokeStyle = '#8ab4ff';
        ctx.lineWidth = 6 * dpr;
        ctx.stroke();
      }
    }
  }

  drawQuad(pts, dpr, alpha) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.fillStyle = 'rgba(138,180,255,0.14)';
    ctx.fill();
    ctx.lineWidth = 2.5 * dpr;
    ctx.strokeStyle = '#8ab4ff';
    ctx.stroke();
    // Corner brackets
    ctx.lineWidth = 5 * dpr;
    ctx.strokeStyle = '#ffffff';
    ctx.lineCap = 'round';
    for (let k = 0; k < 4; k++) {
      const p = pts[k], a = pts[(k + 3) % 4], b = pts[(k + 1) % 4];
      const L = 22 * dpr;
      const ua = [a[0] - p[0], a[1] - p[1]], ub = [b[0] - p[0], b[1] - p[1]];
      const la = Math.hypot(...ua) || 1, lb = Math.hypot(...ub) || 1;
      ctx.beginPath();
      ctx.moveTo(p[0] + ua[0] / la * L, p[1] + ua[1] / la * L);
      ctx.lineTo(p[0], p[1]);
      ctx.lineTo(p[0] + ub[0] / lb * L, p[1] + ub[1] / lb * L);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------- capture ---------------- */

  flash() {
    const f = $('#cam-flash');
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
  }

  setGuidedUi(on) {
    $('#cam-done').hidden = !on;
    this.progressEl.hidden = !on;
    $('#cam-mode').disabled = on;
    $('#cam-glare').disabled = on;
    this.root.classList.toggle('guided', on);
  }

  async onShutter() {
    if (this.state === 'aim') return this.startScan();
    // During guided capture the shutter adds a manual extra shot.
    if (this.state === 'guided' && !this.capturingDot) {
      this.capturingDot = true;
      try { await this.addShot(); } finally { this.capturingDot = false; }
      if (this.shots >= 5) this.finish();
    }
  }

  async startScan() {
    this.state = 'capturing';
    // Tapping the button jolts the phone. Wait until it settles so both the
    // main shot and the tracking reference are sharp.
    if (!this.steady) {
      this.hint('Hold still…');
      await this.waitSteady(1000);
      if (this.state !== 'capturing') return;
    }
    const full = this.camera.grabFull();
    const small = this.camera.grabTrack();
    if (!full || !small) { this.state = 'aim'; return; }
    this.flash();
    vibrate(20);
    this.hintQuads = this.quads.map((q) => q.pts.map((p) => p.slice()));
    try {
      if (this.sid) { this.worker.call('sessionDrop', { sid: this.sid }).catch(() => {}); this.sid = null; }
      const { sid } = await this.worker.call('sessionCreate');
      this.sid = sid;
      await this.worker.call('sessionAddFrame', { sid, image: full }, { transfer: [full.data.buffer] });
      this.shots = 1;
      if (!getSettings().glare) { this.finish(); return; }
      this.trackW = small.width;
      this.trackH = small.height;
      this.setupDots();
      // Only a single photo's outline is passed: it lets the tracker prefer
      // features on the print over a plain or patterned table.
      const quad = this.hintQuads.length === 1 ? this.guideQuad : null;
      await this.worker.call('trackStart', { image: small, quad }, { transfer: [small.data.buffer] });
    } catch (e) {
      toast('Capture failed: ' + e.message);
      this.state = 'aim';
      return;
    }
    this.H = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    this.trackOk = true;
    this.lastTrackOk = performance.now();
    this.state = 'guided';
    this.setGuidedUi(true);
    this.updateProgress();
    this.hint('Move your phone so the circle covers each dot');
  }

  // Guide dots sit toward the corners of the photo (or of all photos).
  setupDots() {
    let pts;
    if (this.hintQuads.length === 1) {
      pts = this.hintQuads[0];
    } else if (this.hintQuads.length > 1) {
      const all = this.hintQuads.flat();
      const x0 = Math.min(...all.map((p) => p[0])), x1 = Math.max(...all.map((p) => p[0]));
      const y0 = Math.min(...all.map((p) => p[1])), y1 = Math.max(...all.map((p) => p[1]));
      pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    } else {
      pts = [[0.15, 0.15], [0.85, 0.15], [0.85, 0.85], [0.15, 0.85]];
    }
    const px = pts.map((p) => [p[0] * this.trackW, p[1] * this.trackH]);
    const c = [px.reduce((a, p) => a + p[0], 0) / 4, px.reduce((a, p) => a + p[1], 0) / 4];
    this.guideQuad = px;
    this.dots = px.map((p) => ({ p: [c[0] + (p[0] - c[0]) * DOT_SPREAD, c[1] + (p[1] - c[1]) * DOT_SPREAD], done: false, near: 0, last: null }));
  }

  updateProgress() {
    const done = this.dots ? this.dots.filter((d) => d.done).length : 0;
    this.progressEl.textContent = `${done} of ${this.dots ? this.dots.length : 4}`;
  }

  maybeTrack() {
    if (this.tracking || this.capturingDot) return;
    const img = this.camera.grabTrack();
    if (!img) return;
    this.tracking = true;
    this.worker.call('track', { image: img }, { transfer: [img.data.buffer] })
      .then((r) => this.onTrack(r))
      .catch(() => {})
      .finally(() => { this.tracking = false; });
  }

  async onTrack(r) {
    if (this.state !== 'guided') return;
    const now = performance.now();
    if (!r) {
      this.trackOk = false;
      if (now - this.lastTrackOk > 5000) this.hint('Can\'t follow the photo. Tap the button for each extra shot, or tap Done');
      else if (now - this.lastTrackOk > 1200) this.hint('Point back at the photo');
      this.dots.forEach((d) => { d.near = 0; d.last = null; });
      return;
    }
    if (!this.trackOk) this.hint('Move your phone so the circle covers each dot');
    this.trackOk = true;
    this.lastTrackOk = now;
    this.H = r.H;
    const rect = this.displayRect();
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    const R = Math.min(rect.w, rect.h) * 0.085;
    for (const d of this.dots) {
      if (d.done) continue;
      const q = applyH(this.H, d.p);
      const s = this.toScreen([q[0] / this.trackW, q[1] / this.trackH]);
      const inside = Math.hypot(s[0] - cx, s[1] - cy) < R;
      const settled = d.last && Math.hypot(s[0] - d.last[0], s[1] - d.last[1]) < R * 0.6;
      d.last = s;
      d.near = inside ? d.near + 1 : 0;
      // Take the shot once the dot is inside the circle and the phone is
      // steady, or after it has stayed inside for a few updates anyway.
      if (inside && ((settled && this.steady) || d.near >= 3) && !this.capturingDot) {
        this.capturingDot = true;
        try {
          await this.addShot();
          d.done = true;
          vibrate(35);
        } finally {
          this.capturingDot = false;
        }
        this.updateProgress();
        if (this.dots.every((x) => x.done)) { this.finish(); return; }
        break;
      }
    }
  }

  async addShot() {
    const full = this.camera.grabFull();
    if (!full) return;
    this.flash();
    await this.worker.call('sessionAddFrame', { sid: this.sid, image: full }, { transfer: [full.data.buffer] });
    this.shots++;
  }

  async finish() {
    if (!this.sid || this.state === 'processing') return;
    this.state = 'processing';
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.setGuidedUi(false);
    this.hint('');
    const sid = this.sid;
    this.sid = null;
    this.worker.call('trackStop').catch(() => {});
    this.camera.stop();
    const s = getSettings();
    showBusy(STAGES.detect, 0);
    try {
      const res = await this.worker.call('sessionProcess', {
        sid, multi: s.multi, autoRotate: s.autoRotate, hintQuads: this.hintQuads,
      }, { onProgress: (stage, v) => showBusy(STAGES[stage] || 'Working…', v) });
      hideBusy();
      if (this.shots > 1 && res.usedFrames < this.shots) {
        toast(`Used ${res.usedFrames} of ${this.shots} shots (some could not be aligned)`);
      }
      this.app.openResults(res.items, { source: 'camera' });
    } catch (e) {
      hideBusy();
      toast('Processing failed: ' + e.message, 4000);
      this.open();
    }
  }
}
