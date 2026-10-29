import { theme } from '../theme.js';
import { decalsEnabled, wallDecal, wallBase, hash, boxDecalShapes } from '../decals.js';
import { project, pathPoly, toCam, BOX_H, DECAL_MAX_DIST, FAR_DARK, PALLET_COLOR } from './camera.js';

// Face painting: flat colour, distance shading and the decals on walls, boxes and chargers.
// Decal shapes are given in face coordinates: u = 0..1 along the face, v = height in tiles.

const YEL = '#f4c414', RED = '#c62828', WHITE = '#eeeeee', BLACK = '#1a1a1a';

// Fills a polygon given as world points [x, y, z] with `fill`, darkened by `dark`.
function decalPoly(ctx, cam, world, fill, dark) {
  const pts = project(cam, world.map(([x, y, z]) => toCam(cam, x, y, z)));
  if (pts.length < 3) return;
  pathPoly(ctx, pts);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.fillStyle = `rgba(0,0,0,${dark})`;
  ctx.fill();
}

// Shape painter for a face from `a` (u = 0) to `b` (u = 1).
function faceShapes(ctx, cam, a, b, dark) {
  const shape = (uv, fill) => decalPoly(ctx, cam, uv.map(([u, v]) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, v]), fill, dark);
  return {
    shape,
    box: (u0, v0, u1, v1, fill) => shape([[u0, v0], [u1, v0], [u1, v1], [u0, v1]], fill),
    disc: (u, v, r, fill) => shape(circlePts(u, v, r), fill),
    tri: (u, v, r, fill) => shape([[u, v + r], [u + r * 0.95, v - r * 0.55], [u - r * 0.95, v - r * 0.55]], fill),
  };
}

function circlePts(u, v, r, n = 18) {
  return Array.from({ length: n }, (_, i) => [u + Math.cos((i / n) * Math.PI * 2) * r, v + Math.sin((i / n) * Math.PI * 2) * r]);
}

// 3×5 pixel font (rows top to bottom) for the slogan posters.
const FONT = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', '!': '010010010000010', '-': '000000111000000',
};

const SLOGANS = [
  { bg: '#1565c0', fg: WHITE, lines: ['FORKLIFT', 'FRENZY IS', 'GREAT!'] },
  { bg: '#2e7d32', fg: WHITE, lines: ['BEST JOB', 'EVER!'] },
  { bg: YEL, fg: BLACK, lines: ['SAFETY', 'FIRST'] },
  { bg: '#6a1b9a', fg: WHITE, lines: ['WE LOVE', 'FORKLIFT', 'FRENZY'] },
  { bg: RED, fg: WHITE, lines: ['NO BOX', 'LEFT', 'BEHIND'] },
  { bg: '#ef6c00', fg: BLACK, lines: ['STACK IT', 'LIKE YOU', 'MEAN IT'] },
  { bg: '#00695c', fg: WHITE, lines: ['WORK', 'HARD', 'LIFT HIGH'] },
  { bg: '#263238', fg: YEL, lines: ['HAPPY', 'FORKS', 'HAPPY LIFE'] },
];

function poster({ box }, s) {
  const { bg, fg, lines } = SLOGANS[s % SLOGANS.length];
  const cols = Math.max(...lines.map((l) => l.length)) * 4 - 1;
  const px = Math.min(0.045, 0.74 / cols);
  const h = lines.length * 6 * px + 0.1;
  const top = 1.8 + h / 2;
  box(0.1, top - h, 0.9, top, '#2b2e33');
  box(0.12, top - h + 0.02, 0.88, top - 0.02, bg);
  lines.forEach((line, li) => {
    const x0 = 0.5 - (line.length * 4 - 1) * px / 2;
    const y0 = top - 0.07 - li * 6 * px;
    [...line].forEach((ch, ci) => {
      const bits = FONT[ch];
      if (!bits) return;
      for (let i = 0; i < 15; i++) {
        if (bits[i] !== '1') continue;
        const u = x0 + (ci * 4 + (i % 3)) * px, v = y0 - Math.floor(i / 3) * px;
        box(u, v - px, u + px, v, fg);
      }
    });
  });
}

