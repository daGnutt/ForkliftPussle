import { COLORS } from './level.js';
import { FL, toWorld } from './forklift.js';
import { drawPov } from './pov.js';
import { theme } from './theme.js';
import { floorDecals } from './decals.js';
import { carriedWorldOffs, HIT_LIFE, zoneDone, stackInZone, score, maxScore, lostBreakdown, isSolved, scoreEnough, isParked } from './game.js';

function rotRect(ctx, cx, cy, a, fn) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(a);
  fn();
  ctx.restore();
}

const PX = 0.06, PY = -0.1; // screen shift per unit of height

// Draws a stack whose bottom box is at height z0 above the floor: top box
// colour, plus a coloured number for each box below it.
function drawStack(ctx, layers, x, y, z0 = 0, rots = [], offs = []) {
  const n = layers.length;
  const size = 1, h = size / 2;
  const at = (cx, cy, i, fn) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rots[i] || 0);
    fn();
    ctx.restore();
  };
  if (z0 > 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    at(x + (offs[0]?.x || 0) + 0.1, y + (offs[0]?.y || 0) + 0.1, 0, () => ctx.fillRect(-h, -h, size, size));
  }
  const cx = x + (offs[n - 1]?.x || 0) + (z0 + n - 1) * PX, cy = y + (offs[n - 1]?.y || 0) + (z0 + n - 1) * PY;
  for (let i = 0; i < n; i++) {
    at(x + (offs[i]?.x || 0) + (z0 + i) * PX, y + (offs[i]?.y || 0) + (z0 + i) * PY, i, () => {
      const col = COLORS[layers[i]];
      const a = rots[i] || 0, ca = Math.cos(a), sa = Math.sin(a);
      // extrusion towards the floor, expressed in the box's local frame
      const ex = -PX * ca - PY * sa, ey = PX * sa - PY * ca;
      const edges = [[0, -1, -h, -h, h, -h], [1, 0, h, -h, h, h], [0, 1, h, h, -h, h], [-1, 0, -h, h, -h, -h]];
      ctx.lineJoin = 'round';
      for (const [nx, ny, x1, y1, x2, y2] of edges) {
        if (nx * ex + ny * ey <= 0) continue;
        const wx = nx * ca - ny * sa, wy = nx * sa + ny * ca; // world normal
        const shade = 0.5 - 0.25 * (wx * 0.6 - wy * 0.8);
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        ctx.lineTo(x2 + ex, y2 + ey); ctx.lineTo(x1 + ex, y1 + ey);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = `rgba(0,0,0,${shade})`;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.65)';
        ctx.lineWidth = 0.04;
        ctx.stroke();
      }
      ctx.fillStyle = col;
      ctx.fillRect(-h, -h, size, size);
      const gr = ctx.createLinearGradient(-h, -h, h, h);
      gr.addColorStop(0, 'rgba(255,255,255,0.35)');
      gr.addColorStop(1, 'rgba(0,0,0,0.18)');
      ctx.fillStyle = gr;
      ctx.fillRect(-h, -h, size, size);
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.lineWidth = 0.05;
      ctx.strokeRect(-h, -h, size, size);
      // tape strip across the lid
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(-0.07, -h, 0.14, size);
    });
  }
  at(cx, cy, n - 1, () => {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 0.04;
    ctx.strokeRect(-h + 0.12, -h + 0.12, size - 0.24, size - 0.24);
    if (n > 1) {
      ctx.font = 'bold 0.34px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < n - 1; i++) {
        const col = i % 2, row = Math.floor(i / 2);
        const px = -h + 0.3 + col * 0.4, py = -h + 0.3 + row * 0.4;
        ctx.lineWidth = 0.1;
        ctx.strokeStyle = '#000';
        ctx.strokeText(String(i + 1), px, py);
        ctx.fillStyle = COLORS[layers[i]];
        ctx.fillText(String(i + 1), px, py);
      }
    }
  });
}

