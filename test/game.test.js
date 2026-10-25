import assert from 'node:assert/strict';
import { generateLevel, parseSeed } from '../js/level.js';
import { FL, toLocal, maxSteerFor } from '../js/forklift.js';
import { reverseLight, REV_RADIUS } from '../js/revlight.js';
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

// Steering lock: full lock standing still with forks down, clamped down by speed and by fork height.
{
  assert.equal(maxSteerFor(0, 0), FL.maxSteer, 'full lock at rest');
  assert.ok(maxSteerFor(4, 0) < maxSteerFor(0, 0), 'speed narrows the lock');
  assert.ok(maxSteerFor(0, 5) < maxSteerFor(0, 0), 'fork height narrows the lock');

  const g = newGame(1);
  g.stacks = [];
  const f = g.fl;
  f.x = 10; f.y = 7; f.a = 0;
  g.H = 5;
  run(g, { up: true }, 1);
  run(g, { up: true, right: true }, 1);
  assert.ok(f.steer <= maxSteerFor(f.speed, g.H) + 1e-9, 'steer stays within the tapered lock');
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
  g.stacks = [{ x: 10, y: 5, layers: [0], rots: [Math.PI / 4], a: Math.PI / 4 }];
  const f = g.fl;
  f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
  driveUntil(g, 10, 8);
  faceStack(g, Math.PI / 4);
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
  faceStack(g, Math.PI / 4);
  forkUp(g);
  forkDown(g);
  assert.ok(pts(g) <= 60, 'crooked placement');
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

// Raised forks cap top speed: empty forks (H=0) reach a higher top speed than fully raised forks (H=5).
{
  const g = newGame(1);
  flatWorld(g);
  const f = g.fl;
  f.x = 5; f.y = 5; f.a = 0; f.speed = 0;
  run(g, { up: true }, 5);
  const lowSpeed = f.speed;

  const h = newGame(1);
  flatWorld(h);
  h.H = 5;
  const hf = h.fl;
  hf.x = 5; hf.y = 5; hf.a = 0; hf.speed = 0;
  run(h, { up: true }, 5);
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
  const { lowestUnscored } = await import('../js/highscores.js');
  const st2 = { d: {}, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = v; } };
  assert.strictEqual(lowestUnscored(st2, 5), 1);
  saveBest(st2, 5, 1, { score: 10, time: 5, name: 'a' });
  saveBest(st2, 5, 3, { score: 10, time: 5, name: 'a' });
  saveBest(st2, 6, 2, { score: 10, time: 5, name: 'a' });
  assert.strictEqual(lowestUnscored(st2, 5), 2);
  assert.strictEqual(lowestUnscored(st2, 6), 1);
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

// Spawn/parking varies per level and is axis-aligned and inside the walls.
{
  const starts = new Set();
  for (let n = 1; n <= 8; n++) {
    const l = generateLevel(n);
    starts.add(`${l.start.x.toFixed(1)},${l.start.y.toFixed(1)}`);
    assert.ok(Math.abs(Math.sin(2 * l.start.a)) < 1e-9, 'start heading is axis-aligned');
    assert.ok(newGame(n) && isParked(newGame(n)), 'spawns parked');
  }
  assert.ok(starts.size > 1, 'spawn point varies');
  console.log('spawn ok');
}

// A released stack is drawn lowering (dropFrom) until the forks reach the floor.
{
  const g = newGame(1);
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
  for (let i = 0; i < 10; i++) d.frame(i * 16.7, 2, 0.5, 1);
  const lines = d.lines(newGame(1), { width: 800, height: 600, dpr: 1 });
  assert.ok(lines[0].startsWith('FPS 60'), lines[0]);
  assert.ok(lines[2].startsWith('time share'), lines[2]);
  assert.ok(lines[2].includes('update   3%') && lines[2].includes('draw   6%') && lines[2].includes('idle  91%'), lines[2]);
  assert.ok(lines[4].includes('boxes in place 0/'), lines[4]);
}

// Reversing light: only when reversing, and never reaches past a wall.
{
  const g = newGame(1);
  assert.equal(reverseLight(g), null, 'no light when stationary');
  g.fl.speed = -1;
  const L = reverseLight(g);
  assert.ok(L && L.pts.every((p) => Math.hypot(p.x - L.x, p.y - L.y) <= REV_RADIUS + 1e-9));
  g.fl.speed = 1;
  assert.equal(reverseLight(g), null, 'no light driving forward');
  // Light centre 0.5 from the right border wall, rear pointing at it.
  const wall = g.walls.reduce((b, w) => (w.x > b.x ? w : b));
  g.fl.a = Math.PI; g.fl.y = g.h / 2; g.fl.speed = -1;
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
  assert(Math.abs(g.time - 1) < 0.05);
  g.status = 'won';
  const t = g.time;
  run(g, {}, 1);
  assert.strictEqual(g.time, t);
  assert.strictEqual(newGame(2).time, 0);
  console.log('timer stops on win ok');
}

{
  const { parseMidi } = await import('../js/midi.js');
  const { readFileSync, readdirSync } = await import('node:fs');
  const files = readdirSync(new URL('../assets/midi/', import.meta.url)).filter((f) => f.endsWith('.mid'));
  assert.ok(files.length >= 13);
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
