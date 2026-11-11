import { boxDecalKind } from './decals.js';
import { rectPoly, sat, overlapArea } from './geom.js';
import { FL, MAX_H, MAX_LAYERS, MAX_PLAYERS, makeForklift, drive, toWorld, toLocal } from './forklift.js';
import { addDent, dentIndex, toLocalDir } from './dents.js';
import { generateLevel } from './level.js';

const FORKLIFT_MASS = 6;
const MIN_SUPPORT = 0.5; // fraction of a box that must rest on the box below, else it falls off the stack
// Every box is worth BOX_POINTS: up to CRASH_POINTS lost to crashes and up to
// SQUARE_POINTS lost for being placed crooked. Points are only ever deducted.
const BOX_POINTS = 100;
const CRASH_POINTS = 50;
const SQUARE_POINTS = 50;
const SQUARE_ALLOWANCE = (5 * Math.PI) / 180;
const CRASH_MIN_SPEED = 0.8;
const CRASH_COOLDOWN = 0.4;
const BONK_MIN_SPEED = 1.2;
const BONK_LOSS = 0.4; // fraction of forward motion lost in one step that counts as a bonk
const BONK_COOLDOWN = 0.2;
const LOOK_BACK_DELAY = 1; // s in gear R before the chase camera swings round to look backwards
const SCRAPE_MIN_SPEED = 0.3; // speed while touching a wall that scrapes
const FORK_PUSH_FAST = 2; // above this speed a fork push damages the whole stack, not just the boxes below the forks
const FORK_BLOCK_POINTS = 10;
const CEILING_LEVELS = 6; // the carried stack's top (H + boxes) may not go above this many box heights
const CEILING_POINTS = 10; // crash points per box on the forks each time they hit the ceiling
const PALLET_INERTIA = 0.17; // radius of gyration squared of a unit box
const ALIGN_MIN_SPEED = 0.05;
const ALIGN_RATE = 1.2; // rad/s a nudged stack turns square to the forklift

// `deco` is the box's decal kind; it lives in the pen entry so it travels with the box.
const newPen = (col = 0, seed = 0) => ({ crash: 0, sq: 0, deco: boxDecalKind(col, seed) });

// Trucks. Every player drives one entry of `g.trucks`; the fields below belong to a truck. `g` itself is the view of
// the local truck (`g.self`): g.fl, g.H, g.carried... forward to `g.trucks[g.self]`, so single-player code and
// tests just use `g`. `truckView(g, i)` gives the same view for another truck (a Proxy), which every per-truck
// function (update steps, forkUp/forkDown, resolve) accepts in place of `g`.
const TRUCK_KEYS = ['fl', 'carried', 'carriedRel', 'carriedRots', 'carriedPen', 'carriedOffs', 'bonks', 'bonkPower', 'bonkAt', 'scrape', 'wallPush', 'contact', 'slip', 'H', 'hf', 'ef', 'revTime', 'rv', 'hitAt', 'horn'];
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
    revTime: 0, // seconds spent in gear R; the chase camera only looks back after LOOK_BACK_DELAY
    rv: 0, // 0..1 smoothed: how far the chase camera has turned to look backwards (gear R)
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
export const otherTrucks = (g) => g.root.trucks.map((t, i) => (t.gone || t === g.truck ? null : truckView(g.root, i))).filter(Boolean);

