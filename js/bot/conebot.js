import { repairable } from '../repair.js';
import { BOX_HALF_X, halfY, zoneExt } from '../geom.js';
import { BOT_R, hash, botHome, place, rectDist, circlesOf, truckCircles, STACK_R, zoneMarkKey, zonesInArea, bots } from './common.js';
import { nearBox, buildGrid, plan, routeDistances, SKIP_SECS, REPLAN, skipped, preferLive } from './nav.js';
import { sightHits } from './loiter.js';
import { tapeCorners } from './tapebot.js';
import { stepWorker } from './worker.js';
import { startSpawn, startDespawn, stepSeq, registerCommit } from './spawn.js';

export function makeConeBot(g) {
  if (!g.hatch) return null;
  const home = botHome(g.hatch);
  return { x: home.x, y: home.y, a: g.hatch.a, show: 0, mode: 'hidden', state: 'loiter', task: null, path: [], repath: 0 };
}

// Shared cone-bot prisms: local centre, half sizes, height range, colour and optional emissive flag.
export const CONE_BOT_PARTS = [
  [0, 0, 0.34, 0.21, 0.10, 0.20, '#aeb4b6'],
  [0, 0, 0.32, 0.215, 0.10, 0.13, '#a62c2b'],
  [-0.17, 0, 0.17, 0.20, 0.20, 0.69, '#e3e5e2'],
  [-0.17, 0, 0.17, 0.205, 0.22, 0.26, '#ad3431'],
  [-0.17, 0, 0.15, 0.207, 0.49, 0.53, '#b33832'],
  [-0.17, 0, 0.17, 0.20, 0.66, 0.70, '#c6cbca'],
  [0.17, 0, 0.17, 0.19, 0.19, 0.58, '#b53630'],
  [0.17, 0, 0.16, 0.20, 0.53, 0.60, '#e4e6e2'],
  [0.17, 0, 0.11, 0.203, 0.33, 0.49, '#20292d'],
  [0.335, 0, 0.008, 0.155, 0.28, 0.52, '#172125'],
  [0.345, -0.075, 0.004, 0.038, 0.35, 0.44, '#ffb768', true],
  [0.345, 0.075, 0.004, 0.038, 0.35, 0.44, '#ffb768', true],
  [0.350, -0.075, 0.003, 0.021, 0.37, 0.425, '#252322'],
  [0.350, 0.075, 0.003, 0.021, 0.37, 0.425, '#252322'],
  [0.354, -0.08, 0.002, 0.007, 0.402, 0.417, '#fff3d4', true],
  [0.354, 0.07, 0.002, 0.007, 0.402, 0.417, '#fff3d4', true],
];
export const CONE_BOT_WHEELS = [[-0.20, -0.22], [-0.20, 0.22], [0.22, 0]];

