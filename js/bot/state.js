import { BOT_SPACE, SPEED, FLEE_SPEED, FLEE_BOT_SPEED, SCARE, CALM, truckCircles, approachGap, bots, botKey, outranks, botLane, emerge, retract } from './common.js';
import { followPath, pushOut, fleePlan, pathDistance, botAhead } from './nav.js';
import { SPOOK_SECS } from './cleanbot.js';
import { stepLoiter } from './loiter.js';
import { speak } from './speech.js';

export { bots, botKey, outranks };
export const STATES = ['flee', 'right-of-way', 'going-to-work', 'working', 'loiter'];

// Beacon prisms use the same local dimensions as the shared bot parts.
export const BOT_BEACONS = {
  bot: [-0.08, 0, 0.045, 0.06, 0.40, 0.46, '#ef941f'],
  inspector: [-0.08, 0, 0.045, 0.06, 0.45, 0.51, '#ef941f'],
  coneBot: [0.13, 0, 0.06, 0.145, 0.60, 0.65, '#ef941f'],
  tapeBot: [0, 0, 0.055, 0.08, 1.35, 1.43, '#78e5f4'],
};
export const beaconPulse = (g) => Math.floor((g.clock || 0) * 4) % 2 === 0;
// Beacon: blinking red while fleeing, blinking blue in right-of-way, blinking amber going to and doing work, off while loitering.
export const STATE_TONE = { flee: 'red', 'right-of-way': 'blue' };
export const botBeaconTone = (g, b) => !b?.show ? null : STATE_TONE[b.state] || null;
export const botBeaconOn = (g, b) => b?.show > 0 && (b.state === 'flee' || b.state === 'right-of-way' || b.state === 'going-to-work' || b.state === 'working') && beaconPulse(g);
export const TONES = { blue: ['#3d8bff', '#1f4fbf'], red: ['#ff3b30', '#a31c14'] };
export const beaconColor = (color, on, tone = null) => tone ? TONES[tone][on ? 0 : 1] : on ? color === '#ef941f' ? '#ffc45a' : '#c7fbff' : color;
export const proximityBeaconOn = (g, p) => beaconPulse(g)
  && truckCircles(g).some((c) => Math.hypot(p.x - c.x, p.y - c.y) < c.r + 3);
export const IDLE_SECS = 600, ROW_NEAR = BOT_SPACE + 0.6, YELL_SECS = 0.8, FLEE_BOT_HOLD = 0.5;

// Changing state discards the old route when the bot starts or stops having a job (or stops fleeing).
export function setState(bot, next) {
  const prev = bot.state;
  if (next === 'flee') { bot.task = null; bot.workKey = null; }
  if (prev === next) return;
  bot.state = next;
  if (prev === 'flee' || prev === 'loiter' || next === 'loiter') {
    bot.path = []; bot.repath = 0; bot.planKey = null; bot.passing = null; bot.loiter = null; bot.blockWait = 0;
  }
}

function enterFlee(g, bot) {
  setState(bot, 'flee');
  bot.path = []; bot.repath = 0; bot.fleePath = false; bot.target = null; bot.shooting = 0; bot.passing = null;
  bot.seq = null; bot.ghost = null;
  if (bot === g.tapeBot) bot.tapeJob = null;
}

// What a bot is running from: a moving forklift, a bot in right-of-way (unless this one outranks it or is itself in right-of-way), or a worker it is blocking.
export function threatOf(g, bot) {
  const was = bot.state === 'flee';
  const out = { speed: 0, kind: null, keys: [] };
  if (approachGap(g, bot) < (was && bot.fleeKind === 'truck' ? CALM : SCARE)) {
    out.speed = FLEE_SPEED; out.kind = 'truck'; bot.spookedUntil = g.clock + SPOOK_SECS;
  }
  for (const o of bots(g)) {
    if (o === bot || o.show !== 1 || o.state !== 'right-of-way') continue;
    if (outranks(g, bot, o) && !(bot.state === 'loiter' && (o.blockWait || 0) > 4)) continue; // a higher-priority bot stays, unless it is idle and the requester is stuck
    if (bot.state === 'right-of-way' && !((bot.blockWait || 0) > 4 && outranks(g, o, bot))) continue; // a stuck lower-priority bot makes way
    if (Math.hypot(o.x - bot.x, o.y - bot.y) < ROW_NEAR || pathDistance(bot, o, o.path || []) < BOT_SPACE + 0.4) out.keys.push(botKey(g, o));
  }
  if (bot.yelledUntil > g.clock && g[bot.yelledBy]?.show > 0) out.keys.push(bot.yelledBy);
  if (out.keys.length) {
    out.speed = FLEE_BOT_SPEED; out.kind = out.kind || 'bot';
    bot.fleeUntil = g.clock + FLEE_BOT_HOLD; bot.fleeKeys = out.keys;
  } else if (!out.kind && was && bot.fleeKind === 'bot' && g.clock < bot.fleeUntil) {
    out.speed = FLEE_BOT_SPEED; out.kind = 'bot'; out.keys = bot.fleeKeys || [];
  }
  return out;
}

