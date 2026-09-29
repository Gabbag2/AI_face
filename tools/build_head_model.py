"""
build_head_model.py  -  builds js/headModelData.js (the "head model" the app uses)

You only need to run this again if you change something in here.
The app itself never runs Python: it just imports the generated JS file.

    python tools/build_head_model.py

WHAT PROBLEM DOES THIS SOLVE?
-----------------------------
The camera only sees your FACE. MediaPipe gives us 478 points on the face,
but no EEG positions (Fp1, AF7, ...). EEG positions are defined on the whole
HEAD with a tape measure (the "10-20 system": 10% / 20% of head distances).

So we need, once and for all, a 3D description of:
  (a) the face points MediaPipe tracks, and
  (b) the EEG positions,
in the SAME coordinate system. Then, in the app, when we know where the face is,
we automatically know where the EEG positions are.

We build it from two public data sets (copies are in tools/data/):
  1. canonical_face_model.obj  - MediaPipe's "average face": the 468 landmarks
     in 3D, in centimetres. (github.com/google-ai-edge/mediapipe)
  2. standard_1005.elc         - the standard 10-05 EEG positions on the MNI
     template head, in millimetres (Oostenveld & Praamstra 2001, FieldTrip).
And one file that tells us which face points are "rigid" (good for tracking):
  3. geometry_pipeline_metadata_landmarks.pbtxt - MediaPipe's own list of
     landmarks + weights it uses to estimate head pose.

THE STEPS
---------
 1. Face model -> millimetres, origin at the nasion (landmark 168: the deepest
    point of the nose bridge between the eyes, the anchor of the 10-20 system).
 2. EEG head -> same axes, same size, same origin:
      a. axes : MNI is (x = right, y = front, z = up)
                our face frame is (x = subject's LEFT, y = up, z = out of the face)
      b. size : the MNI head is big (607 mm around). We shrink it to an average
                adult head (560 mm), which matches the size of the average face.
      c. origin: MNI nasion "Nz" -> face nasion (landmark 168)
      d. tilt : the two models are not tilted the same way (head nodding
                "yes"). We try tilts and keep the one that lays the forehead
                electrodes exactly on the face's forehead skin.
 3. Fit a sphere to the forehead. The app uses it to (i) "drape" the virtual
    sensor on the forehead and (ii) "unwrap" the forehead to find the real sensor.
 4. Write js/headModelData.js.
"""

import os
import re

import numpy as np
from scipy.optimize import least_squares, minimize_scalar

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "..", "js", "headModelData.js")

NASION_LANDMARK = 168          # MediaPipe index of the nasion
AVERAGE_HEAD_CIRCUMFERENCE = 560.0   # mm, typical adult (men ~570, women ~550)

# MediaPipe's pose landmarks we DROP because they are on the jaw
# (they move when you talk, which would make the overlay wobble).
JAW_LANDMARKS = {136, 365, 132, 361}

# EEG positions we export (the ones that make sense on / near the forehead).
# Odd numbers = LEFT hemisphere, even = RIGHT, "z" = midline.
EXPORTED_POSITIONS = ["Fp1", "Fpz", "Fp2",
                      "AF7", "AF3", "AFz", "AF4", "AF8",
                      "F7", "F3", "Fz", "F4", "F8"]


# ---------------------------------------------------------------------------
# 1. Load the canonical face
# ---------------------------------------------------------------------------
def load_obj(path):
    """Return (vertices Nx3, triangles Mx3) from a Wavefront .obj file."""
    verts, tris = [], []
    with open(path) as f:
        for line in f:
            if line.startswith("v "):                       # "v x y z"
                verts.append([float(t) for t in line.split()[1:4]])
            elif line.startswith("f "):                     # "f a/ta b/tb c/tc" (1-based)
                tris.append([int(t.split("/")[0]) - 1 for t in line.split()[1:4]])
    return np.array(verts), np.array(tris)


face_cm, triangles = load_obj(os.path.join(DATA, "canonical_face_model.obj"))
face = face_cm * 10.0                          # cm -> mm
face = face - face[NASION_LANDMARK]            # origin = nasion
# The canonical face already uses: x = subject's left, y = up, z = out of the face.

# MediaPipe's pose landmarks and weights ("procrustes_landmark_basis" lines).
with open(os.path.join(DATA, "geometry_pipeline_metadata_landmarks.pbtxt")) as f:
    basis = re.findall(r"landmark_id: (\d+) weight: ([\d.eE-]+)", f.read())
