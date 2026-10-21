import { newGame, update, forkUp, forkDown, zoneDone } from './game.js';
import { createInput } from './input.js';
import { draw } from './render.js';
import { startAudio, toggleMusic, playFork, playSuccess, setEngine } from './audio.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const view = { width: 0, height: 0, dpr: 1 };

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
let game = newGame(level);
const countDone = () => game.zones.filter((z) => zoneDone(game, z)).length;
let doneZones = countDone();

function load(n) {
  level = Math.max(1, n);
  localStorage.setItem('forklift-level', String(level));
  game = newGame(level);
  doneZones = countDone();
}

const input = createInput({
  anyKey: startAudio,
  mute: toggleMusic,
  up: () => { const h = game.H; forkUp(game); if (game.H !== h) playFork(true); },
  down: () => { const h = game.H; forkDown(game); if (game.H !== h) playFork(false); },
  restart: () => load(level),
  next: (code) => { if (code === 'Enter' ? game.status === 'won' : true) load(level + 1); },
  prev: () => load(level - 1),
});

const splash = document.getElementById('splash');
let splashOn = true;
window.addEventListener('keydown', (e) => {
  if (!splashOn) return;
  splashOn = false;
  splash.classList.add('hide');
  last = performance.now();
  e.stopImmediatePropagation();
}, true);

const STEP = 1 / 120;
let acc = 0, last = performance.now();
function frame(now) {
  acc += Math.min(0.1, (now - last) / 1000);
  last = now;
  while (!splashOn && acc >= STEP) {
    update(game, input.state(), STEP);
    acc -= STEP;
  }
  const st = input.state();
  setEngine(game.fl.speed, st.up || st.down);
  const done = countDone();
  if (done > doneZones) playSuccess();
  doneZones = done;
  draw(ctx, game, view);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
