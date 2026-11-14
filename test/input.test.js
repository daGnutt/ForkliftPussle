import assert from 'node:assert/strict';

// Minimal browser stubs so js/input.js loads in Node
const stub = () => ({ addEventListener() {}, querySelectorAll: () => [], getElementById: () => null });
globalThis.document = stub();
globalThis.window = stub();
let pad = null;
Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => [pad] }, configurable: true });
const { createInput } = await import('../js/input.js');

const mkPad = ({ axes = [0, 0, 0, 0], pressed = [] } = {}) => ({
  connected: true, mapping: 'standard', axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })),
});

// Gamepad drives, steers and fires one-shot actions on the press edge
{
  const calls = [];
  let blocked = false;
  const inp = createInput({ up: () => calls.push('up'), menuToggle: () => calls.push('menu'), blocked: () => blocked });
  pad = mkPad({ axes: [0.8, 0, 0, 0], pressed: [7] });
  let s = inp.state();
  assert.ok(s.up && s.right && !s.left && !s.down);
  pad = mkPad({ pressed: [0] });
  inp.state(); inp.state();
  assert.deepEqual(calls, ['up'], 'A fires fork up once per press');
  pad = mkPad({ pressed: [9] });
  inp.state();
  assert.deepEqual(calls, ['up', 'menu']);
  blocked = true;
  pad = mkPad({ axes: [0, -1, 0, 0] });
  s = inp.state();
  assert.ok(!s.up, 'no driving while the menu is open');
  pad = null;
  assert.ok(!inp.state().up, 'unplugging releases the controls');
}
console.log('input tests passed');
