// Procedural audio (Web Audio, no asset files): a chill generative background
// track that can be muted, plus short sound effects. Browser only.
import { parseMidi } from './midi.js';

const MUTE_KEY = 'forklift-music-muted';

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const MUSIC_VOL = 0.35;
const TRACK_KEY = 'forklift-music-track';

let ctx = null, master = null, musicBus = null, sfxBus = null;
let muted = localStorage.getItem(MUTE_KEY) === '1';
let nextStep = 0, stepIdx = 0, timer = null, noiseBuf = null;
let trackIdx = 0, trackBus = null, STEP = 0.15;
let engine = null;
let beeper = null;
const ALL_KEY = 'forklift-all-muted';
let allMuted = localStorage.getItem(ALL_KEY) === '1';
const MASTER_VOL = 0.8;

function init() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = allMuted ? 0 : MASTER_VOL;
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
  applyTrack();
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
  if (thin) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.setValueAtTime(130, t);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
  g.gain.setValueAtTime(0.5, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  o.connect(g);
  g.connect(trackBus);
  o.start(t);
  o.stop(t + 0.25);
}

let thin = false; // breakdown: drums drop out
const T = (m, t, dur, o) => tone(trackBus, mtof(m), t, dur, o);
const ND = (t, dur, o) => { if (!thin) noise(trackBus, t, dur, o); };
const pad = (chord, t, len, { gain = 0.05, cutoff = 1200, type = 'triangle' } = {}) => {
  chord.forEach((m, i) => T(m, t, len, { type: i === 0 ? 'sine' : type, gain: i === 0 ? gain * 2 : gain, attack: 0.8, release: 1.6, cutoff }));
};

