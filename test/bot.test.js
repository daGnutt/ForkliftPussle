import assert from 'node:assert/strict';
import { newGame, update, addTruck, zoneDone, zoneWonky, flaggedStacks, flagSymbol, endPhotos, score } from '../js/game.js';
import { issues } from '../js/photo.js';
import { BOT_R, CLEAN_SECS, truckGap, botDrawPos, TURN_RATE, stepBot, stepInspector, stepConeBot, coneTargets, areaComplete, areaMarkKey, stackSig, stepConeCollisions, stepTapeBot, stepTapeCollisions, tapeCorners, trailingTape } from '../js/bot.js';
import { serializeGame, deserializeGame } from '../js/savestate.js';
import { BOX_HALF_X, halfY, zoneExt, rectPoly } from '../js/geom.js';
import { run, NONE, flatWorld } from './common.js';
import { floorDecals } from '../js/decals.js';

const hasBarrel = (g) => g.stacks.some((s) => s.layers.includes(6));
const botGame = () => {
  const g = newGame(4, 0);
  assert.ok(hasBarrel(g) && g.hatch && g.bot, 'barrel levels get a hatch and a hidden bot');
  assert.equal(g.bot.show, 0);
  return g;
};
const mid = (g) => ({ x: g.w / 2, y: g.h / 2 });
const clearOf = (g, p) => { g.fl.x = p.x < g.w / 2 ? g.w - 1 : 1; g.fl.y = p.y < g.h / 2 ? g.h - 1 : 1; };
const botKinds = ['bot', 'inspector', 'coneBot', 'tapeBot'];
const fillTapeAreas = (g, areas) => {
  g.zones = areas.map((a) => ({ x: a.x + a.w / 2, y: a.y + a.h / 2, color: a.color, count: 1 }));
  g.stacks = g.zones.map((z) => ({ x: z.x, y: z.y, layers: [z.color], rots: [0], pen: [{ crash: 0, sq: 0 }] }));
  return (z) => g.stacks.find((s) => s.x === z.x && s.y === z.y);
};
const scanTapeZone = (g, z, stack, ok = true) => {
  const bot = g.inspector ||= { show: 0, seen: [] }, key = `${z.x},${z.y},${z.color}`;
  if (!bot.seen.includes(key)) bot.seen.push(key);
  (bot.sigs ||= {})[key] = stackSig(stack);
  (bot.photos ||= {})[key] = { ok, pens: [{ shift: 0 }] };
};
const idleStep = (g, kind, dt) => {
  if (kind === 'bot') stepBot(g, dt, 1.15 ** 2 / 50);
  else if (kind === 'inspector') stepInspector(g, dt, [], () => null, () => false);
  else if (kind === 'coneBot') stepConeBot(g, dt, []);
  else stepTapeBot(g, dt, [], () => null, () => false);
};

assert.ok(newGame(1, 0).hatch && newGame(1, 0).bot && newGame(1, 0).inspector, 'levels without barrels also have a cleaning bot');
assert.deepEqual(newGame(4, 0).hatch, newGame(4, 0).hatch, 'the hatch is deterministic');

// Wheel smoke leaves fresh marks, which the cleaner removes without touching permanent decals.
{
  const g = newGame(1, 0);
  const oldDecals = structuredClone(floorDecals(g));
  flatWorld(g); g.stacks = []; g.inspector = null; g.coneBot = null; g.tapeBot = null; g.repair = null;
  Object.assign(g.fl, { x: 2.5, y: g.h / 2, a: Math.PI, speed: 0 });
  let slipped = false;
  for (let i = 0; i < 360; i++) { update(g, { up: true }, 1 / 120); slipped ||= g.slip > 0.05; }
  assert.ok(slipped && g.skidMarks.length, 'wheel slip produces fresh marks even without barrels');
  const marks = g.skidMarks.map((m) => ({ ...m }));
  assert.ok(marks.every((m) => m.left === 1), 'new marks begin uncleaned');
  Object.assign(g.fl, { x: g.w - 2, y: 1, speed: 0 });
  g.slip = 0;
  let seen = false, fading = false;
  for (let i = 0; g.skidMarks.length && i < 120 * 120; i++) {
    update(g, NONE, 1 / 120);
    seen ||= g.bot.show > 0;
    fading ||= g.skidMarks.some((m) => m.left < 1);
  }
  assert.ok(seen && fading && !g.skidMarks.length, 'cleaner emerges and scrubs the marks away');
  assert.deepEqual(floorDecals(g), oldDecals, 'old factory decals are unchanged');
}

// The bot stays hidden while there is no oil.
{
  const g = botGame();
  run(g, NONE, 2);
  assert.equal(g.bot.show, 0);
  assert.equal(g.skidMarks.length, 0, 'stationary wheels leave no marks');
}

// Oil takes priority over fresh skid marks; marks are not safety-cone spill targets.
{
  const g = botGame();
  flatWorld(g); g.stacks = [];
  g.oil = [{ id: 'oil', x: 8, y: 6, r: 0.163, drops: 1 }];
  g.skidMarks = [{ id: 'skid:test', x: 6, y: 6, a: 0, left: 1 }];
  stepBot(g, 1 / 120, 1.15 ** 2 / 50);
  assert.ok(g.bot.debugTask.startsWith('spill oil'));
  const withMarks = coneTargets(g, []);
  g.skidMarks = [];
  assert.deepEqual(coneTargets(g, []), withMarks, 'skid marks do not create cone jobs');
}

// Skid jobs and grouped scrubbing stay outside every live forklift's safety perimeter.
{
  const g = newGame(1);
  flatWorld(g); g.stacks = []; g.inspector = null; g.coneBot = null; g.tapeBot = null;
  Object.assign(g.fl, { x: 5, y: 4, a: 0, speed: 0 });
  const near = { id: 'near', x: 5.1, y: 6, a: 0, left: 1 };
  const far = { id: 'far', x: 5.1, y: 6.2, a: 0, left: 1 };
  g.skidMarks = [near, far];
  Object.assign(g.bot, { x: far.x, y: far.y, show: 1, mode: 'out' });
  stepBot(g, 0.1, 1.15 ** 2 / 50);
  assert.ok(g.bot.debugTask.startsWith('skid far '), 'a parked forklift excludes the nearer mark');
  assert.ok(far.left < 1, 'a mark outside the perimeter is cleaned');
  assert.equal(near.left, 1, 'grouped cleaning does not touch an unsafe mark');

  Object.assign(g.fl, { x: 5, y: 4.3 });
  stepBot(g, 0.1, 1.15 ** 2 / 50);
  assert.equal(g.bot.debugTask, null, 'a moving perimeter cancels an existing skid job');
  assert.equal(near.left, 1);
  const remaining = far.left;
  stepBot(g, 0.1, 1.15 ** 2 / 50);
  assert.equal(far.left, remaining, 'unsafe marks remain untouched');

  Object.assign(g.fl, { x: 12, y: 1 });
  const other = g.trucks[addTruck(g, 'Other', 1)];
  Object.assign(other.fl, { x: 5, y: 4, a: 0, speed: 0 });
  stepBot(g, 0.1, 1.15 ** 2 / 50);
  assert.ok(g.bot.debugTask.startsWith('skid far '), 'another parked player also protects nearby marks');
  other.gone = true;
  Object.assign(g.bot, { x: near.x, y: near.y });
  stepBot(g, 0.1, 1.15 ** 2 / 50);
  assert.ok(g.bot.debugTask.startsWith('skid near '), 'marks become eligible when the truck leaves');
}

// Nearby skid marks do not summon a hidden cleaner, but nearby oil still does.
{
  const g = newGame(1);
  flatWorld(g); g.stacks = [];
  Object.assign(g.fl, { x: 5, y: 4, a: 0, speed: 0 });
  g.skidMarks = [{ id: 'near', x: 5.1, y: 6.1, a: 0, left: 1 }];
  stepBot(g, 1 / 120, 1.15 ** 2 / 50);
  assert.equal(g.bot.mode, 'hidden', 'a mark at the perimeter boundary is not a job');
  g.oil = [{ id: 'oil', x: 5.1, y: 6.1, r: 0.163, drops: 1 }];
  stepBot(g, 1 / 120, 1.15 ** 2 / 50);
  assert.ok(g.bot.debugTask.startsWith('spill oil '), 'the skid perimeter does not apply to oil');
  assert.equal(g.bot.mode, 'out');
}

// Other players leave marks too, while stationary wheelspin does not create unlimited duplicates.
{
  const g = newGame(1);
  flatWorld(g); g.stacks = []; g.bot = null; g.inspector = null; g.coneBot = null; g.tapeBot = null;
  const other = g.trucks[addTruck(g, 'Other', 1)];
  Object.assign(g.fl, { x: 2, y: 2 });
  Object.assign(other.fl, { x: 8, y: 7, a: 0, speed: 0 });
  other.slip = 1;
  update(g, NONE, 1 / 120);
  assert.equal(g.skidMarks.length, 4, 'the remote truck leaves marks at its wheels');
  for (let i = 0; i < 120; i++) { other.slip = 1; update(g, NONE, 1 / 120); }
  assert.equal(g.skidMarks.length, 4, 'repeated wheelspin at the same spot does not pile up marks');
}

// New oil interrupts skid cleaning; the mark is scrubbed quickly once the oil is gone.
{
  const g = newGame(1);
  flatWorld(g); g.stacks = []; g.inspector = null; g.coneBot = null; g.tapeBot = null;
  const spot = mid(g);
  clearOf(g, spot);
  Object.assign(g.bot, { x: spot.x, y: spot.y, show: 1, mode: 'out' });
  g.skidMarks = [{ id: 'skid:test', x: spot.x, y: spot.y, a: 0, left: 1 }];
  run(g, NONE, 0.1);
  const remaining = g.skidMarks[0].left;
  assert.ok(remaining < 1 && remaining > 0, 'skid cleaning has started');
  g.oil = [{ id: 'new-oil', x: spot.x, y: spot.y, r: 0.163, drops: 1 }];
  let elapsed = 0;
  while (g.oil.length && elapsed < 10) {
    update(g, NONE, 1 / 120); elapsed += 1 / 120;
    assert.equal(g.skidMarks[0].left, remaining, 'oil interrupts skid cleaning');
  }
  assert.ok(!g.oil.length && elapsed >= CLEAN_SECS - 0.1, 'oil is cleaned first at its normal rate');
  elapsed = 0;
  while (g.skidMarks.length && elapsed < 1) { update(g, NONE, 1 / 120); elapsed += 1 / 120; }
  assert.ok(!g.skidMarks.length && elapsed < 0.3, 'partly cleaned mark is finished quickly');
}

// It drives out, mops one drop in about CLEAN_SECS and eventually goes home.
{
  const g = botGame();
  const spot = mid(g);
  g.stacks = [];
  clearOf(g, g.hatch);
  g.oil = [{ id: 't', x: spot.x, y: spot.y, r: 0.163, drops: 1 }];
  stepBot(g, 1 / 120, 1.15 ** 2 / 50);
  assert.ok(g.bot.debugTask.startsWith('spill t at '), 'cleaner reports its selected spill as it emerges');
  let seen = 0, cleanStart = null, t = 0;
  while (g.oil.length && t < 60) {
    update(g, NONE, 1 / 120); t += 1 / 120;
    if (g.bot.show > 0) seen++;
    if (g.bot.cleaning && cleanStart === null) cleanStart = t;
  }
  assert.ok(seen > 0 && !g.oil.length, 'the bot emerged and removed the spill');
  assert.ok(Math.abs(t - cleanStart - CLEAN_SECS) < 0.3, `one drop takes ~${CLEAN_SECS}s of cleaning (${(t - cleanStart).toFixed(2)})`);
  g.bot.idle = 600;
  run(g, NONE, 40);
  assert.equal(g.bot.mode, 'hidden', 'it goes back into its hatch');
}

// Large spills shrink while being cleaned.
{
  const g = botGame();
  g.stacks = [];
  const spot = mid(g);
  g.oil = [{ id: 't', x: spot.x, y: spot.y, r: Math.sqrt(10 * 1.15 ** 2 / 50), drops: 10 }];
  clearOf(g, g.hatch);
  let t = 0;
  while (!g.bot.cleaning && t++ < 120 * 60) update(g, NONE, 1 / 120);
  const r0 = g.oil[0].r;
  run(g, NONE, 3);
  assert.ok(g.oil[0].r < r0 && Math.abs(g.oil[0].drops - (10 - 3 / CLEAN_SECS)) < 0.1);
}

// It runs away from a forklift that approaches, and never ends up inside it.
{
  const g = botGame();
  g.stacks = [];
  flatWorld(g);
  const spot = mid(g);
  g.oil = [{ id: 't', x: spot.x, y: spot.y, r: 0.4, drops: 8 }];
  clearOf(g, g.hatch);
  let t = 0;
  while (!g.bot.cleaning && t++ < 120 * 60) update(g, NONE, 1 / 120);
  assert.ok(g.bot.cleaning);
  g.fl.x = g.bot.x - 1.5; g.fl.y = g.bot.y; g.fl.a = 0;
  run(g, NONE, 0.2);
  assert.ok(!g.bot.scared && g.bot.cleaning, 'a standing forklift does not scare the bot');
  g.fl.x = g.bot.x - 2.5;
  run(g, { up: true }, 0.6);
  assert.ok(g.bot.scared && !g.bot.cleaning, 'a close moving forklift scares the bot off the spill');
  g.fl.x += 0.8;
  run(g, { up: true }, 1);
  let min = Infinity;
  for (let i = 0; i < 240; i++) { update(g, { up: true }, 1 / 120); min = Math.min(min, truckGap(g, g.bot)); }
  assert.ok(min > -BOT_R * 0.5, `the bot is not run over (${min.toFixed(2)})`);
}

// Open spills come first (small ones before big puddles); oil under a barrel is reached from beside it once the rest is done.
{
  const g = botGame();
  const s = g.stacks.find((q) => q.layers.includes(6));
  g.oil = [{ id: 'big', x: 9.5, y: 9, r: 0.6, drops: 4 }, { id: 'small', x: 13, y: 9, r: 0.2, drops: 1 }, { id: 'under', x: s.x, y: s.y, r: 0.2, drops: 1 }];
  clearOf(g, g.hatch);
  const order = [];
  let t = 0;
  while (g.oil.length && t++ < 120 * 120) {
    update(g, NONE, 1 / 120);
    for (const id of ['small', 'big', 'under']) if (!order.includes(id) && !g.oil.some((o) => o.id === id)) order.push(id);
    if (!g.oil.some((o) => o.id === 'under') && g.stacks.some((q) => Math.hypot(g.bot.x - q.x, g.bot.y - q.y) < 0.5)) assert.fail('the bot drove into a barrel');
  }
  assert.deepEqual(order, ['small', 'big', 'under'], 'small open drop, then the puddle, then the oil under the barrel');
}

