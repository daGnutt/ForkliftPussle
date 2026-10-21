import { COLORS } from './level.js';
import { FL, toWorld } from './forklift.js';

const EYE_X = -0.5; // cabin seat, local x (origin at the front axle)
const EYE_Z = 1.7; // eye height in box units
const WALL_H = 3;
const HFOV = Math.PI / 2;
const COL_W = 2;
const MAX_DIST = 30;

const PAL = 0.1; // pallet / tine thickness

function rectEdges(x, y, a, hl, hw, z0, z1, color, edges) {
  const c = Math.cos(a), s = Math.sin(a);
  const p = [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]].map(([u, v]) => [x + u * c - v * s, y + u * s + v * c]);
  for (let i = 0; i < 4; i++) {
    const q = p[i], r = p[(i + 1) % 4];
    edges.push({ x1: q[0], y1: q[1], x2: r[0], y2: r[1], z0, z1, color, shade: 0.75 + 0.25 * Math.abs(Math.cos(Math.atan2(r[1] - q[1], r[0] - q[0]))) });
  }
}

// A stack of boxes standing on a small pallet whose underside is at height z.
function stackEdges(x, y, rots, layers, z, edges) {
  rectEdges(x, y, rots[0] ?? 0, 0.5, 0.5, z, z + PAL, '#9a7040', edges);
  layers.forEach((c, i) => rectEdges(x, y, rots[i] ?? 0, 0.5, 0.5, z + PAL + i, z + PAL + i + 1, COLORS[c], edges));
}

function buildEdges(g) {
  const edges = [];
  for (const w of g.walls) {
    const sides = [[w.x, w.y, w.x + w.w, w.y], [w.x + w.w, w.y, w.x + w.w, w.y + w.h], [w.x + w.w, w.y + w.h, w.x, w.y + w.h], [w.x, w.y + w.h, w.x, w.y]];
    for (const [x1, y1, x2, y2] of sides) {
      edges.push({ x1, y1, x2, y2, z0: 0, z1: WALL_H, color: null, shade: y1 === y2 ? 1 : 0.8 });
    }
  }
  for (const st of g.stacks) stackEdges(st.x, st.y, st.rots || [], st.layers, 0, edges);
  if (g.carried) {
    const p = toWorld(g.fl, FL.carryX, 0);
    stackEdges(p.x, p.y, g.carriedRots.map((r) => r + g.fl.a), g.carried, g.hf, edges);
  }
  const len = (FL.tineX1 - FL.tineX0) / 2;
  for (const side of [-1, 1]) {
    const t = toWorld(g.fl, (FL.tineX0 + FL.tineX1) / 2, side * FL.tineOff);
    rectEdges(t.x, t.y, g.fl.a, len, FL.tineHalf, g.hf, g.hf + PAL, '#b0b4ba', edges);
  }
  return edges;
}

function rayHit(ox, oy, dx, dy, e) {
  const sx = e.x2 - e.x1, sy = e.y2 - e.y1;
  const den = dx * sy - dy * sx;
  if (Math.abs(den) < 1e-9) return -1;
  const qx = e.x1 - ox, qy = e.y1 - oy;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * dy - qy * dx) / den;
  return t > 0.01 && u >= 0 && u <= 1 ? t : -1;
}

// Doom-style first-person view from the cabin, drawn into the box (x, y, w, h).
export function drawPov(ctx, g, x, y, w, h) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  const horizon = h * 0.5;
  const sky = ctx.createLinearGradient(0, y, 0, y + horizon);
  sky.addColorStop(0, '#2b3038');
  sky.addColorStop(1, '#4a505a');
  ctx.fillStyle = sky;
  ctx.fillRect(x, y, w, horizon);
  const floor = ctx.createLinearGradient(0, y + horizon, 0, y + h);
  floor.addColorStop(0, '#8a867c');
  floor.addColorStop(1, '#c9c4b8');
  ctx.fillStyle = floor;
  ctx.fillRect(x, y + horizon, w, h - horizon);

  const eye = toWorld(g.fl, EYE_X, 0);
  const f = (w / 2) / Math.tan(HFOV / 2);
  const edges = buildEdges(g);
  for (let px = 0; px < w; px += COL_W) {
    const off = Math.atan((px + COL_W / 2 - w / 2) / f);
    const ang = g.fl.a + off, dx = Math.cos(ang), dy = Math.sin(ang);
    const hits = [];
    for (const e of edges) {
      const t = rayHit(eye.x, eye.y, dx, dy, e);
      if (t > 0 && t < MAX_DIST) hits.push({ t, e });
    }
    hits.sort((a, b) => b.t - a.t); // far to near
    const cosOff = Math.cos(off);
    for (const { t, e } of hits) {
      const d = t * cosOff;
      const yTop = y + horizon - ((e.z1 - EYE_Z) / d) * f;
      const yBot = y + horizon - ((e.z0 - EYE_Z) / d) * f;
      ctx.fillStyle = e.color || '#555b64';
      ctx.fillRect(x + px, yTop, COL_W, yBot - yTop);
      const dark = Math.min(0.75, d / 14) + (1 - e.shade) * 0.6;
      ctx.fillStyle = `rgba(0,0,0,${dark})`;
      ctx.fillRect(x + px, yTop, COL_W, yBot - yTop);
      if (e.color && Math.abs(e.z1 - e.z0 - 1) < 1e-6 && e.color !== '#9a7040') { // box seams
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(x + px, yBot - 1, COL_W, 1);
      }
    }
  }
  // cabin frame / crosshair-free window border
  ctx.restore();
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('CABIN VIEW  (F: swap)', x + 6, y + 5);
}
