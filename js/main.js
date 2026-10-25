import { newGame, update, forkUp, forkDown, zoneDone, score } from './game.js';
import { createInput } from './input.js';
import { getBest, lowestUnscored, beats, saveBest, finalScore, timePenalty, formatTime } from './highscores.js';
import { serializeGame, deserializeGame, encodeState, decodeState } from './savestate.js';
import { parseSeed } from './level.js';
import { draw } from './render.js';
import { debugEnabled, createDebug } from './debug.js';
import { decalsEnabled, setDecalsEnabled } from './decals.js';
import { startAudio, playFork, playBlocked, playBreak, playBonk, setScrape, playSuccess, setEngine, setSilenced, isMusicMuted, setMusicMuted, MUSIC_TRACKS, getMusicTrack, setMusicTrack, isEngineOn, setEngineOn, isAllMuted, setAllMuted } from './audio.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });
const view = { width: 0, height: 0, dpr: 1, povBig: localStorage.getItem('forklift-cab-view') === '1', showSmall: false };

function resize() {
  view.width = canvas.clientWidth;
  view.height = canvas.clientHeight;
  view.dpr = window.devicePixelRatio || 1;
  // Phones report a dpr of ~3 (9x the pixels); cap the backing store so drawing stays fast, CSS scales it up.
  if (matchMedia('(pointer: coarse)').matches) view.dpr = Math.min(view.dpr, 1, Math.sqrt(0.9e6 / Math.max(1, view.width * view.height)));
  canvas.width = Math.round(view.width * view.dpr);
  canvas.height = Math.round(view.height * view.dpr);
}
window.addEventListener('resize', resize);
resize();

let level = Number(localStorage.getItem('forklift-level')) || 1;
let seedText = localStorage.getItem('forklift-seed') || '';
let seed = parseSeed(seedText);
let hard = localStorage.getItem('forklift-hard') === '1';
let game = newGame(level, seed, hard);
function loadSaved() {
  try {
    const data = JSON.parse(localStorage.getItem('forklift-state'));
    if (data && data.level === level && data.seed === seed && data.hard === hard) game = deserializeGame(data);
  } catch { localStorage.removeItem('forklift-state'); }
}
loadSaved();
function saveState() {
  localStorage.setItem('forklift-state', JSON.stringify(serializeGame(game, seedText)));
}
const countDone = () => game.zones.filter((z) => zoneDone(game, z)).length;
let doneZones = countDone();
let hitCount = 0;
let bonkCount = 0;
view.best = getBest(localStorage, seed, level);
let recordOpen = false, recorded = false;
const recordEl = document.getElementById('record');
const recordName = document.getElementById('recordName');

function closeRecord() {
  recordOpen = false;
  recordEl.classList.add('hide');
  recordName.blur();
  input.clear();
}

function load(n) {
  if (recordOpen) closeRecord();
  recorded = false;
  level = Math.max(1, n);
  localStorage.setItem('forklift-level', String(level));
  game = newGame(level, seed, hard);
  doneZones = countDone();
  hitCount = game.hitCount;
  bonkCount = game.bonks;
  view.best = getBest(localStorage, seed, level);
  saveState();
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

const input = createInput({
  anyKey: startAudio,
  fullscreen: toggleFullscreen,
  toggleSmall: () => { view.showSmall = !view.showSmall; },
  swapView: () => {
    view.povBig = !view.povBig;
    localStorage.setItem('forklift-cab-view', view.povBig ? '1' : '0');
    if (tutStep === 3 && view.povBig) nextTutorial();
  },
  up: () => {
    const h = game.H;
    if (forkUp(game) === 'blocked') playBlocked();
    else if (game.H !== h) playFork(true);
  },
  down: () => {
    const h = game.H;
    if (forkDown(game) === 'blocked') playBlocked();
    else if (game.H !== h) playFork(false);
  },
  restart: () => load(level),
  next: () => { if (game.status === 'won') load(level + 1); },
  menu: () => { if (!splashOn && !recordOpen) toggleMenu(true); },
  pause: () => { if (!splashOn && !recordOpen) toggleMenu(true); },
});

const pending = {};
recordName.addEventListener('keydown', (e) => e.stopPropagation());
document.getElementById('recordForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = recordName.value.trim() || 'Anonymous';
  localStorage.setItem('forklift-player', name);
  saveBest(localStorage, pending.seed, pending.level, { ...pending.result, name });
  if (pending.level === level && pending.seed === seed) view.best = getBest(localStorage, seed, level);
  closeRecord();
});

