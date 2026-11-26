import { repairable } from '../repair.js';
import { SPEED, FLEE_SPEED, SCARE, CALM, turnTo, botHome, botLane, emerge, retract, approachGap } from './common.js';
import { buildGrid, plan, REPLAN, blockedAhead, followPath, pushOut, fleePlan } from './nav.js';
import { activity, makeWay } from './state.js';
import { followTruck } from './loiter.js';
import { SPOOK_SECS } from './cleanbot.js';

// The inspection bot: photographs every completed drop point once (`seen` holds the keys of inspected zones).
export function makeInspector(g) {
  if (!g.hatch) return null;
  const home = botHome(g.hatch);
  return { x: home.x, y: home.y, a: g.hatch.a, show: 0, mode: 'hidden', shooting: 0, flash: 0, roll: 0, scared: false, path: [], repath: 0, seen: [] };
}
// ---- Inspection bot ----
export const CORNER_WEIGHT = 12, PHOTO_DIST = 1.4, BOX_SECS = 1.2, FLASH_SECS = 0.35;
// Laser scan of the stack being inspected, or null: `lens` the beam's origin (in front of the bot), `aim` the stack, `h` its height in boxes,
// `u` scan progress 0..1, `sx, sy` the beam's current target on the floor, `z` its height in boxes (0..h) and `sheet` the offset of the scan sheet.
export function scanBeam(b) {
  if (!b || !b.aim || b.show <= 0 || b.shooting <= 0) return null;
  const n = Math.max(1, b.aim.h), u = Math.min(1, b.shooting / (n * BOX_SECS)), dx = b.aim.x - b.x, dy = b.aim.y - b.y, d = Math.hypot(dx, dy) || 1;
  // the scan climbs one box at a time (w 0..1 within box i), bottom to top
  const i = Math.min(n - 1, Math.floor(b.shooting / BOX_SECS)), w = Math.min(1, b.shooting / BOX_SECS - i);
  const fx = dx / d, fy = dy / d, sw = 0.5 * Math.sin(w * Math.PI * 2), depth = 0.45 * Math.sin(w * Math.PI);
  return {
    lens: { x: b.x + Math.cos(b.a) * 0.3, y: b.y + Math.sin(b.a) * 0.3 }, aim: b.aim, h: b.aim.h, u, fx, fy,
    sx: b.aim.x - fy * sw + fx * depth, sy: b.aim.y + fx * sw + fy * depth, z: i + 0.5 + 0.35 * Math.sin(w * Math.PI * 2), sheet: depth,
  };
}

// Fingerprint of a floor stack's exact arrangement: any nudge changes it.
export const stackSig = (s) => (s ? [s.x, s.y, ...s.layers, ...(s.rots || []), ...(s.offs || []).flatMap((o) => [o.x, o.y])].map((v) => (typeof v === 'number' ? Math.round(v * 1000) : v)).join(',') : '');

export const zoneKey = (z) => `${z.x},${z.y},${z.color}`;

export function currentInspection(g, z, stack) {
  const bot = g.inspector, key = zoneKey(z), photo = bot?.photos?.[key];
  if (!stack || stack.touched || !bot?.seen?.includes(key) || bot.sigs?.[key] !== stackSig(stack)
      || typeof photo?.ok !== 'boolean' || (g.hard && photo.pens?.[0]?.shift === undefined)) return null;
  return photo;
}

// Completed drop points that have not been photographed yet.
export function pendingZones(g, done, stackAt = (z) => g.stacks.find((s) => Math.hypot(s.x - z.x, s.y - z.y) < 0.5)) {
  const insp = g.inspector;
  if (!insp) return [];
  const doneKeys = new Set(done.map(zoneKey));
  // a stack that was touched since its photo (nudged, straightened, re-placed) is inspected again
  const changed = new Set(done.filter((z) => {
    const key = zoneKey(z), q = stackAt(z);
    const photo = insp.photos?.[key];
    const outdated = insp.seen.includes(key) && (typeof photo?.ok !== 'boolean' || (g.hard && photo.pens?.[0]?.shift === undefined));
    if (outdated) for (const p of q?.pen || []) delete p.inspected;
    return outdated || q?.touched || insp.sigs?.[key] !== stackSig(q);
  }).map(zoneKey));
  insp.seen = insp.seen.filter((k) => doneKeys.has(k) && !changed.has(k)); // a drop point that was undone is inspected again once it is completed anew
  if (insp.photos) for (const k of Object.keys(insp.photos)) if (!insp.seen.includes(k)) delete insp.photos[k];
  return done.filter((z) => !insp.seen.includes(zoneKey(z)));
}

