import assert from 'node:assert/strict';
import { BARREL_COLOR, COLORS, ZONE_COLORS, generateLevel, parseSeed, isReachable } from '../js/level.js';
import { pointRectDist, FORK_CLEARANCE, LEVEL_H, TINE_H, PALLET_DECK_H } from '../js/geom.js';
import { FL, toLocal, toWorld, maxSteerFor } from '../js/forklift.js';
import { reverseLight, REV_RADIUS } from '../js/revlight.js';
import { serializeGame, deserializeGame, encodeState, decodeState, serializeEndless, deserializeEndless } from '../js/savestate.js';
import { chaseOrbit, lookYawDelta } from '../js/gl/camera.js';
import { chaseDrift, povCamera, overviewCamera, chaseCamera, chaseRig, chaseTiles, chaseZoom, clearChaseTilt, groundFootprint, blendCameras, CHASE_TILT } from '../js/gl/camera.js';
import { staticMeshes, dynamicMeshes, ceilingClip, renderMode, CEILING_HIDE_Z } from '../js/gl/scene.js';
import { addStack as addGLStack, addForks as addGLForks, PAL, PALLET_COLOR } from '../js/gl/models.js';
import { buildFaces as buildPovFaces } from '../js/pov/scene.js';
import { makeCamera } from '../js/pov/camera.js';
import { tapeShapes, TAPE_FILL } from '../js/repair.js';
import { popupScale, placePhoto, drawPhoto, boxStatus, issues, stripHeight, scoreText } from '../js/photo.js';
import { projectPoint } from '../js/gl/mat.js';
import { oilDropMark } from '../js/decals.js';
import { setThemeMode } from '../js/theme.js';
import { draw, drawForkGauge, observerLayout, placeObserverCard, observerObstacles } from '../js/render.js';
import { drawHintArrow, repairHintOn, setRepairHint } from '../js/repairhint.js';
import { setDiscoEnabled } from '../js/disco.js';
import { createDemo } from '../js/demo.js';
import { createHost } from '../js/net/host.js';
import { createGuest } from '../js/net/guest.js';
import { createPredictor } from '../js/net/predict.js';
import { applySnapshot, createInterpolator, snapshot } from '../js/net/protocol.js';
import { rectPoly, sat } from '../js/geom.js';
import { TRUCK_BONUS, lorryHonks, newEndless, stepEndless, endEndless, rampDecals, truckRoofs, numberRects, dockWaits, truckGeom, unloadRate, interval, endlessScore, animatedDoors } from '../js/endless.js';
import { newGame, update, addTruck, removeTruck, truckView, isGhost, ghostBetween, forkUp, forkDown, carriedDrawH, stackInZone, isParked, isFinished, score, maxScore, lostBreakdown, zoneWonky, zoneDone, zonePoints, zoneLabelPos, stackZ, wonkyStack, fallView } from '../js/game.js';
import { addParticles, setParticlesEnabled, shouldSpawnSetdownDust } from '../js/gl/particles.js';
import { Mesh, parseColor } from '../js/gl/mesh.js';

import { NONE, pts, run, faceStack, flatWorld, driveUntil } from './common.js';

// Toppled boxes keep their drawing-only fall height in both 3D renderers.
{
  const g = newGame(1);
  g.zones = []; g.hatch = null; g.bot = null; g.inspector = null; g.repair = null;
  Object.assign(g.fl, { x: 3, y: 3, a: 0, speed: 0 });
  g.stacks = [{ x: 10, y: 5, layers: [0], rots: [0], a: 0, offs: [{ x: 0, y: 0 }], pen: [{ crash: 0, sq: 0, deco: 0 }],
    fall: { t0: 0, dx: 0, dy: 0, dr: 0, z: 2, from: 0 } }];
  const tops = [];
  for (const clock of [0, 0.25, 0.5]) {
    g.clock = clock;
    const mesh = dynamicMeshes(g, 'pov', [8, 5]).opaque, zs = [];
    for (let i = 0; i < mesh.n; i += 10) {
      if (mesh.a[i] > 9 && mesh.a[i] < 11 && mesh.a[i + 1] > 4 && mesh.a[i + 1] < 6) zs.push(mesh.a[i + 2]);
    }
    const top = Math.max(...zs);
    const faces = buildPovFaces(g, makeCamera({ x: 8, y: 5 }, 2, 0, Math.PI / 2, 0, 0, 800, 400));
    const softwareTop = Math.max(...faces.filter((f) => f.color === COLORS[0]).flatMap((f) => f.quad.map((p) => p[2])));
    assert.ok(Math.abs(top - softwareTop) < 0.02, 'software and GL render the falling box at matching heights');
    tops.push(top);
  }
  assert.ok(tops[0] > tops[1] && tops[1] > tops[2], 'the box visibly descends before landing');
  assert.ok(Math.abs(tops[2] - 0.6) < 0.02, 'the landed box rests on the floor');
}

