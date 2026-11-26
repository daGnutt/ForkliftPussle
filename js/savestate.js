import { newGame, forkHeight } from './game.js';
import { newEndless, endlessSnapshot, restoreEndless } from './endless.js';
import { MAX_H, MAX_LAYERS } from './forklift.js';
import { FORK_CLEARANCE } from './geom.js';
import { makeBot, stackSig } from './bot.js';
import { HARD_PHYSICS_VERSION } from './hard-physics.js';

const SAVE_VERSION = 1;
const LEVEL_LAYOUT_VERSION = 5;
const INSPECTION_VERSION = 2;
export class HardPhysicsVersionError extends Error {
  constructor() { super('Saved hard-mode physics is no longer compatible'); }
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const arr = (a, n, ok) => Array.isArray(a) && a.length === n && a.every(ok);
const okRot = num;
const okOff = (o) => !!o && num(o.x) && num(o.y);
const okPen = (p) => !!p && num(p.crash) && num(p.sq) &&
  (p.shift === undefined || num(p.shift) && p.shift >= 0 && p.shift <= 50) &&
  (p.tip === undefined || p.tip === 1 || p.tip === 2) &&
  (p.loose === undefined || !!p.loose && num(p.loose.x) && num(p.loose.y) && num(p.loose.a)) &&
  (p.inspected === undefined || typeof p.inspected === 'boolean') &&
  (p.oilDropped === undefined || Number.isInteger(p.oilDropped) && p.oilDropped >= 0 && p.oilDropped <= 50) &&
  (p.oilFraction === undefined || num(p.oilFraction) && p.oilFraction >= 0 && p.oilFraction < 1);
const OLD_BOT_FIELDS = ['activity', 'scared', 'curiosity', 'observing', 'lastView', 'yieldFor', 'yieldPath'];
// Saves from before the unified bot state machine: drop the legacy fields and let each bot re-evaluate its jobs fresh.
function migrateBots(g) {
  for (const k of ['bot', 'inspector', 'coneBot', 'tapeBot', 'fixBot']) {
    const b = g[k];
    if (!b) continue;
    for (const f of OLD_BOT_FIELDS) delete b[f];
    if (!b.state) b.state = 'loiter';
  }
}

const DYNAMIC = ['stacks', 'fl', 'carried', 'carriedRel', 'carriedRots', 'carriedPen', 'carriedOffs', 'carriedRest', 'oil', 'skidMarks', 'cones', 'tapes', 'repair', 'bot', 'inspector', 'coneBot', 'tapeBot', 'fixBot', 'photo', 'bonks', 'H', 'hy', 'hf', 'status', 'time', 'started', 'clock'];

// Plain-JSON snapshot of a level in progress; the static layout is regenerated from (level, seed, hard).
export function serializeGame(g, seedText = '') {
  const state = {};
  for (const k of DYNAMIC) if (g[k] !== undefined) state[k] = clone(g[k]);
  return { version: SAVE_VERSION, layoutVersion: LEVEL_LAYOUT_VERSION, inspectionVersion: INSPECTION_VERSION, ...(g.hard && { hardPhysicsVersion: HARD_PHYSICS_VERSION }), level: g.level, seed: g.seed, seedText, hard: g.hard, state };
}

// Older saves tracked inspections by zone; only recover boxes still matching a recorded photo.
function restoreInspections(g, data) {
  for (const st of g.stacks) if (st.touched) for (const pen of st.pen || []) delete pen.inspected;
  if (g.hard && data.inspectionVersion !== INSPECTION_VERSION) {
    for (const pens of [...g.stacks.map((s) => s.pen || []), g.carriedPen || []]) for (const p of pens) delete p.inspected;
    if (g.inspector) {
      g.inspector.seen = [];
      delete g.inspector.sigs;
      delete g.inspector.photos;
    }
    g.photo = null;
    return;
  }
  if (data.inspectionVersion !== undefined) return;
  for (const z of g.zones) {
    const key = `${z.x},${z.y},${z.color}`, sig = g.inspector?.sigs?.[key];
    if (!sig || !g.inspector.seen?.includes(key)) continue;
    const st = g.stacks.find((s) => !s.touched && Math.abs(s.x - z.x) < 0.5 && Math.abs(s.y - z.y) < 0.5 && stackSig(s) === sig);
    if (st?.pen) for (const pen of st.pen) pen.inspected = true;
  }
}

function checkState(s) {
  const okFl = s.fl && ['x', 'y', 'a', 'speed', 'steer'].every((k) => num(s.fl[k]));
  const opt = (a, n, ok) => a === undefined || arr(a, n, ok); // stacks' rots/offs/pen are rebuilt by ensure() when absent
  const okStacks = Array.isArray(s.stacks) && s.stacks.every((st) => !!st && num(st.x) && num(st.y) && Array.isArray(st.layers) && st.layers.length > 0 && st.layers.length <= MAX_LAYERS && st.layers.every(Number.isInteger)
    && opt(st.rots, st.layers.length, okRot) && opt(st.offs, st.layers.length, okOff) && opt(st.pen, st.layers.length, okPen));
  const okCarried = s.carried === null || (Array.isArray(s.carried) && s.carried.length > 0 && s.carried.length <= MAX_LAYERS && s.carried.every(Number.isInteger)
    && arr(s.carriedRots, s.carried.length, okRot) && arr(s.carriedOffs, s.carried.length, okOff) && arr(s.carriedPen, s.carried.length, okPen));
  const okOil = s.oil === undefined || (Array.isArray(s.oil) && s.oil.every((o) => o && typeof o.id === 'string' && num(o.x) && num(o.y) && num(o.r) && o.r > 0 &&
    (o.drops === undefined || num(o.drops) && o.drops > 0) &&
    (o.barrelId === undefined || typeof o.barrelId === 'string') && (o.seq === undefined || Number.isInteger(o.seq) && o.seq >= 0) &&
    (o.anchorX === undefined || num(o.anchorX)) && (o.anchorY === undefined || num(o.anchorY)) &&
    (o.leaking === undefined || typeof o.leaking === 'boolean')));
  const okSkids = s.skidMarks === undefined || (Array.isArray(s.skidMarks) && s.skidMarks.every((m) =>
    m && typeof m.id === 'string' && num(m.x) && num(m.y) && num(m.a) && num(m.left) && m.left > 0 && m.left <= 1));
  const okCones = s.cones === undefined || (Array.isArray(s.cones) && s.cones.every((c) => c && typeof c.id === 'string' && typeof c.goalId === 'string'
    && num(c.x) && num(c.y) && num(c.a) && typeof c.tipped === 'boolean' && typeof c.squished === 'boolean'));
  const okTapes = s.tapes === undefined || (Array.isArray(s.tapes) && s.tapes.every((t) => t && typeof t.key === 'string' && Number.isInteger(t.color)
    && num(t.x) && num(t.y) && num(t.w) && num(t.h) && typeof t.sig === 'string' && typeof t.broken === 'boolean'
    && (t.posts === undefined || arr(t.posts, 4, (v) => typeof v === 'boolean'))
    && (t.edges === undefined || arr(t.edges, 4, (v) => typeof v === 'boolean'))
    && (t.wallSides === undefined || arr(t.wallSides, 4, (v) => v === null || num(v)))));
  if (!okFl || !okStacks || !okCarried || !okOil || !okSkids || !okCones || !okTapes || !Number.isInteger(s.H) || s.H < 0 || s.H > MAX_H) throw new Error('Corrupt state');
  if (s.status !== 'play' && s.status !== 'won') throw new Error('Corrupt state');
}

function restoreForkHeight(g, version) {
  if (g.hard && (version === undefined || version === 1) && g.carried && num(g.hy)) g.hy += FORK_CLEARANCE;
  const height = forkHeight(g);
  if (!num(height) || height < g.H - 1e-6 || height >= g.H + 1) g.hy = g.H + (g.hard && g.carried ? FORK_CLEARANCE : 0);
  if (!num(g.hf)) g.hf = g.hy;
}

// Returns a new game from a snapshot, or throws if the data is not a valid snapshot.
export function deserializeGame(data) {
  if (!data || data.version !== SAVE_VERSION || !data.state) throw new Error('Unknown save format');
  const { level, seed, hard, state: s } = data;
  if (hard && data.hardPhysicsVersion !== undefined && ![1, 2, HARD_PHYSICS_VERSION].includes(data.hardPhysicsVersion)) throw new HardPhysicsVersionError();
  if (!Number.isInteger(level) || level < 1 || !num(seed)) throw new Error('Bad level or seed');
  if (data.layoutVersion !== LEVEL_LAYOUT_VERSION) {
    throw new Error('Saved level layout is no longer compatible');
  }
  const g = newGame(level, seed, !!hard);
  checkState(s);
  const boxes = (stacks, carried, extra) => stacks.reduce((n, st) => n + st.layers.length, 0) + (carried ? carried.length : 0) + (extra?.length || 0);
  if (boxes(s.stacks, s.carried, s.fixBot?.carry?.layers) !== boxes(g.stacks, null)) throw new Error('State does not match level');
  Object.assign(g, clone(s));
  if (!g.bot) g.bot = makeBot(g);
  migrateBots(g);
  restoreInspections(g, data);
  const ph = g.photo; // the observer's last picture; a malformed one is dropped rather than failing the load
  if (ph != null && !(Array.isArray(ph.layers) && Array.isArray(ph.pens) && Array.isArray(ph.rots) && Array.isArray(ph.offs) && num(ph.at?.x) && num(ph.at?.y))) g.photo = null;
  restoreForkHeight(g, data.hardPhysicsVersion);
  if (!num(g.time)) g.time = 0;
  // Saves from before `clock` was stored: start it past every stack's last-hit time so cooldowns have expired.
  if (!num(g.clock)) g.clock = Math.max(0, ...g.stacks.map((st) => st.hitAt ?? 0)) + 1;
  if (!num(g.bonks)) g.bonks = 0;
  g.started = !!g.started;
  return g;
}

async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

// Snapshot -> deflate-compressed, base64 text for sharing.
export async function encodeState(data) {
  const bytes = await pipe(new TextEncoder().encode(JSON.stringify(data)), new CompressionStream('deflate-raw'));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Inverse of encodeState; plain JSON text is accepted too.
export async function decodeState(text) {
  const t = text.trim();
  if (t.startsWith('{')) return JSON.parse(t);
  const bin = atob(t.replace(/\s+/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(await pipe(bytes, new DecompressionStream('deflate-raw'))));
}

const ENDLESS_VERSION = 1;

// Snapshot of an endless game in progress (the static layout is rebuilt by newEndless).
export function serializeEndless(g) {
  const state = {};
  for (const k of DYNAMIC) if (g[k] !== undefined) state[k] = clone(g[k]);
  return { version: ENDLESS_VERSION, inspectionVersion: INSPECTION_VERSION, ...(g.hard && { hardPhysicsVersion: HARD_PHYSICS_VERSION }), seed: g.seed, hard: g.hard, state, endless: clone(endlessSnapshot(g)) };
}

// Returns the resumed endless game, or throws if the data is not a valid snapshot.
export function deserializeEndless(data) {
  if (!data || data.version !== ENDLESS_VERSION || !data.state || !data.endless || !num(data.seed)) throw new Error('Unknown save format');
  if (data.hard && data.hardPhysicsVersion !== undefined && ![1, 2, HARD_PHYSICS_VERSION].includes(data.hardPhysicsVersion)) throw new HardPhysicsVersionError();
  const s = data.state;
  checkState(s);
  if (s.status !== 'play') throw new Error('Corrupt state');
  const g = newEndless(data.seed, !!data.hard);
  Object.assign(g, clone(s));
  if (!g.bot) g.bot = makeBot(g);
  migrateBots(g);
  restoreForkHeight(g, data.hardPhysicsVersion);
  if (!num(g.time)) g.time = 0;
  if (!num(g.bonks)) g.bonks = 0;
  g.started = false; // the start board (with the high scores) shows until the truck moves again
  restoreEndless(g, clone(data.endless));
  restoreInspections(g, data);
  return g;
}
