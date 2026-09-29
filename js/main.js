// main.js - the conductor.
//
// What happens for every video frame:
//   1. faceTracker : MediaPipe finds 478 points on the face.
//   2. pose        : how the head is turned, and how many pixels one millimetre is.
//   3. face size   : the iris (11.7 mm in everybody) tells us the real size of that face.
//   4. head model  : the EEG positions on THIS head, and the best spot for the sensor.
//   5. detector    : where the real sensor is right now.
//   6. guidance    : the difference, turned into "move a bit to the left".
//   7. renderer/ui : draw it all.

import { IRIS_DIAMETER_MM } from './config.js';
import { HEAD_MODEL } from './headModelData.js';
import { Camera } from './camera.js';
import { FaceTracker } from './faceTracker.js';
import { PoseEstimator } from './pose.js';
import { Head, solvePlacement } from './headModel.js';
import { buildSensor } from './sensor.js';
import { SensorDetector } from './detector.js';
import { computeGuidance, Coach } from './guidance.js';
import { Renderer } from './renderer.js';
import { UI } from './ui.js';
import { RollingMedian, clamp } from './math3d.js';

const video = document.getElementById('video');
const camera = new Camera(video);
const renderer = new Renderer(document.getElementById('view'));
const poseEstimator = new PoseEstimator();
const head = new Head();
const detector = new SensorDetector();
const coach = new Coach();
const faceSize = new RollingMedian(45);          // ~1.5 s: the face size changes slowly

const ui = new UI({
  onStart: start,
  onChange: () => { needsSolve = true; },
  onSwitchCamera: switchCamera,
  onVoiceOn: () => coach.say('Voice on', performance.now()),
});
ui.fillPositions(Object.keys(HEAD_MODEL.eeg));

let tracker = null;
let sensor = null;          // the sensor shape, in head-model millimetres
let placement = null;       // where the sensor should go
let needsSolve = true;      // something changed: compute the placement again
let lastVideoTime = -1;
let frames = 0, fpsSince = 0, fps = 0, lastInfo = 0;

// window.app makes it easy to inspect things from the browser console (and in tests).
window.app = { camera, head, detector, ui, state: {} };

async function start() {
  try {
    ui.setStatus('Opening the camera…');
    await camera.start('user');
    ui.setStatus('Loading the face tracker (a few seconds the first time)…');
    tracker = await FaceTracker.create((message) => ui.setStatus(message));
    ui.hideStart();
    requestAnimationFrame(loop);
  } catch (error) {
    ui.setStatus(`Could not start: ${error.message}. Allow camera access, then reload.`);
  }
}

async function switchCamera() {
  try {
    await camera.switch();
  } catch (error) {
    ui.setCard({ state: 'searching', title: 'No second camera found' });
    return;
  }
  poseEstimator.reset();                        // the new camera sees a different picture
  detector.reset();
  coach.reset();
}

