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


console.log('demo tests passed');