// Pictogram person: head, body and (for a woman) a skirt, standing on v0 with u as centre.
function person({ box, disc, shape }, u, v0, fill, skirt) {
  disc(u, v0 + 0.36, 0.045, fill);
  if (skirt) shape([[u - 0.02, v0 + 0.3], [u + 0.02, v0 + 0.3], [u + 0.07, v0 + 0.12], [u - 0.07, v0 + 0.12]], fill);
  else box(u - 0.05, v0 + 0.14, u + 0.05, v0 + 0.3, fill);
  box(u - 0.035, v0, u - 0.005, v0 + 0.14, fill);
  box(u + 0.005, v0, u + 0.035, v0 + 0.14, fill);
}

function toiletDoor(p, woman) {
  const { box } = p;
  box(0.14, 0, 0.86, 1.7, '#7e8a82');
  box(0.19, 0, 0.81, 1.64, woman ? '#9c5a7a' : '#4f6f93');
  box(0.68, 0.7, 0.76, 0.78, '#c9ccd1');
  box(0.3, 1.0, 0.7, 1.5, '#1565c0');
  box(0.32, 1.02, 0.68, 1.48, '#1e88e5');
  person(p, 0.5, 1.07, WHITE, woman);
}

function deerSign({ box, shape, tri }) {
  shape([[0.5, 2.1], [0.9, 1.7], [0.5, 1.3], [0.1, 1.7]], BLACK);
  shape([[0.5, 2.05], [0.85, 1.7], [0.5, 1.35], [0.15, 1.7]], YEL);
  box(0.36, 1.62, 0.6, 1.72, BLACK); // body
  box(0.38, 1.5, 0.41, 1.62, BLACK);
  box(0.43, 1.5, 0.46, 1.62, BLACK);
  box(0.52, 1.5, 0.55, 1.62, BLACK);
  box(0.57, 1.5, 0.6, 1.62, BLACK);
  shape([[0.55, 1.7], [0.6, 1.7], [0.68, 1.86], [0.62, 1.88]], BLACK); // neck
  shape([[0.6, 1.84], [0.72, 1.84], [0.74, 1.8], [0.62, 1.78]], BLACK); // head
  shape([[0.6, 1.88], [0.57, 1.97], [0.59, 1.97], [0.63, 1.9]], BLACK); // antlers
  shape([[0.66, 1.86], [0.7, 1.97], [0.72, 1.96], [0.69, 1.86]], BLACK);
  box(0.34, 1.68, 0.37, 1.74, BLACK); // tail
}

// Green cross box.
function firstAid({ box }) {
  box(0.2, 1.4, 0.8, 2.0, '#2e7d32');
  box(0.24, 1.44, 0.76, 1.96, WHITE);
  box(0.44, 1.5, 0.56, 1.9, '#2e7d32');
  box(0.34, 1.64, 0.66, 1.76, '#2e7d32');
}

function stairsSign({ box, shape }) {
  box(0.2, 1.4, 0.8, 2.0, '#2e7d32');
  shape([[0.28, 1.48], [0.28, 1.58], [0.4, 1.58], [0.4, 1.7], [0.52, 1.7], [0.52, 1.82], [0.64, 1.82], [0.64, 1.94], [0.72, 1.94], [0.72, 1.48]], WHITE);
}

// Wall-mounted air conditioner: casing, slatted grille, fan and a pipe going up to the ceiling.
function acUnit({ box, disc }) {
  box(0.46, 2.62, 0.54, 3.2, '#9aa1a8');
  box(0.1, 2.0, 0.9, 2.62, '#c9ccd1');
  box(0.1, 2.54, 0.9, 2.62, '#aeb3b9');
  box(0.14, 2.06, 0.86, 2.5, '#8d949c');
  disc(0.5, 2.28, 0.19, '#2b2e33');
  disc(0.5, 2.28, 0.14, '#555b62');
  box(0.485, 2.12, 0.515, 2.44, '#2b2e33');
  box(0.34, 2.265, 0.66, 2.295, '#2b2e33');
  disc(0.5, 2.28, 0.03, '#c9ccd1');
  for (let i = 0; i < 4; i++) box(0.16, 2.1 + i * 0.03, 0.84, 2.115 + i * 0.03, '#7a8087');
  box(0.78, 2.1, 0.84, 2.14, '#43a047');
}

