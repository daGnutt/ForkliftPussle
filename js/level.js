import { pointRectDist } from './geom.js';
import { FL } from './forklift.js';

export const COLORS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#9e9e9e', '#39484b'];
export const WIDE_COLOR = 5; // gray: only wide boxes and their zones; the generator's colours are 0..4
export const BARREL_COLOR = 6; // dark blue-gray: only oil barrels and their zones
export const ZONE_COLORS = COLORS.map((color, i) => (i === BARREL_COLOR ? '#bfd5d8' : color));

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

// A wide pallet must be approached along its short axis. Reserve a straight
// corridor long enough to set it down and reverse until both tines are clear.
function wideApproaches(lvl, p, obstacles) {
  const vertical = Math.abs(Math.sin(p.a || 0)) > 0.5;
  const withdraw = FL.tineX1 + 0.5 + 0.15;
  const far = withdraw - FL.back + 0.15, half = 1.1;
  return [-1, 1].flatMap((side) => {
    const lo = side < 0 ? -far : -0.65, hi = side < 0 ? 0.65 : far;
    const r = vertical
      ? { x: p.x - half, y: p.y + lo, w: 2 * half, h: hi - lo }
      : { x: p.x + lo, y: p.y - half, w: hi - lo, h: 2 * half };
    if (r.x < 0 || r.y < 0 || r.x + r.w > lvl.w || r.y + r.h > lvl.h ||
        [...lvl.walls, ...obstacles].some((o) => rectGap(r, o) === 0)) return [];
    return [{ x: p.x + (vertical ? 0 : side * withdraw), y: p.y + (vertical ? side * withdraw : 0) }];
  });
}

function zoneObstacle(z) {
  const vertical = z.wide && Math.abs(Math.sin(z.a || 0)) > 0.5;
  const hx = z.wide ? (vertical ? 1 : 0.5) : 0.5;
  const hy = z.wide ? (vertical ? 0.5 : 1) : 0.5;
  return { x: z.x - hx, y: z.y - hy, w: 2 * hx, h: 2 * hy };
}

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
  const reachableApproach = (p, obstacles) => wideApproaches(lvl, p, obstacles).some(({ x, y }) => {
    const i = Math.floor(x / GRID), j = Math.floor(y / GRID);
    return i >= 0 && j >= 0 && i < cols && j < rows && seen[j * cols + i];
  });
  return stacks.every((s) => near(s) && (!s.wide || reachableApproach(s, []))) &&
    zones.every((z) => near(z) && (!z.wide || reachableApproach(z, zones.filter((o) => o !== z).map(zoneObstacle))));
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

// From level 3 a few gray boxes (`WIDE_COLOR`) are wide: some of the normal drop points (zone + its boxes of that colour) are swapped for gray
// 1×2 drop points (`zone.wide`, world half extents `hx`/`hy`, `a`) holding the same number of wide boxes (`stack.wide`, `a` = heading: the
// long side runs along local y). All wide zones share one gray drop-off area laid out on a grid, like the zones of any colour; the wide boxes
// stand in stacks of 1-3 (all wide) in bays of their own. A wide box only ever stacks on wide boxes and only fits a wide zone.
// Uses its own generator and leaves the layout alone when there is no clear spot.
const WIDE_ZONE_LONG = 1.1, WIDE_ZONE_SHORT = 0.6, WIDE_MAX_COUNT = 3;

