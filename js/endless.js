import { rectPoly, sat } from './geom.js';
import { FL, toWorld } from './forklift.js';
import { gameFromLayout, wonkyStack, solidPolys, zoneDone, zonePoints } from './game.js';

// Endless mode: single boxes ride a conveyor belt along the north wall; the player moves them onto the delivery truck of their
// colour (one bay per colour). A full truck (4 slots x 4 boxes) closes its gate once no forklift is inside, drives off with its
// load and is replaced by a new one. Boxes that reach the end of the belt are missed; too many ends the game.
export const ENDLESS_W = 26;
export const ENDLESS_COLORS = 4;
export const MAX_MISSED = 10;
const BELT = { x0: 0.2, y0: 0.5, x1: ENDLESS_W - 1.2, y1: 2.5 };
const ROAD = 2.8; // depth of the truck road between the belt and the laser fence
const BELT_SPEED = 0.4; // tiles/s
const SPAWN_X = 1.0;
const SLOT = 1.5; // spacing of the delivery truck's stack slots (2 wide, 3 deep)
const TRUCK_W = 3.6, TRUCK_D = 6, WALL = 0.3;
const APRON = 0.9; // empty strip inside the gate before the first stack slots
const RAMP_D = 0.9, CAB_D = 2;
const WH_H = 14; // the warehouse floor ends here: the south wall runs along y = WH_H, with an opening for each truck
export const ENDLESS_H = WH_H + TRUCK_D + CAB_D; // the trucks stand in the yard south of the wall, cab last
const BAY_Y = WH_H; // the trailer's north edge, its gate in line with the south wall
const SLOTS = 6;
const FIRST_X = 4.0, BAY_STEP = 4.8;
const GONE = 200; // a truck that is away is parked this far off the map
const OUT_DIST = 9;
const GATE_DELAY = 1; // s between the gate closing and the truck driving off
const AWAY_TIME = 2; // s before the replacement truck arrives
const STACK_BOXES = 4;

// Average gap between spawns; each gap is randomised (x0.4..x1.6) so the boxes arrive irregularly.
export const interval = (elapsed) => Math.max(4, 8 - elapsed / 80);

function bayRects(x0, off) {
  const y = BAY_Y + off;
  return {
    gate: [x0, y, TRUCK_W, WALL],
    left: [x0, y + WALL, WALL, TRUCK_D - WALL],
    right: [x0 + TRUCK_W - WALL, y + WALL, WALL, TRUCK_D - WALL],
    back: [x0 + WALL, y + TRUCK_D - WALL, TRUCK_W - 2 * WALL, WALL],
    cab: [x0 + WALL, y + TRUCK_D, TRUCK_W - 2 * WALL, CAB_D],
    area: [x0 + WALL, y + WALL, TRUCK_W - 2 * WALL, TRUCK_D - 2 * WALL],
  };
}
const slotAt = (x0, i, off) => ({ x: x0 + WALL + SLOT / 2 + (i % 2) * SLOT, y: BAY_Y + WALL + APRON + SLOT / 2 + Math.floor(i / 2) * SLOT + off });

function setRect(w, [x, y, ww, hh]) {
  Object.assign(w, { x, y, w: ww, h: hh, poly: rectPoly(x + ww / 2, y + hh / 2, ww / 2, hh / 2) });
}

// The warehouse's south wall: solid between the truck openings.
function southWall() {
  const out = [];
  let x = 0;
  for (let k = 0; k < ENDLESS_COLORS; k++) {
    const x0 = FIRST_X + k * BAY_STEP;
    out.push({ x, y: WH_H, w: x0 - x, h: WALL });
    x = x0 + TRUCK_W;
  }
  out.push({ x, y: WH_H, w: ENDLESS_W - x, h: WALL });
  return out;
}

// Asphalt yard south of the warehouse where the trucks stand.
export const yardRect = () => ({ x: 0, y: WH_H + WALL, w: ENDLESS_W, h: ENDLESS_H - WH_H - WALL });