const bodyPoly = (t) => {
  const c = toWorld(t.fl, (FL.back + FL.front) / 2, 0);
  return rectPoly(c.x, c.y, (FL.front - FL.back) / 2, FL.halfW, t.fl.a);
};
const carriedPoly = (t) => {
  if (!t.carried) return null;
  const c = toWorld(t.fl, FL.carryX, 0);
  return rectPoly(c.x, c.y, 0.5, 0.5, t.fl.a + t.carriedRel);
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

function updateGhosts(g) {
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
  return i;
}

// A leaving player's truck disappears; boxes on its forks are put down in front of it so the level stays solvable.
export function removeTruck(g, i) {
  const t = g.trucks[i];
  if (!t || t.gone) return;
  if (t.carried) {
    const v = truckView(g, i);
    const p = toWorld(t.fl, FL.carryX, 0), c = Math.cos(t.fl.a), sn = Math.sin(t.fl.a);
    const n = t.carried.length;
    while (t.carriedPen.length < n) t.carriedPen.push(newPen(t.carried[t.carriedPen.length], t.carriedPen.length));
    while (t.carriedRots.length < n) t.carriedRots.push(t.carriedRel);
    while (t.carriedOffs.length < n) t.carriedOffs.push({ x: 0, y: 0 });
    g.stacks.push({
      x: p.x, y: p.y, layers: t.carried, rots: t.carriedRots.map((r) => r + t.fl.a), pen: t.carriedPen,
      offs: t.carriedOffs.map((o) => ({ x: o.x * c - o.y * sn, y: o.x * sn + o.y * c })), a: t.fl.a + t.carriedRel,
    });
    Object.assign(v, { carried: null, carriedRots: [], carriedPen: [], carriedOffs: [] });
  }
  t.gone = true;
  g.ghostPairs = g.ghostPairs.filter((pr) => !pr.includes(i));
  for (const s of g.stacks) if (s.dropFrom != null && (s.dropTruck ?? 0) === i) delete s.dropFrom;
}

// Visual lowering (in box heights) of a just-released stack: it follows the forks of the truck that put it down.
export const dropLift = (g, st) => (st.dropFrom != null ? Math.max(0, (g.root.trucks[st.dropTruck ?? 0]?.hf ?? 0) - st.dropFrom - stackZ(g, st)) : 0);

// Height (in box levels) of the floor under a point: 1 on the raised conveyor belt (`g.lowWalls`), else 0.
export const zAt = (g, x, y) => (g.lowWalls?.some((w) => x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) ? 1 : 0);
export const stackZ = (g, s) => zAt(g, s.x, s.y);
// The fork level relative to the bottom of stack s (negative: the tines are below it, inside the belt).
const relH = (g, s) => g.H - stackZ(g, s);

function ensure(S) {
  if (!S.rots) S.rots = S.layers.map(() => S.a || 0);
  if (!S.pen) S.pen = S.layers.map((c, i) => newPen(c, i));
  if (!S.offs) S.offs = [];
  while (S.offs.length < S.layers.length) S.offs.push({ x: 0, y: 0 });
}

// World-frame offsets of the carried boxes relative to the carried bottom box.
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
  if (i === 0) { S.x += dx; S.y += dy; return; }
  for (let j = i; j < S.layers.length; j++) { S.offs[j].x += dx; S.offs[j].y += dy; }
}

// A box with less than MIN_SUPPORT of its area on the box below falls off, together with everything above it,
// to the floor beside the stack, taking maximum damage.
function settle(g, S) {
  ensure(S);
  for (let i = 1; i < S.layers.length; i++) {
    const a = boxPos(S, i), b = boxPos(S, i - 1);
    if (overlapArea(rectPoly(a.x, a.y, 0.5, 0.5, S.rots[i]), rectPoly(b.x, b.y, 0.5, 0.5, S.rots[i - 1])) >= MIN_SUPPORT) continue;
    let dx = a.x - b.x, dy = a.y - b.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    addDent(S.pen[i - 1], 't');
    const pen = S.pen.splice(i);
    hurt(g, pen, CRASH_POINTS, S.x + dx * 1.45, S.y + dy * 1.45, pen.length);
    const offs = S.offs.splice(i);
    const rots = S.rots.splice(i);
    const nx = S.x + dx * 1.45, ny = S.y + dy * 1.45;
    const layers = S.layers.splice(i);
    const rel = offs.map((o) => ({ x: o.x - offs[0].x, y: o.y - offs[0].y }));
    // Landing within stackable reach of another stack's top box, the fallen boxes come to rest on it.
    const under = g.stacks.find((t) => {
      if (t === S || t.layers.length + layers.length > MAX_LAYERS) return false;
      const c = boxPos(t, t.layers.length - 1);
      return Math.abs(c.x - nx) < 0.55 && Math.abs(c.y - ny) < 0.55;
    });
    if (under) {
      under.layers.push(...layers); under.rots.push(...rots); under.pen.push(...pen);
      under.offs.push(...rel.map((o) => ({ x: nx + o.x - under.x, y: ny + o.y - under.y })));
      settle(g, under);
    } else {
      g.stacks.push({ x: nx, y: ny, layers, rots, pen, a: rots[0], offs: rel });
    }
    break;
  }
}


export const HIT_LIFE = 1.2; // seconds a damage popup lives
export const SCORE_LIFE = 2.2; // finished-stack score popups stay longer so they can be read
export const hitLife = (h) => (h.score ? SCORE_LIFE : HIT_LIFE);
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
  if (speed < CRASH_MIN_SPEED || g.clock - (owner.hitAt ?? -1) < CRASH_COOLDOWN) return;
  owner.hitAt = g.clock;
  const pts = Math.min(5, Math.max(1, Math.round(speed)));
  const c = owner === g ? toWorld(g.fl, FL.carryX, 0) : owner;
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

