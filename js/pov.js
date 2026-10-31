import { theme } from './theme.js';
import { toWorld } from './forklift.js';
import { makeCamera, EYE_X, EYE_Z, EYE_FOLLOW, EYE_TILT, HFOV, BOX_H, PAL, MAX_DIST } from './pov/camera.js';
import { buildFaces } from './pov/scene.js';
import { drawFace } from './pov/face.js';
import { drawCeiling, drawFloorGrid, drawFloorDecals, drawFloorMarks, drawRevFloor, drawRevWalls } from './pov/floor.js';
import { zoneLabelItems, drawHits } from './pov/overlay.js';

// Cabin view: a small polygon-projection 3D renderer (see docs/CODE_GUIDE.md, js/pov/).

// First-person view from the cabin, drawn into the box (x, y, w, h).
export function drawPov(ctx, g, x, y, w, h) {
  const yaw = g.fl.a;
  const horizon = h * (0.32 + EYE_TILT * (g.ef - g.hf));
  const cam = makeCamera(toWorld(g.fl, EYE_X, 0), EYE_Z + EYE_FOLLOW * g.ef * (BOX_H + PAL), yaw,
    HFOV, x, y, w, horizon);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  const sky = ctx.createLinearGradient(0, y, 0, y + horizon);
  sky.addColorStop(0, theme().skyTop);
  sky.addColorStop(1, theme().skyBottom);
  ctx.fillStyle = sky;
  ctx.fillRect(x, y, w, horizon);
  const floor = ctx.createLinearGradient(0, y + horizon, 0, y + h);
  floor.addColorStop(0, theme().floorFar);
  floor.addColorStop(1, theme().floor);
  ctx.fillStyle = floor;
  ctx.fillRect(x, y + horizon, w, h - horizon);

  drawCeiling(ctx, g, cam);
  drawFloorGrid(ctx, cam);
  drawFloorDecals(ctx, g, cam);
  drawFloorMarks(ctx, g, cam);
  drawRevFloor(ctx, g, cam);
  const faces = buildFaces(g, cam);
  const labels = zoneLabelItems(g, cam).sort((a, b) => b.d - a.d);
  let li = 0;
  for (const f of faces) {
    while (li < labels.length && labels[li].d >= f.d) labels[li++].draw(ctx);
    if (f.d < MAX_DIST) drawFace(ctx, cam, g, f);
  }
  while (li < labels.length) labels[li++].draw(ctx);
  drawRevWalls(ctx, g, cam);
  drawHits(ctx, g, cam);
  ctx.restore();

  ctx.strokeStyle = '#111';
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('CABIN VIEW  (M: swap)', x + 6, y + 5);
}
