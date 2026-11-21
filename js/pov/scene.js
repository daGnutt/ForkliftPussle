import { COLORS } from '../level.js';
import { botDrawPos } from '../bot.js';
import { truckPaint, TRUCK_H, truckRoofs, animatedDoors } from '../endless.js';
import { theme } from '../theme.js';
import { decalsEnabled, overheadDecals, boxDeco, OPEN_BOX_DECAL_EDGES } from '../decals.js';
import { FL, toWorld, truckColor } from '../forklift.js';
import { carriedDrawH, carriedWorldOffs, carriedJoltZ, otherTrucksShown, isGhost, dropLift, stackZ, fallView, truckPopScale, liftedHf } from '../game.js';
import { BOX_H, PAL, WALL_H, CHARGER_H, PALLET_COLOR, MAX_DIST, offscreen, toCam } from './camera.js';
import { BOX_SCALE, BOX_HALF_X, halfY, palletRunnerDims, TINE_H, PALLET_DECK_H } from '../geom.js';

// Scene geometry: everything is a prism (walls, pallets, boxes, tines, fixtures) split into
// faces, back-face culled and sorted far to near (painter's algorithm).

// Adds the faces of a rectangular prism (centre x,y, heading a, half sizes hl,hw, heights z0..z1).
// split: max segment length; long faces are cut up so far-to-near sorting stays right (walls, tines).
// wall = true: colourless, checker-tinted tiles.
function addPrism(faces, cam, x, y, a, hl, hw, z0, z1, color, wall = false, split = wall ? 1 : 0, deco = 0, skipTop = false, skipBottom = false, decoEdges = null) {
  const c = Math.cos(a), s = Math.sin(a);
  const p = [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]].map(([u, v]) => [x + u * c - v * s, y + u * s + v * c]);
  if (Math.hypot(x - cam.x, y - cam.y) - Math.hypot(hl, hw) > MAX_DIST || offscreen(cam, p)) return;
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
        side: [q0, q1, z0, z1], k, n, deco: decoEdges && !decoEdges.includes(i) ? 0 : deco, edge: i,
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
        mx: x + um * c, my: y + um * s, mz: z, color, shade, lit, boxFlat: !wall && hl === BOX_HALF_X && hw === BOX_HALF_X,
      });
    }
  };
  if (cam.z > z1) { if (!skipTop) flat(z1, 1, true); }
  else if (cam.z < z0 && !skipBottom) flat(z0, 0.5, false);
}

function addCylinder(faces, cam, x, y, r, z0, z1, color, n = 16) {
  const pts = Array.from({ length: n }, (_, i) => {
    const a = i * Math.PI * 2 / n;
    return [x + Math.cos(a) * r, y + Math.sin(a) * r];
  });
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    const nx = dy / len, ny = -dx / len;
    if ((cam.x - a[0]) * nx + (cam.y - a[1]) * ny <= 0) continue;
    faces.push({ quad: [[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]],
      mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2, mz: (z0 + z1) / 2, color, shade: 0.75 + 0.25 * Math.abs(dx / len) });
  }
  if (cam.z > z1) for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    faces.push({ quad: [[x, y, z1], [a[0], a[1], z1], [b[0], b[1], z1], [b[0], b[1], z1]],
      mx: (x + a[0] + b[0]) / 3, my: (y + a[1] + b[1]) / 3, mz: z1, color, shade: 1 });
  }
}

function addBarrelDecals(faces, cam, x, y, z0, r, rot) {
  const mark = [[0, 0.12], [0.055, 0.035], [0.065, -0.015], [0, -0.12], [-0.065, -0.015], [-0.055, 0.035]];
  const ink = '#20292b', n = 16, radius = r * Math.cos(Math.PI / n) + 0.003;
  for (let i = 0; i < 4; i++) {
    const a = rot + Math.PI / n + i * Math.PI / 2, nx = Math.cos(a), ny = Math.sin(a);
    if ((cam.x - x) * nx + (cam.y - y) * ny <= 0) continue;
    const tx = -ny, ty = nx, z = z0 + (2 * (BOX_H + PAL) - PAL) / 2;
    const pts = mark.map(([u, v]) => [x + nx * radius + tx * u, y + ny * radius + ty * u, z + v]);
    const mid = [x + nx * radius, y + ny * radius, z];
    for (let j = 0; j < pts.length; j++) {
      const a = pts[j], b = pts[(j + 1) % pts.length];
      faces.push({ quad: [mid, a, b, b], mx: (mid[0] + a[0] + b[0]) / 3, my: (mid[1] + a[1] + b[1]) / 3,
        mz: (mid[2] + a[2] + b[2]) / 3, color: ink, shade: 1 });
    }
  }
}

