// Cleaning bot (inspired by M-O): lives behind a hatch and drives out for oil or fresh skid marks,
// paths on a coarse grid (avoiding walls, stacks and forklifts), mops oil (one drop per CLEAN_SECS) and
// runs away whenever a forklift comes close. With nothing left to clean it watches forklifts before returning to its hatch.
// Pure data + DOM-free; `g.hatch` is static (regenerated per level), `g.bot` is dynamic (saved and synced).
import { repairable } from './repair.js';
import { BARREL_COLOR } from './level.js';
import { FL, toWorld } from './forklift.js';
import { BOX_HALF_X, halfY, zoneExt, rectPoly, sat } from './geom.js';

export const BOT_R = 0.3; // about a quarter of a forklift's footprint
export const CLEAN_SECS = 5; // seconds per oil drop
const SKID_CLEAN_SECS = 0.3;
const SKID_TRUCK_CLEARANCE = 1.5;
const CELL = 0.25, SPEED = 2.25, FLEE_SPEED = 3.2, SCARE = 1.3, CALM = 2.0, SHOW_SECS = 0.6;
export const TURN_RATE = 5, TURN_FIRST = 0.6; // max turning speed (rad/s; a tracked bot spins on the spot) and the heading error above which it turns before driving on
const FLEE_TURN_RATE = 16;
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
// Turns the bot towards heading `ang` at no more than TURN_RATE; returns the heading error left.
function turnTo(bot, ang, dt, rate = TURN_RATE) {
  const da = angDiff(bot.a, ang), step = Math.max(-rate * dt, Math.min(rate * dt, da));
  bot.a += step;
  return da - step;
}
const hash = (n) => { const t = Math.sin(n * 12.9898) * 43758.5453; return t - Math.floor(t); };

// Predetermined hatch position on the outer walls: seeded, and clear of stacks, pillars and the start.
export function makeHatch(g) {
  if (!g.zones?.length && !g.stacks.some((s) => s.layers.includes(BARREL_COLOR))) return null;
  const sides = [
    (t) => ({ x: t * g.w, y: 0, nx: 0, ny: 1 }),
    (t) => ({ x: g.w, y: t * g.h, nx: -1, ny: 0 }),
    (t) => ({ x: t * g.w, y: g.h, nx: 0, ny: -1 }),
    (t) => ({ x: 0, y: t * g.h, nx: 1, ny: 0 }),
  ];
  const cands = [];
  for (let side = 0; side < 4; side++) for (let k = 1; k < 20; k++) cands.push({ ...sides[side](k / 20), side });
  const base = (g.seed || 0) * 7 + g.level * 31;
  // Clearance of the spot in front of the hatch to stacks, pillars, drop-off zones and the start; the hatch must also open into free floor.
  const clearance = (h) => {
    const p = { x: h.x + h.nx * 0.5, y: h.y + h.ny * 0.5 };
    let c = Math.hypot(g.start.x - p.x, g.start.y - p.y) - 2;
    for (const s of g.stacks) c = Math.min(c, Math.hypot(s.x - p.x, s.y - p.y) - 1);
    for (const z of g.zones || []) c = Math.min(c, Math.hypot(z.x - p.x, z.y - p.y) - 0.7);
    for (const w of g.walls.slice(4)) c = Math.min(c, rectDist(p.x, p.y, w) - 0.5);
    return c;
  };
  const start = Math.floor(hash(base) * cands.length);
  let best = null, bestC = -Infinity;
  for (let i = 0; i < cands.length; i++) {
    const h = cands[(start + i) % cands.length], c = clearance(h);
    if (c >= 0.5) { best = h; break; }
    if (c > bestC) { bestC = c; best = h; }
  }
  return { x: best.x, y: best.y, nx: best.nx, ny: best.ny, a: Math.atan2(best.ny, best.nx) };
}

const botHome = (h) => ({ x: h.x + h.nx * (BOT_R + 0.1), y: h.y + h.ny * (BOT_R + 0.1) });

// Where a bot is drawn: it keeps its full size and slides in/out of the hatch, so while `show` < 1 it sits (partly) inside the wall,
// which hides it; `show` is the progress of that slide.
const BOT_SLIDE = BOT_R + 0.1 + 0.5; // from home to fully inside the wall
export function botDrawPos(b, h) {
  const s = (1 - b.show) * BOT_SLIDE;
  return h ? { x: b.x - h.nx * s, y: b.y - h.ny * s } : { x: b.x, y: b.y };
}

// A bot drives straight out of its hatch and straight back in, always forwards: `show` (0..1) is how far along that
// line from `botHome` to `botLane` it is. It goes in and out via the lane point, where it turns to face the wall before driving in.
const LANE = 1.1; // distance of the lane point (the bot's goal when going home) from the wall
const laneAt = (h, show) => { const d = (LANE - (BOT_R + 0.1)) * show + BOT_R + 0.1; return { x: h.x + h.nx * d, y: h.y + h.ny * d }; };
const botLane = (h) => laneAt(h, 1);
const bots = (g) => [g.bot, g.inspector, g.coneBot, g.tapeBot].filter(Boolean);
const BOT_SPACE = BOT_R * 2 + 0.04;
const botKey = (g, bot) => ['bot', 'inspector', 'coneBot', 'tapeBot'].find((key) => g[key] === bot);
const canYield = (g, worker, bot) => worker.activity === 'work' && bot.activity === 'follow'
  && !bot.scared && bot.show === 1 && bot.yieldBlock?.worker !== botKey(g, worker);
function hatchBusy(g, bot) {
  const lane = botLane(g.hatch);
  return bots(g).some((o) => o !== bot && o.show > 0
    && (o.show < 1 || Math.hypot(o.x - lane.x, o.y - lane.y) < BOT_SPACE));
}
function place(g, bot, a) { const p = laneAt(g.hatch, bot.show); bot.x = p.x; bot.y = p.y; bot.a = a; }
function emerge(g, bot, dt) {
  if (hatchBusy(g, bot)) return;
  bot.show = Math.min(1, bot.show + dt / SHOW_SECS * (bot === g.tapeBot ? 2 : 1));
  place(g, bot, g.hatch.a);
}
function retract(g, bot, dt) {
  if (hatchBusy(g, bot)) return;
  bot.path = [];
  if (!bot.leaving) {
    const lane = botLane(g.hatch);
    bot.x = lane.x; bot.y = lane.y;
    if (Math.abs(turnTo(bot, g.hatch.a + Math.PI, dt)) > 0.05) return;
    bot.leaving = true;
  }
  bot.show = Math.max(0, bot.show - dt / SHOW_SECS * (bot === g.tapeBot ? 2 : 1));
  place(g, bot, g.hatch.a + Math.PI);
  if (bot.show === 0) { bot.mode = 'hidden'; bot.leaving = false; }
}

export function makeBot(g) {
  if (!g.hatch) return null;
  const home = botHome(g.hatch);
  return { x: home.x, y: home.y, a: g.hatch.a, show: 0, mode: 'hidden', cleaning: false, scared: false, path: [], repath: 0, clean: 0 };
}

// The inspection bot: photographs every completed drop point once (`seen` holds the keys of inspected zones).
export function makeInspector(g) {
  if (!g.hatch) return null;
  const home = botHome(g.hatch);
  return { x: home.x, y: home.y, a: g.hatch.a, show: 0, mode: 'hidden', shooting: 0, flash: 0, roll: 0, scared: false, path: [], repath: 0, seen: [] };
}

export function makeConeBot(g) {
  if (!g.hatch) return null;
  const home = botHome(g.hatch);
  return { x: home.x, y: home.y, a: g.hatch.a, show: 0, mode: 'hidden', scared: false, path: [], repath: 0 };
}

// Shared cone-bot prisms: local centre, half sizes, height range, colour and optional emissive flag.
export const CONE_BOT_PARTS = [
  [0, 0, 0.34, 0.21, 0.10, 0.20, '#aeb4b6'],
  [0, 0, 0.32, 0.215, 0.10, 0.13, '#a62c2b'],
  [-0.17, 0, 0.17, 0.20, 0.20, 0.69, '#e3e5e2'],
  [-0.17, 0, 0.17, 0.205, 0.22, 0.26, '#ad3431'],
  [-0.17, 0, 0.15, 0.207, 0.49, 0.53, '#b33832'],
  [-0.17, 0, 0.17, 0.20, 0.66, 0.70, '#c6cbca'],
  [0.17, 0, 0.17, 0.19, 0.19, 0.58, '#b53630'],
  [0.17, 0, 0.16, 0.20, 0.53, 0.60, '#e4e6e2'],
  [0.17, 0, 0.11, 0.203, 0.33, 0.49, '#20292d'],
  [0.335, 0, 0.008, 0.155, 0.28, 0.52, '#172125'],
  [0.345, -0.075, 0.004, 0.038, 0.35, 0.44, '#ffb768', true],
  [0.345, 0.075, 0.004, 0.038, 0.35, 0.44, '#ffb768', true],
  [0.350, -0.075, 0.003, 0.021, 0.37, 0.425, '#252322'],
  [0.350, 0.075, 0.003, 0.021, 0.37, 0.425, '#252322'],
  [0.354, -0.08, 0.002, 0.007, 0.402, 0.417, '#fff3d4', true],
  [0.354, 0.07, 0.002, 0.007, 0.402, 0.417, '#fff3d4', true],
];
export const CONE_BOT_WHEELS = [[-0.20, -0.22], [-0.20, 0.22], [0.22, 0]];

// Beacon prisms use the same local dimensions as the shared bot parts.
export const BOT_BEACONS = {
  bot: [-0.08, 0, 0.045, 0.06, 0.40, 0.46, '#ef941f'],
  inspector: [-0.08, 0, 0.045, 0.06, 0.45, 0.51, '#ef941f'],
  coneBot: [0.13, 0, 0.06, 0.145, 0.60, 0.65, '#ef941f'],
  tapeBot: [0, 0, 0.055, 0.08, 1.35, 1.43, '#78e5f4'],
};
const beaconPulse = (g) => Math.floor((g.clock || 0) * 4) % 2 === 0;
export const botBeaconOn = (g, b) => b?.show > 0 && b.activity === 'work' && !b.scared && beaconPulse(g);
export const beaconColor = (color, on) => on ? color === '#ef941f' ? '#ffc45a' : '#c7fbff' : color;
export const proximityBeaconOn = (g, p) => beaconPulse(g)
  && truckCircles(g).some((c) => Math.hypot(p.x - c.x, p.y - c.y) < c.r + 3);

export const TAPE_BOT_PARTS = [
  [0, -0.16, 0.28, 0.04, 0.03, 0.18, '#303538'],
  [0, 0.16, 0.28, 0.04, 0.03, 0.18, '#303538'],
  [0, 0, 0.21, 0.15, 0.12, 1.12, '#e8eae6'],
  [0, -0.15, 0.20, 0.012, 0.14, 1.1, '#e3b82a'],
  [0, 0.15, 0.20, 0.012, 0.14, 1.1, '#e3b82a'],
  [-0.215, 0, 0.012, 0.13, 0.17, 1.0, '#363b3e'],
  [0, 0, 0.16, 0.14, 1.12, 1.35, '#e8eae6'],
  [0.16, 0, 0.02, 0.13, 1.16, 1.31, '#172126'],
  [0.182, 0, 0.005, 0.07, 1.22, 1.25, '#42d8f4', true],
  [-0.08, -0.12, 0.012, 0.012, 1.32, 1.55, '#343b3e'],
  [-0.08, 0.12, 0.012, 0.012, 1.32, 1.55, '#343b3e'],
];

