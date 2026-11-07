// Triangle batch builder for the WebGL renderer. Vertex = position(3) normal(3) colour rgba(4).
// A zero normal marks an unlit (emissive) vertex. Pure data, no DOM.

export const STRIDE = 10;

const colorCache = new Map();
// '#rgb', '#rrggbb', '#rrggbbaa', 'rgb(a)(r,g,b,a)' or [r,g,b,a] (0..1) -> [r,g,b,a] in 0..1.
export function parseColor(c) {
  if (Array.isArray(c)) return c;
  let v = colorCache.get(c);
  if (v) return v;
  let m;
  if (c[0] === '#') {
    let h = c.slice(1);
    if (h.length === 3) h = [...h].map((ch) => ch + ch).join('');
    v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    v.push(h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1);
  } else if ((m = /rgba?\(([^)]+)\)/.exec(c))) {
    const p = m[1].split(',').map(Number);
    v = [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1];
  } else v = [1, 0, 1, 1];
  colorCache.set(c, v);
  return v;
}

export function hsl(h, s, l, a = 1) {
  const k = (n) => (n + h / 30) % 12, f = (n) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4), a];
}

export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
export const shade = (c, k) => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k), c[3]];

export class Mesh {
  constructor() { this.a = []; }

  get count() { return this.a.length / STRIDE; }

  vert(p, n, c) { this.a.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2], c[3]); }

  tri(p0, p1, p2, n, c) {
    this.vert(p0, n, c);
    this.vert(p1, n, c);
    this.vert(p2, n, c);
  }

  quad(p0, p1, p2, p3, n, c) {
    this.tri(p0, p1, p2, n, c);
    this.tri(p0, p2, p3, n, c);
  }

  // Prism: centre (x, y), heading rot, half length hl (along heading) and half width hw, heights z0..z1.
  // Sides are always built; opts.top / opts.bottom (default true) add the lids. opts.emissive: unlit.
  cuboid(x, y, rot, hl, hw, z0, z1, color, opts = {}) {
    const c = parseColor(color), co = Math.cos(rot), si = Math.sin(rot);
    const at = (u, v, z) => [x + u * co - v * si, y + u * si + v * co, z];
    const corners = [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]];
    const lit = !opts.emissive;
    for (let i = 0; i < 4; i++) {
      const [u0, v0] = corners[i], [u1, v1] = corners[(i + 1) % 4];
      const du = u1 - u0, dv = v1 - v0, len = Math.hypot(du, dv);
      const nu = dv / len, nv = -du / len;
      const n = lit ? [nu * co - nv * si, nu * si + nv * co, 0] : [0, 0, 0];
      this.quad(at(u0, v0, z0), at(u1, v1, z0), at(u1, v1, z1), at(u0, v0, z1), n, c);
    }
    if (opts.top !== false) this.quad(at(-hl, -hw, z1), at(hl, -hw, z1), at(hl, hw, z1), at(-hl, hw, z1), lit ? [0, 0, 1] : [0, 0, 0], c);
    if (opts.bottom !== false) this.quad(at(-hl, -hw, z0), at(hl, -hw, z0), at(hl, hw, z0), at(-hl, hw, z0), lit ? [0, 0, -1] : [0, 0, 0], c);
  }

  // Cylinder lying along the local y axis (a wheel): centre (x, y, z), heading rot, radius r, half width hw.
  wheel(x, y, z, rot, r, hw, color, n = 12) {
    const c = parseColor(color), co = Math.cos(rot), si = Math.sin(rot);
    const at = (u, v, w) => [x + u * co - v * si, y + u * si + v * co, z + w];
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const u0 = Math.cos(a0) * r, w0 = Math.sin(a0) * r, u1 = Math.cos(a1) * r, w1 = Math.sin(a1) * r;
      const am = (a0 + a1) / 2, nu = Math.cos(am), nw = Math.sin(am);
      const nrm = [nu * co, nu * si, nw];
      this.quad(at(u0, -hw, w0), at(u1, -hw, w1), at(u1, hw, w1), at(u0, hw, w0), nrm, c);
      for (const s of [-1, 1]) this.tri(at(0, s * hw, 0), at(u0, s * hw, w0), at(u1, s * hw, w1), [-si * s, co * s, 0], shade(c, 0.8));
    }
  }

  // Flat polygon at height z facing up: a quad (convex) or a fan around the centroid (star-shaped).
  poly(pts, z, color, up = true) {
    if (pts.length < 3) return;
    const c = parseColor(color);
    if (pts.length === 4) {
      const n = [0, 0, up ? 1 : -1];
      this.quad([pts[0][0], pts[0][1], z], [pts[1][0], pts[1][1], z], [pts[2][0], pts[2][1], z], [pts[3][0], pts[3][1], z], n, c);
      return;
    }
    let cx = 0, cy = 0;
    for (const [px, py] of pts) { cx += px; cy += py; }
    cx /= pts.length;
    cy /= pts.length;
    const n = [0, 0, up ? 1 : -1], mid = [cx, cy, z];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      this.tri(mid, [a[0], a[1], z], [b[0], b[1], z], n, c);
    }
  }

  // Regular n-gon of radius r (light pools).
  disc(x, y, z, r, color, n = 16) {
    const pts = [];
    for (let i = 0; i < n; i++) pts.push([x + Math.cos((i * Math.PI * 2) / n) * r, y + Math.sin((i * Math.PI * 2) / n) * r]);
    this.poly(pts, z, color);
  }

  // Axis-aligned rectangle outline of width t drawn as four floor strips (x0,y0)-(x1,y1) at height z.
  frame(x0, y0, x1, y1, t, z, color) {
    this.poly([[x0, y0], [x1, y0], [x1, y0 + t], [x0, y0 + t]], z, color);
    this.poly([[x0, y1 - t], [x1, y1 - t], [x1, y1], [x0, y1]], z, color);
    this.poly([[x0, y0 + t], [x0 + t, y0 + t], [x0 + t, y1 - t], [x0, y1 - t]], z, color);
    this.poly([[x1 - t, y0 + t], [x1, y0 + t], [x1, y1 - t], [x1 - t, y1 - t]], z, color);
  }

  // Polygon on a vertical plane: points (u, v) with u along the segment (ax,ay)->(bx,by) (0..1) and v the height.
  // The plane is offset by `off` along (nx, ny) so it floats just above the surface.
  vpoly(ax, ay, bx, by, nx, ny, off, pts, color) {
    const c = parseColor(color);
    const p = pts.map(([u, v]) => [ax + (bx - ax) * u + nx * off, ay + (by - ay) * u + ny * off, v]);
    for (let i = 1; i + 1 < p.length; i++) this.tri(p[0], p[i], p[i + 1], [nx, ny, 0], c); // the wall normal makes decals take the scene lighting
  }

  floats() { return new Float32Array(this.a); }
}
