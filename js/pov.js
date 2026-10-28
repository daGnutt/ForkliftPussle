import { COLORS } from './level.js';
import { theme } from './theme.js';
import { decalsEnabled, floorDecals, wallDecal, wallBase, hash, overheadDecals, boxDecalKind, boxDecalShapes } from './decals.js';
import { FL, toWorld } from './forklift.js';
import { reverseLight } from './revlight.js';
import { carriedWorldOffs, HIT_LIFE, zoneDone, isSolved, scoreEnough, isParked } from './game.js';

// Cabin view: a small polygon-projection 3D renderer. Everything is built from
// prisms (walls, pallets, boxes, tines), split into faces, back-face culled and
// painted far to near. Camera space: fw = forward, rt = right, z = up.

const EYE_X = -0.5; // seat position, local x (origin at the front axle)
const EYE_Z = 1.45; // eye height with the fork on the floor
const EYE_FOLLOW = 0.4; // share of the fork height the eye follows
const CHARGER_H = 0.9; // 1.5 boxes
const WALL_H = 4; // also the ceiling height; clears a 5-box stack (3.0)
const BOX_H = 0.5; // drawn box height (footprint stays 1×1)
const PAL = 0.1; // pallet / tine thickness
const HFOV = Math.PI / 2;
const REAR_HFOV = (130 * Math.PI) / 180;
const NEAR = 0.08;
const MAX_DIST = 30;
const FAR_DARK = 14;
const PALLET_COLOR = '#9a7040';

// World point + height -> camera space.
function toCam(cam, px, py, z) {
  const dx = px - cam.x, dy = py - cam.y;
  return [dx * cam.c + dy * cam.s, -dx * cam.s + dy * cam.c, z - cam.z];
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

function project(cam, pts) {
  return clipNear(pts).map(([fw, rt, z]) => [cam.cx + (rt / fw) * cam.f, cam.cy - (z / fw) * cam.f]);
}

// Projects a 2-point line, clipped to the near plane (null if fully behind it).
function projectLine(cam, a, b) {
  const ain = a[0] >= NEAR, bin = b[0] >= NEAR;
  if (!ain && !bin) return null;
  const cut = (p, q) => {
    const t = (NEAR - p[0]) / (q[0] - p[0]);
    return [NEAR, p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])];
  };
  return [ain ? a : cut(a, b), bin ? b : cut(b, a)].map(([fw, rt, z]) => [cam.cx + (rt / fw) * cam.f, cam.cy - (z / fw) * cam.f]);
}

function fillPoly(ctx, pts, fill, stroke) {
  if (pts.length < 3) return;
  ctx.beginPath();
  pts.forEach(([X, Y], i) => (i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y)));
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
}

function floorPoly(ctx, cam, corners, fill, stroke) {
  fillPoly(ctx, project(cam, corners.map(([x, y]) => toCam(cam, x, y, 0))), fill, stroke);
}

// Ceiling plane over the whole level with steel joists every 4 tiles.
function drawCeiling(ctx, g, cam) {
  const pt = (x, y) => toCam(cam, x, y, WALL_H);
  fillPoly(ctx, project(cam, [pt(0, 0), pt(g.w, 0), pt(g.w, g.h), pt(0, g.h)]), '#3d424a');
  ctx.beginPath();
  const line = (ax, ay, bx, by) => {
    const p = projectLine(cam, pt(ax, ay), pt(bx, by));
    if (p) { ctx.moveTo(p[0][0], p[0][1]); ctx.lineTo(p[1][0], p[1][1]); }
  };
  for (let x = 0; x <= g.w; x += 4) line(x, 0, x, g.h);
  for (let y = 0; y <= g.h; y += 4) line(0, y, g.w, y);
  ctx.strokeStyle = 'rgba(15,17,20,0.7)';
  ctx.lineWidth = 3;
  ctx.stroke();
}