// impact leaves one tipped or crushed for the cone bot to restore.
export function stepConeCollisions(g) {
  for (const cone of g.cones || []) {
    if (cone.squished) continue;
    for (const t of g.trucks) {
      if (t.gone) continue;
      for (const c of circlesOf(t)) {
        const dx = cone.x - c.x, dy = cone.y - c.y, d = Math.hypot(dx, dy), min = c.r + 0.13;
        if (d >= min) continue;
        const a = d > 1e-6 ? Math.atan2(dy, dx) : hash((cone.id || '').length + t.id * 17) * Math.PI * 2;
        cone.x = c.x + Math.cos(a) * min; cone.y = c.y + Math.sin(a) * min;
        if (Math.abs(t.fl.speed) > 2.6) cone.squished = true;
        else if (Math.abs(t.fl.speed) > 0.25) cone.tipped = true;
      }
    }
    for (const bot of bots(g)) {
      if (!bot.show) continue;
      if (bot === g.coneBot && cone.placedX != null && Math.hypot(cone.x - cone.placedX, cone.y - cone.placedY) < 0.22) continue;
      const dx = cone.x - bot.x, dy = cone.y - bot.y, d = Math.hypot(dx, dy), min = BOT_R * 0.8 + 0.13;
      if (d >= min) continue;
      const a = d > 1e-6 ? Math.atan2(dy, dx) : hash((cone.id || '').length + bot.x * 7 + bot.y * 11) * Math.PI * 2;
      cone.x = bot.x + Math.cos(a) * min;
      cone.y = bot.y + Math.sin(a) * min;
      cone.tipped = true;
    }
    for (const s of g.stacks) {
      const dx = cone.x - s.x, dy = cone.y - s.y, d = Math.hypot(dx, dy), min = STACK_R + 0.13;
      if (d >= min) continue;
      const a = d > 1e-6 ? Math.atan2(dy, dx) : 0;
      cone.x = s.x + Math.cos(a) * min; cone.y = s.y + Math.sin(a) * min;
      cone.tipped = true;
    }
    for (const w of g.walls) {
      const d = rectDist(cone.x, cone.y, w);
      if (d >= 0.13) continue;
      if (d > 1e-6) {
        const x = Math.max(w.x, Math.min(cone.x, w.x + w.w)), y = Math.max(w.y, Math.min(cone.y, w.y + w.h));
        cone.x = x + (cone.x - x) / d * 0.13; cone.y = y + (cone.y - y) / d * 0.13;
      } else {
        const sides = [[cone.x - w.x, -1, 0], [w.x + w.w - cone.x, 1, 0], [cone.y - w.y, 0, -1], [w.y + w.h - cone.y, 0, 1]].sort((a, b) => a[0] - b[0]);
        cone.x += sides[0][1] * (sides[0][0] + 0.13); cone.y += sides[0][2] * (sides[0][0] + 0.13);
      }
    }
  }
}
// reconciled against these stable IDs, so a moving truck naturally takes its markings with it.
export function coneTargets(g, doneZones, stackAt = (z) => g.stacks.find((s) => Math.hypot(s.x - z.x, s.y - z.y) < 0.5), markedZones = doneZones, onlyId = null) {
  const targets = new Map();
  const addTarget = (id, target) => { if (!onlyId || id === onlyId) targets.set(id, target); };
  const tapedAreas = (g.tapes || []).filter((t) => !t.broken).map((t) => {
    const corners = tapeCorners(t);
    return { x0: corners[0].x, x1: corners[1].x, y0: corners[0].y, y1: corners[2].y };
  });
  for (const spill of g.oil || []) {
    if (onlyId && !onlyId.startsWith(`spill:${spill.id}:`)) continue;
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      const id = `spill:${spill.id}:${i}`;
      addTarget(id, { id, x: spill.x + Math.cos(a) * (spill.r + 0.35), y: spill.y + Math.sin(a) * (spill.r + 0.35) });
    }
  }
  for (const z of markedZones) {
    if (onlyId && !onlyId.startsWith(`stack:${zoneMarkKey(z)}:`)) continue;
    const stack = stackAt(z);
    if (!stack) continue;
    const angle = stack.rots?.[0] ?? stack.a ?? 0;
    const hx = BOX_HALF_X + 0.18, hy = halfY(stack.pen?.[0]) + 0.18;
    const neighbours = g.zones.filter((other) => other !== z);
    const add = (id, x, y) => {
      const d = Math.hypot(x - stack.x, y - stack.y) || 1, standR = STACK_R + BOT_R + 0.5;
      addTarget(id, { id, x, y, stackCenter: { x: stack.x, y: stack.y }, approach: { x: stack.x + (x - stack.x) / d * standR, y: stack.y + (y - stack.y) / d * standR } });
    };
    for (let i = 0; i < 4; i++) {
      const sx = i & 1 ? 1 : -1, sy = i & 2 ? 1 : -1;
      const x = stack.x + sx * hx * Math.cos(angle) - sy * hy * Math.sin(angle);
      const y = stack.y + sx * hx * Math.sin(angle) + sy * hy * Math.cos(angle);
      const nearNeighbourCorner = neighbours.some((other) => {
        const e = zoneExt(other);
        return [-1, 1].some((dx) => [-1, 1].some((dy) =>
          Math.hypot(x - (other.x + dx * e.x), y - (other.y + dy * e.y)) < 0.5));
      });
      if (!nearNeighbourCorner) add(`stack:${zoneMarkKey(z)}:${i}`, x, y);
    }
  }
  // Toppled boxes and barrels, and the pallets they lost, are hazards on the floor: cone their corners until they are righted.
  const hazard = (id, x, y, angle, pen, stack) => {
    const hx = BOX_HALF_X + 0.18, hy = halfY(pen) + 0.18;
    for (let i = 0; i < 4; i++) {
      const sx = i & 1 ? 1 : -1, sy = i & 2 ? 1 : -1;
      const cx = x + sx * hx * Math.cos(angle) - sy * hy * Math.sin(angle), cy = y + sx * hx * Math.sin(angle) + sy * hy * Math.cos(angle);
      const d = Math.hypot(cx - x, cy - y) || 1, standR = STACK_R + BOT_R + 0.5;
      addTarget(`${id}:${i}`, { id: `${id}:${i}`, x: cx, y: cy, stackCenter: { x, y }, approach: { x: x + (cx - x) / d * standR, y: y + (cy - y) / d * standR } });
    }
  };
  for (const stack of g.stacks) {
    const pen = stack.pen?.[0];
    if (!pen || stack.roll || stack.fall) continue;
    const tipId = `tip:${stack.x.toFixed(1)},${stack.y.toFixed(1)}`;
    if (pen.tip && (!onlyId || onlyId.startsWith(`${tipId}:`))) hazard(tipId, stack.x, stack.y, stack.rots?.[0] ?? stack.a ?? 0, pen);
    const l = pen.loose;
    const palletId = l && `pallet:${l.x.toFixed(1)},${l.y.toFixed(1)}`;
    if (l && !l.lift && (!onlyId || onlyId.startsWith(`${palletId}:`))) hazard(palletId, l.x, l.y, l.a, pen);
  }
  const unique = [];
  for (const target of targets.values()) {
    if (tapedAreas.some((a) => target.x >= a.x0 && target.x <= a.x1 && target.y >= a.y0 && target.y <= a.y1)) continue;
    if (!unique.some((o) => Math.hypot(o.x - target.x, o.y - target.y) < 0.16)) unique.push(target);
  }
  return unique;
}