const PAL_SLATS = [-0.42, -0.21, 0, 0.21, 0.42];

// Stack with a pallet under every box; level h sits at height h * (BOX_H + PAL).
// Boxes from index `from` up are drawn `extra` levels higher (a stack still being lowered).
function addStack(faces, cam, x0, y0, rots, layers, level, offs = [], from = 0, extra = 0, pens = []) {
  layers.forEach((col, i) => {
    if (pens[i]?.barrelPart === 'top') return;
    const x = x0 + (offs[i]?.x || 0), y = y0 + (offs[i]?.y || 0);
    const z = (level + i + (i >= from ? extra : 0)) * (BOX_H + PAL), r = rots[i] ?? 0;
    const cr = Math.cos(r), sr = Math.sin(r), pen = pens[i], scale = BOX_SCALE, hx = BOX_HALF_X, hy = halfY(pen);
    const deck = z + PAL;
    // as in the GL view: three runners along local x, five deck slats across them (perpendicular to the box tape)
    if (Math.hypot(x - cam.x, y - cam.y) < 14) {
      for (const [off, hw] of palletRunnerDims(pen)) addPrism(faces, cam, x - sr * off, y + cr * off, r, hx, hw, z, deck - 0.025, PALLET_COLOR, false, 0, 0, true, i > 0);
      for (const u of PAL_SLATS) addPrism(faces, cam, x + cr * u * scale, y + sr * u * scale, r, 0.075 * scale, hy, deck - PALLET_DECK_H, deck, PALLET_COLOR, false, 0, 0, false, true);
    } else addPrism(faces, cam, x, y, r, hx, hy, z, deck, PALLET_COLOR, false, 0, 0, true, i > 0);
    const first = faces.length;
    if (pens[i]?.barrelPart === 'base') {
      const top = z + 2 * (BOX_H + PAL);
      addCylinder(faces, cam, x, y, 0.38, deck, top, COLORS[col]);
      if (decalsEnabled()) addBarrelDecals(faces, cam, x, y, deck, 0.38, r);
      for (const h of [0.26, 0.74]) addCylinder(faces, cam, x, y, 0.395, deck + h * (top - deck), deck + h * (top - deck) + 0.035, '#a8afb0');
      addCylinder(faces, cam, x, y, 0.35, top, top + 0.008, '#20292b');
      return;
    }
    addPrism(faces, cam, x, y, r, hx, hy, z + PAL, z + PAL + BOX_H, COLORS[col], false, 0, decalsEnabled() ? boxDeco(pens[i], col, i) : 0,
      false, false, pens[i]?.open ? OPEN_BOX_DECAL_EDGES : null);
    if (pens[i]?.open) {
      addPrism(faces, cam, x, y, r, 0.4 * scale, 0.4 * scale, z + PAL + BOX_H, z + PAL + BOX_H + 0.01, '#1b1b1b', false, 0, 0, false, true);
      addPrism(faces, cam, x, y, r, 0.07 * scale, 0.4 * scale, z + PAL + BOX_H + 0.012, z + PAL + BOX_H + 0.024, '#555b60', false, 0, 0, false, true);
    }
    if (pen?.dent || pen?.tape) for (let k = first; k < faces.length; k++) { faces[k].pen = pen; faces[k].dseed = i + Math.round(col * 7); faces[k].box = { x, y, r, scale }; }
  });
}

// Cleaning bot hatch and bot (see js/bot.js), as simple prisms.
function addBot(faces, cam, g) {
  const h = g.hatch;
  if (!h || Math.hypot(h.x - cam.x, h.y - cam.y) > MAX_DIST) return;
  addPrism(faces, cam, h.x + h.nx * 0.03, h.y + h.ny * 0.03, h.a, 0.03, 0.45, 0, 0.55, '#2b2f33');
  const q = g.inspector;
  if (q && q.show > 0) {
    const { x: bx, y: by } = botDrawPos(q, g.hatch), at = (u, v) => [bx + (u * Math.cos(q.a) - v * Math.sin(q.a)), by + (u * Math.sin(q.a) + v * Math.cos(q.a))];
    for (const v of [-0.25, 0.25]) addPrism(faces, cam, ...at(0, v), q.a, 0.2, 0.05, 0, 0.12, '#4a4d52');
    addPrism(faces, cam, bx, by, q.a, 0.22, 0.2, 0.1, 0.45, '#f6f6f4');
    addPrism(faces, cam, ...at(0.24, 0), q.a, 0.06, 0.1, 0.2, 0.4, q.flash > 0 ? '#ffffff' : '#111317');
  }
  const b = g.bot;
  if (!b || b.show <= 0) return;
  const { x: bx, y: by } = botDrawPos(b, g.hatch), at = (u, v) => [bx + (u * Math.cos(b.a) - v * Math.sin(b.a)), by + (u * Math.sin(b.a) + v * Math.cos(b.a))];
  for (const v of [-0.25, 0.25]) addPrism(faces, cam, ...at(0, v), b.a, 0.2, 0.05, 0, 0.12, '#4a4d52');
  addPrism(faces, cam, bx, by, b.a, 0.22, 0.2, 0.1, 0.4, '#f2f2ee');
  addPrism(faces, cam, ...at(0.2, 0), b.a, 0.04, 0.15, 0.2, 0.36, '#20262c');
  for (const v of [-0.17, 0.17]) addPrism(faces, cam, ...at(0.28, v), b.a, 0.08, 0.02, 0.1, 0.14, '#4a4d52');
  addPrism(faces, cam, ...at(0.36, 0), b.a, 0.05, 0.17, 0.07, 0.17, '#e8c52e');
}

