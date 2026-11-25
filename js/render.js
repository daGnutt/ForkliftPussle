import { BARREL_COLOR, COLORS, ZONE_COLORS } from './level.js';
import { dockWaits, dockNumber, DOCKS, endlessScore } from './endless.js';
import { FL, MAX_H, toWorld, truckColor } from './forklift.js';
import { botDrawPos } from './bot.js';
import { repairHintOn, repairBlink } from './repairhint.js';
import { drawFlag } from './gl/overlay.js';
import { chaseTiles as chaseTilesFor, chaseRig, clearChaseTilt, CHASE_TILT, CHASE_TILES, CHASE_DEFAULT, headTurn } from './gl/camera.js';
import { beginGlFrame } from './gl/renderer.js';
import { clearTruckSpot, addHudRect, boxStatus } from './photo.js';
import { drawPov3d, drawOverview3d, drawLook3d } from './gl/views.js';
import { formatTime, timePenalty, finalScore } from './highscores.js';
import { theme } from './theme.js';
import { qrMatrix } from './qr.js';
import { liftedHf, carriedDrawH, carriedWorldOffs, forkHeight, zoneExt, zoneDone, flaggedStacks, stackInZone, score, maxScore, lostBreakdown, isSolved, otherTrucksShown, dropLift, stackZ, fallView, truckView } from './game.js';
import { BOX_HALF_X, halfY, LEVEL_H } from './geom.js';

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
    drawOverview3d(ctx, g, rx, ry, rw, rh, c.x, c.y, s2, view.dpr, view.orbit);
    if (zoomed) ctx.restore();
    return { x: c.x - rw / s2 / 2, y: c.y - rh / s2 / 2, w: rw / s2, h: rh / s2 };
  }
  const orbit = view.fullMap ? { yaw: 0, tilt: 0 } : follow ? view.orbit : null;
  drawOverview3d(ctx, g, rx, ry, rw, rh, (rx + rw / 2 - ox) / s, (ry + rh / 2 - oy) / s, s, view.dpr, orbit, 0, g.fl.a, null,
    view.fullMap ? (proj) => { view.observerProject = (x, y, z = 0) => proj(x, y, z * LEVEL_H); } : null);
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
  for (const t of [...otherTrucksShown(g), ...(!g.truck.gone ? [g] : [])]) {
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
  for (const t of [...otherTrucksShown(g), ...(!g.truck.gone ? [g] : [])]) {
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

// Small top-down window just in front of (or, with back, just behind) the forklift, heading up/down the screen.
function drawLookWindow(ctx, g, x, y, w, h, back, dpr = 1) {
  const scale = w / 4.5, wT = w / scale, hT = h / scale;
  const c = toWorld(g.fl, back ? FL.back + 0.5 - hT / 2 : FL.front - 0.5 + hT / 2, 0);
  drawLook3d(ctx, g, x, y, w, h, c.x, c.y, hT, back ? [-Math.cos(g.fl.a), -Math.sin(g.fl.a)] : [Math.cos(g.fl.a), Math.sin(g.fl.a)], dpr);
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

// Observer join card: a Polaroid-style QR image with the five-character party code below it.
const partyQrCache = new Map();
export function observerLayout(width, height, mapWidth, mapHeight, hasCard) {
  const margin = 8, top = 48;
  const area = { x: margin, y: top, w: Math.max(1, width - margin * 2), h: Math.max(1, height - top - margin) };
  if (!hasCard) return { area, card: null };
  const w = Math.max(180, Math.min(260, width * 0.25, height * 0.32)), h = w + 58, angle = -0.055;
  const bw = w * Math.cos(angle) + h * Math.abs(Math.sin(angle));
  const bh = h * Math.cos(angle) + w * Math.abs(Math.sin(angle));
  return { area, card: { x: Math.max(margin, width - margin - bw), y: top, w, h, bw, bh, angle } };
}

// Compare overlap lexicographically: even a crowded floor must give forklifts priority over boxes, zones, then bots.
export function placeObserverCard(area, card, obstacles, previous = null) {
  const x1 = Math.max(area.x, area.x + area.w - card.bw), y1 = Math.max(area.y, area.y + area.h - card.bh);
  const clamp = (p) => ({ x: Math.max(area.x, Math.min(x1, p.x)), y: Math.max(area.y, Math.min(y1, p.y)) });
  const anchor = clamp(previous || { x: x1, y: area.y });
  let best = null, bestScore = null;
  const consider = (x, y) => {
    const score = obstacles.map((group) => group.reduce((sum, r) => sum
      + Math.max(0, Math.min(x + card.bw, r.right) - Math.max(x, r.left))
      * Math.max(0, Math.min(y + card.bh, r.bottom) - Math.max(y, r.top)), 0));
    score.push(Math.hypot(x - anchor.x, y - anchor.y));
    const different = bestScore && score.findIndex((v, i) => Math.abs(v - bestScore[i]) > 0.01);
    if (!bestScore || (different >= 0 && score[different] < bestScore[different])) {
      best = { ...card, x, y }; bestScore = score;
    }
  };
  consider(anchor.x, anchor.y);
  if (bestScore.slice(0, obstacles.length).every((v) => v === 0)) return best;
  const nx = Math.max(1, Math.ceil((x1 - area.x) / 40)), ny = Math.max(1, Math.ceil((y1 - area.y) / 40));
  for (let ix = 0; ix <= nx; ix++) for (let iy = 0; iy <= ny; iy++) consider(area.x + (x1 - area.x) * ix / nx, area.y + (y1 - area.y) * iy / ny);
  return best;
}

export function observerObstacles(g, project) {
  const groups = [[], [], [], []];
  const rect = (group, points, pad = 8) => {
    const p = points.map(([x, y, z = 0]) => project(x, y, z)).filter(Boolean);
    if (!p.length) return;
    groups[group].push({ left: Math.min(...p.map((v) => v[0])) - pad, right: Math.max(...p.map((v) => v[0])) + pad,
      top: Math.min(...p.map((v) => v[1])) - pad, bottom: Math.max(...p.map((v) => v[1])) + pad });
  };
  const box = (group, x, y, hx, hy, a, z0, z1, pad = 8) => {
    const co = Math.cos(a), si = Math.sin(a);
    rect(group, [z0, z1].flatMap((z) => [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]
      .map(([u, v]) => [x + u * co - v * si, y + u * si + v * co, z])), pad);
  };
  for (let i = 0; i < g.trucks.length; i++) {
    if (g.trucks[i].gone) continue;
    const t = truckView(g, i), f = t.fl, centre = toWorld(f, (FL.back + FL.tineX1) / 2, 0), z = liftedHf(t) ?? 0;
    box(0, centre.x, centre.y, (FL.tineX1 - FL.back) / 2, FL.halfW + 0.15, f.a, z, z + 2.5, 14);
    if (t.carried?.length) {
      const c = toWorld(f, FL.carryX, 0), offs = carriedWorldOffs(t);
      t.carried.forEach((_, j) => {
        const o = offs?.[j] || { x: 0, y: 0 };
        box(1, c.x + o.x, c.y + o.y, BOX_HALF_X, halfY(t.carriedPen?.[j]), (t.carriedRots?.[j] || 0) + f.a,
          carriedDrawH(t) + j, carriedDrawH(t) + j + 1);
      });
    }
  }
  for (const st of g.stacks) {
    const s = fallView(g, st), z = stackZ(s) + dropLift(g, s);
    s.layers.forEach((_, i) => {
      const o = s.offs?.[i] || { x: 0, y: 0 };
      box(1, s.x + o.x, s.y + o.y, BOX_HALF_X, halfY(s.pen?.[i]), s.rots?.[i] ?? s.a ?? 0, z + i, z + i + 1);
    });
  }
  for (const z of g.zones) { const e = zoneExt(z); box(2, z.x, z.y, e.x, e.y, 0, 0, 0); }
  for (const b of [g.bot, g.inspector]) {
    if (!b || b.show <= 0) continue;
    const p = botDrawPos(b, g.hatch);
    box(3, p.x, p.y, 0.55, 0.55, b.a || 0, 0, 0.8);
  }
  return groups;
}

function floatingObserverCard(view, g, area, card) {
  const now = performance.now(), old = view.observerCard;
  const previous = old?.g === g && old.w === card.w && old.areaW === area.w && old.areaH === area.h ? old : null;
  const target = placeObserverCard(area, card, observerObstacles(g, view.observerProject), previous);
  const k = previous ? 1 - Math.exp(-8 * Math.min(0.1, Math.max(0, (now - previous.time) / 1000))) : 1;
  const out = { ...target, x: previous ? previous.x + (target.x - previous.x) * k : target.x,
    y: previous ? previous.y + (target.y - previous.y) * k : target.y, time: now, g, areaW: area.w, areaH: area.h };
  view.observerCard = out;
  return out;
}
function drawPartyJoinCard(ctx, party, rect) {
  if (!rect) return null;
  const { x, y, w, h, bw, bh, angle } = rect;
  const picture = w - 20;
  ctx.save();
  ctx.translate(x + bw / 2, y + bh / 2);
  ctx.rotate(angle);
  ctx.translate(-w / 2, -h / 2);
  ctx.fillStyle = '#fff';
  ctx.shadowColor = 'rgba(0,0,0,.55)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 3);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  let matrix = partyQrCache.get(party.url);
  if (!matrix) {
    try { matrix = qrMatrix(party.url); } catch { matrix = []; }
    partyQrCache.set(party.url, matrix);
  }
  const px = (w - picture) / 2, py = 10;
  ctx.fillStyle = '#111';
  ctx.fillRect(px, py, picture, picture);
  ctx.fillStyle = '#fff';
  ctx.fillRect(px + 1, py + 1, picture - 2, picture - 2);
  const unit = matrix.length ? Math.floor(picture / (matrix.length + 8)) : 0;
  const ox = px + Math.floor((picture - unit * matrix.length) / 2);
  const oy = py + Math.floor((picture - unit * matrix.length) / 2);
  ctx.fillStyle = '#111';
  for (let yy = 0; yy < matrix.length; yy++) for (let xx = 0; xx < matrix.length; xx++) {
    if (matrix[yy][xx]) ctx.fillRect(ox + xx * unit, oy + yy * unit, unit, unit);
  }
  if (!matrix.length) {
    ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.font = '12px sans-serif';
    ctx.fillText('Enter party code', w / 2, py + picture / 2, picture - 8);
  }
  ctx.fillStyle = '#43a047';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText('JOIN THE PARTY', w / 2, w + 9);
  ctx.fillStyle = '#111';
  ctx.font = 'bold 24px monospace';
  ctx.fillText(party.code, w / 2, w + 35);
  ctx.restore();
  addHudRect(x, y, x + bw, y + bh);
  return { x, y, w, h };
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
  const cell = 26, top = MAX_H;
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
  if (g.hard) ctx.fillRect(gx + 34, yOf(forkHeight(g)) + cell - 4, 8, 4); // exact box-bottom height between levels
}

function drawCompass(ctx, g, view, width) {
  let a; // world heading of the screen's "up"
  if (view.povBig) a = g.fl.a + (view.look ? view.look.yaw : 0) + (view.gamepadCab || view.touchManualCab ? 0 : headTurn(g.fl));
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
  beginGlFrame(ctx, theme().bg);
  const strip = view.touch && !view.fullMap && !view.povBig && width > height;
  let mmBox = null;
  view.miniHit = null;
  const hx0 = 20;
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  const cabs = view.shared && view.cabs ? [...view.cabs].filter((i) => g.trucks[i] && !g.trucks[i].gone).sort((a, b) => a - b) : [];
  const tiles = cabs.length ? cabTiles(width, height, cabs.length) : null;
  if (view.povBig && !view.shared) {
    drawPov3d(ctx, g, 0, 0, width, height, view.dpr, view.look, !view.gamepadCab && !view.touchManualCab);
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
    let joinCard = null;
    if (tiles?.ov) { const t = tiles.ov; rx = t.x + 8; ry = t.y + 50; rw = t.w - 16; rh = t.h - 58; }
    // When the map doesn't fit, reserve room for the minimap (above the field in portrait, left of it in landscape)
    // so it never covers the playing field.
    // Touch landscape: keep the field clear of the fork gauge at the right edge even when the whole map fits.
    const touchLand = view.touch && !view.fullMap && !portrait;
    if (!tiles && view.touch && !view.fullMap && portrait && view.tutorialBottom) {
      ry = Math.max(ry, Math.min(view.tutorialBottom + 12, height - bottom - 30));
      rh = height - ry - bottom;
    }
    const ext = rotatedExtent(g, view), zoomedIn = !view.fullMap && Math.min(48, rw / ext.w, rh / ext.h) < MIN_FOLLOW_SCALE;
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
    if (view.fullMap) {
      const layout = observerLayout(width, height, g.w, g.h, !!view.partyJoin);
      ({ x: rx, y: ry, w: rw, h: rh } = layout.area);
      joinCard = layout.card;
    }
    const cam = tiles && !tiles.ov ? null : drawOverview(ctx, g, view, rx, ry, rw, rh, view.fullMap ? Infinity : 48, !view.fullMap, !tiles && touchLand && zoomedIn ? GAUGE_W : 0, !tiles && touchLand && zoomedIn ? PAD_H : 0);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    if (joinCard && view.partyJoin && view.observerProject) {
      drawPartyJoinCard(ctx, view.partyJoin, floatingObserverCard(view, g, { x: rx, y: ry, w: rw, h: rh }, joinCard));
    } else view.observerCard = null;
    if (tiles) {
      cabs.forEach((i, k) => {
        const t = tiles.cabs[k], tv = i === g.self ? g : truckView(g, i);
        drawPov3d(ctx, tv, t.x, t.y, t.w, t.h, view.dpr, null, i === g.self && !view.gamepadCab && !view.touchManualCab);
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
  if (view.fullscreen && !view.fullMap && !(view.touch && width > height)) { // observer and touch landscape HUDs stay visible
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
  else if (view.fullMap) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(8, 8, Math.max(1, width - 100), 30);
    ctx.fillStyle = '#eee';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText(title, 14, 23, Math.max(1, width - 112));
  }
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

  if (view.party && !view.fullMap) drawPartyBadge(ctx, g, view.party, width);

  // fork height gauge(s): one per live truck in local multiplayer, extra ones to the left
  const gauged = view.fullMap ? [] : view.shared ? g.trucks.map((_, i) => i).filter((i) => !g.trucks[i].gone) : [g.self];
  gauged.forEach((i, k) => drawForkGauge(ctx, i === g.self ? g : truckView(g, i), width - 70 - k * GAUGE_W, 70));
  drawCompass(ctx, g, view, width);
  if (g.endless) drawDockWaits(ctx, g, width, view.touch && width > height);

  if (view.fullscreen && view.flashAt != null && ready) drawReadyFlash(ctx, width, height, (now - view.flashAt) / 1000);
  if (!view.fullMap && g.status === 'play' && !g.started && !view.startHidden && !view.paused && !view.menuOpen) drawStartBoard(ctx, g, view, width, height);
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
    ctx.fillText(view.round ? 'Waiting for the next round' : view.touch ? 'Tap to play again' : 'Press Enter to play again', width / 2, height / 2 + 40);
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
  const k = Math.min(1, Math.max(0.55, width / 620)); // shrink text and spacing on narrow (portrait) screens
  const maxW = width * 0.94;
  const font = (px, bold) => `${bold ? 'bold ' : ''}${Math.round(px * k)}px sans-serif`;
  const cx = width / 2;
  const top = Math.max(0, height / 2 - 110 * k - 20);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  // Lay out the lines first so the backdrop can be sized to fit them.
  const lines = [];
  const add = (text, px, bold, gap) => {
    ctx.font = font(px, bold);
    for (const t of wrapText(ctx, text, maxW)) lines.push({ t, f: ctx.font, gap });
  };
  add('Level complete!', 36, true, 46);
  add(`Boxes in zones: ${pts + lost.crash + lost.square} − crashes ${lost.crash} − ${g.hard ? 'wonkiness' : 'squareness'} ${lost.square} = ${pts}`, 18, false, 26);
  add(`Time ${formatTime(g.time)}: −${timePenalty(g.time)} (1 point per 10 s)`, 18, false, 32);
  add(`Final score: ${finalScore(pts, g.time)}`, 22, true, 34);
  add(view.round ? 'Waiting for the next round' : view.touch ? 'Tap to continue to the next level' : 'Press Enter for the next level', 20, false, 36);
  let y = top + 20;
  const ys = lines.map((l, i) => (y += (i ? lines[i - 1].gap * k : 36 * k)));
  const listY = y + 20 * k;
  const listH = 18 * 11 + 6;
  const boxH = Math.min(height - top, listY + listH + 10 - top);
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, top, width, boxH);
  ctx.fillStyle = '#fff';
  lines.forEach((l, i) => { ctx.font = l.f; ctx.fillText(l.t, cx, ys[i], maxW); });
  drawTopLists(ctx, view, cx, listY, Math.max(width / 2, Math.min(width, 540)));
}

// Splits text on spaces into lines no wider than maxWidth (a single overlong word stays on its own line).
function wrapText(ctx, text, maxWidth) {
  const out = [];
  let cur = '';
  for (const w of text.split(' ')) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && ctx.measureText(next).width > maxWidth) { out.push(cur); cur = w; } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}
