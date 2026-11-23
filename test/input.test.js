import assert from 'node:assert/strict';

// Minimal browser stubs so js/input.js loads in Node
const stub = () => ({ addEventListener() {}, querySelectorAll: () => [], getElementById: () => null });
globalThis.document = stub();
globalThis.window = stub();
let pad = null;
Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => [pad] }, configurable: true });
const { createInput, createCameraPointerInput } = await import('../js/input.js');

import { drive } from '../js/forklift.js';
const mkPad = ({ axes = [0, 0, 0, 0], pressed = [] } = {}) => ({
  connected: true, mapping: 'standard', axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })),
});

// Camera gestures distinguish a tap from a drag, cancellation, and the two-finger horn.
{
  const listeners = {};
  const canvas = { addEventListener: (type, f) => { listeners[type] = f; } };
  const calls = [];
  const dragging = createCameraPointerInput(canvas, {
    allowed: (e) => !e.blocked,
    move: (dx, dy, e) => calls.push(['move', dx, dy, e.pointerType]),
    tap: (e) => calls.push(['tap', e.pointerType]),
  });
  const event = (type, id, x, y, extra = {}) => listeners[type]({ type, pointerId: id, pointerType: 'touch', clientX: x, clientY: y, ...extra });
  event('pointerdown', 1, 50, 50);
  event('pointermove', 1, 53, 50);
  event('pointerup', 1, 53, 50);
  assert.deepEqual(calls, [['tap', 'touch']], 'small movements still tap');
  calls.length = 0;
  event('pointerdown', 1, 50, 50);
  event('pointermove', 1, 60, 55);
  assert.equal(dragging(), true);
  event('pointerup', 1, 60, 55);
  assert.deepEqual(calls, [['move', 10, 5, 'touch']], 'a drag never taps');
  assert.equal(dragging(), false);
  calls.length = 0;
  event('pointerdown', 1, 50, 50);
  event('pointerdown', 2, 70, 50);
  event('pointerup', 1, 50, 50);
  event('pointerup', 2, 70, 50);
  event('pointerdown', 3, 50, 50);
  event('pointercancel', 3, 50, 50);
  event('pointerdown', 4, 50, 50, { blocked: true });
  event('pointerup', 4, 50, 50);
  assert.deepEqual(calls, [], 'multitouch, cancellation and excluded areas do not tap');
  event('pointerdown', 5, 50, 50, { pointerType: 'mouse' });
  event('pointerup', 5, 50, 50, { pointerType: 'mouse' });
  assert.deepEqual(calls, [['tap', 'mouse']], 'mouse clicks remain available for double-clicking');
}

// Gamepad drives, steers and fires one-shot actions on the press edge
{
  const calls = [];
  let blocked = false;
  const inp = createInput({ up: () => calls.push('up'), menuNav: (d) => calls.push(d), menuSelect: () => calls.push('select'), menuBack: () => calls.push('back'), menuToggle: () => calls.push('menu'), blocked: () => blocked });
  pad = mkPad({ axes: [0.8, 0, 0, 0], pressed: [7] });
  let s = inp.state();
  assert.ok(s.up && s.right && !s.left && !s.down && s.motionSource === 'gamepad');
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
  s = inp.state();
  assert.ok(!s.up && s.motionSource === 'gamepad', 'unplugging releases controls without changing the last motion source');
}

// D-pad selects GL camera modes and resets the active camera
{
  const calls = [];
  const inp = createInput({
    cameraOverview: () => calls.push('overview'),
    cameraCabin: () => calls.push('cabin'),
    cameraChase: () => calls.push('chase'),
    cameraReset: () => calls.push('reset'),
  });
  pad = mkPad({ pressed: [12] }); inp.state();
  pad = mkPad({ pressed: [14] }); inp.state();
  pad = mkPad({ pressed: [15] }); inp.state();
  pad = mkPad({ pressed: [13] }); inp.state();
  pad = mkPad({ pressed: [13] }); inp.state();
  pad = mkPad({ pressed: [11] }); inp.state();
  assert.deepEqual(calls, ['overview', 'cabin', 'chase', 'reset', 'reset'], 'd-pad down and right-stick click reset once per press');
  pad = null;
}

