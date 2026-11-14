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
  const a = g.fl.a, p = toWorld(g.fl, FL.back, 0), eye = chaseRig(g, 11, CHASE_TILT, null, 0, a).eye, back = Math.hypot(eye[0] - p.x, eye[1] - p.y) * 0.2; // wall between camera and truck
  g.walls = [{ x: p.x - Math.cos(a) * back - 1, y: p.y - Math.sin(a) * back - 1, w: 2, h: 2 }];
  const t = clearChaseTilt(g, 11, a, 0, CHASE_TILT);
  assert.ok(t < CHASE_TILT, 'camera should lift over the wall');
  console.log('chase wall clearing ok');
}

// chase camera orbit keeps its distance to the tines' middle
{
  const g = newGame(1), r = chaseRig(g, 11, CHASE_TILT, null, 0, g.fl.a), p = toWorld(g.fl, (FL.tineX0 + FL.tineX1) / 2, 0);
  const q = chaseOrbit(g, r.pos, Math.PI / 4);
  assert.ok(Math.abs(Math.hypot(q[0] - p.x, q[1] - p.y) - r.maxD) < 1e-9, 'orbit keeps the distance');
  const back = chaseOrbit(g, q, -Math.PI / 4);
  assert.ok(Math.hypot(back[0] - r.pos[0], back[1] - r.pos[1]) < 1e-9, 'orbit is reversible');
  console.log('chase orbit ok');
}


// chase camera: zooms out with speed, looks higher with raised forks, drifts faster when steering
{
  const g = newGame(1), still = chaseRig(g, 11, CHASE_TILT, null, 0, g.fl.a);
  g.ef = 3;
  assert.ok(chaseRig(g, 11, CHASE_TILT, null, 0, g.fl.a).tz > still.tz, 'raised forks lift the look-at point');
  g.fl.speed = 3;
  assert.ok(chaseRig(g, 11, CHASE_TILT, null, 0, g.fl.a).maxD > still.maxD * 1.15, 'speed zooms the chase view out');
  const far = [g.fl.x - 20, g.fl.y], straight = chaseDrift(g, far, still.maxD, 0.1);
  g.fl.steer = FL.maxSteer;
  const turning = chaseDrift(g, far, still.maxD, 0.1);
  assert.ok(Math.hypot(turning[0] - far[0], turning[1] - far[1]) > Math.hypot(straight[0] - far[0], straight[1] - far[1]), 'steering speeds up the drift');
  // shuffling: a short reversal must not pull the camera to the front of the truck; a sustained one does
  const h = newGame(1);
  h.fl.a = 0;
  const tc = toWorld(h.fl, (FL.tineX0 + FL.tineX1) / 2, 0), behind = [tc.x - 5, tc.y];
  let pos = behind;
  h.fl.speed = 3;
  for (let i = 0; i < 5; i++) pos = chaseDrift(h, pos, 5, 0.1);
  h.fl.speed = -3;
  for (let i = 0; i < 3; i++) pos = chaseDrift(h, pos, 5, 0.1);
  assert.ok(Math.abs(pos[0] - behind[0]) < 0.2, 'a short reversal keeps the camera behind the truck');
  for (let i = 0; i < 20; i++) pos = chaseDrift(h, pos, 5, 0.1);
  assert.ok(pos[0] - behind[0] > 1, 'a sustained reversal swings the camera to the front');
  console.log('chase tuning ok');
}


console.log('render tests passed');
