import { hash } from './decals.js';

// Cosmetic box damage. A box's `pen.dent` is `{t, c: [4], s: [4]}` of 0/1 flags marking a crumpled top,
// crumpled corners and crumpled sides; how bad they look follows the box's remaining health (`pen.crash`). Corner i is local vertex i (-,-), (+,-), (+,+), (-,+); side i is
// the edge from corner i to corner i + 1 (its outward normal is up, right, down, left).

export const DENT_FILL = '#2b1d12';
export const DENT_LINE = '#d9b98a';

export function addDent(pen, kind, i = 0) {
  const d = (pen.dent ||= { t: 0, c: [0, 0, 0, 0], s: [0, 0, 0, 0] });
  if (kind === 't') d.t = 1;
  else d[kind][i] = 1;
}

const FULL_DAMAGE = 50; // crash points at which a box is as crumpled as it gets (CRASH_POINTS in game.js)

// Dent flags scaled by the box's damage: a fresh dent is shallow, a nearly wrecked box is crushed.
function severity(pen) {
  const k = Math.min(1, Math.max(0.12, (pen.crash || 0) / FULL_DAMAGE));
  const d = pen.dent;
  return { t: d.t * k, c: d.c.map((v) => v * k), s: d.s.map((v) => v * k) };
}

// Side or corner of a box that faces the local direction (lx, ly).
export function dentIndex(kind, lx, ly) {
  if (kind === 's') return Math.abs(lx) > Math.abs(ly) ? (lx > 0 ? 1 : 3) : ly > 0 ? 2 : 0;
  return lx >= 0 ? (ly >= 0 ? 2 : 1) : ly >= 0 ? 3 : 0;
}

// World direction (dx, dy) to the local frame of a box turned by angle a.
export function toLocalDir(dx, dy, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [dx * c + dy * s, -dx * s + dy * c];
}

const jit = (seed, k) => hash(seed, k, 91) - 0.5;
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

// Jagged blob around (cx, cy) with half sizes rx, ry.
function blob(cx, cy, rx, ry, seed) {
  const pts = [];
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2, r = 0.7 + 0.6 * (jit(seed, k) + 0.5);
    pts.push([cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]);
  }
  return pts;
}

// Crumpled patches on the lid, in box-local tile units (the box spans -0.5..0.5).
export function topShapes(pen, seed = 0) {
  const d = severity(pen), out = [];
  if (d.t > 0) out.push(blob(jit(seed, 50) * 0.2, jit(seed, 51) * 0.2, 0.12 + 0.3 * d.t, 0.12 + 0.3 * d.t, seed));
  d.c.forEach((v, i) => {
    if (v <= 0) return;
    const [sx, sy] = CORNERS[i], l = 0.1 + 0.3 * v;
    const p = [[sx * 0.5, sy * 0.5], [sx * (0.5 - l), sy * 0.5], [sx * (0.5 - l * 0.55), sy * (0.5 - l * 0.45)], [sx * (0.5 - l * 0.3), sy * (0.5 - l * 0.8)], [sx * 0.5, sy * (0.5 - l)]];
    out.push(p.map(([x, y], k) => (k && k < 4 ? [x + jit(seed + i, k) * 0.05, y + jit(seed + i, k + 9) * 0.05] : [x, y])));
  });
  d.s.forEach((v, i) => {
    if (v <= 0) return;
    const dep = 0.05 + 0.13 * v, len = 0.3 + 0.5 * v, n = 6;
    const pts = [];
    for (let k = 0; k <= n; k++) pts.push([-len / 2 + (len * k) / n, 0.5 - dep * (0.4 + 0.6 * (jit(seed + i, k + 20) + 0.5)) * (k === 0 || k === n ? 0 : 1)]);
    pts.push([len / 2, 0.5], [-len / 2, 0.5]);
    // rotate the "bottom edge" strip onto side i (0 = top)
    const rot = [Math.PI, -Math.PI / 2, 0, Math.PI / 2][i], c = Math.cos(rot), s = Math.sin(rot);
    out.push(pts.map(([x, y]) => [x * c - y * s, x * s + y * c]));
  });
  return out;
}

// Patches on side face i, in face coordinates: u = 0..1 along the edge (corner i to corner i + 1), v = 0 (bottom)..1 (top).
export function sideShapes(pen, i, seed = 0) {
  const d = severity(pen), out = [];
  const s = d.s[i];
  if (s > 0) out.push(blob(0.5 + jit(seed, 60) * 0.2, 0.5, 0.1 + 0.25 * s, 0.12 + 0.25 * s, seed + i).map(([u, v]) => [Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v))]));
  for (const [k, u0, dir] of [[i, 0, 1], [(i + 1) % 4, 1, -1]]) {
    const v = d.c[k];
    if (v <= 0) continue;
    const l = 0.1 + 0.3 * v;
    out.push([[u0, 1], [u0 + dir * l, 1], [u0 + dir * l * 0.5, 1 - l * 0.6], [u0 + dir * l * 0.2, 1 - l * 1.1], [u0, 1 - l]]);
  }
  return out;
}