// Cabin steering follows the last driving or steering device, not controller connection.
{
  const listeners = {};
  globalThis.window = { addEventListener: (type, f) => { (listeners[type] ??= []).push(f); } };
  let blocked = false;
  const inp = createInput({ blocked: () => blocked });
  const key = (type, code) => listeners[type].forEach((f) => f({ code, repeat: false, preventDefault() {}, target: null }));
  pad = mkPad();
  assert.equal(inp.state().motionSource, 'keyboard', 'an idle connected controller does not change the default');
  pad = mkPad({ axes: [0, 0, 0.8, 0] });
  assert.equal(inp.state().motionSource, 'keyboard', 'camera look is not motion input');
  pad = mkPad({ axes: [0.8, 0, 0, 0] });
  assert.equal(inp.state().motionSource, 'gamepad', 'steering selects the controller');
  pad = mkPad();
  assert.equal(inp.state().motionSource, 'gamepad', 'releasing the stick retains the last source');
  key('keydown', 'ArrowUp');
  assert.equal(inp.state().motionSource, 'keyboard', 'keyboard motion wins with a controller connected');
  pad = mkPad({ pressed: [7] });
  assert.equal(inp.state().motionSource, 'gamepad', 'controller throttle switches back while a key remains held');
  key('keydown', 'ArrowLeft');
  assert.equal(inp.state().motionSource, 'keyboard', 'a new key press switches back even while the trigger is held');
  assert.equal(inp.state().motionSource, 'keyboard', 'unchanged controller input does not immediately switch back');
  pad = mkPad({ axes: [0.8, 0, 0, 0], pressed: [7] });
  assert.equal(inp.state().motionSource, 'gamepad', 'new steering movement switches back');
  key('keyup', 'ArrowUp'); key('keyup', 'ArrowLeft');
  key('keydown', 'KeyH');
  assert.equal(inp.state().motionSource, 'gamepad', 'non-motion keys do not switch the camera');
  blocked = true;
  key('keydown', 'ArrowRight');
  assert.equal(inp.state().motionSource, 'gamepad', 'menu navigation does not change the motion source');
  key('keyup', 'ArrowRight');
  blocked = false;
  inp.setLocalMode(true);
  key('keydown', 'ArrowRight');
  assert.equal(inp.state().motionSource, 'keyboard', 'local multiplayer pads do not override the keyboard truck');
  pad = null;
  globalThis.window = stub();
}

// Analog trigger and stick scale acceleration and steering
{
  const inp = createInput({ blocked: () => false });
  pad = mkPad({ axes: [0.56, 0, 0, 0] });
  pad.buttons[7] = { pressed: true, value: 0.5 };
  const s = inp.state();
  assert.equal(s.thr, 0.5);
  assert.ok(s.str > 0.4 && s.str < 0.6 && s.right);
  pad = mkPad({ axes: [0, 0, 0, -0.8] });
  assert.ok(inp.state().lookU && !inp.state().lookD, 'right stick up looks up');
  pad = mkPad({ axes: [0, 0, 0, 0.8] });
  assert.ok(inp.state().lookD && !inp.state().lookU, 'right stick down looks down');
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
  local.beginVote();
  assert.deepEqual(local.pollVote(g).ballots, [], 'buttons held when voting starts do not cast ballots');
  pads = [mk(0), mk(1), mk(2), mk(3)];
  local.pollVote(g);
  pads = [mk(0, [0]), mk(1, [1]), mk(2), mk(3)];
  assert.deepEqual(local.pollVote(g).ballots, [{ slot: 1, choice: 'yes' }, { slot: 2, choice: 'no' }], 'each joined controller casts its own ballot');
  assert.deepEqual(local.pollVote(g).ballots, [], 'held buttons do not vote repeatedly');
  pads = [mk(0), mk(1), mk(2), mk(3)];
  local.pollVote(g, false);
  pads = [mk(0, [0]), mk(1), mk(2), mk(3)];
  assert.deepEqual(local.pollVote(g, false).ballots, [], 'gameplay button presses do not cast ballots while the menu is closed');
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
  assert.equal(local.remove(g, 1), true, 'a vote can remove a joined controller');
  assert.equal(g.trucks[1].gone, true);
  local.step(g, 1.1);
  assert.equal(local.players, 1, 'a removed controller stays out until joining again');
  pads = [mk(0, [0]), mk(1), mk(3)];
  local.step(g, 1.2);
  assert.equal(local.players, 2, 'a removed local controller can join again');
  pads = [];
}
console.log('input tests passed');

