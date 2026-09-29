// pose.js - where is the head in the image, and how is it turned?
//
// INPUT : the 478 face landmarks from MediaPipe
//         (x, y = position in the image from 0 to 1, z = depth, same scale as x)
// OUTPUT: a "pose": the rotation R and the scale s that best map the
//         average 3D face (head frame, millimetres) onto the landmarks we see
//         (pixels). This is a "Procrustes" fit, solved with Horn's method.
//
// Once we have the pose, ANY point defined in the head frame (an EEG position,
// a corner of the sensor, ...) can be placed in the image: projectPoint().

import { HEAD_MODEL } from './headModelData.js';
import { CAMERA } from './config.js';
import { sub, dot, matVec, quatToMatrix, symmetricEigen, OneEuroFilter, DEG } from './math3d.js';

const MODEL = HEAD_MODEL.procrustes;                       // [{ index, weight, pos }]
const TOTAL_WEIGHT = MODEL.reduce((sum, m) => sum + m.weight, 0);

// Weighted centre of the model points, and the model points measured from it.
const MODEL_CENTER = [0, 1, 2].map(
  (k) => MODEL.reduce((sum, m) => sum + m.weight * m.pos[k], 0) / TOTAL_WEIGHT);
const MODEL_CENTERED = MODEL.map((m) => sub(m.pos, MODEL_CENTER));
const MODEL_SPREAD = MODEL.reduce((sum, m, i) => sum + m.weight * dot(MODEL_CENTERED[i], MODEL_CENTERED[i]), 0);

// Iris landmarks (only in the 478-point model): 4 points on the edge of each iris,
// listed so that [0]-[2] and [1]-[3] are opposite points.
const IRIS_EDGES = [[469, 470, 471, 472], [474, 475, 476, 477]];

// Every landmark we use (they are the ones we smooth over time).
const USED = [...MODEL.map((m) => m.index), ...IRIS_EDGES.flat()];

export class PoseEstimator {
  constructor() {
    this.filters = new Map();   // landmark index -> [filter for x, for y, for z]
  }

  // Forget the past (e.g. after the camera changed).
  reset() {
    this.filters.clear();
  }

  // landmarks: MediaPipe result for one face. width/height: video size (px).
  update(landmarks, width, height, timeSec) {
    // 1. Landmarks in pixels, each coordinate smoothed over time (less jitter).
    const px = new Map();
    for (const i of USED) {
      const raw = [landmarks[i].x * width, landmarks[i].y * height, landmarks[i].z * width];
      if (!this.filters.has(i)) this.filters.set(i, raw.map(() => new OneEuroFilter(1.5, 0.02)));
      const filters = this.filters.get(i);
      px.set(i, raw.map((value, k) => filters[k].filter(value, timeSec)));
    }

    // 2. Weighted centre of what we see.
    const imageCenter = [0, 0, 0];
    for (const m of MODEL) {
      const q = px.get(m.index);
      for (let k = 0; k < 3; k++) imageCenter[k] += (m.weight * q[k]) / TOTAL_WEIGHT;
    }

    // 3. Cross-covariance S[a][b] = sum over points of weight * model[a] * seen[b]
    //    (both measured from their centres). It tells how the two point clouds
    //    are oriented relative to each other.
    const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    MODEL.forEach((m, i) => {
      const P = MODEL_CENTERED[i];
      const Q = sub(px.get(m.index), imageCenter);
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[a][b] += m.weight * P[a] * Q[b];
    });

    // 4. Horn's method: the best rotation is the eigenvector (with the largest
    //    eigenvalue) of this 4x4 matrix, read as a quaternion [w, x, y, z].
    const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
    const N = [
      [xx + yy + zz, yz - zy, zx - xz, xy - yx],
      [yz - zy, xx - yy - zz, xy + yx, zx + xz],
      [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
      [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
    ];
    const { values, vectors } = symmetricEigen(N);
    const R = quatToMatrix(vectors[values.indexOf(Math.max(...values))]);

    // 5. Scale = pixels per millimetre at the face.
    let projection = 0;
    MODEL.forEach((m, i) => {
      projection += m.weight * dot(sub(px.get(m.index), imageCenter), matVec(R, MODEL_CENTERED[i]));
    });
    const s = projection / MODEL_SPREAD;

    // 6. Fit quality: typical distance (pixels) between model and observation.
    let squaredError = 0;
    MODEL.forEach((m, i) => {
      const predicted = matVec(R, MODEL_CENTERED[i]);
      const seen = sub(px.get(m.index), imageCenter);
      for (let k = 0; k < 3; k++) squaredError += m.weight * (s * predicted[k] - seen[k]) ** 2;
    });

    // 7. Distance face <-> camera (mm), for the perspective correction below.
    //    focal length in pixels = (half the image) / tan(half the field of view)
    const focalPx = Math.max(width, height) / 2 / Math.tan((CAMERA.fovLongSideDeg * DEG) / 2);

    return {
      R,                                    // rotation: head frame -> camera axes
      s,                                    // pixels per mm
      modelCenter: MODEL_CENTER,            // this head-frame point ...
      imageCenter,                          // ... appears here in the image
      distanceMm: focalPx / s,              // camera to face
      rmsPx: Math.sqrt(squaredError / TOTAL_WEIGHT),
      irisPx: irisDiameterPx(px),           // null if unreliable in this frame
      width,
      height,
    };
  }
}

// Where does the head-frame point p (mm) appear in the image (pixels)?
// Camera axes: x = right, y = down, z = away from the camera.
export function projectPoint(pose, p) {
  const r = matVec(pose.R, sub(p, pose.modelCenter));       // mm, in camera axes
  // Perspective: a point farther than the face centre looks smaller.
  const m = pose.distanceMm / (pose.distanceMm + r[2]);
  return {
    x: pose.imageCenter[0] + pose.s * m * r[0],
    y: pose.imageCenter[1] + pose.s * m * r[1],
    depth: r[2],
  };
}

// How much a surface with outward normal n (head frame) faces the camera:
// 1 = straight at it, 0 = side-on, negative = facing away.
export function facing(pose, n) {
  return -matVec(pose.R, n)[2];
}

// Average iris diameter in pixels, or null if the two eyes disagree (blink,
// strong head turn...). We take the larger of the two diameters of each iris
// because a turned head squashes one of them.
function irisDiameterPx(px) {
  const d = IRIS_EDGES.map(([a, b, c, e]) =>
    Math.max(Math.hypot(px.get(a)[0] - px.get(c)[0], px.get(a)[1] - px.get(c)[1]),
      Math.hypot(px.get(b)[0] - px.get(e)[0], px.get(b)[1] - px.get(e)[1])));
  if (Math.min(...d) < 2 || Math.max(...d) / Math.min(...d) > 1.3) return null;
  return (d[0] + d[1]) / 2;
}