// It drives around stacks and walls on the way to the spill.
{
  const g = botGame();
  const s = g.stacks.find((q) => !q.layers.includes(6));
  g.oil = [{ id: 't', x: s.x + 1.3, y: s.y, r: 0.3, drops: 2 }];
  clearOf(g, g.hatch);
  let min = Infinity, t = 0;
  while (g.oil.length && t++ < 120 * 90) {
    update(g, NONE, 1 / 120);
    if (g.bot.show > 0) for (const q of g.stacks) min = Math.min(min, Math.hypot(g.bot.x - q.x, g.bot.y - q.y));
  }
  assert.ok(!g.oil.length && min > 0.5 + BOT_R * 0.8, `the bot keeps clear of stacks (${min.toFixed(2)})`);
}

// The bot is saved with the game.
{
  const g = botGame();
  g.oil = [{ id: 't', x: g.w / 2, y: g.h / 2, r: 0.3, drops: 3 }];
  run(g, NONE, 2);
  const g2 = deserializeGame(JSON.parse(JSON.stringify(serializeGame(g))));
  assert.equal(g2.bot.show, g.bot.show);
  assert.equal(g2.bot.x, g.bot.x);
}

// Curious travel is faster for the other bots, while the tape bot travels more slowly off duty.
{
  for (const [kind, speed] of [['bot', 2.25], ['inspector', 1.25], ['coneBot', 1.5], ['tapeBot', 1.5]]) {
    const g = botGame();
    g.stacks = []; flatWorld(g); g.areas = [];
    for (const other of botKinds) if (other !== kind) g[other] = null;
    const b = g[kind];
    Object.assign(b, { mode: 'out', show: 1, activity: 'follow', x: 5, y: 6, a: 0,
      curiosity: { x: 8, y: 6, truck: g.trucks[0].id, left: null }, path: [{ x: 8, y: 6 }], repath: 1e9 });
    Object.assign(g.fl, { x: 15, y: 10, a: 0, speed: 0 });
    idleStep(g, kind, 0.05);
    assert.ok(Math.abs(b.x - 5 - speed * 0.05) < 1e-8, `${kind} travels at its curious speed`);
    if (kind === 'tapeBot') {
      Object.assign(b, { activity: 'home', idle: 600, x: 5, y: 6, a: 0, path: [{ x: 8, y: 6 }], repath: 1e9, planKey: 'home' });
      idleStep(g, kind, 0.05);
      assert.ok(Math.abs(b.x - 5 - speed * 0.05) < 1e-8, 'the tape bot also returns home at its off-duty speed');
    }
  }
}

// The cleaner, inspector and cone bot also use their faster speed while travelling for work.
{
  for (const [kind, speed] of [['bot', 2.25], ['inspector', 1.25], ['coneBot', 1.5]]) {
    const g = botGame();
    g.stacks = []; flatWorld(g); g.areas = [];
    for (const other of botKinds) if (other !== kind) g[other] = null;
    const b = g[kind], z = { x: 12, y: 6, color: 0, count: 1 };
    if (kind === 'inspector') g.stacks = [{ x: z.x, y: z.y, layers: [0], pen: [{}], rots: [0] }];
    else g.oil = [{ id: 'speed', x: z.x, y: z.y, r: 0.2, drops: 1 }];
    Object.assign(b, { mode: 'out', show: 1, x: 5, y: 6, a: 0 });
    Object.assign(g.fl, { x: 17, y: 12, a: 0, speed: 0 });
    const step = () => kind === 'inspector' ? stepInspector(g, 0.05, [z], () => g.stacks[0], () => false) : idleStep(g, kind, 0.05);
    step();
    assert.equal(b.activity, 'work', `${kind} has work`);
    Object.assign(b, { x: 5, y: 6, a: 0, path: [{ x: 8, y: 6 }], repath: 1e9 });
    step();
    assert.ok(Math.abs(b.x - 5 - speed * 0.05) < 1e-8, `${kind} travels at its work speed`);
  }
}

// Curious bots watch from a distance for 5-15 seconds, relocate even for a parked truck, and prioritise work.
{
  for (const kind of ['bot', 'inspector', 'coneBot', 'tapeBot']) {
    const g = botGame();
    g.stacks = []; flatWorld(g);
    const b = g[kind];
    if (kind !== 'inspector') g.inspector = null;
    if (kind !== 'bot') g.bot = null;
    Object.assign(b, { mode: 'out', show: 1, x: 4, y: 6, a: 0 });
    Object.assign(g.fl, { x: 12, y: 6, a: 0, speed: 0.4 });
    const step = (dt, done = []) => {
      if (kind === 'bot') stepBot(g, dt, 1.15 ** 2 / 50);
      else if (kind === 'coneBot') stepConeBot(g, dt, done);
      else if (kind === 'tapeBot') stepTapeBot(g, dt, done, (z) => g.stacks.find((s) => s.x === z.x && s.y === z.y), () => false);
      else stepInspector(g, dt, done, (z) => g.stacks.find((s) => s.x === z.x && s.y === z.y), () => false);
    };
    g.fl.speed = 0;
    for (let i = 0; i < 800 && !b.observing; i++) step(0.05);
    assert.ok(b.observing, `${kind} reaches a viewing spot for a parked forklift`);
    assert.ok(truckGap(g, b) >= 2.5, `${kind} keeps a respectful distance`);
    const duration = b.curiosity.left;
    assert.ok(duration >= 5 && duration <= 15, `${kind} observes for 5-15 seconds`);
    const stopped = { x: b.x, y: b.y };
    for (let i = 0; i < 80; i++) step(0.05);
    assert.ok(Math.hypot(b.x - stopped.x, b.y - stopped.y) < 0.01, `${kind} watches a parked forklift`);
    const facing = Math.atan2(g.fl.y - b.y, g.fl.x - 0.7 - b.x);
    assert.ok(Math.abs(Math.atan2(Math.sin(b.a - facing), Math.cos(b.a - facing))) < 0.1, `${kind} looks at the truck body`);
    for (let i = 0; i < 240 && b.curiosity; i++) step(0.05);
    assert.ok(!b.curiosity, `${kind} finishes its observation`);
    step(0.05);
    assert.ok(b.curiosity && Math.hypot(b.curiosity.x - stopped.x, b.curiosity.y - stopped.y) >= 1, `${kind} chooses a different destination`);
    b.idle = 599.8;
    step(0.1);
    assert.equal(b.activity, 'follow', `${kind} stays out before ten minutes`);
    step(0.11);
    assert.equal(b.activity, 'home', `${kind} returns after ten minutes`);
    let done = [];
    if (kind === 'bot' || kind === 'coneBot') g.oil = [{ id: 'new', x: 5, y: 9, r: 0.2, drops: 1 }];
    else {
      const z = { x: 5, y: 9, color: 0, count: 1 };
      g.stacks = [{ x: z.x, y: z.y, layers: [0], pen: [{ crash: 0, sq: 0 }], rots: [0] }];
      done = [z];
      if (kind === 'tapeBot') {
        g.zones = done;
        const area = { x: 4, y: 8, w: 2, h: 2, color: 0 };
        g.areas = [area];
        const key = `${z.x},${z.y},${z.color}`;
        g.inspector = { seen: [key], sigs: { [key]: stackSig(g.stacks[0]) }, photos: { [key]: { ok: true } } };
      }
    }
    step(0.01, done);
    assert.equal(b.activity, 'work', `${kind} interrupts its return for new work`);
    assert.equal(b.idle, 0, 'work resets the idle timer');
    assert.ok(kind === 'coneBot' ? b.planKey.startsWith('place:spill:new:')
      : kind === 'tapeBot' ? !!b.planKey : b.goal && Math.hypot(b.goal.x - 5, b.goal.y - 9) < 0.01, 'the new job is the goal');
    assert.equal(b.curiosity, null, 'work cancels the observation');
    Object.assign(b, { activity: 'home', idle: 600, show: 0.5, leaving: true });
    step(0.1, done);
    assert.ok(b.show > 0.5 && !b.leaving, `${kind} reverses out of the hatch when work appears`);
  }
}

// Viewing destinations and observation keep a clear sight line; an occluding wall interrupts the pause.
{
  for (const kind of botKinds) {
    const g = botGame();
    g.stacks = []; flatWorld(g); g.areas = [];
    for (const other of botKinds) if (other !== kind) g[other] = null;
    const b = g[kind];
    Object.assign(b, { mode: 'out', show: 1, x: 4, y: 6, a: 0 });
    Object.assign(g.fl, { x: 13, y: 6, a: 0, speed: 0 });
    g.walls.push({ x: 8, y: 3, w: 0.4, h: 6 });
    const visible = (p) => {
      for (let i = 1; i < 100; i++) {
        const x = p.x + (g.fl.x - 0.7 - p.x) * i / 100, y = p.y + (g.fl.y - p.y) * i / 100;
        if (g.walls.some((w) => x > w.x && x < w.x + w.w && y > w.y && y < w.y + w.h)) return false;
      }
      return true;
    };
    for (let i = 0; i < 1600 && !b.observing; i++) {
      idleStep(g, kind, 0.05);
      if (b.curiosity) assert.ok(visible(b.curiosity), `${kind} chooses a destination with a view`);
      if (b.path.length && b.curiosity) assert.equal(b.curiosity.left, null, 'travel time does not consume observation');
    }
    assert.ok(b.observing && visible(b), `${kind} reaches a spot with line of sight`);
    const original = botGame();
    original[kind] = b;
    const saved = deserializeGame(JSON.parse(JSON.stringify(serializeGame(original))));
    assert.deepEqual(saved[kind].curiosity, b.curiosity, 'destination and observation timer survive saving');
    const old = b.curiosity;
    const x = (b.x + g.fl.x - 0.7) / 2, y = (b.y + g.fl.y) / 2;
    g.stacks = [{ x: x - 0.15, y, layers: [0], rots: [Math.PI / 4], offs: [{ x: 0.15, y: 0 }], pen: [{}] }];
    idleStep(g, kind, 0.05);
    assert.ok(!b.observing && b.curiosity !== old, `${kind} notices a rotated, offset box blocking its view`);
    g.stacks = [];
    Object.assign(b, { x: old.x, y: old.y, curiosity: old, path: [] });
    g.walls.push({ x: x - 0.01, y: y - 0.01, w: 0.02, h: 0.02 });
    idleStep(g, kind, 0.05);
    assert.ok(!b.observing && b.curiosity !== old, `${kind} relocates when its sight line is blocked`);
    if (b.curiosity) assert.ok(visible(b.curiosity), 'the replacement spot also has a view');
  }
}

// Idle bots peek past wall corners and boxes, but still watch from the open when cover is unavailable.
{
  for (const kind of botKinds) for (const cover of ['wall', 'box', 'none']) {
    const g = botGame();
    g.stacks = []; flatWorld(g); g.areas = [];
    for (const other of botKinds) if (other !== kind) g[other] = null;
    const b = g[kind];
    Object.assign(b, { mode: 'out', show: 1, x: 4, y: 6, a: 0 });
    Object.assign(g.fl, { x: 13, y: 6, a: 0, speed: 0 });
    let corners = [];
    if (cover === 'wall') {
      g.walls.push({ x: 8, y: 4, w: 0.4, h: 4 });
      corners = rectPoly(8.2, 6, 0.2, 2);
    } else if (cover === 'box') {
      g.stacks.push({ x: 8, y: 6, layers: [0], rots: [Math.PI / 4], offs: [{ x: 0.2, y: 0 }], pen: [{}] });
      corners = rectPoly(8.2, 6, BOX_HALF_X, halfY({}), Math.PI / 4);
    }
    for (let i = 0; i < 1600 && !b.observing; i++) idleStep(g, kind, 0.05);
    assert.ok(b.observing, `${kind} reaches a ${cover} viewing spot`);
    assert.ok(truckGap(g, b) >= 2.5, `${kind} stays out of the forklift's way`);
    if (corners.length) {
      assert.ok(corners.some((c) => Math.hypot(b.x - c.x, b.y - c.y) < 1.6), `${kind} peeks near ${cover} cover`);
      const nearest = corners.map((a, i) => {
        const z = corners[(i + 1) % corners.length], dx = z.x - a.x, dy = z.y - a.y;
        const t = Math.max(0, Math.min(1, ((b.x - a.x) * dx + (b.y - a.y) * dy) / (dx * dx + dy * dy)));
        return { x: a.x + dx * t, y: a.y + dy * t };
      }).sort((a, z) => Math.hypot(a.x - b.x, a.y - b.y) - Math.hypot(z.x - b.x, z.y - b.y))[0];
      assert.ok((nearest.x - b.x) * (g.fl.x - 0.7 - b.x) + (nearest.y - b.y) * (g.fl.y - b.y) > 0, 'cover is towards the forklift, not behind the bot');
    }
    for (let i = 1; i < 100; i++) {
      const x = b.x + (g.fl.x - 0.7 - b.x) * i / 100, y = b.y + (g.fl.y - b.y) * i / 100;
      assert.ok(!g.walls.some((w) => x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h), 'wall does not block the view');
      if (cover === 'box') {
        const dx = x - 8.2, dy = y - 6, c = Math.SQRT1_2;
        assert.ok(Math.abs((dx + dy) * c) > BOX_HALF_X || Math.abs((dy - dx) * c) > halfY({}), 'rotated box does not block the view');
      }
    }
    const first = { x: b.x, y: b.y };
    for (let i = 0; i < 400 && b.observing; i++) idleStep(g, kind, 0.05);
    for (let i = 0; i < 1600 && !b.observing; i++) idleStep(g, kind, 0.05);
    assert.ok(b.observing && Math.hypot(b.x - first.x, b.y - first.y) >= 0.99, `${kind} switches ${cover} viewing spots`);
  }
}

// Curiosity can choose another forklift when the nearest one is in an unreachable room.
{
  const g = botGame();
  g.stacks = []; flatWorld(g); g.areas = [];
  g.inspector = null; g.coneBot = null; g.tapeBot = null;
  Object.assign(g.bot, { mode: 'out', show: 1, x: 8, y: 3, a: 0 });
  Object.assign(g.fl, { x: 4, y: 3, a: 0, speed: 0 });
  g.walls.push({ x: 6, y: 0, w: 0.4, h: g.h });
  const other = { id: 1, fl: { ...g.fl, x: 15, y: 8 }, carried: null };
  g.trucks.push(other);
  idleStep(g, 'bot', 0.05);
  assert.equal(g.bot.curiosity?.truck, 1, 'a visible, reachable forklift wins over an inaccessible one');
  const destination = g.bot.curiosity;
  other.gone = true;
  for (let i = 0; i < 800 && g.bot.curiosity === destination; i++) idleStep(g, 'bot', 0.05);
  assert.ok(g.bot.curiosity !== destination && !g.bot.observing, 'a gone forklift is discarded after reaching the destination');
}