export function makeTapeBot(g) {
  if (!g.hatch) return null;
  const home = botHome(g.hatch);
  return { x: home.x, y: home.y, a: g.hatch.a, show: 0, mode: 'hidden', scared: false, path: [], repath: 0 };
}

export const tapeDeploying = (bot) => bot?.tapeJob?.phase === 'draw' && !bot.scared;

function rectDist(x, y, w) {
  const dx = Math.max(w.x - x, 0, x - (w.x + w.w)), dy = Math.max(w.y - y, 0, y - (w.y + w.h));
  return Math.hypot(dx, dy);
}

// Circles approximating each forklift (and its carried stack): { x, y, r }.
// A forklift rolling faster than MOVING_SPEED (tiles/s) counts as moving; only moving ones scare a bot.
const MOVING_SPEED = 0.15;
const circlesOf = (t) => {
  const out = [];
  for (const [x, r] of [[-1.7, 0.6], [-1.1, 0.6], [-0.5, 0.6], [0.1, 0.6], [0.9, 0.35], [1.4, 0.35]]) out.push({ ...toWorld(t.fl, x, 0), r });
  if (t.carried) out.push({ ...toWorld(t.fl, FL.carryX, 0), r: 0.75 });
  return out;
};
export function truckCircles(g, movingOnly = false) {
  const out = [];
  for (const t of g.trucks) {
    if (t.gone || (movingOnly && Math.abs(t.fl.speed) <= MOVING_SPEED)) continue;
    out.push(...circlesOf(t));
  }
  return out;
}

// Smallest gap between the bot and a forklift that is moving towards it (stationary ones and ones driving away are no threat).
function approachGap(g, p) {
  let best = Infinity;
  for (const t of g.trucks) {
    if (t.gone || Math.abs(t.fl.speed) <= MOVING_SPEED) continue;
    const vx = Math.cos(t.fl.a) * t.fl.speed, vy = Math.sin(t.fl.a) * t.fl.speed;
    if (vx * (p.x - t.fl.x) + vy * (p.y - t.fl.y) <= 0) continue;
    for (const c of circlesOf(t)) best = Math.min(best, Math.hypot(p.x - c.x, p.y - c.y) - c.r - BOT_R);
  }
  return best;
}

// Smallest gap between the bot and any forklift.
export function truckGap(g, p, movingOnly = false) {
  let best = Infinity;
  for (const c of truckCircles(g, movingOnly)) best = Math.min(best, Math.hypot(p.x - c.x, p.y - c.y) - c.r - BOT_R);
  return best;
}

// Cones are light floor objects: moving trucks and stacks displace them, while a hard
// impact leaves one tipped or crushed for the cone bot to restore.
export function stepConeCollisions(g) {
  for (const cone of g.cones || []) {
    if (cone.squished) continue;
    for (const t of g.trucks) {
      if (t.gone) continue;
      for (const c of circlesOf(t)) {
        const dx = cone.x - c.x, dy = cone.y - c.y, d = Math.hypot(dx, dy), min = c.r + 0.13;
        if (d >= min) continue;
        const a = d > 1e-6 ? Math.atan2(dy, dx) : hash((cone.id || '').length + t.id * 17) * Math.PI * 2;
        cone.x = c.x + Math.cos(a) * min; cone.y = c.y + Math.sin(a) * min;
        if (Math.abs(t.fl.speed) > 2.6) cone.squished = true;
        else if (Math.abs(t.fl.speed) > 0.25) cone.tipped = true;
      }
    }
    for (const s of g.stacks) {
      const dx = cone.x - s.x, dy = cone.y - s.y, d = Math.hypot(dx, dy), min = STACK_R + 0.13;
      if (d >= min) continue;
      const a = d > 1e-6 ? Math.atan2(dy, dx) : 0;
      cone.x = s.x + Math.cos(a) * min; cone.y = s.y + Math.sin(a) * min;
      cone.tipped = true;
    }
    for (const w of g.walls) {
      const d = rectDist(cone.x, cone.y, w);
      if (d >= 0.13) continue;
      if (d > 1e-6) {
        const x = Math.max(w.x, Math.min(cone.x, w.x + w.w)), y = Math.max(w.y, Math.min(cone.y, w.y + w.h));
        cone.x = x + (cone.x - x) / d * 0.13; cone.y = y + (cone.y - y) / d * 0.13;
      } else {
        const sides = [[cone.x - w.x, -1, 0], [w.x + w.w - cone.x, 1, 0], [cone.y - w.y, 0, -1], [w.y + w.h - cone.y, 0, 1]].sort((a, b) => a[0] - b[0]);
        cone.x += sides[0][1] * (sides[0][0] + 0.13); cone.y += sides[0][2] * (sides[0][0] + 0.13);
      }
    }
  }
}

function nearBox(s, x, y, margin) {
  return s.layers.some((_, i) => {
    const off = s.offs?.[i] || { x: 0, y: 0 }, a = s.rots?.[i] ?? s.a ?? 0;
    const dx = x - s.x - off.x, dy = y - s.y - off.y, c = Math.cos(a), sn = Math.sin(a);
    return Math.abs(dx * c + dy * sn) < BOX_HALF_X + margin
      && Math.abs(-dx * sn + dy * c) < halfY(s.pen?.[i]) + margin;
  });
}

function buildGrid(g, margin, slim = false, avoidBots = null) {
  const nx = Math.ceil(g.w / CELL), ny = Math.ceil(g.h / CELL), blocked = new Uint8Array(nx * ny);
  const stamp = (x0, y0, x1, y1, hit) => {
    for (let j = Math.max(0, Math.floor(y0 / CELL)); j <= Math.min(ny - 1, Math.floor(y1 / CELL)); j++) {
      for (let i = Math.max(0, Math.floor(x0 / CELL)); i <= Math.min(nx - 1, Math.floor(x1 / CELL)); i++) {
        if (hit((i + 0.5) * CELL, (j + 0.5) * CELL)) blocked[j * nx + i] = 1;
      }
    }
  };
  const circle = (c, r) => stamp(c.x - r, c.y - r, c.x + r, c.y + r, (x, y) => Math.hypot(x - c.x, y - c.y) < r);
  for (const w of g.walls) {
    const m = slim ? 0.25 : BOT_R + 0.05;
    stamp(w.x - m, w.y - m, w.x + w.w + m, w.y + w.h + m, (x, y) => rectDist(x, y, w) < m);
  }
  for (const s of g.stacks) {
    if (!slim) circle(s, STACK_R + BOT_R);
    else {
      const r = 2 + Math.max(0, ...(s.offs || []).map((o) => Math.hypot(o.x, o.y)));
      stamp(s.x - r, s.y - r, s.x + r, s.y + r, (x, y) => nearBox(s, x, y, 0.2));
    }
  }
  const fixed = blocked.slice(); // cells blocked by walls and boxes only (forklifts move away on their own)
  for (const c of truckCircles(g)) circle(c, c.r + BOT_R + margin);
  if (avoidBots) for (const b of bots(g)) {
    if (b !== avoidBots && b.show > 0 && !canYield(g, avoidBots, b)) circle(b, BOT_SPACE + 0.1);
  }
  return { nx, ny, blocked, fixed };
}

const cellOf = (grid, p) => ({ i: Math.max(0, Math.min(grid.nx - 1, Math.floor(p.x / CELL))), j: Math.max(0, Math.min(grid.ny - 1, Math.floor(p.y / CELL))) });
const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

// Nearest unblocked cell (index) to cell `s`, ignoring obstacles on the way; -1 if the grid is full.
function nearestFree(grid, s) {
  const { nx, ny, blocked } = grid, seen = new Uint8Array(nx * ny), q = [s.j * nx + s.i];
  seen[q[0]] = 1;
  for (let k = 0; k < q.length; k++) {
    const id = q[k];
    if (!blocked[id]) return id;
    const i = id % nx, j = (id - i) / nx;
    for (const [di, dj] of NB) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny || seen[nj * nx + ni]) continue;
      seen[nj * nx + ni] = 1; q.push(nj * nx + ni);
    }
  }
  return -1;
}

// Dijkstra over free cells from `from`. `score(x, y, cost)` ranks cells (lower is better); the best cell within `maxCost` wins.
// Returns the waypoint list (world coordinates) to that cell, or [].
function plan(grid, from, maxCost, score) {
  const { nx, ny, blocked } = grid, n = nx * ny;
  const s = cellOf(grid, from);
  let start = s.j * nx + s.i;
  const escape = grid.fixed?.[start] ? nearestFree(grid, s) : -1; // a bot stuck inside a wall or box (e.g. by a repair mast built on top of it) first walks to the nearest free cell
  const first = escape >= 0 ? { x: ((escape % nx) + 0.5) * CELL, y: (Math.floor(escape / nx) + 0.5) * CELL } : null;
  if (first) start = escape;
  const cost = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
  cost[start] = 0;
  const open = [[0, start]]; // binary min-heap on cost
  const push = (item) => {
    let k = open.push(item) - 1;
    while (k > 0 && open[(k - 1) >> 1][0] > item[0]) { open[k] = open[(k - 1) >> 1]; k = (k - 1) >> 1; }
    open[k] = item;
  };
  const pop = () => {
    const top = open[0], last = open.pop();
    if (open.length) {
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= open.length) break;
        if (c + 1 < open.length && open[c + 1][0] < open[c][0]) c++;
        if (open[c][0] >= last[0]) break;
        open[k] = open[c]; k = c;
      }
      open[k] = last;
    }
    return top;
  };
  let best = start, bestScore = Infinity;
  while (open.length) {
    const [c, id] = pop();
    if (c > cost[id]) continue;
    const i = id % nx, j = (id - i) / nx;
    const sc = score((i + 0.5) * CELL, (j + 0.5) * CELL, c);
    if (sc < bestScore) { bestScore = sc; best = id; }
    for (const [di, dj, w] of NB) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny || blocked[nj * nx + ni]) continue;
      if (di && dj && (blocked[j * nx + ni] || blocked[nj * nx + i])) continue;
      const nc = c + w * CELL;
      if (nc > maxCost || nc >= cost[nj * nx + ni]) continue;
      cost[nj * nx + ni] = nc; prev[nj * nx + ni] = id;
      push([nc, nj * nx + ni]);
    }
  }
  const path = [];
  for (let id = best; id !== start && id >= 0; id = prev[id]) path.push({ x: ((id % nx) + 0.5) * CELL, y: (Math.floor(id / nx) + 0.5) * CELL });
  path.reverse();
  return first ? [first, ...path] : path;
}

