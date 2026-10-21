// Procedural audio (Web Audio, no asset files): a chill generative background
// track that can be muted, plus short sound effects. Browser only.
const MUTE_KEY = 'forklift-music-muted';

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
// Am9, Fmaj7, Cmaj7, G6 – MIDI notes.
const CHORDS = [
  [57, 60, 64, 67, 71],
  [53, 60, 64, 67, 69],
  [48, 55, 64, 67, 71],
  [55, 59, 62, 64, 69],
];
const MUSIC_VOL = 0.35;
const BPM = 98;
const STEP = 60 / BPM / 4; // 16th note
const STEPS_PER_CHORD = 32; // two bars

let ctx = null, master = null, musicBus = null, sfxBus = null;
let muted = localStorage.getItem(MUTE_KEY) === '1';
let nextStep = 0, stepIdx = 0, timer = null, noiseBuf = null;
let engine = null;

function init() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(ctx.destination);

  musicBus = ctx.createGain();
  musicBus.gain.value = muted ? 0 : MUSIC_VOL;
  sfxBus = ctx.createGain();
  sfxBus.gain.value = 0.5;
  sfxBus.connect(master);

  // Soft feedback delay acts as a cheap reverb for the music.
  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0.42;
  const fb = ctx.createGain();
  fb.gain.value = 0.4;
  const damp = ctx.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = 1800;
  musicBus.connect(master);
  musicBus.connect(delay);
  delay.connect(damp);
  damp.connect(fb);
  fb.connect(delay);
  damp.connect(master);
}

function tone(dest, freq, t, dur, { type = 'sine', gain = 0.2, attack = 0.02, release = 0.2, cutoff = 0 } = {}) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.setValueAtTime(gain, t + Math.max(attack, dur - release));
  g.gain.linearRampToValueAtTime(0, t + dur);
  let out = o;
  if (cutoff) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    o.connect(f);
    out = f;
  }
  out.connect(g);
  g.connect(dest);
  o.start(t);
  o.stop(t + dur + 0.05);
  return o;
}

function noise(dest, t, dur, { gain = 0.1, cutoff = 7000, type = 'highpass' } = {}) {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = cutoff;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f);
  f.connect(g);
  g.connect(dest);
  src.start(t);
  src.stop(t + dur + 0.02);
}

function kick(t) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.setValueAtTime(130, t);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
  g.gain.setValueAtTime(0.5, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  o.connect(g);
  g.connect(musicBus);
  o.start(t);
  o.stop(t + 0.25);
}

function schedulePad(chord, t) {
  chord.forEach((m, i) => {
    tone(musicBus, mtof(m), t, STEPS_PER_CHORD * STEP + 1.2, {
      type: i === 0 ? 'sine' : 'triangle',
      gain: i === 0 ? 0.1 : 0.05,
      attack: 0.8,
      release: 1.6,
      cutoff: 1200,
    });
  });
}

function scheduleStep(i, t) {
  const chord = CHORDS[Math.floor(i / STEPS_PER_CHORD) % CHORDS.length];
  const k = i % STEPS_PER_CHORD;
  const beat = k % 16;
  if (k === 0) schedulePad(chord, t);

  // Drums: four on the floor-ish kick, off-beat hats, snare-like tick on 2 and 4.
  if (beat % 4 === 0) kick(t);
  if (beat % 4 === 2) noise(musicBus, t, 0.05, { gain: 0.05 });
  if (beat === 4 || beat === 12) noise(musicBus, t, 0.12, { gain: 0.08, cutoff: 1800, type: 'bandpass' });

  // Syncopated bass on the chord root.
  if ([0, 3, 6, 10, 14].includes(beat)) {
    tone(musicBus, mtof(chord[0] - 12), t, STEP * 2.2, { type: 'sawtooth', gain: 0.1, attack: 0.01, release: 0.12, cutoff: 380 });
  }

  // 8th-note arpeggio over the chord tones, with an octave lift on the last bar.
  if (k % 2 === 0) {
    const pattern = [1, 2, 3, 4, 3, 2, 4, 3];
    const m = chord[pattern[(k / 2) % pattern.length]] + (k >= 16 ? 12 : 0);
    tone(musicBus, mtof(m + 12), t, STEP * 3, { type: 'triangle', gain: 0.06, attack: 0.01, release: 0.25, cutoff: 3000 });
  }
}

