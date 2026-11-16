import { COLORS } from './level.js';

// The inspector's snapshot, seen from its own vantage point: a camera ~0.3 tiles off the floor, tilted up so the whole stack fits.
const W = 400, H = 300, CAM_H = 0.3, FOV = 1.8, SHOW_MS = 4500;

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
  const R = 0.38, N = 28, ang = (k) => (k * 2 * Math.PI) / N, pt = (k, y) => P(cx + Math.cos(ang(k)) * R, y, cz + Math.sin(ang(k)) * R);
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

export function drawPhoto(ctx, photo, w = W, h = H) {
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
    if (pen?.barrelPart === 'base') { drawBarrel(ctx, P, col, cx, cz, y0, y0 + 2, poly, line); continue; }
    const phi = (photo.rots?.[i] ?? view) - view, sn = Math.sin(phi), cs = Math.cos(phi), y1 = y0 + 1;
    const cor = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([u, v]) => [cx + u * sn + v * cs, cz + u * cs - v * sn]);
    if (y0 > CAM_H) poly(cor.map(([x, z]) => P(x, y0, z)), shade(col, 0.6)); // underside, seen from below
    for (let k = 0; k < 4; k++) {
      const [ax, az] = cor[k], [bx, bz] = cor[(k + 1) % 4], ex = bx - ax, ez = bz - az, nx = -ez, nz = ex; // outward normal for this winding
      if (nx * ax + nz * az >= 0) continue; // faces away from the camera
      const nl = Math.hypot(nx, nz);
      poly([P(ax, y0, az), P(bx, y0, bz), P(bx, y1, bz), P(ax, y1, az)], shade(col, 0.8 + 0.35 * (-nz / nl)));
      const m = (u, v) => P(ax + ex * u, y0 + v, az + ez * u);
      for (const [p, q] of [[[0.5, 0], [0.5, 1]], [[0, 0.5], [1, 0.5]], [[0.12, 0.12], [0.88, 0.12]], [[0.88, 0.12], [0.88, 0.88]], [[0.88, 0.88], [0.12, 0.88]], [[0.12, 0.88], [0.12, 0.12]]]) line(m(...p), m(...q), 'rgba(255,255,255,.55)', 3);
    }
  }
  // flash: hot centre, light vignette
  const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, h * 0.95);
  g.addColorStop(0, 'rgba(255,255,255,.25)'); g.addColorStop(0.6, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,.35)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  // verdict printed on the photo
  const text = photo.ok ? 'GOOD JOB' : 'COULD BE BETTER', col = photo.ok ? '#43a047' : '#e53935';
  ctx.save();
  ctx.translate(w / 2, h - 44); ctx.rotate(-0.06);
  ctx.font = 'bold 44px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const sc = Math.min(1, (w - 30) / ctx.measureText(text).width);
  ctx.scale(sc, sc);
  ctx.lineWidth = 8; ctx.lineJoin = 'round'; ctx.strokeStyle = '#fff'; ctx.strokeText(text, 0, 0);
  ctx.fillStyle = col; ctx.fillText(text, 0, 0);
  ctx.restore();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 14; ctx.strokeRect(0, 0, w, h); // polaroid border
}

let timer = 0, fade = 0;
export function showPhoto(photo) {
  const el = typeof document !== 'undefined' && document.getElementById('photo');
  if (!el) return;
  el.width = W; el.height = H;
  drawPhoto(el.getContext('2d'), photo);
  clearTimeout(timer); clearTimeout(fade);
  el.classList.remove('hide', 'fade');
  fade = setTimeout(() => el.classList.add('fade'), SHOW_MS - 400);
  timer = setTimeout(() => el.classList.add('hide'), SHOW_MS);
}
