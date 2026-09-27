// Guided-capture tracking under handheld conditions: a phone held upright,
// tilting toward each glare dot with hand shake, motion blur, exposure
// drift and a reflection that moves with the camera. Tracking runs at
// 4 updates per second, roughly what a mid-range phone manages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPipeline } from './helpers.mjs';
import { buildScene, handheldRun } from './handheld.mjs';

const { cv, P } = await loadPipeline();

function runScenario(scene, quad, center, opts) {
  let tr = null, lost = 0, n = 0, worst = 0;
  const captured = [false, false, false, false];
  const last = [null, null, null, null];
  for (const fr of handheldRun(cv, P, scene, { quad, center, fps: 4, smallShort: 320, smallLong: 640, ...opts })) {
    if (!tr) {
      tr = P.createTracker(fr.gray, null);
      fr.gray.delete();
      continue;
    }
    const r = P.trackFrame(tr, fr.gray);
    n++;
    const [sw, sh] = fr.size;
    const R = Math.min(sw, sh) * 0.085;
    if (!r) { lost++; last.fill(null); fr.gray.delete(); continue; }
    fr.dotsSmall.forEach((d, k) => {
      const e = P.applyH(r.H, d), t = P.applyH(fr.Htrue, d);
      worst = Math.max(worst, Math.hypot(e[0] - t[0], e[1] - t[1]) / R);
      const inside = Math.hypot(e[0] - sw / 2, e[1] - sh / 2) < R;
      const settled = last[k] && Math.hypot(e[0] - last[k][0], e[1] - last[k][1]) < R * 0.6;
      if (inside && settled) captured[k] = true;
      last[k] = e;
    });
    fr.gray.delete();
  }
  tr.delete();
  return { lost: lost / n, dots: captured.filter(Boolean).length, worst };
}

test('guided capture keeps track of the photo while the phone moves', () => {
  const { scene, quad, center } = buildScene(cv, {});
  const scenarios = [
    { name: 'no glare', glare: null },
    { name: 'glare, blurred tap', glare: { x: 0.5, y: 0.45, r: 0.12, strength: 240 }, tapShake: 20, refTime: 0.35 },
    { name: 'glare off-centre', glare: { x: 0.65, y: 0.35, r: 0.1, strength: 220 } },
  ];
  let total = 0;
  for (const s of scenarios) {
    const r = runScenario(scene, quad, center, { gainAmp: 0.25, blurN: 4, exposure: 0.04, shakeAmp: 1.5, seed: 3, ...s });
    console.log(`${s.name}: lost ${(r.lost * 100).toFixed(0)}% of updates, ${r.dots}/4 dots, worst dot error ${r.worst.toFixed(2)} circle radii`);
    assert.ok(r.lost < 0.1, `${s.name}: tracking rarely lost`);
    assert.ok(r.dots >= 3, `${s.name}: dots reachable`);
    total += r.dots;
  }
  assert.ok(total >= 11, 'nearly all dots captured overall');
  scene.delete();
});
