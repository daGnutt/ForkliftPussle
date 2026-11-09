import { COLORS } from '../level.js';
import { hitLife, zoneDone } from '../game.js';
import { toCam, BOX_H, PAL, MAX_DIST } from './camera.js';

// Text overlays drawn over the finished scene.

// Outlined, centred label at screen point (sx, sy).
export function label(ctx, text, sx, sy, size, color) {
  ctx.font = `bold ${size}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(2, size / 6);
  ctx.strokeStyle = '#000';
  ctx.strokeText(text, sx, sy);
  ctx.fillStyle = color;
  ctx.fillText(text, sx, sy);
}

export const DAMAGE_COLOR = '#ff5252', WONKY_COLOR = '#ffb74d', POINTS_COLOR = '#a5d6a7';

const signed = (n) => `${n < 0 ? '−' : '+'}${Math.abs(n)}`;

// Rows of a score popup: the stack's points (green, red when negative), or the wonkiness change (amber when it costs, green when it gains)
// on the row below, so both popups of a drop point sit under each other.
export function pointsRows(sc) {
  if (sc.total != null) return [[{ text: `Score: ${signed(sc.total)}`, color: sc.total < 0 ? DAMAGE_COLOR : POINTS_COLOR }]];
  return [[], [{ text: `Wonkiness: ${signed(sc.wonky)}`, color: sc.wonky < 0 ? WONKY_COLOR : POINTS_COLOR }]];
}

// Outlined label made of coloured segments, centred as a whole at (sx, sy).
export function labelParts(ctx, parts, sx, sy, size, minStroke = 2) {
  ctx.font = `bold ${size}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(minStroke, size / 6);
  ctx.strokeStyle = '#000';
  let x = sx - parts.reduce((n, q) => n + ctx.measureText(q.text).width, 0) / 2;
  for (const q of parts) {
    ctx.strokeText(q.text, x, sy);
    ctx.fillStyle = q.color;
    ctx.fillText(q.text, x, sy);
    x += ctx.measureText(q.text).width;
  }
}

// Rows of coloured segments, the first centred at (sx, sy) and the rest stacked below it.
export function labelRows(ctx, rows, sx, sy, size, minStroke = 2) {
  rows.forEach((parts, i) => labelParts(ctx, parts, sx, sy + i * size * 1.15, size, minStroke));
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

// Rows of a popup: the red damage `−pts`, or a finished stack's score breakdown.
export const hitRows = (h) => (h.score ? pointsRows(h.score) : [[{ text: `−${h.pts}`, color: DAMAGE_COLOR }]]);

// Damage popups floating up from the damaged box.
export function drawHits(ctx, g, cam) {
  for (const h of g.hits || []) {
    const k = (g.clock - h.t) / hitLife(h);
    const [fw, rt] = toCam(cam, h.x, h.y, 0);
    if (fw <= 0.3) continue;
    const sx = cam.cx + (rt / fw) * cam.f, sy = cam.cy - ((h.z * (BOX_H + PAL) + 0.3 + k * 0.8 - cam.z) / fw) * cam.f;
    ctx.globalAlpha = Math.max(0, 1 - k * k);
    labelRows(ctx, hitRows(h), sx, sy, Math.max(10, Math.min(60, (0.45 / fw) * cam.f)));
  }
  ctx.globalAlpha = 1;
}
