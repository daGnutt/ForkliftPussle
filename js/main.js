import './firstplay.js';
import { newGame, update, endPhotos, forkUp, forkDown, zoneDone, zoneWonky, score, liveTrucks, topOpen, truckPopChanges, crashAlert, removeTruck } from './game.js';
import { newEndless, stepEndless, endEndless, endlessScore } from './endless.js';
import { createInput, createCameraPointerInput, inTouchControlZone } from './input.js';
import { createLocal } from './local.js';
import { syncScores, fetchTopList, pullScores, submitPartyScore, partyBoard, observerPartyScore } from './globalscores.js';
import { createRelay } from './net/relay.js';
import { createHost } from './net/host.js';
import { createGuest, withoutJoinParam } from './net/guest.js';
import { applySnapshot } from './net/protocol.js';
import { truckColor } from './forklift.js';
import { getBest, getTop, addTop, lowestUnscored, beats, saveBest, finalScore, timePenalty, formatTime } from './highscores.js';
import { serializeGame, deserializeGame, serializeEndless, deserializeEndless, encodeState, decodeState, HardPhysicsVersionError } from './savestate.js';
import { createStateHistory } from './state-history.js';
import { parseSeed } from './level.js';
import { draw, drawResults } from './render.js';
import { showPhoto, dodgePhoto, startGallery, stopGallery, clearPhotos } from './photo.js';
import { debugEnabled, createDebug } from './debug.js';
import { setBareForks, bareForksEnabled } from './gl/models.js';
import { setParticlesEnabled } from './gl/particles.js';
import { setDecalsEnabled } from './decals.js';
import { glAvailable, glEnabled, setGlEnabled, attachGlCanvas } from './gl/renderer.js';
import { themeMode, setThemeMode, theme } from './theme.js';
import { setDiscoEnabled } from './disco.js';
import { chaseDrift, chaseOrbit, lookYawDelta, CHASE_TILES, CHASE_DEFAULT, CHASE_TILT, chaseZoom as chaseZoomOf } from './gl/camera.js';
import { initTestingBanner, isTesting } from './testing.js';
import { startSplashAnimation } from './splash.js';
import { startSplash3d } from './splash3d.js';
import { repairHintWanted, setRepairHint, REPAIRED_KEY } from './repairhint.js';
import { standardPads } from './gamepad.js';
import { createRumble, vibrateSupported, sendRumble, rumbleSupport, RUMBLE_FEATURES, RUMBLE_EFFECTS, RUMBLE_STRENGTH } from './rumble.js';
import { pickScheme, KEYBOARD, TOUCH } from './schemepicker.js';
import { batterySaverOption, canvasDpr, shouldDraw } from './power.js';
import { startAudio, playDroid as droid, playFork, playBlocked, playBreak, playPop, playBonk, setScrape, setSqueal, playSuccess, playWonky, setEngine, setCrashAlert, setHorns, playTruckHonk, playImpatientHonk, setSilenced, setPageHidden, getVolume, setVolume, isMusicMuted, setMusicMuted, isMusicRandom, setMusicRandom, setTrackListener, MUSIC_TRACKS, getMusicTrack, setMusicTrack, isAllMuted, setAllMuted } from './audio.js';

const canvas = document.getElementById('game');
const resultsCanvas = document.getElementById('results'); // end-of-level panel, stacked above the gallery photos
const resultsCtx = resultsCanvas.getContext('2d');
const ctx = canvas.getContext('2d');
attachGlCanvas(document.getElementById('gameGl'), ctx);
const isTouch = matchMedia('(pointer: coarse)').matches;
let lowerResolutionOn = batterySaverOption(localStorage, 'resolution', isTouch);
let limitFrameRateOn = batterySaverOption(localStorage, 'frame-rate', isTouch);
let reduceEffectsOn = batterySaverOption(localStorage, 'effects', isTouch);
let rafPending = false;
function scheduleFrame() {
  if (!rafPending && !view.paused) { rafPending = true; requestAnimationFrame(frame); }
}
const view = { width: 0, height: 0, dpr: 1, povBig: !isTouch && localStorage.getItem('forklift-cab-view') === '1', chase: localStorage.getItem('forklift-chase-cam') === '1', chaseZoom: localStorage.getItem('forklift-chase-zoom') === null ? null : Number(localStorage.getItem('forklift-chase-zoom')), zoom: localStorage.getItem('forklift-ov-zoom') === null ? null : Number(localStorage.getItem('forklift-ov-zoom')), touch: isTouch };

function resize() {
  view.width = canvas.clientWidth;
  view.height = canvas.clientHeight;
  if (isTouch && view.height > view.width) view.povBig = false; // portrait has no cab view
  view.dpr = canvasDpr(window.devicePixelRatio, view.width, view.height, lowerResolutionOn);
  canvas.width = Math.round(view.width * view.dpr);
  canvas.height = Math.round(view.height * view.dpr);
  resultsCanvas.width = canvas.width;
  resultsCanvas.height = canvas.height;
}
window.addEventListener('resize', resize);
resize();

// ?level=N always starts that level on every page load (overrides the saved level)
const levelParam = Math.floor(Number(new URLSearchParams(location.search).get('level')));
let level = levelParam >= 1 ? levelParam : Number(localStorage.getItem('forklift-level')) || 1;
// The seed only comes from the URL (?seed=...), meant for tournaments.
let seedText = (new URLSearchParams(location.search).get('seed') || '').trim().slice(0, 32);
let seed = parseSeed(seedText);
let hard = localStorage.getItem('forklift-hard') === '1';
let game = newGame(level, seed, hard);
function loadSaved() {
  try {
    const data = JSON.parse(localStorage.getItem('forklift-state'));
    if (data && data.level === level && data.seed === seed && data.hard === hard) game = deserializeGame(data);
  } catch (err) {
    if (err instanceof HardPhysicsVersionError) window.alert('This saved hard-mode level uses an incompatible physics version and will restart.');
    localStorage.removeItem('forklift-state');
  }
}
if (levelParam >= 1) localStorage.removeItem('forklift-state'); // ?level always starts fresh
else loadSaved();
// Local best now; global top fetched in the background (stale replies are ignored).
// Endless scores live on level 0 of the seed's boards.
const boardLevel = () => (game.endless ? 0 : level);
function refreshGlobal() {
  const board = `${seed || 0}:${boardLevel()}`;
  fetchTopList(board).then((list) => {
    if (board !== `${seed || 0}:${boardLevel()}`) return;
    view.global = list === null ? 'offline' : list[0] || 'none';
    view.globalList = list;
  });
}
function refreshBest() {
  view.best = getBest(localStorage, seed, boardLevel());
  view.localList = getTop(localStorage, seed, boardLevel());
  view.global = 'loading';
  view.globalList = undefined;
  refreshGlobal();
}
// Party state: null when playing alone, else { role: 'host' | 'guest', code, name, host | guest, go }. A guest mirrors the host's game and never steps it.
let mp = null;
const stateHistory = isTesting() ? createStateHistory() : null;
const roundPanel = document.getElementById('roundReady');
const roundCountdown = document.getElementById('roundCountdown');
const roundReadyButton = document.getElementById('roundReadyButton');
const roundScoreMessage = document.getElementById('roundScoreMessage');
let roundTimer = null, roundDisplay = null;
function showRound(state) {
  roundDisplay = state ? { ...state, deadline: performance.now() / 1000 + state.remaining } : null;
  view.round = !!state;
  roundPanel.hidden = !state;
  roundReadyButton.hidden = !state?.eligible;
  roundReadyButton.disabled = !!state?.ready;
  if (!state) roundScoreMessage.textContent = '';
  updateRoundDisplay();
}
function updateRoundDisplay() {
  if (!roundDisplay) return;
  const seconds = Math.ceil(Math.max(0, roundDisplay.deadline - performance.now() / 1000));
  roundCountdown.textContent = `${game.endless ? 'Restarting' : 'Next level'} in ${seconds} seconds`;
}
function observerRoundChanged(state) {
  clearTimeout(roundTimer);
  showRound(state);
  const blocked = !!state;
  document.getElementById('menuRestart').disabled = blocked;
  document.querySelector('#menuGoto button').disabled = blocked;
  if (!state) return;
  roundTimer = setTimeout(() => {
    if (!mp?.observer || mp.role !== 'host') return;
    const current = mp.host.roundState();
    if (!current) return;
    if (current.remaining > 0) { observerRoundChanged(current); return; }
    showRound(null);
    document.getElementById('menuRestart').disabled = false;
    document.querySelector('#menuGoto button').disabled = false;
    if (game.endless) loadEndless(true); else load(level + 1);
  }, Math.max(0, state.remaining * 1000));
}
roundReadyButton.addEventListener('click', () => {
  if (mp?.role !== 'guest' || !roundDisplay?.eligible || roundDisplay.ready) return;
  mp.guest.ready(roundDisplay.id);
  roundReadyButton.disabled = true;
});
const ENDLESS_KEY = 'forklift-endless-state';
function saveState() {
  if (mp) return;
  if (game.endless) {
    if (game.status === 'over') localStorage.removeItem(ENDLESS_KEY);
    else localStorage.setItem(ENDLESS_KEY, JSON.stringify(serializeEndless(game)));
    return;
  }
  localStorage.setItem('forklift-state', JSON.stringify(serializeGame(game, seedText)));
}
const countDone = () => game.zones.filter((z) => zoneDone(game, z)).length;
const doneSet = () => new Set(game.zones.filter((z) => zoneDone(game, z)));
let doneZones = doneSet();
let hitCount = game.hitCount;
let bonkCount = game.bonks;
let otherBonks = new Map(); // truck id -> last seen bonk count (other trucks' bumps are heard, quieter with distance)
const otherH = new Map(); // truck id -> last seen fork level
// Controller rumble (js/rumble.js): only while the gamepad was the last driving input; menu option #rumbleOpt.
const rumble = createRumble();
let lastTouch = false; // the last pointer input was a finger: only then does the phone vibrate
addEventListener('pointerdown', (e) => { lastTouch = e.pointerType === 'touch'; }, true);
const RUMBLE_HIT_DIST = 2.5; // tiles: box damage this close to the own truck is felt
refreshBest();
// Loudness 0..1 of a sound at (x, y), falling off with the distance from the local truck (same curve as the horns).
// Other players' trucks pop in and out of existence: queue a pop (sound here, smoke in gl/particles.js) on every change.
let popGame = null, popPrev = new Map(), popN = 0;
function watchPops() {
  if (popGame !== game) { popGame = game; popPrev = new Map(); }
  game.pops = (game.pops || []).filter((p) => game.clock - p.t < 2);
  for (const p of truckPopChanges(game, popPrev)) {
    game.pops.push({ n: ++popN, x: p.x, y: p.y, t: game.clock });
    (game.popVis ||= {})[p.i] = { t: game.clock, kind: p.kind };
    playPop(hearVol(p.x, p.y));
  }
}
const hearVol = (x, y) => 1 / (1 + Math.hypot(x - game.fl.x, y - game.fl.y) / 8);
// The maintenance bots talk in droidspeak, triggered by state changes (first sight of a game is silent): hello on emerging, bye on going home,
// alarm when a forklift scares them, mumble while mopping, a scanning trill, and the inspector's verdict (perfect / warn).
let galleryGame = null;
let botGame = null, botPrev = new Map(), botSaid = new WeakSet();
function watchBots() {
  const playDroid = (...a) => { if (game.status !== 'won') droid(...a); }; // silent on the end-of-level screen
  const loaded = botGame !== game; // first look at this game (new level, or restored from a save): its existing photo is not news
  if (loaded) { botGame = game; botPrev = new Map(); botSaid = new WeakSet(); }
  const first = (b, key) => { const p = botPrev.get(key); botPrev.set(key, { show: b.show > 0, scared: !!b.scared, shoot: (b.shooting || 0) > 0, clean: !!b.cleaning }); return p; };
  for (const [key, b, pitch] of [['clean', game.bot, 0.8], ['insp', game.inspector, 1.25]]) {
    if (!b) continue;
    const p = first(b, key), vol = hearVol(b.x, b.y);
    if (!p) continue;
    if (b.show > 0 && !p.show) playDroid('hello', vol, pitch);
    else if (b.show <= 0 && p.show) playDroid('bye', vol, pitch);
    if (b.scared && !p.scared) playDroid('alarm', vol, pitch);
    if ((b.shooting || 0) > 0 && !p.shoot) playDroid('scan', vol, pitch);
    if (b.cleaning && !p.clean) playDroid('mumble', vol, pitch);
  }
  if (game.photo && !botSaid.has(game.photo)) { botSaid.add(game.photo); if (!reduceEffectsOn && !loaded && game.status !== 'won') showPhoto(game.photo); } // after the level the gallery shows them
  if (game.forkPhoto && !botSaid.has(game.forkPhoto)) { botSaid.add(game.forkPhoto); if (!reduceEffectsOn) showPhoto(game.forkPhoto.photo, undefined, true); } // tines in a damaged stack: show the observer's last picture of it again
  for (const h of game.hits || []) {
    if (!h.check || botSaid.has(h)) continue;
    botSaid.add(h);
    playDroid(h.check === 'warn' ? 'warn' : 'perfect', hearVol(h.x, h.y), 1.25);
  }
}
// Delivery trucks honk (see `lorryHonks`): once before an incoming truck opens its gate, twice before a full one closes its gate (heard by distance).
const truckHonks = new Map(), truckNags = new Map();
function honkTrucks() {
  const e = game.endless;
  if (!e) { truckHonks.clear(); truckNags.clear(); return; }
  for (const o of [...e.docks, ...e.bays]) {
    if (o.dock) {
      const n = truckNags.get(o);
      truckNags.set(o, o.nagT);
      if (n !== undefined && n !== o.nagT && o.nagT >= 0) playImpatientHonk(o.nagDur, hearVol(o.area.x + o.area.w / 2, o.area.y + o.area.h / 2));
    }
    const prev = truckHonks.get(o);
    truckHonks.set(o, o.honkT);
    if (prev === undefined || prev === o.honkT || o.honkT < 0) continue;
    playTruckHonk(o.honkN, hearVol(o.area.x + o.area.w / 2, o.area.y + o.area.h / 2));
  }
}
let recordOpen = false, recorded = false, manualEnd = false; // manualEnd: the endless run was ended from the menu, so always offer the name prompt
const recordEl = document.getElementById('record');
const recordName = document.getElementById('recordName');

