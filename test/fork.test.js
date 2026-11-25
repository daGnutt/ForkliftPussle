import assert from 'node:assert/strict';
import { generateLevel, parseSeed, isReachable } from '../js/level.js';
import { pointRectDist } from '../js/geom.js';
import { FL, MAX_H, MAX_LAYERS, toLocal, toWorld, maxSteerFor } from '../js/forklift.js';
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
import { carriedDrawH, dropLift, liftedHf, newGame, update, addTruck, removeTruck, truckView, isGhost, ghostBetween, forkUp, forkDown, stackInZone, isParked, isFinished, score, maxScore, lostBreakdown, zoneWonky, zoneDone, zonePoints, zoneLabelPos, stackZ, wonkyStack, fallView } from '../js/game.js';

import { TAP_S, crashAlert } from '../js/game.js';
import { FORK_CLEARANCE } from '../js/geom.js';
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

// In hard mode, the combined weight above a contact can tip a well-overlapped box.
{
  const drop = (topOffset) => {
    const g = newGame(1, 0, true);
    flatWorld(g);
    g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0], a: 0 }];
    g.carried = [1, 2]; g.carriedRots = [0, 0];
    g.carriedPen = [{ crash: 0, sq: 0 }, { crash: 0, sq: 0 }];
    g.carriedOffs = [{ x: 0, y: 0 }, { x: topOffset, y: 0 }];
    g.carriedRel = 0;
    Object.assign(g.fl, { x: 9.4, y: 5, a: 0 });
    g.H = 2;
    forkDown(g);
    return g;
  };
  const stable = drop(0);
  assert.deepEqual(stable.stacks[0].layers, [0, 1, 2]);
  const unstable = drop(0.4);
  assert.deepEqual(unstable.stacks[0].layers, [0], 'the unsupported group falls together');
  assert.deepEqual(unstable.stacks[1].layers, [1, 2]);
  const topFalls = drop(0.9);
  assert.deepEqual(topFalls.stacks[0].layers, [0, 1], 'an unsupported top falls before it can pull down a stable box');
  assert.deepEqual(topFalls.stacks[1].layers, [2]);
}

// A fall blocked in its preferred direction finds a legal nearby position without losing cargo.
{
  const drop = () => {
    const g = newGame(1, 0, true);
    flatWorld(g);
    g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0], a: 0 },
      { x: 11, y: 5, layers: [3], rots: [0], a: 0, pen: [{ crash: 0, sq: 0, open: true }] }];
    g.carried = [1, 2]; g.carriedRots = [0, 0];
    g.carriedPen = [{ crash: 0, sq: 0, deco: 1 }, { crash: 0, sq: 0, deco: 2 }];
    g.carriedOffs = [{ x: 0, y: 0 }, { x: 0.4, y: 0 }];
    Object.assign(g.fl, { x: 9.4, y: 5, a: 0 });
    g.H = 2;
    forkDown(g);
    return g;
  };
  const a = drop(), b = drop();
  const fallen = a.stacks.find((s) => s.layers[0] === 1);
  assert.ok(fallen && fallen.fall, 'the unsupported group lands elsewhere');
  assert.deepEqual(fallen.layers, [1, 2]);
  assert.deepEqual(fallen.pen.map((p) => p.deco), [1, 2]);
  assert.deepEqual(a.stacks.map((s) => [s.x, s.y, s.layers]), b.stacks.map((s) => [s.x, s.y, s.layers]), 'landing is deterministic');
  const box = rectPoly(fallen.x, fallen.y, 0.5, 0.5, fallen.rots[0]);
  for (const s of a.stacks.filter((s) => s !== fallen)) {
    const p = rectPoly(s.x, s.y, 0.5, 0.5, s.rots[0]);
    assert.ok(!sat(box, p), 'landing does not overlap another floor stack');
  }
}

