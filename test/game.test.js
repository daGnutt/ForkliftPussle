import assert from 'node:assert/strict';
import { generateLevel, parseSeed, isReachable } from '../js/level.js';
import { pointRectDist } from '../js/geom.js';
import { FL, toLocal, toWorld, maxSteerFor } from '../js/forklift.js';
import { reverseLight, REV_RADIUS } from '../js/revlight.js';
import { serializeGame, deserializeGame, encodeState, decodeState, serializeEndless, deserializeEndless } from '../js/savestate.js';
import { povCamera, overviewCamera, chaseCamera, chaseTiles, chaseZoom, clearChaseTilt, groundFootprint, CHASE_TILT } from '../js/gl/camera.js';
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
import { newEndless, stepEndless, endEndless, rampDecals, numberRects, dockWaits, truckGeom, unloadRate, interval, endlessScore } from '../js/endless.js';
import { newGame, update, addTruck, removeTruck, truckView, isGhost, ghostBetween, forkUp, forkDown, stackInZone, isParked, isFinished, score, maxScore, lostBreakdown, zoneWonky, zonePoints, zoneLabelPos, stackZ } from '../js/game.js';

const NONE = {};
const pts = (g) => maxScore(g) - lostBreakdown(g).crash - lostBreakdown(g).square;
const run = (g, inp, secs) => { for (let i = 0; i < secs * 120; i++) update(g, inp, 1 / 120); };

// Every colour's zones sit together in one area, clear of other areas.
for (let n = 1; n <= 40; n++) {
  const l = generateLevel(n);
  for (const a of l.areas) {
    for (const z of l.zones.filter((z) => z.color === a.color)) {
      assert.ok(z.x - 0.6 >= a.x - 1e-9 && z.x + 0.6 <= a.x + a.w + 1e-9, `level ${n} zone x in area`);
      assert.ok(z.y - 0.6 >= a.y - 1e-9 && z.y + 0.6 <= a.y + a.h + 1e-9, `level ${n} zone y in area`);
    }
  }
  assert.equal(new Set(l.zones.map((z) => z.color)).size, l.areas.length, `level ${n} one area per colour`);
}

// Generator: counts match, nothing overlaps walls, deterministic.
for (let n = 1; n <= 40; n++) {
  const l = generateLevel(n);
  const boxes = l.stacks.flatMap((s) => s.layers);
  const zoneBoxes = l.zones.reduce((a, z) => a + z.count, 0);
  assert.equal(boxes.length, zoneBoxes, `level ${n} box count`);
  for (const s of l.stacks) {
    assert.ok(s.layers.length >= 1 && s.layers.length <= 5);
    assert.ok(s.x > 1 && s.x < l.w - 1 && s.y > 1 && s.y < l.h - 1);
  }
  assert.deepEqual(generateLevel(n), l, 'deterministic');
}

// Rooms and corridors: from the start, every stack and zone is reachable for a forklift-wide path.
for (let n = 1; n <= 40; n++) {
  const l = generateLevel(n);
  const R = 0.5, W = Math.round(l.w / R), H = Math.round(l.h / R);
  const blocked = (x, y) => x < 0.55 || y < 0.55 || x > l.w - 0.55 || y > l.h - 0.55 ||
    l.walls.some((r) => x > r.x - 0.55 && x < r.x + r.w + 0.55 && y > r.y - 0.55 && y < r.y + r.h + 0.55);
  const key = (i, j) => i + ',' + j;
  const q = [[Math.floor(l.start.x / R), Math.floor(l.start.y / R)]];
  const seen = new Set([key(...q[0])]);
  while (q.length) {
    const [i, j] = q.pop();
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = i + a, y = j + b;
      if (x < 0 || y < 0 || x >= W || y >= H || seen.has(key(x, y)) || blocked(x * R, y * R)) continue;
      seen.add(key(x, y));
      q.push([x, y]);
    }
  }
  for (const o of [...l.stacks, ...l.zones]) {
    assert.ok(seen.has(key(Math.floor(o.x / R), Math.floor(o.y / R))), `level ${n} item reachable`);
  }
}

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

// Turn the forklift to ang and place it so the stack at (10, 5) sits on the forks.
const faceStack = (g, ang) => {
  g.stacks[0].x = 10; g.stacks[0].y = 5;
  g.fl.a = ang;
  g.fl.x = 10 - FL.carryX * Math.cos(ang);
  g.fl.y = 5 - FL.carryX * Math.sin(ang);
};
const flatWorld = (g) => { g.zones = []; g.walls = g.walls.slice(0, 4); };
const driveUntil = (g, x, brakeAt) => {
  const f = g.fl;
  while (f.x + FL.carryX < x) update(g, { up: f.speed <= 1 || f.x <= brakeAt, down: f.speed > 1 && f.x > brakeAt }, 1 / 120);
  while (f.speed > 0.05) update(g, { down: true }, 1 / 120);
  run(g, {}, 0.5);
};

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

// Damage to a loose stack lowers the score right away (negative before anything is on a drop point).
{
  const g = newGame(1);
  assert.equal(score(g), 0);
  g.stacks[0].pen[0].crash = 30;
  assert.equal(score(g), -30, 'damage shows before the stack is dropped');
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

// Scoring: starts at full points, crashes cost up to 50 per box, crooked placement costs up to 50.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 8, y: 5, layers: [0] }];
  const f = g.fl;
  f.x = 5; f.y = 5; f.a = 0; f.speed = 0;
  assert.equal(pts(g), 100);
  run(g, { up: true }, 3);
  assert.ok(pts(g) < 100 && pts(g) >= 50, 'crash costs points but not below 50');
  for (let i = 0; i < 20; i++) { g.clock += 1; g.fl.speed = 4; run(g, { up: true }, 0.01); }
  assert.ok(pts(g) >= 50, 'crash loss capped at 50 per box');
}
{
  const g = newGame(1);
  flatWorld(g);
  g.zones = [{ x: 10, y: 5, color: 0, count: 1 }];
  g.stacks = [{ x: 10, y: 5, layers: [0], rots: [Math.PI / 4], a: Math.PI / 4 }];
  const f = g.fl;
  f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
  driveUntil(g, 10, 8);
  faceStack(g, Math.PI / 4);
  forkUp(g);
  const before = pts(g);
  forkDown(g);
  assert.ok(before - pts(g) > 0 && pts(g) <= 100 - 30, 'diagonal box loses ~50 for squareness');
  g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0], a: 0 }];
  assert.equal(pts(g), 100, 'square box keeps full points');
}

// Re-placing a crooked box squarely recovers its squareness points.
{
  const g = newGame(1);
  flatWorld(g);
  g.zones = [{ x: 10, y: 5, color: 0, count: 1 }];
  g.stacks = [{ x: 10, y: 5, layers: [0], rots: [Math.PI / 4], a: Math.PI / 4 }];
  const f = g.fl;
  f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
  driveUntil(g, 10, 8);
  faceStack(g, Math.PI / 4);
  forkUp(g);
  forkDown(g);
  assert.ok(pts(g) <= 70, 'crooked placement');
  forkUp(g);
  f.a -= Math.PI / 4;
  forkDown(g);
  assert.equal(lostBreakdown(g).square, 0, 're-placed square recovers points');
}

// Small angle errors are free and deductions come in steps of 5.
{
  const place = (ang) => {
    const g = newGame(1);
    flatWorld(g);
    g.zones = [{ x: 10, y: 5, color: 0, count: 1 }];
    g.stacks = [{ x: 10, y: 5, layers: [0], rots: [ang], a: ang }];
    const f = g.fl;
    f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
    driveUntil(g, 10, 8);
    faceStack(g, ang);
    forkUp(g);
    forkDown(g);
    return lostBreakdown(g).square;
  };
  assert.equal(place(0.05), 0, 'within allowance');
  for (const a of [0.2, 0.4, 0.6, 0.78]) assert.equal(place(a) % 5, 0, 'multiple of 5');
  assert.ok(place(0.4) > 0 && place(0.4) < place(0.78));
}

