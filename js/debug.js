import { zoneDone, score, maxScore } from './game.js';

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
      const total = g.stacks.reduce((s, st) => s + st.layers.length, 0) + (g.carried ? g.carried.reduce((s, l) => s + l.length, 0) : 0);
      const zoneBoxes = g.zones.reduce((s, z) => s + z.count, 0);
      const mem = performance.memory ? `${(performance.memory.usedJSHeapSize / 1048576).toFixed(1)} MB` : 'n/a';
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