function closeRecord() {
  recordOpen = false;
  recordEl.classList.add('hide');
  recordName.blur();
  input.clear();
}

function load(n) {
  if (mp?.role === 'guest') return; // only the host changes levels
  stateHistory?.clear();
  hard = hardOpt.checked;
  if (recordOpen) closeRecord();
  recorded = false;
  manualEnd = false;
  level = Math.max(1, n);
  localStorage.setItem('forklift-level', String(level));
  game = newGame(level, seed, hard);
  doneZones = doneSet();
  hitCount = game.hitCount;
  bonkCount = game.bonks;
  otherBonks.clear();
  otherH.clear();
  partyGameChanged();
  refreshBest();
  saveState();
}
// Resumes the saved endless game of this seed and mode unless `fresh`.
function loadEndless(fresh = false) {
  if (mp?.role === 'guest') return;
  stateHistory?.clear();
  hard = hardOpt.checked;
  if (recordOpen) closeRecord();
  recorded = false;
  manualEnd = false;
  game = null;
  if (!fresh && !mp) {
    try {
      const data = JSON.parse(localStorage.getItem(ENDLESS_KEY));
      if (data && data.seed === seed && !!data.hard === hard) game = deserializeEndless(data);
    } catch (err) {
      if (err instanceof HardPhysicsVersionError) window.alert('This saved hard-mode endless game uses an incompatible physics version and will restart.');
      localStorage.removeItem(ENDLESS_KEY);
    }
  }
  game ||= newEndless(seed, hard);
  partyGameChanged();
  refreshBest();
  saveState();
  doneZones = doneSet();
  hitCount = game.hitCount;
  bonkCount = game.bonks;
  otherBonks.clear();
  otherH.clear();
}
// After the host's game was replaced: the guests get their trucks back in the new game.
function partyGameChanged() {
  local.levelLoaded(game);
  if (mp?.role !== 'host') return;
  if (!mp.observer) game.trucks[0].name = mp.name;
  else {
    removeTruck(game, 0);
    view.fullMap = true;
    document.body.classList.add('observer-party');
    tutorialEl.classList.add('hide');
  }
  mp.host.levelLoaded(game);
}

