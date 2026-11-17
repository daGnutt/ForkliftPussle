// Cleaning bot (inspired by M-O): lives behind a hatch in a wall on levels with oil barrels. Once there is oil it drives out,
// paths to the nearest spill on a coarse grid (avoiding walls, stacks and forklifts), mops it up (one drop per CLEAN_SECS) and
// runs away whenever a forklift comes close. With nothing left to clean it goes back into its hatch.
// Pure data + DOM-free; `g.hatch` is static (regenerated per level), `g.bot` is dynamic (saved and synced).
import { repairable } from './repair.js';
import { BARREL_COLOR } from './level.js';
import { FL, toWorld } from './forklift.js';

export const BOT_R = 0.3; // about a quarter of a forklift's footprint
export const CLEAN_SECS = 5; // seconds per oil drop
const CELL = 0.25, SPEED = 1.8, FLEE_SPEED = 3.2, SCARE = 1.3, CALM = 2.0, SHOW_SECS = 0.6;
export const TURN_RATE = 5, TURN_FIRST = 0.6; // max turning speed (rad/s; a tracked bot spins on the spot) and the heading error above which it turns before driving on
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
// Turns the bot towards heading `ang` at no more than TURN_RATE; returns the heading error left.
function turnTo(bot, ang, dt) {
  const da = angDiff(bot.a, ang), step = Math.max(-TURN_RATE * dt, Math.min(TURN_RATE * dt, da));
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

export const botHome = (h) => ({ x: h.x + h.nx * (BOT_R + 0.1), y: h.y + h.ny * (BOT_R + 0.1) });

// Where a bot is drawn: it keeps its full size and slides in/out of the hatch, so while `show` < 1 it sits (partly) inside the wall,
// which hides it; `show` is the progress of that slide.
export const BOT_SLIDE = BOT_R + 0.1 + 0.5; // from home to fully inside the wall
export function botDrawPos(b, h) {
  const s = (1 - b.show) * BOT_SLIDE;
  return h ? { x: b.x - h.nx * s, y: b.y - h.ny * s } : { x: b.x, y: b.y };
}

// A bot drives straight out of its hatch and straight back in, always forwards: `show` (0..1) is how far along that
// line from `botHome` to `botLane` it is. It goes in and out via the lane point, where it turns to face the wall before driving in.
export const LANE = 1.1; // distance of the lane point (the bot's goal when going home) from the wall
const laneAt = (h, show) => { const d = (LANE - (BOT_R + 0.1)) * show + BOT_R + 0.1; return { x: h.x + h.nx * d, y: h.y + h.ny * d }; };
export const botLane = (h) => laneAt(h, 1);
function place(g, bot, a) { const p = laneAt(g.hatch, bot.show); bot.x = p.x; bot.y = p.y; bot.a = a; }
function emerge(g, bot, dt) {
  bot.show = Math.min(1, bot.show + dt / SHOW_SECS);
  place(g, bot, g.hatch.a);
}
function retract(g, bot, dt) {
  bot.path = [];
  if (!bot.leaving) {
    const lane = botLane(g.hatch);
    bot.x = lane.x; bot.y = lane.y;
    if (Math.abs(turnTo(bot, g.hatch.a + Math.PI, dt)) > 0.05) return;
    bot.leaving = true;
  }
  bot.show = Math.max(0, bot.show - dt / SHOW_SECS);
  place(g, bot, g.hatch.a + Math.PI);
  if (bot.show === 0) { bot.mode = 'hidden'; bot.leaving = false; }
}

export function makeBot(g) {
  if (!g.hatch || !g.stacks.some((s) => s.layers.includes(BARREL_COLOR))) return null;
  const home = botHome(g.hatch);
  return { x: home.x, y: home.y, a: g.hatch.a, show: 0, mode: 'hidden', cleaning: false, scared: false, path: [], repath: 0, clean: 0 };
}

// The inspection bot: photographs every completed drop point once (`seen` holds the keys of inspected zones).
export function makeInspector(g) {
  if (!g.hatch) return null;
  const home = botHome(g.hatch);
  return { x: home.x, y: home.y, a: g.hatch.a, show: 0, mode: 'hidden', shooting: 0, flash: 0, roll: 0, scared: false, path: [], repath: 0, seen: [] };
}

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

function buildGrid(g, margin) {
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
    const m = BOT_R + 0.05;
    stamp(w.x - m, w.y - m, w.x + w.w + m, w.y + w.h + m, (x, y) => rectDist(x, y, w) < m);
  }
  for (const s of g.stacks) circle(s, STACK_R + BOT_R);
  for (const c of truckCircles(g)) circle(c, c.r + BOT_R + margin);
  return { nx, ny, blocked };
}

