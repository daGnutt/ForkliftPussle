// Wire format and state sync of a party. The host runs the simulation and sends snapshots; guests send their inputs.
//
//   guest -> host (reliable): { t: 'hello', name } | { t: 'in', up, down, left, right, horn } | { t: 'fork', dir: 'up' | 'down' } | { t: 'gping', n } (answered with { t: 'gpong', n }; the guest's round-trip measurement)
//   host -> guest (reliable): { t: 'welcome', slot, started, ...level } | { t: 'level', ...level } | { t: 'bye' }
//     where level = { level, seed, hard, seedText, snap } (snap is a full snapshot)
//   host -> guest (fast):     { t: 'snap', ...snapshot }
import { makeTruck } from '../game.js';

const TRUCK_FIELDS = ['id', 'color', 'name', 'gone', 'fl', 'carried', 'carriedRel', 'carriedRots', 'carriedPen', 'carriedOffs', 'bonks', 'bonkPower', 'bonkAt', 'scrape', 'contact', 'slip', 'H', 'hf', 'ef', 'rv', 'hitAt', 'horn'];
export const SNAPSHOT_HZ = 30;
const STACK_RESEND = 5; // snapshots are unreliable, so changed stacks are repeated this many times
const STACK_REFRESH = 2; // seconds between full stack refreshes while nothing changes

// Compact JSON: numbers are rounded to 1/10000.
export const encode = (msg) => JSON.stringify(msg, (k, v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v));

// Plain-data snapshot of the whole game state a guest needs; `stacks` is left out when `withStacks` is false.
export function snapshot(g, withStacks = true) {
  const r = g.root;
  const s = {
    trucks: r.trucks.map((t) => Object.fromEntries(TRUCK_FIELDS.map((k) => [k, t[k]]))),
    ghostPairs: r.ghostPairs,
    hits: r.hits.map(({ owner, ...h }) => h),
    hitCount: r.hitCount,
    status: r.status, time: r.time, started: r.started, clock: r.clock,
  };
  if (withStacks) s.stacks = r.stacks;
  return s;
}

// Decides when the host sends the stacks: when they changed (a few times, since packets can be lost) and every STACK_REFRESH seconds.
export function createSnapshotter() {
  let last = '', left = 0, lastAt = -Infinity;
  return {
    reset() { last = ''; left = 0; lastAt = -Infinity; },
    next(g, now) {
      const cur = encode(g.root.stacks);
      if (cur !== last) { last = cur; left = STACK_RESEND; }
      const withStacks = left > 0 || now - lastAt >= STACK_REFRESH;
      if (left > 0) left--;
      if (withStacks) lastAt = now;
      return { t: 'snap', ...snapshot(g, withStacks) };
    },
  };
}

// Copies a snapshot into a (guest) game. The level layout is the same; only dynamic state is replaced.
export function applySnapshot(g, s) {
  s.trucks.forEach((d, i) => {
    const t = g.trucks[i] || (g.trucks[i] = makeTruck(g.start, i));
    Object.assign(t, d);
    t.fl = { ...d.fl };
  });
  g.trucks.length = s.trucks.length;
  if (s.stacks) g.stacks = s.stacks;
  Object.assign(g, { ghostPairs: s.ghostPairs, hits: s.hits, hitCount: s.hitCount, status: s.status, time: s.time, started: s.started, clock: s.clock });
}

const lerp = (a, b, k) => a + (b - a) * k;
const lerpAngle = (a, b, k) => a + (((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI) * k;

// Guests render slightly in the past, blending between the two snapshots around that time.
export function createInterpolator(delay = 0.1) {
  let buf = [], stacks = null;
  return {
    reset() { buf = []; stacks = null; },
    get ready() { return buf.length > 0; },
    push(snap, now) {
      if (snap.stacks) stacks = snap.stacks; else snap.stacks = stacks;
      buf.push({ t: now, snap });
      if (buf.length > 40) buf.shift();
    },
    // Writes the state for time `now` into `g`; false until something has arrived.
    apply(g, now) {
      if (!buf.length) return false;
      const rt = now - delay;
      let i = buf.length - 1;
      while (i > 0 && buf[i].t > rt) i--;
      const a = buf[i], b = buf[i + 1];
      applySnapshot(g, a.snap);
      if (b && rt > a.t) {
        const k = Math.min(1, (rt - a.t) / Math.max(1e-3, b.t - a.t));
        g.trucks.forEach((t, j) => {
          const u = b.snap.trucks[j];
          if (!u || u.gone || t.gone) return;
          const f = t.fl, v = u.fl;
          f.x = lerp(f.x, v.x, k); f.y = lerp(f.y, v.y, k); f.a = lerpAngle(f.a, v.a, k);
          f.speed = lerp(f.speed, v.speed, k); f.steer = lerp(f.steer, v.steer, k);
          t.hf = lerp(t.hf, u.hf, k); t.ef = lerp(t.ef, u.ef, k);
        });
        const sa = a.snap.stacks, sb = b.snap.stacks;
        if (sa && sb && sa.length === sb.length) {
          g.stacks = sa.map((s, j) => (sb[j].layers.length === s.layers.length ? { ...s, x: lerp(s.x, sb[j].x, k), y: lerp(s.y, sb[j].y, k) } : s));
        }
      }
      while (buf.length > 2 && buf[1].t <= rt) buf.shift();
      return true;
    },
  };
}
