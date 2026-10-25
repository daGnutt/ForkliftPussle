// Web Audio: public-domain MIDI background songs (muteable) plus procedural sound effects. Browser only.
import { parseMidi } from './midi.js';

const MUTE_KEY = 'forklift-music-muted';

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const MUSIC_VOL = 0.35;
const TRACK_KEY = 'forklift-music-track';

let ctx = null, master = null, musicBus = null, sfxBus = null;
let muted = localStorage.getItem(MUTE_KEY) === '1';
let timer = null, noiseBuf = null;
let trackIdx = 0, trackBus = null;
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

// Public-domain MIDI songs from the Mutopia Project (see assets/midi/CREDITS.md).
const TRACKS = [
  { id: 'rag-pineapple', name: 'Ragtime: Pineapple Rag', midi: 'assets/midi/pineapple-rag.mid' },
  { id: 'rag-elite', name: 'Ragtime: Elite Syncopations', midi: 'assets/midi/elite-syncopations.mid' },
  { id: 'rag-strenuous', name: 'Ragtime: The Strenuous Life', midi: 'assets/midi/strenuous-life.mid' },
  { id: 'bach-269', name: 'Bach: Chorale BWV 269', midi: 'assets/midi/bach-bwv269.mid' },
];

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
  song = null;
  if (!ctx) return;
  const old = trackBus;
  if (old) {
    old.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
    setTimeout(() => old.disconnect(), 1500);
  }
  trackBus = ctx.createGain();
  trackBus.connect(musicBus);
}

{
  const saved = TRACKS.findIndex((t) => t.id === localStorage.getItem(TRACK_KEY));
  trackIdx = Math.max(0, saved);
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

function tick() {
  if (ctx) midiTick();
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
