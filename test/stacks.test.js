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

// Nudging a box slowly squares it to the forklift; it causes no damage.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 9.2, y: 5, layers: [0, 1], rots: [0.4, 0.4], pen: [{ crash: 0, sq: 0 }, { crash: 0, sq: 0 }], a: 0.4 }];
  const f = g.fl;
  f.x = 7; f.y = 5; f.a = 0; f.speed = 0;
  for (let i = 0; i < 600; i++) {
    f.speed = Math.min(f.speed + 0.01, 0.5);
    update(g, { up: true }, 1 / 120);
    if (f.speed > 0.6) f.speed = 0.5;
  }
  const s = g.stacks[0];
  assert.ok(Math.abs(s.a) < 0.01 && Math.abs(s.rots[1]) < 0.01, 'stack turned square to the forklift');
  assert.equal(s.pen[0].crash, 0, 'nudging does not damage the bottom box');
  assert.equal(s.pen[1].crash, 0, 'upper box undamaged');
  console.log('box-align ok');
}

// Boxes that topple off a stack tumble visually: the logical stack is at its landing spot at once, fallView interpolates.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0, 1], rots: [0, 0], pen: [{ crash: 0, sq: 0 }, { crash: 0, sq: 0 }], a: 0, offs: [{ x: 0, y: 0 }, { x: 0.45, y: 0 }] }];
  g.fl.x = 8; g.fl.y = 5; g.fl.a = 0; g.fl.speed = 0;
  let fallen;
  for (let i = 0; i < 600 && !fallen; i++) {
    g.fl.speed = 2;
    update(g, { up: true }, 1 / 120);
    fallen = g.stacks.find((s) => s.fall);
  }
  assert.ok(fallen, 'a box toppled');
  const v = fallView(g, fallen);
  assert.ok(v.fallZ > 0 && Math.hypot(v.x - fallen.x, v.y - fallen.y) > 0.1, 'fallen box starts away from its landing spot');
  for (let i = 0; i < 90; i++) update(g, {}, 1 / 120);
  assert.equal(fallen.fall, undefined, 'animation ends');
  assert.equal(fallView(g, fallen), fallen);
  console.log('fall-anim ok');
}

// Pushing a stack gently into a wall squares it to the wall; a hard shove snags it and spins it.
{
  const mk = () => {
    const g = newGame(1);
    flatWorld(g);
    g.walls = [{ x: 12, y: 0, w: 1, h: 20, poly: [{ x: 12, y: 0 }, { x: 13, y: 0 }, { x: 13, y: 20 }, { x: 12, y: 20 }] }];
    g.stacks = [{ x: 11, y: 5, layers: [0], rots: [0.3], pen: [{ crash: 0, sq: 0 }], a: 0.3 }];
    g.fl.x = 8.5; g.fl.y = 5; g.fl.a = 0; g.fl.speed = 0;
    return g;
  };
  const g = mk();
  for (let i = 0; i < 900; i++) {
    g.fl.speed = Math.min(g.fl.speed + 0.01, 0.4);
    update(g, { up: true }, 1 / 120);
    if (g.fl.speed > 0.5) g.fl.speed = 0.4;
  }
  assert.ok(Math.abs(g.stacks[0].a) < 0.02, 'gentle push squares the stack to the wall');
  const h = mk();
  h.stacks[0].rots = [0.15]; h.stacks[0].a = 0.15;
  for (let i = 0; i < 300; i++) {
    h.fl.speed = 3;
    update(h, { up: true }, 1 / 120);
  }
  assert.ok(Math.abs(h.stacks[0].a - 0.15) > 0.02, 'hard shove spins the stack');
  // a carried stack pressed gently against a wall squares up to it on the forks
  const c = mk();
  c.stacks = [];
  c.fl.x = 10; c.fl.a = 0.2; c.fl.speed = 0;
  c.carried = [0]; c.carriedRel = 0; c.carriedRots = [0]; c.carriedPen = [{ crash: 0, sq: 0 }]; c.carriedOffs = [{ x: 0, y: 0 }];
  for (let i = 0; i < 600; i++) {
    c.fl.speed = Math.min(c.fl.speed + 0.01, 0.4);
    update(c, { up: true }, 1 / 120);
  }
  assert.ok(Math.abs(c.fl.a + c.carriedRel) < 0.05, 'carried stack squares to the wall on the forks');
  console.log('wall-align ok');
}


