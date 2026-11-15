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

// Rear steering: pressing right while moving forward turns the nose right and the rear swings left.
{
  const g = newGame(1);
  g.stacks = [];
  const f = g.fl;
  f.x = 10; f.y = 7; f.a = 0;
  run(g, { up: true }, 1);
  const a0 = f.a;
  run(g, { up: true, right: true }, 0.5);
  assert.ok(f.a > a0, 'turns clockwise (right)');
}

// Steering lock: full lock standing still, clamped down by speed (not by fork height).
{
  assert.equal(maxSteerFor(0, 0), FL.maxSteer, 'full lock at rest');
  assert.ok(maxSteerFor(4, 0) < maxSteerFor(0, 0), 'speed narrows the lock');
  
  const g = newGame(1);
  g.stacks = [];
  const f = g.fl;
  f.x = 10; f.y = 7; f.a = 0;
  g.H = 5;
  run(g, { up: true }, 1);
  run(g, { up: true, right: true }, 1);
  assert.ok(f.steer <= maxSteerFor(f.speed) + 1e-9, 'steer stays within the tapered lock');
  const g2 = newGame(1); g2.stacks = []; g2.H = 5;
  g2.fl.x = 10; g2.fl.y = 7; g2.fl.a = 0;
  run(g2, { right: true }, 1);
  assert.equal(g2.fl.steer, FL.maxSteer, 'raised forks keep full lock at rest');
}

// Wall collision + engine braking.
{
  const g = newGame(1);
  g.stacks = [];
  const f = g.fl;
  f.x = 5; f.y = 5; f.a = Math.PI;
  run(g, { up: true }, 6);
  assert.ok(f.x > 0 && f.x < 4, 'stopped by wall');
}


// Parking spot: forklift spawns parked; a level finishes only when solved and parked.
{
  const g = newGame(1);
  assert.ok(isParked(g), 'spawns in parking spot');
  g.stacks = [{ x: 12, y: 5, layers: [0], rots: [0], pen: [{ crash: 0, sq: 0 }], a: 0 }];
  g.zones = [{ x: 12, y: 5, color: 0, count: 1 }];
  assert.ok(isFinished(g), 'solved and parked');
  g.stacks[0].pen = [{ crash: 60, sq: 0 }];
  assert.ok(isFinished(g), 'no minimum score needed');
  g.stacks[0].pen = [{ crash: 0, sq: 0 }];
  g.fl.x += 3;
  assert.ok(!isParked(g) && !isFinished(g), 'must be parked');
  g.fl.x -= 3; g.fl.a += 1;
  assert.ok(!isParked(g), 'must be aligned');
  g.fl.a -= 1; g.fl.speed = 0;
  update(g, {}, 1 / 120);
  assert.equal(g.status, 'won');
}

// Raised forks cap top speed: empty forks (H=0) reach a higher top speed than fully raised forks (H=5).
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [];
  const f = g.fl;
  f.x = 3; f.y = 5; f.a = 0; f.speed = 0;
  run(g, { up: true }, 2.5);
  const lowSpeed = f.speed;

  const h = newGame(1);
  flatWorld(h);
  h.stacks = [];
  h.H = 5;
  const hf = h.fl;
  hf.x = 3; hf.y = 5; hf.a = 0; hf.speed = 0;
  run(h, { up: true }, 2.5);
  const highSpeed = hf.speed;

  assert.ok(highSpeed < lowSpeed, 'fully raised forks cap speed below level-0 top speed');
  assert.ok(highSpeed > 0, 'still able to move with forks raised');
}


// Gear D/R only flips after a complete stop, when about to move the other way
{
  const g = newGame(1);
  assert.equal(g.fl.gear, 'D');
  g.fl.speed = 2;
  let flipped = false;
  for (let i = 0; i < 600 && !flipped; i++) {
    update(g, { down: true }, 1 / 120);
    if (g.fl.gear === 'R') flipped = true; else assert.ok(g.fl.speed > -0.001, 'stays in D while still moving forward');
  }
  assert.ok(flipped && Math.abs(g.fl.speed) < 0.05, 'R engages at standstill');
  run(g, {}, 0.5);
  assert.equal(g.fl.gear, 'R', 'brief idle keeps R');
  run(g, { down: true }, 0.2);
  run(g, { up: true }, 2);
  assert.equal(g.fl.gear, 'D');
  console.log('gear ok');
}


