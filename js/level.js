import { pointRectDist } from './geom.js';

export const COLORS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function levelParams(n) {
  const w = Math.min(44, 14 + Math.floor(n * 1.4));
  const h = Math.max(11, Math.round(w * 0.7));
  return {
    w,
    h,
    maxH: Math.min(5, 2 + Math.floor((n - 1) / 2)),
    colors: Math.min(5, 2 + Math.floor((n - 1) / 2)),
    total: Math.min(40, 4 + n * 2),
    dividers: n < 2 ? 0 : Math.min(10, 1 + Math.floor(n / 2)),
  };
}

function rectGap(a, b) {
  const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0);
  const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0);
  return Math.hypot(dx, dy);
}

// Splits the level into rooms and corridors with dividing walls (thickness 1), each with one or two door gaps.
// Later walls keep clear of earlier doors so every room stays reachable.
const WALL_T = 1, DOOR_W = 3.6, MIN_ROOM = 7, CORRIDOR_W = 3.4;

function buildRooms(rnd, w, h, count, start) {
  const walls = [];
  const doors = [];
  const gaps = [];
  const regions = [{ x: 0, y: 0, w, h }];
  const clear = (r) => !doors.some((d) => rectGap(d, r) === 0) &&
    pointRectDist(start.x, start.y, r) >= 3;
  for (let i = 0; i < count; i++) {
    regions.sort((a, b) => b.w * b.h - a.w * a.h);
    let done = false;
    for (let ri = 0; ri < regions.length && !done; ri++) {
      const reg = regions[ri];
      const vertical = reg.w === reg.h ? rnd() < 0.5 : reg.w > reg.h;
      const len = vertical ? reg.w : reg.h;
      const cross = vertical ? reg.h : reg.w;
      if (len < 2 * MIN_ROOM + WALL_T || cross < DOOR_W + 2) continue;
      for (let t = 0; t < 30 && !done; t++) {
        const corridor = len >= 2 * MIN_ROOM + CORRIDOR_W && rnd() < 0.4;
        let c;
        if (corridor) {
          c = rnd() < 0.5 ? CORRIDOR_W : len - CORRIDOR_W - WALL_T;
        } else {
          c = MIN_ROOM + Math.floor(rnd() * (len - 2 * MIN_ROOM - WALL_T + 1));
        }
        const dMin = 0.5, dMax = cross - DOOR_W - 0.5;
        const d = Math.round((dMin + rnd() * (dMax - dMin)) * 2) / 2;
        const wallRect = vertical
          ? { x: reg.x + c, y: reg.y, w: WALL_T, h: cross }
          : { x: reg.x, y: reg.y + c, w: cross, h: WALL_T };
        if (!clear(wallRect)) continue;
        // A second opening when the wall is long enough (at least 1.5 of wall between the doors).
        const offs = [d];
        if (cross >= 2 * DOOR_W + 3.5 && rnd() < 0.4) {
          const lo = d + DOOR_W + 1.5, hi = cross - DOOR_W - 0.5;
          const lo2 = 0.5, hi2 = d - DOOR_W - 1.5;
          const opts = [];
          if (hi >= lo) opts.push([lo, hi]);
          if (hi2 >= lo2) opts.push([lo2, hi2]);
          if (opts.length) {
            const [a, b] = opts[Math.floor(rnd() * opts.length)];
            offs.push(Math.round((a + rnd() * (b - a)) * 2) / 2);
          }
        }
        offs.sort((p, q) => p - q);
        let pos = 0;
        for (const o of offs) {
          const door = vertical
            ? { x: wallRect.x, y: reg.y + o, w: WALL_T, h: DOOR_W }
            : { x: reg.x + o, y: wallRect.y, w: DOOR_W, h: WALL_T };
          const p = vertical ? { ...wallRect, h: o - pos } : { ...wallRect, w: o - pos };
          if (vertical) p.y = reg.y + pos; else p.x = reg.x + pos;
          if (p.w > 0 && p.h > 0) walls.push(p);
          gaps.push(door);
          doors.push({ x: door.x - 1.2, y: door.y - 1.2, w: door.w + 2.4, h: door.h + 2.4 });
          pos = o + DOOR_W;
        }
        const last = vertical ? { ...wallRect, y: reg.y + pos, h: cross - pos }
          : { ...wallRect, x: reg.x + pos, w: cross - pos };
        if (last.w > 0 && last.h > 0) walls.push(last);
        regions.splice(ri, 1);
        if (vertical) {
          regions.push({ x: reg.x, y: reg.y, w: c, h: reg.h },
            { x: reg.x + c + WALL_T, y: reg.y, w: reg.w - c - WALL_T, h: reg.h });
        } else {
          regions.push({ x: reg.x, y: reg.y, w: reg.w, h: c },
            { x: reg.x, y: reg.y + c + WALL_T, w: reg.w, h: reg.h - c - WALL_T });
        }
        done = true;
      }
    }
    if (!done) break;
  }
  return { walls, doors: gaps };
}

