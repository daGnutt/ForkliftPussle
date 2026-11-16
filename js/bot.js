// Cleaning bot (inspired by M-O): lives behind a hatch in a wall on levels with oil barrels. Once there is oil it drives out,
// paths to the nearest spill on a coarse grid (avoiding walls, stacks and forklifts), mops it up (one drop per CLEAN_SECS) and
// runs away whenever a forklift comes close. With nothing left to clean it goes back into its hatch.
// Pure data + DOM-free; `g.hatch` is static (regenerated per level), `g.bot` is dynamic (saved and synced).
import { BARREL_COLOR } from './level.js';
import { FL, toWorld } from './forklift.js';

export const BOT_R = 0.3; // about a quarter of a forklift's footprint
export const CLEAN_SECS = 5; // seconds per oil drop
const CELL = 0.25, SPEED = 1.8, FLEE_SPEED = 3.2, SCARE = 1.3, CALM = 2.0, SHOW_SECS = 0.6, TURN = 8;
const hash = (n) => { const t = Math.sin(n * 12.9898) * 43758.5453; return t - Math.floor(t); };

// Predetermined hatch position on the outer walls: seeded, and clear of stacks, pillars and the start.
export function makeHatch(g) {
  if (!g.stacks.some((s) => s.layers.includes(BARREL_COLOR))) return null;
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

export function makeBot(g) {
  if (!g.hatch) return null;
  const home = botHome(g.hatch);
  return { x: home.x, y: home.y, a: g.hatch.a, show: 0, mode: 'hidden', cleaning: false, scared: false, path: [], repath: 0, clean: 0 };
}

function rectDist(x, y, w) {
  const dx = Math.max(w.x - x, 0, x - (w.x + w.w)), dy = Math.max(w.y - y, 0, y - (w.y + w.h));
  return Math.hypot(dx, dy);
}

// Circles approximating each forklift (and its carried stack): { x, y, r }.
export function truckCircles(g) {
  const out = [];
  for (const t of g.trucks) {
    if (t.gone) continue;
    for (const [x, r] of [[-1.7, 0.6], [-1.1, 0.6], [-0.5, 0.6], [0.1, 0.6], [0.9, 0.35], [1.4, 0.35]]) out.push({ ...toWorld(t.fl, x, 0), r });
    if (t.carried) out.push({ ...toWorld(t.fl, FL.carryX, 0), r: 0.75 });
  }
  return out;
}

// Smallest gap between the bot and any forklift.
export function truckGap(g, p) {
  let best = Infinity;
  for (const c of truckCircles(g)) best = Math.min(best, Math.hypot(p.x - c.x, p.y - c.y) - c.r - BOT_R);
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
  for (const s of g.stacks) circle(s, 0.75 + BOT_R);
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

const spillDrops = (sp, dropArea) => sp.drops ?? sp.r * sp.r / dropArea;

function nearestSpill(g, bot) {
  let best = null, bd = Infinity;
  for (const sp of g.oil || []) {
    const d = Math.hypot(sp.x - bot.x, sp.y - bot.y);
    if (d < bd) { bd = d; best = sp; }
  }
  return best;
}

export function stepBot(g, dt, dropArea) {
  const bot = g.bot;
  if (!bot || !g.hatch) return;
  const home = botHome(g.hatch);
  const spill = nearestSpill(g, bot);
  const gap = truckGap(g, bot);

  if (bot.mode === 'hidden') {
    if (!spill) return;
    bot.mode = 'out';
  }
  bot.scared = gap < (bot.scared ? CALM : SCARE);
  bot.cleaning = false;
  let speed = SPEED;
  let goal = null;

  bot.repath -= dt;
  if (bot.scared) {
    speed = FLEE_SPEED;
    if (bot.repath <= 0 || bot.fleePath !== true) {
      const trucks = truckCircles(g);
      const grid = buildGrid(g, 0);
      bot.path = plan(grid, bot, 7, (x, y, c) => {
        let clear = Infinity;
        for (const t of trucks) clear = Math.min(clear, Math.hypot(x - t.x, y - t.y) - t.r);
        return -Math.min(clear, 4) * 3 + c * 0.2;
      });
      bot.fleePath = true; bot.repath = 0.25;
    }
  } else {
    bot.fleePath = false;
    goal = spill ? { x: spill.x, y: spill.y, r: Math.max(0.08, Math.sqrt(spillDrops(spill, dropArea) * dropArea) * 0.5) } : { ...home, r: 0.08 };
    if (bot.repath <= 0) {
      const grid = buildGrid(g, 0.45);
      bot.path = plan(grid, bot, 80, (x, y) => Math.max(0, Math.hypot(x - goal.x, y - goal.y) - goal.r) * 10);
      bot.repath = 0.4;
    }
  }

  // Follow the waypoints.
  let move = speed * dt;
  while (bot.path.length && move > 0) {
    const w = bot.path[0], d = Math.hypot(w.x - bot.x, w.y - bot.y);
    if (d <= move) {
      if (d > 1e-6) bot.a = Math.atan2(w.y - bot.y, w.x - bot.x);
      bot.x = w.x; bot.y = w.y; move -= d; bot.path.shift();
      continue;
    }
    const ang = Math.atan2(w.y - bot.y, w.x - bot.x);
    let da = ang - bot.a; da = Math.atan2(Math.sin(da), Math.cos(da));
    bot.a += da * Math.min(1, TURN * dt);
    bot.x += Math.cos(ang) * move; bot.y += Math.sin(ang) * move;
    move = 0;
  }

  // The grid is coarse: finish the last few centimetres in a straight line.
  if (!bot.path.length && goal && move > 0) {
    const d = Math.hypot(goal.x - bot.x, goal.y - bot.y);
    if (d > 1e-6 && d < 0.5 && truckGap(g, goal) > 0) {
      const step = Math.min(move, Math.max(0, d - goal.r * 0.5));
      bot.a = Math.atan2(goal.y - bot.y, goal.x - bot.x);
      bot.x += (goal.x - bot.x) / d * step; bot.y += (goal.y - bot.y) / d * step;
    }
  }

  // Get pushed out of a forklift that reached it anyway.
  for (const c of truckCircles(g)) {
    const d = Math.hypot(bot.x - c.x, bot.y - c.y), min = c.r + BOT_R * 0.8;
    if (d < min && d > 1e-6) { bot.x = c.x + (bot.x - c.x) / d * min; bot.y = c.y + (bot.y - c.y) / d * min; }
  }

  if (!bot.scared && goal) {
    const d = Math.hypot(goal.x - bot.x, goal.y - bot.y);
    if (spill && d <= goal.r + 0.12) {
      bot.cleaning = true;
      const drops = spillDrops(spill, dropArea) - dt / CLEAN_SECS;
      if (drops <= 1e-9) g.oil.splice(g.oil.indexOf(spill), 1);
      else { spill.drops = drops; spill.r = Math.sqrt(drops * dropArea); }
    } else if (!spill && Math.hypot(home.x - bot.x, home.y - bot.y) < 0.15) {
      bot.x = home.x; bot.y = home.y;
      bot.show = Math.max(0, bot.show - dt / SHOW_SECS);
      if (bot.show === 0) bot.mode = 'hidden';
      return;
    }
  }
  bot.show = Math.min(1, bot.show + dt / SHOW_SECS);
}
