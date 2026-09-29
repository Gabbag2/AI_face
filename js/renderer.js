// renderer.js - draws the camera picture and everything on top of it.
//
// Two coordinate systems are involved:
//   * image pixels: what the camera sees (never mirrored) - the landmarks and
//     projectPoint() live here;
//   * screen pixels: what you see. In selfie mode it is the mirror image.
// toScreen() converts one into the other. Text is always drawn unmirrored,
// which is why we do not simply flip the whole canvas.

import { projectPoint, facing } from './pose.js';
import { add, sub, scale, normalize, DEG } from './math3d.js';

const CYAN = '#22d3ee';
const AMBER = '#ffb020';
const GREEN = '#35e07a';

// How each version of the sensor drawing looks.
const STYLES = {
  solid: { patch: 'rgba(255,255,255,0.18)', patchLine: 'rgba(255,255,255,0.55)', strip: 'rgba(70,70,70,0.92)', stripLine: 'rgba(20,20,20,0.9)', pod: 'rgba(12,12,12,0.95)', podLine: 'rgba(120,120,120,0.9)', dash: [] },
  target: { patch: 'rgba(34,211,238,0.06)', patchLine: 'rgba(34,211,238,0.35)', strip: 'rgba(34,211,238,0.16)', stripLine: CYAN, pod: 'rgba(34,211,238,0.22)', podLine: CYAN, dash: [5, 4] },
  found: { patch: null, patchLine: null, strip: null, stripLine: AMBER, pod: null, podLine: AMBER, dash: [] },
  aligned: { patch: null, patchLine: null, strip: null, stripLine: GREEN, pod: null, podLine: GREEN, dash: [] },
};

