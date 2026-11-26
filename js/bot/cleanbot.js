import { SPEED, TURN_FIRST, turnAfterPath, botHome, truckCircles, truckGap, REACH, underStack } from './common.js';
import { REPLAN, KEEP_ROUTE, preferLive, blockedAhead, goalPlan, moveBot, followPath, pushOut, buildGrid, routeDistances } from './nav.js';
import { stepHead, settle } from './state.js';

export const CLEAN_SECS = 5; // seconds per oil drop
export const SKID_CLEAN_SECS = 0.3;
export const SKID_TRUCK_CLEARANCE = 1.5;

export function makeBot(g) {
  if (!g.hatch) return null;
  const home = botHome(g.hatch);
  return { x: home.x, y: home.y, a: g.hatch.a, show: 0, mode: 'hidden', cleaning: false, state: 'loiter', path: [], repath: 0, clean: 0 };
}

export const FAR_CAP = 8, FAR_WEIGHT = 2, CLEAN_FAR_WEIGHT = 6; // the cleaner weighs distance from forklifts well above its own travel distance
// A bot that had to flee from a forklift keeps SPOOK_SECS of extra caution: its far-from-forklift preference is multiplied by SPOOK_MULT.
export const SPOOK_SECS = 25, SPOOK_MULT = 4;
export const farWeight = (g, bot, base) => base * (bot.spookedUntil > g.clock ? SPOOK_MULT : 1);
export function farFromTrucks(g, p) {
  let d = FAR_CAP;
  for (const c of truckCircles(g)) d = Math.min(d, Math.hypot(p.x - c.x, p.y - c.y) - c.r);
  return Math.max(0, d);
}

export const spillDrops = (sp, dropArea) => sp.drops ?? sp.r * sp.r / dropArea;

export function pickSpill(g, bot, dropArea) {
  const spills = preferLive(g, bot, g.oil || [], (o) => o.id);
  if (!spills.length) return null;
  const distances = routeDistances(buildGrid(g, 0.45, false, bot), bot, spills);
  let best = null, bs = Infinity;
  for (const [index, sp] of spills.entries()) {
    const found = distances[index];
    const route = Number.isFinite(found) ? found : Math.hypot(sp.x - bot.x, sp.y - bot.y);
    const sc = (underStack(g, sp) ? 1e6 : 0) + Math.round(spillDrops(sp, dropArea) * 4) * 100 + route - (bot.spookedUntil > g.clock ? farWeight(g, bot, CLEAN_FAR_WEIGHT) * farFromTrucks(g, sp) : 0); // only a spooked cleaner goes for far-away spills
    if (sc < bs) { bs = sc; best = sp; }
  }
  return best;
}

// Oil under a stack can't be driven to: the bot stops at the edge and reaches in with its brush arms.
export function stepBot(g, dt, dropArea) {
  const bot = g.bot;
  if (!bot || !g.hatch) return;
  const spill = pickSpill(g, bot, dropArea);
  const trucks = truckCircles(g);
  const safeMark = (m) => trucks.every((c) => Math.hypot(m.x - c.x, m.y - c.y) > c.r + SKID_TRUCK_CLEARANCE);
  const marks = preferLive(g, bot, (g.skidMarks || []).filter(safeMark), (m) => m.id);
  const distances = !spill && marks.length ? routeDistances(buildGrid(g, 0.45, false, bot), bot, marks) : [];
  const mark = !spill && marks.reduce((best, m, index) => {
    const found = distances[index];
    const d = Number.isFinite(found) ? found : Math.hypot(m.x - bot.x, m.y - bot.y);
    return !best || d < best.d ? { item: m, d } : best;
  }, null)?.item;
  const target = spill || mark;
  bot.debugTask = target ? `${spill ? 'spill' : 'skid'} ${target.id} at ${target.x.toFixed(1)},${target.y.toFixed(1)}` : null;
  bot.cleaning = false;
  bot.goal = null;
  if (stepHead(g, bot, dt, !!target)) return;
  const speed = SPEED;
  const key = target.id;
  if (bot.planKey !== key) { bot.planKey = key; bot.repath = 0; }
  const goal = spill ? { x: spill.x, y: spill.y, r: Math.max(0.08, Math.sqrt(spillDrops(spill, dropArea) * dropArea) * 0.5) }
    : { x: mark.x, y: mark.y, r: 0.35 };
  bot.goal = { x: goal.x, y: goal.y }; // shown by the debug overlay
  if (blockedAhead(g, bot)) bot.repath = 0;
  if (bot.repath <= 0) {
    const covered = underStack(g, target);
    bot.path = goalPlan(g, bot, target.id, (x, y) => Math.max(0, Math.hypot(x - goal.x, y - goal.y) - goal.r) * 10,
      (e) => { const d = Math.hypot(e.x - goal.x, e.y - goal.y); return covered ? d <= REACH - 0.05 : d < goal.r + 0.5; });
    bot.repath = bot.waiting || !bot.path.length ? REPLAN : KEEP_ROUTE; // a route is kept until something disturbs it
  }

  const move = followPath(g, bot, speed * dt, dt);
  // The grid is coarse: finish the last few centimetres in a straight line.
  if (!bot.path.length && move > 0) {
    const d = Math.hypot(goal.x - bot.x, goal.y - bot.y);
    if (d > 1e-6 && d < 0.5 && truckGap(g, goal) > 0 && !underStack(g, goal)) {
      const step = Math.min(move, Math.max(0, d - goal.r * 0.5));
      if (Math.abs(turnAfterPath(bot, Math.atan2(goal.y - bot.y, goal.x - bot.x), dt)) < TURN_FIRST) moveBot(g, bot, bot.x + (goal.x - bot.x) / d * step, bot.y + (goal.y - bot.y) / d * step);
    }
  }

  pushOut(g, bot);

  const d = Math.hypot(goal.x - bot.x, goal.y - bot.y);
  const reaching = !bot.path.length && d <= REACH && underStack(g, target);
  const atJob = d <= goal.r + 0.12 || reaching;
  if (atJob) {
    bot.cleaning = true;
    if (reaching) turnAfterPath(bot, Math.atan2(goal.y - bot.y, goal.x - bot.x), dt);
    if (spill) {
      const drops = spillDrops(spill, dropArea) - dt / CLEAN_SECS;
      if (drops <= 1e-9) g.oil.splice(g.oil.indexOf(spill), 1);
      else { spill.drops = drops; spill.r = Math.sqrt(drops * dropArea); }
    } else {
      for (const m of g.skidMarks) if (safeMark(m) && Math.hypot(m.x - mark.x, m.y - mark.y) < 0.5) m.left -= dt / SKID_CLEAN_SECS;
      g.skidMarks = g.skidMarks.filter((m) => m.left > 1e-9);
    }
  }
  settle(g, bot, true, atJob);
}