// The tines only enter the slots of a pallet when roughly square to it; otherwise they hit its runners and the pallet is pushed.
{
  const g = newGame(1, 0, true);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0], a: 0 }];
  faceStack(g, 0.05);
  forkUp(g);
  assert.ok(g.carried, 'square-ish forks lift');
}

// Hard mode: the runners follow the box's local x axis, so tines can't enter from the sides (along the box tape).
{
  const g = newGame(1, 0, true);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0], a: 0 }];
  const f = g.fl;
  f.a = Math.PI / 2; f.speed = 0; f.x = 10; f.y = 2;
  for (let i = 0; i < 480; i++) update(g, { up: f.speed < 0.3 }, 1 / 120);
  assert.ok(f.y < 4.2, 'forks stop against the runners when coming in from the side');
}

// A skewed tine hitting the pallet off-centre turns it towards the forks' heading, in both directions.
{
  const turned = (deg) => {
    const g = newGame(1, 0, true);
    flatWorld(g);
    g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0], a: 0 }];
    const f = g.fl;
    f.a = deg * Math.PI / 180; f.speed = 0;
    f.x = 10 - 3 * Math.cos(f.a); f.y = 5 - 3 * Math.sin(f.a);
    for (let i = 0; i < 480; i++) update(g, { up: f.speed < 0.3 }, 1 / 120);
    return g.stacks[0].rots[0];
  };
  assert.ok(turned(20) > 0.05, 'turns towards a positive heading');
  assert.ok(turned(-20) < -0.05, 'turns towards a negative heading');
}

// Turning with the forks in a pallet glides it with the forks sideways (and turns it) without lifting it.
{
  const g = newGame(1, 0, true);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0], a: 0 }];
  faceStack(g, 0);
  g.fl.x -= 0.5 * Math.cos(0);
  for (let i = 0; i < 120; i++) { g.fl.speed = 0.8; update(g, { right: true }, 1 / 120); }
  const s = g.stacks[0];
  assert.equal(g.carried, null, 'pallet is not carried');
  assert.ok(Math.abs(g.fl.a) > 0.05, 'forklift turned');
  assert.ok(Math.abs(s.a - g.fl.a) < 1e-6, 'pallet turned with the forks');
  const l = toLocal(g.fl, s.x, s.y);
  assert.ok(Math.abs(l.y) < 1e-6, 'held sideways on the forks');
}

// Driving the forks in at too steep an angle pushes the stack instead.
{
  const run1 = (ang) => {
    const g = newGame(1, 0, true);
    flatWorld(g);
    g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0], a: 0 }];
    const f = g.fl;
    f.a = ang; f.x = 7; f.y = ang > 0.1 ? 4 : 5; f.speed = 0;
    run(g, { up: true }, 1.0);
    return g.stacks[0].x;
  };
  assert.ok(run1(0.5) > 10.2, 'skewed forks push the stack');
  assert.ok(run1(0) < 10.01, 'straight forks slide in');
}

// Turning with the forks in the middle of a stack turns only the boxes from the forks upward.
{
  const g = newGame(1, 0, true);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0, 1, 2], rots: [0, 0, 0], a: 0 }];
  faceStack(g, 0);
  g.H = 1;
  g.fl.x -= 0.5;
  for (let i = 0; i < 70; i++) { g.fl.speed = 0.8; update(g, { right: true }, 1 / 120); }
  const s = g.stacks[0];
  assert.equal(s.layers.length, 3, 'stack stays whole');
  assert.equal(s.rots[0], 0, 'bottom box does not turn');
  assert.ok(s.rots[1] > 0.05 && Math.abs(s.rots[1] - g.fl.a) < 1e-6 && s.rots[2] === s.rots[1], 'boxes from the forks up turn');
}

