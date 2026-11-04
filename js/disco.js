import { theme } from './theme.js';
import { FL, toWorld } from './forklift.js';
import { toCam, project, fillPoly, WALL_H, MAX_DIST } from './pov/camera.js';

// Dark-mode disco: randomly scattered glitter balls plus coloured light spots orbiting it on the floor.
// Everything is a pure function of the game clock; shared by the overview (render.js) and the cabin view (pov.js).
export const BALL_R = 0.7; // tiles
export const BALL_DROP = 1.2; // ball centre below the ceiling (cabin view)
export const SPOT_R = 2.6;
const SPOTS = 3;

let enabled = true;
export const discoEnabled = () => enabled;
export function setDiscoEnabled(on) { enabled = !!on; }
export const discoOn = () => enabled && theme().disco === true;

// Ball positions: randomly scattered (seeded by level and seed, cached per game), about one per 150 tiles, at least 2.
const ballCache = new WeakMap();
export function discoBalls(g) {
  let balls = ballCache.get(g);
  if (balls) return balls;
  let a = (Math.imul(g.level || 1, 2654435761) ^ Math.imul((g.seed || 0) + 1, 40503)) >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = Math.max(2, Math.min(40, Math.round((g.w * g.h) / 150)));
  balls = [];
  for (let i = 0; i < n; i++) balls.push({ x: 1 + rnd() * (g.w - 2), y: 1 + rnd() * (g.h - 2), k: Math.floor(rnd() * 100), hide: false });
  ballCache.set(g, balls);
  return balls;
}

// Light sources: every ball plus one riding on the forklift (no visible ball).
export function discoSources(g) {
  const c = toWorld(g.fl, (FL.front - FL.back) / 2, 0);
  return [...discoBalls(g), { x: c.x, y: c.y, k: 5, hide: true }];
}

export function discoSpots(ball, t) {
  const out = [];
  for (let n = 0; n < SPOTS; n++) {
    const a = t * (0.5 + 0.15 * n) * (n % 2 ? -1 : 1) + (n * 2 * Math.PI) / SPOTS + ball.k;
    const r = 3 + 1.5 * Math.sin(t * 0.7 + n + ball.k);
    out.push({ x: ball.x + Math.cos(a) * r, y: ball.y + Math.sin(a) * r, hue: (t * 60 + n * 120 + ball.k * 30) % 360 });
  }
  return out;
}

// Light pools on the floor in world units (the caller sets the transform).
export function drawDiscoSpots(ctx, g, vis) {
  const t = g.clock || 0;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const b of discoSources(g)) {
    for (const s of discoSpots(b, t)) {
      if (vis && (s.x + SPOT_R < vis.x0 || s.x - SPOT_R > vis.x1 || s.y + SPOT_R < vis.y0 || s.y - SPOT_R > vis.y1)) continue;
      const gr = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, SPOT_R);
      gr.addColorStop(0, `hsla(${s.hue},100%,60%,0.55)`);
      gr.addColorStop(1, `hsla(${s.hue},100%,60%,0)`);
      ctx.fillStyle = gr;
      ctx.fillRect(s.x - SPOT_R, s.y - SPOT_R, SPOT_R * 2, SPOT_R * 2);
    }
  }
  ctx.restore();
}

// A mirrored ball of screen/world radius r centred at (cx, cy): silver sphere with glittering rotating facets.
export function drawGlitterBall(ctx, cx, cy, r, t, k = 0) {
  const gr = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
  gr.addColorStop(0, '#f4f6fa');
  gr.addColorStop(1, '#5d6470');
  ctx.fillStyle = gr;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  const N = 40, size = r * 0.2;
  for (let i = 0; i < N; i++) {
    const lat = Math.asin(((i + 0.5) / N) * 2 - 1);
    const lon = i * 2.39996 + t * 0.9 + k;
    const front = Math.cos(lat) * Math.cos(lon);
    if (front <= 0.05) continue;
    const sx = cx + r * Math.cos(lat) * Math.sin(lon), sy = cy - r * Math.sin(lat);
    const tw = Math.max(0, Math.sin(t * 5 + i * 1.7 + k));
    ctx.fillStyle = tw > 0.85 ? '#fff' : `hsl(${(i * 47 + t * 90) % 360},60%,${45 + tw * 25}%)`;
    ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
  }
  ctx.globalCompositeOperation = 'lighter';
  const flash = Math.max(0, Math.sin(t * 3 + k)) ** 6;
  ctx.fillStyle = `rgba(255,255,255,${0.5 * flash})`;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}

// Cabin view: 'floor' draws the light pools as projected floor polygons; 'balls' returns depth-sorted draw items
// ({ d, draw }) for the hanging balls, to be merged with the faces so nearer walls and boxes cover them and farther ones don't.
export function drawDiscoPov(ctx, g, cam, part) {
  const t = g.clock || 0;
  if (part === 'floor') {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const b of discoSources(g)) {
      for (const s of discoSpots(b, t)) {
        if (Math.hypot(s.x - cam.x, s.y - cam.y) > MAX_DIST / 2) continue;
        for (const [rr, a] of [[1, 0.18], [0.65, 0.22], [0.3, 0.3]]) {
          const ring = [];
          for (let i = 0; i < 16; i++) ring.push(toCam(cam, s.x + Math.cos((i * Math.PI) / 8) * SPOT_R * rr, s.y + Math.sin((i * Math.PI) / 8) * SPOT_R * rr, 0));
          fillPoly(ctx, project(cam, ring), `hsla(${s.hue},100%,60%,${a})`);
        }
      }
    }
    ctx.restore();
    return;
  }
  return discoBalls(g).map((b) => ({
    d: Math.hypot(b.x - cam.x, b.y - cam.y, WALL_H - BALL_DROP - cam.z) - BALL_R,
    draw: (ctx) => drawBallPov(ctx, cam, b, t),
  }));
}

function drawBallPov(ctx, cam, b, t) {
  const c = toCam(cam, b.x, b.y, WALL_H - BALL_DROP);
  if (c[0] < 0.3 || c[0] > MAX_DIST) return;
  const top = toCam(cam, b.x, b.y, WALL_H);
  const X = cam.cx + (c[1] / c[0]) * cam.f, Y = cam.cy - (c[2] / c[0]) * cam.f;
  const R = (BALL_R / c[0]) * cam.f;
  ctx.strokeStyle = 'rgba(200,200,210,0.6)';
  ctx.lineWidth = Math.max(1, R * 0.06);
  ctx.beginPath();
  ctx.moveTo(cam.cx + (top[1] / top[0]) * cam.f, cam.cy - (top[2] / top[0]) * cam.f);
  ctx.lineTo(X, Y);
  ctx.stroke();
  drawGlitterBall(ctx, X, Y, R, t, b.k);
}