const OVERHEAD_R = 20; // fixtures further away are tiny and fogged

function addOil(faces, cam, g) {
  for (const spill of g.oil || []) {
    if (Math.hypot(spill.x - cam.x, spill.y - cam.y) - spill.r > MAX_DIST) continue;
    const pts = Array.from({ length: 16 }, (_, i) => {
      const a = i * Math.PI / 8;
      return [spill.x + Math.cos(a) * spill.r, spill.y + Math.sin(a) * spill.r * 0.72];
    });
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      faces.push({ quad: [[spill.x, spill.y, 0.008], [a[0], a[1], 0.008], [b[0], b[1], 0.008], [b[0], b[1], 0.008]],
        mx: (spill.x + a[0] + b[0]) / 3, my: (spill.y + a[1] + b[1]) / 3, mz: 0.008, color: '#172322', shade: 1 });
    }
  }
}

// Ceiling fixtures as prisms so walls and boxes occlude them correctly.
function addOverhead(faces, cam, g) {
  if (!decalsEnabled()) return;
  const { lights, fans } = overheadDecals(g);
  const near = (o, r) => Math.hypot(o.x - cam.x, o.y - cam.y) < r;
  for (const l of lights) {
    if (!near(l, OVERHEAD_R)) continue;
    addPrism(faces, cam, l.x, l.y, l.a, 0.9, 0.14, WALL_H - 0.1, WALL_H - 0.02, '#4a4f57');
    const n = faces.length;
    addPrism(faces, cam, l.x, l.y, l.a, 0.84, 0.1, WALL_H - 0.12, WALL_H - 0.1, '#fff8d6');
    for (let i = n; i < faces.length; i++) faces[i].glow = true;
  }
  for (const f of fans) {
    if (!near(f, OVERHEAD_R)) continue;
    addPrism(faces, cam, f.x, f.y, 0, 0.025, 0.025, WALL_H - 0.35, WALL_H, '#2c3036');
    addPrism(faces, cam, f.x, f.y, 0, 0.12, 0.12, WALL_H - 0.45, WALL_H - 0.33, '#2c3036');
    for (let i = 0; i < 4; i++) {
      const a = f.a + (i * Math.PI) / 2, c = Math.cos(a), s = Math.sin(a);
      addPrism(faces, cam, f.x + c * 0.6, f.y + s * 0.6, a, 0.48, 0.1, WALL_H - 0.43, WALL_H - 0.41, '#8c939b');
    }
  }
}

