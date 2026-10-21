import { COLORS } from './level.js';
import { FL, toWorld } from './forklift.js';
import { zoneDone } from './game.js';

function rotRect(ctx, cx, cy, a, fn) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(a);
  fn();
  ctx.restore();
}

// Draws a stack: top box colour, plus a coloured number for each box below it.
function drawStack(ctx, layers, x, y, lift = 0) {
  const n = layers.length;
  const size = 1;
  const off = 0.07;
  if (lift > 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(x - size / 2 + 0.1, y - size / 2 + 0.1, size, size);
  }
  const lx = x - lift * 0.04, ly = y - lift * 0.04;
  for (let i = 0; i < n; i++) {
    const bx = lx - size / 2 + i * off * 0.6, by = ly - size / 2 - i * off;
    ctx.fillStyle = COLORS[layers[i]];
    ctx.fillRect(bx, by, size, size);
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 0.05;
    ctx.strokeRect(bx, by, size, size);
    if (i === n - 1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 0.04;
      ctx.strokeRect(bx + 0.12, by + 0.12, size - 0.24, size - 0.24);
    }
  }
  if (n > 1) {
    const tx = lx - size / 2 + (n - 1) * off * 0.6, ty = ly - size / 2 - (n - 1) * off;
    ctx.font = 'bold 0.34px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < n - 1; i++) {
      const col = i % 2, row = Math.floor(i / 2);
      const px = tx + 0.3 + col * 0.4, py = ty + 0.3 + row * 0.4;
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

function drawForklift(ctx, g) {
  const f = g.fl;
  rotRect(ctx, f.x, f.y, f.a, () => {
    // wheels
    drawWheel(ctx, 0, -FL.halfW - 0.02, 0);
    drawWheel(ctx, 0, FL.halfW + 0.02, 0);
    drawWheel(ctx, -FL.L, -FL.halfW + 0.08, -f.steer);
    drawWheel(ctx, -FL.L, FL.halfW - 0.08, -f.steer);
    // body
    ctx.fillStyle = '#f9a825';
    ctx.fillRect(FL.back, -FL.halfW, FL.front - FL.back, FL.halfW * 2);
    ctx.strokeStyle = '#6d4c00';
    ctx.lineWidth = 0.05;
    ctx.strokeRect(FL.back, -FL.halfW, FL.front - FL.back, FL.halfW * 2);
    // counterweight
    ctx.fillStyle = '#555';
    ctx.fillRect(FL.back, -FL.halfW + 0.05, 0.4, FL.halfW * 2 - 0.1);
    // seat & overhead guard
    ctx.fillStyle = '#37474f';
    ctx.fillRect(-0.9, -0.28, 0.5, 0.56);
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 0.06;
    ctx.strokeRect(-1.1, -0.45, 1.0, 0.9);
    // mast
    ctx.fillStyle = '#444';
    ctx.fillRect(FL.front - 0.08, -0.42, 0.16, 0.84);
    // tines (shade shows fork height)
    const shade = Math.round(150 + g.hf * 20);
    ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
    for (const s of [-1, 1]) {
      ctx.fillRect(FL.tineX0, s * FL.tineOff - FL.tineHalf, FL.tineX1 - FL.tineX0, FL.tineHalf * 2);
    }
    // direction marker
    ctx.fillStyle = '#c62828';
    ctx.beginPath();
    ctx.moveTo(-0.1, -0.1); ctx.lineTo(0.2, 0); ctx.lineTo(-0.1, 0.1);
    ctx.fill();
  });
  if (g.carried) {
    const p = toWorld(f, FL.carryX, 0);
    drawStack(ctx, g.carried, p.x, p.y, g.hf);
  }
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

  for (const st of g.stacks) drawStack(ctx, st.layers, st.x, st.y);
  drawForklift(ctx, g);

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

  // fork height gauge
  const gx = width - 70, gy = 70, cell = 26;
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#aaa';
  ctx.fillText('FORKS', gx + 15, gy - 12);
  for (let lvl = 5; lvl >= 0; lvl--) {
    const y = gy + (5 - lvl) * cell;
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    ctx.strokeRect(gx, y, 30, cell - 2);
    ctx.fillStyle = '#aaa';
    ctx.fillText(String(lvl), gx - 10, y + cell / 2);
    if (g.carried && lvl >= g.T && lvl < g.T + g.carried.length) {
      ctx.fillStyle = COLORS[g.carried[lvl - g.T]];
      ctx.fillRect(gx + 3, y + 3, 24, cell - 8);
    }
    if (lvl === g.T) {
      ctx.strokeStyle = '#f9a825';
      ctx.lineWidth = 3;
      ctx.strokeRect(gx - 3, y - 2, 36, cell + 2);
    }
  }

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
