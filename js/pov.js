import { COLORS } from './level.js';
import { theme } from './theme.js';
import { FL, toWorld } from './forklift.js';
import { zoneDone, isSolved, scoreEnough, isParked } from './game.js';

const EYE_X = -0.5; // cabin seat, local x (origin at the front axle)
const EYE_Z = 1.45; // eye height in box units with the fork on the floor
const EYE_FOLLOW = 0.4; // share of the fork's height the camera follows
let eyeZ = EYE_Z; // current eye height, set per frame in drawPov
const WALL_H = 3;
const BOX_H = 0.5; // drawn box height in the first-person view (footprint stays 1×1)
const HFOV = Math.PI / 2;
const REAR_HFOV = (130 * Math.PI) / 180; // wide, like a convex mirror
const COL_W = 2;
const MAX_DIST = 30;

// Fills a flat floor quad (world corners) as seen from the eye.
function floorQuad(ctx, eye, ang, f, cx, cy, pts, fill, stroke) {
  const c = Math.cos(ang), s = Math.sin(ang);
  let poly = pts.map(([px, py]) => {
    const dx = px - eye.x, dy = py - eye.y;
    return [dx * c + dy * s, -dx * s + dy * c]; // [forward, right]
  });
  const near = 0.08, out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (a[0] >= near) out.push(a);
    if ((a[0] >= near) !== (b[0] >= near)) {
      const t = (near - a[0]) / (b[0] - a[0]);
      out.push([near, a[1] + t * (b[1] - a[1])]);
    }
  }
  if (out.length < 3) return;
  ctx.beginPath();
  out.forEach(([fw, rt], i) => {
    const X = cx + (rt / fw) * f, Y = cy + (eyeZ / fw) * f;
    if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
  });
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.stroke();
}

const PAL = 0.1; // pallet / tine thickness

function rectEdges(x, y, a, hl, hw, z0, z1, color, edges, top = false) {
  const id = (edges.nid = (edges.nid || 0) + 1);
  const c = Math.cos(a), s = Math.sin(a);
  const p = [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]].map(([u, v]) => [x + u * c - v * s, y + u * s + v * c]);
  for (let i = 0; i < 4; i++) {
    const q = p[i], r = p[(i + 1) % 4];
    edges.push({ x1: q[0], y1: q[1], x2: r[0], y2: r[1], z0, z1, color, id, top, shade: 0.75 + 0.25 * Math.abs(Math.cos(Math.atan2(r[1] - q[1], r[0] - q[0]))) });
  }
}

// Stack with a pallet under every box; level h maps to height h * (BOX_H + PAL),
// so the tines at fork level h line up with the pallet of box h.
function stackEdges(x, y, rots, layers, level, edges, heading) {
  layers.forEach((c, i) => {
    const z = (level + i) * (BOX_H + PAL), r = rots[i] ?? 0;
    // centre block plus corner blocks: tine openings on all four sides
    const cr = Math.cos(r), sr = Math.sin(r);
    rectEdges(x, y, r, 0.2, 0.2, z, z + PAL, '#9a7040', edges);
    for (const [u, v] of [[-0.45, -0.45], [0.45, -0.45], [0.45, 0.45], [-0.45, 0.45]]) {
      rectEdges(x + u * cr - v * sr, y + u * sr + v * cr, r, 0.05, 0.05, z, z + PAL, '#9a7040', edges);
    }
    rectEdges(x, y, r, 0.5, 0.5, z + PAL, z + BOX_H + PAL, COLORS[c], edges, i === layers.length - 1);
  });
}

function parkingCorners(g) {
  const p = g.parking, hx = (FL.front - FL.back) / 2 + 0.2, hy = FL.halfW + 0.2;
  const c = Math.cos(p.a), s = Math.sin(p.a);
  return [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([u, v]) => [p.x + u * c - v * s, p.y + u * s + v * c]);
}