// Falling cargo can land on a compatible neighboring stack during set-down.
{
  const g = newGame(1, 0, true);
  flatWorld(g);
  const neighbor = { x: 11.2, y: 5, layers: [3], rots: [0], a: 0 };
  g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0], a: 0 }, neighbor];
  g.carried = [1, 2]; g.carriedRots = [0, 0];
  g.carriedPen = [{ crash: 0, sq: 0, deco: 1 }, { crash: 0, sq: 0, deco: 2 }];
  g.carriedOffs = [{ x: 0, y: 0 }, { x: 0.4, y: 0 }];
  Object.assign(g.fl, { x: 9.4, y: 5, a: 0 });
  g.H = 2;
  forkDown(g);
  assert.deepEqual(neighbor.layers, [3, 1, 2]);
  assert.deepEqual(neighbor.pen.slice(1).map((p) => p.deco), [1, 2]);
  assert.equal(g.stacks.length, 2);
}

// Falling boxes cannot land on a taller stack or pass through a wall.
{
  const g = newGame(1, 0, true);
  flatWorld(g);
  const wall = { x: 11.6, y: 3.5, w: 0.2, h: 3 };
  wall.poly = rectPoly(wall.x + wall.w / 2, wall.y + wall.h / 2, wall.w / 2, wall.h / 2, 0);
  g.walls.push(wall);
  const tall = { x: 11, y: 5, layers: [3, 4], rots: [0, 0], a: 0 };
  g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0], a: 0 }, tall];
  g.carried = [1, 2]; g.carriedRots = [0, 0];
  g.carriedPen = [{ crash: 0, sq: 0 }, { crash: 0, sq: 0 }];
  g.carriedOffs = [{ x: 0, y: 0 }, { x: 0.4, y: 0 }];
  Object.assign(g.fl, { x: 9.4, y: 5, a: 0 });
  g.H = 2;
  forkDown(g);
  assert.deepEqual(tall.layers, [3, 4], 'a fall never rises onto a taller stack');
  const fallen = g.stacks.find((s) => s.layers[0] === 1);
  assert.ok(fallen?.fall);
  for (let i = 0; i < fallen.layers.length; i++) {
    const p = rectPoly(fallen.x + fallen.offs[i].x, fallen.y + fallen.offs[i].y, 0.5, 0.5, fallen.rots[i]);
    assert.ok(!sat(p, wall.poly));
    assert.ok(p.every((v) => v.x <= wall.x), 'the wall is not crossed');
  }
}

// When every reachable landing is blocked, the group stays in place without losing cargo.
{
  const g = newGame(1, 0, true);
  flatWorld(g);
  g.walls = [
    { x: 11.31, y: 3, w: 0.2, h: 4 }, { x: 8.5, y: 3, w: 0.2, h: 4 },
    { x: 8.5, y: 3.5, w: 3, h: 0.2 }, { x: 8.5, y: 6.3, w: 3, h: 0.2 },
  ].map((w) => ({ ...w, poly: rectPoly(w.x + w.w / 2, w.y + w.h / 2, w.w / 2, w.h / 2) }));
  g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0], a: 0 }];
  g.carried = [1, 2]; g.carriedRots = [0, 0];
  g.carriedPen = [{ crash: 0, sq: 0 }, { crash: 0, sq: 0 }];
  g.carriedOffs = [{ x: 0, y: 0 }, { x: 0.4, y: 0 }];
  Object.assign(g.fl, { x: 9.4, y: 5, a: 0 });
  g.H = 2;
  forkDown(g);
  assert.deepEqual(g.stacks[0].layers, [0, 1, 2]);
  assert.equal(g.stacks.length, 1);
  assert.ok(g.stacks[0].pen.every((p) => p.crash === 0), 'no fall means no fall damage');
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
  while (g.H < MAX_H - 1) assert.equal(forkUp(g), undefined);
  assert.equal(forkUp(g), 'blocked');
  assert.equal(g.H, MAX_H - 1, 'forks stay put');
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
  while (g.H < MAX_H - 1) assert.equal(forkUp(g), undefined);
  assert.equal(forkUp(g), 'blocked');
  assert.equal(g.H, MAX_H - 1, 'lift stops');
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


