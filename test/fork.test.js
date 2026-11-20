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
import { liftedHf, newGame, update, addTruck, removeTruck, truckView, isGhost, ghostBetween, forkUp, forkDown, forkDownAll, stackInZone, isParked, isFinished, score, maxScore, lostBreakdown, zoneWonky, zoneDone, zonePoints, zoneLabelPos, stackZ, wonkyStack, fallView } from '../js/game.js';

import { NONE, pts, run, faceStack, flatWorld, driveUntil } from './common.js';

// Pick up from the floor (level 0), carry over a stack, merge, then split again.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0] }, { x: 14, y: 5, layers: [1, 2] }];
  const f = g.fl;
  f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
  assert.equal(g.H, 0);
  driveUntil(g, 10, 8);
  assert.ok(stackInZone(g), 'stack in fork zone');
  forkUp(g);
  assert.deepEqual(g.carried, [0]);
  assert.equal(g.H, 1);
  forkUp(g); forkUp(g);
  assert.equal(g.H, 3);
  driveUntil(g, 13.9, 12.4);
  assert.ok(Math.abs(g.stacks[0].x - 14) < 0.05, 'high carried box passes over low stack');
  forkDown(g);
  assert.equal(g.H, 2);
  assert.equal(g.carried, null, 'merged onto stack on reaching rest height');
  assert.deepEqual(g.stacks[0].layers, [1, 2, 0]);
  forkUp(g);
  assert.deepEqual(g.carried, [0]);
  assert.deepEqual(g.stacks[0].layers, [1, 2]);
  assert.equal(g.H, 3);
}

// A carried box needs at least half of it on the stack below, otherwise it falls beside the stack with maximum damage.
{
  const drop = (offset) => {
    const g = newGame(1);
    flatWorld(g);
    g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0], a: 0 }, { x: 4, y: 12, layers: [1], rots: [0], a: 0 }];
    g.carried = [1]; g.carriedRots = [0]; g.carriedPen = [{ crash: 0, sq: 0 }]; g.carriedRel = 0;
    g.stacks.pop();
    g.fl.a = 0; g.fl.x = 10 - FL.carryX + offset; g.fl.y = 5;
    g.H = 2;
    forkDown(g);
    return g;
  };
  const ok = drop(0.25);
  assert.deepEqual(ok.stacks[0].layers, [0, 1], 'mostly supported box stays on');
  assert.ok(Math.abs(ok.stacks[0].offs[1].x - 0.25) < 1e-6, 'box keeps its offset: crooked tower');
  const bad = drop(0.54);
  assert.deepEqual(bad.stacks[0].layers, [0], 'stack below untouched');
  assert.equal(bad.stacks.length, 2, 'box fell to the floor');
  assert.equal(bad.stacks[1].pen[0].crash, 50, 'maximum crash damage');
}

// A crooked tower keeps its offsets when lifted and put down.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0, 1], rots: [0, 0], a: 0, offs: [{ x: 0, y: 0 }, { x: 0.3, y: 0.1 }] }];
  g.fl.a = 0; g.fl.x = 10 - FL.carryX; g.fl.y = 5;
  forkUp(g);
  assert.deepEqual(g.carried, [0, 1]);
  assert.ok(Math.abs(g.carriedOffs[1].x - 0.3) < 1e-9 && Math.abs(g.carriedOffs[1].y - 0.1) < 1e-9);
  g.fl.a = Math.PI / 2;
  forkDown(g);
  assert.equal(g.carried, null);
  const o = g.stacks[0].offs[1];
  assert.ok(Math.abs(o.x + 0.1) < 1e-9 && Math.abs(o.y - 0.3) < 1e-9, 'offset turns with the forklift');
}

// Picking up a load off-center changes only its height; the offset turns with the truck.
{
  const g = newGame(1);
  flatWorld(g);
  Object.assign(g.fl, { x: 9, y: 5, a: Math.PI / 2 });
  const p = toWorld(g.fl, FL.carryX + 0.3, -0.2);
  g.stacks = [{ ...p, layers: [0] }];
  forkUp(g);
  assert.deepEqual(g.carried, [0]);
  const o = g.carriedOffs[0];
  assert.ok(Math.abs(o.x - 0.3) < 1e-9 && Math.abs(o.y + 0.2) < 1e-9, 'keeps depth and lateral offsets in the fork frame');
  g.fl.a = Math.PI;
  const expected = toWorld(g.fl, FL.carryX + 0.3, -0.2);
  forkDown(g);
  assert.equal(g.carried, null);
  const s = g.stacks[0];
  assert.ok(Math.hypot(s.x - expected.x, s.y - expected.y) < 1e-9, 'lands where the off-center load was carried');
}