// A roller door spans two segments around the junction `key`; skip it unless the whole width is free wall face
// (no perpendicular wall abutting the face within the span).
function doorFits(g, key, q0, q1) {
  const L = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]);
  const dx = (q1[0] - q0[0]) / L, dy = (q1[1] - q0[1]) / L;
  const nx = dy, ny = -dx;
  for (let t = -1.9; t <= 1.9; t += 0.2) {
    const x = key[0] + dx * L * t + nx * 0.1, y = key[1] + dy * L * t + ny * 0.1;
    if (g.walls.some((w) => x > w.x && x < w.x + w.w && y > w.y && y < w.y + w.h)) return false;
  }
  return true;
}

function rollerDoor({ box, shape }, off) {
  const slab = (x0, v0, x1, v1, fill) => {
    const a = Math.max(0, x0 - off), b = Math.min(1, x1 - off);
    if (b > a) box(a, v0, b, v1, fill);
  };
  slab(0.06, 0, 1.94, 2.7, YEL);
  slab(0.14, 0, 1.86, 2.6, '#8a9199');
  for (let v = 0.12; v < 2.5; v += 0.13) slab(0.14, v, 1.86, v + 0.025, '#5f656c');
  slab(0.14, 2.35, 1.86, 2.6, '#6d737a');
  slab(0.14, 0, 1.86, 0.1, BLACK);
  for (let i = 0; i < 7; i++) slab(0.14 + i * 0.246, 0, 0.14 + i * 0.246 + 0.123, 0.1, YEL);
  slab(0.14, 2.6, 1.86, 2.7, '#3a3f45');
  slab(0.85, 0.22, 1.15, 0.28, '#c9ccd1');
}

// Signs are hung around the eye height of a person: the cabin eye with the forks at level 1 (0.95 + 0.55·0.6).
const SIGN_DROP = 0.3;
const FIXED_SIGNS = new Set(['door', 'exit', 'ac', 'toiletM', 'toiletW']); // anchored to the floor / above the door

function dropped({ shape }, dv) {
  const sh = (uv, fill) => shape(uv.map(([u, v]) => [u, v - dv]), fill);
  return {
    shape: sh,
    box: (u0, v0, u1, v1, fill) => sh([[u0, v0], [u1, v0], [u1, v1], [u0, v1]], fill),
    disc: (u, v, r, fill) => sh(circlePts(u, v, r), fill),
    tri: (u, v, r, fill) => sh([[u, v + r], [u + r * 0.95, v - r * 0.55], [u - r * 0.95, v - r * 0.55]], fill),
  };
}