// Off-centre impacts: a corner hit on a wall makes the truck pivot and skid; a square, gentle or stopped contact does not.
{
  const mk = (y) => {
    const g = newGame(1);
    g.stacks = []; g.zones = [];
    g.walls = [{ x: 10, y: -20, w: 1, h: 40, poly: rectPoly(10.5, 0, 0.5, 20) }];
    g.fl.x = 6; g.fl.y = y; g.fl.a = 0.4; g.fl.speed = 3.5;
    return g;
  };
  const g = mk(0);
  let maxSpin = 0;
  for (let i = 0; i < 120; i++) { update(g, { up: true }, 1 / 120); maxSpin = Math.max(maxSpin, Math.abs(g.fl.spin || 0)); }
  assert.ok(maxSpin > 0.3, 'angled wall hit spins the truck');
  assert.ok(Math.abs(g.fl.sx || 0) + Math.abs(g.fl.sy || 0) > 0 || g.fl.x < 10, 'truck stays outside the wall');
  const slow = mk(0); slow.fl.speed = 0.2;
  run(slow, {}, 1);
  assert.ok(!slow.fl.spin, 'gentle contact does not spin');
  run(g, {}, 6);
  assert.ok(!g.fl.spin && !g.fl.sx && !g.fl.sy, 'spin and skid die out completely after a hit');
  const aRest = g.fl.a;
  run(g, {}, 2);
  assert.equal(g.fl.a, aRest, 'a resting truck does not keep rotating');
  console.log('impact spin ok');
}

// A stack hit off-centre by a fast truck, or by another stack, turns.
{
  const g = newGame(1);
  flatWorld(g);
  g.zones = [];
  g.stacks = [{ x: 10, y: 5, layers: [0] }, { x: 10.9, y: 5.8, layers: [1] }];
  g.fl.x = 4; g.fl.y = 5.4; g.fl.a = 0; g.fl.speed = 3;
  run(g, { up: true }, 1.5);
  assert.ok(g.stacks.some((s) => Math.abs(s.a || 0) > 0.02), 'off-centre push turns a stack');
  console.log('stack spin ok');
}

// A hard hit nudges the upper boxes of a tall stack sideways, toppling the top when pushed far enough; a gentle push does not.
{
  const mk = (speed) => {
    const g = newGame(1);
    flatWorld(g);
    g.zones = [];
    g.stacks = [{ x: 10, y: 5, layers: [0, 1, 2, 3] }];
    g.fl.x = 6; g.fl.y = 5; g.fl.a = 0; g.fl.speed = speed;
    return g;
  };
  const hard = mk(4);
  run(hard, { up: true }, 1.2);
  assert.ok(hard.stacks.length > 1, 'hard crash topples the upper boxes');
  const soft = mk(0.5);
  run(soft, {}, 0.5);
  assert.equal(soft.stacks.length, 1, 'gentle bump keeps the stack standing');
  console.log('stack nudge ok');
}

// Boxes knocked off a stack land on another stack's top box when it is within stackable reach.
{
  const g = newGame(1);
  flatWorld(g);
  g.zones = [];
  g.stacks = [{ x: 10, y: 5, layers: [0, 1, 2, 3] }, { x: 11.5, y: 5, layers: [4] }];
  g.fl.x = 6; g.fl.y = 5; g.fl.a = 0; g.fl.speed = 4;
  run(g, { up: true }, 1.5);
  assert.ok(g.stacks.some((s) => s.layers.includes(4) && s.layers.length > 1), 'fallen boxes came to rest on the stack behind');
  console.log('stack landing ok');
}

// Boxes toppled off a stack never land inside or beyond a wall.
{
  const g = newGame(1);
  flatWorld(g);
  g.zones = [];
  g.walls = [{ x: 11.3, y: 0, w: 0.3, h: 12, poly: rectPoly(11.45, 6, 0.15, 6, 0) }];
  g.stacks = [{ x: 10, y: 5, layers: [0, 1, 2, 3] }];
  g.fl.x = 6; g.fl.y = 5; g.fl.a = 0; g.fl.speed = 4;
  run(g, { up: true }, 1.2);
  assert.ok(g.stacks.length > 1, 'the upper boxes toppled');
  for (const s of g.stacks) assert.ok(s.x < 11.3, 'fallen boxes stay on the near side of the wall');
  console.log('fall spot ok');
}

// A truck spawning on top of a stack passes through it until it has driven off.
{
  const g = newGame(3, 0, false);
  g.stacks.push({ x: g.fl.x, y: g.fl.y, layers: [0] });
  g.trucks[0].gone = true;
  const j = addTruck(g, 'B');
  const st = g.stacks.find((q) => q.ghost);
  assert.ok(st, 'a stack under a spawning truck is ghosted');
  const x0 = st.x, y0 = st.y;
  g.self = j;
  for (let i = 0; i < 60; i++) update(g, { up: true }, 1 / 120);
  assert.equal(st.x, x0, 'the ghost stack is not pushed');
  assert.equal(st.y, y0);
  for (let i = 0; i < 600; i++) update(g, { up: true }, 1 / 120);
  assert.ok(!g.stacks.some((q) => q.ghost?.includes(j)), 'the stack turns solid once the truck has left it');
}


console.log('physics tests passed');
