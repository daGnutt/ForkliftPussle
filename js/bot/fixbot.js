import { SPEED, angDiff, rectDist, truckCircles } from './common.js';
import { buildGrid, plan, routeDistance, SKIP_SECS, skipped } from './nav.js';
import { makeTapeBot } from './tapebot.js';
import { stepWorker } from './worker.js';

export const FIX_HOVER = 0.4, FIX_H_FOLDED = 0.5, FIX_H_OPEN = 2.2;
export const FIX_BEAM_SECS = 0.9, FIX_UNFOLD_SECS = 0.7, FIX_GIVE_UP = 90, FIX_REACH = 2.1;
export const smooth = (p) => p * p * (3 - 2 * p);
export const lerp = (a, b, t) => a + (b - a) * t;
export const toppled = (p) => !!p?.tip || !!p?.loose;
export const TIP_ANGLE = [0, Math.PI / 2, Math.PI];

export function makeFixBot(g) {
  const bot = makeTapeBot(g);
  return bot && { ...bot, unfold: 0, fix: null, carry: null, carryZ: 0, beam: null };
}

// Geometry of the arch for an unfold amount: leg spacing, head height, and the parts [u, v, hl, hw, z0, z1, color, emissive].
export function fixBotShape(f) {
  const h = lerp(FIX_H_FOLDED, FIX_H_OPEN, f), vl = lerp(0.12, 0.7, f), parts = [];
  for (const side of [-1, 1]) {
    parts.push([0, side * (vl + 0.03), 0.42, 0.1, 0, 0.22, '#2d3234']);
    parts.push([0, side * vl, 0.1, 0.09, 0.22, lerp(0.42, 1.0, f), '#e4e7e3']);
    parts.push([0, side * vl, 0.08, 0.07, lerp(0.42, 1.0, f), h - 0.25, '#4f9a62']);
  }
  parts.push([0, 0, 0.2, vl + 0.1, h - 0.27, h - 0.05, '#e4e7e3']);
  parts.push([0.2, 0, 0.012, lerp(0.1, 0.32, f), h - 0.23, h - 0.09, '#7dff9c', true]);
  parts.push([0, 0, 0.13, 0.13, h - 0.3, h - 0.27, '#a5ffc4', true]);
  return { h, vl, parts, beamZ: h - 0.3 };
}

export function fixTargets(g, bot) {
  const out = [];
  for (const s of g.stacks) {
    const p = s.pen?.[0];
    if (!toppled(p) || s.roll || s.fall) continue;
    const kind = p.loose && !p.loose.set ? 'pallet' : 'box';
    const at = kind === 'pallet' ? p.loose : s, key = `${kind}:${s.x.toFixed(2)},${s.y.toFixed(2)}`;
    if (!skipped(g, bot, key)) out.push({ kind, key, sx: s.x, sy: s.y, x: at.x, y: at.y });
  }
  return out;
}
export const fixStack = (g, job) => g.stacks.find((s) => s.x === job.sx && s.y === job.sy);

export function pickFixJob(g, bot) {
  const ts = fixTargets(g, bot);
  if (!ts.length) return null;
  const grid = buildGrid(g, 0.45, false, bot), best = [];
  for (const kind of ['pallet', 'box']) {
    ts.filter((t) => t.kind === kind).forEach((t) => {
      const path = plan(grid, bot, 80, (x, y, c) => Math.hypot(x - t.x, y - t.y) * 10 + c * 0.02);
      const end = path.length ? path[path.length - 1] : { x: bot.x, y: bot.y }, d = Math.hypot(end.x - t.x, end.y - t.y);
      const found = routeDistance(grid, bot, t);
      best.push({ ...t, tier: (kind === 'pallet' ? 0 : 1) + (d <= FIX_REACH ? 0 : 2), ax: end.x, ay: end.y,
        d: Number.isFinite(found) ? found : Math.hypot(t.x - bot.x, t.y - bot.y) });
    });
  }
  best.sort((a, b) => a.tier - b.tier || a.d - b.d);
  const t = best[0];
  return { kind: t.kind, key: t.key, sx: t.sx, sy: t.sy, x: t.x, y: t.y, ax: t.ax, ay: t.ay, tier: t.tier, phase: 'go', t: 0, age: 0, stuck: 0 };
}

