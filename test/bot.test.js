import assert from 'node:assert/strict';
import { newGame, update, zoneDone, zoneWonky, flaggedStacks } from '../js/game.js';
import { BOT_R, CLEAN_SECS, truckGap } from '../js/bot.js';
import { serializeGame, deserializeGame } from '../js/savestate.js';
import { run, NONE } from './common.js';

const hasBarrel = (g) => g.stacks.some((s) => s.layers.includes(6));
const botGame = () => {
  const g = newGame(4, 0);
  assert.ok(hasBarrel(g) && g.hatch && g.bot, 'barrel levels get a hatch and a hidden bot');
  assert.equal(g.bot.show, 0);
  return g;
};
const mid = (g) => ({ x: g.w / 2, y: g.h / 2 });
const clearOf = (g, p) => { g.fl.x = p.x < g.w / 2 ? g.w - 1 : 1; g.fl.y = p.y < g.h / 2 ? g.h - 1 : 1; };

assert.ok(newGame(1, 0).hatch && !newGame(1, 0).bot && newGame(1, 0).inspector, 'levels without barrels have no cleaning bot, but an inspector');
assert.deepEqual(newGame(4, 0).hatch, newGame(4, 0).hatch, 'the hatch is deterministic');

// The bot stays hidden while there is no oil.
{
  const g = botGame();
  run(g, NONE, 2);
  assert.equal(g.bot.show, 0);
}

// It drives out, mops one drop in about CLEAN_SECS and goes home.
{
  const g = botGame();
  const spot = mid(g);
  g.stacks = [];
  clearOf(g, g.hatch);
  g.oil = [{ id: 't', x: spot.x, y: spot.y, r: 0.163, drops: 1 }];
  let seen = 0, cleanStart = null, t = 0;
  while (g.oil.length && t < 60) {
    update(g, NONE, 1 / 120); t += 1 / 120;
    if (g.bot.show > 0) seen++;
    if (g.bot.cleaning && cleanStart === null) cleanStart = t;
  }
  assert.ok(seen > 0 && !g.oil.length, 'the bot emerged and removed the spill');
  assert.ok(Math.abs(t - cleanStart - CLEAN_SECS) < 0.3, `one drop takes ~${CLEAN_SECS}s of cleaning (${(t - cleanStart).toFixed(2)})`);
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

// The inspector photographs each completed drop point once, in turn, then returns to the hatch.
{
  const g = newGame(1, 0);
  g.stacks = [];
  const zs = g.zones.slice(0, 2);
  assert.equal(zs.length, 2);
  run(g, NONE, 2);
  assert.equal(g.inspector.show, 0, 'nothing is inspected while no drop point is done');
  g.stacks = zs.map((z) => ({ x: z.x, y: z.y, layers: Array(z.count).fill(z.color), pen: [], rots: [] }));
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
      const dv = Math.atan2(Math.sin(2 * (g.photo.view - (g.photo.rots[0] ?? 0) - Math.PI / 4)), Math.cos(2 * (g.photo.view - (g.photo.rots[0] ?? 0) - Math.PI / 4))) / 2;
      assert.ok(Math.abs(dv) < 0.5, 'photographed from a corner, so two sides of the stack show');
    }
    prev = g.inspector.flash;
  }
  assert.equal(g.inspector.seen.length, done.length, 'all completed drop points were photographed');
  assert.equal(flashes, done.length, 'one photo each');
  assert.ok(g.photo && g.photo.n === done.length && typeof g.photo.ok === 'boolean' && g.photo.layers.length > 0, 'each photo leaves a snapshot for the popup');
  assert.equal(flaggedStacks(g).length, done.filter((z) => zoneWonky(g, z)).length, 'every inspected crooked stack is flagged with a "!"');
  if (g.stacks.length) { // touching a photographed stack clears its flag and sends the inspector back
    const st = g.stacks[0];
    st.rots[0] += 0.2;
    update(g, NONE, 1 / 120);
    assert.ok(g.inspector.seen.length < done.length, 'a nudged stack is inspected again');
    assert.ok(!flaggedStacks(g).some((f) => f.x === st.x && f.y === st.y), 'its warning sign is gone');
  }
  assert.ok(g.inspector.roll !== 0, 'the wheels turned while driving');
  assert.ok(g.hits.length === 0 || g.hits.every((h) => h.check === 'perfect' || h.check === 'warn'), 'verdict labels');
  run(g, NONE, 60);
  assert.equal(g.inspector.mode, 'hidden', 'it goes back into the hatch');
  const g3 = newGame(1, 0);
  g3.inspector.seen = ['1,2,0'];
  assert.deepEqual(deserializeGame(JSON.parse(JSON.stringify(serializeGame(g3)))).inspector.seen, ['1,2,0'], 'the inspector is saved');
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

console.log('bot tests passed');