// Boxes only score once their stack sits in its correct zone.
{
  const g = newGame(1);
  flatWorld(g);
  g.zones = [{ x: 12, y: 5, color: 0, count: 1 }];
  g.stacks = [{ x: 8, y: 5, layers: [0] }];
  assert.equal(score(g), 0, 'not in zone yet');
  g.stacks[0].x = 12;
  assert.equal(score(g), 100, 'in zone');
  g.stacks[0].pen = [{ crash: 15, sq: 0 }];
  assert.equal(score(g), 85);
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

console.log('all tests passed');

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
  while (g.H < 4) assert.equal(forkUp(g), undefined);
  assert.equal(forkUp(g), 'blocked');
  assert.equal(g.H, 4, 'forks stay put');
  assert.deepEqual(g.carriedPen.map((p) => p.crash), [10, 10], 'every carried box is damaged');
  assert.equal(g.hitCount, 1);
  console.log('ceiling ok');
}

// seeds: deterministic, differ from default, 0 = default
{
  assert.deepEqual(generateLevel(3, 42), generateLevel(3, 42), 'seeded level deterministic');
  assert.deepEqual(generateLevel(3, 0), generateLevel(3), 'seed 0 is default');
  assert.notDeepEqual(generateLevel(3, 42).stacks, generateLevel(3).stacks, 'seed changes layout');
  assert.equal(parseSeed('42'), 42);
  assert.equal(parseSeed('abc'), parseSeed('abc'));
  assert.equal(newGame(2, 7).seed, 7);
}

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

// high scores
{
  const { getBest, beats, saveBest, finalScore, formatTime } = await import('../js/highscores.js');
  assert.deepEqual([0, 59.9, 60, 3599, 3600, 7500, 359999, 360000].map(formatTime), ['0s', '59s', '1m 00s', '59m 59s', '1h 00m', '2h 05m', '99h 59m', '100+ h']);
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(getBest(store, 5, 1), null);
  assert.ok(beats({ score: 1, time: 9 }, null));
  saveBest(store, 5, 1, { score: 500, time: 30.4, name: 'Ann' });
  assert.deepEqual(getBest(store, 5, 1), { score: 500, time: 30, name: 'Ann' });
  assert.equal(getBest(store, 6, 1), null);
  assert.equal(getBest(store, 5, 2), null);
  assert.ok(!beats({ score: 400, time: 1 }, getBest(store, 5, 1)));
  assert.ok(beats({ score: 500, time: 20 }, getBest(store, 5, 1)));
  assert.ok(!beats({ score: 500, time: 40 }, getBest(store, 5, 1)));
  assert.equal(finalScore(500, 9.9), 500);
  assert.equal(finalScore(500, 100), 490);
  assert.equal(finalScore(5, 1000), 0);
  const { getTop, addTop } = await import('../js/highscores.js');
  assert.deepEqual(getTop(store, 5, 1).map((e) => e.name), ['Ann'], 'legacy best seeds the list');
  for (let i = 0; i < 12; i++) addTop(store, 5, 1, { score: 100 + i, time: 5, name: `P${i}` });
  const top = getTop(store, 5, 1);
  assert.equal(top.length, 10);
  assert.equal(top[0].name, 'Ann');
  assert.equal(top[9].score, 103);
  assert.ok(!addTop(store, 5, 1, { score: 1, time: 1, name: 'Low' }), 'too low for top 10');
  assert.deepEqual(getTop(store, 5, 2), []);
  const { lowestUnscored } = await import('../js/highscores.js');
  const st2 = { d: {}, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = v; } };
  assert.strictEqual(lowestUnscored(st2, 5), 1);
  saveBest(st2, 5, 1, { score: 10, time: 5, name: 'a' });
  saveBest(st2, 5, 3, { score: 10, time: 5, name: 'a' });
  saveBest(st2, 6, 2, { score: 10, time: 5, name: 'a' });
  assert.strictEqual(lowestUnscored(st2, 5), 2);
  assert.strictEqual(lowestUnscored(st2, 6), 1);
  const { unsynced, markSynced } = await import('../js/highscores.js');
  const { syncScores } = await import('../js/globalscores.js');
  const st3 = { d: {}, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = v; } };
  saveBest(st3, 7, 1, { score: 10, time: 5, name: 'a' });
  saveBest(st3, 7, 2, { score: 20, time: 6, name: 'b' });
  assert.deepEqual(unsynced(st3).map((u) => [u.board, u.level]), [['7:1', 1], ['7:2', 2]]);
  const calls = [];
  const n = await syncScores(st3, async (board, p) => { calls.push([board, p.points, p.time, p.level]); return board === '7:2' ? null : 1; });
  assert.equal(n, 1);
  assert.deepEqual(unsynced(st3).map((u) => u.board), ['7:2']);
  assert.deepEqual(getBest(st3, 7, 1), { score: 10, time: 5, name: 'a', synced: true });
  markSynced(st3, '7:2', { score: 1, time: 6 }); // stale: better score replaced it
  assert.equal(unsynced(st3).length, 1);
  saveBest(st3, 7, 1, { score: 11, time: 5, name: 'a' }); // new best is unsynced again
  assert.equal(unsynced(st3).length, 2);
  const { pullScores } = await import('../js/globalscores.js');
  const st4 = { d: {}, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = v; } };
  saveBest(st4, 7, 1, { score: 50, time: 5, name: 'me' });
  const remote = [{ board: '7:1', name: 'me', points: 30, time: 9 }, { board: '7:2', name: 'me', points: 20, time: 6 }, { board: 'default', name: 'me', points: 1, time: 1 }];
  const fetchPage = async () => ({ data: remote, total: 3 });
  assert.deepEqual(await pullScores(st4, 'me', fetchPage), { fetched: 3, added: 2 });
  assert.deepEqual(getBest(st4, 7, 1), { score: 50, time: 5, name: 'me' }, 'a worse remote score keeps the local best');
  assert.deepEqual(getBest(st4, 7, 2), { score: 20, time: 6, name: 'me', synced: true }, 'a pulled best counts as synced');
  assert.equal(getTop(st4, 7, 1).length, 2, 'the pulled run joins the local top list');
  assert.deepEqual(await pullScores(st4, 'me', fetchPage), { fetched: 3, added: 0 }, 'pulling twice adds nothing');
  assert.equal(await pullScores(st4, 'me', async () => null), null, 'offline');
  const offsets = [];
  await pullScores(st4, 'me', async (n, o) => { offsets.push(o); return { data: [remote[0]], total: 150 }; });
  assert.deepEqual(offsets, [0, 100], 'pages through all scores');
  console.log('highscores ok');
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

// Start stacks are clustered into bays (big yellow squares) clear of walls, doorways and drop-off areas.
{
  const rectGap = (a, b) => Math.hypot(Math.max(0, a.x - b.x - b.w, b.x - a.x - a.w), Math.max(0, a.y - b.y - b.h, b.y - a.y - a.h));
  for (let n = 1; n <= 30; n++) {
    const l = generateLevel(n);
    assert.equal(l.n, n, `level ${n} generated without fallback`);
    for (const st of l.stacks) {
      assert.ok(l.bays.some((b) => st.x > b.x && st.x < b.x + b.w && st.y > b.y && st.y < b.y + b.h), `level ${n} stack in a bay`);
    }
    for (const b of l.bays) {
      assert.ok(l.stacks.some((st) => st.x > b.x && st.x < b.x + b.w && st.y > b.y && st.y < b.y + b.h), `level ${n} no empty bay`);
      assert.ok(!l.walls.some((r) => rectGap(r, b) < 1), `level ${n} bay clear of walls`);
      assert.ok(!l.doors.some((r) => rectGap(r, b) < 1), `level ${n} bay clear of doors`);
    }
  }
  console.log('bays ok');
}

