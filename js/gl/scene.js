import { COLORS } from '../level.js';
import { BOGIE, truckPaint, truckGeom, truckFloorArt, rampDecals, yardRects, truckBays } from '../endless.js';
import { theme } from '../theme.js';
import { FL, toWorld } from '../forklift.js';
import { decalsEnabled, floorDecals, overheadDecals } from '../decals.js';
import { discoOn, discoBalls, discoSources, discoSpots, SPOT_R, BALL_R, BALL_DROP } from '../disco.js';
import { reverseLight } from '../revlight.js';
import { zoneDone, zoneLabelPos, isSolved, scoreEnough, isParked, otherTrucksShown, isGhost, dropLift, stackZ } from '../game.js';
import { paintWallDecals, chargerDecal } from '../pov/face.js';
import { Mesh, parseColor, mix, shade, hsl } from './mesh.js';
import { addParticles } from './particles.js';
import { WALL_H, HEAD_X, HEAD_Z, TAIL_X, TAIL_Z, LAMP_Y, BOX_H, PAL, addStack, addForklift, addForks, addCarried, bareForksEnabled } from './models.js';

// Builds the meshes for the WebGL renderer. `mode` is 'pov' (cabin: ceiling, signs) or 'ov' (overview / third person:
// no ceiling). Walls are always full height; in 'ov' the renderer clips the ones on the camera side of the forklift
// (see `wallClip`). Static meshes depend only on the level and theme;
// dynamic ones (stacks, forklift, markings) are rebuilt every frame.

export const OV_WALL_H = 1.1; // lowest height the camera-side walls are clipped to in 'ov'

// Clip for the static walls: [nx, ny, d, zMax] hides geometry with dot(xy, n) > d above zMax. The overview cuts every
// wall at OV_WALL_H (n = 0, d = -1 matches everything); the third-person view (`cam.chase`) shows them full height (null).
export function wallClip(cam) {
  return cam.chase ? null : [0, 0, -1, OV_WALL_H];
}
export const CHARGER_H = 0.9;
const GREY = [0.43, 0.45, 0.48, 1], WHITE = [1, 1, 1, 1];
const YEL = '#f4c414', RED = '#c62828', BLACK = '#1a1a1a';

const circlePts = (u, v, r, n = 18) => Array.from({ length: n }, (_, i) => [u + Math.cos((i / n) * Math.PI * 2) * r, v + Math.sin((i / n) * Math.PI * 2) * r]);

// Tops for the clipped part of each wall (at the clip height) so the cut walls look solid; the rectangle is cut
// to the clipped half-plane.
// Cabs are drawn into their own mesh that the wall clipping plane never cuts.
const isCab = (w) => w.truck && (w.truck.part === 'cab' || w.truck.part === 'wcab');

export function wallCaps(g, [nx, ny, d, z]) {
  const m = new Mesh();
  if (z >= WALL_H) return m;
  const grey = parseColor('#6d737a');
  for (const w of g.walls) {
    if (w.charger || isCab(w)) continue;
    const col = w.truck ? parseColor(truckPaint(w.truck.color)) : grey;
    const pts = [[w.x, w.y], [w.x + w.w, w.y], [w.x + w.w, w.y + w.h], [w.x, w.y + w.h]], out = [];
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4], da = nx * a[0] + ny * a[1] - d, db = nx * b[0] + ny * b[1] - d;
      if (da > 0) out.push(a);
      if (da > 0 !== db > 0) out.push([a[0] + ((b[0] - a[0]) * da) / (da - db), a[1] + ((b[1] - a[1]) * da) / (da - db)]);
    }
    for (let i = 1; i + 1 < out.length; i++) m.tri([...out[0], z], [...out[i], z], [...out[i + 1], z], [0, 0, 1], col);
  }
  return m;
}

