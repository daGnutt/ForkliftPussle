import assert from 'node:assert/strict';
import { generateLevel, parseSeed, isReachable, BARREL_COLOR } from '../js/level.js';
import { pointRectDist } from '../js/geom.js';
import { FL, toLocal, toWorld, maxSteerFor } from '../js/forklift.js';
import { repairHintWanted } from '../js/repairhint.js';
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
import { rectPoly, sat, overlapArea, halfY, palletRunnerDims } from '../js/geom.js';
import { TRUCK_BONUS, lorryHonks, newEndless, stepEndless, endEndless, rampDecals, truckRoofs, numberRects, dockWaits, truckGeom, unloadRate, interval, endlessScore, animatedDoors } from '../js/endless.js';
import { newGame, update, addTruck, removeTruck, truckView, isGhost, ghostBetween, forkUp, forkDown, stackInZone, isParked, isFinished, score, maxScore, lostBreakdown, zoneWonky, zoneDone, zonePoints, zoneLabelPos, stackZ, wonkyStack, fallView, carriedJoltZ, crashAlert, crashBlink, crashProbes, alertTriggers } from '../js/game.js';

import { stackSig } from '../js/bot.js';
import { NONE, pts, run, faceStack, flatWorld, driveUntil } from './common.js';

// A displaced box rides the forks only when both tines catch it.
{
  const push = (y) => {
    const g = newGame(1, 0, true);
    flatWorld(g);
    g.H = 1;
    g.stacks = [{ x: 10, y: 5, layers: [0, 1], rots: [0, 0], a: 0,
      offs: [{ x: 0, y: 0 }, { x: 0, y: 0 }], pen: [{ crash: 0, sq: 0 }, { crash: 0, sq: 0 }] }];
    Object.assign(g.fl, { x: 7.6, y, a: 0, speed: 0 });
    for (let i = 0; i < 360 && !g.carried && !g.stacks.some((s) => s.fall); i++) {
      g.fl.speed = 1.5;
      update(g, { up: true }, 1 / 120);
    }
    return g;
  };
  const caught = push(5.08);
  assert.deepEqual(caught.carried, [1], 'the displaced upper box is caught');
  assert.equal(caught.stacks[0].layers.length, 1, 'the lower box remains on the floor');
  assert.ok(caught.carriedOffs[0].x || caught.carriedOffs[0].y, 'the caught box keeps its offset on the forks');
  const before = toWorld(caught.fl, FL.carryX + caught.carriedOffs[0].x, caught.carriedOffs[0].y);
  caught.fl.speed = 1;
  update(caught, { up: true }, 1 / 120);
  const after = toWorld(caught.fl, FL.carryX + caught.carriedOffs[0].x, caught.carriedOffs[0].y);
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) > 0.001, 'the caught box moves with the forklift');
  const missed = push(5.6);
  assert.equal(missed.carried, null, 'a box outside the tine footprint is not caught');
  assert.ok(missed.stacks.some((s) => s.fall), 'the missed box falls normally');
}

// A full-size carried crate pushes a neighbouring stack less than one tile from its path.
{
  const g = newGame(1, 0, true);
  flatWorld(g);
  g.zones = [{ x: 12, y: 5, count: 1, color: 0 }];
  const neighbour = { x: 12.4, y: 5.95, a: 0, layers: [1] };
  g.stacks = [{ x: 9, y: 5, a: 0, layers: [0] }, neighbour];
  Object.assign(g.fl, { x: 7, y: 5, a: 0, speed: 0 });
  driveUntil(g, 9, 7.5);
  forkUp(g);
  assert.deepEqual(g.carried, [0]);
  driveUntil(g, 12, 10.5);
  forkDown(g);
  update(g, NONE, 1 / 120);
  assert.ok(zoneDone(g, g.zones[0]));
  assert.ok(neighbour.y > 5.95, 'the full-size crate pushes the overlapping adjacent stack');
}

// Full-size wide pallets leave both tine slots open on a straight approach.
{
  const g = newGame(1, 0, true);
  flatWorld(g);
  const wide = { x: 10, y: 5, a: 0, layers: [5], pen: [{ wide: true, crash: 0, sq: 0 }] };
  g.stacks = [wide];
  Object.assign(g.fl, { x: 8, y: 5, a: 0, speed: 0 });
  driveUntil(g, 10, 8.5);
  assert.equal(wide.x, 10, 'the forks did not push the wide pallet');
  forkUp(g);
  assert.deepEqual(g.carried, [5]);
}

// A slow front/mast nudge squares boxes through one level above the forks and carries that turn into higher boxes.
{
  const g = newGame(1);
  flatWorld(g);
  const rots = [0.35, 0.4, 0.45, 0.3, 0.7];
  g.stacks = [{ x: 9.2, y: 5, layers: [0, 1, 2, 3, 4], rots: [...rots], pen: Array.from({ length: 5 }, () => ({ crash: 0, sq: 0 })), a: rots[0] }];
  g.H = 1;
  const f = g.fl;
  f.x = 7; f.y = 5; f.a = 0; f.speed = 0;
  for (let i = 0; i < 600; i++) {
    f.speed = Math.min(f.speed + 0.01, 0.5);
    update(g, { up: true }, 1 / 120);
    if (f.speed > 0.6) f.speed = 0.5;
  }
  const s = g.stacks[0];
  assert.ok(s.rots.slice(0, 3).every((r) => Math.abs(r) < 0.01), 'levels 0 through H+1 turn square to the forklift');
  assert.ok(s.rots.slice(3).every((r, i) => Math.abs((r - rots[i + 3]) - (s.rots[2] - rots[2])) < 0.01), 'all boxes above H+1 follow the same turn as the box beneath them');
  assert.ok(Math.abs(s.a) < 0.01, 'the bottom box turns square with the stack');
  assert.equal(s.pen[0].crash, 0, 'nudging does not damage the bottom box');
  assert.equal(s.pen[1].crash, 0, 'upper box undamaged');
  console.log('box-align ok');
}

// Hard-mode tines push and torque the boxes at fork level and above without automatic squaring.
{
  const g = newGame(1, 0, true);
  flatWorld(g);
  g.H = 2;
  const rots = [0.1, 0.2, 0.3, 0.35, 0.75];
  g.stacks = [{ x: 10, y: 5, layers: [0, 1, 2, 3, 4], rots: [...rots], pen: Array.from({ length: 5 }, () => ({ crash: 0, sq: 0 })), a: rots[0] }];
  Object.assign(g.fl, { x: 7.9, y: 5, a: 0, speed: 0 });
  run(g, { thr: 0.1 }, 1);
  const s = g.stacks[0];
  assert.ok(g.fl.x + FL.front < s.x - 0.5, 'the front/mast has not contacted the stack');
  assert.equal(s.layers.length, 5, 'the stack remains intact');
  assert.ok(s.rots.slice(0, 2).every((r, i) => Math.abs(r - rots[i]) < 0.01), 'boxes below the tines keep their angle');
  const turn = s.rots[2] - rots[2];
  assert.ok(Math.abs(turn) > 0.02 && Math.abs(s.rots[2]) > 0.2, 'tine contact rotates the box at fork level instead of squaring it');
  assert.ok(s.rots.slice(3).every((r, i) => Math.abs((r - rots[i + 3]) - turn) < 0.01), 'upper boxes follow the physical turn without aligning independently');
  assert.ok(s.offs.slice(2).some((o) => Math.hypot(o.x, o.y) > 0.05), 'tines push the boxes at and above fork level');
  assert.ok(s.pen.every((p) => p.crash === 0), 'slow tine contact does not damage the stack');
}