procrustes = [(int(i), float(w)) for i, w in basis if int(i) not in JAW_LANDMARKS]


# ---------------------------------------------------------------------------
# 2. Load the EEG head and move it onto the face
# ---------------------------------------------------------------------------
def load_elc(path):
    """Return {label: xyz} from an ASA .elc electrode file."""
    lines = [l.strip() for l in open(path)]
    i_pos, i_lab = lines.index("Positions"), lines.index("Labels")
    pos = [list(map(float, l.split())) for l in lines[i_pos + 1:i_lab] if l]
    labels = [l for l in lines[i_lab + 1:] if l]
    return dict(zip(labels, np.array(pos)))


mni = load_elc(os.path.join(DATA, "standard_1005.elc"))

# 2a. Axes. MNI (x=right, y=front, z=up) -> ours (x=left, y=up, z=front).
#     new x = -old x, new y = old z, new z = old y. (This is a pure rotation.)
def mni_to_face_axes(p):
    return np.array([-p[0], p[2], p[1]])


eeg = {name: mni_to_face_axes(p) for name, p in mni.items()}

# 2b. Size. Measure the head circumference of the template along the
#     "10% line" (the tape-measure line through Fpz, T7, Oz, T8 used in 10-20).
LEFT_HALF = ["Fpz", "Fp1h", "Fp1", "AFp7", "AF7", "AFF7", "F7", "FFT7", "FT7", "FTT7", "T7",
             "TTP7", "TP7", "TPP7", "P7", "PPO7", "PO7", "POO7", "O1", "O1h", "Oz"]
RIGHT_HALF = [n.replace("7", "8").replace("1", "2") for n in LEFT_HALF]


def polyline_length(names):
    pts = np.array([eeg[n] for n in names])
    return float(np.sum(np.linalg.norm(np.diff(pts, axis=0), axis=1)))


template_circumference = polyline_length(LEFT_HALF) + polyline_length(RIGHT_HALF)
scale = AVERAGE_HEAD_CIRCUMFERENCE / template_circumference

# 2c. Origin: put the template nasion "Nz" at 0 (our origin is the face nasion).
nz = eeg["Nz"].copy()
eeg = {name: (p - nz) * scale for name, p in eeg.items()}


# 2d. Tilt. Rotation about the x axis (the ear-to-ear axis) by `deg` degrees.
def rot_x(deg):
    a = np.radians(deg)
    return np.array([[1, 0, 0],
                     [0, np.cos(a), -np.sin(a)],
                     [0, np.sin(a), np.cos(a)]])


def face_depth_at(x, y):
    """z of the face skin at (x, y), looking at the face from the front.
    We find the mesh triangle that contains (x, y) and interpolate its z."""
    best = None
    for tri in triangles:
        (x1, y1, z1), (x2, y2, z2), (x3, y3, z3) = face[tri]
        det = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3)
        if abs(det) < 1e-9:
            continue
        l1 = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / det    # barycentric coords
        l2 = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / det
        l3 = 1 - l1 - l2
        if min(l1, l2, l3) >= 0:                                    # inside the triangle
            z = l1 * z1 + l2 * z2 + l3 * z3
            best = z if best is None else max(best, z)              # front-most surface
    return best


# Electrodes that sit on the part of the forehead covered by the face mesh.
FOREHEAD_ELECTRODES = ["Fpz", "Fp1", "Fp2", "Fp1h", "Fp2h", "AFpz", "AFp1", "AFp2", "AFp3",
                       "AFp4", "AFp1h", "AFp2h", "AFp3h", "AFp4h", "AFp5", "AFp6"]


def forehead_misfit(deg):
    """RMS distance (mm, front-back) between the tilted electrodes and the face skin."""
    R = rot_x(deg)
    errors = []
    for name in FOREHEAD_ELECTRODES:
        p = R @ eeg[name]
        skin_z = face_depth_at(p[0], p[1])
        if skin_z is not None:
            errors.append(p[2] - skin_z)
    return float(np.sqrt(np.mean(np.square(errors))))


fit = minimize_scalar(forehead_misfit, bounds=(-25, 15), method="bounded")
pitch = fit.x
R = rot_x(pitch)
eeg = {name: R @ p for name, p in eeg.items()}

# Make left/right perfectly symmetric (the template is only ~1 mm asymmetric).
def mirror_name(name):
    """Fp1 -> Fp2, AF8 -> AF7, AFp3h -> AFp4h. Midline names (no number) map to themselves."""
    m = re.match(r"^(.*?)(\d+)(h?)$", name)
    if not m:
        return name                                   # midline ("z") or fiducial
    prefix, number, half = m.groups()
    n = int(number)
    return f"{prefix}{n + 1 if n % 2 else n - 1}{half}"