// Extruded box in the forklift's local frame between heights z0 and z1,
// using the same parallax as the box layers.
function block(ctx, f, x0, y0, x1, y1, z0, z1, col, rot = 0) {
  const ca = Math.cos(f.a), sa = Math.sin(f.a);
  const dz = z1 - z0;
  // floor-ward extrusion in the local frame
  const ex = (-PX * ca - PY * sa) * dz, ey = (PX * sa - PY * ca) * dz;
  ctx.save();
  ctx.translate(f.x + z1 * PX, f.y + z1 * PY);
  ctx.rotate(f.a + rot);
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const lx = ex * cr + ey * sr, ly = -ex * sr + ey * cr;
  const edges = [[0, -1, x0, y0, x1, y0], [1, 0, x1, y0, x1, y1], [0, 1, x1, y1, x0, y1], [-1, 0, x0, y1, x0, y0]];
  ctx.lineJoin = 'round';
  for (const [nx, ny, ax, ay, bx, by] of edges) {
    if (nx * lx + ny * ly <= 0) continue;
    const wx = nx * Math.cos(f.a + rot) - ny * Math.sin(f.a + rot);
    const wy = nx * Math.sin(f.a + rot) + ny * Math.cos(f.a + rot);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    ctx.lineTo(bx + lx, by + ly); ctx.lineTo(ax + lx, ay + ly);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = `rgba(0,0,0,${0.5 - 0.25 * (wx * 0.6 - wy * 0.8)})`;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 0.025;
    ctx.stroke();
  }
  ctx.fillStyle = col;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  const gr = ctx.createLinearGradient(x0, y0, x1, y1);
  gr.addColorStop(0, 'rgba(255,255,255,0.3)');
  gr.addColorStop(1, 'rgba(0,0,0,0.15)');
  ctx.fillStyle = gr;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 0.03;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.restore();
}

function drawWheel(ctx, f, lx, ly, ang) {
  const c = Math.cos(f.a), s = Math.sin(f.a);
  const w = { x: f.x + lx * c - ly * s, y: f.y + lx * s + ly * c, a: f.a + ang };
  block(ctx, w, -0.22, -0.1, 0.22, 0.1, 0, 0.32, '#1c1c1c');
}

function drawForkliftBody(ctx, g) {
  const f = g.fl;
  const W = FL.halfW;
  // ground shadow
  rotRect(ctx, f.x + 0.08, f.y + 0.1, f.a, () => {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(FL.back, -W, FL.front - FL.back, W * 2);
  });
  drawWheel(ctx, f, 0, -W - 0.02, 0);
  drawWheel(ctx, f, 0, W + 0.02, 0);
  drawWheel(ctx, f, -FL.L, -W + 0.08, -f.steer);
  drawWheel(ctx, f, -FL.L, W - 0.08, -f.steer);
  // chassis, rear counterweight, hood, seat
  block(ctx, f, FL.back, -W, FL.front, W, 0.15, 0.5, '#f9a825');
  block(ctx, f, FL.back, -W, FL.back + 0.55, W, 0.5, 0.85, '#8d6e63');
  block(ctx, f, -0.75, -0.4, -0.1, 0.4, 0.5, 0.62, '#37474f');
  block(ctx, f, -1.2, -0.3, -0.85, 0.3, 0.5, 0.78, '#263238');
  // mast uprights at the front
  for (const s of [-1, 1]) block(ctx, f, FL.front - 0.12, s * 0.38 - 0.06, FL.front + 0.02, s * 0.38 + 0.06, 0.5, 1.5, '#555');
  block(ctx, f, FL.front - 0.12, -0.38, FL.front + 0.02, 0.38, 1.3, 1.5, '#444');
  // overhead guard: four posts and a roof
  for (const px of [-1.1, -0.05]) for (const s of [-1, 1]) {
    block(ctx, f, px - 0.04, s * 0.42 - 0.04, px + 0.04, s * 0.42 + 0.04, 0.5, 1.15, '#37474f');
  }
  block(ctx, f, -1.2, -0.5, 0.05, 0.5, 1.15, 1.25, '#f9a825');
  ctx.save();
  ctx.translate(f.x + 1.25 * PX, f.y + 1.25 * PY);
  ctx.rotate(f.a);
  ctx.fillStyle = '#c62828';
  ctx.beginPath();
  ctx.moveTo(-0.1, -0.1); ctx.lineTo(0.2, 0); ctx.lineTo(-0.1, 0.1);
  ctx.fill();
  ctx.restore();
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
      ctx.fillStyle = theme().tine;
      ctx.fillRect(FL.tineX0, y, FL.tineX1 - FL.tineX0, FL.tineHalf * 2);
      ctx.strokeStyle = theme().tineEdge;
      ctx.lineWidth = 0.03;
      ctx.strokeRect(FL.tineX0, y, FL.tineX1 - FL.tineX0, FL.tineHalf * 2);
    }
  });
  ctx.restore();
}

