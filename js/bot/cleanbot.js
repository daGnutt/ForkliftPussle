import { SPEED, FLEE_SPEED, SCARE, CALM, TURN_FIRST, turnAfterPath, botHome, botLane, emerge, retract, truckCircles, truckGap, REACH, underStack } from './common.js';
import { REPLAN, KEEP_ROUTE, preferLive, blockedAhead, goalPlan, moveBot, followPath, pushOut, fleePlan } from './nav.js';
import { activity, makeWay } from './state.js';
import { followTruck } from './loiter.js';

export const CLEAN_SECS = 5; // seconds per oil drop
export const SKID_CLEAN_SECS = 0.3;
export const SKID_TRUCK_CLEARANCE = 1.5;

export function makeBot(g) {
  if (!g.hatch) return null;
  const home = botHome(g.hatch);
  return { x: home.x, y: home.y, a: g.hatch.a, show: 0, mode: 'hidden', cleaning: false, scared: false, path: [], repath: 0, clean: 0 };
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
  let best = null, bs = Infinity;
  for (const sp of preferLive(g, bot, g.oil || [], (o) => o.id)) {
    const sc = (underStack(g, sp) ? 1e6 : 0) + Math.round(spillDrops(sp, dropArea) * 4) * 100 + Math.hypot(sp.x - bot.x, sp.y - bot.y) - (bot.spookedUntil > g.clock ? farWeight(g, bot, CLEAN_FAR_WEIGHT) * farFromTrucks(g, sp) : 0); // only a spooked cleaner goes for far-away spills
    if (sc < bs) { bs = sc; best = sp; }
  }
  return best;
}

// Oil under a stack can't be driven to: the bot stops at the edge and reaches in with its brush arms.
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
    if (bot.yieldFor && makeWay(g, bot, dt, speed)) { pushOut(g, bot); return; }
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
      if (Math.abs(turnAfterPath(bot, Math.atan2(goal.y - bot.y, goal.x - bot.x), dt)) < TURN_FIRST) moveBot(g, bot, bot.x + (goal.x - bot.x) / d * step, bot.y + (goal.y - bot.y) / d * step);
    } else if (!target && d >= 0.5 && bot.repath > REPLAN) bot.repath = REPLAN;
  }

  pushOut(g, bot);

  if (!bot.scared && goal) {
    const d = Math.hypot(goal.x - bot.x, goal.y - bot.y);
    const reaching = target && !bot.path.length && d <= REACH && underStack(g, target);
    if (target && (d <= goal.r + 0.12 || reaching)) {
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
    } else if (!target && Math.hypot(home.x - bot.x, home.y - bot.y) < 0.15) {
      retract(g, bot, dt);
      return;
    }
  }
}
