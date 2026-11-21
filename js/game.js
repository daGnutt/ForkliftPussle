import { boxDecalKind } from './decals.js';
import { rectPoly, sat, overlapArea, BOX_HALF_X, halfY, palletRunnerDims, zoneExt } from './geom.js';
export { zoneExt } from './geom.js';
import { FL, MAX_H, MAX_LAYERS, MAX_PLAYERS, makeForklift, drive, toWorld, toLocal } from './forklift.js';
import { addDent, dentIndex, toLocalDir } from './dents.js';
import { BARREL_COLOR, generateLevel } from './level.js';
import { makeStation, stepRepair, repairable, recordDropAngle } from './repair.js';
import { makeHatch, makeBot, makeInspector, stepBot, stepInspector, stackSig, makePhoto } from './bot.js';

const FORKLIFT_MASS = 6;
const MIN_SUPPORT = 0.5; // fraction of a box that must rest on the box below, else it falls off the stack
// Every box is worth BOX_POINTS: up to CRASH_POINTS lost to crashes and up to
// SQUARE_POINTS lost for being placed crooked. Points are only ever deducted.
const BOX_POINTS = 100;
const CRASH_POINTS = 50;
const HARD_PALLET_DAMAGE_FACTOR = 0.75;
const HARD_PALLET_CRASH_MIN_SPEED = 1.5;
const SQUARE_POINTS = 50;
const SQUARE_ALLOWANCE = (5 * Math.PI) / 180;
const SHIFT_MAX = 0.35;
const CRASH_MIN_SPEED = 0.8;
const CRASH_COOLDOWN = 0.4;
const BONK_MIN_SPEED = 1.2;
const BONK_LOSS = 0.4; // fraction of forward motion lost in one step that counts as a bonk
const BONK_COOLDOWN = 0.2;
const SCRAPE_MIN_SPEED = 0.3; // speed while touching a wall that scrapes
const FORK_BLOCK_POINTS = 10;
const CEILING_LEVELS = 6; // the carried stack's top (H + boxes) may not go above this many box heights
const CEILING_POINTS = 10; // crash points per box on the forks each time they hit the ceiling
const PALLET_INERTIA = 0.17; // radius of gyration squared of a unit box
const ALIGN_MIN_SPEED = 0.05;
const ALIGN_RATE = 1.2; // rad/s a nudged stack turns square to the forklift

// `deco` is the box's decal kind; it lives in the pen entry so it travels with the box.
// `open` marks an open-top box: nothing can be stacked on it, so it only ever sits on top of a stack.
// `wide` marks a wide box (1×2 tiles, long side across the forks): only forks that have both tines under it can lift it, and it only
// stacks on (and under) other wide boxes.
const newPen = (col = 0, seed = 0, open = false, wide = false) => ({ crash: 0, sq: 0, deco: open ? 4 : boxDecalKind(col, seed), ...(open && { open: true }), ...(wide && { wide: true }) });
export const topOpen = (pens) => !!pens?.[pens.length - 1]?.open;
const blocksStacking = (pens) => topOpen(pens) || pens?.[pens.length - 1]?.barrelPart === 'top';
const wideBox = (pens) => !!pens?.[0]?.wide;
const boxPoly = (x, y, a, pen) => rectPoly(x, y, BOX_HALF_X, halfY(pen), a);
const boxArea = (pen) => 4 * BOX_HALF_X * halfY(pen);
const reach = (s) => Math.hypot(BOX_HALF_X, halfY(s.pen?.[0]));
const boxMass = (s) => (wideBox(s.pen) ? 2 : 1);
const WIDE_ALIGN = 0.45; // max |sin| of the angle between truck heading and a wide box's local x axis for the tines to get under it
const boxPoints = (pen) => (pen?.wide ? 2 * BOX_POINTS : BOX_POINTS);

// Trucks. Every player drives one entry of `g.trucks`; the fields below belong to a truck. `g` itself is the view of
// the local truck (`g.self`): g.fl, g.H, g.carried... forward to `g.trucks[g.self]`, so single-player code and
// tests just use `g`. `truckView(g, i)` gives the same view for another truck (a Proxy), which every per-truck
// function (update steps, forkUp/forkDown, resolve) accepts in place of `g`.
const TRUCK_KEYS = ['fl', 'carried', 'carriedRel', 'carriedRots', 'carriedPen', 'carriedOffs', 'bonks', 'bonkPower', 'bonkAt', 'scrape', 'wallPush', 'contact', 'slip', 'H', 'hf', 'ef', 'hitAt', 'horn', 'lifting', 'liftedBy', 'liftRel', 'perchZ', 'rideLv', 'rideOff'];
const TRUCK_SET = new Set(TRUCK_KEYS);

export function makeTruck(start, id = 0, name = '') {
  return {
    id, color: id, name, gone: false, input: {},
    fl: makeForklift(start.x, start.y, start.a),
    carried: null, carriedRel: 0, carriedRots: [], carriedPen: [], carriedOffs: [],
    bonks: 0, bonkPower: 0, bonkAt: -1, scrape: 0, wallPush: null,
    contact: null, // last wall hit: { x, y, nx, ny } = point on the truck and the direction the wall pushed it (for sparks)
    slip: 0, // 0..1, how much the tyres are spinning (driving into something that does not give, or being shoved); drives tyre smoke
    H: 0, hf: 0, ef: 0,
    horn: false, // the horn key is held
    lifting: -1, // id of the truck riding on this truck's tines (-1 none)
    liftedBy: -1, // id of the truck whose tines carry this one (it cannot move by itself meanwhile)
    perchZ: 0, // > 0: the truck sits on top of stacks this many box levels up and cannot move until lifted off
    rideLv: 0, // > 0: it sits on top of the stack of this many boxes its carrier carries (instead of on the tines)
    rideOff: null, // pose of a truck riding on a carried stack, in the carrier's frame { x, y, a }
    liftRel: 0, // heading of a lifted truck relative to its carrier (+-PI/2: it rides sideways on the tines)
  };
}

function bindTrucks(g) {
  Object.defineProperty(g, 'root', { value: g });
  Object.defineProperty(g, 'truck', { get() { return this.trucks[this.self]; } });
  for (const k of TRUCK_KEYS) {
    Object.defineProperty(g, k, { get() { return this.trucks[this.self][k]; }, set(v) { this.trucks[this.self][k] = v; }, configurable: true });
  }
}

const views = new WeakMap();
// The game seen from truck i: `g` itself for the local truck, otherwise a Proxy that redirects the truck fields.
export function truckView(g, i) {
  const root = g.root;
  if (i === root.self) return root;
  const t = root.trucks[i];
  let v = views.get(t);
  if (!v) {
    v = new Proxy(root, {
      get: (_, k) => (k === 'truck' ? t : TRUCK_SET.has(k) ? t[k] : root[k]),
      set: (_, k, val) => { if (TRUCK_SET.has(k)) t[k] = val; else root[k] = val; return true; },
    });
    views.set(t, v);
  }
  return v;
}

// The live truck objects.
export const liveTrucks = (g) => g.root.trucks.filter((t) => !t.gone);
// Views of the live trucks other than the one `g` is the view of.
export function truckPopChanges(g, previous) {
  const root = g.root, changes = [];
  root.trucks.forEach((t, i) => {
    if (i === root.self) return;
    const prev = previous.get(i);
    if (prev && prev.gone !== !!t.gone) {
      const at = t.gone ? prev : t.fl;
      changes.push({ i, kind: t.gone ? 'out' : 'in', x: at.x, y: at.y });
    }
    previous.set(i, { gone: !!t.gone, x: t.fl.x, y: t.fl.y });
  });
  for (let i = root.trucks.length; i < MAX_PLAYERS; i++) {
    if (!previous.has(i)) previous.set(i, { gone: true });
  }
  return changes;
}
// View-only pop timing (set by main.js `watchPops`): arrivals scale in and departures linger for the smoke to build
// before scaling out. Renderers use this; it does not affect the simulation.
export const POP_DELAY = 0.8;
const POP_OUT_HOLD = POP_DELAY * 0.5;
const POP_MIN_SCALE = 0.03;
export function truckPopScale(g, i) {
  const root = g.root, pop = root.popVis?.[i];
  if (!pop) return 1;
  const elapsed = Math.max(0, root.clock - pop.t);
  if (elapsed >= POP_DELAY) return 1;
  const progress = pop.kind === 'out'
    ? Math.max(0, Math.min(1, (elapsed - POP_OUT_HOLD) / (POP_DELAY - POP_OUT_HOLD)))
    : Math.max(0, Math.min(1, elapsed / POP_DELAY));
  const eased = progress * progress * (3 - 2 * progress);
  return pop.kind === 'out' ? 1 - (1 - POP_MIN_SCALE) * eased : POP_MIN_SCALE + (1 - POP_MIN_SCALE) * eased;
}
export const otherTrucksShown = (g) => g.root.trucks.map((t, i) => {
  if (t === g.truck) return null;
  const pv = g.root.popVis?.[i], busy = pv && g.root.clock - pv.t < POP_DELAY;
  return (busy ? pv.kind === 'out' || pv.kind === 'in' : !t.gone) ? truckView(g.root, i) : null;
}).filter(Boolean);
export const otherTrucks = (g) => g.root.trucks.map((t, i) => (t.gone || t === g.truck ? null : truckView(g.root, i))).filter(Boolean);

const bodyPoly = (t) => {
  const c = toWorld(t.fl, (FL.back + FL.front) / 2, 0);
  return rectPoly(c.x, c.y, (FL.front - FL.back) / 2, FL.halfW, t.fl.a);
};
// A truck riding on another's tines sits sideways across them: body centre at the carry point.
const LIFT_GRIP = 0.7; // how far (along its body) the carry point may be off the middle of a truck for the tines to get under its side
const LIFT_SIDEWAYS = 0.5; // max |cos| of the angle between a truck's heading and the lifter's for the lifter to be at its side
const BODY_MID = (FL.back + FL.front) / 2;
function liftedPose(carrier, liftRel) {
  const a = carrier.fl.a + liftRel, p = toWorld(carrier.fl, FL.carryX, 0);
  return { x: p.x - BODY_MID * Math.cos(a), y: p.y - BODY_MID * Math.sin(a), a };
}
// Where a lifted truck is: on the tines, or (rideLv > 0) fixed relative to the carrier on top of its carried stack.
function riderPose(carrier, v) {
  if (!(v.rideLv > 0 && v.rideOff)) return liftedPose(carrier, v.liftRel);
  const p = toWorld(carrier.fl, v.rideOff.x, v.rideOff.y);
  return { x: p.x, y: p.y, a: carrier.fl.a + v.rideOff.a };
}
// Height (box levels, incl. the tine thickness) a lifted or perched truck's wheels are at, or null when the truck is on the floor.
const LIFT_OFF = 0.1 / 0.6; // pallet/tine thickness in box levels (PAL / (BOX_H + PAL))
export const liftedHf = (g) => (g.truck.liftedBy >= 0 ? (g.root.trucks[g.truck.liftedBy]?.hf ?? 0) + g.truck.rideLv + LIFT_OFF : g.truck.perchZ > 0 ? g.truck.perchZ + LIFT_OFF : null);
// A truck that cannot drive or work its forks: on another's tines or perched on stacks.
const stuck = (g) => g.liftedBy >= 0 || g.perchZ > 0;
// Box levels of the highest stack top under a truck body at pose p.
function supportLevels(root, p) {
  const body = rectPoly(toWorld(p, BODY_MID, 0).x, toWorld(p, BODY_MID, 0).y, (FL.front - FL.back) / 2, FL.halfW, p.a);
  let n = 0;
  for (const s of root.stacks) if (sat(body, stackPoly(s))) n = Math.max(n, s.layers.length);
  return n;
}
function syncLifted(root, carrier) {
  const v = root.trucks[carrier.lifting];
  if (!v) return;
  if (v.rideLv > 0 && !carrier.carried) return releaseLifted(root, carrier); // the stack it sat on is gone from the forks
  Object.assign(v.fl, riderPose(carrier, v), { speed: 0, steer: 0 });
}
function releaseLifted(root, carrier) {
  const v = root.trucks[carrier.lifting];
  if (v) {
    v.liftedBy = -1; v.liftRel = 0;
    if (v.rideLv > 0) { v.perchZ = supportLevels(root, v.fl); v.rideLv = 0; v.rideOff = null; } // set down with the stack: perched on it
  }
  carrier.lifting = -1;
}
const carriedCenter = (t, i = 0) => {
  const o = t.carriedOffs?.[i];
  return toWorld(t.fl, FL.carryX + (o?.x || 0), o?.y || 0);
};
const carriedPoly = (t, i = 0) => {
  if (!t.carried) return null;
  const c = carriedCenter(t, i);
  return boxPoly(c.x, c.y, t.fl.a + (t.carriedRots?.[i] ?? t.carriedRel), t.carriedPen?.[i]);
};
export const solidPolys = (t) => [bodyPoly(t), carriedPoly(t)].filter(Boolean);
const trucksOverlap = (a, b) => {
  if (Math.hypot(a.fl.x - b.fl.x, a.fl.y - b.fl.y) > 6) return false;
  const pb = solidPolys(b);
  return solidPolys(a).some((p) => pb.some((q) => sat(p, q)));
};