function buildEdges(g) {
  const edges = [];
  for (const w of g.walls) {
    const sides = [[w.x, w.y, w.x + w.w, w.y], [w.x + w.w, w.y, w.x + w.w, w.y + w.h], [w.x + w.w, w.y + w.h, w.x, w.y + w.h], [w.x, w.y + w.h, w.x, w.y]];
    for (const [x1, y1, x2, y2] of sides) {
      edges.push({ x1, y1, x2, y2, z0: 0, z1: WALL_H, color: null, shade: y1 === y2 ? 1 : 0.8 });
    }
  }
  for (const st of g.stacks) stackEdges(st.x, st.y, st.rots || [], st.layers, 0, edges, g.fl.a);
  if (g.carried) {
    const p = toWorld(g.fl, FL.carryX, 0);
    stackEdges(p.x, p.y, g.carriedRots.map((r) => r + g.fl.a), g.carried, g.hf, edges, g.fl.a);
  }
  const len = (FL.tineX1 - FL.tineX0) / 2;
  for (const side of [-1, 1]) {
    const t = toWorld(g.fl, (FL.tineX0 + FL.tineX1) / 2, side * FL.tineOff);
    rectEdges(t.x, t.y, g.fl.a, len, FL.tineHalf, g.hf * (BOX_H + PAL), g.hf * (BOX_H + PAL) + PAL, '#b0b4ba', edges, true);
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

// True if something other than what stands on the zone itself blocks the line of sight to the zone's floor centre.
function floorOccluded(eye, z, edges) {
  const dx = z.x - eye.x, dy = z.y - eye.y, d = Math.hypot(dx, dy);
  const ux = dx / d, uy = dy / d;
  return edges.some((e) => {
    const t = rayHit(eye.x, eye.y, ux, uy, e);
    if (t < 0 || t >= d) return false;
    if (Math.hypot(eye.x + ux * t - z.x, eye.y + uy * t - z.y) < 0.75) return false;
    const zl = eyeZ * (1 - t / d); // sight-line height at the hit
    return zl >= e.z0 && zl <= e.z1;
  });
}

// Doom-style first-person view from the cabin, drawn into the box (x, y, w, h).
// opts.rear: look backwards, mirrored left-right (rear-view mirror).
export function drawPov(ctx, g, x, y, w, h, opts = {}) {
  const yaw = g.fl.a + (opts.rear ? Math.PI : 0);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  if (opts.rear) { ctx.translate(2 * x + w, 0); ctx.scale(-1, 1); }
  const horizon = h * 0.35;
  const sky = ctx.createLinearGradient(0, y, 0, y + horizon);
  sky.addColorStop(0, theme().skyTop);
  sky.addColorStop(1, theme().skyBottom);
  ctx.fillStyle = sky;
  ctx.fillRect(x, y, w, horizon);
  const floor = ctx.createLinearGradient(0, y + horizon, 0, y + h);
  floor.addColorStop(0, theme().floorFar);
  floor.addColorStop(1, theme().floor);
  ctx.fillStyle = floor;
  ctx.fillRect(x, y + horizon, w, h - horizon);

  eyeZ = EYE_Z + EYE_FOLLOW * g.hf * (BOX_H + PAL);
  const eye = toWorld(g.fl, EYE_X, 0);
  const f = (w / 2) / Math.tan((opts.rear ? REAR_HFOV : HFOV) / 2);
  for (const z of g.zones) {
    const done = zoneDone(g, z), r = 0.6;
    floorQuad(ctx, eye, yaw, f, x + w / 2, y + horizon,
      [[z.x - r, z.y - r], [z.x + r, z.y - r], [z.x + r, z.y + r], [z.x - r, z.y + r]],
      COLORS[z.color] + (done ? 'cc' : '77'), COLORS[z.color]);
  }
  const park = parkingCorners(g);
  const ready = isSolved(g) && scoreEnough(g);
  floorQuad(ctx, eye, yaw, f, x + w / 2, y + horizon, park,
    ready ? (isParked(g) ? '#66bb6a99' : '#66bb6a66') : '#9e9e9e55', ready ? '#66bb6a' : '#bdbdbd');
  const edges = buildEdges(g);
  for (let px = 0; px < w; px += COL_W) {
    const off = Math.atan((px + COL_W / 2 - w / 2) / f);
    const ang = yaw + off, dx = Math.cos(ang), dy = Math.sin(ang);
    const hits = [];
    for (const e of edges) {
      const t = rayHit(eye.x, eye.y, dx, dy, e);
      if (t > 0 && t < MAX_DIST) hits.push({ t, e });
    }
    hits.sort((a, b) => (Math.abs(a.t - b.t) > 1e-6 ? b.t - a.t : a.e.z0 - b.e.z0)); // far to near
    const span = {};
    for (const { t, e } of hits) if (e.top) { const q = span[e.id] || (span[e.id] = [t, t]); q[0] = Math.min(q[0], t); q[1] = Math.max(q[1], t); }
    const cosOff = Math.cos(off);
    const under = {};
    for (const { t, e } of hits) if (e.id && e.z0 > eyeZ) { const q = under[e.id] || (under[e.id] = [t, t]); q[0] = Math.min(q[0], t); q[1] = Math.max(q[1], t); }
    // undersides wait in a queue and are drawn lowest-last once the ray moves nearer than all of them,
    // because a lower plane above the eye hides a higher one
    let queue = [];
    const flush = () => {
      queue.sort((a, b) => b.e.z0 - a.e.z0);
      for (const { e, u } of queue) {
        const yFar = y + horizon - ((e.z0 - eyeZ) / (u[1] * cosOff)) * f;
        const yNear = y + horizon - ((e.z0 - eyeZ) / (u[0] * cosOff)) * f;
        ctx.fillStyle = e.color;
        ctx.fillRect(x + px, yNear, COL_W, yFar - yNear);
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(x + px, yNear, COL_W, yFar - yNear);
      }
      queue = [];
    };
    for (const { t, e } of hits) {
      if (queue.length && t < Math.min(...queue.map((o) => o.t)) - 1e-6) flush();
      const d = t * cosOff;
      const yTop = y + horizon - ((e.z1 - eyeZ) / d) * f;
      const yBot = y + horizon - ((e.z0 - eyeZ) / d) * f;
      ctx.fillStyle = e.color || '#555b64';
      ctx.fillRect(x + px, yTop, COL_W, yBot - yTop);
      const dark = Math.min(0.75, d / 14) + (1 - e.shade) * 0.6;
      ctx.fillStyle = `rgba(0,0,0,${dark})`;
      ctx.fillRect(x + px, yTop, COL_W, yBot - yTop);
      const u = e.id && e.z0 > eyeZ ? under[e.id] : null;
      if (u && t === u[1] && u[1] > u[0]) queue.push({ e, u, t });
      const q = e.top && e.z1 < eyeZ ? span[e.id] : null;
      if (q && t === q[0] && q[1] > q[0]) { // closed lid between near and far edge
        // stop at any nearer solid that the lid runs into (e.g. tines slid under a box)
        let dFar = q[1];
        for (const o of hits) {
          if (o.e.id !== e.id && o.t > q[0] && o.t < dFar && o.e.z0 <= e.z1 + 1e-6 && o.e.z1 > e.z1 + 1e-6) dFar = o.t;
        }
        const yFar = y + horizon - ((e.z1 - eyeZ) / (dFar * cosOff)) * f;
        ctx.fillStyle = e.color;
        ctx.fillRect(x + px, yFar, COL_W, yTop - yFar);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(x + px, yFar, COL_W, yTop - yFar);
      }
      if (e.color && Math.abs(e.z1 - e.z0 - BOX_H) < 1e-6 && e.color !== '#9a7040') { // box seams
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(x + px, yBot - 1, COL_W, 1);
      }
    }
    flush();
  }
  // floating labels (drawn over the walls so they stay readable): total boxes wanted per zone, hidden once the zone is done
  for (const z of opts.rear ? [] : g.zones) {
    const done = zoneDone(g, z);
    if (done) continue;
    const text = `×${z.count}`;
    const c = Math.cos(g.fl.a), s = Math.sin(g.fl.a);
    const dx = z.x - eye.x, dy = z.y - eye.y;
    const fw = dx * c + dy * s, rt = -dx * s + dy * c;
    if (fw > 0.3 && fw < MAX_DIST && !floorOccluded(eye, z, edges)) {
      const sx = x + w / 2 + (rt / fw) * f, sy = y + horizon - ((0.9 - eyeZ) / fw) * f;
      const size = Math.max(8, Math.min(48, (0.5 / fw) * f));
      ctx.font = `bold ${size}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(2, size / 6);
      ctx.strokeStyle = '#000';
      ctx.strokeText(text, sx, sy);
      ctx.fillStyle = COLORS[z.color];
      ctx.fillText(text, sx, sy);
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
  ctx.fillText(opts.rear ? 'REAR MIRROR' : 'CABIN VIEW  (F: swap)', x + 6, y + 5);
}
