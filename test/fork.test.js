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


console.log('fork tests passed');