// Saved choice wins; with none, full screen is on for touch devices (the default is not written to storage).
const savedFs = localStorage.getItem('forklift-auto-fullscreen');
let autoFs = savedFs === null ? matchMedia('(pointer: coarse)').matches : savedFs === '1';
function setFullscreen(on) {
  if (!autoFs) return;
  if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

let cursorTimer = 0;
function wakeCursor() {
  canvas.classList.remove('idle');
  clearTimeout(cursorTimer);
  if (document.fullscreenElement) cursorTimer = setTimeout(() => canvas.classList.add('idle'), 2000);
}
canvas.addEventListener('mousemove', wakeCursor);
document.addEventListener('fullscreenchange', wakeCursor);

function nextLevel() {
  if (mp?.observer && mp.host.roundState()) return;
  if (game.status === 'won') load(level + 1);
  else if (game.endless && game.status === 'over') loadEndless(true);
}

function toggleChase() {
  if (mp?.observer || !glEnabled()) return;
  if (view.povBig) {
    view.povBig = false;
    localStorage.setItem('forklift-cab-view', '0');
    view.chase = true;
  } else view.chase = !view.chase;
  view.orbit = null;
  view.chaseGoal = null;
  localStorage.setItem('forklift-chase-cam', view.chase ? '1' : '0');
}

function setCameraOverview() {
  if (!glEnabled()) return;
  view.povBig = false;
  view.chase = false;
  view.orbit = null;
  view.look = null;
  view.manualCab = false;
  view.touchManualCab = false;
  view.chaseGoal = null;
  view.camP = null;
  localStorage.setItem('forklift-cab-view', '0');
  localStorage.setItem('forklift-chase-cam', '0');
}

function setCameraCabin() {
  if (mp?.observer || !glEnabled() || isTouch) return;
  view.povBig = true;
  view.chase = false;
  view.look = null;
  view.manualCab = false;
  view.touchManualCab = false;
  view.orbit = null;
  view.chaseGoal = null;
  view.camP = null;
  localStorage.setItem('forklift-cab-view', '1');
  localStorage.setItem('forklift-chase-cam', '0');
  tutDone.cab = true;
}

function setCameraChase() {
  if (mp?.observer || !glEnabled()) return;
  view.povBig = false;
  view.chase = true;
  view.look = null;
  view.manualCab = false;
  view.touchManualCab = false;
  view.orbit = null;
  view.chaseGoal = null;
  view.camP = null;
  localStorage.setItem('forklift-cab-view', '0');
  localStorage.setItem('forklift-chase-cam', '1');
}

function resetCamera() {
  if (!glEnabled()) return;
  view.look = null;
  view.orbit = null;
  view.manualCab = false;
  view.touchManualCab = false;
  view.chaseGoal = null;
  view.camP = null;
  view.camA = null;
  view.snap = false;
  view.chaseLiftTarget = 0;
  view.chaseLift = 0;
  if (view.chase) {
    view.chaseZoom = null;
    localStorage.removeItem('forklift-chase-zoom');
  } else if (!view.povBig) {
    view.zoom = null;
    localStorage.removeItem('forklift-ov-zoom');
  }
}

// Local multiplayer: gamepads join the running game as extra trucks (see local.js).
const toggleCab = (slot) => {
  view.cabs ||= new Set();
  if (!view.cabs.delete(slot)) view.cabs.add(slot);
};
const local = createLocal(toggleCab);
const startBtn = document.getElementById('startBtn');
const input = createInput({
  anyKey: startAudio,
  fullscreen: toggleFullscreen,
  toggleChase,
  cameraOverview: setCameraOverview,
  cameraCabin: setCameraCabin,
  cameraChase: setCameraChase,
  cameraReset: resetCamera,
  swapView: () => {
    if (mp?.observer || isTouch) return;
    if (view.shared) { toggleCab(game.self); return; }
    view.povBig = !view.povBig;
    localStorage.setItem('forklift-cab-view', view.povBig ? '1' : '0');
    if (view.povBig) tutDone.cab = true;
  },
  up: () => {
    if (mp?.observer) return;
    if (game.hard) return; // hard mode reads the held fork keys in update()
    if (mp?.role === 'guest') { mp.guest.sendFork('up'); noteForkResult('up', mp.guest.predictor.fork('up', performance.now() / 1000)); return; }
    const h = game.H;
    const res = forkUp(game);
    noteForkResult('up', res);
    if (res !== 'blocked' && game.H !== h) playFork(true);
  },
  down: () => {
    if (mp?.observer) return;
    if (game.hard) return;
    if (mp?.role === 'guest') { mp.guest.sendFork('down'); noteForkResult('down', mp.guest.predictor.fork('down', performance.now() / 1000)); return; }
    const h = game.H;
    const res = forkDown(game);
    noteForkResult('down', res);
    if (res !== 'blocked' && game.H !== h) playFork(false);
  },
  next: () => {
    if (mp?.role === 'guest' && roundDisplay?.eligible) roundReadyButton.click();
    else nextLevel();
  },
  menu: () => { if (!splashOn && !recordOpen) toggleMenu(true); },
  pause: () => { if (!splashOn && !recordOpen) toggleMenu(true); },
  menuToggle: () => { if (view.menuOpen) toggleMenu(false); else if (!splashOn && !recordOpen) toggleMenu(true); else if (splashOn) startBtn.click(); },
  menuNav: (dir) => padMenuNav(dir),
  menuSelect: () => { if (splashOn) startBtn.click(); else if (view.menuOpen) document.activeElement?.click?.(); },
  menuBack: () => { if (!view.menuOpen) return; if (menuEl.dataset.page !== 'main') showPage(parentPage()); else toggleMenu(false); },
  blocked: () => splashOn || recordOpen || !!view.menuOpen,
});

// On touch, tapping the "Level complete" board goes to the next level.
// Easter egg: in landscape, tapping the minimap swaps between the overview and the cab view.
const specialTouch = new WeakSet();
let lastTap = null;
if (isTouch) canvas.addEventListener('pointerdown', (e) => {
  if (splashOn || recordOpen || view.menuOpen) return;
  const r = canvas.getBoundingClientRect(), h = view.miniHit, x = e.clientX - r.left, y = e.clientY - r.top;
  if (h && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
    specialTouch.add(e);
    lastTap = null;
    view.povBig = !view.povBig;
  } else {
    if (game.status === 'won' || (game.endless && game.status === 'over')) { specialTouch.add(e); lastTap = null; }
    nextLevel();
  }
});

// Look around in the 3D views: drag the canvas or hold ,/. (or Q/W). The big view's camera swings around the forklift (overview,
// view.orbit { yaw, tilt }) or turns on the spot (cabin, view.look { yaw, pitch }); driving springs it back.
const CHASE_TILT_EASE = 0.8; // 1/s: how fast the moving chase camera returns to its default height
const CHASE_TURN = Math.PI / 4; // a ,/. press swings the chase camera this far around the forklift
const ORBIT_HOME = 0.35, ORBIT_TILT_MAX = 1.3, LOOK_PITCH_MAX = 0.7, LOOK_SPEED = 2;
// Flat overview: a ,/. press springs the camera a quarter turn (o.goal = target yaw) instead of turning continuously.
function quarterTurn(dir) {
  if (view.chase) { view.chaseGoal = (view.chaseGoal || 0) - dir * CHASE_TURN; lookState(); return; }
  const o = lookState(), q = Math.PI / 2;
  o.goal = (Math.round((o.goal ?? o.yaw) / q) - dir) * q;
}
// Chase camera: the user swings its floor position (view.camP) around the truck; it stays there and the normal rules (distance limits, drift) apply.
function swingChase(ang) {
  if (view.camP && ang) view.camP = chaseOrbit(game, view.camP, ang);
}
function turnStep(dt) {
  if (view.chase) {
    const goal = view.chaseGoal;
    if (!goal) return;
    const d = Math.abs(goal) < 0.003 ? goal : goal * (1 - Math.exp(-9 * dt));
    swingChase(d);
    view.chaseGoal = goal - d || null;
    return;
  }
  const o = view.orbit;
  if (!o || o.goal == null) return;
  o.yaw += (o.goal - o.yaw) * (1 - Math.exp(-9 * dt));
  if (Math.abs(o.goal - o.yaw) < 0.003) { o.yaw = wrap(o.goal); o.goal = null; }
}
const wrap = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
const orbitHome = () => (view.chase ? CHASE_TILT : ORBIT_HOME);
function lookState() {
  view.snap = false;
  return view.povBig ? (view.look ||= { yaw: 0, pitch: 0 }) : (view.orbit ||= { yaw: 0, tilt: orbitHome() });
}
function lookBy(dyaw, dpitch, manualCab = false) {
  const o = lookState();
  o.goal = null;
  if (view.chase) { view.chaseGoal = null; swingChase(-dyaw); } else o.yaw = wrap(o.yaw + lookYawDelta(dyaw, view.povBig));
  if (view.povBig) o.pitch = Math.min(LOOK_PITCH_MAX, Math.max(-LOOK_PITCH_MAX, o.pitch + dpitch));
  else o.tilt = Math.min(ORBIT_TILT_MAX, Math.max(0.05, o.tilt + dpitch));
  if (view.povBig && manualCab) view.manualCab = true;
}
function springBack(dt) {
  const k = 1 - Math.exp(-7 * dt);
  const o = view.orbit, l = view.look;
  if (o && !view.chase) {
    // the flat overview settles on the nearest quarter turn (the map stays rotated); the chase camera is left where the user put it
    const target = o.goal ?? Math.round(o.yaw / (Math.PI / 2)) * (Math.PI / 2);
    o.yaw += (target - o.yaw) * k;
    o.tilt -= (o.tilt - orbitHome()) * k;
    if (Math.abs(o.yaw - target) + Math.abs(o.tilt - orbitHome()) < 0.003) {
      o.goal = null;
      if (target === 0) view.orbit = null;
      else { o.yaw = wrap(target); o.tilt = orbitHome(); }
    }
  }
  if (l && !view.manualCab) { l.yaw -= l.yaw * k; l.pitch -= l.pitch * k; if (Math.abs(l.yaw) + Math.abs(l.pitch) < 0.003) view.look = null; }
  if ((!view.orbit || view.chase || view.orbit.yaw === Math.round(view.orbit.yaw / (Math.PI / 2)) * (Math.PI / 2)) && !view.look) view.snap = false;
}
canvas.addEventListener('pointerdown', () => { if (!splashOn) view.startHidden = true; }, true);
// Double tap (or double click) on the GL overview toggles the third-person camera.
const DOUBLE_TAP_MS = 350, DOUBLE_TAP_PX = 30;
function tapped(e) {
  const now = performance.now();
  if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DOUBLE_TAP_PX) {
    lastTap = null;
    toggleChase();
  } else {
    if (e.pointerType === 'touch') resetCamera();
    lastTap = { t: now, x: e.clientX, y: e.clientY };
  }
}
const cameraDragging = createCameraPointerInput(canvas, {
  allowed: (e) => {
    if (mp?.observer || e.target !== canvas || !glEnabled() || splashOn || recordOpen || view.menuOpen || specialTouch.has(e)) return false;
    if (e.pointerType !== 'touch') return true;
    if (!glAvailable()) return false;
    const r = canvas.getBoundingClientRect();
    return !inTouchControlZone(e.clientX - r.left, e.clientY - r.top, r.width, r.height, matchMedia('(orientation: landscape)').matches, view.shared ? game.trucks.length : 1);
  },
  move: (dx, dy, e) => {
    lastTap = null;
    const touchCab = e.pointerType === 'touch' && view.povBig;
    lookBy(dx * 0.008, dy * 0.006, touchCab);
    if (touchCab) view.touchManualCab = true;
  },
  tap: tapped,
  cancel: () => { lastTap = null; },
});

const pending = {};
recordName.addEventListener('keydown', (e) => e.stopPropagation());
document.getElementById('recordForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = recordName.value.trim() || 'Anonymous';
  savePlayerName(name);
  // addTop first: getTop falls back to the saved best, which would duplicate the new entry
  addTop(localStorage, pending.seed, pending.level, { ...pending.result, name });
  saveBest(localStorage, pending.seed, pending.level, { ...pending.result, name });
  if (pending.level === boardLevel() && pending.seed === seed) {
    view.best = getBest(localStorage, seed, boardLevel());
    view.localList = getTop(localStorage, seed, boardLevel());
  }
  closeRecord();
  syncScores(localStorage).then(() => refreshGlobal());
});

// Game over in endless mode: the run's points go to the local and global lists (level 0 of the seed).
function recordEndless(force = false) {
  if (!mp) localStorage.removeItem(ENDLESS_KEY);
  const result = { score: endlessScore(game.endless), time: game.time };
  if (!result.score) return;
  if (!force && !beats(result, getBest(localStorage, seed, 0))) {
    if (addTop(localStorage, seed, 0, { ...result, name: localStorage.getItem('forklift-player') || 'Anonymous' })) view.localList = getTop(localStorage, seed, 0);
    syncScores(localStorage).then(refreshGlobal);
    return;
  }
  Object.assign(pending, { seed, level: 0, result });
  document.getElementById('recordInfo').textContent = `Endless: ${game.endless.delivered} trucks, ${game.endless.boxes} boxes, ${result.score} points (${formatTime(result.time)})`;
  recordName.value = localStorage.getItem('forklift-player') || '';
  recordOpen = true;
  recordEl.classList.remove('hide');
  input.clear();
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (!(touch && recordName.value)) recordName.focus();
}

