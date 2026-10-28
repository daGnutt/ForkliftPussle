import { COLORS } from '../level.js';
import { HIT_LIFE, zoneDone } from '../game.js';
import { toCam, BOX_H, PAL, MAX_DIST } from './camera.js';

// Text overlays drawn over the finished scene.

// True if a wall or box side blocks the sight line from the eye to a zone's floor centre (ignoring what stands on the zone itself).
function floorOccluded(cam, z, faces) {
  const dx = z.x - cam.x, dy = z.y - cam.y;
  for (const f of faces) {
    if (!f.side) continue;
    const [[ax, ay], [bx, by], z0, z1] = f.side;
    const sx = bx - ax, sy = by - ay;
    const den = dx * sy - dy * sx;
    if (Math.abs(den) < 1e-9) continue;
    const qx = ax - cam.x, qy = ay - cam.y;
    const t = (qx * sy - qy * sx) / den, u = (qx * dy - qy * dx) / den;
    if (t <= 0.01 || t >= 1 || u < 0 || u > 1) continue;
    if (Math.hypot(cam.x + dx * t - z.x, cam.y + dy * t - z.y) < 0.75) continue;
    const zl = cam.z * (1 - t);
    if (zl >= z0 && zl <= z1) return true;
  }
  return false;
}

// Outlined, centred label at screen point (sx, sy).
function label(ctx, text, sx, sy, size, color) {
  ctx.font = `bold ${size}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(2, size / 6);
  ctx.strokeStyle = '#000';
  ctx.strokeText(text, sx, sy);
  ctx.fillStyle = color;
  ctx.fillText(text, sx, sy);
}

// Floating "×count" over each unfinished zone; hidden when the zone floor is out of sight.
export function drawZoneLabels(ctx, g, cam, faces) {
  for (const z of g.zones) {
    if (zoneDone(g, z)) continue;
    const [fw, rt] = toCam(cam, z.x, z.y, 0);
    if (fw <= 0.3 || fw >= MAX_DIST || floorOccluded(cam, z, faces)) continue;
    const sx = cam.cx + (rt / fw) * cam.f, sy = cam.cy - ((0.9 - cam.z) / fw) * cam.f;
    label(ctx, `×${z.count}`, sx, sy, Math.max(8, Math.min(48, (0.5 / fw) * cam.f)), COLORS[z.color]);
  }
}

// Damage popups floating up from the damaged box.
export function drawHits(ctx, g, cam) {
  for (const h of g.hits || []) {
    const k = (g.clock - h.t) / HIT_LIFE;
    const [fw, rt] = toCam(cam, h.x, h.y, 0);
    if (fw <= 0.3) continue;
    const sx = cam.cx + (rt / fw) * cam.f, sy = cam.cy - ((h.z * (BOX_H + PAL) + 0.3 + k * 0.8 - cam.z) / fw) * cam.f;
    ctx.globalAlpha = Math.max(0, 1 - k * k);
    label(ctx, `−${h.pts}`, sx, sy, Math.max(10, Math.min(60, (0.45 / fw) * cam.f)), '#ff5252');
  }
  ctx.globalAlpha = 1;
}