function floorGrid(ctx, cam) {
  const R = 18;
  const x0 = Math.floor(cam.x - R), x1 = Math.ceil(cam.x + R), y0 = Math.floor(cam.y - R), y1 = Math.ceil(cam.y + R);
  ctx.beginPath();
  const line = (ax, ay, bx, by) => {
    const p = projectLine(cam, toCam(cam, ax, ay, 0), toCam(cam, bx, by, 0));
    if (p) { ctx.moveTo(p[0][0], p[0][1]); ctx.lineTo(p[1][0], p[1][1]); }
  };
  for (let gx = x0; gx <= x1; gx++) line(gx, y0, gx, y1);
  for (let gy = y0; gy <= y1; gy++) line(x0, gy, x1, gy);
  ctx.strokeStyle = theme().povGrid;
  ctx.lineWidth = 1;
  ctx.stroke();
}

// Adds the faces of a rectangular prism (centre x,y, heading a, half sizes hl,hw, heights z0..z1).
// split: max segment length; long faces are cut up so far-to-near sorting stays right (walls, tines).
// wall = true: colourless, checker-tinted tiles.
function addPrism(faces, cam, x, y, a, hl, hw, z0, z1, color, wall = false, split = wall ? 1 : 0, deco = 0, skipTop = false, skipBottom = false) {
  const c = Math.cos(a), s = Math.sin(a);
  const p = [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]].map(([u, v]) => [x + u * c - v * s, y + u * s + v * c]);
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = p[i], [bx, by] = p[(i + 1) % 4];
    const ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey);
    const nx = ey / len, ny = -ex / len; // outward normal
    if ((cam.x - ax) * nx + (cam.y - ay) * ny <= 0) continue; // back face
    const shade = 0.75 + 0.25 * Math.abs(ex / len);
    const n = split ? Math.ceil(len / split) : 1;
    for (let k = 0; k < n; k++) {
      const q0 = [ax + (ex * k) / n, ay + (ey * k) / n], q1 = [ax + (ex * (k + 1)) / n, ay + (ey * (k + 1)) / n];
      faces.push({
        quad: [[q0[0], q0[1], z0], [q1[0], q1[1], z0], [q1[0], q1[1], z1], [q0[0], q0[1], z1]],
        mx: (q0[0] + q1[0]) / 2, my: (q0[1] + q1[1]) / 2, mz: (z0 + z1) / 2,
        color, shade, tile: wall ? Math.floor((q0[0] + q0[1] + (q1[0] + q1[1])) / 2) : null,
        side: [q0, q1, z0, z1], k, n, deco,
      });
    }
  }
  const flat = (z, shade, lit) => {
    const n = split ? Math.ceil((2 * hl) / split) : 1;
    for (let k = 0; k < n; k++) {
      const u0 = -hl + (2 * hl * k) / n, u1 = -hl + (2 * hl * (k + 1)) / n;
      const at = (u, v) => [x + u * c - v * s, y + u * s + v * c, z];
      const um = (u0 + u1) / 2;
      faces.push({
        quad: [at(u0, -hw), at(u1, -hw), at(u1, hw), at(u0, hw)],
        mx: x + um * c, my: y + um * s, mz: z, color, shade, lit,
      });
    }
  };
  if (cam.z > z1) { if (!skipTop) flat(z1, 1, true); }
  else if (cam.z < z0 && !skipBottom) flat(z0, 0.5, false);
}

// Stack with a pallet under every box; level h sits at height h * (BOX_H + PAL).
// Boxes from index `from` up are drawn `extra` levels higher (a stack still being lowered).
function addStack(faces, cam, x0, y0, rots, layers, level, offs = [], from = 0, extra = 0, pens = []) {
  layers.forEach((col, i) => {
    const x = x0 + (offs[i]?.x || 0), y = y0 + (offs[i]?.y || 0);
    const z = (level + i + (i >= from ? extra : 0)) * (BOX_H + PAL), r = rots[i] ?? 0;
    const cr = Math.cos(r), sr = Math.sin(r);
    addPrism(faces, cam, x, y, r, 0.2, 0.2, z, z + PAL, PALLET_COLOR, false, 0, 0, true, i > 0);
    for (const [u, v] of [[-0.45, -0.45], [0.45, -0.45], [0.45, 0.45], [-0.45, 0.45]]) {
      addPrism(faces, cam, x + u * cr - v * sr, y + u * sr + v * cr, r, 0.05, 0.05, z, z + PAL, PALLET_COLOR, false, 0, 0, true, i > 0);
    }
    addPrism(faces, cam, x, y, r, 0.5, 0.5, z + PAL, z + PAL + BOX_H, COLORS[col], false, 0, decalsEnabled() ? pens[i]?.deco ?? boxDecalKind(col, i) : 0);
  });
}