// Two trucks that are inside each other when one spawns are ghosts to each other (drawn translucent, no collision) until they separate.
export const ghostBetween = (g, i, j) => g.root.ghostPairs.some(([a, b]) => (a === i && b === j) || (a === j && b === i));
export const isGhost = (g, i) => g.root.ghostPairs.some((p) => p.includes(i));

// Stacks under a truck that spawns carry `ghost` = [truck ids]: those trucks pass through them (drawn translucent) until clear.
const stackUnder = (t, s) => sat(bodyPoly(t), boxPoly(s.x, s.y, s.a || 0, s.pen?.[0]));
function markSpawnStacks(g, i) {
  const t = g.trucks[i];
  for (const s of g.stacks) {
    if (s.ghost) s.ghost = s.ghost.filter((j) => j !== i);
    if (stackUnder(t, s)) (s.ghost ||= []).push(i);
    if (s.ghost && !s.ghost.length) delete s.ghost;
  }
}

function updateGhosts(g) {
  for (const s of g.stacks) {
    if (!s.ghost) continue;
    s.ghost = s.ghost.filter((j) => g.trucks[j] && !g.trucks[j].gone && stackUnder(g.trucks[j], s));
    if (!s.ghost.length) delete s.ghost;
  }
  g.ghostPairs = g.ghostPairs.filter(([a, b]) => {
    const ta = g.trucks[a], tb = g.trucks[b];
    return ta && tb && !ta.gone && !tb.gone && trucksOverlap(ta, tb);
  });
}

// Adds a player's truck in the parking spot (first free slot); returns its index, or -1 when the game is full.
// A given `slot` is used when it is free (a rebuilt level keeps every player's colour).
export function addTruck(g, name = '', slot = -1) {
  let i = slot;
  if (i < 0) {
    i = g.trucks.findIndex((t) => t.gone);
    if (i < 0) { if (g.trucks.length >= MAX_PLAYERS) return -1; i = g.trucks.length; }
  } else if (i >= MAX_PLAYERS || (g.trucks[i] && !g.trucks[i].gone)) return -1;
  while (g.trucks.length < i) g.trucks.push({ ...makeTruck(g.start, g.trucks.length), gone: true });
  const t = makeTruck(g.start, i, name);
  g.trucks[i] = t;
  g.ghostPairs = g.ghostPairs.filter((p) => !p.includes(i));
  g.trucks.forEach((o, j) => { if (j !== i && !o.gone && trucksOverlap(t, o)) g.ghostPairs.push([j, i]); });
  markSpawnStacks(g, i);
  return i;
}

// A leaving player's truck disappears; boxes on its forks are put down in front of it so the level stays solvable.
export function removeTruck(g, i) {
  const t = g.trucks[i];
  if (!t || t.gone) return;
  if (t.carried) {
    const v = truckView(g, i);
    const n = t.carried.length;
    while (t.carriedPen.length < n) t.carriedPen.push(newPen(t.carried[t.carriedPen.length], t.carriedPen.length));
    while (t.carriedRots.length < n) t.carriedRots.push(t.carriedRel);
    while (t.carriedOffs.length < n) t.carriedOffs.push({ x: 0, y: 0 });
    const p = carriedCenter(t), world = carriedWorldOffs(t), base = world[0];
    g.stacks.push({
      x: p.x, y: p.y, layers: t.carried, rots: t.carriedRots.map((r) => r + t.fl.a), pen: t.carriedPen,
      offs: world.map((o) => ({ x: o.x - base.x, y: o.y - base.y })), a: t.fl.a + t.carriedRel,
    });
    Object.assign(v, { carried: null, carriedRots: [], carriedPen: [], carriedOffs: [] });
  }
  if (t.lifting >= 0) releaseLifted(g, t);
  if (t.liftedBy >= 0) { const c = g.trucks[t.liftedBy]; if (c) c.lifting = -1; t.liftedBy = -1; }
  t.gone = true;
  g.ghostPairs = g.ghostPairs.filter((pr) => !pr.includes(i));
  for (const s of g.stacks) if (s.dropFrom != null && (s.dropTruck ?? 0) === i) delete s.dropFrom;
}

// Visual lowering (in box heights) of a just-released stack: it follows the forks of the truck that put it down.
export const dropLift = (g, st) => (st.dropFrom != null ? Math.max(0, (g.root.trucks[st.dropTruck ?? 0]?.hf ?? 0) - st.dropFrom - stackZ(st)) : 0);

// Proximity alert (any gear but R, occupied forks only, even when coasting or standing still): the area the carried stack sweeps in the next ALERT_AHEAD seconds along the current steering arc,
// plus a close probe reaching at least ALERT_MIN_REACH tiles beyond the fork tips. Returns the probe polygons (also drawn in debug mode).
const ALERT_AHEAD = 1, ALERT_STEP = 0.2, ALERT_MIN_REACH = 1, ALERT_MAX_TURN = Math.PI / 4; // the sweep stops once the heading has turned 45° either way (90° in total)
export function crashProbes(g) {
  const f = g.fl;
  if (!g.carried || g.status === 'over' || f.gear === 'R') return [];
  const hy = halfY(g.carriedPen?.[0]);
  const o = g.carriedOffs?.[0] || { x: 0, y: 0 };
  const x0 = FL.carryX - BOX_HALF_X + o.x, x1 = FL.tineX1 + ALERT_MIN_REACH + o.x;
  const m = toWorld(f, (x0 + x1) / 2, o.y), probes = [rectPoly(m.x, m.y, (x1 - x0) / 2, hy, f.a)];
  const v = Math.max(0, f.speed);
  let { x, y, a } = f;
  for (let t = 0; t < ALERT_AHEAD; t += ALERT_STEP) {
    x += Math.cos(a) * v * ALERT_STEP; y += Math.sin(a) * v * ALERT_STEP;
    a += (v * Math.tan(f.steer) / FL.L) * ALERT_STEP;
    if (Math.abs(a - f.a) > ALERT_MAX_TURN) break;
    const c = toWorld({ x, y, a }, FL.carryX + o.x, o.y);
    probes.push(rectPoly(c.x, c.y, 0.5, hy, a + g.carriedRel));
  }
  return probes;
}

// The stacks the alert's probes currently hit (at an overlapping height).
export function alertTriggers(g) {
  const probes = crashProbes(g);
  if (!probes.length) return [];
  return g.stacks.filter((s) => s.layers.length > g.H && probes.some((p) => sat(p, stackPoly(s))));
}

export const crashAlert = (g) => alertTriggers(g).length > 0;

// True during the lit half of the alert's blink (the headlights flash red).
export const crashBlink = (g) => crashAlert(g) && Math.floor((g.clock || 0) * 6) % 2 === 0;

// Drawing-only height on copies made by fallView; floor stacks have no logical elevation.
export const stackZ = (s) => s.fallZ || 0;

function ensure(S) {
  if (!S.rots) S.rots = S.layers.map(() => S.a || 0);
  if (!S.pen) S.pen = S.layers.map((c, i) => newPen(c, i));
  if (!S.offs) S.offs = [];
  while (S.offs.length < S.layers.length) S.offs.push({ x: 0, y: 0 });
}

const forgetInspection = (pens) => { for (const p of pens || []) delete p.inspected; };
const touchStack = (s) => { s.touched = true; forgetInspection(s.pen); };

// World-frame offsets of the carried boxes relative to the fork carry point.
export function carriedWorldOffs(g) {
  const c = Math.cos(g.fl.a), sn = Math.sin(g.fl.a);
  return (g.carriedOffs || []).map((o) => ({ x: o.x * c - o.y * sn, y: o.x * sn + o.y * c }));
}

// World position of box i of a stack: the stack position plus that box's own offset (boxes may sit crooked on each other).
function boxPos(S, i) {
  ensure(S);
  return { x: S.x + S.offs[i].x, y: S.y + S.offs[i].y };
}

// Moves boxes i and above together; box 0 is the stack position itself, so moving it moves the whole stack.
function shiftBoxes(S, i, dx, dy) {
  if (S.pen?.[i]?.barrelPart === 'top') i--;
  if (i === 0) { S.x += dx; S.y += dy; return; }
  for (let j = i; j < S.layers.length; j++) { S.offs[j].x += dx; S.offs[j].y += dy; }
}

// Where fallen boxes land: 1.45 from the stack along (dx, dy), but never in or beyond a wall (e.g. the sides of a delivery trailer, which
// would leave them unreachable outside the map): walks outwards and stops at the first wall, then tries other directions if too close.
function fallSpot(g, S, dx, dy, a, pen) {
  const free = (x, y) => { const p = boxPoly(x, y, a, pen); return !g.walls.some((w) => sat(p, w.poly)); };
  const reach = (ux, uy) => { let d = 0; while (d < 1.45 - 1e-9 && free(S.x + ux * Math.min(1.45, d + 0.05), S.y + uy * Math.min(1.45, d + 0.05))) d += 0.05; return d; };
  let best = { d: reach(dx, dy), ux: dx, uy: dy };
  for (let k = 1; best.d < 1.0 && k <= 7; k++) {
    const a = Math.atan2(dy, dx) + (k * Math.PI) / 4, ux = Math.cos(a), uy = Math.sin(a), d = reach(ux, uy);
    if (d > best.d + 1e-9) best = { d, ux, uy };
  }
  return { x: S.x + best.ux * best.d, y: S.y + best.uy * best.d };
}

const FALL_TIME = 0.5; // seconds a toppled box takes to tumble to the floor (drawing only; the stack is at its landing spot at once)

// The stack as it should be drawn: while boxes are still tumbling off a stack (`s.fall`), they slide in from where they
// toppled, turn and drop; the logical position, rotations and heights are always the final ones.
export function fallView(g, s0) {
  const s = fallBase(g, s0), hop = joltHop((g.root || g).clock, s0.jolt);
  return hop > 0 ? { ...s, fallZ: (s.fallZ || 0) + hop } : s;
}

function fallBase(g, s) {
  const f = s.fall;
  if (!f) return s;
  const p = Math.min(1, ((g.root || g).clock - f.t0) / FALL_TIME);
  if (p >= 1) return s;
  const e = 1 - (1 - p) ** 2, k = 1 - e;
  const v = { ...s, rots: s.rots.map((r, i) => (i >= f.from ? r + f.dr * (1 - p) * Math.sin(Math.PI * Math.min(1, p * 1.3)) : r)) };
  if (f.from === 0) {
    v.x = s.x + f.dx * k; v.y = s.y + f.dy * k;
    v.fallZ = Math.max(0, f.z * (1 - p * p) + 0.25 * Math.sin(Math.PI * p));
  } else {
    v.offs = s.offs.map((o, i) => (i >= f.from ? { x: o.x + f.dx * k, y: o.y + f.dy * k } : o));
  }
  return v;
}

// A box with less than MIN_SUPPORT of its area on the box below falls off, together with everything above it,
// to the floor beside the stack, taking maximum damage.
function settle(g, S) {
  ensure(S);
  for (let i = 1; i < S.layers.length; i++) {
    if (S.pen[i]?.barrelPart === 'top') continue;
    const a = boxPos(S, i), b = boxPos(S, i - 1);
    if (overlapArea(boxPoly(a.x, a.y, S.rots[i], S.pen[i]), boxPoly(b.x, b.y, S.rots[i - 1], S.pen[i - 1])) >= MIN_SUPPORT * boxArea(S.pen[i])) continue;
    if (catchFallingBoxes(g, S, i)) return;
    let dx = a.x - b.x, dy = a.y - b.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const startZ = i;
    addDent(S.pen[i - 1], 't');
    const pen = S.pen.splice(i);
    hurt(g, pen, CRASH_POINTS, S.x + dx * 1.45, S.y + dy * 1.45, pen.length);
    const offs = S.offs.splice(i);
    const rots = S.rots.splice(i);
    const { x: nx, y: ny } = fallSpot(g, S, dx, dy, rots[0], pen[0]);
    const layers = S.layers.splice(i);
    const rel = offs.map((o) => ({ x: o.x - offs[0].x, y: o.y - offs[0].y }));
    // Landing within stackable reach of another stack's top box, the fallen boxes come to rest on it.
    const under = g.stacks.find((t) => {
      if (t === S || t.layers.length + layers.length > MAX_LAYERS || blocksStacking(t.pen) || wideBox(t.pen) !== wideBox(pen)) return false;
      const c = boxPos(t, t.layers.length - 1);
      return Math.abs(c.x - nx) < 0.55 && Math.abs(c.y - ny) < 0.55;
    });
    const fall = (from, z) => ({ t0: g.clock, dx: a.x - nx, dy: a.y - ny, dr: 0.7 * Math.sign(dx * dy || 1), z, from });
    if (under) {
      under.fall = fall(under.layers.length, 0);
      under.layers.push(...layers); under.rots.push(...rots); under.pen.push(...pen);
      under.offs.push(...rel.map((o) => ({ x: nx + o.x - under.x, y: ny + o.y - under.y })));
      settle(g, under);
    } else {
      g.stacks.push({ x: nx, y: ny, layers, rots, pen, a: rots[0], offs: rel, fall: fall(0, startZ) });
    }
    break;
  }
}


