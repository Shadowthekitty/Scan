// Phone rotation from the gyroscope, used during guided capture to move the
// dots and outline with the phone between tracking results (a few per second
// on a phone) and through short dropouts. Image tracking stays in charge:
// the gyroscope only fills the gaps.
//
// How rotation shows up in the picture (axes and signs, which differ with
// screen orientation and between browsers; units; the lens; the delay
// between sensor and camera) is not assumed. It is learned from the
// tracker's own results as the phone moves, and remembered for next time.

const STORE_KEY = 'scan.gyroFit';
// Candidate delays (ms) of the camera picture behind the sensor.
const DELAYS = [0, 30, 60, 90, 120, 160];

function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

function mul3(A, B) {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return C;
}

function applyH(H, p) {
  const w = H[6] * p[0] + H[7] * p[1] + H[8];
  return [(H[0] * p[0] + H[1] * p[1] + H[2]) / w, (H[3] * p[0] + H[4] * p[1] + H[5]) / w];
}

// Least squares for y ~ k1 * a + k2 * b.
function solve2(rows) {
  let saa = 0, sab = 0, sbb = 0, say = 0, sby = 0;
  for (const [a, b, y] of rows) { saa += a * a; sab += a * b; sbb += b * b; say += a * y; sby += b * y; }
  const det = saa * sbb - sab * sab;
  if (Math.abs(det) < 1e-12) return null;
  return [(say * sbb - sby * sab) / det, (sby * saa - say * sab) / det];
}

export class GyroModel {
  /**
   * w, h: tracking frame size in pixels (predictions are in those pixels).
   * key: remembers the learned fit per screen orientation.
   */
  constructor(w, h, opts = {}) {
    this.w = w;
    this.h = h;
    this.key = opts.key || '';
    this.storage = opts.storage === undefined ? safeStorage() : opts.storage;
    this.samples = [];   // [t ms, total rotation x, y, z]
    this.last = null;
    this.pairs = [];     // tracked motion between two frames
    this.fit = this.load();
  }

  /** Rotation rate around the device's x, y and z axes (any unit per second). */
  addRate(t, x, y, z) {
    if (![x, y, z].every(Number.isFinite)) return;
    if (!this.last) {
      this.last = { t, x, y, z };
      this.samples.push([t, 0, 0, 0]);
      return;
    }
    const dt = Math.min(0.1, Math.max(0, (t - this.last.t) / 1000));
    const p = this.samples[this.samples.length - 1];
    // Trapezoid rule between the two readings.
    this.samples.push([t, p[1] + (x + this.last.x) / 2 * dt, p[2] + (y + this.last.y) / 2 * dt, p[3] + (z + this.last.z) / 2 * dt]);
    this.last = { t, x, y, z };
    if (this.samples.length > 900) this.samples.splice(0, this.samples.length - 600);
  }

