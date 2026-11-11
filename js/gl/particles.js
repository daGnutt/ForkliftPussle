import { COLORS } from '../level.js';
import { theme } from '../theme.js';
import { FL, toWorld } from '../forklift.js';
import { zoneDone, otherTrucks, isGhost } from '../game.js';
import { parseColor } from './mesh.js';
import { BOX_H, PAL } from './models.js';

// Purely visual particles for the GL views (no DOM, nothing here feeds back into the game). The system watches the game
// state between frames and spawns: sparks (wall bonks, scraping), tyre smoke (`slip`: wheels spinning against something
// that does not give), box damage smoke and cardboard chips (new `hits`), dust when a stack is set down, and confetti
// when a zone is completed. State lives per game in a WeakMap and is stepped once per `g.clock` change, so the
// several views drawn in one frame (cabin + minimap) share it. Emissive sparks go in the opaque mesh, soft puffs in
// the transparent one.

const MAX = 700, FAR = 45, MAX_STEP = 0.1;
const rnd = (a = 0, b = 1) => a + Math.random() * (b - a);

const states = new WeakMap();

function stateFor(g) {
  let s = states.get(g.root);
  if (!s) states.set(g.root, (s = { ps: [], flashes: [], clock: null, bonks: new Map(), carried: new Map(), hitCount: g.root.hitCount || 0, popN: Math.max(0, ...(g.root.pops || []).map((p) => p.n)), zones: null, acc: new Map() }));
  return s;
}

function emit(s, p) {
  if (s.ps.length >= MAX) s.ps.shift();
  s.ps.push({ age: 0, drag: 0, grav: 0, ...p });
}

const sparks = (s, x, y, z, nx, ny, n, speed) => {
  for (let i = 0; i < n; i++) {
    const a = Math.atan2(ny, nx) + rnd(-1.2, 1.2), v = rnd(0.4, 1) * speed;
    emit(s, { kind: 'spark', x, y, z, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: rnd(0.3, 2.2), life: rnd(0.25, 0.6), size: rnd(0.025, 0.045), grav: 7, drag: 0.8 });
  }
};

const puff = (s, x, y, z, o = {}) => {
  const a = rnd(0, Math.PI * 2), v = rnd(0.05, 0.3) * (o.spread ?? 1);
  emit(s, { kind: 'smoke', x, y, z, vx: Math.cos(a) * v + (o.vx || 0), vy: Math.sin(a) * v + (o.vy || 0), vz: rnd(0.2, 0.6), life: rnd(0.7, 1.2) * (o.life ?? 1), size: o.size ?? 0.12, grow: o.grow ?? 0.35, drag: 1.2, col: o.col || [0.86, 0.86, 0.88], a0: o.a0 ?? 0.55 });
};

const wheelPoints = (f) => {
  const W = FL.halfW;
  return [toWorld(f, -FL.L, -W + 0.08), toWorld(f, -FL.L, W - 0.08), toWorld(f, 0, -W - 0.02), toWorld(f, 0, W + 0.02)];
};

// Hit height: `z` of a popup is in box heights.
const hitZ = (z) => PAL + Math.max(0, z - 0.5) * BOX_H;

function watchTruck(s, t, dt) {
  const f = t.fl, id = t.truck.id, c = t.contact;
  const was = s.bonks.get(id);
  s.bonks.set(id, t.bonks);
  if (was !== undefined && t.bonks > was && c) {
    const pw = t.bonkPower || 0.5;
    sparks(s, c.x, c.y, 0.25, c.nx, c.ny, 8 + Math.round(pw * 26), 1.5 + pw * 3.5);
    for (let i = 0; i < 3; i++) puff(s, c.x, c.y, 0.2, { size: 0.1, grow: 0.5, col: [0.7, 0.68, 0.64], a0: 0.4, vx: c.nx * 0.4, vy: c.ny * 0.4 });
    s.flashes.push({ x: c.x, y: c.y, z: 0.6, age: 0, life: 0.16, k: 0.7 + pw });
  }
  const acc = (key, rate) => {
    const n = (s.acc.get(key) || 0) + rate * dt;
    s.acc.set(key, n % 1);
    return Math.floor(n);
  };
  if (t.scrape > 0 && c) {
    const k = acc(`sc${id}`, 18 + 16 * Math.min(t.scrape, 4));
    sparks(s, c.x, c.y, 0.2, c.nx, c.ny, k, 0.8 + t.scrape * 0.5);
  }
  if ((t.slip || 0) > 0.05) {
    const wheels = wheelPoints(f);
    for (let k = acc(`sl${id}`, 55 * t.slip); k > 0; k--) {
      const w = wheels[Math.random() < 0.75 ? (Math.random() < 0.5 ? 0 : 1) : 2 + ((Math.random() * 2) | 0)];
      puff(s, w.x, w.y, 0.08, { size: 0.09 + 0.05 * t.slip, grow: 0.55, a0: 0.35 + 0.3 * t.slip, life: 0.9, spread: 0.7 });
    }
  }
  // set down a stack: dust where it lands
  const had = s.carried.get(id);
  const has = !!t.carried;
  s.carried.set(id, has);
  if (had && !has) {
    const p = toWorld(f, FL.carryX, 0);
    for (let i = 0; i < 7; i++) puff(s, p.x, p.y, 0.05, { size: 0.1, grow: 0.5, spread: 2.2, col: [0.76, 0.7, 0.62], a0: 0.4, life: 0.8 });
  }
}

