import assert from 'node:assert/strict';
import { generateLevel, parseSeed, isReachable, BARREL_COLOR } from '../js/level.js';
import { pointRectDist } from '../js/geom.js';
import { FL, MAX_LAYERS, toLocal, toWorld, maxSteerFor } from '../js/forklift.js';
import { reverseLight, REV_RADIUS } from '../js/revlight.js';
import { serializeGame, deserializeGame, encodeState, decodeState, serializeEndless, deserializeEndless } from '../js/savestate.js';
import { chaseOrbit } from '../js/gl/camera.js';
import { chaseDrift, povCamera, overviewCamera, chaseCamera, chaseRig, chaseTiles, chaseZoom, clearChaseTilt, groundFootprint, CHASE_TILT } from '../js/gl/camera.js';
import { staticMeshes, dynamicMeshes } from '../js/gl/scene.js';
import { projectPoint } from '../js/gl/mat.js';
import { setThemeMode } from '../js/theme.js';
import { setDiscoEnabled } from '../js/disco.js';
import { createDemo } from '../js/demo.js';
import { qrMatrix, QR_SIZE } from '../js/qr.js';
import { createHost } from '../js/net/host.js';
import { createGuest, withoutJoinParam } from '../js/net/guest.js';
import { createRound } from '../js/net/round.js';
import { createVote } from '../js/net/vote.js';
import { createPredictor } from '../js/net/predict.js';
import { applySnapshot, createInterpolator, snapshot } from '../js/net/protocol.js';
import { rectPoly, sat, FORK_CLEARANCE } from '../js/geom.js';
import { TRUCK_BONUS, lorryHonks, newEndless, stepEndless, endEndless, rampDecals, truckRoofs, numberRects, dockWaits, truckGeom, unloadRate, interval, endlessScore, animatedDoors } from '../js/endless.js';
import { newGame, update, addTruck, removeTruck, truckView, isGhost, ghostBetween, forkUp, forkDown, stackInZone, isParked, isFinished, score, maxScore, lostBreakdown, zoneWonky, zoneDone, zonePoints, zoneLabelPos, stackZ, wonkyStack, fallView, POP_DELAY, truckPopScale, otherTrucksShown, truckPopChanges } from '../js/game.js';

import { NONE, pts, run, faceStack, flatWorld, driveUntil } from './common.js';

// Fresh skid marks and their cleaning progress are authoritative multiplayer state.
{
  const host = newGame(1), guest = newGame(1);
  host.skidMarks = [{ id: 'skid:test', x: 4, y: 5, a: 0.3, left: 0.4 }];
  applySnapshot(guest, JSON.parse(JSON.stringify(snapshot(host))));
  assert.deepEqual(guest.skidMarks, host.skidMarks);
  host.skidMarks = [];
  applySnapshot(guest, JSON.parse(JSON.stringify(snapshot(host))));
  assert.deepEqual(guest.skidMarks, [], 'cleaned marks disappear on guests');
}

// Drop height is authoritative per-truck state, including when heights otherwise agree.
{
  const host = newGame(1, 0, true), guest = newGame(1, 0, true);
  host.stacks = [];
  Object.assign(host.fl, { x: 6, y: 5, a: 0, speed: 0 });
  host.H = 2; host.hy = 2 + FORK_CLEARANCE; host.dropH = 2 + FORK_CLEARANCE;
  const auth = structuredClone(snapshot(host));
  applySnapshot(guest, auth);
  assert.equal(guest.dropH, host.dropH, 'snapshot carries the drop height');
  guest.dropH = null;
  const predictor = createPredictor();
  predictor.reset(guest);
  predictor.onSnapshot(auth, 1, 0);
  predictor.fork('down', 2);
  predictor.apply(guest, 2);
  assert.equal(guest.hy, 1, 'prediction reconciles drop height even when fork heights match');
  assert.equal(guest.dropH, null);
}