// Hard mode: a tapped fork key moves one level, a held one moves the forks fluidly and leaves them between levels.
{
  const hardGame = () => {
    const g = newGame(1, 1, true);
    flatWorld(g);
    g.stacks = [];
    g.fl.x = 6; g.fl.y = 5; g.fl.a = 0; g.fl.speed = 0;
    return g;
  };
  const g = hardGame();
  assert.ok(g.hard);
  run(g, { forkUp: true }, 0.1); run(g, {}, 0.05);
  assert.equal(g.hy, 1, 'tap: next level');
  run(g, { forkUp: true }, TAP_S + 0.5); run(g, {}, 0.05);
  assert.ok(Math.abs(g.hy - 1.5) < 0.02, `hold: fluid (hy ${g.hy})`);
  assert.equal(g.H, 1);
  run(g, { forkDown: true }, 0.1); run(g, {}, 0.05);
  assert.equal(g.hy, 1, 'tap down from between levels: the level below');
  run(g, { forkUp: true }, TAP_S + 0.5); run(g, {}, 0.05);
  run(g, { forkUp: true }, 0.1); run(g, {}, 0.05);
  assert.equal(g.hy, 2, 'tap up from between levels: the level above');
  run(g, { forkDown: true }, TAP_S + 0.9); run(g, {}, 0.05);
  assert.ok(g.hy > 1 && g.hy < 1.2, `hold down lowers fluidly (hy ${g.hy})`);

  const fast = hardGame();
  const slow = hardGame();
  run(slow, { forkUp: true }, 0.1); run(slow, {}, 0.05);
  run(fast, { up: true }, 1); run(slow, { up: true }, 1);
  assert.ok(fast.fl.speed > slow.fl.speed, 'raised forks slow the truck down');
  const hover = hardGame();
  hover.hy = 0.1; hover.H = 0;
  run(hover, { up: true }, 1);
  const lowSpeed = hover.fl.speed;
  const floor = hardGame();
  run(floor, { up: true }, 1);
  assert.ok(lowSpeed > floor.fl.speed * 0.95, 'barely raised forks cost almost no speed');
  console.log('fork fluid height ok');
}

// Both tines must be under a pallet before it can be lifted in hard mode.
{
  const game = (hard, y) => {
    const g = newGame(1, 0, hard);
    flatWorld(g);
    g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0], a: 0 }];
    Object.assign(g.fl, { x: 9, y, a: 0, speed: 0 });
    return g;
  };
  const oneTine = game(true, 5.4);
  assert.equal(forkUp(oneTine), 'blocked');
  assert.equal(oneTine.carried, null);
  const both = game(true, 5);
  forkUp(both);
  assert.deepEqual(both.carried, [0]);
  const easy = game(false, 5.4);
  forkUp(easy);
  assert.deepEqual(easy.carried, [0], 'easy mode retains its permissive pickup');
}

// Large hard-mode updates cross the same fork boundaries as fixed simulation steps.
{
  const make = () => {
    const g = newGame(1, 0, true);
    flatWorld(g);
    g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0], a: 0 }];
    Object.assign(g.fl, { x: 9, y: 5, a: 0, speed: 0 });
    return g;
  };
  const long = make(), fixed = make();
  update(long, { forkUp: true }, 0.4);
  run(fixed, { forkUp: true }, 0.4);
  assert.deepEqual(long.carried, fixed.carried);
  assert.ok(Math.abs(long.hy - fixed.hy) < 1e-9);
  assert.equal(long.fk.ev.n, fixed.fk.ev.n);
}

// Hard mode: forks move through the pallet clearance before lifting its load.
{
  const g = newGame(1, 1, true);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0, 1] }];
  g.fl.x = 6; g.fl.y = 5; g.fl.a = 0; g.fl.speed = 0;
  driveUntil(g, 10, 8);
  run(g, { forkUp: true }, TAP_S + 0.025);
  assert.equal(g.carried, null, 'the box stays on the floor while the forks are in the clearance');
  run(g, { forkUp: true }, 0.15);
  assert.deepEqual(g.carried, [0, 1], 'the box is picked up when the forks reach the deck');
  run(g, {}, 0.05);
  const lifted = g.hy;
  assert.ok(lifted > 0 && lifted < 0.4, `carried between levels (hy ${lifted})`);
  assert.ok(Math.abs(carriedDrawH(g) - (g.hf - FORK_CLEARANCE)) < 1e-6, 'the pallet deck rests on the tines');
  run(g, { forkUp: true }, TAP_S + 1); run(g, {}, 0.05);
  assert.equal(g.carried.length, 2);
  assert.ok(g.hy > 1, 'keeps rising');
  run(g, { forkDown: true }, 3);
  assert.equal(g.carried, null, 'lowered to the floor: set down');
  assert.equal(g.stacks.length, 1);
  assert.equal(g.stacks[0].layers.length, 2);
  assert.ok(Math.abs(g.hy - FORK_CLEARANCE) < 1e-6, 'empty forks remain at deck contact after fluid set-down');
  assert.equal(g.hits.length, 0, 'holding down after the set-down does not damage it');
  console.log('fork fluid pickup ok');
}

