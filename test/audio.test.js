import assert from 'node:assert/strict';

const values = new Map([['forklift-music-muted', '1']]);
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
};

const contexts = [];
let oscillatorCount = 0;
const oscillators = [];
const audioParam = () => ({
  value: 0, events: [],
  setValueAtTime(value, t) { this.events.push(['set', value, t]); },
  linearRampToValueAtTime(value, t) { this.events.push(['linear', value, t]); },
  exponentialRampToValueAtTime(value, t) { this.events.push(['exponential', value, t]); },
  setTargetAtTime() {}, cancelScheduledValues() {},
});
class MockAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = {};
    this.suspendCount = 0;
    this.resumeCount = 0;
    contexts.push(this);
  }
  createGain() { return { gain: audioParam(), connect() {}, disconnect() {} }; }
  createBiquadFilter() {
    return { type: '', frequency: audioParam(), Q: { value: 0 }, gain: { value: 0 }, connect() {} };
  }
  createDynamicsCompressor() {
    return { threshold: {}, ratio: {}, attack: {}, release: {}, connect() {} };
  }
  createDelay() { return { delayTime: { value: 0 }, connect() {} }; }
  createOscillator() {
    oscillatorCount++;
    const o = { type: '', frequency: audioParam(), detune: { value: 0 }, connect() {}, start(t) { this.at = t; }, stop(t) { this.end = t; } };
    oscillators.push(o);
    return o;
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

const { startAudio, setSilenced, setPageHidden, isMusicMuted, playDroid } = await import('../js/audio.js');

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

// Each bot has a recognisable timbre and dialect, independent of random phrasing and mood.
{
  setSilenced(false);
  const random = Math.random;
  const samples = [];
  try {
    Math.random = () => 0.5;
    for (const voice of ['cleaner', 'inspector', 'cone', 'tape']) {
      const start = oscillators.length;
      playDroid('curious', 0.5, voice);
      const notes = oscillators.slice(start).filter((_, i) => i % 2 === 0);
      assert.ok(notes.length >= 3, `${voice} speaks a phrase`);
      samples.push({
        type: notes[0].type,
        rhythm: notes.map((n) => n.at),
        intervals: notes.map((n) => n.frequency.events.at(-1)[1] / n.frequency.events[0][1]),
      });
      for (const mood of ['hello', 'bye', 'scan', 'perfect', 'warn', 'alarm', 'mumble']) playDroid(mood, 1, voice);
    }
  } finally { Math.random = random; }
  assert.equal(new Set(samples.map((s) => s.type)).size, 4, 'voices have distinct timbres');
  assert.equal(new Set(samples.map((s) => JSON.stringify(s.rhythm))).size, 4, 'dialects have distinct rhythms');
  assert.equal(new Set(samples.map((s) => JSON.stringify(s.intervals))).size, 4, 'dialects have distinct pitch vocabulary, not just transposition');
  const before = oscillators.length;
  setSilenced(true);
  playDroid('hello', 1, 'cone');
  setSilenced(false);
  playDroid('hello', 0, 'tape');
  setPageHidden(true);
  playDroid('hello', 1, 'cleaner');
  assert.equal(oscillators.length, before, 'muted, inaudible and hidden bots do not schedule speech');
}

console.log('audio tests passed');
