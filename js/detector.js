// detector.js - find the REAL sensor on the forehead.
//
// The idea: searching the camera image directly is hard, because the sensor
// looks bigger, smaller or slanted depending on how you hold the phone.
// So we first UNWRAP the forehead into a flat map measured in millimetres
// (like peeling an orange and flattening the peel). On that map the sensor
// always has the same size and shape, so we can simply slide a picture of it
// (a "template") around and keep the best match.
//
// Every frame:
//   1. unwrap   : for each 1 mm cell of the forehead, project its 3D position
//                 into the image and read the colour of that pixel.
//   2. likeness : how much each cell looks like the sensor = dark compared with
//                 the skin AND colourless (the sensor is black/grey, while skin,
//                 brown hair and eyebrows are strongly coloured).
//   3. match    : slide the template (pod + strips dark, a ring of skin around
//                 them light) over the map, try several angles, keep the best.
//   4. smooth   : average with the previous frames so the result does not jitter.

import { DETECTION } from './config.js';
import { clamp, DEG } from './math3d.js';

const PAD = 64;          // empty margin (cells) so the template may hang over the map edge
const COARSE_STEP = 2;   // first pass: test every 2nd mm
const ANGLES_DEG = [-20, -16, -12, -8, -4, 0, 4, 8, 12, 16, 20];

export class SensorDetector {
  constructor() {
    // A hidden canvas, only used to read pixels out of the video.
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.map = null;         // the unwrapped forehead (rebuilt when the head size changes)
    this.templates = null;   // template sample offsets, one set per angle
    this.smoothed = null;    // last accepted detection
    this.missed = 0;         // frames in a row without a match
  }

  // ---------------------------------------------------------------------
  // The map: one cell per square millimetre of forehead skin.
  // row 0 = top of the band, column 0 = subject's right side.
  // ---------------------------------------------------------------------
  buildMap(head) {
    const uMax = Math.round(DETECTION.roiHalfWidthMm * head.h);
    const vMax = Math.round(head.vAtHeight(DETECTION.roiTopMm * head.h));
    const vMin = Math.round(head.vAtHeight(DETECTION.roiBottomMm * head.h));
    const cols = 2 * uMax + 1;
    const rows = vMax - vMin + 1;
    const cells = cols * rows;
    const points = new Float32Array(cells * 3);
    const normals = new Float32Array(cells * 3);

    for (let r = 0; r < rows; r++) {
      const v = vMax - r;
      for (let c = 0; c < cols; c++) {
        const u = c - uMax;
        const p = head.chartPoint(u, v);
        const n = head.chartNormal(u, v);
        const i = 3 * (r * cols + c);
        points[i] = p[0]; points[i + 1] = p[1]; points[i + 2] = p[2];
        normals[i] = n[0]; normals[i + 1] = n[1]; normals[i + 2] = n[2];
      }
    }
    this.map = {
      scale: head.h, uMax, vMax, vMin, cols, rows, points, normals, pad: PAD,
      W: cols + 2 * PAD, H: rows + 2 * PAD,                    // padded size
      likeness: new Float32Array((cols + 2 * PAD) * (rows + 2 * PAD)),
      rgb: new Uint8ClampedArray(cells * 4),                   // for the debug view
      bright: new Float32Array(cells),
      chroma: new Float32Array(cells),
      x: new Float32Array(cells),
      y: new Float32Array(cells),
      visible: new Uint8Array(cells),
    };
    this.templates = null;                                     // depends on map width
  }

  // ---------------------------------------------------------------------
  detect(video, pose, head, sensor) {
    if (!this.map || this.map.scale !== head.h) this.buildMap(head);
    const M = this.map;

    if (!this.unwrap(video, pose)) return this.lost();
    this.computeLikeness();
    const match = this.findSensor(sensor);
    if (!match) return this.lost();

    // Smooth: average with the previous result, unless the sensor jumped
    // (then it is probably a different object and we start fresh).
    const near = this.smoothed
      && Math.hypot(match.u - this.smoothed.u, match.v - this.smoothed.v) < 10
      && Math.abs(match.psi - this.smoothed.psi) < 15 * DEG;
    const blend = (a, b) => a + 0.5 * (b - a);
    this.smoothed = near
      ? { ...match, u: blend(this.smoothed.u, match.u), v: blend(this.smoothed.v, match.v), psi: blend(this.smoothed.psi, match.psi) }
      : match;
    this.missed = 0;
    return { found: true, ...this.smoothed, map: M };
  }

