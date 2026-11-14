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


console.log('save tests passed');
