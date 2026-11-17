import assert from 'node:assert/strict';
import { generateLevel, parseSeed, isReachable, BARREL_COLOR } from '../js/level.js';
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
import { newGame, update, addTruck, removeTruck, truckView, isGhost, ghostBetween, forkUp, forkDown, forkDownAll, stackInZone, isParked, isFinished, score, maxScore, lostBreakdown, zoneWonky, zoneDone, zonePoints, zoneLabelPos, stackZ, wonkyStack, fallView, carriedJoltZ } from '../js/game.js';

import { stackSig } from '../js/bot.js';
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

// Honking jump-scares nearby stacks (and the one on the forks): boxes hop, shift and turn a little but never leave their stack.
{
  const g = newGame(1);
  flatWorld(g);
  const pen = () => ({ crash: 0, sq: 0 });
  g.fl.x = 5; g.fl.y = 5; g.fl.a = 0; g.fl.speed = 0;
  g.stacks = [
    { x: 7, y: 5, layers: [0, 1, 2, 3, 4], rots: [0, 0, 0, 0, 0], pen: [pen(), pen(), pen(), pen(), pen()], a: 0 },
    { x: 14, y: 5, layers: [0, 1], rots: [0, 0], pen: [pen(), pen()], a: 0 },
  ];
  run(g, NONE, 0.05);
  const far = JSON.stringify(g.stacks[1]);
  for (let n = 0; n < 40; n++) {
    run(g, { horn: true }, 0.05);
    if (n === 0) assert.ok(fallView(g, g.stacks[0]).fallZ > 0, 'the stack hops');
    run(g, NONE, 0.5);
    if (n === 0) {
      const s = g.stacks[0];
      assert.ok(s.offs.some((o) => o.x !== 0 || o.y !== 0) && s.rots.some((r) => r !== 0), 'near stack shifted and turned');
    }
  }
  const s = g.stacks[0];
  assert.equal(s.layers.length, 5, 'a honk never topples a stack');
  assert.equal(g.stacks.length, 2, 'no box fell off');
  assert.ok(s.offs.every((o, j) => j === 0 || Math.hypot(o.x - s.offs[j - 1].x, o.y - s.offs[j - 1].y) <= 0.121), 'boxes stay on the one below');
  assert.equal(JSON.stringify(g.stacks[1]), far, 'distant stack untouched');

  const h = newGame(1);
  flatWorld(h);
  h.stacks = [{ x: 10, y: 5, layers: [0, 1, 2], rots: [0, 0, 0], pen: [pen(), pen(), pen()], a: 0 }];
  faceStack(h, 0);
  forkUp(h);
  const rel = h.carriedRel;
  for (let n = 0; n < 40; n++) { run(h, { horn: true }, 0.05); run(h, NONE, 0.5); }
  assert.ok(h.carriedOffs.some((o) => o.x !== 0 || o.y !== 0), 'carried boxes shifted');
  assert.equal(h.carriedRel, rel, 'carried bottom box stays square to the forks');
  assert.ok(h.carriedOffs.every((o, j) => j === 0 || Math.hypot(o.x - h.carriedOffs[j - 1].x, o.y - h.carriedOffs[j - 1].y) <= 0.121), 'carried boxes stay on the one below');
  assert.equal(h.carried.length, 3, 'still carrying all boxes');
  console.log('horn-jolt ok');
}