const WALL_SIGNS = {
  ac: acUnit,
  toiletM: (p) => toiletDoor(p, false),
  toiletW: (p) => toiletDoor(p, true),
  deer: deerSign,
  firstaid: firstAid,
  stairs: stairsSign,
  window({ box, shape }) {
    box(0.12, 1.22, 0.88, 2.38, '#2b2e33');
    box(0.17, 1.27, 0.83, 2.33, theme().skyBottom);
    shape([[0.17, 1.27], [0.4, 1.27], [0.63, 2.33], [0.4, 2.33]], 'rgba(255,255,255,0.25)');
    box(0.485, 1.27, 0.515, 2.33, '#2b2e33');
    box(0.17, 1.78, 0.83, 1.82, '#2b2e33');
    box(0.1, 1.2, 0.9, 1.24, '#8d949c');
  },
  door({ box }) {
    box(0.14, 0, 0.86, 1.7, YEL);
    box(0.19, 0, 0.81, 1.64, '#4d6b5b');
    box(0.34, 1.05, 0.66, 1.45, '#1f2a30');
    box(0.36, 1.07, 0.64, 1.43, theme().skyBottom);
    box(0.68, 0.7, 0.76, 0.78, '#c9ccd1');
    box(0.22, 0.6, 0.78, 0.63, '#7e8a82');
    box(0.38, 1.7, 0.62, 1.88, '#2e7d32');
    box(0.41, 1.72, 0.59, 1.86, WHITE);
  },
  nosmoking({ box, disc, shape }) {
    disc(0.5, 1.75, 0.3, RED);
    disc(0.5, 1.75, 0.23, WHITE);
    box(0.3, 1.72, 0.6, 1.78, '#d8b27a');
    box(0.6, 1.72, 0.69, 1.78, '#e56a1d');
    shape([[0.3, 1.52], [0.35, 1.47], [0.7, 1.98], [0.65, 2.03]], RED);
  },
  exit({ box, disc, shape }) {
    box(0.18, 1.7, 0.82, 2.0, '#1b5e20');
    box(0.2, 1.72, 0.8, 1.98, '#2e7d32');
    shape([[0.28, 1.82], [0.5, 1.82], [0.5, 1.77], [0.7, 1.85], [0.5, 1.93], [0.5, 1.88], [0.28, 1.88]], WHITE);
    disc(0.34, 1.91, 0.04, WHITE);
  },
  extinguisher({ box }) {
    box(0.3, 1.45, 0.7, 1.95, RED);
    box(0.47, 1.52, 0.53, 1.88, WHITE);
    box(0.34, 1.64, 0.66, 1.7, WHITE);
    box(0.4, 0.55, 0.6, 1.25, '#b71c1c');
    box(0.45, 1.25, 0.55, 1.32, BLACK);
    box(0.55, 1.18, 0.65, 1.24, BLACK);
  },
  hazard({ box, disc, tri }) {
    tri(0.5, 1.8, 0.4, BLACK);
    tri(0.5, 1.8, 0.34, YEL);
    box(0.475, 1.74, 0.525, 1.98, BLACK);
    disc(0.5, 1.64, 0.03, BLACK);
  },
  electric({ shape, tri }) {
    tri(0.5, 1.8, 0.4, BLACK);
    tri(0.5, 1.8, 0.34, YEL);
    shape([[0.54, 1.98], [0.42, 1.74], [0.5, 1.74], [0.46, 1.58], [0.6, 1.8], [0.52, 1.8]], BLACK);
  },
  forklift({ box, disc, shape }) {
    box(0.2, 1.4, 0.8, 2.0, '#1565c0');
    box(0.27, 1.5, 0.5, 1.75, WHITE);
    box(0.5, 1.5, 0.55, 1.95, WHITE);
    box(0.55, 1.5, 0.72, 1.55, WHITE);
    disc(0.34, 1.47, 0.04, WHITE);
    disc(0.46, 1.47, 0.04, WHITE);
    shape([[0.2, 2.0], [0.8, 1.4], [0.8, 1.45], [0.25, 2.0]], RED);
  },
  ppe({ box, disc, shape }) {
    disc(0.5, 1.75, 0.3, '#1565c0');
    shape(circlePts(0.5, 1.72, 0.17).filter(([, v]) => v >= 1.72).concat([[0.33, 1.72]]), WHITE);
    box(0.3, 1.66, 0.7, 1.72, WHITE);
  },
  speed({ box, disc }) {
    disc(0.5, 1.75, 0.3, RED);
    disc(0.5, 1.75, 0.23, WHITE);
    box(0.42, 1.88, 0.58, 1.91, BLACK);
    box(0.42, 1.75, 0.45, 1.9, BLACK);
    box(0.42, 1.73, 0.58, 1.76, BLACK);
    box(0.55, 1.6, 0.58, 1.75, BLACK);
    box(0.42, 1.58, 0.58, 1.61, BLACK);
  },
  fire({ box, disc }) {
    box(0.22, 1.2, 0.78, 1.9, RED);
    disc(0.5, 1.55, 0.2, WHITE);
    disc(0.5, 1.55, 0.14, '#8e1b1b');
    disc(0.5, 1.55, 0.05, WHITE);
    box(0.3, 1.78, 0.7, 1.84, WHITE);
  },
};

