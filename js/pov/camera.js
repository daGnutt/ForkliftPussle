// Cabin-view constants and projection maths. Camera space: fw = forward, rt = right, z = up.

export const EYE_X = -0.5; // seat position, local x (origin at the front axle)
export const EYE_Z = 1.45; // eye height with the fork on the floor
export const EYE_FOLLOW = 0.4; // share of the fork height the eye follows
export const CHARGER_H = 0.9; // 1.5 boxes
export const WALL_H = 4; // also the ceiling height; clears a 5-box stack (3.0)
export const BOX_H = 0.5; // drawn box height (footprint stays 1×1)
export const PAL = 0.1; // pallet / tine thickness
export const HFOV = Math.PI / 2;
export const REAR_HFOV = (130 * Math.PI) / 180;
export const MAX_DIST = 60;
export const FAR_DARK = 28;
export const DECAL_MAX_DIST = 30;
export const PALLET_COLOR = '#9a7040';

const NEAR = 0.08;

// Camera at world (eye.x, eye.y, z) looking along `yaw`; (x, y, w) is the screen box and `horizon` the horizon row inside it.
export function makeCamera(eye, z, yaw, fov, x, y, w, horizon) {
  return { x: eye.x, y: eye.y, z, c: Math.cos(yaw), s: Math.sin(yaw), f: w / 2 / Math.tan(fov / 2), cx: x + w / 2, cy: y + horizon };
}

// World point + height -> camera space.
export function toCam(cam, px, py, z) {
  const dx = px - cam.x, dy = py - cam.y;
  return [dx * cam.c + dy * cam.s, -dx * cam.s + dy * cam.c, z - cam.z];
}

export function toScreen(cam, [fw, rt, z]) {
  return [cam.cx + (rt / fw) * cam.f, cam.cy - (z / fw) * cam.f];
}

// Clips a camera-space polygon to fw >= NEAR.
function clipNear(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const ain = a[0] >= NEAR, bin = b[0] >= NEAR;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (NEAR - a[0]) / (b[0] - a[0]);
      out.push([NEAR, a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
    }
  }
  return out;
}

export function project(cam, pts) {
  return clipNear(pts).map((p) => toScreen(cam, p));
}

// Projects a 2-point line, clipped to the near plane (null if fully behind it).
function projectLine(cam, a, b) {
  const ain = a[0] >= NEAR, bin = b[0] >= NEAR;
  if (!ain && !bin) return null;
  const cut = (p, q) => {
    const t = (NEAR - p[0]) / (q[0] - p[0]);
    return [NEAR, p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])];
  };
  return [ain ? a : cut(a, b), bin ? b : cut(b, a)].map((p) => toScreen(cam, p));
}

export function pathPoly(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([X, Y], i) => (i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y)));
  ctx.closePath();
}

export function fillPoly(ctx, pts, fill, stroke) {
  if (pts.length < 3) return;
  pathPoly(ctx, pts);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
}

export function floorPoly(ctx, cam, corners, fill, stroke) {
  fillPoly(ctx, project(cam, corners.map(([x, y]) => toCam(cam, x, y, 0))), fill, stroke);
}

// Strokes world-space segments [ax, ay, bx, by] at height z as one path.
export function strokeLines(ctx, cam, segs, z, style, width) {
  ctx.beginPath();
  for (const [ax, ay, bx, by] of segs) {
    const p = projectLine(cam, toCam(cam, ax, ay, z), toCam(cam, bx, by, z));
    if (p) { ctx.moveTo(p[0][0], p[0][1]); ctx.lineTo(p[1][0], p[1][1]); }
  }
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.stroke();
}
