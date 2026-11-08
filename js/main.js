import { newGame, update, forkUp, forkDown, zoneDone, zoneWonky, score } from './game.js';
import { createInput } from './input.js';
import { syncScores, fetchTopList } from './globalscores.js';
import { getBest, getTop, addTop, lowestUnscored, beats, saveBest, finalScore, timePenalty, formatTime } from './highscores.js';
import { serializeGame, deserializeGame, encodeState, decodeState } from './savestate.js';
import { parseSeed } from './level.js';
import { draw } from './render.js';
import { debugEnabled, createDebug } from './debug.js';
import { decalsEnabled, setDecalsEnabled } from './decals.js';
import { glEnabled, setGlEnabled } from './gl/renderer.js';
import { themeMode, setThemeMode } from './theme.js';
import { discoEnabled, setDiscoEnabled } from './disco.js';
import { initTestingBanner } from './testing.js';
import { startSplashAnimation } from './splash.js';
import { startAudio, playFork, playBlocked, playBreak, playBonk, setScrape, playSuccess, playWonky, setEngine, setSilenced, isMusicMuted, setMusicMuted, isMusicRandom, setMusicRandom, setTrackListener, MUSIC_TRACKS, getMusicTrack, setMusicTrack, isEngineOn, setEngineOn, isAllMuted, setAllMuted } from './audio.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });
const isTouch = matchMedia('(pointer: coarse)').matches;
const view = { width: 0, height: 0, dpr: 1, povBig: !isTouch && localStorage.getItem('forklift-cab-view') === '1', showSmall: false, touch: isTouch };

function resize() {
  view.width = canvas.clientWidth;
  view.height = canvas.clientHeight;
  if (isTouch && view.height > view.width) view.povBig = false; // portrait has no cab view
  view.dpr = window.devicePixelRatio || 1;
  // Phones report a dpr of ~3 (9x the pixels); cap the backing store so drawing stays fast, CSS scales it up.
  if (matchMedia('(pointer: coarse)').matches) view.dpr = Math.min(view.dpr, 1, Math.sqrt(0.9e6 / Math.max(1, view.width * view.height)));
  // Desktop: keep the backing store under ~3M pixels (big high-DPI windows are slow, especially in Firefox).
  view.dpr = Math.min(view.dpr, Math.sqrt(3e6 / Math.max(1, view.width * view.height)));
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
// Local best now; global top fetched in the background (stale replies are ignored).
function refreshGlobal() {
  const board = `${seed || 0}:${level}`;
  fetchTopList(board).then((list) => {
    if (board !== `${seed || 0}:${level}`) return;
    view.global = list === null ? 'offline' : list[0] || 'none';
    view.globalList = list;
  });
}
function refreshBest() {
  view.best = getBest(localStorage, seed, level);
  view.localList = getTop(localStorage, seed, level);
  view.global = 'loading';
  view.globalList = undefined;
  refreshGlobal();
}
function saveState() {
  localStorage.setItem('forklift-state', JSON.stringify(serializeGame(game, seedText)));
}
const countDone = () => game.zones.filter((z) => zoneDone(game, z)).length;
const doneSet = () => new Set(game.zones.filter((z) => zoneDone(game, z)));
let doneZones = doneSet();
let hitCount = game.hitCount;
let bonkCount = game.bonks;
refreshBest();
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
  doneZones = doneSet();
  hitCount = game.hitCount;
  bonkCount = game.bonks;
  refreshBest();
  saveState();
}