function checkRecord() {
  if (game.status !== 'won' || recorded) return;
  recorded = true;
  const result = { score: finalScore(score(game), game.time), time: game.time };
  if (!beats(result, getBest(localStorage, seed, level))) return;
  Object.assign(pending, { seed, level, result });
  document.getElementById('recordInfo').textContent = `Level ${level}: ${score(game)} − ${timePenalty(game.time)} time = ${result.score} points (${formatTime(result.time)})`;
  recordName.value = localStorage.getItem('forklift-player') || '';
  recordOpen = true;
  recordEl.classList.remove('hide');
  input.clear();
  recordName.focus();
}

const splash = document.getElementById('splash');
let splashOn = true;
const seedInput = document.getElementById('seed');
seedInput.value = seedText;

const TUTORIAL = [
  'Use <b>↑/↓</b> to drive and <b>←/→</b> to steer (the rear wheels steer!). <b>Space</b> brakes.',
  'Press <b>A</b> to raise the forks and <b>Z</b> to lower them.',
  'Drive the forks under a stack, lift it, and set it down on the matching coloured zone. Then park on the marked spot.',
  'If you want an more immersive experience, press <b>Tab</b> or <b>M</b> to switch to the cab view (and again to return to the overview).',
];
const tutorialEl = document.getElementById('tutorial');
let tutStep = localStorage.getItem('forklift-tutorial-done') ? -1 : 0;
function showTutorial() {
  tutorialEl.classList.toggle('hide', tutStep < 0);
  if (tutStep >= 0) tutorialEl.innerHTML = `<small>Tutorial ${tutStep + 1}/${TUTORIAL.length}</small>${TUTORIAL[tutStep]}`;
}
function nextTutorial() {
  tutStep = tutStep + 1 >= TUTORIAL.length ? -1 : tutStep + 1;
  if (tutStep < 0) localStorage.setItem('forklift-tutorial-done', '1');
  showTutorial();
}
let tutStart = { x: game.fl.x, y: game.fl.y };
function checkTutorial() {
  if (tutStart.g !== game) tutStart = { x: game.fl.x, y: game.fl.y, g: game };
  if (tutStep < 0) return;
  const g = game;
  if (tutStep === 0 && Math.hypot(g.fl.x - tutStart.x, g.fl.y - tutStart.y) > 0.5) nextTutorial();
  else if (tutStep === 1 && g.H !== 0) nextTutorial();
  else if (tutStep === 2 && countDone() > 0) nextTutorial();
}
const tutorialOpt = document.getElementById('tutorialOpt');
tutorialOpt.checked = tutStep >= 0;
const hardOpt = document.getElementById('hardOpt');
hardOpt.checked = hard;
showTutorial();

function startGame() {
  const text = seedInput.value.trim();
  if (text !== seedText) {
    seedText = text;
    seed = parseSeed(text);
    localStorage.setItem('forklift-seed', text);
    load(1);
  }
  if (hardOpt.checked !== hard) {
    hard = hardOpt.checked;
    localStorage.setItem('forklift-hard', hard ? '1' : '0');
    load(level);
  }
  view.best = getBest(localStorage, seed, level);
  if (tutorialOpt.checked) {
    localStorage.removeItem('forklift-tutorial-done');
    tutStep = 0;
  } else {
    tutStep = -1;
    localStorage.setItem('forklift-tutorial-done', '1');
  }
  showTutorial();
  splashOn = false;
  splash.classList.add('hide');
  seedInput.blur();
  last = performance.now();
}

document.getElementById('seedRandom').addEventListener('click', () => {
  seedInput.value = String(1 + Math.floor(Math.random() * 999999));
  seedInput.focus();
});

