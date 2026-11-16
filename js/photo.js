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
  const poly = (pts, fill) => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = '#111'; ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.stroke(); };
  for (let i = n - 1; i >= 0; i--) { // top first: lower boxes' fronts never overlap those above
    const col = COLORS[photo.layers[i]] ?? '#9e9e9e', y0 = i, y1 = i + 1, z0 = d - 0.5, z1 = d + 0.5;
    if (y0 > CAM_H) poly([P(-0.5, y0, z0), P(0.5, y0, z0), P(0.5, y0, z1), P(-0.5, y0, z1)], shade(col, 0.6)); // underside, seen from below
    poly([P(-0.5, y0, z0), P(0.5, y0, z0), P(0.5, y1, z0), P(-0.5, y1, z0)], shade(col, 1.1));
    const m = (u, v) => P(-0.5 + u, y0 + v, z0); // box-face coordinates, 0..1
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 3; // tape cross and inner frame
    for (const [a, b] of [[[0.5, 0], [0.5, 1]], [[0, 0.5], [1, 0.5]], [[0.12, 0.12], [0.88, 0.12]], [[0.88, 0.12], [0.88, 0.88]], [[0.88, 0.88], [0.12, 0.88]], [[0.12, 0.88], [0.12, 0.12]]]) {
      const s = m(...a), e = m(...b); ctx.beginPath(); ctx.moveTo(s[0], s[1]); ctx.lineTo(e[0], e[1]); ctx.stroke();
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