export function newEndless(seed = 0, hard = false) {
  const bays = [], zones = [], areas = [];
  for (let k = 0; k < ENDLESS_COLORS; k++) {
    const x0 = FIRST_X + k * BAY_STEP;
    const r = bayRects(x0, 0);
    areas.push({ color: k, x: r.area[0], y: r.area[1], w: r.area[2], h: r.area[3] });
    const bz = [];
    for (let i = 0; i < SLOTS; i++) { const z = { ...slotAt(x0, i, 0), color: k, count: STACK_BOXES, bay: k }; zones.push(z); bz.push(z); }
    bays.push({ k, x0, off: 0, placed: 0, state: 'open', t: 0, v: 0, gateClosed: false, cargo: [], zones: bz, area: areas[k], parts: {} });
  }
  const layout = {
    w: ENDLESS_W, h: ENDLESS_H, walls: southWall(), charger: null, zones, areas, bays: [], doors: [], stacks: [],
    start: { x: ENDLESS_W / 2, y: 7, a: -Math.PI / 2 },
  };
  const g = gameFromLayout(layout, 0, seed, hard);
  g.endless = { rs: (seed ^ 0x9e3779b9) >>> 0, elapsed: 0, spawnT: 2, spawned: 0, missed: 0, broken: false, delivered: 0, boxes: 0, points: 0, over: false, bays };
  g.belt = { ...BELT, speed: BELT_SPEED, beamY: BELT.y1 + ROAD };
  g.layoutVersion = 0;
  // the belt top is at z-level 1: trucks can't drive onto it, but tines at level 1+ reach the boxes on it
  const lw = {}; setRect(lw, [BELT.x0, BELT.y0, BELT.x1 - BELT.x0, BELT.y1 - BELT.y0]);
  g.lowWalls = [lw];
  for (const b of bays) {
    const r = bayRects(b.x0, 0);
    // each wall is one object shared by `walls` (collision) and `pillars` (drawing), so moving it updates both
    for (const n of ['left', 'right', 'back', 'cab']) { const w = { truck: { color: b.k, part: n } }; setRect(w, r[n]); b.parts[n] = w; g.walls.push(w); g.pillars.push(w); }
    b.parts.gate = { truck: { color: b.k, part: 'gate' } }; // only part of the walls while the gate is closed
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

const interior = (b, m = 0) => ({ x0: b.x0 + WALL - m, x1: b.x0 + TRUCK_W - WALL + m, y0: BAY_Y + WALL - m + b.off, y1: BAY_Y + TRUCK_D - WALL + m + b.off });
const inBox = (s, r) => s.x > r.x0 && s.x < r.x1 && s.y > r.y0 && s.y < r.y1;
const footprint = (b, m) => { const r = { x0: b.x0 - m, x1: b.x0 + TRUCK_W + m, y0: BAY_Y - m, y1: ENDLESS_H }; return rectPoly((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, (r.x1 - r.x0) / 2, (r.y1 - r.y0) / 2); };
const clearOfTrucks = (g, b, m) => { const f = footprint(b, m); return !g.trucks.some((t) => !t.gone && solidPolys(t).some((p) => sat(p, f))); };

function place(g, b) {
  const off = b.state === 'away' ? GONE : b.off;
  const d = off - b.placed;
  const r = bayRects(b.x0, off);
  for (const n of ['left', 'right', 'back', 'cab']) setRect(b.parts[n], r[n]);
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
      const r = { x0: b.x0 - 0.5, x1: b.x0 + TRUCK_W + 0.5, y0: BAY_Y - 0.5, y1: ENDLESS_H };
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
  const B = g.belt;
  // The laser fence: any truck part (body, carried boxes, tine tips) across the beam pauses the belt and the arrivals.
  const broken = g.trucks.some((t) => !t.gone && (solidPolys(t).some((p) => p.some((v) => v.y < B.beamY))
    || [-FL.tineOff, FL.tineOff].some((o) => toWorld(t.fl, FL.tineX1, o).y < B.beamY)));
  if (broken !== e.broken) { e.broken = broken; g.layoutVersion++; }
  if (!broken) e.elapsed += dt;
  for (const s of broken ? [] : [...g.stacks]) {
    if (s.dropFrom != null || s.y < B.y0 || s.y > B.y1 || s.x < B.x0 || s.x > B.x1 + 1) continue;
    s.x += B.speed * dt;
    if (s.x > B.x1) { e.missed += s.layers.length; g.stacks.splice(g.stacks.indexOf(s), 1); }
  }
  if (!broken) e.spawnT -= dt;
  if (e.spawnT <= 0 && !broken) {
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

// Floor art of the belt as [{pts, fill, z}] polygons (z: the level the polygon lies at, 1 on top of the belt), drawn in order: rollers between hazard-striped rails, chevrons along the
// direction of travel, alternating diagonal yellow and black stripes marking the grabbing zone along its south side, the red pit at the end, and the laser fence (posts plus a beam)
// along the fenced lane's south edge. The beam is
// bright while intact and dark while broken.
// Visual extras of a delivery truck (all follow the bay as it drives): plank floor, loading ramp (only while the gate is open)
// (the cab is a solid wall part, `parts.cab`).
export function truckGeom(b) {
  const gt = b.parts.gate, a = b.area;
  return {
    floor: { x: a.x, y: a.y, w: a.w, h: a.h },
    ramp: b.gateClosed ? null : { x: gt.x + 0.4, y: gt.y - RAMP_D, w: gt.w - 0.8, h: RAMP_D },
  };
}

// Flat floor art for the truck floor: wooden planks along the truck, as [{ pts, fill }].
export function truckFloorArt(r) {
  const out = [{ pts: [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]], fill: '#8a6a43' }];
  const n = Math.round(r.w / 0.5);
  for (let i = 1; i < n; i++) { const x = r.x + (i * r.w) / n; out.push({ pts: [[x - 0.015, r.y], [x + 0.015, r.y], [x + 0.015, r.y + r.h], [x - 0.015, r.y + r.h]], fill: '#5e4527' }); }
  return out;
}

export function beltArt(b, broken = false) {
  const out = [];
  let z = 1; // the belt's top is one level up; the south face, grabbing-zone stripes, pit and fence stand on the floor
  const rect = (x, y, w, h, fill) => out.push({ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], fill, z });
  const cy = (b.y0 + b.y1) / 2, h = (b.y1 - b.y0) / 2;
  rect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, '#3b3f45');
  for (let x = b.x0 + 0.25; x < b.x1; x += 0.5) rect(x, b.y0 + 0.2, 0.07, b.y1 - b.y0 - 0.4, '#2a2d32');
  for (let x = b.x0, i = 0; x < b.x1 - 1e-6; x += 0.4, i++) {
    const w = Math.min(0.4, b.x1 - x), fill = i % 2 ? '#1a1a1a' : '#f4c414';
    rect(x, b.y0, w, 0.2, fill);
    rect(x, b.y1 - 0.2, w, 0.2, fill);
  }
  for (let x = b.x0 + 1.2; x < b.x1 - 1; x += 1.6) {
    out.push({ pts: [[x, cy - h * 0.5], [x + 0.45, cy], [x, cy + h * 0.5], [x - 0.22, cy + h * 0.5], [x + 0.23, cy], [x - 0.22, cy - h * 0.5]], fill: '#8d949b', z });
  }
  z = 0;
  // alternating diagonal yellow and black stripes fill the lane between the belt and the laser fence: the grabbing zone
  const y0 = b.y1, bh = b.beamY - b.y1, sh = 1, sw = 0.4;
  rect(b.x0, y0, b.x1 - b.x0, bh, '#1a1a1a');
  for (let x = b.x0; x < b.x1 - sh - sw; x += 2 * sw) out.push({ pts: [[x, y0 + bh], [x + sw, y0 + bh], [x + sw + sh, y0], [x + sh, y0]], fill: '#f4c414', z });
  rect(b.x1, b.y0, ENDLESS_W - b.x1, b.y1 - b.y0, '#c62828');
  for (let y = b.y0; y < b.y1 - 1e-6; y += 0.4) rect(b.x1, y, 0.2, 0.2, '#1a1a1a');
  rect(b.x0, b.beamY - 0.025, b.x1 - b.x0, 0.05, broken ? '#4a1a1a' : '#ff1744');
  const posts = [b.x0, b.x1 - 0.3];
  for (let x = b.x0 + 6; x < b.x1 - 3; x += 6) posts.push(x);
  for (const x of posts) { rect(x, b.beamY - 0.15, 0.3, 0.3, '#222'); rect(x + 0.08, b.beamY - 0.07, 0.14, 0.14, broken ? '#ffb300' : '#ff1744'); }
  return out;
}