// How far (capped at 8 tiles) a point is from the nearest forklift; bots prefer goals far from the forklifts.
const FAR_CAP = 8, FAR_WEIGHT = 2, CLEAN_FAR_WEIGHT = 6; // the cleaner weighs distance from forklifts well above its own travel distance
// A bot that had to flee from a forklift keeps SPOOK_SECS of extra caution: its far-from-forklift preference is multiplied by SPOOK_MULT.
const SPOOK_SECS = 25, SPOOK_MULT = 4;
const farWeight = (g, bot, base) => base * (bot.spookedUntil > g.clock ? SPOOK_MULT : 1);
function farFromTrucks(g, p) {
  let d = FAR_CAP;
  for (const c of truckCircles(g)) d = Math.min(d, Math.hypot(p.x - c.x, p.y - c.y) - c.r);
  return Math.max(0, d);
}

const spillDrops = (sp, dropArea) => sp.drops ?? sp.r * sp.r / dropArea;

// ---- Blocked routes ----
// Targets the bot gave up on for a while (`bot.skip`: key -> g.clock until which it is ignored); used only if something else is left to do.
const SKIP_SECS = 10, GIVE_UP_SECS = 3, REPLAN = 0.4, KEEP_ROUTE = 1e9; // KEEP_ROUTE: no periodic replanning (survives JSON, unlike Infinity)
const skipped = (g, bot, key) => (bot.skip?.[key] ?? 0) > g.clock;
function preferLive(g, bot, items, keyOf) {
  const live = items.filter((o) => !skipped(g, bot, keyOf(o)));
  return live.length ? live : items;
}

// Check only the next half tile of the route, so distant obstacles are dealt with when reached.
function blockedAhead(g, bot) {
  if (!bot.path.length) return false;
  const pts = [], limit = 0.5;
  let from = bot, left = limit;
  for (const w of bot.path) {
    const d = Math.hypot(w.x - from.x, w.y - from.y);
    if (d < 1e-8) continue;
    const length = Math.min(d, left), steps = Math.ceil(length / 0.1);
    for (let i = 1; i <= steps; i++) pts.push({ x: from.x + (w.x - from.x) * length * i / steps / d, y: from.y + (w.y - from.y) * length * i / steps / d });
    left -= length;
    if (left <= 1e-8) break;
    from = w;
  }
  const trucks = truckCircles(g);
  return pts.some((p) => g.walls.some((w) => rectDist(p.x, p.y, w) < (bot === g.tapeBot ? 0.25 : BOT_R))
    || trucks.some((c) => Math.hypot(p.x - c.x, p.y - c.y) < c.r + BOT_R * 0.9)
    || (!bot.passing && !bot.yieldPath?.length && bots(g).some((b) => b !== bot && b.show > 0 && !canYield(g, bot, b) && Math.hypot(p.x - b.x, p.y - b.y) < BOT_SPACE))
    || g.stacks.some((s) => bot === g.tapeBot ? nearBox(s, p.x, p.y, 0.2) : Math.hypot(p.x - s.x, p.y - s.y) < STACK_R + BOT_R * 0.9));
}

// Where to wait while the way is blocked: a nearby free cell with room around it (away from forklifts, walls and boxes), so the bot
// is not in anybody's way. Staying put is free, so it only moves when its spot is bad.
function waitPlan(g, bot, grid) {
  const trucks = truckCircles(g);
  return plan(grid, bot, 6, (x, y, c) => {
    let clear = 3;
    for (const t of trucks) clear = Math.min(clear, Math.hypot(x - t.x, y - t.y) - t.r);
    let room = 1.2;
    for (const w of g.walls) room = Math.min(room, rectDist(x, y, w));
    for (const s of g.stacks) room = Math.min(room, Math.hypot(x - s.x, y - s.y) - STACK_R);
    return -Math.max(0, clear) * 3 - Math.max(0, room) * 2 + c * 0.6;
  });
}

// Plans the way to a goal on the grid with forklifts as obstacles. `reached(end)` tells whether a route ending there gets the bot where it
// wants to be; if not (forklifts or boxes block every way), the bot picks a waiting spot, replans every REPLAN seconds so it sets off as soon
// as a way opens (the Dijkstra search finds a detour on its own), and gives the target up for a while after GIVE_UP_SECS of waiting.
function goalPlan(g, bot, key, score, reached) {
  const grid = buildGrid(g, 0.45, bot === g.tapeBot, bot);
  const path = plan(grid, bot, 80, score);
  const end = path.length ? path[path.length - 1] : bot;
  if (reached(end)) { bot.waiting = false; bot.waitT = 0; return path; }
  bot.waiting = true;
  bot.waitT = (bot.waitT || 0) + REPLAN;
  if (key != null && bot.waitT >= GIVE_UP_SECS) { (bot.skip ||= {})[key] = g.clock + SKIP_SECS; bot.waitT = 0; }
  return waitPlan(g, bot, grid);
}

// Spills out in the open first, oil under a stack only once those are done; within each group small drops first
// (they are quick to finish), then the nearest one.
function pickSpill(g, bot, dropArea) {
  let best = null, bs = Infinity;
  for (const sp of preferLive(g, bot, g.oil || [], (o) => o.id)) {
    const sc = (underStack(g, sp) ? 1e6 : 0) + Math.round(spillDrops(sp, dropArea) * 4) * 100 + Math.hypot(sp.x - bot.x, sp.y - bot.y) - (bot.spookedUntil > g.clock ? farWeight(g, bot, CLEAN_FAR_WEIGHT) * farFromTrucks(g, sp) : 0); // only a spooked cleaner goes for far-away spills
    if (sc < bs) { bs = sc; best = sp; }
  }
  return best;
}

// Oil under a stack can't be driven to: the bot stops at the edge and reaches in with its brush arms.
const STACK_R = 0.75, REACH = 1.45;
const underStack = (g, p) => g.stacks.some((s) => Math.hypot(s.x - p.x, s.y - p.y) < STACK_R);

function clearBotSpot(g, bot, p) {
  return p.x >= BOT_R && p.y >= BOT_R && p.x <= g.w - BOT_R && p.y <= g.h - BOT_R
    && !g.walls.some((w) => rectDist(p.x, p.y, w) < BOT_R)
    && !g.stacks.some((s) => bot === g.tapeBot ? nearBox(s, p.x, p.y, 0.2) : Math.hypot(p.x - s.x, p.y - s.y) < STACK_R + BOT_R)
    && truckGap(g, p) >= 0;
}

function moveBot(g, bot, x, y) {
  const dx = x - bot.x, dy = y - bot.y, len2 = dx * dx + dy * dy;
  for (const o of bots(g)) {
    if (o === bot || o.show <= 0) continue;
    const t = len2 ? Math.max(0, Math.min(1, ((o.x - bot.x) * dx + (o.y - bot.y) * dy) / len2)) : 0;
    const d = Math.hypot(bot.x + dx * t - o.x, bot.y + dy * t - o.y);
    if (d < Math.min(BOT_SPACE, Math.hypot(bot.x - o.x, bot.y - o.y)) - 1e-8) return false;
  }
  bot.x = x; bot.y = y;
  return true;
}

// Keep the route, but steer around a blocking bot on our right (positive world-y when heading east).
function passingPoint(g, bot, w) {
  if (bot.yieldPath?.length) return bot.yieldPath[0];
  if (bot.passing && clearBotSpot(g, bot, bot.passing)) return bot.passing;
  bot.passing = null;
  if (!w) return bot;
  const dx = w.x - bot.x, dy = w.y - bot.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
  const other = bots(g).filter((o) => {
    if (o === bot || o.show <= 0) return false;
    const ox = o.x - bot.x, oy = o.y - bot.y;
    return ox * ux + oy * uy > 0 && Math.hypot(ox, oy) < 1.4 && Math.abs(ox * uy - oy * ux) < BOT_SPACE;
  }).sort((a, b) => Math.hypot(a.x - bot.x, a.y - bot.y) - Math.hypot(b.x - bot.x, b.y - bot.y))[0];
  if (!other) return w;
  if (canYield(g, bot, other)) {
    if (pathDistance(other, bot, bot.path) >= BOT_SPACE + 0.3) return w;
    const key = botKey(g, bot);
    if (other.yieldFor !== key) { other.yieldFor = key; other.yieldPath = []; other.yieldWait = 0; other.repath = 0; }
    return bot;
  }
  const side = BOT_SPACE + 0.15;
  const p = { x: bot.x - uy * side, y: bot.y + ux * side,
    next: { x: other.x + ux * side - uy * side, y: other.y + uy * side + ux * side } };
  const steps = Math.ceil(Math.hypot(p.x - bot.x, p.y - bot.y) / 0.1);
  for (let i = 1; i <= steps; i++) {
    if (!clearBotSpot(g, bot, { x: bot.x + (p.x - bot.x) * i / steps, y: bot.y + (p.y - bot.y) * i / steps })) {
      // In single-file gaps one bot backs into a roomy passing place; the other waits.
      if (bots(g).indexOf(bot) > bots(g).indexOf(other)) {
        bot.yieldPath = plan(buildGrid(g, 0.1, bot === g.tapeBot, bot), bot, 6, (x, y, cost) => {
          if (Math.hypot(x - other.x, y - other.y) < BOT_SPACE + 0.2) return Infinity;
          let room = 1;
          for (const wall of g.walls) room = Math.min(room, rectDist(x, y, wall));
          if (room < 0.8) return Infinity;
          const right = -(x - bot.x) * uy + (y - bot.y) * ux;
          return cost + Math.max(0, 0.8 - right) * 2;
        });
        if (bot.yieldPath.length) return bot.yieldPath[0];
      }
      return bot;
    }
  }
  bot.passing = p;
  return p;
}

// Moves along bot.path by `move` tiles, turning towards each waypoint; returns the unused distance.
function followPath(g, bot, move, dt) {
  let turned = false;
  while ((bot.path.length || bot.yieldPath?.length || bot.passing) && move > 0) {
    const w = passingPoint(g, bot, bot.path[0]), d = Math.hypot(w.x - bot.x, w.y - bot.y);
    if (w === bot) return 0;
    if (d < 1e-6) {
      if (w === bot.yieldPath?.[0]) bot.yieldPath.shift();
      else if (w === bot.passing) bot.passing = w.next || null;
      else bot.path.shift();
      continue;
    }
    const ang = Math.atan2(w.y - bot.y, w.x - bot.x);
    if (!turned) { turned = true; if (Math.abs(turnTo(bot, ang, dt, bot.scared ? FLEE_TURN_RATE : TURN_RATE)) > TURN_FIRST) return move; }
    else if (Math.abs(angDiff(bot.a, ang)) > TURN_FIRST) return move;
    const step = Math.min(d, move);
    if (!moveBot(g, bot, bot.x + Math.cos(ang) * step, bot.y + Math.sin(ang) * step)) {
      bot.passing = null; bot.yieldPath = []; bot.repath = 0;
      return 0;
    }
    if (d <= move) {
      move -= d;
      if (w === bot.yieldPath?.[0]) { bot.yieldPath.shift(); if (!bot.yieldPath.length) bot.repath = 0; }
      else if (w === bot.passing) { bot.passing = w.next || null; if (!bot.passing) bot.repath = 0; }
      else bot.path.shift();
      continue;
    }
    move = 0;
  }
  return move;
}

