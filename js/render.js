import { COLORS } from './level.js';
import { FL, toWorld } from './forklift.js';
import { zoneDone, stackInZone } from './game.js';

function rotRect(ctx, cx, cy, a, fn) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(a);
  fn();
  ctx.restore();
}

const PX = 0.042, PY = -0.07; // screen shift per unit of height

// Draws a stack whose bottom box is at height z0 above the floor: top box
// colour, plus a coloured number for each box below it.
function drawStack(ctx, layers, x, y, z0 = 0) {
  const n = layers.length;
  const size = 1;
  if (z0 > 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(x - size / 2 + 0.1, y - size / 2 + 0.1, size, size);
  }
  let bx = 0, by = 0;
  for (let i = 0; i < n; i++) {
    bx = x - size / 2 + (z0 + i) * PX;
    by = y - size / 2 + (z0 + i) * PY;
    ctx.fillStyle = COLORS[layers[i]];
    ctx.fillRect(bx, by, size, size);
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 0.05;
    ctx.strokeRect(bx, by, size, size);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 0.04;
  ctx.strokeRect(bx + 0.12, by + 0.12, size - 0.24, size - 0.24);
  if (n > 1) {
    ctx.font = 'bold 0.34px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < n - 1; i++) {
      const col = i % 2, row = Math.floor(i / 2);
      const px = bx + 0.3 + col * 0.4, py = by + 0.3 + row * 0.4;
      ctx.lineWidth = 0.1;
      ctx.strokeStyle = '#000';
      ctx.strokeText(String(i + 1), px, py);
      ctx.fillStyle = COLORS[layers[i]];
      ctx.fillText(String(i + 1), px, py);
    }
  }
}

function drawWheel(ctx, lx, ly, ang) {
  ctx.save();
  ctx.translate(lx, ly);
  ctx.rotate(ang);
  ctx.fillStyle = '#111';
  ctx.fillRect(-0.22, -0.1, 0.44, 0.2);
  ctx.restore();
}

function drawForkliftBody(ctx, g) {
  const f = g.fl;
  rotRect(ctx, f.x, f.y, f.a, () => {
    drawWheel(ctx, 0, -FL.halfW - 0.02, 0);
    drawWheel(ctx, 0, FL.halfW + 0.02, 0);
    drawWheel(ctx, -FL.L, -FL.halfW + 0.08, -f.steer);
    drawWheel(ctx, -FL.L, FL.halfW - 0.08, -f.steer);
    ctx.fillStyle = '#f9a825';
    ctx.fillRect(FL.back, -FL.halfW, FL.front - FL.back, FL.halfW * 2);
    ctx.strokeStyle = '#6d4c00';
    ctx.lineWidth = 0.05;
    ctx.strokeRect(FL.back, -FL.halfW, FL.front - FL.back, FL.halfW * 2);
    ctx.fillStyle = '#555';
    ctx.fillRect(FL.back, -FL.halfW + 0.05, 0.4, FL.halfW * 2 - 0.1);
    ctx.fillStyle = '#37474f';
    ctx.fillRect(-0.9, -0.28, 0.5, 0.56);
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 0.06;
    ctx.strokeRect(-1.1, -0.45, 1.0, 0.9);
    ctx.fillStyle = '#444';
    ctx.fillRect(FL.front - 0.08, -0.42, 0.16, 0.84);
    ctx.fillStyle = '#c62828';
    ctx.beginPath();
    ctx.moveTo(-0.1, -0.1); ctx.lineTo(0.2, 0); ctx.lineTo(-0.1, 0.1);
    ctx.fill();
  });
}

// Tines are drawn at their own height (same parallax as box layers).
function drawTines(ctx, g) {
  const f = g.fl;
  const z = g.hf;
  ctx.save();
  ctx.translate(z * PX, z * PY);
  rotRect(ctx, f.x, f.y, f.a, () => {
    for (const s of [-1, 1]) {
      const y = s * FL.tineOff - FL.tineHalf;
      ctx.fillStyle = '#b0b0b0';
      ctx.fillRect(FL.tineX0, y, FL.tineX1 - FL.tineX0, FL.tineHalf * 2);
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 0.03;
      ctx.strokeRect(FL.tineX0, y, FL.tineX1 - FL.tineX0, FL.tineHalf * 2);
    }
  });
  ctx.restore();
}

function drawCarried(ctx, g) {
  if (!g.carried) return;
  const p = toWorld(g.fl, FL.carryX, 0);
  drawStack(ctx, g.carried, p.x, p.y, g.hf);
}