// Pushing a stack with the forks in a higher box only damages the boxes below the forks, unless fast.
{
  const push = (speed) => {
    const g = newGame(1, 0, true);
    flatWorld(g);
    const pen = () => ({ crash: 0, sq: 0 });
    g.stacks = [{ x: 10, y: 5, layers: [0, 1, 2], rots: [0, 0, 0], pen: [pen(), pen(), pen()], a: 0 }];
    g.H = 1;
    const f = g.fl;
    f.a = 0.5; f.x = 7; f.y = 4; f.speed = speed;
    for (let i = 0; i < 100; i++) { f.speed = speed; update(g, { up: true }, 1 / 120); if (g.stacks[0].pen.some((p) => p.crash > 0)) break; }
    return g.stacks[0].pen.map((p) => p.crash);
  };
  const slow = push(1.9), fast = push(3);
  assert.ok(slow[0] > 0 && slow[1] === 0 && slow[2] === 0, 'slow: only box below the forks');
  assert.ok(fast[1] > 0 && fast[2] > 0, 'fast: whole stack');
}

// Without hard mode, forks slide into a pallet from any angle and nothing is pushed or turned.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0], a: 0 }];
  faceStack(g, 0.3);
  forkUp(g);
  assert.ok(g.carried, 'lifts at any angle');
  const h = newGame(1);
  flatWorld(h);
  h.stacks = [{ x: 10, y: 5, layers: [0], rots: [0], a: 0 }];
  h.fl.a = 0.5; h.fl.x = 7; h.fl.y = 4;
  for (let i = 0; i < 120; i++) { h.fl.speed = 0.8; update(h, { up: true }, 1 / 120); }
  assert.equal(h.stacks[0].x, 10, 'tines pass through');
}

// Level-0 tines (beside an offset box) don't push the box on level 1 away.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0, 1], rots: [0, 0], a: 0, offs: [{ x: 0, y: 0 }, { x: 0, y: 0.4 }] }];
  g.fl.a = 0; g.fl.x = 7; g.fl.y = 5;
  for (let i = 0; i < 300; i++) { g.fl.speed = 0.8; update(g, { up: true }, 1 / 120); }
  assert.equal(g.stacks.length, 1, 'the offset box stays on its stack');
}


// Open-top boxes: only on top of a stack, never more than stacks, nothing can be put on them.
{
  let seen = 0;
  for (let n = 1; n <= 40; n++) {
    const l = generateLevel(n);
    const open = l.stacks.filter((s) => s.open);
    seen += open.length;
    assert.ok(open.length <= l.stacks.length);
    [0, 1, 2, 3, 4].forEach((c) => assert.ok(open.filter((s) => s.layers[s.layers.length - 1] === c).length <= l.zones.filter((z) => z.color === c).length, `level ${n} open boxes fit zones`));
  }
  assert.ok(seen > 0, 'some levels have open-top boxes');
  assert.ok(generateLevel(1).stacks.every((s) => !s.open), 'none on level 1');

  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0] }, { x: 14, y: 5, layers: [1, 2], open: true }].map(wonkyStack);
  assert.equal(g.stacks[1].pen[1].open, true);
  assert.equal(g.stacks[1].pen[1].deco, 4, 'do-not-stack decal');
  assert.ok(!g.stacks[1].pen[0].open);
  const f = g.fl;
  f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
  driveUntil(g, 10, 8);
  forkUp(g); forkUp(g); forkUp(g);
  driveUntil(g, 13.9, 12.4);
  forkDown(g); forkDown(g); forkDown(g);
  assert.deepEqual(g.carried, [0], 'cannot be put down on an open box');
  assert.deepEqual(g.stacks[0].layers, [1, 2]);
  assert.equal(g.H, 3);
  console.log('open-top boxes ok');
}