const HIT_LIFE = 1.2; // seconds a damage popup lives
const SCORE_LIFE = 2.2; // finished-stack score popups stay longer so they can be read
export const hitLife = (h) => (h.score || h.check ? SCORE_LIFE : HIT_LIFE); // `check`: the inspection bot's "inspected" label
const HIT_MERGE = 0.6; // further damage to the same stack within this time adds to its popup

// Applies crash points and records the actual loss as a floating popup (x, y, z in box heights).
function hurt(g, pens, pts, x, y, z, owner = null) {
  let lost = 0;
  for (const p of pens) { const n = Math.min(CRASH_POINTS, p.crash + pts); lost += n - p.crash; p.crash = n; }
  lost = Math.round(lost);
  if (lost <= 0) return;
  g.hits ||= [];
  const prev = owner && g.hits.find((h) => h.owner === owner && g.clock - h.t < HIT_MERGE);
  if (prev) { prev.pts += lost; prev.x = x; prev.y = y; prev.z = z; prev.t = g.clock; }
  else g.hits.push({ x, y, z, pts: lost, t: g.clock, owner });
  g.hitCount = (g.hitCount || 0) + 1;
}

// Crumples the boxes in `pens` where they were hit. `dent` = {kind: 's'|'c', dx, dy (world direction from the boxes
// towards what they hit), rots (world angle of each box)}.
function dentBoxes(pens, count, dent) {
  for (let i = 0; i < count; i++) {
    const [lx, ly] = toLocalDir(dent.dx, dent.dy, dent.rots[i] || 0);
    addDent(pens[i], dent.kind, dentIndex(dent.kind, lx, ly));
  }
}

function crash(g, pens, owner, count = pens.length, dent = null) {
  const speed = Math.abs(g.fl.speed);
  const hardPallet = g.hard && g.stacks.includes(owner);
  if (speed < (hardPallet ? HARD_PALLET_CRASH_MIN_SPEED : CRASH_MIN_SPEED) || g.clock - (owner.hitAt ?? -1) < CRASH_COOLDOWN) return;
  owner.hitAt = g.clock;
  let pts = Math.min(5, Math.max(1, Math.round(speed)));
  if (hardPallet) pts = Math.max(1, Math.round(pts * HARD_PALLET_DAMAGE_FACTOR));
  const c = owner === g ? carriedCenter(g) : owner;
  hurt(g, pens.slice(0, count), pts, c.x, c.y, owner === g ? g.H + pens.length : pens.length, owner);
  if (dent) dentBoxes(pens, Math.min(count, pens.length), dent);
}

const carriedRotsWorld = (g) => g.carriedRots.map((r) => r + g.fl.a);

// Deduction (0..SQUARE_POINTS) for a box whose world angle is a: free within
// SQUARE_ALLOWANCE of square, then scaled and floored to steps of 5 points.
function squareLoss(a) {
  const q = Math.PI / 2;
  const m = ((a % q) + q) % q;
  const dev = Math.min(m, q - m);
  if (dev <= SQUARE_ALLOWANCE) return 0;
  const t = (dev - SQUARE_ALLOWANCE) / (q / 2 - SQUARE_ALLOWANCE);
  return Math.floor((t * SQUARE_POINTS) / 5) * 5;
}

// Sideways placement is allowed while every corner of the box stays inside the drop point.
function refreshPlacement(g, S, z) {
  ensure(S);
  const e = zoneExt(z);
  S.pen.forEach((p, i) => {
    p.sq = squareLoss(S.rots[i]);
    if (!g.hard) return;
    const c = boxPos(S, i);
    const outside = p.barrelPart === 'top' ? 0 : Math.max(0, ...boxPoly(c.x, c.y, S.rots[i], p).flatMap((v) =>
      [Math.abs(v.x - z.x) - e.x, Math.abs(v.y - z.y) - e.y]));
    p.shift = outside <= 1e-9 ? 0 : Math.min(SQUARE_POINTS, 5 * Math.ceil(10 * outside / SHIFT_MAX));
  });
}

const placementLoss = (g, p) => Math.min(SQUARE_POINTS, p.sq + (g.hard ? p.shift || 0 : 0));
const inspectionKey = (z) => `${z.x},${z.y},${z.color}`;
function hasReport(g, s, z) {
  const key = inspectionKey(z), bot = g.inspector;
  return !s.touched && bot?.seen.includes(key) && bot.sigs?.[key] === stackSig(s) && bot.photos?.[key]?.pens?.[0]?.shift !== undefined;
}
const showPlacement = (g, s, z, reportedOnly) => !g.hard || !reportedOnly || g.status === 'won' || hasReport(g, s, z);

export function maxScore(g) {
  const sum = (layers, pens) => layers.reduce((n, _, i) => n + boxPoints(pens?.[i]), 0);
  return g.stacks.reduce((n, s) => n + sum(s.layers, s.pen), 0) + g.root.trucks.reduce((n, t) => n + (t.carried ? sum(t.carried, t.carriedPen) : 0), 0);
}

// Points lost to crashes and to crooked placement.
export function lostBreakdown(g, reportedOnly = false) {
  let crashLost = 0, repairableLost = 0, squareLost = 0;
  const addCrash = (p) => { crashLost += p.crash; if (repairable(p)) repairableLost += p.crash; };
  for (const S of g.stacks) {
    ensure(S);
    for (const p of S.pen) addCrash(p);
    const z = g.zones.find((z) => stackFillsZone(S, z));
    if (z && showPlacement(g, S, z, reportedOnly)) {
      refreshPlacement(g, S, z);
      for (const p of S.pen) squareLost += placementLoss(g, p);
    }
  }
  for (const t of g.root.trucks) for (const p of t.carriedPen) addCrash(p);
  const crash = Math.round(crashLost), repairableCrash = Math.round(repairableLost);
  return { crash, repairableCrash, permanentCrash: crash - repairableCrash, square: Math.round(squareLost) };
}

// Points earned: only boxes in a stack that completes a zone count, but crash damage anywhere (loose stacks, carried boxes) is already deducted,
// so it is not deducted again when that stack is dropped on a drop point.
export function score(g, reportedOnly = false) {
  let pts = 0;
  const counted = new Set();
  for (const z of g.zones) {
    const S = stackForZone(g, z);
    if (!S || counted.has(S)) continue;
    counted.add(S);
    const reveal = showPlacement(g, S, z, reportedOnly);
    refreshPlacement(g, S, z);
    for (const p of S.pen) pts += boxPoints(p) - p.crash - (reveal ? placementLoss(g, p) : 0);
  }
  for (const S of g.stacks) if (!counted.has(S)) { ensure(S); for (const p of S.pen) pts -= p.crash; }
  for (const t of g.root.trucks) for (const p of t.carriedPen) pts -= p.crash;
  return Math.round(pts);
}

// Fresh stacks get a little deterministic wonkiness: each box is turned up to WONK_ROT and shifted up to WONK_OFF.
const WONK_ROT = 15 * Math.PI / 180, WONK_OFF = 0.06;
export function wonkyStack(s) {
  const base = Math.floor(s.x * 31 + s.y * 17);
  const pen = s.layers.map((c, i) => newPen(c, base + i, !!s.open && i === s.layers.length - 1, !!s.wide));
  if (Number.isInteger(s.barrelAt) && s.barrelAt >= 0 && s.barrelAt + 1 < s.layers.length) {
    const barrelId = `barrel:${s.x}:${s.y}:${s.barrelAt}`;
    pen[s.barrelAt] = { ...pen[s.barrelAt], barrelPart: 'base', barrelId };
    pen[s.barrelAt + 1] = { ...pen[s.barrelAt + 1], barrelPart: 'top', barrelId };
  }
  if (s.wide) return { x: s.x, y: s.y, layers: [...s.layers], rots: s.layers.map(() => s.a || 0), pen, offs: s.layers.map(() => ({ x: 0, y: 0 })), a: s.a || 0 };
  const r = (i, k) => { const t = Math.sin((base + i * 7.13 + k * 3.7) * 12.9898) * 43758.5453; return (t - Math.floor(t)) * 2 - 1; };
  const rots = s.layers.map((_, i) => (s.a || 0) + r(i, 1) * WONK_ROT);
  const offs = s.layers.map((_, i) => (i === 0 ? { x: 0, y: 0 } : { x: r(i, 2) * WONK_OFF, y: r(i, 3) * WONK_OFF }));
  if (Number.isInteger(s.barrelAt)) {
    rots[s.barrelAt + 1] = rots[s.barrelAt];
    offs[s.barrelAt + 1] = { ...offs[s.barrelAt] };
  }
  return { x: s.x, y: s.y, layers: [...s.layers], rots, pen, offs, a: rots[0] };
}

export function newGame(levelNumber, seed = 0, hard = false) {
  return gameFromLayout(generateLevel(levelNumber, seed), levelNumber, seed, hard);
}

// Builds the game state from a layout (`generateLevel`'s shape: w, h, walls, charger, zones, areas, bays, doors, stacks, start).
export function gameFromLayout(lvl, levelNumber, seed = 0, hard = false) {
  const walls = [];
  const T = 3;
  const add = (x, y, w, h, charger) => walls.push({ x, y, w, h, poly: rectPoly(x + w / 2, y + h / 2, w / 2, h / 2), ...(charger && { charger }) });
  add(-T, -T, lvl.w + 2 * T, T);
  add(-T, lvl.h, lvl.w + 2 * T, T);
  add(-T, 0, T, lvl.h);
  add(lvl.w, 0, T, lvl.h);
  for (const r of lvl.walls) add(r.x, r.y, r.w, r.h, r === lvl.charger);
  const g = {
    level: levelNumber,
    seed,
    hard,
    w: lvl.w,
    h: lvl.h,
    walls,
    pillars: lvl.walls,
    charger: lvl.charger,
    zones: lvl.zones,
    areas: lvl.areas,
    bays: lvl.bays,
    doors: lvl.doors,
    stacks: lvl.stacks.map((s) => wonkyStack(s)),
    parking: { ...toWorld(lvl.start, (FL.back + FL.front) / 2, 0), a: lvl.start.a },
    start: { x: lvl.start.x, y: lvl.start.y, a: lvl.start.a },
    trucks: [makeTruck(lvl.start)],
    oil: [],
    self: 0, // index of the local player's truck
    ghostPairs: [], // [i, j] truck pairs that spawned inside each other and pass through each other until they separate
    hits: [],
    hitCount: 0,
    status: 'play',
    time: 0,
    started: false,
    clock: 0,
  };
  g.repair = makeStation(g);
  if (g.repair) { const m = g.repair.mast; walls.push({ ...m, poly: rectPoly(m.x + m.w / 2, m.y + m.h / 2, m.w / 2, m.h / 2), mast: true }); }
  g.hatch = makeHatch(g);
  g.bot = makeBot(g);
  g.inspector = makeInspector(g);
  bindTrucks(g);
  markSpawnStacks(g, 0);
  return g;
}

const stackPoly = (s) => boxPoly(s.x, s.y, s.a || 0, s.pen?.[0]);

// Boxes above the fork level that have slid more than SLID_MIN off the box below them: the truck body and the fork plate hit these
// (the tines never touch them, even offset), so such a box can be pushed back into line.
const SLID_MIN = 0.2;
const BODY_REACH = 3; // boxes the body/fork plate reaches above the fork level's own box; higher ones need the forks raised
function slidBoxes(g, s) {
  ensure(s);
  const out = [];
  for (let i = g.H + 1; i < Math.min(s.layers.length, g.H + BODY_REACH); i++) {
    if (Math.hypot(s.offs[i].x - s.offs[i - 1].x, s.offs[i].y - s.offs[i - 1].y) <= SLID_MIN) continue;
    const c = boxPos(s, i);
    out.push({ poly: boxPoly(c.x, c.y, s.rots[i], s.pen?.[i]), from: i });
  }
  return out;
}