// Boxes that topple off a stack tumble visually: the logical stack is at its landing spot at once, fallView interpolates.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0, 1], rots: [0, 0], pen: [{ crash: 0, sq: 0 }, { crash: 0, sq: 0 }], a: 0, offs: [{ x: 0, y: 0 }, { x: 0.45, y: 0 }] }];
  g.fl.x = 8; g.fl.y = 5; g.fl.a = 0; g.fl.speed = 0;
  let fallen;
  for (let i = 0; i < 600 && !fallen; i++) {
    g.fl.speed = 2;
    update(g, { up: true }, 1 / 120);
    fallen = g.stacks.find((s) => s.fall);
  }
  assert.ok(fallen, 'a box toppled');
  const v = fallView(g, fallen);
  assert.ok(v.fallZ > 0 && Math.hypot(v.x - fallen.x, v.y - fallen.y) > 0.1, 'fallen box starts away from its landing spot');
  for (let i = 0; i < 90; i++) update(g, {}, 1 / 120);
  assert.equal(fallen.fall, undefined, 'animation ends');
  assert.equal(fallView(g, fallen), fallen);
  console.log('fall-anim ok');
}

// Pushing a stack gently into a wall squares it to the wall; a hard shove snags it and spins it.
{
  const mk = () => {
    const g = newGame(1);
    flatWorld(g);
    g.walls = [{ x: 12, y: 0, w: 1, h: 20, poly: [{ x: 12, y: 0 }, { x: 13, y: 0 }, { x: 13, y: 20 }, { x: 12, y: 20 }] }];
    g.stacks = [{ x: 11, y: 5, layers: [0], rots: [0.3], pen: [{ crash: 0, sq: 0 }], a: 0.3 }];
    g.fl.x = 8.5; g.fl.y = 5; g.fl.a = 0; g.fl.speed = 0;
    return g;
  };
  const g = mk();
  for (let i = 0; i < 900; i++) {
    g.fl.speed = Math.min(g.fl.speed + 0.01, 0.4);
    update(g, { up: true }, 1 / 120);
    if (g.fl.speed > 0.5) g.fl.speed = 0.4;
  }
  assert.ok(Math.abs(g.stacks[0].a) < 0.02, 'gentle push squares the stack to the wall');
  const h = mk();
  h.stacks[0].rots = [0.15]; h.stacks[0].a = 0.15;
  for (let i = 0; i < 300; i++) {
    h.fl.speed = 3;
    update(h, { up: true }, 1 / 120);
  }
  assert.ok(Math.abs(h.stacks[0].a - 0.15) > 0.02, 'hard shove spins the stack');
  // a carried stack pressed gently against a wall squares up to it on the forks
  const c = mk();
  c.stacks = [];
  c.fl.x = 10; c.fl.a = 0.2; c.fl.speed = 0;
  c.carried = [0]; c.carriedRel = 0; c.carriedRots = [0]; c.carriedPen = [{ crash: 0, sq: 0 }]; c.carriedOffs = [{ x: 0, y: 0 }];
  for (let i = 0; i < 600; i++) {
    c.fl.speed = Math.min(c.fl.speed + 0.01, 0.4);
    update(c, { up: true }, 1 / 120);
  }
  assert.ok(Math.abs(c.fl.a + c.carriedRel) < 0.05, 'carried stack squares to the wall on the forks');
  console.log('wall-align ok');
}

// Wall contact slides protruding carried boxes back without clipping or gentle-contact damage.
{
  const g = newGame(10, 0, true);
  g.stacks = []; g.zones = []; g.bot = null; g.inspector = null; g.repair = null;
  Object.assign(g.fl, { x: 10.045584556050366, y: 15.206415970192738, a: 21.965472688463088, speed: 0, steer: 0 });
  g.H = 1; g.hf = 1;
  g.carried = [4, 0]; g.carriedRel = -22.019411022077236;
  g.carriedRots = [-22.019411022077236, -21.943390779548526];
  g.carriedOffs = [{ x: 0.4451031871673399, y: -0.051937301654630064 }, { x: 0.851283635704168, y: 0.037105325895694596 }];
  g.carriedPen = [{ crash: 0, sq: 0 }, { crash: 0, sq: 0 }];
  const polys = () => g.carried.map((_, i) => {
    const o = g.carriedOffs[i], c = toWorld(g.fl, FL.carryX + o.x, o.y);
    return rectPoly(c.x, c.y, 0.5, halfY(g.carriedPen[i]), g.fl.a + g.carriedRots[i]);
  });
  assert.ok(g.walls.some((w) => (sat(polys()[1], w.poly)?.depth || 0) > 0.3), 'saved upper box starts inside the wall');
  const bottom = { ...g.carriedOffs[0] }, x = g.fl.x;
  update(g, NONE, 1 / 120);
  assert.ok(g.carriedOffs[1].x < 0.6, 'the upper box slides toward the forklift');
  assert.deepEqual(g.carriedOffs[0], bottom, 'upper contact does not slide the bottom box');
  assert.ok(Math.abs(g.fl.x - x) < 1e-6, 'repairing the upper overlap need not shove the truck');
  for (let i = 0; i < 720; i++) {
    g.fl.speed = 0.3;
    update(g, NONE, 1 / 120);
    const p = polys();
    assert.ok(p.every((poly) => g.walls.every((w) => (sat(poly, w.poly)?.depth || 0) < 1e-6)), 'every carried box clears walls after each step');
    assert.ok(overlapArea(p[0], p[1]) >= 0.5 - 1e-6, 'gentle sliding preserves upper-box support');
    assert.ok(g.carriedPen.every((pen) => pen.crash === 0 && !pen.dent), 'gentle pushing never damages or dents the boxes');
  }
  const beforeDrop = polys().map((p) => p.map((v) => ({ ...v })));
  forkDown(g);
  assert.equal(g.carried, null, 'the adjusted load can be put down');
  const s = g.stacks[0];
  s.layers.forEach((_, i) => {
    const p = rectPoly(s.x + s.offs[i].x, s.y + s.offs[i].y, 0.5, halfY(s.pen[i]), s.rots[i]);
    p.forEach((v, k) => assert.ok(Math.hypot(v.x - beforeDrop[i][k].x, v.y - beforeDrop[i][k].y) < 1e-8, 'set-down keeps each box position'));
  });
}

