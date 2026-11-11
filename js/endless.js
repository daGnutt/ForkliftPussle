import { rectPoly, sat } from './geom.js';
import { FL, toWorld } from './forklift.js';
import { COLORS } from './level.js';
import { gameFromLayout, liveTrucks, wonkyStack, solidPolys, zoneDone, zonePoints } from './game.js';

// Endless mode: incoming trucks park in bays along the west wall, each carrying 2x3 stacks of random height and colour. The player
// carries them to the delivery truck of their colour south of the warehouse (one bay per colour). A full delivery truck (6 stacks
// of 4 boxes) closes its gate once no forklift is inside, drives off with its load and is replaced. An incoming truck that is
// unloaded closes its gate and drives off; when a new one is due and every bay is still occupied, the game is over.
export const ENDLESS_COLORS = 5;
export const DOCKS = 5;
export const DOCK_COLOR = ENDLESS_COLORS; // beyond the box colours: the incoming trucks are grey
export const truckPaint = (c) => COLORS[c] ?? '#78909c';
const SLOT = 1.5; // spacing of the delivery truck's stack slots (2 wide, 3 deep)
const TRUCK_W = 3.6, TRUCK_D = 6, WALL = 0.3;
const APRON = 0.9; // empty strip inside the gate before the first stack slots
const RAMP_D = 0.9, CAB_D = 2;
const WH_W = 28, WH_H = 24; // the warehouse floor; its south wall runs along y = WH_H, with an opening for each truck
const WX = TRUCK_D + CAB_D + WALL; // the warehouse floor starts here: the west wall (the incoming trucks' gates) is just before it
export const ENDLESS_W = WX + WH_W;
export const ENDLESS_H = WH_H + TRUCK_D + CAB_D; // the trucks stand in the yard south of the wall, cab last
const BAY_Y = WH_H; // the trailer's north edge, its gate in line with the south wall
const SLOTS = 6;
const FIRST_X = WX + 2.0, BAY_STEP = 4.8;
const DOCK_Y0 = 0.6, DOCK_STEP = 4.8;
const GONE = 200; // a truck that is away is parked this far off the map
const OUT_DIST = 9;
const GATE_DELAY = 1; // s between the gate closing and the truck driving off
const AWAY_TIME = 2; // s before the replacement truck arrives
const STACK_BOXES = 4;
const DOCK_ARRIVE_T = 1; // s until the first incoming truck

// Adaptive pace: the unloading rate (boxes/s while there is work) is measured as an exponentially decayed average over about
// RATE_TAU s of busy time, starting from a prior per player. The next truck is due after the time that rate needs to unload it,
// plus a small margin, so the pace follows the crew: slacking or accidents lower the rate (and give a little more time), but the
// queue grows meanwhile and the bays fill.
const RATE_PRIOR = 0.15; // boxes/s per player before anything was measured
const RATE_PRIOR_T = 60; // s of busy time the prior is worth
const RATE_TAU = 150;
const PACE_MARGIN = 1.15;
export const MIN_GAP = 20, MAX_GAP = 150;
export const unloadRate = (e) => e.wBoxes / e.wBusy;
export const interval = (e, boxes) => Math.min(MAX_GAP, Math.max(MIN_GAP, (boxes / unloadRate(e)) * PACE_MARGIN));

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

// An incoming truck stands west of the warehouse with its rear (the gate, in the west wall) facing east; `off` slides it west.
const XR = WX - WALL; // the trailer's east edge
const dockY = (k) => DOCK_Y0 + (DOCKS - 1 - k) * DOCK_STEP; // dock 0 is the southernmost
function dockRects(y0, off) {
  const x = XR - TRUCK_D - off;
  return {
    sideN: [x, y0, TRUCK_D, WALL],
    sideS: [x, y0 + TRUCK_W - WALL, TRUCK_D, WALL],
    back: [x, y0 + WALL, WALL, TRUCK_W - 2 * WALL],
    cab: [x - CAB_D, y0 + WALL, CAB_D, TRUCK_W - 2 * WALL],
    area: [x + WALL, y0 + WALL, TRUCK_D - WALL, TRUCK_W - 2 * WALL],
  };
}
const dockSlot = (y0, i, off) => ({ x: XR - APRON - SLOT / 2 - Math.floor(i / 2) * SLOT - off, y: y0 + WALL + SLOT / 2 + (i % 2) * SLOT });

function setRect(w, [x, y, ww, hh]) {
  Object.assign(w, { x, y, w: ww, h: hh, poly: rectPoly(x + ww / 2, y + hh / 2, ww / 2, hh / 2) });
}