// All views show the same box height before pickup, while carried, and after release.
{
  const g = newGame(1, 1, true);
  flatWorld(g);
  g.zones = []; g.hatch = null; g.bot = null; g.inspector = null; g.repair = null;
  g.stacks = [{ x: 10, y: 5, layers: [1, 0], a: 0 }];
  faceStack(g, 0);
  g.H = g.hy = g.hf = 1;
  const cam = makeCamera({ x: 8, y: 5 }, 2, 0, Math.PI / 2, 0, 0, 800, 400);
  const check = (height) => {
    const color = parseColor(COLORS[0]), mesh = dynamicMeshes(g, 'pov', [8, 5]).opaque, zs = [];
    for (let i = 0; i < mesh.n; i += 10) {
      if (color.slice(0, 3).every((c, j) => Math.abs(mesh.a[i + 6 + j] - c) < 1e-6)) zs.push(mesh.a[i + 2]);
    }
    const glTop = Math.max(...zs);
    const faces = buildPovFaces(g, cam);
    const povTop = Math.max(...faces.filter((f) => f.color === COLORS[0]).flatMap((f) => f.quad.map((p) => p[2])));
    assert.ok(Math.abs(glTop - (height + 1) * 0.6) < 1e-5, `GL box height ${glTop}`);
    assert.ok(Math.abs(povTop - glTop) < 1e-5, `software cabin box height ${povTop}`);

    const translations = [];
    const ctx = new Proxy({ canvas: { width: 1200, height: 800 } }, {
      get: (t, k) => k in t ? t[k] : k === 'translate' ? (x, y) => translations.push([x, y])
        : k === 'measureText' ? (text) => ({ width: text.length * 7 })
          : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {},
      set: (t, k, v) => { t[k] = v; return true; },
    });
    const oldOffscreen = globalThis.OffscreenCanvas;
    globalThis.OffscreenCanvas = class { getContext() { return ctx; } };
    try { draw(ctx, g, { width: 1200, height: 800, dpr: 1 }); }
    finally { globalThis.OffscreenCanvas = oldOffscreen; }
    assert.ok(translations.some(([x, y]) => Math.abs(x - (10 + height * 0.06)) < 1e-6 && Math.abs(y - (5 - height * 0.1)) < 1e-6), 'overview draws the box at the same height');
  };
  run(g, { forkUp: true }, 0.025);
  assert.equal(g.carried, null);
  check(1);
  run(g, { forkUp: true }, 0.4);
  assert.ok(g.carried);
  check(g.hf - FORK_CLEARANCE);
  run(g, {}, 0.05);
  run(g, { forkDown: true }, 0.1);
  run(g, {}, 1 / 120);
  assert.equal(g.carried, null);
  assert.ok(g.stacks[0].dropFrom != null);
  check(Math.max(1, g.hf - FORK_CLEARANCE));
}

// The pallet deck touches the tines when a box is carried in either mode.
{
  for (const hard of [false, true]) {
    const g = newGame(1, 1, hard);
    g.carried = [0]; g.carriedRots = [0]; g.carriedPen = [{}]; g.carriedOffs = [{ x: 0, y: 0 }];
    g.H = 1; g.hy = hard ? 1.5 : 1; g.hf = g.hy + FORK_CLEARANCE;
    const boxes = [], forks = [];
    addGLStack({ cuboid: (...p) => boxes.push(p) }, new Mesh(), 10, 5, [0], [0], carriedDrawH(g), [], 0, 0, [{}]);
    addGLForks({ cuboid: (...p) => forks.push(p) }, g, true);
    const deckBottom = boxes.find((p) => Math.abs(p[5] - (carriedDrawH(g) * LEVEL_H + PAL - PALLET_DECK_H)) < 1e-8)[5];
    assert.ok(Math.abs(deckBottom - forks[0][6]) < 1e-8, 'pallet deck meets the top of the tine');
    assert.ok(Math.abs(forks[0][6] - forks[0][5] - 0.05) < 1e-8, 'tines are half their former thickness');
    assert.ok(Math.abs(PAL - PALLET_DECK_H - 0.095) < 1e-8, 'pallet opening is half its former height');
    assert.ok(boxes.some((p) => Math.abs(p[5] - (carriedDrawH(g) * LEVEL_H + PAL)) < 1e-8 &&
      Math.abs(p[6] - ((carriedDrawH(g) + 1) * LEVEL_H)) < 1e-8), 'box grows down to the deck while its top stays at the same level');
  }
}

// Barrel pallets retain the full-size footprint and leave room for the tines beneath the deck.
{
  const layers = [BARREL_COLOR, BARREL_COLOR], pen = [{ barrelPart: 'base' }, { barrelPart: 'top' }];
  const wood = [], drums = [], x = 6, y = 5;
  const mesh = { cuboid: (...args) => wood.push(args), cylinder: (...args) => drums.push(args), disc() {}, tri() {}, poly() {} };
  addGLStack(mesh, new Mesh(), x, y, [0, 0], layers, 0, [], 0, 0, pen);
  const maxX = Math.max(...wood.map(([cx, , , hx]) => cx + hx));
  const maxY = Math.max(...wood.map(([, cy, , , hy]) => cy + hy));
  assert.ok(Math.abs(maxX - x - 0.5) < 1e-8 && Math.abs(maxY - y - 0.5) < 1e-8);
  assert.ok(Math.abs(PAL - PALLET_DECK_H - TINE_H - FORK_CLEARANCE * LEVEL_H) < 1e-9, 'the slot has the intended free tine travel');
  assert.ok(wood.filter((p) => p[5] > 0).every((p) => p[5] > TINE_H), 'GL deck clears the full-height tine');
  assert.equal(drums[0][2], Math.max(...wood.map((p) => p[6])), 'the drum sits on the deck');

  const g = newGame(1);
  g.stacks = [{ x, y, layers, pen, a: 0 }];
  const faces = buildPovFaces(g, makeCamera({ x: x - 2, y }, 1.5, 0, Math.PI / 2, 0, 0, 800, 400));
  const pallet = faces.filter((f) => f.color === PALLET_COLOR), barrel = faces.filter((f) => f.color === COLORS[BARREL_COLOR]);
  const palletDeck = Math.max(...pallet.flatMap((f) => f.quad.map((p) => p[2])));
  assert.equal(palletDeck, drums[0][2], 'software and GL decks agree');
  assert.equal(Math.min(...barrel.flatMap((f) => f.quad.map((p) => p[2]))), palletDeck);
  assert.ok(pallet.some((f) => f.quad.every((p) => p[2] > TINE_H)), 'software deck clears the tines');
}

