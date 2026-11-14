import assert from 'node:assert/strict';
import { generateLevel, parseSeed, isReachable } from '../js/level.js';
import { pointRectDist } from '../js/geom.js';
import { FL, toLocal, toWorld, maxSteerFor } from '../js/forklift.js';
import { reverseLight, REV_RADIUS } from '../js/revlight.js';
import { serializeGame, deserializeGame, encodeState, decodeState, serializeEndless, deserializeEndless } from '../js/savestate.js';
import { chaseOrbit } from '../js/gl/camera.js';
import { chaseDrift, povCamera, overviewCamera, chaseCamera, chaseRig, chaseTiles, chaseZoom, clearChaseTilt, groundFootprint, CHASE_TILT } from '../js/gl/camera.js';
import { staticMeshes, dynamicMeshes } from '../js/gl/scene.js';
import { projectPoint } from '../js/gl/mat.js';
import { setThemeMode } from '../js/theme.js';
import { setDiscoEnabled } from '../js/disco.js';
import { createDemo } from '../js/demo.js';
import { createHost } from '../js/net/host.js';
import { createGuest } from '../js/net/guest.js';
import { createPredictor } from '../js/net/predict.js';
import { applySnapshot, createInterpolator, snapshot } from '../js/net/protocol.js';
import { rectPoly, sat } from '../js/geom.js';
import { TRUCK_BONUS, lorryHonks, newEndless, stepEndless, endEndless, rampDecals, truckRoofs, numberRects, dockWaits, truckGeom, unloadRate, interval, endlessScore, animatedDoors } from '../js/endless.js';
import { newGame, update, addTruck, removeTruck, truckView, isGhost, ghostBetween, forkUp, forkDown, forkDownAll, stackInZone, isParked, isFinished, score, maxScore, lostBreakdown, zoneWonky, zoneDone, zonePoints, zoneLabelPos, stackZ, wonkyStack, fallView } from '../js/game.js';

import { NONE, pts, run, faceStack, flatWorld, driveUntil } from './common.js';

// Endless mode in a party: the snapshot carries the trucks and gates, and the guest's prediction shares the moving walls.
{
  const host = newEndless(5);
  addTruck(host, 'Bob');
  for (let i = 0; i < 12 * 60; i++) { update(host, NONE, 1 / 60); stepEndless(host, 1 / 60); }
  assert.ok(host.endless.docks.some((d) => d.state !== 'free'), 'an incoming truck arrived');
  const guest = newEndless(5);
  guest.self = 1;
  applySnapshot(guest, JSON.parse(JSON.stringify(snapshot(host))));
  assert.deepEqual(guest.endless.docks.map((d) => [d.state, d.off]), host.endless.docks.map((d) => [d.state, d.off]));
  assert.equal(guest.walls.length, host.walls.length, 'gates and trucks are mirrored as walls');
  assert.equal(guest.endless.arrived, host.endless.arrived);
  const pr = createPredictor();
  pr.reset(guest);
  pr.step(guest, { up: true }, 1 / 60, 0);
  assert.ok(pr.ready);
}