// Ceiling fixtures as prisms so walls and boxes occlude them correctly.
function addOverhead(faces, cam, g) {
  if (!decalsEnabled()) return;
  const { lights, fans } = overheadDecals(g);
  const glow = (from) => { for (let i = from; i < faces.length; i++) faces[i].glow = true; };
  for (const l of lights) {
    addPrism(faces, cam, l.x, l.y, l.a, 0.9, 0.14, WALL_H - 0.1, WALL_H - 0.02, '#4a4f57');
    const n = faces.length;
    addPrism(faces, cam, l.x, l.y, l.a, 0.84, 0.1, WALL_H - 0.12, WALL_H - 0.1, '#fff8d6');
    glow(n);
  }
  for (const f of fans) {
    addPrism(faces, cam, f.x, f.y, 0, 0.025, 0.025, WALL_H - 0.35, WALL_H, '#2c3036');
    addPrism(faces, cam, f.x, f.y, 0, 0.12, 0.12, WALL_H - 0.45, WALL_H - 0.33, '#2c3036');
    for (let i = 0; i < 4; i++) {
      const a = f.a + (i * Math.PI) / 2, c = Math.cos(a), s = Math.sin(a);
      addPrism(faces, cam, f.x + c * 0.6, f.y + s * 0.6, a, 0.48, 0.1, WALL_H - 0.43, WALL_H - 0.41, '#8c939b');
    }
  }
}

function buildFaces(g, cam) {
  const faces = [];
  addOverhead(faces, cam, g);
  for (const w of g.walls) {
    if (w.charger) {
      const n = faces.length;
      addPrism(faces, cam, w.x + w.w / 2, w.y + w.h / 2, 0, w.w / 2, w.h / 2, 0, CHARGER_H, '#c62828');
      for (let i = n; i < faces.length; i++) faces[i].charger = true;
    } else addPrism(faces, cam, w.x + w.w / 2, w.y + w.h / 2, 0, w.w / 2, w.h / 2, 0, WALL_H, null, true);
  }
  for (const st of g.stacks) addStack(faces, cam, st.x, st.y, st.rots || [], st.layers, 0, st.offs, st.dropFrom ?? 0,
      st.dropFrom != null ? Math.max(0, g.hf - st.dropFrom) : 0, st.pen);
  if (g.carried) {
    const p = toWorld(g.fl, FL.carryX, 0);
    addStack(faces, cam, p.x, p.y, g.carriedRots.map((r) => r + g.fl.a), g.carried, g.hf, carriedWorldOffs(g), 0, 0, g.carriedPen);
  }
  const len = (FL.tineX1 - FL.tineX0) / 2, tz = g.hf * (BOX_H + PAL);
  for (const side of [-1, 1]) {
    const t = toWorld(g.fl, (FL.tineX0 + FL.tineX1) / 2, side * FL.tineOff);
    addPrism(faces, cam, t.x, t.y, g.fl.a, len, FL.tineHalf, tz, tz + PAL, theme().tine, false, 0.2);
  }
  for (const f of faces) f.d = Math.hypot(f.mx - cam.x, f.my - cam.y, f.mz - cam.z);
  faces.sort((a, b) => b.d - a.d);
  return faces;
}


// Wall decals are drawn in face coordinates: u = 0..1 left to right as seen from outside, v = height in tiles.
const DECAL_MAX_DIST = 16;

function circlePts(u, v, r, n = 18) {
  return Array.from({ length: n }, (_, i) => [u + Math.cos((i / n) * Math.PI * 2) * r, v + Math.sin((i / n) * Math.PI * 2) * r]);
}

