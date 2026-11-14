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

// Damage to a loose stack lowers the score right away (negative before anything is on a drop point).
{
  const g = newGame(1);
  assert.equal(score(g), 0);
  g.stacks[0].pen[0].crash = 30;
  assert.equal(score(g), -30, 'damage shows before the stack is dropped');
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


console.log('score tests passed');
