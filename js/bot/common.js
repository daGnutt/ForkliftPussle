import { BARREL_COLOR } from '../level.js';
import { FL, toWorld, topSpeed } from '../forklift.js';

export const BOT_R = 0.3; // about a quarter of a forklift's footprint
// every bot's speed is a fraction of the forklift's top speed
export const FL_SPEED = topSpeed(0), SPEED = FL_SPEED * 0.75, WORK_SPEED = FL_SPEED * 0.25;
export const FLEE_SPEED = FL_SPEED * 1.2, FLEE_BOT_SPEED = FL_SPEED * 1.25; // fleeing a moving forklift / a bot in right-of-way or a yelling worker
export const CELL = 0.25, SCARE = 1.3, CALM = 2.0, SHOW_SECS = 0.6;
export const TURN_RATE = 5, TURN_FIRST = 0.6; // max turning speed (rad/s; a tracked bot spins on the spot) and the heading error above which it turns before driving on
export const FLEE_TURN_RATE = 16;
export const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
// Turns the bot towards heading `ang` at no more than TURN_RATE; returns the heading error left.
export function turnTo(bot, ang, dt, rate = TURN_RATE) {
  const da = angDiff(bot.a, ang), step = Math.max(-rate * dt, Math.min(rate * dt, da));
  bot.a += step;
  return da - step;
}
// Turn for a follow-up move in the same step: followPath already used this step's turn budget if it turned.
export const turnAfterPath = (bot, ang, dt) => bot.didTurn ? angDiff(bot.a, ang) : turnTo(bot, ang, dt);
export const hash = (n) => { const t = Math.sin(n * 12.9898) * 43758.5453; return t - Math.floor(t); };

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
export const laneAt = (h, show) => { const d = (LANE - (BOT_R + 0.1)) * show + BOT_R + 0.1; return { x: h.x + h.nx * d, y: h.y + h.ny * d }; };
export const botLane = (h) => laneAt(h, 1);
export const BOT_SPACE = BOT_R * 2 + 0.04;
export const botsCollide = (a, b) => a.state !== 'right-of-way' && b.state !== 'right-of-way';
export const BOT_KEYS = ['bot', 'inspector', 'coneBot', 'tapeBot', 'fixBot'];
export const bots = (g) => BOT_KEYS.map((k) => g[k]).filter(Boolean);
export const botKey = (g, bot) => BOT_KEYS.find((key) => g[key] === bot);
// Priority, highest first: box resetter, inspector, tape bot, cleaner, cone bot.
export const PRIORITY = ['fixBot', 'inspector', 'tapeBot', 'bot', 'coneBot'];
export const outranks = (g, a, b) => PRIORITY.indexOf(botKey(g, a)) < PRIORITY.indexOf(botKey(g, b));
export function hatchBusy(g, bot) {
  const lane = botLane(g.hatch);
  return bots(g).some((o) => o !== bot && o.show > 0
    && (o.show < 1 || Math.hypot(o.x - lane.x, o.y - lane.y) < BOT_SPACE));
}
export function place(g, bot, a) { const p = laneAt(g.hatch, bot.show); bot.x = p.x; bot.y = p.y; bot.a = a; }
export function emerge(g, bot, dt) {
  if (hatchBusy(g, bot)) return;
  bot.show = Math.min(1, bot.show + dt / SHOW_SECS * (bot === g.tapeBot ? 2 : 1));
  place(g, bot, g.hatch.a);
}
export function retract(g, bot, dt) {
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
export function rectDist(x, y, w) {
  const dx = Math.max(w.x - x, 0, x - (w.x + w.w)), dy = Math.max(w.y - y, 0, y - (w.y + w.h));
  return Math.hypot(dx, dy);
}

// Circles approximating each forklift (and its carried stack): { x, y, r }.
// A forklift rolling faster than MOVING_SPEED (tiles/s) counts as moving; only moving ones scare a bot.
export const MOVING_SPEED = 0.15;
export const circlesOf = (t) => {
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
export function approachGap(g, p) {
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

export const STACK_R = 0.75, REACH = 1.45;
export const underStack = (g, p) => g.stacks.some((s) => Math.hypot(s.x - p.x, s.y - p.y) < STACK_R);
export const zoneMarkKey = (z) => `${z.x},${z.y},${z.color}`;
export const areaMarkKey = (a) => `${a.color}:${a.x},${a.y},${a.w},${a.h}`;
export const zonesInArea = (g, a) => g.zones.filter((z) => z.color === a.color
  && z.x >= a.x - 0.1 && z.x <= a.x + a.w + 0.1
  && z.y >= a.y - 0.1 && z.y <= a.y + a.h + 0.1);

// Cones frame slicks and the actual footprint of inspected stacks. Existing cones are
