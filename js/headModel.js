// headModel.js - the head as the app imagines it, in the "head frame"
// (millimetres, origin = nasion, x = subject's LEFT, y = up, z = out of the face):
//   - the EEG positions (Fp1, AF7, ...),
//   - a sphere that hugs the forehead (radius ~75 mm),
// both scaled to the user's head size.
//
// THE FOREHEAD MAP (u, v)
// Every point of the forehead is described by two numbers, in millimetres
// measured ON THE SKIN, starting from the point of the forehead straight in
// front of the sphere centre:
//     v = walk v mm up (or down) the middle of the forehead
//     u = then walk u mm sideways, toward the LEFT ear if positive
// Both walks follow the shortest path on the skin (a "geodesic"), which is
// exactly the path a straight flexible strip takes when you press it on.
// That is why the sensor looks straight and undistorted on this map - which
// is what lets the detector search for it with a simple flat template.
//
// This file also knows how to "drape" the flat sensor onto the round forehead
// and where the sensor should be placed for a chosen montage.

import { HEAD_MODEL } from './headModelData.js';
import { add, sub, scale, dot, length, normalize, clamp, DEG } from './math3d.js';

export class Head {
  constructor() {
    this.setScale(1);
  }

  // h = 1: average head. h = 1.1: every EEG distance is 10% longer.
  // We scale around the origin (the nasion), which stays put on the face.
  setScale(h) {
    this.h = h;
    this.center = scale(HEAD_MODEL.sphere.center, h);
    this.radius = HEAD_MODEL.sphere.radius * h;
    this.eeg = {};
    for (const [name, p] of Object.entries(HEAD_MODEL.eeg)) this.eeg[name] = scale(p, h);
  }

  // ------------------------------------------------------------- the map ----
  // (u, v) in millimetres -> 3D point on the head.
  chartPoint(u, v) {
    return add(this.center, scale(this.chartNormal(u, v), this.radius));
  }

  // Direction from the sphere centre to that point = the direction straight
  // out of the skin there.
  chartNormal(u, v) {
    const a = u / this.radius;
    const b = v / this.radius;
    return [Math.sin(a), Math.sin(b) * Math.cos(a), Math.cos(b) * Math.cos(a)];
  }

  // 3D point -> (u, v).
  toChart(p) {
    const d = normalize(sub(p, this.center));
    return { u: this.radius * Math.asin(clamp(d[0], -1, 1)), v: this.radius * Math.atan2(d[1], d[2]) };
  }

  // The three directions at a point of the map:
  //   east   = along the skin toward the subject's left ear (u increasing)
  //   north  = along the skin upward (v increasing)
  //   normal = straight out of the skin
  frameAt(u, v) {
    const a = u / this.radius;
    const b = v / this.radius;
    return {
      east: [Math.cos(a), -Math.sin(b) * Math.sin(a), -Math.cos(b) * Math.sin(a)],
      north: [0, Math.cos(b), -Math.sin(b)],
      normal: [Math.sin(a), Math.sin(b) * Math.cos(a), Math.cos(b) * Math.cos(a)],
    };
  }

  // v of the midline point that is `heightMm` above the nasion.
  vAtHeight(heightMm) {
    return this.radius * Math.asin(clamp((heightMm - this.center[1]) / this.radius, -1, 1));
  }

  // --------------------------------------------------------------- draping --
  // Where does the point (s, t) of the flat sensor land on the head?
  // placement = { u, v, psi }: the centre of the sensor on the map, and its
  // rotation psi (radians; 0 = strips horizontal, positive = the end toward the
  // left ear goes up).
  // We walk sqrt(s² + t²) mm along the skin from the centre, in the direction
  // of (s, t) - like pressing a sticker on a ball from its middle outward, so
  // distances measured from the centre stay exact.
  drape(placement, s, t) {
    const { east, north, normal } = this.frameAt(placement.u, placement.v);
    const c = Math.cos(placement.psi);
    const n = Math.sin(placement.psi);
    const along = add(scale(east, c), scale(north, n));      // the sensor's s axis on the skin
    const across = add(scale(east, -n), scale(north, c));    // the sensor's t axis on the skin
    const step = add(scale(along, s), scale(across, t));     // where to walk (mm)
    const distance = length(step);
    if (distance < 1e-9) return this.chartPoint(placement.u, placement.v);
    const angle = distance / this.radius;                    // arc length -> angle
    const direction = scale(step, 1 / distance);
    return add(this.center,
      scale(add(scale(normal, Math.cos(angle)), scale(direction, Math.sin(angle))), this.radius));
  }