// A truck cab facing `a` (0 east, PI/2 south, PI west): a tall cab at the trailer end, a lower hood in front with grille,
// bumper and headlights, side windows, mirrors and wheels. Shared by the delivery and the incoming lorries.
function addCab(sm, w, col, a) {
  const f = [Math.round(Math.cos(a)), Math.round(Math.sin(a))], l = [-f[1], f[0]], horiz = f[0] !== 0;
  const depth = horiz ? w.w : w.h, hw = (horiz ? w.h : w.w) / 2, cx = w.x + w.w / 2, cy = w.y + w.h / 2;
  const fx = cx + (f[0] * depth) / 2, fy = cy + (f[1] * depth) / 2; // centre of the front edge
  const pos = (t, lat = 0) => [fx - f[0] * t + l[0] * lat, fy - f[1] * t + l[1] * lat];
  const box = (t0, t1, hh, z0, z1, c, o, lat = 0) => { const [x, y] = pos((t0 + t1) / 2, lat); sm.cuboid(x, y, a, (t1 - t0) / 2, hh, z0, z1, c, o); };
  box(0, depth, hw, 0.3, 0.5, '#26292e', { top: false });
  box(0.8, depth, hw, 0.5, 2.6, col);
  box(0, 0.8, hw - 0.1, 0.5, 1.35, col);
  box(0.8, depth, hw + 0.01, 0.5, 0.65, shade(col, 0.7), { top: false, bottom: false });
  box(0.78, 0.82, hw - 0.25, 1.5, 2.3, '#1d2a38', { top: false, bottom: false });
  box(0.9, 1.7, hw + 0.01, 1.5, 2.25, '#1d2a38', { top: false, bottom: false });
  box(0.8, depth, hw, 2.6, 2.7, shade(col, 0.8));
  box(-0.02, 0.03, hw - 0.4, 0.7, 1.2, '#15171a', { top: false, bottom: false });
  box(0, 0.12, hw, 0.3, 0.6, '#c9ccd1');
  for (const s of [-1, 1]) {
    box(-0.03, 0.04, 0.2, 0.7, 0.95, '#fff6c0', { emissive: true }, s * (hw - 0.5));
    const [mx, my] = pos(0.8, s * (hw + 0.12));
    sm.cuboid(mx, my, a, 0.06, 0.1, 1.5, 2.1, '#15171a');
    const [wx, wy] = pos(1.4, s * (hw + 0.05));
    sm.wheel(wx, wy, 0.4, a, 0.4, 0.14, '#15171a');
  }
}

// Delivery truck panels: sides/cab in the bay colour on a dark skirt with wheels, rear doors (the gate) in light grey.
const TRUCK_SKIRT = 0.45;
function addTruckPart(sm, w) {
  if (w.truck.part === 'cab') { addCab(sm, w, parseColor(truckPaint(w.truck.color)), Math.PI / 2); return; }
  if (w.truck.part === 'wcab') { addCab(sm, w, parseColor(truckPaint(w.truck.color)), w.truck.side < 0 ? Math.PI : 0); return; }
  const { color, part } = w.truck, cx = w.x + w.w / 2, cy = w.y + w.h / 2, hl = w.w / 2, hw = w.h / 2;
  const body = part === 'gate' ? '#b9bec5' : part === 'back' ? shade(parseColor(truckPaint(color)), 0.7) : parseColor(truckPaint(color));
  sm.cuboid(cx, cy, 0, hl, hw, 0, TRUCK_SKIRT, '#26292e', { top: false });
  sm.cuboid(cx, cy, 0, hl, hw, TRUCK_SKIRT, WALL_H, body, { bottom: false });
  if (part === 'gate' && hl > 0.2) sm.cuboid(cx, cy, 0, hl - 0.15, hw + 0.01, 1, 1.15, '#7b8088', { top: false, bottom: false });
  if (part === 'left' || part === 'right') {
    const out = part === 'left' ? -1 : 1;
    for (const d of BOGIE) sm.wheel(cx + out * (hl + 0.05), w.y + d, 0.4, Math.PI / 2, 0.4, 0.14, '#15171a');
  }
  if (part === 'side') { // incoming trailer: the gate end is east (west dock) or west (east dock)
    for (const d of BOGIE) sm.wheel(w.truck.side < 0 ? w.x + w.w - d : w.x + d, cy + w.truck.lat * (hw + 0.05), 0.4, 0, 0.4, 0.14, '#15171a');
  }
}