export const WHEEL_R = 0.12;

// The snapshot of stack `st` that the photo popup draws (js/photo.js): `ok` is the verdict, `view` the angle it is seen from and `dist` the distance. Also used to fake a picture at the end of a level.
export const makePhoto = (st, ok, view, dist, n, t) => ({ n, t, ok, layers: st ? [...st.layers] : [], rots: st?.rots ? [...st.rots] : [], offs: st?.offs ? st.offs.map((o) => ({ ...o })) : [], pens: st?.pen ? st.pen.map((q) => ({ barrelPart: q?.barrelPart, wide: !!q?.wide, crash: q?.crash || 0, sq: q?.sq || 0, shift: q?.shift, tape: q?.tape || 0 })) : [], view, dist });

// Has the stack in the observer's last picture (`photo.at`, `photo.sig`) been touched, changed or taken away since?
export function photoTampered(g) {
  const p = g.photo;
  if (!p?.at) return false;
  const q = g.stacks.find((o) => Math.hypot(o.x - p.at.x, o.y - p.at.y) < 0.5);
  return !q || q.touched || stackSig(q) !== p.sig;
}

// Steps the inspector and turns its wheels (`roll`, radians) by the distance it drove.
export function stepInspector(g, dt, done, stackAt, wonky) {
  const bot = g.inspector;
  if (!bot) return;
  const x = bot.x, y = bot.y;
  if (g.photo && (photoTampered(g) || (g.hard && g.photo.pens?.[0]?.shift === undefined))) g.photo = null;
  inspectorStep(g, dt, done, stackAt, wonky);
  bot.roll = ((bot.roll || 0) + ((bot.x - x) * Math.cos(bot.a) + (bot.y - y) * Math.sin(bot.a)) / WHEEL_R) % (Math.PI * 2);
}

export const pathLength = (from, path) => path.reduce((n, w, i) => n + Math.hypot(w.x - (i ? path[i - 1].x : from.x), w.y - (i ? path[i - 1].y : from.y)), 0);

