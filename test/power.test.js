import assert from 'node:assert/strict';
import { batterySaverOption, canvasDpr, shouldDraw } from '../js/power.js';
import { startVisibleLoop } from '../js/visible-loop.js';

const storage = (values = {}) => ({ getItem: (key) => values[key] ?? null });

// Each option defaults independently; old all-in-one preferences remain respected.
{
  assert.equal(batterySaverOption(storage(), 'resolution', true), true);
  assert.equal(batterySaverOption(storage(), 'effects', false), false);
  assert.equal(batterySaverOption(storage(), 'frame-rate', true), false);
  assert.equal(batterySaverOption(storage({ 'forklift-battery-saver-resolution': '0' }), 'resolution', true), false);
  assert.equal(batterySaverOption(storage({ 'forklift-battery-saver': '1' }), 'frame-rate', false), true);
  assert.equal(batterySaverOption(storage({
    'forklift-battery-saver': '1',
    'forklift-battery-saver-frame-rate': '0',
  }), 'frame-rate', true), false);
}

// Lower-resolution option caps DPR and pixel count; desktop keeps its existing pixel budget.
{
  assert.equal(canvasDpr(3, 400, 300, true), 1);
  assert.equal(canvasDpr(3, 1200, 1000, true), Math.sqrt(0.9e6 / 1.2e6));
  assert.equal(canvasDpr(3, 2000, 1000, false), Math.sqrt(3e6 / 2e6));
}

// The frame-rate limit only skips draws inside the 30 fps interval.
{
  assert.equal(shouldDraw(0, 0, true), false);
  assert.equal(shouldDraw(1000 / 30, 0, true), true);
  assert.equal(shouldDraw(1, 0, false), true);
}

// Splash loops cancel both callback types while hidden and resume with fresh timing.
{
  const listeners = new Map(), frames = new Map(), timers = new Map();
  let nextFrame = 0, nextTimer = 0, resets = 0, draws = 0;
  globalThis.document = {
    hidden: false,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  };
  globalThis.requestAnimationFrame = (fn) => { const id = ++nextFrame; frames.set(id, fn); return id; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  globalThis.setTimeout = (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  const loop = startVisibleLoop(() => true, () => { draws++; return 100; }, () => { resets++; });
  assert.equal(frames.size, 1, 'visible splash starts one frame loop');

  const firstFrame = frames.entries().next().value;
  document.hidden = true;
  listeners.get('visibilitychange')();
  firstFrame[1](10);
  assert.equal(frames.size, 0, 'hiding cancels a pending frame');
  assert.equal(draws, 0, 'a canceled frame cannot draw while hidden');

  document.hidden = false;
  listeners.get('visibilitychange')();
  assert.equal(frames.size, 1, 'showing restarts a single frame loop');
  listeners.get('visibilitychange')();
  assert.equal(frames.size, 1, 'repeated visible events do not duplicate frames');
  const resumedFrame = frames.entries().next().value;
  frames.delete(resumedFrame[0]);
  resumedFrame[1](5000);
  assert.equal(timers.size, 1, 'frame-rate delay uses one timeout');
  const timer = timers.entries().next().value;

  document.hidden = true;
  listeners.get('visibilitychange')();
  timer[1]();
  assert.equal(timers.size, 0, 'hiding cancels a pending timeout');
  assert.equal(frames.size, 0);

  document.hidden = false;
  listeners.get('visibilitychange')();
  assert.equal(frames.size, 1, 'showing restarts a single frame loop');
  const finalFrame = frames.entries().next().value;
  frames.delete(finalFrame[0]);
  finalFrame[1](6000);
  assert.equal(draws, 2, 'animation draws again after returning');
  assert.equal(resets, 4, 'each hide and show resets animation timing');
  loop();
  assert.equal(listeners.size, 0, 'stopping removes the visibility listener');

  document.hidden = true;
  startVisibleLoop(() => false, () => { draws++; });
  document.hidden = false;
  listeners.get('visibilitychange')();
  assert.equal(listeners.size, 0, 'a splash that is no longer active does not restart');
  assert.equal(frames.size, 0);
}
