import { newGame, update, forkUp, forkDown, zoneDone, zoneWonky, score, liveTrucks } from './game.js';
import { createInput } from './input.js';
import { syncScores, fetchTopList, pullScores, submitPartyScore, partyBoard } from './globalscores.js';
import { createRelay } from './net/relay.js';
import { createHost } from './net/host.js';
import { createGuest } from './net/guest.js';
import { applySnapshot } from './net/protocol.js';
import { truckColor } from './forklift.js';
import { getBest, getTop, addTop, lowestUnscored, beats, saveBest, finalScore, timePenalty, formatTime } from './highscores.js';
import { serializeGame, deserializeGame, encodeState, decodeState } from './savestate.js';
import { parseSeed } from './level.js';
import { draw } from './render.js';
import { debugEnabled, createDebug } from './debug.js';
import { setBareForks, bareForksEnabled } from './gl/models.js';
import { decalsEnabled, setDecalsEnabled } from './decals.js';
import { glEnabled, setGlEnabled, attachGlCanvas } from './gl/renderer.js';
import { themeMode, setThemeMode, theme } from './theme.js';
import { discoEnabled, setDiscoEnabled } from './disco.js';
import { CHASE_TILT, chaseZoom as chaseZoomOf } from './gl/camera.js';
import { initTestingBanner, isTesting } from './testing.js';
import { startSplashAnimation } from './splash.js';
import { startSplash3d } from './splash3d.js';
import { startAudio, playFork, playBlocked, playBreak, playBonk, setScrape, playSuccess, playWonky, setEngine, setHorns, setSilenced, isMusicMuted, setMusicMuted, isMusicRandom, setMusicRandom, setTrackListener, MUSIC_TRACKS, getMusicTrack, setMusicTrack, isEngineOn, setEngineOn, isAllMuted, setAllMuted } from './audio.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
attachGlCanvas(document.getElementById('gameGl'), ctx);
const isTouch = matchMedia('(pointer: coarse)').matches;
const view = { width: 0, height: 0, dpr: 1, povBig: !isTouch && localStorage.getItem('forklift-cab-view') === '1', chase: localStorage.getItem('forklift-chase-cam') === '1', chaseZoom: localStorage.getItem('forklift-chase-zoom') === null ? null : Number(localStorage.getItem('forklift-chase-zoom')), touch: isTouch };

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
// Party state: null when playing alone, else { role: 'host' | 'guest', code, name, host | guest, go }. A guest mirrors the host's game and never steps it.
let mp = null;
function saveState() {
  if (mp) return;
  localStorage.setItem('forklift-state', JSON.stringify(serializeGame(game, seedText)));
}
const countDone = () => game.zones.filter((z) => zoneDone(game, z)).length;
const doneSet = () => new Set(game.zones.filter((z) => zoneDone(game, z)));
let doneZones = doneSet();
let hitCount = game.hitCount;
let bonkCount = game.bonks;
let otherBonks = new Map(); // truck id -> last seen bonk count (other trucks' bumps are heard, quieter with distance)
const otherH = new Map(); // truck id -> last seen fork level
refreshBest();
// Loudness 0..1 of a sound at (x, y), falling off with the distance from the local truck (same curve as the horns).
const hearVol = (x, y) => 1 / (1 + Math.hypot(x - game.fl.x, y - game.fl.y) / 8);
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
  if (mp?.role === 'guest') return; // only the host changes levels
  if (recordOpen) closeRecord();
  recorded = false;
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
// After the host's game was replaced: the guests get their trucks back in the new game.
function partyGameChanged() {
  if (mp?.role !== 'host') return;
  game.trucks[0].name = mp.name;
  mp.host.levelLoaded(game);
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

let cursorTimer = 0;
function wakeCursor() {
  canvas.classList.remove('idle');
  clearTimeout(cursorTimer);
  if (document.fullscreenElement) cursorTimer = setTimeout(() => canvas.classList.add('idle'), 2000);
}
canvas.addEventListener('mousemove', wakeCursor);
document.addEventListener('fullscreenchange', wakeCursor);

function nextLevel() { if (game.status === 'won') load(level + 1); }

function toggleChase() {
  if (!glEnabled()) return;
  if (view.povBig) {
    view.povBig = false;
    localStorage.setItem('forklift-cab-view', '0');
    view.chase = true;
  } else view.chase = !view.chase;
  view.orbit = null;
  localStorage.setItem('forklift-chase-cam', view.chase ? '1' : '0');
}

const input = createInput({
  anyKey: startAudio,
  fullscreen: toggleFullscreen,
  toggleChase,
  swapView: () => {
    if (isTouch) return;
    view.povBig = !view.povBig;
    localStorage.setItem('forklift-cab-view', view.povBig ? '1' : '0');
    if (view.povBig) tutDone.cab = true;
  },
  up: () => {
    if (mp?.role === 'guest') { mp.guest.sendFork('up'); if (mp.guest.predictor.fork('up', performance.now() / 1000) === 'blocked') playBlocked(); return; }
    const h = game.H;
    if (forkUp(game) === 'blocked') playBlocked();
    else if (game.H !== h) playFork(true);
  },
  down: () => {
    if (mp?.role === 'guest') { mp.guest.sendFork('down'); if (mp.guest.predictor.fork('down', performance.now() / 1000) === 'blocked') playBlocked(); return; }
    const h = game.H;
    if (forkDown(game) === 'blocked') playBlocked();
    else if (game.H !== h) playFork(false);
  },
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
const CAM_SPRING = 3;
// Flat overview: a Q/W press springs the camera a quarter turn (o.goal = target yaw) instead of turning continuously.
function quarterTurn(dir) {
  const o = lookState(), q = Math.PI / 2;
  o.goal = (Math.round((o.goal ?? o.yaw) / q) - dir) * q;
}
function turnStep(dt) {
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
function lookBy(dyaw, dpitch) {
  const o = lookState();
  o.goal = null;
  o.yaw = wrap(o.yaw - dyaw);
  if (view.povBig) o.pitch = Math.min(LOOK_PITCH_MAX, Math.max(-LOOK_PITCH_MAX, o.pitch + dpitch));
  else o.tilt = Math.min(ORBIT_TILT_MAX, Math.max(0.05, o.tilt + dpitch));
}
function springBack(dt) {
  const k = 1 - Math.exp(-7 * dt);
  const o = view.orbit, l = view.look;
  if (o) {
    // the flat overview settles on the nearest quarter turn (the map stays rotated); the chase camera always returns behind the forklift
    const target = view.chase ? 0 : o.goal ?? Math.round(o.yaw / (Math.PI / 2)) * (Math.PI / 2);
    o.yaw += (target - o.yaw) * k;
    o.tilt -= (o.tilt - orbitHome()) * k;
    if (Math.abs(o.yaw - target) + Math.abs(o.tilt - orbitHome()) < 0.003) {
      o.goal = null;
      if (target === 0) view.orbit = null;
      else { o.yaw = wrap(target); o.tilt = orbitHome(); }
    }
  }
  if (l) { l.yaw -= l.yaw * k; l.pitch -= l.pitch * k; if (Math.abs(l.yaw) + Math.abs(l.pitch) < 0.003) view.look = null; }
  if ((!view.orbit || view.orbit.yaw === Math.round(view.orbit.yaw / (Math.PI / 2)) * (Math.PI / 2) && !view.chase) && !view.look) view.snap = false;
}
let drag = null;
canvas.addEventListener('pointerdown', () => { if (!splashOn) view.startHidden = true; }, true);
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
// Double tap (or double click) on the GL overview toggles the third-person camera.
let lastTap = null;
const DOUBLE_TAP_MS = 350, DOUBLE_TAP_PX = 30;
function tapped(e) {
  const now = performance.now();
  if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DOUBLE_TAP_PX) {
    lastTap = null;
    toggleChase();
  } else lastTap = { t: now, x: e.clientX, y: e.clientY };
}
const endDrag = (e) => {
  if (drag && e.pointerId === drag.id) {
    if (!drag.moved && e.type === 'pointerup') tapped(e);
    drag = null;
  }
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

const pending = {};
recordName.addEventListener('keydown', (e) => e.stopPropagation());
document.getElementById('recordForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = recordName.value.trim() || 'Anonymous';
  savePlayerName(name);
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
  if (mp?.role === 'guest') return; // the host submits the shared score
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
const seedInput = document.getElementById('seed');
seedInput.value = seedText;

// Each step is done when its action has happened (also if it happened earlier, so
// early presses are credited), but every step stays visible for at least MIN_MS.
const TUTORIAL = [
  { done: 'drive', html: isTouch
    ? 'Use the <b>Forward</b>/<b>Back</b> buttons to drive and <b>◀/▶</b> to steer (the rear wheels steer, so the tail swings out!). Release the button to engine-brake.'
    : 'Use <b>↑/↓</b> to drive and <b>←/→</b> to steer (the rear wheels steer, so the tail swings out!). Release the throttle to engine-brake.' },
  { done: 'fork', html: isTouch
    ? 'Tap <b>Fork ▲</b> to raise the forks and <b>Fork ▼</b> to lower them. Drive the forks in under a stack to lift it.'
    : 'Press <b>A</b> to raise the forks and <b>Z</b> to lower them. Drive the forks in under a stack to lift it.' },
  { done: 'zone', html: isTouch
    ? 'Set a stack down on the zone of the matching colour (exactly the shown count), then park on the marked spot. Use <b>Menu</b> → Restart if you get stuck.'
    : 'Set a stack down on the zone of the matching colour (exactly the shown count), then park on the marked spot. Use <b>Menu</b> → Game → Restart level if you get stuck.' },
  { done: 'cab', html: 'For a more immersive experience, press <b>Tab</b> or <b>M</b> to switch to the cab view (and again to return to the overview).' },
  { done: 'info', html: isTouch
    ? 'Hold two fingers on the canvas to <b>honk</b>. Open <b>Menu</b> → <b>Info</b> for scoring and more tips.'
    : 'Extras: <b>C</b> chase camera, <b>W</b>/<b>Q</b> rotate the camera (or drag it), hold <b>H</b> to honk, <b>F</b> full screen. Press <b>P</b> / <b>Esc</b> for the menu → <b>Info</b> for scoring and more tips.',
    extra: () => (theme().dark
      ? ' Prefer a brighter scene? Switch <b>Colour mode</b> to <b>Light</b> under Visuals.'
      : ' Try <b>Dark</b> colour mode under Visuals for headlights, ambient lights and disco lights.') },
];
if (isTouch) TUTORIAL.splice(3, 1);
const TUT_MIN_MS = 2500, TUT_INFO_MS = 20000;
const tutorialEl = document.getElementById('tutorial');
// ?skip hides the tutorial for this visit without saving it as done.
let tutStep = localStorage.getItem('forklift-tutorial-done') || new URLSearchParams(location.search).has('skip') ? -1 : 0;
let tutDone = {};
let tutShownAt = performance.now();
function showTutorial() {
  tutShownAt = performance.now();
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
let tutLastH = game.H;
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
  if (mp?.role === 'guest' && !mp.go) return; // waiting for the host
  const text = seedInput.value.trim();
  if (mp?.role !== 'guest' && text !== seedText) {
    seedText = text;
    seed = parseSeed(text);
    localStorage.setItem('forklift-seed', text);
    load(1);
  }
  if (mp?.role !== 'guest' && hardOpt.checked !== hard) {
    hard = hardOpt.checked;
    localStorage.setItem('forklift-hard', hard ? '1' : '0');
    load(level);
  }
  refreshBest();
  if (tutorialOpt.checked) {
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
  splash.classList.add('hide');
  seedInput.blur();
  last = performance.now();
  if (mp?.role === 'host') mp.host.started(game);
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
  if (!splashOn || e.target === seedInput || e.target === partyName || e.target === joinCode) return;
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
const partyNotice = sessionStorage.getItem('forklift-party-msg');
if (partyNotice) { partyErr.textContent = partyNotice; sessionStorage.removeItem('forklift-party-msg'); }
for (const el of [partyName, joinCode]) el.addEventListener('keydown', (e) => e.stopPropagation());
joinCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); joinParty(); } });
hostBtn.addEventListener('click', () => { startAudio(); hostParty(); });
joinBtn.addEventListener('click', () => { startAudio(); joinParty(); });
const leaveParty = () => { mp?.host?.close(); mp?.guest?.close(); mp = null; location.reload(); };
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
document.getElementById('mpHost').addEventListener('click', () => { startAudio(); hostParty(mpName.value).catch(() => {}); });
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
    nm.textContent = (p.name || `Player ${p.slot + 1}`) + (p.slot === game.self ? ' (you)' : '') + (p.slot === 0 ? ' – host' : '');
    li.append(nm);
    if (isHost) {
      const ping = document.createElement('span');
      ping.className = 'ping';
      ping.textContent = p.slot === 0 ? '' : p.ping == null ? '… ms' : `${p.ping} ms`;
      li.append(ping);
      if (p.slot !== 0) for (const [label, ban] of [['Kick', false], ['Ban', true]]) {
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
async function hostParty(nameText = partyName.value) {
  if (mp) return;
  const name = (nameText.trim() || 'Player').slice(0, 24);
  savePlayerName(name);
  partyErr.textContent = '';
  busy(true);
  const host = createHost({ relay: createRelay(), getGame: () => game, levelInfo: () => ({ level, seed, hard, seedText }), isStarted: () => !splashOn, name, onChange: () => { refreshParty(game.trucks); renderMpPage(); }, onClosed: partyClosed });
  try { await host.start(); } catch (e) { busy(false); partyErr.textContent = mpErr.textContent = e.message; return; }
  mpErr.textContent = '';
  mp = { role: 'host', code: host.code, name, host };
  game.trucks[0].name = name;
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
  const guest = createGuest({ relay: createRelay(), code, name, onGame: onGuestGame, onClosed: partyClosed });
  mp = { role: 'guest', code, name, guest, go: false, connected: false, lastH: null };
  try { await guest.join(); } catch (e) { mp = null; busy(false); partyErr.textContent = e.message; return; }
  showParty('Connecting…');
  mp.timer = setTimeout(() => { if (mp && !mp.connected) partyClosed('Could not connect to the host (a firewall may be blocking the connection)'); }, 20000);
}
// The host's level (welcome, and again on every level change): build it and mirror the host's state.
function onGuestGame(m) {
  if (mp?.role !== 'guest') return;
  mp.connected = true;
  clearTimeout(mp.timer);
  level = m.level; seed = m.seed; seedText = m.seedText || ''; hard = m.hard;
  game = newGame(level, seed, hard);
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
if (!startSplash3d(document.getElementById('splashGl'), () => splashOn)) startSplashAnimation(document.getElementById('splashAnim'), () => splashOn);
setDecalsEnabled(localStorage.getItem('forklift-decals-off') !== '1');
const themeSel = document.getElementById('themeSel');
setThemeMode(localStorage.getItem('forklift-theme'));
const bareOpt = document.getElementById('bareOpt');
const chaseOpt = document.getElementById('chaseOpt');
const chaseZoomSel = document.getElementById('chaseZoom');
setBareForks(localStorage.getItem('forklift-bare-forks') === '1');
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
    bareOpt.checked = bareForksEnabled();
    chaseOpt.checked = view.chase;
    chaseZoomSel.value = view.chaseZoom ?? chaseZoomOf(view.ovTiles || 14);
    themeSel.value = themeMode();
    menuHardOpt.checked = hard;
    menuLevel.value = level;
    for (const el of menuEl.querySelectorAll('[data-hostonly]')) el.hidden = mp?.role === 'guest';
    menuLeave.hidden = !mp;
    mpName.value = localStorage.getItem('forklift-player') || '';
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
const zoomSlider = document.getElementById('zoomSlider');
const zoomBar = document.getElementById('zoomBar');
function syncZoomBar() {
  zoomBar.classList.toggle('hide', splashOn || !!view.menuOpen || view.povBig);
  if (document.activeElement !== zoomSlider) zoomSlider.value = view.chaseZoom ?? chaseZoomOf(view.ovTiles || 14);
}
setInterval(syncZoomBar, 200);
zoomSlider.addEventListener('input', () => {
  view.chaseZoom = Number(zoomSlider.value);
  localStorage.setItem('forklift-chase-zoom', String(view.chaseZoom));
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
  chaseZoomSel.value = chaseZoomOf(view.ovTiles || 14);
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
  const typing = e.target === menuLevel || e.target === pullName;
  if (e.target === stateText) { if (e.code === 'Escape') { e.preventDefault(); showPage('main'); } return; }
  if (e.code === 'Escape' && menuEl.dataset.page !== 'main') { e.preventDefault(); showPage('main'); return; }
  if (e.code === 'Escape' || (e.code === 'KeyP' && !typing)) { e.preventDefault(); toggleMenu(false); return; }
  if (e.code === 'Enter' && e.target !== menuLevel && e.target !== pullName) { e.preventDefault(); toggleMenu(false); return; }
  if (e.target === trackSel && e.code !== 'KeyT') return;
  if (e.target === themeSel && e.code !== 'KeyC') return;
  if (typing || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
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
    KeyB: () => toggle(bareOpt),
    KeyI: () => toggle(discoOpt),
    KeyH: () => toggle(chaseOpt),
    KeyG: () => { showPage('game'); menuLevel.focus(); menuLevel.select(); },
    KeyL: () => document.getElementById('menuLowest').click(),
    KeyF: toggleFullscreen,
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
  if (mp?.role === 'guest') return;
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
  partyGameChanged();
  refreshBest();
  saveState();
  toggleMenu(false);
});
window.addEventListener('pagehide', saveState);
setInterval(() => { if (!splashOn && !view.paused) saveState(); }, 1000);

const lostFocus = () => document.hidden || !document.hasFocus();
function applyPause() {
  const p = !!view.menuOpen && !mp; // the others keep driving, so a party never pauses
  if (!p && view.paused) last = performance.now();
  view.paused = p;
  setSilenced(!!view.menuOpen);
}
// Losing focus opens the same pause menu as Esc/P; the player must click Resume (or press Esc/P) to continue, just like any other pause.
const pauseOnBlur = () => { if (!splashOn && !recordOpen && !mp && lostFocus()) toggleMenu(true); };
window.addEventListener('blur', pauseOnBlur);
window.addEventListener('focus', applyPause);
document.addEventListener('visibilitychange', pauseOnBlur);
pauseOnBlur();
applyPause();

const debug = debugEnabled(location.search) ? createDebug() : null;
initTestingBanner();
if (!isTesting()) menuEl.querySelector('[data-go="state"]')?.remove();
const STEP = 1 / 120;
let acc = 0, last = performance.now();
// ?skip in the URL bypasses the splash (on touch it opens the main menu; keeps saved settings; no audio until a key/click starts it)
if (new URLSearchParams(location.search).has('skip')) {
  startGame();
  // On touch, start in the main menu: leaving it is the user gesture that lets full-screen kick in (auto full-screen on for this visit only; not saved)
  if (isTouch) { autoFs = true; autoFsOpt.checked = true; toggleMenu(true); }
}
const START_BOARD_SECS = 10;
function frame(now) {
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
    if (inp.up || inp.down || inp.left || inp.right) view.snap = true;
    if (!splashOn && glEnabled()) {
      if (view.povBig || view.chase) { if (inp.lookL || inp.lookR) lookBy((inp.lookR - inp.lookL) * LOOK_SPEED * dt, 0); }
      else {
        if (inp.lookR && !view.lookHeld?.R) quarterTurn(1);
        if (inp.lookL && !view.lookHeld?.L) quarterTurn(-1);
        turnStep(dt);
      }
      view.lookHeld = { L: inp.lookL, R: inp.lookR };
    }
    if (view.snap) springBack(dt);
  };
  const followStep = (dt) => {
    // chase camera heading follows the forklift on a spring
    if (view.camA == null || game !== view.camG) { view.camA = game.fl.a; view.camG = game; }
    else {
      // in reverse (same delay as the cabin's look-back) the camera orbits round to the front of the forklift
      const target = game.fl.a + (game.rv > 0.5 ? Math.PI - 0.001 : 0);
      view.camA += wrap(target - view.camA) * (1 - Math.exp(-CAM_SPRING * dt));
    }
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
      if (game.H !== mp.lastH) { if (mp.lastH != null) playFork(game.H > mp.lastH); mp.lastH = game.H; }
    }
  }
  while (mp?.role !== 'guest' && !splashOn && !view.paused && acc >= STEP) {
    const inp = input.state();
    cameraStep(inp, STEP);
    update(game, inp, STEP);
    followStep(STEP);
    acc -= STEP;
    steps++;
  }
  if (mp?.role === 'host' && !splashOn) mp.host.broadcast(game);
  const t1 = performance.now();
  checkTutorial();
  checkRecord();
  const st = input.state();
  setEngine(game.fl.speed, st.up || st.down, game.fl.gear === 'R', game.self);
  game.horn = !!st.horn && !splashOn && !view.paused;
  setHorns(game.trucks.map((t, i) => {
    const own = i === game.self, d = Math.hypot(t.fl.x - game.fl.x, t.fl.y - game.fl.y);
    return { id: t.id, on: !t.gone && !splashOn && !view.paused && (own ? !!st.horn : !!t.horn), vol: own ? 1 : hearVol(t.fl.x, t.fl.y) };
  }));
  const done = doneSet();
  const fresh = [...done].filter((z) => !doneZones.has(z));
  if (fresh.length) (fresh.some((z) => zoneWonky(game, z)) ? playWonky : playSuccess)();
  doneZones = done;
  if (game.hitCount !== hitCount) {
    if (game.hitCount > hitCount) { const h = game.hits?.[game.hits.length - 1]; playBreak(h ? hearVol(h.x, h.y) : 1); }
    hitCount = game.hitCount;
  }
  let scrapeV = game.scrape, scrapeVol = 1;
  for (let i = 0; i < game.trucks.length; i++) {
    const t = game.trucks[i];
    if (i === game.self) continue;
    if (t.gone) { setEngine(0, false, false, t.id, 0); otherH.delete(t.id); continue; }
    const vol = hearVol(t.fl.x, t.fl.y);
    if (t.H !== (otherH.get(t.id) ?? t.H)) playFork(t.H > otherH.get(t.id), vol);
    otherH.set(t.id, t.H);
    setEngine(t.fl.speed, t.input?.up || t.input?.down, t.fl.gear === 'R', t.id, vol);
    if (t.bonks > (otherBonks.get(t.id) ?? t.bonks)) playBonk(t.bonkPower, vol);
    otherBonks.set(t.id, t.bonks);
    if (t.scrape * vol > scrapeV * scrapeVol) { scrapeV = t.scrape; scrapeVol = vol; }
  }
  setScrape(scrapeV, scrapeVol);
  if (game.bonks !== bonkCount) { if (game.bonks > bonkCount) playBonk(game.bonkPower); bonkCount = game.bonks; }
  const t2 = performance.now();
  view.fullscreen = !!document.fullscreenElement;
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
