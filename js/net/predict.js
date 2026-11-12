// Client-side prediction for a guest: the guest's own truck is simulated locally with the same rules as the host, so driving
// feels instant whatever the ping. Everything else (other trucks, stacks, forks) still comes from the host. Each snapshot
// carries the host's version of the truck; it is compared with what the prediction was one round trip ago and the difference
// is blended away (or snapped when it is large, e.g. after a collision with another truck).
import { newGame, update, forkUp, forkDown, forkDownAll } from '../game.js';
import { newEndless } from '../endless.js';

const STEP = 1 / 120;
const HISTORY = 2; // seconds of predicted states kept for comparing with snapshots
const GAIN = 0.2; // share of the error removed per snapshot
const SNAP_DIST = 2; // tiles; a bigger error replaces the prediction outright
const PUSH_MEMORY = 0.5; // seconds a stack keeps the guest's own (predicted) push before the host's position is trusted again
const MAX_STACK_DIFF = 0.6; // tiles; a predicted stack further off than this from the host's is not shown

const AUX = ['carried', 'carriedRel', 'carriedRots', 'carriedPen', 'carriedOffs', 'bonks', 'bonkPower', 'bonkAt', 'scrape', 'wallPush', 'contact', 'slip', 'H', 'hf', 'ef', 'revTime', 'rv', 'hitAt'];
const SHOWN = ['carried', 'carriedRel', 'carriedRots', 'carriedPen', 'carriedOffs', 'H', 'hf', 'ef', 'rv']; // what is displayed while a fork action is unconfirmed
const CONFIRM_SLACK = 0.3; // seconds after one round trip before the host's fork state is trusted over the predicted one

const wrap = (a) => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

export function createPredictor() {
  let sim = null, pred = null, hist = [], acc = 0, movedAt = [], forkAt = -Infinity, confirmWindow = 0.4;
  const pending = (now) => now - forkAt < confirmWindow;

  const nearest = (t) => {
    let best = null;
    for (const h of hist) if (!best || Math.abs(h.t - t) < Math.abs(best.t - t)) best = h;
    return best;
  };

  // Mirrors what the host sent that the guest does not simulate itself: the other trucks. The guest's own truck keeps its predicted fork state.
  function syncWorld(g) {
    const self = g.self, mine = sim.trucks[self];
    sim.trucks = g.trucks.map((t, i) => {
      if (i === self) return mine;
      const c = structuredClone({ ...t, fl: undefined });
      c.fl = { ...t.fl, speed: 0, brake: true };
      c.input = {};
      return c;
    });
    sim.ghostPairs = g.ghostPairs;
    sim.started = g.started;
    sim.status = g.status;
    sim.hits = [];
    if (g.endless) { sim.walls = g.walls; sim.pillars = g.pillars; } // the moving trucks and gates of the endless warehouse
  }

  return {
    get ready() { return !!pred; },
    reset(g) {
      sim = g.endless ? newEndless(g.seed, g.hard) : newGame(g.level, g.seed, g.hard);
      sim.self = g.self;
      sim.stacks = structuredClone(g.stacks);
      sim.trucks = structuredClone(g.trucks);
      pred = sim.trucks[g.self].fl;
      hist = []; acc = 0; movedAt = []; forkAt = -Infinity;
    },
    // A snapshot arrived at `now`; `rtt` is the measured round trip in seconds.
    onSnapshot(snap, now, rtt) {
      if (!sim || !pred) return;
      confirmWindow = rtt + CONFIRM_SLACK;
      const authTruck = snap.trucks[sim.self];
      const auth = authTruck?.fl;
      if (!auth) return;
      const mine = sim.trucks[sim.self];
      if (!pending(now) && (authTruck.H !== mine.H || JSON.stringify(authTruck.carried) !== JSON.stringify(mine.carried))) {
        for (const k of AUX) mine[k] = structuredClone(authTruck[k]);
      }
      const past = nearest(now - rtt);
      if (!past || Math.hypot(auth.x - past.x, auth.y - past.y) > SNAP_DIST) {
        Object.assign(pred, auth);
        hist = [];
      } else {
        const dx = (auth.x - past.x) * GAIN, dy = (auth.y - past.y) * GAIN, da = wrap(auth.a - past.a) * GAIN, dv = (auth.speed - past.speed) * GAIN;
        pred.x += dx; pred.y += dy; pred.a += da; pred.speed += dv;
        for (const h of hist) { h.x += dx; h.y += dy; h.a += da; h.speed += dv; }
      }
      const s = snap.stacks;
      if (!s || pending(now)) return;
      if (s.length !== sim.stacks.length || s.some((x, i) => x.layers.length !== sim.stacks[i].layers.length)) {
        sim.stacks = structuredClone(s);
        movedAt = [];
      } else {
        s.forEach((x, i) => { if (now - (movedAt[i] ?? -Infinity) > PUSH_MEMORY) { sim.stacks[i].x = x.x; sim.stacks[i].y = x.y; } });
      }
    },
    // A fork action was sent to the host: it is applied to the prediction at once and shown until the host confirms it.
    fork(dir, now) {
      if (!sim || !pred) return;
      forkAt = now;
      return (dir === 'up' ? forkUp : dir === 'downAll' ? forkDownAll : forkDown)(sim);
    },
    // Advances the prediction by `dt` seconds of real time with the held keys; `g` is the interpolated host game.
    step(g, input, dt, now) {
      if (!sim || !pred || g.status !== 'play') return;
      syncWorld(g);
      acc = Math.min(acc + dt, 0.1);
      while (acc >= STEP) {
        const before = sim.stacks.map((s) => [s.x, s.y]);
        update(sim, input, STEP);
        sim.stacks.forEach((s, i) => { if (before[i] && (s.x !== before[i][0] || s.y !== before[i][1])) movedAt[i] = now; });
        acc -= STEP;
      }
      pred = sim.trucks[sim.self].fl;
      hist.push({ t: now, x: pred.x, y: pred.y, a: pred.a, speed: pred.speed });
      while (hist.length && hist[0].t < now - HISTORY) hist.shift();
    },
    // Replaces the guest's own truck (and stacks it is pushing) in the displayed game `g` with the predicted ones.
    apply(g, now) {
      if (!sim || !pred) return;
      const f = g.trucks[g.self]?.fl;
      if (!f) return;
      Object.assign(f, pred);
      if (pending(now)) {
        const mine = sim.trucks[sim.self];
        for (const k of SHOWN) g.trucks[g.self][k] = mine[k];
        g.stacks = sim.stacks;
        return;
      }
      g.stacks = g.stacks.map((s, i) => {
        const p = sim.stacks[i];
        if (!p || p.layers.length !== s.layers.length || now - (movedAt[i] ?? -Infinity) > PUSH_MEMORY) return s;
        return Math.hypot(p.x - s.x, p.y - s.y) > MAX_STACK_DIFF ? s : { ...s, x: p.x, y: p.y };
      });
    },
  };
}