// Oil barrels occupy two box levels on one pallet and leak a finite supply of merging drops.
{
  const lvl = generateLevel(3);
  const layoutBarrel = lvl.stacks.find((s) => Number.isInteger(s.barrelAt));
  assert.ok(layoutBarrel, 'level 3 introduces a barrel');
  assert.equal(layoutBarrel.layers[layoutBarrel.barrelAt], BARREL_COLOR, 'barrel has its own box type');
  assert.equal(layoutBarrel.layers[layoutBarrel.barrelAt + 1], BARREL_COLOR, 'barrel occupies two layers of its own type');
  assert.deepEqual(lvl.zones.filter((z) => z.color === BARREL_COLOR).map((z) => z.count), [1], 'each two-layer barrel has a one-barrel zone');
  assert.ok(lvl.stacks.filter((s) => Number.isInteger(s.barrelAt)).length <= 4, 'barrel count is capped at four');
  assert.ok(generateLevel(12).stacks.filter((s) => Number.isInteger(s.barrelAt)).length > 1, 'later levels can spawn multiple barrels');

  const g = newGame(1);
  flatWorld(g);
  g.stacks = [wonkyStack({ x: 10, y: 5, layers: [BARREL_COLOR, BARREL_COLOR], barrelAt: 0 })];
  faceStack(g, 0);
  forkUp(g);
  assert.deepEqual(g.carried, [BARREL_COLOR, BARREL_COLOR], 'forking at the pallet lifts the whole barrel');
  const upper = newGame(1);
  flatWorld(upper);
  upper.stacks = [wonkyStack({ x: 10, y: 5, layers: [BARREL_COLOR, BARREL_COLOR], barrelAt: 0 })];
  faceStack(upper, 0);
  upper.H = 1;
  forkUp(upper);
  assert.equal(upper.carried, null, 'the upper half cannot be lifted separately');
  const zone = newGame(1);
  zone.zones = [{ x: 10, y: 5, color: BARREL_COLOR, count: 1 }];
  zone.stacks = [wonkyStack({ x: 10, y: 5, layers: [BARREL_COLOR, BARREL_COLOR], barrelAt: 0 })];
  assert.ok(zoneDone(zone, zone.zones[0]), 'a two-height barrel counts as one item in its zone');
  zone.stacks = [wonkyStack({ x: 10, y: 5, layers: [BARREL_COLOR, BARREL_COLOR, 0], barrelAt: 0 })];
  assert.ok(!zoneDone(zone, zone.zones[0]), 'barrels with a box stacked above do not fit their zone');

  const noStack = newGame(1);
  flatWorld(noStack);
  noStack.stacks = [wonkyStack({ x: 10, y: 5, layers: [BARREL_COLOR, BARREL_COLOR], barrelAt: 0 })];
  noStack.carried = [0];
  noStack.carriedRots = [0];
  noStack.carriedPen = [{ crash: 0, sq: 0, deco: 0 }];
  noStack.carriedOffs = [{ x: 0, y: 0 }];
  noStack.H = 3;
  faceStack(noStack, 0);
  forkDown(noStack);
  assert.deepEqual(noStack.stacks[0].layers, [BARREL_COLOR, BARREL_COLOR], 'boxes cannot be set down on a barrel');
  assert.deepEqual(noStack.carried, [0], 'the box remains carried above a barrel');
  const honked = newGame(1);
  flatWorld(honked);
  honked.stacks = [wonkyStack({ x: 7, y: 5, layers: [BARREL_COLOR, BARREL_COLOR], barrelAt: 0 })];
  honked.fl.x = 5; honked.fl.y = 5; honked.fl.a = 0;
  update(honked, { horn: true }, 1 / 120);
  assert.deepEqual(honked.stacks[0].offs[1], honked.stacks[0].offs[0], 'a horn cannot separate barrel halves');
  assert.equal(honked.stacks[0].rots[1], honked.stacks[0].rots[0], 'barrel halves turn together');

  const hit = newGame(1);
  flatWorld(hit);
  hit.stacks = [wonkyStack({ x: 10, y: 5, layers: [BARREL_COLOR, BARREL_COLOR], barrelAt: 0 })];
  hit.fl.x = 7; hit.fl.y = 5; hit.fl.a = 0; hit.fl.speed = 2;
  for (let i = 0; i < 180; i++) update(hit, { up: true }, 1 / 120);
  hit.fl.speed = 0;
  for (let i = 0; i < 1200 && !hit.oil.length; i++) update(hit, NONE, 1 / 120);
  assert.equal(hit.oil.length, 1, 'damaging the barrel spills oil');
  assert.ok(hit.oil[0].r < 0.2, 'the first oil puddle starts small instead of making a large splat');
  assert.ok(hit.stacks[0].pen.some((p) => p.crash > 0), 'the barrel was damaged');

  const leak = (damage) => {
    const h = newGame(1);
    flatWorld(h);
    h.fl.x = 2; h.fl.y = 2; h.fl.speed = 0;
    h.stacks = [wonkyStack({ x: 10, y: 5, layers: [BARREL_COLOR, BARREL_COLOR], barrelAt: 0 })];
    h.stacks[0].pen[0].crash = damage;
    return h;
  };
  const intact = leak(0);
  run(intact, NONE, 12);
  assert.equal(intact.oil.length, 0, 'undamaged barrels do not leak');
  const lightLeak = leak(1);
  run(lightLeak, NONE, 9);
  assert.equal(lightLeak.oil.length, 0, 'one damage point takes ten seconds to emit a drop');
  run(lightLeak, NONE, 1);
  assert.equal(lightLeak.oil[0].drops, 1, 'one damage point emits one drop per ten seconds');
  const heavyLeak = leak(50);
  run(heavyLeak, NONE, 10);
  assert.equal(heavyLeak.stacks[0].pen[0].oilDropped, 50, 'a barrel holds fifty drops');
  assert.equal(heavyLeak.oil.length, 1, 'nearby drops join into one spill');
  assert.equal(heavyLeak.oil[0].drops, 50);
  assert.ok(Math.abs(heavyLeak.oil[0].r - 1.15) < 1e-9, 'fifty drops have the original spill area');
  run(heavyLeak, NONE, 10);
  assert.equal(heavyLeak.oil[0].drops, 50, 'an empty barrel stops leaking');
  const movingLeak = leak(5);
  run(movingLeak, NONE, 2);
  const firstPuddle = movingLeak.oil[0], firstRadius = firstPuddle.r;
  movingLeak.stacks[0].x += 0.8;
  run(movingLeak, NONE, 2);
  assert.equal(movingLeak.oil.length, 2, 'moving a leaking barrel leaves another small puddle behind');
  assert.equal(firstPuddle.r, firstRadius, 'the old puddle stays at its last size');
  assert.equal(movingLeak.oil[1].drops, 1, 'the new puddle starts with one drop');
  movingLeak.stacks[0].x -= 0.6;
  run(movingLeak, NONE, 2);
  assert.equal(movingLeak.oil.length, 2, 'a nearby new drop merges with an existing puddle');
  assert.equal(movingLeak.oil.reduce((n, o) => n + o.drops, 0), 3, 'merging conserves drops');

  const slowMove = leak(5);
  for (let i = 0; i < 8; i++) {
    slowMove.stacks[0].x += 0.1;
    run(slowMove, NONE, 1);
  }
  assert.equal(slowMove.oil[0].drops, 4, 'slow movement emits drops at the same rate');
  assert.ok(slowMove.oil[0].x < slowMove.stacks[0].x, 'merged drops stay behind rather than following the barrel');
  const combined = leak(5);
  combined.stacks[0].pen[1].crash = 5;
  run(combined, NONE, 1);
  assert.equal(combined.oil[0].drops, 1, 'damage on both barrel halves contributes to the drop rate');
  const shared = leak(50);
  run(shared, NONE, 10);
  const otherBarrel = wonkyStack({ x: 11.2, y: 5, layers: [BARREL_COLOR, BARREL_COLOR], barrelAt: 0 });
  otherBarrel.pen[0].crash = 10;
  shared.stacks.push(otherBarrel);
  run(shared, NONE, 1);
  assert.equal(shared.oil.length, 1, 'nearby drops from different barrels merge');
  assert.equal(shared.oil[0].drops, 51, 'both barrels contribute oil');

  const carriedLeak = newGame(1);
  flatWorld(carriedLeak);
  carriedLeak.stacks = [wonkyStack({ x: 10, y: 5, layers: [BARREL_COLOR, BARREL_COLOR], barrelAt: 0 })];
  faceStack(carriedLeak, 0);
  carriedLeak.stacks[0].pen[0].crash = 5;
  forkUp(carriedLeak);
  run(carriedLeak, NONE, 2);
  assert.equal(carriedLeak.oil.length, 1, 'a carried damaged barrel leaks beneath itself');
  carriedLeak.fl.x += 0.8;
  run(carriedLeak, NONE, 2);
  assert.equal(carriedLeak.oil.length, 2, 'carrying the leaking barrel leaves a trail');

  const turn = (oil) => {
    const h = newGame(1);
    flatWorld(h);
    h.fl.x = 10; h.fl.y = 10; h.fl.a = 0; h.fl.speed = 2;
    if (oil) {
      for (const side of [-1, 1]) {
        const p = toWorld(h.fl, -FL.L, side * (FL.halfW - 0.08));
        h.oil.push({ id: `test:${side}`, x: p.x, y: p.y, r: 0.12 });
      }
    }
    update(h, { right: true }, 0.2);
    return { angle: h.fl.a, spin: h.fl.spin || 0, slip: h.slip };
  };
  const clean = turn(false), slick = turn(true);
  assert.ok(Math.abs(slick.spin) > Math.abs(clean.spin), 'oil on a rear tire can spin the truck');
  assert.ok(slick.slip > 0, 'oil makes the tyres slip');
  console.log('oil barrels ok');
}

