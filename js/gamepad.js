// Shared gamepad reading (standard mapping): the analog drive/steer values, used by input.js (the keyboard player's pad) and local.js (local players).
export const STICK_DEAD = 0.12, TRIG_DEAD = 0.05;

// Connected standard-mapping pads as [{ index, gp }], in slot order.
export function standardPads() {
  const out = [];
  for (const gp of navigator.getGamepads?.() ?? []) if (gp?.connected && gp.mapping === 'standard') out.push({ index: gp.index, gp });
  return out;
}

const trig = (gp, i) => { const v = gp.buttons[i]?.value || (gp.buttons[i]?.pressed ? 1 : 0); return v > TRIG_DEAD ? v : 0; };

// thr: right trigger minus left trigger; str: left stick X with the dead zone rescaled so it starts from 0 (both -1..1).
export function padAxes(gp) {
  const lx = gp.axes[0] ?? 0;
  return {
    thr: trig(gp, 7) - trig(gp, 6),
    str: Math.abs(lx) > STICK_DEAD ? Math.sign(lx) * (Math.abs(lx) - STICK_DEAD) / (1 - STICK_DEAD) : 0,
  };
}