export function spotFree(g, x, y, self) {
  if (x < 1 || y < 1 || x > g.w - 1 || y > g.h - 1) return false;
  if (g.walls.some((w) => rectDist(x, y, w) < 0.8)) return false;
  if (g.hatch && Math.hypot(g.hatch.x - x, g.hatch.y - y) < 2.5) return false; // never block the bot's own way home
  for (const s of g.stacks) {
    if (Math.hypot(s.x - x, s.y - y) < 1.5) return false;
    const l = s !== self && s.pen?.[0]?.loose;
    if (l && Math.hypot(l.x - x, l.y - y) < 1.3) return false;
  }
  return !truckCircles(g).some((c) => Math.hypot(c.x - x, c.y - y) < c.r + 1);
}
export function freeSpot(g, bot, self) {
  const a = Math.round(bot.a / (Math.PI / 2)) * Math.PI / 2;
  if (spotFree(g, bot.x, bot.y, self)) return { x: bot.x, y: bot.y, a };
  for (let r = 0.6; r <= 4; r += 0.4) {
    for (let k = 0; k < 16; k++) {
      const t = bot.a + k * Math.PI / 8, x = bot.x + Math.cos(t) * r, y = bot.y + Math.sin(t) * r;
      if (spotFree(g, x, y, self)) return { x, y, a };
    }
  }
  return { x: bot.x, y: bot.y, a };
}

export const setLoose = (s, patch) => { for (const p of s.pen) p.loose = { ...p.loose, ...patch }; };
export function placeBox(g, s, spot) {
  for (const p of s.pen) { delete p.tip; delete p.loose; delete p.tipShow; }
  s.x = spot.x; s.y = spot.y; s.a = spot.a;
  s.rots = s.rots.map(() => spot.a);
  s.offs = s.offs.map(() => ({ x: 0, y: 0 }));
  g.stacks.push(s);
}

// Puts whatever is in the beam down where it is, ending the job.
export function fixAbort(g, bot, job) {
  const spot = { x: bot.x, y: bot.y, a: Math.round(bot.a / (Math.PI / 2)) * Math.PI / 2 };
  if (bot.carry) {
    placeBox(g, bot.carry, spot);
    bot.carry = null;
  } else if (job?.kind === 'pallet' && job.phase !== 'go') {
    const s = fixStack(g, job);
    if (s) { setLoose(s, { x: spot.x, y: spot.y, a: spot.a, set: true }); for (const p of s.pen) delete p.loose.lift; }
  }
  bot.carryZ = 0; bot.beam = null; bot.fix = null; bot.task = null;
}

export function fixValid(g, bot, job) {
  if (bot.carry) return true;
  const s = fixStack(g, job), p = s?.pen?.[0];
  if (!toppled(p)) return false;
  return job.kind === 'pallet' ? !!p.loose && !p.loose.set : !p.loose || !!p.loose.set;
}