// A roller door spans two segments around the junction `key`; skip it unless the whole width is free wall face
// (no perpendicular wall abutting the face within the span).
function doorFits(g, key, q0, q1) {
  const L = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]);
  const dx = (q1[0] - q0[0]) / L, dy = (q1[1] - q0[1]) / L;
  const nx = dy, ny = -dx;
  for (let t = -1.9; t <= 1.9; t += 0.2) {
    const x = key[0] + dx * L * t + nx * 0.1, y = key[1] + dy * L * t + ny * 0.1;
    if (g.walls.some((w) => x > w.x && x < w.x + w.w && y > w.y && y < w.y + w.h)) return false;
  }
  return true;
}

function drawWallDecals(ctx, cam, g, f, dark) {
  const [q0, q1] = f.side;
  const len = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]);
  if (!decalsEnabled() || len < 0.9 || f.d > DECAL_MAX_DIST) return;
  const mx = f.mx, my = f.my;
  const shape = (uv, fill) => {
    const pts = project(cam, uv.map(([u, v]) => toCam(cam, q1[0] + (q0[0] - q1[0]) * u, q1[1] + (q0[1] - q1[1]) * u, v)));
    if (pts.length < 3) return;
    ctx.beginPath();
    pts.forEach(([X, Y], i) => (i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y)));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.fillStyle = `rgba(0,0,0,${Math.max(0, dark)})`;
    ctx.fill();
  };
  const box = (u0, v0, u1, v1, fill) => shape([[u0, v0], [u1, v0], [u1, v1], [u0, v1]], fill);
  const disc = (u, v, r, fill) => shape(circlePts(u, v, r), fill);
  const tri = (u, v, r, fill) => shape([[u, v + r], [u + r * 0.95, v - r * 0.55], [u - r * 0.95, v - r * 0.55]], fill);
  const YEL = '#f4c414', RED = '#c62828', WHITE = '#eeeeee', BLACK = '#1a1a1a';

  // Two-segment roller door: the pair (k even, k + 1) shares the point where the segments meet.
  if (f.n > 1 && (f.k & 1 ? true : f.k + 1 < f.n)) {
    const key = f.k & 1 ? q0 : q1;
    if (hash(key[0], key[1], 34) < 0.1 && doorFits(g, key, q0, q1)) {
      const off = f.k & 1 ? 0 : 1; // visually the later segment is the left half
      const slab = (x0, v0, x1, v1, fill) => {
        const a = Math.max(0, x0 - off), b = Math.min(1, x1 - off);
        if (b > a) box(a, v0, b, v1, fill);
      };
      slab(0.06, 0, 1.94, 2.7, YEL);
      slab(0.14, 0, 1.86, 2.6, '#8a9199');
      for (let v = 0.12; v < 2.5; v += 0.13) slab(0.14, v, 1.86, v + 0.025, '#5f656c');
      slab(0.14, 2.35, 1.86, 2.6, '#6d737a');
      slab(0.14, 0, 1.86, 0.1, BLACK);
      for (let i = 0; i < 7; i++) slab(0.14 + i * 0.246, 0, 0.14 + i * 0.246 + 0.123, 0.1, YEL);
      slab(0.14, 2.6, 1.86, 2.7, '#3a3f45');
      slab(0.85, 0.22, 1.15, 0.28, '#c9ccd1');
      return;
    }
  }

  const base = wallBase(mx, my);
  if (base === 1) box(0, 0, 1, 0.12, YEL);
  else if (base === 2) {
    for (let i = 0; i < 8; i++) {
      const a = i * 0.125;
      shape([[a, 0], [a + 0.0625 + 0.05, 0], [a + 0.0625 + 0.15, 0.2], [a + 0.1, 0.2]], i & 1 ? BLACK : YEL);
    }
  }

  switch (wallDecal(mx, my)) {
    case 'window': {
      box(0.12, 1.22, 0.88, 2.38, '#2b2e33');
      box(0.17, 1.27, 0.83, 2.33, theme().skyBottom);
      shape([[0.17, 1.27], [0.4, 1.27], [0.63, 2.33], [0.4, 2.33]], 'rgba(255,255,255,0.25)');
      box(0.485, 1.27, 0.515, 2.33, '#2b2e33');
      box(0.17, 1.78, 0.83, 1.82, '#2b2e33');
      box(0.1, 1.2, 0.9, 1.24, '#8d949c');
      break;
    }
    case 'door': {
      box(0.14, 0, 0.86, 2.28, YEL);
      box(0.19, 0, 0.81, 2.2, '#4d6b5b');
      box(0.34, 1.4, 0.66, 1.9, '#1f2a30');
      box(0.36, 1.42, 0.64, 1.88, theme().skyBottom);
      box(0.68, 0.95, 0.76, 1.05, '#c9ccd1');
      box(0.22, 0.88, 0.78, 0.92, '#7e8a82');
      box(0.38, 2.28, 0.62, 2.5, '#2e7d32');
      box(0.41, 2.31, 0.59, 2.47, WHITE);
      break;
    }
    case 'nosmoking': {
      disc(0.5, 1.75, 0.3, RED);
      disc(0.5, 1.75, 0.23, WHITE);
      box(0.3, 1.72, 0.6, 1.78, '#d8b27a');
      box(0.6, 1.72, 0.69, 1.78, '#e56a1d');
      shape([[0.3, 1.52], [0.35, 1.47], [0.7, 1.98], [0.65, 2.03]], RED);
      break;
    }
    case 'exit': {
      box(0.18, 2.2, 0.82, 2.6, '#1b5e20');
      box(0.2, 2.22, 0.8, 2.58, '#2e7d32');
      shape([[0.28, 2.37], [0.5, 2.37], [0.5, 2.3], [0.7, 2.4], [0.5, 2.5], [0.5, 2.43], [0.28, 2.43]], WHITE);
      disc(0.34, 2.46, 0.04, WHITE);
      break;
    }
    case 'extinguisher': {
      box(0.3, 1.45, 0.7, 1.95, RED);
      box(0.47, 1.52, 0.53, 1.88, WHITE);
      box(0.34, 1.64, 0.66, 1.7, WHITE);
      box(0.4, 0.55, 0.6, 1.25, '#b71c1c');
      box(0.45, 1.25, 0.55, 1.32, BLACK);
      box(0.55, 1.18, 0.65, 1.24, BLACK);
      break;
    }
    case 'hazard': {
      tri(0.5, 1.8, 0.4, BLACK);
      tri(0.5, 1.8, 0.34, YEL);
      box(0.475, 1.74, 0.525, 1.98, BLACK);
      disc(0.5, 1.64, 0.03, BLACK);
      break;
    }
    case 'electric': {
      tri(0.5, 1.8, 0.4, BLACK);
      tri(0.5, 1.8, 0.34, YEL);
      shape([[0.54, 1.98], [0.42, 1.74], [0.5, 1.74], [0.46, 1.58], [0.6, 1.8], [0.52, 1.8]], BLACK);
      break;
    }
    case 'forklift': {
      box(0.2, 1.4, 0.8, 2.0, '#1565c0');
      box(0.27, 1.5, 0.5, 1.75, WHITE);
      box(0.5, 1.5, 0.55, 1.95, WHITE);
      box(0.55, 1.5, 0.72, 1.55, WHITE);
      disc(0.34, 1.47, 0.04, WHITE);
      disc(0.46, 1.47, 0.04, WHITE);
      shape([[0.2, 2.0], [0.8, 1.4], [0.8, 1.45], [0.25, 2.0]], RED);
      break;
    }
    case 'ppe': {
      disc(0.5, 1.75, 0.3, '#1565c0');
      shape(circlePts(0.5, 1.72, 0.17).filter(([, v]) => v >= 1.72).concat([[0.33, 1.72]]), WHITE);
      box(0.3, 1.66, 0.7, 1.72, WHITE);
      break;
    }
    case 'speed': {
      disc(0.5, 1.75, 0.3, RED);
      disc(0.5, 1.75, 0.23, WHITE);
      box(0.42, 1.88, 0.58, 1.91, BLACK);
      box(0.42, 1.75, 0.45, 1.9, BLACK);
      box(0.42, 1.73, 0.58, 1.76, BLACK);
      box(0.55, 1.6, 0.58, 1.75, BLACK);
      box(0.42, 1.58, 0.58, 1.61, BLACK);
      break;
    }
    case 'fire': {
      box(0.22, 1.2, 0.78, 1.9, RED);
      disc(0.5, 1.55, 0.2, WHITE);
      disc(0.5, 1.55, 0.14, '#8e1b1b');
      disc(0.5, 1.55, 0.05, WHITE);
      box(0.3, 1.78, 0.7, 1.84, WHITE);
      break;
    }
  }
}

