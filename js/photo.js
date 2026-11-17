import { COLORS } from './level.js';

// The inspector's snapshot, seen from its own vantage point: a camera ~0.3 tiles off the floor, tilted up so the whole stack fits.
const W = 400, H = 300, STRIP = 81, CAM_H = 0.3, FOV = 1.8, SHOW_MS = 4500;

const shade = (hex, k) => {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
};

// Pinhole projection of (x sideways, y height, z depth) for a camera at height CAM_H pitched up by `pitch`.
export function projector(photo, w = W, h = H) {
  const layers = Math.max(1, photo.layers.length), d = Math.max(1.1, photo.dist || 1.4) - 0.5; // distance to the stack's front face
  const pitch = Math.atan2(layers / 2 - CAM_H, d), f = (h / 2) / Math.tan(FOV / 2);
  const c = Math.cos(pitch), s = Math.sin(pitch);
  return (x, y, z) => {
    const dy = y - CAM_H, zz = Math.max(0.05, z * c + dy * s), yy = dy * c - z * s;
    return [w / 2 + (x / zz) * f, h / 2 - (yy / zz) * f];
  };
}

// An oil drum: a cylinder two boxes tall with bands and a yellow hazard stripe, so it never reads as a crate.
function drawBarrel(ctx, P, col, cx, cz, y0, y1, poly, line) {
  const R = 0.47, N = 28, ang = (k) => (k * 2 * Math.PI) / N, pt = (k, y) => P(cx + Math.cos(ang(k)) * R, y, cz + Math.sin(ang(k)) * R);
  if (y0 > CAM_H) poly(Array.from({ length: N }, (_, k) => pt(k, y0)), shade(col, 0.5), 3);
  for (let k = 0; k < N; k++) {
    const mid = ang(k + 0.5), nx = Math.cos(mid), nz = Math.sin(mid);
    if (nx * (cx + nx * R) + nz * (cz + nz * R) >= 0) continue; // back half
    const lit = 0.75 + 0.4 * -nz, band = (a, b, f) => poly([pt(k, a), pt(k + 1, a), pt(k + 1, b), pt(k, b)], f, 0);
    band(y0, y1, shade(col, lit));
    band(y0 + (y1 - y0) * 0.38, y0 + (y1 - y0) * 0.62, k % 2 ? shade('#fdd835', lit) : shade('#212121', lit)); // hazard stripe
  }
  for (const f of [0.06, 0.38, 0.62, 0.94]) {
    const y = y0 + (y1 - y0) * f;
    for (let k = 0; k < N; k++) { const mid = ang(k + 0.5); if (Math.cos(mid) * (cx + Math.cos(mid) * R) + Math.sin(mid) * (cz + Math.sin(mid) * R) < 0) line(pt(k, y), pt(k + 1, y), 'rgba(255,255,255,.5)', 2.5); }
  }
  const edge = (y) => { for (let k = 0; k < N; k++) { const mid = ang(k + 0.5); if (Math.cos(mid) * (cx + Math.cos(mid) * R) + Math.sin(mid) * (cz + Math.sin(mid) * R) < 0) line(pt(k, y), pt(k + 1, y), '#111', 4); } };
  edge(y0); edge(y1);
  const sl = pt(0, y0), sr = pt(N / 2, y0), tl = pt(0, y1), tr = pt(N / 2, y1);
  line(sl, tl, '#111', 4); line(sr, tr, '#111', 4);
}

const hurt = (pen) => (pen?.crash || 0) > 0;

// Warning triangle with an exclamation mark, centred on screen point `c`, `r` px across.
function drawDamage(ctx, c, r) {
  const [x, y] = c, t = [[x, y - r * 0.55], [x + r * 0.6, y + r * 0.45], [x - r * 0.6, y + r * 0.45]];
  ctx.beginPath(); t.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); ctx.closePath();
  ctx.fillStyle = '#ffeb3b'; ctx.fill(); ctx.strokeStyle = '#d50000'; ctx.lineWidth = Math.max(2, r * 0.12); ctx.lineJoin = 'round'; ctx.stroke();
  ctx.fillStyle = '#d50000'; ctx.fillRect(x - r * 0.05, y - r * 0.2, r * 0.1, r * 0.36); ctx.fillRect(x - r * 0.05, y + r * 0.22, r * 0.1, r * 0.1);
}

