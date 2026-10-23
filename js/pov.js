import { COLORS } from './level.js';
import { theme } from './theme.js';
import { FL, toWorld } from './forklift.js';
import { carriedWorldOffs, zoneDone, isSolved, scoreEnough, isParked } from './game.js';

// Cabin view: a small polygon-projection 3D renderer. Everything is built from
// prisms (walls, pallets, boxes, tines), split into faces, back-face culled and
// painted far to near. Camera space: fw = forward, rt = right, z = up.

const EYE_X = -0.5; // seat position, local x (origin at the front axle)
const EYE_Z = 1.45; // eye height with the fork on the floor
const EYE_FOLLOW = 0.4; // share of the fork height the eye follows
const WALL_H = 3;
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

function floorGrid(ctx, cam) {
  const R = 18;
  const x0 = Math.floor(cam.x - R), x1 = Math.ceil(cam.x + R), y0 = Math.floor(cam.y - R), y1 = Math.ceil(cam.y + R);
  ctx.beginPath();
  const line = (ax, ay, bx, by) => {
    const p = project(cam, [toCam(cam, ax, ay, 0), toCam(cam, bx, by, 0)]);
    if (p.length === 2) { ctx.moveTo(p[0][0], p[0][1]); ctx.lineTo(p[1][0], p[1][1]); }
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
function addPrism(faces, cam, x, y, a, hl, hw, z0, z1, color, wall = false, split = wall ? 1 : 0) {
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
        side: [q0, q1, z0, z1],
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
  if (cam.z > z1) flat(z1, 1, true);
  else if (cam.z < z0) flat(z0, 0.5, false);
}

// Stack with a pallet under every box; level h sits at height h * (BOX_H + PAL).
// Boxes from index `from` up are drawn `extra` levels higher (a stack still being lowered).
function addStack(faces, cam, x0, y0, rots, layers, level, offs = [], from = 0, extra = 0) {
  layers.forEach((col, i) => {
    const x = x0 + (offs[i]?.x || 0), y = y0 + (offs[i]?.y || 0);
    const z = (level + i + (i >= from ? extra : 0)) * (BOX_H + PAL), r = rots[i] ?? 0;
    const cr = Math.cos(r), sr = Math.sin(r);
    addPrism(faces, cam, x, y, r, 0.2, 0.2, z, z + PAL, PALLET_COLOR);
    for (const [u, v] of [[-0.45, -0.45], [0.45, -0.45], [0.45, 0.45], [-0.45, 0.45]]) {
      addPrism(faces, cam, x + u * cr - v * sr, y + u * sr + v * cr, r, 0.05, 0.05, z, z + PAL, PALLET_COLOR);
    }
    addPrism(faces, cam, x, y, r, 0.5, 0.5, z + PAL, z + PAL + BOX_H, COLORS[col]);
  });
}

function buildFaces(g, cam) {
  const faces = [];
  for (const w of g.walls) {
    addPrism(faces, cam, w.x + w.w / 2, w.y + w.h / 2, 0, w.w / 2, w.h / 2, 0, WALL_H, null, true);
  }
  for (const st of g.stacks) addStack(faces, cam, st.x, st.y, st.rots || [], st.layers, 0, st.offs, st.dropFrom ?? 0,
      st.dropFrom != null ? Math.max(0, g.hf - st.dropFrom) : 0);
  if (g.carried) {
    const p = toWorld(g.fl, FL.carryX, 0);
    addStack(faces, cam, p.x, p.y, g.carriedRots.map((r) => r + g.fl.a), g.carried, g.hf, carriedWorldOffs(g));
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

function drawFace(ctx, cam, f) {
  const pts = project(cam, f.quad.map(([x, y, z]) => toCam(cam, x, y, z)));
  if (pts.length < 3) return;
  const dark = Math.min(0.75, f.d / FAR_DARK) + (1 - f.shade) * 0.6;
  ctx.beginPath();
  pts.forEach(([X, Y], i) => (i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y)));
  ctx.closePath();
  ctx.fillStyle = f.color || ((f.tile ?? 0) & 1 ? '#5d646e' : '#555b64');
  ctx.fill();
  ctx.fillStyle = `rgba(0,0,0,${Math.max(0, dark)})`;
  ctx.fill();
  if (f.lit) { ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fill(); }
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

  floorGrid(ctx, cam);
  drawFloorMarks(ctx, g, cam);
  const faces = buildFaces(g, cam);
  for (const f of faces) if (f.d < MAX_DIST) drawFace(ctx, cam, f);
  if (!opts.rear) drawZoneLabels(ctx, g, cam, faces);
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
