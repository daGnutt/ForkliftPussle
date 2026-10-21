import { newGame, update, forkUp, forkDown, zoneDone, score } from './game.js';
import { createInput } from './input.js';
import { getBest, beats, saveBest, finalScore, timePenalty } from './highscores.js';
import { parseSeed } from './level.js';
import { draw } from './render.js';
import { startAudio, toggleMusic, playFork, playBlocked, playSuccess, setEngine, setSilenced } from './audio.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const view = { width: 0, height: 0, dpr: 1, povBig: true, showSmall: false };

function resize() {
  view.dpr = window.devicePixelRatio || 1;
  view.width = canvas.clientWidth;
  view.height = canvas.clientHeight;
  canvas.width = Math.round(view.width * view.dpr);
  canvas.height = Math.round(view.height * view.dpr);
}
window.addEventListener('resize', resize);
resize();

let level = Number(localStorage.getItem('forklift-level')) || 1;
let seedText = localStorage.getItem('forklift-seed') || '';
let seed = parseSeed(seedText);
let game = newGame(level, seed);
const countDone = () => game.zones.filter((z) => zoneDone(game, z)).length;
let doneZones = countDone();
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
  game = newGame(level, seed);
  doneZones = countDone();
  view.best = getBest(localStorage, seed, level);
}

const input = createInput({
  anyKey: startAudio,
  mute: toggleMusic,
  toggleSmall: () => { view.showSmall = !view.showSmall; },
  swapView: () => { view.povBig = !view.povBig; if (tutStep === 3) nextTutorial(); },
  up: () => { const h = game.H; forkUp(game); if (game.H !== h) playFork(true); },
  down: () => {
    const h = game.H;
    if (forkDown(game) === 'blocked') playBlocked();
    else if (game.H !== h) playFork(false);
  },
  restart: () => load(level),
  next: () => { if (game.status === 'won') load(level + 1); },
  goto: () => {
    const n = parseInt(window.prompt('Go to level:', String(level)), 10);
    input.clear();
    if (n >= 1) load(n);
  },
  pause: () => { if (!splashOn) setPaused(!view.userPaused, true); },
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
  document.getElementById('recordInfo').textContent = `Level ${level}: ${score(game)} − ${timePenalty(game.time)} time = ${result.score} points (${result.time.toFixed(0)}s)`;
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
  'If you get lost, press <b>F</b> to switch to the map view (and <b>F</b> again to return to the cabin).',
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
showTutorial();

function startGame() {
  const text = seedInput.value.trim();
  if (text !== seedText) {
    seedText = text;
    seed = parseSeed(text);
    localStorage.setItem('forklift-seed', text);
    load(1);
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
  if (splashOn || recordOpen || e.target === seedInput || e.code !== 'KeyH' || e.repeat) return;
  e.stopImmediatePropagation();
  tutStep = 0;
  showTutorial();
}, true);
window.addEventListener('keydown', (e) => {
  if (!splashOn || e.target === seedInput) return;
  e.stopImmediatePropagation();
  startGame();
}, true);

const lostFocus = () => document.hidden || !document.hasFocus();
function applyPause() {
  const p = !!view.userPaused || lostFocus();
  if (!p && view.paused) last = performance.now();
  view.paused = p;
  setSilenced(p);
}
function setPaused(p, manual) {
  if (manual) view.userPaused = p;
  applyPause();
}
window.addEventListener('blur', applyPause);
window.addEventListener('focus', applyPause);
document.addEventListener('visibilitychange', applyPause);
view.paused = !document.hasFocus();
setSilenced(view.paused);

const STEP = 1 / 120;
let acc = 0, last = performance.now();
function frame(now) {
  acc += Math.min(0.1, (now - last) / 1000);
  last = now;
  if (view.paused) acc = 0;
  while (!splashOn && !view.paused && acc >= STEP) {
    update(game, input.state(), STEP);
    acc -= STEP;
  }
  checkTutorial();
  checkRecord();
  const st = input.state();
  setEngine(game.fl.speed, st.up || st.down);
  const done = countDone();
  if (done > doneZones) playSuccess();
  doneZones = done;
  draw(ctx, game, view);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
