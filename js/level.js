import { pointRectDist } from './geom.js';

export const COLORS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa'];
export const COLOR_NAMES = ['red', 'blue', 'green', 'yellow', 'purple'];

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

export function levelParams(n) {
  const w = Math.min(30, 14 + Math.floor(n * 1.4));
  const h = Math.max(11, Math.round(w * 0.7));
  return {
    w,
    h,
    maxH: Math.min(5, 2 + Math.floor((n - 1) / 2)),
    colors: Math.min(5, 2 + Math.floor((n - 1) / 2)),
    total: Math.min(28, 4 + n * 2),
    dividers: n < 2 ? 0 : Math.min(7, 1 + Math.floor(n / 2)),
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
  return walls;
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

  const walls = buildRooms(rnd, w, h, dividers, start);
  walls.push(charger);

  const placed = [];
  const areas = [];
  const spot = (margin, pillarGap, minOther) => {
    for (let t = 0; t < 400; t++) {
      const x = margin + rnd() * (w - 2 * margin);
      const y = margin + rnd() * (h - 2 * margin);
      if (Math.hypot(x - start.x, y - start.y) < 3.2) continue;
      if (walls.some((r) => pointRectDist(x, y, r) < pillarGap)) continue;
      if (areas.some((r) => pointRectDist(x, y, r) < 1.6)) continue;
      if (placed.some((o) => Math.hypot(o.x - x, o.y - y) < minOther(o))) continue;
      return { x, y };
    }
    return null;
  };

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
      placed.push({ x: z.x, y: z.y, zone: true });
    });
  }
  for (const st of stacks) {
    const s = spot(2.3, 2.0, (o) => (o.zone ? 1.8 : 2.0));
    if (!s) return null;
    st.x = s.x; st.y = s.y;
    placed.push({ x: s.x, y: s.y });
  }

  return { n, w, h, walls, zones, areas, stacks, start };
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
  for (let attempt = 0; attempt < 300; attempt++) {
    const lvl = tryGenerate(n, attempt, seed);
    if (lvl) return lvl;
  }
  return tryGenerate(1, 0, seed);
}