// Endless mode: incoming trucks bring 2x3 stacks to the west wall, a full delivery truck closes its gate, drives off and is replaced;
// the game ends when a new incoming truck is due and every west bay is still occupied.
{
  const g = newEndless(1);
  const step = (secs) => { for (let i = 0; i < secs * 60; i++) { update(g, NONE, 1 / 60); stepEndless(g, 1 / 60); } };
  const E = g.endless;
  g.fl.x = 20; g.fl.y = 7; g.fl.a = 0; // well away from the trucks
  assert.ok(g.walls.includes(E.docks[0].parts.gate), 'an empty west bay is closed off');
  step(1.2);
  const d = E.docks[0];
  assert.equal(d.state, 'arriving');
  assert.equal(g.stacks.length, 6, 'an incoming truck carries 2x3 stacks');
  step(10);
  assert.equal(d.state, 'present');
  assert.ok(!g.walls.includes(d.parts.gate), 'the gate opens when the truck has arrived');
  assert.ok(truckRoofs(g).length >= 6 && truckRoofs(g).every((r) => r.color !== undefined), 'roofs exist for the present trailers and bays');
  assert.equal(E.docks.length, 6);
  assert.equal(E.bays.length, 5);
  assert.ok(E.docks.every((o) => o.y0 <= d.y0), 'the first truck takes the southernmost bay');
  assert.equal(E.docks.filter((o) => o.side > 0).length, 3, 'three incoming bays on each side');
  assert.equal(rampDecals(g).length, 11, 'every bay has a permanent ramp decal, truck or not');
  assert.equal(rampDecals(g).filter((r) => r.east).length, 6);
  assert.deepEqual(rampDecals(g).filter((r) => r.east).sort((a, b) => b.y - a.y).filter((r) => r.side < 0).map((r) => r.num), [1, 2, 3], 'west bays are 1-3, southernmost first');
  assert.deepEqual(rampDecals(g).filter((r) => r.side > 0).sort((a, b) => b.y - a.y).map((r) => r.num), [4, 5, 6], 'east bays are 4-6');
  assert.deepEqual(rampDecals(g).filter((r) => r.num).sort((a, b) => a.num - b.num).map((r) => numberRects(r).length), [8, 11, 11, 9, 11, 12], 'glyphs of 1-6 (no zero)');
  assert.ok(rampDecals(g).filter((r) => r.num).every((r) => numberRects(r).length >= 5), 'each number has pixels');
  assert.ok(dockWaits(g)[d.k] >= 0 && dockWaits(g).filter((w) => w !== null).length === 1, 'the present truck is timed');
  assert.ok(rampDecals(g).every((r) => [r.x, r.y, r.w, r.h].every(Number.isFinite)));
  assert.ok(g.stacks.every((s) => !s.leaving && s.x < 8 && s.x > 2 && s.layers.length >= 1 && s.layers.length <= 3), 'stacks stand in the trailer');
  const slots = new Set(g.stacks.map((s) => `${Math.round(s.x)},${Math.round(s.y)}`));
  assert.equal(slots.size, 6);
  // impatient driver: honks every minute, 0.5 s longer for every 5 minutes waited
  E.arriveT = 1e9;
  const held = g.stacks;
  const nag = (min, n) => { d.since = E.elapsed - min * 60 + 0.01; d.nagN = n; d.nagT = -1e9; step(0.05); };
  assert.equal(d.nagN, 0);
  nag(1, 0);
  assert.equal(d.nagN, 1); assert.equal(d.nagDur, 0.5);
  assert.ok(lorryHonks(g).some((h) => h.id === 100 + d.k), 'the label shows during the honk');
  nag(5, 4);
  assert.equal(d.nagDur, 1);
  nag(10, 9);
  assert.equal(d.nagDur, 1.5);
  d.nagT = E.elapsed - 2; step(0.05);
  assert.ok(!lorryHonks(g).some((h) => h.id === 100 + d.k), 'the honk ends');
  g.stacks = held;
  // an unloaded truck leaves
  g.stacks = [];
  step(0.2);
  assert.equal(d.state, 'leaving');
  assert.equal(dockWaits(g)[d.k], null, 'a leaving truck is no longer timed');
  step(5);
  assert.equal(d.state, 'free');
  assert.equal(E.unloaded, 1);

  // delivery truck: a full truck closes its gate and drives off with its load
  E.arriveT = 1e9;
  g.fl.a = 0; g.fl.x = 20; g.fl.y = 7; g.carried = null; g.H = 0; g.hf = 0;
  const bay = E.bays[1];
  g.stacks = bay.zones.map((z) => ({ x: z.x, y: z.y, layers: [1, 1, 1, 1] }));
  step(0.2);
  assert.equal(bay.state, 'closing');
  assert.equal(bay.honkN, 2, 'the truck honks twice first');
  assert.ok(!g.walls.includes(bay.parts.gate), 'the gate is still open while it honks');
  assert.ok(E.live > 1500 && E.points === 0 && endlessScore(E) === E.live, 'a full load counts in the running score but is not banked yet');
  const loadScore = E.live;
  step(0.7);
  assert.ok(g.walls.includes(bay.parts.gate), 'gate closes when the truck is full');
  step(1.2 + 1);
  assert.ok(E.points > 1500 + TRUCK_BONUS && E.boxes === 24, 'closing the gate banks the points and the truck bonus');
  assert.equal(E.points, loadScore + TRUCK_BONUS);
  assert.ok(bay.off > 0 && g.stacks.length === 6, 'truck drives off with its load');
  assert.ok(g.walls.includes(bay.door), 'the bay door shuts the wall while the truck is out');
  step(4);
  assert.ok(g.walls.includes(bay.door), 'and stays shut while the bay is empty');
  assert.equal(E.delivered, 1);
  assert.equal(E.boxes, 24);
  assert.ok(E.points > 1500, 'delivered boxes are scored');
  assert.equal(g.stacks.length, 0, 'the load left with the truck');
  step(8);
  assert.ok(bay.state === 'open' && bay.off === 0 && !g.walls.includes(bay.parts.gate), 'a new truck waits with an open gate');
  assert.ok(!g.walls.includes(bay.door), 'the bay door opens with the new truck');

  // removing a stack from an open drop point takes its points off the running score
  const rk = newEndless(3);
  rk.endless.arriveT = 1e9;
  const rb = rk.endless.bays[0];
  rk.stacks = [{ x: rb.zones[0].x, y: rb.zones[0].y, layers: [0, 0, 0, 0] }];
  rk.fl.x = 5; rk.fl.y = 5;
  stepEndless(rk, 1 / 60);
  assert.equal(endlessScore(rk.endless), 400);
  rk.stacks = [];
  stepEndless(rk, 1 / 60);
  assert.equal(endlessScore(rk.endless), 0, 'points are deducted when the stack leaves the drop point');
  rk.stacks = [{ x: rb.zones[0].x, y: rb.zones[0].y, layers: [0, 0] }, { x: rb.zones[1].x, y: rb.zones[1].y, layers: [0, 0, 0, 0] }];
  stepEndless(rk, 1 / 60);
  endEndless(rk);
  assert.equal(endlessScore(rk.endless), 400, 'at the end only completed stacks of a partly packed lorry count');

  // a forklift inside keeps the gate open
  const h = newEndless(2);
  h.endless.arriveT = 1e9;
  const b2 = h.endless.bays[0];
  h.stacks = b2.zones.map((z) => ({ x: z.x, y: z.y, layers: [0, 0, 0, 0] }));
  h.fl.x = b2.zones[2].x; h.fl.y = b2.zones[2].y + 0.2; h.fl.a = -Math.PI / 2;
  stepEndless(h, 1 / 60);
  assert.equal(b2.state, 'open', 'gate stays open while the forklift is inside');

  // tines poking into the full truck (body outside) keep the gate open; a forklift driving up while the gate closes reopens it
  const k = newEndless(4);
  k.endless.arriveT = 1e9;
  const b3 = k.endless.bays[2];
  k.stacks = b3.zones.map((z) => ({ x: z.x, y: z.y, layers: [2, 2, 2, 2] }));
  k.fl.x = b3.x0 + 1.8; k.fl.y = 18 + 0.3 - 1.0; k.fl.a = Math.PI / 2; // tines reach ~0.5 into the trailer
  update(k, NONE, 1 / 60); stepEndless(k, 1 / 60);
  assert.equal(b3.state, 'open', 'gate stays open while the tines are in the truck');
  k.fl.x = 20; k.fl.y = 7; // clear
  update(k, NONE, 1 / 60); stepEndless(k, 1 / 60);
  assert.equal(b3.state, 'closing');
  k.fl.x = b3.x0 + 1.8; k.fl.y = 18 + 0.3 - 1.0;
  update(k, NONE, 1 / 60); stepEndless(k, 1 / 60);
  assert.equal(b3.state, 'open', 'closing is aborted when a forklift comes too close');
  assert.ok(!k.walls.includes(b3.parts.gate));

  // all incoming bays still occupied when the next truck is due: game over
  const m = newEndless(3);
  m.fl.x = 20; m.fl.y = 7; m.fl.a = 0;
  for (let i = 0; i < 60 * 1200 && m.status !== 'over'; i++) stepEndless(m, 1 / 60); // no update(): collision resolving dominates the run time and nothing moves here
  assert.equal(m.status, 'over');
  assert.ok(m.endless.docks.every((o) => o.state === 'present'));
  assert.equal(m.endless.arrived, 6);
  assert.ok(m.stacks.filter((q) => q.x > m.w - 8.3).length === 18 && m.stacks.filter((q) => q.x < 8.3).length === 18, 'both sides hold their trucks\' stacks');
  assert.ok(unloadRate(m.endless) < 0.15, 'an idle crew lowers the measured unloading rate');

  // adaptive pace: a crew that unloads fast gets trucks sooner than one that does not
  const fast = newEndless(4), slow = newEndless(4);
  for (const q of [fast, slow]) { q.fl.x = 20; q.fl.y = 7; q.fl.a = 0; stepEndless(q, 1); }
  for (let i = 0; i < 60 * 60; i++) {
    for (const s of fast.stacks) if (i % 120 === 0 && s.x > 2 && s.x < 8) { fast.stacks.splice(fast.stacks.indexOf(s), 1); break; }
    stepEndless(fast, 1 / 60); stepEndless(slow, 1 / 60);
  }
  assert.ok(unloadRate(fast.endless) > unloadRate(slow.endless), 'removing boxes raises the measured rate');
  assert.ok(interval(fast.endless, 12) < interval(slow.endless, 12));

  // difficulty slides: harder while fewer than 5 docks are occupied, easier once 5 are
  {
    const g = newEndless(4);
    g.fl.x = 20; g.fl.y = 7; g.fl.a = 0;
    const m0 = g.endless.margin;
    for (const d of g.endless.docks) d.state = 'free';
    stepEndless(g, 60);
    assert.ok(g.endless.margin < m0, 'margin falls with few lorries');
    const m1 = g.endless.margin;
    for (const d of g.endless.docks.slice(0, 5)) d.state = 'present';
    g.endless.arriveT = 1e9;
    stepEndless(g, 60);
    assert.ok(g.endless.margin > m1, 'margin rises with 5 lorries');
  }

  // bay doors ease open and shut instead of popping
  {
    const g = newEndless(1);
    const d = animatedDoors(g).find((o) => o.w.roller && o.w.lift === 0);
    assert(d, 'a shut dock roller door starts at lift 0');
    d.w.lift = 0.5;
    stepEndless(g, 0.1);
    assert(d.w.lift > 0 && d.w.lift < 0.5, 'a shut door keeps lowering gradually');
  }
  // a saved endless game resumes exactly, also through JSON
  const a = newEndless(7);
  a.fl.x = 20; a.fl.y = 7; a.fl.a = 0;
  for (let i = 0; i < 40 * 60; i++) { update(a, NONE, 1 / 60); stepEndless(a, 1 / 60); }
  a.endless.points = 12;
  const r = deserializeEndless(JSON.parse(JSON.stringify(serializeEndless(a))));
  assert.equal(r.stacks.length, a.stacks.length);
  assert.equal(r.endless.points, 12);
  assert.deepEqual(r.endless.docks.map((o) => [o.state, o.off, (o.cargo || []).length]), a.endless.docks.map((o) => [o.state, o.off, (o.cargo || []).length]));
  assert.ok(r.endless.docks.every((o) => (o.cargo || []).every((c) => r.stacks.includes(c))), 'cargo points into the restored stacks');
  assert.equal(r.walls.length, a.walls.length);
  for (let i = 0; i < 30 * 60; i++) { update(a, NONE, 1 / 60); stepEndless(a, 1 / 60); update(r, NONE, 1 / 60); stepEndless(r, 1 / 60); }
  assert.deepEqual(r.stacks.map((q) => [q.x, q.y, q.layers]), a.stacks.map((q) => [q.x, q.y, q.layers]), 'the resumed game continues identically');
  a.status = 'over';
  assert.throws(() => deserializeEndless(serializeEndless(a)), 'a finished game is not resumable');
  console.log('endless ok');
}

{
  const g = newEndless(3);
  endEndless(g);
  assert.equal(g.status, 'over');
  assert.ok(g.endless.over, 'ending by hand marks the run over');
  const t = g.endless.elapsed;
  stepEndless(g, 1);
  assert.equal(g.endless.elapsed, t, 'a finished run no longer advances');
  console.log('end endless run ok');
}


// Endless: open-top boxes stay under a quarter of each colour.
{
  const g = newEndless(7);
  for (let i = 0; i < 4000; i++) { update(g, {}, 0.05); stepEndless(g, 0.05); }
  const e = g.endless;
  let open = 0;
  for (let c = 0; c < 5; c++) {
    assert.ok(e[`opened${c}`] / e[`spawned${c}`] < 0.25, `colour ${c} share`);
    open += e[`opened${c}`];
  }
  assert.ok(open > 0, 'endless spawns open boxes');
  console.log('endless open-top ok');
}


console.log('endless tests passed');
