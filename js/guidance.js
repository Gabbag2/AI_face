// guidance.js - turns "where the sensor is" vs "where it should be" into advice.
//
// Everything is decided in HEAD coordinates (left ear / right ear / up / down),
// because those never change. Only the little arrow shown on the screen depends
// on the camera: in selfie mode the picture is mirrored, so "toward your right
// ear" points to the RIGHT of the screen, while with the back camera (you are
// looking at someone else) the same instruction points to the LEFT of the screen.

import { GUIDANCE } from './config.js';
import { DEG } from './math3d.js';

// target    : chosen placement  { u, v (mm on the forehead map), psi (radians) }
// detection : what the detector found (same units), or null
// toRealMm  : head-model mm -> real mm (face size factor)
// selfie    : true when the screen shows a mirrored image (front camera)
export function computeGuidance(target, detection, toRealMm, selfie) {
  if (!detection || !detection.found) {
    return {
      state: 'searching',
      title: 'Place the sensor on the outline',
      speech: 'Place the sensor on your forehead',
      corrections: [],
    };
  }

  const du = (detection.u - target.u) * toRealMm;     // + : too far toward the LEFT ear
  const dv = (detection.v - target.v) * toRealMm;     // + : too high
  const dpsi = (detection.psi - target.psi) / DEG;    // + : the LEFT-ear end is too high
  const my = selfie ? 'your ' : 'the ';
  const corrections = [];

  if (Math.abs(du) > GUIDANCE.goodMm) {
    const ear = du > 0 ? 'RIGHT' : 'LEFT';
    corrections.push({
      axis: 'side',
      urgency: Math.abs(du) / GUIDANCE.goodMm,
      arrow: (du > 0) === selfie ? '→' : '←',        // mirrored view flips left and right
      title: `${verb(du)} toward ${my}${ear} ear`,
      speech: `${verb(du)} toward ${my}${ear.toLowerCase()} ear, ${Math.round(Math.abs(du))} millimetres`,
      amount: `${Math.round(Math.abs(du))} mm`,
    });
  }
  if (Math.abs(dv) > GUIDANCE.goodMm) {
    const down = dv > 0;
    corrections.push({
      axis: 'height',
      urgency: Math.abs(dv) / GUIDANCE.goodMm,
      arrow: down ? '↓' : '↑',
      title: `${verb(dv)} ${down ? 'DOWN, toward the eyebrows' : 'UP, toward the hairline'}`,
      speech: `${verb(dv)} ${down ? 'down' : 'up'}, ${Math.round(Math.abs(dv))} millimetres`,
      amount: `${Math.round(Math.abs(dv))} mm`,
    });
  }
  if (Math.abs(dpsi) > GUIDANCE.goodDeg) {
    const ear = dpsi > 0 ? 'LEFT' : 'RIGHT';
    corrections.push({
      axis: 'tilt',
      urgency: Math.abs(dpsi) / GUIDANCE.goodDeg,
      arrow: (dpsi > 0) === selfie ? '↺' : '↻',
      title: `Level it: lower the ${ear}-ear side`,
      speech: `Level it: lower the ${ear.toLowerCase()} side`,
      amount: `${Math.round(Math.abs(dpsi))}°`,
    });
  }
  corrections.sort((a, b) => b.urgency - a.urgency);   // biggest mistake first

  if (corrections.length === 0) {
    return { state: 'aligned', title: 'Aligned', speech: 'Aligned', corrections, du, dv, dpsi };
  }
  return { state: 'adjust', ...corrections[0], corrections, du, dv, dpsi };
}

const verb = (mm) => (Math.abs(mm) > GUIDANCE.bigMm ? 'Move' : 'Move a bit');

// Keeps track of how long the sensor has been in place, and says the advice out loud.
export class Coach {
  constructor() {
    this.alignedSince = null;
    this.lastPhrase = '';
    this.lastTime = 0;
  }

  update(guidance, nowMs, voiceOn) {
    if (guidance.state === 'aligned') {
      if (this.alignedSince === null) this.alignedSince = nowMs;
      if (nowMs - this.alignedSince > GUIDANCE.holdMs) {
        guidance = { ...guidance, state: 'perfect', title: 'Perfect - press it down gently', speech: 'Perfect. Press it down gently.' };
      }
    } else {
      this.alignedSince = null;
    }
    if (voiceOn) this.say(guidance.speech || guidance.title, nowMs);
    return guidance;
  }

  say(phrase, nowMs) {
    if (!('speechSynthesis' in window)) return;
    const repeating = phrase === this.lastPhrase;
    if (nowMs - this.lastTime < (repeating ? 6000 : GUIDANCE.speakEveryMs)) return;
    this.lastPhrase = phrase;
    this.lastTime = nowMs;
    speechSynthesis.cancel();                     // drop what is still being said
    const utterance = new SpeechSynthesisUtterance(phrase);
    utterance.lang = 'en-US';
    utterance.rate = 1.05;
    speechSynthesis.speak(utterance);
  }

  reset() {
    this.alignedSince = null;
    this.lastPhrase = '';
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }
}