export function draw(ctx, g, view) {
  const { width, height } = view;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#1b1f23';
  ctx.fillRect(0, 0, width, height);
  const s = Math.min(48, Math.min((width - 40) / g.w, (height - 70) / g.h));
  const ox = (width - g.w * s) / 2, oy = 50 + (height - 70 - g.h * s) / 2;
  ctx.setTransform(s * view.dpr, 0, 0, s * view.dpr, ox * view.dpr, oy * view.dpr);

  ctx.fillStyle = '#c9c4b8';
  ctx.fillRect(0, 0, g.w, g.h);
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 0.03;
  ctx.beginPath();
  for (let x = 0; x <= g.w; x++) { ctx.moveTo(x, 0); ctx.lineTo(x, g.h); }
  for (let y = 0; y <= g.h; y++) { ctx.moveTo(0, y); ctx.lineTo(g.w, y); }
  ctx.stroke();

  for (const z of g.zones) {
    const done = zoneDone(g, z);
    ctx.fillStyle = COLORS[z.color];
    ctx.globalAlpha = done ? 0.75 : 0.4;
    ctx.fillRect(z.x - 0.6, z.y - 0.6, 1.2, 1.2);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = COLORS[z.color];
    ctx.lineWidth = 0.1;
    ctx.setLineDash(done ? [] : [0.2, 0.15]);
    ctx.strokeRect(z.x - 0.6, z.y - 0.6, 1.2, 1.2);
    ctx.setLineDash([]);
    ctx.font = 'bold 0.3px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#000';
    ctx.fillText(`×${z.count}`, z.x, z.y + 0.78);
  }

  // Stacks whose top is below the tines are drawn first; stacks the tines
  // slide under are drawn over them.
  const low = g.stacks.filter((st) => st.layers.length <= g.hf);
  const high = g.stacks.filter((st) => st.layers.length > g.hf);
  for (const st of low) drawStack(ctx, st.layers, st.x, st.y);
  drawForkliftBody(ctx, g);
  drawTines(ctx, g);
  for (const st of high) drawStack(ctx, st.layers, st.x, st.y);
  drawCarried(ctx, g);

  ctx.fillStyle = '#3b3f45';
  for (const w of g.pillars) {
    ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 0.06;
    ctx.strokeRect(w.x, w.y, w.w, w.h);
  }
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 0.3;
  ctx.strokeRect(-0.15, -0.15, g.w + 0.3, g.h + 0.3);

  // screen-space HUD
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  const done = g.zones.filter((z) => zoneDone(g, z)).length;
  ctx.fillStyle = '#eee';
  ctx.font = 'bold 20px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`Level ${g.level}   Zones ${done}/${g.zones.length}   ${g.time.toFixed(0)}s`, 20, 25);

  // fork height gauge: 0 = floor; box layer i fills the cell at height i-1
  const gx = width - 70, gy = 70, cell = 26, top = 5;
  const yOf = (lvl) => gy + (top - lvl) * cell;
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#aaa';
  ctx.fillText('FORKS', gx + 15, gy - 12);
  for (let lvl = top; lvl >= 0; lvl--) {
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    ctx.strokeRect(gx, yOf(lvl), 30, cell - 2);
    ctx.fillStyle = '#aaa';
    ctx.fillText(String(lvl), gx - 10, yOf(lvl) + cell / 2);
  }
  const cellBox = (lvl, color, alpha) => {
    if (lvl > top) return;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = COLORS[color];
    ctx.fillRect(gx + 3, yOf(lvl) + 3, 24, cell - 8);
    ctx.globalAlpha = 1;
  };
  const under = stackInZone(g);
  if (under) under.layers.forEach((c, i) => cellBox(i, c, 0.85));
  if (g.carried) g.carried.forEach((c, i) => cellBox(g.H + i, c, 1));
  ctx.strokeStyle = '#f9a825';
  ctx.lineWidth = 3;
  ctx.strokeRect(gx - 3, yOf(g.H) - 2, 36, cell + 2);
  ctx.fillStyle = '#f9a825';
  ctx.fillRect(gx + 34, yOf(g.H) + cell / 2 - 3, 8, 4);

  if (g.status === 'won') {
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, height / 2 - 60, width, 120);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText('Level complete!', width / 2, height / 2 - 14);
    ctx.font = '20px sans-serif';
    ctx.fillText('Press Enter for the next level', width / 2, height / 2 + 28);
  }
}
