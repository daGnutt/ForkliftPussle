import { COLORS } from './level.js';
import { FL, toWorld, truckColor } from './forklift.js';
import { topShapes, DENT_FILL, DENT_LINE } from './dents.js';
import { reverseLight } from './revlight.js';
import { drawPov } from './pov.js';
import { labelRows, hitRows, honkers, drawHonk } from './pov/overlay.js';
import { chaseTiles as chaseTilesFor, clearChaseTilt, CHASE_TILT, headTurn } from './gl/camera.js';
import { beginGlFrame } from './gl/renderer.js';
import { drawPov3d, drawOverview3d, drawLook3d } from './gl/views.js';
import { formatTime, timePenalty, finalScore } from './highscores.js';
import { theme } from './theme.js';
import { discoOn, drawDiscoSpots } from './disco.js';
import { decalsEnabled, floorDecals, boxDecalKind, boxDecalShapes } from './decals.js';
import { carriedWorldOffs, hitLife, zoneDone, zoneLabelPos, stackInZone, score, maxScore, lostBreakdown, isSolved, scoreEnough, isParked, otherTrucks, isGhost } from './game.js';

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

// Draws the visible side faces of an extruded rectangle in local coordinates. edges: [nx, ny, x1, y1, x2, y2];
// (ex, ey) is the floor-ward extrusion and `ang` the local frame's world rotation (for shading).
function extrudeSides(ctx, edges, ex, ey, ang, col, stroke, lw) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  ctx.lineJoin = 'round';
  for (const [nx, ny, x1, y1, x2, y2] of edges) {
    if (nx * ex + ny * ey <= 0) continue;
    const wx = nx * ca - ny * sa, wy = nx * sa + ny * ca; // world normal
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.lineTo(x2 + ex, y2 + ey); ctx.lineTo(x1 + ex, y1 + ey);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = `rgba(0,0,0,${0.5 - 0.25 * (wx * 0.6 - wy * 0.8)})`;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
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
      extrudeSides(ctx, edges, ex, ey, a, col, 'rgba(0,0,0,0.65)', 0.04);
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
      if (pens[i]?.dent) {
        for (const poly of topShapes(pens[i], i + Math.round(layers[i] * 7))) {
          ctx.beginPath();
          poly.forEach(([u, v], k) => (k ? ctx.lineTo(u, v) : ctx.moveTo(u, v)));
          ctx.closePath();
          ctx.fillStyle = DENT_FILL;
          ctx.globalAlpha = 0.6;
          ctx.fill();
          ctx.globalAlpha = 0.7;
          ctx.strokeStyle = DENT_LINE;
          ctx.lineWidth = 0.025;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
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
  extrudeSides(ctx, edges, lx, ly, f.a + rot, col, 'rgba(0,0,0,0.55)', 0.025);
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
  const pal = truckColor(g.truck.color);
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
  block(ctx, f, FL.back, -W, FL.front, W, 0.15, 0.5, pal.body);
  block(ctx, f, FL.back, -W, FL.back + 0.55, W, 0.5, 0.85, pal.counter);
  // mast uprights at the front
  for (const s of [-1, 1]) block(ctx, f, FL.front - 0.12, s * 0.38 - 0.06, FL.front + 0.02, s * 0.38 + 0.06, 0.5, 1.5, '#555');
  block(ctx, f, FL.front - 0.12, -0.38, FL.front + 0.02, 0.38, 1.3, 1.5, '#555');
  // overhead guard: four posts, a dark roof and a cream seat panel (as on the splash screen)
  for (const px of [-1.1, -0.05]) for (const s of [-1, 1]) {
    block(ctx, f, px - 0.04, s * 0.42 - 0.04, px + 0.04, s * 0.42 + 0.04, 0.5, 1.15, '#37474f');
  }
  block(ctx, f, -1.2, -0.5, 0.05, 0.5, 1.15, 1.25, pal.roof);
  block(ctx, f, -1.0, -0.33, -0.1, 0.33, 1.25, 1.27, '#fff3c4');
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
const GAUGE_W = 90;
const PAD_H = 144; // landscape touch pad height incl. margin
function drawOverview(ctx, g, view, rx, ry, rw, rh, maxScale, follow = false, panRight = 0, panBottom = 0) {
  const fit = Math.min(maxScale, rw / g.w, rh / g.h);
  const zoomed = follow && fit < MIN_FOLLOW_SCALE;
  const s = zoomed ? MIN_FOLLOW_SCALE : fit;
  let ox = rx + (rw - g.w * s) / 2, oy = ry + (rh - g.h * s) / 2;
  let cam = null;
  if (zoomed) {
    const c = toWorld(g.fl, (FL.front - FL.back) / 2, 0);
    // On touch landscape the camera may pan `panRight` px past the right/bottom map edge (shown black) so the fork gauge and pads don't hide map.
    const axis = (pos, size, len, r0, m = 0) => (len * s <= size ? r0 + (size - len * s) / 2 : r0 + size / 2 - Math.min(Math.max(pos, size / 2 / s), len - size / 2 / s + m / s) * s);
    ox = axis(c.x, rw, g.w, rx, panRight);
    oy = axis(c.y, rh, g.h, ry, panBottom);
    cam = { x: (rx - ox) / s, y: (ry - oy) / s, w: rw / s, h: rh / s };
    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();
    if (panRight || panBottom) {
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(rx, ry, rw, rh);
    }
  }
  view.ovTiles = rh / s;
  const chaseTiles = view.chaseZoom == null ? view.ovTiles : chaseTilesFor(view.chaseZoom);
  if (follow && view.chase) {
    // wall in the way: orbit upwards (smaller tilt) until half the forklift is visible; main.js eases view.chaseLift toward the target
    const heading = view.camA ?? g.fl.a, yaw = view.orbit ? view.orbit.yaw : 0, base = view.orbit ? view.orbit.tilt : CHASE_TILT;
    view.chaseLiftTarget = base - clearChaseTilt(g, chaseTiles, heading, yaw, base);
  }
  const lifted = view.chase && view.chaseLift > 0.001 ? { yaw: view.orbit ? view.orbit.yaw : 0, tilt: Math.max(0.05, (view.orbit ? view.orbit.tilt : CHASE_TILT) - view.chaseLift) } : view.orbit;
  const foot = follow && view.chase && drawOverview3d(ctx, g, rx, ry, rw, rh, 0, 0, 0, view.dpr, lifted, chaseTiles, view.camA ?? g.fl.a);
  if (foot) {
    if (zoomed) ctx.restore();
    return { x: 0, y: 0, w: g.w, h: g.h, poly: foot }; // chase: the minimap outlines the tilted floor footprint
  }
  if (follow && view.chaseZoom != null) { // user zoom: centred on the forklift at the slider's zoom
    const c = toWorld(g.fl, (FL.front - FL.back) / 2, 0), s2 = rh / chaseTilesFor(view.chaseZoom);
    if (drawOverview3d(ctx, g, rx, ry, rw, rh, c.x, c.y, s2, view.dpr, view.orbit)) {
      if (zoomed) ctx.restore();
      return { x: c.x - rw / s2 / 2, y: c.y - rh / s2 / 2, w: rw / s2, h: rh / s2 };
    }
  }
  if (drawOverview3d(ctx, g, rx, ry, rw, rh, (rx + rw / 2 - ox) / s, (ry + rh / 2 - oy) / s, s, view.dpr, follow ? view.orbit : null)) {
    if (zoomed) ctx.restore();
    return cam;
  }
  ctx.setTransform(s * view.dpr, 0, 0, s * view.dpr, ox * view.dpr, oy * view.dpr);
  drawWorld(ctx, g, null, s * view.dpr);
  for (const h of g.hits || []) {
    const k = (g.clock - h.t) / hitLife(h);
    ctx.globalAlpha = Math.max(0, 1 - k * k);
    labelRows(ctx, hitRows(h), h.x + h.z * PX, h.y + h.z * PY - k * 1.2, 0.55, 0.1);
  }
  ctx.globalAlpha = 1;
  for (const t of honkers(g)) {
    ctx.save();
    ctx.scale(0.01, 0.01);
    drawHonk(ctx, t, g.clock, (t.fl.x + 1.5 * PX) * 100, (t.fl.y + 1.5 * PY - 1.2) * 100, 70);
    ctx.restore();
  }
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
  ctx.fillStyle = theme().wall;
  for (const q of g.pillars) ctx.fillRect(q.x * s, q.y * s, Math.max(1.5, q.w * s), Math.max(1.5, q.h * s));
  const dot = Math.max(3, s * 0.9);
  for (const st of g.stacks) {
    ctx.fillStyle = COLORS[st.layers[st.layers.length - 1]];
    ctx.fillRect(st.x * s - dot / 2, st.y * s - dot / 2, dot, dot);
  }
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 1;
  const fr = Math.max(4, s * 1.1); // heading arrow: the tip points where the forklift faces
  ctx.save();
  ctx.translate(g.fl.x * s, g.fl.y * s);
  ctx.rotate(g.fl.a);
  ctx.beginPath();
  ctx.moveTo(fr, 0);
  ctx.lineTo(-fr * 0.7, fr * 0.7);
  ctx.lineTo(-fr * 0.3, 0);
  ctx.lineTo(-fr * 0.7, -fr * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = '#f9a825';
  if (cam.poly) {
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.beginPath();
    cam.poly.forEach(([px, py], i) => (i ? ctx.lineTo(px * s, py * s) : ctx.moveTo(px * s, py * s)));
    ctx.closePath();
    ctx.stroke();
  } else ctx.strokeRect(cam.x * s, cam.y * s, cam.w * s, cam.h * s);
  ctx.restore();
}

// Top-down world in simulation units; the caller sets the transform.
// With `pxPerTile`, the static floor (colour, grid, decals) is blitted from an offscreen canvas cached per game state.
const MAX_FLOOR_PX = 16e6;
let floorCache = null;
function drawFloor(ctx, g, vis, pxPerTile) {
  if (vis || !pxPerTile || g.w * g.h * pxPerTile * pxPerTile > MAX_FLOOR_PX) return paintFloor(ctx, g, vis);
  const key = [theme(), decalsEnabled(), Math.round(pxPerTile * 100)];
  const c = floorCache;
  if (!c || c.g !== g || c.key.some((k, i) => k !== key[i])) {
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    cv.width = Math.ceil(g.w * pxPerTile);
    cv.height = Math.ceil(g.h * pxPerTile);
    const cc = cv.getContext('2d');
    cc.scale(pxPerTile, pxPerTile);
    paintFloor(cc, g);
    floorCache = { g, key, cv, px: pxPerTile };
  }
  ctx.drawImage(floorCache.cv, 0, 0, floorCache.cv.width / floorCache.px, floorCache.cv.height / floorCache.px);
}

// vis (optional world AABB {x0,y0,x1,y1}): only things touching it are drawn (partial render for the small windows).
function drawWorld(ctx, g, vis, pxPerTile = 0) {
  drawFloor(ctx, g, vis, pxPerTile);
  if (discoOn()) drawDiscoSpots(ctx, g, vis);
  drawWorldObjects(ctx, g, vis);
}

const visSeen = (vis, x, y, w, h) => !vis || (x + w >= vis.x0 && x <= vis.x1 && y + h >= vis.y0 && y <= vis.y1);

function paintFloor(ctx, g, vis) {
  const seen = (x, y, w, h) => visSeen(vis, x, y, w, h);
  ctx.fillStyle = theme().floor;
  ctx.fillRect(0, 0, g.w, g.h);
  ctx.strokeStyle = theme().grid;
  ctx.lineWidth = 0.03;
  ctx.beginPath();
  const gx0 = vis ? Math.max(0, Math.floor(vis.x0)) : 0, gx1 = vis ? Math.min(g.w, Math.ceil(vis.x1)) : g.w;
  const gy0 = vis ? Math.max(0, Math.floor(vis.y0)) : 0, gy1 = vis ? Math.min(g.h, Math.ceil(vis.y1)) : g.h;
  for (let x = gx0; x <= gx1; x++) { ctx.moveTo(x, gy0); ctx.lineTo(x, gy1); }
  for (let y = gy0; y <= gy1; y++) { ctx.moveTo(gx0, y); ctx.lineTo(gx1, y); }
  ctx.stroke();

  for (const d of decalsEnabled() ? floorDecals(g) : []) {
    if (vis && !d.pts.some(([x, y]) => seen(x - 1, y - 1, 2, 2))) continue;
    ctx.fillStyle = d.fill;
    ctx.beginPath();
    d.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.fill();
  }

  for (const a of g.areas) {
    if (!seen(a.x - 0.3, a.y - 0.3, a.w + 0.6, a.h + 0.6)) continue;
    ctx.fillStyle = COLORS[a.color];
    ctx.globalAlpha = 0.12;
    ctx.fillRect(a.x - 0.3, a.y - 0.3, a.w + 0.6, a.h + 0.6);
    ctx.globalAlpha = 1;
  }
}

function drawWorldObjects(ctx, g, vis) {
  const seen = (x, y, w, h) => visSeen(vis, x, y, w, h);
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
    if (!seen(z.x - 0.6, z.y - 1.2, 1.2, 2.4)) continue;
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
    if (done) continue;
    ctx.font = 'bold 0.5px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 0.1;
    ctx.strokeStyle = '#fff';
    const lp = zoneLabelPos(g, z);
    ctx.strokeText(`×${z.count}`, lp.x, lp.y);
    ctx.fillStyle = '#000';
    ctx.fillText(`×${z.count}`, lp.x, lp.y);
  }

  // Stacks whose top is below the tines are drawn first; stacks the tines
  // slide under are drawn over them.
  const shown = g.stacks.filter((st) => seen(st.x - 1.2, st.y - 1.2, 2.4, 2.4));
  const low = shown.filter((st) => st.layers.length <= g.hf);
  const high = shown.filter((st) => st.layers.length > g.hf);
  const dstack = (st) => drawStack(ctx, st.layers, st.x, st.y, 0, st.rots, st.offs, st.pen);
  for (const st of low) dstack(st);
  // other trucks first, so the local one is always on top; ghosts are translucent
  const trucks = [...otherTrucks(g), g];
  for (const t of trucks) {
    ctx.globalAlpha = isGhost(g, t.truck.id) ? 0.4 : 1;
    drawForkliftBody(ctx, t);
    drawTines(ctx, t);
    ctx.globalAlpha = 1;
  }
  for (const st of high) dstack(st);
  for (const t of trucks) {
    ctx.globalAlpha = isGhost(g, t.truck.id) ? 0.4 : 1;
    drawCarried(ctx, t);
    ctx.globalAlpha = 1;
  }

  ctx.fillStyle = theme().wall;
  for (const w of g.pillars) {
    if (!seen(w.x, w.y, w.w, w.h)) continue;
    ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.strokeStyle = theme().wallEdge;
    ctx.lineWidth = 0.06;
    ctx.strokeRect(w.x, w.y, w.w, w.h);
  }
  if (g.charger && seen(g.charger.x, g.charger.y, g.charger.w, g.charger.h)) drawCharger(ctx, g.charger);
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

// Small top-down window just in front of (or, with back, just behind) the forklift, heading up/down the screen.
// Only the part of the world inside the window is drawn (culled via drawWorld's vis box).
function drawLookWindow(ctx, g, x, y, w, h, back, dpr = 1) {
  const scale = w / 4.5, wT = w / scale, hT = h / scale;
  const c = toWorld(g.fl, back ? FL.back + 0.5 - hT / 2 : FL.front - 0.5 + hT / 2, 0);
  const rot = (back ? Math.PI / 2 : -Math.PI / 2) - g.fl.a;
  const ext = Math.abs(Math.cos(rot)) * wT / 2 + Math.abs(Math.sin(rot)) * hT / 2;
  const exy = Math.abs(Math.sin(rot)) * wT / 2 + Math.abs(Math.cos(rot)) * hT / 2;
  if (drawLook3d(ctx, g, x, y, w, h, c.x, c.y, hT, back ? [-Math.cos(g.fl.a), -Math.sin(g.fl.a)] : [Math.cos(g.fl.a), Math.sin(g.fl.a)], dpr)) {
    drawLookFrame(ctx, x, y, w, h, back);
    return;
  }
  const vis = { x0: c.x - ext, x1: c.x + ext, y0: c.y - exy, y1: c.y + exy };
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = theme().bg;
  ctx.fillRect(x, y, w, h);
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate(rot);
  ctx.scale(scale, scale);
  ctx.translate(-c.x, -c.y);
  drawWorld(ctx, g, vis);
  ctx.restore();
  drawLookFrame(ctx, x, y, w, h, back);
}

function drawLookFrame(ctx, x, y, w, h, back) {
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(back ? 'REAR' : 'FRONT', x + 6, y + 5);
}

// Landscape touch: status text on both sides of the minimap, between the control pads.
function globalLine(gl) {
  if (gl === 'offline') return 'Global: offline';
  if (!gl || gl === 'loading') return 'Global: …';
  if (gl === 'none') return 'Global: none yet';
  return `Global ${gl.points} by ${gl.name} (${formatTime(gl.time || 0)})`;
}

const topRow = (i, e) => `${i + 1}. ${e.name} ${e.points ?? e.score} (${formatTime(e.time || 0)})`;

// Two top-10 columns (local, global) centred on cx, starting at y; returns the height used.
function drawTopLists(ctx, view, cx, y, width) {
  const lh = 18, colW = Math.min(width / 2 - 20, 250);
  const cols = [
    ['Local top 10', '#b3e5fc', (view.localList || []).map((e, i) => topRow(i, e)), 'No local scores yet'],
    ['Global top 10', '#c5e1a5', (view.globalList || []).map((e, i) => topRow(i, e)),
      view.globalList === null ? 'Offline' : view.globalList ? 'No global scores yet' : 'Loading…'],
  ];
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  cols.forEach(([title, color, rows, empty], c) => {
    const x = cx + (c ? 10 : -colW - 10);
    ctx.fillStyle = color;
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText(title, x, y + lh / 2, colW);
    ctx.font = '14px sans-serif';
    ctx.globalAlpha = rows.length ? 1 : 0.6;
    (rows.length ? rows : [empty]).forEach((r, i) => ctx.fillText(r, x, y + lh * (i + 1.5) + 2, colW));
    ctx.globalAlpha = 1;
  });
  return lh * 11 + 6;
}

// Shown on a freshly loaded level until the truck first moves.
function drawStartBoard(ctx, g, view, width, height) {
  const title = `Level ${g.level}${g.seed ? ` (seed ${g.seed})` : ''}`;
  const h = 40 + 18 * 11 + 22, y = Math.max(10, height * 0.12);
  const w = Math.min(width - 20, 560);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect((width - w) / 2, y, w, h);
  ctx.font = 'bold 20px sans-serif';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, width / 2, y + 20);
  drawTopLists(ctx, view, width / 2, y + 40, w / 2);
}

function drawStatusStrip(ctx, g, view, mm, title, bestText, globalText, hint, width, height) {
  const PAD = 156, lost = lostBreakdown(g);
  const done = g.zones.filter((z) => zoneDone(g, z)).length;
  const bottom = height - 10, lh = 17, rows = 4;
  const line = (text, x, row, color, align, w, bold) => {
    ctx.font = `${bold ? 'bold ' : ''}13px sans-serif`;
    ctx.textAlign = align;
    ctx.fillStyle = color;
    ctx.fillText(text, x, bottom - row * lh, w);
  };
  ctx.textBaseline = 'middle';
  const lx = mm.x - 8, rx = mm.x + mm.w + 8;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(PAD - 4, bottom - rows * lh - 9, lx - PAD + 4, rows * lh + 14);
  ctx.fillRect(rx - 4, bottom - rows * lh - 9, width - PAD - rx + 8, rows * lh + 14);
  const lw = lx - PAD, rw = width - PAD - rx;
  line(`Level ${g.level}${g.seed ? ` (seed ${g.seed})` : ''}`, lx, 2, '#eee', 'right', lw, true);
  line(`Zones ${done}/${g.zones.length}   Score ${score(g)}/${maxScore(g)}`, lx, 1, '#eee', 'right', lw);
  line(formatTime(g.time), lx, 0, '#eee', 'right', lw);
  line(globalText, rx, 3, '#c5e1a5', 'left', rw);
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

// Pulsing banner in the middle of the screen when the parking space unlocks.
function drawReadyFlash(ctx, width, height, t) {
  const DUR = 3;
  if (t < 0 || t > DUR) return;
  const fade = Math.min(1, (DUR - t) / 0.6);
  const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 6);
  const pop = 1 + 0.25 * Math.max(0, 1 - t * 4);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.scale(pop, pop);
  ctx.globalAlpha = fade;
  const w = Math.min(width - 20, 520), h = 90;
  ctx.fillStyle = `rgba(0,0,0,${0.55 + 0.15 * pulse})`;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.strokeStyle = `rgba(255,224,130,${0.4 + 0.6 * pulse})`;
  ctx.lineWidth = 4;
  ctx.strokeRect(-w / 2, -h / 2, w, h);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = pulse > 0.5 ? '#fff59d' : '#ffe082';
  ctx.font = 'bold 34px sans-serif';
  ctx.fillText('PARKING SPOT UNLOCKED', 0, -10, w - 20);
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText('Return to the parking spot (P)', 0, 26, w - 20);
  ctx.restore();
}

// Top right: the party code and one swatch + name per player (the local one in bold).
function drawPartyBadge(ctx, g, party, width) {
  ctx.save();
  ctx.font = '13px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const items = g.trucks.map((t, i) => (t.gone ? null : { i, name: t.name || `Player ${i + 1}` })).filter(Boolean);
  const label = `Party ${party.code}`;
  const widths = items.map((p) => 16 + ctx.measureText(p.name).width + 10);
  const w = ctx.measureText(label).width + 18 + widths.reduce((a, b) => a + b, 0);
  let x = width - 12 - w;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath();
  ctx.roundRect(x - 6, 8, w + 12, 26, 6);
  ctx.fill();
  ctx.fillStyle = '#eee';
  ctx.fillText(label, x, 21);
  x += ctx.measureText(label).width + 18;
  items.forEach((p, k) => {
    ctx.fillStyle = truckColor(p.i).body;
    ctx.fillRect(x, 15, 11, 11);
    ctx.fillStyle = p.i === g.self ? '#fff' : '#ccc';
    ctx.font = `${p.i === g.self ? 'bold ' : ''}13px sans-serif`;
    ctx.fillText(p.name, x + 16, 21);
    x += widths[k];
  });
  ctx.restore();
}

// Small compass under the fork gauge (hidden while north is up, except in the chase camera): the needle points to north (world -y) as seen from the current camera.
const wrapAngle = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
function drawCompass(ctx, g, view, width) {
  let a; // world heading of the screen's "up"
  if (view.povBig) a = g.fl.a + (view.look ? view.look.yaw : 0) + headTurn(g.fl);
  else if (view.chase) a = (view.camA ?? g.fl.a) + (view.orbit ? view.orbit.yaw : 0);
  else a = view.orbit ? view.orbit.yaw - Math.PI / 2 : -Math.PI / 2;
  const theta = Math.atan2(-Math.cos(a), -Math.sin(a)), cx = width - 29, cy = 262, r = 18;
  if (!(view.chase && !view.povBig) && Math.abs(wrapAngle(theta)) < 0.02) return; // north is straight up: no need for a compass (the chase camera always shows it)
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, r + 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.rotate(theta);
  ctx.fillStyle = '#e53935';
  ctx.beginPath();
  ctx.moveTo(0, -r); ctx.lineTo(5, 2); ctx.lineTo(-5, 2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ddd';
  ctx.beginPath();
  ctx.moveTo(0, r - 4); ctx.lineTo(4, 2); ctx.lineTo(-4, 2);
  ctx.closePath();
  ctx.fill();
  ctx.rotate(-theta);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', Math.sin(theta) * (r - 9), -Math.cos(theta) * (r - 9));
  ctx.restore();
}

export function draw(ctx, g, view) {
  const { width, height } = view;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!beginGlFrame(ctx, theme().bg)) {
    ctx.fillStyle = theme().bg;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }
  const strip = view.touch && !view.povBig && width > height;
  let mmBox = null;
  view.miniHit = null;
  const hx0 = 20;
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  if (view.povBig) {
    if (!drawPov3d(ctx, g, 0, 0, width, height, view.dpr, view.look)) drawPov(ctx, g, 0, 0, width, height);
    if (view.touch && width > height) { // easter egg: the minimap stays tappable to swap back to the overview
      const mm = miniSize(g, 120, 70), mx = (width - mm.w) / 2, my = height - 8 - mm.h;
      drawMiniMap(ctx, g, { x: 0, y: 0, w: g.w, h: g.h }, mx, my, mm.s);
      view.miniHit = { x: mx - 3, y: my - 3, w: mm.w + 6, h: mm.h + 6 };
    } else if (!view.touch) { // non-touch cab view: whole-map minimap bottom left, with the truck's heading
      const mm = miniSize(g, 180, 120);
      drawMiniMap(ctx, g, { x: 0, y: 0, w: g.w, h: g.h }, 16, height - 16 - mm.h, mm.s);
    }
    const mw = Math.min(150, width * 0.14), mh = mw * 0.75;
    // Touch landscape: leave a wide gap between the windows so the view straight ahead stays visible.
    const half = view.touch && width > height ? Math.max(4, width * 0.2) : 4;
    drawLookWindow(ctx, g, width / 2 - mw - half, 8, mw, mh, true, view.dpr);
    drawLookWindow(ctx, g, width / 2 + half, 8, mw, mh, false, view.dpr);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
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
    const touchLand = view.touch && !portrait;
    const zoomedIn = Math.min(48, rw / g.w, rh / g.h) < MIN_FOLLOW_SCALE;
    if (touchLand && !zoomedIn) { rw = width - rx - GAUGE_W; rh = Math.min(rh, height - ry - PAD_H); }
    let mmX = 13, mmY = 100 + 6;
    if (strip) {
      mmX = (width - mm.w) / 2;
      mmY = height - 8 - mm.h;
      mmBox = { x: mmX, w: mm.w, y: mmY };
      view.miniHit = { x: mmX - 3, y: mmY - 3, w: mm.w + 6, h: mm.h + 6 };
    } else if (zoomedIn) {
      if (portrait) { ry = Math.max(ry, mmY + mm.h + 12); rh = height - ry - bottom; }
      else { rx = mmX + mm.w + 16; rw = width - rx - (touchLand ? 20 : GAUGE_W); }
    }
    const cam = drawOverview(ctx, g, view, rx, ry, rw, rh, 48, true, touchLand && zoomedIn ? GAUGE_W : 0, touchLand && zoomedIn ? PAD_H : 0);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    if (strip || cam) drawMiniMap(ctx, g, cam || { x: 0, y: 0, w: g.w, h: g.h }, mmX, mmY, mm.s);
  }
  // screen-space HUD
  const done = g.zones.filter((z) => zoneDone(g, z)).length;
  const best = view.best;
  const title = `Level ${g.level}${g.seed ? ` (seed ${g.seed})` : ''}   Zones ${done}/${g.zones.length}   Score ${score(g)}/${maxScore(g)}   ${formatTime(g.time)}`;
  const bestText = best ? `Best ${best.score} by ${best.name} (${formatTime(best.time)})` : 'Best: none yet';
  const globalText = globalLine(view.global);
  const hint = g.status === 'play' && isSolved(g)
    ? (scoreEnough(g) ? 'All zones filled – return to the parking spot (P)' : 'Score is below 50% – fix damage/placement to finish')
    : '';
  const lostNow = lostBreakdown(g);
  const ready = g.status === 'play' && isSolved(g) && scoreEnough(g);
  const now = performance.now();
  const sig = `${g.level}|${g.seed}|${done}|${score(g)}|${lostNow.crash}|${lostNow.square}|${hint}`;
  // A change only (re)triggers the HUD while it is hidden or on its way up; otherwise it is locked.
  const hudTrigger = view.hudSig !== undefined && view.hudSig !== sig;
  view.hudSig = sig;
  if (ready && !view.hudReady) view.flashAt = now;
  view.hudReady = ready;
  // Full screen: the HUD floats down from the top when something changes, waits, then floats back up.
  let hudOff = 0;
  if (view.fullscreen && !(view.touch && width > height)) { // touch landscape: the strip obstructs nothing, so it stays
    const IN = 0.45, HOLD = 2, OUT = 0.5;
    const dt = Math.min(0.1, Math.max(0, (now - (view.hudLast ?? now)) / 1000));
    let a = view.hudAnim;
    if (!a) a = view.hudAnim = { phase: 'idle', p: 0, hold: 0 };
    if (hudTrigger && (a.phase === 'idle' || a.phase === 'out')) a.phase = 'in';
    if (a.phase === 'in') {
      a.p = Math.min(1, a.p + dt / IN);
      if (a.p >= 1) { a.phase = 'hold'; a.hold = 0; }
    } else if (a.phase === 'hold') {
      a.hold += dt;
      if (a.hold >= HOLD) a.phase = 'out';
    } else if (a.phase === 'out') {
      a.p = Math.max(0, a.p - dt / OUT);
      if (a.p <= 0) a.phase = 'idle';
    }
    const p = a.p;
    view.hudLast = now;
    hudOff = (1 - p * p * (3 - 2 * p)) * (strip ? -130 : 130);
  }
  const hudHidden = Math.abs(hudOff) >= 130;
  ctx.save();
  ctx.translate(0, -hudOff);
  if (hudHidden) { /* hidden in full screen */ }
  else if (view.povBig && view.touch && width > height) { /* cab view on touch landscape: no scoring HUD */ }
  else if (mmBox) drawStatusStrip(ctx, g, view, mmBox, title, bestText, globalText, hint, width, height);
  else {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 20px sans-serif';
    let boxW = ctx.measureText(title).width;
    ctx.font = '14px sans-serif';
    boxW = Math.max(boxW, 380 + Math.max(ctx.measureText(bestText).width, ctx.measureText(globalText).width));
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
    ctx.fillStyle = '#c5e1a5';
    ctx.fillText(globalText, hx0 + 380, 68);
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
  ctx.restore();

  if (view.party) drawPartyBadge(ctx, g, view.party, width);

  // fork height gauge: 0 = floor; box layer i fills the cell at height i-1
  const gx = width - 70, gy = 70, cell = 26, top = 5;
  const yOf = (lvl) => gy + (top - lvl) * cell;
  const tc = truckColor(g.truck.color);
  ctx.fillStyle = tc.dark;
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(gx - 28, gy - 26, 82, top * cell + cell + 34, 6);
  ctx.fill();
  ctx.stroke();
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
  ctx.strokeStyle = tc.body;
  ctx.lineWidth = 3;
  ctx.strokeRect(gx - 3, yOf(g.H) - 2, 36, cell + 2);
  ctx.fillStyle = tc.body;
  ctx.fillRect(gx + 34, yOf(g.H) + cell / 2 - 3, 8, 4);
  drawCompass(ctx, g, view, width);

  if (view.fullscreen && view.flashAt != null && ready) drawReadyFlash(ctx, width, height, (now - view.flashAt) / 1000);
  if (g.status === 'play' && !g.started && !view.startHidden && !view.paused && !view.menuOpen) drawStartBoard(ctx, g, view, width, height);
  if (view.paused) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, width, height);
  }
  if (g.status === 'won') {
    const lost = lostBreakdown(g);
    const pts = score(g);
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, height / 2 - 110, width, 220 + 210);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText('Level complete!', width / 2, height / 2 - 64);
    ctx.font = '18px sans-serif';
    ctx.fillText(`Boxes in zones: ${pts + lost.crash + lost.square} − crashes ${lost.crash} − squareness ${lost.square} = ${pts}`, width / 2, height / 2 - 28);
    ctx.fillText(`Time ${formatTime(g.time)}: −${timePenalty(g.time)} (1 point per 10 s)`, width / 2, height / 2 - 2);
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(`Final score: ${finalScore(pts, g.time)}`, width / 2, height / 2 + 30);
    ctx.font = '20px sans-serif';
    ctx.fillText(view.touch ? 'Tap to continue to the next level' : 'Press Enter for the next level', width / 2, height / 2 + 70);
    drawTopLists(ctx, view, width / 2, height / 2 + 90, width / 2);
  }
}
