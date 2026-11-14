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

// Every zone sits inside a drop-off area of its colour (wide zones have an area of their own), clear of other areas.
for (let n = 1; n <= 40; n++) {
  const l = generateLevel(n);
  for (const z of l.zones) {
    const ex = z.hx ?? 0.6, ey = z.hy ?? 0.6;
    assert.ok(l.areas.some((a) => a.color === z.color && z.x - ex >= a.x - 1e-9 && z.x + ex <= a.x + a.w + 1e-9 &&
      z.y - ey >= a.y - 1e-9 && z.y + ey <= a.y + a.h + 1e-9), `level ${n} zone in an area of its colour`);
  }
  assert.equal(new Set(l.zones.map((z) => z.color)).size, new Set(l.areas.map((a) => a.color)).size, `level ${n} area per colour`);
  for (const a of l.areas) assert.ok(l.zones.some((z) => z.color === a.color), `level ${n} no empty area`);
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


// seeds: deterministic, differ from default, 0 = default
{
  assert.deepEqual(generateLevel(3, 42), generateLevel(3, 42), 'seeded level deterministic');
  assert.deepEqual(generateLevel(3, 0), generateLevel(3), 'seed 0 is default');
  assert.notDeepEqual(generateLevel(3, 42).stacks, generateLevel(3).stacks, 'seed changes layout');
  assert.equal(parseSeed('42'), 42);
  assert.equal(parseSeed('abc'), parseSeed('abc'));
  assert.equal(newGame(2, 7).seed, 7);
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


console.log('level tests passed');