export function coneWorkKey(target) {
  const i = target.id.lastIndexOf(':');
  return i < 0 ? target.id : target.id.slice(0, i);
}

export const CONE_RETRY_SECS = 10, CONE_PLAN_SECS = 3, CONE_R = 0.13;
export function clearConeSpot(g, p, ignored, trucks = truckCircles(g)) {
  return p.x >= CONE_R && p.y >= CONE_R && p.x <= g.w - CONE_R && p.y <= g.h - CONE_R
    && !g.walls.some((w) => rectDist(p.x, p.y, w) < CONE_R)
    && !g.stacks.some((s) => Math.hypot(p.x - s.x, p.y - s.y) < STACK_R + CONE_R || nearBox(s, p.x, p.y, CONE_R))
    && !trucks.some((c) => Math.hypot(p.x - c.x, p.y - c.y) < c.r + CONE_R)
    && !(g.cones || []).some((c) => c !== ignored && Math.hypot(p.x - c.x, p.y - c.y) < CONE_R * 2);
}

// The cone is spawned under the bot, so the bot drives to the reachable clear spot closest to the target and the cone appears there.
export function conePlacement(g, bot, target) {
  const grid = buildGrid(g, 0.45, false, bot);
  const trucks = truckCircles(g);
  const path = plan(grid, bot, 80, (x, y, cost) => clearConeSpot(g, { x, y }, null, trucks)
    ? Math.hypot(x - target.x, y - target.y) * 10 + cost * 0.02 : Infinity);
  const end = path.at(-1) || { x: bot.x, y: bot.y };
  if (bot.show !== 1) return null; // still in the hatch
  const clearLine = !g.walls.some((w) => sightHits(end, target, w.x + w.w / 2, w.y + w.h / 2, w.w / 2 + CONE_R, w.h / 2 + CONE_R));
  if (!clearConeSpot(g, end)) return null;
  return { goal: end, spot: end, misplaced: Math.hypot(end.x - target.x, end.y - target.y) >= 0.22 || !clearLine };
}

