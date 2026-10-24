// Factory fluff: deterministic decals (tire marks, oil stains, yellow floor markings, wall signs).
// Pure data, no drawing, so both renderers share it. Purely cosmetic; never touches game state.

const CELL = 4; // floor decals live in CELL×CELL tile cells

// Cheap deterministic hash -> [0, 1).
// Global on/off switch for all decals (menu option); drawing code checks it.
let decalsOn = true;
export function decalsEnabled() { return decalsOn; }
export function setDecalsEnabled(on) { decalsOn = !!on; }

export function hash(a, b, salt = 0) {
  let h = Math.imul(Math.floor(a * 7) + 1013, 374761393) ^ Math.imul(Math.floor(b * 7) + 7919, 668265263) ^ Math.imul(salt + 17, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Thick polyline as a list of quads.
function strip(pts, w, fill) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = (-(by - ay) / len) * w / 2, ny = ((bx - ax) / len) * w / 2;
    out.push({ pts: [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]], fill });
  }
  return out;
}

function rect(x, y, w, h, fill) {
  return { pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], fill };
}

const YELLOW = 'rgba(244,196,20,0.6)';
const RUBBER = 'rgba(15,15,15,0.22)';

// Random filler per cell (oil stains, dashed lines, hazard patches).
function cellDecals(cx, cy) {
  const r = hash(cx, cy, 1), out = [];
  const ox = cx * CELL + 0.5 + hash(cx, cy, 2) * (CELL - 1), oy = cy * CELL + 0.5 + hash(cx, cy, 3) * (CELL - 1);
  if (r < 0.2) { // oil stain
    const rx = 0.35 + hash(cx, cy, 6) * 0.4, ry = 0.25 + hash(cx, cy, 7) * 0.35;
    const pts = [];
    for (let i = 0; i < 14; i++) {
      const t = (i / 14) * Math.PI * 2, k = 0.85 + hash(cx, cy, 20 + i) * 0.3;
      pts.push([ox + Math.cos(t) * rx * k, oy + Math.sin(t) * ry * k]);
    }
    out.push({ pts, fill: 'rgba(10,10,15,0.22)' });
  } else if (r < 0.38) { // dashed yellow lane line
    const horiz = hash(cx, cy, 8) < 0.5;
    for (let i = 0; i < 4; i++) {
      out.push(horiz ? rect(cx * CELL + i, oy, 0.6, 0.14, YELLOW) : rect(ox, cy * CELL + i, 0.14, 0.6, YELLOW));
    }
  } else if (r < 0.5) { // yellow/black hazard stripe patch
    const horiz = hash(cx, cy, 9) < 0.5, n = 8;
    for (let i = 0; i < n; i++) {
      const s = i * 0.25;
      out.push(horiz ? rect(ox + s, oy, 0.25, 0.5, i & 1 ? 'rgba(20,20,20,0.5)' : YELLOW)
        : rect(ox, oy + s, 0.5, 0.25, i & 1 ? 'rgba(20,20,20,0.5)' : YELLOW));
    }
  }
  return out;
}

// Pair of tire tracks: from (x, y) heading a, straight s1, a turn of `turn` radians with radius r, straight s2.
function tracks(x, y, a, s1, turn, r, s2) {
  const out = [];
  for (const side of [-0.28, 0.28]) {
    const pts = [];
    let px = x, py = y, pa = a;
    const push = () => pts.push([px - Math.sin(pa) * side, py + Math.cos(pa) * side]);
    const step = (len, dTurn) => {
      const n = Math.max(1, Math.ceil(len / 0.3));
      for (let i = 0; i < n; i++) {
        push();
        pa += dTurn / n;
        px += Math.cos(pa) * (len / n);
        py += Math.sin(pa) * (len / n);
      }
    };
    step(s1, 0);
    step(Math.abs(turn) * r, turn);
    step(s2, 0);
    push();
    out.push(pts);
  }
  return out;
}

const bboxHit = (x0, y0, x1, y1, r, m) => x1 > r.x - m && x0 < r.x + r.w + m && y1 > r.y - m && y0 < r.y + r.h + m;
const ptsBox = (pts) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];

const cache = new WeakMap();