function drawCarried(ctx, g) {
  if (!g.carried) return;
  const p = toWorld(g.fl, FL.carryX, 0);
  drawStack(ctx, g.carried, p.x, p.y, g.hf, g.carriedRots.map((r) => r + g.fl.a), carriedWorldOffs(g));
}

// Draws the top-down overview scaled into the screen rect (rx, ry, rw, rh).
function drawOverview(ctx, g, view, rx, ry, rw, rh, maxScale) {
  const s = Math.min(maxScale, rw / g.w, rh / g.h);
  const ox = rx + (rw - g.w * s) / 2, oy = ry + (rh - g.h * s) / 2;
  ctx.setTransform(s * view.dpr, 0, 0, s * view.dpr, ox * view.dpr, oy * view.dpr);
  drawWorld(ctx, g);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 0.55px sans-serif';
  ctx.lineWidth = 0.1;
  for (const h of g.hits || []) {
    const k = (g.time - h.t) / HIT_LIFE;
    const x = h.x + h.z * PX, y = h.y + h.z * PY - k * 1.2;
    ctx.globalAlpha = Math.max(0, 1 - k * k);
    ctx.strokeStyle = '#000';
    ctx.strokeText(`−${h.pts}`, x, y);
    ctx.fillStyle = '#ff5252';
    ctx.fillText(`−${h.pts}`, x, y);
  }
  ctx.globalAlpha = 1;
}

// Top-down world in simulation units; the caller sets the transform.
function drawWorld(ctx, g) {
  ctx.fillStyle = theme().floor;
  ctx.fillRect(0, 0, g.w, g.h);
  ctx.strokeStyle = theme().grid;
  ctx.lineWidth = 0.03;
  ctx.beginPath();
  for (let x = 0; x <= g.w; x++) { ctx.moveTo(x, 0); ctx.lineTo(x, g.h); }
  for (let y = 0; y <= g.h; y++) { ctx.moveTo(0, y); ctx.lineTo(g.w, y); }
  ctx.stroke();

  for (const d of floorDecals(0, 0, g.w, g.h, g.w, g.h)) {
    ctx.fillStyle = d.fill;
    ctx.beginPath();
    d.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.fill();
  }

  for (const a of g.areas) {
    ctx.fillStyle = COLORS[a.color];
    ctx.globalAlpha = 0.12;
    ctx.fillRect(a.x - 0.3, a.y - 0.3, a.w + 0.6, a.h + 0.6);
    ctx.globalAlpha = 1;
  }

  {
    const p = g.parking, ok = isSolved(g) && scoreEnough(g);
    const hx = (FL.front - FL.back) / 2 + 0.2, hy = FL.halfW + 0.2;
    rotRect(ctx, p.x, p.y, p.a, () => {
      ctx.fillStyle = ok ? '#66bb6a' : '#9e9e9e';
      ctx.globalAlpha = isParked(g) && ok ? 0.5 : 0.22;
      ctx.fillRect(-hx, -hy, 2 * hx, 2 * hy);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = ok ? '#66bb6a' : '#bdbdbd';
      ctx.lineWidth = 0.08;
      ctx.setLineDash([0.25, 0.15]);
      ctx.strokeRect(-hx, -hy, 2 * hx, 2 * hy);
      ctx.setLineDash([]);
      ctx.fillStyle = ok ? '#66bb6a' : '#bdbdbd';
      ctx.font = 'bold 0.8px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('P', 0, 0);
      if (ok) {
        ctx.beginPath();
        ctx.moveTo(hx - 0.15, 0);
        ctx.lineTo(hx - 0.75, -0.45);
        ctx.lineTo(hx - 0.75, 0.45);
        ctx.closePath();
        ctx.fill();
      }
    });
  }

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
  for (const st of low) drawStack(ctx, st.layers, st.x, st.y, 0, st.rots, st.offs);
  drawForkliftBody(ctx, g);
  drawTines(ctx, g);
  for (const st of high) drawStack(ctx, st.layers, st.x, st.y, 0, st.rots, st.offs);
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
}

