// Controller rumble: mixes short fading pulses (bonks, box damage, blocked forks) and steady layers (acceleration, braking,
// fork movement, scraping, tyre slip) into one strong/weak motor pair, and sends it to a gamepad with whichever haptics API
// it has: `vibrationActuator.playEffect('dual-rumble')` (Chromium, Safari) or else `hapticActuators[i].pulse()` (Firefox).
// DOM-free apart from the gamepad object passed in, so Node tests can drive it with fakes.
export const RUMBLE_REFRESH = 0.05; // s between re-sends while rumbling
export const RUMBLE_EFFECT_MS = 100; // each effect outlasts the refresh, so a lost frame does not leave a gap
const ACC_REF = 3.2; // tiles/s², the forklift's full-throttle acceleration (forklift.js ACC)
const FORK_REF = 2; // box heights/s of fork travel that gives the full fork hum

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Sends one effect; returns the API used ('dual', 'pulse') or null when the pad has no haptics.
export function sendRumble(gp, strong, weak, ms = RUMBLE_EFFECT_MS) {
  ms = Math.max(1, ms);
  const va = gp?.vibrationActuator;
  try {
    if (va?.playEffect && (!va.effects || va.effects.includes('dual-rumble'))) {
      va.playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: strong, weakMagnitude: weak })?.catch?.(() => {});
      return 'dual';
    }
    const ha = gp?.hapticActuators;
    if (ha?.length && ha[0]?.pulse) {
      if (ha.length >= 2 && ha[1]?.pulse) { ha[0].pulse(strong, ms)?.catch?.(() => {}); ha[1].pulse(weak, ms)?.catch?.(() => {}); }
      else ha[0].pulse(Math.max(strong, weak * 0.6), ms)?.catch?.(() => {});
      return 'pulse';
    }
  } catch { /* haptics are best effort */ }
  return null;
}

export function createRumble() {
  let pulses = []; // { strong, weak, t, dur }: fade linearly to 0 over dur seconds
  const layers = new Map(); // name -> { strong, weak }
  let sinceSend = Infinity, sent = { strong: 0, weak: 0 };
  let feed = null; // previous truck sample for feedTruck
  const r = {
    pulse(strong, weak, dur) { pulses.push({ strong, weak, t: 0, dur }); },
    set(name, strong = 0, weak = 0) { if (strong > 0 || weak > 0) layers.set(name, { strong, weak }); else layers.delete(name); },
    clear() { pulses = []; layers.clear(); feed = null; },
    // The current motor mix after ageing the pulses by dt seconds.
    mix(dt = 0) {
      let strong = 0, weak = 0;
      for (const p of pulses) p.t += dt;
      pulses = pulses.filter((p) => p.t < p.dur);
      for (const p of pulses) { const k = 1 - p.t / p.dur; strong = Math.max(strong, p.strong * k); weak = Math.max(weak, p.weak * k); }
      for (const l of layers.values()) { strong += l.strong; weak += l.weak; }
      return { strong: clamp01(strong), weak: clamp01(weak) };
    },
    // Steady layers from the own truck's motion: speeding up and slowing down (fade at a steady speed), fork travel
    // (the smoothed height `hf`, so easy-mode steps give a short hum and hard-mode holds a continuous one),
    // scraping a wall (sparks) and tyre slip (smoke).
    feedTruck(t, dt) {
      const v = Math.abs(t.fl.speed), hf = t.hf ?? t.H ?? 0;
      if (!feed || feed.t !== t || dt <= 0) { feed = { t, v, hf, a: 0 }; return; }
      const a = (v - feed.v) / dt / ACC_REF;
      feed.a += (a - feed.a) * Math.min(1, dt * 15);
      const fork = Math.abs(hf - feed.hf) / dt / FORK_REF;
      feed.v = v; feed.hf = hf;
      r.set('accel', 0, feed.a > 0.1 ? 0.2 * clamp01(feed.a) : 0);
      r.set('brake', feed.a < -0.1 ? 0.15 * clamp01(-feed.a) : 0, feed.a < -0.1 ? 0.1 * clamp01(-feed.a) : 0);
      r.set('fork', 0.05 * clamp01(fork), 0.25 * clamp01(fork));
      r.set('scrape', t.scrape > 0 ? 0.08 : 0, t.scrape > 0 ? Math.min(0.5, 0.2 + 0.1 * t.scrape) : 0);
      const slip = (t.slip || 0) > 0.05 ? clamp01(t.slip) : 0;
      r.set('slip', 0.1 * slip, 0.35 * slip);
    },
    // One frame: mixes and (throttled) sends to gp. When disabled or without a pad, everything is dropped and a running
    // effect is stopped once. Returns the mix.
    frame(dt, gp, enabled = true) {
      if (!enabled || !gp) {
        pulses = []; layers.clear(); feed = null;
        if ((sent.strong || sent.weak) && gp) sendRumble(gp, 0, 0, 0);
        sent = { strong: 0, weak: 0 }; sinceSend = Infinity;
        return { strong: 0, weak: 0 };
      }
      const m = r.mix(dt);
      sinceSend += dt;
      const on = m.strong > 0.01 || m.weak > 0.01;
      const wasOn = sent.strong > 0 || sent.weak > 0;
      const changed = Math.abs(m.strong - sent.strong) > 0.05 || Math.abs(m.weak - sent.weak) > 0.05;
      if (on ? sinceSend >= RUMBLE_REFRESH || (changed && sinceSend >= RUMBLE_REFRESH / 2) : wasOn) {
        sendRumble(gp, on ? m.strong : 0, on ? m.weak : 0, on ? RUMBLE_EFFECT_MS : 0);
        sent = on ? m : { strong: 0, weak: 0 };
        sinceSend = 0;
      }
      return m;
    },
  };
  return r;
}
