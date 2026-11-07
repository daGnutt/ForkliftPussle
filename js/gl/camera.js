import { toWorld } from '../forklift.js';
import { EYE_X, EYE_Z, EYE_FOLLOW, EYE_TILT, HFOV, BOX_H, PAL } from '../pov/camera.js';
import { perspective, viewBasis, mul } from './mat.js';

// Camera maths for the WebGL renderer (pure, no DOM). A camera is { vp, eye: [x, y, z], w, h } (w, h in css px).

const POV_NEAR = 0.06, POV_FAR = 90;

// Cabin view: eye on the seat, rising part-way with the forks; the horizon shifts as the forks lead the eye.
export function povCamera(g, w, h) {
  const e = toWorld(g.fl, EYE_X, 0), z = EYE_Z + EYE_FOLLOW * g.ef * (BOX_H + PAL), a = g.fl.a;
  const p = 0.32 + EYE_TILT * (g.ef - g.hf);
  const f2w = 1 / Math.tan(HFOV / 2);
  const proj = perspective(f2w, (f2w * w) / h, 2 * p - 1, POV_NEAR, POV_FAR);
  const view = viewBasis([e.x, e.y, z], [-Math.sin(a), Math.cos(a), 0], [0, 0, 1], [Math.cos(a), Math.sin(a), 0]);
  return { vp: mul(proj, view), eye: [e.x, e.y, z], w, h };
}

export const OV_TILT = 0.35; // radians off vertical
const OV_VFOV = (30 * Math.PI) / 180;

// Top-down view: looks at world (cx, cy), `tilesH` tiles visible vertically at that point, `up` = world direction
// that points up the screen (default: -y). Leans back by OV_TILT so walls and stacks show their sides.
export function overviewCamera(cx, cy, tilesH, w, h, up = [0, -1], tilt = OV_TILT) {
  const dist = tilesH / 2 / Math.tan(OV_VFOV / 2), st = Math.sin(tilt), ct = Math.cos(tilt);
  const [ux, uy] = up;
  const eye = [cx - ux * st * dist, cy - uy * st * dist, ct * dist];
  const f2h = 1 / Math.tan(OV_VFOV / 2);
  const proj = perspective((f2h * h) / w, f2h, 0, dist * 0.15, dist * 3);
  const view = viewBasis(eye, [-uy, ux, 0], [ux * ct, uy * ct, st], [ux * st, uy * st, -ct]);
  return { vp: mul(proj, view), eye, w, h };
}