// Crookedness of resting boxes is always judged by their current angle, so nudging a stack straight or crooked counts.
function refreshSquare(S) {
  ensure(S);
  S.pen.forEach((p, i) => { p.sq = squareLoss(S.rots[i]); });
}

export function maxScore(g) {
  return BOX_POINTS * (g.stacks.reduce((n, s) => n + s.layers.length, 0) + g.root.trucks.reduce((n, t) => n + (t.carried ? t.carried.length : 0), 0));
}

// Points lost to crashes (permanent) and to crooked placement (recoverable).
export function lostBreakdown(g) {
  let crashLost = 0, squareLost = 0;
  for (const S of g.stacks) {
    refreshSquare(S);
    for (const p of S.pen) crashLost += p.crash;
    if (g.zones.some((z) => stackFillsZone(S, z))) for (const p of S.pen) squareLost += p.sq;
  }
  for (const t of g.root.trucks) for (const p of t.carriedPen) crashLost += p.crash;
  return { crash: Math.round(crashLost), square: Math.round(squareLost) };
}

// Points earned: only boxes in a stack that completes a zone count, but crash damage anywhere (loose stacks, carried boxes) is already deducted,
// so it is not deducted again when that stack is dropped on a drop point.
export function score(g) {
  let pts = 0;
  const counted = new Set();
  for (const z of g.zones) {
    const S = g.stacks.find((s) => stackFillsZone(s, z));
    if (!S || counted.has(S)) continue;
    counted.add(S);
    refreshSquare(S);
    for (const p of S.pen) pts += BOX_POINTS - p.crash - p.sq;
  }
  for (const S of g.stacks) if (!counted.has(S)) { ensure(S); for (const p of S.pen) pts -= p.crash; }
  for (const t of g.root.trucks) for (const p of t.carriedPen) pts -= p.crash;
  return Math.round(pts);
}

// Fresh stacks get a little deterministic wonkiness: each box is turned up to WONK_ROT and shifted up to WONK_OFF.
const WONK_ROT = 15 * Math.PI / 180, WONK_OFF = 0.06;
export function wonkyStack(s) {
  const base = Math.floor(s.x * 31 + s.y * 17);
  const r = (i, k) => { const t = Math.sin((base + i * 7.13 + k * 3.7) * 12.9898) * 43758.5453; return (t - Math.floor(t)) * 2 - 1; };
  const rots = s.layers.map((_, i) => r(i, 1) * WONK_ROT);
  const offs = s.layers.map((_, i) => (i === 0 ? { x: 0, y: 0 } : { x: r(i, 2) * WONK_OFF, y: r(i, 3) * WONK_OFF }));
  return { x: s.x, y: s.y, layers: [...s.layers], rots, pen: s.layers.map((c, i) => newPen(c, base + i)), offs, a: rots[0] };
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
    self: 0, // index of the local player's truck
    ghostPairs: [], // [i, j] truck pairs that spawned inside each other and pass through each other until they separate
    hits: [],
    hitCount: 0,
    status: 'play',
    time: 0,
    started: false,
    clock: 0,
  };
  bindTrucks(g);
  return g;
}

const stackPoly = (s) => rectPoly(s.x, s.y, 0.5, 0.5, s.a || 0);

function forkShapes(g) {
  const f = g.fl;
  const mk = (lx, ly, hx, hy, stackFilter, targets) => {
    const c = toWorld(f, lx, ly);
    return { poly: rectPoly(c.x, c.y, hx, hy, f.a), stackFilter, targets };
  };
  const boxes = (from) => (s) => {
    ensure(s);
    const out = [];
    for (let i = from; i < s.layers.length; i++) { const c = boxPos(s, i); out.push({ poly: rectPoly(c.x, c.y, 0.5, 0.5, s.rots[i]), from: i }); }
    return out;
  };
  const shapes = [
    mk((FL.back + FL.front) / 2, 0, (FL.front - FL.back) / 2, FL.halfW, () => true, (s) => [{ poly: stackPoly(s), from: 0 }]),
  ];
  const tx = (FL.tineX0 + FL.tineX1) / 2, thx = (FL.tineX1 - FL.tineX0) / 2;
  if (g.carried) {
    const c = toWorld(f, FL.carryX, 0);
    shapes.push({ poly: rectPoly(c.x, c.y, 0.5, 0.5, f.a + g.carriedRel), stackFilter: (s) => s.layers.length > relH(g, s), carried: true, targets: (s) => boxes(Math.max(0, relH(g, s)))(s) });
  }
  const blocks = (s) => g.hard && relH(g, s) >= 0 && s.layers.length > relH(g, s);
  for (const side of [-1, 1]) shapes.push({ ...mk(tx, side * FL.tineOff, thx, FL.tineHalf, blocks, (s) => palletRunners(g, s).map((poly) => ({ poly, from: relH(g, s) }))), tine: true });
  return shapes;
}

