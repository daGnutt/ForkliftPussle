import { toWorld, FL } from '../forklift.js';
import { EYE_X, EYE_Z, HFOV, BOX_H, PAL } from '../pov/camera.js';
import { perspective, viewBasis, mul } from './mat.js';
import { WALL_H } from './models.js';

// Camera maths for the WebGL renderer (pure, no DOM). A camera is { vp, eye: [x, y, z], w, h } (w, h in css px).

const POV_NEAR = 0.06, POV_FAR = 90;
const LOW_LIFT = 0.22; // radians the view is raised above the fork-tip line when the forks are low (fades out by level 2)

// The driver looks into the turn: a small yaw proportional to the steering angle, regardless of speed or direction.
const HEAD_TURN = 0.3;
function headTurn(f) {
  return HEAD_TURN * (f.steer / FL.maxSteer);
}

// Cabin view (always looks forward, also in reverse; see rearCamera): eye fixed at seat height (no up/down translation); the camera
// only pitches to look at the fork tips (smoothed level g.ef), so the view tilts up and down as the forks rise and fall. `look` ({ yaw, pitch } radians) turns the head.
export function povCamera(g, w, h, look = null) {
  const e = toWorld(g.fl, EYE_X, 0);
  const a = g.fl.a + (look ? look.yaw : 0) + headTurn(g.fl);
  const tip = FL.tineX1 - EYE_X, pitch = Math.atan2(g.ef * (BOX_H + PAL) - EYE_Z, tip) + LOW_LIFT * Math.max(0, 1 - g.ef / 2) + (look ? look.pitch : 0);
  const cp = Math.cos(pitch), sp = Math.sin(pitch), c = Math.cos(a), s = Math.sin(a);
  const f2w = 1 / Math.tan(HFOV / 2);
  const proj = perspective(f2w, (f2w * w) / h, 0, POV_NEAR, POV_FAR);
  const eye = [e.x, e.y, EYE_Z];
  const view = viewBasis(eye, [-s, c, 0], [-c * sp, -s * sp, cp], [c * cp, s * cp, sp]);
  return { vp: mul(proj, view), eye, w, h };
}

const REAR_Z = 1.05, REAR_PITCH = 0.5, REAR_HFOV = (110 * Math.PI) / 180;

// Reversing camera: mounted at the tail looking straight back, tilted down towards the floor, wide angle and mirrored (like a
// car's) so screen-left is the side the tail swings to when steering left in reverse.
export function rearCamera(g, w, h) {
  const e = toWorld(g.fl, FL.back, 0), a = g.fl.a + Math.PI;
  const cp = Math.cos(REAR_PITCH), sp = Math.sin(REAR_PITCH), c = Math.cos(a), s = Math.sin(a);
  const f2w = 1 / Math.tan(REAR_HFOV / 2);
  const proj = perspective(f2w, (f2w * w) / h, 0, POV_NEAR, POV_FAR);
  proj[0] = -proj[0];
  const eye = [e.x, e.y, REAR_Z];
  const view = viewBasis(eye, [-s, c, 0], [c * sp, s * sp, cp], [c * cp, s * cp, -sp]);
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

const OCC_MIN_VISIBLE = 0.5, OCC_STEP = 0.05, OCC_MIN_TILT = 0.05;
const OCC_PTS = [];
for (const x of [FL.back, (FL.back + FL.front) / 2, FL.front]) for (const y of [-FL.halfW, 0, FL.halfW]) for (const z of [0.3, 1.2]) OCC_PTS.push([x, y, z]);

// Does the segment a -> b pass through the wall box (full height WALL_H)? Slab test.
function segHitsWall(a, b, w, wallH) {
  let t0 = 0, t1 = 1;
  const lo = [w.x, w.y, 0], hi = [w.x + w.w, w.y + w.h, wallH];
  for (let i = 0; i < 3; i++) {
    const d = b[i] - a[i];
    if (Math.abs(d) < 1e-9) { if (a[i] < lo[i] || a[i] > hi[i]) return false; continue; }
    let ta = (lo[i] - a[i]) / d, tb = (hi[i] - a[i]) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

// Fraction (0..1) of sample points on the forklift body that the chase camera eye sees past the walls.
export function truckVisibility(g, eye, wallH = WALL_H) {
  let seen = 0;
  for (const [x, y, z] of OCC_PTS) {
    const p = toWorld(g.fl, x, y), q = [p.x, p.y, z];
    if (!g.walls.some((w) => segHitsWall(eye, q, w, wallH))) seen++;
  }
  return seen / OCC_PTS.length;
}

// Smallest tilt <= `tilt` (the camera orbits upwards, towards top-down) at which at least half of the forklift is visible
// from the chase camera with the given heading + orbit yaw and `tiles` visible; `tilt` itself when nothing obstructs it.
export function clearChaseTilt(g, tiles, heading, yaw, tilt, wallH = WALL_H) {
  const a = heading + yaw, p = toWorld(g.fl, (FL.tineX0 + FL.tineX1) / 2, 0);
  const cx = p.x + Math.cos(a) * tiles * 0.2, cy = p.y + Math.sin(a) * tiles * 0.2;
  const dist = tiles / 2 / Math.tan(OV_VFOV / 2);
  for (let t = tilt; ; t -= OCC_STEP) {
    t = Math.max(OCC_MIN_TILT, t);
    const eye = [cx - Math.cos(a) * Math.sin(t) * dist, cy - Math.sin(a) * Math.sin(t) * dist, Math.cos(t) * dist];
    if (truckVisibility(g, eye, wallH) >= OCC_MIN_VISIBLE || t <= OCC_MIN_TILT) return t;
  }
}