// All floor decals of a level, computed once per game state. Tire tracks follow natural turns (into drop-offs and the
// parking spot, round the ends of dividing walls); yellow squares sit around the drop-offs without touching them.
// Everything is kept clear of walls and inside the level (0,0,w,h).
export function floorDecals(g) {
  if (cache.has(g)) return cache.get(g);
  const out = [];
  const walls = g.pillars || [];
  const inside = (pts, m = 0.05) => pts.every(([x, y]) => x >= m && y >= m && x <= g.w - m && y <= g.h - m);
  const clearOfWalls = (pts, m) => { const [a, b, c, d] = ptsBox(pts); return !walls.some((r) => bboxHit(a, b, c, d, r, m)); };
  const trackOk = (list) => list.every((pts) => inside(pts) && pts.every(([x, y]) => !walls.some((r) => bboxHit(x, y, x, y, r, 0.45))));
  const addTracks = (list) => { if (trackOk(list)) for (const pts of list) out.push(...strip(pts, 0.16, RUBBER)); };

  // Random filler: not on the drop-offs or parking spot.
  const zoneBoxes = g.zones.map((z) => ({ x: z.x - 0.6, y: z.y - 0.6, w: 1.2, h: 1.2 }));
  const pk = g.parking, pr = { x: pk.x - 1.8, y: pk.y - 1.8, w: 3.6, h: 3.6 };
  const keepClear = [...zoneBoxes, pr, ...g.areas.map((a) => ({ x: a.x - 0.3, y: a.y - 0.3, w: a.w + 0.6, h: a.h + 0.6 }))];
  const free = (pts, m) => { const [a, b, c, d] = ptsBox(pts); return !keepClear.some((r) => bboxHit(a, b, c, d, r, m)); };
  for (let cx = 0; cx <= Math.floor(g.w / CELL); cx++) {
    for (let cy = 0; cy <= Math.floor(g.h / CELL); cy++) {
      for (const d of cellDecals(cx, cy)) if (inside(d.pts) && free(d.pts, 0.15) && clearOfWalls(d.pts, 0.1)) out.push(d);
    }
  }

  // Tracks swinging into each drop-off and the parking spot.
  const targets = [...g.zones.map((z) => [z.x, z.y]), [pk.x, pk.y]];
  targets.forEach(([tx, ty], n) => {
    for (let k = 0; k < 4; k++) {
      if (hash(tx, ty, 60 + k) > 0.35) continue;
      const turn = (hash(tx, ty, 70 + k) < 0.5 ? 1 : -1) * (Math.PI / 2);
      addTracks(tracks(tx, ty, (k * Math.PI) / 2, 0.9, turn, 1.6 + hash(tx, ty, 80 + k) * 0.8, 2 + hash(tx, ty, 90 + k) * 1.5));
    }
  });

  // Tracks rounding the ends of dividing walls: along one side, a quarter turn about the corner, away along the end.
  const M = 1.4, L = 1.6;
  for (const w of walls) {
    [[w.x, w.y, -1, -1], [w.x + w.w, w.y, 1, -1], [w.x, w.y + w.h, -1, 1], [w.x + w.w, w.y + w.h, 1, 1]].forEach(([cx, cy, sx, sy], i) => {
      if (hash(cx, cy, 40 + i) > 0.5) return;
      const alongY = hash(cx, cy, 50 + i) < 0.5;
      const [x, y, a] = alongY ? [cx + sx * M, cy - sy * L, sy * Math.PI / 2] : [cx - sx * L, cy + sy * M, sx > 0 ? 0 : Math.PI];
      // pick the turn direction whose arc centre is the corner
      const bx = x + Math.cos(a) * L, by = y + Math.sin(a) * L; // where the arc starts
      const t = [1, -1].map((d) => [d, Math.hypot(bx - d * Math.sin(a) * M - cx, by + d * Math.cos(a) * M - cy)])
        .sort((p, q) => p[1] - q[1])[0][0];
      addTracks(tracks(x, y, a, L, t * (Math.PI / 2), M, L));
    });
  }

  // Yellow bays: one outline around each whole drop-off area, plus a few unused empty bays elsewhere.
  const outline = (x, y, w, h) => out.push(...strip([[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y - 0.045]], 0.09, YELLOW));
  const bays = [];
  for (const a of g.areas) {
    const b = { x: a.x - 0.3, y: a.y - 0.3, w: a.w + 0.6, h: a.h + 0.6 };
    bays.push(b);
    if (inside([[b.x, b.y], [b.x + b.w, b.y + b.h]], 0.1)) outline(b.x, b.y, b.w, b.h);
  }
  const hit = (b, r, m) => bboxHit(b.x, b.y, b.x + b.w, b.y + b.h, r, m);
  const spare = Math.max(1, Math.round((g.w * g.h) / 90));
  for (let t = 0, made = 0; t < 60 && made < spare; t++) {
    const w = 2 + Math.floor(hash(g.w, t, 110) * 3), h = 1 + Math.floor(hash(g.h, t, 111) * 3);
    const b = { x: 1 + Math.floor(hash(t, g.h, 112) * (g.w - w - 2)), y: 1 + Math.floor(hash(t, g.w, 113) * (g.h - h - 2)), w, h };
    const pts = [[b.x, b.y], [b.x + w, b.y + h]];
    if (!inside(pts, 0.5) || !clearOfWalls(pts, 0.8) || hit(b, pr, 0.3)) continue;
    if (bays.some((o) => hit(b, o, 0.6)) || g.zones.some((z) => hit(b, { x: z.x - 0.6, y: z.y - 0.6, w: 1.2, h: 1.2 }, 0.6))) continue;
    bays.push(b);
    outline(b.x, b.y, b.w, b.h);
    made++;
  }

  cache.set(g, out);
  return out;
}