// Keyboard schemes: WASD drives, Q/E work the forks, comma/period look; arrows only drive in the arrows scheme
{
  const listeners = {};
  globalThis.window = { addEventListener: (t, f) => { (listeners[t] ??= []).push(f); } };
  const { createInput: mk } = await import('../js/input.js?keys');
  const calls = [];
  const inp = mk({ up: () => calls.push('up'), down: () => calls.push('down') });
  const key = (type, code) => listeners[type].forEach((f) => f({ code, repeat: false, preventDefault() {}, target: null }));
  key('keydown', 'KeyW');
  assert.ok(!inp.state().up, 'W does not drive in the arrows scheme');
  assert.ok(!inp.state().lookL, 'W no longer looks left in the arrows scheme');
  key('keyup', 'KeyW');
  inp.setScheme('wasd');
  key('keydown', 'KeyW'); key('keydown', 'KeyD');
  let s = inp.state();
  assert.ok(s.up && s.right && !s.lookL, 'W/D drive and steer in the WASD scheme');
  key('keyup', 'KeyW'); key('keyup', 'KeyD');
  key('keydown', 'KeyE'); key('keydown', 'KeyQ');
  assert.deepEqual(calls, ['up', 'down'], 'E raises and Q lowers the forks');
  key('keydown', 'Comma');
  assert.ok(inp.state().lookL, 'comma looks left');
  key('keydown', 'ArrowUp');
  assert.ok(!inp.state().up, 'arrow keys do not drive in the WASD scheme');
  key('keyup', 'ArrowUp');
  inp.setScheme('arrows');
  key('keydown', 'ArrowUp');
  assert.ok(inp.state().up, 'arrow keys drive in the arrows scheme');
  globalThis.window = stub();
}

// Touch joystick: analog throttle/steering from the knob offset (dead zone 0.12 rescaled)
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
  assert.ok(Math.abs(s.str - 0.38 / 0.88) < 0.03 && s.thr === 0, 'half deflection steers partially');
  ev('pointermove', 50, 50 - 50); // full forward
  s = inp.state();
  assert.equal(s.thr, 1);
  ev('pointermove', 100, 0); // corner: both axes full at once
  s = inp.state();
  assert.ok(s.thr === 1 && s.str === 1, 'the square corner gives full throttle and full steering');
  ev('pointermove', 50, 50 + 4); // inside the dead zone
  assert.equal(inp.state().thr, 0);
  ev('pointerup', 0, 0);
  globalThis.document = stub();
  globalThis.window = stub();
}

// Joystick scheme: letting go of the stick brakes
{
  const stickEl = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    querySelector: () => ({ style: {} }), classList: { add() {}, remove() {} }, addEventListener() {},
  };
  globalThis.document = { querySelectorAll: () => [], getElementById: (id) => (id === 'stick' ? stickEl : null), addEventListener() {} };
  const { createInput: mk } = await import('../js/input.js?brake');
  assert.equal(mk({}).state().brake, true, 'untouched visible stick brakes');
  globalThis.document = stub();
  assert.equal(mk({}).state().brake, false, 'no stick (other schemes): coast as before');
  const f = { x: 0, y: 0, a: 0, speed: 3, steer: 0, brake: false, gear: 'D', roll: 0 };
  const g2 = { ...f };
  drive(f, { thr: 0, str: 0, brake: true }, 0.5);
  drive(g2, { thr: 0, str: 0 }, 0.5);
  assert.ok(f.speed < g2.speed && f.brake, 'braking slows faster than coasting and lights the brake lamps');
}

// Touch camera drag ignores the control zones (pad strip + fork gauge)
{
  const { inTouchControlZone: z } = await import('../js/input.js');
  assert.ok(z(400, 700, 800, 800, false), 'portrait: bottom 208px is a control zone');
  assert.ok(!z(400, 500, 800, 800, false), 'portrait: open area above it is free');
  assert.ok(z(400, 660, 900, 800, true), 'landscape: bottom 144px');
  assert.ok(!z(400, 640, 900, 800, true), 'landscape: free above 144px');
  assert.ok(z(850, 100, 900, 800, true), 'fork gauge column');
  assert.ok(!z(500, 100, 900, 800, true), 'free area beside the gauge');
}

// Phone vibration: the rumble mix goes to navigator.vibrate as buzz lengths; silent below a threshold, no-op without the API
{
  const { createRumble, vibrateSupported, vibrateMs } = await import('../js/rumble.js');
  const calls = [];
  const nav = { vibrate: (v) => { calls.push(v); return true; } };
  assert.ok(vibrateSupported(nav) && !vibrateSupported({}));
  assert.equal(vibrateMs({ strong: 0.05, weak: 0.05 }), 0);
  assert.ok(vibrateMs({ strong: 1, weak: 0 }) > vibrateMs({ strong: 0.3, weak: 0 }));
  const r = createRumble();
  r.strength = 1;
  r.pulse('bonk', 1, 0.5, 0.2);
  assert.ok(r.frameVibrate(0.01, true, nav) > 0);
  r.frameVibrate(0.01, true, nav);
  assert.equal(calls.length, 1, 'throttled to the refresh interval');
  for (let i = 0; i < 40; i++) r.frameVibrate(0.01, true, nav);
  assert.equal(calls.at(-1), 0, 'vibrate(0) once the pulse faded');
  r.pulse('bonk', 1, 1, 1);
  r.frameVibrate(0.01, true, nav);
  r.frameVibrate(0.01, false, nav);
  assert.equal(calls.at(-1), 0, 'disabling stops it');
  assert.equal(r.frameVibrate(0.01, true, {}), 0, 'no API: no-op');
}