function watchHits(s, g) {
  const r = g.root, n = r.hitCount || 0;
  if (n > s.hitCount) {
    const h = (r.hits || []).filter((q) => !q.score).sort((a, b) => b.t - a.t)[0];
    if (h) {
      const z = hitZ(h.z), amount = Math.min(1, 0.3 + (h.pts || 1) / 8);
      for (let i = 0; i < 4 + Math.round(amount * 6); i++) puff(s, h.x + rnd(-0.3, 0.3), h.y + rnd(-0.3, 0.3), z + rnd(-0.1, 0.2), { size: 0.12, grow: 0.5, col: [0.42, 0.4, 0.38], a0: 0.5, life: 1.3 });
      for (let i = 0; i < 3 + Math.round(amount * 8); i++) {
        const a = rnd(0, Math.PI * 2), v = rnd(0.5, 1.8);
        emit(s, { kind: 'chip', x: h.x, y: h.y, z: z + 0.1, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: rnd(1, 3), life: rnd(0.6, 1.2), size: rnd(0.03, 0.07), grav: 9, col: Math.random() < 0.5 ? [0.72, 0.55, 0.32, 1] : [0.58, 0.42, 0.24, 1] });
      }
    }
  }
  s.hitCount = n;
}

// A truck popped in or out (`pops`, queued by main.js): a big smoke cloud with a bright flash, sparks, a ring of dust,
// confetti and rising stars where it stood.
function watchPops(s, g) {
  const CONF = [[1, 0.3, 0.3], [1, 0.85, 0.2], [0.3, 0.6, 1], [0.4, 0.9, 0.4], [1, 0.5, 0.9]];
  for (const p of g.pops || []) {
    if (p.n <= s.popN) continue;
    s.popN = p.n;
    for (let i = 0; i < 26; i++) puff(s, p.x + rnd(-0.5, 0.5), p.y + rnd(-0.5, 0.5), rnd(0.1, 0.5), { size: 0.2, grow: 0.9, spread: 3, a0: 0.8, life: 1.6, col: [0.95, 0.95, 0.97] });
    for (let i = 0; i < 16; i++) { // dust ring
      const a = (i / 16) * Math.PI * 2;
      puff(s, p.x, p.y, 0.1, { size: 0.2, grow: 0.8, spread: 0, vx: Math.cos(a) * 2.2, vy: Math.sin(a) * 2.2, a0: 0.5, life: 1.2, col: [0.8, 0.76, 0.7] });
    }
    sparks(s, p.x, p.y, 0.5, 0, 0, 40, 5);
    for (let i = 0; i < 40; i++) {
      const a = rnd(0, Math.PI * 2), v = rnd(0.5, 2.6), c = CONF[i % CONF.length];
      emit(s, { kind: 'chip', x: p.x, y: p.y, z: 0.5, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: rnd(3, 6.5), life: rnd(1.2, 2.2), size: rnd(0.04, 0.07), grav: 6, drag: 0.5, col: [c[0], c[1], c[2], 1], lit: true });
    }
    for (let i = 0; i < 8; i++) { // rising yellow stars
      const a = rnd(0, Math.PI * 2);
      emit(s, { kind: 'chip', x: p.x, y: p.y, z: 0.6, vx: Math.cos(a) * 0.6, vy: Math.sin(a) * 0.6, vz: rnd(1.5, 3), life: rnd(0.9, 1.5), size: 0.09, grav: -1, drag: 0.6, col: [1, 0.95, 0.4, 1], lit: true });
    }
    s.flashes.push({ x: p.x, y: p.y, z: 0.8, age: 0, life: 0.3, k: 2 });
  }
}

function watchZones(s, g) {
  const done = g.zones.map((z) => zoneDone(g, z));
  if (s.zones && s.zones.length === done.length) {
    done.forEach((d, i) => {
      if (!d || s.zones[i]) return;
      const z = g.zones[i], c = parseColor(COLORS[z.color]);
      for (let k = 0; k < 40; k++) {
        const a = rnd(0, Math.PI * 2), v = rnd(0.4, 1.8);
        const col = k & 1 ? c : [1, 1, 1, 1];
        emit(s, { kind: 'chip', x: z.x, y: z.y, z: 0.5, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: rnd(2.5, 5), life: rnd(1, 1.8), size: rnd(0.035, 0.06), grav: 6, drag: 0.5, col: [col[0], col[1], col[2], 1], lit: true });
      }
    });
  }
  s.zones = done;
}