// Lifting and immediately replacing a crooked upper box does not straighten it.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0, 1], offs: [{ x: 0, y: 0 }, { x: 0.3, y: 0.1 }] }];
  Object.assign(g.fl, { x: 10.65 - FL.carryX, y: 5.2, a: 0 });
  g.H = 1;
  forkUp(g);
  assert.deepEqual(g.carried, [1]);
  forkDown(g);
  assert.equal(g.carried, null);
  assert.equal(g.stacks.length, 1, 'lowers onto the box under the load, not under the center of the forks');
  assert.deepEqual(g.stacks[0].layers, [0, 1]);
  const o = g.stacks[0].offs[1];
  assert.ok(Math.abs(o.x - 0.3) < 1e-9 && Math.abs(o.y - 0.1) < 1e-9, 'upper box stays crooked without truck movement');
}

// Whole stack from level 0; release on the floor at level 0.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0, 1] }];
  const f = g.fl;
  f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
  driveUntil(g, 10, 8);
  forkUp(g);
  assert.deepEqual(g.carried, [0, 1]);
  assert.equal(g.H, 1);
  forkDown(g);
  assert.equal(g.H, 0);
  assert.equal(g.carried, null, 'released on reaching level 0');
  assert.deepEqual(g.stacks[0].layers, [0, 1]);
}

// Destack: tines at level 1 (above the bottom box) lift everything above it.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0, 1, 2] }];
  const f = g.fl;
  f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
  forkUp(g);
  assert.equal(g.H, 1);
  driveUntil(g, 10, 8);
  forkUp(g);
  assert.deepEqual(g.carried, [1, 2]);
  assert.deepEqual(g.stacks[0].layers, [0]);
  assert.equal(g.H, 2);
}

// Carried boxes collide with floor stacks that reach their height.
{
  const g = newGame(1);
  g.zones = [];
  g.stacks = [{ x: 9, y: 5, layers: [0, 1] }];
  const f = g.fl;
  f.x = 5; f.y = 5; f.a = 0;
  g.carried = [2];
  g.H = 1;
  run(g, { up: true }, 1.5);
  assert.deepEqual(g.stacks[0].layers, [0], 'bottom box stays');
  assert.equal(g.stacks.length, 2, 'pushed top box fell off the stack');
  assert.deepEqual(g.stacks[1].layers, [1]);
  assert.ok(g.stacks[1].x > 9.5, 'carried box pushed the top box off');
  assert.equal(g.stacks[1].pen[0].crash, 50, 'maximum damage');
}


// Carried boxes keep their orientation relative to the forklift and keep it when dropped.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0.15], a: 0.15 }];
  const f = g.fl;
  f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
  driveUntil(g, 9.7, 8);
  forkUp(g);
  assert.ok(Math.abs(g.carriedRel - 0.15) < 1e-9, 'relative angle stored');
  f.a += 0.5;
  forkDown(g);
  assert.equal(g.carried, null);
  assert.ok(Math.abs(g.stacks[0].a - 0.65) < 0.05, 'dropped with rotated orientation');
}

// Each box in a stack remembers its own rotation through lift, drop and merge.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0, 1], rots: [0.1, 0.15], a: 0.1 }];
  const f = g.fl;
  f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
  driveUntil(g, 10, 8);
  g.H = 1;
  forkUp(g);
  assert.deepEqual(g.stacks[0].rots, [0.1]);
  assert.ok(Math.abs(g.carriedRots[0] - 0.15) < 1e-9);
  forkDown(g);
  assert.equal(g.carried, null);
  assert.deepEqual(g.stacks[0].layers, [0, 1]);
  assert.ok(Math.abs(g.stacks[0].rots[0] - 0.1) < 1e-9 && Math.abs(g.stacks[0].rots[1] - 0.15) < 1e-9);
}


