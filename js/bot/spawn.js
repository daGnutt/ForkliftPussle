import { BOT_R, BOT_SPACE, STACK_R, SPEED, TURN_RATE, turnTo, rectDist, truckCircles, bots, botsCollide } from './common.js';
import { moveBot, nearBox, pushOut } from './nav.js';
import { stepWorker } from './worker.js';
import { speak } from './speech.js';

// Spawning and despawning of cones and tape posts. A sequence is plain data in `bot.seq` so it survives saving; what it creates or removes is
// done by the owner's registered `commit` (by name, see `registerCommit`).
//   spawn:   aim at a clear heading → wait → create the object under the bot → drive on ≥ its size
//   despawn: face away from the object → reverse onto it → remove it → wait → free again
// Bots ignore tape posts and cones when moving; ghost is retained in sequence state for save compatibility.
export const LEAVE_MIN = 0.4, SPAWN_WAIT = 0.25, STUCK_SECS = 1.5, AIM_TOL = 0.05, TOUCH = 0.06;
const COMMITS = {};
export const registerCommit = (name, fn) => { COMMITS[name] = fn; };

export function startSpawn(bot, { commit, data, size, speed = SPEED, at = bot }) {
  bot.seq = { kind: 'spawn', phase: 'aim', t: SPAWN_WAIT, commit, data, size, speed, at: { x: at.x, y: at.y }, stuck: 0 };
}
export function startDespawn(bot, { commit, data, at, speed = SPEED }) {
  bot.seq = { kind: 'despawn', phase: 'face', t: SPAWN_WAIT, commit, data, size: 0, speed, at: { x: at.x, y: at.y }, stuck: 0 };
}

// Is the bot's body clear at point p (walls, boxes, forklifts and other bots)?
function clearAt(g, bot, p) {
  return p.x >= BOT_R && p.y >= BOT_R && p.x <= g.w - BOT_R && p.y <= g.h - BOT_R
    && !g.walls.some((w) => rectDist(p.x, p.y, w) < BOT_R)
    && !g.stacks.some((s) => Math.hypot(p.x - s.x, p.y - s.y) < STACK_R * 0.6 || nearBox(s, p.x, p.y, BOT_R))
    && !truckCircles(g).some((c) => Math.hypot(p.x - c.x, p.y - c.y) < c.r + BOT_R)
    && !bots(g).some((o) => o !== bot && o.show > 0 && botsCollide(bot, o) && Math.hypot(p.x - o.x, p.y - o.y) < BOT_SPACE);
}
const clearHeading = (g, bot, a, size, reach = [size + 0.1, size + 0.4]) => reach.every((d) => clearAt(g, bot, { x: bot.x + Math.cos(a) * d, y: bot.y + Math.sin(a) * d }));

// The heading closest to the current one with a clear stretch of floor ahead of it, or null when boxed in.
export function spawnHeading(g, bot, size) {
  for (const k of [0, 1, -1, 2, -2, 3, -3, 4]) {
    const a = bot.a + k * Math.PI / 4;
    if (clearHeading(g, bot, a, size)) return a;
  }
  for (const k of [0, 1, -1, 2, -2, 3, -3, 4]) { // cramped (e.g. a corner): settle for room to clear the object itself
    const a = bot.a + k * Math.PI / 4;
    if (clearHeading(g, bot, a, size, [size + 0.1])) return a;
  }
  return null;
}

function drop(bot) { bot.seq = null; bot.ghost = null; }

// Advances a running sequence; returns true while the bot is busy with one (the caller then skips its job logic).
export function stepSeq(g, bot, dt) {
  const s = bot.seq;
  if (!s) return false;
  stepWorker(g, bot, dt, true, null, null, SPEED, true);
  if (!bot.seq) return true;
  if (bot.show !== 1 || bot.state !== 'working') { drop(bot); return true; }
  if (s.phase === 'aim') {
    if (s.heading != null && !clearHeading(g, bot, s.heading, s.size, [s.size + 0.1])) delete s.heading;
    const a = s.heading ?? (s.heading = spawnHeading(g, bot, s.size));
    if (a == null) { // boxed in: after a second, go ahead with the current heading rather than stall the bot forever
      s.aimT = (s.aimT || 0) + dt;
      if (s.aimT > 1) { s.phase = 'free'; s.t = SPAWN_WAIT; }
      return true;
    }
    if (Math.abs(turnTo(bot, a, dt)) < AIM_TOL) { s.phase = 'wait'; s.t = SPAWN_WAIT; }
  } else if ((s.phase === 'wait' || s.phase === 'free') && s.kind === 'spawn') {
    if (s.phase === 'wait' && !clearHeading(g, bot, bot.a, s.size, [s.size + 0.1])) {
      s.phase = 'aim'; delete s.heading; s.aimT = 0; return true;
    }
    s.t -= dt;
    if (s.t > 0) return true;
    COMMITS[s.commit]?.(g, bot, s, 'spawn');
    speak(g, bot, 'spawn');
    bot.ghost = { x: s.at.x, y: s.at.y };
    s.phase = 'leave'; s.from = { x: bot.x, y: bot.y };
  } else if (s.phase === 'leave') {
    const x = bot.x, y = bot.y, step = s.speed * dt;
    moveBot(g, bot, x + Math.cos(bot.a) * step, y + Math.sin(bot.a) * step);
    pushOut(g, bot);
    s.stuck = Math.hypot(bot.x - x, bot.y - y) < step * 0.3 ? s.stuck + dt : 0;
    if (Math.hypot(bot.x - s.from.x, bot.y - s.from.y) >= Math.max(s.size, LEAVE_MIN) || s.stuck > STUCK_SECS) drop(bot);
  } else if (s.phase === 'face') {
    const d = Math.hypot(bot.x - s.at.x, bot.y - s.at.y);
    if (d < TOUCH) { s.phase = 'reverse'; return true; }
    if (Math.abs(turnTo(bot, Math.atan2(bot.y - s.at.y, bot.x - s.at.x), dt, TURN_RATE)) < AIM_TOL) s.phase = 'reverse';
    bot.ghost = { x: s.at.x, y: s.at.y };
  } else if (s.phase === 'reverse') {
    bot.ghost = { x: s.at.x, y: s.at.y };
    const x = bot.x, y = bot.y, d = Math.hypot(x - s.at.x, y - s.at.y), step = Math.min(s.speed * 0.6 * dt, d);
    if (d >= TOUCH) {
      moveBot(g, bot, x - Math.cos(bot.a) * step, y - Math.sin(bot.a) * step);
      pushOut(g, bot);
      s.stuck = Math.hypot(bot.x - x, bot.y - y) < step * 0.3 ? s.stuck + dt : 0;
    }
    if (d < TOUCH || Math.hypot(bot.x - s.at.x, bot.y - s.at.y) < TOUCH || s.stuck > STUCK_SECS) {
      COMMITS[s.commit]?.(g, bot, s, 'despawn');
      speak(g, bot, 'despawn');
      bot.ghost = null; s.phase = 'rest'; s.t = SPAWN_WAIT;
    }
  } else if (s.phase === 'rest') {
    s.t -= dt;
    if (s.t <= 0) drop(bot);
  }
  return true;
}
