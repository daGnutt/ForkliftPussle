// Controller rumble: mixes short fading pulses (bonks, box damage, blocked forks) and steady layers (scraping, tyre slip,
// horn) into one strong/weak motor pair, and sends it to a gamepad with whichever haptics API
// it has: `vibrationActuator.playEffect('dual-rumble')` (Chromium, Safari) or else `hapticActuators[i].pulse()` (Firefox).
// DOM-free apart from the gamepad object passed in, so Node tests can drive it with fakes.
export const RUMBLE_REFRESH = 0.05; // s between re-sends while rumbling
export const RUMBLE_EFFECT_MS = 100; // each effect outlasts the refresh, so a lost frame does not leave a gap

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Feature switches (menu checkboxes): pulses bonk/damage/blocked, layers scrape/slip/horn.
export const RUMBLE_FEATURES = [
  ['bonk', 'Bumps'], ['damage', 'Box damage'], ['blocked', 'Blocked forks'], ['scrape', 'Scraping (sparks)'],
  ['slip', 'Wheel spin (tyre smoke)'], ['horn', 'Horn'],
];
// Output effects (menu drop-down). 'auto' = dual where available, else pulse.
export const RUMBLE_EFFECTS = [
  ['auto', 'Auto'], ['dual', 'Dual rumble (motors)'], ['trigger', 'Trigger rumble (motors + triggers)'],
  ['triggers', 'Triggers only'], ['pulse', 'Haptic pulse (Firefox)'],
];
export const RUMBLE_STRENGTH = 0.5; // default overall strength

// Effects the pad can play, as RUMBLE_EFFECTS ids (without 'auto').
export function rumbleSupport(gp) {
  const out = [], va = gp?.vibrationActuator;
  if (va?.playEffect) {
    if (!va.effects || va.effects.includes('dual-rumble')) out.push('dual');
    if (va.effects?.includes('trigger-rumble')) out.push('trigger', 'triggers');
  }
  if (gp?.hapticActuators?.length && gp.hapticActuators[0]?.pulse) out.push('pulse');
  return out;
}

// Sends one effect with the chosen `effect` (RUMBLE_EFFECTS id); returns the effect used or null when the pad can't play it.
export function sendRumble(gp, strong, weak, ms = RUMBLE_EFFECT_MS, effect = 'auto') {
  ms = Math.max(1, ms);
  const can = rumbleSupport(gp);
  const use = effect === 'auto' ? can.find((e) => e === 'dual' || e === 'pulse') : can.includes(effect) ? effect : null;
  const quiet = (p) => p?.catch?.(() => {});
  try {
    if (use === 'dual') quiet(gp.vibrationActuator.playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: strong, weakMagnitude: weak }));
    else if (use === 'trigger' || use === 'triggers') {
      const t = Math.max(strong, weak), motors = use === 'trigger';
      quiet(gp.vibrationActuator.playEffect('trigger-rumble', { startDelay: 0, duration: ms, strongMagnitude: motors ? strong : 0, weakMagnitude: motors ? weak : 0, leftTrigger: t, rightTrigger: t }));
    } else if (use === 'pulse') {
      const ha = gp.hapticActuators;
      if (ha.length >= 2 && ha[1]?.pulse) { quiet(ha[0].pulse(strong, ms)); quiet(ha[1].pulse(weak, ms)); }
      else quiet(ha[0].pulse(Math.max(strong, weak * 0.6), ms));
    }
  } catch { return null; /* haptics are best effort */ }
  return use ?? null;
}

export function createRumble() {
  let pulses = []; // { strong, weak, t, dur }: fade linearly to 0 over dur seconds
  const layers = new Map(); // name -> { strong, weak }
  let sinceSend = Infinity, sent = { strong: 0, weak: 0 };
  const off = new Set(); // disabled RUMBLE_FEATURES ids
  const r = {
    strength: RUMBLE_STRENGTH, // 0..1, scales the whole mix
    effect: 'auto', // RUMBLE_EFFECTS id
    setFeature(name, on) { if (on) off.delete(name); else { off.add(name); layers.delete(name); } },
    feature: (name) => !off.has(name),
    pulse(name, strong, weak, dur) { if (!off.has(name)) pulses.push({ strong, weak, t: 0, dur }); },
    set(name, strong = 0, weak = 0) { if (!off.has(name) && (strong > 0 || weak > 0)) layers.set(name, { strong, weak }); else layers.delete(name); },
    clear() { pulses = []; layers.clear(); },
    // The current motor mix after ageing the pulses by dt seconds.
    mix(dt = 0) {
      let strong = 0, weak = 0;
      for (const p of pulses) p.t += dt;
      pulses = pulses.filter((p) => p.t < p.dur);
      for (const p of pulses) { const k = 1 - p.t / p.dur; strong = Math.max(strong, p.strong * k); weak = Math.max(weak, p.weak * k); }
      for (const l of layers.values()) { strong += l.strong; weak += l.weak; }
      return { strong: clamp01(strong) * r.strength, weak: clamp01(weak) * r.strength };
    },
    // Steady layers from the own truck: scraping a wall (sparks), tyre slip (smoke) and the held horn (`horn`).
    feedTruck(t) {
      r.set('scrape', t.scrape > 0 ? 0.08 : 0, t.scrape > 0 ? Math.min(0.5, 0.2 + 0.1 * t.scrape) : 0);
      const slip = (t.slip || 0) > 0.05 ? clamp01(t.slip) : 0;
      r.set('slip', 0.1 * slip, 0.35 * slip);
      r.set('horn', t.horn ? 0.15 : 0, t.horn ? 0.45 : 0);
    },
    // One frame: mixes and (throttled) sends to gp. When disabled or without a pad, everything is dropped and a running
    // effect is stopped once. Returns the mix.
    frame(dt, gp, enabled = true) {
      if (!enabled || !gp) {
        pulses = []; layers.clear();
        if ((sent.strong || sent.weak) && gp) sendRumble(gp, 0, 0, 0, r.effect);
        sent = { strong: 0, weak: 0 }; sinceSend = Infinity;
        return { strong: 0, weak: 0 };
      }
      const m = r.mix(dt);
      sinceSend += dt;
      const on = m.strong > 0.01 || m.weak > 0.01;
      const wasOn = sent.strong > 0 || sent.weak > 0;
      const changed = Math.abs(m.strong - sent.strong) > 0.05 || Math.abs(m.weak - sent.weak) > 0.05;
      if (on ? sinceSend >= RUMBLE_REFRESH || (changed && sinceSend >= RUMBLE_REFRESH / 2) : wasOn) {
        sendRumble(gp, on ? m.strong : 0, on ? m.weak : 0, on ? RUMBLE_EFFECT_MS : 0, r.effect);
        sent = on ? m : { strong: 0, weak: 0 };
        sinceSend = 0;
      }
      return m;
    },
  };
  return r;
}