// Spawn/parking varies per level and is axis-aligned and inside the walls.
{
  const starts = new Set();
  for (let n = 1; n <= 8; n++) {
    const l = generateLevel(n);
    starts.add(`${l.start.x.toFixed(1)},${l.start.y.toFixed(1)}`);
    assert.ok(Math.abs(Math.sin(2 * l.start.a)) < 1e-9, 'start heading is axis-aligned');
    assert.ok(newGame(n) && isParked(newGame(n)), 'spawns parked');
    // Tail against a half-width charger stub that juts from an outer wall.
    const c = Math.cos(l.start.a), s = Math.sin(l.start.a);
    const tx = l.start.x + FL.back * c, ty = l.start.y + FL.back * s;
    const ch = l.walls.find((r) => pointRectDist(tx, ty, r) < 0.1 &&
      (r.x < 0.01 || r.y < 0.01 || r.x + r.w > l.w - 0.01 || r.y + r.h > l.h - 0.01));
    assert.ok(newGame(n).walls.some((w) => w.charger && w.x === ch.x && w.y === ch.y), 'game marks the charger wall');
    assert.ok(ch, 'tail rests against a charger on an outer wall');
    assert.ok(Math.abs(Math.max(ch.w, ch.h) - FL.halfW) < 1e-9, 'charger is half the truck width');
  }
  assert.ok(starts.size > 1, 'spawn point varies');
  console.log('spawn ok');
}

// A released stack is drawn lowering (dropFrom) until the forks reach the floor.
{
  const g = newGame(1);
  g.fl.a = 0;
  g.stacks = [{ x: g.fl.x + 1, y: g.fl.y, layers: [0], rots: [g.fl.a], pen: [{ crash: 0, sq: 0 }], offs: [{ x: 0, y: 0 }], a: g.fl.a }];
  forkUp(g);
  assert.ok(g.carried, 'picked up');
  g.hf = g.H = 3;
  g.carried = g.carried || [0];
  while (g.H > 0 && g.carried) forkDown(g);
  const dropped = g.stacks.find((s) => s.dropFrom != null);
  assert.ok(dropped && g.hf > dropped.dropFrom, 'released while forks still above');
  run(g, {}, 1);
  assert.ok(g.stacks.every((s) => s.dropFrom == null), 'lowering ends at the floor');
  console.log('drop ok');
}

{
  const g = newGame(3);
  const S = g.stacks.find((s) => s.layers.length > 0);
  const before = S.pen.map((p) => p.deco);
  assert.ok(before.every((d) => d >= 0 && d <= 3));
  g.fl.x = S.x - 1; g.fl.y = S.y; g.fl.a = 0; g.fl.speed = 0;
  forkUp(g);
  assert.ok(g.carried, 'stack lifted');
  assert.deepEqual(g.carriedPen.map((p) => p.deco), before, 'decals travel with lifted boxes');
  console.log('box decals ok');
}

// debug overlay helpers
{
  const { debugEnabled, createDebug } = await import('../js/debug.js');
  assert.strictEqual(debugEnabled('?debug'), true);
  assert.strictEqual(debugEnabled('?x=1&debug=1'), true);
  assert.strictEqual(debugEnabled(''), false);
  const d = createDebug();
  for (let i = 0; i < 10; i++) { d.frame(i * 16.7, 2, 0.5, 1); d.overhead(0.5); }
  const lines = d.lines(newGame(1), { width: 800, height: 600, dpr: 1 });
  assert.ok(lines[0].startsWith('FPS 60'), lines[0]);
  assert.ok(lines[2].startsWith('time share'), lines[2]);
  assert.ok(lines[1].includes('debug 0.50 ms'), lines[1]);
  assert.ok(lines[2].includes('update   3%') && lines[2].includes('draw   6%') && lines[2].includes('debug   3%') && lines[2].includes('idle  88%'), lines[2]);
  assert.ok(lines[4].includes('boxes in place 0/'), lines[4]);
}

// Reversing light: only when reversing, and never reaches past a wall.
{
  const g = newGame(1);
  assert.equal(reverseLight(g), null, 'no light when stationary');
  g.fl.x = g.w / 2; g.fl.y = g.h / 2; g.fl.a = 0;
  g.fl.speed = -1; g.fl.gear = 'R';
  const L = reverseLight(g);
  assert.ok(L && L.pts.every((p) => Math.hypot(p.x - L.x, p.y - L.y) <= REV_RADIUS + 1e-9));
  g.fl.speed = 1; g.fl.gear = 'D';
  assert.equal(reverseLight(g), null, 'no light driving forward');
  // Light centre 0.5 from the right border wall, rear pointing at it.
  const wall = g.walls.reduce((b, w) => (w.x > b.x ? w : b));
  g.fl.a = Math.PI; g.fl.y = g.h / 2; g.fl.speed = -1; g.fl.gear = 'R';
  g.fl.x = wall.x - 0.5 + (FL.back - 1.0);
  const M = reverseLight(g);
  assert.ok(M.pts.every((p) => p.x <= wall.x + 1e-9), 'light stops at wall');
  g.fl.x += 0.9; // centre would be inside the wall: light must still show
  const N = reverseLight(g);
  assert.ok(N && N.pts.every((p) => p.x <= wall.x + 1e-9), 'light survives wall contact');
  assert.ok(M.pts.some((p) => p.wall && p.climb > 0), 'light climbs wall');
}

{
  const g = newGame(1);
  run(g, {}, 1);
  assert.strictEqual(g.time, 0, 'timer waits for first movement');
  run(g, { up: true }, 1);
  assert(Math.abs(g.time - 1) < 0.05);
  g.status = 'won';
  const t = g.time;
  run(g, {}, 1);
  assert.strictEqual(g.time, t);
  assert.strictEqual(newGame(2).time, 0);
  console.log('timer stops on win ok');
}

{
  // head-on wall hit bonks; sliding along a wall scrapes
  let g = newGame(2);
  g.stacks = [];
  g.fl.x = g.w / 2; g.fl.y = 1.5; g.fl.a = -Math.PI / 2; g.fl.speed = 4;
  run(g, {}, 1);
  assert.ok(g.bonks >= 1 && g.bonkPower > 0.2, 'head-on hit bonks');
  g = newGame(2);
  g.stacks = [];
  g.walls = g.walls.slice(0, 4);
  g.fl.x = g.w / 2; g.fl.y = 1; g.fl.a = -0.15; g.fl.speed = 3;
  let scraped = false;
  for (let i = 0; i < 180; i++) { update(g, { up: true }, 1 / 120); scraped ||= g.scrape > 0.3; }
  assert.ok(scraped && g.bonks === 0, 'glancing contact scrapes without bonk');
  console.log('wall sounds ok');
}

{
  const { parseMidi } = await import('../js/midi.js');
  const { readFileSync, readdirSync } = await import('node:fs');
  const files = readdirSync(new URL('../assets/midi/', import.meta.url)).filter((f) => f.endsWith('.mid'));
  assert.ok(files.length >= 9);
  let drums = 0;
  for (const f of files) {
    const s = parseMidi(readFileSync(new URL(`../assets/midi/${f}`, import.meta.url)));
    drums += s.notes.filter((n) => n.drum).length;
    assert.ok(s.notes.length > 50 && s.duration > 20 && s.duration < 600, `${f} parses`);
    assert.ok(s.notes.every((n) => n.dur > 0 && n.note >= 0 && n.note < 128), `${f} notes valid`);
  }
  assert.ok(drums > 1000, 'percussion channel kept');
  console.log('midi parser ok');
}

// Some dividing walls have two openings (collinear wall pieces with two gaps between them).
{
  let multi = 0;
  for (let n = 4; n <= 14; n++) {
    const { walls } = generateLevel(n);
    for (const a of walls) for (const b of walls) {
      if (a === b) continue;
      const v = a.w === 1 && b.w === 1 && a.x === b.x;
      const hz = a.h === 1 && b.h === 1 && a.y === b.y;
      if ((v && b.y > a.y + a.h) || (hz && b.x > a.x + a.w)) {
        const c = walls.find((m) => m !== a && m !== b && (v ? m.w === 1 && m.x === a.x && m.y >= a.y + a.h && m.y + m.h <= b.y : m.h === 1 && m.y === a.y && m.x >= a.x + a.w && m.x + m.w <= b.x));
        if (c) multi++;
      }
    }
  }
  assert.ok(multi > 0, 'some wall has two doors');
  console.log('multi door ok');
}