function forkShapes(g) {
  const f = g.fl;
  const mk = (lx, ly, hx, hy, stackFilter, targets) => {
    const c = toWorld(f, lx, ly);
    return { poly: rectPoly(c.x, c.y, hx, hy, f.a), stackFilter, targets };
  };
  const boxes = (from) => (s) => {
    ensure(s);
    const out = [];
    for (let i = from; i < s.layers.length; i++) { const c = boxPos(s, i); out.push({ poly: boxPoly(c.x, c.y, s.rots[i], s.pen?.[i]), from: i }); }
    return out;
  };
  const shapes = [
    mk((FL.back + FL.front) / 2, 0, (FL.front - FL.back) / 2, FL.halfW, () => true, (s) => [{ poly: stackPoly(s), from: 0 }, ...slidBoxes(g, s)]),
  ];
  const tx = (FL.tineX0 + FL.tineX1) / 2, thx = (FL.tineX1 - FL.tineX0) / 2;
  if (g.lifting >= 0) { // the truck on the tines is part of this one: walls, trucks and stacks stop it too
    const v = g.root.trucks[g.lifting], p = riderPose(g.truck, v), c = toWorld(p, BODY_MID, 0);
    shapes.push({ poly: rectPoly(c.x, c.y, (FL.front - FL.back) / 2, FL.halfW, p.a), stackFilter: (s) => s.layers.length > g.H + v.rideLv, targets: (s) => [{ poly: stackPoly(s), from: 0 }] });
    const vc = carriedPoly({ ...v, fl: p });
    if (vc) shapes.push({ poly: vc, stackFilter: (s) => s.layers.length > g.H + v.rideLv + v.H, targets: (s) => [{ poly: stackPoly(s), from: 0 }] });
  }
  if (g.carried) {
    const c = carriedCenter(g);
    shapes.push({ poly: boxPoly(c.x, c.y, f.a + g.carriedRel, g.carriedPen?.[0]), stackFilter: (s) => s.layers.length > g.H, carried: true, targets: boxes(g.H) });
  }
  const blocks = (s) => s.layers.length > g.H && s.pen?.[g.H]?.barrelPart !== 'top' && g.hard;
  const tineTargets = (s) => palletRunners(g, s).map((poly) => ({ poly, from: g.H }));
  for (const side of [-1, 1]) shapes.push({ ...mk(tx, side * FL.tineOff, thx, FL.tineHalf, blocks, tineTargets), tine: true });
  return shapes;
}

function catchFallingBoxes(g, S, from) {
  const count = S.layers.length - from;
  if (!g.hard || g.carried || g.lifting >= 0 || g.H !== from || g.H + count >= CEILING_LEVELS) return false;
  if (S.pen[from]?.wide && Math.abs(Math.sin(g.fl.a - S.rots[from])) > WIDE_ALIGN) return false;
  const c = boxPos(S, from), local = toLocal(g.fl, c.x, c.y);
  if (Math.abs(local.x - FL.carryX) >= 0.55 || Math.abs(local.y) >= 0.5) return false;
  const box = boxPoly(c.x, c.y, S.rots[from], S.pen[from]);
  const tines = forkShapes(g).filter((shape) => shape.tine);
  if (tines.length !== 2 || !tines.every((tine) => sat(box, tine.poly))) return false;

  liftBoxes(g, S, from);
  return true;
}

function liftBoxes(g, S, from) {
  g.carriedOffs = S.offs.splice(from).map((o) => {
    const l = toLocal(g.fl, S.x + o.x, S.y + o.y);
    return { x: l.x - FL.carryX, y: l.y };
  });
  g.carried = S.layers.splice(from);
  g.carriedRots = S.rots.splice(from).map((r) => r - g.fl.a);
  g.carriedPen = S.pen.splice(from);
  g.carriedRel = g.carriedRots[0];
  if (!S.layers.length) g.stacks.splice(g.stacks.indexOf(S), 1);
}

// A pallet is three runners along the box's local x axis (perpendicular to its tape) with a slot for each tine between them,
// so tines only fit when driving along that axis (either way); from the sides they hit the runners.
function palletRunners(g, s) {
  ensure(s);
  const k = g.H, ang = s.rots[k], c = boxPos(s, k);
  const ux = Math.cos(ang), uy = Math.sin(ang);
  return palletRunnerDims(s.pen[k]).map(([off, hw]) => rectPoly(c.x - uy * off, c.y + ux * off, BOX_HALF_X, hw, ang));
}

// Pushing a stack off its centre turns it by the lever arm of the push (the boxes from `from` upward).
// `tip` is the pushing shape's vertex deepest into the stack, (nx, ny) the push direction, (sx, sy) how far it moved the stack.
function spinStack(s, from, tip, nx, ny, sx, sy) {
  if (s.pen?.[from]?.barrelPart === 'top') from--;
  const c = boxPos(s, from);
  const rx = tip.x - c.x, ry = tip.y - c.y;
  const raw = ((rx * ny - ry * nx) * Math.hypot(sx, sy)) / (rx * rx + ry * ry + PALLET_INERTIA * (wideBox(s.pen) ? 2.5 : 1));
  const da = Math.max(-0.01, Math.min(0.01, raw));
  s.rots = s.rots.map((r, i) => (i >= from ? r + da : r));
  if (from === 0) s.a = (s.a || 0) + da;
}

// A hard hit shoves the upper boxes of a stack further than the bottom one (they have more lever arm and nothing
// holds them), nudging them off the boxes below; settle() then drops the ones left without enough support.
const NUDGE_K = 0.06; // tiles per squared box height per tile/s of impact speed
function nudgeStack(g, s, from, dx, dy, speed) {
  if (speed < CRASH_MIN_SPEED || s.layers.length < 2 || g.clock - (s.nudgeAt ?? -1) < CRASH_COOLDOWN) return;
  s.nudgeAt = g.clock;
  ensure(s);
  const len = Math.hypot(dx, dy) || 1;
  for (let j = Math.max(1, from + 1); j < s.layers.length; j++) {
    if (s.pen[j]?.barrelPart === 'top') continue;
    const n = NUDGE_K * speed * (j - from) ** 2;
    s.offs[j].x += (dx / len) * n; s.offs[j].y += (dy / len) * n;
    if (s.pen[j]?.barrelPart === 'base' && s.pen[j + 1]?.barrelPart === 'top') s.offs[j + 1] = { ...s.offs[j] };
  }
  settle(g, s);
}

const deepest = (poly, nx, ny) => poly.reduce((t, p) => (p.x * nx + p.y * ny > t.x * nx + t.y * ny ? p : t), poly[0]);

function shiftPoly(poly, dx, dy) {
  for (const p of poly) { p.x += dx; p.y += dy; }
}

const CARRIED_TURN_MAX = 0.35; // rad a carried stack can twist on the forks away from square to them

// Turns the carried stack about its centre by the lever arm of a wall's push (tip = contact point, (m.x, m.y) = push-out normal).
function turnCarried(g, tip, m) {
  const c = carriedCenter(g);
  const rx = tip.x - c.x, ry = tip.y - c.y;
  const raw = (rx * m.y - ry * m.x) * m.depth / (rx * rx + ry * ry + PALLET_INERTIA);
  twistCarried(g, Math.max(-0.01, Math.min(0.01, raw)));
}

function twistCarried(g, da) {
  const q = Math.PI / 2, wrap = (a) => ((a + q / 2) % q + q) % q - q / 2;
  const rel0 = wrap(g.carriedRel);
  const rel = Math.max(-CARRIED_TURN_MAX, Math.min(CARRIED_TURN_MAX, rel0 + da));
  const d = rel - rel0;
  const before = g.carried.map((_, i) => {
    const o = g.carriedOffs[i] || { x: 0, y: 0 };
    return boxPoly(FL.carryX + o.x, o.y, g.carriedRots[i] ?? g.carriedRel, g.carriedPen[i]);
  });
  const after = g.carried.map((_, i) => {
    const o = g.carriedOffs[i] || { x: 0, y: 0 };
    return boxPoly(FL.carryX + o.x, o.y, (g.carriedRots[i] ?? g.carriedRel) + d, g.carriedPen[i]);
  });
  for (let i = 0; i < after.length; i++) {
    const back = Math.min(FL.front, ...before[i].map((v) => v.x));
    if (after[i].some((v) => v.x < back - 1e-9)) return;
    if (i > 0 && overlapArea(after[i], after[i - 1]) < Math.min(MIN_SUPPORT * boxArea(g.carriedPen[i]), overlapArea(before[i], before[i - 1])) - 1e-9) return;
  }
  g.carriedRel += d;
  g.carriedRots = g.carriedRots.map((r) => r + d);
}

const WALL_GAP = 1e-7;

function supportedShift(polys, pens, from, dx, dy) {
  if (from === 0) return true;
  const p = polys[from], below = polys[from - 1];
  const need = Math.min(MIN_SUPPORT * boxArea(pens[from]), overlapArea(p, below));
  return overlapArea(p.map((v) => ({ x: v.x + dx, y: v.y + dy })), below) >= need - 1e-9;
}

// Only the bottom pallet slides along the tines; upper boxes can slide across their support.
function slideCarried(g, from, m) {
  if (g.carriedPen[from]?.barrelPart === 'top') from--;
  const c = Math.cos(g.fl.a), sn = Math.sin(g.fl.a), nx = m.x * c + m.y * sn;
  let dx = nx * (m.depth + WALL_GAP), dy = (-m.x * sn + m.y * c) * (m.depth + WALL_GAP);
  if (from === 0) {
    if (nx >= -1e-6) return;
    dx = (m.depth + WALL_GAP) / nx; dy = 0;
  }
  while (g.carriedOffs.length < g.carried.length) g.carriedOffs.push({ x: 0, y: 0 });
  const local = g.carried.map((_, i) => {
    const o = g.carriedOffs[i];
    return boxPoly(FL.carryX + o.x, o.y, g.carriedRots[i] ?? g.carriedRel, g.carriedPen[i]);
  });
  const world = g.carried.map((_, i) => carriedPoly(g, i));
  const obstacles = world.map((_, i) => {
    const out = g.walls.map((w) => w.poly);
    for (const s of g.stacks) {
      const k = g.H + i;
      if (s.ghost?.includes(g.truck.id) || k < 0 || k >= s.layers.length) continue;
      const p = boxPos(s, k);
      out.push(boxPoly(p.x, p.y, s.rots[k], s.pen[k]));
    }
    for (const o of otherTrucks(g)) {
      if (ghostBetween(g, g.truck.id, o.truck.id) || o.liftedBy === g.truck.id) continue;
      out.push(bodyPoly(o));
      const k = g.H + i - o.H;
      if (o.carried && k >= 0 && k < o.carried.length) out.push(carriedPoly(o, k));
    }
    return out.map((poly) => ({ poly, depth: sat(world[i], poly)?.depth || 0 }));
  });
  const safe = (fraction) => {
    const x = dx * fraction, y = dy * fraction;
    if (!supportedShift(local, g.carriedPen, from, x, y)) return false;
    for (let i = from; i < local.length; i++) {
      const p = local[i].map((v) => ({ x: v.x + x, y: v.y + y }));
      const back = Math.min(...local[i].map((v) => v.x));
      if (Math.min(...p.map((v) => v.x)) < Math.min(FL.front + WALL_GAP, back) - 1e-9) return false;
      if (i === 0 && ![-1, 1].every((side) => sat(p, rectPoly((FL.tineX0 + FL.tineX1) / 2, side * FL.tineOff, (FL.tineX1 - FL.tineX0) / 2, FL.tineHalf)))) return false;
      const wp = world[i].map((v) => ({ x: v.x + x * c - y * sn, y: v.y + x * sn + y * c }));
      if (obstacles[i].some((o) => (sat(wp, o.poly)?.depth || 0) > o.depth + 1e-9)) return false;
    }
    return true;
  };
  let fraction = 1;
  if (!safe(1)) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (safe(mid)) lo = mid; else hi = mid;
    }
    fraction = lo;
  }
  for (let i = from; i < g.carried.length; i++) {
    g.carriedOffs[i].x += dx * fraction; g.carriedOffs[i].y += dy * fraction;
  }
}

function resolveTruckWalls(g, shapes, moveF, effects = true) {
  let changed = false;
  const hit = (poly, m, dx, dy) => {
    if (!effects) return;
    const tip = deepest(poly, -m.x, -m.y);
    g.contact = { x: tip.x, y: tip.y, nx: m.x, ny: m.y };
    if (dx || dy) {
      g.impacts.push({ x: tip.x, y: tip.y, nx: m.x, ny: m.y, w: 1 });
      const wp = g.wallPush || (g.wallPush = { x: 0, y: 0 });
      wp.x += dx; wp.y += dy;
    }
  };
  for (const sh of shapes) {
    if (sh.carried) continue;
    for (const w of g.walls) {
      const m = sat(sh.poly, w.poly);
      if (!m) continue;
      changed = true;
      const dx = m.x * (m.depth + WALL_GAP), dy = m.y * (m.depth + WALL_GAP);
      hit(sh.poly, m, dx, dy);
      moveF(dx, dy);
      if (effects && g.carried && sh.tine) {
        forgetInspection(g.carriedPen);
        if (Math.abs(g.fl.speed) < CRASH_MIN_SPEED) g.carriedAligning = true;
        else turnCarried(g, deepest(sh.poly, -m.x, -m.y), m);
      }
    }
  }
  for (let i = 0; i < (g.carried?.length || 0); i++) {
    for (const w of g.walls) {
      const poly = carriedPoly(g, i), m = sat(poly, w.poly);
      if (!m) continue;
      changed = true;
      forgetInspection(g.carriedPen);
      slideCarried(g, i, m);
      const remaining = sat(carriedPoly(g, i), w.poly);
      const dx = remaining ? remaining.x * (remaining.depth + WALL_GAP) : 0;
      const dy = remaining ? remaining.y * (remaining.depth + WALL_GAP) : 0;
      hit(poly, m, dx, dy);
      moveF(dx, dy);
      if (effects) {
        crash(g, g.carriedPen, g, g.carriedPen.length, { kind: 'c', dx: -m.x, dy: -m.y, rots: carriedRotsWorld(g) });
        if (Math.abs(g.fl.speed) < CRASH_MIN_SPEED) g.carriedAligning = true;
        else turnCarried(g, deepest(poly, -m.x, -m.y), m);
      }
    }
  }
  for (const sh of shapes) if (sh.carried) sh.poly = carriedPoly(g);
  return changed;
}