// Doorway trim: hazard-striped jamb posts up to 2 high on both sides of each opening and a header beam under the ceiling.
// Purely visual; no collision. Posts hug the jambs so the passable width is unchanged.
function addDoorways(faces, cam, g) {
  if (!decalsEnabled()) return;
  for (const d of g.doors || []) {
    const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
    if (Math.hypot(cx - cam.x, cy - cam.y) > 24) continue;
    const vert = d.h > d.w, len = vert ? d.h : d.w, th = vert ? d.w : d.h;
    const place = (u, v) => (vert ? [cx + v, cy + u] : [cx + u, cy + v]);
    const sz = (a, b) => (vert ? [b, a] : [a, b]);
    for (const su of [-1, 1]) for (const sv of [-1, 1]) {
      const [x, y] = place(su * (len / 2 - 0.07), sv * (th / 2 - 0.07));
      const [hx, hy] = sz(0.07, 0.07);
      for (let i = 0; i < 4; i++) addPrism(faces, cam, x, y, 0, hx, hy, i * 0.5, i * 0.5 + 0.5, i & 1 ? '#262626' : '#f4c414');
      addPrism(faces, cam, x, y, 0, hx, hy, 2, 2.05, '#262626');
      const n = faces.length;
      addPrism(faces, cam, x, y, 0, hx * 0.8, hy * 0.8, 2.05, 2.25, '#ffa000');
      for (let i = n; i < faces.length; i++) faces[i].glow = true;
    }
    const [hx, hy] = sz(len / 2, th / 2);
    const n = Math.floor(len / 0.6);
    const m = faces.length;
    const [lx, ly] = sz(0.5, th / 2 - 0.1), [mx, my] = place(0, 0);
    addPrism(faces, cam, mx, my, 0, lx, ly, WALL_H - 0.4, WALL_H - 0.35, '#ffa000', false, 0, 0, true);
    for (let i = m; i < faces.length; i++) faces[i].glow = true;
    for (let i = 0; i < n; i++) {
      const [x, y] = place(-len / 2 + (i + 0.5) * (len / n), 0);
      const [bx, by] = sz(len / n / 2, th / 2);
      addPrism(faces, cam, x, y, 0, bx, by, WALL_H - 0.35, WALL_H - 0.05, i & 1 ? '#262626' : '#f4c414', false, 0, 0, true);
    }
  }
}

// Another truck seen from the cabin: chassis, counterweight, roof, and its carried stack and forks.
function addTruck(faces, cam, t) {
  const pal = truckColor(t.truck.color), W = FL.halfW, at = (u, v) => toWorld(t.fl, u, v), a = t.fl.a;
  const part = (x0, x1, z0, z1, col) => {
    const c = at((x0 + x1) / 2, 0);
    addPrism(faces, cam, c.x, c.y, a, (x1 - x0) / 2, W, z0, z1, col);
  };
  part(FL.back, FL.front, 0.15, 0.5, pal.body);
  part(FL.back, FL.back + 0.55, 0.5, 0.85, pal.counter);
  part(-1.2, 0.05, 1.15, 1.25, pal.roof);
  if (t.carried) {
    const p = at(FL.carryX, 0);
    addStack(faces, cam, p.x, p.y, t.carriedRots.map((r) => r + a), t.carried, (carriedDrawH(t) ?? 0) + carriedJoltZ(t), carriedWorldOffs(t), 0, 0, t.carriedPen);
  }
  addForks(faces, cam, t);
}

// Fork carriage: a plate on the mast, an upright shank and a blade with a tapered, thinner tip per tine.
function addForks(faces, cam, g) {
  const tz = g.hf * (BOX_H + PAL), col = theme().tine;
  const { tineX0: x0, tineX1: x1, tineOff: off, tineHalf: hw } = FL;
  const at = (u, v) => toWorld(g.fl, u, v), a = g.fl.a;
  const tipX = x1 - 0.3, bodyLen = (tipX - x0) / 2;
  for (const side of [-1, 1]) {
    const b = at(x0 + bodyLen, side * off);
    addPrism(faces, cam, b.x, b.y, a, bodyLen, hw, tz, tz + TINE_H, col, false, 0.2);
    const tip = at((tipX + x1) / 2, side * off);
    addPrism(faces, cam, tip.x, tip.y, a, 0.15, hw * 0.55, tz, tz + TINE_H * 0.5, col, false, 0);
    const sh = at(x0 + 0.05, side * off);
    addPrism(faces, cam, sh.x, sh.y, a, 0.05, hw, tz, tz + 0.5, col, false, 0.2);
  }
  const plate = at(x0 - 0.05, 0);
  addPrism(faces, cam, plate.x, plate.y, a, 0.03, off + hw, tz + 0.3, tz + 0.4, col, false, 0.3);
}

const COLS = 256;

// Wall faces span floor to ceiling, so anything inside the building that lies further away along the same
// view columns is hidden. Per screen column we keep the depth of the nearest wall covering it fully and drop
// faces that lie wholly behind that depth (conservatively: whole columns only, forward depth only).
function dropHidden(faces, cam) {
  const left = cam.cx - cam.hw, colW = (2 * cam.hw) / COLS;
  const block = new Float64Array(COLS).fill(Infinity);
  const info = faces.map((f) => {
    let lo = Infinity, hi = -Infinity, dmin = Infinity, dmax = -Infinity;
    for (const [x, y, z] of f.quad) {
      const [fw, rt] = toCam(cam, x, y, z);
      if (fw < 0.2) return null;
      const X = cam.cx + (rt / fw) * cam.f;
      if (X < lo) lo = X;
      if (X > hi) hi = X;
      if (fw < dmin) dmin = fw;
      if (fw > dmax) dmax = fw;
    }
    return { c0: Math.floor((lo - left) / colW), c1: Math.floor((hi - left) / colW), dmin, dmax, lo, hi };
  });
  faces.forEach((f, i) => {
    const v = info[i];
    if (!v || f.tile == null || !f.side) return;
    const a = Math.ceil((v.lo - left) / colW), b = Math.floor((v.hi - left) / colW) - 1;
    for (let c = Math.max(0, a); c <= Math.min(COLS - 1, b); c++) if (v.dmax < block[c]) block[c] = v.dmax;
  });
  return faces.filter((f, i) => {
    const v = info[i];
    if (!v) return true;
    for (let c = Math.max(0, v.c0); c <= Math.min(COLS - 1, v.c1); c++) if (!(block[c] < v.dmin)) return true;
    return false;
  });
}

