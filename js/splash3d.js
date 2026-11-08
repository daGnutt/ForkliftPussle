import { createDemo } from './demo.js';
import { overviewCamera, chaseCamera, clearChaseTilt, CHASE_TILT } from './gl/camera.js';
import { drawGl, glAvailable } from './gl/renderer.js';
import { toWorld, FL } from './forklift.js';

// WebGL splash diorama: the scripted forklift of demo.js shuffles stacks round a small room while the camera cuts between
// an orbiting overview, the chase camera and a chase camera swinging round the truck. Returns false (nothing started) when WebGL is unavailable, so
// the caller can fall back to the 2D figure-eight in splash.js.
const SHOTS = [{ kind: 'orbit', secs: 10 }, { kind: 'chase', secs: 7 }, { kind: 'orbit', secs: 8 }, { kind: 'swing', secs: 7 }];
const FADE = 0.35; // seconds of fade to black at each cut
const ROOM_MID = { x: 9, y: 5 };

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function startSplash3d(canvas, isActive) {
  if (!glAvailable()) return false;
  const demo = createDemo(), g = demo.g;
  for (let i = 0; i < 60 * 3; i++) demo.step(1 / 60); // already mid-job when the splash opens
  let shot = 0, shotT = 0, last = null, heading = g.fl.a, clock = 0;
  const ctx = canvas.getContext('2d');

  function camera(w, h) {
    const kind = SHOTS[shot].kind;
    if (kind === 'chase' || kind === 'swing') {
      const tiles = 8, yaw = kind === 'swing' ? Math.sin(shotT * 0.9) * 0.8 : 0;
      const tilt = clearChaseTilt(g, tiles, heading, yaw, CHASE_TILT);
      return { cam: chaseCamera(g, w, h, tiles, heading, { yaw, tilt }), mode: 'ov' };
    }
    const phi = -Math.PI / 2 + Math.sin(clock * 0.18) * 0.9;
    return { cam: overviewCamera(ROOM_MID.x, ROOM_MID.y, 12.5, w, h, [Math.cos(phi), Math.sin(phi)], 0.6), mode: 'ov' };
  }

  function draw() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return true;
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { cam, mode } = camera(w, h);
    if (!drawGl(ctx, g, mode, cam, 0, 0, dpr)) return false;
    const fade = Math.max(0, 1 - Math.min(shotT, SHOTS[shot].secs - shotT) / FADE);
    if (fade > 0) {
      ctx.fillStyle = `rgba(0,0,0,${fade})`;
      ctx.fillRect(0, 0, w, h);
    }
    return true;
  }

  if (!draw()) return false;
  canvas.hidden = false;

  function frame(now) {
    if (!isActive()) return;
    requestAnimationFrame(frame);
    const dt = last === null ? 0 : Math.min(0.05, (now - last) / 1000);
    last = now;
    clock += dt;
    demo.step(dt);
    heading += wrap(g.fl.a - heading) * (1 - Math.exp(-dt / 0.35));
    shotT += dt;
    if (shotT >= SHOTS[shot].secs) { shotT = 0; shot = (shot + 1) % SHOTS.length; }
    draw();
  }
  requestAnimationFrame(frame);
  return true;
}
