// faceTracker.js - runs Google's MediaPipe "Face Landmarker" on each video frame.
// It gives 478 points on the face (eyes, nose, mouth, face outline, irises),
// each with x, y (position in the image, 0 to 1) and z (depth).
//
// The library and its WebAssembly code come from a CDN; the neural network
// model is the local file models/face_landmarker.task (with the official
// Google address as a fallback).

const VERSION = '1.0.1';
const LIBRARY = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/vision_bundle.mjs`;
const WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm`;
const MODELS = [
  'models/face_landmarker.task',
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
];

export class FaceTracker {
  constructor(landmarker, delegate) {
    this.landmarker = landmarker;
    this.delegate = delegate;       // 'GPU' or 'CPU', just to show in the interface
    this.lastTime = -1;
  }

  // Loads the library and the model. Tries the graphics card first (fast),
  // then the processor (slower but works everywhere).
  static async create(onProgress = () => {}) {
    onProgress('Loading the face tracker…');
    const { FaceLandmarker, FilesetResolver } = await import(LIBRARY);
    const fileset = await FilesetResolver.forVisionTasks(WASM);

    let lastError = null;
    for (const modelAssetPath of MODELS) {
      for (const delegate of ['GPU', 'CPU']) {
        try {
          const landmarker = await FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath, delegate },
            runningMode: 'VIDEO',
            numFaces: 1,
            minFaceDetectionConfidence: 0.5,
            minFacePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });
          return new FaceTracker(landmarker, delegate);
        } catch (error) {
          lastError = error;
        }
      }
    }
    throw lastError;
  }

  // Returns the 478 landmarks of the first face found, or null.
  detect(video, timeMs) {
    // MediaPipe wants strictly increasing timestamps in video mode.
    if (timeMs <= this.lastTime) timeMs = this.lastTime + 1;
    this.lastTime = timeMs;
    const result = this.landmarker.detectForVideo(video, timeMs);
    return result.faceLandmarks?.[0] ?? null;
  }
}
