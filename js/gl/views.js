import { COLORS } from '../level.js';
import { hitLife, zoneDone } from '../game.js';
import { label, labelRows, hitRows, honkers, drawHonk, pinHonk } from '../pov/overlay.js';
import { povCamera, overviewCamera, chaseCamera, groundFootprint } from './camera.js';
import { drawGl, glAvailable } from './renderer.js';
import { BOX_H, PAL } from './models.js';
import { clipPoint } from './mat.js';

// Screen-space glue between the WebGL scene and the 2D game canvas: view entry points and the text overlays
// (cabin zone counts, damage and score popups) that are drawn in 2D over the 3D image through the camera projection.

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

// Cabin view into the css-px box (x, y, w, h). Returns false if WebGL is unavailable.
export function drawPov3d(ctx, g, x, y, w, h, dpr, look = null) {
  if (!glAvailable()) return false;
  const cam = povCamera(g, w, h, look);
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
    const k = (g.clock - hh.t) / hitLife(hh);
    const p = proj(hh.x, hh.y, hh.z * (BOX_H + PAL) + 0.3 + k * 0.8);
    if (!p) continue;
    ctx.globalAlpha = Math.max(0, 1 - k * k);
    labelRows(ctx, hitRows(hh), p[0], p[1], Math.max(10, Math.min(60, (0.45 / p[2]) * (w / 2))));
  }
  ctx.globalAlpha = 1;
  for (const t of honkers(g)) {
    const rect = { x, y, w, h }, p = proj(t.fl.x, t.fl.y, 1.8);
    if (p) {
      const [sx, sy, sz] = pinHonk(p[0], p[1], p[2] > 60 ? 10 : Math.max(10, Math.min(60, (0.6 / p[2]) * (w / 2))), rect);
      drawHonk(ctx, t, g.clock, sx, sy, sz);
    } else {
      const c = clipPoint(cam.vp, t.fl.x, t.fl.y, 1.8), [sx, sy, sz] = pinHonk(0, 0, 60, rect, true, c[0] || 1e-6, -c[1]);
      drawHonk(ctx, t, g.clock, sx, sy, sz);
    }
  }
  ctx.restore();
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, w, h);
  return true;
}

// Overview into the css-px rect (rx, ry, rw, rh): centre (cx, cy) in tiles, s px per tile at the centre.
// `orbit` ({ yaw, tilt } radians, set by dragging) rotates/tilts the camera around the same centre (cx, cy); `chase` (tiles visible vertically) uses the
// third-person camera behind the forklift at the sprung `heading` (cx, cy, s ignored); `orbit` then orbits the tines' middle.
// Returns false without WebGL, else true (chase: the floor footprint polygon, for the minimap).
export function drawOverview3d(ctx, g, rx, ry, rw, rh, cx, cy, s, dpr, orbit = null, chase = 0, heading = g.fl.a) {
  if (!glAvailable()) return false;
  let cam, foot = true;
  if (chase) {
    cam = chaseCamera(g, rw, rh, chase, heading, orbit);
    s = rh / chase;
    foot = groundFootprint(cam);
  } else if (orbit) {
    const co = Math.cos(orbit.yaw), si = Math.sin(orbit.yaw);
    cam = overviewCamera(cx, cy, rh / s, rw, rh, [si, -co], orbit.tilt);
  } else cam = overviewCamera(cx, cy, rh / s, rw, rh);
  const proj = drawGl(ctx, g, 'ov', cam, rx, ry, dpr);
  if (!proj) return false;
  ctx.save();
  ctx.beginPath();
  ctx.rect(rx, ry, rw, rh);
  ctx.clip();
  for (const h of g.hits || []) {
    const k = (g.clock - h.t) / hitLife(h);
    const p = proj(h.x, h.y, h.z * (BOX_H + PAL) + 0.4 + k * 1.2);
    if (!p) continue;
    ctx.globalAlpha = Math.max(0, 1 - k * k);
    labelRows(ctx, hitRows(h), p[0], p[1], 0.55 * s);
  }
  ctx.globalAlpha = 1;
  for (const t of honkers(g)) {
    const rect = { x: rx, y: ry, w: rw, h: rh }, p = proj(t.fl.x, t.fl.y, 1.8);
    if (p) {
      const [sx, sy, sz] = pinHonk(p[0], p[1], 0.7 * s, rect);
      drawHonk(ctx, t, g.clock, sx, sy, sz);
    } else {
      const c = clipPoint(cam.vp, t.fl.x, t.fl.y, 1.8), [sx, sy, sz] = pinHonk(0, 0, 0.7 * s, rect, true, c[0] || 1e-6, -c[1]);
      drawHonk(ctx, t, g.clock, sx, sy, sz);
    }
  }
  ctx.restore();
  return foot;
}

// Small look window (css px box x, y, w, h) centred on world (cx, cy) showing `tilesH` tiles vertically, with `up` pointing up the screen.
export function drawLook3d(ctx, g, x, y, w, h, cx, cy, tilesH, up, dpr) {
  if (!glAvailable()) return false;
  return !!drawGl(ctx, g, 'ov', overviewCamera(cx, cy, tilesH, w, h, up, 0.3), x, y, dpr);
}
