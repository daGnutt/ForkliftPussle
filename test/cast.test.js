import assert from 'node:assert/strict';
import { CAST_APPLICATION_ID, createCastSender, createEmptyPartyTimer, requestCastFrame } from '../js/cast.js';

// Launch only starts a Cast session; joining remains a separate player action.
{
  let options, requested = 0, currentSession = {};
  const context = {
    setOptions: (value) => { options = value; },
    requestSession: async () => { requested++; },
    getCurrentSession: () => currentSession,
  };
  const sender = createCastSender({
    cast: { framework: { CastContext: { getInstance: () => context } } },
    chromeApi: { cast: { AutoJoinPolicy: { ORIGIN_SCOPED: 'origin' } } },
  });
  await sender.start();
  assert.equal(requested, 1);
  assert.equal(options.receiverApplicationId, CAST_APPLICATION_ID);
  assert.equal(options.autoJoinPolicy, 'origin');
  currentSession = null;
  await assert.rejects(sender.start(), /No Cast receiver session/);
}

// The empty-party deadline is not reset by repeated roster updates, and rejoins cancel it.
{
  let now = 0, next = 0, ended = 0;
  const timers = new Map();
  const idle = createEmptyPartyTimer(() => ended++, {
    setTimer: (fn, delay) => { const id = ++next; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  function advance(ms) {
    now += ms;
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); }
  }
  idle.update(0);
  advance(59000);
  idle.update(0);
  advance(1000);
  assert.equal(ended, 1, 'ends 60 seconds after creation');
  idle.update(1);
  advance(120000);
  assert.equal(ended, 1, 'connected players prevent shutdown');
  idle.update(0);
  advance(59000);
  idle.update(1);
  advance(1000);
  assert.equal(ended, 1, 'a rejoin cancels shutdown');
  idle.update(0);
  advance(60000);
  assert.equal(ended, 2, 'ends 60 seconds after the last player leaves');
  idle.update(0);
  idle.cancel();
  advance(60000);
  assert.equal(ended, 2, 'cleanup cancels the timer');
}

// A stalled animation callback falls back to a timer without running either frame twice.
{
  let animation, timeout, cancelled, cleared, times = [];
  const options = {
    requestFrame: (fn) => { animation = fn; return 7; },
    cancelFrame: (id) => { cancelled = id; },
    setTimer: (fn, delay) => { assert.equal(delay, 1000 / 30); timeout = fn; return 8; },
    clearTimer: (id) => { cleared = id; },
    now: () => 123,
  };
  requestCastFrame((time) => times.push(time), options);
  timeout();
  animation(124);
  assert.deepEqual(times, [123]);
  assert.equal(cancelled, 7);
  assert.equal(cleared, 8);
  times = []; cancelled = null;
  requestCastFrame((time) => times.push(time), options);
  animation(200);
  timeout();
  assert.deepEqual(times, [200]);
  assert.equal(cleared, 8);
}

// Receiver starts the normal Observer page and only trusts messages from its own frame.
{
  let frameMessage, stopped = 0, startOptions;
  const frameWindow = {};
  const frame = { contentWindow: frameWindow };
  const error = { hidden: true };
  globalThis.cast = { framework: { CastReceiverContext: { getInstance: () => ({
    start: (options) => { startOptions = options; },
    stop: () => { stopped++; },
  }) } } };
  globalThis.document = { getElementById: (id) => id === 'game' ? frame : error };
  globalThis.location = { origin: 'https://example.test', href: 'https://example.test/cast-receiver.html' };
  globalThis.window = { addEventListener: (type, listener) => { if (type === 'message') frameMessage = listener; } };
  await import('../js/cast-receiver.js');
  assert.equal(frame.src, 'https://example.test/index.html?observer&castReceiver=1');
  assert.equal(startOptions.disableIdleTimeout, true);
  frameMessage({ origin: 'https://other.test', source: frameWindow, data: { type: 'ended' } });
  frameMessage({ origin: location.origin, source: {}, data: { type: 'ended' } });
  assert.equal(stopped, 0);
  frameMessage({ origin: location.origin, source: frameWindow, data: { type: 'ended' } });
  assert.equal(stopped, 1);
  const log = console.error;
  try {
    console.error = () => {};
    frameMessage({ origin: location.origin, source: frameWindow, data: { type: 'error', message: 'Party server failed' } });
  } finally { console.error = log; }
  assert.equal(error.textContent, 'Party server failed');
  assert.equal(error.hidden, false);
  assert.equal(frame.hidden, true);
  delete globalThis.cast;
  delete globalThis.document;
  delete globalThis.location;
  delete globalThis.window;
}

console.log('Cast tests passed');