// All curious bots keep their destination as the truck moves, and detour only when a blockage is close.
{
  for (const kind of botKinds) {
    const g = botGame();
    g.stacks = []; flatWorld(g); g.areas = [];
    for (const other of botKinds) if (other !== kind) g[other] = null;
    const b = g[kind], q = { x: 10.125, y: 6.125, truck: g.trucks[0].id, left: null };
    const path = Array.from({ length: 24 }, (_, i) => ({ x: 4.375 + i * 0.25, y: 6.125 }));
    Object.assign(b, { mode: 'out', show: 1, activity: 'follow', x: 4.125, y: 6.125, a: 0, curiosity: q, path, repath: 1e9 });
    Object.assign(g.fl, { x: 17, y: 12, a: 0, speed: 0 });
    assert.ok(Math.hypot(q.x - g.fl.x, q.y - g.fl.y) > 8, 'the truck has moved out of viewing range');
    g.walls.push({ x: 7, y: 5.8, w: 0.4, h: 0.6 });
    idleStep(g, kind, 0.05);
    assert.equal(b.curiosity, q, `${kind} keeps the destination when the truck is no longer visible`);
    assert.equal(b.path, path, `${kind} ignores a distant blockage`);
    b.x = 6.4;
    while (path[0].x < b.x) path.shift();
    idleStep(g, kind, 0.05);
    assert.equal(b.curiosity, q, `${kind} keeps the destination when detouring`);
    assert.notEqual(b.path, path, `${kind} replans when approaching the blockage`);
    for (let i = 0; i < 800 && b.curiosity === q; i++) idleStep(g, kind, 0.05);
    assert.notEqual(b.curiosity, q, `${kind} reconsiders the truck after reaching the destination`);
    assert.ok(Math.hypot(b.x - q.x, b.y - q.y) < 0.2, `${kind} reached the original destination`);
  }
}

// A temporarily unreachable viewing destination is retried rather than replaced.
{
  const g = botGame();
  g.stacks = []; flatWorld(g); g.areas = [];
  g.inspector = null; g.coneBot = null; g.tapeBot = null;
  const b = g.bot, q = { x: 10.125, y: 6.125, truck: g.trucks[0].id, left: null };
  Object.assign(b, { mode: 'out', show: 1, activity: 'follow', x: 6, y: 6.125, a: 0,
    curiosity: q, path: [{ x: 6.875, y: 6.125 }, { x: q.x, y: q.y }], repath: 1e9 });
  Object.assign(g.fl, { x: 17, y: 12, a: 0, speed: 0 });
  const wall = { x: 7, y: 0, w: 0.4, h: g.h };
  g.walls.push(wall);
  for (let i = 0; i < 120; i++) idleStep(g, 'bot', 0.05);
  assert.equal(b.curiosity, q, 'the bot retains an unreachable destination');
  g.walls = g.walls.filter((w) => w !== wall);
  for (let i = 0; i < 800 && b.curiosity === q; i++) idleStep(g, 'bot', 0.05);
  assert.notEqual(b.curiosity, q, 'the bot reconsiders its view after the route opens');
  assert.ok(Math.hypot(b.x - q.x, b.y - q.y) < 0.2, 'the bot reaches its original destination');
}

// An idle bot uses its current good vantage point and only moves a short distance when switching.
{
  for (const kind of botKinds) {
    const g = botGame();
    g.stacks = []; flatWorld(g); g.areas = [];
    for (const other of botKinds) if (other !== kind) g[other] = null;
    const b = g[kind];
    Object.assign(b, { mode: 'out', show: 1, x: 7.125, y: 6.125, a: 0 });
    Object.assign(g.fl, { x: 13, y: 6, a: 0, speed: 0 });
    for (let i = 0; i < 80 && !b.observing; i++) idleStep(g, kind, 0.05);
    assert.ok(b.observing && Math.hypot(b.x - 7.125, b.y - 6.125) < 0.01, `${kind} stays at a suitable open vantage point`);
    const first = { x: b.x, y: b.y };
    for (let i = 0; i < 400 && b.observing; i++) idleStep(g, kind, 0.05);
    for (let i = 0; i < 800 && !b.observing; i++) idleStep(g, kind, 0.05);
    const distance = Math.hypot(b.x - first.x, b.y - first.y);
    assert.ok(b.observing && distance >= 0.99 && distance < 1.5, `${kind} switches to a nearby spot`);
  }
}

// An observer clears a working bot's route, including when it must leave a narrow corridor.
{
  for (const [workerKind, observerKind] of [
    ['inspector', 'bot'], ['inspector', 'coneBot'], ['inspector', 'tapeBot'],
    ['bot', 'inspector'], ['bot', 'tapeBot'], ['coneBot', 'inspector'],
  ]) {
    const g = botGame();
    g.stacks = []; flatWorld(g); g.areas = [];
    for (const other of botKinds) if (other !== workerKind && other !== observerKind) g[other] = null;
    g.walls.push({ x: 7, y: 3, w: 5, h: 2.4 }, { x: 7, y: 6.6, w: 5, h: 2.4 });
    Object.assign(g.fl, { x: 2, y: 6, a: 0, speed: 0 });
    const worker = g[workerKind], observer = g[observerKind];
    Object.assign(worker, { mode: 'out', show: 1, activity: 'work', x: 7.5, y: 6, a: 0 });
    Object.assign(observer, { mode: 'out', show: 1, activity: 'follow', x: 9.5, y: 6, a: 0,
      curiosity: { x: 9.5, y: 6, truck: g.trucks[0].id, left: 100 }, path: [], repath: 1e9 });
    const z = { x: 15, y: 6, color: 0, count: 1 };
    if (workerKind === 'inspector') g.stacks = [{ x: z.x, y: z.y, layers: [0], pen: [{}], rots: [0] }];
    else g.oil = [{ id: 'corridor-work', x: 14, y: 6, r: 0.2, drops: 1 }];
    const stepWorker = () => {
      if (workerKind === 'inspector') stepInspector(g, 0.05, [z], () => g.stacks[0], () => false);
      else if (workerKind === 'coneBot') stepConeBot(g, 0.05, []);
      else stepBot(g, 0.05, 1.15 ** 2 / 50);
    };
    let yielded = false;
    for (let i = 0; i < 1600 && worker.x < 12.5; i++) {
      stepWorker(); idleStep(g, observerKind, 0.05);
      yielded ||= !!observer.yieldFor;
      assert.ok(Math.hypot(worker.x - observer.x, worker.y - observer.y) >= BOT_R * 2 - 1e-6, 'worker and observer do not overlap');
    }
    assert.ok(yielded && worker.x >= 12.5, `${observerKind} makes way for working ${workerKind} in a corridor`);
  }
}

// If an observer is boxed in, the worker can try another route rather than waiting forever.
{
  const g = botGame();
  g.stacks = []; flatWorld(g); g.areas = []; g.coneBot = null; g.tapeBot = null;
  g.walls.push({ x: 9, y: 5, w: 2, h: 0.1 }, { x: 9, y: 6.9, w: 2, h: 0.1 },
    { x: 9, y: 5, w: 0.1, h: 2 }, { x: 10.9, y: 5, w: 0.1, h: 2 });
  Object.assign(g.fl, { x: 15, y: 11, a: 0, speed: 0 });
  Object.assign(g.inspector, { x: 8.5, y: 6, show: 1, activity: 'work', path: [{ x: 12, y: 6 }], repath: 1e9 });
  Object.assign(g.bot, { mode: 'out', show: 1, activity: 'follow', x: 10, y: 6, a: 0,
    yieldFor: 'inspector', yieldPath: [], repath: 0 });
  for (let i = 0; i < 50 && !g.bot.yieldBlock; i++) idleStep(g, 'bot', 0.05);
  assert.equal(g.bot.yieldBlock?.worker, 'inspector', 'impossible yielding temporarily restores the observer as an obstacle');
  assert.equal(g.inspector.repath, 0, 'the worker is prompted to find a detour');
}

// A yielding observer abandons its detour immediately when a forklift scares it.
{
  for (const kind of botKinds) {
    const g = botGame();
    g.stacks = []; flatWorld(g); g.areas = [];
    for (const other of botKinds) if (other !== kind && other !== 'inspector') g[other] = null;
    const b = g[kind];
    if (kind === 'inspector') g.bot = { x: 6, y: 6, show: 1, activity: 'work', path: [{ x: 12, y: 6 }] };
    else Object.assign(g.inspector, { x: 6, y: 6, show: 1, activity: 'work', path: [{ x: 12, y: 6 }] });
    Object.assign(b, { mode: 'out', show: 1, activity: 'follow', x: 8, y: 6, a: 0,
      yieldFor: kind === 'inspector' ? 'bot' : 'inspector', yieldPath: [{ x: 9, y: 6 }], repath: 1e9 });
    Object.assign(g.fl, { x: 6, y: 6, a: 0, speed: 2 });
    idleStep(g, kind, 0.05);
    assert.ok(b.scared && b.fleePath && !b.yieldFor && !b.yieldPath.length, `${kind} flees instead of continuing to yield`);
  }
}

// All bot pairs pass on their own right without overlapping, including the cone and tape bots.
{
  for (let i = 0; i < botKinds.length; i++) for (let j = i + 1; j < botKinds.length; j++) {
    const g = botGame();
    g.stacks = []; flatWorld(g); g.areas = [];
    const kinds = [botKinds[i], botKinds[j]];
    for (const other of botKinds) if (!kinds.includes(other)) g[other] = null;
    Object.assign(g.fl, { x: 10, y: 11, a: 0, speed: 0 });
    const [east, west] = kinds.map((kind) => g[kind]);
    Object.assign(east, { mode: 'out', show: 1, activity: 'follow', x: 7, y: 6, a: 0, repath: 1e9,
      curiosity: { x: 14, y: 6, truck: g.trucks[0].id, left: null }, path: [{ x: 14, y: 6 }] });
    Object.assign(west, { mode: 'out', show: 1, activity: 'follow', x: 13, y: 6, a: Math.PI, repath: 1e9,
      curiosity: { x: 6, y: 6, truck: g.trucks[0].id, left: null }, path: [{ x: 6, y: 6 }] });
    let rightEast = false, rightWest = false, crossedEast = false, crossedWest = false;
    for (let n = 0; n < 800 && !(crossedEast && crossedWest); n++) {
      idleStep(g, kinds[0], 0.05); idleStep(g, kinds[1], 0.05);
      assert.ok(Math.hypot(east.x - west.x, east.y - west.y) >= BOT_R * 2, `${kinds} never overlap`);
      rightEast ||= east.y > 6.3;
      rightWest ||= west.y < 5.7;
      crossedEast ||= east.x > 12;
      crossedWest ||= west.x < 8;
    }
    assert.ok(rightEast && rightWest, `${kinds} both turn right`);
    assert.ok(crossedEast && crossedWest, `${kinds} finish passing rather than deadlocking`);
  }
}

// The shared hatch serialises departures instead of spawning bots in the same space.
{
  const g = botGame();
  g.stacks = []; flatWorld(g);
  clearOf(g, g.hatch);
  g.oil = [{ id: 'queue', x: 10, y: 6, r: 0.3, drops: 20 }];
  let cleanerOut = false, coneOut = false;
  for (let n = 0; n < 600; n++) {
    stepBot(g, 0.025, 1.15 ** 2 / 50); stepConeBot(g, 0.025, []);
    cleanerOut ||= g.bot.show === 1;
    coneOut ||= g.coneBot.show === 1;
    if (g.bot.show > 0 && g.coneBot.show > 0) {
      const a = botDrawPos(g.bot, g.hatch), b = botDrawPos(g.coneBot, g.hatch);
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= BOT_R * 2, 'emerging bots keep their spacing');
    }
  }
  assert.ok(cleanerOut && coneOut, 'both queued bots eventually emerge');
}

// A single-file gap makes one bot back out to a right-side passing place, not deadlock.
{
  const g = botGame();
  g.stacks = []; flatWorld(g); g.areas = [];
  g.bot = null; g.inspector = null;
  Object.assign(g.fl, { x: 10, y: 11, a: 0, speed: 0 });
  g.walls.push({ x: 8, y: 3, w: 4, h: 2.4 }, { x: 8, y: 6.6, w: 4, h: 2.4 });
  const east = g.coneBot, west = g.tapeBot;
  Object.assign(east, { mode: 'out', show: 1, activity: 'work', x: 8.5, y: 6, a: 0 });
  Object.assign(west, { mode: 'out', show: 1, activity: 'work', x: 11.5, y: 6, a: Math.PI });
  g.oil = [{ id: 'corridor', x: 14, y: 6, r: 0.3, drops: 20 }];
  const area = { color: 0, x: 4, y: 5, w: 2, h: 2 }, key = areaMarkKey(area);
  g.areas = [area];
  g.tapes = [{ ...area, key, sig: '', posts: [true, true, true, true], edges: [true, true, true, true] }];
  g.inspector = null;
  // Keep the tape bot's job on the west side of the gap.
  const stackAt = () => null;
  let backedUp = false;
  for (let n = 0; n < 1200 && east.x < 12.5; n++) {
    stepConeBot(g, 0.05, []); stepTapeBot(g, 0.05, [], stackAt, () => false);
    backedUp ||= west.x > 11.6;
    assert.ok(Math.hypot(east.x - west.x, east.y - west.y) >= BOT_R * 2, 'bots keep clear while yielding');
  }
  assert.ok(backedUp && east.x > 12.5, 'the yielding bot backs out and the oncoming bot passes');
}

// Both bots turn sharply when fleeing and persist their idle timer in a save.
{
  for (const kind of ['bot', 'inspector']) {
    const g = botGame();
    g.stacks = []; flatWorld(g);
    const b = g[kind];
    g[kind === 'bot' ? 'inspector' : 'bot'] = null;
    Object.assign(b, { mode: 'out', show: 1, x: 8, y: 6, a: Math.PI, idle: 42 });
    Object.assign(g.fl, { x: 6, y: 6, a: 0, speed: 2 });
    if (kind === 'bot') stepBot(g, 0.1, 1.15 ** 2 / 50);
    else stepInspector(g, 0.1, [], () => null, () => false);
    assert.ok(b.scared, `${kind} is scared`);
    assert.ok(Math.abs(Math.atan2(Math.sin(b.a - Math.PI), Math.cos(b.a - Math.PI))) > TURN_RATE * 0.1, `${kind} turns faster when fleeing`);
    const original = botGame();
    original[kind] = b;
    const saved = deserializeGame(JSON.parse(JSON.stringify(serializeGame(original))));
    assert.equal(saved[kind].idle, b.idle, `${kind} idle timer survives saving`);
  }
}

