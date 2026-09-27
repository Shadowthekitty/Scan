// Camera access: live preview plus full-resolution and downscaled frame grabs.
export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.small = document.createElement('canvas');
    this.smallCtx = this.small.getContext('2d', { willReadFrequently: true });
    this.full = document.createElement('canvas');
  }

  static supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  async start(quality = 'high') {
    this.stop();
    const size = quality === 'high'
      ? { width: { ideal: 3840 }, height: { ideal: 2880 } }
      : { width: { ideal: 1920 }, height: { ideal: 1440 } };
    const attempts = [
      { video: { facingMode: { ideal: 'environment' }, ...size }, audio: false },
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
      { video: true, audio: false },
    ];
    let lastErr = null;
    for (const c of attempts) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(c);
        break;
      } catch (e) {
        lastErr = e;
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) break;
      }
    }
    if (!this.stream) throw lastErr || new Error('No camera available');
    this.track = this.stream.getVideoTracks()[0];
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play().catch(() => {});
    if (!this.video.videoWidth) {
      await new Promise((resolve) => {
        const done = () => { this.video.removeEventListener('loadedmetadata', done); resolve(); };
        this.video.addEventListener('loadedmetadata', done);
        setTimeout(done, 3000);
      });
    }
    // Prefer continuous autofocus where the browser exposes it.
    try {
      const caps = this.track.getCapabilities ? this.track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) {
        await this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      }
    } catch (e) { /* optional */ }
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    if (this.video) this.video.srcObject = null;
  }

  get active() { return !!(this.stream && this.video.videoWidth); }
  get width() { return this.video.videoWidth; }
  get height() { return this.video.videoHeight; }

  hasTorch() {
    try {
      const caps = this.track && this.track.getCapabilities ? this.track.getCapabilities() : {};
      return !!caps.torch;
    } catch (e) { return false; }
  }

  async setTorch(on) {
    if (!this.track) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      return true;
    } catch (e) { return false; }
  }

  /** Downscaled frame for live analysis. */
  grabSmall(maxSide = 400) {
    const vw = this.width, vh = this.height;
    if (!vw) return null;
    const k = Math.min(1, maxSide / Math.max(vw, vh));
    const w = Math.round(vw * k), h = Math.round(vh * k);
    if (this.small.width !== w) this.small.width = w;
    if (this.small.height !== h) this.small.height = h;
    this.smallCtx.drawImage(this.video, 0, 0, w, h);
    const img = this.smallCtx.getImageData(0, 0, w, h);
    return { width: w, height: h, data: img.data };
  }

  /**
   * Frame for tracking during the guided shots. Sized by the short side so
   * a phone held upright (portrait video) still gives enough detail.
   */
  grabTrack(short = 320, long = 640) {
    const vw = this.width, vh = this.height;
    if (!vw) return null;
    const k = Math.min(1, short / Math.min(vw, vh), long / Math.max(vw, vh));
    return this.grabSmall(Math.round(Math.max(vw, vh) * k));
  }

  /**
   * How much the picture changed since the last call (0-255 scale), from a
   * tiny thumbnail. Uniform brightness changes (auto-exposure) are ignored.
   */
  motion() {
    const vw = this.width, vh = this.height;
    if (!vw) return Infinity;
    const w = 48, h = Math.max(8, Math.round(48 * vh / vw));
    if (!this.tiny) {
      this.tiny = document.createElement('canvas');
      this.tinyCtx = this.tiny.getContext('2d', { willReadFrequently: true });
    }
    if (this.tiny.width !== w || this.tiny.height !== h) { this.tiny.width = w; this.tiny.height = h; this.tinyPrev = null; }
    this.tinyCtx.drawImage(this.video, 0, 0, w, h);
    const d = this.tinyCtx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let i = 0, o = 0; i < g.length; i++, o += 4) g[i] = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
    const prev = this.tinyPrev;
    this.tinyPrev = g;
    if (!prev) return Infinity;
    let mean = 0;
    for (let i = 0; i < g.length; i++) mean += g[i] - prev[i];
    mean /= g.length;
    let diff = 0;
    for (let i = 0; i < g.length; i++) diff += Math.abs(g[i] - prev[i] - mean);
    return diff / g.length;
  }

  /** Full-resolution frame. */
  grabFull() {
    const vw = this.width, vh = this.height;
    if (!vw) return null;
    this.full.width = vw;
    this.full.height = vh;
    const ctx = this.full.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.video, 0, 0, vw, vh);
    const img = ctx.getImageData(0, 0, vw, vh);
    this.full.width = 1;
    this.full.height = 1;
    return { width: vw, height: vh, data: img.data };
  }
}
