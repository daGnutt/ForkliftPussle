import { COLORS } from '../level.js';
import { theme } from '../theme.js';
import { FL, toWorld } from '../forklift.js';
import { topShapes, DENT_FILL } from '../dents.js';
import { decalsEnabled, boxDecalKind, boxDecalShapes } from '../decals.js';
import { carriedWorldOffs } from '../game.js';
import { parseColor, shade, mix } from './mesh.js';

// Geometry of the movable things (forklift, pallets, boxes). Heights in tiles; a box is BOX_H tall, a pallet PAL.
export const BOX_H = 0.5;
export const PAL = 0.1;
export const WALL_H = 4;
export const PALLET_COLOR = '#9a7040';
const WHITE = [1, 1, 1, 1];

// Dark-mode lamps in the forklift frame: headlights high on the A-pillars, tail lamps on the counterweight.
export const HEAD_Z = 1.4, TAIL_Z = 0.7, LAMP_Y = 0.38;
export const HEAD_X = FL.front + 0.02, TAIL_X = FL.back - 0.03;

// Runners along the fork axis [lateral offset, half width], as in game.js (a slot for each tine between them).
const RUNNERS = [[0, 0.12], [-0.47, 0.03], [0.47, 0.03]];
const SLATS = [-0.42, -0.21, 0, 0.21, 0.42];

// Pallet with box on top: three runners, five deck slats, a taped cardboard box with a lid.
// `dent`/`deco` decals go to the transparent mesh `tm` (drawn after, blended over the box top).
function addBox(m, tm, x, y, r, z, col, pen, level) {
  const co = Math.cos(r), si = Math.sin(r), wood = parseColor(PALLET_COLOR);
  for (const [off, hw] of RUNNERS) m.cuboid(x - si * off, y + co * off, r, 0.5, hw, z, z + PAL - 0.025, shade(wood, 0.82), { top: false, bottom: level === 0 });
  SLATS.forEach((u, i) => m.cuboid(x + co * u, y + si * u, r, 0.075, 0.5, z + PAL - 0.03, z + PAL, shade(wood, i & 1 ? 1 : 0.92), { bottom: false }));
  const dented = !!pen?.dent;
  const base = parseColor(COLORS[col]);
  const body = dented ? shade(base, 0.82) : base;
  const z0 = z + PAL, z1 = z0 + BOX_H;
  m.cuboid(x, y, r, 0.5, 0.5, z0, z1, body, { bottom: false });
  m.cuboid(x, y, r, 0.46, 0.46, z1, z1 + 0.012, shade(mix(body, WHITE, 0.18), 1), { bottom: false });
  m.cuboid(x, y, r, 0.07, 0.505, z0, z1 + 0.018, mix(body, WHITE, 0.45), { bottom: false });
  const top = z1 + 0.02;
  const place = (u, v) => [x + u * co - v * si, y + u * si + v * co];
  if (dented) for (const poly of topShapes(pen, level + Math.round(col * 7))) tm.poly(poly.map(([u, v]) => place(u, v)), top, [...parseColor(DENT_FILL).slice(0, 3), 0.6]);
  if (decalsEnabled()) {
    for (const d of boxDecalShapes(pen?.deco ?? boxDecalKind(col, level))) tm.poly(d.pts.map(([u, v]) => place(u * 0.4, -v * 0.4)), top, d.fill);
  }
}

// Stack with a pallet under every box; level h sits at height h * (BOX_H + PAL).
// Boxes from index `from` up are drawn `extra` levels higher (a stack still being lowered).
export function addStack(m, tm, x0, y0, rots, layers, level, offs = [], from = 0, extra = 0, pens = []) {
  layers.forEach((col, i) => {
    const x = x0 + (offs[i]?.x || 0), y = y0 + (offs[i]?.y || 0);
    const z = (level + i + (i >= from ? extra : 0)) * (BOX_H + PAL);
    addBox(m, tm, x, y, rots[i] ?? 0, z, col, pens[i], i);
  });
}

