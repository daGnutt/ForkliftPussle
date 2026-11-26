import { toWorld } from '../forklift.js';
import { BOX_HALF_X, halfY, rectPoly } from '../geom.js';
import { BOT_R, CELL, turnAfterPath, BOT_SPACE, rectDist, circlesOf, truckGap } from './common.js';
import { buildGrid, cellOf, plan, REPLAN, KEEP_ROUTE, blockedAhead, followPath, pushOut } from './nav.js';
import { bots, FOLLOW_GAP, makeWay } from './state.js';

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

export function followTruck(g, bot, dt, speed) {
  if (bot.yieldBlock && (bot.yieldBlock.left -= dt) <= 0) bot.yieldBlock = null;
  if (bot.yieldFor && makeWay(g, bot, dt, speed)) return;
  const wall = g.walls.find((w) => rectDist(bot.x, bot.y, w) < BOT_R * 1.05);
  if (wall || bot.idleEscape) {
    bot.observing = false;
    if (!bot.idleEscape) {
      pushOut(g, bot);
      bot.path = plan(buildGrid(g, 0.45, bot === g.tapeBot, bot), bot, 6, (x, y, cost) => Math.max(0, 1.5 - rectDist(x, y, wall)) * 4 + cost * 0.2);
      bot.idleEscape = true; bot.curiosity = null;
    }
    followPath(g, bot, speed * dt, dt);
    if (!bot.path.length) { bot.idleEscape = false; bot.repath = 0; }
    return;
  }
  const trucks = g.trucks.filter((t) => !t.gone);
  let q = bot.curiosity, truck = q && trucks.find((t) => t.id === q.truck);
  bot.observing = false;
  if (q && blockedAhead(g, bot)) bot.repath = 0;
  if (!q && bot.repath <= 0) {
    const grid = buildGrid(g, 0.45, bot === g.tapeBot, bot);
    const cover = viewCover(g);
    for (truck of trucks.sort((a, b) => Math.hypot(bot.x - a.fl.x, bot.y - a.fl.y) - Math.hypot(bot.x - b.fl.x, bot.y - b.fl.y))) {
      const circles = circlesOf(truck), centre = toWorld(truck.fl, -0.7, 0);
      const previous = bot.lastView;
      const score = (x, y, cost) => {
        const p = { x, y };
        if (previous && Math.hypot(x - previous.x, y - previous.y) < 1) return Infinity;
        const gap = Math.min(...circles.map((c) => Math.hypot(x - c.x, y - c.y) - c.r - BOT_R));
        if (gap < 2.5 || !viewingSpot(g, bot, p, truck)) return Infinity;
        return (peeking(p, centre, cover) ? 0 : 1000)
          + cost * 10 + Math.abs(gap - FOLLOW_GAP) * 0.05;
      };
      bot.path = plan(grid, bot, 80, score);
      let end = bot.path.at(-1) || bot;
      if (!bot.path.length) {
        const { i, j } = cellOf(grid, bot), p = { x: (i + 0.5) * CELL, y: (j + 0.5) * CELL };
        if (!grid.blocked[j * grid.nx + i] && Number.isFinite(score(p.x, p.y, 0))
            && (!Number.isFinite(score(end.x, end.y, 0)) || (peeking(p, centre, cover) && !peeking(end, centre, cover)))) {
          bot.path = [p]; end = p;
        }
      }
      if (Number.isFinite(score(end.x, end.y, 0))) {
        q = bot.curiosity = { x: end.x, y: end.y, truck: truck.id, left: null };
        break;
      }
      bot.path = [];
    }
    bot.repath = q ? KEEP_ROUTE : REPLAN;
  }
  if (!q) return;
  if (bot.repath <= 0 && !bot.passing) {
    bot.path = plan(buildGrid(g, 0.45, bot === g.tapeBot, bot), bot, 80, (x, y, cost) => Math.hypot(x - q.x, y - q.y) * 10 + cost * 0.02);
    bot.repath = bot.path.length ? KEEP_ROUTE : REPLAN;
  }
  bot.goal = { x: q.x, y: q.y };
  followPath(g, bot, speed * dt, dt);
  if (bot.path.length || bot.passing || bot.yieldPath?.length) return;
  if (Math.hypot(bot.x - q.x, bot.y - q.y) > 0.15) {
    if (bot.repath > REPLAN) bot.repath = REPLAN;
    return;
  }
  if (!truck || !viewingSpot(g, bot, bot, truck)) { bot.curiosity = null; bot.repath = 0; return; }
  const aim = toWorld(truck.fl, -0.7, 0);
  if (Math.abs(turnAfterPath(bot, Math.atan2(aim.y - bot.y, aim.x - bot.x), dt)) > 0.15) return;
  bot.observing = true;
  if (q.left === null) q.left = 5 + Math.random() * 10;
  else q.left -= dt;
  if (q.left <= 0) {
    bot.lastView = { x: q.x, y: q.y }; bot.curiosity = null; bot.repath = 0; bot.observing = false;
  }
}
