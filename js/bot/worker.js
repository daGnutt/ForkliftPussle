import { SPEED, WORK_SPEED, TURN_FIRST, turnAfterPath, botKey } from './common.js';
import { buildGrid, plan, REPLAN, KEEP_ROUTE, blockedAhead, moveBot, followPath, pushOut, watchStuck } from './nav.js';
import { stepHead, settle } from './state.js';
import { tapeDeploying } from './tapebot.js';

export const AT_JOB = 0.35; // within this of the goal (with the route finished) the bot is at its job
export function stepWorker(g, bot, dt, hasWork, goal, goalKey, speed = SPEED, atJob = null) {
  if (!bot || !g.hatch) return;
  bot.goal = null;
  if (stepHead(g, bot, dt, hasWork)) return;
  if (bot === g.tapeBot) speed = tapeDeploying(bot) ? WORK_SPEED : SPEED;
  if (!goal) { settle(g, bot, hasWork, atJob); return; }
  bot.goal = { x: goal.x, y: goal.y };
  const newGoal = bot.planKey !== goalKey;
  if (newGoal) { bot.planKey = goalKey; bot.repath = 0; }
  if (blockedAhead(g, bot)) bot.repath = 0;
  if (bot.repath <= 0) {
    bot.path = plan(buildGrid(g, 0.45, bot === g.tapeBot, bot), bot, 80, (x, y, c) => Math.hypot(x - goal.x, y - goal.y) * 10 + c * 0.02);
    bot.repath = bot.path.length ? KEEP_ROUTE : REPLAN;
    if (g.debugBots && newGoal) console.debug('[worker bot] route planned', {
      bot: botKey(g, bot), goalKey, goal: { x: goal.x, y: goal.y }, waypoints: bot.path.length,
    });
  }
  const start = { x: bot.x, y: bot.y };
  const left = followPath(g, bot, speed * dt, dt);
  const recoveryUntil = g.debugBots ? bot.recoveryUntil : null;
  watchStuck(g, bot, dt, start, speed * dt);
  if (g.debugBots && bot.recoveryUntil !== recoveryUntil) console.debug('[worker bot] stuck recovery', {
    bot: botKey(g, bot), goalKey, position: { x: bot.x, y: bot.y },
    action: bot.stuckCount === 0 ? 'temporarily skipped job' : 'escape route',
    waypoints: bot.path.length,
  });
  if (!bot.path.length && left > 0) {
    const dx = goal.x - bot.x, dy = goal.y - bot.y, d = Math.hypot(dx, dy);
    if (d > 1e-6 && d < 0.5) {
      const step = Math.min(left, d), a = Math.atan2(dy, dx);
      if (Math.abs(turnAfterPath(bot, a, dt)) < TURN_FIRST) moveBot(g, bot, bot.x + dx / d * step, bot.y + dy / d * step);
    } else if (d >= 0.5 && bot.repath > REPLAN) bot.repath = REPLAN;
  }
  pushOut(g, bot);
  settle(g, bot, hasWork, atJob ?? (!bot.path.length && Math.hypot(goal.x - bot.x, goal.y - bot.y) < AT_JOB));
}
