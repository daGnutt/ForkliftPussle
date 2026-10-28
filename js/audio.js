// Web Audio: public-domain MIDI background songs (muteable) plus procedural sound effects. Browser only.
import { parseMidi } from './midi.js';

const MUTE_KEY = 'forklift-music-muted';

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const MUSIC_VOL = 0.35;
const SFX_VOL = 0.5;
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
  sfxBus.gain.value = SFX_VOL;
  sfxBus.connect(master);

  // Music bus: cut low-mid mud, add a little presence, glue with a gentle compressor.
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 35;
  const mud = ctx.createBiquadFilter();
  mud.type = 'peaking';
  mud.frequency.value = 280;
  mud.Q.value = 0.9;
  mud.gain.value = -4;
  const air = ctx.createBiquadFilter();
  air.type = 'highshelf';
  air.frequency.value = 4500;
  air.gain.value = 3;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.ratio.value = 3;
  comp.attack.value = 0.01;
  comp.release.value = 0.2;
  musicBus.connect(hp);
  hp.connect(mud);
  mud.connect(air);
  air.connect(comp);
  comp.connect(master);

  // Short, dark-but-clear feedback delay as a cheap reverb; lows are removed so it doesn't cloud the mix.
  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0.3;
  const fb = ctx.createGain();
  fb.gain.value = 0.25;
  const send = ctx.createGain();
  send.gain.value = 0.5;
  const wetHp = ctx.createBiquadFilter();
  wetHp.type = 'highpass';
  wetHp.frequency.value = 400;
  const damp = ctx.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = 3200;
  air.connect(send);
  send.connect(delay);
  delay.connect(wetHp);
  wetHp.connect(damp);
  damp.connect(fb);
  fb.connect(delay);
  damp.connect(master);
  applyTrack();
}

function tone(dest, freq, t, dur, { type = 'sine', gain = 0.2, attack = 0.02, release = 0.2, cutoff = 0, cutoffEnd = 0, q = 0.7, hp = 0, decay = 0, detune = 0 } = {}) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (detune) o.detune.value = detune;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  if (decay) {
    // Percussive body: exponential fall towards a quiet sustain, then a short release.
    g.gain.exponentialRampToValueAtTime(gain * 0.25, t + attack + decay);
    g.gain.setValueAtTime(gain * 0.25, t + Math.max(attack + decay, dur - release));
  } else {
    g.gain.setValueAtTime(gain, t + Math.max(attack, dur - release));
  }
  g.gain.linearRampToValueAtTime(0, t + dur);
  let out = o;
  if (cutoff) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = q;
    f.frequency.setValueAtTime(cutoff, t);
    // Bright attack that mellows out, like a plucked or struck string.
    if (cutoffEnd) f.frequency.exponentialRampToValueAtTime(cutoffEnd, t + Math.min(dur, 0.4));
    out.connect(f);
    out = f;
  }
  if (hp) {
    const h = ctx.createBiquadFilter();
    h.type = 'highpass';
    h.frequency.value = hp;
    out.connect(h);
    out = h;
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

// Public-domain / CC0 MIDI songs (sources in assets/midi/CREDITS.md).
const TRACKS = [
  { id: 'country-hoedown', name: 'Country: Hee-Haw Hoedown', midi: 'assets/midi/hoedown.mid' },
  { id: 'classical-elise', name: 'Classical: Für Forklift', midi: 'assets/midi/fur-elise.mid' },
  { id: 'classical-turca', name: 'Classical: Rondo alla Turbo', midi: 'assets/midi/rondo-alla-turca.mid' },
  { id: 'waltz-dead-pallets', name: 'Gothic Waltz: Dance of the Dead Pallets', midi: 'assets/midi/death-waltz.mid' },
  { id: 'industrial-gears', name: 'Industrial Metal: Gears of Grind', midi: 'assets/midi/gears.mid' },
  { id: 'metal-math', name: 'Math Metal: Pallet Algebra', midi: 'assets/midi/math-metal.mid' },
  { id: 'techno-trance', name: 'Techno: Trance of the Pallet Gods', midi: 'assets/midi/gods-of-trance.mid' },
  { id: 'synthwave-neon', name: 'Synthwave: Neon Warehouse', midi: 'assets/midi/vaporwave.mid' },
  { id: 'rock-arena', name: 'Arena Rock: Stadium Forklift', midi: 'assets/midi/arena-rock.mid' },
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
    voice(n, t);
  }
}