// Sliding stops at the mast/support limits, including corners, wide pallets and rigid barrels.
{
  const mk = (pens, angle = 0) => {
    const g = newGame(1);
    g.stacks = []; g.zones = []; g.bot = null; g.inspector = null; g.repair = null;
    g.walls = [{ x: 12, y: 0, w: 1, h: 20, poly: rectPoly(12.5, 10, 0.5, 10) }];
    Object.assign(g.fl, { x: 10.6, y: 5, a: angle, speed: 0, steer: 0 });
    g.H = 1; g.hf = 1;
    g.carried = pens.map(() => 0); g.carriedRel = 0;
    g.carriedRots = pens.map(() => 0);
    g.carriedOffs = pens.map((_, i) => ({ x: i * 0.3, y: 0 }));
    g.carriedPen = pens.map((p) => ({ crash: 0, sq: 0, ...p }));
    return g;
  };
  const check = (g) => {
    const polys = g.carried.map((_, i) => {
      const o = g.carriedOffs[i], c = toWorld(g.fl, FL.carryX + o.x, o.y);
      return rectPoly(c.x, c.y, 0.5, halfY(g.carriedPen[i]), g.fl.a + g.carriedRots[i]);
    });
    polys.forEach((p, i) => {
      assert.ok(g.walls.every((w) => (sat(p, w.poly)?.depth || 0) < 1e-6), 'every layer clears its wall blockers');
      assert.ok(p.every((v) => toLocal(g.fl, v.x, v.y).x >= FL.front - 1e-6), 'no carried box passes through the mast');
      if (i > 0) assert.ok(overlapArea(p, polys[i - 1]) >= 0.5 * (g.carriedPen[i].wide ? 2 : 1) - 1e-6, 'upper layers stay supported');
    });
    assert.ok(g.carriedPen.every((p) => p.crash === 0 && !p.dent), 'slow contacts add no damage or dents');
  };
  const plain = mk([{}, {}]);
  plain.carriedOffs.forEach((o) => { o.x += 0.3; });
  const corner = mk([{}, {}], 0.2);
  corner.walls.push({ x: 0, y: 6, w: 20, h: 1, poly: rectPoly(10, 6.5, 10, 0.5) });
  const wide = mk([{ wide: true }, { wide: true }], 0.12);
  const barrel = mk([{ barrelPart: 'base' }, { barrelPart: 'top' }]);
  barrel.carriedOffs[1] = { ...barrel.carriedOffs[0] };
  const mast = mk([{}, {}], 0.12);
  mast.carriedOffs[1] = { x: 0, y: 0 }; mast.carriedRots[1] = 0.35;
  for (const g of [plain, corner, wide, barrel, mast]) {
    for (let i = 0; i < 600; i++) {
      g.fl.speed = 0.3;
      update(g, NONE, 1 / 120);
      check(g);
    }
  }
  assert.ok(plain.carriedOffs[0].x < 0.1, 'bottom contact slides the protruding load backward on the forks');
  assert.ok(plain.fl.x < 11, 'the truck cannot keep advancing once sliding room runs out');
  assert.deepEqual(barrel.carriedOffs[0], barrel.carriedOffs[1], 'the two barrel layers slide together');
  assert.equal(barrel.carriedRots[0], barrel.carriedRots[1], 'the barrel remains rigid while turning');
  assert.ok(mast.carriedOffs[1].x < 0, 'the angled upper box uses the sliding room in front of the mast');

  const fast = mk([{}, {}]);
  fast.fl.speed = 2.5;
  update(fast, NONE, 1 / 120);
  assert.ok(fast.carriedPen.every((p) => p.crash > 0 && p.dent), 'fast wall impacts still damage the carried load');
}

// Offset upper boxes of floor stacks cannot clip through walls either.
{
  const g = newGame(1);
  g.zones = []; g.bot = null; g.inspector = null; g.repair = null;
  g.walls = [{ x: 12, y: 0, w: 1, h: 20, poly: rectPoly(12.5, 10, 0.5, 10) }];
  g.stacks = [{ x: 11.45, y: 5, layers: [0, 1], a: 0, rots: [0, 0.2],
    offs: [{ x: 0, y: 0 }, { x: 0.25, y: 0 }], pen: [{ crash: 0, sq: 0 }, { crash: 0, sq: 0 }] }];
  Object.assign(g.fl, { x: 8.5, y: 5, a: 0, speed: 0, steer: 0 });
  update(g, NONE, 1 / 120);
  const s = g.stacks[0];
  assert.equal(s.x, 11.45, 'the upper-box wall correction need not move the bottom box');
  assert.ok(s.offs[1].x < 0.1, 'the protruding upper box slides back over its support');
  for (let i = 0; i < 1200; i++) {
    g.fl.speed = 0.3;
    update(g, NONE, 1 / 120);
    assert.equal(g.stacks.length, 1, 'gentle wall contact does not topple boxes');
    const polys = s.layers.map((_, j) => rectPoly(s.x + s.offs[j].x, s.y + s.offs[j].y, 0.5, 0.5, s.rots[j]));
    assert.ok(polys.every((p) => g.walls.every((w) => (sat(p, w.poly)?.depth || 0) < 1e-6)), 'all floor-stack layers remain outside walls');
    assert.ok(overlapArea(polys[0], polys[1]) >= 0.5 - 1e-6, 'the upper floor box retains support');
    assert.ok(s.pen.every((p) => p.crash === 0 && !p.dent), 'gentle floor-stack contacts cause no damage');
  }
}

