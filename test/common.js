// Shared helpers for the category test files.
import { FL } from '../js/forklift.js';
import { update, maxScore, lostBreakdown } from '../js/game.js';

export const NONE = {};
export const pts = (g) => maxScore(g) - lostBreakdown(g).crash - lostBreakdown(g).square;
export const run = (g, inp, secs) => { for (let i = 0; i < secs * 120; i++) update(g, inp, 1 / 120); };
// Turn the forklift to ang and place it so the stack at (10, 5) sits on the forks.
export const faceStack = (g, ang) => {
  g.stacks[0].x = 10; g.stacks[0].y = 5;
  g.fl.a = ang;
  g.fl.x = 10 - FL.carryX * Math.cos(ang);
  g.fl.y = 5 - FL.carryX * Math.sin(ang);
};
export const flatWorld = (g) => { g.zones = []; g.walls = g.walls.slice(0, 4); };
export const driveUntil = (g, x, brakeAt) => {
  const f = g.fl;
  while (f.x + FL.carryX < x) update(g, { up: f.speed <= 1 || f.x <= brakeAt, down: f.speed > 1 && f.x > brakeAt }, 1 / 120);
  while (f.speed > 0.05) update(g, { down: true }, 1 / 120);
  run(g, {}, 0.5);
};

