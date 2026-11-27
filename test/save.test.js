import assert from 'node:assert/strict';
import { generateLevel, parseSeed, isReachable } from '../js/level.js';
import { pointRectDist } from '../js/geom.js';
import { FL, toLocal, toWorld, maxSteerFor } from '../js/forklift.js';
import { reverseLight, REV_RADIUS } from '../js/revlight.js';
import { serializeGame, deserializeGame, encodeState, decodeState, serializeEndless, deserializeEndless } from '../js/savestate.js';
import { createStateHistory } from '../js/state-history.js';
import { chaseOrbit } from '../js/gl/camera.js';
import { chaseDrift, povCamera, overviewCamera, chaseCamera, chaseRig, chaseTiles, chaseZoom, clearChaseTilt, groundFootprint, CHASE_TILT } from '../js/gl/camera.js';
import { staticMeshes, dynamicMeshes } from '../js/gl/scene.js';
import { projectPoint } from '../js/gl/mat.js';
import { setThemeMode } from '../js/theme.js';
import { laneAt, stackSig } from '../js/bot.js';
import { setDiscoEnabled } from '../js/disco.js';
import { createDemo } from '../js/demo.js';
import { createHost } from '../js/net/host.js';
import { createGuest } from '../js/net/guest.js';
import { createPredictor } from '../js/net/predict.js';
import { applySnapshot, createInterpolator, snapshot } from '../js/net/protocol.js';
import { rectPoly, sat, FORK_CLEARANCE } from '../js/geom.js';
import { TRUCK_BONUS, lorryHonks, newEndless, stepEndless, endEndless, rampDecals, truckRoofs, numberRects, dockWaits, truckGeom, unloadRate, interval, endlessScore, animatedDoors } from '../js/endless.js';
import { newGame, update, addTruck, removeTruck, truckView, isGhost, ghostBetween, forkUp, forkDown, stackInZone, isParked, isFinished, score, maxScore, lostBreakdown, zoneWonky, zoneDone, zonePoints, zoneLabelPos, stackZ, wonkyStack, fallView } from '../js/game.js';

import { NONE, pts, run, faceStack, flatWorld, driveUntil } from './common.js';

// Old saves keep active bots but relocate bots in the old hatch and replan their routes.
{
  for (const endless of [false, true]) {
    const g = endless ? newEndless(7) : newGame(3, 7);
    const data = endless ? serializeEndless(g) : serializeGame(g);
    delete data.hatchVersion;
    Object.assign(data.state.bot, { x: -5, y: -5, show: 0.5, leaving: true, path: [{ x: -5, y: -5 }], repath: 10 });
    Object.assign(data.state.inspector, { x: 5, y: 6, show: 1, path: [{ x: -5, y: -5 }], repath: 10 });
    const restored = endless ? deserializeEndless(data) : deserializeGame(data);
    assert.deepEqual({ x: restored.bot.x, y: restored.bot.y }, laneAt(restored.hatch, 0.5));
    assert.equal(restored.bot.a, restored.hatch.a + Math.PI);
    assert.deepEqual([restored.inspector.x, restored.inspector.y], [5, 6], 'active bots remain in place');
    assert.deepEqual(restored.inspector.path, []);
    assert.equal(restored.inspector.repath, 0);
  }
}

// Rolling history is detached, bounded and based on active simulation time.
{
  for (const endless of [false, true]) {
    const g = endless ? newEndless(7) : newGame(3, 7);
    const history = createStateHistory();
    const snap = () => endless ? serializeEndless(g) : serializeGame(g, 'seed');
    let calls = 0;
    for (let i = 0; i < 600; i++) {
      g.fl.x = i / 120;
      history.step(1 / 120, () => { calls++; return snap(); });
    }
    const saved = history.earlier();
    assert.ok(saved, 'five seconds of active time makes a snapshot available');
    const oldX = saved.state.fl.x;
    g.fl.x = 100;
    assert.equal(saved.state.fl.x, oldX, 'later changes do not mutate a snapshot');
    const restored = endless ? deserializeEndless(saved) : deserializeGame(saved);
    assert.equal(restored.fl.x, oldX, 'historical save remains importable');
    assert.ok(calls <= 52, 'snapshot cadence is approximately ten per second');
    const frozen = history.earlier();
    assert.equal(history.earlier(), frozen, 'without simulation steps history does not advance');
    for (let i = 0; i < 240; i++) { g.fl.x = 5 + i / 120; history.step(1 / 120, snap); }
    assert.ok(Math.abs(history.earlier().state.fl.x - 2) < 0.15, 'export is about five active seconds old');
    history.clear();
    assert.equal(history.earlier(), null, 'reset discards prior snapshots');
  }
  const history = createStateHistory();
  for (let i = 0; i < 599; i++) history.step(1 / 120, () => ({}));
  assert.equal(history.earlier(), null, 'short histories are unavailable');
}

