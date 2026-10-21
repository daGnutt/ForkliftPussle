import assert from 'node:assert/strict';
import { generateLevel } from '../js/level.js';
import { FL } from '../js/forklift.js';
import { newGame, update, forkUp, forkDown, stackInZone } from '../js/game.js';

const NONE = {};
const run = (g, inp, secs) => { for (let i = 0; i < secs * 120; i++) update(g, inp, 1 / 120); };

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

// Pick up, carry, stack onto another, then drop to floor.
{
  const g = newGame(1);
  g.zones = [];
  g.walls = g.walls.filter((w) => w.x < 0 || w.y < 0 || w.x >= g.w || w.y >= g.h);
  g.walls = g.walls.slice(0, 4);
  g.stacks = [{ x: 10, y: 5, layers: [0] }, { x: 14, y: 5, layers: [1, 2] }];
  const f = g.fl;
  f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
  run(g, { up: true }, 2.2);
  run(g, { brake: true }, 0.8);
  assert.ok(stackInZone(g), 'stack in fork zone');
  forkUp(g);
  assert.deepEqual(g.carried, [0]);
  assert.equal(g.T, 1);
  forkUp(g); forkUp(g); forkUp(g);
  assert.equal(g.T, 4);
  // drive to the 2-stack with forks above it (top = 4 + 1 - 1 = 4 <= 5)
  while (f.x + FL.carryX < 13.9) update(g, { up: true, brake: f.speed > 1 && f.x > 12.4 }, 1 / 120);
  run(g, { brake: true }, 0.8);
  assert.equal(g.stacks[0].layers.length, 2);
  assert.ok(Math.abs(g.stacks[0].x - 14) < 0.05, 'high forks do not push low stack');
  forkDown(g);
  assert.equal(g.T, 3);
  forkDown(g);
  assert.equal(g.carried, null, 'merged onto stack at rest height');
  assert.deepEqual(g.stacks[0].layers, [1, 2, 0]);
  // split: forks at 3 reach under layer 3
  assert.equal(g.T, 3);
  forkUp(g);
  assert.deepEqual(g.carried, [0]);
  assert.deepEqual(g.stacks[0].layers, [1, 2]);
}

// Pushing at fork height 1.
{
  const g = newGame(1);
  g.zones = [];
  g.stacks = [{ x: 9, y: 5, layers: [0] }];
  const f = g.fl;
  f.x = 5; f.y = 5; f.a = 0;
  forkUp(g);
  assert.equal(g.T, 1);
  run(g, { up: true }, 1.5);
  assert.ok(g.stacks[0].x > 9.5, 'stack pushed');
}

console.log('all tests passed');