// A later multiplayer horn cannot leave an already-stepped truck's upper load inside a wall.
{
  const g = newGame(1);
  g.stacks = []; g.zones = []; g.bot = null; g.inspector = null; g.repair = null;
  g.walls = [{ x: 12, y: 0, w: 1, h: 20, poly: rectPoly(12.5, 10, 0.5, 10) }];
  Object.assign(g.fl, { x: 10.49, y: 5, a: 0, speed: 0, steer: 0 });
  g.H = 1; g.carried = [0, 1]; g.carriedRel = 0; g.carriedRots = [0, 0];
  g.carriedOffs = [{ x: 0, y: 0 }, { x: 0.049, y: 0 }];
  g.carriedPen = [{ crash: 0, sq: 0 }, { crash: 0, sq: 0 }];
  const id = addTruck(g, 'horn'), other = truckView(g, id);
  Object.assign(other.fl, { x: 10.3, y: 6.4, a: 0, speed: 0, steer: 0 });
  for (let i = 0; i < 600; i++) {
    other.truck.input = { horn: i % 60 === 0 };
    update(g, NONE, 1 / 120);
    g.carried.forEach((_, j) => {
      const o = g.carriedOffs[j], c = toWorld(g.fl, FL.carryX + o.x, o.y);
      const p = rectPoly(c.x, c.y, 0.5, 0.5, g.fl.a + g.carriedRots[j]);
      assert.ok(g.walls.every((w) => (sat(p, w.poly)?.depth || 0) < 1e-6), 'multiplayer horn leaves every carried box clear of walls');
    });
    assert.ok(g.carriedPen.every((p) => p.crash === 0 && !p.dent), 'horn-induced clearance adds no damage');
  }
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

// A crooked pallet caught by both tines must not jump ahead while the truck creeps forward.
{
  for (const side of [-1, 1]) for (const thr of [0.1, 0.2]) {
    const g = newGame(44, 0, true);
    g.zones = []; g.walls = [];
    Object.assign(g.fl, { x: 15, y: 8, a: 0, speed: 0, steer: 0 });
    const angle = side * 0.314868433;
    const s = { x: 16.5921463346, y: 8 + side * 0.1064773491,
      layers: [0, 2], rots: [angle, side * 0.4249593], a: angle };
    g.stacks = [s];
    for (let i = 0; i < 120; i++) {
      const before = toLocal(g.fl, s.x, s.y);
      update(g, { thr }, 1 / 120);
      const after = toLocal(g.fl, s.x, s.y);
      assert.ok(after.x - before.x < 1e-5, 'the pallet does not jump ahead of the truck');
      for (const off of [-FL.tineOff, FL.tineOff]) {
        const c = toWorld(g.fl, (FL.tineX0 + FL.tineX1) / 2, off);
        const tine = rectPoly(c.x, c.y, (FL.tineX1 - FL.tineX0) / 2, FL.tineHalf, g.fl.a);
        for (const [y, half] of palletRunnerDims(s.pen[0])) {
          const r = toWorld(s, 0, y);
          const runner = rectPoly(r.x, r.y, 0.5, half, s.a);
          assert.ok((sat(tine, runner)?.depth || 0) < 1e-4, 'the tines do not clip through the runners');
        }
      }
    }
    assert.ok(Math.abs(s.a) < Math.abs(angle), 'contact still turns the pallet towards the forks');
    assert.ok(s.pen.every((p) => p.crash === 0), 'gentle contact does not damage the stack');
  }
}

// A slow off-centre push against a pallet's closed side turns it clockwise, even when square to the truck.
{
  for (const speed of [0.02, 0.3]) {
    const g = newGame(9, 0, true), rotation = 2.637474002998607;
    const s = { x: 17.161711292836376, y: 5.845426538217926, layers: [1, 2],
      rots: [rotation, rotation], a: rotation, offs: [{ x: 0, y: 0 }, { x: -0.02722295492130797, y: -0.04391507610620465 }] };
    g.stacks = [s];
    Object.assign(g.fl, { x: 17.63925829868377, y: 7.866128459991518, a: 4.208270329793503, speed: 0, steer: 0 });
    for (let i = 0; i < 120; i++) {
      g.fl.speed = speed;
      update(g, { thr: speed * 0.1 / 3.2 }, 1 / 120);
    }
    assert.ok(s.rots[0] > rotation + 0.005, 'off-centre tine contact rotates the pallet clockwise');
    assert.equal(s.rots[1], s.rots[0], 'the box above follows the pallet rotation');
    assert.ok(s.pen.every((p) => p.crash === 0), 'gentle side contact does not damage the boxes');
  }
}

// Mirrored closed-side tine pushes produce opposite rotations instead of snapping square.
{
  for (const side of [-1, 1]) {
    const g = newGame(1, 0, true);
    flatWorld(g);
    const s = { x: 10, y: 5 + side * 0.558, layers: [0], rots: [Math.PI / 2], a: Math.PI / 2 };
    g.stacks = [s];
    Object.assign(g.fl, { x: 8, y: 5, a: 0, speed: 0, steer: 0 });
    for (let i = 0; i < 120; i++) {
      g.fl.speed = 0.3;
      update(g, { thr: 0.3 * 0.1 / 3.2 }, 1 / 120);
    }
    assert.ok(side * (s.rots[0] - Math.PI / 2) > 0.05, 'rotation follows the side of the push');
  }
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

// Fork contact damages only the pallet at tine height, at every impact speed.
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
  assert.ok(slow[1] > 0 && slow[0] === 0 && slow[2] === 0, 'slow: only box at the forks');
  assert.ok(fast[1] > 0 && fast[0] === 0 && fast[2] === 0, 'fast: still only box at the forks');
}

// Hard-mode pallets shrug off light impacts and take less damage from harder impacts.
{
  const damage = (hard, speed) => {
    const g = newGame(1, 0, hard);
    flatWorld(g);
    const pen = { crash: 0, sq: 0 };
    g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0], pen: [pen], a: 0 }];
    Object.assign(g.fl, { x: 8.5, y: 5, a: 0, speed });
    for (let i = 0; i < 120 && pen.crash === 0; i++) {
      g.fl.speed = speed;
      update(g, { up: true }, 1 / 120);
    }
    return pen.crash;
  };
  assert.ok(damage(true, 3) < damage(false, 3), 'hard-mode pallet cushions a hard bump');
  assert.equal(damage(false, 1), 1, 'a standard-mode bump still damages the pallet');
  assert.equal(damage(true, 1), 0, 'a light hard-mode bump does not damage the pallet');
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

// Level-0 tines (beside an offset box) don't push the box on level 1 away.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0, 1], rots: [0, 0], a: 0, offs: [{ x: 0, y: 0 }, { x: 0, y: 0.4 }] }];
  g.fl.a = 0; g.fl.x = 7; g.fl.y = 5;
  for (let i = 0; i < 300; i++) { g.fl.speed = 0.8; update(g, { up: true }, 1 / 120); }
  assert.equal(g.stacks.length, 1, 'the offset box stays on its stack');
}


// Open-top boxes: only on top of a stack, never more than stacks, nothing can be put on them.
{
  let seen = 0;
  for (let n = 1; n <= 40; n++) {
    const l = generateLevel(n);
    const open = l.stacks.filter((s) => s.open);
    seen += open.length;
    assert.ok(open.length <= l.stacks.length);
    [0, 1, 2, 3, 4].forEach((c) => assert.ok(open.filter((s) => s.layers[s.layers.length - 1] === c).length <= l.zones.filter((z) => z.color === c).length, `level ${n} open boxes fit zones`));
  }
  assert.ok(seen > 0, 'some levels have open-top boxes');
  assert.ok(generateLevel(1).stacks.every((s) => !s.open), 'none on level 1');

  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0] }, { x: 14, y: 5, layers: [1, 2], open: true }].map(wonkyStack);
  assert.equal(g.stacks[1].pen[1].open, true);
  assert.equal(g.stacks[1].pen[1].deco, 4, 'do-not-stack decal');
  assert.ok(!g.stacks[1].pen[0].open);
  const f = g.fl;
  f.x = 6; f.y = 5; f.a = 0; f.speed = 0;
  driveUntil(g, 10, 8);
  forkUp(g); forkUp(g); forkUp(g);
  driveUntil(g, 13.9, 12.4);
  forkDown(g); forkDown(g); forkDown(g);
  assert.deepEqual(g.carried, [0], 'cannot be put down on an open box');
  assert.deepEqual(g.stacks[0].layers, [1, 2]);
  assert.equal(g.H, 3);
  console.log('open-top boxes ok');
}


