import { FL, toWorld } from './forklift.js';

// Blue reversing light on the floor behind the forklift (pure geometry, DOM-free).
// The disc is cast as rays from its centre and stopped at the first wall, so it
// never leaks through or past walls. Rays that hit a wall within the radius
// carry `wall: true`; the cabin view lets the light climb the wall there
// (height `climb`, a spherical falloff).
export const REV_RADIUS = 0.9;
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
  const c = toWorld(g.fl, FL.back - REV_OFFSET, 0);
  const pts = [];
  for (let i = 0; i < RAYS; i++) {
    const a = (i / RAYS) * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
    const d = rayHit(g, c.x, c.y, dx, dy, REV_RADIUS);
    const wall = d < REV_RADIUS - 1e-6;
    if (wall && d < 1e-6) return null;
    pts.push({ x: c.x + dx * d, y: c.y + dy * d, d, wall, climb: wall ? Math.sqrt(REV_RADIUS * REV_RADIUS - d * d) : 0 });
  }
  return { x: c.x, y: c.y, r: REV_RADIUS, pts };
}
