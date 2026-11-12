import { rectPoly, sat } from './geom.js';
import { FL, toWorld } from './forklift.js';
import { COLORS } from './level.js';
import { gameFromLayout, liveTrucks, wonkyStack, solidPolys, zoneDone, zonePoints } from './game.js';

// Endless mode: incoming trucks park in bays along the west wall, each carrying 2x3 stacks of random height and colour. The player
// carries them to the delivery truck of their colour south of the warehouse (one bay per colour). A full delivery truck (6 stacks
// of 4 boxes) closes its gate once no forklift is inside, drives off with its load and is replaced. An incoming truck that is
// unloaded closes its gate and drives off; when a new one is due and every bay is still occupied, the game is over.
export const ENDLESS_COLORS = 5;
export const ROWS = 3; // incoming-truck bays per side
export const DOCKS = 2 * ROWS; // west and east, alternating from the south
export const DOCK_COLOR = ENDLESS_COLORS; // beyond the box colours: the incoming trucks are grey
export const truckPaint = (c) => COLORS[c] ?? '#78909c';
export const BOGIE = [1.2, 2.1]; // trailer wheel pair: distances from the gate (rear) end, centred under the row of drop points nearest the gate
const SLOT = 1.5; // spacing of the delivery truck's stack slots (2 wide, 3 deep)
const TRUCK_W = 3.6, TRUCK_D = 6, WALL = 0.3;
const APRON = 0.9; // empty strip inside the gate before the first stack slots
const RAMP_D = 0.9, DOCK_RAMP_D = 1.8, CAB_D = 2;
const WH_W = 26, WH_H = 15; // the warehouse floor; its south wall runs along y = WH_H, with an opening for each truck
const WX = TRUCK_D + CAB_D + WALL; // the warehouse floor starts here: the west wall (the incoming trucks' gates) is just before it
export const ENDLESS_W = 2 * WX + WH_W;
export const ENDLESS_H = WH_H + TRUCK_D + CAB_D; // the trucks stand in the yard south of the wall, cab last
const BAY_Y = WH_H; // the trailer's north edge, its gate in line with the south wall
const SLOTS = 6;
const FIRST_X = WX + 1.0, BAY_STEP = 4.8;
const DOCK_Y0 = 0.8, DOCK_STEP = 4.8;
const GONE = 200; // a truck that is away is parked this far off the map
const OUT_DIST = 9;
const HONK_T = 0.7; // s of horn before a gate opens or closes
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
const XR = WX - WALL; // the west wall's left edge: the west trailers' east edge
const XE = WX + WH_W; // the east wall's left edge
// An incoming truck stands outside the west (side -1) or east (side 1) wall with its rear (the gate, in the wall) facing the warehouse.
// `inner` is the trailer's edge at the gate, `off` slides the truck away from the wall.
const dockInner = (side) => (side < 0 ? XR : XE + WALL);
const dockGateX = (side) => (side < 0 ? XR : XE);
const dockY = (row) => DOCK_Y0 + (ROWS - 1 - row) * DOCK_STEP; // row 0 is the southernmost
function dockRects(d, off) {
  const { y0, side } = d, x = side < 0 ? dockInner(side) - TRUCK_D - off : dockInner(side) + off; // the trailer's west edge
  return {
    sideN: [x, y0, TRUCK_D, WALL],
    sideS: [x, y0 + TRUCK_W - WALL, TRUCK_D, WALL],
    back: [side < 0 ? x : x + TRUCK_D - WALL, y0 + WALL, WALL, TRUCK_W - 2 * WALL],
    cab: [side < 0 ? x - CAB_D : x + TRUCK_D, y0 + WALL, CAB_D, TRUCK_W - 2 * WALL],
    rear: [side < 0 ? x + TRUCK_D - 0.05 : x, y0 + WALL, 0.05, TRUCK_W - 2 * WALL], // the trailer's own rear doors, shut while it is in transit
    area: [side < 0 ? x + WALL : x, y0 + WALL, TRUCK_D - WALL, TRUCK_W - 2 * WALL],
  };
}
const dockSlot = (d, i, off) => ({ x: dockInner(d.side) + d.side * (APRON + SLOT / 2 + Math.floor(i / 2) * SLOT + off), y: d.y0 + WALL + SLOT / 2 + (i % 2) * SLOT });

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
  out.push({ x, y: WH_H, w: XE + WALL - x, h: WALL });
  for (const wx of [XR, XE]) {
    let y = 0;
    for (let row = ROWS - 1; row >= 0; row--) {
      out.push({ x: wx, y, w: WALL, h: dockY(row) - y });
      y = dockY(row) + TRUCK_W;
    }
    out.push({ x: wx, y, w: WALL, h: WH_H - y });
  }
  return out.filter((r) => r.w > 1e-6 && r.h > 1e-6);
}