// Wide boxes (1×2): need both tines under them, only stack on each other, only fit wide zones.
{
  for (let n = 1; n <= 40; n++) {
    const l = generateLevel(n);
    const wide = l.stacks.filter((s) => s.wide), wz = l.zones.filter((z) => z.wide);
    assert.equal(wide.reduce((a, s) => a + s.layers.length, 0), wz.reduce((a, z) => a + z.count, 0), `level ${n} wide boxes match wide zones`);
    assert.ok(wide.every((s) => s.layers.every((c) => c === 5)) && wz.every((z) => z.color === 5), 'wide boxes and zones are gray');
    assert.equal(l.areas.filter((a) => a.color === 5).length, wz.length ? 1 : 0, 'wide zones share one area');
    if (n < 3) assert.equal(wide.length, 0);
  }
  assert.ok(generateLevel(20).stacks.some((s) => s.wide), 'later levels have wide boxes');

  const setup = (y) => {
    const g = newGame(1);
    flatWorld(g);
    g.stacks = [{ x: 10, y: 5, layers: [5], wide: true }].map(wonkyStack);
    const f = g.fl;
    f.x = 6; f.y = y; f.a = 0; f.speed = 0;
    return g;
  };
  assert.equal(setup(5).stacks[0].pen[0].wide, true);
  assert.equal(maxScore(setup(5)), 200, 'a wide box is worth two');

  const g = setup(5);
  driveUntil(g, 10, 8);
  assert.equal(stackInZone(g), g.stacks[0]);
  forkUp(g);
  assert.deepEqual(g.carried, [5], 'both tines under: lifted');
  assert.equal(g.stacks.length, 0);
  forkDown(g);
  assert.equal(g.carried, null, 'put down on the floor');
  assert.equal(g.stacks[0].pen[0].wide, true);

  const two = newGame(1);
  const z2 = { x: 10, y: 5, color: 5, count: 2, wide: true, hx: 0.6, hy: 1.1, a: 0 };
  two.zones = [z2];
  two.stacks = [{ x: 10, y: 5, layers: [5, 5], wide: true, a: 0 }].map(wonkyStack);
  assert.ok(zoneDone(two, z2) && two.stacks[0].pen.every((p) => p.wide), 'two stacked wide boxes fill a wide zone of two');
  assert.equal(maxScore(two), 400);
  two.stacks = [{ x: 10, y: 5, layers: [5], wide: true, a: 0 }].map(wonkyStack);
  assert.ok(!zoneDone(two, z2), 'one is not enough');

  const zones = [{ x: 10, y: 5, color: 5, count: 1 }, { x: 10, y: 5, color: 5, count: 1, wide: true, hx: 0.6, hy: 1.1, a: 0 }];
  const z = newGame(1);
  z.zones = zones;
  z.stacks = [{ x: 10, y: 5, layers: [5], wide: true, a: 0 }].map(wonkyStack);
  assert.ok(!zoneDone(z, zones[0]) && zoneDone(z, zones[1]), 'a wide box only fills a wide zone');
  z.stacks = [{ x: 10, y: 5, layers: [5], wide: true, a: Math.PI / 2 }].map(wonkyStack);
  assert.ok(!zoneDone(z, zones[1]), 'and only lined up with it');
  z.stacks = [{ x: 10, y: 5, layers: [5] }].map(wonkyStack);
  assert.ok(zoneDone(z, zones[0]) && !zoneDone(z, zones[1]), 'a normal box never fills a wide zone');

  const off = setup(5.9);
  driveUntil(off, 10, 8);
  assert.equal(stackInZone(off), null, 'only one tine under it: not found');
  forkUp(off);
  assert.equal(off.carried, null);

  const t2 = setup(5);
  t2.fl.a = 0.6;
  t2.fl.x = t2.stacks[0].x - Math.cos(0.6) * FL.carryX; t2.fl.y = t2.stacks[0].y - Math.sin(0.6) * FL.carryX;
  assert.equal(stackInZone(t2), t2.stacks[0]);
  assert.equal(forkUp(t2), 'blocked', 'a crooked approach does not get the tines under it');
  assert.equal(t2.carried, null);

  const h = setup(5);
  h.stacks.push(...[{ x: 14, y: 5, layers: [1] }].map(wonkyStack));
  driveUntil(h, 10, 8);
  forkUp(h);
  driveUntil(h, 13.9, 12.4);
  forkDown(h);
  assert.deepEqual(h.carried, [5], 'a wide box cannot be put down on another box');
  const w = setup(5);
  w.stacks.push(...[{ x: 14, y: 5, layers: [5], wide: true }].map(wonkyStack));
  driveUntil(w, 10, 8);
  forkUp(w);
  driveUntil(w, 13.9, 12.4);
  for (let i = 0; i < 4 && w.carried; i++) forkDown(w);
  assert.equal(w.carried, null, 'a wide box is put down on another wide box');
  assert.equal(w.stacks.length, 1);
  assert.deepEqual(w.stacks[0].layers, [5, 5]);
  assert.ok(w.stacks[0].pen.every((p) => p.wide));
  console.log('wide boxes ok');
}

// Honking jump-scares nearby stacks (and the one on the forks): boxes hop, shift and turn a little but never leave their stack.
{
  const g = newGame(1);
  flatWorld(g);
  const pen = () => ({ crash: 0, sq: 0 });
  g.fl.x = 5; g.fl.y = 5; g.fl.a = 0; g.fl.speed = 0;
  g.stacks = [
    { x: 7, y: 5, layers: [0, 1, 2, 3, 4], rots: [0, 0, 0, 0, 0], pen: [pen(), pen(), pen(), pen(), pen()], a: 0 },
    { x: 14, y: 5, layers: [0, 1], rots: [0, 0], pen: [pen(), pen()], a: 0 },
  ];
  run(g, NONE, 0.05);
  const far = JSON.stringify(g.stacks[1]);
  for (let n = 0; n < 40; n++) {
    run(g, { horn: true }, 0.05);
    if (n === 0) assert.ok(fallView(g, g.stacks[0]).fallZ > 0, 'the stack hops');
    run(g, NONE, 0.5);
    if (n === 0) {
      const s = g.stacks[0];
      assert.ok(s.offs.some((o) => o.x !== 0 || o.y !== 0) && s.rots.some((r) => r !== 0), 'near stack shifted and turned');
    }
  }
  const s = g.stacks[0];
  assert.equal(s.layers.length, 5, 'a honk never topples a stack');
  assert.equal(g.stacks.length, 2, 'no box fell off');
  assert.ok(s.offs.every((o, j) => j === 0 || Math.hypot(o.x - s.offs[j - 1].x, o.y - s.offs[j - 1].y) <= 0.121), 'boxes stay on the one below');
  assert.equal(JSON.stringify(g.stacks[1]), far, 'distant stack untouched');

  const h = newGame(1);
  flatWorld(h);
  h.stacks = [{ x: 10, y: 5, layers: [0, 1, 2], rots: [0, 0, 0], pen: [pen(), pen(), pen()], a: 0 }];
  faceStack(h, 0);
  forkUp(h);
  const rel = h.carriedRel;
  for (let n = 0; n < 40; n++) { run(h, { horn: true }, 0.05); run(h, NONE, 0.5); }
  assert.ok(h.carriedOffs.some((o) => o.x !== 0 || o.y !== 0), 'carried boxes shifted');
  assert.equal(h.carriedRel, rel, 'carried bottom box stays square to the forks');
  assert.ok(h.carriedOffs.every((o, j) => j === 0 || Math.hypot(o.x - h.carriedOffs[j - 1].x, o.y - h.carriedOffs[j - 1].y) <= 0.121), 'carried boxes stay on the one below');
  assert.equal(h.carried.length, 3, 'still carrying all boxes');
  console.log('horn-jolt ok');
}