// Typing in the seed box must not reach the game keys; Enter there starts the game.
seedInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); startAudio(); startGame(); }
});
document.getElementById('seedForm').addEventListener('submit', (e) => { e.preventDefault(); startAudio(); startGame(); });
window.addEventListener('keydown', (e) => {
  if (splashOn || recordOpen || view.menuOpen || e.target === seedInput || e.code !== 'KeyH' || e.repeat) return;
  e.stopImmediatePropagation();
  tutStep = 0;
  showTutorial();
}, true);
window.addEventListener('keydown', (e) => {
  if (!splashOn || e.target === seedInput) return;
  e.stopImmediatePropagation();
  startGame();
}, true);

const menuEl = document.getElementById('menu');
const engineOpt = document.getElementById('engineOpt');
const musicOpt = document.getElementById('musicOpt');
const trackSel = document.getElementById('trackSel');
for (const t of MUSIC_TRACKS) trackSel.add(new Option(t.name, t.id));
trackSel.value = getMusicTrack();
trackSel.addEventListener('change', () => { setMusicTrack(trackSel.value); startAudio(); });
const muteOpt = document.getElementById('muteOpt');
const menuLevel = document.getElementById('menuLevel');
const decalOpt = document.getElementById('decalOpt');
setDecalsEnabled(localStorage.getItem('forklift-decals-off') !== '1');
const menuHardOpt = document.getElementById('menuHardOpt');
function toggleMenu(open) {
  view.menuOpen = open;
  menuEl.classList.toggle('hide', !open);
  if (open) {
    muteOpt.checked = isAllMuted();
    engineOpt.checked = isEngineOn();
    musicOpt.checked = !isMusicMuted();
    decalOpt.checked = decalsEnabled();
    menuHardOpt.checked = hard;
    menuLevel.value = level;
    document.getElementById('menuResume').focus();
  } else {
    document.activeElement?.blur();
  }
  input.clear();
  applyPause();
}
muteOpt.addEventListener('change', () => setAllMuted(muteOpt.checked));
engineOpt.addEventListener('change', () => setEngineOn(engineOpt.checked));
decalOpt.addEventListener('change', () => {
  setDecalsEnabled(decalOpt.checked);
  localStorage.setItem('forklift-decals-off', decalOpt.checked ? '0' : '1');
});
musicOpt.addEventListener('change', () => setMusicMuted(!musicOpt.checked));
document.getElementById('menuGoto').addEventListener('submit', (e) => {
  e.preventDefault();
  const n = parseInt(menuLevel.value, 10);
  if (n >= 1) { load(n); toggleMenu(false); }
});
document.getElementById('menuLowest').addEventListener('click', () => {
  load(lowestUnscored(localStorage, seed));
  toggleMenu(false);
});
document.getElementById('menuFullscreen').addEventListener('click', toggleFullscreen);
document.getElementById('menuResume').addEventListener('click', () => toggleMenu(false));
document.getElementById('menuRestart').addEventListener('click', () => {
  hard = menuHardOpt.checked;
  localStorage.setItem('forklift-hard', hard ? '1' : '0');
  hardOpt.checked = hard;
  load(level);
  toggleMenu(false);
});
// While the menu is open it swallows all keys (so the game keys do nothing); Tab/Space/Enter still work on its controls.
window.addEventListener('keydown', (e) => {
  if (!view.menuOpen) return;
  e.stopImmediatePropagation();
  if (e.target === stateText) { if (e.code === 'Escape') { e.preventDefault(); toggleMenu(false); } return; }
  if (e.code === 'Escape' || (e.code === 'KeyP' && e.target !== menuLevel)) { e.preventDefault(); toggleMenu(false); return; }
  if (e.code === 'Enter' && e.target !== menuLevel) { e.preventDefault(); toggleMenu(false); return; }
  if (e.target === trackSel && e.code !== 'KeyT') return;
  if (e.target === menuLevel || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
  const toggle = (el) => { el.checked = !el.checked; el.dispatchEvent(new Event('change')); };
  const actions = {
    KeyA: () => toggle(muteOpt),
    KeyE: () => toggle(engineOpt),
    KeyM: () => toggle(musicOpt),
    KeyT: () => trackSel.focus(),
    KeyD: () => toggle(decalOpt),
    KeyH: () => toggle(menuHardOpt),
    KeyG: () => { menuLevel.focus(); menuLevel.select(); },
    KeyL: () => document.getElementById('menuLowest').click(),
    KeyF: toggleFullscreen,
    KeyR: () => document.getElementById('menuRestart').click(),
    KeyU: () => toggleMenu(false),
  };
  if (actions[e.code]) { e.preventDefault(); actions[e.code](); }
}, true);

const stateText = document.getElementById('stateText');
const stateMsg = document.getElementById('stateMsg');
document.getElementById('stateExport').addEventListener('click', async () => {
  const snap = serializeGame(game, seedText);
  stateText.value = debug ? JSON.stringify(snap) : await encodeState(snap);
  stateText.select();
  try {
    await navigator.clipboard.writeText(stateText.value);
    stateMsg.textContent = 'Exported and copied to clipboard.';
  } catch { stateMsg.textContent = 'Exported; copy the text above.'; }
});
document.getElementById('stateImport').addEventListener('click', async () => {
  let g, data;
  try {
    data = await decodeState(stateText.value);
    g = deserializeGame(data);
  } catch (err) {
    stateMsg.textContent = `Import failed: ${err.message}`;
    return;
  }
  if (recordOpen) closeRecord();
  seed = g.seed;
  seedText = typeof data.seedText === 'string' && parseSeed(data.seedText) === seed ? data.seedText : String(seed);
  hard = g.hard;
  level = g.level;
  localStorage.setItem('forklift-seed', seedText);
  localStorage.setItem('forklift-hard', hard ? '1' : '0');
  localStorage.setItem('forklift-level', String(level));
  seedInput.value = seedText;
  hardOpt.checked = hard;
  game = g;
  recorded = g.status === 'won';
  doneZones = countDone();
  hitCount = g.hitCount;
  bonkCount = g.bonks;
  view.best = getBest(localStorage, seed, level);
  saveState();
  toggleMenu(false);
});
window.addEventListener('pagehide', saveState);
setInterval(() => { if (!splashOn && !view.paused) saveState(); }, 1000);

const lostFocus = () => document.hidden || !document.hasFocus();
function applyPause() {
  const p = !!view.menuOpen;
  if (!p && view.paused) last = performance.now();
  view.paused = p;
  setSilenced(p);
}
// Losing focus opens the same pause menu as Esc/P; the player must click Resume (or press U/Esc/P) to continue, just like any other pause.
const pauseOnBlur = () => { if (!splashOn && !recordOpen && lostFocus()) toggleMenu(true); };
window.addEventListener('blur', pauseOnBlur);
document.addEventListener('visibilitychange', pauseOnBlur);
pauseOnBlur();
applyPause();

const debug = debugEnabled(location.search) ? createDebug() : null;
const touchEl = document.getElementById('touch');
const STEP = 1 / 120;
let acc = 0, last = performance.now();
function frame(now) {
  acc += Math.min(0.1, (now - last) / 1000);
  last = now;
  if (view.paused) acc = 0;
  const t0 = performance.now();
  let steps = 0;
  while (!splashOn && !view.paused && acc >= STEP) {
    update(game, input.state(), STEP);
    acc -= STEP;
    steps++;
  }
  const t1 = performance.now();
  checkTutorial();
  checkRecord();
  touchEl.classList.toggle('won', game.status === 'won' && !recordOpen);
  const st = input.state();
  setEngine(game.fl.speed, st.up || st.down);
  const done = countDone();
  if (done > doneZones) playSuccess();
  doneZones = done;
  if (game.hitCount !== hitCount) { if (game.hitCount > hitCount) playBreak(); hitCount = game.hitCount; }
  setScrape(game.scrape);
  if (game.bonks !== bonkCount) { if (game.bonks > bonkCount) playBonk(game.bonkPower); bonkCount = game.bonks; }
  const t2 = performance.now();
  draw(ctx, game, view);
  if (debug) {
    const t3 = performance.now();
    debug.frame(now, steps, t1 - t0, t3 - t2);
    debug.draw(ctx, game, view);
    debug.overhead(performance.now() - t3);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