function drawBoxDecal(ctx, cam, f, dark) {
  const [q0, q1, z0] = f.side;
  for (const d of boxDecalShapes(f.deco)) {
    const pts = project(cam, d.pts.map(([u, v]) => {
      const U = 0.5 - u * 0.45;
      return toCam(cam, q0[0] + (q1[0] - q0[0]) * U, q0[1] + (q1[1] - q0[1]) * U, z0 + BOX_H / 2 + v * 0.45);
    }));
    if (pts.length < 3) continue;
    ctx.beginPath();
    pts.forEach(([X, Y], i) => (i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y)));
    ctx.closePath();
    ctx.fillStyle = d.fill;
    ctx.fill();
    ctx.fillStyle = `rgba(0,0,0,${dark})`;
    ctx.fill();
  }
}

// High-voltage warning on a charger side: hazard stripes along the base and a bolt in a yellow triangle.
function drawChargerDecal(ctx, cam, f, dark) {
  const [q0, q1] = f.side;
  const shape = (uv, fill) => {
    const pts = project(cam, uv.map(([u, v]) => toCam(cam, q0[0] + (q1[0] - q0[0]) * u, q0[1] + (q1[1] - q0[1]) * u, v)));
    if (pts.length < 3) return;
    ctx.beginPath();
    pts.forEach(([X, Y], i) => (i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y)));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.fillStyle = `rgba(0,0,0,${dark})`;
    ctx.fill();
  };
  shape([[0, 0], [1, 0], [1, 0.1], [0, 0.1]], '#f4c414');
  for (let i = 0; i < 4; i++) {
    const a = i * 0.25;
    shape([[a, 0], [a + 0.125, 0], [a + 0.2, 0.1], [a + 0.075, 0.1]], '#1a1a1a');
  }
  shape([[0.5, 0.82], [0.92, 0.2], [0.08, 0.2]], '#1a1a1a');
  shape([[0.5, 0.74], [0.84, 0.24], [0.16, 0.24]], '#f4c414');
  shape([[0.55, 0.66], [0.38, 0.45], [0.5, 0.45], [0.44, 0.3], [0.64, 0.52], [0.52, 0.52]], '#1a1a1a');
}