// The repair station next to the parking spot repairs one single box at a time (1 damage point/s), spinning it while no truck is close.
{
  const g = newGame(1);
  const r = g.repair;
  assert.ok(r && Math.hypot(r.x - g.parking.x, r.y - g.parking.y) >= 2.4 - 1e-9, 'a pad sits near the parking spot, not on it');
  assert.ok(g.walls.filter((w) => !w.mast).some((w) => pointRectDist(r.mast.x + 0.18, r.mast.y + 0.18, w) < 0.18 + 0.36), 'the mast is on the wall side');
  assert.ok(g.walls.filter((w) => !w.mast).every((w) => pointRectDist(r.x, r.y, w) > 0.65), 'the pad is clear of walls');
  assert.ok(g.walls.some((w) => w.mast) && pointRectDist(r.x, r.y, r.mast) > 0.65, 'the film mast is a solid post beside the turntable');
  g.stacks = [{ x: r.x, y: r.y, layers: [0], rots: [0], a: 0, pen: [{ crash: 10, sq: 0, dent: { t: 1, c: [0, 0, 0, 0], s: [0, 0, 0, 0] } }], offs: [{ x: 0, y: 0 }] }];
  Object.assign(g.fl, { x: g.parking.x, y: g.parking.y, a: g.parking.a, speed: 0 }); // the truck stays in the parking spot, out of reach
  const far = { x: r.x + 12, y: r.y, a: 0, speed: 0 };
  Object.assign(g.fl, far);
  run(g, NONE, 3.01);
  assert.equal(g.stacks[0].pen[0].crash, 7, 'one damage point per second');
  assert.ok(g.stacks[0].a > 5 && g.repair.on, 'the box spins while it is repaired');
  assert.equal(g.stacks[0].pen[0].tape, 1, 'tape appears once repair has started');
  Object.assign(g.fl, { x: r.x - 1.5, y: r.y, a: 0 });
  const a = g.stacks[0].a;
  run(g, NONE, 2);
  assert.ok(g.stacks[0].pen[0].crash === 7 && g.stacks[0].a === a && !g.repair.on, 'a close truck pauses the spin and the repair');
  Object.assign(g.fl, far);
  run(g, NONE, 20);
  const pen = g.stacks[0].pen[0];
  assert.ok(pen.crash === 0 && pen.tape > 1 && !pen.dent, 'fully repaired: more tape, dents gone');
  assert.ok(Math.abs(g.stacks[0].a / (Math.PI / 2) - Math.round(g.stacks[0].a / (Math.PI / 2))) < 1e-9 && !g.repair.on, 'it stops spinning, squared up');
  g.stacks = [{ x: r.x, y: r.y, layers: [0, 1], rots: [0, 0], a: 0, pen: [{ crash: 5, sq: 0 }, { crash: 5, sq: 0 }], offs: [{ x: 0, y: 0 }, { x: 0, y: 0 }] }];
  run(g, NONE, 2);
  assert.ok(g.stacks[0].pen.every((p) => p.crash === 5) && !g.repair.on, 'a stack of several boxes is not repaired');
  console.log('repair station ok');
}