function tryWide(lvl, rnd, want) {
  const { w, h, walls, doors, start } = lvl;
  const stacks = lvl.stacks.map((q) => ({ ...q, layers: [...q.layers] }));
  const picked = [];
  let zones = lvl.zones.map((z) => ({ ...z }));
  for (let t = 0; t < want; t++) {
    const cands = zones.filter((z) => !z.wide && z.count <= WIDE_MAX_COUNT && !picked.includes(z));
    if (!cands.length) break;
    const z = cands[Math.floor(rnd() * cands.length)], c = z.color;
    const open = stacks.filter((q) => q.open && q.layers[q.layers.length - 1] === c).length;
    const spots = [];
    stacks.forEach((q, si) => q.layers.forEach((col, i) => { if (col === c && !(q.open && i === q.layers.length - 1)) spots.push({ si, i }); }));
    if (open >= zones.filter((q) => q.color === c && !picked.includes(q)).length || spots.length < z.count) continue;
    const take = [];
    while (take.length < z.count) take.push(spots.splice(Math.floor(rnd() * spots.length), 1)[0]);
    take.sort((a, b) => b.i - a.i).forEach(({ si, i }) => stacks[si].layers.splice(i, 1));
    picked.push(z);
  }
  if (!picked.length) return null;
  const za = rnd() < 0.5 ? 0 : Math.PI / 2, sa = rnd() < 0.5 ? 0 : Math.PI / 2;
  const ex = za ? WIDE_ZONE_LONG : WIDE_ZONE_SHORT, ey = za ? WIDE_ZONE_SHORT : WIDE_ZONE_LONG;
  const cols = Math.min(picked.length, za ? 3 : 2), rows = Math.ceil(picked.length / cols), px = 2 * ex + 0.4, py = 2 * ey + 0.4;
  const free = (r, areas, bays) => pointRectDist(start.x, start.y, r) >= 3.2 && !walls.some((o) => rectGap(o, r) < 1.5) &&
    !areas.some((o) => rectGap(o, r) < 1.5) && !bays.some((o) => rectGap(o, r) < 1.5) && !doors.some((o) => rectGap(o, r) < 1.0);
  const keep = (ar) => zones.some((q) => !picked.includes(q) && q.color === ar.color && q.x >= ar.x && q.x <= ar.x + ar.w && q.y >= ar.y && q.y <= ar.y + ar.h);
  const oldAreas = lvl.areas.filter((ar) => keep(ar));
  const aw = (cols - 1) * px + 2 * ex, ah = (rows - 1) * py + 2 * ey;
  let area = null;
  const wideZones = (r) => picked.map((z, k) => ({ ...z, color: WIDE_COLOR, x: r.x + ex + (k % cols) * px, y: r.y + ey + Math.floor(k / cols) * py, wide: true, hx: ex, hy: ey, a: za }));
  const otherZones = zones.filter((z) => !picked.includes(z));
  for (let t = 0; t < 300 && !area; t++) {
    const r = { x: 0.5 + rnd() * (w - 1 - aw), y: 0.5 + rnd() * (h - 1 - ah), w: aw, h: ah };
    if (!free(r, oldAreas, lvl.bays)) continue;
    const candidates = wideZones(r), allZones = [...otherZones, ...candidates];
    if (candidates.every((z) => wideApproaches(lvl, z, allZones.filter((o) => o !== z).map(zoneObstacle)).length)) area = r;
  }
  if (!area) return null;
  zones = [...otherZones, ...wideZones(area)];
  const areas = [...oldAreas, { color: WIDE_COLOR, ...area }];
  let left = picked.reduce((n, z) => n + z.count, 0);
  const bays = [...lvl.bays];
  const wide = [];
  while (left > 0) {
    const k = 1 + Math.floor(rnd() * Math.min(3, left));
    let br = null;
    for (let t = 0; t < 300 && !br; t++) {
      const r = { x: 1.3 + rnd() * (w - 2.6 - 2), y: 1.3 + rnd() * (h - 2.6 - 2), w: 2, h: 2 };
      if (free(r, areas, bays) && wideApproaches(lvl, { x: r.x + 1, y: r.y + 1, a: sa }, []).length) br = r;
    }
    if (!br) return null;
    bays.push(br);
    wide.push({ x: br.x + 1, y: br.y + 1, layers: Array(k).fill(WIDE_COLOR), wide: true, a: sa });
    left -= k;
  }
  const all = [...stacks.filter((q) => q.layers.length), ...wide];
  const inBay = (b) => all.some((q) => q.x > b.x && q.x < b.x + b.w && q.y > b.y && q.y < b.y + b.h);
  const cand = { ...lvl, zones, areas, bays: bays.filter(inBay), stacks: all };
  return isReachable(cand) ? cand : null;
}

function markWide(n, attempt, seed, lvl) {
  if (n < 3) return lvl;
  const rnd = mulberry32(n * 7727 + attempt * 13 + 11 + Math.imul(seed, 69069));
  for (let want = Math.min(4, 1 + Math.floor((n - 3) / 3)); want > 0; want--) {
    const r = tryWide(lvl, rnd, want);
    if (r) return r;
  }
  return lvl;
}