// The inspector photographs each completed drop point once, in turn, then eventually returns to the hatch.
{
  const g = newGame(1, 0);
  g.stacks = [];
  const zs = g.zones.slice(0, 2);
  assert.equal(zs.length, 2);
  run(g, NONE, 2);
  assert.equal(g.inspector.show, 0, 'nothing is inspected while no drop point is done');
  g.stacks = zs.map((z) => ({ x: z.x, y: z.y, layers: Array(z.count).fill(z.color), pen: Array.from({ length: z.count }, () => ({ crash: 0, sq: 0 })), rots: Array(z.count).fill(0) }));
  const spots = [[1, 1], [g.w - 1, 1], [1, g.h - 1], [g.w - 1, g.h - 1]].map(([x, y]) => ({ x, y, d: Math.min(Math.hypot(x - g.hatch.x, y - g.hatch.y), ...g.zones.map((z) => Math.hypot(x - z.x, y - z.y))) }));
  Object.assign(g.fl, spots.sort((a, b) => b.d - a.d)[0]);
  const done = g.zones.filter((z) => zoneDone(g, z));
  assert.ok(done.length >= 1, 'drop points are done');
  assert.equal(flaggedStacks(g).length, 0, 'nothing is flagged before the inspector has looked');
  let t = 0, flashes = 0, prev = 0;
  while (g.inspector.seen.length < done.length && t < 120) {
    update(g, NONE, 1 / 120); t += 1 / 120;
    if (g.inspector.flash > prev) {
      flashes++;
      assert.ok(g.hits.some((h) => h.check === 'perfect' || h.check === 'warn'), 'each photo produces a verdict label');
      const dv = Math.atan2(Math.sin(2 * (g.photo.view - (g.photo.rots[0] ?? 0) - Math.PI / 4)), Math.cos(2 * (g.photo.view - (g.photo.rots[0] ?? 0) - Math.PI / 4))) / 2;
      assert.ok(Math.abs(dv) < 0.5, 'photographed from a corner, so two sides of the stack show');
    }
    prev = g.inspector.flash;
  }
  assert.equal(g.inspector.seen.length, done.length, 'all completed drop points were photographed');
  assert.equal(flashes, done.length, 'one photo each');
  assert.ok(g.photo && g.photo.n === done.length && typeof g.photo.ok === 'boolean' && g.photo.layers.length > 0, 'each photo leaves a snapshot for the popup');
  assert.ok(g.stacks.every((s) => s.pen.every((p) => p.inspected === true)), 'inspection marks every photographed box');
  assert.equal(flaggedStacks(g).length, done.filter((z) => zoneWonky(g, z)).length, 'every inspected crooked stack is flagged with a "!"');
  if (g.stacks.length) { // touching a photographed stack clears its flag and sends the inspector back
    const st = g.stacks[0];
    Object.assign(g.fl, { x: st.x, y: st.y - 2, a: Math.PI / 2, speed: 0 });
    update(g, { horn: true }, 1 / 120);
    Object.assign(g.fl, spots[0]);
    assert.ok(g.inspector.seen.length < done.length, 'a nudged stack is inspected again');
    assert.ok(!flaggedStacks(g).some((f) => f.x === st.x && f.y === st.y), 'its warning sign is gone');
    assert.ok(st.pen.every((p) => !p.inspected), 'a nudge hides every box badge until reinspection');
  }
  assert.ok(g.inspector.roll !== 0, 'the wheels turned while driving');
  run(g, NONE, 60);
  assert.ok(g.stacks.every((s) => s.pen.every((p) => p.inspected === true)), 'reinspection reveals the box badges again');
  g.inspector.idle = 600;
  run(g, NONE, 60);
  assert.equal(g.inspector.mode, 'hidden', 'it goes back into the hatch');
  const g3 = newGame(1, 0);
  g3.inspector.seen = ['1,2,0'];
  assert.deepEqual(deserializeGame(JSON.parse(JSON.stringify(serializeGame(g3)))).inspector.seen, ['1,2,0'], 'the inspector is saved');
}

// Driving into a stack marks it touched (which sends the inspector round again); a stack left alone is not.
{
  const g = newGame(1, 0);
  flatWorld(g);
  g.stacks = [{ x: 10, y: 5, layers: [0], pen: [{ crash: 1, sq: 0, inspected: true }], rots: [0] }, { x: 3, y: 9, layers: [1], pen: [{ crash: 1, sq: 0, inspected: true }], rots: [0] }];
  g.fl.x = 5; g.fl.y = 5; g.fl.a = 0; g.H = 3;
  for (let i = 0; i < 6 * 120; i++) update(g, { up: true }, 1 / 120);
  assert.ok(g.stacks[0].touched, 'the forklift hit the stack');
  assert.ok(!g.stacks[1].touched, 'a stack that was left alone is untouched');
  assert.ok(!g.stacks[0].pen[0].inspected, 'contact forgets the hit stack');
  assert.ok(g.stacks[1].pen[0].inspected, 'contact does not forget an untouched stack');
  g.stacks[0].touched = false;
  g.stacks[0].pen[0].inspected = true;
  g.fl.x = g.stacks[0].x - 2; g.fl.a = 0;
  run(g, { horn: true }, 0.1);
  assert.ok(g.stacks[0].touched, 'a honk nudge touches the stacks in range');
  assert.ok(!g.stacks[0].pen[0].inspected, 'a honk also forgets the inspected status');
}

// Inspector targeting: nearest reachable drop point; threats are only forklifts driving towards it; route obstacles are ignored until met.
{
  const setup = () => {
    const g = newGame(1, 0);
    g.stacks = g.zones.slice(0, 2).map((z) => ({ x: z.x, y: z.y, layers: Array(z.count).fill(z.color), pen: [], rots: [] }));
    Object.assign(g.fl, { x: 1, y: 1 });
    return g;
  };
  const g = setup(), [z0, z1] = g.zones.slice(0, 2), ins = g.inspector;
  const near = z1; // put the bot beside the second drop point
  Object.assign(ins, { x: near.x + 2.5, y: near.y, mode: 'out', show: 1 });
  update(g, NONE, 1 / 120);
  const keyOf = (z) => `${z.x},${z.y},${z.color}`;
  const nearer = Math.hypot(z0.x - ins.x, z0.y - ins.y) < Math.hypot(z1.x - ins.x, z1.y - ins.y) ? z0 : z1;
  assert.equal(ins.target, keyOf(nearer), 'it goes for the closest reachable drop point');
  const before = ins.path.length, tgt = ins.target, mid = ins.path[Math.floor(before / 2)];
  if (before > 8) { // a parked forklift appears far along the route: ignored until the bot meets it
    Object.assign(g.fl, { x: mid.x, y: mid.y, speed: 0 });
    update(g, NONE, 1 / 120);
    assert.equal(ins.target, tgt, 'an obstacle on the route is ignored until it is met');
    assert.ok(ins.path.length >= before - 2, 'the route is kept');
  }
  const g2 = setup(), i2 = g2.inspector;
  Object.assign(i2, { x: 6, y: 6, mode: 'out', show: 1 });
  Object.assign(g2.fl, { x: 4.5, y: 6, a: 0, speed: 2 });
  update(g2, NONE, 1 / 120);
  assert.ok(i2.scared, 'a forklift driving towards it scares it');
  const g3 = setup(), i3 = g3.inspector;
  Object.assign(i3, { x: 6, y: 6, mode: 'out', show: 1 });
  Object.assign(g3.fl, { x: 4.5, y: 6, a: Math.PI, speed: 2 });
  update(g3, NONE, 1 / 120);
  assert.ok(!i3.scared, 'a forklift driving away is ignored');
  const g4 = setup(), i4 = g4.inspector;
  Object.assign(i4, { x: 6, y: 6, mode: 'out', show: 1 });
  Object.assign(g4.fl, { x: 4.5, y: 6, a: 0, speed: 0 });
  update(g4, NONE, 1 / 120);
  assert.ok(!i4.scared, 'a stationary forklift is ignored');
}

// A wall splits the room: with a forklift in the only gap the bot waits (away from it) and gets through once the gap is free;
// with a second gap it takes the detour.
{
  const room = (gapsOf) => {
    const g = botGame();
    g.stacks = [];
    g.walls = g.walls.slice(0, 4);
    const mx = g.w / 2;
    const wall = (x, y, w, h) => g.walls.push({ x, y, w, h, poly: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] });
    let y0 = 0;
    for (const [a, b] of gapsOf(g.h)) { if (a > y0) wall(mx - 0.1, y0, 0.2, a - y0); y0 = b; }
    wall(mx - 0.1, y0, 0.2, g.h - y0);
    const far = g.hatch.x < mx ? g.w - 2 : 2;
    g.oil = [{ id: 't', x: far, y: g.h / 2, r: 0.163, drops: 1 }];
    return { g, mx, farSide: (x) => (far > mx ? x > mx + 0.5 : x < mx - 0.5) };
  };
  {
    const { g, mx, farSide } = room((h) => [[h / 2 - 0.9, h / 2 + 0.9]]);
    // The forklift stands in the gap, nose through it.
    g.fl.x = mx - 1.0; g.fl.y = g.h / 2; g.fl.a = 0;
    let crossed = false, waited = false;
    for (let i = 0; i < 120 * 25; i++) {
      g.fl.x = mx - 1.0; g.fl.y = g.h / 2; g.fl.a = 0;
      update(g, NONE, 1 / 120);
      if (g.bot.show > 0 && farSide(g.bot.x)) crossed = true;
      if (g.bot.waiting) waited = true;
    }
    assert.ok(waited && !crossed && g.oil.length, 'the bot waits while the only way is blocked');
    assert.ok(truckGap(g, g.bot) > -BOT_R * 0.5, 'and is not run over');
    g.fl.x = g.bot.x; g.fl.y = g.h - 1;
    let t = 0;
    while (g.oil.length && t++ < 120 * 90) update(g, NONE, 1 / 120);
    assert.ok(!g.oil.length, 'it gets through and cleans once the way is free');
  }
  {
    const { g, mx } = room((h) => [[1.2, 3.2], [h - 3.2, h - 1.2]]);
    let t = 0;
    while (g.oil.length && t++ < 120 * 90) {
      g.fl.x = mx - 1.0; g.fl.y = 2.2; g.fl.a = 0; g.fl.speed = 0; // blocks the upper gap
      update(g, NONE, 1 / 120);
    }
    assert.ok(!g.oil.length, 'the bot finds the other gap');
  }
}

// A bot that had to flee from a forklift afterwards favours spills far from forklifts over nearby ones.
{
  const pick = (spooked) => {
    const g = botGame();
    clearOf(g, g.hatch);
    g.stacks = [];
    g.fl.x = 1; g.fl.y = 6; g.fl.a = 0;
    // the 'far' spill is a slightly bigger puddle (cleaned later), so only the forklift distance can make a bot prefer it
    g.oil = [{ id: 'near', x: 3, y: 6, r: 0.2, drops: 1 }, { id: 'far', x: 8, y: 6, r: 0.2, drops: 1.25 }];
    Object.assign(g.bot, { mode: 'out', show: 1, x: 5.5, y: 6 });
    if (spooked) g.bot.spookedUntil = g.clock + 10;
    update(g, NONE, 1 / 120);
    return g.bot.goal && g.oil.find((o) => o.x === g.bot.goal.x && o.y === g.bot.goal.y)?.id;
  };
  assert.equal(pick(false), 'near', 'a calm bot takes the nearby spill');
  assert.equal(pick(true), 'far', 'a spooked bot goes for the one far from the forklift');
}

// A damaged stack is never "perfect": the inspector's photo says so and lists the damage.
{
  const g = newGame(1, 0);
  const z = g.zones[0];
  g.stacks = [{ x: z.x, y: z.y, layers: Array(z.count).fill(z.color), rots: Array(z.count).fill(0), offs: Array(z.count).fill(0).map(() => ({ x: 0, y: 0 })), a: 0, pen: Array(z.count).fill(0).map(() => ({ crash: 0, sq: 0 })) }];
  g.stacks[0].pen[0].crash = 12;
  const spots = [[1, 1], [g.w - 1, 1], [1, g.h - 1], [g.w - 1, g.h - 1]].map(([x, y]) => ({ x, y, d: Math.min(Math.hypot(x - g.hatch.x, y - g.hatch.y), ...g.zones.map((q) => Math.hypot(x - q.x, y - q.y))) }));
  Object.assign(g.fl, spots.sort((a, b) => b.d - a.d)[0]);
  for (let t = 0; t < 120 && !g.photo; t += 1 / 120) update(g, NONE, 1 / 120);
  assert.ok(g.photo, 'the stack was photographed');
  assert.equal(g.photo.ok, false, 'damage means no GOOD JOB');
  assert.equal(g.photo.pens[0].crash, 12);
  assert.equal(flaggedStacks(g).length, 1, 'a photographed damaged stack gets the floating "!"');
  const fl = flaggedStacks(g)[0];
  assert.ok(fl.damaged && !fl.wonky, 'damage only');
  assert.equal(flagSymbol(fl, 0), 'damaged');
  assert.equal(flagSymbol({ wonky: true, damaged: false }, 0), 'wonky');
  assert.deepEqual([0, 1, 2, 3].map((t) => flagSymbol({ wonky: true, damaged: true }, t + 0.5)), ['wonky', 'damaged', 'wonky', 'damaged'], 'both problems alternate');
  g.stacks[0].pen[0].wide = true;
  assert.equal(flaggedStacks(g).length, 0, 'damage that cannot be repaired is not flagged');
  g.stacks[0].pen[0].wide = false;
  const fresh = newGame(1, 0);
  fresh.photo = g.photo;
  const back = deserializeGame(JSON.parse(JSON.stringify(serializeGame(fresh))));
  assert.deepEqual(back.photo, JSON.parse(JSON.stringify(g.photo)), 'the last picture survives save and load');
}

// In Hard mode the inspector reveals whether each box is turned, shifted, or both.
{
  const g = newGame(1, 0, true);
  const z = g.zones[0];
  const s = { x: z.x, y: z.y, layers: [z.color, z.color], a: Math.PI / 8,
    rots: [Math.PI / 8, 0], offs: [{ x: 0, y: 0 }, { x: 0, y: 0.22 }] };
  z.count = 2;
  g.stacks = [s];
  clearOf(g, z);
  assert.equal(flaggedStacks(g).length, 0);
  assert.equal(score(g, true), 200);
  for (let t = 0; t < 120 && !g.photo; t += 1 / 120) update(g, NONE, 1 / 120);
  assert.ok(g.photo, 'hard stack was photographed');
  assert.equal(g.photo.ok, false);
  assert.deepEqual(issues(g.photo), ['Box 1 is rotated', 'Box 2 is shifted sideways']);
  assert.equal(score(g, true), score(g), 'reported placement losses now show in the live score');
  assert.equal(flaggedStacks(g)[0].wonky, true);

  s.rots[1] = Math.PI / 8;
  update(g, NONE, 1 / 120);
  assert.equal(g.photo, null, 'the old report no longer applies');
  assert.equal(score(g, true), 200);
  for (let t = 0; t < 120 && !g.photo; t += 1 / 120) update(g, NONE, 1 / 120);
  assert.ok(g.photo, 'changed stack was photographed again');
  assert.equal(issues(g.photo)[1], 'Box 2 is rotated and shifted sideways');
}

