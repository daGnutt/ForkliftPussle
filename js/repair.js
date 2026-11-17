import { pointRectDist } from './geom.js';
import { toWorld } from './forklift.js';

// The repair station, a pallet turntable wrapping machine: a round turntable with a film mast (a solid post, `r.mast`) beside it. A turntable is next to the parking spot that holds one single box at a time. A box on it spins and is repaired at
// RATE crash points per second; while a truck is within PAUSE_DIST of the pad the box stands still and nothing is repaired.
export const PAD_HALF = 0.65, PAUSE_DIST = 1.5, SPIN = 2, RATE = 1, MAX_TAPE = 6, TAPE_EVERY = 8;
const SIDE = 2.4, MAST_AT = 1.05, MAST_HALF = 0.18;

// Places the pad beside the parking spot (either side, first one that is clear of walls, stacks and drop points), or null.
export function makeStation(g) {
  const p = g.parking, nx = -Math.sin(p.a), ny = Math.cos(p.a);
  for (const side of [1, -1]) {
    const x = p.x + nx * SIDE * side, y = p.y + ny * SIDE * side;
    if (g.walls.some((w) => pointRectDist(x, y, w) < PAD_HALF + 0.5)) continue;
    if (g.stacks.some((s) => Math.hypot(s.x - x, s.y - y) < PAD_HALF + 1)) continue;
    if (g.zones.some((z) => Math.hypot(z.x - x, z.y - y) < PAD_HALF + 1.6)) continue;
    const mx = x + nx * side * MAST_AT, my = y + ny * side * MAST_AT;
    if (g.walls.some((w) => pointRectDist(mx, my, w) < MAST_HALF + 0.6)) continue;
    return { x, y, on: false, acc: 0, ang: 0, mast: { x: mx - MAST_HALF, y: my - MAST_HALF, w: 2 * MAST_HALF, h: 2 * MAST_HALF } };
  }
  return null;
}

// The single box on the pad: a lone 1×1 box resting on its middle.
export const boxOnPad = (g) => g.stacks.find((s) => s.layers.length === 1 && s.pen?.[0] && !s.pen[0].wide && Math.hypot(s.x - g.repair.x, s.y - g.repair.y) < 0.5);

// `fls`: the forklift frames of all trucks in play.
export const truckNearPad = (r, fls) => fls.some((f) => [-1.9, -1.4, -0.9, -0.4, 0, 0.35].some((u) => { const q = toWorld(f, u, 0); return Math.hypot(q.x - r.x, q.y - r.y) < PAUSE_DIST; }));

export const tapeCount = (pen) => (pen.fix > 0 ? Math.min(MAX_TAPE, 1 + Math.floor(pen.fix / TAPE_EVERY)) : 0);

export function stepRepair(g, dt, fls) {
  const r = g.repair;
  if (!r) return;
  const s = boxOnPad(g), pen = s?.pen[0];
  r.on = !!pen && pen.crash > 0 && !truckNearPad(r, fls);
  if (!r.on) { r.acc = 0; return; }
  r.ang = ((r.ang || 0) + SPIN * dt) % (2 * Math.PI);
  s.rots ||= [s.a || 0];
  s.a = (s.a || 0) + SPIN * dt; s.rots[0] += SPIN * dt;
  r.acc += RATE * dt;
  while (r.acc >= 1 && pen.crash > 0) { r.acc -= 1; pen.crash -= 1; pen.fix = (pen.fix || 0) + 1; }
  pen.tape = tapeCount(pen);
  if (pen.crash <= 0) { // done: straighten the box and smooth out its dents
    pen.crash = 0; delete pen.dent; r.on = false; r.acc = 0;
    const q = Math.PI / 2, a = Math.round(s.a / q) * q;
    s.rots[0] += a - s.a; s.a = a;
  }
}

// Floor art of the turntable in world coordinates: `{ pts, hex, alpha }` polygons (dark platform, rim, four spokes turning with the box).
export function padPolys(r) {
  const h = PAD_HALF, N = 24, ang = r.ang || 0, hot = r.on ? '#fff176' : '#ffca28';
  const ring = (rad, k) => [r.x + Math.cos((k * 2 * Math.PI) / N) * rad, r.y + Math.sin((k * 2 * Math.PI) / N) * rad];
  const out = [{ pts: Array.from({ length: N }, (_, k) => ring(h, k)), hex: '#455a64', alpha: 0.85 }];
  for (let k = 0; k < N; k++) out.push({ pts: [ring(h, k), ring(h, k + 1), ring(h - 0.06, k + 1), ring(h - 0.06, k)], hex: k % 2 ? '#212121' : '#ffca28', alpha: 1 });
  for (let k = 0; k < 4; k++) {
    const a = ang + (k * Math.PI) / 2, c = Math.cos(a), s = Math.sin(a), at = (u, v) => [r.x + u * c - v * s, r.y + u * s + v * c];
    out.push({ pts: [at(0.1, -0.05), at(h - 0.12, -0.05), at(h - 0.12, 0.05), at(0.1, 0.05)], hex: hot, alpha: 1 });
  }
  return out;
}

// Tape on a box lid, box-local (-0.5..0.5): `tapeCount(pen)` diagonal strips, alternating direction, clipped to the lid.
export function tapeShapes(pen) {
  const n = pen.tape || 0, out = [], w = 0.045;
  for (let i = 0; i < n; i++) {
    const dir = i % 2 ? -1 : 1, c = (i - (n - 1) / 2) * 0.2, strip = [[-1, c - 1 - w], [1, c + 1 - w], [1, c + 1 + w], [-1, c - 1 + w]].map(([u, v]) => [u, dir * v]);
    let poly = strip;
    for (const [ax, ay, bound] of [[1, 0, 0.5], [-1, 0, 0.5], [0, 1, 0.5], [0, -1, 0.5]]) {
      const inside = ([u, v]) => ax * u + ay * v <= bound, next = [];
      poly.forEach((a, k) => {
        const b = poly[(k + 1) % poly.length], ia = inside(a), ib = inside(b);
        if (ia) next.push(a);
        if (ia !== ib) { const da = ax * a[0] + ay * a[1] - bound, db = ax * b[0] + ay * b[1] - bound, f = da / (da - db); next.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); }
      });
      poly = next;
    }
    if (poly.length > 2) out.push(poly);
  }
  return out;
}
export const TAPE_FILL = '#e8d9a0';