// Inspector targeting: pick the nearest reachable pending drop point, pathfind to it and go. Obstacles that appear on the route are ignored until
// the bot actually meets one (then it picks a target afresh); a forklift driving towards it makes it run away first, then it picks afresh.
export function inspectorStep(g, dt, done, stackAt, wonky) {
  const bot = g.inspector;
  if (!bot || !g.hatch) return;
  const home = botLane(g.hatch);
  const todo = pendingZones(g, done, stackAt);
  bot.flash = Math.max(0, bot.flash - dt / FLASH_SECS);
  if (bot.target && !todo.some((z) => zoneKey(z) === bot.target)) { bot.target = null; bot.shooting = 0; bot.path = []; }
  if (bot.mode === 'hidden') {
    if (!todo.length) return;
    bot.mode = 'out';
  }
  const current = activity(bot, todo.length > 0, dt);
  if (bot.show < 1) { if (bot.leaving) retract(g, bot, dt); else emerge(g, bot, dt); return; }
  const wasScared = bot.scared;
  bot.scared = approachGap(g, bot) < (wasScared ? CALM : SCARE);
  if (bot.scared) bot.spookedUntil = g.clock + SPOOK_SECS;
  let speed = SPEED;
  bot.repath -= dt;
  bot.goal = null;
  if (bot.scared) {
    if (bot.yieldFor) { bot.yieldFor = null; bot.yieldPath = []; bot.repath = 0; }
    bot.curiosity = null; bot.observing = false;
    speed = FLEE_SPEED; bot.shooting = 0;
    if (bot.repath <= 0 || bot.fleePath !== true) { bot.path = fleePlan(g, bot); bot.fleePath = true; bot.repath = 0.25; }
    bot.target = null; // targeting restarts once it is safe
  } else {
    if (bot.fleePath || wasScared) { bot.fleePath = false; bot.path = []; bot.target = null; bot.repath = 0; }
    if (current === 'follow') {
      followTruck(g, bot, dt, speed);
      pushOut(g, bot);
      return;
    }
    if (bot.yieldFor && makeWay(g, bot, dt, speed)) { pushOut(g, bot); return; }
    if (bot.target && blockedAhead(g, bot)) { bot.target = null; bot.path = []; bot.shooting = 0; bot.repath = 0; } // met the obstacle: pick again
    if (!bot.target && todo.length && bot.repath <= 0) {
      const grid = buildGrid(g, 0.45, false, bot);
      let best = null;
      for (const z of todo) {
        const st = g.stacks.find((q) => Math.hypot(q.x - z.x, q.y - z.y) < 0.5), turn = (st?.rots?.[0] ?? st?.a ?? 0) + Math.PI / 4;
        // the inspector prefers a spot diagonal to the stack (at a corner), so its photo shows two sides of it
        const corner = (x, y) => (st ? Math.abs(Math.atan2(Math.sin(2 * (Math.atan2(y - z.y, x - z.x) - turn)), Math.cos(2 * (Math.atan2(y - z.y, x - z.x) - turn)))) / 2 * CORNER_WEIGHT : 0);
        const path = plan(grid, bot, 80, (x, y, c) => Math.abs(Math.hypot(x - z.x, y - z.y) - PHOTO_DIST) * 10 + corner(x, y) + c * 0.02);
        const end = path.length ? path[path.length - 1] : bot;
        if (Math.hypot(end.x - z.x, end.y - z.y) >= PHOTO_DIST + 0.45) continue; // unreachable
        const len = pathLength(bot, path);
        if (!best || len < best.len) best = { z, path, len };
      }
      if (best) { bot.target = zoneKey(best.z); bot.path = best.path; bot.shooting = 0; }
      bot.repath = REPLAN; // when nothing is reachable, look again shortly
    }
    const target = bot.target && todo.find((z) => zoneKey(z) === bot.target);
    if (target) bot.goal = { x: target.x, y: target.y };
    else if (current === 'home') {
      bot.goal = { x: home.x, y: home.y };
      if (blockedAhead(g, bot)) { bot.path = []; bot.repath = 0; }
      if (!bot.path.length && bot.repath <= 0 && Math.hypot(home.x - bot.x, home.y - bot.y) > 0.15) {
        bot.path = plan(buildGrid(g, 0.45, false, bot), bot, 80, (x, y, c) => Math.hypot(x - home.x, y - home.y) * 10 + c * 0.02);
        bot.repath = REPLAN;
      }
    }
  }
  followPath(g, bot, speed * dt, dt);
  pushOut(g, bot);

  if (!bot.scared) {
    const target = bot.target && todo.find((z) => zoneKey(z) === bot.target);
    if (target) {
      const d = Math.hypot(target.x - bot.x, target.y - bot.y);
      if (!bot.path.length && d >= PHOTO_DIST + 0.5) { bot.target = null; bot.shooting = 0; bot.repath = 0; } // route ended short of the drop point: pick again
      else if (!bot.path.length) {
        const key = zoneKey(target), st = stackAt(target);
        const complete = done.some((z) => zoneKey(z) === key);
        bot.aim = { x: target.x, y: target.y, h: st ? st.layers.length : 1 };
        if (Math.abs(turnTo(bot, Math.atan2(target.y - bot.y, target.x - bot.x), dt)) < 0.15) bot.shooting += dt;
        if (bot.shooting >= Math.max(1, bot.aim.h) * BOX_SECS) {
          const photo = st && complete && makePhoto(st, !wonky(st, target) && !st.pen.some((q) => q?.crash > 0 && repairable(q)),
            Math.atan2(target.y - bot.y, target.x - bot.x), Math.hypot(target.x - bot.x, target.y - bot.y), (g.photo?.n || 0) + 1, g.clock);
          if (photo) {
            g.photo = photo;
            (bot.sigs ||= {})[key] = stackSig(st);
            for (const pen of st.pen || []) pen.inspected = true;
            st.touched = false; g.photo.at = { x: st.x, y: st.y }; g.photo.sig = stackSig(st);
            (bot.photos ||= {})[key] = g.photo;
            bot.seen.push(key);
          }
          bot.shooting = 0; bot.flash = 1; bot.target = null; bot.repath = 0;
          if (photo) (g.hits ||= []).push({ x: bot.x, y: bot.y, z: 0.5, t: g.clock, owner: null, check: !photo.ok ? 'warn' : 'perfect' });
        }
      }
    } else if (current === 'home' && Math.hypot(home.x - bot.x, home.y - bot.y) < 0.15) {
      retract(g, bot, dt);
      return;
    }
  }
}

// Righting bot (a folding gantry arch on tracks): fixes toppled boxes. It works reachable pallets first, then reachable boxes, then
// "cheats" by beaming the unreachable ones out from the nearest point it can get to. A loose pallet is lifted by tractor beam and set down on
// a free spot; a box is then beamed upright onto it (`pen.loose.set`), or onto its own spot when it never lost its pallet.
// `bot.fix` = { kind, key, sx, sy, phase: 'go' | 'up' | 'carry' | 'down', t, age, stuck, spot, ... }; a box in the beam is `bot.carry` (out of `g.stacks`).