// Flood fill from the start over a grid where cells within CLEAR of a wall, the charger or the map edge are blocked.
// True when every stack and zone has a reachable cell within REACH. Position reachability only: ignores turning radius.
const GRID = 0.25, CLEAR = 0.8, REACH = 2.0;

export function isReachable(lvl) {
  const { w, h, walls, start, stacks, zones } = lvl;
  const cols = Math.ceil(w / GRID), rows = Math.ceil(h / GRID);
  const blocked = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = (i + 0.5) * GRID, y = (j + 0.5) * GRID;
      if (x < CLEAR || y < CLEAR || x > w - CLEAR || y > h - CLEAR ||
          walls.some((r) => pointRectDist(x, y, r) < CLEAR)) blocked[j * cols + i] = 1;
    }
  }
  const si = Math.min(cols - 1, Math.floor(start.x / GRID)), sj = Math.min(rows - 1, Math.floor(start.y / GRID));
  const seen = new Uint8Array(cols * rows);
  const queue = [sj * cols + si];
  seen[queue[0]] = 1;
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q], i = c % cols, j = (c - i) / cols;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
      const nc = nj * cols + ni;
      if (seen[nc] || blocked[nc]) continue;
      seen[nc] = 1;
      queue.push(nc);
    }
  }
  const near = (p) => {
    const r = Math.ceil(REACH / GRID);
    const ci = Math.floor(p.x / GRID), cj = Math.floor(p.y / GRID);
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        if (i < 0 || j < 0 || i >= cols || j >= rows || !seen[j * cols + i]) continue;
        if (Math.hypot((i + 0.5) * GRID - p.x, (j + 0.5) * GRID - p.y) <= REACH) return true;
      }
    }
    return false;
  };
  return stacks.every(near) && zones.every(near);
}

// From level 2 some stacks get an open-top box (`stack.open`: its top box). One per stack at most, and never more of a colour than that
// colour has zones, since each needs a stack of its own to end on. Uses its own generator so the layouts stay as they were.
const OPEN_CHANCE = 0.25;

function markOpenTops(n, attempt, seed, stacks, zones) {
  if (n < 2) return;
  const rnd = mulberry32(n * 31337 + attempt * 7 + 5 + Math.imul(seed, 40503));
  const left = COLORS.map((_, c) => zones.filter((z) => z.color === c).length);
  for (const st of stacks) {
    const c = st.layers[st.layers.length - 1];
    if (rnd() < OPEN_CHANCE && left[c] > 0) { st.open = true; left[c]--; }
  }
}

// From level 3 a few boxes become wide: one box of a colour is taken out of its stack and set down alone in a bay of its own as a 1×2 box
// (`stack.wide`, `a` = its heading: the long side runs along local y), and one of that colour's single-box zones turns into a 1×2 zone
// (`zone.wide`, world half extents `hx`/`hy`, `a`) in a drop-off area of its own. A wide box only ever stands alone and only fits a wide zone.
// Uses its own generator and leaves the layout alone when there is no clear spot.
const WIDE_ZONE_LONG = 1.1, WIDE_ZONE_SHORT = 0.6;