// Mirror showing the area around the forklift, rotated so the forklift's heading is up.
function drawProximityMirror(ctx, g, view, x, y, w, h) {
  const scale = w / 4.5;
  const c = toWorld(g.fl, (FL.front - FL.back) / 2, 0);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = theme().bg;
  ctx.fillRect(x, y, w, h);
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate(-Math.PI / 2 - g.fl.a);
  ctx.scale(scale, scale);
  ctx.translate(-c.x, -c.y);
  drawWorld(ctx, g);
  ctx.restore();
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('SIDE MIRROR', x + 6, y + 5);
}

export function draw(ctx, g, view) {
  const { width, height } = view;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = theme().bg;
  ctx.fillRect(0, 0, width, height);
  const POV_W = 300, POV_H = 170, hx0 = view.showSmall ? 20 + POV_W + 16 : 20;
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  if (view.povBig) {
    drawPov(ctx, g, 0, 0, width, height);
    const mw = Math.min(340, width * 0.3);
    drawPov(ctx, g, (width - mw) / 2, 8, mw, mw * 0.28, { rear: true });
    drawProximityMirror(ctx, g, view, width - 70 - 20 - 190, 8, 190, 150);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    if (view.showSmall) {
      ctx.fillStyle = theme().bg;
      ctx.fillRect(10, 10, POV_W, POV_H);
      ctx.save();
      ctx.beginPath();
      ctx.rect(10, 10, POV_W, POV_H);
      ctx.clip();
      drawOverview(ctx, g, view, 10, 10, POV_W, POV_H, 48);
      ctx.restore();
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 3;
      ctx.strokeRect(10, 10, POV_W, POV_H);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(hx0 - 8, 8, 560, 94);
  } else {
    drawOverview(ctx, g, view, 20, 50, width - 40, height - 70, 48);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    if (view.showSmall) drawPov(ctx, g, 10, 10, POV_W, POV_H);
  }
  // screen-space HUD
  const done = g.zones.filter((z) => zoneDone(g, z)).length;
  ctx.fillStyle = '#eee';
  ctx.font = 'bold 20px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`Level ${g.level}${g.seed ? ` (seed ${g.seed})` : ''}   Zones ${done}/${g.zones.length}   Score ${score(g)}/${maxScore(g)}   ${g.time.toFixed(0)}s`, hx0, 25);
  const best = view.best;
  ctx.font = '14px sans-serif';
  ctx.fillStyle = '#b3e5fc';
  ctx.fillText(best ? `Best ${best.score} by ${best.name} (${best.time}s)` : 'Best: none yet', hx0 + 380, 48);
  const lost = lostBreakdown(g);
  ctx.font = '14px sans-serif';
  ctx.fillStyle = '#ef9a9a';
  ctx.fillText(`Damage −${lost.crash} (locked)`, hx0, 48);
  ctx.fillStyle = '#ffe082';
  ctx.fillText(`Placement −${lost.square} (fixable)`, hx0, 68);
  ctx.fillStyle = '#eee';

  if (g.status === 'play' && isSolved(g)) {
    ctx.font = 'bold 16px sans-serif';
    ctx.fillStyle = '#ffe082';
    ctx.fillText(scoreEnough(g) ? 'All zones filled – return to the parking spot (P)' : 'Score is below 50% – fix damage/placement to finish', hx0, 92);
  }

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

  if (view.paused) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, width, height);
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