// Get pushed out of a forklift that reached the bot anyway (and off the other bot).
function pushOut(g, bot) {
  for (const c of truckCircles(g)) {
    const d = Math.hypot(bot.x - c.x, bot.y - c.y), min = c.r + BOT_R * 0.8;
    if (d < min && d > 1e-6) { bot.x = c.x + (bot.x - c.x) / d * min; bot.y = c.y + (bot.y - c.y) / d * min; }
  }
  for (const w of g.walls) { // being pushed must never leave the bot inside a wall (or the repair mast)
    const d = rectDist(bot.x, bot.y, w);
    if (d >= BOT_R) continue;
    if (d > 1e-6) {
      const cx = Math.max(w.x, Math.min(bot.x, w.x + w.w)), cy = Math.max(w.y, Math.min(bot.y, w.y + w.h));
      bot.x = cx + (bot.x - cx) / d * BOT_R; bot.y = cy + (bot.y - cy) / d * BOT_R;
    } else { // centre inside the rectangle: leave through the nearest side
      const gaps = [[bot.x - w.x, -1, 0], [w.x + w.w - bot.x, 1, 0], [bot.y - w.y, 0, -1], [w.y + w.h - bot.y, 0, 1]].sort((a, b) => a[0] - b[0])[0];
      bot.x += gaps[1] * (gaps[0] + BOT_R); bot.y += gaps[2] * (gaps[0] + BOT_R);
    }
  }
  for (const o of bots(g)) {
    if (!o || o === bot || o.show <= 0) continue;
    const d = Math.hypot(bot.x - o.x, bot.y - o.y);
    if (d >= BOT_SPACE) continue;
    const a = d > 1e-6 ? Math.atan2(bot.y - o.y, bot.x - o.x) : bot.a + Math.PI / 2;
    for (let i = 0; i < 16; i++) {
      const p = { x: o.x + Math.cos(a + i * Math.PI / 8) * BOT_SPACE, y: o.y + Math.sin(a + i * Math.PI / 8) * BOT_SPACE };
      if (clearBotSpot(g, bot, p) && bots(g).every((b) => b === bot || b === o || b.show <= 0 || Math.hypot(p.x - b.x, p.y - b.y) >= BOT_SPACE)) {
        bot.x = p.x; bot.y = p.y; break;
      }
    }
  }
}

// Flee plan: the reachable cell furthest from every forklift.
function fleePlan(g, bot) {
  const trucks = truckCircles(g);
  return plan(buildGrid(g, 0, bot === g.tapeBot, bot), bot, 7, (x, y, c) => {
    let clear = Infinity;
    for (const t of trucks) clear = Math.min(clear, Math.hypot(x - t.x, y - t.y) - t.r);
    let room = 1.5; // wall-hugging spots and corners are traps: a forklift can pin the bot there
    for (const w of g.walls) room = Math.min(room, rectDist(x, y, w));
    return -Math.min(clear, 4) * 3 + (1.5 - room) * 4 + c * 0.2;
  });
}

const IDLE_SECS = 600, FOLLOW_GAP = 3.5;

// Changing activity discards the old route so new work or a trip home always takes priority.
function activity(bot, work, dt) {
  bot.idle = work ? 0 : (bot.idle || 0) + dt;
  const next = work ? 'work' : bot.idle >= IDLE_SECS ? 'home' : 'follow';
  if (bot.activity !== next) {
    bot.activity = next; bot.path = []; bot.repath = 0; bot.planKey = null;
    bot.target = null; bot.shooting = 0; bot.idleEscape = false;
    bot.curiosity = null; bot.observing = false; bot.passing = null;
    bot.yieldPath = []; bot.yieldFor = null; bot.yieldBlock = null;
  }
  if (work) bot.leaving = false;
  return next;
}

function sightHits(p, end, x, y, hx, hy, a = 0) {
  const c = Math.cos(a), s = Math.sin(a), dx = end.x - p.x, dy = end.y - p.y;
  let lo = 0, hi = 1;
  for (const [v, d, h] of [
    [(p.x - x) * c + (p.y - y) * s, dx * c + dy * s, hx],
    [-(p.x - x) * s + (p.y - y) * c, -dx * s + dy * c, hy],
  ]) {
    if (Math.abs(d) < 1e-9) { if (Math.abs(v) > h) return false; }
    else {
      const t0 = (-h - v) / d, t1 = (h - v) / d;
      lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
      if (lo > hi) return false;
    }
  }
  return true;
}

function truckSight(g, p, truck) {
  const aim = toWorld(truck.fl, -0.7, 0);
  return !g.walls.some((w) => sightHits(p, aim, w.x + w.w / 2, w.y + w.h / 2, w.w / 2, w.h / 2))
    && !g.stacks.some((s) => s.layers.some((_, i) => {
      const off = s.offs?.[i] || { x: 0, y: 0 };
      return sightHits(p, aim, s.x + off.x, s.y + off.y, BOX_HALF_X, halfY(s.pen?.[i]), s.rots?.[i] ?? s.a ?? 0);
    }));
}

function viewingSpot(g, bot, p, truck) {
  return truckGap(g, p) >= 2.5
    && Math.hypot(p.x - truck.fl.x, p.y - truck.fl.y) < 8
    && bots(g).every((b) => b === bot || b.show <= 0 || Math.hypot(p.x - b.x, p.y - b.y) >= BOT_SPACE + 0.2)
    && truckSight(g, p, truck);
}

// A peek is close to an obstacle corner, with the sightline grazing its edge rather than crossing it.
function viewCover(g) {
  const rects = g.walls.map((w) => ({ x: w.x + w.w / 2, y: w.y + w.h / 2, hx: w.w / 2, hy: w.h / 2, a: 0 }));
  for (const s of g.stacks) for (let i = 0; i < s.layers.length; i++) {
    const off = s.offs?.[i] || { x: 0, y: 0 };
    rects.push({ x: s.x + off.x, y: s.y + off.y, hx: BOX_HALF_X, hy: halfY(s.pen?.[i]), a: s.rots?.[i] ?? s.a ?? 0 });
  }
  return rects.map((r) => ({ ...r, corners: rectPoly(r.x, r.y, r.hx, r.hy, r.a) }));
}

function peeking(p, aim, cover) {
  return cover.some((r) => {
    if (!r.corners.some((c) => Math.hypot(p.x - c.x, p.y - c.y) < 1.6)) return false;
    const c = Math.cos(r.a), s = Math.sin(r.a), dx = p.x - r.x, dy = p.y - r.y;
    const x = Math.max(-r.hx, Math.min(r.hx, dx * c + dy * s));
    const y = Math.max(-r.hy, Math.min(r.hy, -dx * s + dy * c));
    const near = { x: r.x + x * c - y * s, y: r.y + x * s + y * c };
    return (near.x - p.x) * (aim.x - p.x) + (near.y - p.y) * (aim.y - p.y) > 0
      && sightHits(p, aim, r.x, r.y, r.hx + 0.45, r.hy + 0.45, r.a);
  });
}

function pathDistance(p, from, path) {
  let best = Infinity, start = from, length = 0;
  for (const end of path) {
    const dx = end.x - start.x, dy = end.y - start.y, d2 = dx * dx + dy * dy;
    const t = d2 ? Math.max(0, Math.min(1, ((p.x - start.x) * dx + (p.y - start.y) * dy) / d2)) : 0;
    best = Math.min(best, Math.hypot(p.x - start.x - t * dx, p.y - start.y - t * dy));
    length += Math.sqrt(d2);
    if (length >= 5) break;
    start = end;
  }
  return best;
}

function makeWay(g, bot, dt, speed) {
  const worker = g[bot.yieldFor];
  if (!worker || worker.show <= 0 || worker.activity !== 'work' || worker.scared || !worker.path.length
      || (Math.hypot(bot.x - worker.x, bot.y - worker.y) > 2 && !bot.yieldPath?.length)) {
    bot.yieldFor = null; bot.yieldPath = []; bot.repath = 0;
    return false;
  }
  bot.observing = false; bot.path = []; bot.passing = null;
  const inWay = pathDistance(bot, worker, worker.path) < BOT_SPACE + 0.3;
  if (!bot.yieldPath?.length && inWay && bot.repath <= 0) {
    bot.yieldPath = plan(buildGrid(g, 0.1, bot === g.tapeBot, bot), bot, 12, (x, y, cost) => {
      const p = { x, y };
      if (Math.hypot(x - worker.x, y - worker.y) < BOT_SPACE + 0.3
          || pathDistance(p, worker, worker.path) < BOT_SPACE + 0.3) return Infinity;
      return cost;
    });
    bot.repath = REPLAN;
  }
  if (bot.yieldPath?.length) { bot.yieldWait = 0; followPath(g, bot, speed * dt, dt); }
  else if (inWay && (bot.yieldWait = (bot.yieldWait || 0) + dt) >= 2) {
    bot.yieldBlock = { worker: bot.yieldFor, left: 3 };
    bot.yieldFor = null; bot.repath = 0; worker.repath = 0;
    return false;
  }
  return true;
}

