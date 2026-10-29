import { COLORS } from '../level.js';
import { HIT_LIFE, zoneDone } from '../game.js';
import { toCam, BOX_H, PAL, MAX_DIST } from './camera.js';

// Text overlays drawn over the finished scene.

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

// Floating "×count" over each unfinished zone, as painter items ({ d, draw }) merged into the sorted faces so
// walls and boxes in front of a label cover it. d is pulled nearer by the zone radius so whatever stands on the zone itself doesn't hide it.
export function zoneLabelItems(g, cam) {
  const items = [];
  for (const z of g.zones) {
    if (zoneDone(g, z)) continue;
    const [fw, rt] = toCam(cam, z.x, z.y, 0);
    if (fw <= 0.3 || fw >= MAX_DIST) continue;
    const sx = cam.cx + (rt / fw) * cam.f, sy = cam.cy - ((0.9 - cam.z) / fw) * cam.f;
    items.push({
      d: Math.hypot(z.x - cam.x, z.y - cam.y, 0.9 - cam.z) - 0.75,
      draw: (ctx) => label(ctx, `×${z.count}`, sx, sy, Math.max(8, Math.min(48, (0.5 / fw) * cam.f)), COLORS[z.color]),
    });
  }
  return items;
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