function checkRecord() {
  if ((game.status !== 'won' && !(game.endless && game.status === 'over')) || recorded) return;
  recorded = true;
  if (mp?.role === 'guest') return; // the host submits the shared score
  if (mp?.observer) {
    const players = mp.host.roundPlayers();
    const points = game.endless ? endlessScore(game.endless) : finalScore(score(game), game.time);
    const board = game.endless ? 0 : level;
    mp.host.startRound();
    const submission = observerPartyScore(seed, board, players, mp.name, points, game.time, mp.code, mp.host.token);
    if (players.length > 4) {
      roundScoreMessage.textContent = 'Score not submitted: the server supports at most four players.';
    } else if (submission) {
      const roundId = mp.host.roundState().id;
      submitPartyScore(submission.board, submission.entry).then((rank) => {
        if (rank == null && !isTesting() && mp?.observer && mp.host.roundState()?.id === roundId) roundScoreMessage.textContent = 'Could not submit the party score.';
      });
    }
    return;
  }
  if (game.endless) { recordEndless(manualEnd); manualEnd = false; return; }
  if (mp && liveTrucks(game).length > 1) {
    const players = game.trucks.filter((t) => !t.gone).map((t) => t.name || 'Player');
    submitPartyScore(partyBoard(seed, level, players.length), { name: mp.name, points: finalScore(score(game), game.time), time: game.time, level, party: { players, partyCode: mp.code, hostToken: mp.host.token } });
    return;
  }
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

// Each step is done when its action has happened (also if it happened earlier, so
// early presses are credited), but every step stays visible for at least MIN_MS.
const TUTORIAL = [
  { done: 'drive', get html() { return isTouch
    ? 'Use the <b>Forward</b>/<b>Back</b> buttons to drive and <b>◀/▶</b> to steer (the rear wheels steer, so the tail swings out!). Release the button to engine-brake.'
    : `Use <b>${wasd() ? 'W/S' : '↑/↓'}</b> to drive and <b>${wasd() ? 'A/D' : '←/→'}</b> to steer (the rear wheels steer, so the tail swings out!). Release the throttle to engine-brake.`; } },
  { done: 'fork', get html() { return isTouch
    ? 'Tap <b>Fork ▲</b> to raise the forks and <b>Fork ▼</b> to lower them. Drive the forks in under a stack to lift it.'
    : `Press <b>${wasd() ? 'E' : 'A'}</b> to raise the forks and <b>${wasd() ? 'Q' : 'Z'}</b> to lower them. Drive the forks in under a stack to lift it.`; } },
  { done: 'zone', html: isTouch
    ? 'Set a stack down on the zone of the matching colour (exactly the shown count), then park on the marked spot. Use <b>Menu</b> → Restart if you get stuck.'
    : 'Set a stack down on the zone of the matching colour (exactly the shown count), then park on the marked spot. Use <b>Menu</b> → Restart level if you get stuck.' },
  { done: 'cab', html: 'For a more immersive experience, press <b>Tab</b> or <b>M</b> to switch to the cab view (and again to return to the overview).' },
  { done: 'info', get html() { return isTouch
    ? 'Hold two fingers on the canvas to <b>honk</b>. Open <b>Menu</b> → <b>Info</b> for scoring and more tips.'
    : 'Extras: <b>C</b> chase camera, <b>,</b>/<b>.</b> rotate the camera (or drag it), hold <b>H</b> to honk, <b>F</b> full screen. Press <b>P</b> / <b>Esc</b> for the menu → <b>Info</b> for scoring and more tips.'; },
    extra: () => (theme().dark
      ? ' Prefer a brighter scene? Switch <b>Colour mode</b> to <b>Light</b> under Graphics.'
      : ' Try <b>Dark</b> colour mode under Graphics for headlights, ambient lights and disco lights.') },
];
if (isTouch) TUTORIAL.splice(3, 1);
const TUT_MIN_MS = 2500, TUT_INFO_MS = 20000;
const tutorialEl = document.getElementById('tutorial');
// ?skip hides the tutorial for this visit without saving it as done.
let tutStep = localStorage.getItem('forklift-tutorial-done') || new URLSearchParams(location.search).has('skip') ? -1 : 0;
let tutDone = {};
let tutShownAt = performance.now();
// One-off tip the first time the truck lifts or comes up to an open-top box; it takes over the banner for a few seconds.
const OPEN_TIP_KEY = 'forklift-opentop-tip', OPEN_TIP_MS = 8000, OPEN_TIP_DIST = 1.2;
const CEILING_TIP_KEY = 'forklift-ceiling-tip', FORKBOX_TIP_KEY = 'forklift-forkbox-tip', OIL_TIP_KEY = 'forklift-oil-tip';
let tipUntil = 0;
// One-off tips for events: the first blocked fork action (ceiling / lowering through a box) and the first damaged oil barrel.
const pendingTips = {};
function showTip(key, html) {
  if (mp?.observer) return;
  localStorage.setItem(key, '1');
  tipUntil = performance.now() + OPEN_TIP_MS;
  tutorialEl.classList.remove('hide');
  tutorialEl.innerHTML = `<small>Tip</small>${html}`;
}
const barrelDamaged = (pens = []) => pens.some((p, i) => p?.barrelPart === 'base' && (p.crash || 0) + (pens[i + 1]?.crash || 0) > 0);
function checkEventTips() {
  if (mp?.observer || tipUntil || splashOn || view.menuOpen) return;
  if (!localStorage.getItem(CEILING_TIP_KEY) && pendingTips.ceiling) showTip(CEILING_TIP_KEY, 'Carried boxes <b>hit the ceiling</b> and were damaged. Lower the forks before you drive on.');
  else if (!localStorage.getItem(FORKBOX_TIP_KEY) && pendingTips.forkbox) showTip(FORKBOX_TIP_KEY, 'You cannot lower the forks <b>through a box</b>: it gets damaged. Raise the forks or back out first, then lower them.');
  else if (!localStorage.getItem(OIL_TIP_KEY) && (barrelDamaged(game.carriedPen) || game.stacks.some((s) => barrelDamaged(s.pen)))) showTip(OIL_TIP_KEY, 'A damaged barrel <b>drips oil</b>, and oil is slippery. Don\'t worry, a <b>cleaning bot</b> has been dispatched to help you.');
  pendingTips.ceiling = pendingTips.forkbox = false;
}
// Called with the result of every fork action by the local player.
function noteForkResult(dir, res) {
  if (res !== 'blocked') return;
  playBlocked();
  rumble.pulse('blocked', 0.5, 0.2, 0.12);
  if (dir === 'down') pendingTips.forkbox = true;
  else if (game.carried || game.lifting >= 0) pendingTips.ceiling = true;
}
// Hard mode fork keys act inside update(); sounds and hints follow the events it reports.
let lastForkEv = null;
function watchForkEvents(ev) {
  if (!ev || ev === lastForkEv) return;
  lastForkEv = ev;
  noteForkResult(ev.dir > 0 ? 'up' : 'down', ev.res);
  if (ev.res !== 'blocked' && ev.moved) playFork(ev.dir > 0);
}
function checkOpenTip() {
  if (mp?.observer) return;
  if (tipUntil) {
    if (performance.now() < tipUntil) return;
    tipUntil = 0;
    showTutorial();
    return;
  }
  if (localStorage.getItem(OPEN_TIP_KEY) || splashOn || view.menuOpen) return;
  const near = topOpen(game.carriedPen) || game.stacks.some((s) => topOpen(s.pen) && Math.hypot(s.x - game.fl.x, s.y - game.fl.y) < OPEN_TIP_DIST);
  if (!near) return;
  localStorage.setItem(OPEN_TIP_KEY, '1');
  tipUntil = performance.now() + OPEN_TIP_MS;
  tutorialEl.classList.remove('hide');
  tutorialEl.innerHTML = '<small>Tip</small>This is an <b>open-top box</b>: nothing can be stacked on top of it.';
}
// Until the first repair on this device, carrying one damaged box shows a pop-up and the arrow/glow/blink in the views (js/repairhint.js).
let repairTipOn = false;
function checkRepairTip() {
  if (mp?.observer) { setRepairHint(false); return; }
  if (game.repair?.on) localStorage.setItem(REPAIRED_KEY, '1');
  const on = !splashOn && !view.menuOpen && !tipUntil && repairHintWanted(game, !!localStorage.getItem(REPAIRED_KEY));
  setRepairHint(on);
  if (on === repairTipOn) return;
  repairTipOn = on;
  if (on) {
    tutorialEl.classList.remove('hide');
    tutorialEl.innerHTML = '<small>Tip</small>This box is damaged, it can be <b>repaired at the repair station</b>. Big boxes and oil barrels cannot be repaired.';
  } else showTutorial();
}
function showTutorial() {
  tutShownAt = performance.now();
  if (mp?.observer) { tutorialEl.classList.add('hide'); return; }
  if (tipUntil || repairTipOn) return;
  tutorialEl.classList.toggle('hide', tutStep < 0);
  if (tutStep >= 0) tutorialEl.innerHTML = `<small>Tutorial ${tutStep + 1}/${TUTORIAL.length}</small>${TUTORIAL[tutStep].html}${TUTORIAL[tutStep].extra?.() ?? ''}`;
}
function nextTutorial() {
  tutStep = tutStep + 1 >= TUTORIAL.length ? -1 : tutStep + 1;
  if (tutStep < 0) localStorage.setItem('forklift-tutorial-done', '1');
  showTutorial();
}
let tutStart = { x: game.fl.x, y: game.fl.y };
function checkTutorial() {
  if (mp?.observer) { tutorialEl.classList.add('hide'); setRepairHint(false); return; }
  checkEventTips();
  checkOpenTip();
  checkRepairTip();
  if (tipUntil || repairTipOn) return;
  if (tutStart.g !== game) tutStart = { x: game.fl.x, y: game.fl.y, g: game };
  if (tutStep < 0) return;
  const g = game;
  if (Math.hypot(g.fl.x - tutStart.x, g.fl.y - tutStart.y) > 0.5) tutDone.drive = true;
  if (g.H !== tutLastH) tutDone.fork = true;
  tutLastH = g.H;
  if (countDone() > 0) tutDone.zone = true;
  if (view.menuOpen && !splashOn && TUTORIAL[tutStep].done === 'info' && performance.now() - tutShownAt > TUT_MIN_MS) tutDone.info = true;
  const age = performance.now() - tutShownAt;
  const step = TUTORIAL[tutStep];
  if (step.done === 'info' ? tutDone.info || age > TUT_INFO_MS : tutDone[step.done] && age > TUT_MIN_MS) nextTutorial();
}
const keySel = document.getElementById('keySel');
if (isTouch) document.getElementById('keyLabel').hidden = true;
document.getElementById('ctlDesktop').hidden = isTouch;
document.getElementById('ctlTouch').hidden = !isTouch;
// On touch devices the gamepad map only shows once a gamepad has been seen on this device.
const padMap = document.getElementById('padMap');
const padSeen = () => { localStorage.setItem('forklift-pad-seen', '1'); padMap.hidden = false; };
padMap.hidden = isTouch && !localStorage.getItem('forklift-pad-seen');
if (isTouch) { window.addEventListener('gamepadconnected', padSeen); if (standardPads().length) padSeen(); }
const keyMap = document.getElementById('keyMap');
keyMap.innerHTML = Object.entries(KEYBOARD).map(([name, o]) => `<div data-scheme="${name}" role="button" tabindex="0">${o.svg}<span>${o.label}</span></div>`).join('');
if (isTouch) keyMap.hidden = true;
const applyKeys = () => {
  input.setScheme(keySel.value);
  document.body.classList.toggle('keys-wasd', keySel.value === 'wasd');
  for (const d of keyMap.children) d.classList.toggle('on', d.dataset.scheme === keySel.value);
};
const savedKeys = localStorage.getItem('forklift-keys');
keySel.value = savedKeys === 'wasd' ? 'wasd' : 'arrows';
applyKeys();
keySel.addEventListener('change', () => { localStorage.setItem('forklift-keys', keySel.value); applyKeys(); });
const pickKeys = (e) => {
  const d = e.target.closest('[data-scheme]');
  if (!d || (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  keySel.value = d.dataset.scheme;
  keySel.dispatchEvent(new Event('change'));
};
keyMap.addEventListener('click', pickKeys);
const wasd = () => keySel.value === 'wasd';
let tutLastH = game.H;
const tutorialOpt = document.getElementById('tutorialOpt');
tutorialOpt.checked = tutStep >= 0;
const hardOpt = document.getElementById('hardOpt');
hardOpt.checked = hard;
hardOpt.addEventListener('change', () => {
  localStorage.setItem('forklift-hard', hardOpt.checked ? '1' : '0');
});
showTutorial();

function startGame(endless = false) {
  if (mp?.role === 'guest' && !mp.go) return; // waiting for the host
  if (mp?.role !== 'guest' && hardOpt.checked !== hard) {
    load(level);
  }
  if (endless && mp?.role !== 'guest') loadEndless();
  else refreshBest();
  if (mp?.observer) {
    tutStep = -1;
    tutDone = {};
    tutorialEl.classList.add('hide');
  } else if (tutorialOpt.checked) {
    localStorage.removeItem('forklift-tutorial-done');
    tutStep = 0;
    tutDone = {};
  } else {
    tutStep = -1;
    localStorage.setItem('forklift-tutorial-done', '1');
  }
  showTutorial();
  setFullscreen(true);
  splashOn = false;
  saveState();
  applyPause();
  splash.classList.add('hide');
  last = performance.now();
  if (mp?.role === 'host') mp.host.started(game);
}

document.getElementById('seedForm').addEventListener('submit', (e) => {
  e.preventDefault();
  startAudio();
  startGame(e.submitter && e.submitter.id === 'endlessStart');
});
window.addEventListener('keydown', (e) => {
  if (!splashOn || e.target === partyName || e.target === joinCode) return;
  e.stopImmediatePropagation();
  if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); startAudio(); startGame(); }
}, true);

// ---- Party (multiplayer): host a game from the splash and share the code, or join with a code ----
const partyName = document.getElementById('partyName');
const joinCode = document.getElementById('joinCode');
const menuLeave = document.getElementById('menuLeave');
const hostBtn = document.getElementById('hostBtn');
const joinBtn = document.getElementById('joinBtn');
const partyBox = document.getElementById('partyBox');
const partyList = document.getElementById('partyList');
const partyMsg = document.getElementById('partyMsg');
const partyErr = document.getElementById('partyErr');
partyName.value = localStorage.getItem('forklift-player') || '';
const observerOpt = document.getElementById('observerOpt');
const mpObserverOpt = document.getElementById('mpObserverOpt');
const partyNotice = sessionStorage.getItem('forklift-party-msg');
if (partyNotice) { partyErr.textContent = partyNotice; sessionStorage.removeItem('forklift-party-msg'); }
for (const el of [partyName, joinCode]) el.addEventListener('keydown', (e) => e.stopPropagation());
partyName.addEventListener('keydown', (e) => { if (e.key === 'Enter' && joinCode.value.trim()) { e.preventDefault(); joinParty(); } });
joinCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); joinParty(); } });
hostBtn.addEventListener('click', () => { startAudio(); hostParty(partyName.value, observerOpt.checked); });
joinBtn.addEventListener('click', () => { startAudio(); joinParty(); });
const leaveParty = () => {
  mp?.host?.close(); mp?.guest?.close(); mp = null;
  const url = new URL(location.href);
  url.searchParams.delete('observer'); url.searchParams.delete('multiplayer');
  history.replaceState(null, '', url);
  location.reload();
};
document.getElementById('partyLeave').addEventListener('click', leaveParty);
menuLeave.addEventListener('click', leaveParty);
window.addEventListener('pagehide', () => { mp?.host?.close(); mp?.guest?.close(); });
const busy = (on) => { hostBtn.disabled = joinBtn.disabled = on; };
function playerName() {
  const name = partyName.value.trim() || 'Player';
  savePlayerName(name);
  return name;
}
// The party ended or the connection dropped: back to a clean splash with a note.
function partyClosed(why) {
  if (why === 'left') return;
  sessionStorage.setItem('forklift-party-msg', why);
  location.reload();
}
function showParty(msg) {
  partyBox.hidden = false;
  document.getElementById('partyCode').textContent = mp.code;
  partyMsg.textContent = msg;
}
// `trucks` are the player slots ({ name, gone }); also feeds the in-game badge (view.party).
function refreshParty(trucks) {
  view.party = mp ? { code: mp.code } : null;
  if (mp?.role === 'host' && mp.observer) {
    const live = trucks.filter((t) => t && !t.gone).length;
    if (live < 4) {
      const url = new URL(location.href);
      url.search = '';
      url.searchParams.set('multiplayer', mp.code);
      url.hash = '';
      view.partyJoin = { code: mp.code, url: url.href };
    } else view.partyJoin = null;
  } else view.partyJoin = null;
  partyList.replaceChildren(...trucks.map((t, i) => {
    if (t.gone) return null;
    const li = document.createElement('li');
    li.style.setProperty('--c', truckColor(i).body);
    li.textContent = t.name || `Player ${i + 1}`;
    return li;
  }).filter(Boolean));
}
// The menu's multiplayer page: start hosting, or show the roster (host: ping, kick and ban).
const mpName = document.getElementById('mpName');
const mpErr = document.getElementById('mpErr');
mpName.addEventListener('keydown', (e) => e.stopPropagation());
document.getElementById('mpHost').addEventListener('click', () => { startAudio(); hostParty(mpName.value, mpObserverOpt.checked).catch(() => {}); });
document.getElementById('mpLeave').addEventListener('click', () => leaveParty());
function renderMpPage() {
  const box = document.getElementById('mpBox');
  document.getElementById('mpStart').hidden = !!mp;
  box.hidden = !mp;
  if (!mp) return;
  document.getElementById('mpCode').textContent = mp.code;
  const isHost = mp.role === 'host';
  const roster = isHost ? mp.host.players() : game.trucks.map((t, i) => (t.gone ? null : { slot: i, name: t.name })).filter(Boolean);
  document.getElementById('mpList').replaceChildren(...roster.map((p) => {
    const li = document.createElement('li');
    li.style.setProperty('--c', truckColor(p.slot).body);
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = (p.name || `Player ${p.slot + 1}`) + (!mp.observer && p.slot === game.self ? ' (you)' : '') + (!mp.observer && p.slot === 0 ? ' – host' : '');
    li.append(nm);
    if (isHost) {
      const ping = document.createElement('span');
      ping.className = 'ping';
      ping.textContent = (!mp.observer && p.slot === 0) ? '' : p.ping == null ? '… ms' : `${p.ping} ms`;
      li.append(ping);
      if (mp.observer || p.slot !== 0) for (const [label, ban] of [['Kick', false], ['Ban', true]]) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'sec'; b.textContent = label;
        b.addEventListener('click', () => mp.host.kick(p.slot, ban));
        li.append(b);
      }
    }
    return li;
  }));
}
setInterval(() => { if (view.menuOpen && menuEl.dataset.page === 'party') renderMpPage(); }, 1000);
async function hostParty(nameText = partyName.value, observer = observerOpt.checked) {
  if (mp) return;
  const name = (nameText.trim() || 'Player').slice(0, 24);
  savePlayerName(name);
  partyErr.textContent = '';
  busy(true);
  const host = createHost({ relay: createRelay(), getGame: () => game, levelInfo: () => ({ level, seed, hard, seedText, endless: !!game.endless }), isStarted: () => !splashOn, name, meta: { observer }, onChange: () => { refreshParty(game.trucks); renderMpPage(); }, onClosed: partyClosed, onRound: observerRoundChanged });
  try { await host.start(); } catch (e) { busy(false); partyErr.textContent = mpErr.textContent = e.message; return; }
  stateHistory?.clear();
  mpErr.textContent = '';
  stopLocal();
  mp = { role: 'host', code: host.code, name, host, observer };
  if (observer) {
    removeTruck(game, 0);
    view.fullMap = true;
    view.povBig = false;
    view.chase = false;
    view.zoom = null;
    view.orbit = null;
    document.body.classList.add('observer-party');
    tutorialEl.classList.add('hide');
    resize();
  } else {
    game.trucks[0].name = name;
    view.fullMap = false;
  }
  showParty('Press Start when everyone has joined (others can still join later).');
  refreshParty(game.trucks);
  renderMpPage();
}
async function joinParty() {
  if (mp) return;
  const code = joinCode.value.trim().toUpperCase();
  if (code.length < 4) { partyErr.textContent = 'Enter the party code you were given'; return; }
  const name = playerName();
  partyErr.textContent = '';
  busy(true);
  let playerId = sessionStorage.getItem('forklift-party-player-id');
  if (!playerId) {
    playerId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem('forklift-party-player-id', playerId);
  }
  const guest = createGuest({ relay: createRelay(), code, name, playerId, onGame: onGuestGame, onClosed: partyClosed, onRound: showRound });
  stateHistory?.clear();
  stopLocal();
  mp = { role: 'guest', code, name, guest, go: false, connected: false, lastH: null };
  try { await guest.join(); } catch (e) { mp = null; busy(false); partyErr.textContent = e.message; return; }
  showParty('Connecting…');
  mp.timer = setTimeout(() => { if (mp && !mp.connected) partyClosed('Could not connect to the host (a firewall may be blocking the connection)'); }, 20000);
}
// The host's level (welcome, and again on every level change): build it and mirror the host's state.
function onGuestGame(m) {
  if (mp?.role !== 'guest') return;
  showRound(null);
  if (m.t === 'welcome') history.replaceState(null, '', withoutJoinParam(location.href));
  mp.connected = true;
  clearTimeout(mp.timer);
  level = m.level; seed = m.seed; seedText = m.seedText || ''; hard = m.hard;
  game = m.endless ? newEndless(seed, hard) : newGame(level, seed, hard);
  game.self = m.slot;
  applySnapshot(game, m.snap);
  mp.guest.predictor.reset(game);
  doneZones = doneSet();
  hitCount = game.hitCount;
  bonkCount = game.bonks;
  recorded = true; // only the host records scores
  mp.lastH = null;
  refreshBest();
  refreshParty(m.snap.trucks);
  if (m.started) { mp.go = true; if (splashOn) startGame(); }
  else showParty('Connected – waiting for the host to start…');
}