const WALL_KINDS = ['window', 'window', 'door', 'nosmoking', 'exit', 'extinguisher', 'hazard', 'forklift', 'electric', 'ppe', 'speed', 'fire'];

// Wall decal for the one-tile wall segment at (mx, my); null for most segments.
export function wallDecal(mx, my) {
  const r = hash(mx, my, 31);
  if (r > 0.15) return null;
  return WALL_KINDS[Math.floor(hash(mx, my, 32) * WALL_KINDS.length)];
}

// Yellow/black base stripe style of a wall segment: 0 none, 1 plain yellow line, 2 hazard chevrons.
export function wallBase(mx, my) {
  const r = hash(mx, my, 33);
  return r < 0.3 ? 2 : r < 0.75 ? 1 : 0;
}

const overheadCache = new WeakMap();

// Ceiling fixtures: fluorescent light bars on a 4-tile grid and a few stationary fans on the grid between them.
// Positions that would sit inside or right beside a wall are skipped. Returns { lights: [{x, y, a}], fans: [{x, y, a}] }.
export function overheadDecals(g) {
  if (overheadCache.has(g)) return overheadCache.get(g);
  const walls = g.pillars || [];
  const clear = (x, y, m) => x > m && y > m && x < g.w - m && y < g.h - m
    && !walls.some((r) => x > r.x - m && x < r.x + r.w + m && y > r.y - m && y < r.y + r.h + m);
  const lights = [], fans = [];
  for (let x = 2; x < g.w; x += 4) {
    for (let y = 2; y < g.h; y += 4) {
      const a = hash(x, y, 120) < 0.5 ? 0 : Math.PI / 2;
      if (clear(x, y, 1.2)) lights.push({ x, y, a });
    }
  }
  for (let x = 4; x < g.w; x += 4) {
    for (let y = 4; y < g.h; y += 4) {
      if (hash(x, y, 121) < 0.3 && clear(x, y, 1.5)) fans.push({ x, y, a: hash(x, y, 122) * Math.PI });
    }
  }
  const res = { lights, fans };
  overheadCache.set(g, res);
  return res;
}

// Box decal for the box of colour `col` at stack index `i`: 0 = none, 1 = "this side up" arrows, 2 = fragile glass, 3 = barcode label.
export function boxDecalKind(col, i) {
  const r = hash(col, i, 51);
  return r < 0.25 ? 0 : r < 0.5 ? 1 : r < 0.75 ? 2 : 3;
}

const INK = 'rgba(25,25,25,0.8)';
const arrow = (u) => [
  { pts: [[u - 0.05, -0.35], [u + 0.05, -0.35], [u + 0.05, 0.1], [u - 0.05, 0.1]], fill: INK },
  { pts: [[u - 0.15, 0.1], [u + 0.15, 0.1], [u, 0.38]], fill: INK },
];

// Decal shapes in a unit square (u right, v up, both -0.5..0.5), shared by the top-down and cabin renderers.
export function boxDecalShapes(kind) {
  if (kind === 1) return [...arrow(-0.2), ...arrow(0.2)];
  if (kind === 2) {
    const W = 'rgba(245,245,245,0.95)';
    return [
      { pts: [[-0.5, -0.4], [0.5, -0.4], [0.5, 0.4], [-0.5, 0.4]], fill: 'rgba(198,40,40,0.9)' },
      { pts: [[-0.22, 0.28], [0.22, 0.28], [0.02, -0.02], [-0.02, -0.02]], fill: W },
      { pts: [[-0.025, -0.02], [0.025, -0.02], [0.025, -0.22], [-0.025, -0.22]], fill: W },
      { pts: [[-0.16, -0.22], [0.16, -0.22], [0.16, -0.28], [-0.16, -0.28]], fill: W },
    ];
  }
  if (kind === 3) {
    const out = [{ pts: [[-0.5, -0.3], [0.5, -0.3], [0.5, 0.3], [-0.5, 0.3]], fill: 'rgba(240,240,235,0.95)' }];
    [-0.38, -0.3, -0.2, -0.14, -0.04, 0.04, 0.14, 0.2, 0.3].forEach((u, k) => {
      const w = k % 2 ? 0.03 : 0.05;
      out.push({ pts: [[u, -0.2], [u + w, -0.2], [u + w, 0.18], [u, 0.18]], fill: INK });
    });
    return out;
  }
  return [];
}