function tryWide(lvl, rnd) {
  const { w, h, walls, doors, start } = lvl;
  const picks = [];
  lvl.stacks.forEach((st, si) => st.layers.forEach((c, i) => {
    if (!st.wide && !(st.open && i === st.layers.length - 1) && lvl.zones.some((z) => z.count === 1 && !z.wide && z.color === c)) picks.push({ si, i, c });
  }));
  if (!picks.length) return null;
  const { si, i, c } = picks[Math.floor(rnd() * picks.length)];
  const z = lvl.zones.find((q) => q.count === 1 && !q.wide && q.color === c);
  const sa = rnd() < 0.5 ? 0 : Math.PI / 2, za = rnd() < 0.5 ? 0 : Math.PI / 2;
  const ex = za ? WIDE_ZONE_LONG : WIDE_ZONE_SHORT, ey = za ? WIDE_ZONE_SHORT : WIDE_ZONE_LONG;
  const free = (r, areas, bays) => pointRectDist(start.x, start.y, r) >= 3.2 && !walls.some((o) => rectGap(o, r) < 1.5) &&
    !areas.some((o) => rectGap(o, r) < 1.5) && !bays.some((o) => rectGap(o, r) < 1.5) && !doors.some((o) => rectGap(o, r) < 1.0);
  let zr = null;
  for (let t = 0; t < 300 && !zr; t++) {
    const x = 0.5 + ex + rnd() * (w - 1 - 2 * ex), y = 0.5 + ey + rnd() * (h - 1 - 2 * ey);
    const r = { x: x - ex, y: y - ey, w: 2 * ex, h: 2 * ey };
    if (free(r, lvl.areas, lvl.bays)) zr = r;
  }
  if (!zr) return null;
  const zones = lvl.zones.map((q) => (q === z ? { ...q, x: zr.x + ex, y: zr.y + ey, wide: true, hx: ex, hy: ey, a: za } : q));
  const inArea = (q, ar) => q.color === ar.color && q.x - (q.hx ?? 0.6) >= ar.x - 1e-9 && q.x + (q.hx ?? 0.6) <= ar.x + ar.w + 1e-9 &&
    q.y - (q.hy ?? 0.6) >= ar.y - 1e-9 && q.y + (q.hy ?? 0.6) <= ar.y + ar.h + 1e-9;
  const areas = [...lvl.areas.filter((ar) => ar.color !== c || zones.some((q) => inArea(q, ar))), { color: c, ...zr }];
  for (let t = 0; t < 300; t++) {
    const br = { x: 1.3 + rnd() * (w - 2.6 - 2), y: 1.3 + rnd() * (h - 2.6 - 2), w: 2, h: 2 };
    if (!free(br, areas, lvl.bays)) continue;
    const stacks = lvl.stacks.flatMap((q, k) => (k !== si ? [q] : q.layers.length === 1 ? [] : [{ ...q, layers: q.layers.filter((_, j) => j !== i) }]));
    stacks.push({ x: br.x + 1, y: br.y + 1, layers: [c], wide: true, a: sa });
    const inBay = (b) => stacks.some((q) => q.x > b.x && q.x < b.x + b.w && q.y > b.y && q.y < b.y + b.h);
    const cand = { ...lvl, zones, areas, bays: [...lvl.bays.filter((b) => inBay(b)), br], stacks };
    return isReachable(cand) ? cand : null;
  }
  return null;
}

function markWide(n, attempt, seed, lvl) {
  if (n < 3) return lvl;
  const rnd = mulberry32(n * 7727 + attempt * 13 + 11 + Math.imul(seed, 69069));
  let cur = lvl;
  for (let k = Math.min(3, 1 + Math.floor((n - 3) / 4)); k > 0; k--) cur = tryWide(cur, rnd) || cur;
  return cur;
}