// Each track: 16th-note step scheduler. `chordSteps` steps per chord; `step(k, t, chord, ci, n)`
// gets the step within the chord, the time, the chord, chord index and the global step number.
const TRACKS = [
  {
    id: 'chill', name: 'Chill: Pallet Pad Lounge (ambient)', bpm: 98, chordSteps: 32,
    chords: [[57, 60, 64, 67, 71], [53, 60, 64, 67, 69], [48, 55, 64, 67, 71], [55, 59, 62, 64, 69],
      [50, 57, 60, 64, 69], [46, 53, 57, 60, 64], [53, 60, 64, 67, 69], [52, 59, 62, 66, 68]],
    step(k, t, chord) {
      const beat = k % 16;
      if (k === 0) pad(chord, t, 32 * STEP + 1.2);
      if (beat % 4 === 0) kick(t);
      if (beat % 4 === 2) ND(t, 0.05, { gain: 0.05 });
      if (beat === 4 || beat === 12) ND(t, 0.12, { gain: 0.08, cutoff: 1800, type: 'bandpass' });
      if ([0, 3, 6, 10, 14].includes(beat)) T(chord[0] - 12, t, STEP * 2.2, { type: 'sawtooth', gain: 0.1, attack: 0.01, release: 0.12, cutoff: 380 });
      if (k % 2 === 0) {
        const m = chord[[1, 2, 3, 4, 3, 2, 4, 3][(k / 2) % 8]] + (k >= 16 ? 12 : 0);
        T(m + 12, t, STEP * 3, { type: 'triangle', gain: 0.06, attack: 0.01, release: 0.25, cutoff: 3000 });
      }
    },
  },
  {
    id: 'metal', name: 'Heavy Metal: Fork-Lift of Doom (140 BPM)', bpm: 140, chordSteps: 16,
    chords: [[40, 47, 52], [36, 43, 48], [38, 45, 50], [35, 42, 47],
      [40, 47, 52], [43, 50, 55], [41, 48, 53], [39, 46, 51], [38, 45, 50], [36, 43, 48], [35, 42, 47], [35, 42, 47]],
    step(k, t, chord, ci) {
      // Palm-muted chugs on the 16ths, open chord stabs on the downbeat, double-bass kick.
      const chug = [0, 1, 3, 4, 6, 8, 9, 11, 12, 14].includes(k);
      if (chug) chord.forEach((m) => T(m, t, STEP * (k === 0 ? 3.5 : 0.8), { type: 'sawtooth', gain: 0.07, attack: 0.003, release: 0.05, cutoff: 1500 }));
      if (k % 2 === 0 || k >= 12) kick(t);
      if (k === 4 || k === 12) ND(t, 0.15, { gain: 0.14, cutoff: 2200, type: 'bandpass' });
      if (k % 4 === 2) ND(t, 0.04, { gain: 0.04 });
      if (k === 0 && ci % 4 === 0) ND(t, 0.9, { gain: 0.08, cutoff: 5000 });
      // Pentatonic lead screams over the last two chords.
      if (ci >= 2 && k % 2 === 0) {
        const lead = [64, 67, 69, 71, 74, 71, 69, 67][(k / 2 + ci) % 8];
        T(lead + 12, t, STEP * 2, { type: 'square', gain: 0.035, attack: 0.01, release: 0.1, cutoff: 3500 });
      }
    },
  },
  {
    // 8 one-bar chords: Gm9 | Ebmaj7 | Cm9 | D7b9, then Cm9 | Dm7b5-G7 | Ebmaj7 | D7b9. Root first, bass plays root - 12.
    id: 'hiphop', name: 'Hip Hop: Boom-Bap Box Shuffle (92 BPM)', bpm: 92, chordSteps: 16,
    chords: [[55, 58, 62, 65, 69], [51, 55, 58, 62, 65], [48, 51, 58, 62, 67], [50, 54, 57, 60, 63],
      [48, 51, 58, 62, 67], [50, 53, 56, 60, 65], [51, 55, 58, 62, 65], [50, 54, 57, 60, 63]],
    step(k, t, chord, ci) {
      const sw = k % 2 ? STEP * 0.3 : 0; // lazy MPC swing on the off 16ths
      const odd = ci % 2 === 1, endBar = ci % 4 === 3;
      // Drums: kick pattern alternates each bar, snare on 2 and 4 with quiet ghost notes.
      if ((odd ? [0, 3, 10, 13] : [0, 7, 10]).includes(k)) kick(t);
      if (k === 4 || k === 12) { ND(t, 0.17, { gain: 0.17, cutoff: 1600, type: 'bandpass' }); ND(t, 0.06, { gain: 0.09, cutoff: 500, type: 'lowpass' }); }
      if (odd && (k === 7 || k === 15)) ND(t + sw, 0.05, { gain: 0.04, cutoff: 1600, type: 'bandpass' });
      if (endBar && k >= 12 && k % 1 === 0 && k !== 12) ND(t, 0.06, { gain: 0.05 + (k - 12) * 0.02, cutoff: 1600, type: 'bandpass' });
      if (k % 2 === 0) ND(t, 0.035, { gain: k % 4 === 0 ? 0.06 : 0.04 });
      if (k === 14 && !odd) ND(t + sw, 0.14, { gain: 0.05, cutoff: 6000 });
      // Vinyl crackle.
      if (Math.random() < 0.25) noise(trackBus, t + Math.random() * STEP, 0.01, { gain: 0.012, cutoff: 4000 });
      // Round sub bass: root, octave pop, fifth walk.
      const bass = { 0: 0, 3: 0, 6: 12, 8: 0, 11: 7, 14: 5 }[k];
      if (bass !== undefined && !(endBar && k >= 12)) T(chord[0] - 12 + bass, t + sw, STEP * 2.6, { type: 'sine', gain: 0.24, attack: 0.008, release: 0.15 });
      // Dusty electric-piano comping (offbeat stabs) over a soft pad.
      if (k === 0) pad(chord, t, 16 * STEP + 0.4, { gain: 0.03, cutoff: 800 });
      if ([0, 5, 10].includes(k) || (odd && k === 13)) {
        chord.slice(1).forEach((m, i) => T(m + 12, t + sw + i * 0.008, STEP * 2.2, { type: i % 2 ? 'sine' : 'triangle', gain: 0.045, attack: 0.004, release: 0.25, cutoff: 2400 }));
      }
      // Four-bar flute-like hook (G minor pentatonic), a bar of rest-and-answer each phrase.
      const HOOK = [{ 2: 77, 4: 74, 6: 72, 10: 70 }, { 2: 70, 5: 72, 8: 74, 12: 72 }, { 0: 75, 3: 74, 6: 72, 8: 70, 12: 67 }, { 2: 70, 6: 74, 10: 72, 11: 70 }][ci % 4];
      const hm = HOOK[k];
      if (hm !== undefined && Math.floor(ci / 4) % 2 === 0) T(hm, t + sw, STEP * 2.4, { type: 'sine', gain: 0.07, attack: 0.03, release: 0.25, cutoff: 3000 });
      else if (hm !== undefined) T(hm - 5, t + sw, STEP * 2.4, { type: 'triangle', gain: 0.05, attack: 0.03, release: 0.25, cutoff: 2000 });
    },
  },
  {
    id: 'rap', name: 'Rap: Trap Fork 808 (140 BPM)', bpm: 140, chordSteps: 32,
    chords: [[45, 48, 52], [41, 45, 48], [43, 46, 50], [40, 44, 47],
      [45, 48, 52], [43, 46, 50], [41, 45, 48], [40, 44, 47]],
    step(k, t, chord, ci, n) {
      const beat = k % 16;
      if (k === 0) pad(chord.map((m) => m + 12), t, 32 * STEP + 0.5, { gain: 0.03, cutoff: 800 });
      // Half-time feel: kick on 1 and the "and" of 2, clap on 3, rolling hats with bursts.
      if (beat === 0 || beat === 7 || beat === 10) kick(t);
      if (beat === 8) { ND(t, 0.2, { gain: 0.18, cutoff: 1800, type: 'bandpass' }); ND(t + 0.012, 0.15, { gain: 0.1, cutoff: 1400, type: 'bandpass' }); }
      ND(t, 0.03, { gain: beat % 4 === 0 ? 0.05 : 0.03 });
      if (k % 16 === 14 || (ci % 2 === 1 && k % 16 === 6)) ND(t + STEP / 2, 0.025, { gain: 0.035 });
      // Sliding 808 sub.
      if ([0, 7, 10, 14].includes(beat)) {
        const o = T(chord[0] - 12, t, STEP * (beat === 0 ? 6 : 2.5), { type: 'sine', gain: 0.3, attack: 0.005, release: 0.2 });
        if (beat === 14) { o.frequency.setValueAtTime(mtof(chord[0] - 12), t); o.frequency.linearRampToValueAtTime(mtof(chord[0] - 5), t + STEP * 2.5); }
      }
      // Eerie bell melody.
      if (k % 4 === 0 || k % 16 === 11) T(chord[(n >> 2) % 3] + 24, t, STEP * 3, { type: 'sine', gain: 0.05, attack: 0.003, release: 0.5 });
    },
  },
  {
    id: 'classical', name: 'Classical: Canon in Fork Major (72 BPM)', bpm: 72, chordSteps: 16,
    chords: [[50, 57, 62, 66], [45, 57, 61, 64], [47, 54, 62, 66], [42, 54, 61, 64], [43, 55, 62, 67], [50, 57, 62, 66], [43, 55, 62, 67], [45, 57, 61, 64],
      [47, 54, 59, 62], [43, 50, 55, 59], [45, 52, 57, 61], [38, 45, 50, 54], [43, 50, 55, 59], [38, 45, 50, 54], [43, 50, 55, 59], [45, 57, 61, 64]],
    step(k, t, chord) {
      if (k === 0) {
        pad(chord, t, 16 * STEP + 0.6, { gain: 0.045, cutoff: 1800, type: 'sawtooth' });
        T(chord[0] - 12, t, STEP * 8, { type: 'sine', gain: 0.18, attack: 0.03, release: 0.4 });
      }
      if (k === 8) T(chord[0] - 12, t, STEP * 8, { type: 'sine', gain: 0.12, attack: 0.03, release: 0.4 });
      // Harpsichord-ish plucked arpeggio, bright and short.
      const m = chord[[1, 2, 3, 2][k % 4]] + 12;
      T(m + (k % 8 === 4 ? 12 : 0), t, STEP * 1.6, { type: 'sawtooth', gain: 0.045, attack: 0.003, release: 0.25, cutoff: 2800 });
    },
  },
  {
    id: 'chiptune', name: 'Chiptune: 8-Bit Pallet Hero (150 BPM)', bpm: 150, chordSteps: 32,
    chords: [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62],
      [62, 65, 69], [55, 59, 62], [57, 60, 64], [55, 59, 62], [60, 64, 67], [64, 67, 71], [65, 69, 72], [67, 71, 74]],
    step(k, t, chord) {
      const beat = k % 16;
      // Pulse-wave arpeggio, triangle bass, noise drums.
      T(chord[k % 3] + 12 + (k % 8 >= 4 ? 12 : 0), t, STEP * 0.9, { type: 'square', gain: 0.05, attack: 0.002, release: 0.04 });
      if (k % 2 === 0) T(chord[0] - 12 + (k % 4 === 2 ? 12 : 0), t, STEP * 1.8, { type: 'triangle', gain: 0.2, attack: 0.002, release: 0.05 });
      if (beat % 8 === 0) kick(t);
      if (beat === 4 || beat === 12) ND(t, 0.09, { gain: 0.1, cutoff: 3000, type: 'bandpass' });
      if (beat % 2 === 0) ND(t, 0.02, { gain: 0.03, cutoff: 9000 });
      // Heroic lead on the second half of each two-bar phrase.
      if (k >= 16 && k % 2 === 0) {
        const mel = [0, 2, 4, 2, 5, 4, 2, 0][(k - 16) / 2];
        T(chord[0] + 24 + [0, 2, 4, 7, 9, 12][Math.min(mel, 5)], t, STEP * 1.9, { type: 'square', gain: 0.04, attack: 0.002, release: 0.05 });
      }
    },
  },
];