function drawFace(ctx, cam, g, f) {
  const pts = project(cam, f.quad.map(([x, y, z]) => toCam(cam, x, y, z)));
  if (pts.length < 3) return;
  const dark = Math.min(0.75, f.d / FAR_DARK) + (1 - f.shade) * 0.6;
  ctx.beginPath();
  pts.forEach(([X, Y], i) => (i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y)));
  ctx.closePath();
  if (f.glow) {
    ctx.fillStyle = f.color;
    ctx.fill();
    ctx.fillStyle = `rgba(0,0,0,${Math.min(0.35, f.d / FAR_DARK * 0.35)})`;
    ctx.fill();
    return;
  }
  ctx.fillStyle = f.color || ((f.tile ?? 0) & 1 ? '#5d646e' : '#555b64');
  ctx.fill();
  ctx.fillStyle = `rgba(0,0,0,${Math.max(0, dark)})`;
  ctx.fill();
  if (f.lit) { ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fill(); }
  if (f.charger && f.side) drawChargerDecal(ctx, cam, f, Math.max(0, dark));
  if (f.deco && f.d < DECAL_MAX_DIST) drawBoxDecal(ctx, cam, f, Math.max(0, dark));
  if (f.tile != null && f.side) drawWallDecals(ctx, cam, g, f, Math.max(0, dark));
  if (f.color && f.color !== PALLET_COLOR) {
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// True if a wall or box side blocks the sight line from the eye to a zone's floor centre (ignoring what stands on the zone itself).
function floorOccluded(cam, z, faces) {
  const dx = z.x - cam.x, dy = z.y - cam.y;
  for (const f of faces) {
    if (!f.side) continue;
    const [[ax, ay], [bx, by], z0, z1] = f.side;
    const sx = bx - ax, sy = by - ay;
    const den = dx * sy - dy * sx;
    if (Math.abs(den) < 1e-9) continue;
    const qx = ax - cam.x, qy = ay - cam.y;
    const t = (qx * sy - qy * sx) / den, u = (qx * dy - qy * dx) / den;
    if (t <= 0.01 || t >= 1 || u < 0 || u > 1) continue;
    if (Math.hypot(cam.x + dx * t - z.x, cam.y + dy * t - z.y) < 0.75) continue;
    const zl = cam.z * (1 - t);
    if (zl >= z0 && zl <= z1) return true;
  }
  return false;
}

function drawFloorDecals(ctx, g, cam) {
  if (!decalsEnabled()) return;
  const R = 18;
  for (const d of floorDecals(g)) {
    if (Math.hypot(d.pts[0][0] - cam.x, d.pts[0][1] - cam.y) > R) continue;
    floorPoly(ctx, cam, d.pts, d.fill);
  }
}

function parkingCorners(g) {
  const p = g.parking, hx = (FL.front - FL.back) / 2 + 0.2, hy = FL.halfW + 0.2;
  const c = Math.cos(p.a), s = Math.sin(p.a);
  return [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([u, v]) => [p.x + u * c - v * s, p.y + u * s + v * c]);
}

function drawFloorMarks(ctx, g, cam) {
  for (const z of g.zones) {
    const done = zoneDone(g, z), r = 0.6;
    floorPoly(ctx, cam, [[z.x - r, z.y - r], [z.x + r, z.y - r], [z.x + r, z.y + r], [z.x - r, z.y + r]],
      COLORS[z.color] + (done ? 'cc' : '77'), COLORS[z.color]);
  }
  const ready = isSolved(g) && scoreEnough(g);
  floorPoly(ctx, cam, parkingCorners(g),
    ready ? (isParked(g) ? '#66bb6a99' : '#66bb6a66') : '#9e9e9e55', ready ? '#66bb6a' : '#bdbdbd');
  if (ready) {
    const p = g.parking, hx = (FL.front - FL.back) / 2 + 0.2, c = Math.cos(p.a), s = Math.sin(p.a);
    const arrow = [[hx - 0.15, 0], [hx - 0.75, -0.45], [hx - 0.75, 0.45]]
      .map(([u, v]) => [p.x + u * c - v * s, p.y + u * s + v * c]);
    floorPoly(ctx, cam, arrow, '#66bb6a', '#66bb6a');
  }
}

function revAlpha(g) { return 0.45 + 0.2 * Math.sin(g.clock * 14); }

function drawRevFloor(ctx, g, cam) {
  const L = reverseLight(g);
  if (!L) return;
  floorPoly(ctx, cam, L.pts.map((p) => [p.x, p.y]), `rgba(41,121,255,${revAlpha(g)})`);
  floorPoly(ctx, cam, L.pts.map((p) => [L.x + (p.x - L.x) * 0.45, L.y + (p.y - L.y) * 0.45]), `rgba(144,202,249,${revAlpha(g)})`);
}

// Where the light touches a wall it climbs up it (drawn over the faces).
function drawRevWalls(ctx, g, cam) {
  const L = reverseLight(g);
  if (!L) return;
  ctx.fillStyle = `rgba(41,121,255,${revAlpha(g) * 0.8})`;
  const n = L.pts.length;
  for (let i = 0; i < n; i++) {
    const a = L.pts[i], b = L.pts[(i + 1) % n];
    if (!a.wall || !b.wall) continue;
    if (Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5) continue;
    fillPoly(ctx, project(cam, [
      toCam(cam, a.x, a.y, 0), toCam(cam, b.x, b.y, 0),
      toCam(cam, b.x, b.y, b.climb), toCam(cam, a.x, a.y, a.climb),
    ]), ctx.fillStyle);
  }
}

// Floating "×count" over each unfinished zone, drawn over the scene; hidden when the zone floor is out of sight.
function drawZoneLabels(ctx, g, cam, faces) {
  for (const z of g.zones) {
    if (zoneDone(g, z)) continue;
    const [fw, rt] = toCam(cam, z.x, z.y, 0);
    if (fw <= 0.3 || fw >= MAX_DIST || floorOccluded(cam, z, faces)) continue;
    const sx = cam.cx + (rt / fw) * cam.f, sy = cam.cy - ((0.9 - cam.z) / fw) * cam.f;
    const size = Math.max(8, Math.min(48, (0.5 / fw) * cam.f));
    ctx.font = `bold ${size}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, size / 6);
    ctx.strokeStyle = '#000';
    ctx.strokeText(`×${z.count}`, sx, sy);
    ctx.fillStyle = COLORS[z.color];
    ctx.fillText(`×${z.count}`, sx, sy);
  }
}

// Damage popups floating up from the damaged box.
function drawHits(ctx, g, cam) {
  for (const h of g.hits || []) {
    const k = (g.clock - h.t) / HIT_LIFE;
    const [fw, rt] = toCam(cam, h.x, h.y, 0);
    if (fw <= 0.3) continue;
    const sx = cam.cx + (rt / fw) * cam.f, sy = cam.cy - ((h.z * (BOX_H + PAL) + 0.3 + k * 0.8 - cam.z) / fw) * cam.f;
    const size = Math.max(10, Math.min(60, (0.45 / fw) * cam.f));
    ctx.globalAlpha = Math.max(0, 1 - k * k);
    ctx.font = `bold ${size}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, size / 6);
    ctx.strokeStyle = '#000';
    ctx.strokeText(`−${h.pts}`, sx, sy);
    ctx.fillStyle = '#ff5252';
    ctx.fillText(`−${h.pts}`, sx, sy);
  }
  ctx.globalAlpha = 1;
}

