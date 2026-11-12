import { toWorld, FL } from '../forklift.js';
import { EYE_X, EYE_Z, HFOV, BOX_H, PAL } from '../pov/camera.js';
import { perspective, viewBasis, mul, projectPoint } from './mat.js';
import { WALL_H } from './models.js';

// Camera maths for the WebGL renderer (pure, no DOM). A camera is { vp, eye: [x, y, z], w, h } (w, h in css px).

const POV_NEAR = 0.06, POV_FAR = 90;
const LOW_LIFT = 0.22; // radians the view is raised above the fork-tip line when the forks are low (fades out by level 2)

// The driver looks into the turn: a small yaw proportional to the steering angle, regardless of speed or direction.
const HEAD_TURN = 0.3;
export function headTurn(f) {
  return HEAD_TURN * (f.steer / FL.maxSteer);
}

// Cabin view (always looks forward, also in reverse): eye fixed at seat height (no up/down translation); the camera
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

export const CHASE_TILES = 7, CHASE_DEFAULT = 0.5, CHASE_TILT = 0.95, CHASE_OUT = 0.8; // CHASE_DEFAULT: the default chase view shows this fraction of the overview's tiles

// Chase zoom 0..100: 100 = fully zoomed in (CHASE_TILES tiles visible vertically), 0 = zoomed out by CHASE_OUT (80%).
export function chaseTiles(zoom) {
  return CHASE_TILES / (1 - CHASE_OUT * (1 - Math.min(100, Math.max(0, zoom)) / 100));
}
export function chaseZoom(tiles) {
  return Math.min(100, Math.max(0, Math.round(100 - ((1 - CHASE_TILES / tiles) / CHASE_OUT) * 100)));
}

const CHASE_MIN = 0.35; // closest the chase camera may get to the truck, as a fraction of its maximum distance

// Chase rig: the eye hangs at a fixed height (from `tilt`) and only slides over the floor when it has to, staying within `maxD` of the tines'
// middle (and not closer than CHASE_MIN * maxD); it then pitches/yaws to keep that point centred. `eye2` = [x, y] last eye position (null: behind
// `heading`); `yaw` swings the eye around the truck (user orbit). Returns { pos (the clamped floor position to keep for the next frame),
// eye, target, heading (eye -> truck, without yaw) }.
export function chaseRig(g, tiles, tilt, eye2, yaw = 0, heading = g.fl.a) {
  const p = toWorld(g.fl, (FL.tineX0 + FL.tineX1) / 2, 0);
  const dist = tiles / 2 / Math.tan(OV_VFOV / 2), maxD = Math.sin(tilt) * dist, z = Math.cos(tilt) * dist;
  let ox = eye2 ? eye2[0] - p.x : -Math.cos(heading + yaw) * maxD, oy = eye2 ? eye2[1] - p.y : -Math.sin(heading + yaw) * maxD;
  const d = Math.hypot(ox, oy);
  if (d < 1e-6) { ox = -Math.cos(heading); oy = -Math.sin(heading); }
  const k = Math.min(maxD, Math.max(CHASE_MIN * maxD, d)) / (d < 1e-6 ? 1 : d);
  ox *= k;
  oy *= k;
  const hd = Math.atan2(-oy, -ox), c = Math.cos(yaw), s = Math.sin(yaw);
  const rx = eye2 ? ox * c - oy * s : ox, ry = eye2 ? ox * s + oy * c : oy;
  return { pos: [p.x + ox, p.y + oy], eye: [p.x + rx, p.y + ry, z], target: [p.x, p.y], heading: eye2 ? hd : heading, dist, maxD };
}

const DRIFT_RATE = 0.7, DRIFT_SPEED = 2; // 1/s at DRIFT_SPEED tiles/s or more (scales down with speed)

