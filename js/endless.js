import { rectPoly, sat } from './geom.js';
import { gameFromLayout, wonkyStack, solidPolys, zoneDone, zonePoints } from './game.js';

// Endless mode: single boxes ride a conveyor belt along the north wall; the player moves them onto the delivery truck of their
// colour (one bay per colour). A full truck (4 slots x 4 boxes) closes its gate once no forklift is inside, drives off with its
// load and is replaced by a new one. Boxes that reach the end of the belt are missed; too many ends the game.
export const ENDLESS_W = 26;
export const ENDLESS_H = 14;
export const ENDLESS_COLORS = 4;
export const MAX_MISSED = 10;
const BELT = { x0: 0.2, y0: 0.5, x1: ENDLESS_W - 1.2, y1: 2.5 };
const BELT_SPEED = 0.8; // tiles/s
const SPAWN_X = 1.0;
const SLOT = 2; // spacing of the delivery truck's four stack slots
const TRUCK_W = 4.6, TRUCK_D = 4.6, WALL = 0.3;
const FIRST_X = 2.3, BAY_STEP = 5.6;
const GONE = 200; // a truck that is away is parked this far off the map
const OUT_DIST = 9;
const GATE_DELAY = 1; // s between the gate closing and the truck driving off
const AWAY_TIME = 2; // s before the replacement truck arrives
const STACK_BOXES = 4;

// Average gap between spawns; each gap is randomised (x0.4..x1.6) so the boxes arrive irregularly.
export const interval = (elapsed) => Math.max(4, 8 - elapsed / 80);

function bayRects(x0, off) {
  const y = ENDLESS_H - TRUCK_D + off;
  return {
    gate: [x0, y, TRUCK_W, WALL],
    left: [x0, y + WALL, WALL, TRUCK_D - WALL],
    right: [x0 + TRUCK_W - WALL, y + WALL, WALL, TRUCK_D - WALL],
    back: [x0 + WALL, y + TRUCK_D - WALL, TRUCK_W - 2 * WALL, WALL],
    area: [x0 + WALL, y + WALL, TRUCK_W - 2 * WALL, TRUCK_D - 2 * WALL],
  };
}
const slotAt = (x0, i, off) => ({ x: x0 + WALL + SLOT / 2 + (i % 2) * SLOT, y: ENDLESS_H - TRUCK_D + WALL + SLOT / 2 + Math.floor(i / 2) * SLOT + off });

function setRect(w, [x, y, ww, hh]) {
  Object.assign(w, { x, y, w: ww, h: hh, poly: rectPoly(x + ww / 2, y + hh / 2, ww / 2, hh / 2) });
}

export function newEndless(seed = 0, hard = false) {
  const bays = [], zones = [], areas = [];
  for (let k = 0; k < ENDLESS_COLORS; k++) {
    const x0 = FIRST_X + k * BAY_STEP;
    const r = bayRects(x0, 0);
    areas.push({ color: k, x: r.area[0], y: r.area[1], w: r.area[2], h: r.area[3] });
    const bz = [];
    for (let i = 0; i < 4; i++) { const z = { ...slotAt(x0, i, 0), color: k, count: STACK_BOXES, bay: k }; zones.push(z); bz.push(z); }
    bays.push({ k, x0, off: 0, placed: 0, state: 'open', t: 0, v: 0, gateClosed: false, cargo: [], zones: bz, area: areas[k], parts: {} });
  }
  const layout = {
    w: ENDLESS_W, h: ENDLESS_H, walls: [], charger: null, zones, areas, bays: [], doors: [], stacks: [],
    start: { x: ENDLESS_W / 2, y: 6, a: -Math.PI / 2 },
  };
  const g = gameFromLayout(layout, 0, seed, hard);
  g.endless = { rs: (seed ^ 0x9e3779b9) >>> 0, elapsed: 0, spawnT: 2, spawned: 0, missed: 0, delivered: 0, boxes: 0, points: 0, over: false, bays };
  g.belt = { ...BELT, speed: BELT_SPEED };
  g.layoutVersion = 0;
  for (const b of bays) {
    const r = bayRects(b.x0, 0);
    // each wall is one object shared by `walls` (collision) and `pillars` (drawing), so moving it updates both
    for (const n of ['left', 'right', 'back']) { const w = {}; setRect(w, r[n]); b.parts[n] = w; g.walls.push(w); g.pillars.push(w); }
    b.parts.gate = {}; // only part of the walls while the gate is closed
    setRect(b.parts.gate, r.gate);
  }
  return g;
}