// Save / restore a level in progress through JSON (localStorage and export/import).
{
  const g = newGame(3, 7, true);
  run(g, { up: true }, 1.5);
  run(g, { left: true, up: true }, 1);
  forkUp(g);
  const json = JSON.stringify(serializeGame(g, 'abc'));
  const r = deserializeGame(JSON.parse(json));
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
  c.H = 1;
  assert.deepEqual(deserializeGame(JSON.parse(JSON.stringify(serializeGame(c)))).carried, c.carried, 'carried stack restores');
  run(g, { up: true }, 1);
  run(r, { up: true }, 1);
  assert.deepEqual(r.fl, g.fl);
  assert.throws(() => deserializeGame({ version: 99 }));
  assert.throws(() => deserializeGame({ ...JSON.parse(json), level: 4 }));
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
  console.log('savestate ok');
}

// Placement loss follows the resting angle and only counts stacks sitting in a complete zone.
{
  const g = newGame(1);
  flatWorld(g);
  g.zones = [{ x: 12, y: 5, color: 0, count: 1 }];
  g.stacks = [{ x: 8, y: 5, layers: [0], rots: [Math.PI / 4], a: Math.PI / 4 }];
  assert.equal(lostBreakdown(g).square, 0, 'outside a zone does not count');
  g.stacks[0].x = 12;
  assert.ok(lostBreakdown(g).square > 0, 'nudged into the zone, crooked');
  g.stacks[0].rots = [0];
  assert.equal(lostBreakdown(g).square, 0, 'straightened');
  g.stacks[0].rots = [Math.PI / 4];
  g.stacks[0].x = 8;
  assert.equal(lostBreakdown(g).square, 0, 'nudged out of the zone');
}

{
  const g = newGame(3);
  const all = g.stacks.flatMap((s) => s.rots);
  assert.ok(all.every((r) => Math.abs(r) <= 15 * Math.PI / 180 + 1e-9), 'rotation within 15 degrees');
  assert.ok(all.some((r) => r !== 0), 'boxes are crooked');
  assert.ok(g.stacks.every((s) => s.offs.every((o) => Math.hypot(o.x, o.y) < 0.1)), 'small offsets');
  assert.deepEqual(newGame(3).stacks.map((s) => s.rots), g.stacks.map((s) => s.rots), 'deterministic');
  console.log('wonky stacks ok');
}

// Score popups: separate popups for the stack's points (completed / moved off) and its wonkiness (placed / nudged).
{
  const drop = (x, rot, crash = 0) => {
    const g = newGame(1);
    flatWorld(g);
    g.zones = [{ x: 12, y: 5, color: 0, count: 2 }];
    g.stacks = [];
    g.fl.x = x - FL.carryX; g.fl.y = 5; g.fl.a = 0;
    g.carried = [0, 0]; g.carriedRots = [rot, rot]; g.carriedRel = rot;
    g.carriedPen = [{ crash, sq: 0 }, { crash: 0, sq: 0 }]; g.carriedOffs = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
    g.H = 0;
    update(g, {}, 1 / 120);
    forkDown(g);
    update(g, {}, 1 / 120);
    return g;
  };
  const g = drop(12, Math.PI / 4);
  const pts = zonePoints(g, g.zones[0]);
  const scores = (h) => h.hits.map((x) => x.score);
  assert.equal(pts.square, g.stacks[0].pen[0].sq + g.stacks[0].pen[1].sq);
  assert.ok(pts.square > 0 && pts.crash === 0 && g.hitCount === 0, 'wonky, not a crash');
  assert.deepEqual(scores(g), [{ total: 200 }, { wonky: -pts.square }], 'separate stack and wonkiness popups, no damage row');
  assert.deepEqual(scores(drop(12, Math.PI / 4, 10)), [{ total: 200 }, { wonky: -pts.square }], 'damage was already deducted, popup shows full points');
  assert.deepEqual(scores(drop(12, 0)), [{ total: 200 }], 'no wonkiness popup for a straight stack');
  assert.equal(drop(8, 0).hits.length, 0, 'no popup off a drop point');
  update(g, {}, 1 / 120);
  assert.equal(g.hits.length, 2, 'no repeat while the zone stays complete');

  // nudging: the stack popup fades while the wonkiness popup keeps re-popping
  const n = drop(12, Math.PI / 4);
  run(n, {}, 1.5);
  assert.equal(n.hits.length, 2, 'both popups still showing');
  n.stacks[0].rots = n.stacks[0].rots.map(() => Math.PI / 8); // nudged less crooked: merged and refreshed
  update(n, {}, 1 / 120);
  const left = 200 - zonePoints(n, n.zones[0]).total;
  assert.deepEqual(scores(n), [{ total: 200 }, { wonky: -left }], 'merged into one wonkiness popup');
  run(n, {}, 1);
  assert.deepEqual(scores(n), [{ wonky: -left }], 'stack popup gone, wonkiness popup refreshed');
  n.stacks[0].rots = n.stacks[0].rots.map(() => 0); // nudged straight: cancels out
  update(n, {}, 1 / 120);
  assert.equal(n.hits.length, 0);
  n.stacks[0].rots = n.stacks[0].rots.map(() => Math.PI / 4); // nudged crooked
  update(n, {}, 1 / 120);
  const lost = 200 - zonePoints(n, n.zones[0]).total;
  assert.deepEqual(scores(n), [{ wonky: -lost }], 'wonkiness deduction only');
  run(n, {}, 2.3);
  update(n, {}, 1 / 120);
  n.stacks[0].x += 3; // pushed off the drop point
  update(n, {}, 1 / 120);
  assert.deepEqual(scores(n), [{ total: -200 }], 'negative points when moved off');
  assert.equal(pts.total, 200 - pts.square);
  assert.equal(pts.total, score(g), 'matches the score');
  g.stacks[0].pen[0].crash = 10;
  const hurt = zonePoints(g, g.zones[0]);
  assert.deepEqual([hurt.crash, hurt.total], [10, 200 - 10 - pts.square]);
  assert.equal(hurt.total, score(g));
  assert.equal(hurt.base, 200, 'popup shows full points; the crash was deducted when it happened');
  assert.ok(zoneWonky(g, g.zones[0]));
  assert.equal(zonePoints(drop(12, 0), { x: 12, y: 5, color: 0, count: 2 }).total, 200, 'straight stack is worth full points');
  assert.equal(zonePoints(drop(8, 0), g.zones[0]), null, 'open zone has no points');
  assert.ok(!zoneWonky(drop(12, 0), { x: 12, y: 5, color: 0, count: 2 }));
  console.log('stack points ok');
}

{
  for (let n = 1; n <= 40; n++) assert.ok(isReachable(generateLevel(n)), `level ${n} reachable`);
  const room = { w: 20, h: 12, start: { x: 3, y: 6, a: 0 }, stacks: [{ x: 6, y: 6, layers: [0] }], zones: [{ x: 8, y: 6, color: 0, count: 1 }] };
  assert.ok(isReachable({ ...room, walls: [] }), 'open room reachable');
  const wall = { x: 12, y: 0, w: 1, h: 12 };
  assert.ok(!isReachable({ ...room, walls: [wall], zones: [{ x: 17, y: 6, color: 0, count: 1 }] }), 'walled-off zone rejected');
  const door = [{ x: 12, y: 0, w: 1, h: 4 }, { x: 12, y: 7.6, w: 1, h: 4.4 }];
  assert.ok(isReachable({ ...room, walls: door, zones: [{ x: 17, y: 6, color: 0, count: 1 }] }), 'zone behind a door reachable');
  console.log('reachability ok');
}

{
  for (let seed = -5; seed < 40; seed++) {
    for (const n of [1, 3, 8, 15, 30, 60]) {
      const l = generateLevel(n, seed);
      assert.equal(l.n, n, `level ${n} seed ${seed} keeps its number`);
      assert.ok(isReachable(l), `level ${n} seed ${seed} reachable`);
    }
  }
  console.log('seed sweep ok');
}