function drawWallDecals(ctx, cam, g, f, dark) {
  const [q0, q1] = f.side;
  const len = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]);
  if (!decalsEnabled() || len < 0.9 || f.d > DECAL_MAX_DIST) return;
  // Seen from outside, u = 0 is on the left, which is the segment's end point q1.
  const p = faceShapes(ctx, cam, q1, q0, dark);

  // Two-segment roller door: the pair (k even, k + 1) shares the point where the segments meet.
  if (f.n > 1 && (f.k & 1 ? true : f.k + 1 < f.n)) {
    const key = f.k & 1 ? q0 : q1;
    if (hash(key[0], key[1], 34) < 0.1 && doorFits(g, key, q0, q1)) {
      rollerDoor(p, f.k & 1 ? 0 : 1); // visually the later segment is the left half
      return;
    }
  }

  const base = wallBase(f.mx, f.my);
  if (base === 1) p.box(0, 0, 1, 0.12, YEL);
  else if (base === 2) {
    for (let i = 0; i < 8; i++) {
      const a = i * 0.125;
      p.shape([[a, 0], [a + 0.0625 + 0.05, 0], [a + 0.0625 + 0.15, 0.2], [a + 0.1, 0.2]], i & 1 ? BLACK : YEL);
    }
  }
  const kind = wallDecal(f.mx, f.my);
  if (kind === 'poster') {
    poster(dropped(p, SIGN_DROP), Math.floor(hash(f.mx, f.my, 35) * SLOGANS.length));
    return;
  }
  WALL_SIGNS[kind]?.(FIXED_SIGNS.has(kind) ? p : dropped(p, SIGN_DROP));
}

function drawBoxDecal(ctx, cam, f, dark) {
  const [q0, q1, z0] = f.side;
  for (const d of boxDecalShapes(f.deco)) {
    decalPoly(ctx, cam, d.pts.map(([u, v]) => {
      const U = 0.5 - u * 0.45;
      return [q0[0] + (q1[0] - q0[0]) * U, q0[1] + (q1[1] - q0[1]) * U, z0 + BOX_H / 2 + v * 0.45];
    }), d.fill, dark);
  }
}

// High-voltage warning on a charger side: hazard stripes along the base and a bolt in a yellow triangle.
function drawChargerDecal(ctx, cam, f, dark) {
  const [q0, q1] = f.side;
  const { shape } = faceShapes(ctx, cam, q0, q1, dark);
  shape([[0, 0], [1, 0], [1, 0.1], [0, 0.1]], YEL);
  for (let i = 0; i < 4; i++) {
    const a = i * 0.25;
    shape([[a, 0], [a + 0.125, 0], [a + 0.2, 0.1], [a + 0.075, 0.1]], BLACK);
  }
  shape([[0.5, 0.82], [0.92, 0.2], [0.08, 0.2]], BLACK);
  shape([[0.5, 0.74], [0.84, 0.24], [0.16, 0.24]], YEL);
  shape([[0.55, 0.66], [0.38, 0.45], [0.5, 0.45], [0.44, 0.3], [0.64, 0.52], [0.52, 0.52]], BLACK);
}

export function drawFace(ctx, cam, g, f) {
  const pts = project(cam, f.quad.map(([x, y, z]) => toCam(cam, x, y, z)));
  if (pts.length < 3) return;
  const dark = Math.min(0.75, f.d / FAR_DARK) + (1 - f.shade) * 0.6;
  pathPoly(ctx, pts);
  if (f.glow) {
    ctx.fillStyle = f.color;
    ctx.fill();
    ctx.fillStyle = `rgba(0,0,0,${Math.min(0.35, f.d / FAR_DARK * 0.35)})`;
    ctx.fill();
    return;
  }
  ctx.fillStyle = f.color || ((f.tile ?? 0) & 1 ? '#5d646e' : '#555b64');
  ctx.fill();
  ctx.fillStyle = `rgba(0,0,0,${Math.max(0, dark)})`;
  ctx.fill();
  if (f.lit) { ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fill(); }
  const d = Math.max(0, dark);
  if (f.charger && f.side) drawChargerDecal(ctx, cam, f, d);
  if (f.deco && f.d < DECAL_MAX_DIST) drawBoxDecal(ctx, cam, f, d);
  if (f.tile != null && f.side) drawWallDecals(ctx, cam, g, f, d);
  if (f.color && f.color !== PALLET_COLOR) {
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
