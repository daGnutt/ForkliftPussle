import { toWorld } from '../forklift.js';
import { rectPoly, sat } from '../geom.js';
import { BOT_R, SPEED, WORK_SPEED, botHome, zoneMarkKey, areaMarkKey, zonesInArea } from './common.js';
import { currentInspection } from './inspector.js';
import { stepWorker } from './worker.js';
import { startSpawn, startDespawn, stepSeq, registerCommit } from './spawn.js';

export const TAPE_BOT_PARTS = [
  [0, -0.16, 0.28, 0.04, 0.03, 0.18, '#303538'],
  [0, 0.16, 0.28, 0.04, 0.03, 0.18, '#303538'],
  [0, 0, 0.21, 0.15, 0.12, 1.12, '#e8eae6'],
  [0, -0.15, 0.20, 0.012, 0.14, 1.1, '#e3b82a'],
  [0, 0.15, 0.20, 0.012, 0.14, 1.1, '#e3b82a'],
  [-0.215, 0, 0.012, 0.13, 0.17, 1.0, '#363b3e'],
  [0, 0, 0.16, 0.14, 1.12, 1.35, '#e8eae6'],
  [0.16, 0, 0.02, 0.13, 1.16, 1.31, '#172126'],
  [0.182, 0, 0.005, 0.07, 1.22, 1.25, '#42d8f4', true],
  [-0.08, -0.12, 0.012, 0.012, 1.32, 1.55, '#343b3e'],
  [-0.08, 0.12, 0.012, 0.012, 1.32, 1.55, '#343b3e'],
];

export function makeTapeBot(g) {
  if (!g.hatch) return null;
  const home = botHome(g.hatch);
  return { x: home.x, y: home.y, a: g.hatch.a, show: 0, mode: 'hidden', state: 'loiter', path: [], repath: 0 };
}

export const tapeDeploying = (bot) => bot?.tapeJob?.phase === 'draw' && bot.state !== 'flee';