function resolveStackWalls(g, effects = true) {
  let changed = false;
  for (const s of g.stacks) {
    if (s.leaving) continue;
    ensure(s);
    for (let i = 0; i < s.layers.length; i++) {
      for (const w of g.walls) {
        const c = boxPos(s, i), r = Math.hypot(BOX_HALF_X, halfY(s.pen[i]));
        if (c.x + r < w.x || c.x - r > w.x + w.w || c.y + r < w.y || c.y - r > w.y + w.h) continue;
        const poly = boxPoly(c.x, c.y, s.rots[i], s.pen[i]), m = sat(poly, w.poly);
        if (!m) continue;
        changed = true;
        touchStack(s);
        const dx = m.x * (m.depth + WALL_GAP), dy = m.y * (m.depth + WALL_GAP);
        const from = s.pen[i]?.barrelPart === 'top' ? i - 1 : i;
        const polys = s.layers.map((_, j) => { const p = boxPos(s, j); return boxPoly(p.x, p.y, s.rots[j], s.pen[j]); });
        shiftBoxes(s, supportedShift(polys, s.pen, from, dx, dy) ? from : 0, dx, dy);
        if (!effects) continue;
        const sp = Math.abs(g.fl.speed);
        if (sp < CRASH_MIN_SPEED) g.wallAligning?.add(s);
        else spinStack(s, from, deepest(poly, -m.x, -m.y), m.x, m.y, dx, dy);
        if (sp >= CRASH_MIN_SPEED && g.clock - (s.wallHitAt ?? -1) >= CRASH_COOLDOWN) {
          s.wallHitAt = g.clock;
          dentBoxes(s.pen, s.pen.length, { kind: 'c', dx: -m.x, dy: -m.y, rots: s.rots });
        }
      }
    }
  }
  return changed;
}

// Alignment can swing a corner into a wall after the main collision pass.
function clearWallOverlaps(g) {
  for (let it = 0; it < 8; it++) {
    const shapes = forkShapes(g);
    const moved = resolveTruckWalls(g, shapes, (dx, dy) => {
      g.fl.x += dx; g.fl.y += dy;
      for (const sh of shapes) shiftPoly(sh.poly, dx, dy);
    }, false);
    const shifted = resolveStackWalls(g, false);
    if (!moved && !shifted) break;
  }
}

function resolve(g) {
  const f = g.fl;
  g.wallPush = null;
  g.contact = null;
  g.impacts = [];
  for (let it = 0; it < 8; it++) {
    const shapes = forkShapes(g);
    const moveF = (dx, dy) => {
      f.x += dx; f.y += dy;
      for (const sh of shapes) shiftPoly(sh.poly, dx, dy);
    };

    resolveTruckWalls(g, shapes, moveF);

    // Other trucks are solid (body and carried stack, not their tines) unless they are ghosts to this one; each moves half the overlap.
    for (const o of otherTrucks(g)) {
      if (Math.hypot(o.fl.x - f.x, o.fl.y - f.y) > 6 || ghostBetween(g, g.truck.id, o.truck.id) || o.truck.liftedBy === g.truck.id) continue;
      const theirCarried = carriedPoly(o.truck), theirs = [bodyPoly(o.truck), theirCarried].filter(Boolean);
      // carried stacks only touch when their height ranges overlap (a stack held above or below another passes it)
      const apart = g.carried && o.carried && (g.H >= o.H + o.carried.length || o.H >= g.H + g.carried.length);
      for (const sh of shapes) {
        if (sh.tine) continue;
        for (const q of theirs) {
          if (apart && sh.carried && q === theirCarried) continue;
          const m = sat(sh.poly, q);
          if (!m) continue;
          if (sh.carried) forgetInspection(g.carriedPen);
          if (q === theirCarried) forgetInspection(o.carriedPen);
          const d = m.depth * 0.5005;
          moveF(m.x * d, m.y * d);
          o.fl.x -= m.x * d; o.fl.y -= m.y * d;
          o.slip = 1;
          shiftPoly(q, -m.x * d, -m.y * d);
          const wp = g.wallPush || (g.wallPush = { x: 0, y: 0 });
          wp.x += m.x * d; wp.y += m.y * d;
          if (sh.carried) crash(g, g.carriedPen, g, g.carriedPen.length, { kind: 'c', dx: -m.x, dy: -m.y, rots: carriedRotsWorld(g) });
        }
      }
    }

    for (const s of g.stacks) {
      if (Math.abs(s.x - f.x) > 5 || Math.abs(s.y - f.y) > 5 || s.ghost?.includes(g.truck.id)) continue;
      const wf = 1 / FORKLIFT_MASS;
      for (const sh of shapes) {
        if (!sh.stackFilter || !sh.stackFilter(s)) continue;
        let m = null, from = 0;
        for (const t of sh.targets(s)) { m = sat(sh.poly, t.poly); if (m) { from = t.from; break; } }
        if (!m) continue;
        ensure(s);
        touchStack(s);
        if (sh.carried) forgetInspection(g.carriedPen);
        const ws = 1 / ((s.layers.length - from) * boxMass(s));
        if (!(f.speed > ALIGN_MIN_SPEED && f.speed < CRASH_MIN_SPEED && !sh.carried)) {
          const hit = sh.tine ? g.H : 0;
          crash(g, sh.tine ? s.pen.slice(hit, hit + 1) : s.pen, s, sh.tine ? 1 : s.pen.length,
            { kind: 's', dx: m.x, dy: m.y, rots: sh.tine ? s.rots.slice(hit, hit + 1) : s.rots });
        }
        if (sh.carried) crash(g, g.carriedPen, g, g.carriedPen.length, { kind: 's', dx: -m.x, dy: -m.y, rots: carriedRotsWorld(g) });
        if (!sh.carried && !sh.tine && f.speed > ALIGN_MIN_SPEED && f.speed < CRASH_MIN_SPEED) {
          const from = 0, to = Math.min(s.layers.length - 1, g.H + 1);
          if (from <= to) {
            const range = g.aligning?.get(s);
            g.aligning?.set(s, { from: Math.min(range?.from ?? from, from), to: Math.max(range?.to ?? to, to) });
          }
        }
        const d = m.depth * 1.001;
        moveF(m.x * d * (wf / (wf + ws)), m.y * d * (wf / (wf + ws)));
        if (!sh.tine && Math.abs(f.speed) >= CRASH_MIN_SPEED) {
          let tip = sh.poly[0];
          for (const p of sh.poly) if (p.x * m.x + p.y * m.y < tip.x * m.x + tip.y * m.y) tip = p;
          g.impacts.push({ x: tip.x, y: tip.y, nx: m.x, ny: m.y, w: wf / (wf + ws) });
        }
        const sx = -m.x * d * (ws / (wf + ws)), sy = -m.y * d * (ws / (wf + ws));
        shiftBoxes(s, from, sx, sy);
        if (sh.tine || Math.abs(f.speed) >= CRASH_MIN_SPEED) spinStack(s, from, deepest(sh.poly, -m.x, -m.y), -m.x, -m.y, sx, sy);
        if (!sh.tine) nudgeStack(g, s, from, -m.x, -m.y, Math.abs(f.speed));
        if (from > 0) settle(g, s);
      }
    }

    resolveStackWalls(g);

    for (let i = 0; i < g.stacks.length; i++) {
      for (let j = i + 1; j < g.stacks.length; j++) {
        const a = g.stacks[i], b = g.stacks[j];
        const rr = reach(a) + reach(b);
        if (Math.abs(a.x - b.x) >= rr || Math.abs(a.y - b.y) >= rr) continue;
        const m = sat(stackPoly(a), stackPoly(b));
        if (!m) continue;
        ensure(a); ensure(b);
        touchStack(a); touchStack(b);
        crash(g, a.pen, a, a.pen.length, { kind: 's', dx: -m.x, dy: -m.y, rots: a.rots });
        crash(g, b.pen, b, b.pen.length, { kind: 's', dx: m.x, dy: m.y, rots: b.rots });
        const wa = 1 / (a.layers.length * boxMass(a)), wb = 1 / (b.layers.length * boxMass(b));
        const d = m.depth * 1.001;
        const ax = m.x * d * (wa / (wa + wb)), ay = m.y * d * (wa / (wa + wb));
        const bx = -m.x * d * (wb / (wa + wb)), by = -m.y * d * (wb / (wa + wb));
        const pa = stackPoly(a), pb = stackPoly(b);
        spinStack(a, 0, deepest(pb, m.x, m.y), m.x, m.y, ax, ay);
        spinStack(b, 0, deepest(pa, -m.x, -m.y), -m.x, -m.y, bx, by);
        a.x += ax; a.y += ay;
        b.x += bx; b.y += by;
        const sp = Math.abs(f.speed);
        nudgeStack(g, a, 0, m.x, m.y, sp);
        nudgeStack(g, b, 0, -m.x, -m.y, sp);
      }
    }
  }
}

// A gentle contact squares only the stack boxes reached by the pushing forklift part.
function alignStack(g, s, dt, heading = g.fl.a, from = 0, to = s.layers.length - 1) {
  const q = Math.PI / 2, step = ALIGN_RATE * dt;
  const turn = (a) => {
    const diff = ((heading - a) % q + q * 1.5) % q - q / 2; // signed distance to nearest square angle
    return Math.max(-step, Math.min(step, diff));
  };
  ensure(s);
  const topTurn = turn(s.rots[to]);
  for (let i = from; i <= to; i++) s.rots[i] += turn(s.rots[i]);
  for (let i = to + 1; i < s.rots.length; i++) s.rots[i] += topTurn;
  if (from === 0) s.a = (s.a || 0) + turn(s.a || 0);
}

// A pallet on the tines is held sideways with the forks (the whole stack moves) but can still slide along them;
// only the boxes from the fork level upward turn with the forks.
function glideWithForks(g, S, ly, da, from) {
  touchStack(S);
  const f = g.fl;
  const ux = Math.cos(f.a), uy = Math.sin(f.a), rx = -uy, ry = ux;
  const c = boxPos(S, from);
  const along = c.x * ux + c.y * uy;
  const across = f.x * rx + f.y * ry + ly;
  S.x += ux * along + rx * across - c.x;
  S.y += uy * along + ry * across - c.y;
  S.rots = S.rots.map((r, i) => (i >= from ? r + da : r));
  if (from === 0) S.a = (S.a || 0) + da;
}

// Classifies this step's wall contact for sound. `kept` is the fraction of the intended forward motion that survived
// the collision: a big loss of speed counts a bonk (g.bonks, g.bonkPower 0..1), otherwise touching a wall while
// moving sets g.scrape (speed in tiles/s, 0 when not touching).
function wallContact(g, speed, kept) {
  g.scrape = 0;
  if (!g.wallPush) return;
  const v = Math.abs(speed), lost = 1 - kept;
  if (lost > BONK_LOSS && v > BONK_MIN_SPEED) {
    if (g.clock - g.bonkAt > BONK_COOLDOWN) {
      g.bonkAt = g.clock;
      g.bonks++;
      g.bonkPower = Math.min(1, v * lost / 4);
    }
  } else if (v > SCRAPE_MIN_SPEED) {
    g.scrape = v;
  }
}

const SLIP_DECAY = 2.5; // per second
const SLIP_MIN_PUSH = 0.15; // tiles/s a wall must shove a driven truck back for its tyres to spin
const SLIP_MAX_SPEED = 1.2; // faster than this it is a scrape along the wall, not wheelspin

// Tyre spin (0..1) this step: the driver is on the throttle or steering, yet a wall (or truck) keeps pushing the
// truck back, so the truck crawls instead of moving as driven (stuck against a wall, tail swinging into one).
function tireSlip(g, input, dt) {
  const wp = g.wallPush;
  if (!wp || !(input.up || input.down || input.left || input.right) || Math.abs(g.fl.speed) > SLIP_MAX_SPEED) return 0;
  const push = Math.hypot(wp.x, wp.y) / dt;
  return push < SLIP_MIN_PUSH ? 0 : Math.min(1, 0.4 + push / 1.5);
}

const SPIN_K = 3; // yaw kick per unit of off-centre impact
const SKID_K = 1.5; // sideways bounce kick away from the obstacle
const SPIN_DECAY = 3.5, SKID_DECAY = 3; // per second (tyre grip bleeds the motion off)
const MAX_SPIN = 2.5, MAX_SKID = 2;
const IMPACT_MIN_SPEED = 0.3;
const CENTRE_X = -0.7; // local x of the truck's centre of mass

