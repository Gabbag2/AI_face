// unit.js - checks the math with situations where we know the right answer.

import { symmetricEigen, quatToMatrix, matVec, length, sub, DEG } from '../js/math3d.js';
import { PoseEstimator, projectPoint } from '../js/pose.js';
import { Head, solvePlacement } from '../js/headModel.js';
import { buildSensor } from '../js/sensor.js';
import { HEAD_MODEL } from '../js/headModelData.js';
import { DEFAULT_SENSOR } from '../js/config.js';

const out = document.getElementById('out');
let failures = 0;

function check(name, ok, detail = '') {
  if (!ok) failures++;
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`;
  out.insertAdjacentHTML('beforeend', `<div class="${ok ? 'pass' : 'fail'}">${line}</div>`);
  console.log(line);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ------------------------------------------------------------ eigenvectors --
{
  const { values, vectors } = symmetricEigen([[2, 1], [1, 2]]);   // eigenvalues 3 and 1
  const i = values.indexOf(Math.max(...values));
  check('eigen: 2x2 largest eigenvalue is 3', near(values[i], 3, 1e-9), values.join(', '));
  check('eigen: its eigenvector is (1,1)/sqrt2', near(Math.abs(vectors[i][0]), Math.SQRT1_2, 1e-9));

  const A = [[4, 1, 2, 0.5], [1, 3, 0, 1], [2, 0, 5, 2], [0.5, 1, 2, 1]];
  const r = symmetricEigen(A);
  let worst = 0;
  r.values.forEach((lambda, k) => {                  // check A v = lambda v
    const v = r.vectors[k];
    for (let row = 0; row < 4; row++) {
      const Av = A[row].reduce((sum, a, col) => sum + a * v[col], 0);
      worst = Math.max(worst, Math.abs(Av - lambda * v[row]));
    }
  });
  check('eigen: 4x4 A*v = lambda*v', worst < 1e-9, `max error ${worst.toExponential(1)}`);
}

// --------------------------------------------------------------- rotations --
{
  const q = [Math.cos(45 * DEG), 0, 0, Math.sin(45 * DEG)];      // 90 deg around z
  const v = matVec(quatToMatrix(q), [1, 0, 0]);
  check('quaternion: 90 deg about z turns x into y', near(v[0], 0, 1e-12) && near(v[1], 1, 1e-12));
}

// ------------------------------------------------------------ pose (Horn) --
// Make fake landmarks: take the model face, turn it by a known rotation,
// scale it, move it, then check that the estimator finds the same values.
function rotation(yaw, pitch, roll) {
  const [a, b, c] = [yaw * DEG, pitch * DEG, roll * DEG];
  const Ry = [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
  const Rx = [1, 0, 0, 0, Math.cos(b), -Math.sin(b), 0, Math.sin(b), Math.cos(b)];
  const Rz = [Math.cos(c), -Math.sin(c), 0, Math.sin(c), Math.cos(c), 0, 0, 0, 1];
  const mul = (A, B) => [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j]));
  // head frame (x left, y up, z out of face) -> camera (x right, y down, z away): flip y and z
  return mul([1, 0, 0, 0, -1, 0, 0, 0, -1], mul(Ry, mul(Rx, Rz)));
}
{
  const W = 1280, H = 720, s = 2.5, R = rotation(25, -10, 8), shift = [640, 380, 0];
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const place = (p) => { const r = matVec(R, p); return { x: (s * r[0] + shift[0]) / W, y: (s * r[1] + shift[1]) / H, z: (s * r[2]) / W }; };
  for (const m of HEAD_MODEL.procrustes) landmarks[m.index] = place(m.pos);
  // fake irises: 11.7 mm circles around the eye corners
  [[469, 470, 471, 472, 33], [474, 475, 476, 477, 263]].forEach(([a, b, c, d, eye]) => {
    const e = HEAD_MODEL.procrustes.find((m) => m.index === eye).pos;
    landmarks[a] = place([e[0] + 5.85, e[1], e[2]]); landmarks[c] = place([e[0] - 5.85, e[1], e[2]]);
    landmarks[b] = place([e[0], e[1] + 5.85, e[2]]); landmarks[d] = place([e[0], e[1] - 5.85, e[2]]);
  });
  const pose = new PoseEstimator().update(landmarks, W, H, 0);
  const worstR = Math.max(...pose.R.map((v, i) => Math.abs(v - R[i])));
  check('pose: finds the rotation', worstR < 1e-6, `max error ${worstR.toExponential(1)}`);
  check('pose: finds the scale (px/mm)', near(pose.s, s, 1e-6), pose.s.toFixed(6));
  check('pose: fit error ~0 px', pose.rmsPx < 1e-6, pose.rmsPx.toExponential(1));
  const flat = { ...pose, distanceMm: 1e12 };        // no perspective, like the fake data
  const nz = projectPoint(flat, [0, 0, 0]);
  const expected = place([0, 0, 0]);
  check('pose: nasion projected where expected', near(nz.x, expected.x * W, 1e-6) && near(nz.y, expected.y * H, 1e-6));
  check('pose: iris diameter measured (px)', pose.irisPx !== null && near(pose.irisPx, 11.7 * s, 0.5), String(pose.irisPx));
  const persp = projectPoint(pose, HEAD_MODEL.eeg.F7);
  const weak = projectPoint(flat, HEAD_MODEL.eeg.F7);
  check('pose: perspective pulls far points toward the face centre',
    Math.abs(persp.x - pose.imageCenter[0]) < Math.abs(weak.x - pose.imageCenter[0]));
}

// -------------------------------------------------------------------- head --
{
  const head = new Head();
  const back = head.toChart(head.chartPoint(23, 17));
  check('head: chart round trip', near(back.u, 23, 1e-9) && near(back.v, 17, 1e-9));

  const pl = { ...head.toChart(head.eeg.Fpz), psi: 10 * DEG };
  const p = head.drape(pl, 30, 12);
  check('head: draping keeps distance from the centre',
    near(head.skinDistance(head.chartPoint(pl.u, pl.v), p), Math.hypot(30, 12), 1e-6));
  const right = head.drape({ ...pl, psi: 0 }, 20, 0);
  check('head: +s goes toward the subject\'s left (x > 0)', right[0] > 0);

  // The reason for this particular map: a straight strip pressed on the
  // forehead must stay a straight horizontal line on the map, otherwise the
  // detector cannot match it with a flat template.
  {
    const level = { u: 0, v: 20, psi: 0 };
    let worst = 0;
    for (const s of [-55, -30, -10, 10, 30, 55]) {
      const onMap = head.toChart(head.drape(level, s, 0));
      worst = Math.max(worst, Math.abs(onMap.v - level.v), Math.abs(onMap.u - s));
    }
    check('head: a straight strip stays straight on the map', worst < 1e-9, `${worst.toExponential(1)} mm`);
  }

  const e = head.skinDistance(head.eeg.Fp1, head.eeg.Fp2) / 2;   // a sensor that fits exactly
  const placement = solvePlacement(head, { left: 'Fp1', right: 'Fp2' }, { left: { s: e, t: 0 }, right: { s: -e, t: 0 } });
  const worst = Math.max(...placement.electrodes.map((x) => x.errorMm));
  check('solver: perfectly sized sensor hits Fp1/Fp2', worst < 0.3, `${worst.toFixed(3)} mm`);
  check('solver: symmetric result (centre on midline, not rotated)',
    near(placement.u, 0, 0.05) && near(placement.psi, 0, 1e-3));

  head.setScale(1.1);
  check('head: scaling moves EEG points away from the nasion',
    near(length(head.eeg.Fpz), 1.1 * length(HEAD_MODEL.eeg.Fpz), 1e-9));
}

// ------------------------------------------------------------------ sensor --
{
  const sensor = buildSensor(DEFAULT_SENSOR, 1);
  check('sensor: template has pod, strip and ring samples',
    sensor.template.pod.length > 30 && sensor.template.stripLeft.length > 15
    && sensor.template.stripLeft.length === sensor.template.stripRight.length && sensor.template.ring.length > 30,
    `${sensor.template.pod.length}/${sensor.template.stripLeft.length}+${sensor.template.stripRight.length}/${sensor.template.ring.length}`);
  check('sensor: left strip samples are on the +s side',
    sensor.template.stripLeft.every(([s]) => s > 0) && sensor.template.stripRight.every(([s]) => s < 0));
  check('sensor: left electrode on the +s side',
    sensor.electrodes.left.s > 0 && near(sensor.electrodes.left.s, DEFAULT_SENSOR.electrodeOffset, 1e-9));
  const half = buildSensor(DEFAULT_SENSOR, 0.5);
  check('sensor: toModel scales everything', near(half.electrodes.left.s, DEFAULT_SENSOR.electrodeOffset / 2, 1e-9));
  const d = length(sub([...sensor.pod[0], 0], [0, 0, 0]));
  check('sensor: pod outline is around the centre', d > 5 && d < 20);
}

out.insertAdjacentHTML('beforeend', `<h2 class="${failures ? 'fail' : 'pass'}">${failures ? failures + ' FAILED' : 'ALL PASSED'}</h2>`);
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
window.__testsDone = true;