// The warehouse's south wall (solid between the truck openings) and west wall (closed by the gates of the incoming trucks).
function outerWalls() {
  const out = [];
  let x = XR;
  for (let k = 0; k < ENDLESS_COLORS; k++) {
    const x0 = FIRST_X + k * BAY_STEP;
    out.push({ x, y: WH_H, w: x0 - x, h: WALL });
    x = x0 + TRUCK_W;
  }
  out.push({ x, y: WH_H, w: ENDLESS_W - x, h: WALL });
  let y = 0;
  for (let k = DOCKS - 1; k >= 0; k--) {
    out.push({ x: XR, y, w: WALL, h: dockY(k) - y });
    y = dockY(k) + TRUCK_W;
  }
  out.push({ x: XR, y, w: WALL, h: WH_H - y });
  return out.filter((r) => r.w > 1e-6 && r.h > 1e-6);
}

// Asphalt where the trucks stand: the yard west of the warehouse and the one south of it.
export const yardRects = () => [{ x: 0, y: 0, w: XR, h: ENDLESS_H }, { x: XR, y: WH_H + WALL, w: ENDLESS_W - XR, h: ENDLESS_H - WH_H - WALL }];
// Every truck bay: the six delivery trucks' and the incoming ones'.
export const truckBays = (g) => (g.endless ? [...g.endless.bays, ...g.endless.docks] : []);

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
  const docks = [];
  for (let k = 0; k < DOCKS; k++) {
    const y0 = dockY(k), r = dockRects(y0, GONE);
    docks.push({ k, y0, dock: true, off: GONE, placed: GONE, state: 'free', t: 0, v: 0, gateClosed: true, area: { x: r.area[0], y: r.area[1], w: r.area[2], h: r.area[3] }, parts: {} });
  }
  const layout = {
    w: ENDLESS_W, h: ENDLESS_H, walls: outerWalls(), charger: null, zones, areas, bays: [], doors: [], stacks: [],
    start: { x: WX + WH_W / 2, y: WH_H / 2, a: -Math.PI / 2 },
  };
  const g = gameFromLayout(layout, 0, seed, hard);
  g.endless = { rs: (seed ^ 0x9e3779b9) >>> 0, elapsed: 0, arriveT: DOCK_ARRIVE_T, wBoxes: RATE_PRIOR * RATE_PRIOR_T, wBusy: RATE_PRIOR_T, waiting: 0, arrived: 0, unloaded: 0, delivered: 0, boxes: 0, points: 0, over: false, bays, docks };
  g.layoutVersion = 0;
  for (const b of bays) {
    const r = bayRects(b.x0, 0);
    // each wall is one object shared by `walls` (collision) and `pillars` (drawing), so moving it updates both
    for (const n of ['left', 'right', 'back', 'cab']) { const w = { truck: { color: b.k, part: n } }; setRect(w, r[n]); b.parts[n] = w; g.walls.push(w); g.pillars.push(w); }
    b.parts.gate = { truck: { color: b.k, part: 'gate' } }; // only part of the walls while the gate is closed
    setRect(b.parts.gate, r.gate);
  }
  for (const d of docks) {
    const r = dockRects(d.y0, GONE);
    for (const [n, part] of [['sideN', 'side'], ['sideS', 'side'], ['back', 'back'], ['cab', 'wcab']]) { const w = { truck: { color: DOCK_COLOR, part } }; setRect(w, r[n]); d.parts[n] = w; g.walls.push(w); g.pillars.push(w); }
    d.parts.gate = { truck: { color: DOCK_COLOR, part: 'gate' } }; // closed while no truck stands at the bay
    setRect(d.parts.gate, [XR, d.y0, WALL, TRUCK_W]);
    g.walls.push(d.parts.gate); g.pillars.push(d.parts.gate);
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

const dockInterior = (d) => ({ x0: XR - TRUCK_D + WALL, x1: XR + WALL, y0: d.y0 + WALL, y1: d.y0 + TRUCK_W - WALL });
const dockRect = (d, m) => { const r = { x0: XR - TRUCK_D - m, x1: XR + WALL + m, y0: d.y0 - m, y1: d.y0 + TRUCK_W + m }; return rectPoly((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, (r.x1 - r.x0) / 2, (r.y1 - r.y0) / 2); };

function placeDock(g, d) {
  const dx = d.off - d.placed;
  const r = dockRects(d.y0, d.off);
  for (const n of ['sideN', 'sideS', 'back', 'cab']) setRect(d.parts[n], r[n]);
  Object.assign(d.area, { x: r.area[0], y: r.area[1] });
  for (const s of d.cargo || []) s.x -= dx;
  const has = g.walls.includes(d.parts.gate);
  if (d.gateClosed && !has) { g.walls.push(d.parts.gate); g.pillars.push(d.parts.gate); }
  if (!d.gateClosed && has) { g.walls.splice(g.walls.indexOf(d.parts.gate), 1); g.pillars.splice(g.pillars.indexOf(d.parts.gate), 1); }
  if (dx !== 0 || has !== d.gateClosed) g.layoutVersion++;
  d.placed = d.off;
}

// An incoming truck's load: 2x3 stacks of random height; the more random the truck, the more often a stack mixes colours.
function loadDock(g, d) {
  const e = g.endless;
  const mess = Math.min(1, rnd(e) * 0.7 + e.elapsed / 600);
  d.cargo = [];
  for (let i = 0; i < 6; i++) {
    const n = 1 + Math.floor(rnd(e) * 3);
    const mixed = rnd(e) < mess, col = Math.floor(rnd(e) * ENDLESS_COLORS);
    const layers = Array.from({ length: n }, () => (mixed ? Math.floor(rnd(e) * ENDLESS_COLORS) : col));
    const s = wonkyStack({ ...dockSlot(d.y0, i, d.placed), layers });
    s.leaving = true; // rides in on the truck, through the border
    d.cargo.push(s);
    g.stacks.push(s);
  }
}

function stepDock(g, d, dt) {
  if (d.state === 'arriving') {
    d.off = Math.max(0, d.off - Math.max(0.8, d.off * 0.7) * dt);
    if (d.off <= 0) { d.gateClosed = false; d.state = 'present'; for (const s of d.cargo) delete s.leaving; }
  } else if (d.state === 'present') {
    const r = dockInterior(d), f = dockRect(d, 0.5);
    const empty = !g.stacks.some((s) => s.x > r.x0 && s.x < r.x1 && s.y > r.y0 && s.y < r.y1);
    if (empty && !g.trucks.some((t) => !t.gone && solidPolys(t).some((p) => sat(p, f)))) { d.state = 'leaving'; d.gateClosed = true; d.v = 0; d.cargo = []; }
  } else if (d.state === 'leaving') {
    d.v = Math.min(5, d.v + 2.5 * dt);
    d.off += d.v * dt;
    if (d.off >= OUT_DIST) { d.off = GONE; d.state = 'free'; g.endless.unloaded++; }
  }
  placeDock(g, d);
}

// Boxes standing in the trailers of the incoming trucks that have arrived.
function dockBoxes(g, docks) {
  let n = 0;
  for (const d of docks) {
    if (d.state !== 'present') continue;
    const r = dockInterior(d);
    for (const s of g.stacks) if (s.x > r.x0 && s.x < r.x1 && s.y > r.y0 && s.y < r.y1) n += s.layers.length;
  }
  return n;
}

// Boxes taken out of the trailers count as work done during the busy time (some trailer still holds boxes).
function measureRate(g, e, dt) {
  const now = dockBoxes(g, e.docks), prev = e.waiting;
  e.waiting = now;
  if (!now && !prev) return;
  const k = Math.exp(-dt / RATE_TAU);
  e.wBoxes = e.wBoxes * k + Math.max(0, prev - now);
  e.wBusy = e.wBusy * k + dt;
}

// Advances the endless mode one step; call after `update`.
export function stepEndless(g, dt) {
  const e = g.endless;
  if (!e || e.over) return;
  e.elapsed += dt;
  e.arriveT -= dt;
  if (e.arriveT <= 0) {
    const d = e.docks.find((o) => o.state === 'free');
    if (!d) { e.over = true; g.status = 'over'; return; }
    d.off = OUT_DIST; d.state = 'arriving'; loadDock(g, d);
    e.arrived++;
    if (e.arrived === 1) e.wBoxes = RATE_PRIOR * RATE_PRIOR_T * Math.max(1, liveTrucks(g).length); // the prior scales with the crew
    e.arriveT = interval(e, d.cargo.reduce((n, s) => n + s.layers.length, 0)) * (0.85 + 0.3 * rnd(e));
  }
  for (const d of e.docks) stepDock(g, d, dt);
  measureRate(g, e, dt);
  for (const b of e.bays) stepBay(g, b, dt);
}

// Visual extras of a truck (all follow the bay as it drives): plank floor, loading ramp (only while the gate is open)
// (the cab is a solid wall part, `parts.cab`).
export function truckGeom(b) {
  const gt = b.parts.gate, a = b.area;
  return {
    floor: { x: a.x, y: a.y, w: a.w, h: a.h, along: b.dock },
    ramp: b.gateClosed ? null : b.dock ? { x: gt.x + gt.w, y: gt.y + 0.4, w: RAMP_D, h: gt.h - 0.8, east: true } : { x: gt.x + 0.4, y: gt.y - RAMP_D, w: gt.w - 0.8, h: RAMP_D },
  };
}

// Flat floor art for the truck floor: wooden planks along the truck, as [{ pts, fill }].
export function truckFloorArt(r) {
  const out = [{ pts: [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]], fill: '#8a6a43' }];
  const n = Math.round(r.w / 0.5);
  for (let i = 1; i < n; i++) { const x = r.x + (i * r.w) / n; out.push({ pts: [[x - 0.015, r.y], [x + 0.015, r.y], [x + 0.015, r.y + r.h], [x - 0.015, r.y + r.h]], fill: '#5e4527' }); }
  if (r.along) return [out[0], ...Array.from({ length: Math.round(r.h / 0.5) - 1 }, (_, i) => { const y = r.y + ((i + 1) * r.h) / Math.round(r.h / 0.5); return { pts: [[r.x, y - 0.015], [r.x + r.w, y - 0.015], [r.x + r.w, y + 0.015], [r.x, y + 0.015]], fill: '#5e4527' }; })];
  return out;
}