// Oil barrels occupy two box levels on one pallet and leak a finite supply of merging drops.
{
  const lvl = generateLevel(3);
  const layoutBarrel = lvl.stacks.find((s) => Number.isInteger(s.barrelAt));
  assert.ok(layoutBarrel, 'level 3 introduces a barrel');
  assert.equal(layoutBarrel.layers[layoutBarrel.barrelAt], BARREL_COLOR, 'barrel has its own box type');
  assert.equal(layoutBarrel.layers[layoutBarrel.barrelAt + 1], BARREL_COLOR, 'barrel occupies two layers of its own type');
  assert.deepEqual(lvl.zones.filter((z) => z.color === BARREL_COLOR).map((z) => z.count), [1], 'each two-layer barrel has a one-barrel zone');
  assert.ok(lvl.stacks.filter((s) => Number.isInteger(s.barrelAt)).length <= 4, 'barrel count is capped at four');
  assert.ok(generateLevel(12).stacks.filter((s) => Number.isInteger(s.barrelAt)).length > 1, 'later levels can spawn multiple barrels');

  const g = newGame(1);
  flatWorld(g);
  g.stacks = [wonkyStack({ x: 10, y: 5, layers: [BARREL_COLOR, BARREL_COLOR], barrelAt: 0 })];
  faceStack(g, 0);
  forkUp(g);
  assert.deepEqual(g.carried, [BARREL_COLOR, BARREL_COLOR], 'forking at the pallet lifts the whole barrel');
  const upper = newGame(1);
  flatWorld(upper);
  upper.stacks = [wonkyStack({ x: 10, y: 5, layers: [BARREL_COLOR, BARREL_COLOR], barrelAt: 0 })];
  faceStack(upper, 0);
  upper.H = 1;
  forkUp(upper);
  assert.equal(upper.carried, null, 'the upper half cannot be lifted separately');
  const zone = newGame(1);
  zone.zones = [{ x: 10, y: 5, color: BARREL_COLOR, count: 1 }];
  zone.stacks = [wonkyStack({ x: 10, y: 5, layers: [BARREL_COLOR, BARREL_COLOR], barrelAt: 0 })];
  assert.ok(zoneDone(zone, zone.zones[0]), 'a two-height barrel counts as one item in its zone');
  zone.stacks = [wonkyStack({ x: 10, y: 5, layers: [BARREL_COLOR, BARREL_COLOR, 0], barrelAt: 0 })];
  assert.ok(!zoneDone(zone, zone.zones[0]), 'barrels with a box stacked above do not fit their zone');

  const noStack = newGame(1);
  flatWorld(noStack);
  noStack.stacks = [wonkyStack({ x: 10, y: 5, layers: [BARREL_COLOR, BARREL_COLOR], barrelAt: 0 })];
  noStack.carried = [0];
  noStack.carriedRots = [0];
  noStack.carriedPen = [{ crash: 0, sq: 0, deco: 0 }];
  noStack.carriedOffs = [{ x: 0, y: 0 }];
  noStack.H = 3;
  faceStack(noStack, 0);
  forkDown(noStack);
  assert.deepEqual(noStack.stacks[0].layers, [BARREL_COLOR, BARREL_COLOR], 'boxes cannot be set down on a barrel');
  assert.deepEqual(noStack.carried, [0], 'the box remains carried above a barrel');
  const honked = newGame(1);
  flatWorld(honked);
  honked.stacks = [wonkyStack({ x: 7, y: 5, layers: [BARREL_COLOR, BARREL_COLOR], barrelAt: 0 })];
  honked.fl.x = 5; honked.fl.y = 5; honked.fl.a = 0;
  update(honked, { horn: true }, 1 / 120);
  assert.deepEqual(honked.stacks[0].offs[1], honked.stacks[0].offs[0], 'a horn cannot separate barrel halves');
  assert.equal(honked.stacks[0].rots[1], honked.stacks[0].rots[0], 'barrel halves turn together');

  const hit = newGame(1);
  flatWorld(hit);
  hit.stacks = [wonkyStack({ x: 10, y: 5, layers: [BARREL_COLOR, BARREL_COLOR], barrelAt: 0 })];
  hit.fl.x = 7; hit.fl.y = 5; hit.fl.a = 0; hit.fl.speed = 2;
  for (let i = 0; i < 180; i++) update(hit, { up: true }, 1 / 120);
  hit.fl.speed = 0;
  for (let i = 0; i < 1200 && !hit.oil.length; i++) update(hit, NONE, 1 / 120);
  assert.equal(hit.oil.length, 1, 'damaging the barrel spills oil');
  assert.ok(hit.oil[0].r < 0.2, 'the first oil puddle starts small instead of making a large splat');
  assert.ok(hit.stacks[0].pen.some((p) => p.crash > 0), 'the barrel was damaged');

  const leak = (damage) => {
    const h = newGame(1);
    flatWorld(h);
    h.fl.x = 2; h.fl.y = 2; h.fl.speed = 0;
    h.stacks = [wonkyStack({ x: 10, y: 5, layers: [BARREL_COLOR, BARREL_COLOR], barrelAt: 0 })];
    h.stacks[0].pen[0].crash = damage;
    return h;
  };
  const intact = leak(0);
  run(intact, NONE, 12);
  assert.equal(intact.oil.length, 0, 'undamaged barrels do not leak');
  const lightLeak = leak(1);
  run(lightLeak, NONE, 9);
  assert.equal(lightLeak.oil.length, 0, 'one damage point takes ten seconds to emit a drop');
  run(lightLeak, NONE, 1);
  assert.equal(lightLeak.oil[0].drops, 1, 'one damage point emits one drop per ten seconds');
  const heavyLeak = leak(50);
  run(heavyLeak, NONE, 10);
  assert.equal(heavyLeak.stacks[0].pen[0].oilDropped, 50, 'a barrel holds fifty drops');
  assert.equal(heavyLeak.oil.length, 1, 'nearby drops join into one spill');
  assert.equal(heavyLeak.oil[0].drops, 50);
  assert.ok(Math.abs(heavyLeak.oil[0].r - 1.15) < 1e-9, 'fifty drops have the original spill area');
  run(heavyLeak, NONE, 10);
  assert.equal(heavyLeak.oil[0].drops, 50, 'an empty barrel stops leaking');
  const movingLeak = leak(5);
  run(movingLeak, NONE, 2);
  const firstPuddle = movingLeak.oil[0], firstRadius = firstPuddle.r;
  movingLeak.stacks[0].x += 0.8;
  run(movingLeak, NONE, 2);
  assert.equal(movingLeak.oil.length, 2, 'moving a leaking barrel leaves another small puddle behind');
  assert.equal(firstPuddle.r, firstRadius, 'the old puddle stays at its last size');
  assert.equal(movingLeak.oil[1].drops, 1, 'the new puddle starts with one drop');
  movingLeak.stacks[0].x -= 0.6;
  run(movingLeak, NONE, 2);
  assert.equal(movingLeak.oil.length, 2, 'a nearby new drop merges with an existing puddle');
  assert.equal(movingLeak.oil.reduce((n, o) => n + o.drops, 0), 3, 'merging conserves drops');

  const slowMove = leak(5);
  for (let i = 0; i < 8; i++) {
    slowMove.stacks[0].x += 0.1;
    run(slowMove, NONE, 1);
  }
  assert.equal(slowMove.oil[0].drops, 4, 'slow movement emits drops at the same rate');
  assert.ok(slowMove.oil[0].x < slowMove.stacks[0].x, 'merged drops stay behind rather than following the barrel');
  const combined = leak(5);
  combined.stacks[0].pen[1].crash = 5;
  run(combined, NONE, 1);
  assert.equal(combined.oil[0].drops, 1, 'damage on both barrel halves contributes to the drop rate');
  const shared = leak(50);
  run(shared, NONE, 10);
  const otherBarrel = wonkyStack({ x: 11.2, y: 5, layers: [BARREL_COLOR, BARREL_COLOR], barrelAt: 0 });
  otherBarrel.pen[0].crash = 10;
  shared.stacks.push(otherBarrel);
  run(shared, NONE, 1);
  assert.equal(shared.oil.length, 1, 'nearby drops from different barrels merge');
  assert.equal(shared.oil[0].drops, 51, 'both barrels contribute oil');

  const carriedLeak = newGame(1);
  flatWorld(carriedLeak);
  carriedLeak.stacks = [wonkyStack({ x: 10, y: 5, layers: [BARREL_COLOR, BARREL_COLOR], barrelAt: 0 })];
  faceStack(carriedLeak, 0);
  carriedLeak.stacks[0].pen[0].crash = 5;
  forkUp(carriedLeak);
  run(carriedLeak, NONE, 2);
  assert.equal(carriedLeak.oil.length, 1, 'a carried damaged barrel leaks beneath itself');
  carriedLeak.fl.x += 0.8;
  run(carriedLeak, NONE, 2);
  assert.equal(carriedLeak.oil.length, 2, 'carrying the leaking barrel leaves a trail');

  const turn = (oil) => {
    const h = newGame(1);
    flatWorld(h);
    h.fl.x = 10; h.fl.y = 10; h.fl.a = 0; h.fl.speed = 2;
    if (oil) {
      for (const side of [-1, 1]) {
        const p = toWorld(h.fl, -FL.L, side * (FL.halfW - 0.08));
        h.oil.push({ id: `test:${side}`, x: p.x, y: p.y, r: 0.12 });
      }
    }
    update(h, { right: true }, 0.2);
    return { angle: h.fl.a, spin: h.fl.spin || 0, slip: h.slip };
  };
  const clean = turn(false), slick = turn(true);
  assert.ok(Math.abs(slick.spin) > Math.abs(clean.spin), 'oil on a rear tire can spin the truck');
  assert.ok(slick.slip > 0, 'oil makes the tyres slip');
  console.log('oil barrels ok');
}

