import { newGame, forkUp, forkDown } from './game.js';
import { rectPoly } from './geom.js';
import { FL } from './forklift.js';

// Scripted forklift for the GL splash diorama (pure, DOM-free). A small room has four pallet spots in a ring and three
// stacks; the forklift keeps moving the stack next to the empty spot into it (real `forkUp`/`forkDown`), so the stacks
// circle forever. The truck's pose follows Hermite paths: the front axle always moves along the heading, so the heading is
// the path tangent (reversed when backing up) and the steering angle follows from the path curvature.

export const ROOM = { w: 18, h: 10 };
const T = 3;
const SPOTS = [{ x: 4, y: 3, a: Math.PI }, { x: 14, y: 3, a: 0 }, { x: 14, y: 7, a: 0 }, { x: 4, y: 7, a: Math.PI }];
const ZONE_COLORS = [3, 4, 0, 1];
const OUT = 2.6; // tiles the truck backs away from a spot
const V_FWD = 3, V_APPROACH = 2.2, V_BACK = 1.8; // approximate peak speeds, tiles/s

const smooth = (x) => x * x * (3 - 2 * x);
const spotPose = (s) => ({ x: s.x - Math.cos(s.a) * FL.carryX, y: s.y - Math.sin(s.a) * FL.carryX, h: s.a });
const backed = (p, d = OUT) => ({ x: p.x - Math.cos(p.h) * d, y: p.y - Math.sin(p.h) * d, h: p.h });

// Hermite path p0 -> p1, driving forwards (dir 1) or backwards (dir -1); k scales the end tangents.
function leg(p0, p1, dir, vmax, k) {
  const m0 = [dir * Math.cos(p0.h) * k, dir * Math.sin(p0.h) * k], m1 = [dir * Math.cos(p1.h) * k, dir * Math.sin(p1.h) * k];
  const a = [p0.x, p0.y], b = [p1.x, p1.y];
  const eval_ = (t) => {
    const t2 = t * t, t3 = t2 * t;
    const c = [2 * t3 - 3 * t2 + 1, t3 - 2 * t2 + t, -2 * t3 + 3 * t2, t3 - t2];
    const d1 = [6 * t2 - 6 * t, 3 * t2 - 4 * t + 1, -6 * t2 + 6 * t, 3 * t2 - 2 * t];
    const d2 = [12 * t - 6, 6 * t - 4, -12 * t + 6, 6 * t - 2];
    const at = (w, i) => w[0] * a[i] + w[1] * m0[i] + w[2] * b[i] + w[3] * m1[i];
    return { x: at(c, 0), y: at(c, 1), dx: at(d1, 0), dy: at(d1, 1), ddx: at(d2, 0), ddy: at(d2, 1) };
  };
  const N = 64, cum = [0];
  let prev = eval_(0);
  for (let i = 1; i <= N; i++) {
    const q = eval_(i / N);
    cum.push(cum[i - 1] + Math.hypot(q.x - prev.x, q.y - prev.y));
    prev = q;
  }
  const len = cum[N];
  const tAt = (sigma) => {
    const target = sigma * len;
    let lo = 0, hi = N;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= target) lo = mid; else hi = mid; }
    return (lo + (cum[hi] > cum[lo] ? (target - cum[lo]) / (cum[hi] - cum[lo]) : 0)) / N;
  };
  const at = (sigma) => {
    const e = eval_(tAt(sigma)), v = Math.hypot(e.dx, e.dy) || 1;
    return { x: e.x, y: e.y, h: Math.atan2(e.dy, e.dx) + (dir < 0 ? Math.PI : 0), kappa: (e.dx * e.ddy - e.dy * e.ddx) / (v * v * v) };
  };
  return { type: 'leg', dir, len, dur: Math.max(0.5, (1.5 * len) / vmax), at };
}