// Ramp: a flat decal (grey with yellow edge stripes) on the floor.
function addRampDecal(tm, r) {
  const x1 = r.x + r.w, y1 = r.y + r.h;
  tm.poly([[r.x, r.y], [x1, r.y], [x1, y1], [r.x, y1]], 0.004, parseColor('#7b8088'));
  const stripes = r.east ? [[r.x, r.y, x1, r.y + 0.12], [r.x, y1 - 0.12, x1, y1]] : [[r.x, r.y, r.x + 0.12, y1], [x1 - 0.12, r.y, x1, y1]];
  for (const [ax, ay, bx, by] of stripes) tm.poly([[ax, ay], [bx, ay], [bx, by], [ax, by]], 0.0045, parseColor('#f4c414'));
}

// One wall rectangle: sides in 1-tile segments with a checker tint, plus decals in cabin mode.
function addWall(sm, tm, g, w, mode) {
  const top = WALL_H;
  const cx = w.x + w.w / 2, cy = w.y + w.h / 2;
  if (w.charger) {
    sm.cuboid(cx, cy, 0, w.w / 2, w.h / 2, 0, CHARGER_H, '#c62828', { bottom: false });
    addChargerSigns(tm, w);
    return;
  }
  if (w.truck) { addTruckPart(sm, w); return; }
  const p = [[w.x, w.y], [w.x + w.w, w.y], [w.x + w.w, w.y + w.h], [w.x, w.y + w.h]];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = p[i], [bx, by] = p[(i + 1) % 4];
    const ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey);
    const nx = ey / len, ny = -ex / len;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    if (mx < -0.01 || my < -0.01 || mx > g.w + 0.01 || my > g.h + 0.01) continue; // faces of the border walls pointing out of the level
    const n = Math.ceil(len);
    for (let k = 0; k < n; k++) {
      const q0 = [ax + (ex * k) / n, ay + (ey * k) / n], q1 = [ax + (ex * (k + 1)) / n, ay + (ey * (k + 1)) / n];
      const tile = Math.floor((q0[0] + q0[1] + q1[0] + q1[1]) / 2);
      const col = parseColor(tile & 1 ? '#5d646e' : '#555b64');
      sm.quad([q0[0], q0[1], 0], [q1[0], q1[1], 0], [q1[0], q1[1], top], [q0[0], q0[1], top], [nx, ny, 0], col);
      if (mode === 'pov') sm.quad([q0[0], q0[1], WALL_H - 0.14], [q1[0], q1[1], WALL_H - 0.14], [q1[0], q1[1], WALL_H], [q0[0], q0[1], WALL_H], [nx, ny, 0], shade(col, 0.7));
      if (!decalsEnabled() || Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) < 0.9) continue;
      const side = [q0, q1];
      const pen = {
        shape: (uv, fill) => tm.vpoly(q1[0], q1[1], q0[0], q0[1], nx, ny, 0.004, uv, fill),
        box: (u0, v0, u1, v1, fill) => pen.shape([[u0, v0], [u1, v0], [u1, v1], [u0, v1]], fill),
        disc: (u, v, r, fill) => pen.shape(circlePts(u, v, r), fill),
        tri: (u, v, r, fill) => pen.shape([[u, v + r], [u + r * 0.95, v - r * 0.55], [u - r * 0.95, v - r * 0.55]], fill),
      };
      paintWallDecals(g, pen, { side, mx: (q0[0] + q1[0]) / 2, my: (q0[1] + q1[1]) / 2, k, n });
    }
  }
  sm.quad([w.x, w.y, top], [w.x + w.w, w.y, top], [w.x + w.w, w.y + w.h, top], [w.x, w.y + w.h, top], [0, 0, 1], parseColor('#6d737a'));
}

