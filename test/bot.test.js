import assert from 'node:assert/strict';
import { newGame, update } from '../js/game.js';
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

assert.ok(!newGame(1, 0).hatch && !newGame(1, 0).bot, 'levels without barrels have no bot');
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
  g.fl.x = g.bot.x - 2; g.fl.y = g.bot.y; g.fl.a = 0;
  run(g, NONE, 0.2);
  assert.ok(g.bot.scared && !g.bot.cleaning, 'a close forklift scares the bot off the spill');
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

console.log('bot tests passed');