// Rumble: dual-rumble where available, Firefox hapticActuators otherwise; pulses fade, throttled sends, stop when disabled
{
  const { createRumble, sendRumble, rumbleSupport } = await import('../js/rumble.js');
  const dual = [], pulses = [[], []];
  const chromePad = { vibrationActuator: { effects: ['dual-rumble'], playEffect: (t, o) => { dual.push([t, o.strongMagnitude, o.weakMagnitude]); return Promise.resolve(); } } };
  const act = (i) => ({ pulse: (v, ms) => { pulses[i].push([v, ms]); return Promise.resolve(true); } });
  assert.equal(sendRumble(chromePad, 0.5, 0.2), 'dual');
  assert.deepEqual(dual[0], ['dual-rumble', 0.5, 0.2]);
  assert.equal(sendRumble({ hapticActuators: [act(0)] }, 0.2, 1), 'pulse');
  assert.equal(pulses[0][0][0], 0.6, 'one actuator: max(strong, weak × 0.6)');
  sendRumble({ hapticActuators: [act(0), act(1)] }, 0.3, 0.7);
  assert.deepEqual([pulses[0][1][0], pulses[1][0][0]], [0.3, 0.7], 'two actuators: strong and weak motors');
  assert.equal(sendRumble({ vibrationActuator: null, hapticActuators: [] }, 1, 1), null);
  const trig = [];
  const xboxPad = { vibrationActuator: { effects: ['dual-rumble', 'trigger-rumble'], playEffect: (t, o) => { trig.push([t, o.strongMagnitude, o.leftTrigger]); return Promise.resolve(); } } };
  assert.deepEqual(rumbleSupport(xboxPad), ['dual', 'trigger', 'triggers']);
  assert.equal(sendRumble(xboxPad, 0.4, 0.2, 100, 'triggers'), 'triggers');
  assert.deepEqual(trig[0], ['trigger-rumble', 0, 0.4], 'triggers only: motors off, triggers at the stronger value');
  assert.equal(sendRumble(chromePad, 0.4, 0.2, 100, 'pulse'), null, 'a chosen effect the pad lacks plays nothing');

  const r = createRumble();
  r.strength = 1;
  r.pulse('bonk', 1, 0.5, 0.2);
  dual.length = 0;
  assert.equal(r.frame(0.01, chromePad).strong, 0.95);
  r.frame(0.01, chromePad);
  assert.equal(dual.length, 1, 'no resend before the refresh interval');
  for (let i = 0; i < 30; i++) r.frame(0.01, chromePad);
  assert.deepEqual(r.mix(), { strong: 0, weak: 0 }, 'pulse faded out');
  assert.deepEqual(dual.at(-1).slice(1), [0, 0], 'stopped once it faded');
  r.pulse('bonk', 1, 1, 1);
  r.frame(0.01, chromePad, false);
  assert.deepEqual(r.mix(), { strong: 0, weak: 0 }, 'disabled drops pending pulses');
  r.setFeature('damage', false);
  r.pulse('damage', 1, 1, 1);
  assert.deepEqual(r.mix(), { strong: 0, weak: 0 }, 'a switched-off feature does not rumble');
  r.strength = 0.5;
  r.pulse('bonk', 1, 1, 1);
  assert.deepEqual(r.mix(), { strong: 0.5, weak: 0.5 }, 'strength scales the mix');
  r.clear(); r.strength = 1;

  // Truck feed: the held horn buzzes, scraping and tyre slip rumble, a quiet truck does not
  const t = { fl: { speed: 2 }, scrape: 0, slip: 0, horn: false };
  r.feedTruck(t);
  assert.deepEqual(r.mix(), { strong: 0, weak: 0 }, 'driving alone is quiet');
  t.horn = true; r.feedTruck(t);
  assert.ok(r.mix().weak > 0.3, 'honking buzzes');
  r.setFeature('horn', false); r.feedTruck(t);
  assert.deepEqual(r.mix(), { strong: 0, weak: 0 }, 'horn rumble can be switched off');
  t.scrape = 1; t.slip = 0.5; r.feedTruck(t);
  assert.ok(r.mix().weak > 0.3, 'scrape and slip rumble');
}

// Y on the keyboard player's pad does not swap the camera view
{
  const calls = [];
  const inp = createInput({ swapView: () => calls.push('swap') });
  pad = mkPad({ pressed: [3] });
  inp.state();
  pad = null;
  inp.state();
  assert.deepEqual(calls, []);
}
