import { SPEED, FLEE_SPEED, WORK_SPEED, SCARE, CALM, TURN_FIRST, turnAfterPath, botLane, emerge, retract, approachGap } from './common.js';
import { buildGrid, plan, REPLAN, KEEP_ROUTE, blockedAhead, moveBot, followPath, pushOut, fleePlan } from './nav.js';
import { activity, makeWay } from './state.js';
import { followTruck } from './loiter.js';
import { SPOOK_SECS } from './cleanbot.js';
import { tapeDeploying } from './tapebot.js';

export function stepWorker(g, bot, dt, hasWork, goal, goalKey, speed = SPEED) {
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
    followPath(g, bot, FLEE_SPEED * dt, dt);
    pushOut(g, bot);
    return;
  }
  if (wasScared || bot.fleePath) { bot.path = []; bot.repath = 0; bot.fleePath = false; }
  if (bot === g.tapeBot) speed = tapeDeploying(bot) ? WORK_SPEED : SPEED;
  if (current === 'follow') {
    followTruck(g, bot, dt, speed);
    pushOut(g, bot);
    return;
  }
  if (bot.yieldFor && makeWay(g, bot, dt, speed)) { pushOut(g, bot); return; }
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
      if (Math.abs(turnAfterPath(bot, a, dt)) < TURN_FIRST) moveBot(g, bot, bot.x + dx / d * step, bot.y + dy / d * step);
    } else if (d >= 0.5 && bot.repath > REPLAN) bot.repath = REPLAN;
  }
  pushOut(g, bot);
  if (current === 'home' && Math.hypot(bot.x - destination.x, bot.y - destination.y) < 0.2 && !bot.path.length) retract(g, bot, dt);
}
