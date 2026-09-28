// The gyroscope model learns how phone rotation moves the picture from the
// tracker's results, then predicts that motion between tracking updates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GyroModel, applyH, mul3 } from '../js/motion.js';

const W = 320, H = 640, F = 520, DELAY = 60;

function rot([ax, ay, az]) {
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
  const Rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx], Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy], Rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mul3(Rz, mul3(Rx, Ry));
}
const K = [F, 0, W / 2, 0, F, H / 2, 0, 0, 1], Ki = [1 / F, 0, -W / (2 * F), 0, 1 / F, -H / (2 * F), 0, 0, 1];
const T = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
// Camera angles over time (radians): tilting toward dots, with a little roll.
const angles = (t) => { const s = t / 1000; return [0.16 * Math.sin(1.3 * s), 0.2 * Math.sin(0.9 * s + 1), 0.05 * Math.sin(0.7 * s)]; };
// Picture motion from the reference (time 0) to what the camera shows at t.
const Hat = (t) => mul3(K, mul3(rot(angles(t - DELAY)), mul3(T(rot(angles(-DELAY))), Ki)));

test('gyroscope predicts picture motion between tracking updates', () => {
  const g = new GyroModel(W, H, { storage: null });
  let seed = 3;
  const noise = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5); };
  // Sensor at 60 Hz, reporting in degrees per second around its own axes,
  // which differ from the camera's (swapped, flipped).
  const dt = 1000 / 60;
  let lastTrack = null;
  for (let t = 0; t <= 6000; t += dt) {
    const a = angles(t), b = angles(t + 1);
    const w = [(b[0] - a[0]) * 1000, (b[1] - a[1]) * 1000, (b[2] - a[2]) * 1000].map((v) => v * 180 / Math.PI);
    g.addRate(t, -w[1] + noise() * 0.5, w[0] + noise() * 0.5, -w[2] + noise() * 0.5);
    // Tracking results four times a second.
    if (Math.round(t) % 250 < dt && t > 0) {
      const Ht = Hat(t);
      if (lastTrack) g.observe(lastTrack.t, t, lastTrack.H, Ht);
      lastTrack = { t, H: Ht };
    }
  }
  assert.ok(g.fit, 'learned how rotation moves the picture');
  // Predict from each tracking result to moments before the next one.
  let err = 0, still = 0, n = 0;
  for (let t0 = 3000; t0 < 5800; t0 += 250) {
    for (const ahead of [100, 200, 350]) {
      const p = g.predict(t0, t0 + ahead);
      assert.ok(p, 'prediction available');
      const Hp = mul3(p, Hat(t0)), Ht = Hat(t0 + ahead), H0 = Hat(t0);
      for (const q of [[W * 0.3, H * 0.3], [W * 0.7, H * 0.5], [W * 0.5, H * 0.8]]) {
        const a = applyH(Hp, q), b = applyH(Ht, q), c = applyH(H0, q);
        err += Math.hypot(a[0] - b[0], a[1] - b[1]);
        still += Math.hypot(c[0] - b[0], c[1] - b[1]);
        n++;
      }
    }
  }
  console.log(`gyroscope: dots off by ${(err / n).toFixed(1)} px with prediction, ${(still / n).toFixed(1)} px without (delay found ${g.fit.delay} ms)`);
  assert.ok(err / n < 4, 'prediction keeps the dots in place');
  assert.ok(err / n < still / n / 4, 'much better than waiting for tracking');
});