symmetric = {}
for name, p in eeg.items():
    other = mirror_name(name)
    if name in ("LPA", "RPA", "Nz") or other not in eeg:
        symmetric[name] = p
        continue
    q = eeg[other] * np.array([-1, 1, 1])              # mirror the partner
    avg = (p + q) / 2
    if other == name:                                  # midline point
        avg[0] = 0.0
    symmetric[name] = avg
eeg = symmetric


# ---------------------------------------------------------------------------
# 3. Fit a sphere to the forehead region (electrodes + face-mesh forehead)
# ---------------------------------------------------------------------------
# Frontal rows only: Fp.., AFp.., AF.., AFF.., F1..F10/Fz (not FC/FT: those are further back),
# and only above the eyebrow line (y > 8 mm above the nasion).
FRONTAL_ROW = re.compile(r"^(Fp|AFp|AFF|AF|F)(\d+h?|z)$")
band = [p for name, p in eeg.items() if FRONTAL_ROW.match(name) and p[1] > 8]
mesh_forehead = [p for p in face if p[1] > 15]         # above the eyebrows
points = np.array(band + mesh_forehead)


def sphere_residuals(params):
    cy, cz, radius = params                            # centre x is 0 (symmetry)
    centre = np.array([0.0, cy, cz])
    return np.linalg.norm(points - centre, axis=1) - radius


sph = least_squares(sphere_residuals, x0=[20.0, -70.0, 80.0])
sphere_centre = np.array([0.0, sph.x[0], sph.x[1]])
sphere_radius = float(sph.x[2])
sphere_rms = float(np.sqrt(np.mean(sph.fun ** 2)))


def on_sphere(p):
    """Push a point radially onto the sphere (moves it < 4 mm, mostly in depth)."""
    d = p - sphere_centre
    return sphere_centre + d / np.linalg.norm(d) * sphere_radius


# ---------------------------------------------------------------------------
# 4. Write the JS module
# ---------------------------------------------------------------------------
def vec(v):
    """[x, y, z] rounded to 0.01 mm, written on one line."""
    return "[" + ", ".join(f"{float(x):.2f}" for x in v) + "]"


lines = [
    "// AUTO-GENERATED by tools/build_head_model.py - do not edit by hand.",
    "// Everything is in millimetres, in the \"head frame\":",
    "//   origin = nasion (MediaPipe landmark 168), x = subject's LEFT, y = up, z = out of the face.",
    "export const HEAD_MODEL = {",
    f"  averageHeadCircumferenceMm: {AVERAGE_HEAD_CIRCUMFERENCE:.0f},",
    f"  templateScale: {scale:.4f},        // MNI head -> average head",
    f"  pitchDeg: {pitch:.2f},            // tilt that lays the EEG forehead on the face forehead",
    f"  foreheadFitRmsMm: {fit.fun:.2f},      // how well it fits after that tilt",
    "",
    "  // Face landmarks used to find the head pose: MediaPipe index, weight, 3D position.",
    "  procrustes: [",
]
lines += [f"    {{ index: {i}, weight: {w:.5f}, pos: {vec(face[i])} }}," for i, w in procrustes]
lines += [
    "  ],",
    "",
    "  // EEG 10-10 positions (MNI template registered onto the face, then put on the sphere).",
    "  eeg: {",
]
lines += [f"    {name}: {vec(on_sphere(eeg[name]))}," for name in EXPORTED_POSITIONS]
lines += [
    "  },",
    "",
    "  // Sphere fitted to the forehead: used to drape the sensor and to unwrap the forehead.",
    f"  sphere: {{ center: {vec(sphere_centre)}, radius: {sphere_radius:.2f}, rmsMm: {sphere_rms:.2f} }},",
    "};",
    "",
]
with open(OUT, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))

print(f"template circumference : {template_circumference:.1f} mm -> scale {scale:.4f}")
print(f"best tilt (pitch)      : {pitch:.2f} deg, forehead misfit {fit.fun:.2f} mm RMS")
print(f"sphere                 : centre {vec(sphere_centre)} mm, radius {sphere_radius:.1f} mm, RMS {sphere_rms:.2f} mm")
print(f"pose landmarks         : {len(procrustes)}")
for name in EXPORTED_POSITIONS:
    print(f"  {name:4s} {vec(on_sphere(eeg[name]))}")
print("wrote", os.path.normpath(OUT))
