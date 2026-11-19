import { repairable } from './repair.js';

// Onboarding hint for the repair station: until the player has repaired something on this device, carrying a single damaged box shows a
// pop-up (main.js), an arrow towards the station, a glowing station and a blinking minimap marker. Pure view state, never part of `g`.
export const REPAIRED_KEY = 'forklift-repaired';

// Carrying exactly one damaged box that the station can repair (a plain 1×1: no big boxes, no oil barrels) on a level with a station.
export const repairHintWanted = (g, repaired) => !repaired && !!g.repair && g.status === 'play' && g.carried?.length === 1 && g.carriedPen?.[0]?.crash > 0 && repairable(g.carriedPen[0]);

const hint = { on: false };
export const setRepairHint = (on) => { hint.on = on; };
export const repairHintOn = () => hint.on;

const BLINK = 0.5; // seconds per phase of the blinking minimap marker
export const repairBlink = (clock) => Math.floor(clock / BLINK) % 2 === 0;

// Small outlined arrow at (x, y) pointing along screen angle `ang`, `size` px (or world units) long.
export function drawHintArrow(ctx, x, y, ang, size, clock) {
  const k = size * (1 + 0.12 * Math.sin(clock * 6));
  ctx.save();
  ctx.translate(x, y); ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(k * 0.6, 0); ctx.lineTo(-k * 0.1, -k * 0.5); ctx.lineTo(-k * 0.1, -k * 0.2); ctx.lineTo(-k * 0.6, -k * 0.2);
  ctx.lineTo(-k * 0.6, k * 0.2); ctx.lineTo(-k * 0.1, k * 0.2); ctx.lineTo(-k * 0.1, k * 0.5); ctx.closePath();
  ctx.fillStyle = '#42a5f5'; ctx.fill();
  ctx.strokeStyle = '#111'; ctx.lineWidth = size / 8; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.restore();
}

// Pulsing blue halo of radius r around (x, y).
export function drawHintGlow(ctx, x, y, r, clock) {
  const k = 0.75 + 0.25 * Math.sin(clock * 5), gr = ctx.createRadialGradient(x, y, r * 0.3, x, y, r * k);
  gr.addColorStop(0, 'rgba(66,165,245,0.55)'); gr.addColorStop(1, 'rgba(66,165,245,0)');
  ctx.fillStyle = gr;
  ctx.beginPath(); ctx.arc(x, y, r * k, 0, Math.PI * 2); ctx.fill();
}

// Cabin views: the arrow sits on the edge of the box (x, y, w, h), in the direction of the station relative to where the truck faces (ahead = top).
export function drawRepairEdgeArrow(ctx, g, x, y, w, h) {
  if (!hint.on || !g.repair) return;
  const rel = Math.atan2(g.repair.y - g.fl.y, g.repair.x - g.fl.x) - g.fl.a, dx = Math.sin(rel), dy = -Math.cos(rel);
  const size = Math.max(14, Math.min(w, h) * 0.07), ex = w / 2 - size * 1.6, ey = h / 2 - size * 1.6;
  const k = Math.min(ex / (Math.abs(dx) || 1e-9), ey / (Math.abs(dy) || 1e-9));
  drawHintArrow(ctx, x + w / 2 + dx * k, y + h / 2 + dy * k, Math.atan2(dy, dx), size, g.clock);
}