// High-voltage warning on each charger side and on its top.
function addChargerSigns(tm, w) {
  const edges = [[[w.x, w.y], [w.x + w.w, w.y]], [[w.x + w.w, w.y], [w.x + w.w, w.y + w.h]], [[w.x + w.w, w.y + w.h], [w.x, w.y + w.h]], [[w.x, w.y + w.h], [w.x, w.y]]];
  for (const [a, b] of edges) {
    const ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey), nx = ey / len, ny = -ex / len;
    const pen = { shape: (uv, fill) => tm.vpoly(a[0], a[1], b[0], b[1], nx, ny, 0.004, uv, fill) };
    chargerDecal(pen);
  }
  const cx = w.x + w.w / 2, cy = w.y + w.h / 2, r = Math.min(w.w, w.h) * 0.38;
  tm.poly([[cx, cy - r], [cx + r * 0.95, cy + r * 0.6], [cx - r * 0.95, cy + r * 0.6]], CHARGER_H + 0.004, YEL);
}

function addCeiling(sm, g) {
  const c = parseColor('#3d424a');
  sm.quad([0, 0, WALL_H], [0, g.h, WALL_H], [g.w, g.h, WALL_H], [g.w, 0, WALL_H], [0, 0, -1], c);
  for (let x = 0; x <= g.w; x += 4) sm.cuboid(x, g.h / 2, Math.PI / 2, g.h / 2, 0.07, WALL_H - 0.14, WALL_H, '#262a30', { top: false });
  for (let y = 0; y <= g.h; y += 4) sm.cuboid(g.w / 2, y, 0, g.w / 2, 0.07, WALL_H - 0.14, WALL_H, '#262a30', { top: false });
  if (!decalsEnabled()) return;
  const { lights, fans } = overheadDecals(g);
  for (const l of lights) {
    sm.cuboid(l.x, l.y, l.a, 0.9, 0.14, WALL_H - 0.1, WALL_H - 0.02, '#4a4f57');
    sm.cuboid(l.x, l.y, l.a, 0.84, 0.1, WALL_H - 0.125, WALL_H - 0.1, '#fff8d6', { emissive: true, top: false });
  }
  for (const f of fans) {
    sm.cuboid(f.x, f.y, 0, 0.025, 0.025, WALL_H - 0.35, WALL_H, '#2c3036');
    sm.cuboid(f.x, f.y, 0, 0.12, 0.12, WALL_H - 0.45, WALL_H - 0.33, '#2c3036');
    for (let i = 0; i < 4; i++) {
      const a = f.a + (i * Math.PI) / 2;
      sm.cuboid(f.x + Math.cos(a) * 0.6, f.y + Math.sin(a) * 0.6, a, 0.48, 0.1, WALL_H - 0.43, WALL_H - 0.41, '#8c939b');
    }
  }
}

// Doorway trim: hazard-striped jamb posts with amber beacons, plus (cabin view only) a header beam and lamp; purely visual.
// The overview gets shorter posts so they stay under the clipped walls.
function addDoorways(sm, g, mode) {
  if (!decalsEnabled()) return;
  const k = mode === 'ov' ? 0.45 : 1;
  for (const d of g.doors || []) {
    const cx = d.x + d.w / 2, cy = d.y + d.h / 2, vert = d.h > d.w, len = vert ? d.h : d.w, th = vert ? d.w : d.h;
    const place = (u, v) => (vert ? [cx + v, cy + u] : [cx + u, cy + v]);
    for (const su of [-1, 1]) {
      for (const sv of [-1, 1]) {
        const [x, y] = place(su * (len / 2 - 0.07), sv * (th / 2 - 0.07));
        for (let i = 0; i < 4; i++) sm.cuboid(x, y, 0, 0.07, 0.07, i * 0.5 * k, (i * 0.5 + 0.5) * k, i & 1 ? '#262626' : '#f4c414');
        sm.cuboid(x, y, 0, 0.07, 0.07, 2 * k, 2.05 * k, '#262626');
        sm.cuboid(x, y, 0, 0.056, 0.056, 2.05 * k, 2.25 * k, '#ffa000', { emissive: true });
      }
    }
    if (mode === 'ov') continue;
    const n = Math.floor(len / 0.6);
    const [mx, my] = place(0, 0);
    sm.cuboid(mx, my, 0, vert ? th / 2 - 0.1 : 0.5, vert ? 0.5 : th / 2 - 0.1, WALL_H - 0.4, WALL_H - 0.35, '#ffa000', { emissive: true, top: false });
    for (let i = 0; i < n; i++) {
      const [x, y] = place(-len / 2 + (i + 0.5) * (len / n), 0);
      const hl = vert ? th / 2 : len / n / 2, hw = vert ? len / n / 2 : th / 2;
      sm.cuboid(x, y, 0, hl, hw, WALL_H - 0.35, WALL_H - 0.05, i & 1 ? '#262626' : '#f4c414', { top: false });
    }
  }
}

