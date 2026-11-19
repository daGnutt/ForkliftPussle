import assert from 'node:assert/strict';

const values = new Map([['forklift-music-muted', '1']]);
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
};

const contexts = [];
let oscillatorCount = 0;
class MockAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = {};
    this.suspendCount = 0;
    this.resumeCount = 0;
    contexts.push(this);
  }
  createGain() { return { gain: { value: 0, setTargetAtTime() {} }, connect() {}, disconnect() {} }; }
  createBiquadFilter() {
    return { type: '', frequency: { value: 0 }, Q: { value: 0 }, gain: { value: 0 }, connect() {} };
  }
  createDynamicsCompressor() {
    return { threshold: {}, ratio: {}, attack: {}, release: {}, connect() {} };
  }
  createDelay() { return { delayTime: { value: 0 }, connect() {} }; }
  createOscillator() {
    oscillatorCount++;
    const param = { setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} };
    return { type: '', frequency: param, detune: { value: 0 }, connect() {}, start() {}, stop() {} };
  }
  suspend() { this.suspendCount++; this.state = 'suspended'; return Promise.resolve(); }
  resume() {
    this.resumeCount++;
    if (this.blockResume) return Promise.reject(new Error('resume blocked'));
    this.state = 'running';
    return Promise.resolve();
  }
}
globalThis.window = { AudioContext: MockAudioContext };
let resolveFetch;
globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });

const intervals = [], cleared = [];
globalThis.setInterval = (fn) => { intervals.push(fn); return intervals.length; };
globalThis.clearInterval = (id) => cleared.push(id);

const { startAudio, setSilenced, setPageHidden, isMusicMuted } = await import('../js/audio.js');

// A visible pause silences only effects; hiding suspends audio and clears its MIDI scheduler.
{
  startAudio();
  const ctx = contexts[0];
  assert.equal(intervals.length, 1, 'audio starts one MIDI scheduler');

  setSilenced(true);
  assert.equal(ctx.suspendCount, 0, 'the visible pause menu keeps music running');
  assert.equal(intervals.length, 1, 'pause does not stop the music scheduler');

  setPageHidden(true);
  assert.equal(ctx.suspendCount, 1, 'hiding suspends the audio context');
  assert.deepEqual(cleared, [1], 'hiding clears the scheduler');
  const midi = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96,
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 18,
    0, 0x90, 60, 64, 96, 0x80, 60, 0, 0, 0xff, 0x2f, 0,
  ]);
  resolveFetch({ arrayBuffer: async () => midi.buffer });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(oscillatorCount, 0, 'a song finishing its load while hidden does not schedule notes');
  intervals[0]();
  assert.equal(intervals.length, 1, 'a stale hidden callback does not restart scheduling');

  setPageHidden(false);
  await Promise.resolve();
  assert.equal(ctx.resumeCount, 1, 'showing resumes previously started audio');
  assert.equal(intervals.length, 2, 'showing starts one scheduler');
  setPageHidden(false);
  assert.equal(intervals.length, 2, 'repeated visible events do not duplicate timers');
  assert.equal(isMusicMuted(), true, 'visibility changes preserve the music mute preference');

  setPageHidden(true);
  setPageHidden(true);
  assert.equal(ctx.suspendCount, 2, 'repeated hidden events suspend only once per transition');
  ctx.blockResume = true;
  setPageHidden(false);
  await Promise.resolve();
  assert.equal(intervals.length, 2, 'a blocked automatic resume does not start a timer');
  ctx.blockResume = false;
  startAudio();
  await Promise.resolve();
  assert.equal(intervals.length, 3, 'repeated hide/show cycles restart one scheduler each time');
}

console.log('audio tests passed');