// Successful link joins remove only the join parameter.
{
  assert.equal(withoutJoinParam('https://example.test/?seed=x&multiplayer=ABCDE&testing#map'), 'https://example.test/?seed=x&testing=#map');
}

// Party votes reveal only aggregate ballots, need a strict majority, and expire.
{
  const vote = createVote();
  const opened = vote.start({ type: 'level', level: 4 }, ['a', 'b', 'c'], 0);
  assert.equal(opened.status, 'active');
  assert.equal(opened.total, 3);
  assert.equal(opened.eligible, false);
  assert.equal(vote.cast(opened.id, 'stranger', 'yes', 1), null, 'non-members cannot vote');
  assert.equal(vote.cast(opened.id, 'a', 'maybe', 1), null, 'ballots are yes or no');
  vote.cast(opened.id, 'a', 'yes', 1);
  vote.cast(opened.id, 'b', 'no', 1);
  const passed = vote.cast(opened.id, 'c', 'yes', 2);
  assert.equal(passed.status, 'passed', 'two of three votes pass');
  assert.equal(passed.yes, 2);
  assert.equal(passed.no, 1);
  assert.equal('ballots' in passed, false, 'public state does not expose individual choices');
  assert.equal(vote.poll(7), null, 'results disappear after a short notice');

  const expiring = vote.start({ type: 'endless' }, ['a', 'b', 'c'], 10);
  vote.cast(expiring.id, 'a', 'no', 11);
  assert.equal(vote.poll(30).status, 'failed', 'a vote fails at its deadline without a majority');
}

// Observer readiness uses the round-end roster and never extends a deadline.
{
  const round = createRound();
  round.join('a', 'Anna');
  round.join('b', 'Bob');
  round.leave('b', 1);
  round.join('c', 'Cy');
  round.start(10);
  assert.deepEqual(round.players(), ['Anna', 'Bob', 'Cy'], 'score includes players who left');
  assert.equal(round.state('a', 10).remaining, 10);
  round.join('d', 'Dee');
  assert.equal(round.state('d', 10).eligible, false, 'late joiners do not block readiness');
  assert.equal(round.ready('a', 99, 11), false, 'stale round messages are ignored');
  assert.equal(round.ready('a', 1, 11), true);
  assert.equal(round.ready('a', 1, 11), false, 'duplicate readiness is ignored');
  assert.equal(round.state('c', 11).remaining, 9);
  round.leave('c', 12);
  assert.equal(round.state('a', 12).remaining, 3, 'disconnecting the last unready player shortens the timer');
  round.leave('a', 14);
  assert.equal(round.state('d', 14).remaining, 1, 'readiness never extends a shorter timer');
  round.reset([['d', 'Dee']]);
  assert.deepEqual(round.players(), ['Dee']);
  round.start(20);
  assert.equal(round.ready('d', 1, 20), false, 'previous round IDs cannot confirm the new round');
  assert.equal(round.ready('d', 2, 20), true);
  assert.equal(round.state('d', 20).remaining, 3);
  const empty = createRound();
  empty.start(0);
  assert.equal(empty.state(null, 0).remaining, 3, 'an empty eligible roster shortens the timer');
  const lobby = createRound();
  lobby.join('a', 'Left early', false);
  lobby.leave('a', 0);
  lobby.join('b', 'Player', false);
  lobby.begin();
  assert.deepEqual(lobby.players(), ['Player'], 'players who leave before the round starts are not scored');
  lobby.leave('b', 1);
  lobby.join('c', 'Player', true, 'session');
  lobby.leave('c', 2);
  lobby.join('d', 'Player', true, 'session');
  assert.deepEqual(lobby.players(), ['Player', 'Player'], 'a reconnect with the same session ID is counted only once');
}