// Lowering empty forks through a box is blocked and damages the box under the forks.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0, 1] }];
  const f = g.fl;
  f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
  driveUntil(g, 10, 8);
  g.H = 2;
  assert.equal(forkDown(g), 'blocked');
  assert.equal(g.H, 2, 'forks stay put');
  assert.equal(g.stacks[0].pen[1].crash, 10, 'box under the forks is damaged');
  assert.equal(g.stacks[0].pen[0].crash, 0);
  assert.equal(g.hits.length, 1, 'damage popup recorded');
  assert.equal(g.hits[0].pts, 10);
  assert.equal(g.hitCount, 1);
  run(g, {}, 0.1);
  g.H = 2;
  assert.equal(forkDown(g), 'blocked');
  assert.equal(g.hits.length, 1, 'same stack damage merges into one popup');
  assert.equal(g.hits[0].pts, 20);
  run(g, {}, 2);
  assert.equal(g.hits.length, 0, 'popup expires');
  g.H = 3;
  assert.equal(forkDown(g), undefined, 'free to lower above the stack');
  assert.equal(g.H, 2);
  console.log('fork-blocked ok');
}

// Holding "lower" (forkDownAll) drops to the lowest safe level without damage.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0, 1] }];
  const f = g.fl;
  f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
  g.H = 4;
  forkDownAll(g);
  assert.equal(g.H, 0, 'empty forks away from boxes go to the floor');
  driveUntil(g, 10, 8);
  g.H = 4;
  forkDownAll(g);
  assert.equal(g.H, 2, 'stops above the box the forks cannot pass');
  assert.equal(g.hits.length, 0, 'no damage');
  assert.equal(g.stacks[0].pen?.[1]?.crash ?? 0, 0);
  g.stacks = [];
  g.H = 3;
  g.carried = [2];
  forkDownAll(g);
  assert.equal(g.H, 0, 'carried stack lowered to the floor');
  assert.equal(g.carried, null, 'and released');
  assert.equal(g.stacks.length, 1);
  console.log('fork-down-all ok');
}

// Raising a carried stack into the ceiling is blocked and damages every carried box.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0, 1] }];
  const f = g.fl;
  f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
  driveUntil(g, 10, 8);
  forkUp(g);
  assert.equal(g.carried.length, 2);
  while (g.H < 4) assert.equal(forkUp(g), undefined);
  assert.equal(forkUp(g), 'blocked');
  assert.equal(g.H, 4, 'forks stay put');
  assert.deepEqual(g.carriedPen.map((p) => p.crash), [10, 10], 'every carried box is damaged');
  assert.equal(g.hitCount, 1);
  console.log('ceiling ok');
}

// A truck can be lifted from its side; while lifted it cannot drive, and it is set down when the forks reach the floor.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [];
  const b = addTruck(g, 'Bob');
  const bob = g.trucks[b], vb = truckView(g, b);
  Object.assign(bob.fl, { x: 9, y: 5.775, a: Math.PI / 2, speed: 0 });
  Object.assign(g.fl, { x: 2, y: 5, a: 0, speed: 0 });
  g.ghostPairs = [];
  // from the front of Bob (not the side) nothing is lifted
  const sav = { ...bob.fl };
  Object.assign(bob.fl, { a: 0 });
  driveUntil(g, 7.5, 6);
  forkUp(g);
  assert.equal(g.lifting, -1, 'not from the front/back');
  forkDown(g);
  Object.assign(bob.fl, sav);
  Object.assign(g.fl, { x: 2, y: 5, a: 0, speed: 0 });
  driveUntil(g, 8.9, 7);
  forkUp(g);
  assert.equal(g.lifting, b);
  assert.equal(bob.liftedBy, g.truck.id);
  assert.equal(g.H, 1);
  bob.input = { up: true };
  const bx = bob.fl.x, by = bob.fl.y;
  run(g, { up: true }, 1);
  assert.ok(g.fl.x > 9, 'carrier drives on');
  assert.ok(Math.hypot(bob.fl.x - bx, bob.fl.y - by) > 1, 'the lifted truck is carried along');
  const c = { x: g.fl.x + Math.cos(g.fl.a) * 1.0, y: g.fl.y + Math.sin(g.fl.a) * 1.0 };
  assert.ok(Math.hypot(bob.fl.x + Math.cos(bob.fl.a) * -0.775 - c.x, bob.fl.y + Math.sin(bob.fl.a) * -0.775 - c.y) < 0.05, 'centred on the tines');
  assert.equal(forkUp(vb), undefined, 'a lifted truck cannot work the forks');
  assert.equal(vb.H, 0);
  run(g, NONE, 2);
  forkDown(g);
  assert.equal(g.lifting, -1);
  assert.equal(bob.liftedBy, -1);
  bob.input = { up: true };
  const px = bob.fl.x;
  run(g, NONE, 1);
  assert.ok(bob.fl.x !== px || bob.fl.y !== bob.fl.y || Math.abs(bob.fl.speed) > 0, 'drives again once down');
  console.log('lift truck ok');
}

