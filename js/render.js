import { BARREL_COLOR, COLORS, ZONE_COLORS } from './level.js';
import { BOGIE, truckPaint, truckGeom, truckFloorArt, rampDecals, numberRects, dockWaits, dockNumber, yardRects, truckBays, DOCKS, endlessScore } from './endless.js';
import { FL, toWorld, truckColor } from './forklift.js';
import { scanBeam, botDrawPos, WHEEL_R } from './bot.js';
import { drawBotDebugWorld } from './debug.js';
import { topShapes, DENT_FILL, DENT_LINE } from './dents.js';
import { padPolys, tapeShapes, TAPE_FILL } from './repair.js';
import { repairHintOn, repairBlink, drawHintGlow, drawHintArrow } from './repairhint.js';
import { reverseLight } from './revlight.js';
import { drawPov } from './pov.js';
import { labelRows, hitRows, honkers, drawHonk, drawFlag } from './pov/overlay.js';
import { chaseTiles as chaseTilesFor, chaseRig, clearChaseTilt, CHASE_TILT, CHASE_TILES, CHASE_DEFAULT, headTurn } from './gl/camera.js';
import { beginGlFrame } from './gl/renderer.js';
import { clearTruckSpot, setTruckSpot, addHudRect, boxStatus } from './photo.js';
import { drawPov3d, drawOverview3d, drawLook3d } from './gl/views.js';
import { formatTime, timePenalty, finalScore } from './highscores.js';
import { theme } from './theme.js';
import { discoOn, drawDiscoSpots } from './disco.js';
import { decalsEnabled, floorDecals, boxDeco, boxDecalShapes, oilDropMark } from './decals.js';
import { liftedHf, carriedWorldOffs, zoneExt, hitLife, zoneDone, flaggedStacks, zoneLabelPos, stackInZone, score, maxScore, lostBreakdown, isSolved, isParked, otherTrucksShown, isGhost, stackZ, fallView, truckView, carriedJoltZ, truckPopScale, crashBlink } from './game.js';
import { BOX_SCALE, BOX_HALF_X, halfY } from './geom.js';

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

