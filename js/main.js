import { newGame, update, forkUp, forkDown } from './game.js';
import { createInput } from './input.js';
import { draw } from './render.js';

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

function load(n) {
  level = Math.max(1, n);
  localStorage.setItem('forklift-level', String(level));
  game = newGame(level);
}

const input = createInput({
  up: (half) => forkUp(game, half),
  down: (half) => forkDown(game, half),
  restart: () => load(level),
  next: (code) => { if (code === 'Enter' ? game.status === 'won' : true) load(level + 1); },
  prev: () => load(level - 1),
});

const STEP = 1 / 120;
let acc = 0, last = performance.now();
function frame(now) {
  acc += Math.min(0.1, (now - last) / 1000);
  last = now;
  while (acc >= STEP) {
    update(game, input.state(), STEP);
    acc -= STEP;
  }
  draw(ctx, game, view);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