// The repair station next to the parking spot repairs one single box at a time (1 damage point/s), spinning it while no truck is close.
{
  const g = newGame(1);
  const r = g.repair;
  assert.ok(r && Math.hypot(r.x - g.parking.x, r.y - g.parking.y) >= 2.4 - 1e-9, 'a pad sits near the parking spot, not on it');
  assert.ok(g.walls.filter((w) => !w.mast).some((w) => pointRectDist(r.mast.x + 0.18, r.mast.y + 0.18, w) < 0.18 + 0.36), 'the mast is on the wall side');
  assert.ok(g.walls.filter((w) => !w.mast).every((w) => pointRectDist(r.x, r.y, w) > 0.65), 'the pad is clear of walls');
  assert.ok(g.walls.some((w) => w.mast) && pointRectDist(r.x, r.y, r.mast) > 0.65, 'the film mast is a solid post beside the turntable');
  const droppedA = 0.37;
  g.stacks = []; g.zones = []; g.H = 0;
  Object.assign(g.fl, { x: r.x - FL.carryX, y: r.y, a: 0, speed: 0 });
  g.carried = [0]; g.carriedRel = droppedA; g.carriedRots = [droppedA];
  g.carriedPen = [{ crash: 10, sq: 0, dent: { t: 1, c: [0, 0, 0, 0], s: [0, 0, 0, 0] } }];
  g.carriedOffs = [{ x: 0, y: 0 }];
  forkDown(g);
  assert.equal(g.repair.dropA, droppedA, 'set-down records the box orientation before the truck moves');
  Object.assign(g.fl, { x: r.x - 2.15, y: r.y, a: 0, speed: 0 });
  run(g, NONE, 1);
  assert.ok(g.stacks[0].pen[0].crash === 10 && g.stacks[0].a === droppedA && !g.repair.on, 'forks stay clear of the full rotation area before spinning starts');
  Object.assign(g.fl, { x: g.parking.x, y: g.parking.y, a: g.parking.a, speed: 0 }); // the truck stays in the parking spot, out of reach
  const far = { x: r.x + 12, y: r.y, a: 0, speed: 0 };
  Object.assign(g.fl, far);
  run(g, NONE, 3.01);
  assert.equal(g.stacks[0].pen[0].crash, 7, 'one damage point per second');
  assert.ok(g.stacks[0].a > 5 && g.repair.on, 'the box spins while it is repaired');
  assert.equal(g.stacks[0].pen[0].tape, 1, 'tape appears once repair has started');
  Object.assign(g.fl, { x: r.x - 1.5, y: r.y, a: 0 });
  const a = g.stacks[0].a;
  run(g, NONE, 2);
  assert.ok(g.stacks[0].pen[0].crash === 7 && g.stacks[0].a === a && !g.repair.on, 'a close truck pauses the spin and the repair');
  Object.assign(g.fl, far);
  run(g, NONE, 7.01);
  const pen = g.stacks[0].pen[0];
  assert.ok(pen.crash === 0 && pen.tape > 1 && !pen.dent && g.repair.on, 'the repaired box keeps turning to its drop-off orientation');
  const repairedA = g.stacks[0].a;
  run(g, NONE, 0.2);
  assert.ok(g.stacks[0].a > repairedA, 'it continues rotating after repair is complete');
  run(g, NONE, 2);
  assert.ok(Math.abs(Math.sin(g.stacks[0].a - droppedA)) < 1e-9 && !g.repair.on, 'it stops at its drop-off orientation or 180 degrees from it');
  g.stacks = [{ x: r.x, y: r.y, layers: [0, 1], rots: [0, 0], a: 0, pen: [{ crash: 5, sq: 0 }, { crash: 5, sq: 0 }], offs: [{ x: 0, y: 0 }, { x: 0, y: 0 }] }];
  run(g, NONE, 2);
  assert.ok(g.stacks[0].pen.every((p) => p.crash === 5) && !g.repair.on, 'a stack of several boxes is not repaired');
  console.log('repair station ok');
}