// A truck can be put down on top of a stack, stays there (cannot move), and drops when the stack is gone; trucks carrying boxes can be lifted.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 12, y: 5, layers: [0, 1] }];
  const b = addTruck(g, 'Bob');
  const bob = g.trucks[b];
  g.ghostPairs = [];
  Object.assign(bob.fl, { x: 7, y: 5.775, a: Math.PI / 2, speed: 0 });
  bob.carried = [2]; bob.carriedRots = [0]; bob.carriedPen = []; bob.carriedOffs = [{ x: 0, y: 0 }]; bob.carriedRel = 0;
  Object.assign(g.fl, { x: 1, y: 5, a: 0, speed: 0 });
  driveUntil(g, 7, 5.5);
  forkUp(g);
  assert.equal(g.lifting, b, 'a truck carrying boxes can be lifted');
  assert.ok(liftedHf(truckView(g, b)) > 0);
  // drive over to the stack and put the truck down on it
  forkUp(g);
  assert.equal(g.H, 2);
  driveUntil(g, 11.9, 10);
  forkDown(g);
  assert.equal(g.lifting, -1, 'set down');
  assert.equal(bob.perchZ, 2, 'perched on the stack');
  bob.input = { up: true };
  const x = bob.fl.x, y = bob.fl.y;
  run(g, NONE, 1);
  assert.equal(bob.fl.x, x); assert.equal(bob.fl.y, y);
  g.stacks = [];
  run(g, NONE, 0.1);
  assert.equal(bob.perchZ, 0, 'falls to the floor without the stack');
  console.log('perch truck ok');
}

// Lifting a truck that carries a stack into the ceiling is refused and damages that stack.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [];
  const b = addTruck(g, 'Bob');
  const bob = g.trucks[b];
  g.ghostPairs = [];
  Object.assign(bob.fl, { x: 9, y: 5.775, a: Math.PI / 2, speed: 0 });
  bob.carried = [2, 3]; bob.carriedRots = [0, 0]; bob.carriedPen = []; bob.carriedOffs = [{ x: 0, y: 0 }, { x: 0, y: 0 }]; bob.carriedRel = 0;
  Object.assign(g.fl, { x: 2, y: 5, a: 0, speed: 0 });
  driveUntil(g, 8.9, 7);
  forkUp(g);
  assert.equal(g.lifting, b);
  while (g.H < 4) assert.equal(forkUp(g), undefined);
  assert.equal(forkUp(g), 'blocked');
  assert.equal(g.H, 4, 'lift stops');
  assert.deepEqual(bob.carriedPen.map((p) => p.crash), [10, 10], 'the carried stack is damaged');
  console.log('lift ceiling ok');
}

// Taking the stack a truck is perched on takes the truck along; putting the stack down perches it again.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 6, y: 5, layers: [0, 1] }];
  const b = addTruck(g, 'Bob');
  const bob = g.trucks[b];
  g.ghostPairs = [];
  Object.assign(bob.fl, { x: 6, y: 5.775, a: Math.PI / 2, speed: 0 });
  bob.perchZ = 2;
  Object.assign(g.fl, { x: 1, y: 5, a: 0, speed: 0 });
  driveUntil(g, 6, 4);
  forkUp(g);
  assert.deepEqual(g.carried, [0, 1], 'the stack is lifted');
  assert.equal(g.lifting, b, 'with the truck on top');
  assert.equal(bob.perchZ, 0);
  assert.equal(bob.liftedBy, g.truck.id);
  assert.ok(liftedHf(truckView(g, b)) > 2, 'rides above the carried stack');
  const x0 = bob.fl.x;
  run(g, { down: true }, 0.8);
  assert.ok(Math.abs(bob.fl.x - x0) > 0.5, 'the truck is carried along');
  run(g, NONE, 1);
  forkDown(g);
  assert.equal(g.carried, null, 'stack set down');
  assert.equal(g.lifting, -1);
  assert.equal(bob.perchZ, 2, 'the truck is perched on it again');
  console.log('lift stack with truck ok');
}


console.log('fork tests passed');
