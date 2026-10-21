import assert from 'node:assert/strict';
import { generateLevel, parseSeed } from '../js/level.js';
import { FL } from '../js/forklift.js';
import { newGame, update, forkUp, forkDown, stackInZone, isParked, isFinished, score, maxScore, lostBreakdown } from '../js/game.js';

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

// Wall collision + brake.
{
  const g = newGame(1);
  g.stacks = [];
  const f = g.fl;
  f.x = 5; f.y = 5; f.a = Math.PI;
  run(g, { up: true }, 6);
  assert.ok(f.x > 0 && f.x < 4, 'stopped by wall');
}

const flatWorld = (g) => { g.zones = []; g.walls = g.walls.slice(0, 4); };
const driveUntil = (g, x, brakeAt) => {
  const f = g.fl;
  while (f.x + FL.carryX < x) update(g, { up: true, brake: f.speed > 1 && f.x > brakeAt }, 1 / 120);
  run(g, { brake: true }, 0.8);
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
  assert.ok(g.stacks[0].x > 9.5, 'carried box pushes stack');
}

// Carried boxes keep their orientation relative to the forklift and keep it when dropped.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0.3], a: 0.3 }];
  const f = g.fl;
  f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
  driveUntil(g, 9.7, 8);
  forkUp(g);
  assert.ok(Math.abs(g.carriedRel - 0.3) < 1e-9, 'relative angle stored');
  f.a += 0.5;
  forkDown(g);
  assert.equal(g.carried, null);
  assert.ok(Math.abs(g.stacks[0].a - 0.8) < 0.05, 'dropped with rotated orientation');
}

// Each box in a stack remembers its own rotation through lift, drop and merge.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0, 1], rots: [0.1, 0.4], a: 0.1 }];
  const f = g.fl;
  f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
  driveUntil(g, 10, 8);
  g.H = 1;
  forkUp(g);
  assert.deepEqual(g.stacks[0].rots, [0.1]);
  assert.ok(Math.abs(g.carriedRots[0] - 0.4) < 1e-9);
  forkDown(g);
  assert.equal(g.carried, null);
  assert.deepEqual(g.stacks[0].layers, [0, 1]);
  assert.ok(Math.abs(g.stacks[0].rots[0] - 0.1) < 1e-9 && Math.abs(g.stacks[0].rots[1] - 0.4) < 1e-9);
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
  for (let i = 0; i < 20; i++) { g.time += 1; g.fl.speed = 4; run(g, { up: true }, 0.01); }
  assert.ok(pts(g) >= 50, 'crash loss capped at 50 per box');
}
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0], rots: [Math.PI / 4], a: Math.PI / 4 }];
  const f = g.fl;
  f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
  driveUntil(g, 10, 8);
  forkUp(g);
  const before = pts(g);
  forkDown(g);
  assert.ok(before - pts(g) > 0 && pts(g) <= 100 - 40, 'diagonal box loses ~50 for squareness');
  g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0], a: 0 }];
  assert.equal(pts(g), 100, 'square box keeps full points');
}

// Re-placing a crooked box squarely recovers its squareness points.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0], rots: [Math.PI / 4], a: Math.PI / 4 }];
  const f = g.fl;
  f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
  driveUntil(g, 10, 8);
  forkUp(g);
  forkDown(g);
  assert.ok(pts(g) <= 60, 'crooked placement');
  forkUp(g);
  f.a -= Math.PI / 4;
  forkDown(g);
  assert.ok(pts(g) >= 98, 're-placed square recovers points');
}

// Small angle errors are free and deductions come in steps of 5.
{
  const place = (ang) => {
    const g = newGame(1);
    flatWorld(g);
    g.stacks = [{ x: 10, y: 5, layers: [0], rots: [ang], a: ang }];
    const f = g.fl;
    f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
    driveUntil(g, 10, 8);
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
  g.stacks[0].pen = [{ crash: 10, sq: 5 }];
  assert.equal(score(g), 85);
}

// Parking spot: forklift spawns parked; a level finishes only when solved, score >= 50% and parked.
{
  const g = newGame(1);
  assert.ok(isParked(g), 'spawns in parking spot');
  g.stacks = [{ x: 12, y: 5, layers: [0], rots: [0], pen: [{ crash: 0, sq: 0 }], a: 0 }];
  g.zones = [{ x: 12, y: 5, color: 0, count: 1 }];
  assert.ok(isFinished(g), 'solved and parked');
  g.stacks[0].pen = [{ crash: 50, sq: 50 }];
  assert.ok(!isFinished(g), 'score below 50%');
  g.stacks[0].pen = [{ crash: 0, sq: 0 }];
  g.fl.x += 3;
  assert.ok(!isParked(g) && !isFinished(g), 'must be parked');
  g.fl.x -= 3; g.fl.a += 1;
  assert.ok(!isParked(g), 'must be aligned');
  g.fl.a -= 1; g.fl.speed = 0;
  update(g, {}, 1 / 120);
  assert.equal(g.status, 'won');
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
  g.H = 3;
  assert.equal(forkDown(g), undefined, 'free to lower above the stack');
  assert.equal(g.H, 2);
  console.log('fork-blocked ok');
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

// Nudging a box slowly squares it to the forklift; a stack's bottom box takes a little damage.
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
  assert.ok(s.pen[0].crash > 0 && s.pen[0].crash < 10, 'bottom box takes a little damage');
  assert.equal(s.pen[1].crash, 0, 'upper box undamaged');
  console.log('box-align ok');
}
