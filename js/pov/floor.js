import { COLORS } from '../level.js';
import { theme } from '../theme.js';
import { decalsEnabled, floorDecals } from '../decals.js';
import { FL } from '../forklift.js';
import { reverseLight } from '../revlight.js';
import { zoneDone, isSolved, scoreEnough, isParked } from '../game.js';
import { project, fillPoly, floorPoly, strokeLines, toCam, WALL_H } from './camera.js';

// Everything painted before the 3D faces: ceiling, floor grid, decals, zone/parking marks, reversing light.

const GRID_R = 40;

// Ceiling plane over the whole level with steel joists every 4 tiles.
export function drawCeiling(ctx, g, cam) {
  const pt = (x, y) => toCam(cam, x, y, WALL_H);
  fillPoly(ctx, project(cam, [pt(0, 0), pt(g.w, 0), pt(g.w, g.h), pt(0, g.h)]), '#3d424a');
  const segs = [];
  for (let x = 0; x <= g.w; x += 4) segs.push([x, 0, x, g.h]);
  for (let y = 0; y <= g.h; y += 4) segs.push([0, y, g.w, y]);
  strokeLines(ctx, cam, segs, WALL_H, 'rgba(15,17,20,0.7)', 3);
}

export function drawFloorGrid(ctx, cam) {
  const x0 = Math.floor(cam.x - GRID_R), x1 = Math.ceil(cam.x + GRID_R), y0 = Math.floor(cam.y - GRID_R), y1 = Math.ceil(cam.y + GRID_R);
  const segs = [];
  for (let gx = x0; gx <= x1; gx++) segs.push([gx, y0, gx, y1]);
  for (let gy = y0; gy <= y1; gy++) segs.push([x0, gy, x1, gy]);
  strokeLines(ctx, cam, segs, 0, theme().povGrid, 1);
}

export function drawFloorDecals(ctx, g, cam) {
  if (!decalsEnabled()) return;
  for (const d of floorDecals(g)) {
    if (Math.hypot(d.pts[0][0] - cam.x, d.pts[0][1] - cam.y) > GRID_R) continue;
    floorPoly(ctx, cam, d.pts, d.fill);
  }
}

function parkingCorners(g) {
  const p = g.parking, hx = (FL.front - FL.back) / 2 + 0.2, hy = FL.halfW + 0.2;
  const c = Math.cos(p.a), s = Math.sin(p.a);
  return [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([u, v]) => [p.x + u * c - v * s, p.y + u * s + v * c]);
}

export function drawFloorMarks(ctx, g, cam) {
  for (const z of g.zones) {
    const done = zoneDone(g, z), r = 0.6;
    floorPoly(ctx, cam, [[z.x - r, z.y - r], [z.x + r, z.y - r], [z.x + r, z.y + r], [z.x - r, z.y + r]],
      COLORS[z.color] + (done ? 'cc' : '77'), COLORS[z.color]);
  }
  const ready = isSolved(g) && scoreEnough(g);
  floorPoly(ctx, cam, parkingCorners(g),
    ready ? (isParked(g) ? '#66bb6a99' : '#66bb6a66') : '#9e9e9e55', ready ? '#66bb6a' : '#bdbdbd');
  if (ready) {
    const p = g.parking, hx = (FL.front - FL.back) / 2 + 0.2, c = Math.cos(p.a), s = Math.sin(p.a);
    const arrow = [[hx - 0.15, 0], [hx - 0.75, -0.45], [hx - 0.75, 0.45]]
      .map(([u, v]) => [p.x + u * c - v * s, p.y + u * s + v * c]);
    floorPoly(ctx, cam, arrow, '#66bb6a', '#66bb6a');
  }
}

const revAlpha = (g) => 0.45 + 0.2 * Math.sin(g.clock * 14);

export function drawRevFloor(ctx, g, cam) {
  const L = reverseLight(g);
  if (!L) return;
  floorPoly(ctx, cam, L.pts.map((p) => [p.x, p.y]), `rgba(41,121,255,${revAlpha(g)})`);
  floorPoly(ctx, cam, L.pts.map((p) => [L.x + (p.x - L.x) * 0.45, L.y + (p.y - L.y) * 0.45]), `rgba(144,202,249,${revAlpha(g)})`);
}

// Where the light touches a wall it climbs up it (drawn over the faces).
export function drawRevWalls(ctx, g, cam) {
  const L = reverseLight(g);
  if (!L) return;
  const fill = `rgba(41,121,255,${revAlpha(g) * 0.8})`;
  ctx.fillStyle = fill;
  const n = L.pts.length;
  for (let i = 0; i < n; i++) {
    const a = L.pts[i], b = L.pts[(i + 1) % n];
    if (!a.wall || !b.wall) continue;
    if (Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5) continue;
    fillPoly(ctx, project(cam, [
      toCam(cam, a.x, a.y, 0), toCam(cam, b.x, b.y, 0),
      toCam(cam, b.x, b.y, b.climb), toCam(cam, a.x, a.y, a.climb),
    ]), fill);
  }
}