// Hard mode: visual pickup and release remain continuous at the floor and on a stack.
{
  for (const n of [0, 1]) {
    const g = newGame(1, 1, true);
    flatWorld(g);
    g.stacks = [{ x: 10, y: 5, layers: n ? [1, 0] : [0], a: 0 }];
    faceStack(g, 0);
    g.H = g.hy = g.hf = n;
    const height = () => {
      if (g.carried) return carriedDrawH(g);
      return n + dropLift(g, g.stacks[0]);
    };
    const dt = 1 / 120;
    let before = height(), picked = false, released = false;
    for (let i = 0; i < 100 && !picked; i++) {
      const tineBefore = g.hf, hyBefore = g.hy;
      update(g, { forkUp: true }, dt);
      const next = height();
      assert.ok(Math.abs(next - before) <= dt + 1e-6, 'pickup advances without a visual jump');
      assert.ok(Math.abs(g.hf - tineBefore) <= 6 * dt + 1e-6, 'pickup does not move the tines abruptly');
      picked = !!g.carried;
      if (picked) assert.ok(Math.abs(g.hy - hyBefore - dt) < 1e-6, 'physical tine height remains continuous at pickup');
      before = next;
    }
    assert.ok(picked, 'the box is picked up after the forks reach the deck');
    run(g, { forkUp: true }, 0.5);
    run(g, {}, 0.05);
    assert.ok(Math.abs(carriedDrawH(g) - (g.hf - FORK_CLEARANCE)) < 1e-6, 'pallet deck stays aligned with the tines');
    before = height();
    for (let i = 0; i < 200 && !released; i++) {
      const tineBefore = g.hf;
      update(g, { forkDown: true }, dt);
      const next = height();
      assert.ok(Math.abs(next - before) <= 6 * dt + 1e-6, 'set-down advances without a visual jump');
      assert.ok(next >= n - 1e-6, 'load never clips through its support');
      assert.ok(Math.abs(g.hf - tineBefore) <= 6 * dt + 1e-6, 'release does not move the tines abruptly');
      released = !g.carried;
      if (released) assert.ok(Math.abs(g.hy - n - FORK_CLEARANCE) < 1e-6, 'tines remain at the pallet deck at set-down');
      before = next;
    }
    assert.ok(released, 'logical set-down still occurs');
    run(g, {}, 0.5);
    assert.ok(Math.abs(height() - n) < 1e-6, 'load settles on its support');
  }
}

// Holding down leaves the released pallet on the floor or its support, without the tines pushing it away.
{
  for (const n of [0, 1]) {
    const g = newGame(1, 1, true);
    flatWorld(g);
    g.stacks = n ? [{ x: 10, y: 5, layers: [1], a: 0 }] : [];
    Object.assign(g.fl, { x: 10 - FL.carryX, y: 5, a: 0, speed: 0 });
    g.carried = [0]; g.carriedRots = [0]; g.carriedPen = [{}]; g.carriedOffs = [{ x: 0, y: 0 }];
    g.H = n + 1; g.hy = g.hf = g.H + FORK_CLEARANCE;
    run(g, { forkDown: true }, 2);
    assert.equal(g.carried, null);
    assert.equal(g.stacks.length, 1);
    assert.deepEqual(g.stacks[0].layers, n ? [1, 0] : [0]);
    assert.ok(Math.hypot(g.fl.x - (10 - FL.carryX), g.fl.y - 5) < 1e-6, 'stationary truck is not shoved away');
    const s = g.stacks[0], off = s.offs[n];
    assert.ok(Math.hypot(s.x + off.x - 10, s.y + off.y - 5) < 1e-6, 'released box stays in place');
    assert.equal(g.hits.length, 0, 'the tines do not damage the released box');
    run(g, {}, 0.1);
    run(g, { down: true }, 0.8);
    assert.ok(g.fl.x < 10 - FL.carryX - 0.1, 'forks can back out');
    assert.ok(Math.hypot(s.x + off.x - 10, s.y + off.y - 5) < 1e-6, 'the box remains after backing out');
  }
}