export function tapeCorners(t) {
  const walls = t.wallSides || [];
  const x0 = walls[3] == null ? t.x - 0.3 : walls[3] + 0.08;
  const x1 = walls[1] == null ? t.x + t.w + 0.3 : walls[1] - 0.08;
  const y0 = walls[0] == null ? t.y - 0.3 : walls[0] + 0.08;
  const y1 = walls[2] == null ? t.y + t.h + 0.3 : walls[2] - 0.08;
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

export function tapeSegment(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  return len < 1e-6 ? null : rectPoly((a.x + b.x) / 2, (a.y + b.y) / 2, len / 2, 0.025, Math.atan2(dy, dx));
}

export function tapeWallSides(g, t) {
  const sides = [null, null, null, null], clearance = 0.45;
  const set = (i, face, gap) => {
    if (gap < 0 || gap >= clearance) return;
    if (sides[i] === null || (i === 0 || i === 3 ? face > sides[i] : face < sides[i])) sides[i] = face;
  };
  for (const w of g.walls) {
    if (w.x < t.x + t.w && w.x + w.w > t.x) {
      set(0, w.y + w.h, t.y - w.y - w.h);
      set(2, w.y, w.y - t.y - t.h);
    }
    if (w.y < t.y + t.h && w.y + w.h > t.y) {
      set(1, w.x, w.x - t.x - t.w);
      set(3, w.x + w.w, t.x - w.x - w.w);
    }
  }
  return sides;
}

export function initTape(t, g) {
  if (!Array.isArray(t.posts)) t.posts = [true, true, true, true];
  if (!Array.isArray(t.edges)) t.edges = Array(4).fill(!t.broken);
  t.wallSides = tapeWallSides(g, t);
  for (let i = 0; i < 4; i++) if (t.wallSides[i] !== null) t.edges[i] = false;
}

export const tapeComplete = (t) => t.posts.every(Boolean) && t.edges.every((edge, i) => edge || t.wallSides[i] !== null);
export const touching = (poly, shapes) => poly && shapes.some((shape) => sat(poly, shape));
export const POST_R = 0.08;
export const postPoly = (p) => rectPoly(p.x, p.y, POST_R, POST_R);

// Tape and posts are deliberately breakable rather than solid obstacles.
export function stepTapeCollisions(g, shapes) {
  for (const t of g.tapes || []) {
    initTape(t, g);
    const corners = tapeCorners(t);
    for (let i = 0; i < 4; i++) {
      if (t.posts[i] && touching(postPoly(corners[i]), shapes)) {
        t.posts[i] = false;
        t.edges[i] = false;
        t.edges[(i + 3) % 4] = false;
      }
    }
    for (let i = 0; i < 4; i++) {
      if (t.edges[i] && touching(tapeSegment(corners[i], corners[(i + 1) % 4]), shapes)) t.edges[i] = false;
    }
    t.broken = !tapeComplete(t);
  }
  const job = g.tapeBot?.tapeJob;
  const t = job && g.tapes.find((q) => q.key === job.key);
  if (job?.phase === 'draw' && t) {
    const end = toWorld(g.tapeBot, -0.25, 0);
    if (!t.posts[job.from] || touching(tapeSegment(tapeCorners(t)[job.from], end), shapes)) job.phase = 'start';
  }
}

export function trailingTape(g) {
  const b = g.tapeBot, job = b?.tapeJob;
  const t = tapeDeploying(b) && (g.tapes || []).find((q) => q.key === job.key);
  return t && t.posts?.[job.from] ? [tapeCorners(t)[job.from], toWorld(b, -0.25, 0)] : null;
}

export function tapeLines(g) {
  const lines = [];
  for (const t of g.tapes || []) {
    const corners = tapeCorners(t);
    for (let i = 0; i < 4; i++) if (t.edges ? t.edges[i] : !t.broken) lines.push([corners[i], corners[(i + 1) % 4]]);
  }
  const trailing = trailingTape(g);
  if (trailing) lines.push(trailing);
  return lines;
}

// Posts are spawned and removed by the bot itself (see spawn.js); this applies the result to the tape.
registerCommit('post', (g, bot, s, phase) => {
  const d = s.data, tape = g.tapes.find((t) => t.key === d.key);
  if (!tape) return;
  if (phase === 'despawn') {
    tape.posts[d.from] = false;
    tape.edges[d.from] = false;
    tape.edges[(d.from + 3) % 4] = false;
    tape.broken = !tapeComplete(tape);
    bot.tapeJob = null;
    if (!tape.posts.some(Boolean)) g.tapes = g.tapes.filter((t) => t !== tape);
    return;
  }
  if (d.mode === 'start') {
    tape.posts[d.from] = true;
    if (bot.tapeJob?.key === d.key) bot.tapeJob.phase = 'draw';
    return;
  }
  tape.posts[d.mode === 'end' ? d.to : d.from] = true;
  if (d.mode === 'end') tape.edges[d.edge] = true;
  tape.broken = !tapeComplete(tape);
  bot.tapeJob = null;
});

export function stepTapeBot(g, dt, doneZones, stackAt, wonky, shapes = []) {
  const bot = g.tapeBot;
  if (!bot) return;
  if (stepSeq(g, bot, dt)) return;
  g.tapes ||= [];
  const liveAreas = new Map(g.areas.map((a) => [areaMarkKey(a), a]));
  g.tapes = g.tapes.filter((t) => liveAreas.has(t.key));
  for (const tape of g.tapes) {
    initTape(tape, g);
  }
  const jobs = [], done = new Set(doneZones.map(zoneMarkKey));
  for (const [key, area] of liveAreas) {
    const tape = g.tapes.find((t) => t.key === key), zones = zonesInArea(g, area);
    const valid = zones.length > 0 && zones.every((z) => done.has(zoneMarkKey(z)) && stackAt(z));
    const reports = valid ? zones.map((z) => currentInspection(g, z, stackAt(z))) : [];
    if (tape && (!valid || reports.some((p) => p?.ok === false))) jobs.push({ key, area, action: 'remove' });
    else if (valid && reports.every((p) => p?.ok === true)) {
      if (tape?.broken) jobs.push({ key, area, action: 'repair' });
      else if (!tape) jobs.push({ key, area, action: 'install' });
    }
  }
  const currentKey = bot.workKey || bot.tapeJob?.key;
  const job = jobs.find((j) => j.key === currentKey) || jobs.reduce((best, j) => {
    const d = Math.hypot(j.area.x + j.area.w / 2 - bot.x, j.area.y + j.area.h / 2 - bot.y);
    return !best || d < best.d ? { job: j, d } : best;
  }, null)?.job;
  if (!job) { bot.tapeJob = null; bot.workKey = null; bot.debugTask = null; stepWorker(g, bot, dt, false, null, null); return; }
  bot.workKey = job.key;
  bot.debugTask = `${job.action === 'remove' ? 'removing tape from' : 'taping'} zone ${g.areas.indexOf(job.area) + 1}`;
  let tape = g.tapes.find((t) => t.key === job.key);
  if (job.action === 'remove') {
    const task = bot.tapeJob;
    let post = task?.phase === 'remove' && task.key === job.key && tape.posts[task.from] ? task.from : tape.posts.findIndex(Boolean);
    if (post < 0) { g.tapes = g.tapes.filter((t) => t !== tape); bot.tapeJob = null; return; }
    bot.tapeJob = { key: job.key, edge: null, from: post, to: post, phase: 'remove' };
    const corners = tapeCorners(tape), corner = corners[post];
    const dx = corner.x - (tape.x + tape.w / 2), dy = corner.y - (tape.y + tape.h / 2), dist = Math.hypot(dx, dy) || 1;
    const goal = {
      x: Math.max(BOT_R + 0.1, Math.min(g.w - BOT_R - 0.1, corner.x + dx / dist * 0.55)),
      y: Math.max(BOT_R + 0.1, Math.min(g.h - BOT_R - 0.1, corner.y + dy / dist * 0.55)),
    };
    stepWorker(g, bot, dt, true, goal, `remove:${job.key}:${post}`);
    if (bot.state === 'flee' || bot.show !== 1 || Math.hypot(bot.x - goal.x, bot.y - goal.y) >= 0.35 || bot.path.length) return;
    startDespawn(bot, { commit: 'post', data: { key: job.key, from: post }, at: corner });
    return;
  }
  if (!tape) {
    tape = { key: job.key, color: job.area.color, x: job.area.x, y: job.area.y, w: job.area.w, h: job.area.h,
      sig: '', broken: true, posts: [false, false, false, false], edges: [false, false, false, false] }; // sig is retained for save compatibility
    initTape(tape, g);
    g.tapes.push(tape);
    stepWorker(g, bot, dt, true, tapeCorners(tape)[0], `${job.key}:start:0`);
    return;
  }
  const corners = tapeCorners(tape);
  let task = bot.tapeJob;
  if (!task || task.key !== job.key || (task.edge != null && (tape.edges[task.edge] || tape.wallSides[task.edge] !== null))) {
    const edge = tape.edges.findIndex((v, i) => !v && tape.wallSides[i] === null);
    if (edge < 0) {
      const post = tape.posts.findIndex((v) => !v);
      if (post < 0) { tape.broken = false; bot.tapeJob = null; return; }
      task = bot.tapeJob = { key: job.key, edge: null, from: post, to: post, phase: 'post' };
    } else {
      const from = tape.posts[edge] ? edge : tape.posts[(edge + 1) % 4] ? (edge + 1) % 4 : edge;
      const to = from === edge ? (edge + 1) % 4 : edge;
      task = bot.tapeJob = { key: job.key, edge, from, to, phase: 'start' };
    }
  }
  const index = task.phase === 'start' || task.phase === 'post' ? task.from : task.to;
  const corner = corners[index];
  // A missing post is spawned under the bot, so it stands on the corner itself; an existing post is approached from outside.
  const exists = tape.posts[index], dx = corner.x - (tape.x + tape.w / 2), dy = corner.y - (tape.y + tape.h / 2), dist = Math.hypot(dx, dy) || 1;
  const lim = (v, max) => Math.max(BOT_R + 0.1, Math.min(max - BOT_R - 0.1, v));
  const goal = { x: lim(corner.x + (exists ? dx / dist * 0.55 : 0), g.w), y: lim(corner.y + (exists ? dy / dist * 0.55 : 0), g.h) };
  stepWorker(g, bot, dt, true, goal, `${job.key}:${task.phase}:${index}`);
  if (bot.state === 'flee') { if (task.edge != null) task.phase = 'start'; return; }
  // Something (e.g. a cone) can keep the bot off a corner; after standing still for a second it settles for a spot beside it.
  const still = bot.still?.x === bot.x && bot.still?.y === bot.y ? bot.still.t + dt : 0;
  bot.still = { x: bot.x, y: bot.y, t: still };
  const reach = exists ? 0.35 : still > 1 ? 0.75 : 0.2;
  if (bot.show !== 1 || Math.hypot(bot.x - goal.x, bot.y - goal.y) >= reach || bot.path.length) return;
  if (touching(postPoly(corner), shapes)) return;
  const spawn = (mode) => startSpawn(bot, { at: corner, size: POST_R * 2, commit: 'post', speed: tapeDeploying(bot) ? WORK_SPEED : SPEED,
    data: { key: job.key, mode, from: task.from, to: task.to, edge: task.edge } });
  if (task.phase === 'post') spawn('post');
  else if (task.phase === 'start') { if (exists) task.phase = 'draw'; else spawn('start'); }
  else if (tape.posts[task.from] && !touching(tapeSegment(corners[task.from], corner), shapes)) {
    if (!exists) spawn('end');
    else {
      tape.edges[task.edge] = true;
      tape.broken = !tapeComplete(tape);
      bot.tapeJob = null;
    }
  }
}