// Floor, grid, decals, area tints (transparent layer, drawn over the floor with a depth offset).
function addFloor(sm, tm, g, mode) {
  const t = theme();
  sm.quad([0, 0, 0], [g.w, 0, 0], [g.w, g.h, 0], [0, g.h, 0], [0, 0, 1], parseColor(t.floor));
  const grid = parseColor(mode === 'pov' ? t.povGrid : t.grid), gw = mode === 'pov' ? 0.02 : 0.03;
  for (let x = 0; x <= g.w; x++) tm.poly([[x - gw, 0], [x + gw, 0], [x + gw, g.h], [x - gw, g.h]], 0, grid);
  for (let y = 0; y <= g.h; y++) tm.poly([[0, y - gw], [g.w, y - gw], [g.w, y + gw], [0, y + gw]], 0, grid);
  if (decalsEnabled()) for (const d of floorDecals(g)) tm.poly(d.pts, 0, d.fill);
  for (const y of g.endless ? yardRects() : []) tm.poly([[y.x, y.y], [y.x + y.w, y.y], [y.x + y.w, y.y + y.h], [y.x, y.y + y.h]], 0.002, parseColor('#2c2f33'));
  for (const b of truckBays(g)) {
    const t = truckGeom(b);
    truckFloorArt(t.floor).forEach(({ pts, fill }, i) => tm.poly(pts, 0.003 + 0.0005 * (i % 2), parseColor(fill)));
  }
  for (const r of rampDecals(g)) addRampDecal(tm, r);
  for (const a of g.areas) {
    const c = parseColor(COLORS[a.color]);
    tm.poly([[a.x - 0.3, a.y - 0.3], [a.x + a.w + 0.3, a.y - 0.3], [a.x + a.w + 0.3, a.y + a.h + 0.3], [a.x - 0.3, a.y + a.h + 0.3]], 0, [c[0], c[1], c[2], 0.12]);
  }
}

const cache = new WeakMap();

// { opaque, trans, cabs } meshes that only change with the level, theme and decal switch.
export function staticMeshes(g, mode) {
  const key = [theme(), decalsEnabled(), mode, g.layoutVersion || 0];
  let e = cache.get(g);
  if (!e) cache.set(g, (e = {}));
  const hit = e[mode];
  if (hit && hit.key.every((k, i) => k === key[i])) return hit;
  const sm = new Mesh(), tm = new Mesh(), cm = new Mesh();
  addFloor(sm, tm, g, mode);
  for (const w of g.walls) { if (isCab(w)) addTruckPart(cm, w); else addWall(sm, tm, g, w, mode); }
  if (mode === 'pov') addCeiling(sm, g);
  addDoorways(sm, g, mode);
  return (e[mode] = { key, opaque: sm, trans: tm, cabs: cm });
}

const revAlpha = (g) => 0.45 + 0.2 * Math.sin(g.clock * 14);

function parkingCorners(g) {
  const p = g.parking, hx = (FL.front - FL.back) / 2 + 0.2, hy = FL.halfW + 0.2;
  const c = Math.cos(p.a), s = Math.sin(p.a);
  const at = (u, v) => [p.x + u * c - v * s, p.y + u * s + v * c];
  return { hx, hy, at };
}