  // Distance along the skin between two points (shortest path on the sphere).
  skinDistance(a, b) {
    const da = sub(a, this.center);
    const db = sub(b, this.center);
    return this.radius * Math.acos(clamp(dot(da, db) / (length(da) * length(db)), -1, 1));
  }

  // Closest EEG position to a point: { name, distance }.
  nearestPosition(p) {
    let best = null;
    for (const [name, q] of Object.entries(this.eeg)) {
      const d = length(sub(p, q));
      if (!best || d < best.distance) best = { name, distance: d };
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// Where should the sensor go?
//   preset     : one of PLACEMENTS (config.js): { left, right } or { center }
//   electrodes : { left: {s, t}, right: {s, t} }, the electrode positions on the
//                flat sensor, in head-model millimetres.
// Returns { u, v, psi, center, electrodes: [...] }.
// ---------------------------------------------------------------------------
export function solvePlacement(head, preset, electrodes) {
  if (preset.center) {
    // Easy case: pod on the point, strips horizontal.
    const { u, v } = head.toChart(head.eeg[preset.center]);
    return describePlacement(head, { u, v, psi: 0 }, electrodes, null);
  }

  const targetL = head.eeg[preset.left];
  const targetR = head.eeg[preset.right];

  // "Cost" of a placement = squared distance electrode -> target, for both sides.
  const cost = (placement) => {
    const dl = sub(head.drape(placement, electrodes.left.s, electrodes.left.t), targetL);
    const dr = sub(head.drape(placement, electrodes.right.s, electrodes.right.t), targetR);
    return dot(dl, dl) + dot(dr, dr);
  };

  // Starting guess: centre halfway between the targets, strips pointing from
  // the right target to the left one.
  const middle = head.toChart(scale(add(targetL, targetR), 0.5));
  const { east, north } = head.frameAt(middle.u, middle.v);
  const direction = sub(targetL, targetR);
  let best = { ...middle, psi: Math.atan2(dot(direction, north), dot(direction, east)) };
  let bestCost = cost(best);

  // Pattern search: try a small step in each direction (u, v, psi, + and -),
  // keep any step that lowers the cost; when none does, halve the steps.
  const steps = { u: 2, v: 2, psi: 2 * DEG };
  while (steps.u > 0.01) {
    let improved = false;
    for (const key of ['u', 'v', 'psi']) {
      for (const sign of [1, -1]) {
        const trial = { ...best, [key]: best[key] + sign * steps[key] };
        const trialCost = cost(trial);
        if (trialCost < bestCost) {
          best = trial;
          bestCost = trialCost;
          improved = true;
        }
      }
    }
    if (!improved) for (const key of Object.keys(steps)) steps[key] /= 2;
  }
  return describePlacement(head, best, electrodes, { left: preset.left, right: preset.right });
}

// Adds useful information to a placement: its 3D centre and where each
// electrode lands (3D point, distance to its target, closest EEG position).
function describePlacement(head, placement, electrodes, targets) {
  const landing = ['left', 'right'].map((side) => {
    const pos = head.drape(placement, electrodes[side].s, electrodes[side].t);
    const target = targets ? targets[side] : null;
    return {
      side,
      pos,
      target,
      errorMm: target ? length(sub(pos, head.eeg[target])) : null,
      nearest: head.nearestPosition(pos),
    };
  });
  return { ...placement, center: head.chartPoint(placement.u, placement.v), electrodes: landing };
}
