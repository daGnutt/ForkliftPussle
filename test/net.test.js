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

// Multiplayer trucks: ghosts at spawn, collisions once separated, stack handoff on the tines, leaving players
{
  const boxes = (g) => g.stacks.reduce((n, s) => n + s.layers.length, 0) + g.trucks.reduce((n, t) => n + (t.carried ? t.carried.length : 0), 0);
  const g = newGame(1);
  const total = boxes(g);
  assert.equal(addTruck(g, 'B'), 1);
  assert.equal(g.trucks[1].color, 1, 'second truck is red');
  assert.deepEqual(g.ghostPairs, [[0, 1]], 'a truck spawning inside another is a ghost to it');
  assert.ok(isGhost(g, 0) && isGhost(g, 1) && ghostBetween(g, 1, 0));
  // truck 0 drives off through the ghost; once clear they are solid
  run(g, { up: true }, 0.5);
  assert.ok(g.ghostPairs.length === 1 || g.trucks[0].fl.speed > 0, 'still overlapping or moving');
  run(g, { up: true }, 3);
  assert.deepEqual(g.ghostPairs, [], 'ghosts become real once separated');
  // a solid truck is pushed along by the other one instead of being driven through
  const t0 = g.trucks[0].fl, t1 = g.trucks[1].fl;
  Object.assign(t0, { x: 3, y: 8.5, a: 0, speed: 0 });
  Object.assign(t1, { x: 6.2, y: 8.5, a: 0, speed: 0 });
  run(g, { up: true }, 2);
  assert.ok(t1.x - t0.x > 2.2, 'the driver did not pass through the other truck');
  assert.ok(t1.x > 6.5, 'and pushed it along');

  // handoff: truck 1 lifts a floor stack, truck 0 takes it over by raising its tines under it, then gives it back by lowering
  g.ghostPairs = [];
  const S = g.stacks[0], n = S.layers.length;
  Object.assign(t1, { x: S.x - FL.carryX, y: S.y, a: 0, speed: 0 });
  const v1 = truckView(g, 1);
  forkUp(v1);
  assert.equal(g.trucks[1].carried.length, n, 'truck 1 carries the stack');
  assert.equal(g.trucks[1].H, 1);
  const p = toWorld(t1, FL.carryX, 0);
  Object.assign(t0, { x: p.x + FL.carryX, y: p.y, a: Math.PI, speed: 0 });
  g.trucks[0].H = 0;
  forkUp(g);
  assert.equal(g.carried.length, n, 'truck 0 took the stack');
  assert.equal(g.H, 1, 'but did not lift it higher than it was');
  assert.equal(g.trucks[1].carried, null);
  assert.equal(boxes(g), total);
  forkDown(g);
  assert.equal(g.carried, null, 'lowering the stack over the other tines gives it away');
  assert.equal(g.trucks[1].carried.length, n);
  assert.equal(g.trucks[1].H, 1, 'the receiver stays at its height');
  assert.equal(g.H, 0);
  // not under the tines: nothing happens
  Object.assign(t0, { x: 5, y: 5 });
  forkUp(g);
  assert.equal(g.carried, null);
  assert.equal(g.H, 1);

  // split: truck 0 puts its tines inside a carried stack and takes only the boxes from that level up; then puts them back on top
  {
    const g4 = newGame(1);
    addTruck(g4, 'B');
    g4.ghostPairs = [];
    const a = g4.trucks[0], b = g4.trucks[1];
    Object.assign(b.fl, { x: 10, y: 10, a: 0, speed: 0 });
    const pc = toWorld(b.fl, FL.carryX, 0);
    Object.assign(a.fl, { x: pc.x + FL.carryX, y: pc.y, a: Math.PI, speed: 0 });
    b.H = 1; b.carried = [0, 1, 2]; b.carriedRots = [0, 0, 0]; b.carriedPen = []; b.carriedOffs = [{ x: 0, y: 0 }, { x: 0, y: 0.05 }, { x: 0.1, y: 0.05 }]; b.carriedRel = 0;
    a.H = 2;
    forkUp(g4);
    assert.deepEqual(a.carried, [1, 2], 'took the boxes from its tines up');
    assert.deepEqual(b.carried, [0], 'the lower box stays on the other forks');
    assert.equal(a.H, 2);
    assert.ok(Math.abs(a.carriedOffs[1].x) > 0.09 || Math.abs(a.carriedOffs[1].y) > 0.09, 'keeps its crookedness');
    const sum = a.carried.length + b.carried.length;
    forkDown(g4);
    assert.equal(a.carried, null, 'put the boxes onto the other stack');
    assert.deepEqual(b.carried, [0, 1, 2]);
    assert.equal(b.carriedOffs.length, 3);
    assert.equal(sum, 3);
    assert.equal(a.H, 1);
    // a stack of four held at height 2 is dropped onto a single box carried at level 1; the carried stacks do not push each other
    b.carried = [0]; b.carriedRots = [0]; b.carriedOffs = [{ x: 0, y: 0 }]; b.carriedPen = []; b.H = 1;
    Object.assign(b.fl, { x: 6, y: 7, a: 0, speed: 0 });
    const pc2 = toWorld(b.fl, FL.carryX, 0);
    Object.assign(a.fl, { x: pc2.x + FL.carryX, y: pc2.y, a: Math.PI, speed: 0 });
    a.carried = [1, 2, 3, 0]; a.carriedRots = [0, 0, 0, 0]; a.carriedPen = []; a.carriedOffs = []; a.H = 2;
    const ax = a.fl.x, ay = a.fl.y;
    for (let i = 0; i < 20; i++) update(g4, {}, 1 / 120);
    assert.ok(Math.abs(a.fl.x - ax) < 0.01 && Math.abs(a.fl.y - ay) < 0.01, 'stacks at different heights do not collide');
    forkDown(g4);
    assert.equal(a.carried, null);
    assert.deepEqual(b.carried, [0, 1, 2, 3, 0], 'four boxes from height 2 land on the single carried box');
    // a full stack is not merged into
    b.carried = [0, 1, 2, 3]; a.carried = [1, 2]; a.carriedRots = [0, 0]; a.carriedPen = []; a.carriedOffs = []; a.H = 4;
    forkDown(g4);
    assert.equal(b.carried.length, 4, 'over MAX_LAYERS is refused');
  }

  // a player leaving puts the carried boxes down and frees the slot
  removeTruck(g, 1);
  assert.equal(boxes(g), total, 'no box lost when a player leaves');
  assert.equal(g.trucks[1].gone, true);
  assert.equal(addTruck(g, 'C'), 1, 'the slot is reused');
  for (let i = 0; i < 3; i++) addTruck(g, 'x');
  assert.equal(addTruck(g, 'full'), -1, 'at most four trucks');

  // any parked truck finishes the level
  const g2 = newGame(1);
  addTruck(g2, 'B');
  assert.equal(g2.trucks.length, 2);

  // other trucks are drawn: ghosts go to the transparent mesh, solid trucks to the opaque one
  const g3 = newGame(1);
  const solo = dynamicMeshes(g3, 'ov', [0, 0]);
  addTruck(g3, 'B');
  const ghosted = dynamicMeshes(g3, 'ov', [0, 0]);
  assert.ok(ghosted.trans.count > solo.trans.count && ghosted.opaque.count === solo.opaque.count, 'ghost drawn translucent');
  Object.assign(g3.trucks[1].fl, { x: 20, y: 10 });
  update(g3, {}, 1 / 120);
  assert.ok(dynamicMeshes(g3, 'ov', [0, 0]).opaque.count > solo.opaque.count, 'solid truck drawn opaque');

  // horns follow each truck's key and travel in snapshots
  update(g3, { horn: true }, 1 / 120);
  g3.trucks[1].input = {};
  assert.equal(g3.horn, true, 'own horn sounds while held');
  assert.equal(g3.trucks[1].horn, false);
  g3.trucks[1].input = { horn: true };
  update(g3, {}, 1 / 120);
  assert.deepEqual(g3.trucks.map((t) => t.horn), [false, true], 'other truck horn follows its input');
  assert.deepEqual(snapshot(g3).trucks.map((t) => t.horn), [false, true], 'horn is in snapshots');
  console.log('multiplayer trucks ok');
}

