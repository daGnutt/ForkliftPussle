import { theme } from '../theme.js';
import { staticMeshes, dynamicMeshes, LIGHT_MAX } from './scene.js';
import { parseColor } from './mesh.js';
import { projectPoint } from './mat.js';

// WebGL2 renderer. Draws into one hidden canvas and copies the result into the 2D game canvas, so the HUD,
// minimap and menus stay plain 2D. Returns false from `drawGl` when WebGL2 is unavailable (callers fall back
// to the canvas renderers).

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec4 aCol;
uniform mat4 uVP;
out vec3 vN;
out vec4 vC;
out vec3 vW;
void main() {
  vN = aNrm; vC = aCol; vW = aPos;
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vN;
in vec4 vC;
in vec3 vW;
uniform vec3 uEye, uSun, uSunCol, uAmbUp, uAmbDown, uFogCol;
uniform float uFogA, uFogB, uFogMax, uAdd;
const int NL = 24;
uniform int uNL;
uniform vec4 uLP[NL]; // xyz position, w radius
uniform vec3 uLC[NL];
uniform vec4 uLD[NL]; // xyz spot direction, w cone cosine (-2 = omni)
out vec4 o;
void main() {
  vec3 col = vC.rgb;
  if (dot(vN, vN) > 0.01) {
    vec3 n = normalize(vN);
    vec3 lit = mix(uAmbDown, uAmbUp, n.z * 0.5 + 0.5) + uSunCol * max(dot(n, uSun), 0.0);
    for (int i = 0; i < NL; i++) {
      if (i >= uNL) break;
      vec3 d = uLP[i].xyz - vW;
      float dist = length(d);
      float a = clamp(1.0 - dist / uLP[i].w, 0.0, 1.0);
      vec3 l = d / max(dist, 1e-3);
      float spot = uLD[i].w < -1.0 ? 1.0 : smoothstep(uLD[i].w, uLD[i].w + 0.2, dot(-l, uLD[i].xyz));
      lit += uLC[i] * (a * a * 1.6 * spot * max(dot(n, l), 0.0));
    }
    col *= lit;
  }
  float f = clamp((distance(vW, uEye) - uFogA) / (uFogB - uFogA), 0.0, 1.0) * uFogMax;
  col = uAdd > 0.5 ? col * (1.0 - f) : mix(col, uFogCol, f);
  o = vec4(col, vC.a);
}`;

const LIGHT = {
  pov: { sun: [0.35, 0.25, 0.9], sunCol: [0.5, 0.5, 0.48], up: [0.62, 0.62, 0.65], down: [0.45, 0.45, 0.47], fogA: 6, fogB: 48, fogMax: 0.8 },
  ov: { sun: [-0.4, -0.5, 0.8], sunCol: [0.42, 0.42, 0.4], up: [0.66, 0.66, 0.68], down: [0.5, 0.5, 0.52], fogA: 1e4, fogB: 2e4, fogMax: 0 },
};
// Dark mode: little ambient light; the truck's and the ceiling's point lights do the work.
const DARK_LIGHT = {
  pov: { sun: [0.35, 0.25, 0.9], sunCol: [0.03, 0.03, 0.035], up: [0.13, 0.14, 0.17], down: [0.08, 0.08, 0.1], fogA: 6, fogB: 48, fogMax: 0.8 },
  ov: { sun: [-0.4, -0.5, 0.8], sunCol: [0.05, 0.05, 0.06], up: [0.24, 0.25, 0.29], down: [0.16, 0.16, 0.19], fogA: 1e4, fogB: 2e4, fogMax: 0 },
};

let R = null; // { canvas, gl, prog, u, dyn, statics } | null; undefined while untried
let failed = false;
let enabled = true;
export const glEnabled = () => enabled;
export function setGlEnabled(on) { enabled = !!on; }

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function init() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 2;
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: true, depth: true, powerPreference: 'high-performance' });
  if (!gl) throw new Error('no webgl2');
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const u = {};
  u.uLP = gl.getUniformLocation(prog, 'uLP[0]');
  u.uLC = gl.getUniformLocation(prog, 'uLC[0]');
  u.uLD = gl.getUniformLocation(prog, 'uLD[0]');
  for (const n of ['uVP', 'uEye', 'uSun', 'uSunCol', 'uAmbUp', 'uAmbDown', 'uFogCol', 'uFogA', 'uFogB', 'uFogMax', 'uAdd', 'uNL']) u[n] = gl.getUniformLocation(prog, n);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); R = null; });
  canvas.addEventListener('webglcontextrestored', () => { failed = false; });
  return { canvas, gl, prog, u, vao: gl.createVertexArray(), buf: gl.createBuffer(), statics: { pov: null, ov: null } };
}

function get() {
  if (R) return R;
  if (failed || !enabled || typeof document === 'undefined') return null;
  try { R = init(); } catch (e) { failed = true; console.warn('WebGL unavailable, using the 2D renderer:', e.message); }
  return R;
}

export function glAvailable() { return enabled && !!get(); }

const fogColor = () => parseColor(theme().floorFar);

function bindAttribs(gl) {
  gl.enableVertexAttribArray(0);
  gl.enableVertexAttribArray(1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 40, 0);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 40, 12);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 40, 24);
}

// Static meshes live in GPU buffers (one entry per mode; replaced when the level, theme or decal switch changes).
function staticBuffers(r, g, mode) {
  const meshes = staticMeshes(g, mode), { gl } = r;
  let e = r.statics[mode];
  if (e && e.meshes === meshes) return e;
  if (e) { gl.deleteBuffer(e.opaque.buf); gl.deleteBuffer(e.trans.buf); }
  const up = (m) => {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, m.floats(), gl.STATIC_DRAW);
    return { buf, count: m.count };
  };
  e = r.statics[mode] = { meshes, opaque: up(meshes.opaque), trans: up(meshes.trans) };
  return e;
}

function drawBuffer(r, buf, count) {
  if (!count) return;
  const { gl } = r;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  bindAttribs(gl);
  gl.drawArrays(gl.TRIANGLES, 0, count);
}

function drawMesh(r, mesh) {
  if (!mesh.count) return;
  const { gl } = r;
  gl.bindBuffer(gl.ARRAY_BUFFER, r.buf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.floats(), gl.DYNAMIC_DRAW);
  bindAttribs(gl);
  gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
}

// Renders game state `g` with `cam` (see camera.js) into the css-px rect (x, y, w, h) of `ctx`, whose transform
// must map css px (dpr already applied). mode: 'pov' | 'ov'. Returns a projector (world x, y, z) -> [sx, sy, depth]
// in ctx css px, or null if WebGL is unavailable.
export function drawGl(ctx, g, mode, cam, x, y, dpr) {
  const r = get();
  if (!r) return null;
  const { gl, canvas, u } = r;
  const w = cam.w, h = cam.h;
  const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
  if (canvas.width < pw || canvas.height < ph) {
    canvas.width = Math.max(canvas.width, pw);
    canvas.height = Math.max(canvas.height, ph);
  }
  const L = (theme().dark ? DARK_LIGHT : LIGHT)[mode];
  const bg = mode === 'pov' ? fogColor() : parseColor(theme().bg);

  const st = staticBuffers(r, g, mode);
  const dyn = dynamicMeshes(g, mode, cam.eye);

  gl.bindVertexArray(r.vao);
  gl.useProgram(r.prog);
  gl.viewport(0, 0, pw, ph);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(0, 0, pw, ph);
  gl.clearColor(bg[0], bg[1], bg[2], 1);
  gl.depthMask(true);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.BLEND);

  gl.uniformMatrix4fv(u.uVP, false, cam.vp);
  gl.uniform3fv(u.uEye, cam.eye);
  const sl = Math.hypot(...L.sun);
  gl.uniform3f(u.uSun, L.sun[0] / sl, L.sun[1] / sl, L.sun[2] / sl);
  gl.uniform3fv(u.uSunCol, L.sunCol);
  gl.uniform3fv(u.uAmbUp, L.up);
  gl.uniform3fv(u.uAmbDown, L.down);
  gl.uniform3f(u.uFogCol, bg[0], bg[1], bg[2]);
  gl.uniform1f(u.uFogA, L.fogA);
  gl.uniform1f(u.uFogB, L.fogB);
  gl.uniform1f(u.uFogMax, L.fogMax);
  gl.uniform1f(u.uAdd, 0);
  const lp = new Float32Array(LIGHT_MAX * 4), lc = new Float32Array(LIGHT_MAX * 3), ld = new Float32Array(LIGHT_MAX * 4);
  dyn.lights.forEach((l, i) => {
    lp.set([l.x, l.y, l.z, l.r], i * 4);
    lc.set(l.col.slice(0, 3), i * 3);
    if (l.dir) { const n = Math.hypot(...l.dir); ld.set([l.dir[0] / n, l.dir[1] / n, l.dir[2] / n, l.cone], i * 4); } else ld[i * 4 + 3] = -2;
  });
  gl.uniform1i(u.uNL, dyn.lights.length);
  gl.uniform4fv(u.uLP, lp);
  gl.uniform3fv(u.uLC, lc);
  gl.uniform4fv(u.uLD, ld);

  drawBuffer(r, st.opaque.buf, st.opaque.count);
  drawMesh(r, dyn.opaque);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(false);
  gl.enable(gl.POLYGON_OFFSET_FILL);
  gl.polygonOffset(-2, -2);
  drawBuffer(r, st.trans.buf, st.trans.count);
  drawMesh(r, dyn.trans);
  gl.disable(gl.POLYGON_OFFSET_FILL);
  gl.depthMask(true);
  gl.disable(gl.BLEND);

  ctx.drawImage(canvas, 0, canvas.height - ph, pw, ph, x, y, w, h);
  return (wx, wy, wz) => {
    const p = projectPoint(cam.vp, wx, wy, wz, w, h);
    return p && [x + p[0], y + p[1], p[2]];
  };
}
