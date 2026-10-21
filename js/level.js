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
    pillars: Math.min(8, Math.floor(n / 2)),
  };
}

function rectGap(a, b) {
  const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0);
  const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0);
  return Math.hypot(dx, dy);
}

function tryGenerate(n, attempt, seed = 0) {
  const rnd = mulberry32(n * 7919 + attempt * 104729 + 17 + Math.imul(seed, 2654435761));
  const { w, h, maxH, colors, total, pillars } = levelParams(n);
  const start = { x: 3.2, y: h - 2.6, a: 0 };

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

  const walls = [];
  for (let p = 0; p < pillars; p++) {
    for (let t = 0; t < 60; t++) {
      const pw = 1 + Math.floor(rnd() * 3), ph = 1 + Math.floor(rnd() * 3);
      const r = {
        x: 3 + Math.floor(rnd() * (w - 6 - pw)),
        y: 3 + Math.floor(rnd() * (h - 6 - ph)),
        w: pw,
        h: ph,
      };
      if (pointRectDist(start.x, start.y, r) < 4) continue;
      if (walls.some((o) => rectGap(o, r) < 2.5)) continue;
      walls.push(r);
      break;
    }
  }

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