function tryGenerate(n, attempt, seed = 0) {
  const rnd = mulberry32(n * 7919 + attempt * 104729 + 17 + Math.imul(seed, 2654435761));
  const { w, h, maxH, colors, total, dividers } = levelParams(n);
  // The truck's tail rests against a charger: a half-truck-width stub jutting from an outer wall.
  const side = Math.floor(rnd() * 4), along = rnd();
  const CHARGER_D = 0.45, TAIL = 1.9, CHARGER_W = 0.55;
  const dist = CHARGER_D + TAIL;
  const a = side * (Math.PI / 2);
  const start = { x: 0, y: 0, a };
  let charger;
  if (side % 2 === 0) {
    start.y = 2.2 + along * (h - 4.4);
    start.x = side === 0 ? dist : w - dist;
    charger = { x: side === 0 ? 0 : w - CHARGER_D, y: start.y - CHARGER_W / 2, w: CHARGER_D, h: CHARGER_W };
  } else {
    start.x = 2.2 + along * (w - 4.4);
    start.y = side === 1 ? dist : h - dist;
    charger = { x: start.x - CHARGER_W / 2, y: side === 1 ? 0 : h - CHARGER_D, w: CHARGER_W, h: CHARGER_D };
  }

  const boxes = [];
  for (let c = 0; c < colors; c++) boxes.push(c);
  while (boxes.length < total) boxes.push(Math.floor(rnd() * colors));

  const zones = [];
  for (let c = 0; c < colors; c++) {
    let remaining = boxes.filter((b) => b === c).length;
    while (remaining > 0) {
      const k = 1 + Math.floor(rnd() * Math.min(maxH, remaining));
      zones.push({ x: 0, y: 0, color: c, count: k });
      remaining -= k;
    }
  }

  for (let i = boxes.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [boxes[i], boxes[j]] = [boxes[j], boxes[i]];
  }
  const stacks = [];
  for (let i = 0; i < boxes.length;) {
    const k = Math.min(boxes.length - i, 1 + Math.floor(rnd() * maxH));
    stacks.push({ x: 0, y: 0, layers: boxes.slice(i, i + k) });
    i += k;
  }

  const { walls, doors } = buildRooms(rnd, w, h, dividers, start);
  walls.push(charger);

  const areas = [];

  // One tidy block per colour: that colour's zones laid out on a grid.
  const PITCH = 1.6;
  const WALL_GAP = 0.5;
  for (let c = 0; c < colors; c++) {
    const zs = zones.filter((z) => z.color === c);
    const cols = Math.min(zs.length, 3), rows = Math.ceil(zs.length / cols);
    const aw = (cols - 1) * PITCH + 1.2, ah = (rows - 1) * PITCH + 1.2;
    let area = null;
    for (let t = 0; t < 400 && !area; t++) {
      const r = {
        x: 1 + rnd() * (w - 2 - aw),
        y: 1 + rnd() * (h - 2 - ah),
        w: aw,
        h: ah,
      };
      // Prefer drop-off areas flush against an outer wall (most attempts).
      if (t < 300) {
        const side = Math.floor(rnd() * 4);
        if (side === 0) r.x = WALL_GAP;
        else if (side === 1) r.x = w - aw - WALL_GAP;
        else if (side === 2) r.y = WALL_GAP;
        else r.y = h - ah - WALL_GAP;
      }
      if (pointRectDist(start.x, start.y, r) < 3.2) continue;
      if (walls.some((o) => rectGap(o, r) < 1.5)) continue;
      if (areas.some((o) => rectGap(o, r) < 1.5)) continue;
      area = { color: c, ...r };
    }
    if (!area) return null;
    areas.push(area);
    zs.forEach((z, i) => {
      z.x = area.x + 0.6 + (i % cols) * PITCH;
      z.y = area.y + 0.6 + Math.floor(i / cols) * PITCH;
    });
  }
  // Start stacks are clustered into small groups (2-4) on a grid; each group gets a big yellow bay around it.
  const SP = 2.0, bays = [];
  const clear = (r, gap) => pointRectDist(start.x, start.y, r) >= 3.2 &&
    !walls.some((o) => rectGap(o, r) < gap) && !doors.some((o) => rectGap(o, r) < 1.0) && !areas.some((o) => rectGap(o, r) < 1.5) &&
    !bays.some((o) => rectGap(o, r) < 1.5);
  for (let i = 0; i < stacks.length;) {
    const k = Math.min(stacks.length - i, 1 + Math.floor(rnd() * 4));
    const group = stacks.slice(i, i + k);
    i += k;
    let cols = k === 4 ? 2 : k;
    if (k > 1 && k < 4 && rnd() < 0.5) cols = 1;
    const rows = Math.ceil(k / cols);
    const bw = cols * SP, bh = rows * SP;
    let bay = null;
    for (let t = 0; t < 300 && !bay; t++) {
      const r = { x: 1.3 + rnd() * (w - 2.6 - bw), y: 1.3 + rnd() * (h - 2.6 - bh), w: bw, h: bh };
      if (clear(r, 1.0)) bay = r;
    }
    if (!bay) return null;
    bays.push(bay);
    group.forEach((st, j) => {
      st.x = bay.x + SP / 2 + (j % cols) * SP;
      st.y = bay.y + SP / 2 + Math.floor(j / cols) * SP;
    });
  }

  markOpenTops(n, attempt, seed, stacks, zones);

  const base = { n, w, h, walls, doors, zones, areas, bays, stacks, start, charger };
  if (!isReachable(base)) return null;
  return markWide(n, attempt, seed, base);
}

// Integer seeds are used as-is; any other text is hashed. Empty/0 = the default layouts.
export function parseSeed(text) {
  const t = String(text ?? '').trim();
  if (/^-?\d+$/.test(t)) return Number(t) | 0;
  let h = 0;
  for (const ch of t) h = (Math.imul(h, 31) + ch.codePointAt(0)) | 0;
  return h;
}

export function generateLevel(n, seed = 0) {
  // Keep varying the attempt number (deterministic) until a valid level of this very number turns up.
  for (let attempt = 0; attempt < 5000; attempt++) {
    const lvl = tryGenerate(n, attempt, seed);
    if (lvl) return lvl;
  }
  throw new Error(`No valid layout found for level ${n} (seed ${seed})`);
}