// Multiplayer trucks: ghosts at spawn, collisions once separated, stack handoff on the tines, leaving players
{
  const boxes = (g) => g.stacks.reduce((n, s) => n + s.layers.length, 0) + g.trucks.reduce((n, t) => n + (t.carried ? t.carried.length : 0), 0);
  const alreadyJoined = newGame(1);
  addTruck(alreadyJoined, 'Already joined');
  assert.deepEqual(truckPopChanges(alreadyJoined, new Map()), [], 'trucks present on the first sight of a game stay silent');

  const popGame = newGame(1);
  const popHistory = new Map();
  assert.deepEqual(truckPopChanges(popGame, popHistory), [], 'the first sight of a game is silent');
  addTruck(popGame, 'Pop');
  assert.equal(truckPopChanges(popGame, popHistory)[0].kind, 'in', 'a first-time local player joining is detected');
  popGame.popVis = { 1: { t: popGame.clock, kind: 'in' } };
  assert.equal(otherTrucksShown(popGame).length, 1, 'a spawning truck is visible inside the pop smoke');
  assert.equal(truckPopScale(popGame, 1), 0.03, 'it starts tiny');
  popGame.clock += POP_DELAY / 2;
  assert.ok(truckPopScale(popGame, 1) > 0.03 && truckPopScale(popGame, 1) < 1, 'it grows during the smoke');
  popGame.clock += POP_DELAY;
  assert.equal(truckPopScale(popGame, 1), 1, 'it reaches full size');
  popGame.popVis[1] = { t: popGame.clock, kind: 'out' };
  popGame.trucks[1].gone = true;
  assert.equal(otherTrucksShown(popGame).length, 1, 'a disconnect stays visible during its pop');
  assert.equal(truckPopScale(popGame, 1), 1, 'it waits for the smoke to build');
  popGame.clock += POP_DELAY * 0.75;
  assert.ok(truckPopScale(popGame, 1) < 1 && truckPopScale(popGame, 1) > 0.03, 'it shrinks after the smoke builds');
  popGame.clock += POP_DELAY;
  assert.equal(otherTrucksShown(popGame).length, 0, 'it is hidden after the pop');

  const visual = newGame(1);
  visual.stacks = [];
  addTruck(visual, 'Visual');
  Object.assign(visual.trucks[1].fl, { x: 100, y: 100 });
  visual.ghostPairs = [];
  visual.popVis = { 1: { t: visual.clock, kind: 'in' } };
  const truckExtent = () => {
    const a = dynamicMeshes(visual, 'ov', [100, 100]).opaque.floats();
    let extent = 0;
    for (let i = 0; i < a.length; i += 10) {
      const d = Math.hypot(a[i] - 100, a[i + 1] - 100);
      if (d < 10) extent = Math.max(extent, d);
    }
    return extent;
  };
  const tinyExtent = truckExtent();
  visual.clock += POP_DELAY;
  assert.ok(truckExtent() > tinyExtent * 10, 'WebGL truck geometry scales up from tiny');

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

  // Hard-mode handoffs preserve physical tine height for both trucks.
  {
    const h = newGame(1, 0, true);
    addTruck(h, 'Carrier');
    h.ghostPairs = [];
    h.stacks = [{ x: 10, y: 10, layers: [0], a: 0, rots: [0] }];
    const a = h.trucks[0], b = h.trucks[1];
    Object.assign(b.fl, { x: 10 - FL.carryX, y: 10, a: 0, speed: 0 });
    forkUp(truckView(h, 1));
    assert.ok(Math.abs(b.hy - b.H - FORK_CLEARANCE) < 1e-6);
    Object.assign(a.fl, { x: 10 + FL.carryX, y: 10, a: Math.PI, speed: 0 });
    forkUp(h);
    assert.deepEqual(a.carried, [0]);
    assert.equal(b.carried, null);
    assert.ok(Math.abs(a.hy - a.H - FORK_CLEARANCE) < 1e-6);
    forkDown(h);
    assert.equal(a.carried, null);
    assert.deepEqual(b.carried, [0]);
    assert.ok(Math.abs(b.hy - b.H - FORK_CLEARANCE) < 1e-6);
  }

  // a receiver cannot take only the upper box from a carried barrel
  {
    const barrelGame = newGame(1);
    addTruck(barrelGame, 'Barrel carrier');
    barrelGame.ghostPairs = [];
    const barrelStack = wonkyStack({ x: 10, y: 10, layers: [BARREL_COLOR, BARREL_COLOR], barrelAt: 0 });
    barrelGame.stacks = [barrelStack];
    const carrier = barrelGame.trucks[1], receiver = barrelGame.trucks[0];
    Object.assign(carrier.fl, { x: barrelStack.x - FL.carryX, y: barrelStack.y, a: 0, speed: 0 });
    forkUp(truckView(barrelGame, 1));
    assert.equal(carrier.carried.length, 2);
    const carryPoint = toWorld(carrier.fl, FL.carryX, 0);
    Object.assign(receiver.fl, { x: carryPoint.x + FL.carryX, y: carryPoint.y, a: Math.PI, speed: 0 });
    receiver.H = 2;
    forkUp(barrelGame);
    assert.equal(receiver.carried, null, 'the top half remains with the carrier');
    assert.equal(carrier.carried.length, 2, 'the barrel stays intact');
  }

  // split: truck 0 puts its tines inside a carried stack and takes only the boxes from that level up; then puts them back on top
  {
    const g4 = newGame(1);
    addTruck(g4, 'B');
    g4.ghostPairs = [];
    const a = g4.trucks[0], b = g4.trucks[1];
    Object.assign(b.fl, { x: 10, y: 10, a: 0, speed: 0 });
    const pc = toWorld(b.fl, FL.carryX, 0);
    Object.assign(a.fl, { x: pc.x + FL.carryX + 0.2, y: pc.y - 0.1, a: Math.PI, speed: 0 });
    const originalOffs = [{ x: 0, y: 0 }, { x: 0, y: 0.05 }, { x: 0.1, y: 0.05 }];
    b.H = 1; b.carried = [0, 1, 2]; b.carriedRots = [0, 0, 0]; b.carriedPen = []; b.carriedOffs = originalOffs; b.carriedRel = 0;
    const boxCenter = (t, i) => toWorld(t.fl, FL.carryX + t.carriedOffs[i].x, t.carriedOffs[i].y);
    const original = b.carried.map((_, i) => boxCenter(b, i));
    const checkCenter = (t, i, expected) => {
      const p = boxCenter(t, i);
      assert.ok(Math.hypot(p.x - expected.x, p.y - expected.y) < 1e-9, 'handoff keeps the box in the same world position');
    };
    a.H = 2;
    forkUp(g4);
    assert.deepEqual(a.carried, [1, 2], 'took the boxes from its tines up');
    assert.deepEqual(b.carried, [0], 'the lower box stays on the other forks');
    assert.equal(a.H, 2);
    checkCenter(a, 0, original[1]);
    checkCenter(a, 1, original[2]);
    const sum = a.carried.length + b.carried.length;
    forkDown(g4);
    assert.equal(a.carried, null, 'put the boxes onto the other stack');
    assert.deepEqual(b.carried, [0, 1, 2]);
    original.forEach((p, i) => checkCenter(b, i, p));
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
    b.carried = Array.from({ length: MAX_LAYERS - 1 }, (_, i) => i % 4); a.carried = [1, 2]; a.carriedRots = [0, 0]; a.carriedPen = []; a.carriedOffs = []; a.H = MAX_LAYERS - 1;
    forkDown(g4);
    assert.equal(b.carried.length, MAX_LAYERS - 1, 'over MAX_LAYERS is refused');
  }

  // a player leaving puts the carried boxes down and frees the slot
  removeTruck(g, 1);
  assert.equal(boxes(g), total, 'no box lost when a player leaves');
  assert.equal(g.trucks[1].gone, true);
  assert.equal(addTruck(g, 'C'), 1, 'the slot is reused');
  for (let i = 0; i < 3; i++) addTruck(g, 'x');
  assert.equal(addTruck(g, 'full'), -1, 'at most four trucks');

  // An observer host has no truck; guests can occupy the four real truck slots.
  const observer = newGame(1);
  removeTruck(observer, 0);
  assert.equal(observer.trucks[0].gone, true, 'the observer host owns no truck');
  assert.equal(addTruck(observer, 'Guest 1'), 0, 'slot 0 is reused by the first guest');

  const joinUrl = 'https://palletpolka.gnutt.se/?multiplayer=ABCDE';
  const joinQr = qrMatrix(joinUrl);
  assert.equal(joinQr.length, QR_SIZE, 'the QR matrix is a version 3 square');
  assert.ok(joinQr.every((row) => row.length === QR_SIZE), 'the QR matrix has complete rows');
  assert.equal(qrMatrix('x'.repeat(60)).length, 33, 'longer deployment URLs use version 4');
  assert.equal(qrMatrix('x'.repeat(90)).length, 37, 'still longer URLs use version 5');
  assert.throws(() => qrMatrix('x'.repeat(107)), RangeError, 'unrepresentable URLs are rejected');

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
  let changes = 0, started = false, hostClock = 0, appliedVote = null, guestVote = null, guestVotingEnabled = null;
  const h = createHost({ relay, getGame: () => host, levelInfo: info, isStarted: () => started, name: 'Anna', onChange: () => changes++, onVoteResult: (action) => { appliedVote = action; }, linkFactory, clock: () => hostClock });
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
    onVote: (state, enabled) => { guestVote = state; guestVotingEnabled = enabled; },
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

  const savedStacks = host.stacks;
  host.stacks = [];
  host.trucks[1].H = host.trucks[1].hy = 4;
  guest.sendFork('down');
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(host.trucks[1].H, 3, 'first guest tap lowers one level');
  guest.sendFork('down');
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(host.trucks[1].H, 0, 'second guest tap lowers to the floor');
  host.trucks[1].H = host.trucks[1].hy = 1;
  host.stacks = savedStacks;

  assert.equal(h.callVote({ type: 'mode', hard: true }), true, 'host can initiate a vote');
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(guestVote.status, 'active');
  assert.equal(guestVote.eligible, true, 'all connected players receive a ballot');
  guest.castVote(guestVote.id, 'yes');
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(h.voteState().yes, 1);
  assert.equal(appliedVote, null, 'one of two players is not a majority');
  assert.equal(h.castVote(guestVote.id, 'yes'), true);
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(guestVote.status, 'passed');
  assert.deepEqual(appliedVote, { type: 'mode', hard: true }, 'the host applies a passed action');
  assert.equal('ballots' in guestVote, false, 'individual choices are never sent to guests');
  guest.callVote({ type: 'level', level: 2 });
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(guestVote.status, 'active', 'a guest can call a vote in a driving-host party');
  const cancelledId = guestVote.id;
  h.setVotingEnabled(false);
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(guestVotingEnabled, false);
  assert.equal(guestVote, null, 'disabling voting cancels the current ballot');
  guest.callVote({ type: 'endless' });
  guest.castVote(cancelledId, 'yes');
  assert.equal(h.callVote({ type: 'endless' }), false, 'host cannot call a vote while disabled');
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(h.voteState(), null, 'guest requests cannot bypass the setting');
  let newGuestVotingEnabled = null;
  const disabledJoin = createGuest({ relay, code: 'ABCDE', name: 'Late', linkFactory, onGame: () => {}, onVote: (_state, enabled) => { newGuestVotingEnabled = enabled; } });
  await disabledJoin.join();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(newGuestVotingEnabled, false, 'a new guest is told voting is disabled');
  disabledJoin.close();
  for (let i = 0; i < 3; i++) await tick();
  h.setVotingEnabled(true);
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(guestVotingEnabled, true);
  guest.callVote({ type: 'endless' });
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(guestVote.action.type, 'endless', 'voting works again after re-enabling');
  h.setVotingEnabled(false);
  h.setVotingEnabled(true);

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

  // Prediction displays offset-only stack motion, then accepts the host's geometry.
  {
    const pg = newGame(1, 0, true);
    pg.stacks = [
      { x: 10, y: 5, a: 0, layers: [0, 1], rots: [0, 0], offs: [{ x: 0, y: 0 }, { x: 0.3, y: 0 }] },
      { x: 11.3, y: 5, a: 0, layers: [2, 3], rots: [0, 0], offs: [{ x: 0, y: 0 }, { x: -0.3, y: 0 }] },
    ];
    Object.assign(pg.fl, { x: 4, y: 4, a: 0, speed: 0 });
    const pr = createPredictor();
    pr.reset(pg);
    pr.step(pg, {}, 1 / 120, 0);
    pr.apply(pg, 0);
    assert.ok(pg.stacks[0].offs[1].x < 0.2, 'predicted upper-box displacement is displayed');
    const auth = structuredClone(snapshot(pg));
    auth.stacks[0].offs[1].x = 0.1;
    auth.stacks[0].rots[1] = 0.2;
    pr.onSnapshot(auth, 1, 0);
    pr.fork('up', 2);
    pr.apply(pg, 2);
    assert.equal(pg.stacks[0].offs[1].x, 0.1, 'host offset replaces expired prediction');
    assert.equal(pg.stacks[0].rots[1], 0.2, 'host rotation replaces expired prediction');
  }

  // Held hard-mode fork motion stays predicted until it is old enough for host correction.
  {
    const pg = newGame(1, 0, true);
    pg.stacks = [{ x: 10, y: 5, a: 0, layers: [0], rots: [0], offs: [{ x: 0, y: 0 }] }];
    Object.assign(pg.fl, { x: 4, y: 4, speed: 0 });
    const auth = structuredClone(snapshot(pg)), pr = createPredictor();
    pr.reset(pg);
    for (let i = 1; i <= 42; i++) pr.step(pg, { forkUp: true }, 1 / 60, i / 60);
    auth.stacks[0].x += 0.4;
    pr.onSnapshot(auth, 0.7, 0.05);
    pr.apply(pg, 0.7);
    assert.ok(pg.hy > 0.3 && pg.hy < 1, 'held motion is shown despite an older host snapshot');
    assert.equal(pg.stacks[0].x, 10.4, 'other players can still move stacks while the fork is held');
    pr.onSnapshot(auth, 1.2, 0.05);
    pr.step(pg, { forkUp: true }, 0, 1.2);
    pr.apply(pg, 1.2);
    assert.equal(pg.hy, 0, 'host corrects fractional height even within the same level');
  }

  // Multiplayer contacts use the actual upper-layer footprints and height intervals.
  {
    const setup = (otherHeight) => {
      const g = newGame(1, 0, true);
      g.stacks = []; g.walls = []; g.zones = [];
      addTruck(g, 'Bob');
      g.ghostPairs = [];
      g.trucks.forEach((t, i) => {
        Object.assign(t.fl, { x: i ? 11.5 : 8, y: 5, a: i ? Math.PI : 0, speed: 0 });
        t.H = i ? otherHeight : 1; t.hy = t.H + FORK_CLEARANCE;
        t.carried = [0, 1]; t.carriedRel = 0; t.carriedRots = [0, 0];
        t.carriedOffs = [{ x: 0, y: 0 }, { x: 0.4, y: 0 }];
        t.carriedPen = [{ crash: 0, sq: 0 }, { crash: 0, sq: 0 }];
      });
      return g;
    };
    const g = setup(1);
    const top = (t) => {
      const p = toWorld(t.fl, FL.carryX + t.carriedOffs[1].x, t.carriedOffs[1].y);
      return rectPoly(p.x, p.y, 0.5, 0.5, t.fl.a + t.carriedRots[1]);
    };
    assert.ok(sat(top(g.trucks[0]), top(g.trucks[1])));
    update(g, {}, 1 / 120);
    assert.ok((sat(top(g.trucks[0]), top(g.trucks[1]))?.depth || 0) < 1e-4);
    const separated = setup(3);
    update(separated, {}, 1 / 120);
    assert.equal(separated.trucks[0].fl.x, 8, 'loads at separate heights do not push');
    assert.equal(separated.trucks[1].fl.x, 11.5);
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

  // Mixed physics versions must not simulate the same hard-mode party.
  const oldGuestLink = (opts) => {
    const link = linkFactory(opts), send = link.sendReliable;
    link.sendReliable = (msg) => {
      if (msg.t === 'hello') { const { hardPhysicsVersion, ...old } = msg; return send(old); }
      return send(msg);
    };
    return link;
  };
  let versionError = '';
  const oldGuest = createGuest({ relay, code: 'ABCDE', name: 'Old', linkFactory: oldGuestLink, onGame: () => {}, onClosed: (why) => { versionError = why; } });
  await oldGuest.join();
  for (let i = 0; i < 6; i++) await tick();
  assert.ok(oldGuest.slot > 0, 'old guest can join an easy-mode party');
  host = newGame(8, 3, true);
  h.levelLoaded(host);
  for (let i = 0; i < 6; i++) await tick();
  assert.match(versionError, /physics differs/i, 'switching to hard disconnects an incompatible guest');
  assert.equal(host.trucks.filter((t) => !t.gone).length, 1, 'incompatible guest never gets a truck');
  versionError = '';
  const oldHardGuest = createGuest({ relay, code: 'ABCDE', name: 'OldHard', linkFactory: oldGuestLink, onClosed: (why) => { versionError = why; } });
  await oldHardGuest.join();
  for (let i = 0; i < 6; i++) await tick();
  assert.match(versionError, /physics differs/i, 'host rejects a guest without the current solver');
  const oldHostLink = (opts) => linkFactory({ ...opts, onMessage: (msg) => {
    if (msg.t === 'welcome') { const { hardPhysicsVersion, ...old } = msg; opts.onMessage(old); }
    else opts.onMessage(msg);
  } });
  versionError = '';
  const oldHostGuest = createGuest({ relay, code: 'ABCDE', name: 'New', linkFactory: oldHostLink, onClosed: (why) => { versionError = why; } });
  await oldHostGuest.join();
  for (let i = 0; i < 6; i++) await tick();
  assert.match(versionError, /physics differs/i, 'guest rejects a hard-mode host without the current solver');
  host = newGame(8, 3, false);
  h.levelLoaded(host);

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
  let dan = joinCy('Dan');
  await dan.join();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(h.kick(dan.slot), true);
  cyClosed = null;
  dan = joinCy('dan');
  await dan.join();
  for (let i = 0; i < 6; i++) await tick();
  assert.match(cyClosed, /wait 60 seconds/i, 'a kicked name cannot immediately rejoin');
  hostClock = 60;
  cyClosed = null;
  dan = joinCy('Dan');
  await dan.join();
  for (let i = 0; i < 6; i++) await tick();
  assert.ok(dan.slot > 0, 'a kicked player can rejoin when the cooldown expires');
  dan.close();
  h.close();
  assert.equal(ended, 'tok', 'party ended at the relay');
  host = newGame(1);
  removeTruck(host, 0);
  let observerClock = 0;
  const observerHost = createHost({ relay, getGame: () => host, levelInfo: info, isStarted: () => true, name: 'Observer', meta: { observer: true }, linkFactory, clock: () => observerClock });
  await observerHost.start();
  for (let i = 0; i < 120; i++) update(host, null, 1 / 120);
  assert.equal(host.trucks.filter((t) => !t.gone).length, 0, 'starting an observer game does not create a truck');
  host = newGame(2);
  removeTruck(host, 0);
  observerHost.levelLoaded(host);
  assert.equal(host.trucks.filter((t) => !t.gone).length, 0, 'changing levels with no guests does not spawn a truck');
  const observerGuests = [];
  const roundStates = [];
  const observerVoteStates = [];
  const observerVotingEnabled = [];
  const observerGames = [];
  for (let i = 0; i < 4; i++) {
    const player = createGuest({ relay, code: 'ABCDE', name: `Guest ${i + 1}`, linkFactory, onGame: (state) => { observerGames[i] = state; }, onRound: (state) => { roundStates[i] = state; }, onVote: (state, enabled) => { observerVoteStates[i] = state; observerVotingEnabled[i] = enabled; } });
    observerGuests.push(player);
    await player.join();
    for (let j = 0; j < 6; j++) await tick();
    assert.equal(player.slot, i, 'all four truck slots are available to guests');
    assert.equal(observerGames[i].observer, true, 'guests know slot zero is not the host in observer mode');
  }
  host = newGame(3);
  removeTruck(host, 0);
  observerHost.levelLoaded(host);
  assert.deepEqual(host.trucks.filter((t) => !t.gone).map((t) => t.name), ['Guest 1', 'Guest 2', 'Guest 3', 'Guest 4'], 'level changes restore every guest in the same slot');
  observerGuests[1].callVote({ type: 'kick', slot: 0 });
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(observerVoteStates[1].action.slot, 0, 'a guest can call a vote against the first observer-party slot');
  observerHost.setVotingEnabled(false);
  for (let i = 0; i < 3; i++) await tick();
  assert.ok(observerVotingEnabled.every((enabled) => !enabled));
  assert.ok(observerVoteStates.every((state) => state === null), 'observer disabling voting cancels the ballot for everyone');
  observerHost.setVotingEnabled(true);
  assert.equal(observerHost.callVote({ type: 'mode', hard: true }), true, 'observer hosts can call player votes');
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(observerHost.voteState().total, 4, 'observer is not counted as a voter');
  assert.equal(observerHost.voteState().eligible, false, 'observer has no ballot');
  assert.equal(observerVoteStates[0].eligible, true, 'players receive ballots on observer-hosted games');
  for (let i = 0; i < 3; i++) observerGuests[i].castVote(observerVoteStates[i].id, 'yes');
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(observerVoteStates[0].status, 'passed', 'guest votes pass by majority with an observer host');
  observerGuests[0].sendInput({ up: true, horn: true });
  for (let i = 0; i < 3; i++) await tick();
  const before = { ...host.trucks[0].fl };
  for (let i = 0; i < 120; i++) update(host, null, 1 / 120);
  assert.ok(Math.hypot(host.trucks[0].fl.x - before.x, host.trucks[0].fl.y - before.y) > 0.1, 'slot 0 follows guest input on an observer host');
  assert.equal(host.trucks[0].horn, true, 'slot 0 retains the guest horn input');
  observerHost.startRound();
  for (let i = 0; i < 3; i++) await tick();
  assert.ok(roundStates.every((state) => state.eligible && state.remaining === 10), 'all guests receive the countdown');
  for (let i = 1; i < 4; i++) observerGuests[i].ready(roundStates[i].id);
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(observerHost.roundState().remaining, 10, 'an unready guest keeps the original timer');
  observerClock = 2;
  assert.equal(observerHost.kick(0), true, 'observer can kick the first guest');
  assert.equal(host.trucks[0].gone, true);
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(observerHost.roundState().remaining, 3, 'kicking the unready player shortens the timer');
  assert.deepEqual(observerHost.roundPlayers(), ['Guest 1', 'Guest 2', 'Guest 3', 'Guest 4'], 'the kicked participant remains on the round score');
  observerHost.close();
  for (const player of observerGuests) player.close();
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