// Stroke font for the floor-painted zone counts: polylines on a 2x4 grid (y down).
const GLYPHS = {
  '×': [[[0, 1], [2, 3]], [[2, 1], [0, 3]]],
  0: [[[0, 0], [2, 0], [2, 4], [0, 4], [0, 0]]],
  1: [[[0, 1], [1, 0], [1, 4]]],
  2: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 4], [2, 4]]],
  3: [[[0, 0], [2, 0], [2, 4], [0, 4]], [[0, 2], [2, 2]]],
  4: [[[0, 0], [0, 2], [2, 2]], [[2, 0], [2, 4]]],
  5: [[[2, 0], [0, 0], [0, 2], [2, 2], [2, 4], [0, 4]]],
  6: [[[2, 0], [0, 0], [0, 4], [2, 4], [2, 2], [0, 2]]],
  7: [[[0, 0], [2, 0], [2, 4]]],
  8: [[[0, 0], [2, 0], [2, 4], [0, 4], [0, 0]], [[0, 2], [2, 2]]],
  9: [[[2, 2], [0, 2], [0, 0], [2, 0], [2, 4], [0, 4]]],
};

// Text painted flat on the floor, centred on (cx, cy), `u` world units per grid step; strokes are `t` thick.
function floorText(tm, str, cx, cy, u, t, z, color) {
  const adv = 3.2 * u, x0 = cx - ((str.length - 1) * adv + 2 * u) / 2, y0 = cy - 2 * u;
  [...str].forEach((ch, i) => {
    for (const line of GLYPHS[ch] || []) {
      for (let k = 1; k < line.length; k++) {
        const [ax, ay] = [x0 + i * adv + line[k - 1][0] * u, y0 + line[k - 1][1] * u];
        const [bx, by] = [x0 + i * adv + line[k][0] * u, y0 + line[k][1] * u];
        const len = Math.hypot(bx - ax, by - ay), dx = ((bx - ax) / len) * t / 2, dy = ((by - ay) / len) * t / 2;
        const nx = -dy, ny = dx;
        tm.poly([[ax - dx + nx, ay - dy + ny], [bx + dx + nx, by + dy + ny], [bx + dx - nx, by + dy - ny], [ax - dx - nx, ay - dy - ny]], z, color);
      }
    }
  });
}

function addMarks(tm, g, mode) {
  for (const z of g.zones) {
    const done = zoneDone(g, z), r = 0.6, c = parseColor(COLORS[z.color]);
    if (mode === 'ov' && !done) {
      const txt = `×${z.count}`;
      const lp = zoneLabelPos(g, z);
      floorText(tm, txt, lp.x, lp.y, 0.1, 0.16, 0.003, '#fff');
      floorText(tm, txt, lp.x, lp.y, 0.1, 0.07, 0.005, '#000');
    }
    tm.poly([[z.x - r, z.y - r], [z.x + r, z.y - r], [z.x + r, z.y + r], [z.x - r, z.y + r]], 0, [c[0], c[1], c[2], done ? 0.8 : 0.47]);
    tm.frame(z.x - r, z.y - r, z.x + r, z.y + r, 0.07, 0, c);
  }
  const ready = isSolved(g) && scoreEnough(g);
  const { hx, hy, at } = parkingCorners(g);
  const col = ready ? parseColor('#66bb6a') : parseColor('#bdbdbd');
  const fillA = ready ? (isParked(g) ? 0.6 : 0.4) : 0.33;
  tm.poly([at(-hx, -hy), at(hx, -hy), at(hx, hy), at(-hx, hy)], 0, [col[0], col[1], col[2], fillA]);
  const bar = (u0, v0, u1, v1) => tm.poly([at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)], 0, col);
  const t = 0.07;
  bar(-hx, -hy, hx, -hy + t); bar(-hx, hy - t, hx, hy); bar(-hx, -hy + t, -hx + t, hy - t); bar(hx - t, -hy + t, hx, hy - t);
  bar(-0.25, -0.35, -0.13, 0.35); bar(-0.25, -0.35, 0.15, -0.23); bar(-0.25, -0.05, 0.15, 0.07); bar(0.15, -0.35, 0.27, 0.07);
  if (ready) tm.poly([at(hx - 0.15, 0), at(hx - 0.75, -0.45), at(hx - 0.75, 0.45)], 0, col);
}