// End of level: every stack gets a picture with the points it contributed, longest-dormant stack first; a missing photo is faked from the stack.
{
  const g = newGame(1, 0);
  const [z0, z1] = g.zones;
  g.stacks = [z0, z1].map((z, i) => ({ x: z.x, y: z.y, layers: Array(z.count).fill(z.color), rots: Array(z.count).fill(0), offs: Array(z.count).fill(0).map(() => ({ x: 0, y: 0 })), a: 0, pen: Array(z.count).fill(0).map((_, j) => ({ crash: i || j ? 0 : 10, sq: 0 })) }));
  const mk = (t) => ({ n: 1, t, ok: true, layers: [0], pens: [{ crash: 0 }], at: { x: 0, y: 0 } });
  g.inspector.photos = { [`${z1.x},${z1.y},${z1.color}`]: mk(20) };
  g.clock = 50;
  const list = endPhotos(g);
  assert.equal(list.length, 2, 'a stack without a photo gets a faked one');
  assert.deepEqual(list.map((p) => p.t), [20, 50], 'the stack dormant longest comes first');
  const fake = list[1];
  assert.equal(fake.score.crash, 10);
  assert.equal(fake.score.total, fake.score.base - 10, 'damage is deducted from the stack points');
  assert.equal(fake.ok, false, 'a faked picture of a damaged stack is not perfect');
  assert.equal(fake.pens[0].crash, 10);
  assert.equal(fake.layers.length, g.stacks[0].layers.length);
  assert.equal(list[0].score.total, list[0].score.base, 'a perfect stack scores its full points');
  assert.equal(endPhotos(g)[0], list[0], 'one stable object per picture');
}

// Going in and out of the hatch is a straight line square to the wall: facing out, on the hatch's axis, while sliding.
{
  const g = botGame(), h = g.hatch;
  g.stacks = []; clearOf(g, h);
  g.oil = [{ id: 't', x: h.x + h.nx * 4, y: h.y + h.ny * 4, r: 0.163, drops: 1 }];
  let sliding = 0, t = 0, prev = null;
  while (g.bot.mode !== 'hidden' || !sliding) {
    if (g.bot.show === 0 || g.bot.show === 1) prev = null;
    if (!g.oil.length) g.bot.idle = 600;
    update(g, NONE, 1 / 120); t += 1 / 120;
    if (g.bot.show > 0 && g.bot.show < 1) {
      sliding++;
      assert.ok(Math.abs(Math.sin(g.bot.a - h.a)) < 0.06, 'square to the wall while sliding');
      if (prev) assert.ok((g.bot.x - prev.x) * Math.cos(g.bot.a) + (g.bot.y - prev.y) * Math.sin(g.bot.a) > 0, 'drives forwards, in and out');
      prev = { x: g.bot.x, y: g.bot.y };
      assert.ok(Math.abs((g.bot.x - h.x) * h.ny - (g.bot.y - h.y) * h.nx) < 1e-6, 'stays on the straight line out of the hatch while sliding');
    }
    assert.ok(t < 90, 'bot finishes and goes home');
  }
}

// Bots turn at a limited speed, whatever they are doing.
{
  const g = botGame();
  g.stacks = []; clearOf(g, g.hatch);
  g.oil = [{ id: 't', x: g.hatch.x + g.hatch.nx * 4 + 3, y: g.hatch.y + g.hatch.ny * 4, r: 0.163, drops: 1 }];
  let prev = null, maxTurn = 0;
  for (let i = 0; i < 120 * 30; i++) {
    update(g, NONE, 1 / 120);
    const b = g.bot;
    if (prev !== null && b.show === 1) maxTurn = Math.max(maxTurn, Math.abs(Math.atan2(Math.sin(b.a - prev), Math.cos(b.a - prev))));
    prev = b.show === 1 ? b.a : null;
  }
  assert.ok(maxTurn > 0 && maxTurn <= TURN_RATE / 120 + 1e-9, `turns at most ${TURN_RATE} rad/s (${(maxTurn * 120).toFixed(2)})`);
}

// Bots keep their size when they appear: they slide out of the wall through the hatch instead of scaling up.
{
  const g = botGame(), h = g.hatch, b = { x: 5 + h.nx, y: 5 + h.ny, show: 1 };
  const d = (show) => { const p = botDrawPos({ ...b, show }, h); return (p.x - b.x) * h.nx + (p.y - b.y) * h.ny; };
  assert.equal(d(1), 0, 'fully out: at its real position');
  assert.ok(d(0.5) < 0 && d(0) < d(0.5), 'part way: further into the wall (behind the hatch line)');
  assert.ok(-d(0) >= BOT_R + 0.1, 'hidden: at least from its home position back to the wall face');
}

// An inspector boxed in by a solid obstacle (e.g. a repair mast) walks out of it instead of sitting stuck.
{
  const g = newGame(2, 0);
  const m = g.repair.mast;
  g.inspector.show = 1; g.inspector.mode = 'out';
  g.inspector.x = m.x + m.w / 2; g.inspector.y = m.y + m.h / 2;
  run(g, NONE, 20);
  assert.ok(Math.hypot(g.inspector.x - (m.x + m.w / 2), g.inspector.y - (m.y + m.h / 2)) > 1, 'the inspector got out from inside the mast');
}

// A forklift running over the inspector next to a wall never leaves it inside the wall.
{
  const g = newGame(2, 0);
  const m = g.repair.mast;
  g.inspector.show = 1; g.inspector.mode = 'out';
  g.inspector.x = m.x - BOT_R - 0.05; g.inspector.y = m.y + m.h / 2;
  g.fl.x = g.inspector.x - 1.2; g.fl.y = g.inspector.y; g.fl.a = 0;
  for (let i = 0; i < 240; i++) {
    update(g, { up: true }, 1 / 120);
    const dx = Math.max(m.x - g.inspector.x, 0, g.inspector.x - m.x - m.w), dy = Math.max(m.y - g.inspector.y, 0, g.inspector.y - m.y - m.h);
    assert.ok(Math.hypot(dx, dy) > 0.01, 'the inspector is never inside the mast');
  }
}

// Cones sit at stack corners, away from adjacent drop-point corners regardless of completion.
{
  const g = newGame(1, 0);
  const a = { color: 0, x: 4, y: 4, w: 4, h: 2 };
  const left = { x: 5, y: 5, color: 0, count: 1 }, right = { x: 6.6, y: 5, color: 0, count: 1 };
  const stack = (z, pen = { crash: 0, sq: 0 }) => ({ x: z.x, y: z.y, layers: [z.color], rots: [0], offs: [{ x: 0, y: 0 }], pen: [pen] });
  g.zones = [left, right]; g.areas = [a]; g.stacks = [stack(left), stack(right)];
  const onlyLeft = coneTargets(g, [left]);
  assert.equal(onlyLeft.length, 2, 'the first stack gets its two outer corners');
  assert.ok(onlyLeft.every((c) => c.x < left.x && Math.abs(c.y - left.y) > 0.6), 'the markers are stack corners away from the adjacent point');
  const both = coneTargets(g, [left, right]);
  assert.equal(both.filter((c) => c.id.startsWith('stack:')).length, 4, 'neighbouring corners remain clear even when both points are filled');
  assert.ok(both.every((c) => c.x < left.x || c.x > right.x));
  assert.equal(new Set(both.map((c) => c.id)).size, both.length, 'shared positions do not get duplicate cones');
  const third = { x: 8.2, y: 5, color: 0, count: 1 };
  g.zones.push(third);
  const middle = coneTargets(g, [right]);
  assert.equal(middle.length, 0, 'a stack between adjacent points has no clear corners');
  g.zones = [left, { ...right, x: 7 }];
  assert.equal(coneTargets(g, [left]).length, 4, 'a separated point does not block corners');
  g.zones = [left, { ...right, x: 5, y: 6.6 }];
  assert.ok(coneTargets(g, [left]).every((c) => c.y < left.y), 'vertical neighbours block the near corners');
  assert.equal(coneTargets(g, [left]).length, 2);
  g.zones = [left, { ...right, x: 6.6, y: 6.6 }];
  assert.equal(coneTargets(g, [left]).length, 3, 'a diagonally adjacent point blocks its nearest corner');
  g.zones = [left, right];
  g.stacks[0].rots[0] = Math.PI / 4;
  for (const c of coneTargets(g, [left])) {
    const dx = c.x - left.x, dy = c.y - left.y;
    const localX = (dx + dy) / Math.SQRT2, localY = (dy - dx) / Math.SQRT2;
    assert.ok(Math.abs(Math.abs(localX) - (BOX_HALF_X + 0.18)) < 1e-9 && Math.abs(Math.abs(localY) - (halfY(g.stacks[0].pen[0]) + 0.18)) < 1e-9, 'rotated markers remain at the stack corners');
    const e = zoneExt(right);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      assert.ok(Math.hypot(c.x - right.x - sx * e.x, c.y - right.y - sy * e.y) >= 0.5, 'rotated markers avoid neighbouring point corners');
    }
  }
  g.stacks[0].rots[0] = 0;
  g.stacks[0].pen[0].wide = true;
  g.zones = [left, { ...right, x: 5, y: 7 }];
  const wide = coneTargets(g, [left]);
  assert.equal(wide.length, 2, 'wide stacks also avoid adjacent drop-point corners');
  assert.ok(wide.every((c) => c.y < left.y && Math.abs(c.y - left.y + 1.18) < 1e-9), 'wide stack corners use the full footprint');
  delete g.stacks[0].pen[0].wide;
  g.zones = [left]; g.areas = [{ color: 0, x: 4, y: 4, w: 2, h: 2 }];
  g.oil = [{ id: 'spill-1', x: 10, y: 10, r: 0.4, drops: 1 }];
  const solo = coneTargets(g, [left]);
  assert.equal(solo.filter((c) => c.id.startsWith('spill:')).length, 4);
  assert.equal(solo.filter((c) => c.id.startsWith('stack:')).length, 4, 'wonky or damaged completed stacks still get marked');
}

// The cone bot waits for each photo, then marks that stack without waiting for the rest of the area.
{
  const g = newGame(1, 0);
  flatWorld(g);
  const left = { x: 5, y: 5, color: 0, count: 1 }, right = { x: 6.6, y: 5, color: 0, count: 1 };
  const stack = (z) => ({ x: z.x, y: z.y, layers: [0], pen: [{ crash: 1, sq: 0 }], rots: [0] });
  g.zones = [left, right]; g.areas = [{ color: 0, x: 4, y: 4, w: 4, h: 2 }];
  g.stacks = [stack(left)]; g.bot = null; g.tapeBot = null; g.oil = [];
  Object.assign(g.fl, { x: 2, y: 2, a: 0, speed: 0 });
  stepConeBot(g, 0.05, [left]);
  assert.equal(g.coneBot.mode, 'hidden', 'a filled but uninspected point does not start the cone bot');
  for (let i = 0; i < 120 * 90 && g.cones.length < 2; i++) update(g, NONE, 1 / 120);
  assert.ok(g.inspector.seen.includes('5,5,0'), 'the inspector photographs the first stack');
  assert.ok(g.cones.length >= 2 && g.cones.every((c) => c.goalId.startsWith('stack:5,5,0:')), 'only the inspected stack gets cones');
  assert.ok(g.cones.every((c) => c.x < left.x && Math.abs(c.y - left.y) > 0.6), 'the bot places the cones on the clear stack corners');
  assert.equal(zoneDone(g, right), false, 'the neighbouring point is still unfinished');
  g.stacks.push(stack(right));
  stepConeBot(g, 0.05, [left, right]);
  assert.ok(!g.cones.some((c) => c.goalId.startsWith('stack:6.6,5,0:')), 'a newly filled point waits for its own inspection');
  for (let i = 0; i < 120 * 90 && !g.cones.some((c) => c.goalId.startsWith('stack:6.6,5,0:')); i++) update(g, NONE, 1 / 120);
  assert.ok(g.inspector.seen.includes('6.6,5,0'));
  assert.ok(g.cones.some((c) => c.goalId.startsWith('stack:6.6,5,0:')), 'the second stack is marked after its own inspection');
}

// Area tape requires all points, square placement, and no repairable damage; permanent barrel damage is allowed.
{
  const g = newGame(1, 0);
  const z = { x: 5, y: 5, color: 0, count: 1 }, area = { color: 0, x: 4, y: 4, w: 2, h: 2 };
  const s = { x: 5, y: 5, layers: [0], rots: [0], offs: [{ x: 0, y: 0 }], pen: [{ crash: 0, sq: 0 }] };
  g.zones = [z]; g.areas = [area]; g.stacks = [s];
  const stackAt = () => s, done = [z], clean = () => false;
  assert.equal(areaComplete(g, area, stackAt, done, clean), true);
  assert.equal(areaComplete(g, area, stackAt, [], clean), false, 'an empty point is not complete');
  assert.equal(areaComplete(g, area, stackAt, done, () => true), false, 'wonkiness blocks tape');
  const second = { x: 7, y: 5, color: 0, count: 1 }, s2 = { ...s, x: second.x, y: second.y };
  g.zones.push(second); g.areas = [{ color: 0, x: 4, y: 4, w: 4, h: 2 }]; g.stacks.push(s2);
  assert.equal(areaComplete(g, g.areas[0], (q) => q === z ? s : s2, [z], clean), false, 'every point in a multi-point area must be complete');
  g.zones = [z]; g.areas = [area]; g.stacks = [s];
  s.pen[0].crash = 1;
  assert.equal(areaComplete(g, area, stackAt, done, clean), false, 'repairable damage blocks tape');
  z.color = 6; z.count = 1;
  const barrel = { x: 5, y: 5, layers: [6, 6], rots: [0, 0], offs: [{ x: 0, y: 0 }, { x: 0, y: 0 }],
    pen: [{ crash: 2, barrelPart: 'base' }, { crash: 2, barrelPart: 'top' }] };
  g.stacks = [barrel]; g.areas = [{ color: 6, x: 4, y: 4, w: 2, h: 2 }];
  assert.equal(areaComplete(g, g.areas[0], () => barrel, [z], clean), true, 'permanent barrel damage does not block tape');
}