let autoFs = localStorage.getItem('forklift-auto-fullscreen') === '1';
function setFullscreen(on) {
  if (!autoFs) return;
  if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

function nextLevel() { if (game.status === 'won') load(level + 1); }

const input = createInput({
  anyKey: startAudio,
  fullscreen: toggleFullscreen,
  toggleSmall: () => { view.showSmall = !view.showSmall; },
  swapView: () => {
    if (isTouch) return;
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
  next: () => nextLevel(),
  menu: () => { if (!splashOn && !recordOpen) toggleMenu(true); },
  pause: () => { if (!splashOn && !recordOpen) toggleMenu(true); },
  blocked: () => splashOn || recordOpen || !!view.menuOpen,
});

// On touch, tapping the "Level complete" board goes to the next level.
// Easter egg: in landscape, tapping the minimap swaps between the overview and the cab view.
if (isTouch) canvas.addEventListener('pointerdown', (e) => {
  if (splashOn || recordOpen || view.menuOpen) return;
  const r = canvas.getBoundingClientRect(), h = view.miniHit, x = e.clientX - r.left, y = e.clientY - r.top;
  if (h && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) view.povBig = !view.povBig;
  else nextLevel();
});

// Look around in the 3D views: drag the canvas or hold Q/W. The big view's camera swings around the forklift (overview,
// view.orbit { yaw, tilt }) or turns on the spot (cabin, view.look { yaw, pitch }); driving springs it back.
const ORBIT_HOME = 0.35, ORBIT_TILT_MAX = 1.3, LOOK_PITCH_MAX = 0.7, LOOK_SPEED = 2;
const wrap = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
function lookState() {
  view.snap = false;
  return view.povBig ? (view.look ||= { yaw: 0, pitch: 0 }) : (view.orbit ||= { yaw: 0, tilt: ORBIT_HOME });
}
function lookBy(dyaw, dpitch) {
  const o = lookState();
  o.yaw = wrap(o.yaw - dyaw);
  if (view.povBig) o.pitch = Math.min(LOOK_PITCH_MAX, Math.max(-LOOK_PITCH_MAX, o.pitch + dpitch));
  else o.tilt = Math.min(ORBIT_TILT_MAX, Math.max(0.05, o.tilt + dpitch));
}
function springBack(dt) {
  const k = 1 - Math.exp(-7 * dt);
  const o = view.orbit, l = view.look;
  if (o) { o.yaw -= o.yaw * k; o.tilt -= (o.tilt - ORBIT_HOME) * k; if (Math.abs(o.yaw) + Math.abs(o.tilt - ORBIT_HOME) < 0.003) view.orbit = null; }
  if (l) { l.yaw -= l.yaw * k; l.pitch -= l.pitch * k; if (Math.abs(l.yaw) + Math.abs(l.pitch) < 0.003) view.look = null; }
  if (!view.orbit && !view.look) view.snap = false;
}
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.target !== canvas || !glEnabled() || splashOn || recordOpen || view.menuOpen) return;
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 6) return;
  drag.moved = true;
  drag.x = e.clientX; drag.y = e.clientY;
  lookBy(dx * 0.008, dy * 0.006);
});
const endDrag = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

const pending = {};
recordName.addEventListener('keydown', (e) => e.stopPropagation());
document.getElementById('recordForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = recordName.value.trim() || 'Anonymous';
  localStorage.setItem('forklift-player', name);
  // addTop first: getTop falls back to the saved best, which would duplicate the new entry
  addTop(localStorage, pending.seed, pending.level, { ...pending.result, name });
  saveBest(localStorage, pending.seed, pending.level, { ...pending.result, name });
  if (pending.level === level && pending.seed === seed) {
    view.best = getBest(localStorage, seed, level);
    view.localList = getTop(localStorage, seed, level);
  }
  closeRecord();
  syncScores(localStorage).then(() => refreshGlobal());
});

function checkRecord() {
  if (game.status !== 'won' || recorded) return;
  recorded = true;
  const result = { score: finalScore(score(game), game.time), time: game.time };
  if (!beats(result, getBest(localStorage, seed, level))) {
    if (addTop(localStorage, seed, level, { ...result, name: localStorage.getItem('forklift-player') || 'Anonymous' })) view.localList = getTop(localStorage, seed, level);
    return;
  }
  Object.assign(pending, { seed, level, result });
  document.getElementById('recordInfo').textContent = `Level ${level}: ${score(game)} − ${timePenalty(game.time)} time = ${result.score} points (${formatTime(result.time)})`;
  recordName.value = localStorage.getItem('forklift-player') || '';
  recordOpen = true;
  recordEl.classList.remove('hide');
  input.clear();
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (!(touch && recordName.value)) recordName.focus();
}

syncScores(localStorage).then(refreshGlobal); // upload bests that never reached the global list

const splash = document.getElementById('splash');
let splashOn = true;
startSplashAnimation(document.getElementById('splashAnim'), () => splashOn);
const seedInput = document.getElementById('seed');
seedInput.value = seedText;

const TUTORIAL = [
  'Use <b>↑/↓</b> to drive and <b>←/→</b> to steer (the rear wheels steer!).  Release the throttle to engine-brake.',
  'Press <b>A</b> to raise the forks and <b>Z</b> to lower them.',
  'Drive the forks under a stack, lift it, and set it down on the matching coloured zone. Then park on the marked spot.',
  'If you want an more immersive experience, press <b>Tab</b> or <b>M</b> to switch to the cab view (and again to return to the overview).',
];
if (isTouch) TUTORIAL.pop();
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