// Forward drive between two poses; a U-turn gets a via point beside the chord (towards the room's middle) so the path loops.
function drive(p0, p1, vmax) {
  const turn = Math.abs(Math.atan2(Math.sin(p1.h - p0.h), Math.cos(p1.h - p0.h)));
  const chord = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (turn < 2.2 || chord < 1) return [leg(p0, p1, 1, vmax, chord * 1.2 + 1.5)];
  const ux = (p1.x - p0.x) / chord, uy = (p1.y - p0.y) / chord;
  let nx = -uy, ny = ux;
  const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
  if (nx * (ROOM.w / 2 - mx) + ny * (ROOM.h / 2 - my) < 0) { nx = -nx; ny = -ny; }
  const off = 4;
  const via = { x: mx + nx * off, y: my + ny * off, h: Math.atan2(uy, ux) };
  const k = chord * 0.7 + 3.5;
  return [leg(p0, via, 1, vmax, k), leg(via, p1, 1, vmax, k)];
}

export function createDemo() {
  const g = newGame(1);
  const wall = (x, y, w, h) => ({ x, y, w, h, poly: rectPoly(x + w / 2, y + h / 2, w / 2, h / 2) });
  g.w = ROOM.w;
  g.h = ROOM.h;
  g.walls = [wall(-T, -T, ROOM.w + 2 * T, T), wall(-T, ROOM.h, ROOM.w + 2 * T, T), wall(-T, 0, T, ROOM.h), wall(ROOM.w, 0, T, ROOM.h)];
  g.pillars = [];
  g.charger = null;
  g.areas = [];
  g.bays = [];
  g.doors = [];
  g.level = 1;
  g.seed = 0;
  g.zones = SPOTS.map((s, i) => ({ x: s.x, y: s.y, color: ZONE_COLORS[i], count: 1 }));
  g.stacks = [{ x: SPOTS[1].x, y: SPOTS[1].y, layers: [0, 0] }, { x: SPOTS[2].x, y: SPOTS[2].y, layers: [2] }, { x: SPOTS[3].x, y: SPOTS[3].y, layers: [3, 3, 3] }];
  g.parking = { x: ROOM.w / 2, y: ROOM.h - 1.2, a: 0 };
  const start = { x: ROOM.w / 2, y: ROOM.h / 2, h: 0 };
  Object.assign(g.fl, { x: start.x, y: start.y, a: start.h, speed: 0, steer: 0 });

  const q = [];
  let empty = 0, cur = start;
  const wait = (t) => q.push({ type: 'wait', dur: t });
  const act = (fn) => q.push({ type: 'act', fn });
  function plan() {
    const src = (empty + 1) % 4, from = spotPose(SPOTS[src]), to = spotPose(SPOTS[empty]);
    q.push(...drive(cur, from, V_APPROACH));
    wait(0.5);
    act(() => forkUp(g));
    wait(1);
    q.push(leg(from, backed(from), -1, V_BACK, OUT));
    q.push(...drive(backed(from), to, V_FWD));
    wait(0.5);
    act(() => forkDown(g));
    wait(1);
    q.push(leg(to, backed(to), -1, V_BACK, OUT));
    cur = backed(to);
    empty = src;
  }

  let el = 0;
  function apply(t, x) {
    const f = g.fl, s = smooth(x);
    if (t.type === 'wait') { f.speed = 0; f.brake = false; return; }
    const p = t.at(s);
    f.x = p.x; f.y = p.y; f.a = p.h;
    f.speed = t.dir * ((t.len * 6 * x * (1 - x)) / t.dur);
    f.steer = Math.atan(t.dir * FL.L * p.kappa);
    f.gear = t.dir < 0 ? 'R' : 'D';
    f.brake = x > 0.8;
  }

  function step(dt) {
    g.clock += dt;
    let rest = dt;
    for (;;) {
      if (!q.length) plan();
      const t = q[0];
      if (t.type === 'act') { t.fn(); q.shift(); continue; }
      el += rest;
      rest = 0;
      apply(t, Math.min(1, el / t.dur));
      if (el < t.dur) break;
      rest = el - t.dur;
      el = 0;
      q.shift();
    }
    g.hf += Math.max(-6 * dt, Math.min(6 * dt, g.H - g.hf));
    g.ef += (g.hf - g.ef) * (1 - Math.exp(-dt / 0.22));
    // a released stack is drawn lowering with the forks until they reach it; without this it keeps following them up
    for (const s of g.stacks) if (s.dropFrom != null && (g.hf <= s.dropFrom + 1e-3 || g.H > s.dropFrom)) delete s.dropFrom;
  }
  return { g, step };
}