// The cone bot physically places cones, retrieves them when their reason disappears, and restores tipped cones.
{
  const g = newGame(1, 0);
  g.stacks = []; g.zones = []; g.areas = []; g.bot = null; g.inspector = null;
  g.oil = [{ id: 'temporary', x: g.w / 2, y: g.h / 2, r: 0.3, drops: 1 }];
  g.coneBot.show = 1; g.coneBot.mode = 'out';
  for (let i = 0; i < 120 * 90 && g.cones.length < 4; i++) { g.clock += 1 / 120; update(g, NONE, 1 / 120); }
  assert.equal(g.cones.length, 4, 'cones are placed around a live slick');
  g.oil = [];
  for (let i = 0; i < 120 * 90 && g.cones.length; i++) { g.clock += 1 / 120; update(g, NONE, 1 / 120); }
  assert.equal(g.cones.length, 0, 'the bot stores obsolete cones');
  update(g, NONE, 1 / 120);
  assert.equal(g.coneBot.activity, 'follow', 'after storing its last cone the bot watches the forklift');
  assert.equal(g.coneBot.mode, 'out', 'storing its last cone does not send it straight into the hatch');

  const area = { color: 0, x: 4, y: 4, w: 4, h: 4 };
  const spill = { id: 'inside-tape', x: 6, y: 6, r: 0.2, drops: 1 };
  const tapedTarget = { id: 'spill:inside-tape:0', x: spill.x + spill.r + 0.35, y: spill.y };
  g.zones = []; g.stacks = []; g.areas = [area]; g.oil = [spill];
  g.tapes = [{ key: areaMarkKey(area), ...area, broken: false }];
  g.cones = [{ id: 'taped-cone', goalId: tapedTarget.id, ...tapedTarget, a: 0, tipped: false, squished: false }];
  Object.assign(g.fl, { x: 1, y: 1, speed: 0 });
  Object.assign(g.coneBot, { x: tapedTarget.x, y: tapedTarget.y, show: 1, mode: 'out', path: [], repath: 0 });
  assert.ok(!coneTargets(g, []).some((target) => target.id === tapedTarget.id), 'an intact tape outline suppresses spill markers inside its zone');
  for (let i = 0; i < 120 * 90 && g.cones.length; i++) { g.clock += 1 / 120; stepConeBot(g, 1 / 120, []); }
  assert.equal(g.cones.length, 0, 'the cone bot retrieves cones from a taped-off zone even while the spill remains');

  g.tapes = [];
  const target = { id: 'spill:repair:0', x: g.w / 2, y: g.h / 2 };
  g.oil = [{ id: 'repair', x: target.x, y: target.y, r: 0.2, drops: 1 }];
  g.cones = [{ id: 'damaged-cone', goalId: target.id, x: target.x, y: target.y, a: 0, tipped: true, squished: false }];
  Object.assign(g.coneBot, { x: target.x, y: target.y, show: 1, mode: 'out', path: [], repath: 0 });
  for (let i = 0; i < 120 * 30 && !g.cones.some((c) => c.goalId === target.id && !c.tipped); i++) { g.clock += 1 / 120; update(g, NONE, 1 / 120); }
  assert.ok(g.cones.some((c) => c.goalId === target.id && !c.tipped), 'the bot retrieves and restores a displaced cone');
  const restored = g.cones.find((c) => c.goalId === target.id);
  restored.squished = true;
  for (let i = 0; i < 120 * 30 && !g.cones.some((c) => c.goalId === target.id && !c.squished); i++) { g.clock += 1 / 120; update(g, NONE, 1 / 120); }
  assert.ok(g.cones.some((c) => c.goalId === target.id && !c.squished && c.id !== restored.id), 'the bot replaces a crushed cone where it is still needed');
}

// Obsolete cones go straight into unlimited onboard storage, including a cone from an old save.
{
  const g = newGame(1, 0), b = g.coneBot;
  flatWorld(g); g.stacks = []; g.zones = []; g.areas = []; g.oil = [];
  g.bot = null; g.inspector = null; g.tapeBot = null;
  Object.assign(g.fl, { x: 1, y: 1, speed: 0 });
  Object.assign(b, { x: 8, y: 8, a: 0, mode: 'out', show: 1, path: [], repath: 0,
    carried: { id: 'legacy', goalId: 'old:0' } });
  g.cones = [0, 1, 2].map((i) => ({ id: `old-${i}`, goalId: `old:${i}`, x: 8.1 + i * 0.05, y: 8, a: 0 }));
  for (let i = 0; i < 30 && g.cones.length; i++) stepConeBot(g, 0.05, []);
  assert.equal(g.cones.length, 0, 'several cones are collected without a hatch trip');
  assert.equal(b.carried, null, 'a legacy carried cone is put into storage');
  assert.ok(Math.hypot(b.x - 8, b.y - 8) < 1, 'the bot stays near the collected cones');
  stepConeBot(g, 0.05, []);
  assert.equal(b.activity, 'follow', 'the bot resumes curiosity once collection is finished');
}

// A blocked target gets a persistent best-effort cone, which is improved when the route opens.
{
  const g = newGame(1, 0);
  flatWorld(g); g.stacks = []; g.zones = []; g.areas = [];
  g.bot = null; g.inspector = null; g.tapeBot = null;
  g.oil = [{ id: 'blocked', x: 10, y: 8, r: 0.2, drops: 1 }];
  Object.assign(g.fl, { x: 1, y: 1, speed: 0 });
  Object.assign(g.coneBot, { x: 6, y: 8, a: 0, mode: 'out', show: 1, path: [], repath: 0 });
  const wall = { x: 8, y: 0, w: 0.5, h: g.h };
  g.walls.push(wall);
  const [target, ...others] = coneTargets(g, []);
  g.cones = others.map((t) => ({ id: t.id, goalId: t.id, x: t.x, y: t.y, a: 0, tipped: false, squished: false }));
  const step = () => { g.clock += 0.05; stepConeBot(g, 0.05, []); };
  for (let i = 0; i < 1200 && !g.cones.some((c) => c.goalId === target.id); i++) step();
  const misplaced = g.cones.find((c) => c.goalId === target.id);
  assert.ok(misplaced?.misplaced, 'an unreachable target gets a flagged cone');
  assert.ok(misplaced.x < wall.x && Math.hypot(misplaced.x - target.x, misplaced.y - target.y) > 0.22, 'fallback is on reachable floor');
  const saveGame = newGame(1, 0);
  saveGame.cones = [misplaced];
  const saved = deserializeGame(JSON.parse(JSON.stringify(serializeGame(saveGame))));
  assert.ok(saved.cones.find((c) => c.goalId === target.id).misplaced, 'the flag survives saving');
  for (let i = 0; i < 500; i++) step();
  assert.ok(g.cones.includes(misplaced) && !misplaced.retire, 'failed retries leave the warning in place');
  g.walls.splice(g.walls.indexOf(wall), 1);
  for (let i = 0; i < 1200 && !g.cones.some((c) => c.goalId === target.id && !c.misplaced && !c.retire); i++) {
    step();
    assert.ok(g.cones.some((c) => c.goalId === target.id && !c.retire), 'a warning remains while the bot travels');
  }
  const improved = g.cones.find((c) => c.goalId === target.id && !c.misplaced && !c.retire);
  assert.ok(improved && Math.hypot(improved.x - target.x, improved.y - target.y) < 0.22, 'the cone is improved once reachable');
  for (let i = 0; i < 1200 && g.cones.includes(misplaced); i++) step();
  assert.ok(!g.cones.includes(misplaced), 'the superseded fallback is collected');
}

// Multiple unreachable markers get separate cones instead of blocking each other.
{
  const g = newGame(1, 0);
  flatWorld(g); g.stacks = []; g.zones = []; g.areas = [];
  g.bot = null; g.inspector = null; g.tapeBot = null;
  g.oil = [{ id: 'isolated', x: 10, y: 8, r: 0.2, drops: 1 }];
  Object.assign(g.fl, { x: 1, y: 1, speed: 0 });
  Object.assign(g.coneBot, { x: 6, y: 8, a: 0, mode: 'out', show: 1, path: [], repath: 0 });
  g.walls.push({ x: 8, y: 0, w: 0.5, h: g.h });
  for (let i = 0; i < 2400 && g.cones.length < 4; i++) { g.clock += 0.05; stepConeBot(g, 0.05, []); }
  assert.equal(g.cones.length, 4, 'each blocked target receives a cone');
  assert.ok(g.cones.every((c) => c.misplaced && c.x < 8), 'all fallbacks are flagged and reachable');
  for (let i = 0; i < g.cones.length; i++) for (let j = 0; j < i; j++) {
    assert.ok(Math.hypot(g.cones[i].x - g.cones[j].x, g.cones[i].y - g.cones[j].y) >= 0.26, 'cones do not overlap');
  }
}

// A parked forklift blocks placement even when the target's surrounding floor is reachable.
{
  const g = newGame(1, 0);
  flatWorld(g); g.stacks = []; g.zones = []; g.areas = [];
  g.bot = null; g.inspector = null; g.tapeBot = null;
  g.oil = [{ id: 'truck', x: 10, y: 8, r: 0.2, drops: 1 }];
  const [target, ...others] = coneTargets(g, []);
  Object.assign(g.fl, { x: target.x, y: target.y, a: 0, speed: 0 });
  Object.assign(g.coneBot, { x: 6, y: 8, a: 0, mode: 'out', show: 1, path: [], repath: 0 });
  g.cones = others.map((t) => ({ id: t.id, goalId: t.id, x: t.x, y: t.y, a: 0, tipped: false, squished: false }));
  const step = () => { g.clock += 0.05; stepConeBot(g, 0.05, []); };
  for (let i = 0; i < 1200 && !g.cones.some((c) => c.goalId === target.id); i++) step();
  const fallback = g.cones.find((c) => c.goalId === target.id);
  assert.ok(fallback?.misplaced, 'the bot does not place the cone underneath the parked forklift');
  Object.assign(g.fl, { x: 1, y: 1 });
  for (let i = 0; i < 1200 && !g.cones.some((c) => c.goalId === target.id && !c.misplaced && !c.retire); i++) step();
  assert.ok(g.cones.some((c) => c.goalId === target.id && !c.misplaced && !c.retire), 'the target is used after the forklift moves');
}

// An unreachable obsolete cone does not prevent new warnings from being delivered.
{
  const g = newGame(1, 0);
  flatWorld(g); g.stacks = []; g.zones = []; g.areas = [];
  g.bot = null; g.inspector = null; g.tapeBot = null;
  g.oil = [{ id: 'new', x: 4, y: 8, r: 0.2, drops: 1 }];
  Object.assign(g.fl, { x: 1, y: 1, speed: 0 });
  Object.assign(g.coneBot, { x: 7, y: 8, a: 0, mode: 'out', show: 1, path: [], repath: 0 });
  g.walls.push({ x: 8, y: 0, w: 0.5, h: g.h });
  g.cones = [{ id: 'old', goalId: 'old:0', x: 8.8, y: 8, a: 0, tipped: false, squished: false }];
  for (let i = 0; i < 1200 && !g.cones.some((c) => c.goalId.startsWith('spill:new:')); i++) {
    g.clock += 0.05; stepConeBot(g, 0.05, []);
  }
  assert.ok(g.cones.some((c) => c.id === 'old'), 'the unreachable cone remains for later retrieval');
  assert.ok(g.cones.some((c) => c.goalId.startsWith('spill:new:')), 'other cone work proceeds');
}

// Cone work stays on its current spill/stack point until finished, then selects the nearest point.
{
  const g = newGame(1, 0);
  flatWorld(g); g.stacks = []; g.zones = []; g.areas = []; g.bot = null; g.inspector = null; g.tapeBot = null;
  g.oil = [{ id: 'far', x: 5, y: 5, r: 0.2, drops: 1 }, { id: 'near', x: 13, y: 13, r: 0.2, drops: 1 }];
  Object.assign(g.fl, { x: 1, y: 1, speed: 0 });
  const b = g.coneBot;
  Object.assign(b, { x: 12, y: 12, a: 0, mode: 'out', show: 1, path: [], repath: 0 });
  stepConeBot(g, 0.05, []);
  assert.ok(b.planKey.startsWith('place:spill:near:'), 'without a current point, the cone bot picks the nearest job');
  assert.equal(b.debugTask, 'placing cone', 'cone task omits the target identifier');

  const farTargets = coneTargets(g, []).filter((t) => t.id.startsWith('spill:far:'));
  g.cones = farTargets.slice(1).map((t) => ({ id: `cone:${t.id}`, goalId: t.id, x: t.x, y: t.y, tipped: false, squished: false }));
  b.workKey = 'spill:far';
  b.planKey = null; b.path = []; b.repath = 0;
  stepConeBot(g, 0.05, []);
  assert.ok(b.planKey.startsWith('place:spill:far:'), 'it finishes the current point before moving to a closer one');
  g.oil = [];
  stepConeBot(g, 0.05, []);
  assert.equal(b.debugTask, 'retrieving cone', 'obsolete cones are identified as retrieval work');
}

// Tape work stays on its current area, or otherwise starts with the nearest area.
{
  const setup = () => {
    const g = newGame(1, 0), far = { color: 0, x: 12, y: 12, w: 2, h: 2 }, near = { color: 0, x: 5, y: 5, w: 2, h: 2 };
    flatWorld(g); g.areas = [far, near]; g.bot = null; g.inspector = null; g.coneBot = null;
    const stackAt = fillTapeAreas(g, g.areas);
    for (const z of g.zones) scanTapeZone(g, z, stackAt(z));
    g.tapes = [far, near].map((area) => ({ ...area, key: areaMarkKey(area), broken: true,
      posts: [false, false, false, false], edges: [false, false, false, false] }));
    Object.assign(g.fl, { x: 1, y: 1, speed: 0 });
    Object.assign(g.tapeBot, { x: 7, y: 7, a: 0, mode: 'out', show: 1, path: [], repath: 0 });
    return { g, stackAt, farKey: areaMarkKey(far), nearKey: areaMarkKey(near) };
  };
  {
    const { g, stackAt, farKey } = setup();
    g.tapeBot.workKey = farKey;
    g.tapeBot.tapeJob = { key: farKey, edge: 0, from: 0, to: 1, phase: 'start' };
    stepTapeBot(g, 0.05, g.zones, stackAt, () => false);
    assert.equal(g.tapeBot.workKey, farKey, 'the active area remains the priority over a closer area');
    assert.equal(g.tapeBot.debugTask, 'taping zone 1');
  }
  {
    const { g, stackAt, nearKey } = setup();
    stepTapeBot(g, 0.05, g.zones, stackAt, () => false);
    assert.equal(g.tapeBot.workKey, nearKey, 'without active work, the tape bot selects the nearest area');
    assert.equal(g.tapeBot.debugTask, 'taping zone 2', 'tape task uses the selected area\'s one-based number');
  }
}

// Cone physics responds to forklift contact with displacement and damage.
{
  const g = newGame(1, 0);
  const before = { x: g.fl.x, y: g.fl.y };
  g.cones = [{ id: 'hit', goalId: 'target', x: before.x - 0.5, y: before.y, a: 0, tipped: false, squished: false }];
  g.fl.speed = 3;
  stepConeCollisions(g);
  assert.ok(g.cones[0].squished && Math.hypot(g.cones[0].x - before.x, g.cones[0].y - before.y) > 0.1);
  g.fl.x = 1; g.fl.y = 1; g.fl.speed = 0;
  g.stacks = [{ x: 8, y: 8, layers: [0], pen: [{ crash: 0, sq: 0 }] }];
  g.cones = [{ id: 'box-hit', goalId: 'target', x: 8.5, y: 8, a: 0, tipped: false, squished: false }];
  stepConeCollisions(g);
  assert.ok(g.cones[0].tipped && Math.hypot(g.cones[0].x - 8.5, g.cones[0].y - 8) > 0.1, 'a moving box stack can tip and displace a cone');
}