// Save / restore a level in progress through JSON (localStorage and export/import).
{
  const g = newGame(3, 7, true);
  run(g, { up: true }, 1.5);
  run(g, { left: true, up: true }, 1);
  forkUp(g);
  g.cones = [{ id: 'cone-a', goalId: 'spill:a:0', x: 2, y: 3, a: 0.2, tipped: true, squished: false }];
  g.tapes = [{ key: '0:1,2,3,4', color: 0, x: 1, y: 2, w: 3, h: 4, sig: 'sig-a', broken: true }];
  g.skidMarks = [{ id: 'skid:test', x: 3, y: 4, a: 0.2, left: 0.5 }];
  g.inspector.checkedAreas = [{ key: '0:1,2,3,4', sig: 'sig-a', complete: false }];
  g.inspector.seen = ['2,3,0'];
  g.inspector.sigs = { '2,3,0': 'stack-sig' };
  g.coneBot.carried = { id: 'cone-b', goalId: 'spill:b:1', x: 4, y: 5, a: 0, tipped: false, squished: false };
  const json = JSON.stringify(serializeGame(g, 'abc'));
  const r = deserializeGame(JSON.parse(json));
  assert.deepEqual(r.cones, g.cones, 'cone condition and targets survive saves');
  assert.deepEqual(r.tapes, g.tapes, 'tape condition and geometry survive saves');
  assert.deepEqual(r.skidMarks, g.skidMarks, 'partly cleaned skid marks survive saves');
  const withDrop = JSON.parse(json);
  withDrop.state.dropH = 1 + FORK_CLEARANCE;
  assert.equal(deserializeGame(withDrop).dropH, withDrop.state.dropH, 'drop height survives saves');
  withDrop.state.dropH = -1;
  assert.throws(() => deserializeGame(withDrop), /Corrupt state/, 'invalid drop height is rejected');
  const legacySkids = JSON.parse(json);
  delete legacySkids.state.skidMarks; legacySkids.state.bot = null;
  const restoredLegacy = deserializeGame(legacySkids);
  assert.deepEqual(restoredLegacy.skidMarks, []);
  assert.ok(restoredLegacy.bot, 'legacy saves without a cleaner get one');
  const corruptSkid = JSON.parse(json);
  corruptSkid.state.skidMarks[0].left = -1;
  assert.throws(() => deserializeGame(corruptSkid), /Corrupt state/);
  assert.deepEqual(r.inspector.checkedAreas, g.inspector.checkedAreas, 'legacy area inspection state remains loadable');
  assert.deepEqual(r.inspector.seen, g.inspector.seen, 'individual scan status survives saves');
  assert.deepEqual(r.inspector.sigs, g.inspector.sigs, 'individual scan fingerprints survive saves');
  assert.deepEqual(r.coneBot.carried, g.coneBot.carried, 'legacy carried-cone state survives loading');
  const legacyHard = JSON.parse(json);
  delete legacyHard.hardPhysicsVersion;
  assert.deepEqual(deserializeGame(legacyHard).stacks, g.stacks, 'legacy hard-mode geometry converts without discarding cargo');
  assert.throws(() => deserializeGame({ ...legacyHard, hardPhysicsVersion: 999 }), /hard-mode physics is no longer compatible/);
  const legacyEasy = serializeGame(newGame(3, 7));
  delete legacyEasy.hardPhysicsVersion;
  assert.equal(deserializeGame(legacyEasy).hard, false, 'easy-mode saves need no physics version');
  const endlessHard = serializeEndless(newEndless(7, true));
  delete endlessHard.hardPhysicsVersion;
  assert.equal(deserializeEndless(endlessHard).hard, true, 'legacy endless hard-mode geometry remains loadable');
  assert.throws(() => deserializeEndless({ ...endlessHard, hardPhysicsVersion: 999 }), /hard-mode physics is no longer compatible/);
  assert.equal(r.level, 3);
  assert.equal(r.seed, 7);
  assert.equal(r.hard, true);
  assert.deepEqual(r.fl, g.fl);
  assert.deepEqual(r.stacks, g.stacks);
  assert.equal(r.H, g.H);
  assert.equal(r.time, g.time);
  assert.equal(r.walls.length, g.walls.length);
  const c = newGame(3, 7, true);
  c.fl.x = c.stacks[0].x - 2.5; c.fl.y = c.stacks[0].y; c.fl.a = 0;
  c.carried = c.stacks.splice(0, 1)[0].layers;
  c.carriedRots = c.carried.map(() => 0); c.carriedPen = c.carried.map(() => ({ crash: 0, sq: 0 })); c.carriedOffs = c.carried.map(() => ({ x: 0, y: 0 }));
  c.carriedPen[0].inspected = true;
  c.H = 1;
  c.hy = 1.4 + FORK_CLEARANCE;
  c.hf = c.hy;
  const oldCarried = serializeGame(c);
  delete oldCarried.hardPhysicsVersion;
  oldCarried.state.hy -= FORK_CLEARANCE;
  const converted = deserializeGame(oldCarried);
  assert.ok(Math.abs(converted.hy - c.hy) < 1e-9, 'legacy carried-load height converts to physical tine height');
  assert.equal(converted.hf, c.hf, 'legacy drawing height is unchanged');
  const previousPhysics = serializeGame(c);
  previousPhysics.hardPhysicsVersion = 2;
  assert.equal(deserializeGame(previousPhysics).hy, c.hy, 'version 2 already stores physical tine height');
  previousPhysics.hardPhysicsVersion = 3;
  assert.equal(deserializeGame(previousPhysics).hy, c.hy, 'version 3 saves remain loadable');
  endlessHard.hardPhysicsVersion = 2;
  assert.equal(deserializeEndless(endlessHard).hard, true, 'version 2 endless saves remain loadable');
  endlessHard.hardPhysicsVersion = 3;
  assert.equal(deserializeEndless(endlessHard).hard, true, 'version 3 endless saves remain loadable');
  assert.deepEqual(deserializeGame(JSON.parse(JSON.stringify(serializeGame(c)))).carried, c.carried, 'carried stack restores');
  assert.equal(deserializeGame(JSON.parse(JSON.stringify(serializeGame(c)))).carriedPen[0].inspected, true, 'inspection follows carried boxes through saves');
  const cGuest = newGame(3, 7, true);
  c.cones = [{ id: 'net-cone', goalId: 'stack:zone:0', x: 2, y: 3, a: 0, tipped: false, squished: false }];
  c.tapes = [{ key: 'net-area', color: 0, x: 1, y: 1, w: 2, h: 2, sig: '', broken: true,
    posts: [true, true, false, false], edges: [true, false, false, false], wallSides: [null, 3.2, null, null],
    postPoints: [null, { x: 3.4, y: 1 }, null, null] }];
  c.tapeBot.tapeJob = { key: 'net-area', edge: 1, from: 1, to: 2, phase: 'draw' };
  c.inspector.checkedAreas = [{ key: 'net-area', sig: 'net', complete: true }];
  c.inspector.seen = ['2,3,0'];
  c.inspector.sigs = { '2,3,0': 'stack-sig' };
  const tapeSave = serializeGame(c);
  const restoredTape = deserializeGame(JSON.parse(JSON.stringify(tapeSave)));
  assert.deepEqual(restoredTape.tapes, c.tapes, 'partially installed tape survives saving');
  assert.deepEqual(restoredTape.tapeBot.tapeJob, c.tapeBot.tapeJob, 'the current deployment survives saving');
  const badTape = JSON.parse(JSON.stringify(tapeSave));
  badTape.state.tapes[0].edges = [true];
  assert.throws(() => deserializeGame(badTape), /Corrupt state/, 'malformed tape state is rejected');
  const badPostPoint = JSON.parse(JSON.stringify(tapeSave));
  badPostPoint.state.tapes[0].postPoints[1].x = '3.4';
  assert.throws(() => deserializeGame(badPostPoint), /Corrupt state/, 'malformed relocated tape post is rejected');
  applySnapshot(cGuest, JSON.parse(JSON.stringify(snapshot(c))));
  assert.deepEqual(cGuest.cones, c.cones, 'cones sync to party guests');
  assert.deepEqual(cGuest.tapes, c.tapes, 'tape syncs to party guests');
  assert.deepEqual(cGuest.tapeBot.tapeJob, c.tapeBot.tapeJob, 'deployment syncs to party guests');
  assert.deepEqual(cGuest.inspector.checkedAreas, c.inspector.checkedAreas, 'legacy area inspection state syncs');
  assert.deepEqual(cGuest.inspector.seen, c.inspector.seen, 'individual scan status syncs');
  assert.deepEqual(cGuest.inspector.sigs, c.inspector.sigs, 'individual scan fingerprints sync');
  assert.equal(cGuest.carriedPen[0].inspected, true, 'inspection follows carried boxes in party snapshots');
  const legacyInspection = serializeGame(newGame(3, 7));
  delete legacyInspection.inspectionVersion;
  const oldStack = legacyInspection.state.stacks[0], oldZone = newGame(3, 7, true).zones[0];
  oldStack.x = oldZone.x; oldStack.y = oldZone.y;
  const key = `${oldZone.x},${oldZone.y},${oldZone.color}`;
  legacyInspection.state.inspector.seen = [key];
  legacyInspection.state.inspector.sigs = { [key]: stackSig(oldStack) };
  assert.ok(deserializeGame(legacyInspection).stacks[0].pen.every((p) => p.inspected), 'legacy matching inspection restores box knowledge');
  oldStack.touched = true;
  assert.ok(deserializeGame(legacyInspection).stacks[0].pen.every((p) => !p.inspected), 'legacy touched stacks are not treated as inspected');
  const oldPlacement = serializeGame(newGame(3, 7, true));
  oldPlacement.inspectionVersion = 1;
  oldPlacement.state.stacks[0].pen.forEach((p) => { p.inspected = true; });
  oldPlacement.state.inspector.seen = [key];
  oldPlacement.state.inspector.sigs = { [key]: stackSig(oldPlacement.state.stacks[0]) };
  oldPlacement.state.inspector.photos = { [key]: { pens: [{ shift: 10 }] } };
  oldPlacement.state.photo = { layers: [0], pens: [{ shift: 10 }], rots: [0], offs: [{ x: 0, y: 0 }], at: { x: 0, y: 0 } };
  const recheck = deserializeGame(oldPlacement);
  assert.deepEqual(recheck.inspector.seen, [], 'old hard-mode placement reports must be rechecked');
  assert.equal(recheck.photo, null, 'the obsolete placement photo is hidden');
  assert.ok(recheck.stacks[0].pen.every((p) => !p.inspected), 'old placement badges are not retained');
  const touchedSave = serializeGame(newGame(3, 7, true));
  touchedSave.state.stacks[0].touched = true;
  touchedSave.state.stacks[0].pen.forEach((p) => { p.inspected = true; });
  assert.ok(deserializeGame(touchedSave).stacks[0].pen.every((p) => !p.inspected), 'a saved touched stack cannot retain old badges');
  run(g, { up: true }, 1);
  run(r, { up: true }, 1);
  assert.deepEqual(r.fl, g.fl);
  assert.throws(() => deserializeGame({ version: 99 }));
  assert.throws(() => deserializeGame({ ...JSON.parse(json), level: 4 }));
  const legacy = JSON.parse(json); delete legacy.layoutVersion;
  assert.throws(() => deserializeGame(legacy), /layout is no longer compatible/, 'old wide-box layouts cannot restore onto changed targets');
  assert.throws(() => deserializeGame({ ...JSON.parse(json), layoutVersion: 3 }), /layout is no longer compatible/, 'old barrel zones cannot restore onto the updated layout');
  const early = serializeGame(newGame(2)); delete early.layoutVersion;
  assert.throws(() => deserializeGame(early), /layout is no longer compatible/, 'old early layouts may also have changed');
  assert.throws(() => deserializeGame({ ...early, layoutVersion: 4 }), /layout is no longer compatible/, 'old layouts cannot restore onto regenerated levels');
  assert.throws(() => deserializeGame({ ...early, layoutVersion: 999 }), /layout is no longer compatible/, 'unknown layout versions are rejected');
  assert.throws(() => deserializeGame({ ...JSON.parse(json), state: { ...JSON.parse(json).state, fl: null } }));
  const cs = JSON.parse(JSON.stringify(serializeGame(c)));
  assert.throws(() => deserializeGame({ ...cs, state: { ...cs.state, carriedRots: [] } }), 'carried rots length');
  assert.throws(() => deserializeGame({ ...cs, state: { ...cs.state, carriedOffs: [null] } }), 'carried offs type');
  assert.throws(() => deserializeGame({ ...cs, state: { ...cs.state, carriedPen: [{ crash: 'x', sq: 0 }] } }), 'carried pen type');
  const bad = JSON.parse(json); bad.state.stacks[0].rots = [];
  assert.throws(() => deserializeGame(bad), 'stack rots length');
  const snap = serializeGame(r, 'abc');
  const enc = await encodeState(snap);
  assert.match(enc, /^[A-Za-z0-9+/]+=*$/);
  assert.ok(enc.length < JSON.stringify(snap).length * 0.6, 'compressed');
  assert.deepEqual(await decodeState(enc), snap);
  assert.deepEqual(await decodeState(JSON.stringify(snap)), snap);
  const hitG = newGame(3);
  hitG.clock = 300; hitG.stacks[0].hitAt = 299.9;
  const hitR = deserializeGame(JSON.parse(JSON.stringify(serializeGame(hitG))));
  assert.ok(hitR.clock - hitR.stacks[0].hitAt >= 0, 'crash cooldown does not outlive a reload');
  hitG.oil.push({ id: 'barrel:1:0', barrelId: 'barrel:1', seq: 0, x: 4, y: 5, anchorX: 3.8, anchorY: 4.9, r: 0.2, leaking: true });
  assert.deepEqual(deserializeGame(JSON.parse(JSON.stringify(serializeGame(hitG)))).oil, hitG.oil, 'oil spills survive save and restore');
  const guest = newGame(3);
  applySnapshot(guest, snapshot(hitG));
  assert.deepEqual(guest.oil, hitG.oil, 'oil spills sync to multiplayer guests');
  const leaking = newGame(3);
  leaking.fl.speed = 0;
  const barrel = leaking.stacks.find((s) => s.pen?.some((p) => p.barrelPart === 'base'));
  const base = barrel.pen.find((p) => p.barrelPart === 'base');
  base.crash = 1;
  base.oilDropped = 49;
  base.oilFraction = 0.9;
  const resumed = deserializeGame(JSON.parse(JSON.stringify(serializeGame(leaking))));
  applySnapshot(guest, snapshot(leaking));
  const resumedBase = resumed.stacks.find((s) => s.pen.some((p) => p.barrelId === base.barrelId)).pen.find((p) => p.barrelPart === 'base');
  const guestBase = guest.stacks.find((s) => s.pen.some((p) => p.barrelId === base.barrelId)).pen.find((p) => p.barrelPart === 'base');
  assert.equal(guestBase.oilDropped, 49, 'multiplayer preserves the consumed oil supply');
  assert.equal(guestBase.oilFraction, 0.9, 'multiplayer preserves drop timing');
  resumed.bot = null; // keep the cleaning bot from mopping the spill during the check
  run(resumed, NONE, 1);
  assert.equal(resumedBase.oilDropped, 50, 'saving preserves fractional progress to the last drop');
  assert.equal(resumed.oil[0].drops, 1, 'reloading does not refill the barrel');
  run(resumed, NONE, 10);
  assert.equal(resumed.oil[0].drops, 1, 'a restored empty barrel remains empty');
  const corruptOil = serializeGame(leaking);
  corruptOil.state.stacks.find((s) => s.pen.some((p) => p.barrelPart === 'base')).pen.find((p) => p.barrelPart === 'base').oilDropped = -1;
  assert.throws(() => deserializeGame(corruptOil), /Corrupt state/, 'negative consumption is rejected');
  console.log('savestate ok');
}

// Service worker precache lists every module, so the offline PWA has the whole game.
{
  const { readFileSync, readdirSync } = await import('node:fs');
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const root = new URL('../js/', import.meta.url);
  const mods = readdirSync(root, { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3).replaceAll('\\', '/'));
  const missing = mods.filter((m) => !sw.includes(`'${m}'`));
  assert.deepEqual(missing, [], 'modules missing from sw.js CORE');
  console.log('sw precache ok');
}

// Saves from before the bot state machine load with legacy fields dropped and the bots loitering.
{
  const g = newGame(3, 0), data = serializeGame(g);
  Object.assign(data.state.bot, { activity: 'follow', scared: true, curiosity: 3, yieldFor: 'x' });
  delete data.state.bot.state;
  const back = deserializeGame(data);
  assert.equal(back.bot.state, 'loiter');
  for (const f of ['activity', 'scared', 'curiosity', 'yieldFor']) assert.ok(!(f in back.bot), f);
  console.log('old bot save ok');
}

console.log('save tests passed');