// The open-top tape strap stays aligned with the standard box tape when the box rotates.
{
  const bounds = (rot) => {
    const mesh = new Mesh();
    addGLStack(mesh, new Mesh(), 0, 0, [rot], [0], 0, [], 0, 0, [{ open: true }]);
    const strap = [];
    for (let i = 0; i < mesh.n; i += 10) {
      if (Math.abs(mesh.a[i + 6] - 85 / 255) < 1e-4 && Math.abs(mesh.a[i + 7] - 91 / 255) < 1e-4 && Math.abs(mesh.a[i + 8] - 96 / 255) < 1e-4) strap.push([mesh.a[i], mesh.a[i + 1]]);
    }
    const xs = strap.map(([x]) => x), ys = strap.map(([, y]) => y);
    return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  };
  const [wideX, wideY] = bounds(0), [tallX, tallY] = bounds(Math.PI / 2);
  assert.ok(wideY > wideX && tallX > tallY, 'the strap follows the same local axis as standard-box tape');
}

// Open-top warning decals appear on the two fork-entry faces, not the blocked sides.
{
  const decals = new Mesh();
  addGLStack(new Mesh(), decals, 0, 0, [0], [0], 0, [], 0, 0, [{ open: true }]);
  let entryFaces = 0, blockedSideFaces = 0;
  for (let i = 0; i < decals.n; i += 30) {
    const tri = [0, 10, 20].map((j) => [decals.a[i + j], decals.a[i + j + 1], decals.a[i + j + 2]]);
    if (Math.max(...tri.map((p) => p[2])) >= 0.6) continue;
    const xs = tri.map((p) => p[0]), ys = tri.map((p) => p[1]);
    const sameX = Math.max(...xs) - Math.min(...xs) < 1e-4;
    const sameY = Math.max(...ys) - Math.min(...ys) < 1e-4;
    if (sameX && Math.abs(Math.abs(xs[0]) - 0.5) < 0.01) entryFaces++;
    if (sameY && Math.abs(Math.abs(ys[0]) - 0.5) < 0.01) blockedSideFaces++;
  }
  assert.ok(entryFaces > 0, 'warning decals remain on the fork-entry ends');
  assert.equal(blockedSideFaces, 0, 'no warning decals are on the runner-blocked sides');
}

// The cabin view shows open-top warning decals only on the two fork-entry faces.
{
  const g = newGame(1);
  g.stacks = [{ x: 10, y: 10, layers: [0], rots: [0], a: 0, pen: [{ open: true }] }];
  const visibleDecalEdges = (x, yaw) => buildPovFaces(g, makeCamera({ x, y: 10 }, 2, yaw, Math.PI / 2, 0, 0, 800, 400))
    .filter((face) => face.deco === 4).map((face) => face.edge);
  assert.deepEqual(visibleDecalEdges(8, 0), [3], 'the back entry face has its decal');
  assert.deepEqual(visibleDecalEdges(12, Math.PI), [1], 'the front entry face has its decal');
}

// The observer join card floats over the full-size map without sacrificing readability.
{
  for (const [width, height] of [[1200, 800], [390, 844], [844, 390]]) {
    const withCard = observerLayout(width, height, 30, 20, true);
    const without = observerLayout(width, height, 30, 20, false);
    const a = withCard.area, c = withCard.card;
    assert.deepEqual(a, without.area, 'the card never reserves space or shrinks the map');
    assert.ok(c.w >= 180 && c.angle !== 0, 'card has a readable minimum width and photo tilt');
    const p = placeObserverCard(a, c, [[], [], [], []]);
    assert.ok(p.x >= a.x && p.y >= a.y && p.x + p.bw <= a.x + a.w && p.y + p.bh <= a.y + a.h, 'rotated corners fit inside the viewport');
  }
  assert.equal(observerLayout(240, 240, 30, 20, true).card.w, 180, 'even a tiny screen does not reduce the minimum size');
  const g = newGame(1);
  const withTruck = dynamicMeshes(g, 'ov', [0, 0]).opaque.count;
  removeTruck(g, 0);
  assert.ok(dynamicMeshes(g, 'ov', [0, 0]).opaque.count < withTruck, 'a removed host truck is not drawn in WebGL');
}