// Curious bots travel to a visible vantage point, then watch for 5-15 simulated seconds.
function followTruck(g, bot, dt, speed) {
  if (bot.yieldBlock && (bot.yieldBlock.left -= dt) <= 0) bot.yieldBlock = null;
  if (bot.yieldFor && makeWay(g, bot, dt, speed)) return;
  const wall = g.walls.find((w) => rectDist(bot.x, bot.y, w) < BOT_R * 1.05);
  if (wall || bot.idleEscape) {
    bot.observing = false;
    if (!bot.idleEscape) {
      pushOut(g, bot);
      bot.path = plan(buildGrid(g, 0.45, bot === g.tapeBot, bot), bot, 6, (x, y, cost) => Math.max(0, 1.5 - rectDist(x, y, wall)) * 4 + cost * 0.2);
      bot.idleEscape = true; bot.curiosity = null;
    }
    followPath(g, bot, speed * dt, dt);
    if (!bot.path.length) { bot.idleEscape = false; bot.repath = 0; }
    return;
  }
  const trucks = g.trucks.filter((t) => !t.gone);
  let q = bot.curiosity, truck = q && trucks.find((t) => t.id === q.truck);
  bot.observing = false;
  if (q && blockedAhead(g, bot)) bot.repath = 0;
  if (!q && bot.repath <= 0) {
    const grid = buildGrid(g, 0.45, bot === g.tapeBot, bot);
    const cover = viewCover(g);
    for (truck of trucks.sort((a, b) => Math.hypot(bot.x - a.fl.x, bot.y - a.fl.y) - Math.hypot(bot.x - b.fl.x, bot.y - b.fl.y))) {
      const circles = circlesOf(truck), centre = toWorld(truck.fl, -0.7, 0);
      const previous = bot.lastView;
      const score = (x, y, cost) => {
        const p = { x, y };
        if (previous && Math.hypot(x - previous.x, y - previous.y) < 1) return Infinity;
        const gap = Math.min(...circles.map((c) => Math.hypot(x - c.x, y - c.y) - c.r - BOT_R));
        if (gap < 2.5 || !viewingSpot(g, bot, p, truck)) return Infinity;
        return (peeking(p, centre, cover) ? 0 : 1000)
          + cost * 10 + Math.abs(gap - FOLLOW_GAP) * 0.05;
      };
      bot.path = plan(grid, bot, 80, score);
      let end = bot.path.at(-1) || bot;
      if (!bot.path.length) {
        const { i, j } = cellOf(grid, bot), p = { x: (i + 0.5) * CELL, y: (j + 0.5) * CELL };
        if (!grid.blocked[j * grid.nx + i] && Number.isFinite(score(p.x, p.y, 0))
            && (!Number.isFinite(score(end.x, end.y, 0)) || (peeking(p, centre, cover) && !peeking(end, centre, cover)))) {
          bot.path = [p]; end = p;
        }
      }
      if (Number.isFinite(score(end.x, end.y, 0))) {
        q = bot.curiosity = { x: end.x, y: end.y, truck: truck.id, left: null };
        break;
      }
      bot.path = [];
    }
    bot.repath = q ? KEEP_ROUTE : REPLAN;
  }
  if (!q) return;
  if (bot.repath <= 0 && !bot.passing) {
    bot.path = plan(buildGrid(g, 0.45, bot === g.tapeBot, bot), bot, 80, (x, y, cost) => Math.hypot(x - q.x, y - q.y) * 10 + cost * 0.02);
    bot.repath = bot.path.length ? KEEP_ROUTE : REPLAN;
  }
  bot.goal = { x: q.x, y: q.y };
  followPath(g, bot, speed * dt, dt);
  if (bot.path.length || bot.passing || bot.yieldPath?.length) return;
  if (Math.hypot(bot.x - q.x, bot.y - q.y) > 0.15) {
    if (bot.repath > REPLAN) bot.repath = REPLAN;
    return;
  }
  if (!truck || !viewingSpot(g, bot, bot, truck)) { bot.curiosity = null; bot.repath = 0; return; }
  const aim = toWorld(truck.fl, -0.7, 0);
  if (Math.abs(turnTo(bot, Math.atan2(aim.y - bot.y, aim.x - bot.x), dt)) > 0.15) return;
  bot.observing = true;
  if (q.left === null) q.left = 5 + Math.random() * 10;
  else q.left -= dt;
  if (q.left <= 0) {
    bot.lastView = { x: q.x, y: q.y }; bot.curiosity = null; bot.repath = 0; bot.observing = false;
  }
}

export function stepBot(g, dt, dropArea) {
  const bot = g.bot;
  if (!bot || !g.hatch) return;
  const home = botLane(g.hatch);
  const spill = pickSpill(g, bot, dropArea);
  const trucks = truckCircles(g);
  const safeMark = (m) => trucks.every((c) => Math.hypot(m.x - c.x, m.y - c.y) > c.r + SKID_TRUCK_CLEARANCE);
  const mark = !spill && preferLive(g, bot, (g.skidMarks || []).filter(safeMark), (m) => m.id)
    .reduce((best, m) => !best || Math.hypot(m.x - bot.x, m.y - bot.y) < Math.hypot(best.x - bot.x, best.y - bot.y) ? m : best, null);
  const target = spill || mark;
  bot.debugTask = target ? `${spill ? 'spill' : 'skid'} ${target.id} at ${target.x.toFixed(1)},${target.y.toFixed(1)}` : null;
  const gap = truckGap(g, bot, true);

  if (bot.mode === 'hidden') {
    if (!target) return;
    bot.mode = 'out';
  }
  const current = activity(bot, !!target, dt);
  if (bot.show < 1) { if (bot.leaving) retract(g, bot, dt); else emerge(g, bot, dt); return; }
  bot.scared = gap < (bot.scared ? CALM : SCARE);
  if (bot.scared) bot.spookedUntil = g.clock + SPOOK_SECS;
  bot.cleaning = false;
  let speed = SPEED;
  let goal = null;

  bot.repath -= dt;
  bot.goal = null;
  if (bot.scared) {
    if (bot.yieldFor) { bot.yieldFor = null; bot.yieldPath = []; bot.repath = 0; }
    bot.curiosity = null; bot.observing = false;
    speed = FLEE_SPEED;
    if (bot.repath <= 0 || bot.fleePath !== true) {
      bot.path = fleePlan(g, bot);
      bot.fleePath = true; bot.repath = 0.25;
    }
  } else {
    if (bot.fleePath) bot.repath = 0;
    bot.fleePath = false;
    if (current === 'follow') {
      followTruck(g, bot, dt, speed);
      pushOut(g, bot);
      return;
    }
    const key = target?.id ?? 'home';
    if (bot.planKey !== key) { bot.planKey = key; bot.repath = 0; }
    goal = spill ? { x: spill.x, y: spill.y, r: Math.max(0.08, Math.sqrt(spillDrops(spill, dropArea) * dropArea) * 0.5) }
      : mark ? { x: mark.x, y: mark.y, r: 0.35 } : { ...home, r: 0.08 };
    bot.goal = { x: goal.x, y: goal.y }; // shown by the debug overlay
    if (blockedAhead(g, bot)) bot.repath = 0;
    if (bot.repath <= 0) {
      const covered = target && underStack(g, target);
      bot.path = goalPlan(g, bot, target?.id, (x, y) => Math.max(0, Math.hypot(x - goal.x, y - goal.y) - goal.r) * 10,
        (e) => { const d = Math.hypot(e.x - goal.x, e.y - goal.y); return covered ? d <= REACH - 0.05 : d < goal.r + 0.5; });
      bot.repath = bot.waiting || !bot.path.length ? REPLAN : KEEP_ROUTE; // a route is kept until something disturbs it
    }
  }

  let move = followPath(g, bot, speed * dt, dt);
  // The grid is coarse: finish the last few centimetres in a straight line.
  if (!bot.path.length && goal && move > 0) {
    const d = Math.hypot(goal.x - bot.x, goal.y - bot.y);
    if (d > 1e-6 && d < 0.5 && truckGap(g, goal) > 0 && !underStack(g, goal)) {
      const step = Math.min(move, Math.max(0, d - goal.r * 0.5));
      if (Math.abs(turnTo(bot, Math.atan2(goal.y - bot.y, goal.x - bot.x), dt)) < TURN_FIRST) moveBot(g, bot, bot.x + (goal.x - bot.x) / d * step, bot.y + (goal.y - bot.y) / d * step);
    } else if (!target && d >= 0.5 && bot.repath > REPLAN) bot.repath = REPLAN;
  }

  pushOut(g, bot);

  if (!bot.scared && goal) {
    const d = Math.hypot(goal.x - bot.x, goal.y - bot.y);
    const reaching = target && !bot.path.length && d <= REACH && underStack(g, target);
    if (target && (d <= goal.r + 0.12 || reaching)) {
      bot.cleaning = true;
      if (reaching) turnTo(bot, Math.atan2(goal.y - bot.y, goal.x - bot.x), dt);
      if (spill) {
        const drops = spillDrops(spill, dropArea) - dt / CLEAN_SECS;
        if (drops <= 1e-9) g.oil.splice(g.oil.indexOf(spill), 1);
        else { spill.drops = drops; spill.r = Math.sqrt(drops * dropArea); }
      } else {
        for (const m of g.skidMarks) if (safeMark(m) && Math.hypot(m.x - mark.x, m.y - mark.y) < 0.5) m.left -= dt / SKID_CLEAN_SECS;
        g.skidMarks = g.skidMarks.filter((m) => m.left > 1e-9);
      }
    } else if (!target && Math.hypot(home.x - bot.x, home.y - bot.y) < 0.15) {
      retract(g, bot, dt);
      return;
    }
  }
}

// ---- Safety markings ----
const zoneMarkKey = (z) => `${z.x},${z.y},${z.color}`;
export const areaMarkKey = (a) => `${a.color}:${a.x},${a.y},${a.w},${a.h}`;
const zonesInArea = (g, a) => g.zones.filter((z) => z.color === a.color
  && z.x >= a.x - 0.1 && z.x <= a.x + a.w + 0.1
  && z.y >= a.y - 0.1 && z.y <= a.y + a.h + 0.1);

// Cones frame slicks and the actual footprint of inspected stacks. Existing cones are
// reconciled against these stable IDs, so a moving truck naturally takes its markings with it.
export function coneTargets(g, doneZones, stackAt = (z) => g.stacks.find((s) => Math.hypot(s.x - z.x, s.y - z.y) < 0.5), markedZones = doneZones) {
  const targets = new Map();
  const tapedAreas = (g.tapes || []).filter((t) => !t.broken).map((t) => {
    const corners = tapeCorners(t);
    return { x0: corners[0].x, x1: corners[1].x, y0: corners[0].y, y1: corners[2].y };
  });
  for (const spill of g.oil || []) {
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      const id = `spill:${spill.id}:${i}`;
      targets.set(id, { id, x: spill.x + Math.cos(a) * (spill.r + 0.35), y: spill.y + Math.sin(a) * (spill.r + 0.35) });
    }
  }
  for (const z of markedZones) {
    const stack = stackAt(z);
    if (!stack) continue;
    const angle = stack.rots?.[0] ?? stack.a ?? 0;
    const hx = BOX_HALF_X + 0.18, hy = halfY(stack.pen?.[0]) + 0.18;
    const neighbours = g.zones.filter((other) => other !== z);
    const add = (id, x, y) => {
      const d = Math.hypot(x - stack.x, y - stack.y) || 1, standR = STACK_R + BOT_R + 0.5;
      targets.set(id, { id, x, y, stackCenter: { x: stack.x, y: stack.y }, approach: { x: stack.x + (x - stack.x) / d * standR, y: stack.y + (y - stack.y) / d * standR } });
    };
    for (let i = 0; i < 4; i++) {
      const sx = i & 1 ? 1 : -1, sy = i & 2 ? 1 : -1;
      const x = stack.x + sx * hx * Math.cos(angle) - sy * hy * Math.sin(angle);
      const y = stack.y + sx * hx * Math.sin(angle) + sy * hy * Math.cos(angle);
      const nearNeighbourCorner = neighbours.some((other) => {
        const e = zoneExt(other);
        return [-1, 1].some((dx) => [-1, 1].some((dy) =>
          Math.hypot(x - (other.x + dx * e.x), y - (other.y + dy * e.y)) < 0.5));
      });
      if (!nearNeighbourCorner) add(`stack:${zoneMarkKey(z)}:${i}`, x, y);
    }
  }
  const unique = [];
  for (const target of targets.values()) {
    if (tapedAreas.some((a) => target.x >= a.x0 && target.x <= a.x1 && target.y >= a.y0 && target.y <= a.y1)) continue;
    if (!unique.some((o) => Math.hypot(o.x - target.x, o.y - target.y) < 0.16)) unique.push(target);
  }
  return unique;
}

function coneWorkKey(target) {
  const i = target.id.lastIndexOf(':');
  return i < 0 ? target.id : target.id.slice(0, i);
}

