import { Mesh, parseColor } from './mesh.js';
import { perspective, mul, viewBasis, projectPoint } from './mat.js';
import { addStack, WALL_H, BOX_H, PAL } from './models.js';
import { drawGl, renderPhotoScene } from './renderer.js';
import { bindTrucks } from '../game.js';

// The inspector's frozen warehouse scene, seen from its low vantage point.
// Photos without a scene use the original synthetic room.

const CAM_H = 0.2, NEAR = 0.05, FAR = 60, WALL_D = 5, ROOM = 12;
const FLOOR = '#8b867b', LINE = '#6d695f', WALL = '#b9a27a', CEIL = '#3a4658', LIGHT = '#fff8d6', SKY = '#1b2330';

// Pure: camera pose (`vp`, `eye`, `pitch`, `vfov`) that frames the whole stack, whatever its height.
export function photoCamera(photo, w, h) {
  const layers = Math.max(1, photo.layers.length), height = layers * (BOX_H + PAL), view = photo.view || 0;
  const d = photo.scene ? Math.max(0.01, photo.dist) : Math.max(1.1, photo.dist || 1.4), near = Math.max(0.05, d - 0.7);
  const top = Math.atan2(height - CAM_H, near), bottom = Math.atan2(-CAM_H, near);
  const pitch = (top + bottom) / 2, vfov = Math.min(1.9, Math.max(0.7, (top - bottom) * 1.25 + 0.15));
  const c = Math.cos(view), s = Math.sin(view), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const origin = photo.scene?.origin || { x: 0, y: 0 };
  const eye = [origin.x - c * d, origin.y - s * d, CAM_H];
  const f2h = 1 / Math.tan(vfov / 2), f2w = f2h * h / w;
  const proj = perspective(f2w, f2h, 0, NEAR, FAR);
  const vp = mul(proj, viewBasis(eye, [-s, c, 0], [-c * sp, -s * sp, cp], [c * cp, s * cp, sp]));
  return { vp, eye, w, h, pitch, vfov };
}

// Floor with tile lines, the wall behind the stack, ceiling with light panels, laid out around the view direction.
function addRoom(m, view) {
  const c = Math.cos(view), s = Math.sin(view);
  const at = (u, v, z) => [c * u - s * v, s * u + c * v, z]; // u along the view direction, v across it
  m.quad(at(-ROOM, -ROOM, 0), at(WALL_D, -ROOM, 0), at(WALL_D, ROOM, 0), at(-ROOM, ROOM, 0), [0, 0, 1], parseColor(FLOOR));
  const mid = (WALL_D - ROOM) / 2, half = (WALL_D + ROOM) / 2;
  for (let k = -ROOM; k <= WALL_D; k++) {
    if (k >= -ROOM && k <= ROOM) m.cuboid(...at(mid, k, 0).slice(0, 2), view, half, 0.012, 0, 0.004, LINE, { bottom: false });
    m.cuboid(...at(k, 0, 0).slice(0, 2), view + Math.PI / 2, ROOM, 0.012, 0, 0.004, LINE, { bottom: false });
  }
  m.quad(at(WALL_D, -ROOM, 0), at(WALL_D, ROOM, 0), at(WALL_D, ROOM, WALL_H), at(WALL_D, -ROOM, WALL_H), [-c, -s, 0], parseColor(WALL));
  m.quad(at(-ROOM, ROOM, WALL_H), at(WALL_D, ROOM, WALL_H), at(WALL_D, -ROOM, WALL_H), at(-ROOM, -ROOM, WALL_H), [0, 0, -1], parseColor(CEIL));
  for (let i = 0; i < 3; i++) for (let j = -1; j <= 1; j++) m.cuboid(...at(-1 + i * 2.5, j * 3, 0).slice(0, 2), view, 0.5, 1.2, WALL_H - 0.01, WALL_H, LIGHT, { emissive: true, top: false });
}

// Draws the picture into the w×h css-px rect at (x, y) of `ctx`. Returns a projector (world x, y, z -> [sx, sy, depth] in ctx px, or null behind the
// camera) for overlays, or null (nothing drawn) without WebGL.
export function drawPhotoGl(ctx, photo, x, y, w, h) {
  const pw = Math.max(1, Math.round(w)), ph = Math.max(1, Math.round(h));
  if (photo.scene) {
    let g = photoGames.get(photo.scene);
    if (!g) {
      g = { ...photo.scene.state };
      bindTrucks(g);
      photoGames.set(photo.scene, g);
    }
    const cam = photoCamera(photo, w, h);
    const proj = drawGl(ctx, g, 'pov', cam, x, y, 1);
    if (!proj) return null;
    const { origin } = photo.scene;
    return (wx, wy, wz) => proj(wx + origin.x, wy + origin.y, wz);
  }
  const m = new Mesh(), tm = new Mesh();
  addRoom(m, photo.view || 0);
  addStack(m, tm, 0, 0, photo.rots || [], photo.layers, 0, photo.offs || [], 0, 0, photo.pens || []);
  const cam = photoCamera(photo, pw, ph), canvas = renderPhotoScene(m, tm, cam, pw, ph, SKY);
  if (!canvas) return null;
  ctx.drawImage(canvas, 0, canvas.height - ph, pw, ph, x, y, w, h);
  const { vp } = cam;
  return (wx, wy, wz) => { const q = projectPoint(vp, wx, wy, wz, w, h); return q && [x + q[0], y + q[1], q[2]]; };
}

const photoGames = new WeakMap();
