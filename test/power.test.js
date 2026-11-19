import assert from 'node:assert/strict';
import { batterySaverOption, canvasDpr, shouldDraw, autosaveIntervalMs } from '../js/power.js';

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

// Frame-rate limit and save cadence are independent.
{
  assert.equal(shouldDraw(0, 0, true), false);
  assert.equal(shouldDraw(1000 / 30, 0, true), true);
  assert.equal(shouldDraw(1, 0, false), true);
  assert.equal(autosaveIntervalMs(true), 5000);
  assert.equal(autosaveIntervalMs(false), 1000);
}