function loop(timeMs) {
  requestAnimationFrame(loop);
  if (!tracker || !camera.ready) return;
  if (video.currentTime === lastVideoTime) return;         // no new frame yet
  lastVideoTime = video.currentTime;

  frames++;
  if (timeMs - fpsSince > 1000) {
    fps = Math.round((frames * 1000) / (timeMs - fpsSince));
    frames = 0;
    fpsSince = timeMs;
  }

  // 1. face landmarks
  const landmarks = tracker.detect(video, timeMs);
  renderer.beginFrame(video, camera.mirrored);
  if (!landmarks) {
    renderer.message('Looking for a face…');
    ui.setCard({ state: 'searching', title: 'Show your face to the camera', corrections: [] });
    return;
  }

  // 2. head pose
  const pose = poseEstimator.update(landmarks, video.videoWidth, video.videoHeight, timeMs / 1000);

  // 3. real size of this face: model millimetres -> real millimetres
  if (pose.irisPx) faceSize.push((pose.s * IRIS_DIAMETER_MM) / pose.irisPx);
  const toRealMm = clamp(faceSize.value ?? 1, 0.75, 1.35);

  // 4. head size: either measured by the user, or "as big as the face suggests"
  const measuredCm = parseFloat(ui.settings.headCircumferenceCm);
  const wantedScale = Number.isFinite(measuredCm)
    ? (measuredCm * 10) / (HEAD_MODEL.averageHeadCircumferenceMm * toRealMm)
    : 1;
  if (Math.abs(wantedScale - head.h) > 0.005) {
    head.setScale(wantedScale);
    needsSolve = true;
  }

  // 5. sensor shape and target placement (only when something changed)
  const preset = validPreset();
  const sizeKey = JSON.stringify([ui.settings.sensor, preset, toRealMm.toFixed(2), head.h.toFixed(3)]);
  if (needsSolve || sizeKey !== window.app.state.sizeKey) {
    // The sensor has a fixed real size, so in head-model millimetres it is
    // smaller on a big face and bigger on a small face: hence 1 / toRealMm.
    sensor = buildSensor(ui.settings.sensor, 1 / toRealMm);
    placement = solvePlacement(head, preset, sensor.electrodes);
    showFit(preset, toRealMm);
    window.app.state.sizeKey = sizeKey;
    needsSolve = false;
  }

  // 6. find the real sensor and turn the difference into advice
  let detection = null;
  let guidance = { state: 'preview', title: 'Preview: this is where the sensor goes', corrections: [] };
  if (ui.settings.mode === 'guide') {
    detection = detector.detect(video, pose, head, sensor);
    guidance = coach.update(computeGuidance(placement, detection, toRealMm, camera.mirrored), timeMs, ui.settings.voice);
  }

  // 7. draw
  const targets = new Set([preset.left, preset.right, preset.center].filter(Boolean));
  renderer.drawPositions(pose, head, targets, ui.settings.showAll);
  if (ui.settings.mode === 'preview') {
    renderer.drawSensor(pose, head, sensor, placement, 'solid', placement.electrodes);
  } else {
    renderer.drawSensor(pose, head, sensor, placement, 'target', placement.electrodes);
    if (detection?.found) {
      const where = { u: detection.u, v: detection.v, psi: detection.psi };
      const good = guidance.state === 'aligned' || guidance.state === 'perfect';
      renderer.drawSensor(pose, head, sensor, where, good ? 'aligned' : 'found');
      renderer.drawGuidance(pose, head, sensor, placement, detection, guidance);
    }
  }
  if (ui.settings.showUnwrapped && detection) {
    renderer.drawUnwrapped(detection.map, sensor, placement, detection);
  }
  ui.setCard(guidance);

  // Numbers for the Settings panel (once per second is enough).
  if (timeMs - lastInfo > 1000) {
    lastInfo = timeMs;
    ui.setHeadEstimate(`From your face: about ${((HEAD_MODEL.averageHeadCircumferenceMm * toRealMm) / 10).toFixed(0)} cm around the head`
      + (Number.isFinite(measuredCm) ? ` (using your ${measuredCm} cm)` : ''));
    ui.setDiagnostics(`${fps} fps · tracker on ${tracker.delegate} · face fit ${pose.rmsPx.toFixed(1)} px`
      + ` · camera ${Math.round(pose.distanceMm / 10)} cm away`
      + (detection?.found ? ` · match ${(detection.total ?? 0).toFixed(2)}` : ' · sensor not found'));
  }
  Object.assign(window.app.state, { pose, placement, detection, guidance, toRealMm, fps });
}

// The chosen target, with a safety net: a setting saved long ago could name a
// position that no longer exists in the head model.
function validPreset() {
  const preset = ui.preset;
  const known = (name) => name && name in HEAD_MODEL.eeg;
  if (preset.center) return known(preset.center) ? preset : { ...preset, center: 'Fpz' };
  return {
    ...preset,
    left: known(preset.left) ? preset.left : 'Fp1',
    right: known(preset.right) ? preset.right : 'Fp2',
  };
}

// One line under the target menu: does the sensor actually reach those positions?
function showFit(preset, toRealMm) {
  if (preset.center) {
    const near = placement.electrodes
      .map((e) => `${e.nearest.name} (${Math.round(e.nearest.distance * toRealMm)} mm away)`).join(' and ');
    ui.setFit(`Pod centred on ${preset.center}; electrodes land near ${near}.`);
    return;
  }
  const worstMm = Math.max(...placement.electrodes.map((e) => e.errorMm)) * toRealMm;
  if (worstMm <= 4) {
    ui.setFit(`Electrodes reach ${preset.left} / ${preset.right} (within ${worstMm.toFixed(0)} mm).`);
    return;
  }
  const targetSpan = head.skinDistance(head.eeg[preset.left], head.eeg[preset.right]) * toRealMm;
  const sensorSpan = 2 * ui.settings.sensor.electrodeOffset;
  ui.setFit(`⚠ Your electrodes are ${sensorSpan.toFixed(0)} mm apart, but ${preset.left}–${preset.right} are `
    + `${targetSpan.toFixed(0)} mm apart on this head: each electrode stays about ${worstMm.toFixed(0)} mm away. `
    + `Best compromise shown. Check "Centre → electrode" in Settings.`, true);
}