// Public-domain MIDI songs from the Mutopia Project (see assets/midi/CREDITS.md).
const MIDI_TRACKS = [
  { id: 'rag-pineapple', name: 'Ragtime: Pineapple Rag', midi: 'assets/midi/pineapple-rag.mid' },
  { id: 'rag-elite', name: 'Ragtime: Elite Syncopations', midi: 'assets/midi/elite-syncopations.mid' },
  { id: 'rag-strenuous', name: 'Ragtime: The Strenuous Life', midi: 'assets/midi/strenuous-life.mid' },
  { id: 'bach-269', name: 'Bach: Chorale BWV 269', midi: 'assets/midi/bach-bwv269.mid' },
];
TRACKS.push(...MIDI_TRACKS);

const songs = new Map(); // url -> parsed song, or 'loading'
let song = null, songStart = 0, songIdx = 0;

function loadSong(tr) {
  const got = songs.get(tr.midi);
  if (got && got !== 'loading') return got;
  if (!got) {
    songs.set(tr.midi, 'loading');
    fetch(tr.midi).then((r) => r.arrayBuffer()).then((b) => {
      songs.set(tr.midi, parseMidi(b));
      if (ctx) tick();
    }).catch(() => songs.delete(tr.midi));
  }
  return null;
}

// Plays notes of the current MIDI track with a soft piano-ish voice, looping at the end.
function midiTick() {
  const tr = TRACKS[trackIdx];
  if (!song) {
    song = loadSong(tr);
    if (!song) return;
    songStart = ctx.currentTime + 0.1;
    songIdx = 0;
  }
  const horizon = ctx.currentTime + 0.4;
  for (;;) {
    if (songIdx >= song.notes.length) {
      const end = songStart + song.duration + 1.5;
      if (end > horizon) return;
      songStart = end;
      songIdx = 0;
    }
    const n = song.notes[songIdx];
    const t = songStart + n.t;
    if (t >= horizon) return;
    songIdx++;
    if (t < ctx.currentTime) continue;
    const dur = Math.min(Math.max(n.dur, 0.12), 2.5);
    const g = 0.14 * (0.4 + 0.6 * n.vel / 127);
    tone(trackBus, mtof(n.note), t, dur + 0.25, { type: 'triangle', gain: g, attack: 0.008, release: dur + 0.2, cutoff: 3000 });
    tone(trackBus, mtof(n.note), t, dur * 0.5 + 0.1, { type: 'sine', gain: g * 0.5, attack: 0.005, release: dur * 0.5 });
  }
}

