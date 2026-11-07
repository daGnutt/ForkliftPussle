import { COLORS } from '../level.js';
import { theme } from '../theme.js';
import { FL, toWorld } from '../forklift.js';
import { decalsEnabled, floorDecals, overheadDecals } from '../decals.js';
import { discoOn, discoBalls, discoSources, discoSpots, SPOT_R, BALL_R, BALL_DROP } from '../disco.js';
import { reverseLight } from '../revlight.js';
import { zoneDone, zoneLabelPos, isSolved, scoreEnough, isParked } from '../game.js';
import { paintWallDecals, chargerDecal } from '../pov/face.js';
import { Mesh, parseColor, mix, shade, hsl } from './mesh.js';
import { WALL_H, addStack, addForklift, addForks, addCarried } from './models.js';

// Builds the meshes for the WebGL renderer. `mode` is 'pov' (cabin: ceiling, signs, full-height walls) or 'ov'
// (top-down overview: low walls so the playing field stays readable). Static meshes depend only on the level and theme;
// dynamic ones (stacks, forklift, markings) are rebuilt every frame.

export const OV_WALL_H = 1.1;
export const CHARGER_H = 0.9;
const GREY = [0.43, 0.45, 0.48, 1], WHITE = [1, 1, 1, 1];
const YEL = '#f4c414', RED = '#c62828', BLACK = '#1a1a1a';

const circlePts = (u, v, r, n = 18) => Array.from({ length: n }, (_, i) => [u + Math.cos((i / n) * Math.PI * 2) * r, v + Math.sin((i / n) * Math.PI * 2) * r]);

// One wall rectangle: sides in 1-tile segments with a checker tint, plus decals in cabin mode.
function addWall(sm, tm, g, w, mode) {
  const top = mode === 'pov' ? WALL_H : OV_WALL_H;
  const cx = w.x + w.w / 2, cy = w.y + w.h / 2;
  if (w.charger) {
    sm.cuboid(cx, cy, 0, w.w / 2, w.h / 2, 0, CHARGER_H, '#c62828', { bottom: false });
    addChargerSigns(tm, w);
    return;
  }
  const t = theme();
  const wallC = mode === 'pov' ? null : mix(parseColor(t.wall), GREY, 0.3);
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
      const col = wallC || parseColor(tile & 1 ? '#5d646e' : '#555b64');
      sm.quad([q0[0], q0[1], 0], [q1[0], q1[1], 0], [q1[0], q1[1], top], [q0[0], q0[1], top], [nx, ny, 0], col);
      if (mode !== 'pov') continue;
      sm.quad([q0[0], q0[1], WALL_H - 0.14], [q1[0], q1[1], WALL_H - 0.14], [q1[0], q1[1], WALL_H], [q0[0], q0[1], WALL_H], [nx, ny, 0], shade(col, 0.7));
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
  sm.quad([w.x, w.y, top], [w.x + w.w, w.y, top], [w.x + w.w, w.y + w.h, top], [w.x, w.y + w.h, top], [0, 0, 1], wallC ? shade(wallC, 1.15) : parseColor('#6d737a'));
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

// Doorway trim: hazard-striped jamb posts and a header beam (cabin view only; purely visual).
function addDoorways(sm, g) {
  if (!decalsEnabled()) return;
  for (const d of g.doors || []) {
    const cx = d.x + d.w / 2, cy = d.y + d.h / 2, vert = d.h > d.w, len = vert ? d.h : d.w, th = vert ? d.w : d.h;
    const place = (u, v) => (vert ? [cx + v, cy + u] : [cx + u, cy + v]);
    for (const su of [-1, 1]) {
      for (const sv of [-1, 1]) {
        const [x, y] = place(su * (len / 2 - 0.07), sv * (th / 2 - 0.07));
        for (let i = 0; i < 4; i++) sm.cuboid(x, y, 0, 0.07, 0.07, i * 0.5, i * 0.5 + 0.5, i & 1 ? '#262626' : '#f4c414');
      }
    }
    const n = Math.floor(len / 0.6);
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
  for (const a of g.areas) {
    const c = parseColor(COLORS[a.color]);
    tm.poly([[a.x - 0.3, a.y - 0.3], [a.x + a.w + 0.3, a.y - 0.3], [a.x + a.w + 0.3, a.y + a.h + 0.3], [a.x - 0.3, a.y + a.h + 0.3]], 0, [c[0], c[1], c[2], 0.12]);
  }
}

const cache = new WeakMap();

// { opaque, trans } meshes that only change with the level, theme and decal switch.
export function staticMeshes(g, mode) {
  const key = [theme(), decalsEnabled(), mode];
  let e = cache.get(g);
  if (!e) cache.set(g, (e = {}));
  const hit = e[mode];
  if (hit && hit.key.every((k, i) => k === key[i])) return hit;
  const sm = new Mesh(), tm = new Mesh();
  addFloor(sm, tm, g, mode);
  for (const w of g.walls) addWall(sm, tm, g, w, mode);
  if (mode === 'pov') {
    addCeiling(sm, g);
    addDoorways(sm, g);
  }
  return (e[mode] = { key, opaque: sm, trans: tm });
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
  const L = reverseLight(g);
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
    addStack(om, tm, st.x, st.y, st.rots || [], st.layers, 0, st.offs, st.dropFrom ?? 0,
      st.dropFrom != null ? Math.max(0, g.hf - st.dropFrom) : 0, st.pen);
  }
  addCarried(om, tm, g);
  addForklift(om, g, mode === 'ov');
  addForks(om, g);
  addMarks(tm, g, mode);
  addBlobShadows(tm, g);
  addRevLight(tm, g);
  const disco = discoOn();
  if (disco && mode === 'pov') addDisco(om, g, eye);
  return { opaque: om, trans: tm, lights: disco ? discoLights(g, eye) : [] };
}