// Hitting something off-centre while moving makes the truck pivot around the contact point (spin) and
// its tail/nose slide sideways away from the obstacle (skid); both fade quickly through tyre grip.
function impactKick(g, speed, dt) {
  const f = g.fl;
  if (!g.impacts.length) return;
  const c = toWorld(f, CENTRE_X, 0), vx = Math.cos(f.a) * speed, vy = Math.sin(f.a) * speed;
  for (const im of g.impacts) {
    const vn = -(vx * im.nx + vy * im.ny);
    if (vn < IMPACT_MIN_SPEED) continue;
    const arm = (im.x - c.x) * im.ny - (im.y - c.y) * im.nx;
    f.spin = clamp((f.spin || 0) + arm * vn * im.w * SPIN_K * dt, -MAX_SPIN, MAX_SPIN);
    f.sx = clamp((f.sx || 0) + im.nx * vn * im.w * SKID_K * dt, -MAX_SKID, MAX_SKID);
    f.sy = clamp((f.sy || 0) + im.ny * vn * im.w * SKID_K * dt, -MAX_SKID, MAX_SKID);
  }
}

function skidStep(f, dt) {
  if (!f.spin && !f.sx && !f.sy) return;
  f.a += (f.spin || 0) * dt;
  f.x += (f.sx || 0) * dt;
  f.y += (f.sy || 0) * dt;
  f.spin *= Math.exp(-SPIN_DECAY * dt); f.sx *= Math.exp(-SKID_DECAY * dt); f.sy *= Math.exp(-SKID_DECAY * dt);
  // keeps saved states compact; small values snap to 0 (rounding alone would freeze them, as one step's decay is below the rounding)
  const q = (v) => (Math.abs(v) < 0.03 ? 0 : Math.round(v * 1e3) / 1e3);
  f.spin = q(f.spin); f.sx = q(f.sx); f.sy = q(f.sy);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// The stack that appears in the fork gauge (tines in front of it): if it carries the inspector's "!" (see flaggedStacks), the picture the
// inspector took of it is shown again (`g.forkPhoto`, picked up by main.js).
function watchForkedStack(g) {
  const S = g.carried ? null : stackInZone(g);
  if (S === g.forkStack) return;
  g.forkStack = S;
  const f = S && flaggedStacks(g).find((q) => q.x === S.x && q.y === S.y);
  const ph = f && g.inspector.photos?.[f.key];
  if (ph) g.forkPhoto = { photo: ph };
}

// Steps the game. `input` drives the local truck; the other trucks use their `input` field (set by the host from the network).
export function update(g, input, dt) {
  const root = g.root;
  root.clock += dt;
  for (const s of root.stacks) {
    if (s.fall && root.clock - s.fall.t0 >= FALL_TIME) delete s.fall;
    if (s.jolt != null && root.clock - s.jolt >= JOLT_TIME) delete s.jolt;
  }
  if (root.hits) root.hits = root.hits.filter((h) => root.clock - h.t < hitLife(h));
  root.trucks.forEach((t, i) => { if (!t.gone) stepTruck(truckView(root, i), i === root.self ? input : t.input, dt); });
  if (root.trucks.length > 1) root.trucks.forEach((t, i) => {
    if (!t.gone && t.liftedBy < 0) clearWallOverlaps(truckView(root, i));
  });
  stepOil(root, dt);
  watchForkedStack(root);
  stepRepair(root, dt, root.trucks.flatMap((t, i) => (t.gone ? [] : [truckView(root, i).fl])));
  stepBot(root, dt, OIL_DROP_AREA);
  stepInspector(root, dt, root.zones.filter((z) => zoneDone(root, z)), (z) => stackForZone(root, z), (s, z) => {
    refreshPlacement(root, s, z);
    return s.pen.some((p) => placementLoss(root, p) > 0);
  });
  updateGhosts(root);
  if (root.status === 'play' && root.started) root.time += dt; // the level timer runs from the first move until solved
  scorePopups(root);
  if (root.status === 'play' && !root.endless && isFinished(root)) root.status = 'won';
}

// Honking sends out a shockwave from the truck's nose: every stack within WAVE_RADIUS (including the ones on any
// truck's forks) gets a "jump scare": the boxes shift and turn a little for real (`wiggleBoxes`) while the stack hops
// for a moment (`jolt` = clock of the honk, drawing only). The wiggle is bounded so that a box never leaves the box below.
const WAVE_RADIUS = 3.5, WAVE_COOLDOWN = 0.4, JOLT_TIME = 0.35;
const WIGGLE_MOVE = 0.05, WIGGLE_TURN = 0.06, WIGGLE_MAX_OFF = 0.12, WIGGLE_MAX_TURN = 0.12, WIGGLE_BOTTOM = 0.03, WIGGLE_SUPPORT = 0.8;
const noise = (i, k) => { const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return 2 * (v - Math.floor(v)) - 1; };

// Randomly shifts and turns boxes 1.. of a stack given as arrays (`offs` relative to any common origin, `rots` angles),
// keeping every box within WIGGLE_MAX_OFF / WIGGLE_MAX_TURN of the one below and on at least WIGGLE_SUPPORT of its
// area; if the result would break that the stack is left as it was.
function wiggleBoxes(offs, rots, pens, seed, k) {
  const o0 = offs.map((o) => ({ ...o })), r0 = rots.slice();
  for (let j = 1; j < offs.length; j++) {
    offs[j].x += WIGGLE_MOVE * k * noise(j, seed + 1); offs[j].y += WIGGLE_MOVE * k * noise(j, seed + 2);
    rots[j] += WIGGLE_TURN * k * noise(j, seed + 3);
    const dx = offs[j].x - offs[j - 1].x, dy = offs[j].y - offs[j - 1].y, m = Math.hypot(dx, dy);
    if (m > WIGGLE_MAX_OFF) { offs[j].x = offs[j - 1].x + (dx / m) * WIGGLE_MAX_OFF; offs[j].y = offs[j - 1].y + (dy / m) * WIGGLE_MAX_OFF; }
    rots[j] = rots[j - 1] + Math.max(-WIGGLE_MAX_TURN, Math.min(WIGGLE_MAX_TURN, rots[j] - rots[j - 1]));
  }
  for (let j = 1; j < offs.length; j++) {
    const a = boxPoly(offs[j].x, offs[j].y, rots[j], pens[j]), b = boxPoly(offs[j - 1].x, offs[j - 1].y, rots[j - 1], pens[j - 1]);
    if (overlapArea(a, b) < WIGGLE_SUPPORT * boxArea(pens[j])) { offs.forEach((o, i) => Object.assign(o, o0[i])); rots.splice(0, rots.length, ...r0); return; }
  }
}

function keepBarrelsRigid(pens, offs, rots) {
  for (let i = 0; i + 1 < pens.length; i++) {
    if (pens[i]?.barrelPart !== 'base' || pens[i + 1]?.barrelPart !== 'top') continue;
    offs[i + 1] = { ...offs[i] };
    rots[i + 1] = rots[i];
  }
}

function hornWave(root, t) {
  const o = toWorld(t.fl, 0.6, 0), seed = Math.round(root.clock * 1000);
  root.stacks.forEach((s, n) => {
    const d = Math.hypot(s.x - o.x, s.y - o.y);
    if (d >= WAVE_RADIUS) return;
    s.jolt = root.clock;
    ensure(s);
    touchStack(s);
    s.x += WIGGLE_BOTTOM * noise(n, seed + 4); s.y += WIGGLE_BOTTOM * noise(n, seed + 5);
    const da = WIGGLE_BOTTOM * noise(n, seed + 6);
    s.rots[0] += da; s.a = (s.a || 0) + da;
    wiggleBoxes(s.offs, s.rots, s.pen, seed + n * 7, 1);
    keepBarrelsRigid(s.pen, s.offs, s.rots);
  });
  for (const u of root.trucks) {
    if (u.gone || !u.carried) continue;
    const c = carriedCenter(u);
    if (Math.hypot(c.x - o.x, c.y - o.y) >= WAVE_RADIUS) continue;
    u.jolt = root.clock;
    forgetInspection(u.carriedPen);
    while (u.carriedOffs.length < u.carried.length) u.carriedOffs.push({ x: 0, y: 0 });
    while (u.carriedRots.length < u.carried.length) u.carriedRots.push(u.carriedRel);
    wiggleBoxes(u.carriedOffs, u.carriedRots, u.carriedPen, seed + u.id * 11, 1);
    keepBarrelsRigid(u.carriedPen, u.carriedOffs, u.carriedRots);
  }
}

function wheelOilGrip(g, x, side) {
  const p = toWorld(g.fl, x, side * (FL.halfW - 0.08));
  return (g.oil || []).some((spill) => Math.hypot(p.x - spill.x, p.y - spill.y) <= spill.r + 0.18) ? 0.3 : 1;
}

function axleOilGrip(g, x) {
  const left = wheelOilGrip(g, x, -1), right = wheelOilGrip(g, x, 1);
  return { grip: (left + right) / 2, imbalance: right - left };
}

function oilDrift(f, rear, dt) {
  const slip = 1 - rear.grip, speed = Math.abs(f.speed);
  if (!slip || speed < 0.25) return;
  const turn = f.speed * f.steer, turnSlip = slip * Math.min(1, Math.abs(turn) / 0.6);
  const yaw = -rear.imbalance * speed * 1.4 + Math.sign(turn) * turnSlip * speed * 2.2;
  f.spin = clamp((f.spin || 0) + yaw * dt, -MAX_SPIN, MAX_SPIN);
  const side = -Math.sign(turn) * turnSlip * Math.min(speed, 3) * 5 * dt;
  f.sx = clamp((f.sx || 0) - Math.sin(f.a) * side, -MAX_SKID, MAX_SKID);
  f.sy = clamp((f.sy || 0) + Math.cos(f.a) * side, -MAX_SKID, MAX_SKID);
}

const OIL_DROPS = 50, OIL_FULL_R = 1.15, OIL_DROP_AREA = OIL_FULL_R ** 2 / OIL_DROPS;

function dropOil(root, barrel) {
  const spill = { id: `${barrel.id}:${barrel.base.oilDropped}`, x: barrel.x, y: barrel.y, r: Math.sqrt(OIL_DROP_AREA), drops: 1 };
  // Radius squared measures area, so merging conserves oil volume.
  for (let i = 0; i < root.oil.length;) {
    const other = root.oil[i];
    if (Math.hypot(spill.x - other.x, spill.y - other.y) > spill.r + other.r) { i++; continue; }
    const a = spill.r ** 2, b = other.r ** 2;
    spill.x = (spill.x * a + other.x * b) / (a + b);
    spill.y = (spill.y * a + other.y * b) / (a + b);
    spill.r = Math.sqrt(a + b);
    spill.drops += other.drops ?? b / OIL_DROP_AREA;
    root.oil.splice(i, 1);
    i = 0;
  }
  root.oil.push(spill);
}

function stepOil(root, dt) {
  const barrels = [];
  const add = (pens, position) => {
    for (let i = 0; i + 1 < pens.length; i++) {
      const base = pens[i];
      if (base?.barrelPart !== 'base' || pens[i + 1]?.barrelPart !== 'top' || !base.barrelId) continue;
      const damage = Math.min(100, (base.crash || 0) + (pens[i + 1].crash || 0));
      if (damage > 0) barrels.push({ id: base.barrelId, base, damage, ...position(i) });
      i++;
    }
  };
  for (const s of root.stacks) {
    ensure(s);
    add(s.pen, (i) => boxPos(s, i));
  }
  for (const t of root.trucks) {
    if (!t.carried) continue;
    add(t.carriedPen || [], (i) => {
      const o = t.carriedOffs?.[i] || { x: 0, y: 0 };
      return toWorld(t.fl, FL.carryX + o.x, o.y);
    });
  }
  if (!barrels.length) return;
  root.oil ||= [];
  for (const barrel of barrels) {
    const base = barrel.base;
    base.oilDropped ??= 0;
    if (base.oilDropped >= OIL_DROPS) continue;
    base.oilFraction = (base.oilFraction || 0) + barrel.damage * dt / 10;
    while (base.oilFraction >= 1 - 1e-9 && base.oilDropped < OIL_DROPS) {
      base.oilFraction = Math.max(0, base.oilFraction - 1);
      base.oilDropped++;
      dropOil(root, barrel);
    }
    if (base.oilDropped === OIL_DROPS) base.oilFraction = 0;
  }
}

// Extra height (box heights, whole stack) `clock - t0` seconds after a jolt, or 0.
const joltHop = (clock, t0) => { const p = t0 == null ? 1 : (clock - t0) / JOLT_TIME; return p >= 0 && p < 1 ? 0.12 * Math.sin(Math.PI * p) : 0; };
export const carriedJoltZ = (g) => (g.carried ? joltHop(g.root.clock, g.truck.jolt) : 0);

function stepTruck(g, input, dt) {
  const f = g.fl;
  const hornOn = !!input.horn;
  if (hornOn && !g.horn && g.root.clock - (g.truck.waveAt ?? -1e9) >= WAVE_COOLDOWN) { g.truck.waveAt = g.root.clock; hornWave(g.root, g.truck); }
  g.horn = hornOn;
  if (g.liftedBy >= 0) { // riding on another truck's tines: no driving until it is put down
    const c = g.root.trucks[g.liftedBy];
    if (c && !c.gone) syncLifted(g.root, c);
    f.speed = 0;
    g.slip = 0;
    g.hf += Math.max(-6 * dt, Math.min(6 * dt, g.H - g.hf));
    return;
  }
  if (g.perchZ > 0) { // sitting on stacks: stays until lifted off; drops to the floor if the stacks are taken away
    g.perchZ = supportLevels(g.root, f);
    if (g.perchZ > 0) {
      f.speed = 0;
      g.slip = 0;
      g.hf += Math.max(-6 * dt, Math.min(6 * dt, g.H - g.hf));
      return;
    }
  }
  const forked = g.hard ? forkedStack(g) : null;
  const forkedY = forked ? toLocal(f, boxPos(forked, g.H).x, boxPos(forked, g.H).y).y : 0;
  const prevA = f.a;
  const frontGrip = axleOilGrip(g, FL.frontWheelX), rearGrip = axleOilGrip(g, -FL.L);
  const th = input.thr ?? (input.up ? 1 : 0) - (input.down ? 1 : 0);
  const str = input.str ?? (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const affected = frontGrip.grip < 1 || rearGrip.grip < 1;
  drive(f, affected
    ? { ...input, thr: th * (0.35 + frontGrip.grip * 0.65), str: str * rearGrip.grip }
    : input, dt, g.H);
  oilDrift(f, rearGrip, dt);
  skidStep(f, dt);
  if (f.speed !== 0) g.started = true; // the level timer starts when a truck first moves
  const driven = { x: f.x, y: f.y };
  const intended = f.speed * dt;
  g.aligning = new Map();
  g.wallAligning = new Set();
  g.carriedAligning = false;
  if (forked && f.a !== prevA) glideWithForks(g, forked, forkedY, f.a - prevA, g.H);
  const speed0 = f.speed;
  resolve(g);
  impactKick(g, speed0, dt);
  for (const [s, range] of g.aligning) alignStack(g, s, dt, g.fl.a, range.from, range.to);
  for (const s of g.wallAligning) alignStack(g, s, dt, 0); // walls are axis-aligned
  if (g.carried && g.carriedAligning) {
    const q = Math.PI / 2, diff = ((0 - g.carriedRel - f.a) % q + q * 1.5) % q - q / 2;
    twistCarried(g, Math.max(-ALIGN_RATE * dt, Math.min(ALIGN_RATE * dt, diff)));
  }
  clearWallOverlaps(g);

  if (Math.abs(intended) > 1e-6) {
    const actual = (f.x - driven.x) * Math.cos(f.a) + (f.y - driven.y) * Math.sin(f.a) + intended;
    const r = Math.max(0, Math.min(1, actual / intended));
    wallContact(g, f.speed, r);
    f.speed *= 1 - (1 - r) * Math.min(1, dt / 0.15);
  } else {
    g.scrape = 0;
  }

  g.slip = Math.max(tireSlip(g, input, dt), 1 - frontGrip.grip, 1 - rearGrip.grip, (g.slip || 0) - SLIP_DECAY * dt);
  if (g.lifting >= 0) syncLifted(g.root, g.truck);

  g.hf += Math.max(-6 * dt, Math.min(6 * dt, g.H - g.hf));
  g.ef += (g.hf - g.ef) * (1 - Math.exp(-dt / 0.22)); // cabin eye trails the forks
  // visual lowering of a just-released stack ends when the forks reach it
  for (const s of g.stacks) if (s.dropFrom != null && (s.dropTruck ?? 0) === g.truck.id && (g.hf <= s.dropFrom + 1e-3 || g.H > s.dropFrom)) delete s.dropFrom;
}

// Score popups are hits with `score` = { total } (points of the drop point's stack before wonkiness: shown when it is completed, negative when
// it is moved off) or { wonky } (signed score change from crooked placement or from nudging the stack more or less crooked). The two kinds pop
// up separately, so the stack score can fade while nudging keeps refreshing the wonkiness. A wonkiness popup still showing for the same drop
// point is merged into and refreshed. Zones already complete on the first call stay quiet.
function scorePopups(g) {
  const prev = g.zonePts;
  g.zonePts = g.zones.map((z) => zonePoints(g, z));
  if (!prev) return;
  const popup = (i, kind) => g.hits.find((h) => h.zone === i && h.score && kind in h.score);
  const drop = (h) => h && g.hits.splice(g.hits.indexOf(h), 1);
  g.zones.forEach((z, i) => {
    const was = prev[i], now = g.zonePts[i];
    const add = (n, score) => g.hits.push({ x: z.x, y: z.y, z: n, t: g.clock, owner: null, zone: i, score });
    if (was && !now) {
      drop(popup(i, 'total')); drop(popup(i, 'wonky'));
      add(was.n, { total: -was.base });
    } else if (!was && now) {
      add(now.n, { total: now.base });
      if (!g.hard && now.square) add(now.n, { wonky: -now.square });
    } else if (!g.hard && was && now && was.square !== now.square) {
      const old = popup(i, 'wonky');
      const change = was.square - now.square + (old ? old.score.wonky : 0);
      drop(old);
      if (change) add(now.n, { wonky: change });
    }
  });
}

export function stackInZone(g) {
  const f = g.fl;
  const o = g.carried ? g.carriedOffs?.[0] : null;
  let best = null, bd = Infinity;
  for (const s of g.stacks) {
    ensure(s);
    const i = g.carried ? s.layers.length - 1 : Math.min(g.H, s.layers.length - 1);
    const c = boxPos(s, i);
    const l = toLocal(f, c.x, c.y);
    const dx = Math.abs(l.x - FL.carryX - (o?.x || 0)), dy = Math.abs(l.y - (o?.y || 0));
    // a wide box is found while both tines are under it (centre within 0.6 of the middle of the forks)
    if (dx < 0.55 && dy < (s.pen?.[i]?.wide && !g.carried ? 0.6 : 0.5) && dx + dy < bd) { best = s; bd = dx + dy; }
  }
  return best;
}

// Fork level H (0..5) is a whole number of box heights above the floor, so a
// stack on the floor spans heights 0..n (layer i is between i-1 and i). The
// tines at level H are under the box at height H: raising the forks lifts
// every box at height H and above. Level 0 is the floor. Tines do not collide
// with boxes. A carried stack's bottom is at height H.
// The stack whose box at the current fork level the tines are in, or null.
function forkedStack(g) {
  const S = stackInZone(g);
  if (S) ensure(S);
  return S && S.layers.length > g.H && S.pen[g.H]?.barrelPart !== 'top' ? S : null;
}

// Moves the boxes from index `k` up of the stack on `from`'s forks onto `to`'s forks (k > 0 splits the stack), keeping their
// world positions and angles. With `onto` they are put on top of the stack `to` already carries instead.
function transferCarried(from, to, k = 0, onto = false) {
  const n = from.carried.length;
  while (from.carriedPen.length < n) from.carriedPen.push(newPen(from.carried[from.carriedPen.length], from.carriedPen.length));
  while (from.carriedRots.length < n) from.carriedRots.push(from.carriedRel);
  while (from.carriedOffs.length < n) from.carriedOffs.push({ x: 0, y: 0 });
  const d = from.fl.a - to.fl.a;
  const offs = from.carriedOffs.slice(k).map((_, i) => {
    const p = carriedCenter(from, k + i), l = toLocal(to.fl, p.x, p.y);
    return { x: l.x - FL.carryX, y: l.y };
  });
  const rots = from.carriedRots.slice(k).map((r) => r + d);
  const layers = from.carried.slice(k), pen = from.carriedPen.slice(k);
  if (onto) {
    to.carried = to.carried.concat(layers);
    to.carriedPen = to.carriedPen.concat(pen);
    to.carriedRots = to.carriedRots.concat(rots);
    while (to.carriedOffs.length < to.carried.length - layers.length) to.carriedOffs.push({ x: 0, y: 0 });
    to.carriedOffs = to.carriedOffs.concat(offs);
  } else {
    to.carried = layers;
    to.carriedPen = pen;
    to.carriedRots = rots;
    to.carriedOffs = offs;
    to.carriedRel = rots[0];
  }
  if (k > 0) {
    from.carried = from.carried.slice(0, k);
    from.carriedRots = from.carriedRots.slice(0, k);
    from.carriedPen = from.carriedPen.slice(0, k);
    from.carriedOffs = from.carriedOffs.slice(0, k);
  } else {
    from.carried = null;
    from.carriedRots = [];
    from.carriedPen = [];
    from.carriedOffs = [];
  }
}

const atCarryPoint = (g, o, from = 0, onto = -1) => {
  const p = carriedCenter(g, from), l = toLocal(o.fl, p.x, p.y), base = o.carriedOffs?.[onto];
  return Math.abs(l.x - FL.carryX - (base?.x || 0)) < 0.55 && Math.abs(l.y - (base?.y || 0)) < 0.5;
};

// Trucks hand stacks over on their tines. A truck whose empty tines are under another truck's carried stack takes it by raising
// the tines up to its height (from below) or, with the tines inside the stack, takes the boxes from that level up and leaves the
// rest on the other forks. A truck lowering a carried stack over another truck's tines gives it away, or puts it on top of the
// stack that truck carries (max 5 layers). Ghosts to each other never trade.
function stackOnMyTines(g) {
  for (const o of otherTrucks(g)) {
    if (!o.carried || wideBox(o.carriedPen) || o.H > g.H + 1 || g.H >= o.H + o.carried.length || ghostBetween(g, g.truck.id, o.truck.id)) continue;
    const k = Math.max(g.H, o.H) - o.H;
    if (o.carriedPen[k]?.barrelPart === 'top') continue;
    if (atCarryPoint(o, g, k)) return o;
  }
  return null;
}

function tinesUnderMyStack(g) {
  for (const o of otherTrucks(g)) {
    if (wideBox(g.carriedPen) || wideBox(o.carriedPen) || ghostBetween(g, g.truck.id, o.truck.id) || !atCarryPoint(g, o, 0, (o.carried?.length || 0) - 1)) continue;
    if (!o.carried && o.H <= g.H) return o;
    if (o.carried && o.H + o.carried.length <= g.H && o.carried.length + g.carried.length <= MAX_LAYERS && !blocksStacking(o.carriedPen)) return o;
  }
  return null;
}

// Raising a truck (and the stack it carries) into the ceiling is refused and damages that stack.
function liftBlocked(g, v, hit = false) {
  const extent = v.carried ? Math.max(1, v.H + v.carried.length) : 1;
  if (!hit && g.H + extent < CEILING_LEVELS) return false;
  if (v.carried) {
    while (v.carriedPen.length < v.carried.length) v.carriedPen.push(newPen(v.carried[v.carriedPen.length], v.carriedPen.length));
    const c = carriedCenter(v);
    hurt(g, v.carriedPen, CEILING_POINTS, c.x, c.y, g.H + v.H + v.carried.length, v);
    addDent(v.carriedPen[v.carriedPen.length - 1], 't');
  }
  return true;
}

// The standing truck whose side the empty tines (on the floor) are under, or null. Only from the side: the lifter must be
// roughly perpendicular to it, with the carry point under the middle of its body. Trucks that are already lifting/lifted or
// carry boxes cannot be taken.
function truckOnMyTines(g) {
  for (const o of otherTrucks(g)) {
    if (o.truck.liftedBy >= 0 || o.truck.lifting >= 0 || g.H !== (o.truck.perchZ || 0) || ghostBetween(g, g.truck.id, o.truck.id)) continue;
    if (Math.abs(Math.cos(o.fl.a - g.fl.a)) > LIFT_SIDEWAYS) continue;
    const p = toWorld(g.fl, FL.carryX, 0), l = toLocal(o.fl, p.x, p.y);
    if (Math.abs(l.x - BODY_MID) < LIFT_GRIP && Math.abs(l.y) < FL.halfW) return o;
  }
  return null;
}

// A perched truck sitting on top of stack S (the one that goes with the boxes lifted off it), or null.
function perchedOn(g, S) {
  const top = S.layers.length;
  for (const o of otherTrucks(g)) {
    if (o.truck.perchZ !== top || o.truck.liftedBy >= 0) continue;
    const c = toWorld(o.fl, BODY_MID, 0);
    if (sat(rectPoly(c.x, c.y, (FL.front - FL.back) / 2, FL.halfW, o.fl.a), stackPoly(S))) return o;
  }
  return null;
}

// Raising carried boxes into the ceiling is refused ('blocked') and damages every carried box.
export function forkUp(g) {
  if (stuck(g)) return;
  if (!g.carried && g.lifting < 0 && !forkedStack(g)) {
    const o = truckOnMyTines(g);
    if (o) {
      if (liftBlocked(g, o)) return 'blocked';
      o.truck.liftedBy = g.truck.id;
      o.truck.perchZ = 0;
      g.truck.lifting = o.truck.id;
      o.truck.liftRel = Math.sin(o.fl.a - g.fl.a) >= 0 ? Math.PI / 2 : -Math.PI / 2;
      o.fl.speed = 0;
      g.H = Math.min(MAX_H, g.H + 1);
      syncLifted(g.root, g.truck);
      return;
    }
  }
  if (g.lifting >= 0 && !g.carried) {
    const v = truckView(g.root, g.lifting);
    return liftBlocked(g, v) ? 'blocked' : void (g.H = Math.min(MAX_H, g.H + 1));
  }
  if (!g.carried) {
    const o = stackOnMyTines(g);
    if (o) {
      g.H = Math.max(g.H, o.H);
      transferCarried(o, g, g.H - o.H);
      return;
    }
  }
  if (g.carried) {
    const rider = g.lifting >= 0 ? truckView(g.root, g.lifting) : null; // a truck sitting on the carried stack
    if (g.H + g.carried.length + (rider ? (rider.carried ? Math.max(1, rider.H + rider.carried.length) : 1) : 0) >= CEILING_LEVELS) {
      if (rider?.carried) liftBlocked(g, rider, true);
      while (g.carriedPen.length < g.carried.length) g.carriedPen.push(newPen(g.carried[g.carriedPen.length], g.carriedPen.length));
      const c = carriedCenter(g);
      hurt(g, g.carriedPen, CEILING_POINTS, c.x, c.y, g.H + g.carried.length, g);
      addDent(g.carriedPen[g.carriedPen.length - 1], 't');
      return 'blocked';
    }
    g.H = Math.min(MAX_H, g.H + 1);
    return;
  }
  const S = forkedStack(g);
  if (S) {
    const k = g.H;
    if (S.pen?.[k]?.wide && Math.abs(Math.sin(g.fl.a - S.rots[k])) > WIDE_ALIGN) return 'blocked'; // the tines don't both fit under it
    const rider = perchedOn(g, S);
    liftBoxes(g, S, k);
    if (rider) { // a truck perched on top of the stack rides along on it
      const l = toLocal(g.fl, rider.fl.x, rider.fl.y);
      rider.truck.liftedBy = g.truck.id;
      rider.truck.perchZ = 0;
      rider.truck.rideLv = g.carried.length;
      rider.truck.rideOff = { x: l.x, y: l.y, a: rider.fl.a - g.fl.a };
      g.truck.lifting = rider.truck.id;
    }
  }
  g.H = Math.min(MAX_H, g.H + 1);
}

// The box that empty forks at level g.H cannot be lowered through, or null (also null while carrying).
function boxUnderForks(g) {
  if (g.carried || g.H <= 0) return null;
  const S = stackInZone(g);
  return S && S.layers.length >= g.H ? S : null;
}

// Holding "lower": drops the forks to the lowest safe level in one go. Stops at the floor, when a carried stack is put down
// (or handed over) and above a box the empty forks cannot pass; never damages anything.
export function forkDownAll(g) {
  while (g.H > 0 && !boxUnderForks(g)) {
    const h = g.H, carried = g.carried, lifting = g.lifting >= 0;
    forkDown(g);
    if (g.H === h || (carried && !g.carried) || (lifting && g.lifting < 0)) break;
  }
}

// Lowering empty forks through a box is refused ('blocked') and damages that box.
export function forkDown(g) {
  if (stuck(g)) return;
  if (g.lifting >= 0 && !g.carried) { // the lifted truck is set down on the floor, or on the stacks under it, when the tines reach it
    const v = g.root.trucks[g.lifting], n = supportLevels(g.root, liftedPose(g.truck, v.liftRel));
    if (g.H > n) g.H--;
    if (g.H <= n) {
      v.perchZ = n;
      releaseLifted(g.root, g.truck);
    }
    return;
  }
  if (g.carried) {
    const o = tinesUnderMyStack(g);
    const rest = o ? o.H + (o.carried ? o.carried.length : 0) : 0;
    if (o && g.H - 1 <= rest) {
      transferCarried(g, o, 0, !!o.carried);
      g.H = Math.max(0, g.H - 1);
      return;
    }
  }
  if (!g.carried) {
    const S = boxUnderForks(g);
    if (S) {
      ensure(S);
      hurt(g, [S.pen[g.H - 1]], FORK_BLOCK_POINTS, S.x, S.y, g.H, S);
      addDent(S.pen[g.H - 1], 't');
      return 'blocked';
    }
    g.H = Math.max(0, g.H - 1);
    return;
  }
  const S = stackInZone(g);
  if (S) ensure(S);
  const n = S ? S.layers.length : 0;
  const cp = carriedCenter(g);
  const minH = n + g.carried.length <= MAX_LAYERS && !(S && (blocksStacking(S.pen) || wideBox(S.pen) !== wideBox(g.carriedPen))) ? n : n + 1;
  if (g.H > minH) g.H = Math.max(minH, g.H - 1);
  // Reaching the resting height puts the boxes down.
  if (g.H === n && minH === n) {
    while (g.carriedPen.length < g.carried.length) g.carriedPen.push(newPen(g.carried[g.carriedPen.length], g.carriedPen.length));
    while (g.carriedRots.length < g.carried.length) g.carriedRots.push(g.carriedRel);
    const worldRots = g.carriedRots.map((r) => r + g.fl.a);
    g.carriedPen.forEach((p, i) => { p.sq = squareLoss(worldRots[i]); });
    const p = toWorld(g.fl, FL.carryX, 0);
    while (g.carriedOffs.length < g.carried.length) g.carriedOffs.push({ x: 0, y: 0 });
    const world = carriedWorldOffs(g);
    if (S) {
      S.layers.push(...g.carried);
      S.rots.push(...worldRots);
      S.pen.push(...g.carriedPen);
      S.offs.push(...world.map((o) => ({ x: p.x + o.x - S.x, y: p.y + o.y - S.y })));
      S.dropFrom = n;
      S.dropTruck = g.truck.id;
      settle(g, S);
    } else {
      const base = world[0], offs = world.map((o) => ({ x: o.x - base.x, y: o.y - base.y }));
      g.stacks.push({ x: cp.x, y: cp.y, layers: g.carried, rots: worldRots, pen: g.carriedPen, offs, a: g.fl.a + g.carriedRel, dropFrom: 0, dropTruck: g.truck.id });
      if (g.carried.length === 1 && repairable(g.carriedPen[0])) recordDropAngle(g, cp.x, cp.y, worldRots[0]);
    }
    g.carried = null;
    g.carriedRots = [];
    g.carriedPen = [];
    g.carriedOffs = [];
    if (g.lifting >= 0) releaseLifted(g.root, g.truck); // a truck that rode on the stack stays perched on it
  }
}

const PARK_POS = 0.6, PARK_ANGLE = 0.35, PARK_SPEED = 0.5;

export function isParked(g) {
  const f = g.fl, p = g.parking;
  const c = toWorld(f, (FL.back + FL.front) / 2, 0);
  let da = (f.a - p.a) % (2 * Math.PI);
  if (da > Math.PI) da -= 2 * Math.PI;
  if (da < -Math.PI) da += 2 * Math.PI;
  return Math.hypot(c.x - p.x, c.y - p.y) < PARK_POS && Math.abs(da) < PARK_ANGLE && Math.abs(f.speed) < PARK_SPEED;
}

// A level is finished: every zone filled and a forklift (any player's) back in its parking spot.
export function isFinished(g) {
  return isSolved(g) && g.root.trucks.some((t, i) => !t.gone && isParked(truckView(g.root, i)));
}

export function isSolved(g) {
  return g.zones.every((z) => zoneDone(g, z));
}

const stackFillsZone = (s, z) => {
  const barrel = z.color === BARREL_COLOR;
  const matchesLoad = barrel
    ? z.count === 1 && s.layers.length === 2 && s.layers.every((c) => c === BARREL_COLOR) &&
      s.pen?.[0]?.barrelPart === 'base' && s.pen?.[1]?.barrelPart === 'top'
    : s.layers.length === z.count && s.layers.every((c) => c === z.color);
  return Math.abs(s.x - z.x) < 0.5 &&
    Math.abs(s.y - z.y) < 0.5 &&
    matchesLoad &&
    !!z.wide === wideBox(s.pen) &&
    (!z.wide || Math.abs(Math.sin((s.a || 0) - (z.a || 0))) < 0.4);
};

const stackForZone = (g, z) => g.stacks.find((s) => stackFillsZone(s, z));

// A completed drop point holds a stack with placement points lost.
export function zoneWonky(g, z) {
  return (zonePoints(g, z)?.square || 0) > 0;
}

// Points of the stack completing zone z: `base` (max for the stack: what the popup shows, since crash damage is already in the live score), `total` (base minus crash and crooked placement `square`); null while the zone is open.
export function zonePoints(g, z, reportedOnly = false) {
  const S = stackForZone(g, z);
  if (!S) return null;
  const reveal = showPlacement(g, S, z, reportedOnly);
  refreshPlacement(g, S, z);
  const crash = S.pen.reduce((n, p) => n + p.crash, 0), square = reveal ? S.pen.reduce((n, p) => n + placementLoss(g, p), 0) : 0;
  const base = S.pen.reduce((n, p) => n + boxPoints(p), 0);
  return { n: S.layers.length, base, total: base - Math.round(crash) - Math.round(square), crash: Math.round(crash), square: Math.round(square) };
}

// The pictures for the end-of-level gallery: one for every drop point's stack, each with the `score` that stack contributed
// (`zonePoints`: base minus damage and wonkiness), the stack that has been dormant longest (oldest picture) first. The inspector's own
// photo is used when it took one, otherwise a picture is faked from the stack (seen from a corner, like the inspector would).
const endCache = new WeakMap();
export function endPhotos(g) {
  const out = [];
  for (const z of g.zones) {
    const S = stackForZone(g, z), pts = zonePoints(g, z);
    if (!S || !pts) continue;
    const photo = (!g.hard || hasReport(g, S, z)) && g.inspector?.photos?.[inspectionKey(z)], src = photo || S;
    if (!endCache.has(src)) {
      const base = photo || makePhoto(S, !pts.crash && !pts.square, Math.PI / 4 + (S.rots?.[0] ?? 0), 1.4, 0, g.clock);
      endCache.set(src, { ...base, score: { base: pts.base, crash: pts.crash, square: pts.square, total: pts.total } }); // one object per picture, so the gallery can tell which are up
    }
    out.push(endCache.get(src));
  }
  return out.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}

// Stacks the inspector judged "could be better": photographed (in `inspector.seen`) and still crooked or damaged. Each `{x, y, h, key, wonky, damaged}` (h = boxes high, wonky = crooked boxes, damaged = repairable crash damage, key = the drop point's key in `inspector.seen`/`inspector.photos`).
export function flaggedStacks(g) {
  const out = [];
  for (const z of g.zones) {
    const key = inspectionKey(z);
    if (!g.inspector?.seen.includes(key)) continue;
    const s = stackForZone(g, z);
    if (!s || s.touched || (g.hard && !hasReport(g, s, z))) continue;
    if (!g.hard && g.inspector.sigs?.[key] !== undefined && g.inspector.sigs[key] !== stackSig(s)) continue; // touched since the photo
    refreshPlacement(g, s, z);
    const wonky = s.pen.some((p) => placementLoss(g, p) > 0);
    const damaged = s.pen.some((p) => p.crash > 0 && repairable(p));
    if (wonky || damaged) out.push({ x: s.x, y: s.y, h: s.layers.length, key, wonky, damaged });
  }
  return out;
}

// Which symbol a flagged stack shows: 'wonky' or 'damaged'; a stack with both alternates every FLAG_SWAP seconds (by the game clock, so every view agrees).
export const FLAG_SWAP = 1;
export function flagSymbol(f, clock) {
  if (f.wonky && f.damaged) return Math.floor(clock / FLAG_SWAP) % 2 ? 'damaged' : 'wonky';
  return f.damaged ? 'damaged' : 'wonky';
}

export function zoneDone(g, z) {
  return g.stacks.some((s) => stackFillsZone(s, z));
}

// Where the overview paints a zone's "×count": just below the zone, or above it when a wall (e.g. the south border) would cover that spot.
// The choice is shared by every drop point of the drop-off area, so a row of labels never mixes above and below.
export function zoneLabelPos(g, z) {
  const hit = (x, y) => g.walls.some((w) => x + 0.4 > w.x && x - 0.4 < w.x + w.w && y + 0.25 > w.y && y - 0.25 < w.y + w.h);
  const off = (o) => zoneExt(o).y + 0.32;
  const mates = g.zones.filter((o) => o.color === z.color);
  const southWall = mates.some((o) => hit(o.x, o.y + off(o)));
  const above = southWall && !hit(z.x, z.y - off(z));
  return { x: z.x, y: above ? z.y - off(z) : z.y + off(z) };
}