function addRevLight(tm, g) {
  const L = theme().dark ? null : reverseLight(g); // dark mode uses real white reverse lights instead
  if (!L) return;
  const a = revAlpha(g);
  tm.poly(L.pts.map((p) => [p.x, p.y]), 0.004, [41 / 255, 121 / 255, 1, a]);
  tm.poly(L.pts.map((p) => [L.x + (p.x - L.x) * 0.45, L.y + (p.y - L.y) * 0.45]), 0.006, [144 / 255, 202 / 255, 249 / 255, a]);
  const n = L.pts.length;
  for (let i = 0; i < n; i++) {
    const p = L.pts[i], q = L.pts[(i + 1) % n];
    if (!p.wall || !q.wall || Math.abs(p.x - q.x) > 0.5 || Math.abs(p.y - q.y) > 0.5) continue;
    const c = [41 / 255, 121 / 255, 1, a * 0.8];
    tm.quad([p.x, p.y, 0], [q.x, q.y, 0], [q.x, q.y, q.climb], [p.x, p.y, p.climb], [0, 0, 0], c);
  }
}

// Soft contact shadows under the forklift and the stacks.
function addBlobShadows(tm, g) {
  const dark = [0, 0, 0, 0.26];
  const sq = (x, y, r, a, h) => {
    const c = Math.cos(r), s = Math.sin(r), at = (u, v) => [x + 0.07 + u * c - v * s, y + 0.09 + u * s + v * c];
    tm.poly([at(-h, -h), at(h, -h), at(h, h), at(-h, h)], 0.002, [0, 0, 0, a]);
  };
  for (const s of g.stacks) sq(s.x + (s.offs?.[0]?.x || 0), s.y + (s.offs?.[0]?.y || 0), s.rots?.[0] || 0, 0.26, 0.53);
  const f = g.fl, W = FL.halfW, c = toWorld(f, (FL.back + FL.front) / 2, 0);
  const co = Math.cos(f.a), si = Math.sin(f.a), hl = (FL.front - FL.back) / 2;
  const at = (u, v) => [c.x + 0.08 + u * co - v * si, c.y + 0.1 + u * si + v * co];
  tm.poly([at(-hl, -W), at(hl, -W), at(hl, W), at(-hl, W)], 0.002, dark);
}

// Real point lights (shader-lit): the nearest LIGHT_MAX coloured spots, hovering above the floor.
export const LIGHT_MAX = 24, LIGHT_Z = 1.3, LIGHT_R = SPOT_R * 1.7;
function discoLights(g, eye) {
  const t = g.clock || 0, out = [];
  for (const b of discoSources(g)) {
    for (const s of discoSpots(b, t)) {
      const d = Math.hypot(s.x - eye[0], s.y - eye[1]);
      if (d < 40) out.push({ x: s.x, y: s.y, z: LIGHT_Z, r: LIGHT_R, col: hsl(s.hue, 1, 0.55, 1), d });
    }
  }
  return out.sort((p, q) => p.d - q.d).slice(0, LIGHT_MAX);
}

// Dark mode: headlights, reverse and brake lights; the ceiling fixtures are only decals, the room's glow is ambient (`DARK_LIGHT`).
const HEAD_I = 1.5, WARM = [1, 0.95, 0.8];
function darkLights(g, eye) {
  const out = [];
  const trucks = [g, ...otherTrucksShown(g).filter((t) => !isGhost(g, t.truck.id))];
  for (const t of trucks) truckLights(t, out);
  for (const l of out) l.d = Math.hypot(l.x - eye[0], l.y - eye[1]);
  return out.sort((p, q) => p.d - q.d).slice(0, LIGHT_MAX);
}