export const MUSIC_TRACKS = TRACKS.map(({ id, name }) => ({ id, name }));

function applyTrack() {
  const tr = TRACKS[trackIdx];
  STEP = 60 / (tr.bpm || 120) / 4;
  stepIdx = 0;
  song = null;
  if (!ctx) return;
  const old = trackBus;
  if (old) {
    old.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
    setTimeout(() => old.disconnect(), 1500);
  }
  trackBus = ctx.createGain();
  trackBus.connect(musicBus);
  nextStep = ctx.currentTime + 0.1;
}

{
  const saved = TRACKS.findIndex((t) => t.id === localStorage.getItem(TRACK_KEY));
  trackIdx = Math.max(0, saved);
  STEP = 60 / (TRACKS[trackIdx].bpm || 120) / 4;
}

export function getMusicTrack() { return TRACKS[trackIdx].id; }
export function setMusicTrack(id) {
  const i = TRACKS.findIndex((t) => t.id === id);
  if (i < 0 || i === trackIdx) return;
  trackIdx = i;
  localStorage.setItem(TRACK_KEY, id);
  applyTrack();
  if (ctx) tick();
}

function scheduleStep(i, t) {
  const tr = TRACKS[trackIdx];
  const loop = tr.chordSteps * tr.chords.length;
  const ci = Math.floor(i / tr.chordSteps) % tr.chords.length;
  const sec = Math.floor(i / loop) % 4;
  const k = i % tr.chordSteps;
  const chord = tr.chords[ci];
  // Fourth pass: first half is a drumless breakdown, second half builds back with extra hats.
  thin = sec === 3 && ci < tr.chords.length / 2;
  tr.step(k, t, chord, ci, i);
  if (sec === 3 && !thin && k % 2 === 1) noise(trackBus, t, 0.02, { gain: 0.03, cutoff: 9000 });
  // Second and third pass: a high countermelody that changes shape each time.
  if ((sec === 1 || sec === 2) && k % 4 === (sec === 1 ? 2 : 0)) {
    const m = chord[(k / 2 + ci + sec) % chord.length] + 24;
    T(m, t, STEP * 3, { type: 'sine', gain: 0.045, attack: 0.01, release: 0.4 });
  }
}

