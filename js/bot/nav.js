import { BOX_HALF_X, halfY } from '../geom.js';
import { BOT_R, CELL, TURN_RATE, TURN_FIRST, FLEE_TURN_RATE, angDiff, turnTo, BOT_SPACE, rectDist, truckCircles, truckGap, STACK_R, bots, outranks } from './common.js';
import { CONE_R } from './conebot.js';
import { tapeCorners, POST_R } from './tapebot.js';

// A lower-priority bot flees from a bot in right-of-way, so the planner may route through it; higher-priority bots stay put.
export const canYield = (g, me, other) => other.show === 1 && outranks(g, me, other);

// Cones and tape posts are solid for bots (not for forklifts). A bot that has just spawned one (or is reversing onto one to retrieve it)
// has `bot.ghost` set to its position and drives through it.
export function solidProps(g) {
  const out = [];
  for (const c of g.cones || []) if (!c.squished) out.push({ x: c.x, y: c.y, r: CONE_R });
  for (const t of g.tapes || []) {
    if (!Array.isArray(t.posts)) continue;
    const corners = tapeCorners(t);
    t.posts.forEach((on, i) => { if (on) out.push({ x: corners[i].x, y: corners[i].y, r: POST_R }); });
  }
  return out;
}
export const propGap = (g, bot) => bot === g.tapeBot ? 0.2 : BOT_R * 0.75;
export const ghosted = (bot, p) => !!bot?.ghost && Math.hypot(bot.ghost.x - p.x, bot.ghost.y - p.y) < 0.03;

export function nearBox(s, x, y, margin) {
  return s.layers.some((_, i) => {
    const off = s.offs?.[i] || { x: 0, y: 0 }, a = s.rots?.[i] ?? s.a ?? 0;
    const dx = x - s.x - off.x, dy = y - s.y - off.y, c = Math.cos(a), sn = Math.sin(a);
    return Math.abs(dx * c + dy * sn) < BOX_HALF_X + margin
      && Math.abs(-dx * sn + dy * c) < halfY(s.pen?.[i]) + margin;
  });
}

export function buildGrid(g, margin, slim = false, avoidBots = null) {
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
  for (const p of solidProps(g)) if (!ghosted(avoidBots, p)) circle(p, p.r + (slim ? 0.2 : BOT_R * 0.75) + 0.08);
  const fixed = blocked.slice(); // cells blocked by walls, boxes and floor markings only (forklifts move away on their own)
  for (const c of truckCircles(g)) circle(c, c.r + BOT_R + margin);
  if (avoidBots) for (const b of bots(g)) {
    if (b !== avoidBots && b.show > 0 && !canYield(g, avoidBots, b)) circle(b, BOT_SPACE + 0.1);
  }
  return { nx, ny, blocked, fixed };
}

export const cellOf = (grid, p) => ({ i: Math.max(0, Math.min(grid.nx - 1, Math.floor(p.x / CELL))), j: Math.max(0, Math.min(grid.ny - 1, Math.floor(p.y / CELL))) });
export const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

