import { zoneDone, score, maxScore, crashProbes, crashAlert, alertTriggers } from './game.js';
import { unloadRate, interval, DOCKS } from './endless.js';

import { truckCircles, BOT_R } from './bot.js';

// Debug overlay of the maintenance bots' intentions: the planned route (line + waypoint dots, red while fleeing), the goal, the bot's mode and
// the forklift circles it steers around. `proj(x, y)` maps floor coordinates to the current canvas units ([sx, sy], or null when not visible); `unit` scales sizes.
export function drawBotDebug(ctx, g, proj, unit = 1) {
  drawAlertProbes(ctx, g, proj, unit);
  drawAlertMarks(ctx, g, proj, unit);
  const bots = [[g.bot, '#ffb84a', 'cleaner'], [g.inspector, '#4ad8ff', 'inspector']].filter(([b]) => b && b.mode === 'out');
  if (!bots.length) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.font = `${11 * unit}px monospace`; ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
  const ring = (x, y, r, color, w) => {
    const c = proj(x, y), e = proj(x + r, y);
    if (!c || !e) return;
    ctx.strokeStyle = color; ctx.lineWidth = w * unit;
    ctx.beginPath(); ctx.arc(c[0], c[1], Math.max(1, Math.hypot(e[0] - c[0], e[1] - c[1])), 0, Math.PI * 2); ctx.stroke();
  };
  for (const c of truckCircles(g)) ring(c.x, c.y, c.r, 'rgba(255,70,70,0.45)', 1);
  for (const [b, color, name] of bots) {
    const fleeing = !!b.scared, col = fleeing ? '#ff4a4a' : b.waiting ? '#ffe14a' : color;
    const pts = [b, ...b.path].map((p) => proj(p.x, p.y));
    if (b.goal) {
      const a = proj(b.x, b.y), t = proj(b.goal.x, b.goal.y);
      if (a && t) {
        ctx.setLineDash([4 * unit, 4 * unit]); ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = unit;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(t[0], t[1]); ctx.stroke(); ctx.setLineDash([]);
        ring(b.goal.x, b.goal.y, 0.15, '#fff', 2); ring(b.goal.x, b.goal.y, 0.05, '#fff', 2);
      }
    }
    ctx.strokeStyle = col; ctx.lineWidth = 2 * unit;
    ctx.beginPath();
    let pen = false;
    for (const p of pts) { if (!p) { pen = false; continue; } if (pen) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); pen = true; }
    ctx.stroke();
    ctx.fillStyle = col;
    pts.forEach((p, i) => { if (p && i) { ctx.beginPath(); ctx.arc(p[0], p[1], (i === pts.length - 1 ? 4 : 2.2) * unit, 0, Math.PI * 2); ctx.fill(); } });
    ring(b.x, b.y, BOT_R, col, 1.5);
    const at = proj(b.x, b.y);
    if (at) {
      const state = [fleeing ? 'FLEEING' : b.waiting ? `WAITING ${(b.waitT || 0).toFixed(1)}s` : b.path.length ? 'driving' : 'at goal', `path ${b.path.length}`,
        ...(b.skip && Object.values(b.skip).some((t) => t > g.clock) ? ['skipping'] : [])].join(' · ');
      const text = `${name}: ${state}`, x = at[0] + 12 * unit, y = at[1] - 10 * unit;
      ctx.lineWidth = 3 * unit; ctx.strokeStyle = '#000'; ctx.strokeText(text, x, y);
      ctx.fillStyle = col; ctx.fillText(text, x, y);
    }
  }
  ctx.restore();
}

// Outlines of the proximity alert's probe areas (see crashProbes); red while the alert is firing.
export function drawAlertProbes(ctx, g, proj, unit = 1) {
  const probes = crashProbes(g);
  if (!probes.length) return;
  ctx.save();
  ctx.strokeStyle = crashAlert(g) ? '#ff3a2a' : 'rgba(255,225,74,0.8)'; ctx.lineWidth = unit;
  for (const poly of probes) {
    const pts = poly.map((p) => proj(p.x, p.y));
    if (pts.some((p) => !p)) continue;
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.stroke();
  }
  ctx.restore();
}

// Lightbulb decals floating above every stack that set off the proximity alert, each with a countdown; they vanish MARK_SECONDS after the last trigger.
const MARK_SECONDS = 3, marks = new Map(); // stack -> clock time the decal expires
export function drawAlertMarks(ctx, g, proj, unit = 1) {
  const now = g.clock || 0;
  for (const s of alertTriggers(g)) marks.set(s, now + MARK_SECONDS);
  for (const [s, until] of marks) {
    if (until < now || until > now + MARK_SECONDS + 1e-6 || !g.stacks.includes(s)) { marks.delete(s); continue; } // expired, clock went back (new level) or stack gone
    const c = proj(s.x, s.y);
    if (!c) continue;
    const x = c[0], y = c[1] - (26 + 8 * s.layers.length) * unit, r = 8 * unit;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.fillStyle = '#ffe14a'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5 * unit;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); // glass
    ctx.fillStyle = '#8a8a8a';
    ctx.beginPath(); ctx.rect(x - r * 0.5, y + r * 0.95, r, r * 0.7); ctx.fill(); ctx.stroke(); // socket
    ctx.strokeStyle = '#a07000'; ctx.lineWidth = unit; // filament
    ctx.beginPath(); ctx.moveTo(x - r * 0.35, y + r * 0.9); ctx.lineTo(x - r * 0.35, y - r * 0.1); ctx.lineTo(x, y + r * 0.3); ctx.lineTo(x + r * 0.35, y - r * 0.1); ctx.lineTo(x + r * 0.35, y + r * 0.9); ctx.stroke();
    ctx.strokeStyle = '#ffe14a'; ctx.lineWidth = 1.5 * unit; // rays
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI * (0.1 + 0.2 * i) - Math.PI * 0.1;
      ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * r * 1.3, y + Math.sin(a) * r * 1.3); ctx.lineTo(x + Math.cos(a) * r * 1.7, y + Math.sin(a) * r * 1.7); ctx.stroke();
    }
    const text = (until - now).toFixed(1);
    ctx.font = `bold ${11 * unit}px monospace`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3 * unit; ctx.strokeStyle = '#000'; ctx.strokeText(text, x + r * 1.9, y); ctx.fillStyle = '#fff'; ctx.fillText(text, x + r * 1.9, y);
    ctx.restore();
  }
}