// The part of a bot's step that every bot shares: hatch emerging/retracting, fleeing and loitering. Returns 'hatch', 'flee' or 'loiter'
// when it handled the frame, or false when the caller should run its job logic (and then call `settle`).
export function stepHead(g, bot, dt, hasWork) {
  if (bot.state === 'flee') { bot.task = null; bot.workKey = null; }
  bot.idle = hasWork ? 0 : (bot.idle || 0) + dt;
  if (bot.mode === 'hidden') {
    if (!hasWork) return 'hatch';
    bot.mode = 'out';
  }
  if (hasWork) bot.leaving = false;
  if (bot.show < 1) {
    if (bot.state !== 'flee') setState(bot, hasWork ? 'going-to-work' : 'loiter');
    if (bot.leaving) retract(g, bot, dt); else emerge(g, bot, dt);
    return 'hatch';
  }
  bot.repath -= dt;
  const threat = threatOf(g, bot);
  if (threat.kind) {
    if (bot.state !== 'flee') { enterFlee(g, bot); speak(g, bot, threat.kind === 'truck' ? 'flee-truck' : 'flee-bot'); }
    bot.fleeKind = threat.kind;
    bot.goal = null;
    const threats = threat.keys.map((k) => g[k]).filter(Boolean);
    if (bot.repath <= 0 || !bot.fleePath) { bot.path = fleePlan(g, bot, threats); bot.fleePath = true; bot.repath = 0.25; }
    followPath(g, bot, threat.speed * dt, dt);
    pushOut(g, bot);
    return 'flee';
  }
  if (bot.state === 'flee') {
    setState(bot, 'loiter'); bot.fleePath = false; bot.fleeKind = null; bot.target = null;
    return 'flee';
  }
  if (!hasWork) {
    setState(bot, 'loiter');
    stepLoiter(g, bot, dt);
    return 'loiter';
  }
  if (bot.state === 'loiter') setState(bot, 'going-to-work');
  return false;
}

// After the job logic: pick going-to-work / right-of-way / working. Right-of-way is entered only from going-to-work, when another bot is in the way,
// and kept until the job is reached.
export function settle(g, bot, hasWork, atJob) {
  if (bot.state === 'flee' || bot.show < 1) return;
  let next = 'going-to-work';
  if (!hasWork) next = 'loiter';
  else if (atJob) next = 'working';
  else if (bot.state === 'right-of-way') next = 'right-of-way';
  else if (bot.state === 'going-to-work' && bot.path.length && botAhead(g, bot, bot.path[0])) next = 'right-of-way';
  if (next === 'right-of-way' && bot.state !== 'right-of-way') speak(g, bot, 'right-of-way');
  setState(bot, next);
  if (next === 'working') yellIfBlocked(g, bot);
}

// A working bot with another bot in its way yells at it; the blocker then flees. Of two working bots only the higher-priority one yells.
export function yellIfBlocked(g, bot) {
  for (const o of bots(g)) {
    if (o === bot || o.show !== 1 || o.state === 'flee' || Math.hypot(o.x - bot.x, o.y - bot.y) >= BOT_SPACE + 0.12) continue;
    if (o.state === 'working' && outranks(g, o, bot)) continue;
    o.yelledBy = botKey(g, bot); o.yelledUntil = g.clock + YELL_SECS;
    bot.blockedBy = botKey(g, o);
    if (!(bot.say?.until > g.clock)) speak(g, bot, 'yell');
  }
}