const CONE_RETRY_SECS = 10, CONE_PLAN_SECS = 3, CONE_R = 0.13;
function clearConeSpot(g, p, ignored, trucks = truckCircles(g)) {
  return p.x >= CONE_R && p.y >= CONE_R && p.x <= g.w - CONE_R && p.y <= g.h - CONE_R
    && !g.walls.some((w) => rectDist(p.x, p.y, w) < CONE_R)
    && !g.stacks.some((s) => Math.hypot(p.x - s.x, p.y - s.y) < STACK_R + CONE_R || nearBox(s, p.x, p.y, CONE_R))
    && !trucks.some((c) => Math.hypot(p.x - c.x, p.y - c.y) < c.r + CONE_R)
    && !(g.cones || []).some((c) => c !== ignored && Math.hypot(p.x - c.x, p.y - c.y) < CONE_R * 2);
}

function conePlacement(g, bot, target, goal) {
  const grid = buildGrid(g, 0.45, false, bot);
  const trucks = truckCircles(g);
  const path = plan(grid, bot, 80, (x, y, cost) => clearConeSpot(g, { x, y }, null, trucks)
    ? Math.hypot(x - goal.x, y - goal.y) * 10 + cost * 0.02 : Infinity);
  const end = path.at(-1) || { x: bot.x, y: bot.y };
  const clearLine = !g.walls.some((w) => sightHits(end, target, w.x + w.w / 2, w.y + w.h / 2, w.w / 2 + CONE_R, w.h / 2 + CONE_R));
  const ideal = Math.hypot(end.x - goal.x, end.y - goal.y) < 0.6 && clearLine && clearConeSpot(g, target);
  const spot = ideal ? { x: target.x, y: target.y } : end;
  if (!clearConeSpot(g, spot)) return null;
  return { goal: end, spot, misplaced: !ideal };
}

export function areaComplete(g, area, stackAt, doneZones, wonky) {
  const done = new Set(doneZones.map(zoneMarkKey));
  const zones = zonesInArea(g, area);
  return zones.length > 0 && zones.every((z) => {
    const s = stackAt(z);
    return done.has(zoneMarkKey(z)) && !!s && !wonky(s, z)
      && !s.pen?.some((p) => p?.crash > 0 && repairable(p));
  });
}

function stepWorker(g, bot, dt, hasWork, goal, goalKey, speed = 1.5) {
  if (!bot || !g.hatch) return;
  bot.goal = null;
  if (bot.mode === 'hidden') {
    if (!hasWork) return;
    bot.mode = 'out';
  }
  const current = activity(bot, hasWork, dt);
  if (bot.show < 1) { if (bot.leaving) retract(g, bot, dt); else emerge(g, bot, dt); return; }
  const wasScared = bot.scared;
  bot.scared = approachGap(g, bot) < (wasScared ? CALM : SCARE);
  if (bot.scared) bot.spookedUntil = g.clock + SPOOK_SECS;
  bot.repath -= dt;
  if (bot.scared) {
    if (bot.yieldFor) { bot.yieldFor = null; bot.yieldPath = []; bot.repath = 0; }
    bot.curiosity = null; bot.observing = false;
    if (bot.repath <= 0 || !bot.fleePath) {
      bot.path = fleePlan(g, bot); bot.fleePath = true; bot.repath = 0.25;
    }
    followPath(g, bot, FLEE_SPEED * (bot === g.tapeBot ? 2 : 1) * dt, dt);
    pushOut(g, bot);
    return;
  }
  if (wasScared || bot.fleePath) { bot.path = []; bot.repath = 0; bot.fleePath = false; }
  if (bot === g.tapeBot && current === 'work' && !tapeDeploying(bot)) speed *= 2;
  if (current === 'follow') {
    followTruck(g, bot, dt, speed);
    pushOut(g, bot);
    return;
  }
  const destination = current === 'home' ? botLane(g.hatch) : goal;
  const key = current === 'home' ? 'home' : goalKey;
  if (!destination) return;
  bot.goal = { x: destination.x, y: destination.y };
  if (bot.planKey !== key) { bot.planKey = key; bot.repath = 0; }
  if (blockedAhead(g, bot)) bot.repath = 0;
  if (bot.repath <= 0) {
    bot.path = plan(buildGrid(g, 0.45, bot === g.tapeBot, bot), bot, 80, (x, y, c) => Math.hypot(x - destination.x, y - destination.y) * 10 + c * 0.02);
    bot.repath = bot.path.length ? KEEP_ROUTE : REPLAN;
  }
  const left = followPath(g, bot, speed * dt, dt);
  if (!bot.path.length && left > 0) {
    const dx = destination.x - bot.x, dy = destination.y - bot.y, d = Math.hypot(dx, dy);
    if (d > 1e-6 && d < 0.5) {
      const step = Math.min(left, d), a = Math.atan2(dy, dx);
      if (Math.abs(turnTo(bot, a, dt)) < TURN_FIRST) moveBot(g, bot, bot.x + dx / d * step, bot.y + dy / d * step);
    } else if (d >= 0.5 && bot.repath > REPLAN) bot.repath = REPLAN;
  }
  pushOut(g, bot);
  if (current === 'home' && Math.hypot(bot.x - destination.x, bot.y - destination.y) < 0.2 && !bot.path.length) retract(g, bot, dt);
}

export function stepConeBot(g, dt, doneZones, stackAt) {
  const bot = g.coneBot;
  if (!bot) return;
  if (bot.carried) bot.carried = null;
  g.cones ||= [];
  const seen = new Set(g.inspector?.seen || []);
  const targets = coneTargets(g, doneZones, stackAt, doneZones.filter((z) => seen.has(zoneMarkKey(z))));
  const byId = new Map(targets.map((t) => [t.id, t]));
  const approach = (t, cone = t) => {
    if (!t.stackCenter) return cone === t ? t : cone;
    const dx = cone.x - t.stackCenter.x, dy = cone.y - t.stackCenter.y, d = Math.hypot(dx, dy) || 1;
    if (d >= STACK_R + BOT_R + 0.5) return cone === t ? t.approach : cone;
    const r = STACK_R + BOT_R + 0.5;
    return { x: t.stackCenter.x + dx / d * r, y: t.stackCenter.y + dy / d * r };
  };
  const closest = (items, point) => items.reduce((best, item) => {
    const p = point(item), d = Math.hypot(p.x - bot.x, p.y - bot.y);
    return !best || d < best.d ? { item, d } : best;
  }, null)?.item;
  const retrieve = (cone) => {
    const target = byId.get(cone.goalId), goal = target ? approach(target, cone) : cone;
    bot.workKey = coneWorkKey({ id: cone.goalId });
    bot.debugTask = 'retrieving cone';
    stepWorker(g, bot, dt, true, goal, `pickup:${cone.goalId}`);
    if (Math.hypot(bot.x - goal.x, bot.y - goal.y) < (target ? 0.7 : 0.4) && !bot.path.length && !bot.scared) {
      const i = g.cones.indexOf(cone);
      if (i >= 0) g.cones.splice(i, 1);
    } else if (bot.show === 1 && !bot.scared && !bot.path.length && bot.repath <= REPLAN) {
      (bot.skip ||= {})[`cone:${cone.id}`] = g.clock + SKIP_SECS;
    }
  };
  const place = (target, old = null) => {
    bot.workKey = coneWorkKey(target);
    bot.debugTask = 'placing cone';
    let job = bot.conePlan;
    if (!job || job.id !== target.id || job.old !== (old?.id || null)
        || job.until <= g.clock || Math.hypot(job.target.x - target.x, job.target.y - target.y) >= 0.22) {
      const placement = conePlacement(g, bot, target, approach(target));
      job = bot.conePlan = { ...placement, id: target.id, old: old?.id || null,
        target: { x: target.x, y: target.y }, until: g.clock + CONE_PLAN_SECS };
      bot.repath = 0;
      if (old && (!job.goal || Math.hypot(job.spot.x - old.x, job.spot.y - old.y) < CONE_R * 2
          || Math.hypot(job.spot.x - target.x, job.spot.y - target.y) >= Math.hypot(old.x - target.x, old.y - target.y) - 0.22)) {
        old.retryAt = g.clock + CONE_RETRY_SECS;
        bot.conePlan = null;
        stepWorker(g, bot, dt, false, null, null);
        return;
      }
    }
    if (!job.goal) { stepWorker(g, bot, dt, true, approach(target), `place:${target.id}`); return; }
    stepWorker(g, bot, dt, true, job.goal, `place:${target.id}`);
    if (bot.show === 1 && Math.hypot(bot.x - job.goal.x, bot.y - job.goal.y) < 0.2 && !bot.path.length && !bot.scared
        && clearConeSpot(g, job.spot)) {
      bot.coneSeq = (bot.coneSeq || 0) + 1;
      if (old) old.retire = true;
      g.cones.push({ id: `cone:${target.id}:${bot.coneSeq}`, goalId: target.id, ...job.spot, a: 0, tipped: false, squished: false,
        misplaced: job.misplaced, placedX: job.spot.x, placedY: job.spot.y, retryAt: job.misplaced ? g.clock + CONE_RETRY_SECS : 0 });
      bot.conePlan = null;
    }
  };
  const good = new Set();
  const accepted = new Set();
  for (const c of g.cones) {
    const t = byId.get(c.goalId);
    if (t && c.misplaced && Math.hypot(c.x - t.x, c.y - t.y) < 0.22) c.misplaced = false;
    const unmoved = c.placedX == null || Math.hypot(c.x - c.placedX, c.y - c.placedY) < 0.22;
    if (t && !c.retire && !c.tipped && !c.squished && ((c.misplaced && unmoved) || Math.hypot(c.x - t.x, c.y - t.y) < 0.22) && !good.has(c.goalId)) {
      good.add(c.goalId); accepted.add(c);
    }
  }
  const invalid = g.cones.filter((c) => !accepted.has(c));
  const missing = targets.filter((t) => !good.has(t.id));
  const jobs = [
    ...invalid.map((cone) => {
      const target = byId.get(cone.goalId);
      return { type: 'retrieve', item: cone, key: coneWorkKey({ id: cone.goalId }), point: target ? approach(target, cone) : cone };
    }),
    ...missing.map((target) => ({ type: 'place', item: target, key: coneWorkKey(target), point: approach(target) })),
  ];
  const jobKey = (job) => job.type === 'retrieve' ? `cone:${job.item.id}` : `place:${job.item.id}`;
  if (!jobs.some((job) => !skipped(g, bot, jobKey(job)))) for (const cone of accepted) {
    if (cone.misplaced && (cone.retryAt ?? 0) <= g.clock) {
      const target = byId.get(cone.goalId);
      jobs.push({ type: 'improve', item: target, cone, key: coneWorkKey(target), point: approach(target) });
    }
  }
  const liveJobs = preferLive(g, bot, jobs, jobKey);
  const currentJobs = liveJobs.filter((job) => job.key === bot.workKey);
  const selected = closest(currentJobs.length ? currentJobs : liveJobs, (job) => job.point);
  if (selected) {
    bot.workKey = selected.key;
    if (selected.type === 'retrieve') retrieve(selected.item);
    else place(selected.item, selected.cone);
    return;
  }
  bot.workKey = null;
  bot.debugTask = null;
  stepWorker(g, bot, dt, false, null, null);
}