registerCommit('cone', (g, bot, s, phase) => {
  const d = s.data;
  if (phase === 'despawn') {
    const i = g.cones.findIndex((c) => c.id === d.id && Math.hypot(c.x - s.at.x, c.y - s.at.y) < 0.22);
    if (i >= 0) g.cones.splice(i, 1);
    return;
  }
  if (!clearConeSpot(g, s.at)) return;
  const old = d.old && g.cones.find((c) => c.id === d.old);
  if (old) old.retire = true;
  g.cones.push({ id: d.id, goalId: d.goalId, x: s.at.x, y: s.at.y, a: 0, tipped: false, squished: false,
    misplaced: d.misplaced, placedX: s.at.x, placedY: s.at.y, retryAt: d.misplaced ? g.clock + CONE_RETRY_SECS : 0 });
});

export function areaComplete(g, area, stackAt, doneZones, wonky) {
  const done = new Set(doneZones.map(zoneMarkKey));
  const zones = zonesInArea(g, area);
  return zones.length > 0 && zones.every((z) => {
    const s = stackAt(z);
    return done.has(zoneMarkKey(z)) && !!s && !wonky(s, z)
      && !s.pen?.some((p) => p?.crash > 0 && repairable(p));
  });
}

export function stepConeBot(g, dt, doneZones, stackAt) {
  const bot = g.coneBot;
  if (!bot) return;
  if (bot.carried) bot.carried = null;
  if (stepSeq(g, bot, dt)) return;
  g.cones ||= [];
  if (bot.state === 'flee') { stepWorker(g, bot, dt, false, null, null); return; }
  const approach = (t, cone = t) => {
    if (!t.stackCenter) return cone === t ? t : cone;
    const dx = cone.x - t.stackCenter.x, dy = cone.y - t.stackCenter.y, d = Math.hypot(dx, dy) || 1;
    if (d >= STACK_R + BOT_R + 0.5) return cone === t ? t.approach : cone;
    const r = STACK_R + BOT_R + 0.5;
    return { x: t.stackCenter.x + dx / d * r, y: t.stackCenter.y + dy / d * r };
  };
  const jobKey = (job) => job.type === 'retrieve' ? `cone:${job.item.id}` : `place:${job.item.id}`;
  const findJobs = () => {
    const seen = new Set(g.inspector?.seen || []);
    const targets = coneTargets(g, doneZones, stackAt, doneZones.filter((z) => seen.has(zoneMarkKey(z))));
    const byId = new Map(targets.map((t) => [t.id, t]));
    const good = new Set();
    const accepted = new Set();
    for (const c of g.cones) {
      const t = byId.get(c.goalId);
      if (t && c.misplaced && Math.hypot(c.x - t.x, c.y - t.y) < 0.22) c.misplaced = false;
      const unmoved = c.placedX == null || Math.hypot(c.x - c.placedX, c.y - c.placedY) < 0.22;
      if (t && !c.retire && !c.tipped && !c.squished && ((c.misplaced && unmoved) || Math.hypot(c.x - t.x, c.y - t.y) < 0.22) && !good.has(c.goalId)) {
        good.add(c.goalId); accepted.add(c);
      }
    }
    const invalid = g.cones.filter((c) => !accepted.has(c));
    const missing = targets.filter((t) => !good.has(t.id));
    const jobs = [
      ...invalid.map((cone) => {
        const target = byId.get(cone.goalId);
        return { type: 'retrieve', item: cone, key: coneWorkKey({ id: cone.goalId }), point: target ? approach(target, cone) : cone };
      }),
      ...missing.map((target) => ({ type: 'place', item: target, key: coneWorkKey(target), point: approach(target) })),
    ];
    if (!jobs.some((job) => !skipped(g, bot, jobKey(job)))) for (const cone of accepted) {
      if (cone.misplaced && (cone.retryAt ?? 0) <= g.clock) {
        const target = byId.get(cone.goalId);
        jobs.push({ type: 'improve', item: target, cone, key: coneWorkKey(target), point: approach(target) });
      }
    }
    return jobs;
  };
  if (!bot.task) {
    const jobs = preferLive(g, bot, findJobs(), jobKey);
    const current = jobs.filter((job) => job.key === bot.workKey);
    const pool = current.length ? current : jobs;
    let selected = pool[0];
    if (pool.length > 1) {
      const points = pool.map((job) => job.point), distances = routeDistances(buildGrid(g, 0.45, false, bot), bot, points);
      let best = Infinity;
      pool.forEach((job, i) => {
        const d = Number.isFinite(distances[i]) ? distances[i] : Math.hypot(points[i].x - bot.x, points[i].y - bot.y);
        if (d < best) { best = d; selected = job; }
      });
    }
    if (!selected) {
      bot.workKey = null; bot.debugTask = null;
      stepWorker(g, bot, dt, false, null, null);
      return;
    }
    if (bot.show !== 1) { stepWorker(g, bot, dt, true, null, null); return; }
    const placement = selected.type === 'retrieve' ? null : conePlacement(g, bot, selected.item);
    if (selected.cone && (!placement || Math.hypot(placement.spot.x - selected.cone.x, placement.spot.y - selected.cone.y) < CONE_R * 2
        || Math.hypot(placement.spot.x - selected.item.x, placement.spot.y - selected.item.y) >= Math.hypot(selected.cone.x - selected.item.x, selected.cone.y - selected.item.y) - 0.22)) {
      selected.cone.retryAt = g.clock + CONE_RETRY_SECS;
      stepWorker(g, bot, dt, false, null, null);
      return;
    }
    if (!placement && selected.type !== 'retrieve') {
      (bot.skip ||= {})[jobKey(selected)] = g.clock + SKIP_SECS;
      stepWorker(g, bot, dt, false, null, null);
      return;
    }
    bot.workKey = selected.key;
    bot.task = { type: selected.type, key: jobKey(selected), id: selected.item.id,
      target: { x: selected.item.x, y: selected.item.y },
      goal: { x: (placement?.goal || selected.point).x, y: (placement?.goal || selected.point).y },
      old: selected.cone?.id || null, misplaced: placement?.misplaced };
  }
  const task = bot.task;
  bot.debugTask = task.type === 'retrieve' ? 'retrieving cone' : 'placing cone';
  stepWorker(g, bot, dt, true, task.goal, task.key);
  if (bot.task !== task || bot.state === 'flee' || bot.show !== 1 || bot.path.length) return;
  const distance = Math.hypot(bot.x - task.goal.x, bot.y - task.goal.y);
  if (distance >= (task.type === 'retrieve' ? 0.7 : 0.2)) {
    if (task.type === 'retrieve' && bot.repath <= REPLAN) { (bot.skip ||= {})[task.key] = g.clock + SKIP_SECS; bot.task = null; }
    return;
  }
  const cone = task.type === 'retrieve' && g.cones.find((c) => c.id === task.id);
  const id = task.type === 'retrieve' ? cone?.goalId : task.id;
  const seen = new Set(g.inspector?.seen || []);
  const target = id && coneTargets(g, doneZones, stackAt, doneZones.filter((z) => seen.has(zoneMarkKey(z))), id)[0];
  const good = (c) => target && !c.retire && !c.tipped && !c.squished
    && ((c.misplaced && (c.placedX == null || Math.hypot(c.x - c.placedX, c.y - c.placedY) < 0.22))
      || Math.hypot(c.x - target.x, c.y - target.y) < 0.22);
  const firstGood = g.cones.find((c) => c.goalId === id && good(c));
  const valid = task.type === 'retrieve'
    ? cone && Math.hypot(cone.x - task.target.x, cone.y - task.target.y) < 0.22 && firstGood !== cone
    : target && Math.hypot(target.x - task.target.x, target.y - task.target.y) < 0.22
      && (task.type === 'improve' ? firstGood?.id === task.old : !firstGood);
  bot.task = null;
  if (!valid) return;
  if (task.type === 'retrieve') startDespawn(bot, { commit: 'cone', data: { id: task.id }, at: task.target });
  else if (clearConeSpot(g, task.goal)) {
    bot.coneSeq = (bot.coneSeq || 0) + 1;
    startSpawn(bot, { commit: 'cone', size: CONE_R * 2, at: task.goal,
      data: { id: `cone:${task.id}:${bot.coneSeq}`, goalId: task.id, old: task.old, misplaced: task.misplaced } });
  } else (bot.skip ||= {})[task.key] = g.clock + SKIP_SECS;
}