// Damage crumples boxes: lids when forks are dropped on them, sides when rammed, corners against walls.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0, 1] }];
  g.fl.x = 6; g.fl.y = 5; g.fl.a = 0; g.fl.speed = 0;
  driveUntil(g, 10, 8);
  g.H = 2;
  assert.equal(forkDown(g), 'blocked');
  assert.ok(g.stacks[0].pen[1].dent.t > 0, 'lid crumpled by the dropped forks');

  const h = newGame(1);
  flatWorld(h);
  h.stacks = [{ x: 9, y: 5, layers: [0] }];
  h.fl.x = 5; h.fl.y = 5; h.fl.a = 0; h.fl.speed = 4;
  run(h, { up: true }, 3);
  const d = h.stacks[0].pen[0].dent;
  assert.ok(d && d.s.some((v) => v > 0), 'side crumpled by the truck');
}

// WebGL scene: pure geometry/camera maths (no GL context needed)
{
  const g = newGame(3);
  g.fl.x = 6; g.fl.y = 5; g.fl.a = 0;
  const cam = povCamera(g, 800, 500);
  const ahead = projectPoint(cam.vp, g.fl.x + 6, g.fl.y, 0.5, 800, 500);
  assert.ok(ahead && Math.abs(ahead[0] - 400) < 1, 'a point straight ahead projects to the screen centre');
  assert.equal(projectPoint(cam.vp, g.fl.x - 6, g.fl.y, 0.5, 800, 500), null, 'points behind the eye are not projected');
  const left = projectPoint(cam.vp, g.fl.x + 6, g.fl.y - 2, 0.5, 800, 500);
  assert.ok(left[0] < 400, 'world -y is left of a forklift heading +x (screen-right is the forklift right)');
  const ov = overviewCamera(8, 5, 10, 800, 500);
  const c = projectPoint(ov.vp, 8, 5, 0, 800, 500);
  assert.ok(Math.abs(c[0] - 400) < 1 && Math.abs(c[1] - 250) < 1, 'overview centres its target');
  const up = projectPoint(ov.vp, 8, 3, 0, 800, 500), down = projectPoint(ov.vp, 8, 7, 0, 800, 500);
  assert.ok(up[1] < c[1] && down[1] > c[1], 'default overview has -y up the screen');
  for (const a of [0, 1.2, -2.5]) {
    g.fl.a = a;
    const ch = chaseCamera(g, 800, 500);
    const fx = g.fl.x, fy = g.fl.y, hx = Math.cos(a), hy = Math.sin(a);
    const here = projectPoint(ch.vp, fx, fy, 0, 800, 500), ahead = projectPoint(ch.vp, fx + hx * 2, fy + hy * 2, 0, 800, 500);
    assert.ok(ahead[1] < here[1] && Math.abs(ahead[0] - here[0]) < 1, 'chase camera: the forklift heading is straight up the screen');
    assert.ok(chaseTiles(0) > 34 && chaseTiles(100) === 7 && chaseZoom(chaseTiles(40)) === 40, 'chase zoom range: fully in = 7 tiles, out = 80% smaller');
    assert.ok((ch.eye[0] - fx) * hx + (ch.eye[1] - fy) * hy < 0 && ch.eye[2] > 1, 'chase camera sits behind and above the forklift');
  }
  {
    g.fl.a = 0.7;
    for (const cam of [chaseCamera(g, 800, 500), chaseCamera(g, 800, 500, 11, 0.7, { yaw: 0, tilt: 1.4 })]) {
      const fp = groundFootprint(cam), [tl, tr, br, bl] = fp;
      assert.ok(fp.every((q) => q.every(Number.isFinite)), 'footprint corners are finite');
      assert.ok(Math.hypot(tl[0] - tr[0], tl[1] - tr[1]) > Math.hypot(bl[0] - br[0], bl[1] - br[1]), 'footprint is wider far than near');
      const inside = fp.every((q, i) => { const n = fp[(i + 1) % 4], o = fp[(i + 2) % 4]; return (n[0] - q[0]) * (g.fl.y - q[1]) - (n[1] - q[1]) * (g.fl.x - q[0]) >= 0 === ((n[0] - q[0]) * (o[1] - q[1]) - (n[1] - q[1]) * (o[0] - q[0]) >= 0); });
      assert.ok(inside, 'footprint contains the forklift');
    }
    const tm = toWorld(g.fl, (FL.tineX0 + FL.tineX1) / 2, 0);
    const sprung = chaseCamera(g, 800, 500, 11, 0.2), orb = chaseCamera(g, 800, 500, 11, 0.7, { yaw: 1.5, tilt: 0.6 });
    const ahead = projectPoint(sprung.vp, tm.x + Math.cos(0.2), tm.y + Math.sin(0.2), 0, 800, 500), mid = projectPoint(sprung.vp, tm.x, tm.y, 0, 800, 500);
    assert.ok(ahead[1] < mid[1], 'chase camera follows the sprung heading, not the forklift heading');
    const ang = Math.atan2(orb.eye[1] - tm.y, orb.eye[0] - tm.x), want = 0.7 + 1.5 + Math.PI;
    assert.ok(Math.abs(Math.atan2(Math.sin(ang - want), Math.cos(ang - want))) < 0.5, 'chase orbit swings the camera around the tines');
  }
  for (const mode of ['pov', 'ov']) {
    const s = staticMeshes(g, mode);
    assert.equal(staticMeshes(g, mode), s, 'static meshes are cached per game state');
    assert.ok(s.opaque.count > 0 && s.opaque.count % 3 === 0, 'static opaque triangles');
    const d = dynamicMeshes(g, mode, cam.eye);
    assert.ok(d.opaque.count > 0 && d.opaque.floats().length === d.opaque.count * 10, 'dynamic mesh floats match the vertex stride');
  }
  console.log('gl scene ok');
}

// Dark mode: headlights, reverse/brake lights; ceiling fixtures give no point light
{
  const g = newGame(1);
  const eye = [g.fl.x, g.fl.y];
  assert.equal(dynamicMeshes(g, 'pov', eye).lights.length, 0, 'light mode has no point lights');
  setThemeMode('dark');
  setDiscoEnabled(false);
  let ls = dynamicMeshes(g, 'pov', eye).lights;
  assert.equal(ls.filter((l) => l.cone === 0.62).length, 2, 'two headlights');
  assert.equal(ls.length, 4, 'headlights plus idle tail glow while standing still');
  assert.ok(ls.filter((l) => l.cone === 0.62).every((l) => l.z > 1.3), 'headlights are high up');
  run(g, { down: true }, 0.5);
  ls = dynamicMeshes(g, 'pov', eye).lights;
  assert.ok(g.fl.speed < -0.05 && ls.length === 6, 'reversing adds two reverse lights');
  run(g, { up: true }, 0.03);
  assert.ok(g.fl.brake && dynamicMeshes(g, 'pov', eye).lights.length >= 6, 'throttle against the motion brakes');
  setThemeMode('light');
  setDiscoEnabled(true);
  console.log('dark lights ok');
}