// Nearest unblocked cell (index) to cell `s`, ignoring obstacles on the way; -1 if the grid is full.
export function nearestFree(grid, s) {
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
export function plan(grid, from, maxCost, score) {
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
// ---- Blocked routes ----
// Targets the bot gave up on for a while (`bot.skip`: key -> g.clock until which it is ignored); used only if something else is left to do.
export const SKIP_SECS = 10, GIVE_UP_SECS = 3, REPLAN = 0.4, KEEP_ROUTE = 1e9; // KEEP_ROUTE: no periodic replanning (survives JSON, unlike Infinity)
export const skipped = (g, bot, key) => (bot.skip?.[key] ?? 0) > g.clock;
export function preferLive(g, bot, items, keyOf) {
  const live = items.filter((o) => !skipped(g, bot, keyOf(o)));
  return live.length ? live : items;
}

// Check only the next half tile of the route, so distant obstacles are dealt with when reached.
export function blockedAhead(g, bot) {
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
    || solidProps(g).some((q) => !ghosted(bot, q) && Math.hypot(p.x - q.x, p.y - q.y) < q.r + propGap(g, bot))
    || (!bot.passing && bots(g).some((b) => b !== bot && b.show > 0 && !canYield(g, bot, b) && Math.hypot(p.x - b.x, p.y - b.y) < BOT_SPACE))
    || g.stacks.some((s) => bot === g.tapeBot ? nearBox(s, p.x, p.y, 0.2) : Math.hypot(p.x - s.x, p.y - s.y) < STACK_R + BOT_R * 0.9));
}

// Where to wait while the way is blocked: a nearby free cell with room around it (away from forklifts, walls and boxes), so the bot
// is not in anybody's way. Staying put is free, so it only moves when its spot is bad.
export function waitPlan(g, bot, grid) {
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
export function goalPlan(g, bot, key, score, reached) {
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
export function clearBotSpot(g, bot, p) {
  return p.x >= BOT_R && p.y >= BOT_R && p.x <= g.w - BOT_R && p.y <= g.h - BOT_R
    && !g.walls.some((w) => rectDist(p.x, p.y, w) < BOT_R)
    && !g.stacks.some((s) => bot === g.tapeBot ? nearBox(s, p.x, p.y, 0.2) : Math.hypot(p.x - s.x, p.y - s.y) < STACK_R + BOT_R)
    && truckGap(g, p) >= 0;
}

export function moveBot(g, bot, x, y) {
  const dx = x - bot.x, dy = y - bot.y, len2 = dx * dx + dy * dy;
  for (const o of bots(g)) {
    if (o === bot || o.show <= 0) continue;
    const t = len2 ? Math.max(0, Math.min(1, ((o.x - bot.x) * dx + (o.y - bot.y) * dy) / len2)) : 0;
    const d = Math.hypot(bot.x + dx * t - o.x, bot.y + dy * t - o.y);
    if (d < Math.min(BOT_SPACE, Math.hypot(bot.x - o.x, bot.y - o.y)) - 1e-8) return false;
  }
  for (const q of solidProps(g)) {
    if (ghosted(bot, q)) continue;
    const dNew = Math.hypot(x - q.x, y - q.y);
    if (dNew < q.r + propGap(g, bot) - 1e-8 && dNew < Math.hypot(bot.x - q.x, bot.y - q.y) - 1e-9) return false; // moving away is always allowed
  }
  bot.x = x; bot.y = y;
  return true;
}

// The nearest other bot ahead on the route to waypoint `w` (within 1.4 tiles and in our lane), or null.
export function botAhead(g, bot, w) {
  if (!w) return null;
  const dx = w.x - bot.x, dy = w.y - bot.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
  return bots(g).filter((o) => {
    if (o === bot || o.show <= 0) return false;
    const ox = o.x - bot.x, oy = o.y - bot.y;
    return ox * ux + oy * uy > 0 && Math.hypot(ox, oy) < 1.4 && Math.abs(ox * uy - oy * ux) < BOT_SPACE;
  }).sort((a, b) => Math.hypot(a.x - bot.x, a.y - bot.y) - Math.hypot(b.x - bot.x, b.y - bot.y))[0] || null;
}

// Keep the route, but steer around a bot in the way on our right (positive world-y when heading east). A lower-priority bot flees from a
// bot in right-of-way, so we give it ROW_PATIENCE seconds to clear the way; a higher-priority one stays and is passed (or waited for in a single-file gap).
export const ROW_PATIENCE = 2;
export function passingPoint(g, bot, w) {
  if (bot.passing && clearBotSpot(g, bot, bot.passing)) return bot.passing;
  bot.passing = null;
  if (!w) return bot;
  const other = botAhead(g, bot, w);
  if (!other) { bot.blockWait = 0; return w; }
  if (canYield(g, bot, other) && (bot.blockWait || 0) < ROW_PATIENCE) return bot;
  const dx = w.x - bot.x, dy = w.y - bot.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
  const side = BOT_SPACE + 0.15;
  const p = { x: bot.x - uy * side, y: bot.y + ux * side,
    next: { x: other.x + ux * side - uy * side, y: other.y + uy * side + ux * side } };
  const steps = Math.ceil(Math.hypot(p.x - bot.x, p.y - bot.y) / 0.1);
  for (let i = 1; i <= steps; i++) {
    if (!clearBotSpot(g, bot, { x: bot.x + (p.x - bot.x) * i / steps, y: bot.y + (p.y - bot.y) * i / steps })) return bot;
  }
  bot.passing = p;
  return p;
}

// Moves along bot.path by `move` tiles, turning towards each waypoint; returns the unused distance.
export function followPath(g, bot, move, dt) {
  let turned = false;
  bot.didTurn = false;
  while ((bot.path.length || bot.passing) && move > 0) {
    const w = passingPoint(g, bot, bot.path[0]), d = Math.hypot(w.x - bot.x, w.y - bot.y);
    if (w === bot) { bot.blockWait = (bot.blockWait || 0) + dt; return 0; }
    if (d < 1e-6) {
      if (w === bot.passing) bot.passing = w.next || null;
      else bot.path.shift();
      continue;
    }
    const ang = Math.atan2(w.y - bot.y, w.x - bot.x);
    if (!turned) { turned = bot.didTurn = true; if (Math.abs(turnTo(bot, ang, dt, bot.state === 'flee' ? FLEE_TURN_RATE : TURN_RATE)) > TURN_FIRST) return move; }
    else if (Math.abs(angDiff(bot.a, ang)) > TURN_FIRST) return move;
    const step = Math.min(d, move);
    if (!moveBot(g, bot, bot.x + Math.cos(ang) * step, bot.y + Math.sin(ang) * step)) {
      bot.passing = null; bot.repath = 0;
      return 0;
    }
    if (d <= move) {
      move -= d;
      if (w === bot.passing) { bot.passing = w.next || null; if (!bot.passing) bot.repath = 0; }
      else bot.path.shift();
      continue;
    }
    move = 0;
  }
  return move;
}

// Get pushed out of a forklift that reached the bot anyway (and off the other bot).
export function pushOut(g, bot) {
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

// Flee plan: the reachable cell furthest from every forklift and from each threatening bot (and the route it is about to drive).
export function fleePlan(g, bot, threats = []) {
  const trucks = truckCircles(g);
  return plan(buildGrid(g, 0, bot === g.tapeBot, bot), bot, 7, (x, y, c) => {
    let clear = Infinity;
    for (const t of trucks) clear = Math.min(clear, Math.hypot(x - t.x, y - t.y) - t.r);
    for (const o of threats) clear = Math.min(clear, Math.hypot(x - o.x, y - o.y) - BOT_SPACE, pathDistance({ x, y }, o, o.path || []) - BOT_SPACE);
    let room = 1.5; // wall-hugging spots and corners are traps: a forklift can pin the bot there
    for (const w of g.walls) room = Math.min(room, rectDist(x, y, w));
    return -Math.min(clear, 4) * 3 + (1.5 - room) * 4 + c * 0.2;
  });
}

export function pathDistance(p, from, path) {
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