const menuEl = document.getElementById('menu');
const volSliders = [...menuEl.querySelectorAll('input.vol')];
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
const menuEndRun = document.getElementById('menuEndRun');
const decalOpt = document.getElementById('decalOpt');
const batteryResolutionOpt = document.getElementById('batteryResolutionOpt');
const batteryFrameRateOpt = document.getElementById('batteryFrameRateOpt');
const batteryEffectsOpt = document.getElementById('batteryEffectsOpt');
const glOpt = document.getElementById('glOpt');
const glParam = new URLSearchParams(location.search).get('gl');
setGlEnabled(glParam ? glParam !== '0' : localStorage.getItem('forklift-gl-off') !== '1');
if (!startSplash3d(document.getElementById('splashGl'), () => splashOn, () => lowerResolutionOn, () => limitFrameRateOn)) startSplashAnimation(document.getElementById('splashAnim'), () => splashOn, () => lowerResolutionOn, () => limitFrameRateOn);
let decalsPreference = localStorage.getItem('forklift-decals-off') !== '1';
setDecalsEnabled(decalsPreference && !reduceEffectsOn);
const themeSel = document.getElementById('themeSel');
setThemeMode(localStorage.getItem('forklift-theme'));
const bareOpt = document.getElementById('bareOpt');
const chaseOpt = document.getElementById('chaseOpt');
const rumbleOpt = document.getElementById('rumbleOpt');
rumbleOpt.checked = localStorage.getItem('forklift-rumble') !== '0';
rumbleOpt.addEventListener('change', () => localStorage.setItem('forklift-rumble', rumbleOpt.checked ? '1' : '0'));
// Rumble subpage: effect, strength, one checkbox per feature (disabled ones saved as a comma list in forklift-rumble-off).
// Phone vibration (navigator.vibrate): same mix as the rumble, only after a touch; hidden where the browser has no API.
const vibrateOpt = document.getElementById('vibrateOpt');
vibrateOpt.checked = localStorage.getItem('forklift-vibrate') !== '0';
vibrateOpt.addEventListener('change', () => localStorage.setItem('forklift-vibrate', vibrateOpt.checked ? '1' : '0'));
document.getElementById('vibrateRow').hidden = !vibrateSupported();
const rumbleEffect = document.getElementById('rumbleEffect');
const rumbleStrength = document.getElementById('rumbleStrength');
const rumbleSupportEl = document.getElementById('rumbleSupport');
for (const [id, name] of RUMBLE_EFFECTS) rumbleEffect.add(new Option(name, id));
rumble.effect = RUMBLE_EFFECTS.some(([id]) => id === localStorage.getItem('forklift-rumble-effect')) ? localStorage.getItem('forklift-rumble-effect') : 'auto';
rumbleEffect.value = rumble.effect;
rumbleEffect.addEventListener('change', () => { rumble.effect = rumbleEffect.value; localStorage.setItem('forklift-rumble-effect', rumble.effect); });
const savedStrength = Number(localStorage.getItem('forklift-rumble-strength') ?? NaN);
rumble.strength = Number.isFinite(savedStrength) ? Math.max(0, Math.min(1, savedStrength)) : RUMBLE_STRENGTH;
rumbleStrength.value = Math.round(rumble.strength * 100);
rumbleStrength.addEventListener('input', () => { rumble.strength = rumbleStrength.value / 100; localStorage.setItem('forklift-rumble-strength', String(rumble.strength)); });
const rumbleOff = new Set((localStorage.getItem('forklift-rumble-off') || '').split(',').filter(Boolean));
for (const [id, name] of RUMBLE_FEATURES) {
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !rumbleOff.has(id);
  rumble.setFeature(id, box.checked);
  box.addEventListener('change', () => {
    rumble.setFeature(id, box.checked);
    if (box.checked) rumbleOff.delete(id); else rumbleOff.add(id);
    localStorage.setItem('forklift-rumble-off', [...rumbleOff].join(','));
  });
  label.append(box, ` ${name}`);
  document.getElementById('rumbleFeatures').append(label);
}
document.getElementById('rumbleTest').addEventListener('click', () => {
  const gp = standardPads()[0]?.gp;
  const s = rumble.strength;
  if (gp) sendRumble(gp, 0.8 * s, 0.6 * s, 250, rumble.effect);
  if (vibrateSupported() && vibrateOpt.checked) { try { navigator.vibrate(Math.round(250 * Math.max(0.2, s))); } catch { /* best effort */ } }
});
// Temporary, only with ?controller: V opens the menu on the Rumble page, for tuning the rumble while testing a pad.
if (new URLSearchParams(location.search).has('controller')) {
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyV' || e.repeat || e.altKey || e.ctrlKey || e.metaKey || splashOn || recordOpen || view.menuOpen) return;
    e.preventDefault();
    toggleMenu(true);
    showPage('rumble');
  });
}
// What the first pad can play, shown under the effect drop-down while the menu is open.
function showRumbleSupport() {
  const gp = standardPads()[0]?.gp;
  const can = gp ? rumbleSupport(gp) : null;
  const text = !gp ? 'No gamepad found (press a button on it).' : can.length ? `This gamepad supports: ${RUMBLE_EFFECTS.filter(([id]) => can.includes(id)).map(([, n]) => n).join(', ')}.` : 'This gamepad/browser has no rumble.';
  if (rumbleSupportEl.textContent !== text) rumbleSupportEl.textContent = text;
}
setInterval(() => { if (view.menuOpen && menuEl.dataset.page === 'rumble') showRumbleSupport(); }, 1000); // the game loop is paused in the menu
const chaseZoomSel = document.getElementById('chaseZoom');
setBareForks(localStorage.getItem('forklift-bare-forks') === '1');
const discoOpt = document.getElementById('discoOpt');
let discoPreference = localStorage.getItem('forklift-disco') === '1';
setDiscoEnabled(discoPreference && !reduceEffectsOn);
setParticlesEnabled(!reduceEffectsOn);
const menuHardOpt = document.getElementById('menuHardOpt');
menuHardOpt.addEventListener('change', () => {
  hardOpt.checked = menuHardOpt.checked;
  hardOpt.dispatchEvent(new Event('change'));
});
const localOpt = document.getElementById('localOpt');
function stopLocal() {
  localOpt.checked = false;
  input.setLocalMode(false);
  local.clear(game);
}
localOpt.addEventListener('change', () => {
  input.setLocalMode(localOpt.checked);
  if (!localOpt.checked) local.clear(game);
});
// ?local turns on local multiplayer for this visit
if (new URLSearchParams(location.search).has('local')) {
  localOpt.checked = true;
  input.setLocalMode(true);
}
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
  if (name === 'rumble') showRumbleSupport();
}
// The page the current page's Back button goes to (subpages like Rumble return to Controls).
const parentPage = () => menuEl.querySelector('.page:not([hidden]) .back')?.dataset.go || 'main';
menuEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (b) showPage(b.dataset.go);
});
// Gamepad menu navigation: up/down move the focus between the visible controls, left/right adjust sliders, drop-downs and number fields.
function padMenuNav(dir) {
  if (!view.menuOpen) return;
  const items = [...menuEl.querySelectorAll('button, input:not([type=hidden]), select, textarea')].filter((el) => !el.disabled && el.offsetParent !== null);
  const cur = document.activeElement;
  if (dir === 'up' || dir === 'down') {
    const i = items.indexOf(cur);
    const n = dir === 'down' ? (i + 1) % items.length : (i <= 0 ? items.length : i) - 1;
    items[n]?.focus();
    items[n]?.scrollIntoView?.({ block: 'nearest' });
    return;
  }
  const d = dir === 'right' ? 1 : -1;
  if (cur?.tagName === 'SELECT') {
    const n = Math.max(0, Math.min(cur.options.length - 1, cur.selectedIndex + d));
    if (n !== cur.selectedIndex) { cur.selectedIndex = n; cur.dispatchEvent(new Event('input', { bubbles: true })); cur.dispatchEvent(new Event('change', { bubbles: true })); }
  } else if (cur?.tagName === 'INPUT' && (cur.type === 'range' || cur.type === 'number')) {
    if (d > 0) cur.stepUp(); else cur.stepDown();
    cur.dispatchEvent(new Event('input', { bubbles: true }));
    cur.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
function toggleMenu(open) {
  if (open && !view.menuOpen) saveState();
  view.menuOpen = open;
  setFullscreen(!open);
  menuEl.classList.toggle('hide', !open);
  if (open) {
    if (stateHistory) stateMsg.textContent = stateHistory.earlier() ? '' : 'Five seconds of gameplay history are not yet available.';
    muteOpt.checked = isAllMuted();
    for (const el of volSliders) el.value = Math.round(getVolume(el.dataset.vol) * 100);
    musicOpt.checked = !isMusicMuted();
    batteryResolutionOpt.checked = lowerResolutionOn;
    batteryFrameRateOpt.checked = limitFrameRateOn;
    batteryEffectsOpt.checked = reduceEffectsOn;
    decalOpt.checked = decalsPreference;
    glOpt.checked = glEnabled();
    discoOpt.checked = discoPreference;
    bareOpt.checked = bareForksEnabled();
    chaseOpt.checked = view.chase;
    chaseZoomSel.value = view.chaseZoom ?? chaseZoomOf(Math.max(CHASE_TILES, (view.ovTiles || 14) * CHASE_DEFAULT));
    themeSel.value = themeMode();
    menuHardOpt.checked = hardOpt.checked;
    localOpt.disabled = !!mp;
    menuLevel.value = level;
    for (const el of menuEl.querySelectorAll('[data-hostonly]')) el.hidden = mp?.role === 'guest';
    menuLeave.hidden = !mp;
    menuLeave.textContent = mp?.observer ? 'End game' : 'Leave party';
    menuEndRun.hidden = !game.endless || game.status === 'over' || mp?.role === 'guest';
    mpName.value = localStorage.getItem('forklift-player') || '';
    mpObserverOpt.checked = mp?.observer ?? observerOpt.checked;
    renderMpPage();
    updateTutorialBtn();
    showPage('main');
  } else {
    document.activeElement?.blur();
  }
  input.clear();
  applyPause();
}
muteOpt.addEventListener('change', () => setAllMuted(muteOpt.checked));
for (const el of volSliders) el.addEventListener('input', () => { setVolume(el.dataset.vol, Number(el.value) / 100); startAudio(); });
decalOpt.addEventListener('change', () => {
  decalsPreference = decalOpt.checked;
  setDecalsEnabled(decalsPreference && !reduceEffectsOn);
  localStorage.setItem('forklift-decals-off', decalOpt.checked ? '0' : '1');
});
function saveBatteryOption(option, enabled) {
  localStorage.setItem(`forklift-battery-saver-${option}`, enabled ? '1' : '0');
}
batteryResolutionOpt.addEventListener('change', () => {
  lowerResolutionOn = batteryResolutionOpt.checked;
  saveBatteryOption('resolution', lowerResolutionOn);
  resize();
});
batteryFrameRateOpt.addEventListener('change', () => {
  limitFrameRateOn = batteryFrameRateOpt.checked;
  saveBatteryOption('frame-rate', limitFrameRateOn);
});
batteryEffectsOpt.addEventListener('change', () => {
  const wasOn = reduceEffectsOn;
  reduceEffectsOn = batteryEffectsOpt.checked;
  saveBatteryOption('effects', reduceEffectsOn);
  setDecalsEnabled(decalsPreference && !reduceEffectsOn);
  setDiscoEnabled(discoPreference && !reduceEffectsOn);
  setParticlesEnabled(!reduceEffectsOn);
  if (reduceEffectsOn && !wasOn) {
    clearPhotos();
    galleryGame = null;
  }
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
  discoPreference = discoOpt.checked;
  setDiscoEnabled(discoPreference && !reduceEffectsOn);
  localStorage.setItem('forklift-disco', discoPreference ? '1' : '0');
});
const zoomSlider = document.getElementById('zoomSlider');
const zoomBar = document.getElementById('zoomBar');
function syncZoomBar() {
  zoomBar.classList.toggle('hide', splashOn || !!view.menuOpen || view.povBig);
  if (document.activeElement !== zoomSlider) zoomSlider.value = (view.chase ? view.chaseZoom : view.zoom) ?? chaseZoomOf(view.chase ? Math.max(CHASE_TILES, (view.ovTiles || 14) * CHASE_DEFAULT) : view.ovTiles || 14);
}
setInterval(syncZoomBar, 200);
zoomSlider.addEventListener('input', () => {
  if (view.chase) {
    view.chaseZoom = Number(zoomSlider.value);
    localStorage.setItem('forklift-chase-zoom', String(view.chaseZoom));
  } else {
    view.zoom = Number(zoomSlider.value);
    localStorage.setItem('forklift-ov-zoom', String(view.zoom));
  }
});
zoomSlider.addEventListener('change', () => zoomSlider.blur()); // keep arrow keys for driving
chaseZoomSel.addEventListener('input', () => {
  view.chaseZoom = Number(chaseZoomSel.value);
  localStorage.setItem('forklift-chase-zoom', String(view.chaseZoom));
});
document.getElementById('chaseZoomReset').addEventListener('click', (e) => {
  e.preventDefault();
  view.chaseZoom = null;
  localStorage.removeItem('forklift-chase-zoom');
  chaseZoomSel.value = chaseZoomOf(Math.max(CHASE_TILES, (view.ovTiles || 14) * CHASE_DEFAULT));
});
chaseOpt.addEventListener('change', () => {
  view.chase = chaseOpt.checked;
  view.orbit = null;
  localStorage.setItem('forklift-chase-cam', view.chase ? '1' : '0');
});
bareOpt.addEventListener('change', () => {
  setBareForks(bareOpt.checked);
  localStorage.setItem('forklift-bare-forks', bareOpt.checked ? '1' : '0');
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
const touchMap = document.getElementById('touchMap');
touchMap.innerHTML = Object.entries(TOUCH).map(([name, o]) => `<div data-scheme="${name}" role="button" tabindex="0">${o.svg}<span>${o.label}</span></div>`).join('');
touchMap.hidden = !isTouch;
const markTouch = () => { for (const d of touchMap.children) d.classList.toggle('on', d.dataset.scheme === touchSel.value); };
const applyTouch = () => {
  touchPad.dataset.scheme = touchSel.value;
  markTouch();
  localStorage.setItem('forklift-touch-scheme', touchSel.value);
  input.clear();
};
touchSel.addEventListener('change', applyTouch);
touchMap.addEventListener('click', (e) => {
  const d = e.target.closest('[data-scheme]');
  if (d) { touchSel.value = d.dataset.scheme; touchSel.dispatchEvent(new Event('change')); }
});
markTouch();
// First run on the splash: nothing saved yet, so ask which control scheme to use.
if (!localStorage.getItem(isTouch ? 'forklift-touch-scheme' : 'forklift-keys') && !new URLSearchParams(location.search).has('skip') && !new URLSearchParams(location.search).has('observer')) {
  pickScheme(isTouch ? 'touch' : 'keyboard').then((name) => {
    if (isTouch) { touchSel.value = name; applyTouch(); } else { keySel.value = name; localStorage.setItem('forklift-keys', name); applyKeys(); }
  });
}
musicOpt.addEventListener('change', () => setMusicMuted(!musicOpt.checked));
document.getElementById('menuGoto').addEventListener('submit', (e) => {
  e.preventDefault();
  if (mp?.observer && mp.host.roundState()) return;
  const n = parseInt(menuLevel.value, 10);
  if (n >= 1) { load(n); toggleMenu(false); }
});
document.getElementById('menuLowest').addEventListener('click', () => {
  load(lowestUnscored(localStorage, seed));
  toggleMenu(false);
});
const pullMsg = document.getElementById('pullMsg');
const pullName = document.getElementById('pullName');
// One player name shared by the record form, the party fields, the multiplayer menu page and the pull-scores field.
const nameInputs = [recordName, partyName, mpName, pullName];
function savePlayerName(name) {
  name = name.slice(0, 24);
  localStorage.setItem('forklift-player', name);
  for (const el of nameInputs) if (el.value !== name) el.value = name;
}
for (const el of nameInputs) el.addEventListener('input', () => {
  const name = el.value.slice(0, 24);
  localStorage.setItem('forklift-player', name);
  for (const o of nameInputs) if (o !== el) o.value = name;
});
for (const el of nameInputs) el.value = localStorage.getItem('forklift-player') || '';
document.getElementById('menuPull').addEventListener('click', async () => {
  let name = pullName.value.trim() || (localStorage.getItem('forklift-player') || '').trim();
  if (!name) name = (prompt('Player name to pull scores for:') || '').trim();
  if (!name) return;
  savePlayerName(name);
  pullMsg.textContent = 'Pulling…';
  const r = await pullScores(localStorage, name);
  if (!r) { pullMsg.textContent = 'Offline: could not reach the score server.'; return; }
  refreshBest();
  pullMsg.textContent = r.fetched ? `Pulled ${r.fetched} score${r.fetched === 1 ? '' : 's'} for ${name}; ${r.added} new or better.` : `No online scores found for ${name}.`;
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
    tutDone = {};
    localStorage.removeItem('forklift-tutorial-done');
    tutStart = { x: game.fl.x, y: game.fl.y, g: game };
  }
  showTutorial();
  updateTutorialBtn();
});
document.getElementById('menuFullscreen').addEventListener('click', toggleFullscreen);
document.getElementById('menuResume').addEventListener('click', () => toggleMenu(false));
document.getElementById('menuRestart').addEventListener('click', () => {
  if (mp?.observer && mp.host.roundState()) return;
  if (game.endless) loadEndless(true); else load(level);
  toggleMenu(false);
});
document.getElementById('menuEndless').addEventListener('click', () => {
  if (!game.endless) loadEndless();
  toggleMenu(false);
});
menuEndRun.addEventListener('click', () => {
  manualEnd = true;
  endEndless(game);
  toggleMenu(false);
});
// While the menu is open it swallows all keys (so the game keys do nothing); Tab/Space/Enter still work on its controls.
window.addEventListener('keydown', (e) => {
  if (!view.menuOpen) return;
  e.stopImmediatePropagation();
  if (e.target.closest?.('#keyMap')) { if (e.code === 'Enter' || e.code === 'Space') pickKeys(e); if (e.code !== 'Escape') return; }
  const typing = e.target === menuLevel || e.target === pullName;
  if (e.target === stateText) { if (e.code === 'Escape') { e.preventDefault(); showPage('main'); } return; }
  if (e.code === 'Escape' && menuEl.dataset.page !== 'main') { e.preventDefault(); showPage(parentPage()); return; }
  if (e.code === 'Escape' || (e.code === 'KeyP' && !typing)) { e.preventDefault(); toggleMenu(false); return; }
  if (e.code === 'Enter' && e.target !== menuLevel && e.target !== pullName) { e.preventDefault(); toggleMenu(false); return; }
  if (e.target === trackSel || e.target === themeSel) return;
  if (typing || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
  if (mp?.observer && e.code === 'KeyM') return;
  const actions = {
    KeyM: () => { muteOpt.checked = !muteOpt.checked; muteOpt.dispatchEvent(new Event('change')); },
    KeyG: () => { showPage('play'); menuLevel.focus(); menuLevel.select(); },
  };
  if (actions[e.code]) { e.preventDefault(); actions[e.code](); }
}, true);

const stateText = document.getElementById('stateText');
const stateMsg = document.getElementById('stateMsg');
const stateSnapshot = () => game.endless ? { ...serializeEndless(game), seedText } : serializeGame(game, seedText);
async function exportSnapshot(snap) {
  stateText.value = debug ? JSON.stringify(snap) : await encodeState(snap);
  stateText.select();
  try {
    await navigator.clipboard.writeText(stateText.value);
    stateMsg.textContent = 'Exported and copied to clipboard.';
  } catch { stateMsg.textContent = 'Exported; copy the text above.'; }
}
document.getElementById('stateExport').addEventListener('click', () => exportSnapshot(stateSnapshot()));
document.getElementById('stateExportEarlier').addEventListener('click', () => {
  const snap = stateHistory?.earlier();
  if (!snap) { stateMsg.textContent = 'Five seconds of gameplay history are not yet available.'; return; }
  exportSnapshot(snap);
});
document.getElementById('stateImport').addEventListener('click', async () => {
  if (mp?.role === 'guest') return;
  let g, data;
  try {
    data = await decodeState(stateText.value);
    g = data && data.endless ? deserializeEndless(data) : deserializeGame(data);
  } catch (err) {
    stateMsg.textContent = `Import failed: ${err.message}`;
    return;
  }
  if (recordOpen) closeRecord();
  stateHistory?.clear();
  seed = g.seed;
  hard = g.hard;
  if (!g.endless) level = g.level;
  localStorage.setItem('forklift-hard', hard ? '1' : '0');
  if (!g.endless) localStorage.setItem('forklift-level', String(level));
  hardOpt.checked = hard;
  game = g;
  recorded = g.status === 'won';
  doneZones = doneSet();
  hitCount = g.hitCount;
  bonkCount = g.bonks;
  otherBonks.clear();
  otherH.clear();
  partyGameChanged();
  refreshBest();
  saveState();
  toggleMenu(false);
});
const lostFocus = () => document.hidden || !document.hasFocus();
function applyPause() {
  const p = !!view.menuOpen && !mp; // the others keep driving, so a party never pauses
  if (!p && view.paused) last = performance.now();
  view.paused = p;
  setSilenced(!!view.menuOpen || splashOn); // the splash diorama stays quiet
  if (!p) scheduleFrame();
}
// Losing focus opens the same pause menu as Esc/P; the player must click Resume (or press Esc/P) to continue, just like any other pause.
const pauseOnBlur = () => { if (!splashOn && !recordOpen && !mp && lostFocus()) toggleMenu(true); };
window.addEventListener('blur', pauseOnBlur);
window.addEventListener('focus', applyPause);
document.addEventListener('visibilitychange', () => {
  setPageHidden(document.hidden);
  pauseOnBlur();
});
setPageHidden(document.hidden);
pauseOnBlur();
applyPause();

const debug = debugEnabled(location.search) ? createDebug() : null;
initTestingBanner();
if (!isTesting()) document.getElementById('stateSection')?.remove();
const STEP = 1 / 120;
let acc = 0, last = performance.now();
if (new URLSearchParams(location.search).has('endless')) loadEndless();
// ?skip in the URL bypasses the splash (on touch it opens the main menu; keeps saved settings; no audio until a key/click starts it)
if (new URLSearchParams(location.search).has('skip') && !new URLSearchParams(location.search).has('observer') && !new URLSearchParams(location.search).has('multiplayer')) {
  startGame();
  // On touch, start in the main menu: leaving it is the user gesture that lets full-screen kick in (auto full-screen on for this visit only; not saved)
  if (isTouch) { autoFs = true; autoFsOpt.checked = true; toggleMenu(true); }
}
const multiplayerParam = new URLSearchParams(location.search).get('multiplayer');
if (multiplayerParam) {
  joinCode.value = multiplayerParam.trim().toUpperCase();
  partyErr.textContent = `${partyNotice ? partyNotice + ' ' : ''}Confirm your name and select Join game.`;
  partyName.focus();
}
if (new URLSearchParams(location.search).has('observer') && !multiplayerParam) {
  observerOpt.checked = true;
  hostParty(partyName.value, true).then(() => { if (mp?.observer) startGame(); });
}
const START_BOARD_SECS = 10;
let lastDraw = -Infinity;
function frame(now) {
  rafPending = false;
  if (view.paused) return;
  const dtReal = Math.min(0.1, (now - last) / 1000);
  acc += dtReal;
  last = now;
  // the start board hides on touch/click (below) or after START_BOARD_SECS of being visible
  if (view.startG !== game) { view.startG = game; view.startT = 0; view.startHidden = false; }
  if (!splashOn && !view.paused && !view.menuOpen && !game.started && (view.startT += dtReal) > START_BOARD_SECS) view.startHidden = true;
  if (view.paused) acc = 0;
  const t0 = performance.now();
  let steps = 0;
  // Camera follow-up for one step of `dt` seconds (the heading of the chase camera, look-around spring-back).
  const cameraStep = (inp, dt) => {
    view.gamepadCab = inp.motionSource === 'gamepad';
    if (inp.up || inp.down || inp.left || inp.right) view.snap = true;
    if (!splashOn && glEnabled()) {
      const pitch = (inp.lookU ? 1 : 0) - (inp.lookD ? 1 : 0);
      if (view.povBig) {
        if (inp.lookL || inp.lookR || inp.lookU || inp.lookD) lookBy((inp.lookR - inp.lookL) * LOOK_SPEED * dt, pitch * LOOK_SPEED * dt, true);
      }
      else {
        if (inp.lookR && !view.lookHeld?.R) quarterTurn(1);
        if (inp.lookL && !view.lookHeld?.L) quarterTurn(-1);
        if (inp.lookU || inp.lookD) lookBy(0, pitch * LOOK_SPEED * dt);
        turnStep(dt);
      }
      view.lookHeld = { L: inp.lookL, R: inp.lookR };
    }
    if (view.snap) springBack(dt);
    // the chase camera slowly eases back to its default height while it moves (driving, swinging or pitching)
    if (view.chase && view.orbit && (inp.up || inp.down || inp.left || inp.right || inp.lookL || inp.lookR || view.chaseGoal || cameraDragging())) {
      const o = view.orbit;
      o.tilt -= (o.tilt - CHASE_TILT) * (1 - Math.exp(-CHASE_TILT_EASE * dt));
      if (Math.abs(o.tilt - CHASE_TILT) < 0.003) o.tilt = CHASE_TILT;
    }
  };
  const followStep = (dt) => {
    // the chase camera position is kept by render.js (chaseRig); a new game starts it behind the forklift
    if (game !== view.camG || !view.chase) view.camP = null;
    else if (view.camP && view.chaseD) view.camP = chaseDrift(game, view.camP, view.chaseD, dt);
    const tgt = view.chase ? view.chaseLiftTarget || 0 : 0, cur = view.chaseLift || 0;
    view.chaseLift = cur + (tgt - cur) * (1 - Math.exp(-(tgt > cur ? 8 : 3) * dt));
  };
  if (mp?.role === 'guest') {
    // a guest never steps the game: it sends its keys and shows what the host sends
    acc = 0;
    const sec = performance.now() / 1000;
    if (!splashOn && mp.go && mp.guest.interp.apply(game, sec)) {
      const inp = input.state();
      mp.guest.sendInput(inp);
      if (!view.paused) mp.guest.predictor.step(game, inp, dtReal, sec);
      mp.guest.predictor.apply(game, sec);
      cameraStep(inp, dtReal);
      followStep(dtReal);
      if (game.hard) watchForkEvents(mp.guest.predictor.fkEv());
      else if (game.H !== mp.lastH) { if (mp.lastH != null) playFork(game.H > mp.lastH); mp.lastH = game.H; }
    }
  }
  watchPops();
  if (mp?.role !== 'guest' && !mp?.observer) watchForkEvents(game.fk.ev);
  if (!mp && !splashOn && !view.paused && !view.menuOpen && localOpt.checked) local.step(game, performance.now() / 1000);
  view.shared = !mp && localOpt.checked && local.players > 0;
  while (mp?.role !== 'guest' && !splashOn && !view.paused && acc >= STEP) {
    const inp = input.state();
    if (!mp?.observer) cameraStep(inp, STEP);
    update(game, mp?.observer ? null : inp, STEP);
    stepEndless(game, STEP);
    if (game.status === 'play' && !view.menuOpen) stateHistory?.step(STEP, stateSnapshot);
    followStep(STEP);
    acc -= STEP;
    steps++;
  }
  if (mp?.role === 'host' && !splashOn) mp.host.broadcast(game);
  const t1 = performance.now();
  checkTutorial();
  checkRecord();
  updateRoundDisplay();
  const st = input.state();
  const won = game.status === 'won'; // end-of-level screen: continuous sfx are cut (jingle and music go on)
  setCrashAlert(!mp?.observer && crashAlert(game) && !splashOn && !view.paused && !won);
  if (won || mp?.observer) setEngine(0, false, false, game.self, 0);
  else setEngine(game.fl.speed, st.up || st.down, game.fl.gear === 'R', game.self);
  if (!mp?.observer) game.horn = !!st.horn && !splashOn && !view.paused;
  setHorns(game.trucks.map((t, i) => {
    const own = !mp?.observer && i === game.self;
    return { id: t.id, on: !won && !t.gone && !splashOn && !view.paused && (own ? !!st.horn : !!t.horn), vol: own ? 1 : hearVol(t.fl.x, t.fl.y) };
  }));
  honkTrucks();
  watchBots();
  const done = doneSet();
  const fresh = [...done].filter((z) => !doneZones.has(z));
  if (fresh.length) (!game.hard && fresh.some((z) => zoneWonky(game, z)) ? playWonky : playSuccess)();
  doneZones = done;
  if (game.hitCount !== hitCount) {
    if (game.hitCount > hitCount) {
      const h = game.hits?.[game.hits.length - 1];
      playBreak(h ? hearVol(h.x, h.y) : 1);
      if (!h || Math.hypot(h.x - game.fl.x, h.y - game.fl.y) < RUMBLE_HIT_DIST) rumble.pulse('damage', 0.9, 0.6, 0.3);
    }
    hitCount = game.hitCount;
  }
  let scrapeV = game.scrape, scrapeVol = 1, slipV = game.slip || 0, slipVol = 1;
  for (let i = 0; i < game.trucks.length; i++) {
    const t = game.trucks[i];
    if (!mp?.observer && i === game.self) continue;
    if (t.gone) { setEngine(0, false, false, t.id, 0); otherH.delete(t.id); continue; }
    const vol = hearVol(t.fl.x, t.fl.y);
    if (t.H !== (otherH.get(t.id) ?? t.H)) playFork(t.H > otherH.get(t.id), vol);
    otherH.set(t.id, t.H);
    if (won) setEngine(0, false, false, t.id, 0);
    else setEngine(t.fl.speed, t.input?.up || t.input?.down, t.fl.gear === 'R', t.id, vol);
    if (t.bonks > (otherBonks.get(t.id) ?? t.bonks)) playBonk(t.bonkPower, vol);
    otherBonks.set(t.id, t.bonks);
    if ((t.slip || 0) * vol > slipV * slipVol) { slipV = t.slip; slipVol = vol; }
    if (t.scrape * vol > scrapeV * scrapeVol) { scrapeV = t.scrape; scrapeVol = vol; }
  }
  setScrape(won ? 0 : scrapeV, scrapeVol);
  setSqueal(won ? 0 : slipV, slipVol);
  if (game.bonks !== bonkCount) {
    if (game.bonks > bonkCount) { const pw = game.bonkPower || 0.5; playBonk(game.bonkPower); rumble.pulse('bonk', 0.35 + 0.65 * pw, 0.3 + 0.5 * pw, 0.12 + 0.18 * pw); }
    bonkCount = game.bonks;
  }
  const vibrateOn = vibrateOpt.checked && lastTouch && st.motionSource !== 'gamepad' && !splashOn && !view.paused && !view.menuOpen
    && !won && !document.hidden && !localOpt.checked && !game.trucks[game.self]?.gone;
  const rumbleOn = rumbleOpt.checked && !splashOn && !view.paused && !view.menuOpen && !won && !document.hidden
    && !localOpt.checked && !game.trucks[game.self]?.gone && st.motionSource === 'gamepad';
  if (rumbleOn || vibrateOn) rumble.feedTruck(game);
  if (vibrateOn) rumble.frameVibrate(dtReal, true);
  else if (vibrateSupported()) rumble.frameVibrate(dtReal, false);
  if (!vibrateOn) rumble.frame(dtReal, standardPads()[0]?.gp ?? null, rumbleOn);
  if (game.status === 'won' && !game.endless) {
    if (!reduceEffectsOn && galleryGame !== game) { galleryGame = game; startGallery(() => endPhotos(game)); }
    else if (reduceEffectsOn && galleryGame) { galleryGame = null; stopGallery(); }
  } else if (galleryGame) { galleryGame = null; stopGallery(); }
  if (shouldDraw(now, lastDraw, limitFrameRateOn)) {
    lastDraw = now;
    const t2 = performance.now();
    view.fullscreen = !!document.fullscreenElement;
    view.tutorialBottom = isTouch && view.height > view.width && !tutorialEl.classList.contains('hide')
      ? tutorialEl.getBoundingClientRect().bottom - canvas.getBoundingClientRect().top : 0;
    game.debugBots = !!debug;
    draw(ctx, game, view);
    drawResults(resultsCtx, game, view);
    dodgePhoto();
    if (debug) {
      const t3 = performance.now();
      debug.frame(now, steps, t1 - t0, t3 - t2);
      debug.draw(ctx, game, view);
      debug.overhead(performance.now() - t3);
    }
  }
  scheduleFrame();
}
scheduleFrame();
