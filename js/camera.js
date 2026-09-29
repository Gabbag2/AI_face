// camera.js - open the camera and switch between the selfie and the back camera.

import { CAMERA } from './config.js';

export class Camera {
  constructor(videoElement) {
    this.video = videoElement;
    this.stream = null;
    this.facing = 'user';          // 'user' = selfie camera, 'environment' = back camera
  }

  // Ask the browser for a camera. The browser may give another resolution than
  // the one we ask for, and on a phone in portrait it usually gives a portrait
  // picture (e.g. 720x1280): we simply use whatever size we get.
  async start(facing = this.facing) {
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: CAMERA.width },
        height: { ideal: CAMERA.height },
      },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    // What did we actually get? (laptops often do not report facingMode)
    const settings = this.stream.getVideoTracks()[0].getSettings();
    this.facing = settings.facingMode || facing;
    return this.facing;
  }

  async switch() {
    return this.start(this.facing === 'user' ? 'environment' : 'user');
  }

  stop() {
    if (!this.stream) return;
    for (const track of this.stream.getTracks()) track.stop();
    this.stream = null;
  }

  // With the selfie camera we show the picture mirrored, like a bathroom mirror:
  // moving your hand to your right moves it to the right of the screen too.
  get mirrored() {
    return this.facing === 'user';
  }

  get ready() {
    return this.video.readyState >= 2 && this.video.videoWidth > 0;
  }
}