// All faces of the level seen from `cam`, sorted far to near.
export function buildFaces(g, cam) {
  const faces = [];
  addOverhead(faces, cam, g);
  addDoorways(faces, cam, g);
  for (const w of g.walls) {
    if (w.lift !== undefined) continue; // bay doors are added below, animated
    if (w.charger) {
      const n = faces.length;
      addPrism(faces, cam, w.x + w.w / 2, w.y + w.h / 2, 0, w.w / 2, w.h / 2, 0, CHARGER_H, '#c62828');
      for (let i = n; i < faces.length; i++) faces[i].charger = true;
    } else if (w.truck) {
      const c = w.truck.part === 'gate' ? '#b9bec5' : truckPaint(w.truck.color);
      addPrism(faces, cam, w.x + w.w / 2, w.y + w.h / 2, 0, w.w / 2, w.h / 2, 0, w.truck.part === 'cab' || w.truck.part === 'wcab' ? 2.6 : TRUCK_H, c);
    } else addPrism(faces, cam, w.x + w.w / 2, w.y + w.h / 2, 0, w.w / 2, w.h / 2, 0, WALL_H, w.roller ? '#c9cfd6' : null, !w.roller);
  }
  for (const { w } of animatedDoors(g)) {
    const top = w.roller ? WALL_H : TRUCK_H, lo = w.lift * (top - (w.roller ? 0.65 : 0.25));
    addPrism(faces, cam, w.x + w.w / 2, w.y + w.h / 2, 0, w.w / 2, w.h / 2, lo, top, w.roller ? '#c9cfd6' : w.truck.part === 'gate' ? '#b9bec5' : truckPaint(w.truck.color));
  }
  for (const r of truckRoofs(g)) addPrism(faces, cam, (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, 0, (r.x1 - r.x0) / 2, (r.y1 - r.y0) / 2, TRUCK_H - 0.03, TRUCK_H, truckPaint(r.color), false, 1);
  addOil(faces, cam, g);
  addBot(faces, cam, g);
  for (const st0 of g.stacks) { const st = fallView(g, st0); addStack(faces, cam, st.x, st.y, st.rots || [], st.layers, stackZ(st), st.offs, st.dropFrom ?? 0,
      dropLift(g, st), st.pen); }
  if (g.carried) {
    const p = toWorld(g.fl, FL.carryX, 0);
    addStack(faces, cam, p.x, p.y, g.carriedRots.map((r) => r + g.fl.a), g.carried, (carriedDrawH(g) ?? 0) + carriedJoltZ(g), carriedWorldOffs(g), 0, 0, g.carriedPen);
  }
  addForks(faces, cam, g);
  for (const t of otherTrucksShown(g)) {
    if (isGhost(g, t.truck.id)) continue; // the software view cannot blend, so ghosts are left out
    const start = faces.length;
    addTruck(faces, cam, t);
    const popScale = truckPopScale(g, t.truck.id);
    if (popScale < 1) {
      const lift = (liftedHf(t) ?? 0) * (BOX_H + PAL), { x, y } = t.fl;
      for (let i = start; i < faces.length; i++) {
        const face = faces[i];
        face.quad = face.quad.map(([px, py, pz]) => [x + (px - x) * popScale, y + (py - y) * popScale, lift + (pz - lift) * popScale]);
        face.mx = x + (face.mx - x) * popScale;
        face.my = y + (face.my - y) * popScale;
        face.mz = lift + (face.mz - lift) * popScale;
      }
    }
  }
  for (const f of faces) f.d = Math.hypot(f.mx - cam.x, f.my - cam.y, f.mz - cam.z) + (f.boxFlat ? 0.6 : 0); // lids/undersides sit behind the pallet parts touching them
  faces.sort((a, b) => b.d - a.d);
  return dropHidden(faces, cam);
}
