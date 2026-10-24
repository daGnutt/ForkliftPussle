// Factory fluff: deterministic decals (tire marks, oil stains, yellow floor markings, wall signs).
// Pure data, no drawing, so both renderers share it. Purely cosmetic; never touches game state.

const CELL = 4; // floor decals live in CELL×CELL tile cells

// Cheap deterministic hash -> [0, 1).
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

function cellDecals(cx, cy) {
  const r = hash(cx, cy, 1), out = [];
  const ox = cx * CELL + 0.5 + hash(cx, cy, 2) * (CELL - 1), oy = cy * CELL + 0.5 + hash(cx, cy, 3) * (CELL - 1);
  if (r < 0.2) { // curving pair of tire marks
    const a0 = hash(cx, cy, 4) * Math.PI * 2, curve = (hash(cx, cy, 5) - 0.5) * 0.35;
    for (const side of [-0.28, 0.28]) {
      const pts = [];
      let x = ox, y = oy, a = a0;
      for (let i = 0; i <= 12; i++) {
        pts.push([x - Math.sin(a) * side, y + Math.cos(a) * side]);
        a += curve;
        x += Math.cos(a) * 0.3;
        y += Math.sin(a) * 0.3;
      }
      out.push(...strip(pts, 0.16, RUBBER));
    }
  } else if (r < 0.32) { // oil stain
    const rx = 0.35 + hash(cx, cy, 6) * 0.4, ry = 0.25 + hash(cx, cy, 7) * 0.35;
    const pts = [];
    for (let i = 0; i < 14; i++) {
      const t = (i / 14) * Math.PI * 2, k = 0.85 + hash(cx, cy, 20 + i) * 0.3;
      pts.push([ox + Math.cos(t) * rx * k, oy + Math.sin(t) * ry * k]);
    }
    out.push({ pts, fill: 'rgba(10,10,15,0.22)' });
  } else if (r < 0.46) { // dashed yellow lane line
    const horiz = hash(cx, cy, 8) < 0.5;
    for (let i = 0; i < 4; i++) {
      out.push(horiz ? rect(cx * CELL + i, oy, 0.6, 0.14, YELLOW) : rect(ox, cy * CELL + i, 0.14, 0.6, YELLOW));
    }
  } else if (r < 0.56) { // yellow/black hazard stripe patch
    const horiz = hash(cx, cy, 9) < 0.5, n = 8;
    for (let i = 0; i < n; i++) {
      const s = i * 0.25;
      out.push(horiz ? rect(ox + s, oy, 0.25, 0.5, i & 1 ? 'rgba(20,20,20,0.5)' : YELLOW)
        : rect(ox, oy + s, 0.5, 0.25, i & 1 ? 'rgba(20,20,20,0.5)' : YELLOW));
    }
  } else if (r < 0.64) { // painted walkway box outline
    const w = 1.6 + hash(cx, cy, 10), h = 1.2;
    out.push(...strip([[ox, oy], [ox + w, oy], [ox + w, oy + h], [ox, oy + h], [ox, oy - 0.07]], 0.1, YELLOW));
  }
  return out;
}

// All floor decals within the tile rectangle [x0,x1]×[y0,y1].
export function floorDecals(x0, y0, x1, y1) {
  const out = [];
  for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
    for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) out.push(...cellDecals(cx, cy));
  }
  return out;
}

const WALL_KINDS = ['window', 'window', 'door', 'nosmoking', 'exit', 'extinguisher', 'hazard', 'forklift', 'electric', 'ppe', 'speed', 'fire'];

// Wall decal for the one-tile wall segment at (mx, my); null for most segments.
export function wallDecal(mx, my) {
  const r = hash(mx, my, 31);
  if (r > 0.3) return null;
  return WALL_KINDS[Math.floor(hash(mx, my, 32) * WALL_KINDS.length)];
}

// Yellow/black base stripe style of a wall segment: 0 none, 1 plain yellow line, 2 hazard chevrons.
export function wallBase(mx, my) {
  const r = hash(mx, my, 33);
  return r < 0.3 ? 2 : r < 0.75 ? 1 : 0;
}