// Putting the tines into a stack that carries the inspector's "!" (photographed, still damaged or wonky, untouched) re-shows the picture the inspector took of that stack.
{
  const setup = (crash, sq = 0, photographed = true) => {
    const g = newGame(1);
    flatWorld(g);
    g.zones = [{ x: 10, y: 5, w: 1, h: 1, count: 1, color: 0 }];
    g.stacks = [{ x: 10, y: 5, layers: [0], rots: [sq ? 0.3 : 0], a: 0, pen: [{ crash, sq }], offs: [{ x: 0, y: 0 }] }]; // sq is recomputed from the angles
    if (photographed) {
      const photo = { n: 1, ok: false, layers: [0], pens: [{ crash, sq }], at: { x: 10, y: 5 } };
      Object.assign(g.inspector, { seen: ['10,5,0'], sigs: { '10,5,0': stackSig(g.stacks[0]) }, photos: { '10,5,0': photo } });
    }
    return g;
  };
  let g = setup(8, 0, false);
  faceStack(g, 0); g.fl.speed = 0;
  run(g, NONE, 0.05);
  assert.equal(g.forkPhoto, undefined, 'no picture taken: nothing to show');
  g = setup(8);
  g.fl.x = 5; g.fl.y = 5; g.fl.a = 0; g.fl.speed = 0;
  run(g, NONE, 0.05);
  assert.equal(g.forkPhoto, undefined, 'tines not in the stack yet');
  faceStack(g, 0);
  run(g, NONE, 0.05);
  assert.equal(g.forkPhoto?.photo, g.inspector.photos['10,5,0'], 'the stack picture is shown when the stack reaches the fork gauge');
  g = setup(0, 20);
  faceStack(g, 0);
  run(g, NONE, 0.05);
  assert.ok(g.forkPhoto, 'a wonky stack re-shows its picture too');
  g = setup(0);
  faceStack(g, 0);
  run(g, NONE, 0.05);
  assert.equal(g.forkPhoto, undefined, 'a perfect stack has no "!" and no popup');
  g = setup(8);
  g.stacks[0].touched = true;
  faceStack(g, 0);
  run(g, NONE, 0.05);
  assert.equal(g.forkPhoto, undefined, 'no "!" (touched since the picture): no popup');
  console.log('last picture ok');
}

console.log('stacks tests passed');

// Proximity alert: only when the carried stack heads into a stack at an overlapping height.
{
  const g = newGame(1);
  flatWorld(g);
  const f = g.fl;
  g.carried = [0]; g.carriedPen = [{ crash: 0, sq: 0 }]; g.carriedRots = [0]; g.carriedOffs = [{ x: 0, y: 0 }]; g.carriedRel = 0;
  g.stacks = [{ x: f.x + 3.6, y: f.y, layers: [1], rots: [0], pen: [{ crash: 0, sq: 0 }], a: 0 }];
  f.a = 0; f.speed = 2;
  g.H = 0;
  assert.equal(crashAlert(g), true);
  g.H = 1; // carried above the low stack
  assert.equal(crashAlert(g), false);
  g.H = 0; f.speed = 0; // standing still: still sees what is just beyond the fork tips
  g.stacks[0].x = f.x + 2.2;
  assert.equal(crashAlert(g), true);
  g.stacks[0].x = f.x + 3.6;
  f.speed = 1; f.gear = 'R';
  assert.equal(crashAlert(g), false, 'not in gear R');
  f.gear = 'D'; g.stacks[0].x = f.x + 5; // beyond 1 s at 1 tile/s
  assert.equal(crashAlert(g), false);
  f.speed = 5; // 1 s ahead now reaches it
  assert.equal(crashAlert(g), true);
  f.speed = 0.1; g.stacks[0].x = f.x + 2.2; // slow: still looks 1 tile past the fork tips
  assert.equal(crashAlert(g), true);
  f.speed = 0; g.stacks[0].x = f.x + 2.4; g.stacks[0].y = f.y + 1.2; // the close probe is straight ahead only: a stack off to the side is missed
  assert.equal(crashAlert(g), false);
  assert.deepEqual(alertTriggers(g), [g.stacks[0]].filter(() => crashAlert(g)));
  g.carried = null; assert.deepEqual(crashProbes(g), [], 'empty forks: no alert');
  assert.deepEqual(alertTriggers(g), []);
}
{ // follows the steering arc
  const g = newGame(1);
  flatWorld(g);
  const f = g.fl;
  g.carried = [0]; g.carriedPen = [{ crash: 0, sq: 0 }]; g.carriedRots = [0]; g.carriedOffs = [{ x: 0, y: 0 }]; g.carriedRel = 0;
  f.a = 0; f.speed = 5; g.H = 0; f.steer = 0;
  g.stacks = [{ x: f.x + 5, y: f.y + 1.6, layers: [1], rots: [0], pen: [{ crash: 0, sq: 0 }], a: 0 }];
  assert.equal(crashAlert(g), false, 'straight ahead misses a stack off to the side');
  f.steer = 0.2;
  assert.equal(crashAlert(g), true, 'turning right sweeps into it');
  f.steer = 1; g.stacks[0].y = f.y + 3;
  assert.equal(crashAlert(g), false, 'the look-ahead stops after 45° of turn');
}
{
  const g = newGame(1);
  flatWorld(g);
  g.carried = [0]; g.carriedPen = [{ crash: 0, sq: 0 }]; g.carriedRots = [0]; g.carriedOffs = [{ x: 0, y: 0 }]; g.carriedRel = 0;
  g.stacks = [{ x: g.fl.x + 2.3, y: g.fl.y, layers: [1], rots: [0], pen: [{ crash: 0, sq: 0 }], a: 0 }];
  g.fl.a = 0; g.fl.speed = 1; g.H = 0;
  const seen = new Set();
  for (let t = 0; t < 1; t += 0.05) { g.clock = t; seen.add(crashBlink(g)); }
  assert.deepEqual([...seen].sort(), [false, true]); // the headlights blink
}

// Repair-station onboarding hint: one damaged, repairable carried box, until the first repair.
{
  const g = newGame(1, 0);
  assert.ok(g.repair, 'level 1 has a repair station');
  const carry = (pens) => Object.assign(g, { carried: pens.map(() => 0), carriedPen: pens });
  assert.equal(repairHintWanted(g, false), false, 'nothing carried');
  carry([{ crash: 3, sq: 0 }]);
  assert.equal(repairHintWanted(g, false), true);
  assert.equal(repairHintWanted(g, true), false, 'never again once something was repaired');
  carry([{ crash: 3, sq: 0 }, { crash: 3, sq: 0 }]);
  assert.equal(repairHintWanted(g, false), false, 'only a single box');
  carry([{ crash: 0, sq: 0 }]);
  assert.equal(repairHintWanted(g, false), false, 'undamaged');
  carry([{ crash: 3, sq: 0, wide: true }]);
  assert.equal(repairHintWanted(g, false), false, 'big boxes cannot be repaired');
  carry([{ crash: 3, sq: 0 }]);
  g.repair = null;
  assert.equal(repairHintWanted(g, false), false, 'no station on this level');
}

{ // a box shoved deep into the outer wall must not tunnel out of the level
  const g = newGame(1, 0, true);
  const s = g.stacks[0];
  for (const [x, y] of [[-2.6, 5], [g.w + 2.6, 5], [10, -2.6], [10, g.h + 2.6]]) {
    s.x = x; s.y = y;
    run(g, NONE, 0.1);
    assert.ok(s.x > -0.01 && s.x < g.w + 0.01 && s.y > -0.01 && s.y < g.h + 0.01, `box at (${x}, ${y}) is back inside`);
  }
}

{ // a box shoved past the middle of a thick inner wall must not come out the other side
  const g = newGame(2, 0, true);
  const w = g.walls.slice(4).find((r) => r.w === 1 && r.h >= 1.4), s = g.stacks[0];
  g.fl.x = 1; g.fl.y = 1; g.fl.a = 0;
  g.stacks = [s];
  s.x = w.x - 0.55; s.y = w.y + w.h / 2;
  run(g, NONE, 0.05);
  s.x = w.x + w.w / 2 + 0.02;
  run(g, NONE, 0.05);
  assert.ok(s.x < w.x, 'box did not tunnel through the inner wall');
}
