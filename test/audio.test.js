import assert from 'node:assert/strict';

class Param {
  value = 0;
  setTargetAtTime(value) { this.value = value; }
}

class Node {
  gain = new Param();
  frequency = new Param();
  Q = new Param();
  threshold = new Param();
  ratio = new Param();
  attack = new Param();
  release = new Param();
  delayTime = new Param();
  connect(node) { this.output = node; }
  start() {}
}

const oscillators = [];
class AudioContext {
  state = 'running';
  currentTime = 0;
  destination = new Node();
  createGain() { return new Node(); }
  createBiquadFilter() { return new Node(); }
  createDynamicsCompressor() { return new Node(); }
  createDelay() { return new Node(); }
  createOscillator() {
    const node = new Node();
    oscillators.push(node);
    return node;
  }
}

globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = { AudioContext };
const { startAudio, setEngine, setBeepOn } = await import('../js/audio.js');
const setIntervalOriginal = globalThis.setInterval;
globalThis.setInterval = () => 1;
startAudio();
globalThis.setInterval = setIntervalOriginal;

const beepers = () => oscillators.filter((node) => node.frequency.value === 880);

setEngine(0, false, true, 0);
assert.equal(beepers().length, 0, 'idle in reverse does not start a beeper');
setEngine(-0.001, true, true, 0);
assert.equal(beepers().length, 1, 'backward movement in reverse starts a beeper');
assert.equal(beepers()[0].output.gain.value, 0.035);
setEngine(0, false, true, 0);
assert.equal(beepers()[0].output.gain.value, 0, 'stopping silences the beeper');
setEngine(1, true, true, 0);
assert.equal(beepers()[0].output.gain.value, 0, 'forward motion in reverse is silent');
setEngine(-1, true, false, 0);
assert.equal(beepers()[0].output.gain.value, 0, 'backward motion outside reverse is silent');

setEngine(-1, true, true, 1, 0.5);
assert.equal(beepers().length, 2, 'another truck has its own beeper');
assert.equal(beepers()[1].output.gain.value, 0.0175, 'other truck volume is respected');
setEngine(0, false, true, 1, 0.5);
assert.equal(beepers()[1].output.gain.value, 0, 'another truck stopping silences its beeper');
setBeepOn(false);
setEngine(-1, true, true, 1);
assert.equal(beepers()[1].output.gain.value, 0, 'disabled reversing beep stays silent');

console.log('audio tests passed');