// Quickly lifting from a stack must wait for the smoothed forks to reach the pickup level.
{
  const g = newGame(1, 1, true);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [1, 0], a: 0 }];
  faceStack(g, 0);
  g.H = g.hy = 1;
  g.hf = 0;
  forkUp(g);
  assert.ok(g.carried);
  assert.equal(carriedDrawH(g), 1, 'the box stays on its support while the forks catch up');
  run(g, {}, 0.4);
  assert.equal(g.carriedRest, 0, 'the pickup clamp is temporary');
  assert.ok(Math.abs(carriedDrawH(g) - (g.hf - FORK_CLEARANCE)) < 1e-6, 'the pallet deck then stays aligned with the tines');
}

// Easy-mode taps keep their original box heights while the tines take up the clearance.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0], a: 0 }];
  faceStack(g, 0);
  forkUp(g);
  let prev = carriedDrawH(g);
  for (let i = 0; i < 60; i++) {
    update(g, {}, 1 / 120);
    const height = carriedDrawH(g);
    assert.ok(Math.abs(height - prev) <= 0.05 + 1e-6, 'easy-mode pickup is continuous');
    prev = height;
  }
  assert.ok(Math.abs(carriedDrawH(g) - 1) < 1e-6, 'tap still raises the box one level');
  forkDown(g);
  assert.equal(g.carried, null);
  assert.ok(Math.abs(dropLift(g, g.stacks[0]) - prev) < 1e-6, 'release preserves the box height');
  run(g, {}, 0.5);
  assert.equal(dropLift(g, g.stacks[0]), 0, 'box reaches the floor');
}

// Forks can slide in and out within the slot, but a lifted load stays attached.
{
  const g = newGame(1, 1, true);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0], a: 0 }];
  Object.assign(g.fl, { x: 6, y: 5, a: 0, speed: 0 });
  g.hy = g.hf = FORK_CLEARANCE / 2;
  driveUntil(g, 10, 8);
  assert.equal(g.carried, null);
  assert.ok(stackInZone(g), 'forks within the clearance enter the pallet without lifting it');
  assert.equal(dropLift(g, g.stacks[0]), 0, 'entering does not raise the box visually');
  const before = g.fl.x;
  run(g, { down: true }, 1);
  assert.ok(g.fl.x < before - 0.1, 'truck backed away');
  assert.equal(g.carried, null);
  assert.equal(g.stacks.length, 1, 'the resting box stays behind');

  faceStack(g, 0);
  g.fl.speed = 0;
  run(g, { forkUp: true }, TAP_S + 0.15);
  assert.ok(g.carried, 'raising past the clearance carries the box');
  run(g, {}, 0.05);
  const liftedAt = g.fl.x;
  run(g, { down: true }, 1);
  assert.ok(g.fl.x < liftedAt - 0.1, 'truck backed away with the lifted box');
  assert.ok(g.carried, 'the lifted box cannot be left behind');
  assert.equal(g.stacks.length, 0);
  run(g, { forkDown: true }, TAP_S + 0.4);
  assert.equal(g.carried, null, 'box is released when lowered to the floor');
  assert.ok(Math.abs(g.hy - FORK_CLEARANCE) < 1e-6, 'the tines remain inside the pallet after set-down');

  const raised = newGame(1, 1, true);
  flatWorld(raised);
  raised.stacks = [{ x: 10, y: 5, layers: [0], a: 0 }];
  Object.assign(raised.fl, { x: 6, y: 5, a: 0, speed: 0 });
  raised.hy = raised.hf = FORK_CLEARANCE + 0.01;
  run(raised, { up: true }, 2);
  assert.ok(!stackInZone(raised), 'forks above the slot clearance hit the box');
}