// Join cards can choose interior spots and dodge in forklift, box, drop-zone, bot order.
{
  const area = { x: 0, y: 0, w: 400, h: 100 }, card = { w: 100, h: 100, bw: 100, bh: 100 };
  const left = { left: 0, top: 0, right: 200, bottom: 100 }, right = { ...left, left: 200, right: 400 };
  for (let priority = 0; priority < 3; priority++) {
    const groups = [[], [], [], []];
    groups[priority] = [left]; groups[priority + 1] = [right];
    const p = placeObserverCard(area, card, groups);
    assert.ok(p.x >= 200, `priority ${priority} stays clear even when the next class must be covered`);
  }
  const crowded = [[{ ...left, right: 120 }, { ...right, left: 280 }], [], [], []];
  const p = placeObserverCard(area, card, crowded);
  assert.ok(p.x >= 120 && p.x + p.bw <= 280, 'not limited to screen corners');
  assert.deepEqual(placeObserverCard(area, card, crowded, p), p, 'a free position stays put instead of jittering');
  const moved = placeObserverCard(area, card, [[{ left: p.x, right: p.x + 100, top: 0, bottom: 100 }], [], [], []], p);
  assert.ok(moved.x + moved.bw <= p.x || moved.x >= p.x + 100, 'moving forklifts make the card relocate');
  const filled = placeObserverCard(area, card, [[{ ...left, right: 400 }], [], [], []], p);
  assert.equal(filled.w, card.w, 'a crowded map does not shrink the card');
}

// Observer obstacle bounds use every live forklift, individual boxes, wide zones and visible bots.
{
  const g = newGame(1);
  removeTruck(g, 0);
  addTruck(g, 'Guest', 1);
  g.stacks = [wonkyStack({ x: 5, y: 6, layers: [0], wide: true })];
  g.zones = [{ x: 10, y: 10, color: 5, count: 1, wide: true, hx: 0.6, hy: 1.1, a: Math.PI / 2 }];
  g.bot = { x: 14, y: 12, a: 0, show: 1 };
  g.inspector = { x: 16, y: 12, a: 0, show: 0 };
  const project = (x, y, z) => [x * 20 + z * 2, y * 20 - z * 3];
  const groups = observerObstacles(g, project);
  assert.deepEqual(groups.map((r) => r.length), [1, 1, 1, 1], 'gone host and hidden inspector do not obstruct placement');
  assert.ok(groups[1][0].bottom - groups[1][0].top > 50, 'wide box footprint is respected');
  assert.ok(groups[2][0].bottom - groups[2][0].top > 50, 'wide drop zone footprint is respected');
  assert.ok(groups[2][0].right - groups[2][0].left < 50, 'zone extents are already world-aligned, not rotated twice');
  const t = truckView(g, 1);
  t.carried = [0]; t.carriedRots = [0]; t.carriedOffs = [{ x: 0, y: 0 }]; t.carriedPen = [{}];
  assert.equal(observerObstacles(g, project)[1].length, 2, 'carried boxes are also protected');
  removeTruck(g, 1);
  assert.equal(observerObstacles(g, project)[0].length, 0, 'departed forklifts stop influencing the card');
}

