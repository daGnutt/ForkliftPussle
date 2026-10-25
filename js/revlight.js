import { FL, toWorld } from './forklift.js';

// Blue reversing light on the floor behind the forklift (pure geometry, DOM-free).
// The disc is cast as rays from its centre and stopped at the first wall, so it
// never leaks through or past walls. Rays that hit a wall within the radius
// carry `wall: true`; the cabin view lets the light climb the wall there
// (height `climb`, a spherical falloff).
export const REV_RADIUS = 0.6;
const REV_OFFSET = 1.0; // centre distance behind the rear of the forklift
const RAYS = 56;

function rayHit(g, ox, oy, dx, dy, max) {
  let best = max;
  for (const w of g.walls) {
    let t0 = 0, t1 = best;
    for (const [o, d, lo, hi] of [[ox, dx, w.x, w.x + w.w], [oy, dy, w.y, w.y + w.h]]) {
      if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { t1 = -1; break; } continue; }
      let a = (lo - o) / d, b = (hi - o) / d;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      if (t0 > t1) break;
    }
    if (t0 <= t1 && t1 >= 0 && t0 < best) best = t0;
  }
  return best;
}

export function reversing(g) {
  return g.status === 'play' && g.fl.speed < -0.05;
}

// Returns null when not reversing (or the centre is inside a wall), else
// { x, y, r, pts: [{x, y, d, wall, climb}] } with pts in angle order.
export function reverseLight(g) {
  if (!reversing(g)) return null;
  // The disc centre is fixed behind the forklift, so walls cut it off ever
  // more. If the centre is inside a wall, rays start from the nearest free
  // point towards the forklift and are limited to the disc.
  const c0 = toWorld(g.fl, FL.back - REV_OFFSET, 0);
  let c = null;
  for (let o = REV_OFFSET; o >= 0 && !c; o -= 0.05) {
    const p = toWorld(g.fl, FL.back - o, 0);
    if (!g.walls.some((w) => p.x > w.x && p.x < w.x + w.w && p.y > w.y && p.y < w.y + w.h)) c = p;
  }
  if (!c) return null;
  const off = Math.hypot(c.x - c0.x, c.y - c0.y);
  if (off >= REV_RADIUS) return null;
  const pts = [];
  for (let i = 0; i < RAYS; i++) {
    const a = (i / RAYS) * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
    // distance along the ray to the disc edge
    const bx = c.x - c0.x, by = c.y - c0.y, k = bx * dx + by * dy;
    const edge = -k + Math.sqrt(Math.max(0, k * k - (bx * bx + by * by - REV_RADIUS * REV_RADIUS)));
    const d = rayHit(g, c.x, c.y, dx, dy, edge);
    const wall = d < edge - 1e-6;
    const px = c.x + dx * d, py = c.y + dy * d;
    const r0 = Math.hypot(px - c0.x, py - c0.y);
    pts.push({ x: px, y: py, d, wall, climb: wall ? Math.sqrt(Math.max(0, REV_RADIUS * REV_RADIUS - r0 * r0)) : 0 });
  }
  return { x: c0.x, y: c0.y, r: REV_RADIUS, pts };
}