  /** Total rotation at time t (ms), interpolated; null if not covered. */
  rotation(t) {
    const s = this.samples;
    if (s.length < 2 || t < s[0][0]) return null;
    if (t >= s[s.length - 1][0]) {
      // A little past the newest reading: carry on at the current rate.
      const q = s[s.length - 1];
      const ahead = (t - q[0]) / 1000;
      if (ahead > 0.1) return null;
      return [q[1] + this.last.x * ahead, q[2] + this.last.y * ahead, q[3] + this.last.z * ahead];
    }
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (s[mid][0] <= t) lo = mid; else hi = mid; }
    const a = s[lo], b = s[hi], u = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
    return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
  }

  delta(t0, t1) {
    const a = this.rotation(t0), b = this.rotation(t1);
    return a && b ? [b[0] - a[0], b[1] - a[1], b[2] - a[2]] : null;
  }

  /**
   * The tracker saw frame ta (homography Ha) and frame tb (Hb); both map the
   * same reference to the frame. Learn from the picture motion between them.
   */
  observe(ta, tb, Ha, Hb) {
    const Hai = inv3(Ha);
    if (!Hai || tb - ta > 1500 || tb <= ta) return;
    const M = mul3(Hb, Hai);
    const c = [this.w / 2, this.h / 2];
    const m = applyH(M, c);
    const r = Math.min(this.w, this.h) * 0.25;
    const e = applyH(M, [c[0] + r, c[1]]);
    const roll = Math.atan2(e[1] - m[1], e[0] - m[0]);
    this.pairs.push({ ta, tb, dx: m[0] - c[0], dy: m[1] - c[1], roll });
    if (this.pairs.length > 40) this.pairs.shift();
    this.refit();
  }

  refit() {
    let best = null;
    for (const delay of DELAYS) {
      const rows = [];
      for (const p of this.pairs) {
        const d = this.delta(p.ta - delay, p.tb - delay);
        if (d) rows.push({ d, p });
      }
      if (rows.length < 6) continue;
      const fx = solve2(rows.map(({ d, p }) => [d[0], d[1], p.dx]));
      const fy = solve2(rows.map(({ d, p }) => [d[0], d[1], p.dy]));
      if (!fx || !fy) continue;
      let err = 0, tot = 0, rz = 0, zz = 0;
      for (const { d, p } of rows) {
        const px = fx[0] * d[0] + fx[1] * d[1], py = fy[0] * d[0] + fy[1] * d[1];
        err += (px - p.dx) ** 2 + (py - p.dy) ** 2;
        tot += p.dx * p.dx + p.dy * p.dy;
        rz += d[2] * p.roll; zz += d[2] * d[2];
      }
      // How much of the picture motion the rotation explains.
      const explained = tot > 0 ? 1 - err / tot : 0;
      // Needs real movement to learn from, not just hand shake.
      const spread = Math.sqrt(tot / rows.length);
      if (!best || explained > best.explained) {
        best = { delay, ax: fx, ay: fy, roll: zz > 0 ? rz / zz : 0, explained, spread, n: rows.length };
      }
    }
    if (best && best.explained >= 0.6 && best.spread >= Math.min(this.w, this.h) * 0.03) {
      this.fit = best;
      this.save();
    }
  }

  /**
   * Expected picture motion from time t0 to t1 (ms) as a 3x3 matrix in
   * tracking pixels, or null when unknown.
   */
  predict(t0, t1) {
    if (!this.fit) return null;
    const { delay, ax, ay, roll } = this.fit;
    const d = this.delta(t0 - delay, t1 - delay);
    if (!d) return null;
    const dx = ax[0] * d[0] + ax[1] * d[1], dy = ay[0] * d[0] + ay[1] * d[1];
    const a = roll * d[2];
    const cs = Math.cos(a), sn = Math.sin(a);
    const cx = this.w / 2, cy = this.h / 2;
    // Turn about the centre, then shift.
    return [cs, -sn, cx - cs * cx + sn * cy + dx, sn, cs, cy - sn * cx - cs * cy + dy, 0, 0, 1];
  }

  load() {
    try {
      const all = JSON.parse(this.storage && this.storage.getItem(STORE_KEY) || '{}');
      const f = all[this.key];
      // Stored in fractions of the frame, so it fits any tracking size.
      if (!f) return null;
      const k = Math.min(this.w, this.h);
      return { delay: f.delay, ax: f.ax.map((v) => v * k), ay: f.ay.map((v) => v * k), roll: f.roll, explained: f.explained, stored: true };
    } catch (e) {
      return null;
    }
  }

  save() {
    try {
      if (!this.storage) return;
      const all = JSON.parse(this.storage.getItem(STORE_KEY) || '{}');
      const k = Math.min(this.w, this.h);
      const f = this.fit;
      all[this.key] = { delay: f.delay, ax: f.ax.map((v) => v / k), ay: f.ay.map((v) => v / k), roll: f.roll, explained: f.explained };
      this.storage.setItem(STORE_KEY, JSON.stringify(all));
    } catch (e) { /* optional */ }
  }
}

function safeStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
}

export { mul3, applyH, inv3 };

/**
 * Motion sensors in the browser. iPhones ask for permission, which must be
 * requested from a tap: call requestPermission() in the shutter's handler.
 */
export class Gyro {
  constructor() {
    this.model = null;
    this.onMotion = (e) => {
      const r = e.rotationRate;
      if (!r || !this.model) return;
      this.model.addRate(performance.now(), r.beta, r.gamma, r.alpha);
    };
  }

  static requestPermission() {
    try {
      const DM = typeof DeviceMotionEvent !== 'undefined' ? DeviceMotionEvent : null;
      if (DM && typeof DM.requestPermission === 'function') return DM.requestPermission().catch(() => 'denied');
    } catch (e) { /* not available */ }
    return Promise.resolve('granted');
  }

  start(w, h) {
    const angle = (typeof screen !== 'undefined' && screen.orientation && screen.orientation.angle) || (typeof window !== 'undefined' && window.orientation) || 0;
    this.model = new GyroModel(w, h, { key: `${angle}` });
    if (typeof window !== 'undefined' && !this.listening) {
      window.addEventListener('devicemotion', this.onMotion);
      this.listening = true;
    }
    return this.model;
  }

  stop() {
    if (typeof window !== 'undefined' && this.listening) window.removeEventListener('devicemotion', this.onMotion);
    this.listening = false;
    this.model = null;
  }
}
