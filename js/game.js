import { rectPoly, sat } from './geom.js';
import { FL, makeForklift, drive, toWorld, toLocal } from './forklift.js';
import { generateLevel } from './level.js';

const FORKLIFT_MASS = 6;
const MAX_LAYERS = 5;

export function newGame(levelNumber) {
  const lvl = generateLevel(levelNumber);
  const walls = [];
  const T = 3;
  const add = (x, y, w, h) => walls.push({ x, y, w, h, poly: rectPoly(x + w / 2, y + h / 2, w / 2, h / 2) });
  add(-T, -T, lvl.w + 2 * T, T);
  add(-T, lvl.h, lvl.w + 2 * T, T);
  add(-T, 0, T, lvl.h);
  add(lvl.w, 0, T, lvl.h);
  for (const r of lvl.walls) add(r.x, r.y, r.w, r.h);
  return {
    level: levelNumber,
    w: lvl.w,
    h: lvl.h,
    walls,
    pillars: lvl.walls,
    zones: lvl.zones,
    areas: lvl.areas,
    stacks: lvl.stacks.map((s) => ({ x: s.x, y: s.y, layers: [...s.layers], rots: s.layers.map(() => 0), a: 0 })),
    fl: makeForklift(lvl.start.x, lvl.start.y, lvl.start.a),
    carried: null,
    carriedRel: 0,
    carriedRots: [],
    H: 0,
    hf: 0,
    status: 'play',
    time: 0,
  };
}

const stackPoly = (s) => rectPoly(s.x, s.y, 0.5, 0.5, s.a || 0);

function forkShapes(g) {
  const f = g.fl;
  const mk = (lx, ly, hx, hy, stackFilter) => {
    const c = toWorld(f, lx, ly);
    return { poly: rectPoly(c.x, c.y, hx, hy, f.a), stackFilter };
  };
  const shapes = [
    mk((FL.back + FL.front) / 2, 0, (FL.front - FL.back) / 2, FL.halfW, () => true),
  ];
  const tx = (FL.tineX0 + FL.tineX1) / 2, thx = (FL.tineX1 - FL.tineX0) / 2;
  if (g.carried) {
    const c = toWorld(f, FL.carryX, 0);
    shapes.push({ poly: rectPoly(c.x, c.y, 0.5, 0.5, f.a + g.carriedRel), stackFilter: (s) => s.layers.length > g.H });
  }
  shapes.push(mk(tx, -FL.tineOff, thx, FL.tineHalf, null));
  shapes.push(mk(tx, FL.tineOff, thx, FL.tineHalf, null));
  return shapes;
}

function shiftPoly(poly, dx, dy) {
  for (const p of poly) { p.x += dx; p.y += dy; }
}

function resolve(g) {
  const f = g.fl;
  for (let it = 0; it < 8; it++) {
    const shapes = forkShapes(g);
    const moveF = (dx, dy) => {
      f.x += dx; f.y += dy;
      for (const sh of shapes) shiftPoly(sh.poly, dx, dy);
    };

    for (const sh of shapes) {
      for (const w of g.walls) {
        const m = sat(sh.poly, w.poly);
        if (m) moveF(m.x * m.depth, m.y * m.depth);
      }
    }

    for (const s of g.stacks) {
      if (Math.abs(s.x - f.x) > 5 || Math.abs(s.y - f.y) > 5) continue;
      const mass = s.layers.length;
      const wf = 1 / FORKLIFT_MASS, ws = 1 / mass;
      for (const sh of shapes) {
        if (!sh.stackFilter || !sh.stackFilter(s)) continue;
        const m = sat(sh.poly, stackPoly(s));
        if (!m) continue;
        const d = m.depth * 1.001;
        moveF(m.x * d * (wf / (wf + ws)), m.y * d * (wf / (wf + ws)));
        s.x -= m.x * d * (ws / (wf + ws));
        s.y -= m.y * d * (ws / (wf + ws));
      }
    }

    for (const s of g.stacks) {
      for (const w of g.walls) {
        if (s.x + 0.71 < w.x || s.x - 0.71 > w.x + w.w || s.y + 0.71 < w.y || s.y - 0.71 > w.y + w.h) continue;
        const m = sat(stackPoly(s), w.poly);
        if (m) { s.x += m.x * m.depth; s.y += m.y * m.depth; }
      }
    }

    for (let i = 0; i < g.stacks.length; i++) {
      for (let j = i + 1; j < g.stacks.length; j++) {
        const a = g.stacks[i], b = g.stacks[j];
        if (Math.abs(a.x - b.x) >= 1.42 || Math.abs(a.y - b.y) >= 1.42) continue;
        const m = sat(stackPoly(a), stackPoly(b));
        if (!m) continue;
        const wa = 1 / a.layers.length, wb = 1 / b.layers.length;
        const d = m.depth * 1.001;
        a.x += m.x * d * (wa / (wa + wb)); a.y += m.y * d * (wa / (wa + wb));
        b.x -= m.x * d * (wb / (wa + wb)); b.y -= m.y * d * (wb / (wa + wb));
      }
    }
  }
}