// Hard-mode load height 1 clears a one-box stack; a load below it still hits.
{
  for (const height of [0.9, 1]) {
    const g = newGame(1, 1, true);
    flatWorld(g);
    g.stacks = [{ x: 10, y: 5, layers: [1], a: 0 }];
    Object.assign(g.fl, { x: 6, y: 5, a: 0, speed: 0 });
    g.carried = [0]; g.carriedRots = [0]; g.carriedPen = [{}]; g.carriedOffs = [{ x: 0, y: 0 }];
    g.H = Math.floor(height); g.hy = g.hf = height + FORK_CLEARANCE;
    for (let i = 0; i < 600 && g.fl.x + FL.carryX < 9.7 && g.stacks[0].x < 10.1; i++) update(g, { up: true }, 1 / 120);
    if (height === 1) {
      assert.ok(g.fl.x + FL.carryX >= 9.7, 'level 1 reaches over the stack');
      assert.ok(Math.abs(g.stacks[0].x - 10) < 1e-6, 'the stack is not pushed');
      assert.ok(Math.abs(carriedDrawH(g) - 1) < 1e-6, 'the load is visually above the stack');
    } else {
      assert.ok(g.stacks[0].x > 10.1, 'a load below level 1 pushes the stack');
    }
  }
}

// A hard-mode tap lifts to level 1, drives over a one-box stack, and sets down on it.
{
  const g = newGame(1, 1, true);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0], a: 0 }, { x: 14, y: 5, layers: [1], a: 0 }];
  faceStack(g, 0);
  run(g, { forkUp: true }, 0.1); run(g, {}, 0.5);
  assert.ok(Math.abs(g.hy - 1 - FORK_CLEARANCE) < 1e-6);
  assert.deepEqual(g.carried, [0]);
  assert.ok(Math.abs(carriedDrawH(g) - 1) < 1e-6, 'load and height indicator agree');
  for (let i = 0; i < 1200 && g.fl.x + FL.carryX < 14; i++)
    update(g, { up: g.fl.speed <= 1 || g.fl.x <= 12.4, down: g.fl.speed > 1 && g.fl.x > 12.4 }, 1 / 120);
  assert.ok(g.fl.x + FL.carryX >= 14, 'the load reaches the stack');
  g.fl.speed = 0;
  assert.ok(Math.abs(g.stacks[0].x - 14) < 0.05, 'the stack stays in place');
  run(g, { forkDown: true }, 0.1); run(g, {}, 0.5);
  assert.equal(g.carried, null);
  assert.deepEqual(g.stacks[0].layers, [1, 0]);
}

// Hard mode: standing still less than a level above a stack after lowering flashes the proximity alert, and a tap sets the load down on it.
{
  const g = newGame(1, 1, true);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0] }];
  g.fl.x = 6; g.fl.y = 5; g.fl.a = 0; g.fl.speed = 0;
  g.carried = [1];
  g.carriedRots = [0]; g.carriedPen = []; g.carriedOffs = [{ x: 0, y: 0 }];
  g.H = 3; g.hy = 3 + FORK_CLEARANCE;
  const at = (x) => { g.fl.x = x - FL.carryX; };
  at(10);
  run(g, {}, 0.1);
  assert.ok(!crashAlert(g), 'high above: no alert');
  run(g, { forkDown: true }, TAP_S + 1.5);
  assert.ok(g.hy > 1 && g.hy < 1.9, `hovering above the stack (hy ${g.hy})`);
  run(g, {}, 0.05);
  assert.ok(crashAlert(g), 'alert while standing still within a level above a box');
  g.fl.speed = 2;
  assert.ok(!crashAlert(g) || g.fl.speed > 0, 'alert is for standing still');
  g.fl.speed = 0;
  run(g, { forkDown: true }, 0.1); run(g, {}, 0.05);
  assert.equal(g.carried, null, 'a tap sets it down on the stack underneath');
  assert.equal(g.stacks[0].layers.length, 2);
  console.log('fork hover alert ok');
}

// The fork lifts to MAX_H and a floor stack of MAX_LAYERS boxes is lifted whole.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: Array.from({ length: MAX_LAYERS }, (_, i) => i % 4) }];
  Object.assign(g.fl, { x: 6, y: 5, a: 0, speed: 0 });
  driveUntil(g, 10, 8);
  forkUp(g);
  assert.equal(g.carried.length, MAX_LAYERS, 'a full-height stack is lifted whole');
  assert.equal(forkUp(g), 'blocked', 'a full-height stack cannot go up into the ceiling');
  assert.equal(g.H, 1, 'it stays lifted at level 1 (full stack plus H < ceiling)');
  console.log('fork max height ok');
}

console.log('fork tests passed');