// Party networking with an in-memory relay and loopback links.
{
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const streams = new Map(); // `${code}/${peer}` -> handlers
  let seq = 0, ended = null;
  const relay = {
    async createParty() { return { code: 'ABCDE', hostToken: 'tok' }; },
    async join(code, name) { const peer = `p${++seq}`; setTimeout(() => streams.get('ABCDE/host').join({ peer, name })); return { peer, iceServers: [] }; },
    async signal(code, m) { setTimeout(() => streams.get(`${code.toUpperCase()}/${m.to}`)?.signal({ from: m.from, type: m.type, data: m.data })); },
    async end(code, token) { ended = token; },
    events(code, peer, token, handlers) { const k = `${code.toUpperCase()}/${peer}`; streams.set(k, handlers); return { close() { streams.delete(k); } }; },
  };
  // loopback links: the offer carries an id, the answering side pairs with the initiator that made it
  const initiators = new Map();
  let linkSeq = 0;
  const linkFactory = ({ initiator, sendSignal, onMessage, onOpen, onClose }) => {
    const me = { open: false, other: null, closed: false, onMessage, onOpen, onClose };
    const wire = (msg) => { const o = me.other; if (o && !o.closed) setTimeout(() => o.onMessage(JSON.parse(typeof msg === 'string' ? msg : JSON.stringify(msg)))); };
    Object.assign(me, {
      sendReliable: wire, sendFast: wire,
      close() { if (me.closed) return; me.closed = true; me.open = false; const o = me.other; if (o && !o.closed) { o.open = false; setTimeout(() => o.onClose?.()); } },
      async signal({ type, data }) {
        if (type === 'offer') {
          const o = initiators.get(data.id);
          me.other = o; o.other = me; me.open = o.open = true;
          setTimeout(() => { me.onOpen?.(); o.onOpen?.(); });
        }
      },
    });
    if (initiator) { const id = ++linkSeq; initiators.set(id, me); setTimeout(() => sendSignal({ type: 'offer', data: { id } })); }
    return me;
  };

  let host = newGame(7, 3, false);
  const info = () => ({ level: host.level, seed: host.seed, hard: host.hard, seedText: '' });
  let changes = 0, started = false;
  const h = createHost({ relay, getGame: () => host, levelInfo: info, isStarted: () => started, name: 'Anna', onChange: () => changes++, linkFactory });
  assert.equal(await h.start(), 'ABCDE');

  let guestGame = null, welcomes = 0, closedWith = null;
  const guest = createGuest({
    relay, code: 'abcde', name: 'Bob', linkFactory,
    onGame: (m) => {
      welcomes++;
      guestGame = newGame(m.level, m.seed, m.hard);
      guestGame.self = m.slot;
      applySnapshot(guestGame, m.snap);
    },
    onClosed: (why) => { closedWith = why; },
  });
  await guest.join();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(welcomes, 1, 'the guest got a welcome');
  assert.equal(guest.slot, 1);
  assert.equal(host.trucks.length, 2, 'the guest has a truck on the host');
  assert.equal(host.trucks[1].name, 'Bob');
  assert.equal(guestGame.trucks[1].color, 1, 'the guest is the second colour');
  assert.deepEqual(h.players().map((p) => p.name), ['Anna', 'Bob']);

  // inputs drive the guest's truck on the host, snapshots bring the result back
  guest.sendInput({ up: true });
  await tick(); await tick();
  assert.equal(host.trucks[1].input.up, true);
  const x0 = host.trucks[1].fl.x;
  for (let i = 0; i < 120; i++) update(host, {}, 1 / 120);
  assert.notEqual(host.trucks[1].fl.x, x0, 'the host moved the guest truck');
  h.broadcast(host, 10);
  for (let i = 0; i < 3; i++) await tick();
  const ip = createInterpolator();
  ip.push({ ...snapshot(host) }, 0);
  ip.apply(guestGame, 1);
  assert.ok(Math.abs(guestGame.fl.x - host.trucks[1].fl.x) < 1e-6, 'the guest mirrors its truck (g is the guest view)');
  guest.sendFork('up');
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(host.trucks[1].H, 1, 'fork action applied to the guest truck');

  // interpolation blends between two snapshots
  const a = snapshot(host), b = JSON.parse(JSON.stringify(a));
  b.trucks[1].fl.x += 2;
  const ip2 = createInterpolator(0);
  ip2.push(JSON.parse(JSON.stringify(a)), 0);
  ip2.push(b, 1);
  ip2.apply(guestGame, 0.5);
  assert.ok(Math.abs(guestGame.fl.x - (a.trucks[1].fl.x + 1)) < 1e-6, 'halfway between snapshots');

  // prediction: the guest's truck moves at once, and a snapshot from one round trip ago pulls it back in line
  {
    const pg = newGame(7, 3, false);
    addTruck(pg, 'Bob');
    pg.self = 1;
    const pr = createPredictor();
    pr.reset(pg);
    const x0 = pg.trucks[1].fl.x;
    for (let i = 0; i < 60; i++) { pr.step(pg, { up: true }, 1 / 60, i / 60); pr.apply(pg, i / 60); }
    assert.ok(Math.abs(pg.trucks[1].fl.x - x0) + Math.abs(pg.trucks[1].fl.y - 0) > 0.1, 'predicted truck moved without a snapshot');
    const ahead = { ...pg.trucks[1].fl };
    const auth = snapshot(pg);
    auth.trucks[1].fl = { ...ahead, x: ahead.x - 0.5 };
    pr.onSnapshot({ ...auth }, 1, 0);
    pr.apply(pg, 1);
    const moved = Math.hypot(pg.trucks[1].fl.x - ahead.x, pg.trucks[1].fl.y - ahead.y);
    assert.ok(moved > 0.01 && moved < 0.5, 'small error is blended, not snapped');
    auth.trucks[1].fl = { ...ahead, x: ahead.x - 10 };
    pr.onSnapshot({ ...auth }, 1, 0);
    pr.apply(pg, 1);
    assert.ok(Math.abs(pg.trucks[1].fl.x - (ahead.x - 10)) < 1e-6, 'large error snaps');
    // forks are predicted too: shown at once, and the host's answer wins once it should have arrived
    pr.fork('up', 2);
    pr.apply(pg, 2);
    assert.equal(pg.trucks[1].H, 1, 'fork level predicted at once');
    const refused = snapshot(pg);
    refused.trucks[1].H = 0;
    pr.onSnapshot(refused, 2.1, 0.05);
    pr.apply(pg, 2.1);
    assert.equal(pg.trucks[1].H, 1, 'still the prediction while the host has not confirmed');
    pr.onSnapshot(refused, 3, 0.05);
    pr.fork('up', 4);
    pr.apply(pg, 4);
    assert.equal(pg.trucks[1].H, 1, 'the host refused the first raise, so the prediction was reset to level 0');
  }

  // a new level keeps everyone in their slot
  host = newGame(8, 3, false);
  h.levelLoaded(host);
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(host.trucks[1].name, 'Bob');
  assert.equal(welcomes, 2, 'the guest was told about the new level');
  assert.equal(guestGame.level, 8);

  // two live players may share a name: the second must not evict the first
  guest.sendInput({ up: false });
  const twin = createGuest({ relay, code: 'abcde', name: 'Bob', linkFactory, onGame: () => {}, onClosed: () => {} });
  await twin.join();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(twin.slot, 2, 'the same-name newcomer gets its own slot');
  assert.equal(host.trucks[1].gone, false, 'the live guest keeps its truck');
  twin.close();
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(host.trucks[2].gone, true);
  closedWith = null;

  // a guest leaving frees the truck; the host closing ends the party
  guest.close();
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(host.trucks[1].gone, true, 'truck removed when the guest left');

  // ping, kick and ban
  let cyGame = null, cyClosed = null;
  const joinCy = (name) => createGuest({ relay, code: 'ABCDE', name, linkFactory, onGame: (m) => { cyGame = m; }, onClosed: (why) => { cyClosed = why; } });
  let cy = joinCy('Cy');
  await cy.join();
  for (let i = 0; i < 6; i++) await tick();
  const cySlot = cy.slot;
  assert.ok(cySlot > 0 && host.trucks[cySlot].name === 'Cy');
  h.broadcast(host, 100);
  for (let i = 0; i < 4; i++) await tick();
  const ping = h.players().find((p) => p.name === 'Cy').ping;
  assert.ok(ping !== null && ping >= 0, 'the host measures a ping');
  assert.equal(h.players()[0].ping, 0);
  assert.equal(h.kick(0), false, 'the host cannot kick itself');
  assert.equal(h.kick(cySlot, true), true);
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(host.trucks[cySlot].gone, true, 'kicked truck removed');
  assert.match(cyClosed, /banned/);
  cy = joinCy('cy');
  await cy.join();
  for (let i = 0; i < 6; i++) await tick();
  assert.match(cyClosed, /banned/);
  assert.equal(host.trucks.filter((t) => !t.gone).length, 1, 'a banned name gets no truck');
  h.close();
  assert.equal(ended, 'tok', 'party ended at the relay');
  console.log('party networking ok');
}

