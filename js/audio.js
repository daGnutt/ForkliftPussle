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
const SCALE = [69, 72, 74, 76, 79, 81, 84]; // A minor pentatonic-ish
const CHORD_LEN = 7; // seconds

let ctx = null, master = null, musicBus = null, sfxBus = null;
let muted = localStorage.getItem(MUTE_KEY) === '1';
let nextChord = 0, chordIdx = 0, timer = null;

function init() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(ctx.destination);

  musicBus = ctx.createGain();
  musicBus.gain.value = muted ? 0 : 0.35;
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

function scheduleChord(t) {
  const chord = CHORDS[chordIdx % CHORDS.length];
  chordIdx++;
  chord.forEach((m, i) => {
    tone(musicBus, mtof(m), t, CHORD_LEN + 1.5, {
      type: i === 0 ? 'sine' : 'triangle',
      gain: i === 0 ? 0.14 : 0.07,
      attack: 1.6,
      release: 2.4,
      cutoff: 900,
    });
  });
  // A few sparse, soft melody notes.
  let nt = t + 0.8;
  while (nt < t + CHORD_LEN - 0.5) {
    if (Math.random() < 0.7) {
      const m = SCALE[Math.floor(Math.random() * SCALE.length)];
      tone(musicBus, mtof(m), nt, 1.6, { gain: 0.06, attack: 0.03, release: 1.4 });
    }
    nt += 0.85 + Math.random() * 1.1;
  }
}

function tick() {
  if (!ctx) return;
  if (nextChord < ctx.currentTime) nextChord = ctx.currentTime + 0.1;
  while (nextChord < ctx.currentTime + 3) {
    scheduleChord(nextChord);
    nextChord += CHORD_LEN;
  }
}

// Call from a user gesture (browsers block audio before the first key press).
export function startAudio() {
  init();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  if (!timer) {
    tick();
    timer = setInterval(tick, 1000);
  }
}

export function isMusicMuted() { return muted; }

export function toggleMusic() {
  startAudio();
  muted = !muted;
  localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  if (ctx) musicBus.gain.setTargetAtTime(muted ? 0 : 0.35, ctx.currentTime, 0.15);
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

// Cheerful rising arpeggio when a zone is filled.
export function playSuccess() {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  [72, 76, 79, 84].forEach((m, i) => {
    tone(sfxBus, mtof(m), t + i * 0.09, 0.5, { type: 'triangle', gain: 0.16, attack: 0.01, release: 0.35 });
  });
}
