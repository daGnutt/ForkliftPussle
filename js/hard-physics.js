import { overlapArea, sat } from './geom.js';

export const HARD_PHYSICS_VERSION = 4;
const SUPPORT_EPS = 1e-8;
const MIN_CONTACT_AREA = 0.01;
const TINE_OVERLAP = 0.01;
const CONTACT_EPS = 1e-4;

export function solveContacts(collect, resolve) {
  for (let iteration = 0; iteration < 32; iteration++) {
    const contacts = collect(iteration);
    if (!contacts.length) break;
    for (const contact of contacts) resolve(contact, iteration);
  }
}

export function palletSupported(tines, box, runners) {
  return tines.length === 2 &&
    tines.every((tine) => overlapArea(tine, box) >= TINE_OVERLAP &&
      runners.every((runner) => (sat(tine, runner)?.depth || 0) <= CONTACT_EPS));
}

// Which tines (by index) are in the pallet's slots: overlapping it without touching a runner.
export function tinesInPallet(tines, box, runners) {
  return tines.map((tine) => overlapArea(tine, box) >= TINE_OVERLAP && runners.every((runner) => (sat(tine, runner)?.depth || 0) <= CONTACT_EPS));
}

// Project all contacts together; opposing constraints cancel rather than pushing a pallet through one tine.
export function contactCorrection(contacts) {
  let x = 0, y = 0;
  for (let iteration = 0; iteration < 8; iteration++) {
    let dx = 0, dy = 0;
    for (const m of contacts) {
      const missing = Math.max(0, m.depth - x * m.x - y * m.y);
      dx += m.x * missing;
      dy += m.y * missing;
    }
    x += dx / contacts.length;
    y += dy / contacts.length;
  }
  return { x: x * 1.001, y: y * 1.001 };
}

export function closingSpeed(motion, point, normal) {
  const x = motion.x - motion.turn * (point.y - motion.y0);
  const y = motion.y + motion.turn * (point.x - motion.x0);
  return Math.max(0, -x * normal.x - y * normal.y);
}

function contains(poly, p) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cross) <= SUPPORT_EPS) continue;
    const side = Math.sign(cross);
    if (sign && side !== sign) return false;
    sign = side;
  }
  return true;
}

// The centre of mass of all boxes above a contact must lie over their shared support.
export function supported(polys, pens, from) {
  if (from <= 0) return true;
  const upper = polys[from], lower = polys[from - 1];
  if (overlapArea(upper, lower) < MIN_CONTACT_AREA) return false;
  let x = 0, y = 0, mass = 0;
  for (let i = from; i < polys.length; i++) {
    const m = pens[i]?.wide ? 2 : 1;
    const center = polys[i].reduce((c, p) => ({ x: c.x + p.x / polys[i].length, y: c.y + p.y / polys[i].length }), { x: 0, y: 0 });
    x += center.x * m; y += center.y * m; mass += m;
  }
  const center = { x: x / mass, y: y / mass };
  return contains(upper, center) && contains(lower, center);
}