function tick() {
  if (!ctx) return;
  if (nextStep < ctx.currentTime - 0.5) nextStep = ctx.currentTime + 0.05;
  while (nextStep < ctx.currentTime + 0.4) {
    scheduleStep(stepIdx++, nextStep);
    nextStep += STEP;
  }
}

// Call from a user gesture (browsers block audio before the first key press).
export function startAudio() {
  init();
  if (!ctx) return;
  if (ctx.state === 'suspended' && !silenced) ctx.resume();
  if (!timer) {
    tick();
    timer = setInterval(tick, 100);
  }
}

// Silence everything (focus lost / manual pause) by suspending the audio clock.
let silenced = false;
export function setSilenced(s) {
  silenced = s;
  if (!ctx) return;
  if (s) ctx.suspend(); else ctx.resume();
}

export function isMusicMuted() { return muted; }

export function toggleMusic() {
  startAudio();
  muted = !muted;
  localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  if (ctx) musicBus.gain.setTargetAtTime(muted ? 0 : MUSIC_VOL, ctx.currentTime, 0.15);
  return muted;
}

// Hydraulic whine sweeping up (raise) or down (lower).
export function playFork(up) {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime, dur = 0.32;
  const o = tone(sfxBus, 1, t, dur, { type: 'sawtooth', gain: 0.12, attack: 0.04, release: 0.1, cutoff: 1100 });
  o.frequency.cancelScheduledValues(t);
  o.frequency.setValueAtTime(up ? 140 : 260, t);
  o.frequency.linearRampToValueAtTime(up ? 260 : 140, t + dur);
  tone(sfxBus, up ? 90 : 70, t, dur, { type: 'square', gain: 0.05, attack: 0.02, release: 0.1, cutoff: 400 });
}

// Descending buzz when the forks are refused a move through a box.
export function playBlocked() {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime, dur = 0.35;
  const o = tone(sfxBus, 1, t, dur, { type: 'sawtooth', gain: 0.14, attack: 0.01, release: 0.1, cutoff: 900 });
  o.frequency.cancelScheduledValues(t);
  o.frequency.setValueAtTime(220, t);
  o.frequency.exponentialRampToValueAtTime(70, t + dur);
}

// Cheerful rising arpeggio when a zone is filled.
export function playSuccess() {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  [72, 76, 79, 84].forEach((m, i) => {
    tone(sfxBus, mtof(m), t + i * 0.09, 0.5, { type: 'triangle', gain: 0.16, attack: 0.01, release: 0.35 });
  });
}

// Electric motor: a thin whine whose pitch and level follow the forklift speed.
function startEngine() {
  const o = ctx.createOscillator();
  const o2 = ctx.createOscillator();
  const f = ctx.createBiquadFilter();
  const g = ctx.createGain();
  o.type = 'sawtooth';
  o2.type = 'sine';
  f.type = 'lowpass';
  f.frequency.value = 900;
  g.gain.value = 0;
  o.connect(f);
  o2.connect(f);
  f.connect(g);
  g.connect(sfxBus);
  o.start();
  o2.start();
  engine = { o, o2, f, g };
}

// Call every frame. speed in tiles/s (signed); throttle: a drive key is held.
export function setEngine(speed, throttle) {
  if (!ctx || ctx.state !== 'running') return;
  if (!engine) startEngine();
  const v = Math.min(1, Math.abs(speed) / 4);
  const t = ctx.currentTime;
  const pitch = 110 + v * 520 + (throttle ? 25 : 0);
  engine.o.frequency.setTargetAtTime(pitch, t, 0.08);
  engine.o2.frequency.setTargetAtTime(pitch * 2, t, 0.08);
  engine.f.frequency.setTargetAtTime(500 + v * 1800, t, 0.1);
  engine.g.gain.setTargetAtTime(0.012 + v * 0.05 + (throttle ? 0.01 : 0), t, 0.1);
}