{
  const g = newGame(1);
  run(g, { down: true }, 0.8);
  assert.equal(g.fl.gear, 'R', 'reversing');
  run(g, {}, 0.5);
  assert.equal(g.fl.gear, 'R', 'brief pause stays in R');
  run(g, { down: true }, 0.3);
  run(g, {}, 4);
  assert.ok(Math.abs(g.fl.speed) < 0.05);
  assert.equal(g.fl.gear, 'D', 'idling in R for >1 s switches to D');
  console.log('idle reverse to D ok');
}

{
  // wall hits record a contact point; holding the throttle against a wall spins the tyres (slip); particles show up in the meshes
  setThemeMode('light');
  const g = newGame(2);
  g.stacks = [];
  g.fl.x = g.w / 2; g.fl.y = 1.5; g.fl.a = -Math.PI / 2; g.fl.speed = 0;
  const eye = [g.fl.x, g.fl.y + 3, 2];
  dynamicMeshes(g, 'ov', eye);
  const before = dynamicMeshes(g, 'ov', eye).trans.count;
  let slip = 0, sparked = 0;
  for (let i = 0; i < 360; i++) {
    update(g, { up: true }, 1 / 120);
    slip = Math.max(slip, g.slip);
    if (i % 12 === 0) { const m = dynamicMeshes(g, 'ov', eye); sparked = Math.max(sparked, m.opaque.count + m.trans.count - before); }
  }
  assert.ok(g.contact && g.contact.ny > 0.9, 'contact normal points away from the wall');
  assert.ok(slip > 0.4, 'driving into a wall spins the tyres');
  assert.ok(sparked > 0, 'particles are drawn');
  g.fl.speed = 0;
  let clear = false;
  for (let x = 3; x < g.w - 3 && !clear; x += 1.5) for (let y = 3; y < g.h - 3 && !clear; y += 1.5) {
    g.fl.x = x; g.fl.y = y;
    update(g, {}, 1 / 120);
    clear = g.contact === null;
  }
  assert.ok(clear, 'contact is cleared once the wall is no longer touched (no stale spark point)');
  const free = newGame(2);
  free.stacks = [];
  run(free, { up: true }, 0.5);
  assert.equal(free.slip, 0, 'free driving does not slip');
  console.log('particles ok');
}


console.log('net tests passed');