// Observer score bar stays visible in fullscreen without changing the driving HUD.
{
  const g = newGame(1);
  g.started = true;
  const texts = [];
  const ctx = new Proxy({ canvas: { width: 1200, height: 800 } }, {
    get: (t, k) => k in t ? t[k] : k === 'fillText' ? (text, x, y) => texts.push({ text, x, y })
      : k === 'measureText' ? (text) => ({ width: text.length * 7 })
        : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {},
    set: (t, k, v) => { t[k] = v; return true; },
  });
  const previous = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = class { getContext() { return ctx; } };
  try {
    for (const [width, height, touch] of [[1200, 800, false], [390, 844, true], [844, 390, true]]) {
      texts.length = 0;
      draw(ctx, g, { width, height, touch, dpr: 1, fullMap: true, fullscreen: true });
      assert.ok(texts.some(({ text, y }) => text.includes('Zones ') && text.includes('Score ') && y === 23), 'observer score bar appears at the top');
    }
    texts.length = 0;
    const joinView = { width: 1200, height: 800, dpr: 1, fullMap: true, partyJoin: { code: 'ABCDE', url: 'https://example.org/?multiplayer=ABCDE' } };
    draw(ctx, g, joinView);
    assert.ok(joinView.observerCard && texts.some(({ text }) => text === 'JOIN THE PARTY'), 'observer draws the floating photo caption');
    joinView.height = 390;
    draw(ctx, g, joinView);
    assert.ok(joinView.observerCard.y + joinView.observerCard.bh <= 382, 'resizing never leaves the card offscreen during its slide');
    joinView.partyJoin = null;
    draw(ctx, g, joinView);
    assert.equal(joinView.observerCard, null, 'removing join information clears the floating card');
    texts.length = 0;
    const endless = newEndless(0, false);
    draw(ctx, endless, { width: 1200, height: 800, dpr: 1, fullMap: true, fullscreen: true });
    assert.ok(texts.some(({ text, y }) => text.startsWith('Endless ') && text.includes('Score ') && y === 23), 'endless score stays visible too');
    texts.length = 0;
    draw(ctx, g, { width: 1200, height: 800, dpr: 1, fullscreen: true });
    assert.ok(!texts.some(({ text }) => text.includes('Zones ') && text.includes('Score ')), 'driving HUD still hides in fullscreen');
  } finally {
    if (previous === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = previous;
  }
}

// The desktop overview and touch-landscape strip separate both kinds of damage from placement.
{
  const g = newGame(1);
  g.started = true;
  g.stacks[0].pen[0].crash = 2;
  const wide = wonkyStack({ x: 4, y: 4, layers: [0], wide: true });
  wide.pen[0].crash = 7;
  g.stacks.push(wide);
  const texts = [];
  const canvas = { width: 1200, height: 800 };
  const ctx = new Proxy({}, {
    get: (t, k) => k === 'canvas' ? canvas : k === 'fillText' ? (text) => texts.push(text)
      : k === 'measureText' ? (text) => ({ width: text.length * 7 })
        : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {},
    set: () => true,
  });
  const previous = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = class { getContext() { return ctx; } };
  try {
    draw(ctx, g, { width: 1200, height: 800, dpr: 1 });
    assert.ok(texts.includes('Damage: −2 repairable, −7 permanent'));
    assert.ok(texts.some((text) => text.startsWith('Placement −')));
    assert.ok(!texts.includes('Damage −2 (locked)'));

    texts.length = 0;
    draw(ctx, g, { width: 1200, height: 800, dpr: 1, touch: true });
    assert.ok(texts.includes('Damage −2 repairable, −7 permanent'));
    assert.ok(texts.some((text) => text.startsWith('Placement −')));
  } finally {
    if (previous === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = previous;
  }
}

// Portrait touch banners reserve space above the overview without changing other layouts.
{
  const g = newGame(1);
  g.started = true;
  const rects = [];
  const ctx = new Proxy({ canvas: { width: 390, height: 844 } }, {
    get: (t, k) => k in t ? t[k] : k === 'rect' ? (...args) => rects.push(args)
      : k === 'measureText' ? (text) => ({ width: text.length * 7 })
        : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {},
  });
  const overviewTop = (view) => {
    rects.length = 0;
    draw(ctx, g, { dpr: 1, zoom: 0.5, ...view });
    return rects.find(([x, , w]) => x === 20 && w === view.width - 40)?.[1];
  };
  const previous = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = class { getContext() { return ctx; } };
  try {
    const portrait = { width: 390, height: 844, touch: true };
    assert.equal(overviewTop({ ...portrait, tutorialBottom: 270 }), 282);
    assert.ok(overviewTop(portrait) < 282, 'the field returns when the banner hides');
    assert.equal(overviewTop({ ...portrait, touch: false, tutorialBottom: 270 }), overviewTop({ ...portrait, touch: false }));
    const landscape = { width: 844, height: 390, touch: true };
    assert.equal(overviewTop({ ...landscape, tutorialBottom: 270 }), overviewTop(landscape));
  } finally {
    if (previous === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = previous;
  }
}

// The software cabin view renders with and without the repair-station hint.
{
  const g = newGame(1), fills = [];
  assert.ok(g.repair, 'the test level has a repair station');
  const ctx = new Proxy({ canvas: { width: 1200, height: 800 } }, {
    get: (t, k) => k in t ? t[k] : k === 'fill' ? () => fills.push(t.fillStyle)
      : k === 'measureText' ? (text) => ({ width: text.length * 7 })
        : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {},
  });
  const hint = repairHintOn();
  try {
    for (const on of [false, true]) {
      setRepairHint(on);
      fills.length = 0;
      draw(ctx, g, { width: 1200, height: 800, dpr: 1, povBig: true });
      assert.equal(fills.includes('#42a5f5'), on, 'the cabin repair arrow follows the hint state');
    }
  } finally {
    setRepairHint(hint);
  }
}

// A carried oil barrel makes its compatible minimap drop point alternate between visible highlight colours.
{
  const g = newGame(3), fills = [];
  g.w = 20; g.h = 12;
  const zone = { x: 8, y: 6, color: BARREL_COLOR, count: 1 };
  g.zones = [zone];
  g.stacks = [];
  g.carried = [BARREL_COLOR, BARREL_COLOR];
  g.carriedPen = [{ barrelPart: 'base' }, { barrelPart: 'top' }];
  const s = 16, rect = [(zone.x - 0.69) * s, (zone.y - 0.69) * s, 1.38 * s, 1.38 * s];
  const ctx = new Proxy({ canvas: { width: 1200, height: 800 } }, {
    get: (t, k) => k in t ? t[k] : k === 'fillRect' ? (...args) => fills.push({ args, color: t.fillStyle, alpha: t.globalAlpha })
      : k === 'measureText' ? (text) => ({ width: text.length * 7 })
        : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {},
  });
  const drawAt = (clock) => {
    g.clock = clock;
    fills.length = 0;
    draw(ctx, g, { width: 1200, height: 800, dpr: 1, povBig: true });
    const fill = fills.find((f) => f.args.length === 4 && f.args.every((v, i) => Math.abs(v - rect[i]) < 0.001));
    assert.ok(fill, 'minimap contains the barrel drop point');
    return fill;
  };
  const first = drawAt(0), second = drawAt(0.25);
  assert.notEqual(first.color, second.color, 'the target alternates colours');
  assert.ok([first.color, second.color].every((color) => color !== ZONE_COLORS[BARREL_COLOR]), 'neither phase falls back to the dim barrel-zone colour');
  assert.equal(first.alpha, 1, 'the highlighted target is fully opaque');
  g.carried = [BARREL_COLOR, 0];
  const mixed = drawAt(0);
  assert.equal(mixed.color, ZONE_COLORS[BARREL_COLOR], 'mixed cargo does not show a target hint');
  assert.equal(mixed.alpha, 0.5, 'an unhinted open zone keeps its normal minimap opacity');
}

// The repair arrow's outline leaves its blue shaft visible in world and pixel units.
{
  for (const size of [0.5, 20]) {
    const points = [];
    let outline;
    const ctx = new Proxy({
      moveTo: (x, y) => points.push([x, y]),
      lineTo: (x, y) => points.push([x, y]),
      stroke() { outline = this.lineWidth; },
    }, { get: (t, k) => k in t ? t[k] : () => {} });
    drawHintArrow(ctx, 0, 0, 0, size, 0);
    const shaftWidth = Math.abs(points[3][1] - points[4][1]);
    assert.ok(outline > 0 && outline < shaftWidth, `outline must not cover the shaft at size ${size}`);
  }
}

// Set-down dust is suppressed when its landing point is inside any drop zone.
{
  const zones = [{ x: 5, y: 6, color: 3, count: 4, hx: 0.6, hy: 0.4 }];
  assert.equal(shouldSpawnSetdownDust({ x: 5, y: 6 }, zones), false, 'a zone suppresses dust regardless of its required contents');
  assert.equal(shouldSpawnSetdownDust({ x: 5.68, y: 6.45 }, zones), false, 'the enlarged zone suppresses dust in its added margin');
  assert.equal(shouldSpawnSetdownDust({ x: 5.69, y: 6 }, zones), false, 'the enlarged zone boundary counts as inside');
  assert.equal(shouldSpawnSetdownDust({ x: 5.70, y: 6 }, zones), true, 'a landing point outside the zone still gets dust even if the stack overlaps its edge');
  assert.equal(shouldSpawnSetdownDust({ x: 5, y: 6 }, []), true, 'without zones, dust is unchanged');
}

// Releasing a stack exercises the particle watcher for both local and other trucks without WebGL.
{
  for (const other of [false, true]) {
    for (const onZone of [false, true]) {
      const g = newGame(1);
      const t = other ? truckView(g, addTruck(g, 'Other')) : g;
      Object.assign(t.fl, { x: 8, y: 8, a: 0 });
      g.ghostPairs = [];
      const p = toWorld(t.fl, FL.carryX, 0), eye = [p.x, p.y - 3, 3];
      g.stacks = [wonkyStack({ x: p.x, y: p.y, layers: [0], a: 0 })];
      g.zones = [{ x: p.x + (onZone ? 0 : 2), y: p.y, color: 1, count: 2 }];
      forkUp(t);
      assert.ok(t.carried, 'picked up the test stack');
      const om = new Mesh(), tm = new Mesh();
      addParticles(om, tm, g, eye);
      g.clock += 1 / 120;
      addParticles(om, tm, g, eye);
      while (t.carried) forkDown(t);
      g.clock += 1 / 120;
      addParticles(om, tm, g, eye);
      assert.equal(tm.count, onZone ? 0 : 7 * 6, `${other ? 'other' : 'local'} truck emits seven dust quads only off-zone`);
    }
  }

  // Battery saver drops cosmetic GL particles and lights, then allows them again.
  {
    const g = newGame(1), om = new Mesh(), tm = new Mesh();
    const eye = [g.fl.x, g.fl.y - 3, 3];
    setParticlesEnabled(false);
    try {
      assert.deepEqual(addParticles(om, tm, g, eye), []);
      assert.equal(om.count + tm.count, 0);
    } finally {
      setParticlesEnabled(true);
    }
  }
}

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
  assert.ok(lookYawDelta(1, true) > 0 && lookYawDelta(-1, true) < 0, 'cabin right/left inputs turn the view in the matching direction');
  assert.equal(lookYawDelta(1, false), -1, 'overview drag direction is unchanged');
  const cam = povCamera(g, 800, 500);
  const ov = overviewCamera(8, 5, 10, 800, 500);
  const cabinBlend = blendCameras(cam, ov, 0.5);
  assert.ok(cam.pose && cabinBlend.pose, 'cabin and overview cameras can be blended smoothly');
  assert.ok(cabinBlend.pose.f2h > cam.pose.f2h && cabinBlend.pose.f2h < ov.pose.f2h, 'camera transitions interpolate vertical field of view');
  assert.ok(ceilingClip({ eye: [0, 0, CEILING_HIDE_Z + 0.1] }), 'the ceiling is clipped while a transition camera is above it');
  assert.ok(!ceilingClip({ eye: [0, 0, CEILING_HIDE_Z - 0.1] }), 'the ceiling is restored once the transition camera is below the threshold');
  assert.equal(renderMode('pov', { eye: [0, 0, CEILING_HIDE_Z + 0.1] }), 'ov', 'transition cameras above the ceiling use clear overview lighting');
  assert.equal(renderMode('pov', { eye: [0, 0, CEILING_HIDE_Z - 0.1] }), 'pov', 'real cabin cameras keep cabin fog');
  const ahead = projectPoint(cam.vp, g.fl.x + 6, g.fl.y, 0.5, 800, 500);
  assert.ok(ahead && Math.abs(ahead[0] - 400) < 1, 'a point straight ahead projects to the screen centre');
  assert.equal(projectPoint(cam.vp, g.fl.x - 6, g.fl.y, 0.5, 800, 500), null, 'points behind the eye are not projected');
  g.fl.steer = FL.maxSteer / 2;
  const straight = projectPoint(povCamera(g, 800, 500, null, false).vp, g.fl.x + 6, g.fl.y, 0.5, 800, 500);
  const headTurned = projectPoint(povCamera(g, 800, 500, null, true).vp, g.fl.x + 6, g.fl.y, 0.5, 800, 500);
  assert.ok(straight && headTurned && Math.abs(straight[0] - 400) < 1 && Math.abs(headTurned[0] - straight[0]) > 10, 'controller cabin mode disables steering head-turn while keyboard mode retains it');
  g.fl.steer = 0;
  const left = projectPoint(cam.vp, g.fl.x + 6, g.fl.y - 2, 0.5, 800, 500);
  assert.ok(left[0] < 400, 'world -y is left of a forklift heading +x (screen-right is the forklift right)');
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


// The cabin camera keeps facing forward while the truck reverses
{
  const g = newGame(1);
  run(g, { down: true }, 0.6);
  assert.equal(g.fl.gear, 'R', 'truck is reversing');
  const cab = povCamera(g, 800, 500), back = projectPoint(cab.vp, g.fl.x + Math.cos(g.fl.a) * 6, g.fl.y + Math.sin(g.fl.a) * 6, 0.5, 800, 500);
  assert.ok(back && Math.abs(back[0] - 400) < 400, 'cabin camera still looks along the heading in reverse');
  console.log('cabin camera reverse view ok');
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


{ // the inspector photo keeps clear of touch controls (portrait tablet: Menu button top right, pads at the bottom)
  const btn = (left, top, right, bottom) => ({ left, top, right, bottom });
  const blocked = [btn(700, 8, 780, 48), btn(16, 900, 100, 1080), btn(600, 900, 780, 1080)];
  const base = { vw: 800, vh: 1100, w: 360, h: 270, blocked };
  const hits = (p) => blocked.some((b) => p.x < b.right && p.x + p.w > b.left && p.y < b.bottom && p.y + p.h > b.top);
  const p = placePhoto(base);
  assert.equal(p.corner, 1, 'slides off the Menu button to the free top-left corner');
  assert.ok(!hits(p) && p.scale === 1);
  assert.equal(placePhoto({ ...base, blocked: [] }).corner, 0, 'no touch controls: stays top right');
  const tight = placePhoto({ vw: 800, vh: 330, w: 500, h: 300, blocked: [btn(380, 100, 420, 200)] });
  assert.equal(tight.scale, 0.5, 'shrinks when no corner fits at full size');
  const first = placePhoto({ vw: 1600, vh: 900, w: 360, h: 270 }), second = placePhoto({ vw: 1600, vh: 900, w: 360, h: 270, avoid: [first] });
  assert.ok(first.corner === 0 && second.corner !== 0, 'a second popup takes another corner instead of covering the first');
  const gauge = btn(1102, 44, 1184, 234), compass = btn(1151, 240, 1199, 284), hud = [gauge, compass];
  const g1 = placePhoto({ vw: 1200, vh: 800, w: 360, h: 270, blocked: hud });
  assert.ok(g1.corner !== 0 && ![gauge, compass].some((b) => g1.x < b.right && g1.x + g1.w > b.left && g1.y < b.bottom && g1.y + g1.h > b.top), 'the photo leaves the fork gauge and compass clear');
  console.log('photo placement ok');
}

{ // touch: re-shown photos are as large as new ones; desktop keeps them smaller
  assert.equal(popupScale(true, true), popupScale(false, true));
  assert.ok(popupScale(true, false) < popupScale(false, false));
  assert.ok(popupScale(false, true) >= 1.5 * popupScale(false, false) && popupScale(false, true) <= 2 * popupScale(false, false), 'touch popups are 50-100% bigger');
}

{ // oil drop-point mark: outlined and darker in light mode, plain in dark mode
  const lm = oilDropMark(0, 0, 1, true), dm = oilDropMark(0, 0);
  assert.ok(lm.edge && lm.edgeW > 0 && !dm.edge && lm.fill !== dm.fill);
}

{ // gallery photos carry their points
  assert.equal(scoreText({ base: 200, crash: 23, square: 15, total: 162 }), '200 − 23 damage − 15 wonky = 162 pts');
  assert.equal(scoreText({ base: 100, crash: 0, square: 0, total: 100 }), '100 pts');
  const p = { layers: [0], pens: [{ crash: 0 }] };
  assert.equal(stripHeight({ ...p, score: { base: 100, crash: 0, square: 0, total: 100 } }), stripHeight(p) + 26, 'the points take one more caption line');
}

console.log('render tests passed');

{ // damaged boxes carry a warning symbol in the inspector photo
  assert.deepEqual(boxStatus({ crash: 10, sq: 5 }), { damaged: true, crooked: true });
  assert.deepEqual(boxStatus({ crash: 10, wide: true, sq: 5 }), { damaged: false, crooked: true });
  assert.deepEqual(boxStatus({ crash: 10, barrelPart: 'base' }), { damaged: false, crooked: false });
  const photo = { n: 1, ok: false, layers: [0, 1], rots: [0, 0], offs: [{ x: 0, y: 0 }, { x: 0, y: 0 }], pens: [{ crash: 0 }, { crash: 10 }], view: 0, dist: 2 };
  const symbols = (p) => {
    let n = 0, style = '';
    const ctx = new Proxy({}, { get: (t, k) => (k === 'fillStyle' ? style : k === 'measureText' ? () => ({ width: 10 }) : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : k === 'fill' ? () => { if (style === '#ffeb3b') n++; } : () => {}), set: (t, k, v) => { if (k === 'fillStyle') style = v; return true; } });
    drawPhoto(ctx, p);
    return n;
  };
  assert.equal(symbols(photo), 1, 'one symbol, on the damaged box only');
  assert.equal(symbols({ ...photo, pens: photo.pens.map((q) => ({ ...q, crash: 0 })) }), 0, 'no symbol without damage');
  assert.equal(symbols({ ...photo, pens: [{ crash: 0 }, { crash: 10, wide: true }] }), 0, 'no symbol on a damaged wide box');
  assert.equal(symbols({ ...photo, pens: [{ crash: 10, barrelPart: 'base' }, { crash: 10, barrelPart: 'top' }] }), 0, 'no symbol on a damaged barrel');
  let tapes = 0, stroke = '';
  const spy = new Proxy({}, { get: (t, k) => (k === 'measureText' ? () => ({ width: 10 }) : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : k === 'stroke' ? () => { if (stroke === TAPE_FILL) tapes++; } : () => {}), set: (t, k, v) => { if (k === 'strokeStyle') stroke = v; return true; } });
  drawPhoto(spy, { ...photo, pens: [{ crash: 0, tape: 2 }, { crash: 0 }] });
  assert.ok(tapes >= 1, 'repair tape shows in the photo');
  const bad = { ...photo, pens: [{ crash: 22.6, sq: 0 }, { crash: 0, sq: 0 }, { crash: 5, sq: 10 }, { crash: 0, sq: 15 }] };
  assert.deepEqual(issues(bad), ['Box 1 has 23 pt damage', 'Box 3 has 5 pt damage and is wonky', 'Box 4 is wonky'], 'issues are listed per box, lowest box is 1');
  assert.deepEqual(issues({ ...photo, pens: [{ crash: 0 }, { crash: 0 }] }), []);
  assert.deepEqual(issues({ ...photo, pens: [{ crash: 30, wide: true, sq: 5 }, { crash: 20, barrelPart: 'base' }, { crash: 20, barrelPart: 'top' }] }), ['Box 1 is wonky'], 'damage on wide boxes and barrels is not listed (cannot be repaired), wonkiness is');
  assert.ok(stripHeight(bad) > stripHeight(photo), 'the caption strip grows with the list');
  console.log('damage symbol ok');
}

// Gauge badges follow each box's inspection state before and after lifting.
{
  const g = newGame(1);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0, 1], a: 0, rots: [0, 0], offs: [{ x: 0, y: 0 }, { x: 0, y: 0 }], pen: [{ crash: 10, sq: 5 }, { crash: 10, sq: 5, inspected: true }] }];
  faceStack(g, 0);
  const symbols = () => {
    let warnings = 0, diamonds = 0, style;
    const ctx = new Proxy({}, {
      get: (t, k) => k === 'fillRect' ? () => { if (style === '#ffe082') diamonds++; }
        : k === 'fillText' ? (text) => { if (text === '!') warnings++; } : () => {},
      set: (t, k, v) => { if (k === 'fillStyle') style = v; return true; },
    });
    drawForkGauge(ctx, g, 100, 100);
    return [warnings, diamonds];
  };
  assert.deepEqual(symbols(), [1, 1], 'uninspected damaged and crooked boxes have no badges');
  g.H = 1;
  forkUp(g);
  assert.deepEqual(symbols(), [1, 1], 'inspection follows the top box when the stack is split');
  g.stacks[0].pen[0].inspected = true;
  assert.deepEqual(symbols(), [2, 2], 'each inspected box gets its own badges');
  update(g, { horn: true }, 1 / 120);
  assert.deepEqual(symbols(), [0, 0], 'nudging floor and carried boxes immediately hides their badges');
}

{ // tape strips stay on the lid and grow with the repair
  const sizes = [1, 2, 6].map((n) => tapeShapes({ tape: n }));
  assert.deepEqual(sizes.map((a) => a.length), [1, 2, 6]);
  assert.ok(sizes[2].every((poly) => poly.length > 2 && poly.every(([u, v]) => Math.abs(u) <= 0.5 + 1e-9 && Math.abs(v) <= 0.5 + 1e-9)));
  console.log('tape ok');
}