// Polaroid: the w x h picture plus a white caption strip below it (canvas height h + STRIP), the verdict is written on the strip.
export function drawPhoto(ctx, photo, w = W, h = H) {
  const sh = Math.round(h * STRIP / H);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h + sh);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
  const P = projector(photo, w, h), d = Math.max(1.1, photo.dist || 1.4), n = photo.layers.length;
  const horizon = P(0, 0, 40)[1]; // floor meets the far wall
  const hy = Math.max(0, Math.min(h, horizon)), top = Math.max(0, hy - h * 0.45);
  ctx.fillStyle = '#b9a27a'; ctx.fillRect(0, 0, w, h); // warm warehouse wall
  const ceil = ctx.createLinearGradient(0, 0, 0, top + 1);
  ceil.addColorStop(0, '#1b2330'); ceil.addColorStop(1, '#3a4658');
  ctx.fillStyle = ceil; ctx.fillRect(0, 0, w, top);
  ctx.fillStyle = '#fff8d6'; // ceiling lights
  for (let i = 0; i < 4; i++) ctx.fillRect(w * (0.1 + i * 0.24), top * 0.35, w * 0.14, Math.max(3, top * 0.12));
  ctx.fillStyle = 'rgba(0,0,0,.12)';
  for (let x = 0; x < w; x += 40) ctx.fillRect(x, top, 2, hy - top); // wall panel seams
  const floor = ctx.createLinearGradient(0, hy, 0, h);
  floor.addColorStop(0, '#6f6a60'); floor.addColorStop(1, '#a8a296');
  ctx.fillStyle = floor; ctx.fillRect(0, hy, w, h - hy);
  ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = 1; // floor tiles, 1 tile apart
  for (let k = -6; k <= 6; k++) { const a = P(k, 0, 1), b = P(k, 0, 40); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
  const poly = (pts, fill, line = 4) => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); if (line) { ctx.strokeStyle = '#111'; ctx.lineWidth = line; ctx.lineJoin = 'round'; ctx.stroke(); } };
  const line = (a, b, style, wd) => { ctx.strokeStyle = style; ctx.lineWidth = wd; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); };
  const view = photo.view || 0, fx = Math.cos(view), fy = Math.sin(view);
  for (let i = n - 1; i >= 0; i--) { // top first: lower boxes' fronts never overlap those above
    const pen = photo.pens?.[i];
    if (pen?.barrelPart === 'top') continue;
    const col = COLORS[photo.layers[i]] ?? '#9e9e9e', y0 = i, o = photo.offs?.[i] || { x: 0, y: 0 };
    const cx = o.x * -fy + o.y * fx, cz = d + o.x * fx + o.y * fy; // box centre in the camera frame: x to the right, z forward
    if (pen?.barrelPart === 'base') {
      drawBarrel(ctx, P, col, cx, cz, y0, y0 + 2, poly, line);
      if (hurt(pen) || hurt(photo.pens?.[i + 1])) drawDamage(ctx, P(cx, y0 + 1, cz - 0.47), Math.abs(P(0.4, 0, cz)[0] - P(-0.4, 0, cz)[0]));
      continue;
    }
    const phi = (photo.rots?.[i] ?? view) - view, sn = Math.sin(phi), cs = Math.cos(phi), y1 = y0 + 1;
    const hy = pen?.wide ? 1 : 0.5; // a double-wide box is two tiles across its local y axis
    const cor = [[-0.5, -hy], [0.5, -hy], [0.5, hy], [-0.5, hy]].map(([u, v]) => [cx + u * sn + v * cs, cz + u * cs - v * sn]);
    if (y0 > CAM_H) poly(cor.map(([x, z]) => P(x, y0, z)), shade(col, 0.6)); // underside, seen from below
    for (let k = 0; k < 4; k++) {
      const [ax, az] = cor[k], [bx, bz] = cor[(k + 1) % 4], ex = bx - ax, ez = bz - az, nx = -ez, nz = ex; // outward normal for this winding
      if (nx * ax + nz * az >= 0) continue; // faces away from the camera
      const nl = Math.hypot(nx, nz);
      poly([P(ax, y0, az), P(bx, y0, bz), P(bx, y1, bz), P(ax, y1, az)], shade(col, 0.8 + 0.25 * (-nz / nl) + 0.2 * (nx / nl)));
      const m = (u, v) => P(ax + ex * u, y0 + v, az + ez * u);
      if (hurt(pen)) drawDamage(ctx, m(0.5, 0.5), Math.min(Math.hypot(...m(1, 0.5).map((v, j) => v - m(0, 0.5)[j])), Math.hypot(...m(0.5, 1).map((v, j) => v - m(0.5, 0)[j]))) * 0.7);
      for (const [p, q] of [[[0.5, 0], [0.5, 1]], [[0, 0.5], [1, 0.5]], [[0.12, 0.12], [0.88, 0.12]], [[0.88, 0.12], [0.88, 0.88]], [[0.88, 0.88], [0.12, 0.88]], [[0.12, 0.88], [0.12, 0.12]]]) line(m(...p), m(...q), 'rgba(255,255,255,.55)', 3);
    }
  }
  // flash: hot centre, light vignette
  const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, h * 0.95);
  g.addColorStop(0, 'rgba(255,255,255,.25)'); g.addColorStop(0.6, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,.35)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.restore();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 14; ctx.strokeRect(0, 0, w, h + sh); // polaroid border
  const text = photo.damage ? 'DAMAGED!' : photo.ok ? 'GOOD JOB' : 'COULD BE BETTER', col = photo.ok ? '#43a047' : '#e53935';
  ctx.save();
  ctx.translate(w / 2, h + sh / 2 + 2); ctx.rotate(-0.04);
  ctx.font = 'bold 40px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.scale(Math.min(1, (w - 50) / ctx.measureText(text).width), 1);
  ctx.fillStyle = col; ctx.fillText(text, 0, 0);
  ctx.restore();
}

