import { COLORS } from '../level.js';
import { theme } from '../theme.js';
import { decalsEnabled, overheadDecals, boxDecalKind } from '../decals.js';
import { FL, toWorld } from '../forklift.js';
import { carriedWorldOffs } from '../game.js';
import { BOX_H, PAL, WALL_H, CHARGER_H, PALLET_COLOR, MAX_DIST, offscreen, toCam } from './camera.js';

// Scene geometry: everything is a prism (walls, pallets, boxes, tines, fixtures) split into
// faces, back-face culled and sorted far to near (painter's algorithm).

// Adds the faces of a rectangular prism (centre x,y, heading a, half sizes hl,hw, heights z0..z1).
// split: max segment length; long faces are cut up so far-to-near sorting stays right (walls, tines).
// wall = true: colourless, checker-tinted tiles.
export function addPrism(faces, cam, x, y, a, hl, hw, z0, z1, color, wall = false, split = wall ? 1 : 0, deco = 0, skipTop = false, skipBottom = false) {
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
        mx: x + um * c, my: y + um * s, mz: z, color, shade, lit, boxFlat: !wall && hl === 0.5 && hw === 0.5,
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
    if (Math.hypot(x - cam.x, y - cam.y) < 12) for (const [u, v] of [[-0.45, -0.45], [0.45, -0.45], [0.45, 0.45], [-0.45, 0.45]]) {
      addPrism(faces, cam, x + u * cr - v * sr, y + u * sr + v * cr, r, 0.05, 0.05, z, z + PAL, PALLET_COLOR, false, 0, 0, true, i > 0);
    }
    addPrism(faces, cam, x, y, r, 0.5, 0.5, z + PAL, z + PAL + BOX_H, COLORS[col], false, 0, decalsEnabled() ? pens[i]?.deco ?? boxDecalKind(col, i) : 0);
  });
}

const OVERHEAD_R = 20; // fixtures further away are tiny and fogged

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
    }
    const [hx, hy] = sz(len / 2, th / 2);
    const n = Math.floor(len / 0.6);
    for (let i = 0; i < n; i++) {
      const [x, y] = place(-len / 2 + (i + 0.5) * (len / n), 0);
      const [bx, by] = sz(len / n / 2, th / 2);
      addPrism(faces, cam, x, y, 0, bx, by, WALL_H - 0.35, WALL_H - 0.05, i & 1 ? '#262626' : '#f4c414', false, 0, 0, true);
    }
  }
}

// Fork carriage: a plate on the mast, an upright shank and a blade with a tapered, thinner tip per tine.
function addForks(faces, cam, g) {
  const tz = g.hf * (BOX_H + PAL), col = theme().tine;
  const { tineX0: x0, tineX1: x1, tineOff: off, tineHalf: hw } = FL;
  const at = (u, v) => toWorld(g.fl, u, v), a = g.fl.a;
  const tipX = x1 - 0.3, bodyLen = (tipX - x0) / 2;
  for (const side of [-1, 1]) {
    const b = at(x0 + bodyLen, side * off);
    addPrism(faces, cam, b.x, b.y, a, bodyLen, hw, tz, tz + PAL, col, false, 0.2);
    const tip = at((tipX + x1) / 2, side * off);
    addPrism(faces, cam, tip.x, tip.y, a, 0.15, hw * 0.55, tz, tz + PAL * 0.5, col, false, 0);
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
  addForks(faces, cam, g);
  for (const f of faces) f.d = Math.hypot(f.mx - cam.x, f.my - cam.y, f.mz - cam.z) + (f.boxFlat ? 0.6 : 0); // lids/undersides sit behind the pallet parts touching them
  faces.sort((a, b) => b.d - a.d);
  return dropHidden(faces, cam);
}
