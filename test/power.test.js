import assert from 'node:assert/strict';
import { batterySaverDefault, canvasDpr, shouldDraw, autosaveIntervalMs } from '../js/power.js';

const storage = (saved = null) => ({ getItem: () => saved });

// Battery saver defaults to touch, but an explicit setting always wins.
{
  assert.equal(batterySaverDefault(storage(), true), true);
  assert.equal(batterySaverDefault(storage(), false), false);
  assert.equal(batterySaverDefault(storage('0'), true), false);
  assert.equal(batterySaverDefault(storage('1'), false), true);
}

// The saver and touch cap DPR and pixel count; desktop keeps its existing pixel budget.
{
  assert.equal(canvasDpr(3, 400, 300, true, false), 1);
  assert.equal(canvasDpr(3, 1200, 1000, true, false), Math.sqrt(0.9e6 / 1.2e6));
  assert.equal(canvasDpr(3, 2000, 1000, false, false), Math.sqrt(3e6 / 2e6));
  assert.equal(canvasDpr(3, 1200, 1000, false, true), Math.sqrt(0.9e6 / 1.2e6));
}

// Battery saver skips drawing between 30 Hz deadlines and autosaves less often.
{
  assert.equal(shouldDraw(0, 0, true), false);
  assert.equal(shouldDraw(1000 / 30, 0, true), true);
  assert.equal(shouldDraw(1, 0, false), true);
  assert.equal(autosaveIntervalMs(true), 5000);
  assert.equal(autosaveIntervalMs(false), 1000);
}
