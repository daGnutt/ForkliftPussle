import assert from 'node:assert/strict';
import { BARREL_COLOR, generateLevel, parseSeed, isReachable } from '../js/level.js';
import { pointRectDist, zoneExt } from '../js/geom.js';
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
    const { x: ex, y: ey } = zoneExt(z);
    assert.ok(l.areas.some((a) => a.color === z.color && z.x - ex >= a.x - 1e-9 && z.x + ex <= a.x + a.w + 1e-9 &&
      z.y - ey >= a.y - 1e-9 && z.y + ey <= a.y + a.h + 1e-9), `level ${n} zone in an area of its colour`);
  }
  assert.equal(new Set(l.zones.map((z) => z.color)).size, new Set(l.areas.map((a) => a.color)).size, `level ${n} area per colour`);
  for (const a of l.areas) assert.ok(l.zones.some((z) => z.color === a.color), `level ${n} no empty area`);
}

// Drop points of a drop-off area: the tallest stacks sit furthest back, towards the outer wall nearest the area (levels 1-2 have no barrel/wide swaps).
for (let n = 1; n <= 2; n++) {
  const l = generateLevel(n);
  for (const a of l.areas) {
    const gaps = [a.x, l.w - a.x - a.w, a.y, l.h - a.y - a.h], back = gaps.indexOf(Math.min(...gaps));
    const depth = (z) => [z.x, l.w - z.x, z.y, l.h - z.y][back];
    const zs = l.zones.filter((z) => z.color === a.color);
    for (const p of zs) for (const q of zs) if (p.count > q.count) assert.ok(depth(p) <= depth(q) + 1e-9, `level ${n} tallest drop point furthest back`);
  }
}

// Colour areas are fitted to their drop points (barrel/wide swaps remove some), so a lone drop point stands against the wall with no empty area.
for (let n = 1; n <= 40; n++) {
  const l = generateLevel(n);
  for (const a of l.areas.filter((o) => o.color < 5)) {
    const zs = l.zones.filter((z) => z.color === a.color);
    const minX = Math.min(...zs.map((z) => z.x - zoneExt(z).x)), maxX = Math.max(...zs.map((z) => z.x + zoneExt(z).x));
    const minY = Math.min(...zs.map((z) => z.y - zoneExt(z).y)), maxY = Math.max(...zs.map((z) => z.y + zoneExt(z).y));
    assert.ok(Math.abs(a.x - minX) < 1e-9 && Math.abs(a.w - (maxX - minX)) < 1e-9, `level ${n} area width fits its drop points`);
    assert.ok(Math.abs(a.y - minY) < 1e-9 && Math.abs(a.h - (maxY - minY)) < 1e-9, `level ${n} area height fits its drop points`);
  }
}

// Generator: counts match, nothing overlaps walls, deterministic.
for (let n = 1; n <= 40; n++) {
  const l = generateLevel(n);
  const boxes = l.stacks.flatMap((s) => s.layers);
  const zoneBoxes = l.zones.reduce((a, z) => a + z.count, 0);
  const barrels = l.stacks.filter((s) => Number.isInteger(s.barrelAt));
  assert.equal(boxes.length - barrels.length, zoneBoxes, `level ${n} box/barrel unit count`);
  assert.equal(l.zones.filter((z) => z.color === BARREL_COLOR).length, barrels.length, `level ${n} one barrel zone per barrel`);
  assert.ok(l.zones.filter((z) => z.color === BARREL_COLOR).every((z) => z.count === 1), `level ${n} barrel zones count barrels`);
  assert.ok(barrels.every((s) => s.barrelAt + 2 === s.layers.length), `level ${n} barrels are never covered by boxes`);
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

// Wide pallets need an aligned corridor to back out, not just a reachable nearby cell.
{
  const zone = { x: 8, y: 8, wide: true, a: 0 };
  const wall = (x) => ({ x, y: 7, w: 0.5, h: 2 });
  const lvl = { w: 16, h: 16, start: { x: 2, y: 2 }, stacks: [], zones: [zone], walls: [] };
  assert.ok(isReachable(lvl), 'open approach');
  lvl.walls = [wall(5), wall(11)];
  assert.ok(!isReachable(lvl), 'walls block both aligned approaches despite nearby reachable floor');
  lvl.walls.pop();
  assert.ok(isReachable(lvl), 'one unobstructed approach is enough');
  lvl.zones.push({ x: 11, y: 8 });
  assert.ok(!isReachable(lvl), 'an already-filled neighbouring drop point blocks the other approach');
  lvl.zones.pop();
  lvl.walls = [];
  zone.x = 2;
  lvl.walls.push(wall(5));
  assert.ok(!isReachable(lvl), 'map edge blocks the other approach');
  zone.x = 8;
  zone.a = Math.PI / 2;
  assert.ok(isReachable(lvl), 'rotated pallet uses the perpendicular approach');
  lvl.stacks.push({ x: 8, y: 8, wide: true, a: 0 });
  lvl.walls = [wall(5), wall(11)];
  assert.ok(!isReachable(lvl), 'wide starting stacks also need an aligned pickup corridor');
}

// Level 28: on hard mode each wide drop can be released and reversed out of,
// even with every other drop point already filled.
{
  const layout = generateLevel(28);
  const wide = layout.zones.filter((z) => z.wide);
  assert.ok(wide.length, 'level 28 retains wide drop points');
  for (const z of wide) {
    const canDrop = (heading) => {
      const g = newGame(28, 0, true);
      g.stacks = layout.zones.map((q) => wonkyStack({
        x: q.x, y: q.y, layers: Array(q.count).fill(q.color), wide: q.wide, a: q.a || 0,
      }));
      const f = g.fl;
      f.a = heading;
      f.x = z.x - FL.carryX * Math.cos(heading);
      f.y = z.y - FL.carryX * Math.sin(heading);
      if (forkUp(g) === 'blocked' || !g.carried) return false;
      forkDown(g);
      if (g.carried || !zoneDone(g, z)) return false;
      const x = f.x, y = f.y;
      for (let i = 0; i < 240 && Math.hypot(f.x - x, f.y - y) < 1.2; i++) update(g, { down: true }, 1 / 120);
      return Math.hypot(f.x - x, f.y - y) >= 1.2 && zoneDone(g, z) &&
        Math.abs((f.x - x) * Math.sin(heading) - (f.y - y) * Math.cos(heading)) < 0.1;
    };
    assert.ok(canDrop(z.a) || canDrop(z.a + Math.PI), 'hard-mode wide drop and straight reverse are possible');
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
  for (const n of [3, 10, 20, 28, 40]) for (const seed of [-7, 42, 101]) {
    const layout = generateLevel(n, seed);
    assert.ok(isReachable(layout), `level ${n}, seed ${seed} satisfies clearance checks`);
    const wideBoxes = layout.stacks.filter((s) => s.wide).reduce((sum, s) => sum + s.layers.length, 0);
    const wideTargets = layout.zones.filter((z) => z.wide).reduce((sum, z) => sum + z.count, 0);
    assert.equal(wideBoxes, wideTargets, `level ${n}, seed ${seed} wide boxes match targets`);
  }
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
