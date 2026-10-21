export function rectPoly(cx, cy, hx, hy, ang = 0) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([x, y]) => ({
    x: cx + x * c - y * s,
    y: cy + x * s + y * c,
  }));
}

function center(p) {
  let x = 0, y = 0;
  for (const v of p) { x += v.x; y += v.y; }
  return { x: x / p.length, y: y / p.length };
}

function project(p, ax) {
  let min = Infinity, max = -Infinity;
  for (const v of p) {
    const d = v.x * ax.x + v.y * ax.y;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
}

function rectAxes(p) {
  const out = [];
  for (let i = 0; i < 2; i++) {
    const a = p[i], b = p[i + 1];
    const ex = b.x - a.x, ey = b.y - a.y;
    const l = Math.hypot(ex, ey) || 1;
    out.push({ x: ey / l, y: -ex / l });
  }
  return out;
}

// Separating axis test for two rectangles. Returns the unit normal pointing
// from b towards a and the penetration depth, or null when not overlapping.
export function sat(a, b) {
  let best = Infinity, bn = null;
  for (const ax of [...rectAxes(a), ...rectAxes(b)]) {
    const [minA, maxA] = project(a, ax);
    const [minB, maxB] = project(b, ax);
    const overlap = Math.min(maxA - minB, maxB - minA);
    if (overlap <= 0) return null;
    if (overlap < best) { best = overlap; bn = ax; }
  }
  const ca = center(a), cb = center(b);
  if ((ca.x - cb.x) * bn.x + (ca.y - cb.y) * bn.y < 0) bn = { x: -bn.x, y: -bn.y };
  return { x: bn.x, y: bn.y, depth: best };
}

export function pointRectDist(px, py, r) {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.w));
  const dy = Math.max(r.y - py, 0, py - (r.y + r.h));
  return Math.hypot(dx, dy);
}