  // No match this frame: keep showing the last one for a few frames, then give up.
  lost() {
    this.missed++;
    if (this.missed > 8) this.smoothed = null;
    return this.smoothed
      ? { found: true, stale: true, ...this.smoothed, map: this.map }
      : { found: false, map: this.map };
  }

  reset() {
    this.smoothed = null;
    this.missed = 0;
  }

  // --- step 1: unwrap ---------------------------------------------------
  // Project every cell of the map into the image and read its pixel.
  unwrap(video, pose) {
    const M = this.map;
    const cells = M.cols * M.rows;
    const R = pose.R;
    const [mx, my, mz] = pose.modelCenter;
    const [ix, iy] = pose.imageCenter;
    const D = pose.distanceMm;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, seen = 0;

    for (let i = 0; i < cells; i++) {
      M.visible[i] = 0;
      const j = 3 * i;
      // Does this piece of skin face the camera? (z of its normal in camera axes)
      const facing = R[6] * M.normals[j] + R[7] * M.normals[j + 1] + R[8] * M.normals[j + 2];
      if (facing > -0.25) continue;                       // turned away or nearly edge-on
      const px = M.points[j] - mx, py = M.points[j + 1] - my, pz = M.points[j + 2] - mz;
      const rx = R[0] * px + R[1] * py + R[2] * pz;
      const ry = R[3] * px + R[4] * py + R[5] * pz;
      const rz = R[6] * px + R[7] * py + R[8] * pz;
      const perspective = D / (D + rz);
      const x = ix + pose.s * perspective * rx;
      const y = iy + pose.s * perspective * ry;
      if (x < 1 || y < 1 || x > pose.width - 2 || y > pose.height - 2) continue;
      M.x[i] = x; M.y[i] = y; M.visible[i] = 1; seen++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (seen < 0.25 * cells) return false;                // forehead hidden or turned away

    // Copy just that rectangle of the video, then read its pixels.
    const bx = Math.floor(minX), by = Math.floor(minY);
    const bw = Math.ceil(maxX) - bx + 1, bh = Math.ceil(maxY) - by + 1;
    if (this.canvas.width < bw || this.canvas.height < bh) {
      this.canvas.width = Math.max(this.canvas.width, bw);
      this.canvas.height = Math.max(this.canvas.height, bh);
    }
    this.ctx.drawImage(video, bx, by, bw, bh, 0, 0, bw, bh);
    const pixels = this.ctx.getImageData(0, 0, bw, bh).data;

    for (let i = 0; i < cells; i++) {
      if (!M.visible[i]) {
        M.rgb[4 * i] = M.rgb[4 * i + 1] = M.rgb[4 * i + 2] = 0;
        M.rgb[4 * i + 3] = 255;
        continue;
      }
      const k = 4 * ((Math.round(M.y[i]) - by) * bw + (Math.round(M.x[i]) - bx));
      const red = pixels[k], green = pixels[k + 1], blue = pixels[k + 2];
      M.bright[i] = 0.299 * red + 0.587 * green + 0.114 * blue;
      M.chroma[i] = Math.max(red, green, blue) - Math.min(red, green, blue);
      M.rgb[4 * i] = red; M.rgb[4 * i + 1] = green; M.rgb[4 * i + 2] = blue; M.rgb[4 * i + 3] = 255;
    }
    return true;
  }

  // --- step 2: how much does each cell look like the sensor? -------------
  computeLikeness() {
    const M = this.map;
    // Skin brightness, column by column (so that uneven lighting does not matter).
    // The sensor covers at most a third of a column, so the 65th percentile is skin.
    const background = new Float32Array(M.cols);
    const values = [];
    for (let c = 0; c < M.cols; c++) {
      values.length = 0;
      for (let r = 0; r < M.rows; r++) {
        const i = r * M.cols + c;
        if (M.visible[i]) values.push(M.bright[i]);
      }
      background[c] = values.length > 8 ? percentile(values, 0.65) : NaN;
    }
    // Columns with too little visible skin borrow the middle value of the others.
    const measured = Array.from(background).filter((value) => value > 0);
    const globalSkin = measured.length ? percentile(measured, 0.5) : 128;
    for (let c = 0; c < M.cols; c++) if (!(background[c] > 0)) background[c] = globalSkin;
    smoothArray(background, 6);

    // How colourful is this person's skin here? (colourfulness relative to brightness)
    // Every second cell is plenty for a median, and keeps this cheap.
    const ratios = [];
    for (let r = 0; r < M.rows; r += 2) {
      for (let c = 0; c < M.cols; c += 2) {
        const i = r * M.cols + c;
        if (M.visible[i] && M.bright[i] > 0.85 * background[c]) {
          ratios.push(M.chroma[i] / Math.max(M.bright[i], 60));
        }
      }
    }
    const skinColourfulness = ratios.length ? percentile(ratios, 0.5) : 0.4;

    for (let r = 0; r < M.rows; r++) {
      for (let c = 0; c < M.cols; c++) {
        const i = r * M.cols + c;
        const o = (r + PAD) * M.W + (c + PAD);
        if (!M.visible[i]) { M.likeness[o] = 0; continue; }
        const skin = background[c];
        // 1 when the cell is at most half as bright as the skin around it
        const dark = clamp((skin - M.bright[i]) / (0.5 * skin), 0, 1);
        // 1 when the cell is much less colourful than skin (black pod, grey strip)
        const ratio = M.chroma[i] / Math.max(M.bright[i], 60);
        const colourless = clamp((0.8 * skinColourfulness - ratio) / (0.4 * skinColourfulness), 0, 1);
        M.likeness[o] = dark * colourless;
      }
    }
  }

  // --- step 3: slide the template over the map ---------------------------
  findSensor(sensor) {
    const M = this.map;
    const L = M.likeness;
    if (!this.templates || this.templates.sensor !== sensor) this.buildTemplates(sensor);
    const templates = this.templates.byAngle;
    const flat = templates.find((t) => t.psi === 0);

    // Coarse pass: every 2 mm, every 4 degrees.
    let best = null;
    for (let r = 0; r < M.rows; r += COARSE_STEP) {
      for (let c = 0; c < M.cols; c += COARSE_STEP) {
        const o = (r + PAD) * M.W + (c + PAD);
        // Quick reject: is it dark where the pod would be?
        let sum = 0;
        for (let k = 0; k < flat.pod.length; k++) sum += L[o + flat.pod[k]];
        if (sum < 0.45 * flat.pod.length) continue;

        for (const t of templates) {
          const score = scoreOffsets(L, o, t);
          if (!best || score.total > best.total) {
            best = { ...score, u: c - M.uMax, v: M.vMax - r, psi: t.psi };
          }
        }
      }
    }
    if (!best) return null;

    // Fine pass: same idea, but with fractions of a millimetre and of a degree
    // (pattern search: try small steps, keep improvements, then shrink the steps).
    const samples = this.templates.samples;
    let current = { u: best.u, v: best.v, psi: best.psi };
    let score = scoreSamples(M, samples, current);
    const steps = { u: 1, v: 1, psi: 2 * DEG };
    while (steps.u > 0.2) {
      let improved = false;
      for (const key of ['u', 'v', 'psi']) {
        for (const sign of [1, -1]) {
          const trial = { ...current, [key]: current[key] + sign * steps[key] };
          const trialScore = scoreSamples(M, samples, trial);
          if (trialScore.total > score.total) {
            current = trial;
            score = trialScore;
            improved = true;
          }
        }
      }
      if (!improved) for (const key of Object.keys(steps)) steps[key] /= 2;
    }
    if (score.total < DETECTION.minScore || score.pod < 0.5) return null;
    return { ...current, ...score };
  }

  // Template sample points, in two forms:
  //   samples : (s, t) in mm, used for the accurate (fractional) pass
  //   byAngle : the same points rotated and rounded to whole cells, as ready-made
  //             offsets into the likeness map, used for the fast coarse pass
  buildTemplates(sensor) {
    const M = this.map;
    const samples = sensor.template;
    const byAngle = ANGLES_DEG.map((deg) => {
      const psi = deg * DEG;
      const cos = Math.cos(psi), sin = Math.sin(psi);
      const rotate = (points) => Int32Array.from(points, ([s, t]) => {
        const du = Math.round(s * cos - t * sin);
        const dv = Math.round(s * sin + t * cos);
        return -dv * M.W + du;                 // a cell higher up (+v) is a lower row
      });
      return {
        psi,
        pod: rotate(samples.pod),
        stripLeft: rotate(samples.stripLeft),
        stripRight: rotate(samples.stripRight),
        ring: rotate(samples.ring),
      };
    });
    this.templates = { sensor, samples, byAngle };
  }
}

// How good is a match?
//   the pod and both strips should be dark, the ring of skin around them light.
// The two strips are combined with "mostly the worse of the two", so a match
// that only fits one side (which is how a wrong tilt looks) scores badly.
// A tiny penalty on the angle breaks ties in favour of a level sensor.
function combine(pod, left, right, ring, psi) {
  const strips = 0.7 * Math.min(left, right) + 0.3 * 0.5 * (left + right);
  return {
    pod,
    strips,
    ring,
    total: 0.6 * pod + 0.4 * strips - 0.6 * ring - 0.001 * Math.abs(psi / DEG),
  };
}

// Score of a template placed on whole-millimetre cell `o`.
function scoreOffsets(L, o, t) {
  const mean = (offsets) => {
    let sum = 0;
    for (let k = 0; k < offsets.length; k++) sum += L[o + offsets[k]];
    return sum / offsets.length;
  };
  return combine(mean(t.pod), mean(t.stripLeft), mean(t.stripRight), mean(t.ring), t.psi);
}

// Same score, but for any (u, v, psi) - reading the map with sub-millimetre precision.
function scoreSamples(M, samples, { u, v, psi }) {
  const cos = Math.cos(psi), sin = Math.sin(psi);
  const mean = (points) => {
    let sum = 0;
    for (const [s, t] of points) {
      sum += sampleLikeness(M, u + s * cos - t * sin, v + s * sin + t * cos);
    }
    return sum / points.length;
  };
  return combine(mean(samples.pod), mean(samples.stripLeft), mean(samples.stripRight), mean(samples.ring), psi);
}

// Likeness at any (u, v) in millimetres, mixing the 4 neighbouring cells.
function sampleLikeness(M, u, v) {
  const col = u + M.uMax + PAD;
  const row = M.vMax - v + PAD;
  const c0 = Math.floor(col), r0 = Math.floor(row);
  if (c0 < 0 || r0 < 0 || c0 + 1 >= M.W || r0 + 1 >= M.H) return 0;
  const fc = col - c0, fr = row - r0;
  const i = r0 * M.W + c0;
  return (M.likeness[i] * (1 - fc) + M.likeness[i + 1] * fc) * (1 - fr)
    + (M.likeness[i + M.W] * (1 - fc) + M.likeness[i + M.W + 1] * fc) * fr;
}

function percentile(values, fraction) {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

// Replace each value by the average of its neighbours (+/- radius).
function smoothArray(array, radius) {
  const copy = Float32Array.from(array);
  for (let i = 0; i < array.length; i++) {
    let sum = 0, count = 0;
    for (let k = Math.max(0, i - radius); k <= Math.min(array.length - 1, i + radius); k++) {
      sum += copy[k]; count++;
    }
    array[i] = sum / count;
  }
}