export function tapeCorners(t) {
  const walls = t.wallSides || [];
  const x0 = walls[3] == null ? t.x - 0.3 : walls[3] + 0.08;
  const x1 = walls[1] == null ? t.x + t.w + 0.3 : walls[1] - 0.08;
  const y0 = walls[0] == null ? t.y - 0.3 : walls[0] + 0.08;
  const y1 = walls[2] == null ? t.y + t.h + 0.3 : walls[2] - 0.08;
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

export function tapeSegment(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  return len < 1e-6 ? null : rectPoly((a.x + b.x) / 2, (a.y + b.y) / 2, len / 2, 0.025, Math.atan2(dy, dx));
}

function tapeWallSides(g, t) {
  const sides = [null, null, null, null], clearance = 0.45;
  const set = (i, face, gap) => {
    if (gap < 0 || gap >= clearance) return;
    if (sides[i] === null || (i === 0 || i === 3 ? face > sides[i] : face < sides[i])) sides[i] = face;
  };
  for (const w of g.walls) {
    if (w.x < t.x + t.w && w.x + w.w > t.x) {
      set(0, w.y + w.h, t.y - w.y - w.h);
      set(2, w.y, w.y - t.y - t.h);
    }
    if (w.y < t.y + t.h && w.y + w.h > t.y) {
      set(1, w.x, w.x - t.x - t.w);
      set(3, w.x + w.w, t.x - w.x - w.w);
    }
  }
  return sides;
}

function initTape(t, g) {
  if (!Array.isArray(t.posts)) t.posts = [true, true, true, true];
  if (!Array.isArray(t.edges)) t.edges = Array(4).fill(!t.broken);
  t.wallSides = tapeWallSides(g, t);
  for (let i = 0; i < 4; i++) if (t.wallSides[i] !== null) t.edges[i] = false;
}

const tapeComplete = (t) => t.posts.every(Boolean) && t.edges.every((edge, i) => edge || t.wallSides[i] !== null);
const touching = (poly, shapes) => poly && shapes.some((shape) => sat(poly, shape));
const postPoly = (p) => rectPoly(p.x, p.y, 0.08, 0.08);

// Tape and posts are deliberately breakable rather than solid obstacles.
export function stepTapeCollisions(g, shapes) {
  for (const t of g.tapes || []) {
    initTape(t, g);
    const corners = tapeCorners(t);
    for (let i = 0; i < 4; i++) {
      if (t.posts[i] && touching(postPoly(corners[i]), shapes)) {
        t.posts[i] = false;
        t.edges[i] = false;
        t.edges[(i + 3) % 4] = false;
      }
    }
    for (let i = 0; i < 4; i++) {
      if (t.edges[i] && touching(tapeSegment(corners[i], corners[(i + 1) % 4]), shapes)) t.edges[i] = false;
    }
    t.broken = !tapeComplete(t);
  }
  const job = g.tapeBot?.tapeJob;
  const t = job && g.tapes.find((q) => q.key === job.key);
  if (job?.phase === 'draw' && t) {
    const end = toWorld(g.tapeBot, -0.25, 0);
    if (!t.posts[job.from] || touching(tapeSegment(tapeCorners(t)[job.from], end), shapes)) job.phase = 'start';
  }
}

export function trailingTape(g) {
  const b = g.tapeBot, job = b?.tapeJob;
  const t = tapeDeploying(b) && (g.tapes || []).find((q) => q.key === job.key);
  return t && t.posts?.[job.from] ? [tapeCorners(t)[job.from], toWorld(b, -0.25, 0)] : null;
}

export function tapeLines(g) {
  const lines = [];
  for (const t of g.tapes || []) {
    const corners = tapeCorners(t);
    for (let i = 0; i < 4; i++) if (t.edges ? t.edges[i] : !t.broken) lines.push([corners[i], corners[(i + 1) % 4]]);
  }
  const trailing = trailingTape(g);
  if (trailing) lines.push(trailing);
  return lines;
}

export function stepTapeBot(g, dt, doneZones, stackAt, wonky, shapes = []) {
  const bot = g.tapeBot;
  if (!bot) return;
  g.tapes ||= [];
  const liveAreas = new Map(g.areas.map((a) => [areaMarkKey(a), a]));
  g.tapes = g.tapes.filter((t) => liveAreas.has(t.key));
  for (const tape of g.tapes) {
    initTape(tape, g);
  }
  const jobs = [], done = new Set(doneZones.map(zoneMarkKey));
  for (const [key, area] of liveAreas) {
    const tape = g.tapes.find((t) => t.key === key), zones = zonesInArea(g, area);
    const valid = zones.length > 0 && zones.every((z) => done.has(zoneMarkKey(z)) && stackAt(z));
    const reports = valid ? zones.map((z) => currentInspection(g, z, stackAt(z))) : [];
    if (tape && (!valid || reports.some((p) => p?.ok === false))) jobs.push({ key, area, action: 'remove' });
    else if (valid && reports.every((p) => p?.ok === true)) {
      if (tape?.broken) jobs.push({ key, area, action: 'repair' });
      else if (!tape) jobs.push({ key, area, action: 'install' });
    }
  }
  const currentKey = bot.workKey || bot.tapeJob?.key;
  const job = jobs.find((j) => j.key === currentKey) || jobs.reduce((best, j) => {
    const d = Math.hypot(j.area.x + j.area.w / 2 - bot.x, j.area.y + j.area.h / 2 - bot.y);
    return !best || d < best.d ? { job: j, d } : best;
  }, null)?.job;
  if (!job) { bot.tapeJob = null; bot.workKey = null; bot.debugTask = null; stepWorker(g, bot, dt, false, null, null); return; }
  bot.workKey = job.key;
  bot.debugTask = `${job.action === 'remove' ? 'removing tape from' : 'taping'} zone ${g.areas.indexOf(job.area) + 1}`;
  let tape = g.tapes.find((t) => t.key === job.key);
  if (job.action === 'remove') {
    const task = bot.tapeJob;
    let post = task?.phase === 'remove' && task.key === job.key && tape.posts[task.from] ? task.from : tape.posts.findIndex(Boolean);
    if (post < 0) { g.tapes = g.tapes.filter((t) => t !== tape); bot.tapeJob = null; return; }
    bot.tapeJob = { key: job.key, edge: null, from: post, to: post, phase: 'remove' };
    const corners = tapeCorners(tape), corner = corners[post];
    const dx = corner.x - (tape.x + tape.w / 2), dy = corner.y - (tape.y + tape.h / 2), dist = Math.hypot(dx, dy) || 1;
    const goal = {
      x: Math.max(BOT_R + 0.1, Math.min(g.w - BOT_R - 0.1, corner.x + dx / dist * 0.55)),
      y: Math.max(BOT_R + 0.1, Math.min(g.h - BOT_R - 0.1, corner.y + dy / dist * 0.55)),
    };
    stepWorker(g, bot, dt, true, goal, `remove:${job.key}:${post}`, 1);
    if (bot.scared || Math.hypot(bot.x - goal.x, bot.y - goal.y) >= 0.35 || bot.path.length) return;
    tape.posts[post] = false;
    tape.edges[post] = false;
    tape.edges[(post + 3) % 4] = false;
    tape.broken = !tapeComplete(tape);
    bot.tapeJob = null;
    if (!tape.posts.some(Boolean)) g.tapes = g.tapes.filter((t) => t !== tape);
    return;
  }
  if (!tape) {
    tape = { key: job.key, color: job.area.color, x: job.area.x, y: job.area.y, w: job.area.w, h: job.area.h,
      sig: '', broken: true, posts: [false, false, false, false], edges: [false, false, false, false] }; // sig is retained for save compatibility
    initTape(tape, g);
    g.tapes.push(tape);
    stepWorker(g, bot, dt, true, tapeCorners(tape)[0], `${job.key}:start:0`, 1);
    return;
  }
  const corners = tapeCorners(tape);
  let task = bot.tapeJob;
  if (!task || task.key !== job.key || (task.edge != null && (tape.edges[task.edge] || tape.wallSides[task.edge] !== null))) {
    const edge = tape.edges.findIndex((v, i) => !v && tape.wallSides[i] === null);
    if (edge < 0) {
      const post = tape.posts.findIndex((v) => !v);
      if (post < 0) { tape.broken = false; bot.tapeJob = null; return; }
      task = bot.tapeJob = { key: job.key, edge: null, from: post, to: post, phase: 'post' };
    } else {
      const from = tape.posts[edge] ? edge : tape.posts[(edge + 1) % 4] ? (edge + 1) % 4 : edge;
      const to = from === edge ? (edge + 1) % 4 : edge;
      task = bot.tapeJob = { key: job.key, edge, from, to, phase: 'start' };
    }
  }
  const index = task.phase === 'start' || task.phase === 'post' ? task.from : task.to;
  const corner = corners[index];
  const cx = tape.x + tape.w / 2, cy = tape.y + tape.h / 2;
  const dx = corner.x - cx, dy = corner.y - cy, dist = Math.hypot(dx, dy) || 1;
  const goal = {
    x: Math.max(BOT_R + 0.1, Math.min(g.w - BOT_R - 0.1, corner.x + dx / dist * 0.55)),
    y: Math.max(BOT_R + 0.1, Math.min(g.h - BOT_R - 0.1, corner.y + dy / dist * 0.55)),
  };
  stepWorker(g, bot, dt, true, goal, `${job.key}:${task.phase}:${index}`, 1);
  if (bot.scared) { if (task.edge != null) task.phase = 'start'; return; }
  if (Math.hypot(bot.x - goal.x, bot.y - goal.y) >= 0.35 || bot.path.length) return;
  if (touching(postPoly(corner), shapes)) return;
  if (task.phase === 'post') {
    tape.posts[task.from] = true;
    tape.broken = !tapeComplete(tape);
    bot.tapeJob = null;
  } else if (task.phase === 'start') {
    tape.posts[task.from] = true;
    task.phase = 'draw';
  } else if (tape.posts[task.from] && !touching(tapeSegment(corners[task.from], corner), shapes)) {
    tape.posts[task.to] = true;
    tape.edges[task.edge] = true;
    tape.broken = !tapeComplete(tape);
    bot.tapeJob = null;
  }
}

// ---- Inspection bot ----
const CORNER_WEIGHT = 12, PHOTO_DIST = 1.4, BOX_SECS = 1.2, INSPECT_SPEED = 1.25, FLASH_SECS = 0.35;
// Laser scan of the stack being inspected, or null: `lens` the beam's origin (in front of the bot), `aim` the stack, `h` its height in boxes,
// `u` scan progress 0..1, `sx, sy` the beam's current target on the floor, `z` its height in boxes (0..h) and `sheet` the offset of the scan sheet.
export function scanBeam(b) {
  if (!b || !b.aim || b.show <= 0 || b.shooting <= 0) return null;
  const n = Math.max(1, b.aim.h), u = Math.min(1, b.shooting / (n * BOX_SECS)), dx = b.aim.x - b.x, dy = b.aim.y - b.y, d = Math.hypot(dx, dy) || 1;
  // the scan climbs one box at a time (w 0..1 within box i), bottom to top
  const i = Math.min(n - 1, Math.floor(b.shooting / BOX_SECS)), w = Math.min(1, b.shooting / BOX_SECS - i);
  const fx = dx / d, fy = dy / d, sw = 0.5 * Math.sin(w * Math.PI * 2), depth = 0.45 * Math.sin(w * Math.PI);
  return {
    lens: { x: b.x + Math.cos(b.a) * 0.3, y: b.y + Math.sin(b.a) * 0.3 }, aim: b.aim, h: b.aim.h, u, fx, fy,
    sx: b.aim.x - fy * sw + fx * depth, sy: b.aim.y + fx * sw + fy * depth, z: i + 0.5 + 0.35 * Math.sin(w * Math.PI * 2), sheet: depth,
  };
}

// Fingerprint of a floor stack's exact arrangement: any nudge changes it.
export const stackSig = (s) => (s ? [s.x, s.y, ...s.layers, ...(s.rots || []), ...(s.offs || []).flatMap((o) => [o.x, o.y])].map((v) => (typeof v === 'number' ? Math.round(v * 1000) : v)).join(',') : '');

const zoneKey = (z) => `${z.x},${z.y},${z.color}`;

function currentInspection(g, z, stack) {
  const bot = g.inspector, key = zoneKey(z), photo = bot?.photos?.[key];
  if (!stack || stack.touched || !bot?.seen?.includes(key) || bot.sigs?.[key] !== stackSig(stack)
      || typeof photo?.ok !== 'boolean' || (g.hard && photo.pens?.[0]?.shift === undefined)) return null;
  return photo;
}

// Completed drop points that have not been photographed yet.
export function pendingZones(g, done, stackAt = (z) => g.stacks.find((s) => Math.hypot(s.x - z.x, s.y - z.y) < 0.5)) {
  const insp = g.inspector;
  if (!insp) return [];
  const doneKeys = new Set(done.map(zoneKey));
  // a stack that was touched since its photo (nudged, straightened, re-placed) is inspected again
  const changed = new Set(done.filter((z) => {
    const key = zoneKey(z), q = stackAt(z);
    const photo = insp.photos?.[key];
    const outdated = insp.seen.includes(key) && (typeof photo?.ok !== 'boolean' || (g.hard && photo.pens?.[0]?.shift === undefined));
    if (outdated) for (const p of q?.pen || []) delete p.inspected;
    return outdated || q?.touched || insp.sigs?.[key] !== stackSig(q);
  }).map(zoneKey));
  insp.seen = insp.seen.filter((k) => doneKeys.has(k) && !changed.has(k)); // a drop point that was undone is inspected again once it is completed anew
  if (insp.photos) for (const k of Object.keys(insp.photos)) if (!insp.seen.includes(k)) delete insp.photos[k];
  return done.filter((z) => !insp.seen.includes(zoneKey(z)));
}

export const WHEEL_R = 0.12;

// The snapshot of stack `st` that the photo popup draws (js/photo.js): `ok` is the verdict, `view` the angle it is seen from and `dist` the distance. Also used to fake a picture at the end of a level.
export const makePhoto = (st, ok, view, dist, n, t) => ({ n, t, ok, layers: st ? [...st.layers] : [], rots: st?.rots ? [...st.rots] : [], offs: st?.offs ? st.offs.map((o) => ({ ...o })) : [], pens: st?.pen ? st.pen.map((q) => ({ barrelPart: q?.barrelPart, wide: !!q?.wide, crash: q?.crash || 0, sq: q?.sq || 0, shift: q?.shift, tape: q?.tape || 0 })) : [], view, dist });

// Has the stack in the observer's last picture (`photo.at`, `photo.sig`) been touched, changed or taken away since?
function photoTampered(g) {
  const p = g.photo;
  if (!p?.at) return false;
  const q = g.stacks.find((o) => Math.hypot(o.x - p.at.x, o.y - p.at.y) < 0.5);
  return !q || q.touched || stackSig(q) !== p.sig;
}

// Steps the inspector and turns its wheels (`roll`, radians) by the distance it drove.
export function stepInspector(g, dt, done, stackAt, wonky) {
  const bot = g.inspector;
  if (!bot) return;
  const x = bot.x, y = bot.y;
  if (g.photo && (photoTampered(g) || (g.hard && g.photo.pens?.[0]?.shift === undefined))) g.photo = null;
  inspectorStep(g, dt, done, stackAt, wonky);
  bot.roll = ((bot.roll || 0) + ((bot.x - x) * Math.cos(bot.a) + (bot.y - y) * Math.sin(bot.a)) / WHEEL_R) % (Math.PI * 2);
}

const pathLength = (from, path) => path.reduce((n, w, i) => n + Math.hypot(w.x - (i ? path[i - 1].x : from.x), w.y - (i ? path[i - 1].y : from.y)), 0);

// Inspector targeting: pick the nearest reachable pending drop point, pathfind to it and go. Obstacles that appear on the route are ignored until
// the bot actually meets one (then it picks a target afresh); a forklift driving towards it makes it run away first, then it picks afresh.
function inspectorStep(g, dt, done, stackAt, wonky) {
  const bot = g.inspector;
  if (!bot || !g.hatch) return;
  const home = botLane(g.hatch);
  const todo = pendingZones(g, done, stackAt);
  bot.flash = Math.max(0, bot.flash - dt / FLASH_SECS);
  if (bot.target && !todo.some((z) => zoneKey(z) === bot.target)) { bot.target = null; bot.shooting = 0; bot.path = []; }
  if (bot.mode === 'hidden') {
    if (!todo.length) return;
    bot.mode = 'out';
  }
  const current = activity(bot, todo.length > 0, dt);
  if (bot.show < 1) { if (bot.leaving) retract(g, bot, dt); else emerge(g, bot, dt); return; }
  const wasScared = bot.scared;
  bot.scared = approachGap(g, bot) < (wasScared ? CALM : SCARE);
  if (bot.scared) bot.spookedUntil = g.clock + SPOOK_SECS;
  let speed = INSPECT_SPEED;
  bot.repath -= dt;
  bot.goal = null;
  if (bot.scared) {
    if (bot.yieldFor) { bot.yieldFor = null; bot.yieldPath = []; bot.repath = 0; }
    bot.curiosity = null; bot.observing = false;
    speed = FLEE_SPEED; bot.shooting = 0;
    if (bot.repath <= 0 || bot.fleePath !== true) { bot.path = fleePlan(g, bot); bot.fleePath = true; bot.repath = 0.25; }
    bot.target = null; // targeting restarts once it is safe
  } else {
    if (bot.fleePath || wasScared) { bot.fleePath = false; bot.path = []; bot.target = null; bot.repath = 0; }
    if (current === 'follow') {
      followTruck(g, bot, dt, speed);
      pushOut(g, bot);
      return;
    }
    if (bot.target && blockedAhead(g, bot)) { bot.target = null; bot.path = []; bot.shooting = 0; bot.repath = 0; } // met the obstacle: pick again
    if (!bot.target && todo.length && bot.repath <= 0) {
      const grid = buildGrid(g, 0.45, false, bot);
      let best = null;
      for (const z of todo) {
        const st = g.stacks.find((q) => Math.hypot(q.x - z.x, q.y - z.y) < 0.5), turn = (st?.rots?.[0] ?? st?.a ?? 0) + Math.PI / 4;
        // the inspector prefers a spot diagonal to the stack (at a corner), so its photo shows two sides of it
        const corner = (x, y) => (st ? Math.abs(Math.atan2(Math.sin(2 * (Math.atan2(y - z.y, x - z.x) - turn)), Math.cos(2 * (Math.atan2(y - z.y, x - z.x) - turn)))) / 2 * CORNER_WEIGHT : 0);
        const path = plan(grid, bot, 80, (x, y, c) => Math.abs(Math.hypot(x - z.x, y - z.y) - PHOTO_DIST) * 10 + corner(x, y) + c * 0.02);
        const end = path.length ? path[path.length - 1] : bot;
        if (Math.hypot(end.x - z.x, end.y - z.y) >= PHOTO_DIST + 0.45) continue; // unreachable
        const len = pathLength(bot, path);
        if (!best || len < best.len) best = { z, path, len };
      }
      if (best) { bot.target = zoneKey(best.z); bot.path = best.path; bot.shooting = 0; }
      bot.repath = REPLAN; // when nothing is reachable, look again shortly
    }
    const target = bot.target && todo.find((z) => zoneKey(z) === bot.target);
    if (target) bot.goal = { x: target.x, y: target.y };
    else if (current === 'home') {
      bot.goal = { x: home.x, y: home.y };
      if (blockedAhead(g, bot)) { bot.path = []; bot.repath = 0; }
      if (!bot.path.length && bot.repath <= 0 && Math.hypot(home.x - bot.x, home.y - bot.y) > 0.15) {
        bot.path = plan(buildGrid(g, 0.45, false, bot), bot, 80, (x, y, c) => Math.hypot(x - home.x, y - home.y) * 10 + c * 0.02);
        bot.repath = REPLAN;
      }
    }
  }
  followPath(g, bot, speed * dt, dt);
  pushOut(g, bot);

  if (!bot.scared) {
    const target = bot.target && todo.find((z) => zoneKey(z) === bot.target);
    if (target) {
      const d = Math.hypot(target.x - bot.x, target.y - bot.y);
      if (!bot.path.length && d >= PHOTO_DIST + 0.5) { bot.target = null; bot.shooting = 0; bot.repath = 0; } // route ended short of the drop point: pick again
      else if (!bot.path.length) {
        const key = zoneKey(target), st = stackAt(target);
        const complete = done.some((z) => zoneKey(z) === key);
        bot.aim = { x: target.x, y: target.y, h: st ? st.layers.length : 1 };
        if (Math.abs(turnTo(bot, Math.atan2(target.y - bot.y, target.x - bot.x), dt)) < 0.15) bot.shooting += dt;
        if (bot.shooting >= Math.max(1, bot.aim.h) * BOX_SECS) {
          const photo = st && complete && makePhoto(st, !wonky(st, target) && !st.pen.some((q) => q?.crash > 0 && repairable(q)),
            Math.atan2(target.y - bot.y, target.x - bot.x), Math.hypot(target.x - bot.x, target.y - bot.y), (g.photo?.n || 0) + 1, g.clock);
          if (photo) {
            g.photo = photo;
            (bot.sigs ||= {})[key] = stackSig(st);
            for (const pen of st.pen || []) pen.inspected = true;
            st.touched = false; g.photo.at = { x: st.x, y: st.y }; g.photo.sig = stackSig(st);
            (bot.photos ||= {})[key] = g.photo;
            bot.seen.push(key);
          }
          bot.shooting = 0; bot.flash = 1; bot.target = null; bot.repath = 0;
          if (photo) (g.hits ||= []).push({ x: bot.x, y: bot.y, z: 0.5, t: g.clock, owner: null, check: !photo.ok ? 'warn' : 'perfect' });
        }
      }
    } else if (current === 'home' && Math.hypot(home.x - bot.x, home.y - bot.y) < 0.15) {
      retract(g, bot, dt);
      return;
    }
  }
}