// A pallet is three runners along the box's local x axis (perpendicular to its tape) with a slot for each tine between them,
// so tines only fit when driving along that axis (either way); from the sides they hit the runners.
const RUNNERS = [[0, 0.12], [-0.47, 0.03], [0.47, 0.03]]; // [lateral offset, half width]
function palletRunners(g, s) {
  ensure(s);
  const k = relH(g, s), ang = s.rots[k], c = boxPos(s, k);
  const ux = Math.cos(ang), uy = Math.sin(ang);
  return RUNNERS.map(([off, hw]) => rectPoly(c.x - uy * off, c.y + ux * off, 0.5, hw, ang));
}

// Pushing a stack off its centre turns it by the lever arm of the push (the boxes from `from` upward).
// `tip` is the pushing shape's vertex deepest into the stack, (nx, ny) the push direction, (sx, sy) how far it moved the stack.
function spinStack(s, from, tip, nx, ny, sx, sy) {
  const c = boxPos(s, from);
  const rx = tip.x - c.x, ry = tip.y - c.y;
  const raw = ((rx * ny - ry * nx) * Math.hypot(sx, sy)) / (rx * rx + ry * ry + PALLET_INERTIA);
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
    const n = NUDGE_K * speed * (j - from) ** 2;
    s.offs[j].x += (dx / len) * n; s.offs[j].y += (dy / len) * n;
  }
  settle(g, s);
}

const deepest = (poly, nx, ny) => poly.reduce((t, p) => (p.x * nx + p.y * ny > t.x * nx + t.y * ny ? p : t), poly[0]);

function shiftPoly(poly, dx, dy) {
  for (const p of poly) { p.x += dx; p.y += dy; }
}