// 2D overview: the canvas currently carries the world transform, so project through it and draw in device pixels.
export function drawBotDebugWorld(ctx, g, dpr) {
  const m = ctx.getTransform();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const proj = (x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
  drawBotDebug(ctx, g, proj, dpr);
  ctx.restore();
}

export const debugEnabled = (search) => new URLSearchParams(search).has('debug');

const WINDOW = 120;
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const push = (a, v) => { a.push(v); if (a.length > WINDOW) a.shift(); };

const pct = (ms, total) => (total ? `${(100 * ms / total).toFixed(0)}%` : '–').padStart(4);

// Rolling frame/update/draw timings plus a snapshot of game state, drawn as a text overlay.
export function createDebug() {
  const frames = [], updates = [], draws = [], steps = [], overheads = [];
  let lastNow = 0, longFrames = 0, worst = 0, lastReset = 0;
  return {
    frame(now, stepCount, updateMs, drawMs) {
      if (lastNow) {
        const dt = now - lastNow;
        push(frames, dt);
        if (dt > 25) longFrames++;
        worst = Math.max(worst, dt);
      }
      if (now - lastReset > 5000) { worst = 0; lastReset = now; }
      lastNow = now;
      push(steps, stepCount);
      push(updates, updateMs);
      push(draws, drawMs);
    },
    // Time spent producing the overlay itself (lines + drawing), reported by main.js after draw().
    overhead(ms) { push(overheads, ms); },
    lines(g, view) {
      const ft = avg(frames);
      const zonesDone = g.zones.filter((z) => zoneDone(g, z));
      const placed = zonesDone.reduce((s, z) => s + z.count, 0);
      const units = (layers, pens) => layers.length - (pens?.filter((p) => p.barrelPart === 'base').length || 0);
      const total = g.stacks.reduce((s, st) => s + units(st.layers, st.pen), 0) + (g.carried ? units(g.carried, g.carriedPen) : 0);
      const zoneBoxes = g.zones.reduce((s, z) => s + z.count, 0);
      const mem = performance.memory ? `${(performance.memory.usedJSHeapSize / 1048576).toFixed(1)} MB` : 'n/a';
      const E = g.endless;
      const endless = E ? [`endless difficulty: unload rate ${unloadRate(E).toFixed(3)} boxes/s  pace ${interval(E, 12).toFixed(0)} s per 12 boxes  next truck in ${Math.max(0, E.arriveT).toFixed(0)} s  waiting ${E.waiting} boxes  bays ${E.docks.filter((d) => d.state !== 'free').length}/${DOCKS}  trucks ${E.arrived}`] : [];
      return [
        `FPS ${ft ? (1000 / ft).toFixed(0) : '–'}  frame ${ft.toFixed(1)} ms (worst ${worst.toFixed(0)} ms, ${longFrames} > 25 ms)`,
        `update ${avg(updates).toFixed(2)} ms  draw ${avg(draws).toFixed(2)} ms  debug ${avg(overheads).toFixed(2)} ms  steps/frame ${avg(steps).toFixed(1)}`,
        `time share  update ${pct(avg(updates), ft)}  draw ${pct(avg(draws), ft)}  debug ${pct(avg(overheads), ft)}  idle ${pct(Math.max(0, ft - avg(updates) - avg(draws) - avg(overheads)), ft)}`,
        `canvas ${view.width}×${view.height} @${view.dpr}x (${Math.round(view.width * view.dpr)}×${Math.round(view.height * view.dpr)} px)`,
        `boxes in place ${placed}/${zoneBoxes}  zones ${zonesDone.length}/${g.zones.length}  boxes ${total}`,
        `stacks ${g.stacks.length}  carried ${g.carried ? g.carried.length : 0}  walls ${g.walls.length}`,
        `level ${g.level ?? '?'} seed ${g.seed}  ${g.hard ? 'hard' : 'normal'}  H ${g.H}  status ${g.status}  t ${g.time.toFixed(1)}s`,
        `fl x ${g.fl.x.toFixed(2)} y ${g.fl.y.toFixed(2)} a ${g.fl.a.toFixed(2)} v ${g.fl.speed.toFixed(2)}`,
        `score ${score(g)}/${maxScore(g)}  heap ${mem}${view.paused ? '  PAUSED' : ''}`,
        ...endless,
      ];
    },
    draw(ctx, g, view) {
      const lines = this.lines(g, view);
      ctx.save();
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ctx.font = '12px monospace';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20;
      const h = lines.length * 16 + 12;
      const x = view.width - w - 6, y = view.height - h - 6;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#7CFC00';
      lines.forEach((l, i) => ctx.fillText(l, x + 10, y + 7 + i * 16));
      ctx.restore();
    },
  };
}