function startGame(disco = false) {
  if (disco) {
    setMusicMuted(false);
    setDiscoEnabled(true);
    localStorage.setItem('forklift-disco', '1');
  }
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
  refreshBest();
  if (tutorialOpt.checked) {
    localStorage.removeItem('forklift-tutorial-done');
    tutStep = 0;
  } else {
    tutStep = -1;
    localStorage.setItem('forklift-tutorial-done', '1');
  }
  showTutorial();
  setFullscreen(true);
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
document.getElementById('seedForm').addEventListener('submit', (e) => {
  e.preventDefault();
  startAudio();
  startGame(e.submitter && e.submitter.id === 'discoStart');
});
window.addEventListener('keydown', (e) => {
  if (!splashOn || e.target === seedInput) return;
  e.stopImmediatePropagation();
  if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); startAudio(); startGame(); }
}, true);

const menuEl = document.getElementById('menu');
const engineOpt = document.getElementById('engineOpt');
const musicOpt = document.getElementById('musicOpt');
const trackSel = document.getElementById('trackSel');
for (const t of MUSIC_TRACKS) trackSel.add(new Option(t.name, t.id));
trackSel.value = getMusicTrack();
setTrackListener((id) => { trackSel.value = id; });
const randomOpt = document.getElementById('randomOpt');
randomOpt.checked = isMusicRandom();
randomOpt.addEventListener('change', () => setMusicRandom(randomOpt.checked));
trackSel.addEventListener('change', () => { setMusicTrack(trackSel.value); startAudio(); });
const muteOpt = document.getElementById('muteOpt');
const menuLevel = document.getElementById('menuLevel');
const decalOpt = document.getElementById('decalOpt');
const glOpt = document.getElementById('glOpt');
const glParam = new URLSearchParams(location.search).get('gl');
setGlEnabled(glParam ? glParam !== '0' : localStorage.getItem('forklift-gl-off') !== '1');
setDecalsEnabled(localStorage.getItem('forklift-decals-off') !== '1');
const themeSel = document.getElementById('themeSel');
setThemeMode(localStorage.getItem('forklift-theme'));
const discoOpt = document.getElementById('discoOpt');
setDiscoEnabled(localStorage.getItem('forklift-disco') === '1');
const menuHardOpt = document.getElementById('menuHardOpt');
const autoFsOpt = document.getElementById('autoFsOpt');
autoFsOpt.checked = autoFs;
autoFsOpt.addEventListener('change', () => {
  autoFs = autoFsOpt.checked;
  localStorage.setItem('forklift-auto-fullscreen', autoFs ? '1' : '0');
});
function showPage(name) {
  for (const p of menuEl.querySelectorAll('.page')) p.hidden = p.dataset.page !== name;
  (menuEl.querySelector(`.page[data-page="${name}"] .primary, .page[data-page="${name}"] .back`)).focus();
  menuEl.dataset.page = name;
}
menuEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (b) showPage(b.dataset.go);
});
function toggleMenu(open) {
  view.menuOpen = open;
  setFullscreen(!open);
  menuEl.classList.toggle('hide', !open);
  if (open) {
    muteOpt.checked = isAllMuted();
    engineOpt.checked = isEngineOn();
    musicOpt.checked = !isMusicMuted();
    decalOpt.checked = decalsEnabled();
    glOpt.checked = glEnabled();
    discoOpt.checked = discoEnabled();
    themeSel.value = themeMode();
    menuHardOpt.checked = hard;
    menuLevel.value = level;
    updateTutorialBtn();
    showPage('main');
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
glOpt.addEventListener('change', () => {
  setGlEnabled(glOpt.checked);
  localStorage.setItem('forklift-gl-off', glOpt.checked ? '0' : '1');
});
themeSel.addEventListener('change', () => {
  setThemeMode(themeSel.value);
  localStorage.setItem('forklift-theme', themeMode());
});
discoOpt.addEventListener('change', () => {
  setDiscoEnabled(discoOpt.checked);
  localStorage.setItem('forklift-disco', discoOpt.checked ? '1' : '0');
});
const touchSel = document.getElementById('touchSel');
const touchPad = document.getElementById('touch');
if (isTouch) document.getElementById('touchLabel').hidden = false;
// On touch devices Auto full-screen lives on the main menu page instead of the visuals page.
if (isTouch) { const l = document.getElementById('autoFsLabel'); l.classList.add('item'); menuEl.querySelector('.page[data-page="main"] hr').before(l); }
{
  const saved = localStorage.getItem('forklift-touch-scheme');
  touchSel.value = [...touchSel.options].some((o) => o.value === saved) ? saved : 'classic';
  touchPad.dataset.scheme = touchSel.value;
}
touchSel.addEventListener('change', () => {
  touchPad.dataset.scheme = touchSel.value;
  localStorage.setItem('forklift-touch-scheme', touchSel.value);
  input.clear();
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
const menuTutorial = document.getElementById('menuTutorial');
function updateTutorialBtn() {
  menuTutorial.innerHTML = tutStep >= 0 ? 'Stop tutorial' : 'Restart tutorial';
}
menuTutorial.addEventListener('click', () => {
  if (tutStep >= 0) {
    tutStep = -1;
    localStorage.setItem('forklift-tutorial-done', '1');
  } else {
    tutStep = 0;
    localStorage.removeItem('forklift-tutorial-done');
    tutStart = { x: game.fl.x, y: game.fl.y, g: game };
  }
  showTutorial();
  updateTutorialBtn();
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
  if (e.target === stateText) { if (e.code === 'Escape') { e.preventDefault(); showPage('main'); } return; }
  if (e.code === 'Escape' && menuEl.dataset.page !== 'main') { e.preventDefault(); showPage('main'); return; }
  if (e.code === 'Escape' || (e.code === 'KeyP' && e.target !== menuLevel)) { e.preventDefault(); toggleMenu(false); return; }
  if (e.code === 'Enter' && e.target !== menuLevel) { e.preventDefault(); toggleMenu(false); return; }
  if (e.target === trackSel && e.code !== 'KeyT') return;
  if (e.target === themeSel && e.code !== 'KeyC') return;
  if (e.target === menuLevel || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
  const toggle = (el) => { el.checked = !el.checked; el.dispatchEvent(new Event('change')); };
  const actions = {
    KeyA: () => toggle(muteOpt),
    KeyE: () => toggle(engineOpt),
    KeyM: () => toggle(musicOpt),
    KeyS: () => showPage('sound'),
    KeyV: () => showPage('display'),
    KeyT: () => { showPage('sound'); trackSel.focus(); },
    KeyD: () => toggle(decalOpt),
    KeyC: () => {
      const o = [...themeSel.options].map((x) => x.value);
      themeSel.value = o[(o.indexOf(themeSel.value) + 1) % o.length];
      themeSel.dispatchEvent(new Event('change'));
    },
    KeyI: () => toggle(discoOpt),
    KeyG: () => { showPage('game'); menuLevel.focus(); menuLevel.select(); },
    KeyL: () => document.getElementById('menuLowest').click(),
    KeyF: toggleFullscreen,
    KeyR: () => document.getElementById('menuRestart').click(),
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
  doneZones = doneSet();
  hitCount = g.hitCount;
  bonkCount = g.bonks;
  refreshBest();
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
// Losing focus opens the same pause menu as Esc/P; the player must click Resume (or press Esc/P) to continue, just like any other pause.
const pauseOnBlur = () => { if (!splashOn && !recordOpen && lostFocus()) toggleMenu(true); };
window.addEventListener('blur', pauseOnBlur);
window.addEventListener('focus', applyPause);
document.addEventListener('visibilitychange', pauseOnBlur);
pauseOnBlur();
applyPause();

const debug = debugEnabled(location.search) ? createDebug() : null;
initTestingBanner();
const STEP = 1 / 120;
let acc = 0, last = performance.now();
// ?skip in the URL bypasses the splash (keeps saved settings; no audio until a key/click starts it)
if (new URLSearchParams(location.search).has('skip')) startGame();
function frame(now) {
  acc += Math.min(0.1, (now - last) / 1000);
  last = now;
  if (view.paused) acc = 0;
  const t0 = performance.now();
  let steps = 0;
  while (!splashOn && !view.paused && acc >= STEP) {
    const inp = input.state();
    if (inp.up || inp.down || inp.left || inp.right) view.snap = true;
    if (!splashOn && glEnabled() && (inp.lookL || inp.lookR)) lookBy((inp.lookR - inp.lookL) * LOOK_SPEED * STEP, 0);
    if (view.snap) springBack(STEP);
    update(game, inp, STEP);
    acc -= STEP;
    steps++;
  }
  const t1 = performance.now();
  checkTutorial();
  checkRecord();
  const st = input.state();
  setEngine(game.fl.speed, st.up || st.down);
  const done = doneSet();
  const fresh = [...done].filter((z) => !doneZones.has(z));
  if (fresh.length) (fresh.some((z) => zoneWonky(game, z)) ? playWonky : playSuccess)();
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
