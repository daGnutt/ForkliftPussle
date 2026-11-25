import { theme } from './theme.js';
import { FL, toWorld } from './forklift.js';

// Dark-mode disco: randomly scattered glitter balls plus coloured light spots orbiting it on the floor.
// Everything is a pure function of the game clock; drawn by the GL scene (gl/scene.js).
export const BALL_R = 0.7; // tiles
export const BALL_DROP = 1.2; // ball centre below the ceiling (cabin view)
export const SPOT_R = 2.6;
const SPOTS = 3;

let enabled = true;
export function setDiscoEnabled(on) { enabled = !!on; }
export const discoOn = () => enabled && theme().disco === true;

// Ball positions: randomly scattered (seeded by level and seed, cached per game), about one per 150 tiles, at least 2.
const ballCache = new WeakMap();
export function discoBalls(g) {
  let balls = ballCache.get(g);
  if (balls) return balls;
  let a = (Math.imul(g.level || 1, 2654435761) ^ Math.imul((g.seed || 0) + 1, 40503)) >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = Math.max(2, Math.min(40, Math.round((g.w * g.h) / 150)));
  balls = [];
  for (let i = 0; i < n; i++) balls.push({ x: 1 + rnd() * (g.w - 2), y: 1 + rnd() * (g.h - 2), k: Math.floor(rnd() * 100), hide: false });
  ballCache.set(g, balls);
  return balls;
}

// Light sources: every ball plus one riding on the forklift (no visible ball).
export function discoSources(g) {
  const c = toWorld(g.fl, (FL.front - FL.back) / 2, 0);
  return [...discoBalls(g), { x: c.x, y: c.y, k: 5, hide: true }];
}

export function discoSpots(ball, t) {
  const out = [];
  for (let n = 0; n < SPOTS; n++) {
    const a = t * (0.5 + 0.15 * n) * (n % 2 ? -1 : 1) + (n * 2 * Math.PI) / SPOTS + ball.k;
    const r = 3 + 1.5 * Math.sin(t * 0.7 + n + ball.k);
    out.push({ x: ball.x + Math.cos(a) * r, y: ball.y + Math.sin(a) * r, hue: (t * 60 + n * 120 + ball.k * 30) % 360 });
  }
  return out;
}