// First-person view from the cabin, drawn into the box (x, y, w, h).
// opts.rear: look backwards, mirrored left-right (rear-view mirror).
export function drawPov(ctx, g, x, y, w, h, opts = {}) {
  const yaw = g.fl.a + (opts.rear ? Math.PI : 0);
  const eye = toWorld(g.fl, EYE_X, 0);
  const horizon = h * 0.35;
  const fov = opts.rear ? REAR_HFOV : HFOV;
  const cam = {
    x: eye.x, y: eye.y, z: EYE_Z + EYE_FOLLOW * g.hf * (BOX_H + PAL),
    c: Math.cos(yaw), s: Math.sin(yaw),
    f: w / 2 / Math.tan(fov / 2), cx: x + w / 2, cy: y + horizon,
  };

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  if (opts.rear) { ctx.translate(2 * x + w, 0); ctx.scale(-1, 1); }

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

  drawCeiling(ctx, g, cam);
  floorGrid(ctx, cam);
  drawFloorDecals(ctx, g, cam);
  drawFloorMarks(ctx, g, cam);
  drawRevFloor(ctx, g, cam);
  const faces = buildFaces(g, cam);
  for (const f of faces) if (f.d < MAX_DIST) drawFace(ctx, cam, g, f);
  drawRevWalls(ctx, g, cam);
  if (!opts.rear) drawZoneLabels(ctx, g, cam, faces);
  if (!opts.rear) drawHits(ctx, g, cam);
  ctx.restore();

  ctx.strokeStyle = '#111';
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(opts.rear ? 'REAR MIRROR' : 'CABIN VIEW  (M: swap)', x + 6, y + 5);
}