// Zone labels never sit under a wall (e.g. a drop point at the south border); all drop points of an area near the south wall are labelled above
{
  for (let n = 1; n <= 40; n++) {
    const g = newGame(n);
    for (const z of g.zones) {
      const p = zoneLabelPos(g, z);
      assert.ok(!g.walls.some((w) => p.x + 0.4 > w.x && p.x - 0.4 < w.x + w.w && p.y + 0.25 > w.y && p.y - 0.25 < w.y + w.h), `zone label hidden by a wall on level ${n}`);
    }
    for (const c of new Set(g.zones.map((z) => z.color))) {
      const side = g.zones.filter((z) => z.color === c).map((z) => Math.sign(zoneLabelPos(g, z).y - z.y));
      assert.ok(side.every((v) => v === side[0]) || g.zones.length < 2, `mixed label sides in one area on level ${n}`);
    }
  }
  console.log('zone labels ok');
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

// The chase camera only looks back after reversing for a while; the cabin camera always looks forward
{
  const g = newGame(1);
  run(g, { down: true }, 0.6);
  assert.ok(g.fl.gear === 'R' && g.rv < 0.01, 'short reverse keeps looking forward');
  run(g, { down: true }, 1.5);
  assert.ok(g.rv > 0.9, 'long reverse looks back');
  const cab = povCamera(g, 800, 500), back = projectPoint(cab.vp, g.fl.x + Math.cos(g.fl.a) * 6, g.fl.y + Math.sin(g.fl.a) * 6, 0.5, 800, 500);
  assert.ok(back && Math.abs(back[0] - 400) < 400, 'cabin camera still looks along the heading in reverse');
  console.log('look back delay ok');
}

// chase camera orbits upwards when a wall hides the forklift
{
  const g = newGame(1);
  g.walls = [];
  assert.equal(clearChaseTilt(g, 11, g.fl.a, 0, CHASE_TILT), CHASE_TILT);
  const a = g.fl.a, p = toWorld(g.fl, FL.back, 0);
  g.walls = [{ x: p.x - Math.cos(a) * 3 - 1, y: p.y - Math.sin(a) * 3 - 1, w: 2, h: 2 }]; // between camera and truck
  const t = clearChaseTilt(g, 11, a, 0, CHASE_TILT);
  assert.ok(t < CHASE_TILT, 'camera should lift over the wall');
  console.log('chase wall clearing ok');
}

// Splash demo: the scripted forklift keeps shuffling the stacks without hitting walls or other stacks, and never loses a box
{
  const { g, step } = createDemo();
  const layers = () => g.stacks.reduce((n, s) => n + s.layers.length, 0) + (g.carried ? g.carried.length : 0);
  let carriedSeen = false;
  for (let i = 0; i < 60 * 200; i++) {
    step(1 / 60);
    const f = g.fl, c = toWorld(f, (FL.back + FL.front) / 2, 0);
    const body = rectPoly(c.x, c.y, (FL.front - FL.back) / 2, FL.halfW, f.a);
    assert.equal(layers(), 6, 'no box lost');
    if (g.H > 0) assert.ok(g.stacks.every((s) => s.dropFrom == null || g.hf <= s.dropFrom + 1e-3), 'a placed stack rises with the forks');
    assert.ok(Math.abs(f.steer) <= FL.maxSteer + 1e-9, 'steering within lock');
    const shapes = [body];
    if (g.carried) { carriedSeen = true; const k = toWorld(f, FL.carryX, 0); shapes.push(rectPoly(k.x, k.y, 0.5, 0.5, f.a)); }
    for (const p of shapes) {
      assert.ok(!g.walls.some((w) => sat(p, w.poly)), 'demo hits a wall');
      assert.ok(!g.stacks.some((s) => sat(p, rectPoly(s.x, s.y, 0.5, 0.5))), 'demo hits a stack');
    }
  }
  assert.ok(carriedSeen, 'demo carries stacks');
  assert.ok(g.stacks.length === 3 || g.carried, 'stacks conserved');
  console.log('splash demo ok');
}

// Multiplayer trucks: ghosts at spawn, collisions once separated, stack handoff on the tines, leaving players
{
  const boxes = (g) => g.stacks.reduce((n, s) => n + s.layers.length, 0) + g.trucks.reduce((n, t) => n + (t.carried ? t.carried.length : 0), 0);
  const g = newGame(1);
  const total = boxes(g);
  assert.equal(addTruck(g, 'B'), 1);
  assert.equal(g.trucks[1].color, 1, 'second truck is red');
  assert.deepEqual(g.ghostPairs, [[0, 1]], 'a truck spawning inside another is a ghost to it');
  assert.ok(isGhost(g, 0) && isGhost(g, 1) && ghostBetween(g, 1, 0));
  // truck 0 drives off through the ghost; once clear they are solid
  run(g, { up: true }, 0.5);
  assert.ok(g.ghostPairs.length === 1 || g.trucks[0].fl.speed > 0, 'still overlapping or moving');
  run(g, { up: true }, 3);
  assert.deepEqual(g.ghostPairs, [], 'ghosts become real once separated');
  // a solid truck is pushed along by the other one instead of being driven through
  const t0 = g.trucks[0].fl, t1 = g.trucks[1].fl;
  Object.assign(t0, { x: 3, y: 8.5, a: 0, speed: 0 });
  Object.assign(t1, { x: 6.2, y: 8.5, a: 0, speed: 0 });
  run(g, { up: true }, 2);
  assert.ok(t1.x - t0.x > 2.2, 'the driver did not pass through the other truck');
  assert.ok(t1.x > 6.5, 'and pushed it along');

  // handoff: truck 1 lifts a floor stack, truck 0 takes it over by raising its tines under it, then gives it back by lowering
  g.ghostPairs = [];
  const S = g.stacks[0], n = S.layers.length;
  Object.assign(t1, { x: S.x - FL.carryX, y: S.y, a: 0, speed: 0 });
  const v1 = truckView(g, 1);
  forkUp(v1);
  assert.equal(g.trucks[1].carried.length, n, 'truck 1 carries the stack');
  assert.equal(g.trucks[1].H, 1);
  const p = toWorld(t1, FL.carryX, 0);
  Object.assign(t0, { x: p.x + FL.carryX, y: p.y, a: Math.PI, speed: 0 });
  g.trucks[0].H = 0;
  forkUp(g);
  assert.equal(g.carried.length, n, 'truck 0 took the stack');
  assert.equal(g.H, 1, 'but did not lift it higher than it was');
  assert.equal(g.trucks[1].carried, null);
  assert.equal(boxes(g), total);
  forkDown(g);
  assert.equal(g.carried, null, 'lowering the stack over the other tines gives it away');
  assert.equal(g.trucks[1].carried.length, n);
  assert.equal(g.trucks[1].H, 1, 'the receiver stays at its height');
  assert.equal(g.H, 0);
  // not under the tines: nothing happens
  Object.assign(t0, { x: 5, y: 5 });
  forkUp(g);
  assert.equal(g.carried, null);
  assert.equal(g.H, 1);

  // split: truck 0 puts its tines inside a carried stack and takes only the boxes from that level up; then puts them back on top
  {
    const g4 = newGame(1);
    addTruck(g4, 'B');
    g4.ghostPairs = [];
    const a = g4.trucks[0], b = g4.trucks[1];
    Object.assign(b.fl, { x: 10, y: 10, a: 0, speed: 0 });
    const pc = toWorld(b.fl, FL.carryX, 0);
    Object.assign(a.fl, { x: pc.x + FL.carryX, y: pc.y, a: Math.PI, speed: 0 });
    b.H = 1; b.carried = [0, 1, 2]; b.carriedRots = [0, 0, 0]; b.carriedPen = []; b.carriedOffs = [{ x: 0, y: 0 }, { x: 0, y: 0.05 }, { x: 0.1, y: 0.05 }]; b.carriedRel = 0;
    a.H = 2;
    forkUp(g4);
    assert.deepEqual(a.carried, [1, 2], 'took the boxes from its tines up');
    assert.deepEqual(b.carried, [0], 'the lower box stays on the other forks');
    assert.equal(a.H, 2);
    assert.ok(Math.abs(a.carriedOffs[1].x) > 0.09 || Math.abs(a.carriedOffs[1].y) > 0.09, 'keeps its crookedness');
    const sum = a.carried.length + b.carried.length;
    forkDown(g4);
    assert.equal(a.carried, null, 'put the boxes onto the other stack');
    assert.deepEqual(b.carried, [0, 1, 2]);
    assert.equal(b.carriedOffs.length, 3);
    assert.equal(sum, 3);
    assert.equal(a.H, 1);
    // a stack of four held at height 2 is dropped onto a single box carried at level 1; the carried stacks do not push each other
    b.carried = [0]; b.carriedRots = [0]; b.carriedOffs = [{ x: 0, y: 0 }]; b.carriedPen = []; b.H = 1;
    Object.assign(b.fl, { x: 6, y: 7, a: 0, speed: 0 });
    const pc2 = toWorld(b.fl, FL.carryX, 0);
    Object.assign(a.fl, { x: pc2.x + FL.carryX, y: pc2.y, a: Math.PI, speed: 0 });
    a.carried = [1, 2, 3, 0]; a.carriedRots = [0, 0, 0, 0]; a.carriedPen = []; a.carriedOffs = []; a.H = 2;
    const ax = a.fl.x, ay = a.fl.y;
    for (let i = 0; i < 20; i++) update(g4, {}, 1 / 120);
    assert.ok(Math.abs(a.fl.x - ax) < 0.01 && Math.abs(a.fl.y - ay) < 0.01, 'stacks at different heights do not collide');
    forkDown(g4);
    assert.equal(a.carried, null);
    assert.deepEqual(b.carried, [0, 1, 2, 3, 0], 'four boxes from height 2 land on the single carried box');
    // a full stack is not merged into
    b.carried = [0, 1, 2, 3]; a.carried = [1, 2]; a.carriedRots = [0, 0]; a.carriedPen = []; a.carriedOffs = []; a.H = 4;
    forkDown(g4);
    assert.equal(b.carried.length, 4, 'over MAX_LAYERS is refused');
  }

  // a player leaving puts the carried boxes down and frees the slot
  removeTruck(g, 1);
  assert.equal(boxes(g), total, 'no box lost when a player leaves');
  assert.equal(g.trucks[1].gone, true);
  assert.equal(addTruck(g, 'C'), 1, 'the slot is reused');
  for (let i = 0; i < 3; i++) addTruck(g, 'x');
  assert.equal(addTruck(g, 'full'), -1, 'at most four trucks');

  // any parked truck finishes the level
  const g2 = newGame(1);
  addTruck(g2, 'B');
  assert.equal(g2.trucks.length, 2);

  // other trucks are drawn: ghosts go to the transparent mesh, solid trucks to the opaque one
  const g3 = newGame(1);
  const solo = dynamicMeshes(g3, 'ov', [0, 0]);
  addTruck(g3, 'B');
  const ghosted = dynamicMeshes(g3, 'ov', [0, 0]);
  assert.ok(ghosted.trans.count > solo.trans.count && ghosted.opaque.count === solo.opaque.count, 'ghost drawn translucent');
  Object.assign(g3.trucks[1].fl, { x: 20, y: 10 });
  update(g3, {}, 1 / 120);
  assert.ok(dynamicMeshes(g3, 'ov', [0, 0]).opaque.count > solo.opaque.count, 'solid truck drawn opaque');

  // horns follow each truck's key and travel in snapshots
  update(g3, { horn: true }, 1 / 120);
  g3.trucks[1].input = {};
  assert.equal(g3.horn, true, 'own horn sounds while held');
  assert.equal(g3.trucks[1].horn, false);
  g3.trucks[1].input = { horn: true };
  update(g3, {}, 1 / 120);
  assert.deepEqual(g3.trucks.map((t) => t.horn), [false, true], 'other truck horn follows its input');
  assert.deepEqual(snapshot(g3).trucks.map((t) => t.horn), [false, true], 'horn is in snapshots');
  console.log('multiplayer trucks ok');
}

// Party networking with an in-memory relay and loopback links.
{
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const streams = new Map(); // `${code}/${peer}` -> handlers
  let seq = 0, ended = null;
  const relay = {
    async createParty() { return { code: 'ABCDE', hostToken: 'tok' }; },
    async join(code, name) { const peer = `p${++seq}`; setTimeout(() => streams.get('ABCDE/host').join({ peer, name })); return { peer, iceServers: [] }; },
    async signal(code, m) { setTimeout(() => streams.get(`${code.toUpperCase()}/${m.to}`)?.signal({ from: m.from, type: m.type, data: m.data })); },
    async end(code, token) { ended = token; },
    events(code, peer, token, handlers) { const k = `${code.toUpperCase()}/${peer}`; streams.set(k, handlers); return { close() { streams.delete(k); } }; },
  };
  // loopback links: the offer carries an id, the answering side pairs with the initiator that made it
  const initiators = new Map();
  let linkSeq = 0;
  const linkFactory = ({ initiator, sendSignal, onMessage, onOpen, onClose }) => {
    const me = { open: false, other: null, closed: false, onMessage, onOpen, onClose };
    const wire = (msg) => { const o = me.other; if (o && !o.closed) setTimeout(() => o.onMessage(JSON.parse(typeof msg === 'string' ? msg : JSON.stringify(msg)))); };
    Object.assign(me, {
      sendReliable: wire, sendFast: wire,
      close() { if (me.closed) return; me.closed = true; me.open = false; const o = me.other; if (o && !o.closed) { o.open = false; setTimeout(() => o.onClose?.()); } },
      async signal({ type, data }) {
        if (type === 'offer') {
          const o = initiators.get(data.id);
          me.other = o; o.other = me; me.open = o.open = true;
          setTimeout(() => { me.onOpen?.(); o.onOpen?.(); });
        }
      },
    });
    if (initiator) { const id = ++linkSeq; initiators.set(id, me); setTimeout(() => sendSignal({ type: 'offer', data: { id } })); }
    return me;
  };

  let host = newGame(7, 3, false);
  const info = () => ({ level: host.level, seed: host.seed, hard: host.hard, seedText: '' });
  let changes = 0, started = false;
  const h = createHost({ relay, getGame: () => host, levelInfo: info, isStarted: () => started, name: 'Anna', onChange: () => changes++, linkFactory });
  assert.equal(await h.start(), 'ABCDE');

  let guestGame = null, welcomes = 0, closedWith = null;
  const guest = createGuest({
    relay, code: 'abcde', name: 'Bob', linkFactory,
    onGame: (m) => {
      welcomes++;
      guestGame = newGame(m.level, m.seed, m.hard);
      guestGame.self = m.slot;
      applySnapshot(guestGame, m.snap);
    },
    onClosed: (why) => { closedWith = why; },
  });
  await guest.join();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(welcomes, 1, 'the guest got a welcome');
  assert.equal(guest.slot, 1);
  assert.equal(host.trucks.length, 2, 'the guest has a truck on the host');
  assert.equal(host.trucks[1].name, 'Bob');
  assert.equal(guestGame.trucks[1].color, 1, 'the guest is the second colour');
  assert.deepEqual(h.players().map((p) => p.name), ['Anna', 'Bob']);

  // inputs drive the guest's truck on the host, snapshots bring the result back
  guest.sendInput({ up: true });
  await tick(); await tick();
  assert.equal(host.trucks[1].input.up, true);
  const x0 = host.trucks[1].fl.x;
  for (let i = 0; i < 120; i++) update(host, {}, 1 / 120);
  assert.notEqual(host.trucks[1].fl.x, x0, 'the host moved the guest truck');
  h.broadcast(host, 10);
  for (let i = 0; i < 3; i++) await tick();
  const ip = createInterpolator();
  ip.push({ ...snapshot(host) }, 0);
  ip.apply(guestGame, 1);
  assert.ok(Math.abs(guestGame.fl.x - host.trucks[1].fl.x) < 1e-6, 'the guest mirrors its truck (g is the guest view)');
  guest.sendFork('up');
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(host.trucks[1].H, 1, 'fork action applied to the guest truck');

  // interpolation blends between two snapshots
  const a = snapshot(host), b = JSON.parse(JSON.stringify(a));
  b.trucks[1].fl.x += 2;
  const ip2 = createInterpolator(0);
  ip2.push(JSON.parse(JSON.stringify(a)), 0);
  ip2.push(b, 1);
  ip2.apply(guestGame, 0.5);
  assert.ok(Math.abs(guestGame.fl.x - (a.trucks[1].fl.x + 1)) < 1e-6, 'halfway between snapshots');

  // prediction: the guest's truck moves at once, and a snapshot from one round trip ago pulls it back in line
  {
    const pg = newGame(7, 3, false);
    addTruck(pg, 'Bob');
    pg.self = 1;
    const pr = createPredictor();
    pr.reset(pg);
    const x0 = pg.trucks[1].fl.x;
    for (let i = 0; i < 60; i++) { pr.step(pg, { up: true }, 1 / 60, i / 60); pr.apply(pg, i / 60); }
    assert.ok(Math.abs(pg.trucks[1].fl.x - x0) + Math.abs(pg.trucks[1].fl.y - 0) > 0.1, 'predicted truck moved without a snapshot');
    const ahead = { ...pg.trucks[1].fl };
    const auth = snapshot(pg);
    auth.trucks[1].fl = { ...ahead, x: ahead.x - 0.5 };
    pr.onSnapshot({ ...auth }, 1, 0);
    pr.apply(pg, 1);
    const moved = Math.hypot(pg.trucks[1].fl.x - ahead.x, pg.trucks[1].fl.y - ahead.y);
    assert.ok(moved > 0.01 && moved < 0.5, 'small error is blended, not snapped');
    auth.trucks[1].fl = { ...ahead, x: ahead.x - 10 };
    pr.onSnapshot({ ...auth }, 1, 0);
    pr.apply(pg, 1);
    assert.ok(Math.abs(pg.trucks[1].fl.x - (ahead.x - 10)) < 1e-6, 'large error snaps');
    // forks are predicted too: shown at once, and the host's answer wins once it should have arrived
    pr.fork('up', 2);
    pr.apply(pg, 2);
    assert.equal(pg.trucks[1].H, 1, 'fork level predicted at once');
    const refused = snapshot(pg);
    refused.trucks[1].H = 0;
    pr.onSnapshot(refused, 2.1, 0.05);
    pr.apply(pg, 2.1);
    assert.equal(pg.trucks[1].H, 1, 'still the prediction while the host has not confirmed');
    pr.onSnapshot(refused, 3, 0.05);
    pr.fork('up', 4);
    pr.apply(pg, 4);
    assert.equal(pg.trucks[1].H, 1, 'the host refused the first raise, so the prediction was reset to level 0');
  }

  // a new level keeps everyone in their slot
  host = newGame(8, 3, false);
  h.levelLoaded(host);
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(host.trucks[1].name, 'Bob');
  assert.equal(welcomes, 2, 'the guest was told about the new level');
  assert.equal(guestGame.level, 8);

  // two live players may share a name: the second must not evict the first
  guest.sendInput({ up: false });
  const twin = createGuest({ relay, code: 'abcde', name: 'Bob', linkFactory, onGame: () => {}, onClosed: () => {} });
  await twin.join();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(twin.slot, 2, 'the same-name newcomer gets its own slot');
  assert.equal(host.trucks[1].gone, false, 'the live guest keeps its truck');
  twin.close();
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(host.trucks[2].gone, true);
  closedWith = null;

  // a guest leaving frees the truck; the host closing ends the party
  guest.close();
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(host.trucks[1].gone, true, 'truck removed when the guest left');

  // ping, kick and ban
  let cyGame = null, cyClosed = null;
  const joinCy = (name) => createGuest({ relay, code: 'ABCDE', name, linkFactory, onGame: (m) => { cyGame = m; }, onClosed: (why) => { cyClosed = why; } });
  let cy = joinCy('Cy');
  await cy.join();
  for (let i = 0; i < 6; i++) await tick();
  const cySlot = cy.slot;
  assert.ok(cySlot > 0 && host.trucks[cySlot].name === 'Cy');
  h.broadcast(host, 100);
  for (let i = 0; i < 4; i++) await tick();
  const ping = h.players().find((p) => p.name === 'Cy').ping;
  assert.ok(ping !== null && ping >= 0, 'the host measures a ping');
  assert.equal(h.players()[0].ping, 0);
  assert.equal(h.kick(0), false, 'the host cannot kick itself');
  assert.equal(h.kick(cySlot, true), true);
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(host.trucks[cySlot].gone, true, 'kicked truck removed');
  assert.match(cyClosed, /banned/);
  cy = joinCy('cy');
  await cy.join();
  for (let i = 0; i < 6; i++) await tick();
  assert.match(cyClosed, /banned/);
  assert.equal(host.trucks.filter((t) => !t.gone).length, 1, 'a banned name gets no truck');
  h.close();
  assert.equal(ended, 'tok', 'party ended at the relay');
  console.log('party networking ok');
}

{
  const g = newGame(1);
  run(g, { down: true }, 0.8);
  assert.equal(g.fl.gear, 'R', 'reversing');
  run(g, {}, 0.5);
  assert.equal(g.fl.gear, 'R', 'brief pause stays in R');
  run(g, { down: true }, 0.3);
  run(g, {}, 4);
  assert.ok(Math.abs(g.fl.speed) < 0.05);
  assert.equal(g.fl.gear, 'D', 'idling in R for >1 s switches to D');
  console.log('idle reverse to D ok');
}

{
  // wall hits record a contact point; holding the throttle against a wall spins the tyres (slip); particles show up in the meshes
  setThemeMode('light');
  const g = newGame(2);
  g.stacks = [];
  g.fl.x = g.w / 2; g.fl.y = 1.5; g.fl.a = -Math.PI / 2; g.fl.speed = 0;
  const eye = [g.fl.x, g.fl.y + 3, 2];
  dynamicMeshes(g, 'ov', eye);
  const before = dynamicMeshes(g, 'ov', eye).trans.count;
  let slip = 0, sparked = 0;
  for (let i = 0; i < 360; i++) {
    update(g, { up: true }, 1 / 120);
    slip = Math.max(slip, g.slip);
    if (i % 12 === 0) { const m = dynamicMeshes(g, 'ov', eye); sparked = Math.max(sparked, m.opaque.count + m.trans.count - before); }
  }
  assert.ok(g.contact && g.contact.ny > 0.9, 'contact normal points away from the wall');
  assert.ok(slip > 0.4, 'driving into a wall spins the tyres');
  assert.ok(sparked > 0, 'particles are drawn');
  g.fl.speed = 0;
  let clear = false;
  for (let x = 3; x < g.w - 3 && !clear; x += 1.5) for (let y = 3; y < g.h - 3 && !clear; y += 1.5) {
    g.fl.x = x; g.fl.y = y;
    update(g, {}, 1 / 120);
    clear = g.contact === null;
  }
  assert.ok(clear, 'contact is cleared once the wall is no longer touched (no stale spark point)');
  const free = newGame(2);
  free.stacks = [];
  run(free, { up: true }, 0.5);
  assert.equal(free.slip, 0, 'free driving does not slip');
  console.log('particles ok');
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
  step(0.7);
  assert.ok(g.walls.includes(bay.parts.gate), 'gate closes when the truck is full');
  step(1.2 + 1);
  assert.ok(E.points > 1500 && E.boxes === 24, 'closing the gate banks the points');
  assert.ok(bay.off > 0 && g.stacks.length === 6, 'truck drives off with its load');
  step(4);
  assert.equal(E.delivered, 1);
  assert.equal(E.boxes, 24);
  assert.ok(E.points > 1500, 'delivered boxes are scored');
  assert.equal(g.stacks.length, 0, 'the load left with the truck');
  step(8);
  assert.ok(bay.state === 'open' && bay.off === 0 && !g.walls.includes(bay.parts.gate), 'a new truck waits with an open gate');

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
  k.fl.x = b3.x0 + 1.8; k.fl.y = 14 + 0.3 - 1.0; k.fl.a = Math.PI / 2; // tines reach ~0.5 into the trailer
  update(k, NONE, 1 / 60); stepEndless(k, 1 / 60);
  assert.equal(b3.state, 'open', 'gate stays open while the tines are in the truck');
  k.fl.x = 20; k.fl.y = 7; // clear
  update(k, NONE, 1 / 60); stepEndless(k, 1 / 60);
  assert.equal(b3.state, 'closing');
  k.fl.x = b3.x0 + 1.8; k.fl.y = 14 + 0.3 - 1.0;
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