// Wide boxes (1×2): need both tines under them, only stack on each other, only fit wide zones.
{
  for (let n = 1; n <= 40; n++) {
    const l = generateLevel(n);
    const wide = l.stacks.filter((s) => s.wide), wz = l.zones.filter((z) => z.wide);
    assert.equal(wide.reduce((a, s) => a + s.layers.length, 0), wz.reduce((a, z) => a + z.count, 0), `level ${n} wide boxes match wide zones`);
    assert.ok(wide.every((s) => s.layers.every((c) => c === 5)) && wz.every((z) => z.color === 5), 'wide boxes and zones are gray');
    assert.equal(l.areas.filter((a) => a.color === 5).length, wz.length ? 1 : 0, 'wide zones share one area');
    if (n < 3) assert.equal(wide.length, 0);
  }
  assert.ok(generateLevel(20).stacks.some((s) => s.wide), 'later levels have wide boxes');

  const setup = (y) => {
    const g = newGame(1);
    flatWorld(g);
    g.stacks = [{ x: 10, y: 5, layers: [5], wide: true }].map(wonkyStack);
    const f = g.fl;
    f.x = 6; f.y = y; f.a = 0; f.speed = 0;
    return g;
  };
  assert.equal(setup(5).stacks[0].pen[0].wide, true);
  assert.equal(maxScore(setup(5)), 200, 'a wide box is worth two');

  const g = setup(5);
  driveUntil(g, 10, 8);
  assert.equal(stackInZone(g), g.stacks[0]);
  forkUp(g);
  assert.deepEqual(g.carried, [5], 'both tines under: lifted');
  assert.equal(g.stacks.length, 0);
  forkDown(g);
  assert.equal(g.carried, null, 'put down on the floor');
  assert.equal(g.stacks[0].pen[0].wide, true);

  const two = newGame(1);
  const z2 = { x: 10, y: 5, color: 5, count: 2, wide: true, hx: 0.6, hy: 1.1, a: 0 };
  two.zones = [z2];
  two.stacks = [{ x: 10, y: 5, layers: [5, 5], wide: true, a: 0 }].map(wonkyStack);
  assert.ok(zoneDone(two, z2) && two.stacks[0].pen.every((p) => p.wide), 'two stacked wide boxes fill a wide zone of two');
  assert.equal(maxScore(two), 400);
  two.stacks = [{ x: 10, y: 5, layers: [5], wide: true, a: 0 }].map(wonkyStack);
  assert.ok(!zoneDone(two, z2), 'one is not enough');

  const zones = [{ x: 10, y: 5, color: 5, count: 1 }, { x: 10, y: 5, color: 5, count: 1, wide: true, hx: 0.6, hy: 1.1, a: 0 }];
  const z = newGame(1);
  z.zones = zones;
  z.stacks = [{ x: 10, y: 5, layers: [5], wide: true, a: 0 }].map(wonkyStack);
  assert.ok(!zoneDone(z, zones[0]) && zoneDone(z, zones[1]), 'a wide box only fills a wide zone');
  z.stacks = [{ x: 10, y: 5, layers: [5], wide: true, a: Math.PI / 2 }].map(wonkyStack);
  assert.ok(!zoneDone(z, zones[1]), 'and only lined up with it');
  z.stacks = [{ x: 10, y: 5, layers: [5] }].map(wonkyStack);
  assert.ok(zoneDone(z, zones[0]) && !zoneDone(z, zones[1]), 'a normal box never fills a wide zone');

  const off = setup(5.9);
  driveUntil(off, 10, 8);
  assert.equal(stackInZone(off), null, 'only one tine under it: not found');
  forkUp(off);
  assert.equal(off.carried, null);

  const t2 = setup(5);
  t2.fl.a = 0.6;
  t2.fl.x = t2.stacks[0].x - Math.cos(0.6) * FL.carryX; t2.fl.y = t2.stacks[0].y - Math.sin(0.6) * FL.carryX;
  assert.equal(stackInZone(t2), t2.stacks[0]);
  assert.equal(forkUp(t2), 'blocked', 'a crooked approach does not get the tines under it');
  assert.equal(t2.carried, null);

  const h = setup(5);
  h.stacks.push(...[{ x: 14, y: 5, layers: [1] }].map(wonkyStack));
  driveUntil(h, 10, 8);
  forkUp(h);
  driveUntil(h, 13.9, 12.4);
  forkDown(h);
  assert.deepEqual(h.carried, [5], 'a wide box cannot be put down on another box');
  const w = setup(5);
  w.stacks.push(...[{ x: 14, y: 5, layers: [5], wide: true }].map(wonkyStack));
  driveUntil(w, 10, 8);
  forkUp(w);
  driveUntil(w, 13.9, 12.4);
  for (let i = 0; i < 4 && w.carried; i++) forkDown(w);
  assert.equal(w.carried, null, 'a wide box is put down on another wide box');
  assert.equal(w.stacks.length, 1);
  assert.deepEqual(w.stacks[0].layers, [5, 5]);
  assert.ok(w.stacks[0].pen.every((p) => p.wide));
  console.log('wide boxes ok');
}

console.log('stacks tests passed');