const cellOf = (grid, p) => ({ i: Math.max(0, Math.min(grid.nx - 1, Math.floor(p.x / CELL))), j: Math.max(0, Math.min(grid.ny - 1, Math.floor(p.y / CELL))) });
const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

// Dijkstra over free cells from `from`. `score(x, y, cost)` ranks cells (lower is better); the best cell within `maxCost` wins.
// Returns the waypoint list (world coordinates) to that cell, or [].
function plan(grid, from, maxCost, score) {
  const { nx, ny, blocked } = grid, n = nx * ny;
  const s = cellOf(grid, from), start = s.j * nx + s.i;
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
  return path.reverse();
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

// True if one of the next waypoints now lies inside a parked forklift or a stack (something settled on the route).
// Moving forklifts are ignored until they scare the bot.
function routeObstructed(g, bot) {
  if (!bot.path.length) return false;
  const moving = new Set(truckCircles(g, true).map((c) => `${c.x},${c.y}`));
  const trucks = truckCircles(g).filter((c) => !moving.has(`${c.x},${c.y}`));
  for (const w of bot.path.slice(0, 8)) {
    for (const c of trucks) if (Math.hypot(w.x - c.x, w.y - c.y) < c.r + BOT_R + 0.1) return true;
    for (const s of g.stacks) if (Math.hypot(w.x - s.x, w.y - s.y) < STACK_R + BOT_R) return true;
  }
  return false;
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
  const grid = buildGrid(g, 0.45);
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

// Moves along bot.path by `move` tiles, turning towards each waypoint; returns the unused distance.
function followPath(bot, move, dt) {
  let turned = false;
  while (bot.path.length && move > 0) {
    const w = bot.path[0], d = Math.hypot(w.x - bot.x, w.y - bot.y);
    if (d < 1e-6) { bot.path.shift(); continue; }
    const ang = Math.atan2(w.y - bot.y, w.x - bot.x);
    if (!turned) { turned = true; if (Math.abs(turnTo(bot, ang, dt)) > TURN_FIRST) return move; }
    else if (Math.abs(angDiff(bot.a, ang)) > TURN_FIRST) return move;
    if (d <= move) { bot.x = w.x; bot.y = w.y; move -= d; bot.path.shift(); continue; }
    bot.x += Math.cos(ang) * move; bot.y += Math.sin(ang) * move;
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
  for (const o of [g.bot, g.inspector]) {
    if (!o || o === bot || o.show <= 0) continue;
    const d = Math.hypot(bot.x - o.x, bot.y - o.y), min = BOT_R * 1.6;
    if (d < min && d > 1e-6) { bot.x = o.x + (bot.x - o.x) / d * min; bot.y = o.y + (bot.y - o.y) / d * min; }
  }
}

// Flee plan: the reachable cell furthest from every forklift.
function fleePlan(g, bot) {
  const trucks = truckCircles(g);
  return plan(buildGrid(g, 0), bot, 7, (x, y, c) => {
    let clear = Infinity;
    for (const t of trucks) clear = Math.min(clear, Math.hypot(x - t.x, y - t.y) - t.r);
    return -Math.min(clear, 4) * 3 + c * 0.2;
  });
}

export function stepBot(g, dt, dropArea) {
  const bot = g.bot;
  if (!bot || !g.hatch) return;
  const home = botLane(g.hatch);
  const spill = pickSpill(g, bot, dropArea);
  const gap = truckGap(g, bot, true);

  if (bot.mode === 'hidden') {
    if (!spill) return;
    bot.mode = 'out';
  }
  if (bot.show < 1) { if (bot.leaving) retract(g, bot, dt); else emerge(g, bot, dt); return; }
  bot.scared = gap < (bot.scared ? CALM : SCARE);
  if (bot.scared) bot.spookedUntil = g.clock + SPOOK_SECS;
  bot.cleaning = false;
  let speed = SPEED;
  let goal = null;

  bot.repath -= dt;
  bot.goal = null;
  if (bot.scared) {
    speed = FLEE_SPEED;
    if (bot.repath <= 0 || bot.fleePath !== true) {
      bot.path = fleePlan(g, bot);
      bot.fleePath = true; bot.repath = 0.25;
    }
  } else {
    if (bot.fleePath) bot.repath = 0;
    bot.fleePath = false;
    const key = spill?.id ?? 'home';
    if (bot.planKey !== key) { bot.planKey = key; bot.repath = 0; }
    goal = spill ? { x: spill.x, y: spill.y, r: Math.max(0.08, Math.sqrt(spillDrops(spill, dropArea) * dropArea) * 0.5) } : { ...home, r: 0.08 };
    bot.goal = { x: goal.x, y: goal.y }; // shown by the debug overlay
    if (routeObstructed(g, bot)) bot.repath = 0;
    if (bot.repath <= 0) {
      const covered = spill && underStack(g, spill);
      bot.path = goalPlan(g, bot, spill?.id, (x, y) => Math.max(0, Math.hypot(x - goal.x, y - goal.y) - goal.r) * 10,
        (e) => { const d = Math.hypot(e.x - goal.x, e.y - goal.y); return covered ? d <= REACH - 0.05 : d < goal.r + 0.5; });
      bot.repath = bot.waiting || !bot.path.length ? REPLAN : KEEP_ROUTE; // a route is kept until something disturbs it
    }
  }

  let move = followPath(bot, speed * dt, dt);
  // The grid is coarse: finish the last few centimetres in a straight line.
  if (!bot.path.length && goal && move > 0) {
    const d = Math.hypot(goal.x - bot.x, goal.y - bot.y);
    if (d > 1e-6 && d < 0.5 && truckGap(g, goal) > 0 && !underStack(g, goal)) {
      const step = Math.min(move, Math.max(0, d - goal.r * 0.5));
      if (Math.abs(turnTo(bot, Math.atan2(goal.y - bot.y, goal.x - bot.x), dt)) < TURN_FIRST) { bot.x += (goal.x - bot.x) / d * step; bot.y += (goal.y - bot.y) / d * step; }
    }
  }

  pushOut(g, bot);

  if (!bot.scared && goal) {
    const d = Math.hypot(goal.x - bot.x, goal.y - bot.y);
    const reaching = spill && !bot.path.length && d <= REACH && underStack(g, spill);
    if (spill && (d <= goal.r + 0.12 || reaching)) {
      bot.cleaning = true;
      if (reaching) turnTo(bot, Math.atan2(goal.y - bot.y, goal.x - bot.x), dt);
      const drops = spillDrops(spill, dropArea) - dt / CLEAN_SECS;
      if (drops <= 1e-9) g.oil.splice(g.oil.indexOf(spill), 1);
      else { spill.drops = drops; spill.r = Math.sqrt(drops * dropArea); }
    } else if (!spill && Math.hypot(home.x - bot.x, home.y - bot.y) < 0.15) {
      retract(g, bot, dt);
      return;
    }
  }
}

// ---- Inspection bot ----
const CORNER_WEIGHT = 12, PHOTO_DIST = 1.4, BOX_SECS = 1.2, INSPECT_SPEED = 1.0, LOITER_SECS = 4, FLASH_SECS = 0.35;
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

export const zoneKey = (z) => `${z.x},${z.y},${z.color}`;

// Completed drop points that have not been photographed yet.
export function pendingZones(g, done) {
  const insp = g.inspector;
  if (!insp) return [];
  const doneKeys = new Set(done.map(zoneKey));
  // a stack that was touched since its photo (nudged, straightened, re-placed) is inspected again
  const changed = new Set(done.filter((z) => {
    const q = g.stacks.find((o) => Math.hypot(o.x - z.x, o.y - z.y) < 0.5);
    return q?.touched || (insp.sigs?.[zoneKey(z)] !== undefined && insp.sigs[zoneKey(z)] !== stackSig(q));
  }).map(zoneKey));
  insp.seen = insp.seen.filter((k) => doneKeys.has(k) && !changed.has(k)); // a drop point that was undone is inspected again once it is completed anew
  if (insp.photos) for (const k of Object.keys(insp.photos)) if (!insp.seen.includes(k)) delete insp.photos[k];
  return done.filter((z) => !insp.seen.includes(zoneKey(z)));
}

export const WHEEL_R = 0.12;

// The snapshot of stack `st` that the photo popup draws (js/photo.js): `ok` is the verdict, `view` the angle it is seen from and `dist` the distance. Also used to fake a picture at the end of a level.
export const makePhoto = (st, ok, view, dist, n, t) => ({ n, t, ok, layers: st ? [...st.layers] : [], rots: st?.rots ? [...st.rots] : [], offs: st?.offs ? st.offs.map((o) => ({ ...o })) : [], pens: st?.pen ? st.pen.map((q) => ({ barrelPart: q?.barrelPart, wide: !!q?.wide, crash: q?.crash || 0, sq: q?.sq || 0, tape: q?.tape || 0 })) : [], view, dist });

// Has the stack in the observer's last picture (`photo.at`, `photo.sig`) been touched, changed or taken away since?
export function photoTampered(g) {
  const p = g.photo;
  if (!p?.at) return false;
  const q = g.stacks.find((o) => Math.hypot(o.x - p.at.x, o.y - p.at.y) < 0.5);
  return !q || q.touched || stackSig(q) !== p.sig;
}

// Steps the inspector and turns its wheels (`roll`, radians) by the distance it drove.
export function stepInspector(g, dt, done, wonky = () => false) {
  const bot = g.inspector;
  if (!bot) return;
  const x = bot.x, y = bot.y;
  if (g.photo && photoTampered(g)) g.photo = null; // the stack in the last picture was touched: the picture no longer shows what is there
  inspectorStep(g, dt, done, wonky);
  bot.roll = ((bot.roll || 0) + ((bot.x - x) * Math.cos(bot.a) + (bot.y - y) * Math.sin(bot.a)) / WHEEL_R) % (Math.PI * 2);
}

const pathLength = (from, path) => path.reduce((n, w, i) => n + Math.hypot(w.x - (i ? path[i - 1].x : from.x), w.y - (i ? path[i - 1].y : from.y)), 0);

// True when the bot is about to run into something on its way (it only notices an obstacle once it is right in front of it).
function blockedAhead(g, bot) {
  if (!bot.path.length) return false;
  const pts = [], w0 = bot.path[0], w1 = bot.path[1];
  for (let k = 1; k <= 3; k++) pts.push({ x: bot.x + (w0.x - bot.x) * k / 3, y: bot.y + (w0.y - bot.y) * k / 3 });
  if (w1) pts.push(w1);
  const trucks = truckCircles(g);
  return pts.some((q) => trucks.some((c) => Math.hypot(q.x - c.x, q.y - c.y) < c.r + BOT_R * 0.9)
    || g.stacks.some((st) => Math.hypot(q.x - st.x, q.y - st.y) < STACK_R + BOT_R * 0.9));
}

// Inspector targeting: pick the nearest reachable pending drop point, pathfind to it and go. Obstacles that appear on the route are ignored until
// the bot actually meets one (then it picks a target afresh); a forklift driving towards it makes it run away first, then it picks afresh.
function inspectorStep(g, dt, done, wonky) {
  const bot = g.inspector;
  if (!bot || !g.hatch) return;
  const home = botLane(g.hatch);
  const todo = pendingZones(g, done);
  bot.flash = Math.max(0, bot.flash - dt / FLASH_SECS);
  if (bot.target && !todo.some((z) => zoneKey(z) === bot.target)) { bot.target = null; bot.shooting = 0; bot.path = []; }
  if (bot.mode === 'hidden') {
    if (!todo.length) return;
    bot.mode = 'out';
  }
  if (bot.show < 1) { if (bot.leaving) retract(g, bot, dt); else emerge(g, bot, dt); return; }
  bot.idle = todo.length ? 0 : (bot.idle || 0) + dt; // loiters a while after the last drop point before heading home
  const wasScared = bot.scared;
  bot.scared = approachGap(g, bot) < (wasScared ? CALM : SCARE);
  if (bot.scared) bot.spookedUntil = g.clock + SPOOK_SECS;
  let speed = INSPECT_SPEED;
  bot.repath -= dt;
  bot.goal = null;
  if (bot.scared) {
    speed = FLEE_SPEED; bot.shooting = 0;
    if (bot.repath <= 0 || bot.fleePath !== true) { bot.path = fleePlan(g, bot); bot.fleePath = true; bot.repath = 0.25; }
    bot.target = null; // targeting restarts once it is safe
  } else {
    if (bot.fleePath || wasScared) { bot.fleePath = false; bot.path = []; bot.target = null; bot.repath = 0; }
    if (bot.target && blockedAhead(g, bot)) { bot.target = null; bot.path = []; bot.shooting = 0; bot.repath = 0; } // met the obstacle: pick again
    if (!bot.target && todo.length && bot.repath <= 0) {
      const grid = buildGrid(g, 0.45);
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
    else if (!todo.length && bot.idle >= LOITER_SECS) {
      bot.goal = { x: home.x, y: home.y };
      if (blockedAhead(g, bot)) { bot.path = []; bot.repath = 0; }
      if (!bot.path.length && bot.repath <= 0 && Math.hypot(home.x - bot.x, home.y - bot.y) > 0.15) {
        bot.path = plan(buildGrid(g, 0.45), bot, 80, (x, y, c) => Math.hypot(x - home.x, y - home.y) * 10 + c * 0.02);
        bot.repath = REPLAN;
      }
    }
  }
  followPath(bot, speed * dt, dt);
  pushOut(g, bot);

  if (!bot.scared) {
    const target = bot.target && todo.find((z) => zoneKey(z) === bot.target);
    if (target) {
      const d = Math.hypot(target.x - bot.x, target.y - bot.y);
      if (!bot.path.length && d >= PHOTO_DIST + 0.5) { bot.target = null; bot.shooting = 0; bot.repath = 0; } // route ended short of the drop point: pick again
      else if (!bot.path.length) {
        const st = g.stacks.find((q) => Math.hypot(q.x - target.x, q.y - target.y) < 0.5);
        bot.aim = { x: target.x, y: target.y, h: st ? st.layers.length : 1 };
        if (Math.abs(turnTo(bot, Math.atan2(target.y - bot.y, target.x - bot.x), dt)) < 0.15) bot.shooting += dt;
        if (bot.shooting >= Math.max(1, bot.aim.h) * BOX_SECS) {
          g.photo = makePhoto(st, !wonky(target) && !st?.pen?.some((q) => q?.crash > 0 && repairable(q)), Math.atan2(target.y - bot.y, target.x - bot.x), Math.hypot(target.x - bot.x, target.y - bot.y), (g.photo?.n || 0) + 1, g.clock); // the snapshot shown as a popup (js/photo.js)
          (bot.sigs ||= {})[zoneKey(target)] = stackSig(st);
          if (st) { st.touched = false; g.photo.at = { x: st.x, y: st.y }; g.photo.sig = stackSig(st); }
          if (st) (bot.photos ||= {})[zoneKey(target)] = g.photo; // kept per drop point: the flagged stack's own picture
          bot.seen.push(zoneKey(target)); bot.shooting = 0; bot.flash = 1; bot.target = null; bot.repath = 0;
          (g.hits ||= []).push({ x: bot.x, y: bot.y, z: 0.5, t: g.clock, owner: null, check: !g.photo.ok ? 'warn' : 'perfect' }); // verdict floats up from the bot
        }
      }
    } else if (!todo.length && bot.idle >= LOITER_SECS && Math.hypot(home.x - bot.x, home.y - bot.y) < 0.15) {
      retract(g, bot, dt);
      return;
    }
  }
}