// Asphalt where the trucks stand: the yard west of the warehouse and the one south of it.
export const yardRects = () => [{ x: 0, y: 0, w: XR, h: ENDLESS_H }, { x: XE + WALL, y: 0, w: ENDLESS_W - XE - WALL, h: ENDLESS_H }, { x: XR, y: WH_H + WALL, w: XE + WALL - XR, h: ENDLESS_H - WH_H - WALL }];
export const TRUCK_H = 3.7; // trailer height, a bit under the 4 high factory ceiling

// Roofs of the trailers currently standing: [{ x0, y0, x1, y1, color, closed }] from the parts' positions; `closed` = gate shut.
export function truckRoofs(g) {
  const out = [];
  for (const b of truckBays(g)) {
    if (b.state === 'away') continue;
    const p = b.parts, a = p.left && p.right ? [p.left.x, p.left.y - p.gate.h, p.right.x + p.right.w, p.back.y + p.back.h] : p.sideN && [p.sideN.x, p.sideN.y, p.sideN.x + p.sideN.w, p.sideS.y + p.sideS.h];
    if (a) out.push({ x0: a[0], y0: a[1], x1: a[2], y1: a[3], color: p.gate.truck.color, closed: b.gateClosed });
  }
  return out;
}

// Every truck bay: the six delivery trucks' and the incoming ones'.
export const truckBays = (g) => (g.endless ? [...g.endless.bays, ...g.endless.docks.filter((d) => d.state !== 'free')] : []);