// While the truck moves, the camera floor position `pos` slowly drifts towards the spot at distance `maxD` behind it (driving forwards) or in
// front of it (reversing); within the distance limits the rig leaves it alone otherwise. Returns the new [x, y].
export function chaseDrift(g, pos, maxD, dt) {
  const f = g.fl, sp = Math.min(1, Math.abs(f.speed) / DRIFT_SPEED);
  if (sp < 1e-3) return pos;
  const p = toWorld(f, (FL.tineX0 + FL.tineX1) / 2, 0), dir = f.speed > 0 ? 1 : -1;
  const k = 1 - Math.exp(-DRIFT_RATE * sp * dt);
  return [pos[0] + (p.x - dir * Math.cos(f.a) * maxD - pos[0]) * k, pos[1] + (p.y - dir * Math.sin(f.a) * maxD - pos[1]) * k];
}

// Third-person view: raised behind the forklift, looking at the middle of the tines (kept centred). `eye2` = the sprung floor position of the
// camera (see chaseRig; null = behind `heading`). `orbit` ({ yaw, tilt }, set by dragging/Q/W) swings the camera around the truck.
// `tiles` = tiles visible vertically at the truck when the camera is at its maximum distance.
export function chaseCamera(g, w, h, tiles = CHASE_TILES, heading = g.fl.a, orbit = null, eye2 = null) {
  const r = chaseRig(g, tiles, orbit ? orbit.tilt : CHASE_TILT, eye2, orbit ? orbit.yaw : 0, heading);
  const [ex, ey, ez] = r.eye, dx = r.target[0] - ex, dy = r.target[1] - ey, d = Math.hypot(dx, dy) || 1e-6, rr = Math.hypot(d, ez);
  const ux = dx / d, uy = dy / d, st = d / rr, ct = ez / rr;
  const f2h = 1 / Math.tan(OV_VFOV / 2);
  const proj = perspective((f2h * h) / w, f2h, 0, r.dist * 0.15, r.dist * 3);
  const view = viewBasis(r.eye, [-uy, ux, 0], [ux * ct, uy * ct, st], [ux * st, uy * st, -ct]);
  return { vp: mul(proj, view), eye: r.eye, w, h, chase: true, pos: r.pos, heading: r.heading };
}

const FOOT_MAX = 40; // tiles from the eye; floor points further away (or above the horizon) are pulled in

// Floor (z = 0) points seen at the screen corners of `cam`, as world [x, y] pairs: top-left, top-right, bottom-right, bottom-left.
// Top corners that look past the horizon or beyond FOOT_MAX tiles slide down the screen edge until they hit the floor in range.
export function groundFootprint(cam) {
  const v = cam.vp;
  const [a, b, c, d, e, f, g, h, i] = [v[0], v[4], v[12], v[1], v[5], v[13], v[3], v[7], v[15]]; // (x, y, 1) -> clip (cx, cy, cw)
  const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
  const D = f * g - d * i, E = a * i - c * g, F = c * d - a * f;
  const G = d * h - e * g, H = b * g - a * h, I = a * e - b * d;
  const at = (nx, ny) => {
    const X = A * nx + B * ny + C, Y = D * nx + E * ny + F, W = G * nx + H * ny + I;
    if (Math.abs(W) < 1e-9) return null;
    const x = X / W, y = Y / W, p = projectPoint(v, x, y, 0, 1, 1);
    return p && Math.hypot(x - cam.eye[0], y - cam.eye[1]) <= FOOT_MAX ? [x, y] : null;
  };
  const corner = (nx, ny) => {
    const direct = at(nx, ny);
    if (direct) return direct;
    let lo = ny, hi = -1, best = at(nx, -1); // ny = -1 is the bottom of the screen
    if (!best) return [cam.eye[0], cam.eye[1]];
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2, p = at(nx, mid);
      if (p) { best = p; hi = mid; } else lo = mid;
    }
    return best;
  };
  return [corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1)];
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
// from the chase camera (at floor position `eye2`, or behind heading + orbit yaw) with `tiles` visible; `tilt` itself when nothing obstructs it.
export function clearChaseTilt(g, tiles, heading, yaw, tilt, eye2 = null, wallH = WALL_H) {
  for (let t = tilt; ; t -= OCC_STEP) {
    t = Math.max(OCC_MIN_TILT, t);
    const eye = chaseRig(g, tiles, t, eye2, yaw, heading).eye;
    if (truckVisibility(g, eye, wallH) >= OCC_MIN_VISIBLE || t <= OCC_MIN_TILT) return t;
  }
}
