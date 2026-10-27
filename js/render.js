import { COLORS } from './level.js';
import { FL, toWorld } from './forklift.js';
import { reverseLight } from './revlight.js';
import { drawPov } from './pov.js';
import { formatTime, timePenalty, finalScore } from './highscores.js';
import { theme } from './theme.js';
import { decalsEnabled, floorDecals, boxDecalKind, boxDecalShapes } from './decals.js';
import { carriedWorldOffs, HIT_LIFE, zoneDone, stackInZone, score, maxScore, lostBreakdown, isSolved, scoreEnough, isParked } from './game.js';

// Gradients are interpreted in the coordinate space at fill time, so they can be cached and reused (creating
// them every frame for every box is slow in Firefox).
const gradCache = new Map();
function shadeGradient(ctx, x0, y0, x1, y1, hi, lo) {
  const key = `${x0},${y0},${x1},${y1},${hi},${lo}`;
  let gr = gradCache.get(key);
  if (!gr) {
    if (gradCache.size > 200) gradCache.clear();
    gr = ctx.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, `rgba(255,255,255,${hi})`);
    gr.addColorStop(1, `rgba(0,0,0,${lo})`);
    gradCache.set(key, gr);
  }
  return gr;
}

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
function drawStack(ctx, layers, x, y, z0 = 0, rots = [], offs = [], pens = []) {
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
      ctx.fillStyle = shadeGradient(ctx, -h, -h, h, h, 0.35, 0.18);
      ctx.fillRect(-h, -h, size, size);
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.lineWidth = 0.05;
      ctx.strokeRect(-h, -h, size, size);
      // tape strip across the lid
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(-0.07, -h, 0.14, size);
      if (decalsEnabled()) {
        for (const d of boxDecalShapes(pens[i]?.deco ?? boxDecalKind(layers[i], i))) {
          ctx.fillStyle = d.fill;
          ctx.beginPath();
          d.pts.forEach(([u, v], k) => (k ? ctx.lineTo(u * 0.4, -v * 0.4) : ctx.moveTo(u * 0.4, -v * 0.4)));
          ctx.fill();
        }
      }
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
  ctx.fillStyle = shadeGradient(ctx, x0, y0, x1, y1, 0.3, 0.15);
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
  drawStack(ctx, g.carried, p.x, p.y, g.hf, g.carriedRots.map((r) => r + g.fl.a), carriedWorldOffs(g), g.carriedPen);
}

// Draws the top-down overview scaled into the screen rect (rx, ry, rw, rh).
// With `follow`, a map that would be drawn smaller than MIN_FOLLOW_SCALE px/tile is shown at that scale instead,
// centred on the forklift and clamped to the map edges; the returned `cam` is the visible world rect (else null).
const MIN_FOLLOW_SCALE = 30;
const PAN_MARGIN = 2;
function drawOverview(ctx, g, view, rx, ry, rw, rh, maxScale, follow = false) {
  const fit = Math.min(maxScale, rw / g.w, rh / g.h);
  const zoomed = follow && fit < MIN_FOLLOW_SCALE;
  const s = zoomed ? MIN_FOLLOW_SCALE : fit;
  let ox = rx + (rw - g.w * s) / 2, oy = ry + (rh - g.h * s) / 2;
  let cam = null;
  if (zoomed) {
    const c = toWorld(g.fl, (FL.front - FL.back) / 2, 0);
    // On touch the camera may pan up to PAN_MARGIN tiles past the map edge so edge content can leave the controls' area.
    const m = view.touch ? PAN_MARGIN : 0;
    const axis = (pos, size, len, r0) => (len * s <= size - 2 * m * s ? r0 + (size - len * s) / 2 : r0 + size / 2 - Math.min(Math.max(pos, size / 2 / s - m), len - size / 2 / s + m) * s);
    ox = axis(c.x, rw, g.w, rx);
    oy = axis(c.y, rh, g.h, ry);
    cam = { x: (rx - ox) / s, y: (ry - oy) / s, w: rw / s, h: rh / s };
    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();
  }
  ctx.setTransform(s * view.dpr, 0, 0, s * view.dpr, ox * view.dpr, oy * view.dpr);
  drawWorld(ctx, g);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 0.55px sans-serif';
  ctx.lineWidth = 0.1;
  for (const h of g.hits || []) {
    const k = (g.clock - h.t) / HIT_LIFE;
    const x = h.x + h.z * PX, y = h.y + h.z * PY - k * 1.2;
    ctx.globalAlpha = Math.max(0, 1 - k * k);
    ctx.strokeStyle = '#000';
    ctx.strokeText(`−${h.pts}`, x, y);
    ctx.fillStyle = '#ff5252';
    ctx.fillText(`−${h.pts}`, x, y);
  }
  ctx.globalAlpha = 1;
  if (zoomed) ctx.restore();
  return cam;
}

