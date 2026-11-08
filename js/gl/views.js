import { COLORS } from '../level.js';
import { HIT_LIFE, WONKY_LIFE, zoneDone } from '../game.js';
import { label } from '../pov/overlay.js';
import { povCamera, overviewCamera } from './camera.js';
import { drawGl, glAvailable } from './renderer.js';
import { BOX_H, PAL } from './models.js';
import { toWorld, FL } from '../forklift.js';

// Screen-space glue between the WebGL scene and the 2D game canvas: view entry points and the text overlays
// (cabin zone counts, damage popups) that are drawn in 2D over the 3D image through the camera projection.

export { glAvailable };

// True if the segment (x0,y0)-(x1,y1) crosses no wall (so a label there is not hidden behind one).
function lineClear(g, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  for (const w of g.walls) {
    let t0 = 0, t1 = 1, hit = true;
    for (const [o, d, lo, hi] of [[x0, dx, w.x, w.x + w.w], [y0, dy, w.y, w.y + w.h]]) {
      if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { hit = false; break; } continue; }
      let a = (lo - o) / d, b = (hi - o) / d;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      if (t0 > t1) { hit = false; break; }
    }
    if (hit) return false;
  }
  return true;
}

function hitText(h) { return h.wonky ? `Wonky −${h.pts}` : `−${h.pts}`; }

// Cabin view into the css-px box (x, y, w, h). Returns false if WebGL is unavailable.
export function drawPov3d(ctx, g, x, y, w, h, dpr) {
  if (!glAvailable()) return false;
  const cam = povCamera(g, w, h);
  const proj = drawGl(ctx, g, 'pov', cam, x, y, dpr);
  if (!proj) return false;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  for (const z of g.zones) {
    if (zoneDone(g, z) || !lineClear(g, cam.eye[0], cam.eye[1], z.x, z.y)) continue;
    const p = proj(z.x, z.y, 0.9);
    if (!p || p[2] < 0.3 || p[2] > 60) continue;
    label(ctx, `×${z.count}`, p[0], p[1], Math.max(8, Math.min(48, (0.5 / p[2]) * (w / 2))), COLORS[z.color]);
  }
  for (const hh of g.hits || []) {
    const k = (g.clock - hh.t) / (hh.wonky ? WONKY_LIFE : HIT_LIFE);
    const p = proj(hh.x, hh.y, hh.z * (BOX_H + PAL) + 0.3 + k * 0.8);
    if (!p) continue;
    ctx.globalAlpha = Math.max(0, 1 - k * k);
    label(ctx, hitText(hh), p[0], p[1], Math.max(10, Math.min(60, (0.45 / p[2]) * (w / 2))), hh.wonky ? '#ffb74d' : '#ff5252');
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, w, h);
  return true;
}

// Overview into the css-px rect (rx, ry, rw, rh): centre (cx, cy) in tiles, s px per tile at the centre.
// `orbit` ({ yaw, tilt } radians, set by dragging) swings the camera around the forklift instead.
export function drawOverview3d(ctx, g, rx, ry, rw, rh, cx, cy, s, dpr, orbit = null) {
  if (!glAvailable()) return false;
  let cam;
  if (orbit) {
    const c = toWorld(g.fl, (FL.front - FL.back) / 2, 0), co = Math.cos(orbit.yaw), si = Math.sin(orbit.yaw);
    cam = overviewCamera(c.x, c.y, rh / s, rw, rh, [si, -co], orbit.tilt);
  } else cam = overviewCamera(cx, cy, rh / s, rw, rh);
  const proj = drawGl(ctx, g, 'ov', cam, rx, ry, dpr);
  if (!proj) return false;
  ctx.save();
  ctx.beginPath();
  ctx.rect(rx, ry, rw, rh);
  ctx.clip();
  const text = (str, p, size, fill, stroke) => {
    ctx.font = `bold ${size}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = size * 0.18;
    ctx.strokeStyle = stroke;
    ctx.strokeText(str, p[0], p[1]);
    ctx.fillStyle = fill;
    ctx.fillText(str, p[0], p[1]);
  };
  for (const h of g.hits || []) {
    const k = (g.clock - h.t) / (h.wonky ? WONKY_LIFE : HIT_LIFE);
    const p = proj(h.x, h.y, h.z * (BOX_H + PAL) + 0.4 + k * 1.2);
    if (!p) continue;
    ctx.globalAlpha = Math.max(0, 1 - k * k);
    text(hitText(h), p, 0.55 * s, h.wonky ? '#ffb74d' : '#ff5252', '#000');
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  return true;
}

// Small look window (css px box x, y, w, h) centred on world (cx, cy) showing `tilesH` tiles vertically, with `up` pointing up the screen.
export function drawLook3d(ctx, g, x, y, w, h, cx, cy, tilesH, up, dpr) {
  if (!glAvailable()) return false;
  return !!drawGl(ctx, g, 'ov', overviewCamera(cx, cy, tilesH, w, h, up, 0.3), x, y, dpr);
}
