import { BOT_SPACE, truckCircles } from './common.js';
import { buildGrid, plan, REPLAN, followPath, pathDistance } from './nav.js';

export const bots = (g) => [g.bot, g.inspector, g.coneBot, g.tapeBot, g.fixBot].filter(Boolean);
export const botKey = (g, bot) => ['bot', 'inspector', 'coneBot', 'tapeBot', 'fixBot'].find((key) => g[key] === bot);
// Right of way: a bot blocked by a lower-ranked bot requests a clear path and the other flees from its route (box righter ranks highest).
export const BOT_RANK = ['coneBot', 'tapeBot', 'bot', 'inspector', 'fixBot'];
export const outranks = (g, a, b) => BOT_RANK.indexOf(botKey(g, a)) > BOT_RANK.indexOf(botKey(g, b));
export const requesting = (g, b) => !!b?.rightOfWay; // lasts until the bot has reached its destination (route finished) or changes activity
export const canYield = (g, worker, bot) => (worker.activity === 'work' && bot.activity === 'follow'
  || (worker.activity === 'work' || worker.activity === 'home') && outranks(g, worker, bot))
  && !bot.scared && bot.show === 1 && bot.yieldBlock?.worker !== botKey(g, worker);
// Beacon prisms use the same local dimensions as the shared bot parts.
export const BOT_BEACONS = {
  bot: [-0.08, 0, 0.045, 0.06, 0.40, 0.46, '#ef941f'],
  inspector: [-0.08, 0, 0.045, 0.06, 0.45, 0.51, '#ef941f'],
  coneBot: [0.13, 0, 0.06, 0.145, 0.60, 0.65, '#ef941f'],
  tapeBot: [0, 0, 0.055, 0.08, 1.35, 1.43, '#78e5f4'],
};
export const beaconPulse = (g) => Math.floor((g.clock || 0) * 4) % 2 === 0;
// Beacon tone: bright blue while requesting right of way, red while fleeing or making way for such a request.
export const botRequesting = (g, b) => !!b?.show && !b.scared && requesting(g, b);
export const botBeaconTone = (g, b) => !b?.show ? null : b.scared || b.yieldFor ? 'red' : requesting(g, b) ? 'blue' : null;
export const botBeaconOn = (g, b) => b?.show > 0 && (b.activity === 'work' || !!botBeaconTone(g, b)) && beaconPulse(g);
export const TONES = { blue: ['#3d8bff', '#1f4fbf'], red: ['#ff3b30', '#a31c14'] };
export const beaconColor = (color, on, tone = null) => tone ? TONES[tone][on ? 0 : 1] : on ? color === '#ef941f' ? '#ffc45a' : '#c7fbff' : color;
export const proximityBeaconOn = (g, p) => beaconPulse(g)
  && truckCircles(g).some((c) => Math.hypot(p.x - c.x, p.y - c.y) < c.r + 3);
export const IDLE_SECS = 600, FOLLOW_GAP = 3.5;

// Changing activity discards the old route so new work or a trip home always takes priority.
export function activity(bot, work, dt) {
  bot.idle = work ? 0 : (bot.idle || 0) + dt;
  const next = work ? 'work' : bot.idle >= IDLE_SECS ? 'home' : 'follow';
  if (bot.activity !== next) {
    bot.activity = next; bot.path = []; bot.repath = 0; bot.planKey = null;
    bot.target = null; bot.shooting = 0; bot.idleEscape = false;
    bot.curiosity = null; bot.observing = false; bot.passing = null;
    bot.yieldPath = []; bot.yieldFor = null; bot.yieldBlock = null; bot.rightOfWay = false;
  }
  if (work) bot.leaving = false;
  return next;
}

export function makeWay(g, bot, dt, speed) {
  const worker = g[bot.yieldFor];
  if (!worker || worker.show <= 0 || (worker.activity !== 'work' && worker.activity !== 'home') || worker.scared || !worker.path.length
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
