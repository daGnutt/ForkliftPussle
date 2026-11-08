import { toWorld, FL } from '../forklift.js';
import { EYE_X, EYE_Z, HFOV, BOX_H, PAL } from '../pov/camera.js';
import { perspective, viewBasis, mul } from './mat.js';

// Camera maths for the WebGL renderer (pure, no DOM). A camera is { vp, eye: [x, y, z], w, h } (w, h in css px).

const POV_NEAR = 0.06, POV_FAR = 90;
const LOW_LIFT = 0.22; // radians the view is raised above the fork-tip line when the forks are low (fades out by level 2)

// In gear R the driver leans out to the steered side (g.lean, -1 left) and a bit back to see past the seat back;
// the swivel direction (g.sweep) is latched in D, and the head turns into the reversing path.
const LEAN_OUT = 0.4, LEAN_BACK = 0.1;

// The driver looks into the turn: a small yaw proportional to the steering angle, regardless of speed or direction.
const HEAD_TURN = 0.3;
function headTurn(f) {
  return HEAD_TURN * (f.steer / FL.maxSteer);
}

// Cabin view: eye fixed at seat height (no up/down translation); the camera only pitches to look at the fork tips
// (smoothed level g.ef), so the view tilts up and down as the forks rise and fall. `look` ({ yaw, pitch } radians) turns the head.
export function povCamera(g, w, h, look = null) {
  const e = toWorld(g.fl, EYE_X - LEAN_BACK * g.rv, LEAN_OUT * g.lean * g.rv);
  const a = g.fl.a + (look ? look.yaw : 0) + headTurn(g.fl) * (1 - g.rv) + (Math.PI * g.sweep - headTurn(g.fl)) * g.rv;
  const tip = FL.tineX1 - EYE_X, pitch = (Math.atan2(g.ef * (BOX_H + PAL) - EYE_Z, tip) + LOW_LIFT * Math.max(0, 1 - g.ef / 2)) * (1 - g.rv) + (look ? look.pitch : 0);
  const cp = Math.cos(pitch), sp = Math.sin(pitch), c = Math.cos(a), s = Math.sin(a);
  const f2w = 1 / Math.tan(HFOV / 2);
  const proj = perspective(f2w, (f2w * w) / h, 0, POV_NEAR, POV_FAR);
  const eye = [e.x, e.y, EYE_Z];
  const view = viewBasis(eye, [-s, c, 0], [-c * sp, -s * sp, cp], [c * cp, s * cp, sp]);
  return { vp: mul(proj, view), eye, w, h };
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

export const CHASE_TILES = 11, CHASE_TILT = 0.95, CHASE_OUT = 0.8;

// Chase zoom 0..100: 100 = fully zoomed in (CHASE_TILES tiles visible vertically), 0 = zoomed out by CHASE_OUT (80%).
export function chaseTiles(zoom) {
  return CHASE_TILES / (1 - CHASE_OUT * (1 - Math.min(100, Math.max(0, zoom)) / 100));
}
export function chaseZoom(tiles) {
  return Math.min(100, Math.max(0, Math.round(100 - ((1 - CHASE_TILES / tiles) / CHASE_OUT) * 100)));
}

// Third-person view: raised behind the forklift, looking along `heading` (the sprung camera heading, default the forklift's own) so the
// forklift points up the screen and the world rotates around it. `orbit` ({ yaw, tilt }, set by dragging/Q/W) swings the camera around
// the middle of the tines. `tiles` = tiles visible vertically at the centre, which sits 20% of that ahead of the tines' middle.
export function chaseCamera(g, w, h, tiles = CHASE_TILES, heading = g.fl.a, orbit = null) {
  const a = heading + (orbit ? orbit.yaw : 0);
  const p = toWorld(g.fl, (FL.tineX0 + FL.tineX1) / 2, 0);
  return { ...overviewCamera(p.x + Math.cos(a) * tiles * 0.2, p.y + Math.sin(a) * tiles * 0.2, tiles, w, h, [Math.cos(a), Math.sin(a)], orbit ? orbit.tilt : CHASE_TILT), chase: true };
}