function tick() {
  if (!ctx) return;
  if (TRACKS[trackIdx].midi) { midiTick(); return; }
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

export function isAllMuted() { return allMuted; }
export function setAllMuted(m) {
  allMuted = m;
  localStorage.setItem(ALL_KEY, m ? '1' : '0');
  if (ctx) master.gain.setTargetAtTime(m ? 0 : MASTER_VOL, ctx.currentTime, 0.03);
}

export function isMusicMuted() { return muted; }

const ENGINE_KEY = 'forklift-engine-off';
let engineOn = localStorage.getItem(ENGINE_KEY) !== '1';
export function isEngineOn() { return engineOn; }
export function setEngineOn(on) {
  engineOn = on;
  localStorage.setItem(ENGINE_KEY, on ? '0' : '1');
  if (!on && engine && ctx) engine.g.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
  if (!on && beeper && ctx) beeper.g.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
}

export function setMusicMuted(m) {
  if (m !== muted) toggleMusic();
}

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

// Splintering crack of a damaged box: noise burst plus a few woody clicks.
export function playBreak() {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  noise(sfxBus, t, 0.18, { gain: 0.3, cutoff: 1400, type: 'bandpass' });
  for (let i = 0; i < 3; i++) {
    const o = tone(sfxBus, 1, t + i * 0.035, 0.08, { type: 'square', gain: 0.1, attack: 0.002, release: 0.05, cutoff: 1500 });
    o.frequency.cancelScheduledValues(t);
    o.frequency.setValueAtTime(260 - i * 50, t + i * 0.035);
    o.frequency.exponentialRampToValueAtTime(60, t + i * 0.035 + 0.08);
  }
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
  if (!ctx || ctx.state !== 'running' || !engineOn) return;
  if (!engine) startEngine();
  const v = Math.min(1, Math.abs(speed) / 4);
  const t = ctx.currentTime;
  const pitch = 110 + v * 520 + (throttle ? 25 : 0);
  engine.o.frequency.setTargetAtTime(pitch, t, 0.08);
  engine.o2.frequency.setTargetAtTime(pitch * 2, t, 0.08);
  engine.f.frequency.setTargetAtTime(500 + v * 1800, t, 0.1);
  engine.g.gain.setTargetAtTime(0.012 + v * 0.05 + (throttle ? 0.01 : 0), t, 0.1);
  setBeeper(speed < -0.05, t);
}

// Reversing warning: 1 kHz square beep, 0.4 s on / 0.4 s off while backing up.
function setBeeper(reversing, t) {
  if (!beeper) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = 1000;
    g.gain.value = 0;
    o.connect(g);
    g.connect(sfxBus);
    o.start();
    beeper = { o, g };
  }
  const on = reversing && t % 0.8 < 0.4;
  beeper.g.gain.setTargetAtTime(on ? 0.02 : 0, t, 0.005);
}
