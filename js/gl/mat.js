// Tiny column-major 4x4 matrix helpers for the WebGL renderer (pure maths, no DOM).

export const identity = () => {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
};

// f2w = 1 / tan(hfov / 2); f2h = f2w * width / height. Horizon fraction p (from the top of the view) is applied as an
// off-centre shift (shift = 2p - 1) so the horizon can sit anywhere without pitching the camera.
export function perspective(f2w, f2h, shift, near, far) {
  const m = new Float32Array(16);
  m[0] = f2w;
  m[5] = f2h;
  m[9] = shift;
  m[10] = -(far + near) / (far - near);
  m[11] = -1;
  m[14] = (-2 * far * near) / (far - near);
  return m;
}

export function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

// View matrix from an eye and orthonormal right / up / forward vectors (eye space looks down -z).
export function viewBasis(eye, r, u, f) {
  const m = identity();
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  m[0] = r[0]; m[4] = r[1]; m[8] = r[2]; m[12] = -dot(r, eye);
  m[1] = u[0]; m[5] = u[1]; m[9] = u[2]; m[13] = -dot(u, eye);
  m[2] = -f[0]; m[6] = -f[1]; m[10] = -f[2]; m[14] = dot(f, eye);
  return m;
}

// World point -> [x, y (css px from the top-left of the view), clip w (= distance along the view axis)].
export function projectPoint(vp, x, y, z, w, h) {
  const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
  const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
  const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
  if (cw <= 1e-4) return null;
  return [(cx / cw * 0.5 + 0.5) * w, (0.5 - (cy / cw) * 0.5) * h, cw];
}