// Tiny General MIDI-ish synth: drums from noise/sine, guitars as filtered saws, bass, leads, piano-like default.
// Voices avoid long sustains and keep lows to the bass/kick so the mix stays clear.
function voice(n, t) {
  const v = n.vel / 127;
  const g = 0.14 * (0.4 + 0.6 * v);
  if (n.drum) {
    const k = n.note;
    if (k === 35 || k === 36) {
      const o = ctx.createOscillator(), e = ctx.createGain();
      o.frequency.setValueAtTime(160, t);
      o.frequency.exponentialRampToValueAtTime(48, t + 0.09);
      e.gain.setValueAtTime(g * 2, t);
      e.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      o.connect(e);
      e.connect(trackBus);
      o.start(t);
      o.stop(t + 0.2);
      noise(trackBus, t, 0.015, { gain: g * 0.8, cutoff: 3000 }); // beater click
    } else if (k === 38 || k === 40) {
      noise(trackBus, t, 0.16, { gain: g * 1.1, cutoff: 2500, type: 'highpass' });
      tone(trackBus, 190, t, 0.1, { type: 'triangle', gain: g * 0.9, attack: 0.001, release: 0.09 });
    } else if (k === 37 || k === 39) {
      noise(trackBus, t, 0.08, { gain: g * 1.1, cutoff: 2000, type: 'bandpass' });
    } else if (k === 42 || k === 44) {
      noise(trackBus, t, 0.035, { gain: g * 0.5, cutoff: 8000 });
    } else if (k === 46 || k === 49 || k === 51 || k === 57 || k === 59) {
      noise(trackBus, t, 0.25, { gain: g * 0.4, cutoff: 7000 });
    } else if (k >= 41 && k <= 50) {
      tone(trackBus, mtof(40 + (k - 41) * 2.5), t, 0.18, { type: 'sine', gain: g * 1.3, attack: 0.002, release: 0.15 });
    } else {
      noise(trackBus, t, 0.05, { gain: g * 0.5, cutoff: 5000 });
    }
    return;
  }
  const dur = Math.min(Math.max(n.dur, 0.12), 2.5);
  const f = mtof(n.note);
  const p = n.prog;
  const bright = 1.5 + 2.5 * v; // harder notes are brighter
  if (p >= 24 && p <= 31) { // guitars: two detuned saws, lows removed
    const dist = p >= 29;
    const cut = Math.min(f * (dist ? 8 : 6), 7000);
    for (const d of [-7, 7]) {
      tone(trackBus, f, t, dur + 0.08, { type: 'sawtooth', gain: g * (dist ? 0.4 : 0.32), attack: 0.004, release: 0.08, cutoff: cut, cutoffEnd: cut * 0.5, q: dist ? 2 : 1, hp: 110, detune: d, decay: dist ? 0 : 0.35 });
    }
  } else if (p >= 32 && p <= 39) { // bass: saw body for definition plus a sine sub
    tone(trackBus, f, t, dur + 0.04, { type: 'sawtooth', gain: g * 0.55, attack: 0.004, release: 0.06, cutoff: Math.max(f * 5, 500), cutoffEnd: Math.max(f * 2.5, 300), q: 2, decay: 0.25 });
    tone(trackBus, f, t, dur + 0.04, { type: 'sine', gain: g * 0.9, attack: 0.004, release: 0.06 });
  } else if (p >= 80 && p <= 103) { // synth leads/pads
    for (const d of [-6, 6]) {
      tone(trackBus, f, t, dur + 0.05, { type: 'sawtooth', gain: g * 0.22, attack: 0.006, release: 0.1, cutoff: Math.min(f * 7, 7000), q: 1.2, hp: 150, detune: d });
    }
  } else if (p >= 48 && p <= 55) { // strings/ensemble
    for (const d of [-8, 8]) {
      tone(trackBus, f, t, dur + 0.2, { type: 'sawtooth', gain: g * 0.2, attack: 0.07, release: 0.2, cutoff: Math.min(f * 5, 5000), hp: 140, detune: d });
    }
  } else { // piano-ish: bright struck attack that decays quickly, short release
    const cut = Math.min(f * bright * 2, 9000);
    tone(trackBus, f, t, Math.min(dur + 0.15, 1.6), { type: 'sawtooth', gain: g * 0.55, attack: 0.002, release: 0.12, cutoff: cut, cutoffEnd: Math.max(f * 1.5, 500), decay: 0.3, hp: f < 200 ? 0 : 120 });
    tone(trackBus, f, t, Math.min(dur + 0.1, 1.2), { type: 'triangle', gain: g * 0.5, attack: 0.002, release: 0.1, decay: 0.25 });
    tone(trackBus, f * 2, t, 0.25, { type: 'sine', gain: g * 0.25, attack: 0.001, release: 0.2 });
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
// With keepMusic (pause menu) only the sound effects are muted and the music keeps playing.
export function setSilenced(s, keepMusic = false) {
  silenced = s && !keepMusic;
  if (!ctx) return;
  sfxBus.gain.setTargetAtTime(s ? 0 : SFX_VOL, ctx.currentTime, 0.02);
  if (silenced) ctx.suspend(); else ctx.resume();
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

// Soft hydraulic hum with a little fluid hiss, sweeping up (raise) or down (lower).
export function playFork(up) {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime, dur = 0.34;
  const o = tone(sfxBus, 1, t, dur, { type: 'triangle', gain: 0.1, attack: 0.06, release: 0.14, cutoff: 700 });
  o.frequency.cancelScheduledValues(t);
  o.frequency.setValueAtTime(up ? 110 : 190, t);
  o.frequency.linearRampToValueAtTime(up ? 190 : 110, t + dur);
  noise(sfxBus, t, dur, { gain: 0.05, cutoff: 1800, type: 'bandpass' });
}

// Descending buzz when the forks are refused a move through a box.
export function playBlocked() {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime, dur = 0.35;
  const o = tone(sfxBus, 1, t, dur, { type: 'triangle', gain: 0.16, attack: 0.01, release: 0.12, cutoff: 600 });
  o.frequency.cancelScheduledValues(t);
  o.frequency.setValueAtTime(200, t);
  o.frequency.exponentialRampToValueAtTime(80, t + dur);
}

// Splintering crack of a damaged box: noise burst plus a few woody clicks.
export function playBreak() {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  noise(sfxBus, t, 0.18, { gain: 0.22, cutoff: 1400, type: 'bandpass' });
  for (let i = 0; i < 3; i++) {
    const o = tone(sfxBus, 1, t + i * 0.035, 0.08, { type: 'triangle', gain: 0.14, attack: 0.002, release: 0.05, cutoff: 1500 });
    o.frequency.cancelScheduledValues(t);
    o.frequency.setValueAtTime(260 - i * 50, t + i * 0.035);
    o.frequency.exponentialRampToValueAtTime(60, t + i * 0.035 + 0.08);
  }
}

// Dull thud of hitting a wall head-on; power 0..1.
export function playBonk(power = 0.5) {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime, k = 0.5 + power;
  const o = tone(sfxBus, 1, t, 0.22, { type: 'sine', gain: 0.7 * k, attack: 0.003, release: 0.15 });
  o.frequency.cancelScheduledValues(t);
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.18);
  noise(sfxBus, t, 0.06, { gain: 0.45 * k, cutoff: 900, type: 'lowpass' });
}

// Metal scraping along a wall: gritty filtered noise whose level and pitch follow the sliding speed (0 = silent).
let scrapeNode = null;
export function setScrape(speed) {
  if (!ctx || ctx.state !== 'running') return;
  if (!scrapeNode) {
    if (speed <= 0) return;
    if (!noiseBuf) noise(sfxBus, ctx.currentTime, 0.01, { gain: 0 });
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f);
    f.connect(g);
    g.connect(sfxBus);
    src.start();
    scrapeNode = { f, g };
  }
  const t = ctx.currentTime, v = Math.min(1, speed / 4);
  scrapeNode.f.frequency.setTargetAtTime(900 + v * 1300, t, 0.05);
  scrapeNode.g.gain.setTargetAtTime(speed > 0 ? 0.05 + v * 0.12 : 0, t, 0.04);
}

// Cheerful rising arpeggio when a zone is filled.
export function playSuccess() {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  [72, 76, 79, 84].forEach((m, i) => {
    tone(sfxBus, mtof(m), t + i * 0.09, 0.5, { type: 'sine', gain: 0.14, attack: 0.008, release: 0.4 });
    tone(sfxBus, mtof(m) * 2, t + i * 0.09, 0.35, { type: 'sine', gain: 0.04, attack: 0.005, release: 0.3 });
  });
}

// Electric motor: a low, soft hum (triangle + sub sine) whose pitch and level follow the forklift speed.
function startEngine() {
  const o = ctx.createOscillator();
  const o2 = ctx.createOscillator();
  const f = ctx.createBiquadFilter();
  const g = ctx.createGain();
  o.type = 'triangle';
  o2.type = 'sine';
  f.type = 'lowpass';
  f.frequency.value = 350;
  f.Q.value = 0.5;
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
  const pitch = 55 + v * 80 + (throttle ? 6 : 0);
  engine.o.frequency.setTargetAtTime(pitch, t, 0.15);
  engine.o2.frequency.setTargetAtTime(pitch * 0.5, t, 0.15);
  engine.f.frequency.setTargetAtTime(250 + v * 350, t, 0.15);
  engine.g.gain.setTargetAtTime(v < 0.02 && !throttle ? 0.008 : 0.02 + v * 0.05, t, 0.15);
  setBeeper(speed < -0.05, t);
}

// Reversing warning: 880 Hz soft sine beep, 0.4 s on / 0.4 s off while backing up.
function setBeeper(reversing, t) {
  if (!beeper) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.value = 0;
    o.connect(g);
    g.connect(sfxBus);
    o.start();
    beeper = { o, g };
  }
  const on = reversing && t % 0.8 < 0.4;
  beeper.g.gain.setTargetAtTime(on ? 0.035 : 0, t, 0.01);
}
