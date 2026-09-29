// math3d.js - a tiny 3D math toolbox.
//
// A 3D vector is a plain array [x, y, z].
// A 3x3 matrix is an array of 9 numbers, written row by row:
//     [ m[0] m[1] m[2]
//       m[3] m[4] m[5]
//       m[6] m[7] m[8] ]

export const DEG = Math.PI / 180;   // multiply degrees by DEG to get radians

// ---------------------------------------------------------------- vectors --
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (a) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a) => scale(a, 1 / (length(a) || 1));

// Matrix times vector.
export const matVec = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ------------------------------------------------------------- rotations --
// A unit quaternion [w, x, y, z] is a compact way to store a rotation.
// This turns it into the equivalent 3x3 rotation matrix.
export function quatToMatrix([w, x, y, z]) {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

// ------------------------------------------------------------ eigenvectors --
// Eigen-decomposition of a small SYMMETRIC matrix (given as an array of rows)
// with the Jacobi method: we repeatedly apply tiny rotations that each cancel
// one off-diagonal number, until the matrix is diagonal. The diagonal then
// holds the eigenvalues, and the accumulated rotations hold the eigenvectors.
// Returns { values: [...], vectors: [...] } where vectors[k] is the k-th
// eigenvector (matching values[k]).
export function symmetricEigen(matrix) {
  const n = matrix.length;
  const a = matrix.map((row) => row.slice());                          // working copy
  const v = a.map((_, i) => a.map((_, j) => (i === j ? 1 : 0)));     // identity

  for (let sweep = 0; sweep < 50; sweep++) {
    let offDiagonal = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) offDiagonal += a[p][q] ** 2;
    if (offDiagonal < 1e-22) break;                                    // diagonal: done

    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        // Rotation angle that makes a[p][q] zero (Numerical Recipes, "jacobi").
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {         // a = a * J  (mix columns p and q)
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {         // a = J^T * a  (mix rows p and q)
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {         // v = v * J  (remember the rotation)
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return {
    values: a.map((row, i) => row[i]),
    vectors: a.map((_, k) => v.map((row) => row[k])),                 // column k of v
  };
}

// --------------------------------------------------------------- smoothing --
// One Euro filter (Casiez et al., 2012): removes jitter from a noisy signal
// without adding lag when it moves fast.
//  - When the value is still, it averages a lot (low cutoff frequency).
//  - When the value moves fast, it averages less (cutoff grows with speed).
export class OneEuroFilter {
  constructor(minCutoff = 1.0, beta = 0.0, derivativeCutoff = 1.0) {
    this.minCutoff = minCutoff;   // Hz: smoothing when still (lower = smoother)
    this.beta = beta;             // how quickly smoothing relaxes with speed
    this.derivativeCutoff = derivativeCutoff;
    this.value = null;            // last filtered value
    this.speed = 0;               // filtered speed (units per second)
    this.time = null;             // last time (seconds)
  }

  // Blend factor of an exponential moving average for a given cutoff frequency.
  static alpha(cutoffHz, dt) {
    const tau = 1 / (2 * Math.PI * cutoffHz);
    return 1 / (1 + tau / dt);
  }

  filter(x, timeSec) {
    if (this.value === null) {           // first sample: nothing to smooth yet
      this.value = x;
      this.time = timeSec;
      return x;
    }
    const dt = Math.max(1e-3, timeSec - this.time);
    this.time = timeSec;
    const rawSpeed = (x - this.value) / dt;
    this.speed += OneEuroFilter.alpha(this.derivativeCutoff, dt) * (rawSpeed - this.speed);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.speed);
    this.value += OneEuroFilter.alpha(cutoff, dt) * (x - this.value);
    return this.value;
  }
}

// Median of the last `size` numbers: a very robust average (one crazy value
// cannot move it). Used for slowly-changing measurements like face size.
export class RollingMedian {
  constructor(size) {
    this.size = size;
    this.items = [];
  }

  push(x) {
    this.items.push(x);
    if (this.items.length > this.size) this.items.shift();
  }

  get value() {
    if (this.items.length === 0) return null;
    const sorted = [...this.items].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
}