function drawOilDrop(ctx, x, y, s = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(0, -0.15);
  ctx.bezierCurveTo(0.055, -0.06, 0.11, 0.01, 0.1, 0.065);
  ctx.bezierCurveTo(0.085, 0.15, -0.085, 0.15, -0.1, 0.065);
  ctx.bezierCurveTo(-0.11, 0.01, -0.055, -0.06, 0, -0.15);
  ctx.closePath();
  ctx.fill();
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
    const hx = BOX_HALF_X, hy = halfY(pens[0]);
    at(x + (offs[0]?.x || 0) + 0.1, y + (offs[0]?.y || 0) + 0.1, 0, () => ctx.fillRect(-hx, -hy, 2 * hx, 2 * hy));
  }
  const cx = x + (offs[n - 1]?.x || 0) + (z0 + n - 1) * PX, cy = y + (offs[n - 1]?.y || 0) + (z0 + n - 1) * PY;
  for (let i = 0; i < n; i++) {
    if (pens[i]?.barrelPart === 'top') continue;
    at(x + (offs[i]?.x || 0) + (z0 + i) * PX, y + (offs[i]?.y || 0) + (z0 + i) * PY, i, () => {
      if (pens[i]?.barrelPart === 'base') {
        const col = COLORS[layers[i]];
      const rx = 0.38, ry = 0.34, segments = 32;
      const ringPoint = (angle, height) => [Math.cos(angle) * rx + height * PX, Math.sin(angle) * ry + height * PY];
      const face = (angle0, angle1, lower, upper, fill, shade = 0) => {
        const mid = (angle0 + angle1) / 2;
        if (Math.cos(mid) * -PX + Math.sin(mid) * -PY <= 0) return;
        const points = [ringPoint(angle0, upper), ringPoint(angle1, upper), ringPoint(angle1, lower), ringPoint(angle0, lower)];
        ctx.beginPath();
        points.forEach(([px, py], k) => (k ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        if (shade) {
          ctx.fillStyle = `rgba(0,0,0,${shade})`;
          ctx.fill();
        }
      };
      for (let k = 0; k < segments; k++) {
        const a0 = k * 2 * Math.PI / segments, a1 = (k + 1) * 2 * Math.PI / segments;
        face(a0, a1, 0, 2, col, 0.12 + 0.12 * (1 - Math.cos((a0 + a1) / 2)));
      }
      for (const h of [0.55, 1.45]) {
        for (let k = 0; k < segments; k++) {
          const a0 = k * 2 * Math.PI / segments, a1 = (k + 1) * 2 * Math.PI / segments;
          face(a0, a1, h - 0.045, h + 0.045, '#a8afb0', 0.12);
        }
      }
      if (decalsEnabled()) {
        const angle = Math.atan2(-PY, -PX);
        const mark = [[0, 0.12], [0.055, 0.035], [0.065, -0.015], [0, -0.12], [-0.065, -0.015], [-0.055, 0.035]];
        ctx.fillStyle = '#20292b';
        ctx.beginPath();
        mark.forEach(([u, v], k) => {
          const [px, py] = ringPoint(angle + u / rx, 1 + v);
          k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        });
        ctx.closePath();
        ctx.fill();
      }
        ctx.save();
        ctx.translate(2 * PX, 2 * PY);
      ctx.fillStyle = col;
        ctx.beginPath(); ctx.ellipse(0, 0, 0.38, 0.34, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#a8afb0'; ctx.lineWidth = 0.045; ctx.stroke();
      ctx.beginPath(); ctx.ellipse(0, 0, 0.28, 0.24, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, 0.045, 0, Math.PI * 2); ctx.fillStyle = '#a8afb0'; ctx.fill();
        if (decalsEnabled()) {
          ctx.fillStyle = '#20292b';
          drawOilDrop(ctx, 0, 0, 0.65);
          drawOilDrop(ctx, -0.19, 0.07, 0.28);
          drawOilDrop(ctx, 0.19, 0.07, 0.28);
        }
        ctx.restore();
        return;
      }
      const col = COLORS[layers[i]];
      const scale = BOX_SCALE, hy = halfY(pens[i]) / scale, sh = 2 * hy;
      ctx.scale(scale, scale);
      const a = rots[i] || 0, ca = Math.cos(a), sa = Math.sin(a);
      // extrusion towards the floor, expressed in the box's local frame
      const ex = (-PX * ca - PY * sa) / scale, ey = (PX * sa - PY * ca) / scale;
      const edges = [[0, -1, -h, -hy, h, -hy], [1, 0, h, -hy, h, hy], [0, 1, h, hy, -h, hy], [-1, 0, -h, hy, -h, -hy]];
      extrudeSides(ctx, edges, ex, ey, a, col, 'rgba(0,0,0,0.65)', 0.04);
      ctx.fillStyle = col;
      ctx.fillRect(-h, -hy, size, sh);
      ctx.fillStyle = shadeGradient(ctx, -h, -hy, h, hy, 0.35, 0.18);
      ctx.fillRect(-h, -hy, size, sh);
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.lineWidth = 0.05;
      ctx.strokeRect(-h, -hy, size, sh);
      // tape strip across the lid
      if (pens[i]?.open) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(-h + 0.1, -h + 0.1, size - 0.2, size - 0.2);
        ctx.fillStyle = '#555b60';
        ctx.fillRect(-0.07, -0.4, 0.14, 0.8);
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(-0.07, -hy, 0.14, sh);
      }
      if (pens[i]?.wide) {
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(-h, -0.02, size, 0.04); // the seam between the two pallets
      }
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
      if (pens[i]?.tape) {
        ctx.fillStyle = TAPE_FILL;
        ctx.globalAlpha = 0.9;
        for (const poly of tapeShapes(pens[i])) {
          ctx.beginPath();
          poly.forEach(([u, v], k) => (k ? ctx.lineTo(u, v) : ctx.moveTo(u, v)));
          ctx.closePath();
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      if (decalsEnabled()) {
        for (const d of boxDecalShapes(boxDeco(pens[i], layers[i], i))) {
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
    const scale = BOX_SCALE, hy = halfY(pens[n - 1]) / scale;
    ctx.scale(scale, scale);
    ctx.strokeRect(-h + 0.12, -hy + 0.12, size - 0.24, 2 * hy - 0.24);
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

function drawWheel(ctx, f, lx, ly, ang, big = false) {
  const c = Math.cos(f.a), s = Math.sin(f.a);
  const w = { x: f.x + lx * c - ly * s, y: f.y + lx * s + ly * c, a: f.a + ang };
  const k = big ? 1.25 : 1;
  block(ctx, w, -0.22 * k, -0.1, 0.22 * k, 0.1, 0, 0.32 * k, '#1c1c1c');
  // tread marks on the top face scroll with the rolled distance
  const step = 0.14 * k, h = 0.32 * k;
  ctx.save();
  ctx.translate(w.x + h * PX, w.y + h * PY);
  ctx.rotate(w.a);
  ctx.fillStyle = '#3c3c3c';
  const off = ((f.roll || 0) % step + step) % step;
  for (let x = -0.22 * k + off; x < 0.22 * k - 0.03; x += step) ctx.fillRect(x, -0.1, 0.03, 0.2);
  ctx.restore();
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
  drawWheel(ctx, f, FL.frontWheelX, -W - 0.02, 0, true);
  drawWheel(ctx, f, FL.frontWheelX, W + 0.02, 0, true);
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

// Proximity alert: the headlights flash red (top-down view).
function drawAlertGlow(ctx, g) {
  if (!crashBlink(g)) return;
  for (const side of [-1, 1]) {
    const p = toWorld(g.fl, FL.front, side * 0.38), r = 0.9;
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    grad.addColorStop(0, 'rgba(255,30,20,0.9)');
    grad.addColorStop(1, 'rgba(255,30,20,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
  }
}

function drawCarried(ctx, g) {
  if (!g.carried) return;
  const p = toWorld(g.fl, FL.carryX, 0);
  drawStack(ctx, g.carried, p.x, p.y, g.hf + (liftedHf(g) ?? 0) + carriedJoltZ(g), g.carriedRots.map((r) => r + g.fl.a), carriedWorldOffs(g), g.carriedPen);
}

// Draws the top-down overview scaled into the screen rect (rx, ry, rw, rh).
// With `follow`, a map that would be drawn smaller than MIN_FOLLOW_SCALE px/tile is shown at that scale instead,
// centred on the forklift and clamped to the map edges; the returned `cam` is the visible world rect (else null).
const MIN_FOLLOW_SCALE = 30;
const GAUGE_W = 90;
const PAD_H = 144; // landscape touch pad height incl. margin
// Size of the screen-aligned box around the map once the flat overview is rotated by the user's orbit yaw (the chase camera orbits the truck instead).
function rotatedExtent(g, view) {
  const yaw = view.orbit && !view.chase ? view.orbit.yaw : 0, co = Math.abs(Math.cos(yaw)), si = Math.abs(Math.sin(yaw));
  return { w: co * g.w + si * g.h, h: si * g.w + co * g.h, co, si };
}

// Local multiplayer (view.shared): the flat overview shows every live truck, centred on their bounding box and as close as they allow.
const GROUP_MARGIN = 5; // tiles around the outermost trucks
function groupFrame(g, rw, rh, yaw = 0) {
  // work in screen axes (right = (cos, sin), up = (sin, -cos)) so a rotated overview still frames every truck; the tilted camera needs a little extra room
  const co = Math.cos(yaw), si = Math.sin(yaw);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of g.trucks) {
    if (t.gone) continue;
    const u = t.fl.x * co + t.fl.y * si, v = t.fl.x * si - t.fl.y * co;
    x0 = Math.min(x0, u); x1 = Math.max(x1, u);
    y0 = Math.min(y0, v); y1 = Math.max(y1, v);
  }
  const mu = (x0 + x1) / 2, mv = (y0 + y1) / 2;
  return { cx: mu * co + mv * si, cy: mu * si - mv * co, s: Math.min(rw / (x1 - x0 + 2 * GROUP_MARGIN), rh / ((y1 - y0 + 2 * GROUP_MARGIN) * 1.2)) };
}

function drawOverview(ctx, g, view, rx, ry, rw, rh, maxScale, follow = false, panRight = 0, panBottom = 0) {
  const ext = rotatedExtent(g, view);
  const fit = Math.min(maxScale, rw / ext.w, rh / ext.h);
  const shared = follow && view.shared ? groupFrame(g, rw, rh, view.orbit && !view.chase ? view.orbit.yaw : 0) : null;
  const sharedS = shared ? Math.min(maxScale, Math.max(fit, Math.min(shared.s, MIN_FOLLOW_SCALE * 1.6))) : 0;
  const userS = !shared && follow && !view.chase && view.zoom != null ? rh / chaseTilesFor(view.zoom) : 0; // slider zoom (software view)
  const zoomed = follow && (shared ? sharedS > fit * 1.001 : userS > 0 || fit < MIN_FOLLOW_SCALE);
  const s = shared ? sharedS : userS || (zoomed ? MIN_FOLLOW_SCALE : fit);
  let ox = rx + (rw - g.w * s) / 2, oy = ry + (rh - g.h * s) / 2;
  let cam = null;
  if (zoomed) {
    const c = shared ? { x: shared.cx, y: shared.cy } : toWorld(g.fl, (FL.front - FL.back) / 2, 0);
    // On touch landscape the camera may pan `panRight` px past the right/bottom map edge (shown black) so the fork gauge and pads don't hide map.
    // `half`: half the visible world extent along that axis (the bounding box of the rotated view)
    const hx = (ext.co * rw + ext.si * rh) / 2 / s, hy = (ext.si * rw + ext.co * rh) / 2 / s;
    const axis = (pos, half, size, len, r0, m = 0) => (len <= 2 * half ? r0 + (size - len * s) / 2 : r0 + size / 2 - Math.min(Math.max(pos, half), len - half + m / s) * s);
    ox = axis(c.x, hx, rw, g.w, rx, panRight);
    oy = axis(c.y, hy, rh, g.h, ry, panBottom);
    const mx = (rx + rw / 2 - ox) / s, my = (ry + rh / 2 - oy) / s;
    cam = { x: mx - hx, y: my - hy, w: 2 * hx, h: 2 * hy };
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
  view.ovTiles = rh / (zoomed && !userS ? MIN_FOLLOW_SCALE : fit);
  const chaseTiles = view.chaseZoom == null ? Math.max(CHASE_TILES, view.ovTiles * CHASE_DEFAULT) : chaseTilesFor(view.chaseZoom);
  if (follow && view.chase && !shared) {
    // the camera only slides when the truck gets further than its maximum distance (the rig clamps view.camP) and then looks at the truck
    const yaw = view.orbit ? view.orbit.yaw : 0, base = view.orbit ? view.orbit.tilt : CHASE_TILT;
    const rig = chaseRig(g, chaseTiles, base, view.camG === g ? view.camP : null, 0, g.fl.a);
    view.camP = rig.pos;
    view.chaseD = rig.maxD;
    view.camG = g;
    view.camA = rig.heading;
    // wall in the way: orbit upwards (smaller tilt) until half the forklift is visible; main.js eases view.chaseLift toward the target
    view.chaseLiftTarget = base - clearChaseTilt(g, chaseTiles, rig.heading, yaw, base, rig.pos);
  }
  const lifted = view.chase && view.chaseLift > 0.001 ? { yaw: view.orbit ? view.orbit.yaw : 0, tilt: Math.max(0.05, (view.orbit ? view.orbit.tilt : CHASE_TILT) - view.chaseLift) } : view.orbit;
  const foot = follow && view.chase && !shared && drawOverview3d(ctx, g, rx, ry, rw, rh, 0, 0, 0, view.dpr, lifted, chaseTiles, view.camA ?? g.fl.a, view.camP);
  if (foot) {
    if (zoomed) ctx.restore();
    return { x: 0, y: 0, w: g.w, h: g.h, poly: foot }; // chase: the minimap outlines the tilted floor footprint
  }
  if (follow && !shared && view.zoom != null) { // user zoom: centred on the forklift at the slider's zoom
    const c = toWorld(g.fl, (FL.front - FL.back) / 2, 0), s2 = rh / chaseTilesFor(view.zoom);
    if (drawOverview3d(ctx, g, rx, ry, rw, rh, c.x, c.y, s2, view.dpr, view.orbit)) {
      if (zoomed) ctx.restore();
      return { x: c.x - rw / s2 / 2, y: c.y - rh / s2 / 2, w: rw / s2, h: rh / s2 };
    }
  }
  if (drawOverview3d(ctx, g, rx, ry, rw, rh, (rx + rw / 2 - ox) / s, (ry + rh / 2 - oy) / s, s, view.dpr, follow ? view.orbit : null)) {
    if (zoomed) ctx.restore();
    return cam;
  }
  setTruckSpot(ox + g.fl.x * s, oy + g.fl.y * s, 2 * s);
  ctx.setTransform(s * view.dpr, 0, 0, s * view.dpr, ox * view.dpr, oy * view.dpr);
  drawWorld(ctx, g, null, s * view.dpr);
  if (g.debugBots) drawBotDebugWorld(ctx, g, view.dpr);
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
const MINIMAP_TARGET_COLORS = ['#ffeb3b', '#00e5ff'];
function minimapTarget(g, z) {
  const layers = g.carried, pens = g.carriedPen;
  if (!layers?.length || !pens || pens.length !== layers.length || layers.some((c) => c !== layers[0])) return false;
  const wide = !!pens[0]?.wide;
  if (pens.some((p) => !!p?.wide !== wide)) return false;
  if (layers[0] === BARREL_COLOR) {
    return layers.length === 2 && pens[0]?.barrelPart === 'base' && pens[1]?.barrelPart === 'top' &&
      z.color === BARREL_COLOR && z.count === 1 && !z.wide;
  }
  return z.color === layers[0] && !!z.wide === wide;
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
    const target = !zoneDone(g, z) && minimapTarget(g, z);
    ctx.fillStyle = target ? MINIMAP_TARGET_COLORS[Math.floor(g.clock * 4) % 2] : ZONE_COLORS[z.color];
    ctx.globalAlpha = target || zoneDone(g, z) ? 1 : 0.5;
    const e = zoneExt(z);
    ctx.fillRect((z.x - e.x) * s, (z.y - e.y) * s, 2 * e.x * s, 2 * e.y * s);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#9e9e9e';
  ctx.fillRect((g.parking.x - 0.8) * s - 1, (g.parking.y - 0.8) * s - 1, 1.6 * s + 2, 1.6 * s + 2);
  if (g.repair) {
    ctx.fillStyle = repairHintOn() && !repairBlink(g.clock) ? '#fff' : '#42a5f5'; // blinks while the repair hint is up
    ctx.fillRect((g.repair.x - 0.65) * s, (g.repair.y - 0.65) * s, 1.3 * s, 1.3 * s);
  }
  ctx.fillStyle = theme().wall;
  for (const q of g.pillars) if (q.y < g.h && q.x < g.w) ctx.fillRect(q.x * s, q.y * s, Math.max(1.5, q.w * s), Math.max(1.5, q.h * s));
  const dot = Math.max(3, s * 0.9);
  for (const st of g.stacks) {
    ctx.fillStyle = COLORS[st.layers[st.layers.length - 1]];
    ctx.fillRect(st.x * s - dot / 2, st.y * s - dot / 2, dot, dot);
  }
  for (const f of flaggedStacks(g)) drawFlag(ctx, f, f.x * s, f.y * s - dot / 2 - Math.max(5, s * 1.1), Math.max(10, s * 2.2), g.clock); // the inspector's "!" on the minimap
  for (const t of [...otherTrucksShown(g), g]) {
    if (!t.carried?.length) continue;
    const p = toWorld(t.fl, FL.carryX, 0);
    ctx.fillStyle = COLORS[t.carried[t.carried.length - 1]];
    ctx.fillRect(p.x * s - dot / 2, p.y * s - dot / 2, dot, dot);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1;
    ctx.strokeRect(p.x * s - dot / 2, p.y * s - dot / 2, dot, dot);
  }
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 1;
  const fr = Math.max(4, s * 1.1); // heading arrow in the truck's colour: the tip points where the forklift faces
  for (const t of [...otherTrucksShown(g), g]) {
    ctx.fillStyle = truckColor(t.truck.color).body;
    ctx.save();
    ctx.translate(t.fl.x * s, t.fl.y * s);
    ctx.rotate(t.fl.a);
    ctx.beginPath();
    ctx.moveTo(fr, 0);
    ctx.lineTo(-fr * 0.7, fr * 0.7);
    ctx.lineTo(-fr * 0.3, 0);
    ctx.lineTo(-fr * 0.7, -fr * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
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
  const key = [theme(), decalsEnabled(), Math.round(pxPerTile * 100), g.layoutVersion || 0];
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

// Inspection bot (Enabot Ebo style): a white egg with a black visor band across the front, two ring eyes and a camera lens that glows
// red while it laser-scans a stack: the beam sweeps over the stack and a scan sheet runs back and forth across it.
function drawInspector(ctx, g, vis) {
  const b = g.inspector;
  if (!b || b.show <= 0 || !visSeen(vis, b.x - 0.5, b.y - 0.5, 1, 1)) return;
  const sc = scanBeam(b);
  if (sc) {
    const hz = sc.h * 0.5, ox = hz * PX, oy = hz * PY;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,60,60,0.35)'; ctx.lineWidth = 0.12;
    ctx.beginPath(); ctx.moveTo(sc.lens.x, sc.lens.y); ctx.lineTo(sc.sx + ox, sc.sy + oy); ctx.stroke();
    ctx.strokeStyle = '#ff3b3b'; ctx.lineWidth = 0.03; ctx.stroke();
    // The scan sheet across the stack.
    const cx = sc.aim.x + sc.fx * sc.sheet + ox, cy = sc.aim.y + sc.fy * sc.sheet + oy;
    ctx.strokeStyle = 'rgba(255,90,90,0.9)'; ctx.lineWidth = 0.035;
    ctx.beginPath(); ctx.moveTo(cx + sc.fy * 0.6, cy - sc.fx * 0.6); ctx.lineTo(cx - sc.fy * 0.6, cy + sc.fx * 0.6); ctx.stroke();
    ctx.restore();
  }
  ctx.save();
  const p = botDrawPos(b, g.hatch);
  ctx.beginPath(); ctx.rect(0, 0, g.w, g.h); ctx.clip(); // the walls hide a bot that is still inside one
  ctx.translate(p.x, p.y); ctx.rotate(b.a);
  ctx.fillStyle = '#1d2024';
  ctx.beginPath(); ctx.roundRect(-0.16, -0.3, 0.32, 0.1, 0.04); ctx.fill();
  ctx.beginPath(); ctx.roundRect(-0.16, 0.2, 0.32, 0.1, 0.04); ctx.fill();
  // Tread ribs slide along the wheels as it drives.
  ctx.strokeStyle = '#5a6068'; ctx.lineWidth = 0.014;
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const x = (((b.roll || 0) * WHEEL_R + i * 0.07) % 0.35 + 0.35) % 0.35 - 0.175;
    if (Math.abs(x) < 0.15) for (const [y0, y1] of [[-0.29, -0.21], [0.21, 0.29]]) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
  }
  ctx.stroke();
  ctx.fillStyle = '#f6f6f4';
  ctx.beginPath(); ctx.ellipse(-0.01, 0, 0.27, 0.23, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#d9dcdf';
  ctx.beginPath(); ctx.ellipse(-0.1, 0, 0.14, 0.17, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#111317';
  ctx.beginPath(); ctx.ellipse(0.14, 0, 0.12, 0.2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.014;
  for (const v of [-0.085, 0.085]) { ctx.beginPath(); ctx.arc(0.17, v, 0.04, 0.5, Math.PI * 2 - 0.5); ctx.stroke(); }
  ctx.fillStyle = sc ? '#ff3b3b' : b.scared ? '#ff6a4a' : '#2a3a52';
  ctx.beginPath(); ctx.arc(0.2, 0, 0.032, 0, Math.PI * 2); ctx.fill();
  if (sc) { ctx.fillStyle = 'rgba(255,60,60,0.35)'; ctx.beginPath(); ctx.arc(0.2, 0, 0.06, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = b.scared ? '#ff6a4a' : '#7fe8ff';
  ctx.beginPath(); ctx.arc(0.1, -0.15, 0.012, 0, Math.PI * 2); ctx.fill();
  if (b.flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${b.flash})`;
    ctx.beginPath(); ctx.arc(0.2, 0, 0.1 + 0.4 * (1 - b.flash), 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// Cleaning bot hatch (in the wall) and the bot itself: a small white M-O-style body, dark visor with a blue eye, side treads
// and a spinning brush in front that scrubs while it cleans.
function drawBot(ctx, g, vis) {
  drawInspector(ctx, g, vis);
  const h = g.hatch;
  if (!h) return;
  ctx.save();
  ctx.translate(h.x, h.y); ctx.rotate(h.a - Math.PI / 2);
  ctx.fillStyle = '#2b2f33'; ctx.fillRect(-0.45, -0.12, 0.9, 0.12);
  ctx.fillStyle = '#e8c52e'; ctx.fillRect(-0.45, -0.12, 0.9, 0.025);
  ctx.restore();
  const b = g.bot;
  if (!b || b.show <= 0 || !visSeen(vis, b.x - 0.5, b.y - 0.5, 1, 1)) return;
  const t = g.clock || 0;
  ctx.save();
  const p = botDrawPos(b, g.hatch);
  ctx.beginPath(); ctx.rect(0, 0, g.w, g.h); ctx.clip(); // the walls hide a bot that is still inside one
  ctx.translate(p.x, p.y); ctx.rotate(b.a);
  ctx.fillStyle = '#4a4d52';
  ctx.fillRect(-0.2, -0.3, 0.4, 0.1); ctx.fillRect(-0.2, 0.2, 0.4, 0.1);
  ctx.fillStyle = '#f2f2ee';
  ctx.beginPath(); ctx.roundRect(-0.22, -0.2, 0.44, 0.4, 0.1); ctx.fill();
  ctx.fillStyle = '#c93a2b'; ctx.fillRect(-0.2, -0.04, 0.12, 0.08);
  ctx.fillStyle = '#20262c';
  ctx.beginPath(); ctx.ellipse(0.1, 0, 0.1, 0.15, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = b.scared ? '#ff6a4a' : '#4ec3ff';
  ctx.beginPath(); ctx.arc(0.12, 0, 0.05, 0, Math.PI * 2); ctx.fill();
  // Two arms hold a roller across the front; it spins about its long axis, so seen from above its bristles sweep forward and back.
  ctx.fillStyle = '#4a4d52';
  ctx.fillRect(0.2, -0.19, 0.16, 0.04); ctx.fillRect(0.2, 0.15, 0.16, 0.04);
  ctx.fillStyle = '#3a3d42'; ctx.fillRect(0.31, -0.17, 0.1, 0.34);
  ctx.strokeStyle = '#e8c52e'; ctx.lineWidth = 0.03; ctx.lineCap = 'round';
  ctx.beginPath();
  for (let k = 0; k < 4; k++) {
    const x = 0.36 + 0.04 * Math.sin((b.cleaning ? t * 18 : 0) + k * Math.PI / 2);
    ctx.moveTo(x, -0.16); ctx.lineTo(x, 0.16);
  }
  ctx.stroke();
  ctx.restore();
}

// vis (optional world AABB {x0,y0,x1,y1}): only things touching it are drawn (partial render for the small windows).
function drawWorld(ctx, g, vis, pxPerTile = 0) {
  drawFloor(ctx, g, vis, pxPerTile);
  for (const oil of g.oil || []) {
    if (!visSeen(vis, oil.x - oil.r, oil.y - oil.r, oil.r * 2, oil.r * 2)) continue;
    ctx.fillStyle = 'rgba(12,22,22,0.72)';
    ctx.beginPath(); ctx.ellipse(oil.x, oil.y, oil.r, oil.r * 0.72, -0.3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(180,205,190,0.22)';
    ctx.beginPath(); ctx.ellipse(oil.x - oil.r * 0.22, oil.y - oil.r * 0.12, oil.r * 0.38, oil.r * 0.09, -0.3, 0, Math.PI * 2); ctx.fill();
  }
  drawBot(ctx, g, vis);
  if (discoOn()) drawDiscoSpots(ctx, g, vis);
  drawWorldObjects(ctx, g, vis);
  if (repairHintOn() && g.repair) {
    drawHintGlow(ctx, g.repair.x, g.repair.y, 2, g.clock);
    const a = Math.atan2(g.repair.y - g.fl.y, g.repair.x - g.fl.x);
    drawHintArrow(ctx, g.fl.x + Math.cos(a) * 2.2, g.fl.y + Math.sin(a) * 2.2, a, 0.5, g.clock);
  }
  for (const f of flaggedStacks(g)) drawFlag(ctx, f, f.x + (f.h + 0.6) * PX, f.y + (f.h + 0.6) * PY - 0.3, 0.9, g.clock, 0.03); // the inspector's hovering "!"
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

  if (g.endless) { ctx.fillStyle = '#2c2f33'; for (const y of yardRects()) ctx.fillRect(y.x, y.y, y.w, y.h); }
  for (const b of truckBays(g)) {
    const t = truckGeom(b);
    for (const { pts, fill } of truckFloorArt(t.floor)) {
      ctx.fillStyle = fill;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.fill();
    }
  }
  for (const r of rampDecals(g)) {
    ctx.fillStyle = '#7b8088';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = '#f4c414';
    if (r.east) {
      ctx.fillRect(r.x, r.y, r.w, 0.12);
      ctx.fillRect(r.x, r.y + r.h - 0.12, r.w, 0.12);
    } else {
      ctx.fillRect(r.x, r.y, 0.12, r.h);
      ctx.fillRect(r.x + r.w - 0.12, r.y, 0.12, r.h);
    }
    if (r.num) { ctx.fillStyle = '#f4f4f4'; for (const q of numberRects(r)) ctx.fillRect(q.x, q.y, q.w, q.h); }
  }
  for (const a of g.areas) {
    if (!seen(a.x - 0.3, a.y - 0.3, a.w + 0.6, a.h + 0.6)) continue;
    ctx.fillStyle = ZONE_COLORS[a.color];
    ctx.globalAlpha = 0.12;
    ctx.fillRect(a.x - 0.3, a.y - 0.3, a.w + 0.6, a.h + 0.6);
    ctx.globalAlpha = 1;
  }
}

function drawWorldObjects(ctx, g, vis) {
  const seen = (x, y, w, h) => visSeen(vis, x, y, w, h);
  {
    const p = g.parking, ok = isSolved(g);
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

  if (g.repair) {
    for (const q of padPolys(g.repair)) {
      ctx.fillStyle = q.hex;
      ctx.globalAlpha = q.alpha;
      ctx.beginPath();
      q.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
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
    const e = zoneExt(z);
    if (!seen(z.x - e.x, z.y - e.y - 0.6, 2 * e.x, 2 * e.y + 1.2)) continue;
    const done = zoneDone(g, z);
    ctx.fillStyle = ZONE_COLORS[z.color];
    ctx.globalAlpha = done ? 0.75 : 0.4;
    ctx.fillRect(z.x - e.x, z.y - e.y, 2 * e.x, 2 * e.y);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = ZONE_COLORS[z.color];
    ctx.lineWidth = 0.1;
    ctx.setLineDash(done ? [] : [0.2, 0.15]);
    ctx.strokeRect(z.x - e.x, z.y - e.y, 2 * e.x, 2 * e.y);
    ctx.setLineDash([]);
    if (z.color === BARREL_COLOR && decalsEnabled()) {
      const mark = oilDropMark(z.x, z.y, 1, !theme().dark);
      ctx.fillStyle = mark.fill;
      ctx.beginPath();
      mark.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
      if (mark.edge) { ctx.strokeStyle = mark.edge; ctx.lineWidth = mark.edgeW; ctx.stroke(); }
    }
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
  const shown = g.stacks.map((st) => fallView(g, st)).filter((st) => seen(st.x - 1.2, st.y - 1.2, 2.4, 2.4));
  const low = shown.filter((st) => stackZ(g, st) + st.layers.length <= g.hf);
  const high = shown.filter((st) => stackZ(g, st) + st.layers.length > g.hf);
  const dstack = (st) => drawStack(ctx, st.layers, st.x, st.y, stackZ(g, st), st.rots, st.offs, st.pen);
  for (const st of low) dstack(st);
  // other trucks first, so the local one is always on top; ghosts are translucent
  const trucks = [...otherTrucksShown(g), g];
  for (const t of trucks) {
    ctx.globalAlpha = isGhost(g, t.truck.id) ? 0.4 : 1;
    const popScale = truckPopScale(g, t.truck.id);
    ctx.save();
    ctx.translate(t.fl.x, t.fl.y);
    ctx.scale(popScale, popScale);
    ctx.translate(-t.fl.x, -t.fl.y);
    const lh = liftedHf(t);
    if (lh != null) { ctx.save(); ctx.translate(lh * PX, lh * PY); } // riding on another truck's tines
    drawForkliftBody(ctx, t);
    drawTines(ctx, t);
    drawAlertGlow(ctx, t);
    if (lh != null) ctx.restore();
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  for (const st of high) dstack(st);
  for (const t of trucks) {
    ctx.globalAlpha = isGhost(g, t.truck.id) ? 0.4 : 1;
    const popScale = truckPopScale(g, t.truck.id);
    ctx.save();
    ctx.translate(t.fl.x, t.fl.y);
    ctx.scale(popScale, popScale);
    ctx.translate(-t.fl.x, -t.fl.y);
    drawCarried(ctx, t);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  ctx.fillStyle = theme().wall;
  for (const w of g.pillars) {
    if (!seen(w.x, w.y, w.w, w.h)) continue;
    if (w.truck) { drawTruckPart(ctx, w); continue; }
    if (w.roller) { drawRollerDoor(ctx, w); continue; }
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

// A delivery truck panel in its bay colour: dark wheels stick out of the sides, the cab is darker, the rear doors (gate) light grey.
function drawTruckPart(ctx, w) {
  const { color, part } = w.truck;
  if (part === 'cab' || part === 'wcab') { // seen from above; the front faces south (delivery) or `side` (west/east, incoming)
    const south = part === 'cab', sd = w.truck.side || 1, depth = south ? w.h : w.w, wd = south ? w.w : w.h;
    const rect = (t0, t1, l0, l1) => { // t: depth from the front edge, l: lateral offset from the left side
      if (south) ctx.fillRect(w.x + l0, w.y + depth - t1, l1 - l0, t1 - t0);
      else ctx.fillRect(sd < 0 ? w.x + t0 : w.x + depth - t1, w.y + l0, t1 - t0, l1 - l0);
    };
    ctx.fillStyle = '#15171a';
    rect(1.0, 1.8, -0.1, 0.1); rect(1.0, 1.8, wd - 0.1, wd + 0.1);
    ctx.fillStyle = truckPaint(color);
    ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    rect(0.8, depth, 0, wd);
    ctx.fillStyle = '#1d2a38';
    rect(0.8, 1.15, 0.25, wd - 0.25);
    ctx.fillStyle = '#15171a';
    rect(0, 0.08, 0.4, wd - 0.4);
    rect(0.7, 0.9, -0.1, 0.1); rect(0.7, 0.9, wd - 0.1, wd + 0.1);
    ctx.fillStyle = '#fff6c0';
    rect(0, 0.1, 0.1, 0.4); rect(0, 0.1, wd - 0.4, wd - 0.1);
    ctx.strokeStyle = '#1f2226';
    ctx.lineWidth = 0.06;
    ctx.strokeRect(w.x, w.y, w.w, w.h);
    return;
  }
  if (part === 'left' || part === 'right') {
    ctx.fillStyle = '#15171a';
    const wx = part === 'left' ? w.x - 0.1 : w.x + w.w - 0.1;
    for (const d of BOGIE) ctx.fillRect(wx, w.y + d - 0.4, 0.2, 0.8);
  }
  if (part === 'side') { // incoming trailer: wheels on the outer face of the side panel
    ctx.fillStyle = '#15171a';
    const wy = w.truck.lat < 0 ? w.y - 0.1 : w.y + w.h - 0.1;
    for (const d of BOGIE) ctx.fillRect((w.truck.side < 0 ? w.x + w.w - d : w.x + d) - 0.4, wy, 0.8, 0.2);
  }
  ctx.fillStyle = part === 'gate' ? '#b9bec5' : truckPaint(color);
  ctx.fillRect(w.x, w.y, w.w, w.h);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  if (part === 'back') ctx.fillRect(w.x, w.y, w.w, w.h);
  ctx.strokeStyle = '#1f2226';
  ctx.lineWidth = 0.06;
  ctx.strokeRect(w.x, w.y, w.w, w.h);
  if (part === 'gate') { ctx.beginPath(); ctx.moveTo(w.x + w.w / 2, w.y); ctx.lineTo(w.x + w.w / 2, w.y + w.h); ctx.stroke(); }
}

// The factory's roller door: light steel with slat ticks and a yellow edge.
function drawRollerDoor(ctx, w) {
  ctx.fillStyle = '#c9cfd6';
  ctx.fillRect(w.x, w.y, w.w, w.h);
  ctx.strokeStyle = '#7b8088';
  ctx.lineWidth = 0.04;
  ctx.beginPath();
  if (w.w >= w.h) for (let x = w.x + 0.3; x < w.x + w.w - 0.01; x += 0.3) { ctx.moveTo(x, w.y); ctx.lineTo(x, w.y + w.h); }
  else for (let y = w.y + 0.3; y < w.y + w.h - 0.01; y += 0.3) { ctx.moveTo(w.x, y); ctx.lineTo(w.x + w.w, y); }
  ctx.stroke();
  ctx.fillStyle = '#f4c414';
  if (w.w >= w.h) ctx.fillRect(w.x, w.y, w.w, 0.06); else ctx.fillRect(w.x, w.y, 0.06, w.h);
  ctx.strokeStyle = theme().wallEdge;
  ctx.lineWidth = 0.06;
  ctx.strokeRect(w.x, w.y, w.w, w.h);
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
  const title = g.endless ? 'Endless mode' : `Level ${g.level}${g.seed ? ` (seed ${g.seed})` : ''}`;
  const h = 40 + 18 * 11 + 22 + (g.endless ? 150 : 0), y = Math.max(10, height * 0.12);
  const w = Math.min(width - 20, 560);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect((width - w) / 2, y, w, h);
  ctx.font = 'bold 20px sans-serif';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, width / 2, y + 20);
  if (g.endless) {
    ctx.font = '16px sans-serif';
    ['Trucks bring stacks to the west and east walls.', 'Stack four of a colour on each of the six spots', 'of that colour\'s delivery truck (south). A full truck', 'drives off and is replaced.', `All ${DOCKS} incoming bays still full when the next one arrives: game over.`]
      .forEach((t, i) => ctx.fillText(t, width / 2, y + 60 + i * 24));
    drawTopLists(ctx, view, width / 2, y + 190, w / 2);
    return;
  }
  drawTopLists(ctx, view, width / 2, y + 40, w / 2);
}

function drawStatusStrip(ctx, g, mm, scoreLine, lost, bestText, globalText, hint, width, height) {
  const PAD = 156;
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
  const E = g.endless;
  line(E ? 'Endless' : `Level ${g.level}${g.seed ? ` (seed ${g.seed})` : ''}`, lx, 2, '#eee', 'right', lw, true);
  line(scoreLine, lx, 1, '#eee', 'right', lw);
  line(formatTime(g.time), lx, 0, '#eee', 'right', lw);
  line(globalText, rx, 3, '#c5e1a5', 'left', rw);
  line(bestText, rx, 2, '#b3e5fc', 'left', rw);
  line(`Damage −${lost.repairableCrash} repairable, −${lost.permanentCrash} permanent`, rx, 1, '#ef9a9a', 'left', rw);
  line(`Placement −${lost.square} (${g.hard ? 'reported' : 'fixable'})`, rx, 0, '#ffe082', 'left', rw);
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
  addHudRect(x - 6, 8, x + w + 6, 34);
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
// Small endless-mode panel: how long the truck at each incoming bay has been waiting to be unloaded.
// Touch landscape: top left (the right-hand controls cover the area under the compass); otherwise under the compass.
function drawDockWaits(ctx, g, width, touchLand) {
  const rh = 16, bw = 130;
  const x = touchLand ? 8 : width - 138, y = touchLand ? 8 : 290;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(x, y, bw, DOCKS * rh + 8);
  ctx.font = '12px sans-serif';
  ctx.textBaseline = 'middle';
  const waits = dockWaits(g);
  g.endless.docks.map((d) => [dockNumber(d), waits[d.k]]).sort((a, b) => a[0] - b[0]).forEach(([n, w], i) => {
    const cy = y + 4 + i * rh + rh / 2;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#aaa';
    ctx.fillText(`Bay ${n}`, x + 6, cy);
    ctx.textAlign = 'right';
    ctx.fillStyle = w === null ? '#666' : w > 120 ? '#ef9a9a' : w > 60 ? '#ffe082' : '#eee';
    ctx.fillText(w === null ? '–' : w >= 36000 ? 'FOREVER' : formatTime(w), x + bw - 6, cy); // 10 h or more
  });
}

// Fork height gauge of one truck view: 0 = floor; box layer i fills the cell at height i-1
function drawBoxStatus(ctx, x, y, kind) {
  ctx.save();
  if (kind === 'damaged') {
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x + 4, y + 3);
    ctx.lineTo(x - 4, y + 3);
    ctx.closePath();
    ctx.fillStyle = '#ffeb3b';
    ctx.fill();
    ctx.strokeStyle = '#b71c1c';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.fillStyle = '#b71c1c';
    ctx.font = 'bold 6px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', x, y + 1);
    ctx.restore();
    return;
  }
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = '#ffe082';
  ctx.strokeStyle = '#4e342e';
  ctx.lineWidth = 1;
  ctx.fillRect(-2.5, -2.5, 5, 5);
  ctx.strokeRect(-2.5, -2.5, 5, 5);
  ctx.restore();
}

export function drawForkGauge(ctx, g, gx, gy) {
  const cell = 26, top = 5;
  addHudRect(gx - 28, gy - 26, gx + 54, gy + top * cell + cell + 8);
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
  const cellBox = (lvl, color, alpha, pen) => {
    if (lvl > top) return;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = COLORS[color];
    ctx.fillRect(gx + 3, yOf(lvl) + 3, 24, cell - 8);
    ctx.globalAlpha = 1;
    if (pen?.open) { // open-top box: nothing can be stacked on it
      ctx.font = '15px sans-serif';
      ctx.fillText('🚫', gx + 15, yOf(lvl) + cell / 2);
      ctx.font = '12px sans-serif';
    }
    const status = pen?.inspected ? boxStatus(pen) : null, icons = [];
    if (status?.damaged) icons.push('damaged');
    if (status?.crooked) icons.push('crooked');
    const xs = icons.length > 1 ? [gx + 9, gx + 21] : [gx + 21];
    icons.forEach((kind, i) => drawBoxStatus(ctx, xs[i], yOf(lvl) + cell / 2, kind));
  };
  const under = stackInZone(g);
  if (under) under.layers.forEach((c, i) => cellBox(i, c, 0.85, under.pen?.[i]));
  if (g.carried) g.carried.forEach((c, i) => cellBox(g.H + i, c, 1, g.carriedPen?.[i]));
  ctx.strokeStyle = tc.body;
  ctx.lineWidth = 3;
  ctx.strokeRect(gx - 3, yOf(g.H) - 2, 36, cell + 2);
  ctx.fillStyle = tc.body;
  ctx.fillRect(gx + 34, yOf(g.H) + cell / 2 - 3, 8, 4);
}

function drawCompass(ctx, g, view, width) {
  let a; // world heading of the screen's "up"
  if (view.povBig) a = g.fl.a + (view.look ? view.look.yaw : 0) + headTurn(g.fl);
  else if (view.chase) a = (view.camA ?? g.fl.a) + (view.orbit ? view.orbit.yaw : 0);
  else a = view.orbit ? view.orbit.yaw - Math.PI / 2 : -Math.PI / 2;
  const theta = Math.atan2(-Math.cos(a), -Math.sin(a)), cx = width - 29, cy = 262, r = 18;
  if (!(view.chase && !view.povBig) && Math.abs(wrapAngle(theta)) < 0.02) return; // north is straight up: no need for a compass (the chase camera always shows it)
  addHudRect(cx - r - 4, cy - r - 4, cx + r + 4, cy + r + 4);
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

// Screen split for `n` cabin views: { ov, cabs } with the overview's window (null when four cabins fill the screen) and one window per cabin.
// 1 cabin: half overview, half cabin; 2: overview on top, the cabins side by side below; 3: quadrants, overview top left; 4: all quadrants are cabins.
function cabTiles(width, height, n) {
  const R = (x, y, w, h) => ({ x, y, w, h }), hw = width / 2, hh = height / 2;
  if (n === 1) return width >= height ? { ov: R(0, 0, hw, height), cabs: [R(hw, 0, hw, height)] } : { ov: R(0, 0, width, hh), cabs: [R(0, hh, width, hh)] };
  if (n === 2) return { ov: R(0, 0, width, hh), cabs: [R(0, hh, hw, hh), R(hw, hh, hw, hh)] };
  const q = [R(0, 0, hw, hh), R(hw, 0, hw, hh), R(0, hh, hw, hh), R(hw, hh, hw, hh)];
  return n === 3 ? { ov: q[0], cabs: q.slice(1) } : { ov: null, cabs: q };
}

export function draw(ctx, g, view) {
  const { width, height } = view;
  clearTruckSpot();
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
  const cabs = view.shared && view.cabs ? [...view.cabs].filter((i) => g.trucks[i] && !g.trucks[i].gone).sort((a, b) => a - b) : [];
  const tiles = cabs.length ? cabTiles(width, height, cabs.length) : null;
  if (view.povBig && !view.shared) {
    if (!drawPov3d(ctx, g, 0, 0, width, height, view.dpr, view.look)) drawPov(ctx, g, 0, 0, width, height);
    if (view.touch && width > height) { // easter egg: the minimap stays tappable to swap back to the overview
      const mm = miniSize(g, 120, 70), mx = (width - mm.w) / 2, my = height - 8 - mm.h;
      drawMiniMap(ctx, g, { x: 0, y: 0, w: g.w, h: g.h }, mx, my, mm.s);
      view.miniHit = { x: mx - 3, y: my - 3, w: mm.w + 6, h: mm.h + 6 };
    } else if (!view.touch) { // non-touch cab view: whole-map minimap bottom left, with the truck's heading
      const mm = miniSize(g, 320, 200);
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
    if (tiles?.ov) { const t = tiles.ov; rx = t.x + 8; ry = t.y + 50; rw = t.w - 16; rh = t.h - 58; }
    // When the map doesn't fit, reserve room for the minimap (above the field in portrait, left of it in landscape)
    // so it never covers the playing field.
    // Touch landscape: keep the field clear of the fork gauge at the right edge even when the whole map fits.
    const touchLand = view.touch && !portrait;
    const ext = rotatedExtent(g, view), zoomedIn = Math.min(48, rw / ext.w, rh / ext.h) < MIN_FOLLOW_SCALE;
    if (!tiles && touchLand && !zoomedIn) { rw = width - rx - GAUGE_W; rh = Math.min(rh, height - ry - PAD_H); }
    let mmX = 13, mmY = 100 + 6;
    if (strip) {
      mmX = (width - mm.w) / 2;
      mmY = height - 8 - mm.h;
      mmBox = { x: mmX, w: mm.w, y: mmY };
      view.miniHit = { x: mmX - 3, y: mmY - 3, w: mm.w + 6, h: mm.h + 6 };
    } else if (zoomedIn && !tiles) {
      if (portrait) { ry = Math.max(ry, mmY + mm.h + 12); rh = height - ry - bottom; }
      else { rx = mmX + mm.w + 16; rw = width - rx - (touchLand ? 20 : GAUGE_W); }
    }
    const cam = tiles && !tiles.ov ? null : drawOverview(ctx, g, view, rx, ry, rw, rh, 48, true, !tiles && touchLand && zoomedIn ? GAUGE_W : 0, !tiles && touchLand && zoomedIn ? PAD_H : 0);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    if (tiles) {
      cabs.forEach((i, k) => {
        const t = tiles.cabs[k], tv = i === g.self ? g : truckView(g, i);
        if (!drawPov3d(ctx, tv, t.x, t.y, t.w, t.h, view.dpr)) drawPov(ctx, tv, t.x, t.y, t.w, t.h);
        ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
        ctx.strokeStyle = truckColor(g.trucks[i].color).body;
        ctx.lineWidth = 4;
        ctx.strokeRect(t.x + 2, t.y + 2, t.w - 4, t.h - 4);
      });
      if (!tiles.ov) { // all four quadrants are cabins: a translucent whole-map minimap in the centre
        const mm4 = miniSize(g, Math.min(260, width * 0.25), Math.min(160, height * 0.25));
        ctx.globalAlpha = 0.6;
        drawMiniMap(ctx, g, { x: 0, y: 0, w: g.w, h: g.h }, (width - mm4.w) / 2, (height - mm4.h) / 2, mm4.s);
        ctx.globalAlpha = 1;
      }
    }
    if (!tiles && (strip || cam)) drawMiniMap(ctx, g, cam || { x: 0, y: 0, w: g.w, h: g.h }, mmX, mmY, mm.s);
  }
  // screen-space HUD
  const done = g.zones.filter((z) => zoneDone(g, z)).length;
  const best = view.best;
  const E = g.endless;
  const liveScore = E ? endlessScore(E) : score(g, true);
  const scoreLine = E ? `Trucks ${E.delivered}   Score ${liveScore}` : `Zones ${done}/${g.zones.length}   Score ${liveScore}/${maxScore(g)}`;
  const title = E ? `Endless   Trucks ${E.delivered}   Boxes ${E.boxes}   Bays ${E.docks.filter((d) => d.state !== 'free').length}/${DOCKS}   Score ${liveScore}   ${formatTime(g.time)}` : `Level ${g.level}${g.seed ? ` (seed ${g.seed})` : ''}   ${scoreLine}   ${formatTime(g.time)}`;
  const bestText = E ? `Bays ${E.docks.filter((d) => d.state !== 'free').length}/${DOCKS}` : best ? `Best ${best.score} by ${best.name} (${formatTime(best.time)})` : 'Best: none yet';
  const globalText = E ? '' : globalLine(view.global);
  const hint = g.status === 'play' && isSolved(g)
    ? 'All zones filled – return to the parking spot (P)'
    : '';
  const lostNow = lostBreakdown(g, true);
  const ready = g.status === 'play' && isSolved(g);
  const now = performance.now();
  const sig = `${g.level}|${g.seed}|${done}|${liveScore}|${lostNow.repairableCrash}|${lostNow.permanentCrash}|${lostNow.square}|${hint}`;
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
  else if (mmBox) drawStatusStrip(ctx, g, mmBox, scoreLine, lostNow, bestText, globalText, hint, width, height);
  else {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 20px sans-serif';
    let boxW = ctx.measureText(title).width;
    ctx.font = '14px sans-serif';
    const damageText = `Damage: −${lostNow.repairableCrash} repairable, −${lostNow.permanentCrash} permanent`;
    const bestX = Math.max(380, ctx.measureText(damageText).width + 20);
    boxW = Math.max(boxW, bestX + Math.max(E ? 0 : ctx.measureText(bestText).width, ctx.measureText(globalText).width));
    ctx.font = 'bold 16px sans-serif';
    if (hint) boxW = Math.max(boxW, ctx.measureText(hint).width);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(hx0 - 8, 8, boxW + 16, hint ? 102 : 84);
    ctx.fillStyle = '#eee';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(title, hx0, 25);
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#b3e5fc';
    if (!E) ctx.fillText(bestText, hx0 + bestX, 48); // endless: Bays is already in the title
    ctx.fillStyle = '#c5e1a5';
    ctx.fillText(globalText, hx0 + bestX, 68);
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#ef9a9a';
    ctx.fillText(damageText, hx0, 48);
    ctx.fillStyle = '#ffe082';
    ctx.fillText(`Placement −${lostNow.square} (${g.hard ? 'reported' : 'fixable'})`, hx0, 68);
    ctx.fillStyle = '#eee';

    if (hint) {
      ctx.font = 'bold 16px sans-serif';
      ctx.fillStyle = '#ffe082';
      ctx.fillText(hint, hx0, 92);
    }
  }
  ctx.restore();

  if (view.party) drawPartyBadge(ctx, g, view.party, width);

  // fork height gauge(s): one per live truck in local multiplayer, extra ones to the left
  const gauged = view.shared ? g.trucks.map((_, i) => i).filter((i) => !g.trucks[i].gone) : [g.self];
  gauged.forEach((i, k) => drawForkGauge(ctx, i === g.self ? g : truckView(g, i), width - 70 - k * GAUGE_W, 70));
  drawCompass(ctx, g, view, width);
  if (g.endless) drawDockWaits(ctx, g, width, view.touch && width > height);

  if (view.fullscreen && view.flashAt != null && ready) drawReadyFlash(ctx, width, height, (now - view.flashAt) / 1000);
  if (g.status === 'play' && !g.started && !view.startHidden && !view.paused && !view.menuOpen) drawStartBoard(ctx, g, view, width, height);
  if (view.paused) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, width, height);
  }
  if (g.status === 'over') {
    const E = g.endless;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, height / 2 - 90, width, 180 + 210);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText('Game over!', width / 2, height / 2 - 40);
    ctx.font = '20px sans-serif';
    ctx.fillText(`${E.delivered} trucks delivered, ${E.boxes} boxes, ${endlessScore(E)} points, ${formatTime(g.time)}`, width / 2, height / 2);
    ctx.fillText(view.touch ? 'Tap to play again' : 'Press Enter to play again', width / 2, height / 2 + 40);
    drawTopLists(ctx, view, width / 2, height / 2 + 70, width / 2);
  }
}

// The end-of-level results panel, drawn on its own overlay canvas (above the gallery photos) instead of on the game canvas.
export function drawResults(ctx, g, view) {
  const { width, height } = view;
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (g.status !== 'won') return;
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
  ctx.fillText(`Boxes in zones: ${pts + lost.crash + lost.square} − crashes ${lost.crash} − ${g.hard ? 'wonkiness' : 'squareness'} ${lost.square} = ${pts}`, width / 2, height / 2 - 28);
  ctx.fillText(`Time ${formatTime(g.time)}: −${timePenalty(g.time)} (1 point per 10 s)`, width / 2, height / 2 - 2);
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText(`Final score: ${finalScore(pts, g.time)}`, width / 2, height / 2 + 30);
  ctx.font = '20px sans-serif';
  ctx.fillText(view.touch ? 'Tap to continue to the next level' : 'Press Enter for the next level', width / 2, height / 2 + 70);
  drawTopLists(ctx, view, width / 2, height / 2 + 90, width / 2);
}
