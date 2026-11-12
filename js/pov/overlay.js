import { lorryHonks } from '../endless.js';
import { COLORS } from '../level.js';
import { hitLife, zoneDone } from '../game.js';
import { truckColor } from '../forklift.js';
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

// Trucks whose horn is sounding, and their "HOOOONK" label (bobbing a little, at screen point (sx, sy)).
// The text grows while the horn is held: HONK, an extra O every 0.5 s up to five, then *HOOOOONK* a second later.
const honkStart = new Map();
export const honkers = (g) => {
  for (const t of g.trucks) {
    if (!t.gone && t.horn) { if (!honkStart.has(t.id)) honkStart.set(t.id, g.clock); } else honkStart.delete(t.id);
  }
  return [...g.trucks.filter((t) => !t.gone && t.horn), ...lorryHonks(g)];
};
export function honkText(elapsed) {
  const o = Math.min(5, 1 + Math.floor(elapsed / 0.5));
  const text = `H${'O'.repeat(o)}NK`;
  return elapsed >= 3 ? `*${text}*` : text;
}
// Keeps a honk label inside `rect` ({ x, y, w, h }): one that falls outside (or lies behind the camera, then (dx, dy) is the screen direction towards it)
// is moved along the ray from the centre to just inside the edge, drawn smaller.
export function pinHonk(sx, sy, size, rect, behind = false, dx = 0, dy = 0) {
  const mx = rect.x + rect.w / 2, my = rect.y + rect.h / 2;
  const hx = Math.max(1, rect.w / 2 - size * 2.6), hy = Math.max(1, rect.h / 2 - size * 0.8);
  if (!behind && Math.abs(sx - mx) <= hx && Math.abs(sy - my) <= hy) return [sx, sy, size];
  const small = Math.max(10, size * 0.6);
  const ex = Math.max(1, rect.w / 2 - small * 2.6), ey = Math.max(1, rect.h / 2 - small * 0.8);
  const vx = behind ? dx : sx - mx, vy = behind ? dy : sy - my;
  const k = Math.min(ex / (Math.abs(vx) || 1e-9), ey / (Math.abs(vy) || 1e-9));
  return [mx + vx * k, my + vy * k, small];
}

export function drawHonk(ctx, t, clock, sx, sy, size) {
  const bob = Math.sin(clock * 16 + t.id * 2) * size * 0.1;
  label(ctx, t.text ?? honkText(Math.max(0, clock - (honkStart.get(t.id) ?? clock))), sx, sy + bob, size, t.paint ?? truckColor(t.color).body);
}

// Damage popups floating up from the damaged box.
export function drawHits(ctx, g, cam, rect) {
  for (const h of g.hits || []) {
    const k = (g.clock - h.t) / hitLife(h);
    const [fw, rt] = toCam(cam, h.x, h.y, 0);
    if (fw <= 0.3) continue;
    const sx = cam.cx + (rt / fw) * cam.f, sy = cam.cy - ((h.z * (BOX_H + PAL) + 0.3 + k * 0.8 - cam.z) / fw) * cam.f;
    ctx.globalAlpha = Math.max(0, 1 - k * k);
    labelRows(ctx, hitRows(h), sx, sy, Math.max(10, Math.min(60, (0.45 / fw) * cam.f)));
  }
  ctx.globalAlpha = 1;
  for (const t of honkers(g)) {
    const [fw, rt] = toCam(cam, t.fl.x, t.fl.y, 0);
    if (fw <= 0.3) {
      if (!rect) continue;
      const [x, y, s] = pinHonk(0, 0, 60, rect, true, rt || 1e-6, 0);
      drawHonk(ctx, t, g.clock, x, y, s);
      continue;
    }
    let sx = cam.cx + (rt / fw) * cam.f, sy = cam.cy - ((1.8 - cam.z) / fw) * cam.f, size = Math.max(10, Math.min(60, (0.6 / fw) * cam.f));
    if (rect) [sx, sy, size] = pinHonk(sx, sy, size, rect);
    drawHonk(ctx, t, g.clock, sx, sy, size);
  }
}
