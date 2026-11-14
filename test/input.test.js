import assert from 'node:assert/strict';

// Minimal browser stubs so js/input.js loads in Node
const stub = () => ({ addEventListener() {}, querySelectorAll: () => [], getElementById: () => null });
globalThis.document = stub();
globalThis.window = stub();
let pad = null;
Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => [pad] }, configurable: true });
const { createInput } = await import('../js/input.js');

import { drive } from '../js/forklift.js';
const mkPad = ({ axes = [0, 0, 0, 0], pressed = [] } = {}) => ({
  connected: true, mapping: 'standard', axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })),
});

// Gamepad drives, steers and fires one-shot actions on the press edge
{
  const calls = [];
  let blocked = false;
  const inp = createInput({ up: () => calls.push('up'), menuNav: (d) => calls.push(d), menuSelect: () => calls.push('select'), menuBack: () => calls.push('back'), menuToggle: () => calls.push('menu'), blocked: () => blocked });
  pad = mkPad({ axes: [0.8, 0, 0, 0], pressed: [7] });
  let s = inp.state();
  assert.ok(s.up && s.right && !s.left && !s.down);
  pad = mkPad({ pressed: [1] });
  inp.state(); inp.state();
  assert.deepEqual(calls, ['up'], 'B fires fork up once per press');
  pad = mkPad({ axes: [0, -1, 0, 0] });
  assert.ok(!inp.state().up, 'the stick does not drive');
  pad = mkPad({ pressed: [9] });
  inp.state();
  assert.deepEqual(calls, ['up', 'menu']);
  blocked = true;
  pad = mkPad({ pressed: [7] });
  assert.ok(!inp.state().up, 'no driving while the menu is open');
  pad = mkPad({ pressed: [13] }); inp.state();
  pad = mkPad({ pressed: [0] }); inp.state();
  pad = mkPad({ pressed: [1] }); inp.state();
  assert.deepEqual(calls.slice(2), ['down', 'select', 'back'], 'd-pad navigates, A selects, B goes back in the menu');
  pad = null;
  assert.ok(!inp.state().up, 'unplugging releases the controls');
}

// Analog trigger and stick scale acceleration and steering
{
  const inp = createInput({ blocked: () => false });
  pad = mkPad({ axes: [0.56, 0, 0, 0] });
  pad.buttons[7] = { pressed: true, value: 0.5 };
  const s = inp.state();
  assert.equal(s.thr, 0.5);
  assert.ok(s.str > 0.4 && s.str < 0.6 && s.right);
  const mk = () => ({ x: 0, y: 0, a: 0, speed: 0, steer: 0, gear: 'D' });
  const half = mk(), full = mk();
  drive(half, { thr: 0.5, str: 0 }, 0.5);
  drive(full, { up: true }, 0.5);
  assert.ok(Math.abs(half.speed * 2 - full.speed) < 0.1 * full.speed, 'half throttle accelerates about half as fast');
  const st = mk();
  for (let i = 0; i < 100; i++) drive(st, { str: 0.5 }, 0.02);
  const stFull = mk();
  for (let i = 0; i < 100; i++) drive(stFull, { right: true }, 0.02);
  assert.ok(st.steer > 0 && st.steer < stFull.steer, 'half stick steers less than full');
}
console.log('input tests passed');
