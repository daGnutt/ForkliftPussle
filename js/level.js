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

function tryGenerate(n, attempt) {
  const rnd = mulberry32(n * 7919 + attempt * 104729 + 17);
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
  const spot = (margin, pillarGap, minOther) => {
    for (let t = 0; t < 400; t++) {
      const x = margin + rnd() * (w - 2 * margin);
      const y = margin + rnd() * (h - 2 * margin);
      if (Math.hypot(x - start.x, y - start.y) < 3.2) continue;
      if (walls.some((r) => pointRectDist(x, y, r) < pillarGap)) continue;
      if (placed.some((o) => Math.hypot(o.x - x, o.y - y) < minOther(o))) continue;
      return { x, y };
    }
    return null;
  };

  for (const z of zones) {
    const s = spot(1.6, 1.8, () => 2.0);
    if (!s) return null;
    z.x = s.x; z.y = s.y;
    placed.push({ x: s.x, y: s.y, zone: true });
  }
  for (const st of stacks) {
    const s = spot(2.3, 2.0, (o) => (o.zone ? 1.8 : 2.0));
    if (!s) return null;
    st.x = s.x; st.y = s.y;
    placed.push({ x: s.x, y: s.y });
  }

  return { n, w, h, walls, zones, stacks, start };
}

export function generateLevel(n) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const lvl = tryGenerate(n, attempt);
    if (lvl) return lvl;
  }
  return tryGenerate(1, 0);
}