// Worker bots expose their current work destination and clear it when fleeing.
{
  for (const kind of ['coneBot', 'tapeBot']) {
    const g = newGame(1, 0), b = g[kind];
    flatWorld(g); g.stacks = []; g.zones = [];
    g.bot = null; g.inspector = null;
    let stackAt = () => null;
    if (kind === 'coneBot') {
      g.tapeBot = null; g.areas = [];
      g.oil = [{ id: 'debug', x: 8, y: 8, r: 0.3, drops: 1 }];
    } else {
      g.coneBot = null;
      const area = { x: 7, y: 7, w: 2, h: 2, color: 0 }, key = areaMarkKey(area);
      g.areas = [area];
      stackAt = fillTapeAreas(g, g.areas);
      scanTapeZone(g, g.zones[0], stackAt(g.zones[0]));
      g.tapes = [{ ...area, key, sig: '', broken: true, posts: [true, false, false, false], edges: [false, false, false, false] }];
    }
    Object.assign(g.fl, { x: 1, y: 1, speed: 0 });
    Object.assign(b, { x: 5, y: 5, a: 0, mode: 'out', show: 1, path: [], repath: 0 });
    const step = () => kind === 'coneBot' ? stepConeBot(g, 0.05, []) : stepTapeBot(g, 0.05, g.zones, stackAt, () => false);
    step();
    assert.ok(b.goal && Number.isFinite(b.goal.x) && Number.isFinite(b.goal.y), `${kind} exposes its work goal`);
    const route = b.path;
    assert.ok(route.length, `${kind} has a route to its work`);
    for (let i = 0; i < 12; i++) step();
    assert.equal(b.path, route, `${kind} keeps an unobstructed route instead of replanning periodically`);
    Object.assign(g.fl, { x: b.x - 2.5, y: b.y, a: 0, speed: 1 });
    step();
    assert.ok(b.scared, `${kind} is fleeing`);
    assert.equal(b.goal, null, `${kind} clears its obsolete goal while fleeing`);
  }
}

// Inspected valid tape is repaired; an incomplete area is dismantled without inspection.
{
  const g = newGame(1, 0);
  const z = { x: 5, y: 5, color: 0, count: 1 }, area = { color: 0, x: 4, y: 4, w: 2, h: 2 };
  const stack = { x: 5, y: 5, layers: [0], rots: [0], offs: [{ x: 0, y: 0 }], pen: [{ crash: 0, sq: 0 }] };
  g.zones = [z]; g.areas = [area]; g.stacks = [stack]; g.inspector = null;
  scanTapeZone(g, z, stack);
  const key = areaMarkKey(area), stackAt = () => g.stacks[0], wonky = () => false;
  g.tapes = [{ key, color: 0, x: area.x, y: area.y, w: area.w, h: area.h, sig: 'old', broken: true,
    posts: [true, true, true, true], edges: [true, false, true, true] }];
  clearOf(g, area);
  Object.assign(g.tapeBot, { x: 5, y: 5, show: 1, mode: 'out', path: [], repath: 0 });
  for (let i = 0; i < 1200 && g.tapes[0].broken; i++) stepTapeBot(g, 0.05, [z], stackAt, wonky);
  assert.equal(g.tapes[0].broken, false, 'the tape bot repairs after a successful scan');
  g.inspector = null;
  g.stacks = [];
  stepTapeBot(g, 0.05, [], stackAt, wonky);
  assert.equal(g.tapeBot.debugTask, 'removing tape from zone 1', 'an incomplete area immediately starts removal');
  let sawPartialRemoval = false;
  for (let i = 0; i < 1200 && g.tapes.length; i++) {
    stepTapeBot(g, 0.05, [], stackAt, wonky);
    if (g.tapes.length && g.tapes[0].posts.some((v) => !v) && g.tapes[0].posts.some(Boolean)) {
      sawPartialRemoval = true;
      for (let post = 0; post < 4; post++) if (!g.tapes[0].posts[post]) {
        assert.equal(g.tapes[0].edges[post], false, 'removing a pole removes the tape leaving it');
        assert.equal(g.tapes[0].edges[(post + 3) % 4], false, 'removing a pole removes the tape approaching it');
      }
    }
  }
  assert.ok(sawPartialRemoval, 'the bot dismantles the outline one pole at a time');
  assert.equal(g.tapes.length, 0, 'the incomplete area is dismantled without an inspector');
  g.stacks = [stack];
  assert.ok(areaComplete(g, area, () => stack, [z], wonky));
}

// Posts and tape are installed in stages, and each impact only damages the pieces it touches.
{
  const g = newGame(1, 0);
  flatWorld(g);
  const z = { x: 8, y: 8, color: 0, count: 1 }, area = { x: 7, y: 7, w: 2, h: 2, color: 0 };
  g.zones = [z]; g.areas = [area];
  g.stacks = [{ x: 8, y: 8, layers: [0], rots: [0], offs: [{ x: 0, y: 0 }], pen: [{ crash: 0, sq: 0 }] }];
  Object.assign(g.fl, { x: 1, y: 1, a: 0, speed: 0 });
  let sawPost = false, sawTrailing = false, sawPartial = false;
  for (let i = 0; i < 120 * 60; i++) {
    update(g, NONE, 1 / 120);
    const t = g.tapes[0];
    if (!t) continue;
    sawPost ||= t.posts.some(Boolean);
    sawTrailing ||= !!trailingTape(g);
    sawPartial ||= t.edges.some(Boolean) && !t.edges.every(Boolean);
    if (!t.broken) break;
  }
  const t = g.tapes[0];
  assert.ok(sawPost && sawTrailing && sawPartial && t && !t.broken, 'bot drops posts and pulls each edge before closing the loop');
  const corners = tapeCorners(t), midpoint = { x: (corners[0].x + corners[1].x) / 2, y: corners[0].y };
  stepTapeCollisions(g, [rectPoly(midpoint.x, midpoint.y, 0.1, 0.1)]);
  assert.deepEqual(t.edges, [false, true, true, true], 'a tape impact breaks only the contacted edge');
  assert.ok(t.posts.every(Boolean), 'tape impact leaves the posts intact');
  for (let i = 0; i < 120 * 45 && t.broken; i++) update(g, NONE, 1 / 120);
  assert.ok(!t.broken, 'bot returns to replace the broken edge');
  stepTapeCollisions(g, [rectPoly(corners[1].x, corners[1].y, 0.1, 0.1)]);
  assert.deepEqual(t.posts, [true, false, true, true], 'post impact removes the post');
  assert.deepEqual(t.edges, [false, false, true, true], 'post impact removes both attached edges');
  for (let i = 0; i < 120 * 60 && t.broken; i++) update(g, NONE, 1 / 120);
  assert.ok(!t.broken, 'bot replaces the post and both edges');
}

// Travelling to a post is faster than drawing an edge.
{
  const move = (phase) => {
    const g = newGame(1, 0), area = { x: 7, y: 7, w: 2, h: 2, color: 0 };
    flatWorld(g); g.stacks = []; g.zones = []; g.areas = [area];
    const stackAt = fillTapeAreas(g, g.areas);
    g.bot = null; g.inspector = null; g.coneBot = null;
    scanTapeZone(g, g.zones[0], stackAt(g.zones[0]));
    Object.assign(g.fl, { x: 1, y: 1, speed: 0 });
    const key = areaMarkKey(area);
    g.tapes = [{ ...area, key, sig: '', broken: true, posts: [true, false, false, false], edges: [false, false, false, false] }];
    const b = g.tapeBot;
    Object.assign(b, { x: 5, y: 5, a: 0, show: 1, mode: 'out', activity: 'work', scared: false,
      tapeJob: { key, edge: 0, from: 0, to: 1, phase },
      planKey: `${key}:${phase}:${phase === 'start' ? 0 : 1}`, path: [{ x: 6, y: 5 }], repath: 10 });
    stepTapeBot(g, 0.05, g.zones, stackAt, () => false);
    return b.x - 5;
  };
  assert.ok(Math.abs(move('draw') - 0.05) < 1e-8, 'drawing retains its 1 tile/s speed');
  assert.ok(Math.abs(move('start') - 0.1) < 1e-8, 'travelling to a post is twice as fast');
}

// The tape bot also moves at double speed when fleeing and passing through the hatch.
{
  const g = newGame(1, 0), area = { x: 7, y: 7, w: 2, h: 2, color: 0 };
  flatWorld(g); g.stacks = []; g.zones = []; g.areas = [area];
  const stackAt = fillTapeAreas(g, g.areas);
  g.bot = null; g.inspector = null; g.coneBot = null;
  scanTapeZone(g, g.zones[0], stackAt(g.zones[0]));
  const key = areaMarkKey(area);
  g.tapes = [{ ...area, key, sig: '', broken: true, posts: [true, false, false, false], edges: [false, false, false, false] }];
  const b = g.tapeBot;
  Object.assign(g.fl, { x: 2.5, y: 5, a: 0, speed: 1 });
  Object.assign(b, { x: 5, y: 5, a: 0, show: 1, mode: 'out', activity: 'work', scared: true, fleePath: true,
    tapeJob: { key, edge: 0, from: 0, to: 1, phase: 'draw' }, path: [{ x: 7, y: 5 }], repath: 10 });
  stepTapeBot(g, 0.05, g.zones, stackAt, () => false);
  assert.ok(b.scared && Math.abs(b.x - 5.32) < 1e-8, 'fleeing interrupts deployment and runs at 6.4 tiles/s');
  assert.equal(b.tapeJob.phase, 'start');
  Object.assign(g.fl, { x: 1, y: 1, speed: 0 });
  Object.assign(b, { show: 0, leaving: false, mode: 'hidden', path: [] });
  stepTapeBot(g, 0.1, g.zones, stackAt, () => false);
  assert.ok(Math.abs(b.show - 1 / 3) < 1e-8, 'the tape bot emerges in half the usual time');
  g.areas = [];
  Object.assign(b, { show: 0.8, leaving: true, mode: 'out' });
  stepTapeBot(g, 0.1, [], () => null, () => false);
  assert.ok(Math.abs(b.show - (0.8 - 1 / 3)) < 1e-8, 'the tape bot retracts in half the usual time');
}

// Physical footprints, including low tines and boxes, break tape even without crossing its height.
{
  const g = newGame(1, 0);
  flatWorld(g);
  g.zones = []; g.stacks = []; g.tapeBot = null; g.inspector = null; g.coneBot = null;
  const area = { x: 7, y: 7, w: 2, h: 2, color: 0 };
  g.areas = [area];
  const tape = { ...area, key: areaMarkKey(area), sig: '', broken: false, posts: [true, true, true, true], edges: [true, true, true, true] };
  g.tapes = [tape];
  Object.assign(g.fl, { x: 8, y: 6.2, a: Math.PI / 2, speed: 0 });
  update(g, NONE, 1 / 120);
  assert.deepEqual(tape.edges, [false, true, true, true], 'floor-level forklift tines break the edge they touch');
  Object.assign(g.fl, { x: 1, y: 1, a: 0, speed: 0 });
  tape.edges = [true, true, true, true]; tape.broken = false;
  g.stacks = [{ x: 9.3, y: 8, layers: [0], rots: [0], offs: [{ x: 0, y: 0 }], pen: [{ crash: 0, sq: 0 }] }];
  update(g, NONE, 1 / 120);
  assert.deepEqual(tape.edges, [true, false, true, true], 'a box touching the tape breaks its edge');
}

// The bot omits a side when the drop area leaves no clearance against a wall.
{
  const g = newGame(1, 0);
  flatWorld(g);
  const z = { x: 1.1, y: 5, color: 0, count: 1 }, area = { x: 0.41, y: 4.31, w: 1.38, h: 1.38, color: 0 };
  g.zones = [z]; g.areas = [area];
  g.stacks = [{ x: z.x, y: z.y, layers: [0], rots: [0], offs: [{ x: 0, y: 0 }], pen: [{ crash: 0, sq: 0 }] }];
  Object.assign(g.fl, { x: 12, y: 1, a: 0, speed: 0 });
  for (let i = 0; i < 120 * 60 && (!g.tapes[0] || g.tapes[0].broken); i++) update(g, NONE, 1 / 120);
  const tape = g.tapes[0];
  assert.ok(tape && !tape.broken && tape.posts.every(Boolean), 'all posts are placed and accessible sides are taped');
  assert.deepEqual(tape.edges, [true, true, true, false], 'the wall side has no tape');
  assert.equal(tape.wallSides[3], 0);
  assert.ok(Math.abs(tapeCorners(tape)[0].x - 0.08) < 1e-9, 'the wall-side posts are placed against the wall');
  stepTapeCollisions(g, [rectPoly(0.08, tapeCorners(tape)[0].y, 0.1, 0.1)]);
  assert.deepEqual(tape.edges, [false, true, true, false], 'breaking a wall-side post only removes its installed neighbour');
  for (let i = 0; i < 120 * 45 && tape.broken; i++) update(g, NONE, 1 / 120);
  assert.ok(!tape.broken && !tape.edges[3], 'the bot repairs the post without adding tape along the wall');
}

// A corner bordered by two walls still gets its otherwise-unconnected post.
{
  const g = newGame(1, 0);
  flatWorld(g);
  const z = { x: 1.1, y: 1.1, color: 0, count: 1 }, area = { x: 0.41, y: 0.41, w: 1.38, h: 1.38, color: 0 };
  g.zones = [z]; g.areas = [area];
  g.stacks = [{ x: z.x, y: z.y, layers: [0], rots: [0], offs: [{ x: 0, y: 0 }], pen: [{ crash: 0, sq: 0 }] }];
  Object.assign(g.fl, { x: 12, y: 8, a: 0, speed: 0 });
  for (let i = 0; i < 120 * 60 && (!g.tapes[0] || g.tapes[0].broken); i++) update(g, NONE, 1 / 120);
  const tape = g.tapes[0];
  assert.ok(tape && !tape.broken && tape.posts.every(Boolean), 'the standalone corner post is installed');
  assert.deepEqual(tape.edges, [false, true, true, false], 'both wall sides are omitted');
  stepTapeCollisions(g, [rectPoly(0.08, 0.08, 0.05, 0.05)]);
  assert.equal(tape.posts[0], false);
  for (let i = 0; i < 120 * 45 && tape.broken; i++) update(g, NONE, 1 / 120);
  assert.ok(!tape.broken && tape.posts[0], 'the standalone post is replaced without adding tape to either wall');
}