// From level 3, convert up to four matching pairs to barrels, moving each pair to the top of its stack.
function markOilBarrel(n, seed, lvl) {
  if (n < 3) return lvl;
  const maxBarrels = Math.min(4, 1 + Math.floor((n - 3) / 2));
  const rnd = mulberry32(n * 15485863 + Math.imul(seed, 32452843));
  const candidates = [];
  for (let si = 0; si < lvl.stacks.length; si++) {
    const s = lvl.stacks[si];
    if (s.wide || s.open) continue;
    for (let i = 0; i + 1 < s.layers.length; i++) {
      if (s.layers[i] === s.layers[i + 1] && s.layers[i] < WIDE_COLOR) candidates.push({ si, i, color: s.layers[i] });
    }
  }
  if (!candidates.length) return lvl;
  const walls = lvl.walls, doors = lvl.doors || [], bays = lvl.bays || [];
  const free = (r, areas) => pointRectDist(lvl.start.x, lvl.start.y, r) >= 3.2 &&
    !walls.some((o) => rectGap(o, r) < 1.5) && !doors.some((o) => rectGap(o, r) < 1.0) &&
    !areas.some((o) => rectGap(o, r) < 1.5) && !bays.some((o) => rectGap(o, r) < 1.5);
  let target = Math.min(maxBarrels, candidates.length), area = null;
  const spacing = 1.35;
  while (target > 0 && !area) {
    const w = 1.2 + (target - 1) * spacing;
    for (let t = 0; t < 300 && !area; t++) {
      const r = { x: 0.6 + rnd() * (lvl.w - 1.2 - w), y: 0.6 + rnd() * (lvl.h - 2.4), w, h: 1.2 };
      if (free(r, lvl.areas)) area = r;
    }
    if (!area) target--;
  }
  if (!area) return lvl;
  const barrelArea = { color: BARREL_COLOR, ...area };
  let working = { ...lvl, areas: [...lvl.areas, barrelArea] };
  const usedStacks = new Set();
  const first = Math.floor(rnd() * candidates.length);
  let placed = 0;
  for (let k = 0; k < candidates.length && placed < target; k++) {
    const { si, i, color } = candidates[(first + k) % candidates.length];
    if (usedStacks.has(si)) continue;
    const zones = working.zones.map((z) => ({ ...z }));
    const donor = zones.find((z) => z.color === color && z.count >= 2);
    if (!donor) continue;
    donor.count -= 2;
    const nextZones = zones.filter((z) => z.count > 0);
    const openTops = working.stacks.filter((s) => s.open && s.layers.at(-1) === color).length;
    if (openTops > nextZones.filter((z) => z.color === color).length) continue;
    const areas = working.areas.filter((a) => a.color !== color || nextZones.some((z) => z.color === color));
    const stacks = working.stacks.map((s) => ({ ...s, layers: [...s.layers] }));
    const pair = stacks[si].layers.splice(i, 2);
    stacks[si].layers.push(...pair.map(() => BARREL_COLOR));
    stacks[si].barrelAt = stacks[si].layers.length - 2;
    const candidate = {
      ...working,
      stacks,
      zones: [...nextZones, { x: area.x + 0.6 + placed * spacing, y: area.y + 0.6, color: BARREL_COLOR, count: 1 }],
      areas,
    };
    if (isReachable(candidate)) {
      working = candidate;
      usedStacks.add(si);
      placed++;
    }
  }
  if (!placed) return lvl;
  working.areas = working.areas.map((a) => a.color === BARREL_COLOR ? { ...a, w: 1.2 + (placed - 1) * spacing } : a);
  return isReachable(working) ? working : lvl;
}

const PITCH = 1.6, WALL_GAP = 0.5;

// Grid used by n drop points: at most 3 columns (rows when the back wall is vertical: columns are then filled one after the other).
function gridDims(n, horizontal) {
  const cols = Math.min(n, 3), rows = Math.ceil(n / cols);
  return horizontal ? { cols, rows } : { cols: Math.ceil(n / rows), rows };
}

// Lays a colour's drop points out on a grid in an area whose back is its nearest outer wall: the tallest fill the rows/columns furthest back
// (ties keep their order).
function fillArea(zs, area, w, h) {
  const gaps = [area.x, w - area.x - area.w, area.y, h - area.y - area.h];
  const back = gaps.indexOf(Math.min(...gaps));
  const horizontal = back >= 2; // wall runs along x, so depth is measured in rows
  const { cols, rows } = gridDims(zs.length, horizontal);
  [...zs].sort((a, b) => b.count - a.count).forEach((z, i) => {
    let col = horizontal ? i % cols : Math.floor(i / rows), row = horizontal ? Math.floor(i / cols) : i % rows;
    if (back === 1) col = cols - 1 - col;
    if (back === 3) row = rows - 1 - row;
    z.x = area.x + 0.6 + col * PITCH;
    z.y = area.y + 0.6 + row * PITCH;
  });
}

// Barrel and wide swaps remove drop points from the colour areas; shrink each such area to its remaining drop points, push it flush against
// its nearest outer wall (keeping its place along the wall) and lay the points out again, so they stand against the wall without gaps.
function tidyAreas(lvl) {
  const { w, h } = lvl;
  const next = { ...lvl, zones: lvl.zones.map((z) => ({ ...z })), areas: lvl.areas.map((a) => ({ ...a })) };
  for (const a of next.areas) {
    if (a.color === WIDE_COLOR || a.color === BARREL_COLOR) continue;
    const zs = next.zones.filter((z) => z.color === a.color);
    const gaps = [a.x, w - a.x - a.w, a.y, h - a.y - a.h];
    const back = gaps.indexOf(Math.min(...gaps));
    const { cols, rows } = gridDims(zs.length, back >= 2);
    const nw = (cols - 1) * PITCH + 1.2, nh = (rows - 1) * PITCH + 1.2;
    const r = { x: a.x + (a.w - nw) / 2, y: a.y + (a.h - nh) / 2, w: nw, h: nh };
    if (back === 0) r.x = WALL_GAP;
    else if (back === 1) r.x = w - nw - WALL_GAP;
    else if (back === 2) r.y = WALL_GAP;
    else r.y = h - nh - WALL_GAP;
    if (lvl.walls.some((o) => rectGap(o, r) < 1.5) || next.areas.some((o) => o !== a && rectGap(o, r) < 1.5)) continue;
    Object.assign(a, r);
    fillArea(zs, a, w, h);
  }
  return isReachable(next) ? next : lvl;
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
    fillArea(zs, area, w, h);
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
  return tidyAreas(markOilBarrel(n, seed, markWide(n, attempt, seed, base)));
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
