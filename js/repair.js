import { pointRectDist } from './geom.js';
import { toWorld } from './forklift.js';

// The repair station: a pad next to the parking spot that holds one single box at a time. A box on it spins and is repaired at
// RATE crash points per second; while a truck is within PAUSE_DIST of the pad the box stands still and nothing is repaired.
export const PAD_HALF = 0.65, PAUSE_DIST = 1.5, SPIN = 2, RATE = 1, MAX_TAPE = 6, TAPE_EVERY = 8;
const SIDE = 2.4;

// Places the pad beside the parking spot (either side, first one that is clear of walls, stacks and drop points), or null.
export function makeStation(g) {
  const p = g.parking, nx = -Math.sin(p.a), ny = Math.cos(p.a);
  for (const side of [1, -1]) {
    const x = p.x + nx * SIDE * side, y = p.y + ny * SIDE * side;
    if (g.walls.some((w) => pointRectDist(x, y, w) < PAD_HALF + 0.5)) continue;
    if (g.stacks.some((s) => Math.hypot(s.x - x, s.y - y) < PAD_HALF + 1)) continue;
    if (g.zones.some((z) => Math.hypot(z.x - x, z.y - y) < PAD_HALF + 1.6)) continue;
    return { x, y, on: false, acc: 0 };
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

// Floor art of the pad in world coordinates: `{ pts, hex, alpha }` polygons (base, border, plus sign); yellow while a box is being repaired.
export function padPolys(r) {
  const h = PAD_HALF, t = 0.07, hex = r.on ? '#ffca28' : '#42a5f5', rect = (u0, v0, u1, v1) => [[r.x + u0, r.y + v0], [r.x + u1, r.y + v0], [r.x + u1, r.y + v1], [r.x + u0, r.y + v1]];
  return [
    { pts: rect(-h, -h, h, h), hex, alpha: 0.3 },
    ...[rect(-h, -h, h, -h + t), rect(-h, h - t, h, h), rect(-h, -h + t, -h + t, h - t), rect(h - t, -h + t, h, h - t), rect(-0.08, -0.35, 0.08, 0.35), rect(-0.35, -0.08, 0.35, 0.08)].map((pts) => ({ pts, hex, alpha: 1 })),
  ];
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
