// config.js - every number you may want to tweak, in one place.
// Units are millimetres (mm) and degrees unless written otherwise.

// ---------------------------------------------------------------------------
// 1. YOUR SENSOR (defaults measured on the photo of the "CLIC" sensor)
//
// We describe the sensor as if it were lying flat, seen from the front,
// with its own little coordinate system:
//     s = along the strips, positive toward the subject's LEFT ear
//     t = across the strips, positive UP
//     (s, t) = (0, 0) is the centre of the black pod (the red LED)
// These values can also be changed in the app (Settings panel).
// ---------------------------------------------------------------------------
export const DEFAULT_SENSOR = {
  podWidth: 33,         // black pod, left to right
  podHeight: 16,        // black pod, top to bottom
  stripLength: 36,      // each dark strip, from the pod edge to its tip
  stripWidth: 7,        // height of a dark strip
  stripAngle: 0,        // how much the strips point downward (degrees, 0 = straight)
  electrodeOffset: 34,  // distance from the pod centre to each electrode centre
                        // (here: the middle of the fabric strip, which is the electrode)
};

// ---------------------------------------------------------------------------
// 2. WHERE YOU WANT THE SENSOR
// "left"/"right" = the EEG position under the sensor's left/right electrode.
// EEG convention: odd numbers are on the LEFT side of the head, even numbers
// on the RIGHT, "z" on the midline. "center" = put the pod itself on a point.
// ---------------------------------------------------------------------------
export const PLACEMENTS = [
  { id: 'Fp1-Fp2', label: 'Electrodes on Fp1 – Fp2', left: 'Fp1', right: 'Fp2' },
  { id: 'AF7-AF8', label: 'Electrodes on AF7 – AF8', left: 'AF7', right: 'AF8' },
  { id: 'F7-F8', label: 'Electrodes on F7 – F8', left: 'F7', right: 'F8' },
  { id: 'AF3-AF4', label: 'Electrodes on AF3 – AF4', left: 'AF3', right: 'AF4' },
  { id: 'Fpz', label: 'Pod centred on Fpz', center: 'Fpz' },
  { id: 'AFz', label: 'Pod centred on AFz', center: 'AFz' },
  { id: 'custom', label: 'Custom pair…' },
];

// ---------------------------------------------------------------------------
// 3. GUIDANCE ("move a bit to the left")
// ---------------------------------------------------------------------------
export const GUIDANCE = {
  goodMm: 3,           // position error below this = good
  goodDeg: 4,          // rotation error below this = good
  bigMm: 10,           // above this we say "move", below it "move a bit"
  holdMs: 700,         // must stay good this long before we say "Perfect"
  speakEveryMs: 2500,  // voice: don't talk more often than this
};

// ---------------------------------------------------------------------------
// 4. CAMERA AND PHYSICAL CONSTANTS
// ---------------------------------------------------------------------------
export const CAMERA = {
  width: 1280,          // requested resolution (the browser may give another one)
  height: 720,
  fovLongSideDeg: 68,   // typical phone / webcam field of view, along the long side
};

// The visible iris is ~11.7 mm wide in almost every adult. Measuring it in
// pixels tells us how many pixels = 1 mm on the face.
export const IRIS_DIAMETER_MM = 11.7;

// ---------------------------------------------------------------------------
// 5. SENSOR DETECTION (finding the real sensor in the image)
// The detector looks at a band of the forehead, measured on the skin from the
// nasion: from roiBottomMm to roiTopMm above it, and roiHalfWidthMm to each side.
// ---------------------------------------------------------------------------
export const DETECTION = {
  roiBottomMm: 16,
  roiTopMm: 80,
  roiHalfWidthMm: 72,
  minScore: 0.33,       // below this "match score" we say "sensor not found"
};