function step(s, g, dt) {
  const root = g.root;
  const trucks = [g, ...otherTrucks(g).filter((t) => !isGhost(g, t.truck.id))];
  for (const t of trucks) watchTruck(s, t, dt);
  watchHits(s, g);
  watchPops(s, g.root);
  watchZones(s, root);
  for (const p of s.ps) {
    p.age += dt;
    const k = Math.exp(-p.drag * dt);
    p.vx *= k; p.vy *= k;
    if (p.kind === 'smoke') p.vz *= k; else p.vz -= p.grav * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    if (p.kind !== 'smoke' && p.z < 0.01) { p.z = 0.01; p.vz = Math.abs(p.vz) * 0.35; p.vx *= 0.6; p.vy *= 0.6; }
    if (p.grow) p.size += p.grow * dt;
  }
  s.ps = s.ps.filter((p) => p.age < p.life);
  for (const fl of s.flashes) fl.age += dt;
  s.flashes = s.flashes.filter((fl) => fl.age < fl.life);
}

// Camera-facing quad at (x, y, z) with half-size `r` (`stretch` lengthens it along the screen-space direction of motion).
function billboard(m, p, eye, r, color, emissive, vel) {
  let vx = eye[0] - p.x, vy = eye[1] - p.y, vz = eye[2] - p.z;
  const l = Math.hypot(vx, vy, vz) || 1;
  vx /= l; vy /= l; vz /= l;
  let rx = -vy, ry = vx, rz = 0; // right = up(z) x toEye
  const rl = Math.hypot(rx, ry) || 1;
  rx /= rl; ry /= rl;
  let ux = vy * rz - vz * ry, uy = vz * rx - vx * rz, uz = vx * ry - vy * rx;
  if (vel) { // streak: the quad's long axis follows the velocity
    const sp = Math.hypot(vel[0], vel[1], vel[2]);
    if (sp > 0.01) {
      const k = Math.min(3, 1 + sp * 0.35);
      ux = vel[0] / sp; uy = vel[1] / sp; uz = vel[2] / sp;
      const dx = uy * vz - uz * vy, dy = uz * vx - ux * vz, dz = ux * vy - uy * vx, dl = Math.hypot(dx, dy, dz) || 1;
      rx = dx / dl; ry = dy / dl; rz = dz / dl;
      const a = [p.x - ux * r * k - rx * r * 0.5, p.y - uy * r * k - ry * r * 0.5, p.z - uz * r * k - rz * r * 0.5];
      quad(m, a, [rx * r, ry * r, rz * r], [ux * r * 2 * k, uy * r * 2 * k, uz * r * 2 * k], color, emissive);
      return;
    }
  }
  quad(m, [p.x - rx * r - ux * r, p.y - ry * r - uy * r, p.z - rz * r - uz * r], [rx * 2 * r, ry * 2 * r, rz * 2 * r], [ux * 2 * r, uy * 2 * r, uz * 2 * r], color, emissive);
}

function quad(m, o, a, b, color, emissive) {
  const n = emissive ? [0, 0, 0] : [0, 0, 1];
  const P = (i, j) => [o[0] + a[0] * i + b[0] * j, o[1] + a[1] * i + b[1] * j, o[2] + a[2] * i + b[2] * j];
  m.quad(P(0, 0), P(1, 0), P(1, 1), P(0, 1), n, color);
}

// Steps the particle system to `g.clock` (once per clock value) and adds the particles to the meshes. Returns the extra
// point lights (sparks flashes, dark mode only).
export function addParticles(om, tm, g, eye) {
  const s = stateFor(g), now = g.root.clock;
  if (s.clock === null || now < s.clock || now - s.clock > 1) { s.ps.length = 0; s.flashes.length = 0; s.clock = now; if (s.zones === null) watchZones(s, g.root); }
  else if (now > s.clock) { const dt = Math.min(MAX_STEP, now - s.clock); s.clock = now; step(s, g, dt); }
  const dark = theme().dark ? 0.55 : 1;
  for (const p of s.ps) {
    const d = Math.hypot(p.x - eye[0], p.y - eye[1]);
    if (d > FAR) continue;
    const t = p.age / p.life;
    if (p.kind === 'spark') {
      const hot = 1 - t;
      billboard(om, p, eye, p.size * Math.max(1, d / 7), [1, 0.4 + 0.55 * hot, 0.1 + 0.5 * hot * hot, 1], true, [p.vx, p.vy, p.vz]);
    } else if (p.kind === 'chip') {
      billboard(p.lit ? om : tm, p, eye, p.size, [p.col[0] * dark, p.col[1] * dark, p.col[2] * dark, 1 - Math.max(0, t - 0.7) / 0.3], !!p.lit);
    } else {
      const a = p.a0 * (1 - t) * Math.min(1, p.age / 0.08);
      billboard(tm, p, eye, p.size, [p.col[0] * dark, p.col[1] * dark, p.col[2] * dark, a], true);
    }
  }
  if (!theme().dark) return [];
  return s.flashes.map((f) => ({ x: f.x, y: f.y, z: f.z, r: 3.2, col: [1.4 * f.k * (1 - f.age / f.life), 0.7 * f.k * (1 - f.age / f.life), 0.2 * f.k * (1 - f.age / f.life)], d: Math.hypot(f.x - eye[0], f.y - eye[1]) }));
}
