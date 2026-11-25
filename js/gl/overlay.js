import { lorryHonks } from '../endless.js';
import { flagSymbol } from '../game.js';
import { truckColor } from '../forklift.js';

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

// The inspector's hovering sign over a stack it found wanting: a bobbing symbol, by shape as well as colour — an amber tilted box for
// crooked boxes (wonky), a red cracked box for repairable crash damage; a stack with both alternates (see flagSymbol).
export function drawFlag(ctx, f, sx, sy, size, clock, minLine = 1.5) {
  const y = sy + Math.sin(clock * 4) * size * 0.12, r = size * 0.58;
  const damaged = flagSymbol(f, clock) === 'damaged';
  ctx.save();
  ctx.translate(sx, y);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#111'; ctx.lineWidth = Math.max(minLine, size / 14);
  if (damaged) {
    ctx.beginPath(); ctx.rect(-r * 0.85, -r * 0.85, r * 1.7, r * 1.7);
    ctx.fillStyle = '#ff5252'; ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(r * 0.15, -r * 0.85); ctx.lineTo(-r * 0.25, -r * 0.2); ctx.lineTo(r * 0.3, r * 0.1); ctx.lineTo(-r * 0.15, r * 0.85);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(minLine, size / 9); ctx.stroke();
  } else {
    ctx.rotate(-0.4);
    ctx.beginPath(); ctx.rect(-r * 0.85, -r * 0.2, r * 1.7, r * 1.05); // lower box, tilted
    ctx.fillStyle = '#ffc107'; ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.rect(-r * 0.55, -r * 1.15, r * 1.1, r * 0.95); // top box sliding off
    ctx.translate(r * 0.3, 0); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

const DAMAGE_COLOR = '#ff5252', WONKY_COLOR = '#ffb74d', POINTS_COLOR = '#a5d6a7';

const signed = (n) => `${n < 0 ? '−' : '+'}${Math.abs(n)}`;

// Rows of a score popup: the stack's points (green, red when negative), or the wonkiness change (amber when it costs, green when it gains)
// on the row below, so both popups of a drop point sit under each other.
function pointsRows(sc) {
  if (sc.total != null) return [[{ text: `Score: ${signed(sc.total)}`, color: sc.total < 0 ? DAMAGE_COLOR : POINTS_COLOR }]];
  return [[], [{ text: `Wonkiness: ${signed(sc.wonky)}`, color: sc.wonky < 0 ? WONKY_COLOR : POINTS_COLOR }]];
}

// Outlined label made of coloured segments, centred as a whole at (sx, sy).
function labelParts(ctx, parts, sx, sy, size, minStroke = 2) {
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

// Rows of a popup: the red damage `−pts`, or a finished stack's score breakdown.
export const hitRows = (h) => (h.check ? [[h.check === 'warn' ? { text: '⚠ Warning', color: WONKY_COLOR } : { text: '✔ Perfect', color: '#7dff9b' }]] : h.score ? pointsRows(h.score) : [[{ text: `−${h.pts}`, color: DAMAGE_COLOR }]]);

// Trucks whose horn is sounding, and their "HOOOONK" label (bobbing a little, at screen point (sx, sy)).
// The text grows while the horn is held: HONK, an extra O every 0.5 s up to five, then *HOOOOONK* a second later.
const honkStart = new Map();
export const honkers = (g) => {
  for (const t of g.trucks) {
    if (!t.gone && t.horn) { if (!honkStart.has(t.id)) honkStart.set(t.id, g.clock); } else honkStart.delete(t.id);
  }
  return [...g.trucks.filter((t) => !t.gone && t.horn), ...lorryHonks(g)];
};
function honkText(elapsed) {
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