export function update(g, input, dt) {
  const f = g.fl;
  g.time += dt;
  drive(f, input, dt);
  const driven = { x: f.x, y: f.y };
  const intended = f.speed * dt;
  resolve(g);

  if (Math.abs(intended) > 1e-6) {
    const actual = (f.x - driven.x) * Math.cos(f.a) + (f.y - driven.y) * Math.sin(f.a) + intended;
    const r = Math.max(0, Math.min(1, actual / intended));
    f.speed *= 1 - (1 - r) * Math.min(1, dt / 0.15);
  }

  g.hf += Math.max(-6 * dt, Math.min(6 * dt, g.H - g.hf));

  if (g.status === 'play' && isSolved(g)) g.status = 'won';
}

export function stackInZone(g) {
  const f = g.fl;
  let best = null, bd = Infinity;
  for (const s of g.stacks) {
    const l = toLocal(f, s.x, s.y);
    const dx = Math.abs(l.x - FL.carryX), dy = Math.abs(l.y);
    if (dx < 0.55 && dy < 0.5 && dx + dy < bd) { best = s; bd = dx + dy; }
  }
  return best;
}

// Fork level H (0..5) is a whole number of box heights above the floor, so a
// stack on the floor spans heights 0..n (layer i is between i-1 and i). The
// tines at level H are under the box at height H: raising the forks lifts
// every box at height H and above. Level 0 is the floor. Tines do not collide
// with boxes. A carried stack's bottom is at height H.
const MAX_H = 5;

export function forkUp(g) {
  if (g.carried) {
    g.H = Math.min(MAX_H, g.H + 1);
    return;
  }
  const S = stackInZone(g);
  if (S && S.layers.length > g.H) {
    g.carried = S.layers.splice(g.H);
    g.carriedRots = S.rots.splice(g.H).map((r) => r - g.fl.a);
    g.carriedRel = g.carriedRots[0];
    if (!S.layers.length) g.stacks.splice(g.stacks.indexOf(S), 1);
  }
  g.H = Math.min(MAX_H, g.H + 1);
}

export function forkDown(g) {
  if (!g.carried) {
    g.H = Math.max(0, g.H - 1);
    return;
  }
  const S = stackInZone(g);
  const n = S ? S.layers.length : 0;
  const minH = n + g.carried.length <= MAX_LAYERS ? n : n + 1;
  if (g.H > minH) g.H = Math.max(minH, g.H - 1);
  // Reaching the resting height puts the boxes down.
  if (g.H === n && minH === n) {
    if (S) {
      S.layers.push(...g.carried);
      S.rots.push(...g.carriedRots.map((r) => r + g.fl.a));
    } else {
      const p = toWorld(g.fl, FL.carryX, 0);
      g.stacks.push({ x: p.x, y: p.y, layers: g.carried, rots: g.carriedRots.map((r) => r + g.fl.a), a: g.fl.a + g.carriedRel });
    }
    g.carried = null;
    g.carriedRots = [];
  }
}

export function isSolved(g) {
  return g.zones.every((z) => zoneDone(g, z));
}

export function zoneDone(g, z) {
  return g.stacks.some(
    (s) =>
      Math.abs(s.x - z.x) < 0.5 &&
      Math.abs(s.y - z.y) < 0.5 &&
      s.layers.length === z.count &&
      s.layers.every((c) => c === z.color),
  );
}