// Forklift: wheels, chassis, counterweight, mast, overhead guard. In the cabin view the roof is a see-through grid.
export function addForklift(m, g, solidRoof) {
  const f = g.fl, a = f.a, W = FL.halfW;
  const box = (x0, y0, x1, y1, z0, z1, col, opts) => {
    const c = toWorld(f, (x0 + x1) / 2, (y0 + y1) / 2);
    m.cuboid(c.x, c.y, a, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, z0, z1, col, opts);
  };
  const wheel = (lx, ly, ang) => {
    const c = toWorld(f, lx, ly);
    m.wheel(c.x, c.y, 0.17, a + ang, 0.17, 0.1, '#1c1c1c');
  };
  wheel(0, -W - 0.02, 0);
  wheel(0, W + 0.02, 0);
  wheel(-FL.L, -W + 0.08, -f.steer);
  wheel(-FL.L, W - 0.08, -f.steer);
  if (solidRoof) box(FL.back, -W, FL.front, W, 0.15, 0.5, '#f9a825');
  else { // cabin view: the hood in front of the eye stays low so it doesn't fill the screen
    box(FL.back, -W, -0.75, W, 0.15, 0.5, '#f9a825');
    box(-0.75, -W, FL.front, W, 0.12, 0.2, '#f9a825');
  }
  box(FL.back, -W, FL.back + 0.55, W, 0.5, 0.85, '#6d4c00');
  box(-0.9, -0.3, -0.2, 0.3, 0.5, 0.6, '#2b2e33'); // seat
  box(-1.0, -0.3, -0.85, 0.3, 0.6, 1.05, '#2b2e33');
  const pw = solidRoof ? 0.04 : 0.018, mw = solidRoof ? 0.06 : 0.03;
  for (const s of [-1, 1]) {
    box(FL.front - 0.12, s * 0.38 - mw, FL.front + 0.02, s * 0.38 + mw, 0.5, 1.5, '#555');
    box(FL.front - 0.1, s * 0.3 - mw * 0.66, FL.front, s * 0.3 + mw * 0.66, 0.5, Math.max(1.5, g.hf * (BOX_H + PAL) + 0.9), '#8a8f96'); // inner mast
    for (const px of [-1.1, -0.05]) box(px - pw, s * 0.42 - pw, px + pw, s * 0.42 + pw, solidRoof ? 0.5 : 0.3, 1.15, '#37474f');
  }
  if (solidRoof) box(FL.front - 0.12, -0.38, FL.front + 0.02, 0.38, 1.3, 1.5, '#555');
  if (theme().dark) {
    const tail = g.fl.speed < -0.05 ? '#ffffff' : g.fl.brake ? '#ff2a1a' : '#6a0d0a';
    for (const s of [-1, 1]) {
      box(HEAD_X - 0.12, s * LAMP_Y - 0.06, HEAD_X + 0.03, s * LAMP_Y + 0.06, HEAD_Z - 0.06, HEAD_Z + 0.06, '#fff4cf', { emissive: true });
      box(TAIL_X - 0.02, s * LAMP_Y - 0.08, TAIL_X + 0.1, s * LAMP_Y + 0.08, TAIL_Z - 0.04, TAIL_Z + 0.04, tail, { emissive: true });
    }
  }
  if (solidRoof) {
    box(-1.2, -0.5, 0.05, 0.5, 1.15, 1.25, '#a1730f');
    box(-1.0, -0.33, -0.1, 0.33, 1.25, 1.27, '#fff3c4');
    const q = toWorld(f, 0.2, 0), r1 = toWorld(f, -0.1, -0.1), r2 = toWorld(f, -0.1, 0.1);
    m.tri([r1.x, r1.y, 1.275], [q.x, q.y, 1.275], [r2.x, r2.y, 1.275], [0, 0, 1], parseColor('#c62828'));
  } else {
    box(-1.2, -0.5, 0.05, -0.46, 1.15, 1.2, '#a1730f');
    box(-1.2, 0.46, 0.05, 0.5, 1.15, 1.2, '#a1730f');
    box(0.01, -0.5, 0.05, 0.5, 1.15, 1.2, '#a1730f');
    box(-1.2, -0.5, -1.16, 0.5, 1.15, 1.2, '#a1730f');
  }
}

// Fork carriage: backrest, upright shank and a blade with a tapered, thinner tip per tine.
export function addForks(m, g) {
  const tz = g.hf * (BOX_H + PAL), col = theme().tine, a = g.fl.a;
  const { tineX0: x0, tineX1: x1, tineOff: off, tineHalf: hw } = FL;
  const cub = (lx0, ly0, lx1, ly1, z0, z1, c) => {
    const p = toWorld(g.fl, (lx0 + lx1) / 2, (ly0 + ly1) / 2);
    m.cuboid(p.x, p.y, a, (lx1 - lx0) / 2, (ly1 - ly0) / 2, z0, z1, c);
  };
  const tipX = x1 - 0.3;
  for (const side of [-1, 1]) {
    const y = side * off;
    cub(x0, y - hw, tipX, y + hw, tz, tz + PAL, col);
    cub(tipX, y - hw * 0.55, x1, y + hw * 0.55, tz, tz + PAL * 0.5, col);
    cub(x0, y - hw, x0 + 0.1, y + hw, tz, tz + 0.5, col);
  }
  cub(x0 - 0.06, -off - hw, x0, off + hw, tz + 0.3, tz + 0.4, col);
  for (const s of [-0.45, -0.15, 0.15, 0.45]) cub(x0 - 0.04, s - 0.02, x0, s + 0.02, tz + 0.1, tz + 0.85, col);
  cub(x0 - 0.04, -0.47, x0, 0.47, tz + 0.82, tz + 0.86, col);
  cub(x0 - 0.06, -0.47, x0, 0.47, tz, tz + 0.06, col);
  const mast = '#8a8f96', chain = '#3a3d42', top = Math.max(1.5, tz + 0.9);
  for (const s of [-1, 1]) {
    cub(x0 - 0.1, s * 0.41 - 0.025, x0 + 0.02, s * 0.41 + 0.025, tz, tz + 0.86, col); // side plates wrapping the inner mast
    cub(x0 - 0.01, s * 0.3 - 0.012, x0 + 0.02, s * 0.3 + 0.012, tz + 0.86, top, chain); // lift chains up to the mast head
  }
  cub(x0 - 0.12, -0.38, x0 + 0.02, 0.38, top - 0.05, top, mast); // mast head cross-member
  cub(x0 - 0.1, -0.04, x0 - 0.04, 0.04, 0.5, tz + 0.82, mast); // lift cylinder rod
}

export function addCarried(m, tm, g) {
  if (!g.carried) return;
  const p = toWorld(g.fl, FL.carryX, 0);
  addStack(m, tm, p.x, p.y, g.carriedRots.map((r) => r + g.fl.a), g.carried, g.hf, carriedWorldOffs(g), 0, 0, g.carriedPen);
}