function rnd(e) {
  e.rs = (e.rs + 0x6d2b79f5) >>> 0;
  let t = e.rs;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const interior = (b, m = 0) => ({ x0: b.x0 + WALL - m, x1: b.x0 + TRUCK_W - WALL + m, y0: ENDLESS_H - TRUCK_D + WALL - m + b.off, y1: ENDLESS_H + b.off });
const inBox = (s, r) => s.x > r.x0 && s.x < r.x1 && s.y > r.y0 && s.y < r.y1;
const footprint = (b, m) => { const r = { x0: b.x0 - m, x1: b.x0 + TRUCK_W + m, y0: ENDLESS_H - TRUCK_D - m, y1: ENDLESS_H }; return rectPoly((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, (r.x1 - r.x0) / 2, (r.y1 - r.y0) / 2); };
const clearOfTrucks = (g, b, m) => { const f = footprint(b, m); return !g.trucks.some((t) => !t.gone && solidPolys(t).some((p) => sat(p, f))); };

function place(g, b) {
  const off = b.state === 'away' ? GONE : b.off;
  const d = off - b.placed;
  const r = bayRects(b.x0, off);
  for (const n of ['left', 'right', 'back']) setRect(b.parts[n], r[n]);
  setRect(b.parts.gate, r.gate);
  Object.assign(b.area, { x: r.area[0], y: r.area[1] });
  b.zones.forEach((z, i) => Object.assign(z, slotAt(b.x0, i, off)));
  for (const s of b.cargo) s.y += d;
  const has = g.walls.includes(b.parts.gate);
  if (b.gateClosed && !has) { g.walls.push(b.parts.gate); g.pillars.push(b.parts.gate); }
  if (!b.gateClosed && has) { g.walls.splice(g.walls.indexOf(b.parts.gate), 1); g.pillars.splice(g.pillars.indexOf(b.parts.gate), 1); }
  if (d !== 0 || has !== b.gateClosed) g.layoutVersion++;
  b.placed = off;
}

function stepBay(g, b, dt) {
  const e = g.endless;
  if (b.state === 'open') {
    if (b.zones.every((z) => zoneDone(g, z)) && clearOfTrucks(g, b, 0.4)) {
      b.state = 'closing'; b.t = 0; b.gateClosed = true;
      const r = interior(b, 0.2);
      b.cargo = g.stacks.filter((s) => inBox(s, r));
      for (const s of b.cargo) s.leaving = true;
    }
  } else if (b.state === 'closing') {
    b.t += dt;
    if (b.t >= GATE_DELAY) { b.state = 'leaving'; b.v = 0; }
  } else if (b.state === 'leaving') {
    b.v = Math.min(5, b.v + 2.5 * dt);
    b.off += b.v * dt;
    if (b.off >= OUT_DIST) {
      let pts = 0;
      for (const z of b.zones) { const p = zonePoints(g, z); if (p) { pts += p.total; e.boxes += p.n; } }
      e.points += pts;
      e.delivered++;
      g.stacks = g.stacks.filter((s) => !b.cargo.includes(s));
      b.cargo = [];
      const idx = g.zones.map((z, i) => (b.zones.includes(z) ? i : -1)).filter((i) => i >= 0);
      if (g.zonePts) for (const i of idx) g.zonePts[i] = null;
      g.hits = g.hits.filter((h) => !idx.includes(h.zone));
      b.state = 'away'; b.t = 0;
    }
  } else if (b.state === 'away') {
    b.t += dt;
    if (b.t >= AWAY_TIME && clearOfTrucks(g, b, 0.6)) {
      const r = { x0: b.x0 - 0.5, x1: b.x0 + TRUCK_W + 0.5, y0: ENDLESS_H - TRUCK_D - 0.5, y1: ENDLESS_H };
      g.stacks = g.stacks.filter((s) => !inBox(s, r));
      b.state = 'arriving'; b.off = OUT_DIST; // the new truck rolls in from below the map
    }
  } else if (b.state === 'arriving') {
    b.off = Math.max(0, b.off - Math.max(0.8, b.off * 0.7) * dt);
    if (b.off <= 0) { b.gateClosed = false; b.state = 'open'; }
  }
  place(g, b);
}

// Advances the endless mode one step; call after `update`.
export function stepEndless(g, dt) {
  const e = g.endless;
  if (!e || e.over) return;
  e.elapsed += dt;
  const B = g.belt;
  for (const s of [...g.stacks]) {
    if (s.dropFrom != null || s.y < B.y0 || s.y > B.y1 || s.x < B.x0 || s.x > B.x1 + 1) continue;
    s.x += B.speed * dt;
    if (s.x > B.x1) { e.missed += s.layers.length; g.stacks.splice(g.stacks.indexOf(s), 1); }
  }
  e.spawnT -= dt;
  if (e.spawnT <= 0) {
    const y = (B.y0 + B.y1) / 2 + (rnd(e) - 0.5) * 0.3;
    if (g.stacks.some((s) => Math.hypot(s.x - SPAWN_X, s.y - y) < 1.2)) e.spawnT = 0.2;
    else {
      const n = rnd(e) < 0.15 ? 3 : rnd(e) < 0.3 ? 2 : 1; // now and then a ready-made stack of one colour
      const col = Math.floor(rnd(e) * ENDLESS_COLORS);
      g.stacks.push(wonkyStack({ x: SPAWN_X, y, layers: Array(n).fill(col) }));
      e.spawned++;
      e.spawnT = interval(e.elapsed) * (0.4 + 1.2 * rnd(e));
    }
  }
  for (const b of e.bays) stepBay(g, b, dt);
  if (e.missed >= MAX_MISSED) { e.over = true; g.status = 'over'; }
}

// Floor art of the belt: the belt rectangle, the red pit at its end where missed boxes fall, and chevrons pointing along it.
export function beltArt(b) {
  const cy = (b.y0 + b.y1) / 2, h = (b.y1 - b.y0) / 2;
  const chevrons = [];
  for (let x = b.x0 + 1; x < b.x1 - 0.6; x += 1.6) chevrons.push([[x, cy - h * 0.55], [x + 0.5, cy], [x, cy + h * 0.55], [x - 0.25, cy + h * 0.55], [x + 0.25, cy], [x - 0.25, cy - h * 0.55]]);
  return { rect: [b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0], pit: [b.x1, b.y0, ENDLESS_W - b.x1, b.y1 - b.y0], chevrons };
}