// Interior walls use the same gap rule; an area with enough clearance keeps its tape.
{
  const g = newGame(1, 0);
  g.walls = [{ x: 3, y: 3, w: 1, h: 4 }];
  const tape = { key: 'interior', color: 0, x: 4.41, y: 4, w: 2, h: 2, sig: '', broken: false,
    posts: [true, true, true, true], edges: [true, true, true, true] };
  g.tapes = [tape];
  stepTapeCollisions(g, []);
  assert.equal(tape.wallSides[3], 4);
  assert.equal(tape.edges[3], false);
  assert.ok(Math.abs(tapeCorners(tape)[0].x - 4.08) < 1e-9);
  assert.equal(tape.broken, false, 'a skipped wall side is complete');
  tape.x = 4.55; tape.edges = [true, true, true, true];
  stepTapeCollisions(g, []);
  assert.equal(tape.wallSides[3], null);
  assert.equal(tape.edges[3], true, 'a sufficiently wide gap keeps the tape');
}

// Interrupted tape is discarded and starts again from its post.
{
  const g = newGame(1, 0), area = { x: 7, y: 7, w: 2, h: 2, color: 0 };
  const key = areaMarkKey(area);
  const tape = { ...area, key, sig: '', broken: true, posts: [true, false, false, false], edges: [false, false, false, false] };
  g.tapes = [tape];
  Object.assign(g.tapeBot, { x: 8, y: 6.7, a: 0, show: 1, tapeJob: { key, edge: 0, from: 0, to: 1, phase: 'draw' } });
  assert.ok(trailingTape(g), 'the unfinished tape is visible behind the bot');
  stepTapeCollisions(g, [rectPoly(7.2, 6.7, 0.1, 0.1)]);
  assert.equal(g.tapeBot.tapeJob.phase, 'start');
  assert.equal(trailingTape(g), null, 'the interrupted segment is discarded');
  g.tapeBot.tapeJob = null;
  g.tapes = [{ ...area, key, sig: '', broken: false }];
  stepTapeCollisions(g, []);
  assert.deepEqual(g.tapes[0].posts, [true, true, true, true], 'legacy outlines restore their four posts');
  assert.deepEqual(g.tapes[0].edges, [true, true, true, true], 'legacy intact outlines restore their four segments');
}

// Incomplete areas and inspected problems trigger removal even when tape is broken.
{
  for (const reason of ['missing', 'wonky', 'damaged']) {
    const g = newGame(1, 0), area = { color: 0, x: 7, y: 7, w: 2, h: 2 };
    flatWorld(g); g.areas = [area];
    const stackAt = fillTapeAreas(g, g.areas), z = g.zones[0];
    if (reason === 'missing') g.stacks = [];
    if (reason === 'damaged') g.stacks[0].pen[0].crash = 1;
    g.inspector = null;
    if (reason !== 'missing') scanTapeZone(g, z, stackAt(z), false);
    g.tapes = [{ ...area, key: areaMarkKey(area), sig: 'old', broken: true, posts: [true, true, true, true], edges: [false, true, true, true] }];
    Object.assign(g.fl, { x: 1, y: 1, speed: 0 });
    Object.assign(g.tapeBot, { mode: 'out', show: 1, x: 5, y: 5, a: 0 });
    stepTapeBot(g, 0.05, reason === 'missing' ? [] : [z], stackAt, () => reason === 'wonky');
    assert.equal(g.tapeBot.debugTask, 'removing tape from zone 1', `${reason} starts removal`);
  }
}

// Legacy area jobs do not send the inspector to empty drop points.
{
  const g = newGame(1, 0), b = g.inspector;
  const z = { x: 8, y: 8, color: 0, count: 1 }, area = { color: 0, x: 7, y: 7, w: 2, h: 2 }, key = areaMarkKey(area);
  flatWorld(g); g.zones = [z]; g.areas = [area]; g.stacks = [];
  g.tapes = [{ ...area, key, sig: 'old', broken: false }];
  Object.assign(b, { mode: 'hidden', show: 0, target: '8,8,0', areaJobs: [{ key, sig: 'old', pending: ['8,8,0'] }] });
  stepInspector(g, 0.05, [], () => null, () => false);
  assert.equal(b.mode, 'hidden', 'an empty taped area no longer creates an inspection job');
  assert.equal(b.target, null, 'a legacy area target is discarded');
}

// A nudge keeps tape in place until the inspector confirms whether the stack is still suitable.
{
  for (const reason of ['clean', 'wonky', 'damaged']) {
    const g = newGame(1, 0), area = { color: 0, x: 7, y: 7, w: 2, h: 2 };
    flatWorld(g); g.areas = [area]; g.bot = null; g.coneBot = null;
    const stackAt = fillTapeAreas(g, g.areas), z = g.zones[0], stack = stackAt(z);
    const wonky = () => reason === 'wonky';
    scanTapeZone(g, z, stack);
    Object.assign(g.inspector, { mode: 'out', show: 1, x: 6.5, y: 8, a: 0 });
    Object.assign(g.tapeBot, { mode: 'out', show: 1, x: 4, y: 5, a: 0 });
    Object.assign(g.fl, { x: 1, y: 1, speed: 0 });
    const tape = { ...area, key: areaMarkKey(area), sig: '', broken: true,
      posts: [true, true, true, true], edges: [false, true, true, true] };
    g.tapes = [tape];
    stack.touched = true;
    if (reason === 'damaged') stack.pen[0].crash = 1;
    stepTapeBot(g, 0.05, [z], stackAt, wonky);
    assert.equal(g.tapeBot.debugTask, null, `${reason}: no removal or repair while the scan is stale`);
    assert.deepEqual(tape.posts, [true, true, true, true], 'the existing posts stay up');
    assert.equal(tape.edges[0], false, 'broken tape is not repaired before the scan');
    for (let i = 0; i < 1000 && stack.touched; i++) {
      g.clock += 0.05;
      stepInspector(g, 0.05, [z], stackAt, wonky);
    }
    assert.equal(stack.touched, false, `${reason}: the inspector rescans the stack`);
    stepTapeBot(g, 0.05, [z], stackAt, wonky);
    assert.equal(g.tapeBot.debugTask, reason === 'clean' ? 'taping zone 1' : 'removing tape from zone 1',
      `${reason}: the tape bot follows the new verdict`);
  }
}

// A real horn nudge inside the drop point leaves the existing tape up while inspection is pending.
{
  const g = newGame(1, 0), area = { color: 0, x: 7, y: 7, w: 2, h: 2 };
  flatWorld(g); g.areas = [area]; g.bot = null; g.coneBot = null;
  const stackAt = fillTapeAreas(g, g.areas), z = g.zones[0], stack = stackAt(z);
  scanTapeZone(g, z, stack);
  Object.assign(g.fl, { x: 4.8, y: 8, a: 0, speed: 0 });
  Object.assign(g.tapeBot, { mode: 'out', show: 1, x: 3, y: 5, a: 0 });
  const tape = { ...area, key: areaMarkKey(area), sig: '', broken: false,
    posts: [true, true, true, true], edges: [true, true, true, true] };
  g.tapes = [tape];
  run(g, { horn: true }, 1 / 120);
  assert.ok(stack.touched && zoneDone(g, z), 'the horn nudges the stack without invalidating the drop point');
  assert.deepEqual(tape.posts, [true, true, true, true], 'the tape stays up');
  assert.notEqual(g.tapeBot.debugTask, 'removing tape from zone 1', 'the nudge does not dispatch removal');
}

// Replacing a stack cancels removal and delays repairs until its new inspection.
{
  const g = newGame(1, 0), area = { color: 0, x: 7, y: 7, w: 2, h: 2 };
  flatWorld(g); g.areas = [area]; g.bot = null; g.coneBot = null;
  const stackAt = fillTapeAreas(g, g.areas), z = g.zones[0], stack = stackAt(z);
  scanTapeZone(g, z, stack);
  Object.assign(g.inspector, { mode: 'out', show: 1, x: 6.5, y: 8, a: 0 });
  Object.assign(g.tapeBot, { mode: 'out', show: 1, x: 3, y: 4, a: 0 });
  Object.assign(g.fl, { x: 1, y: 1, speed: 0 });
  const tape = { ...area, key: areaMarkKey(area), sig: '', broken: true,
    posts: [true, true, true, true], edges: [false, true, true, true] };
  g.tapes = [tape]; g.stacks = [];
  stepTapeBot(g, 0.05, [], stackAt, () => false);
  assert.equal(g.tapeBot.debugTask, 'removing tape from zone 1', 'a missing stack dispatches removal');
  g.stacks = [stack]; stack.touched = true;
  for (let i = 0; i < 10; i++) stepTapeBot(g, 0.05, [z], stackAt, () => false);
  assert.equal(g.tapeBot.debugTask, null, 'restoring the stack cancels removal');
  assert.deepEqual(tape.posts, [true, true, true, true], 'no posts are removed');
  assert.equal(tape.edges[0], false, 'repair waits for inspection');
  for (let i = 0; i < 1000 && stack.touched; i++) {
    g.clock += 0.05;
    stepInspector(g, 0.05, [z], stackAt, () => false);
  }
  assert.equal(stack.touched, false, 'the replacement stack is inspected');
  stepTapeBot(g, 0.05, [z], stackAt, () => false);
  assert.equal(g.tapeBot.debugTask, 'taping zone 1', 'a successful inspection permits repair');
}

// A confirmed bad stack is enough to remove tape even if another stack still needs inspection.
{
  const g = newGame(1, 0), area = { color: 0, x: 7, y: 7, w: 4, h: 2 };
  flatWorld(g); g.areas = [area]; g.bot = null; g.coneBot = null;
  g.zones = [{ x: 8, y: 8, color: 0, count: 1 }, { x: 10, y: 8, color: 0, count: 1 }];
  g.stacks = g.zones.map((z) => ({ x: z.x, y: z.y, layers: [0], rots: [0], pen: [{ crash: 0, sq: 0 }] }));
  const stackAt = (z) => g.stacks.find((s) => s.x === z.x && s.y === z.y);
  g.stacks[0].pen[0].crash = 1;
  scanTapeZone(g, g.zones[0], g.stacks[0], false);
  g.stacks[1].touched = true;
  g.tapes = [{ ...area, key: areaMarkKey(area), sig: '', broken: false, posts: [true, true, true, true], edges: [true, true, true, true] }];
  Object.assign(g.fl, { x: 1, y: 1, speed: 0 });
  Object.assign(g.tapeBot, { mode: 'out', show: 1, x: 4, y: 5, a: 0 });
  stepTapeBot(g, 0.05, g.zones, stackAt, () => false);
  assert.equal(g.tapeBot.debugTask, 'removing tape from zone 1', 'a confirmed failure does not wait for other scans');
}

// Installation waits for every current individual scan, without a second area-wide inspection.
{
  const g = newGame(1, 0), b = g.inspector;
  const first = { x: 6, y: 6, color: 0, count: 1 }, second = { x: 9, y: 6, color: 0, count: 1 };
  const area = { color: 0, x: 5, y: 5, w: 5, h: 2 };
  flatWorld(g); g.zones = [first, second]; g.areas = [area];
  g.stacks = g.zones.map((z) => ({ x: z.x, y: z.y, layers: [0], rots: [0], offs: [{ x: 0, y: 0 }], pen: [{ crash: 0, sq: 0 }] }));
  g.tapes = [];
  const stackAt = (z) => g.stacks.find((s) => s.x === z.x && s.y === z.y), wonky = () => false;
  const firstKey = '6,6,0', secondKey = '9,6,0';
  Object.assign(b, { mode: 'out', show: 1, x: 3, y: 6, a: 0, seen: [firstKey], sigs: { [firstKey]: stackSig(g.stacks[0]) } });
  b.photos = { [firstKey]: { ok: true } };
  g.stacks[0].pen[0].inspected = true;
  Object.assign(g.fl, { x: 16, y: 11, a: 0, speed: 0 });
  for (let i = 0; i < 6000 && !g.tapes.length; i++) {
    g.clock += 0.05;
    stepInspector(g, 0.05, g.zones, stackAt, wonky);
    if (!b.seen.includes(secondKey)) assert.equal(g.tapes.length, 0, 'the unscanned stack blocks installation');
    stepTapeBot(g, 0.05, g.zones, stackAt, wonky);
  }
  assert.ok(b.seen.includes(secondKey), 'the inspector scans the remaining stack');
  assert.equal(b.photos[secondKey].n, 1, 'the already scanned stack is not rescanned');
  assert.equal(g.tapes.length, 1, 'the tape bot is dispatched immediately after the final stack scan');
}

// Old scan records cannot approve a touched or changed stack, and unsuitable stacks cannot be taped.
{
  const g = newGame(1, 0), area = { color: 0, x: 7, y: 7, w: 2, h: 2 };
  flatWorld(g); g.areas = [area]; g.tapes = [];
  const stackAt = fillTapeAreas(g, g.areas), z = g.zones[0], stack = g.stacks[0], key = `${z.x},${z.y},${z.color}`;
  Object.assign(g.fl, { x: 1, y: 1, speed: 0 });
  Object.assign(g.inspector, { seen: [key], sigs: { [key]: stackSig(stack) }, photos: { [key]: { ok: true } } });
  const step = (wonky = () => false) => stepTapeBot(g, 0.05, [z], stackAt, wonky);
  delete g.inspector.sigs[key]; step();
  assert.equal(g.tapes.length, 0, 'a legacy scan without a fingerprint needs a fresh scan');
  stepInspector(g, 0.05, [z], stackAt, () => false);
  assert.ok(!g.inspector.seen.includes(key), 'the inspector rechecks an unverifiable legacy scan');
  g.inspector.seen = [key];
  g.inspector.sigs[key] = stackSig(stack);
  delete g.inspector.photos[key]; step();
  assert.equal(g.tapes.length, 0, 'a legacy scan without a verdict cannot approve tape');
  stepInspector(g, 0.05, [z], stackAt, () => false);
  assert.ok(!g.inspector.seen.includes(key), 'the inspector rechecks a scan without a verdict');
  g.inspector.seen = [key];
  g.inspector.photos = { [key]: { ok: true } };
  stack.touched = true; step();
  assert.equal(g.tapes.length, 0, 'a touched stack needs a fresh scan');
  stack.touched = false; stack.rots[0] = 0.2; step();
  assert.equal(g.tapes.length, 0, 'a changed stack needs a fresh scan');
  g.inspector.sigs[key] = stackSig(stack);
  g.inspector.photos[key].ok = false;
  stack.pen[0].crash = 1; step();
  assert.equal(g.tapes.length, 0, 'repairable damage prevents installation');
  stack.pen[0].crash = 0; step(() => true);
  assert.equal(g.tapes.length, 0, 'wonkiness prevents installation');
  g.inspector.photos[key].ok = true;
  step();
  assert.equal(g.tapes.length, 1, 'a current scan and suitable stack allow installation');
  g.tapes = []; g.hard = true;
  step();
  assert.equal(g.tapes.length, 0, 'an old hard-mode scan without placement information is not current');
  g.inspector.photos = { [key]: { ok: true, pens: [{ shift: 0 }] } };
  step();
  assert.equal(g.tapes.length, 1, 'a current hard-mode scan permits installation');
}

console.log('bot tests passed');
