// sensor.js - the shape of the sensor, laid flat, in its own coordinates:
//   s = mm along the strips (+ = toward the subject's LEFT ear)
//   t = mm across the strips (+ = up)
//   (0, 0) = centre of the black pod.
// Used to:
//   1. draw the virtual sensor (outlines of the adhesive patch, strips, pod),
//   2. know where the electrodes are,
//   3. build the "template" that the detector looks for in the image.

import { DEG } from './math3d.js';

// cfg     : sensor dimensions in real mm (config.js, or the Settings panel).
// toModel : converts real mm into head-model mm (= 1 / face-size factor, see main.js).
export function buildSensor(cfg, toModel = 1) {
  const k = toModel;
  const podW = cfg.podWidth * k;
  const podH = cfg.podHeight * k;
  const stripW = cfg.stripWidth * k;
  const tipDist = podW / 2 + cfg.stripLength * k;   // pod centre -> strip tip
  const tilt = cfg.stripAngle * DEG;

  // A point on a strip. side = +1 (left strip) or -1 (right strip),
  // d = distance from the pod centre along the strip, e = offset across it (+ = up).
  const onStrip = (side, d, e) => [
    side * (d * Math.cos(tilt) + e * Math.sin(tilt)),
    -d * Math.sin(tilt) + e * Math.cos(tilt),
  ];

  // --- 1. outlines, for drawing ---------------------------------------------
  const podRadius = 0.42 * podH;                      // the pod has very round corners
  const pod = roundedRect(podW, podH, podRadius);
  const strips = [1, -1].map((side) => {
    const start = podW / 2 - 2 * k;                   // strips start under the pod
    const bottom = [];
    const top = [];
    for (let d = start; d < tipDist; d += 2) {
      bottom.push(onStrip(side, d, -stripW / 2));
      top.push(onStrip(side, d, stripW / 2));
    }
    bottom.push(onStrip(side, tipDist, -stripW / 2));
    top.push(onStrip(side, tipDist, stripW / 2));
    return [...bottom, ...top.reverse()];             // go out along the bottom, back along the top
  });
  const drop = tipDist * Math.sin(tilt);              // how far down the tips go
  const patch = roundedRect(2 * tipDist + 8 * k, podH + 8 * k + drop, 6 * k)
    .map(([s, t]) => [s, t - drop / 2]);

  // --- 2. electrodes (centre of each), in (s, t) ------------------------------
  const e = cfg.electrodeOffset * k;
  const [ls, lt] = onStrip(1, e, 0);
  const [rs, rt] = onStrip(-1, e, 0);
  const electrodes = { left: { s: ls, t: lt }, right: { s: rs, t: rt } };

  // --- 3. detection template ----------------------------------------------------
  // Four groups of sample points. On a good match:
  //   pod                    -> dark (the black pod)
  //   stripLeft, stripRight  -> dark (the grey strips); kept apart so that the
  //                             detector can insist that BOTH sides match, which
  //                             is what makes the tilt reading trustworthy
  //   ring                   -> light (the skin all around the sensor)
  const template = { pod: [], stripLeft: [], stripRight: [], ring: [] };
  const step = 2 * k;
  for (let s = -podW / 2; s <= podW / 2; s += step) {
    for (let t = -podH / 2; t <= podH / 2; t += step) {
      // stay 1.5 mm inside the pod edge (edges are blurry in the image)
      if (insideRoundedRect(s, t, podW - 3 * k, podH - 3 * k, podRadius - 1.5 * k)) template.pod.push([s, t]);
    }
  }
  for (const side of [1, -1]) {
    const group = side === 1 ? template.stripLeft : template.stripRight;
    for (let d = podW / 2 + 4 * k; d <= tipDist - 2 * k; d += 2.5 * k) {
      for (const across of [-0.3 * stripW, 0, 0.3 * stripW]) group.push(onStrip(side, d, across));
    }
  }
  const gap = 4 * k;                                  // ring distance from the sensor edge
  for (let s = -podW / 2 + 4 * k; s <= podW / 2 - 4 * k; s += 3 * k) {
    template.ring.push([s, podH / 2 + gap], [s, -podH / 2 - gap]);
  }
  for (const side of [1, -1]) {
    for (let d = podW / 2 + 5 * k; d <= tipDist - 2 * k; d += 3 * k) {
      template.ring.push(onStrip(side, d, stripW / 2 + gap), onStrip(side, d, -stripW / 2 - gap));
    }
    for (const across of [-stripW / 2, 0, stripW / 2]) template.ring.push(onStrip(side, tipDist + gap, across));
  }

  return { pod, strips, patch, led: [0, 0.1 * podH], electrodes, template, tipDist };
}

// Outline of a rectangle (w x h, centred on 0) with rounded corners of radius r,
// with points at most 2 mm apart (so it bends smoothly when draped on the head).
function roundedRect(w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  const corners = [                                 // corner centre + start angle
    [w / 2 - r, h / 2 - r, 0],
    [-(w / 2 - r), h / 2 - r, 90],
    [-(w / 2 - r), -(h / 2 - r), 180],
    [w / 2 - r, -(h / 2 - r), 270],
  ];
  const points = [];
  for (const [cx, cy, start] of corners) {
    for (let a = 0; a <= 90; a += 15) {
      points.push([cx + r * Math.cos((start + a) * DEG), cy + r * Math.sin((start + a) * DEG)]);
    }
  }
  return densify(points, 2);
}

// Adds points on each edge of a closed outline so no edge is longer than maxStep.
function densify(points, maxStep) {
  const out = [];
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length];
    const pieces = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / maxStep));
    for (let j = 0; j < pieces; j++) {
      out.push([p[0] + ((q[0] - p[0]) * j) / pieces, p[1] + ((q[1] - p[1]) * j) / pieces]);
    }
  });
  return out;
}

function insideRoundedRect(s, t, w, h, r) {
  const dx = Math.max(Math.abs(s) - (w / 2 - r), 0);
  const dy = Math.max(Math.abs(t) - (h / 2 - r), 0);
  return dx * dx + dy * dy <= r * r;
}