function truckLights(g, out) {
  const f = g.fl, c = Math.cos(f.a), s = Math.sin(f.a);
  const lamp = (lx, ly, z, r, col, dir, cone) => {
    const p = toWorld(f, lx, ly);
    out.push({ x: p.x, y: p.y, z, r, col, dir, cone });
  };
  const fwd = [c * 0.95, s * 0.95, -0.3];
  for (const side of [-1, 1]) lamp(HEAD_X, side * LAMP_Y, HEAD_Z, 11, WARM.map((v) => v * HEAD_I), fwd, 0.62);
  const back = [-c * 0.8, -s * 0.8, -0.6];
  for (const side of [-1, 1]) lamp(TAIL_X, side * LAMP_Y, TAIL_Z, 1.8, [0.5, 0.05, 0.03], back, 0.2); // idle tail glow
  if (f.gear === 'R') for (const side of [-1, 1]) lamp(TAIL_X, side * LAMP_Y, TAIL_Z, 4.5, [0.9, 0.9, 0.95], back, 0.45);
  if (f.brake) for (const side of [-1, 1]) lamp(TAIL_X, side * LAMP_Y, TAIL_Z, 2.2, [0.8, 0.1, 0.06], back, 0.3);
}

function addDisco(om, g, eye) {
  const t = g.clock || 0;
  for (const b of discoBalls(g)) {
    if (Math.hypot(b.x - eye[0], b.y - eye[1]) > 35) continue;
    const cz = WALL_H - BALL_DROP;
    om.cuboid(b.x, b.y, 0, 0.012, 0.012, cz, WALL_H, '#c8c8d2', { top: false, bottom: false });
    const LON = 12, LAT = 8;
    for (let i = 0; i < LAT; i++) {
      for (let j = 0; j < LON; j++) {
        const la0 = Math.PI * (i / LAT - 0.5), la1 = Math.PI * ((i + 1) / LAT - 0.5);
        const lo0 = (j / LON) * Math.PI * 2, lo1 = ((j + 1) / LON) * Math.PI * 2;
        const pt = (la, lo) => [b.x + Math.cos(la) * Math.cos(lo) * BALL_R, b.y + Math.cos(la) * Math.sin(lo) * BALL_R, cz + Math.sin(la) * BALL_R];
        const tw = Math.max(0, Math.sin(t * 5 + (i * LON + j) * 1.7 + b.k));
        const col = tw > 0.85 ? WHITE : hsl(((i * LON + j) * 47 + t * 90) % 360, 0.6, 0.45 + tw * 0.25);
        om.quad(pt(la0, lo0), pt(la0, lo1), pt(la1, lo1), pt(la1, lo0), [0, 0, 0], shade(col, 0.8));
      }
    }
  }
}

// Per-frame meshes: { opaque, trans, lights } for the game state `g` seen from `eye` ([x, y]).
export function dynamicMeshes(g, mode, eye) {
  const om = new Mesh(), tm = new Mesh();
  for (const st of g.stacks) {
    const ghost = st.ghost?.includes(g.truck.id);
    if (ghost) tm.alpha = 0.4;
    addStack(ghost ? tm : om, tm, st.x, st.y, st.rots || [], st.layers, stackZ(g, st), st.offs, st.dropFrom ?? 0,
      dropLift(g, st), st.pen);
    tm.alpha = 1;
  }
  addCarried(om, tm, g);
  for (const t of otherTrucksShown(g)) {
    const ghost = isGhost(g, t.truck.id), m = ghost ? tm : om;
    if (ghost) tm.alpha = 0.4;
    addCarried(m, tm, t);
    addForklift(m, t, true);
    addForks(m, t);
    tm.alpha = 1;
  }
  const bare = mode === 'pov' && bareForksEnabled();
  if (!bare) addForklift(om, g, mode === 'ov');
  addForks(om, g, bare);
  addMarks(tm, g, mode);
  addBlobShadows(tm, g);
  addRevLight(tm, g);
  const sparkLights = addParticles(om, tm, g, eye);
  const disco = discoOn();
  if (disco && mode === 'pov') addDisco(om, g, eye);
  const lights = theme().dark ? darkLights(g, eye) : [];
  lights.push(...sparkLights.slice(0, Math.max(0, LIGHT_MAX - lights.length)));
  if (disco) lights.push(...discoLights(g, eye).slice(0, LIGHT_MAX - lights.length));
  return { opaque: om, trans: tm, lights };
}