// The "10% line" of the 10-20 system: the tape-measure circle that carries
// Fp1, AF7, F7... Drawing it helps to see that all these points are on one line.
const TAPE_LINE = ['F7', 'AF7', 'Fp1', 'Fpz', 'Fp2', 'AF8', 'F8'];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mirror = false;
    this.unit = 6;              // 1/100 of the smaller side: all sizes are multiples of it
  }

  // Draw the camera picture (mirrored in selfie mode) and get ready for overlays.
  beginFrame(video, mirror) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.mirror = mirror;
    this.unit = Math.min(w, h) / 100;
    const ctx = this.ctx;
    ctx.setTransform(mirror ? -1 : 1, 0, 0, 1, mirror ? w : 0, 0);
    ctx.drawImage(video, 0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineJoin = 'round';
  }

  toScreen(p) {
    return { x: this.mirror ? this.canvas.width - p.x : p.x, y: p.y };
  }

  project(pose, point3d) {
    return this.toScreen(projectPoint(pose, point3d));
  }

  // ---------------------------------------------------------- EEG positions --
  drawPositions(pose, head, highlighted, showAll) {
    const ctx = this.ctx;
    ctx.save();

    // the 10% line, drawn by walking along the sphere between the positions
    ctx.beginPath();
    for (let i = 0; i < TAPE_LINE.length - 1; i++) {
      const a = head.eeg[TAPE_LINE[i]];
      const b = head.eeg[TAPE_LINE[i + 1]];
      for (let k = 0; k <= 10; k++) {
        const point = this.arcPoint(head, a, b, k / 10);
        const q = this.project(pose, point);
        if (i === 0 && k === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = this.unit * 0.13;
    ctx.setLineDash([this.unit * 0.5, this.unit * 0.5]);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const [name, point] of Object.entries(head.eeg)) {
      const front = facing(pose, normalize(sub(point, head.center)));
      if (front < 0.12) continue;                       // this point is on the far side
      const isTarget = highlighted.has(name);
      if (!isTarget && !showAll) continue;
      const q = this.project(pose, point);
      const radius = this.unit * (isTarget ? 0.85 : 0.5);
      ctx.globalAlpha = Math.min(1, front * 2.5);
      ctx.beginPath();
      ctx.arc(q.x, q.y, radius, 0, 2 * Math.PI);
      ctx.fillStyle = isTarget ? CYAN : 'rgba(255,255,255,0.9)';
      ctx.fill();
      ctx.lineWidth = this.unit * 0.1;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.stroke();
      this.label(name, q.x, q.y - radius - this.unit * 0.35, isTarget ? CYAN : 'rgba(255,255,255,0.92)', isTarget);
      ctx.globalAlpha = 1;
    }

    if (showAll) {                                       // the anchor of the whole system
      const nasion = this.project(pose, [0, 0, 0]);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = this.unit * 0.12;
      ctx.beginPath();
      ctx.moveTo(nasion.x - this.unit * 0.5, nasion.y);
      ctx.lineTo(nasion.x + this.unit * 0.5, nasion.y);
      ctx.moveTo(nasion.x, nasion.y - this.unit * 0.5);
      ctx.lineTo(nasion.x, nasion.y + this.unit * 0.5);
      ctx.stroke();
      this.label('nasion', nasion.x, nasion.y + this.unit * 1.6, 'rgba(255,255,255,0.75)', false);
    }
    ctx.restore();
  }

  // A point at fraction f of the way from a to b, staying on the head surface.
  arcPoint(head, a, b, f) {
    const da = sub(a, head.center);
    const db = sub(b, head.center);
    const mixed = add(scale(da, 1 - f), scale(db, f));
    return add(head.center, scale(normalize(mixed), head.radius));
  }

  // --------------------------------------------------------- virtual sensor --
  // placement: { theta, phi, psi } - where the sensor sits on the head.
  drawSensor(pose, head, sensor, placement, styleName, electrodes = null) {
    const style = STYLES[styleName];
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = this.unit * (styleName === 'found' || styleName === 'aligned' ? 0.34 : 0.22);
    ctx.setLineDash(style.dash.map((d) => d * this.unit * 0.22));

    const path = (outline) => {
      ctx.beginPath();
      outline.forEach(([s, t], i) => {
        const q = this.project(pose, head.drape(placement, s, t));
        if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
      });
      ctx.closePath();
    };
    const paint = (outline, fill, stroke) => {
      path(outline);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
    };

    if (style.patch || style.patchLine) paint(sensor.patch, style.patch, style.patchLine);
    for (const strip of sensor.strips) paint(strip, style.strip, style.stripLine);
    paint(sensor.pod, style.pod, style.podLine);

    // the little red LED in the middle of the pod
    const led = this.project(pose, head.drape(placement, sensor.led[0], sensor.led[1]));
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(led.x, led.y, this.unit * 0.22, 0, 2 * Math.PI);
    ctx.fillStyle = styleName === 'solid' ? '#ff3b30' : 'rgba(255,59,48,0.75)';
    ctx.fill();

    // Where the electrodes land. No text here: the EEG dots are already
    // labelled, and the line under the target menu says how close they get.
    if (electrodes) {
      for (const electrode of electrodes) {
        const q = this.project(pose, electrode.pos);
        ctx.beginPath();
        ctx.arc(q.x, q.y, this.unit * 0.7, 0, 2 * Math.PI);
        ctx.strokeStyle = CYAN;
        ctx.lineWidth = this.unit * 0.16;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ arrows --
  // Arrows from where the sensor is to where it should be.
  drawGuidance(pose, head, sensor, target, detection, guidance) {
    if (!detection?.found || guidance.state === 'perfect' || guidance.state === 'aligned') return;
    const detected = { u: detection.u, v: detection.v, psi: detection.psi };
    const colour = AMBER;

    const moving = guidance.corrections.some((c) => c.axis !== 'tilt');
    if (moving) {
      this.arrow(this.project(pose, head.drape(detected, 0, 0)),
        this.project(pose, head.drape(target, 0, 0)), colour);
    }
    if (guidance.corrections.some((c) => c.axis === 'tilt')) {
      // rotation only: same centre, target angle
      const levelled = { ...detected, psi: target.psi };
      for (const side of [1, -1]) {
        this.arrow(this.project(pose, head.drape(detected, side * sensor.tipDist * 0.8, 0)),
          this.project(pose, head.drape(levelled, side * sensor.tipDist * 0.8, 0)), colour);
      }
    }
  }

  arrow(from, to, colour) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance < this.unit * 0.8) return;
    const ctx = this.ctx;
    const head = Math.min(this.unit * 1.6, distance * 0.5);
    const angle = Math.atan2(dy, dx);
    ctx.save();
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = this.unit * 0.3;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - head * Math.cos(angle - 0.4), to.y - head * Math.sin(angle - 0.4));
    ctx.lineTo(to.x - head * Math.cos(angle + 0.4), to.y - head * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // ------------------------------------------------- debug: unwrapped forehead --
  drawUnwrapped(map, sensor, target, detection) {
    if (!map) return;
    const ctx = this.ctx;
    if (!this.inset || this.inset.width !== map.cols || this.inset.height !== map.rows) {
      this.inset = document.createElement('canvas');
      this.inset.width = map.cols;
      this.inset.height = map.rows;
      this.insetCtx = this.inset.getContext('2d');
      this.insetImage = this.insetCtx.createImageData(map.cols, map.rows);
    }
    // the unwrapped skin, tinted magenta where the app thinks "this looks like the sensor"
    const data = this.insetImage.data;
    for (let r = 0; r < map.rows; r++) {
      for (let c = 0; c < map.cols; c++) {
        const i = 4 * (r * map.cols + c);
        const likeness = map.likeness[(r + map.pad) * map.W + (c + map.pad)];
        data[i] = map.rgb[i] * (1 - likeness) + 255 * likeness;
        data[i + 1] = map.rgb[i + 1] * (1 - likeness) + 40 * likeness;
        data[i + 2] = map.rgb[i + 2] * (1 - likeness) + 200 * likeness;
        data[i + 3] = 255;
      }
    }
    this.insetCtx.putImageData(this.insetImage, 0, 0);

    const scaleFactor = (this.canvas.width * 0.3) / map.cols;
    const w = map.cols * scaleFactor;
    const h = map.rows * scaleFactor;
    const x0 = this.unit * 1.5;
    const y0 = this.unit * 1.5;
    ctx.save();
    ctx.globalAlpha = 0.9;
    if (this.mirror) {                       // keep it oriented like the picture
      ctx.translate(x0 + w, y0);
      ctx.scale(-1, 1);
      ctx.drawImage(this.inset, 0, 0, w, h);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      ctx.drawImage(this.inset, x0, y0, w, h);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, y0, w, h);

    // chart coordinates -> position inside the inset
    const toInset = (u, v) => ({
      x: x0 + (this.mirror ? map.uMax - u : u + map.uMax) * scaleFactor,
      y: y0 + (map.vMax - v) * scaleFactor,
    });
    const outline = (place, colour, dash) => {
      if (!place) return;
      ctx.beginPath();
      const cos = Math.cos(place.psi);
      const sin = Math.sin(place.psi);
      [...sensor.pod, sensor.pod[0]].forEach(([s, t], i) => {
        const q = toInset(place.u + s * cos - t * sin, place.v + s * sin + t * cos);
        if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
      });
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2;
      ctx.setLineDash(dash);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    outline(target, CYAN, [4, 3]);
    if (detection?.found) outline(detection, detection.stale ? 'rgba(255,176,32,0.5)' : AMBER, []);
    this.label('unwrapped forehead', x0 + w / 2, y0 + h + this.unit * 1.2, 'rgba(255,255,255,0.8)', false);
    ctx.restore();
  }

  // ------------------------------------------------------------------- text --
  label(text, x, y, colour, strong) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `${strong ? '700' : '500'} ${this.unit * (strong ? 2.1 : 1.8)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = this.unit * 0.45;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = colour;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  message(text) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `600 ${this.unit * 3}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    const width = ctx.measureText(text).width + this.unit * 3;
    ctx.fillRect((this.canvas.width - width) / 2, this.canvas.height / 2 - this.unit * 3, width, this.unit * 5);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, this.canvas.width / 2, this.canvas.height / 2 + this.unit * 0.5);
    ctx.restore();
  }
}