function resolve(g) {
  const f = g.fl;
  g.wallPush = null;
  g.impacts = [];
  for (let it = 0; it < 8; it++) {
    const shapes = forkShapes(g);
    const moveF = (dx, dy) => {
      f.x += dx; f.y += dy;
      for (const sh of shapes) shiftPoly(sh.poly, dx, dy);
    };

    for (const sh of shapes) {
      // low walls (the raised conveyor belt) stop the body and a carried stack below height 1, never the tines
      const blockers = g.lowWalls?.length && !sh.tine && !(sh.carried && g.H >= 1) ? g.walls.concat(g.lowWalls) : g.walls;
      for (const w of blockers) {
        const m = sat(sh.poly, w.poly);
        if (m) {
          let tip = sh.poly[0];
          for (const p of sh.poly) if (p.x * m.x + p.y * m.y < tip.x * m.x + tip.y * m.y) tip = p;
          g.contact = { x: tip.x, y: tip.y, nx: m.x, ny: m.y };
          moveF(m.x * m.depth, m.y * m.depth);
          g.impacts.push({ x: tip.x, y: tip.y, nx: m.x, ny: m.y, w: 1 });
          const wp = g.wallPush || (g.wallPush = { x: 0, y: 0 });
          wp.x += m.x * m.depth; wp.y += m.y * m.depth;
          if (sh.carried) crash(g, g.carriedPen, g, g.carriedPen.length, { kind: 'c', dx: -m.x, dy: -m.y, rots: carriedRotsWorld(g) });
        }
      }
    }

    // Other trucks are solid (body and carried stack, not their tines) unless they are ghosts to this one; each moves half the overlap.
    for (const o of otherTrucks(g)) {
      if (Math.hypot(o.fl.x - f.x, o.fl.y - f.y) > 6 || ghostBetween(g, g.truck.id, o.truck.id)) continue;
      const theirCarried = carriedPoly(o.truck), theirs = [bodyPoly(o.truck), theirCarried].filter(Boolean);
      // carried stacks only touch when their height ranges overlap (a stack held above or below another passes it)
      const apart = g.carried && o.carried && (g.H >= o.H + o.carried.length || o.H >= g.H + g.carried.length);
      for (const sh of shapes) {
        if (sh.tine) continue;
        for (const q of theirs) {
          if (apart && sh.carried && q === theirCarried) continue;
          const m = sat(sh.poly, q);
          if (!m) continue;
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
      if (Math.abs(s.x - f.x) > 5 || Math.abs(s.y - f.y) > 5) continue;
      const wf = 1 / FORKLIFT_MASS;
      for (const sh of shapes) {
        if (!sh.stackFilter || !sh.stackFilter(s)) continue;
        let m = null, from = 0;
        for (const t of sh.targets(s)) { m = sat(sh.poly, t.poly); if (m) { from = t.from; break; } }
        if (!m) continue;
        ensure(s);
        const ws = 1 / (s.layers.length - from);
        if (!(f.speed > ALIGN_MIN_SPEED && f.speed < CRASH_MIN_SPEED && !sh.carried)) crash(g, s.pen, s, sh.tine && g.hard && relH(g, s) > 0 && Math.abs(f.speed) < FORK_PUSH_FAST ? relH(g, s) : s.pen.length, { kind: 's', dx: m.x, dy: m.y, rots: s.rots });
        if (sh.carried) crash(g, g.carriedPen, g, g.carriedPen.length, { kind: 's', dx: -m.x, dy: -m.y, rots: carriedRotsWorld(g) });
        if (!sh.carried && !sh.tine && f.speed > ALIGN_MIN_SPEED && f.speed < CRASH_MIN_SPEED) g.aligning?.add(s);
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

    for (const s of g.stacks) {
      if (s.leaving) continue; // a load riding away on a delivery truck passes through the border
      for (const w of g.walls) {
        if (s.x + 0.71 < w.x || s.x - 0.71 > w.x + w.w || s.y + 0.71 < w.y || s.y - 0.71 > w.y + w.h) continue;
        const m = sat(stackPoly(s), w.poly);
        if (m) {
          s.x += m.x * m.depth; s.y += m.y * m.depth;
          const sp = Math.abs(f.speed);
          if (sp >= CRASH_MIN_SPEED && g.clock - (s.wallHitAt ?? -1) >= CRASH_COOLDOWN) {
            ensure(s);
            s.wallHitAt = g.clock;
            dentBoxes(s.pen, s.pen.length, { kind: 'c', dx: -m.x, dy: -m.y, rots: s.rots });
          }
        }
      }
    }

    for (let i = 0; i < g.stacks.length; i++) {
      for (let j = i + 1; j < g.stacks.length; j++) {
        const a = g.stacks[i], b = g.stacks[j];
        if (Math.abs(a.x - b.x) >= 1.42 || Math.abs(a.y - b.y) >= 1.42) continue;
        const m = sat(stackPoly(a), stackPoly(b));
        if (!m) continue;
        ensure(a); ensure(b);
        crash(g, a.pen, a, a.pen.length, { kind: 's', dx: -m.x, dy: -m.y, rots: a.rots });
        crash(g, b.pen, b, b.pen.length, { kind: 's', dx: m.x, dy: m.y, rots: b.rots });
        const wa = 1 / a.layers.length, wb = 1 / b.layers.length;
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

// Driving slowly into a stack turns every box square to the forklift's heading.
function alignStack(g, s, dt) {
  const q = Math.PI / 2, step = ALIGN_RATE * dt;
  const turn = (a) => {
    const diff = ((g.fl.a - a) % q + q * 1.5) % q - q / 2; // signed distance to nearest square angle
    return Math.max(-step, Math.min(step, diff));
  };
  ensure(s);
  s.rots = s.rots.map((r) => r + turn(r));
  s.a = (s.a || 0) + turn(s.a || 0);
}

// A pallet on the tines is held sideways with the forks (the whole stack moves) but can still slide along them;
// only the boxes from the fork level upward turn with the forks.
function glideWithForks(g, S, ly, da, from) {
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

// Steps the game. `input` drives the local truck; the other trucks use their `input` field (set by the host from the network).
export function update(g, input, dt) {
  const root = g.root;
  root.clock += dt;
  if (root.hits) root.hits = root.hits.filter((h) => root.clock - h.t < hitLife(h));
  root.trucks.forEach((t, i) => { if (!t.gone) stepTruck(truckView(root, i), i === root.self ? input : t.input, dt); });
  updateGhosts(root);
  if (root.status === 'play' && root.started) root.time += dt; // the level timer runs from the first move until solved
  scorePopups(root);
  if (root.status === 'play' && !root.endless && isFinished(root)) root.status = 'won';
}

function stepTruck(g, input, dt) {
  const f = g.fl;
  g.horn = !!input.horn;
  const forked = g.hard ? forkedStack(g) : null;
  const forkedY = forked ? toLocal(f, boxPos(forked, relH(g, forked)).x, boxPos(forked, relH(g, forked)).y).y : 0;
  const prevA = f.a;
  drive(f, input, dt, g.H);
  skidStep(f, dt);
  if (f.speed !== 0) g.started = true; // the level timer starts when a truck first moves
  const driven = { x: f.x, y: f.y };
  const intended = f.speed * dt;
  g.aligning = new Set();
  if (forked && f.a !== prevA) glideWithForks(g, forked, forkedY, f.a - prevA, relH(g, forked));
  const speed0 = f.speed;
  resolve(g);
  impactKick(g, speed0, dt);
  for (const s of g.aligning) alignStack(g, s, dt);

  if (Math.abs(intended) > 1e-6) {
    const actual = (f.x - driven.x) * Math.cos(f.a) + (f.y - driven.y) * Math.sin(f.a) + intended;
    const r = Math.max(0, Math.min(1, actual / intended));
    wallContact(g, f.speed, r);
    f.speed *= 1 - (1 - r) * Math.min(1, dt / 0.15);
  } else {
    g.scrape = 0;
  }

  g.slip = Math.max(tireSlip(g, input, dt), (g.slip || 0) - SLIP_DECAY * dt);

  g.hf += Math.max(-6 * dt, Math.min(6 * dt, g.H - g.hf));
  if (f.gear === 'D') g.revTime = 0;
  else g.revTime += dt;
  g.rv += ((f.gear === 'R' && g.revTime > LOOK_BACK_DELAY ? 1 : 0) - g.rv) * (1 - Math.exp(-dt / 0.15));
  g.ef += (g.hf - g.ef) * (1 - Math.exp(-dt / 0.22)); // cabin eye trails the forks
  // visual lowering of a just-released stack ends when the forks reach it
  for (const s of g.stacks) if (s.dropFrom != null && (s.dropTruck ?? 0) === g.truck.id && (g.hf <= s.dropFrom + stackZ(g, s) + 1e-3 || relH(g, s) > s.dropFrom)) delete s.dropFrom;
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
      if (now.square) add(now.n, { wonky: -now.square });
    } else if (was && now && was.square !== now.square) {
      const old = popup(i, 'wonky');
      const change = was.square - now.square + (old ? old.score.wonky : 0);
      drop(old);
      if (change) add(now.n, { wonky: change });
    }
  });
}

export function stackInZone(g) {
  const f = g.fl;
  let best = null, bd = Infinity;
  for (const s of g.stacks) {
    ensure(s);
    const c = boxPos(s, g.carried ? s.layers.length - 1 : Math.min(Math.max(0, relH(g, s)), s.layers.length - 1));
    const l = toLocal(f, c.x, c.y);
    const dx = Math.abs(l.x - FL.carryX), dy = Math.abs(l.y);
    if (dx < 0.55 && dy < 0.5 && dx + dy < bd) { best = s; bd = dx + dy; }
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
  return S && relH(g, S) >= 0 && S.layers.length > relH(g, S) ? S : null;
}

// Moves the boxes from index `k` up of the stack on `from`'s forks onto `to`'s forks (k > 0 splits the stack), keeping their
// world angles. With `onto` they are put on top of the stack `to` already carries instead; otherwise `to` carries nothing yet.
function transferCarried(from, to, k = 0, onto = false) {
  const n = from.carried.length;
  while (from.carriedPen.length < n) from.carriedPen.push(newPen(from.carried[from.carriedPen.length], from.carriedPen.length));
  while (from.carriedRots.length < n) from.carriedRots.push(from.carriedRel);
  while (from.carriedOffs.length < n) from.carriedOffs.push({ x: 0, y: 0 });
  const d = from.fl.a - to.fl.a, c = Math.cos(d), sn = Math.sin(d);
  const rot = (o) => ({ x: o.x * c - o.y * sn, y: o.x * sn + o.y * c });
  const base = from.carriedOffs[k];
  let shift = { x: 0, y: 0 };
  if (onto) {
    // from's bottom box relative to to's bottom box, in to's frame
    const pf = toWorld(from.fl, FL.carryX, 0), pt = toWorld(to.fl, FL.carryX, 0);
    shift = toLocal({ x: 0, y: 0, a: to.fl.a }, pf.x - pt.x, pf.y - pt.y);
  }
  const offs = from.carriedOffs.slice(k).map((o) => { const r = rot({ x: o.x - base.x, y: o.y - base.y }); return { x: r.x + shift.x, y: r.y + shift.y }; });
  const rots = from.carriedRots.slice(k).map((r) => r + d);
  const layers = from.carried.slice(k), pen = from.carriedPen.slice(k);
  if (onto) {
    to.carried = to.carried.concat(layers);
    to.carriedPen = to.carriedPen.concat(pen);
    to.carriedRots = to.carriedRots.concat(rots);
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

const atCarryPoint = (g, o) => {
  const p = toWorld(g.fl, FL.carryX, 0), l = toLocal(o.fl, p.x, p.y);
  return Math.abs(l.x - FL.carryX) < 0.55 && Math.abs(l.y) < 0.5;
};

// Trucks hand stacks over on their tines. A truck whose empty tines are under another truck's carried stack takes it by raising
// the tines up to its height (from below) or, with the tines inside the stack, takes the boxes from that level up and leaves the
// rest on the other forks. A truck lowering a carried stack over another truck's tines gives it away, or puts it on top of the
// stack that truck carries (max 5 layers). Ghosts to each other never trade.
function stackOnMyTines(g) {
  for (const o of otherTrucks(g)) {
    if (!o.carried || o.H > g.H + 1 || g.H >= o.H + o.carried.length || ghostBetween(g, g.truck.id, o.truck.id)) continue;
    if (atCarryPoint(o, g)) return o;
  }
  return null;
}

function tinesUnderMyStack(g) {
  for (const o of otherTrucks(g)) {
    if (ghostBetween(g, g.truck.id, o.truck.id) || !atCarryPoint(g, o)) continue;
    if (!o.carried && o.H <= g.H) return o;
    if (o.carried && o.H + o.carried.length <= g.H && o.carried.length + g.carried.length <= MAX_LAYERS) return o;
  }
  return null;
}

// Raising carried boxes into the ceiling is refused ('blocked') and damages every carried box.
export function forkUp(g) {
  if (!g.carried) {
    const o = stackOnMyTines(g);
    if (o) {
      g.H = Math.max(g.H, o.H);
      transferCarried(o, g, g.H - o.H);
      return;
    }
  }
  if (g.carried) {
    if (g.H + g.carried.length >= CEILING_LEVELS) {
      while (g.carriedPen.length < g.carried.length) g.carriedPen.push(newPen(g.carried[g.carriedPen.length], g.carriedPen.length));
      const c = toWorld(g.fl, FL.carryX, 0);
      hurt(g, g.carriedPen, CEILING_POINTS, c.x, c.y, g.H + g.carried.length, g);
      addDent(g.carriedPen[g.carriedPen.length - 1], 't');
      return 'blocked';
    }
    g.H = Math.min(MAX_H, g.H + 1);
    return;
  }
  const S = forkedStack(g);
  if (S) {
    const k = relH(g, S);
    g.carried = S.layers.splice(k);
    g.carriedRots = S.rots.splice(k).map((r) => r - g.fl.a);
    g.carriedPen = S.pen.splice(k);
    const ox = S.offs[k].x, oy = S.offs[k].y, c = Math.cos(g.fl.a), sn = Math.sin(g.fl.a);
    g.carriedOffs = S.offs.splice(k).map((o) => {
      const dx = o.x - ox, dy = o.y - oy;
      return { x: dx * c + dy * sn, y: -dx * sn + dy * c };
    });
    g.carriedRel = g.carriedRots[0];
    if (!S.layers.length) g.stacks.splice(g.stacks.indexOf(S), 1);
  }
  g.H = Math.min(MAX_H, g.H + 1);
}

// Lowering empty forks through a box is refused ('blocked') and damages that box.
export function forkDown(g) {
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
    const S = g.H > 0 ? stackInZone(g) : null;
    if (S && relH(g, S) > 0 && S.layers.length >= relH(g, S)) {
      ensure(S);
      hurt(g, [S.pen[relH(g, S) - 1]], FORK_BLOCK_POINTS, S.x, S.y, g.H, S);
      addDent(S.pen[relH(g, S) - 1], 't');
      return 'blocked';
    }
    g.H = Math.max(0, g.H - 1);
    return;
  }
  const S = stackInZone(g);
  if (S) ensure(S);
  const cnt = S ? S.layers.length : 0;
  const cp = toWorld(g.fl, FL.carryX, 0);
  const n = cnt + (S ? stackZ(g, S) : zAt(g, cp.x, cp.y)); // resting height: on the belt that is one level up
  const minH = cnt + g.carried.length <= MAX_LAYERS ? n : n + 1;
  if (g.H > minH) g.H = Math.max(minH, g.H - 1);
  // Reaching the resting height puts the boxes down.
  if (g.H === n && minH === n) {
    while (g.carriedPen.length < g.carried.length) g.carriedPen.push(newPen(g.carried[g.carriedPen.length], g.carriedPen.length));
    while (g.carriedRots.length < g.carried.length) g.carriedRots.push(g.carriedRel);
    const worldRots = g.carriedRots.map((r) => r + g.fl.a);
    g.carriedPen.forEach((p, i) => { p.sq = squareLoss(worldRots[i]); });
    const p = toWorld(g.fl, FL.carryX, 0);
    const c = Math.cos(g.fl.a), sn = Math.sin(g.fl.a);
    while (g.carriedOffs.length < g.carried.length) g.carriedOffs.push({ x: 0, y: 0 });
    const world = g.carriedOffs.map((o) => ({ x: o.x * c - o.y * sn, y: o.x * sn + o.y * c }));
    if (S) {
      S.layers.push(...g.carried);
      S.rots.push(...worldRots);
      S.pen.push(...g.carriedPen);
      S.offs.push(...world.map((o) => ({ x: p.x + o.x - S.x, y: p.y + o.y - S.y })));
      S.dropFrom = cnt;
      S.dropTruck = g.truck.id;
      settle(g, S);
    } else {
      g.stacks.push({ x: p.x, y: p.y, layers: g.carried, rots: worldRots, pen: g.carriedPen, offs: world, a: g.fl.a + g.carriedRel, dropFrom: 0, dropTruck: g.truck.id });
    }
    g.carried = null;
    g.carriedRots = [];
    g.carriedPen = [];
    g.carriedOffs = [];
  }
}

const PARK_POS = 0.6, PARK_ANGLE = 0.35, PARK_SPEED = 0.5;
const MIN_SCORE_FRACTION = 0.5;

export function isParked(g) {
  const f = g.fl, p = g.parking;
  const c = toWorld(f, (FL.back + FL.front) / 2, 0);
  let da = (f.a - p.a) % (2 * Math.PI);
  if (da > Math.PI) da -= 2 * Math.PI;
  if (da < -Math.PI) da += 2 * Math.PI;
  return Math.hypot(c.x - p.x, c.y - p.y) < PARK_POS && Math.abs(da) < PARK_ANGLE && Math.abs(f.speed) < PARK_SPEED;
}

export const scoreEnough = (g) => score(g) >= MIN_SCORE_FRACTION * maxScore(g);

// A level is finished: every zone filled, enough score, and a forklift (any player's) back in its parking spot.
export function isFinished(g) {
  return isSolved(g) && scoreEnough(g) && g.root.trucks.some((t, i) => !t.gone && isParked(truckView(g.root, i)));
}

export function isSolved(g) {
  return g.zones.every((z) => zoneDone(g, z));
}

const stackFillsZone = (s, z) =>
  Math.abs(s.x - z.x) < 0.5 &&
  Math.abs(s.y - z.y) < 0.5 &&
  s.layers.length === z.count &&
  s.layers.every((c) => c === z.color);

// A completed drop point holds a stack with crooked boxes (squareness points lost).
export function zoneWonky(g, z) {
  return g.stacks.some((s) => stackFillsZone(s, z) && (refreshSquare(s), s.pen.some((p) => p.sq > 0)));
}

// Points of the stack completing zone z: `base` (max for the stack: what the popup shows, since crash damage is already in the live score), `total` (base minus crash and crooked placement `square`); null while the zone is open.
export function zonePoints(g, z) {
  const S = g.stacks.find((s) => stackFillsZone(s, z));
  if (!S) return null;
  refreshSquare(S);
  const crash = S.pen.reduce((n, p) => n + p.crash, 0), square = S.pen.reduce((n, p) => n + p.sq, 0);
  const base = BOX_POINTS * S.layers.length;
  return { n: S.layers.length, base, total: base - Math.round(crash) - Math.round(square), crash: Math.round(crash), square: Math.round(square) };
}

export function zoneDone(g, z) {
  return g.stacks.some((s) => stackFillsZone(s, z));
}

// Where the overview paints a zone's "×count": just below the zone, or above it when a wall (e.g. the south border) would cover that spot.
// The choice is shared by every drop point of the drop-off area, so a row of labels never mixes above and below.
export function zoneLabelPos(g, z) {
  const hit = (x, y) => g.walls.some((w) => x + 0.4 > w.x && x - 0.4 < w.x + w.w && y + 0.25 > w.y && y - 0.25 < w.y + w.h);
  const mates = g.zones.filter((o) => o.color === z.color);
  const southWall = mates.some((o) => hit(o.x, o.y + 0.92));
  const above = southWall && !hit(z.x, z.y - 0.92);
  return { x: z.x, y: above ? z.y - 0.92 : z.y + 0.92 };
}