export function stepFixBot(g, dt) {
  const bot = g.fixBot;
  if (!bot) return;
  bot.beam = null;
  let job = bot.fix;
  if (bot.state === 'flee') {
    if (job) fixAbort(g, bot, job);
    stepWorker(g, bot, dt, false, null, null);
    return;
  }
  if (!job && bot.show === 1 && bot.state !== 'loiter') job = bot.fix = pickFixJob(g, bot);
  if (job?.phase === 'go' && job.x == null) {
    const stack = fixStack(g, job), at = job.kind === 'pallet' ? stack?.pen?.[0]?.loose : stack;
    if (at) { job.x = at.x; job.y = at.y; }
  }
  if (!job) bot.planKey = null;
  if (job && (job.age += dt) > FIX_GIVE_UP) { (bot.skip ||= {})[job.key] = g.clock + SKIP_SECS * 6; fixAbort(g, bot, job); job = null; }
  const hasWork = !!job || fixTargets(g, bot).length > 0 || !!bot.carry;
  bot.debugTask = job ? `${job.phase} ${job.kind}${job.tier > 1 ? ' (cheat)' : ''}` : null;
  let s = job && !bot.carry && job.phase !== 'go' ? fixStack(g, job) : null;
  let goal = null;
  if (job) goal = job.phase === 'go' ? { x: job.ax, y: job.ay } : job.phase === 'carry' ? job.spot : { x: bot.x, y: bot.y };
  if (job && !bot.task) bot.task = { type: `fix:${job.phase}`, key: job.key, id: job.key, goal: { x: goal.x, y: goal.y } };
  const task = bot.task;
  if (task) goal = task.goal;
  stepWorker(g, bot, dt, hasWork, goal, job ? `${job.phase}:${job.key}` : null, SPEED, !!job && job.phase !== 'go');
  if (job && bot.task !== task) { fixAbort(g, bot, job); return; }
  // It drives collapsed, and only unfolds to pick something up and to move with it.
  const working = !!job && job.phase !== 'go' && bot.show === 1 && bot.state !== 'loiter';
  bot.unfold = Math.max(0, Math.min(1, bot.unfold + (working ? 1 : -1) * dt / FIX_UNFOLD_SECS));
  if (!job) return;
  const move = (x, y, a, z) => {
    if (bot.carry) {
      Object.assign(bot.carry, { x, y, a }); bot.carry.rots = bot.carry.rots.map(() => a); bot.carryZ = z;
    } else if (s) setLoose(s, { x, y, a, lift: z });
    bot.beam = { x, y, z };
  };
  if (job.phase === 'carry') { job.stuck = bot.path.length ? 0 : job.stuck + dt; }
  else if (job.phase === 'go') job.stuck = bot.path.length ? 0 : job.stuck + dt;
  const arrived = bot.state !== 'flee' && (job.phase === 'go' || bot.unfold >= 1) && !bot.path.length && goal && Math.hypot(bot.x - goal.x, bot.y - goal.y) < 0.6;
  if (job.phase === 'go' && arrived) {
    s = fixStack(g, job);
    const at = job.kind === 'pallet' ? s?.pen?.[0]?.loose : s;
    if (!fixValid(g, bot, job) || !at || Math.hypot(at.x - job.x, at.y - job.y) >= 0.22) { fixAbort(g, bot, job); return; }
  }
  const obj = bot.carry || s;
  if (job.phase === 'go' && arrived && obj) {
    job.phase = 'up'; job.t = 0; bot.task = null;
    if (job.kind === 'box') {
      g.stacks.splice(g.stacks.indexOf(s), 1);
      delete s.roll; delete s.fall;
      bot.carry = s; job.ox = s.x; job.oy = s.y; job.oa = s.a || 0;
    } else { const l = s.pen[0].loose; job.ox = l.x; job.oy = l.y; job.oa = l.a; }
  } else if (job.phase === 'up') {
    if (bot.state !== 'flee' && bot.unfold >= 1) job.t += dt;
    const p = Math.min(1, job.t / FIX_BEAM_SECS), e = smooth(p), c = bot.carry || s;
    if (c) {
      move(lerp(job.ox, bot.x, e), lerp(job.oy, bot.y, e), job.oa + angDiff(job.oa, bot.a) * e, FIX_HOVER * e);
      if (bot.carry) for (const q of bot.carry.pen) if (q.tip) q.tipShow = TIP_ANGLE[q.tip] * (1 - e);
    }
    if (p >= 1) {
      job.phase = 'carry'; job.t = 0;
      const l = bot.carry ? bot.carry.pen[0].loose : null;
      job.spot = job.kind === 'pallet' ? freeSpot(g, bot, s) : l ? { x: l.x, y: l.y, a: l.a } : { x: job.sx, y: job.sy, a: job.oa };
      bot.task = null;
    }
  } else if (job.phase === 'carry') {
    move(bot.x, bot.y, bot.a, FIX_HOVER);
    if (arrived) {
      job.phase = 'down'; job.t = 0; job.dx = bot.x; job.dy = bot.y; job.da = bot.a; bot.task = null;
      if (job.kind === 'box') { const l = bot.carry?.pen[0].loose; job.pallet = l && { x: l.x, y: l.y, a: l.a }; job.spot = { x: bot.x, y: bot.y, a: bot.a }; }
    }
  } else if (job.phase === 'down') {
    if (bot.state !== 'flee' && bot.unfold >= 1) job.t += dt;
    const p = Math.min(1, job.t / FIX_BEAM_SECS), e = smooth(p), sp = job.spot;
    move(lerp(job.dx, sp.x, e), lerp(job.dy, sp.y, e), job.da + angDiff(job.da, sp.a) * e, FIX_HOVER * (1 - e));
    // A box is only ever set down right beneath the bot; its lost pallet slides in under it.
    if (job.pallet && bot.carry) {
      const q = job.pallet, pose = { x: lerp(q.x, sp.x, e), y: lerp(q.y, sp.y, e), a: q.a + angDiff(q.a, sp.a) * e };
      for (const p of bot.carry.pen) p.loose = { ...p.loose, ...pose };
    }
    if (p >= 1) {
      if (bot.carry) { placeBox(g, bot.carry, sp); bot.carry = null; }
      else if (s) { setLoose(s, { x: sp.x, y: sp.y, a: sp.a, set: true }); for (const q of s.pen) delete q.loose.lift; }
      bot.carryZ = 0; bot.fix = null; bot.task = null; bot.beam = null;
    }
  }
}