// Snapshot of the stack on the forks as seen from behind the truck, or null when none of its boxes is damaged (so no popup is needed).
export function carriedPhoto(g) {
  if (!g.carried?.length || !g.carriedPen?.some(hurt)) return null;
  const c = Math.cos(g.fl.a), sn = Math.sin(g.fl.a);
  return {
    n: 0, ok: false, layers: [...g.carried], rots: g.carriedRots.map((r) => r + g.fl.a),
    offs: g.carriedOffs.map((o) => ({ x: o.x * c - o.y * sn, y: o.x * sn + o.y * c })),
    pens: g.carriedPen.map((q) => ({ barrelPart: q?.barrelPart, wide: !!q?.wide, crash: q?.crash || 0 })),
    view: g.fl.a, dist: 2.2, damage: true,
  };
}

let timer = 0, fade = 0, spot = null, corner = 0;

// The renderers report where the player's forklift is on the canvas (CSS px, with a radius); no report (cab views) means nothing to dodge.
export const clearTruckSpot = () => { spot = null; };
export const setTruckSpot = (x, y, r) => { spot = { x, y, r }; };

export const PHOTO_SCALES = [1, 0.75, 0.5];
const MARGIN = 16;

// Picks the screen corner (0 right-top, 1 left-top, 2 right-bottom, 3 left-bottom) and size factor for a popup of full size w x h: the current corner is kept while it is free, otherwise the first free one; if no corner is free at full size the popup shrinks (PHOTO_SCALES). `blocked` are screen rects to keep clear (touch controls), `truck` the forklift circle.
export function placePhoto({ vw, vh, w, h, corner = 0, blocked = [], truck = null, m = MARGIN }) {
  const rect = (k, f) => { const rw = w * f, rh = h * f; return { x: k & 1 ? m : vw - rw - m, y: k & 2 ? vh - rh - m : m, w: rw, h: rh }; };
  const hit = (k, f) => {
    const r = rect(k, f);
    if (blocked.some((b) => r.x < b.right + 8 && r.x + r.w > b.left - 8 && r.y < b.bottom + 8 && r.y + r.h > b.top - 8)) return true;
    return !!truck && Math.hypot(truck.x - Math.max(r.x, Math.min(truck.x, r.x + r.w)), truck.y - Math.max(r.y, Math.min(truck.y, r.y + r.h))) < truck.r + 24;
  };
  for (const f of PHOTO_SCALES) {
    const k = hit(corner, f) ? [0, 1, 2, 3].find((c) => !hit(c, f)) : corner;
    if (k !== undefined) return { corner: k, scale: f, ...rect(k, f) };
  }
  return { corner, scale: PHOTO_SCALES.at(-1), ...rect(corner, PHOTO_SCALES.at(-1)) };
}

let photoScale = 1;
// Keeps the popup off the forklift and the visible touch controls: it slides to a free screen corner and shrinks when none is free.
export function dodgePhoto() {
  const el = typeof document !== 'undefined' && document.getElementById('photo');
  if (!el || el.classList.contains('hide')) return;
  const c = document.getElementById('game')?.getBoundingClientRect() || { left: 0, top: 0 };
  const blocked = [...document.querySelectorAll('#touch button, #stick')].map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  const w = el.offsetWidth / photoScale, h = el.offsetHeight / photoScale;
  const truck = spot && { x: spot.x + c.left, y: spot.y + c.top, r: spot.r };
  const p = placePhoto({ vw: innerWidth, vh: innerHeight, w, h, corner, blocked, truck });
  corner = p.corner;
  if (p.scale !== photoScale) { photoScale = p.scale; el.style.width = `calc(min(45vw, 60vh) * ${p.scale})`; }
  el.style.transform = `translate(${p.x - (innerWidth - p.w - MARGIN)}px, ${p.y - MARGIN}px) rotate(2deg)`;
}
export function showPhoto(photo) {
  const el = typeof document !== 'undefined' && document.getElementById('photo');
  if (!el) return;
  el.width = W; el.height = H + STRIP;
  drawPhoto(el.getContext('2d'), photo);
  clearTimeout(timer); clearTimeout(fade);
  el.classList.remove('hide', 'fade');
  fade = setTimeout(() => el.classList.add('fade'), SHOW_MS - 400);
  timer = setTimeout(() => el.classList.add('hide'), SHOW_MS);
}
