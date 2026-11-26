import { toWorld } from '../forklift.js';
import { BOX_HALF_X, halfY, rectPoly } from '../geom.js';
import { BOT_R, SPEED, TURN_FIRST, turnTo, turnAfterPath, BOT_SPACE, circlesOf, truckGap, bots, botLane, retract } from './common.js';
import { buildGrid, plan, REPLAN, KEEP_ROUTE, blockedAhead, followPath, pushOut, moveBot } from './nav.js';
import { IDLE_SECS } from './state.js';

export function sightHits(p, end, x, y, hx, hy, a = 0) {
  const c = Math.cos(a), s = Math.sin(a), dx = end.x - p.x, dy = end.y - p.y;
  let lo = 0, hi = 1;
  for (const [v, d, h] of [
    [(p.x - x) * c + (p.y - y) * s, dx * c + dy * s, hx],
    [-(p.x - x) * s + (p.y - y) * c, -dx * s + dy * c, hy],
  ]) {
    if (Math.abs(d) < 1e-9) { if (Math.abs(v) > h) return false; }
    else {
      const t0 = (-h - v) / d, t1 = (h - v) / d;
      lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
      if (lo > hi) return false;
    }
  }
  return true;
}

export function truckSight(g, p, truck) {
  const aim = toWorld(truck.fl, -0.7, 0);
  return !g.walls.some((w) => sightHits(p, aim, w.x + w.w / 2, w.y + w.h / 2, w.w / 2, w.h / 2))
    && !g.stacks.some((s) => s.layers.some((_, i) => {
      const off = s.offs?.[i] || { x: 0, y: 0 };
      return sightHits(p, aim, s.x + off.x, s.y + off.y, BOX_HALF_X, halfY(s.pen?.[i]), s.rots?.[i] ?? s.a ?? 0);
    }));
}

export function viewingSpot(g, bot, p, truck) {
  return truckGap(g, p) >= 2.5
    && Math.hypot(p.x - truck.fl.x, p.y - truck.fl.y) < 8
    && bots(g).every((b) => b === bot || b.show <= 0 || Math.hypot(p.x - b.x, p.y - b.y) >= BOT_SPACE + 0.2)
    && truckSight(g, p, truck);
}

// A peek is close to an obstacle corner, with the sightline grazing its edge rather than crossing it.
export function viewCover(g) {
  const rects = g.walls.map((w) => ({ x: w.x + w.w / 2, y: w.y + w.h / 2, hx: w.w / 2, hy: w.h / 2, a: 0 }));
  for (const s of g.stacks) for (let i = 0; i < s.layers.length; i++) {
    const off = s.offs?.[i] || { x: 0, y: 0 };
    rects.push({ x: s.x + off.x, y: s.y + off.y, hx: BOX_HALF_X, hy: halfY(s.pen?.[i]), a: s.rots?.[i] ?? s.a ?? 0 });
  }
  return rects.map((r) => ({ ...r, corners: rectPoly(r.x, r.y, r.hx, r.hy, r.a) }));
}

export function peeking(p, aim, cover) {
  return cover.some((r) => {
    if (!r.corners.some((c) => Math.hypot(p.x - c.x, p.y - c.y) < 1.6)) return false;
    const c = Math.cos(r.a), s = Math.sin(r.a), dx = p.x - r.x, dy = p.y - r.y;
    const x = Math.max(-r.hx, Math.min(r.hx, dx * c + dy * s));
    const y = Math.max(-r.hy, Math.min(r.hy, -dx * s + dy * c));
    const near = { x: r.x + x * c - y * s, y: r.y + x * s + y * c };
    return (near.x - p.x) * (aim.x - p.x) + (near.y - p.y) * (aim.y - p.y) > 0
      && sightHits(p, aim, r.x, r.y, r.hx + 0.45, r.hy + 0.45, r.a);
  });
}

// Loiter: with no job a bot looks for a spot with a sight line to a forklift, far away or peeking around a wall or box corner, and stays there.
// After IDLE_SECS without a job it goes back into its hatch.
export const LOITER_RETRY = 1;
export function stepLoiter(g, bot, dt) {
  bot.goal = null;
  if ((bot.idle || 0) >= IDLE_SECS) { goHome(g, bot, dt); return; }
  const trucks = g.trucks.filter((t) => !t.gone);
  pushOut(g, bot);
  const watching = trucks.find((t) => viewingSpot(g, bot, bot, t));
  if (watching && !bot.path.length && !bot.passing) {
    bot.loiter = null;
    const aim = toWorld(watching.fl, -0.7, 0);
    turnTo(bot, Math.atan2(aim.y - bot.y, aim.x - bot.x), dt);
    return;
  }
  if (!bot.path.length && !bot.passing && bot.repath <= 0) {
    const grid = buildGrid(g, 0.45, bot === g.tapeBot, bot), cover = viewCover(g);
    let best = null;
    for (const truck of trucks) {
      const circles = circlesOf(truck), centre = toWorld(truck.fl, -0.7, 0);
      const path = plan(grid, bot, 80, (x, y, cost) => {
        const gap = Math.min(...circles.map((c) => Math.hypot(x - c.x, y - c.y) - c.r - BOT_R));
        if (gap < 2.5 || !viewingSpot(g, bot, { x, y }, truck)) return Infinity;
        return cost * 0.5 - Math.min(gap, 8) * 1.2 - (peeking({ x, y }, centre, cover) ? 5 : 0);
      });
      if (path.length && (!best || path.length < best.length)) best = path;
    }
    if (best) bot.path = best;
    bot.repath = LOITER_RETRY;
  }
  if (bot.path.length || bot.passing) { followPath(g, bot, SPEED * dt, dt); pushOut(g, bot); }
}

export function goHome(g, bot, dt) {
  const lane = botLane(g.hatch);
  bot.goal = { x: lane.x, y: lane.y };
  if (bot.planKey !== 'home') { bot.planKey = 'home'; bot.repath = 0; }
  if (blockedAhead(g, bot)) bot.repath = 0;
  if (bot.repath <= 0 && Math.hypot(lane.x - bot.x, lane.y - bot.y) > 0.15) {
    bot.path = plan(buildGrid(g, 0.45, bot === g.tapeBot, bot), bot, 80, (x, y, c) => Math.hypot(x - lane.x, y - lane.y) * 10 + c * 0.02);
    bot.repath = bot.path.length ? KEEP_ROUTE : REPLAN;
  }
  const left = followPath(g, bot, SPEED * dt, dt);
  if (!bot.path.length && left > 0) {
    const dx = lane.x - bot.x, dy = lane.y - bot.y, d = Math.hypot(dx, dy);
    if (d > 1e-6 && d < 0.5 && Math.abs(turnAfterPath(bot, Math.atan2(dy, dx), dt)) < TURN_FIRST) moveBot(g, bot, bot.x + dx / d * Math.min(left, d), bot.y + dy / d * Math.min(left, d));
    else if (d >= 0.5 && bot.repath > REPLAN) bot.repath = REPLAN;
  }
  pushOut(g, bot);
  if (Math.hypot(lane.x - bot.x, lane.y - bot.y) < 0.2 && !bot.path.length) retract(g, bot, dt);
}