// Putting the tines into a stack that carries the inspector's "!" (photographed, still damaged or wonky, untouched) re-shows the picture the inspector took of that stack.
{
  const setup = (crash, sq = 0, photographed = true) => {
    const g = newGame(1);
    flatWorld(g);
    g.zones = [{ x: 10, y: 5, w: 1, h: 1, count: 1, color: 0 }];
    g.stacks = [{ x: 10, y: 5, layers: [0], rots: [sq ? 0.3 : 0], a: 0, pen: [{ crash, sq }], offs: [{ x: 0, y: 0 }] }]; // sq is recomputed from the angles
    if (photographed) {
      const photo = { n: 1, ok: false, layers: [0], pens: [{ crash, sq }], at: { x: 10, y: 5 } };
      Object.assign(g.inspector, { seen: ['10,5,0'], sigs: { '10,5,0': stackSig(g.stacks[0]) }, photos: { '10,5,0': photo } });
    }
    return g;
  };
  let g = setup(8, 0, false);
  faceStack(g, 0); g.fl.speed = 0;
  run(g, NONE, 0.05);
  assert.equal(g.forkPhoto, undefined, 'no picture taken: nothing to show');
  g = setup(8);
  g.fl.x = 5; g.fl.y = 5; g.fl.a = 0; g.fl.speed = 0;
  run(g, NONE, 0.05);
  assert.equal(g.forkPhoto, undefined, 'tines not in the stack yet');
  faceStack(g, 0);
  run(g, NONE, 0.05);
  assert.equal(g.forkPhoto?.photo, g.inspector.photos['10,5,0'], 'the stack picture is shown when the stack reaches the fork gauge');
  g = setup(0, 20);
  faceStack(g, 0);
  run(g, NONE, 0.05);
  assert.ok(g.forkPhoto, 'a wonky stack re-shows its picture too');
  g = setup(0);
  faceStack(g, 0);
  run(g, NONE, 0.05);
  assert.equal(g.forkPhoto, undefined, 'a perfect stack has no "!" and no popup');
  g = setup(8);
  g.stacks[0].touched = true;
  faceStack(g, 0);
  run(g, NONE, 0.05);
  assert.equal(g.forkPhoto, undefined, 'no "!" (touched since the picture): no popup');
  console.log('last picture ok');
}

console.log('stacks tests passed');
