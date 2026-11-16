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
  const wall = ctx.createLinearGradient(0, 0, 0, h);
  wall.addColorStop(0, '#20262b'); wall.addColorStop(0.7, '#5b666d'); wall.addColorStop(1, '#8d979c');
  ctx.fillStyle = wall; ctx.fillRect(0, 0, w, h);
  const horizon = P(0, 0, 40)[1]; // floor meets the far wall
  ctx.fillStyle = '#6d6a62'; ctx.fillRect(0, Math.min(h, horizon + 8), w, h);
  const poly = (pts, fill) => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 2; ctx.stroke(); };
  for (let i = n - 1; i >= 0; i--) { // top first: lower boxes' fronts never overlap those above
    const col = COLORS[photo.layers[i]] ?? '#9e9e9e', y0 = i, y1 = i + 1, z0 = d - 0.5, z1 = d + 0.5;
    if (y0 > CAM_H) poly([P(-0.5, y0, z0), P(0.5, y0, z0), P(0.5, y0, z1), P(-0.5, y0, z1)], shade(col, 0.55)); // underside, seen from below
    poly([P(-0.5, y0, z0), P(0.5, y0, z0), P(0.5, y1, z0), P(-0.5, y1, z0)], shade(col, 1));
  }
  // flash: hot centre, dark vignette
  const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.1, w / 2, h / 2, h * 0.85);
  g.addColorStop(0, 'rgba(255,255,255,.35)'); g.addColorStop(0.5, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,.6)');
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