// Very basic whole-map overview (walls, drop points, boxes, parking, forklift, visible area) for the zoomed-in overview.
function miniSize(g, maxW, maxH) {
  const s = Math.min(maxW / g.w, maxH / g.h);
  return { s, w: g.w * s, h: g.h * s };
}
function drawMiniMap(ctx, g, cam, x, y, s) {
  const w = g.w * s, h = g.h * s;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(-3, -3, w + 6, h + 6);
  ctx.fillStyle = theme().floor;
  ctx.fillRect(0, 0, w, h);
  for (const z of g.zones) {
    ctx.fillStyle = COLORS[z.color];
    ctx.globalAlpha = zoneDone(g, z) ? 1 : 0.5;
    ctx.fillRect((z.x - 0.6) * s, (z.y - 0.6) * s, 1.2 * s, 1.2 * s);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#9e9e9e';
  ctx.fillRect((g.parking.x - 0.8) * s - 1, (g.parking.y - 0.8) * s - 1, 1.6 * s + 2, 1.6 * s + 2);
  ctx.fillStyle = '#3b3f45';
  for (const q of g.pillars) ctx.fillRect(q.x * s, q.y * s, Math.max(1.5, q.w * s), Math.max(1.5, q.h * s));
  const dot = Math.max(3, s * 0.9);
  for (const st of g.stacks) {
    ctx.fillStyle = COLORS[st.layers[st.layers.length - 1]];
    ctx.fillRect(st.x * s - dot / 2, st.y * s - dot / 2, dot, dot);
  }
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(g.fl.x * s, g.fl.y * s, Math.max(3, s * 0.7), 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = '#f9a825';
  ctx.strokeRect(cam.x * s, cam.y * s, cam.w * s, cam.h * s);
  ctx.restore();
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

  for (const d of decalsEnabled() ? floorDecals(g) : []) {
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

  const rl = reverseLight(g);
  if (rl) {
    ctx.fillStyle = '#2979ff';
    ctx.globalAlpha = 0.45 + 0.2 * Math.sin(g.clock * 14);
    ctx.beginPath();
    rl.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.fill();
    ctx.globalAlpha = 1;
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
    ctx.font = 'bold 0.5px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 0.1;
    ctx.strokeStyle = '#fff';
    ctx.strokeText(`×${z.count}`, z.x, z.y + 0.92);
    ctx.fillStyle = '#000';
    ctx.fillText(`×${z.count}`, z.x, z.y + 0.92);
  }

  // Stacks whose top is below the tines are drawn first; stacks the tines
  // slide under are drawn over them.
  const low = g.stacks.filter((st) => st.layers.length <= g.hf);
  const high = g.stacks.filter((st) => st.layers.length > g.hf);
  for (const st of low) drawStack(ctx, st.layers, st.x, st.y, 0, st.rots, st.offs, st.pen);
  drawForkliftBody(ctx, g);
  drawTines(ctx, g);
  for (const st of high) drawStack(ctx, st.layers, st.x, st.y, 0, st.rots, st.offs, st.pen);
  drawCarried(ctx, g);

  ctx.fillStyle = '#3b3f45';
  for (const w of g.pillars) {
    ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 0.06;
    ctx.strokeRect(w.x, w.y, w.w, w.h);
  }
  if (g.charger) drawCharger(ctx, g.charger);
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 0.3;
  ctx.strokeRect(-0.15, -0.15, g.w + 0.3, g.h + 0.3);
}

// The truck charger: a red block with a high-voltage warning sign (a bolt in a yellow triangle).
function drawCharger(ctx, c) {
  ctx.fillStyle = '#c62828';
  ctx.fillRect(c.x, c.y, c.w, c.h);
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 0.06;
  ctx.strokeRect(c.x, c.y, c.w, c.h);
  const cx = c.x + c.w / 2, cy = c.y + c.h / 2, r = Math.min(c.w, c.h) * 0.38;
  ctx.fillStyle = '#f4c414';
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r * 0.95, cy + r * 0.6);
  ctx.lineTo(cx - r * 0.95, cy + r * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath();
  ctx.moveTo(cx + r * 0.15, cy - r * 0.45);
  ctx.lineTo(cx - r * 0.3, cy + r * 0.15);
  ctx.lineTo(cx, cy + r * 0.15);
  ctx.lineTo(cx - r * 0.15, cy + r * 0.5);
  ctx.lineTo(cx + r * 0.3, cy - r * 0.1);
  ctx.lineTo(cx, cy - r * 0.1);
  ctx.closePath();
  ctx.fill();
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

// Landscape touch: status text on both sides of the minimap, between the control pads.
function drawStatusStrip(ctx, g, view, mm, title, bestText, hint, width, height) {
  const PAD = 156, lost = lostBreakdown(g);
  const done = g.zones.filter((z) => zoneDone(g, z)).length;
  const bottom = height - 10, lh = 17;
  const line = (text, x, row, color, align, w, bold) => {
    ctx.font = `${bold ? 'bold ' : ''}13px sans-serif`;
    ctx.textAlign = align;
    ctx.fillStyle = color;
    ctx.fillText(text, x, bottom - row * lh, w);
  };
  ctx.textBaseline = 'middle';
  const lx = mm.x - 8, rx = mm.x + mm.w + 8;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(PAD - 4, bottom - 3 * lh - 9, lx - PAD + 4, 3 * lh + 14);
  ctx.fillRect(rx - 4, bottom - 3 * lh - 9, width - PAD - rx + 8, 3 * lh + 14);
  const lw = lx - PAD, rw = width - PAD - rx;
  line(`Level ${g.level}${g.seed ? ` (seed ${g.seed})` : ''}`, lx, 2, '#eee', 'right', lw, true);
  line(`Zones ${done}/${g.zones.length}   Score ${score(g)}/${maxScore(g)}`, lx, 1, '#eee', 'right', lw);
  line(formatTime(g.time), lx, 0, '#eee', 'right', lw);
  line(bestText, rx, 2, '#b3e5fc', 'left', rw);
  line(`Damage −${lost.crash} (locked)`, rx, 1, '#ef9a9a', 'left', rw);
  line(`Placement −${lost.square} (fixable)`, rx, 0, '#ffe082', 'left', rw);
  if (hint) {
    ctx.font = 'bold 14px sans-serif';
    const tw = Math.min(width - 2 * PAD, ctx.measureText(hint).width);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect((width - tw) / 2 - 6, mm.y - 28, tw + 12, 22);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffe082';
    ctx.fillText(hint, width / 2, mm.y - 17, width - 2 * PAD);
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = '#eee';
}

export function draw(ctx, g, view) {
  const { width, height } = view;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = theme().bg;
  ctx.fillRect(0, 0, width, height);
  const strip = view.touch && !view.povBig && width > height;
  let mmBox = null;
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
  } else {
    // On touch the control buttons take the bottom 208px (two 84px fork buttons + gap + margin), so the field ends above them.
    // In landscape the buttons are smaller (see style.css): steering bottom left, drive/forks bottom right, a small minimap
    // between them; the field extends down between the pads and the (translucent) pads overlay its bottom corners.
    const portrait = height > width;
    const mm = miniSize(g, portrait ? Math.min(220, width - 40) : 180, portrait ? 110 : 140);
    if (strip) Object.assign(mm, miniSize(g, 120, 70));
    const bottom = strip ? mm.h + 16 : view.touch ? 208 : 20;
    let rx = 20, ry = strip ? 8 : 50, rw = width - 40, rh = height - ry - bottom;
    // When the map doesn't fit, reserve room for the minimap (above the field in portrait, left of it in landscape)
    // so it never covers the playing field.
    // Touch landscape: keep the field clear of the fork gauge at the right edge even when the whole map fits.
    if (view.touch && !portrait) rw = width - rx - 90;
    const zoomedIn = Math.min(48, rw / g.w, rh / g.h) < MIN_FOLLOW_SCALE;
    let mmX = 13, mmY = (view.showSmall ? 190 : 100) + 6;
    if (strip) {
      mmX = (width - mm.w) / 2;
      mmY = height - 8 - mm.h;
      mmBox = { x: mmX, w: mm.w, y: mmY };
    } else if (zoomedIn) {
      if (portrait) { ry = Math.max(ry, mmY + mm.h + 12); rh = height - ry - bottom; }
      else { rx = mmX + mm.w + 16; rw = width - rx - 90; }
    }
    const cam = drawOverview(ctx, g, view, rx, ry, rw, rh, 48, true);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    if (strip || cam) drawMiniMap(ctx, g, cam || { x: 0, y: 0, w: g.w, h: g.h }, mmX, mmY, mm.s);
    if (view.showSmall) drawPov(ctx, g, 10, 10, POV_W, POV_H);
  }
  // screen-space HUD
  const done = g.zones.filter((z) => zoneDone(g, z)).length;
  const best = view.best;
  const title = `Level ${g.level}${g.seed ? ` (seed ${g.seed})` : ''}   Zones ${done}/${g.zones.length}   Score ${score(g)}/${maxScore(g)}   ${formatTime(g.time)}`;
  const bestText = best ? `Best ${best.score} by ${best.name} (${formatTime(best.time)})` : 'Best: none yet';
  const hint = g.status === 'play' && isSolved(g)
    ? (scoreEnough(g) ? 'All zones filled – return to the parking spot (P)' : 'Score is below 50% – fix damage/placement to finish')
    : '';
  if (mmBox) drawStatusStrip(ctx, g, view, mmBox, title, bestText, hint, width, height);
  else {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 20px sans-serif';
    let boxW = ctx.measureText(title).width;
    ctx.font = '14px sans-serif';
    boxW = Math.max(boxW, 380 + ctx.measureText(bestText).width);
    ctx.font = 'bold 16px sans-serif';
    if (hint) boxW = Math.max(boxW, ctx.measureText(hint).width);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(hx0 - 8, 8, boxW + 16, hint ? 102 : 84);
    ctx.fillStyle = '#eee';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(title, hx0, 25);
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#b3e5fc';
    ctx.fillText(bestText, hx0 + 380, 48);
    const lost = lostBreakdown(g);
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#ef9a9a';
    ctx.fillText(`Damage −${lost.crash} (locked)`, hx0, 48);
    ctx.fillStyle = '#ffe082';
    ctx.fillText(`Placement −${lost.square} (fixable)`, hx0, 68);
    ctx.fillStyle = '#eee';

    if (hint) {
      ctx.font = 'bold 16px sans-serif';
      ctx.fillStyle = '#ffe082';
      ctx.fillText(hint, hx0, 92);
    }
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
    const lost = lostBreakdown(g);
    const pts = score(g);
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, height / 2 - 110, width, 220);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText('Level complete!', width / 2, height / 2 - 64);
    ctx.font = '18px sans-serif';
    ctx.fillText(`Boxes in zones: ${pts + lost.crash + lost.square} − crashes ${lost.crash} − squareness ${lost.square} = ${pts}`, width / 2, height / 2 - 28);
    ctx.fillText(`Time ${formatTime(g.time)}: −${timePenalty(g.time)} (1 point per 10 s)`, width / 2, height / 2 - 2);
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(`Final score: ${finalScore(pts, g.time)}`, width / 2, height / 2 + 30);
    ctx.font = '20px sans-serif';
    ctx.fillText(view.touch ? 'Tap to continue to the next level' : 'Press Enter for the next level', width / 2, height / 2 + 70);
  }
}
