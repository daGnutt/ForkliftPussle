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
  pad = mkPad({ pressed: [0] });
  inp.state(); inp.state();
  assert.deepEqual(calls, ['up'], 'A fires fork up once per press');
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

// Local multiplayer: gamepads join with A, each drives its own truck, level reloads keep them, unplugging removes the truck
{
  const { createLocal } = await import('../js/local.js');
  const { newGame, update } = await import('../js/game.js');
  const mk = (index, pressed = [], thr = 0) => {
    const p = mkPad({ pressed });
    p.index = index;
    if (thr) p.buttons[7] = { pressed: true, value: thr };
    return p;
  };
  let pads = [];
  Object.defineProperty(globalThis.navigator, 'getGamepads', { value: () => pads, configurable: true });
  let g = newGame(1, 1, false);
  const local = createLocal();
  pads = [mk(0), mk(1), mk(2), mk(3)];
  local.step(g, 0);
  pads = [mk(0, [0]), mk(1, [0]), mk(2, [0]), mk(3, [0])];
  local.step(g, 0.1);
  assert.equal(local.players, 3, 'at most three pads join besides the keyboard player');
  assert.deepEqual(local.slots(), [1, 2, 3]);
  assert.equal(g.trucks.length, 4);
  pads = [mk(0, [], 1), mk(1), mk(2), mk(3)];
  local.step(g, 0.2);
  for (let i = 0; i < 120; i++) update(g, {}, 1 / 120);
  assert.ok(g.trucks[1].fl.speed > 0, 'pad 0 drives truck 1');
  assert.equal(g.trucks[2].fl.speed, 0, 'idle pads do not move their trucks');
  assert.equal(g.trucks[0].fl.speed, 0, 'the keyboard truck is not driven by pads');
  g = newGame(2, 1, false);
  local.levelLoaded(g);
  assert.deepEqual(g.trucks.map((t) => !t.gone), [true, true, true, true], 'a new level keeps every local player');
  pads = [mk(0), mk(1), mk(3)];
  local.step(g, 1);
  assert.ok(g.trucks[3].gone && !g.trucks[2].gone && local.players === 2, 'unplugging removes the truck');
}
console.log('input tests passed');

// Keyboard schemes: WASD drives, Q/E work the forks, comma/period look; arrows always work
{
  const listeners = {};
  globalThis.window = { addEventListener: (t, f) => { (listeners[t] ??= []).push(f); } };
  const { createInput: mk } = await import('../js/input.js?keys');
  const calls = [];
  const inp = mk({ up: () => calls.push('up'), down: () => calls.push('down') });
  const key = (type, code) => listeners[type].forEach((f) => f({ code, repeat: false, preventDefault() {}, target: null }));
  key('keydown', 'KeyW');
  assert.ok(!inp.state().up, 'W does not drive in the arrows scheme');
  assert.ok(inp.state().lookL, 'W looks left in the arrows scheme');
  key('keyup', 'KeyW');
  inp.setScheme('wasd');
  key('keydown', 'KeyW'); key('keydown', 'KeyD');
  let s = inp.state();
  assert.ok(s.up && s.right && !s.lookL, 'W/D drive and steer in the WASD scheme');
  key('keyup', 'KeyW'); key('keyup', 'KeyD');
  key('keydown', 'KeyQ'); key('keydown', 'KeyE');
  assert.deepEqual(calls, ['up', 'down'], 'Q raises and E lowers the forks');
  key('keydown', 'Comma');
  assert.ok(inp.state().lookL, 'comma looks left');
  key('keydown', 'ArrowUp');
  assert.ok(inp.state().up, 'arrow keys still drive');
  globalThis.window = stub();
}

// First run: the first drive key picks the scheme
for (const [code, want] of [['KeyS', 'wasd'], ['ArrowLeft', 'arrows']]) {
  const listeners = {};
  globalThis.window = { addEventListener: (t, f) => { (listeners[t] ??= []).push(f); } };
  const { createInput: mk } = await import('../js/input.js?detect' + code);
  let picked = null;
  const inp = mk({ schemeDetected: (n) => { picked = n; inp.setScheme(n); } });
  inp.setAutoDetect(true);
  const key = (c) => listeners.keydown.forEach((f) => f({ code: c, repeat: false, preventDefault() {}, target: null }));
  key(code); key('KeyW');
  assert.equal(picked, want, `${code} selects ${want}`);
  globalThis.window = stub();
}

// Touch joystick: analog throttle/steering from the knob offset (dead zone 0.3 rescaled)
{
  const listeners = {};
  const stickEl = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    querySelector: () => ({ style: {} }), classList: { add() {}, remove() {} },
    addEventListener(t, f) { (listeners[t] ??= []).push(f); },
  };
  globalThis.document = { querySelectorAll: () => [], getElementById: (id) => (id === 'stick' ? stickEl : null), addEventListener() {} };
  globalThis.window = { addEventListener() {} };
  const { createInput: mk } = await import('../js/input.js?stick');
  const inp = mk({});
  const ev = (type, x, y) => listeners[type].forEach((f) => f({ pointerType: 'mouse', pointerId: 1, clientX: x, clientY: y, preventDefault() {} }));
  ev('pointerdown', 50, 50);
  ev('pointermove', 50 + 25, 50); // dx/R = 0.5
  let s = inp.state();
  assert.ok(Math.abs(s.str - 0.2 / 0.7) < 0.03 && s.thr === 0, 'half deflection steers partially');
  ev('pointermove', 50, 50 - 50); // full forward
  s = inp.state();
  assert.equal(s.thr, 1);
  ev('pointermove', 100, 0); // corner: both axes full at once
  s = inp.state();
  assert.ok(s.thr === 1 && s.str === 1, 'the square corner gives full throttle and full steering');
  ev('pointermove', 50, 50 + 10); // inside the dead zone
  assert.equal(inp.state().thr, 0);
  ev('pointerup', 0, 0);
  globalThis.document = stub();
  globalThis.window = stub();
}