export function newEndless(seed = 0, hard = false) {
  const bays = [], zones = [], areas = [];
  for (let k = 0; k < ENDLESS_COLORS; k++) {
    const x0 = FIRST_X + k * BAY_STEP;
    const r = bayRects(x0, 0);
    areas.push({ color: k, x: r.area[0], y: r.area[1], w: r.area[2], h: r.area[3] });
    const bz = [];
    for (let i = 0; i < SLOTS; i++) { const z = { ...slotAt(x0, i, 0), color: k, count: STACK_BOXES, bay: k }; zones.push(z); bz.push(z); }
    bays.push({ k, x0, off: 0, placed: 0, state: 'open', honkT: -1e9, honkN: 0, honked: false, t: 0, v: 0, gateClosed: false, cargo: [], zones: bz, area: areas[k], parts: {} });
  }
  const docks = [];
  for (let k = 0; k < DOCKS; k++) {
    const side = k % 2 ? 1 : -1, y0 = dockY(Math.floor(k / 2));
    const r = dockRects({ y0, side }, GONE);
    docks.push({ k, y0, side, dock: true, off: GONE, placed: GONE, state: 'free', honkT: -1e9, honkN: 0, honked: false, since: -1, t: 0, v: 0, gateClosed: true, area: { x: r.area[0], y: r.area[1], w: r.area[2], h: r.area[3] }, parts: {} });
  }
  const layout = {
    w: ENDLESS_W, h: ENDLESS_H, walls: outerWalls(), charger: null, zones, areas, bays: [], doors: [], stacks: [],
    start: { x: WX + WH_W / 2, y: 2.2, a: Math.PI / 2 },
  };
  const g = gameFromLayout(layout, 0, seed, hard);
  g.walls[0].draw = { x: XR, y: -WALL, w: XE + WALL - XR, h: WALL }; // the north border wall is drawn as a thin strip over the warehouse only, not the yards beside it
  for (const w of g.walls.slice(1, 4)) w.hidden = true; // south, west and east border walls: still solid, not drawn, so trucks do not clip through them
  g.endless = { rs: (Math.random() * 4294967296) >>> 0, elapsed: 0, arriveT: DOCK_ARRIVE_T, wBoxes: RATE_PRIOR * RATE_PRIOR_T, wBusy: RATE_PRIOR_T, waiting: 0, arrived: 0, unloaded: 0, delivered: 0, boxes: 0, points: 0, live: 0, over: false, bays, docks };
  g.layoutVersion = 0;
  for (const b of bays) {
    const r = bayRects(b.x0, 0);
    // each wall is one object shared by `walls` (collision) and `pillars` (drawing), so moving it updates both
    for (const n of ['left', 'right', 'back', 'cab']) { const w = { truck: { color: b.k, part: n } }; setRect(w, r[n]); b.parts[n] = w; g.walls.push(w); g.pillars.push(w); }
    b.parts.gate = { truck: { color: b.k, part: 'gate' } }; // only part of the walls while the gate is closed
    setRect(b.parts.gate, r.gate);
    b.door = { roller: true }; // the factory's roller door in the south wall: shut while the truck is out, so nobody drives out of the factory
    setRect(b.door, r.gate);
  }
  for (const d of docks) {
    const r = dockRects(d, GONE);
    for (const [n, part] of [['sideN', 'side'], ['sideS', 'side'], ['back', 'back'], ['cab', 'wcab']]) { const w = { truck: { color: DOCK_COLOR, part, side: d.side, lat: n === 'sideN' ? -1 : 1 } }; setRect(w, r[n]); d.parts[n] = w; }
    d.parts.rear = { truck: { color: DOCK_COLOR, part: 'door' } }; setRect(d.parts.rear, r.rear);
    d.parts.gate = { truck: { color: DOCK_COLOR, part: 'gate' } }; // closed while no truck stands at the bay
    setRect(d.parts.gate, [dockGateX(d.side), d.y0, WALL, TRUCK_W]);
    g.walls.push(d.parts.gate); g.pillars.push(d.parts.gate); // closed until a truck arrives
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
// Body, carried stack and tines (which pass through boxes and walls) of a forklift.
const reachPolys = (t) => {
  const c = toWorld(t.fl, (FL.tineX0 + FL.tineX1) / 2, 0);
  return [...solidPolys(t), rectPoly(c.x, c.y, (FL.tineX1 - FL.tineX0) / 2, FL.tineOff + FL.tineHalf, t.fl.a)];
};
const clearOfTrucks = (g, b, m) => { const f = footprint(b, m); return !g.trucks.some((t) => !t.gone && reachPolys(t).some((p) => sat(p, f))); };

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
  const shut = b.state === 'leaving' || b.state === 'away' || b.state === 'arriving', doorOn = g.walls.includes(b.door);
  if (shut && !doorOn) { g.walls.push(b.door); g.pillars.push(b.door); g.layoutVersion++; }
  if (!shut && doorOn) { g.walls.splice(g.walls.indexOf(b.door), 1); g.pillars.splice(g.pillars.indexOf(b.door), 1); g.layoutVersion++; }
  if (d !== 0 || has !== b.gateClosed) g.layoutVersion++;
  b.placed = off;
}

function stepBay(g, b, dt) {
  const e = g.endless;
  if (b.state === 'open') {
    if (b.zones.every((z) => zoneDone(g, z)) && clearOfTrucks(g, b, 0.8)) {
      b.state = 'closing'; b.t = 0; b.honkT = e.elapsed; b.honkN = 2; // honks twice, then the gate closes
      const r = interior(b, 0.2);
      b.cargo = g.stacks.filter((s) => inBox(s, r));
      for (const s of b.cargo) s.leaving = true;
    }
  } else if (b.state === 'closing') {
    b.t += dt;
    if (!clearOfTrucks(g, b, 0.4)) { b.state = 'open'; b.gateClosed = false; for (const s of b.cargo) delete s.leaving; b.cargo = []; } // a forklift got too close: reopen
    else {
      if (b.t >= HONK_T) b.gateClosed = true;
      if (b.t >= HONK_T + GATE_DELAY) {
        b.state = 'leaving'; b.v = 0;
        for (const z of b.zones) { const p = zonePoints(g, z); if (p) { e.points += p.total; e.boxes += p.n; } } // the closed door banks the load's points for good
      }
    }
  } else if (b.state === 'leaving') {
    b.v = Math.min(5, b.v + 2.5 * dt);
    b.off += b.v * dt;
    if (b.off >= OUT_DIST) {
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

const dockInterior = (d) => ({ x0: d.side < 0 ? XR - TRUCK_D + WALL : XE, x1: d.side < 0 ? XR + WALL : XE + WALL + TRUCK_D - WALL, y0: d.y0 + WALL, y1: d.y0 + TRUCK_W - WALL });
const dockRect = (d, m) => { const r = { x0: (d.side < 0 ? XR - TRUCK_D : XE) - m, x1: (d.side < 0 ? XR + WALL : XE + WALL + TRUCK_D) + m, y0: d.y0 - m, y1: d.y0 + TRUCK_W + m }; return rectPoly((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, (r.x1 - r.x0) / 2, (r.y1 - r.y0) / 2); };

function placeDock(g, d) {
  const dx = d.off - d.placed;
  const r = dockRects(d, d.off);
  for (const n of ['sideN', 'sideS', 'back', 'cab', 'rear']) setRect(d.parts[n], r[n]);
  Object.assign(d.area, { x: r.area[0], y: r.area[1] });
  for (const s of d.cargo || []) s.x += d.side * dx;
  // a free dock's truck is parked far off the map; keep it out of the walls so nothing draws or collides there
  let changed = dx !== 0;
  const want = { sideN: d.state !== 'free', sideS: d.state !== 'free', back: d.state !== 'free', cab: d.state !== 'free', rear: d.state !== 'free' && d.gateClosed, gate: d.gateClosed };
  for (const n in want) {
    const w = d.parts[n], has = g.walls.includes(w);
    if (want[n] && !has) { g.walls.push(w); g.pillars.push(w); changed = true; }
    if (!want[n] && has) { g.walls.splice(g.walls.indexOf(w), 1); g.pillars.splice(g.pillars.indexOf(w), 1); changed = true; }
  }
  if (changed) g.layoutVersion++;
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
    const s = wonkyStack({ ...dockSlot(d, i, d.placed), layers });
    s.leaving = true; // rides in on the truck, through the border
    d.cargo.push(s);
    g.stacks.push(s);
  }
}

function stepDock(g, d, dt) {
  if (d.state === 'arriving') {
    d.off = Math.max(0, d.off - Math.max(0.8, d.off * 0.7) * dt);
    if (d.off <= 0) {
      if (!d.honked) { d.honked = true; d.honkT = g.endless.elapsed; d.honkN = 1; }
      if (g.endless.elapsed - d.honkT >= HONK_T) { d.honked = false; d.gateClosed = false; d.state = 'present'; d.since = g.endless.elapsed; for (const s of d.cargo) delete s.leaving; }
    }
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
  e.live = liveBayPoints(g);
}

// Points of the loads still at a drop point (gate not yet closed); they go up and down with the stacks and are banked into `e.points` when the gate closes.
function liveBayPoints(g) {
  let n = 0;
  for (const b of g.endless.bays) {
    if (b.state !== 'open' && b.state !== 'closing') continue;
    for (const z of b.zones) { const p = zonePoints(g, z); if (p) n += p.total; }
  }
  return n;
}

// The running score: banked points plus the completed stacks waiting at open drop points (kept at the end of the run, so partly packed lorries count).
export function endlessScore(e) {
  return e.points + (e.live || 0);
}

// Ends the run by hand (menu): same outcome as running out of free docks.
export function endEndless(g) {
  const e = g.endless;
  if (!e || e.over) return;
  e.over = true;
  g.status = 'over';
}

// Lorries whose horn is sounding (an incoming truck arriving: one blast just before its gate opens, a delivery truck leaving: two with a short pause just before its gate closes, the label shown only during each blast), shaped like forklifts for the HONK label.
export function lorryHonks(g) {
  const e = g.endless;
  if (!e) return [];
  const out = [];
  for (const o of [...e.docks, ...e.bays]) {
    const age = e.elapsed - o.honkT;
    if (age < 0 || age >= 0.34 * o.honkN || age % 0.34 > 0.26) continue; // matches the blasts of `playTruckHonk`
    out.push({ id: 100 + (o.dock ? o.k : 10 + o.k), gone: false, horn: true, text: 'HONK', paint: truckPaint(o.dock ? DOCK_COLOR : o.k), fl: { x: o.area.x + o.area.w / 2, y: o.area.y + o.area.h / 2 } });
  }
  return out;
}

// Plank floor of a truck (follows the bay as it drives; the cab is a solid wall part, `parts.cab`).
export function truckGeom(b) {
  return { floor: { x: b.area.x, y: b.area.y, w: b.area.w, h: b.area.h, along: b.dock } };
}

// Permanent flat ramp decals on the warehouse side of every bay (delivery and incoming), whether a truck is there or not.
// Rects with `east` run along x; `side` is the dock's wall side.
export function rampDecals(g) {
  const e = g.endless;
  if (!e) return [];
  const out = e.bays.map((b) => { const [gx, gy, gw] = bayRects(b.x0, 0).gate; return { x: gx + 0.4, y: gy - RAMP_D, w: gw - 0.8, h: RAMP_D + WALL }; });
  for (const d of e.docks) { const gx = dockGateX(d.side); out.push({ x: d.side < 0 ? gx : gx - DOCK_RAMP_D, y: d.y0 + 0.4, w: DOCK_RAMP_D + WALL, h: TRUCK_W - 0.8, east: true, side: d.side, num: dockNumber(d) }); }
  return out;
}

const DIGITS = ['010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111']; // 1-6

// Square pixels of the bay number (1-6) painted on a ramp decal `r`, with the bottom of the digit towards the warehouse centre.
export function numberRects(r, p = 0.3) {
  const bits = DIGITS[r.num - 1], cx = r.x + r.w / 2, cy = r.y + r.h / 2, out = [];
  for (let i = 0; i < 15; i++) {
    if (bits[i] !== '1') continue;
    const u = (i % 3 - 1) * p, v = (Math.floor(i / 3) - 2) * p; // u right, v down in the digit's own frame
    const x = cx + (r.side < 0 ? v : -v), y = cy + (r.side < 0 ? -u : u);
    out.push({ x: x - p / 2, y: y - p / 2, w: p, h: p });
  }
  return out;
}

// Bay number shown to players: 1-3 on the west side, 4-6 on the east side, lowest at the southernmost bay.
export const dockNumber = (d) => (d.side < 0 ? 1 : 1 + DOCKS / 2) + Math.floor(d.k / 2);

// Seconds the truck at each incoming bay has been waiting to be unloaded (null while no truck stands there).
export function dockWaits(g) {
  const e = g.endless;
  return e.docks.map((d) => (d.state === 'present' && d.since >= 0 ? e.elapsed - d.since : null));
}

// Flat floor art for the truck floor: wooden planks along the truck, as [{ pts, fill }].
export function truckFloorArt(r) {
  const out = [{ pts: [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]], fill: '#8a6a43' }];
  const n = Math.round(r.w / 0.5);
  for (let i = 1; i < n; i++) { const x = r.x + (i * r.w) / n; out.push({ pts: [[x - 0.015, r.y], [x + 0.015, r.y], [x + 0.015, r.y + r.h], [x - 0.015, r.y + r.h]], fill: '#5e4527' }); }
  if (r.along) return [out[0], ...Array.from({ length: Math.round(r.h / 0.5) - 1 }, (_, i) => { const y = r.y + ((i + 1) * r.h) / Math.round(r.h / 0.5); return { pts: [[r.x, y - 0.015], [r.x + r.w, y - 0.015], [r.x + r.w, y + 0.015], [r.x, y + 0.015]], fill: '#5e4527' }; })];
  return out;
}

const scalars = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v !== 'object' && typeof v !== 'function'));

// Plain data of the endless-mode state; the cargo of a truck is stored as indices into `g.stacks`.
export function endlessSnapshot(g) {
  const e = g.endless;
  const truck = (o) => ({ ...scalars(o), cargo: (o.cargo || []).map((s) => g.stacks.indexOf(s)).filter((i) => i >= 0) });
  return { ...scalars(e), bays: e.bays.map(truck), docks: e.docks.map(truck) };
}

// Inverse of `endlessSnapshot` on a fresh `newEndless` game whose stacks are already restored.
export function restoreEndless(g, snap) {
  const e = g.endless;
  if (!snap.bays || snap.bays.length !== e.bays.length || !snap.docks || snap.docks.length !== e.docks.length) throw new Error('State does not match endless layout');
  const apply = (o, { cargo, ...rest }) => {
    for (const k in rest) if (typeof o[k] === typeof rest[k]) o[k] = rest[k];
    o.cargo = cargo.map((i) => g.stacks[i]).filter(Boolean);
  };
  const { bays, docks, ...rest } = snap;
  for (const k in rest) if (typeof e[k] === typeof rest[k]) e[k] = rest[k];
  bays.forEach((s, i) => apply(e.bays[i], s));
  docks.forEach((s, i) => apply(e.docks[i], s));
  for (const b of e.bays) place(g, b);
  for (const d of e.docks) placeDock(g, d);
}
