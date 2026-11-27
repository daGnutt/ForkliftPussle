import { zoneDone } from './game.js';

// Only discard a stack when its entire conservative footprint is behind one
// ordinary, full-height wall. Special and moving stacks are kept.
function hiddenStack(g, st, eye) {
  if (st.fall || st.fallZ || st.dropFrom != null || st.jolt || st.pen?.some((p) => p?.tip || p?.loose) || st.layers.length > 4) return false;
  const radius = 1.6 + Math.max(0, ...(st.offs || []).map((o) => Math.hypot(o.x, o.y)));
  const corners = [-1, 1].flatMap((x) => [-1, 1].map((y) => [st.x + x * radius, st.y + y * radius]));
  return g.walls.some((w) => {
    if (w.hidden || w.draw || w.charger || w.truck || w.roller || w.lift !== undefined || w.mast) return false;
    if (w.x < 0 || w.y < 0 || w.x + w.w > g.w || w.y + w.h > g.h) return false;
    if (eye.x >= w.x && eye.x <= w.x + w.w && eye.y >= w.y && eye.y <= w.y + w.h) return false;
    return corners.every(([x, y]) => {
      let lo = 0, hi = 1;
      for (const [o, d, min, max] of [[eye.x, x - eye.x, w.x, w.x + w.w], [eye.y, y - eye.y, w.y, w.y + w.h]]) {
        if (Math.abs(d) < 1e-9) { if (o <= min || o >= max) return false; continue; }
        let a = (min - o) / d, b = (max - o) / d;
        if (a > b) [a, b] = [b, a];
        lo = Math.max(lo, a); hi = Math.min(hi, b);
        if (lo >= hi) return false;
      }
      return lo > 0 && hi < 1;
    });
  });
}

// Freeze render inputs, excluding previous reports and bot navigation state.
export function capturePhotoScene(g, stack, view, dist) {
  const eye = { x: stack.x - Math.cos(view) * dist, y: stack.y - Math.sin(view) * dist };
  const cleanBot = (b) => b && { ...b, photos: undefined, sigs: undefined, seen: undefined, path: undefined, task: undefined };
  const root = g.root;
  const state = {
    ...root, photo: undefined, forkPhoto: undefined,
    bot: cleanBot(root.bot), inspector: cleanBot(root.inspector),
    coneBot: cleanBot(root.coneBot), tapeBot: cleanBot(root.tapeBot), fixBot: cleanBot(root.fixBot),
    stacks: root.stacks.filter((s) => s === stack || !hiddenStack(root, s, eye)),
    hits: [], photoScene: true,
    photoDone: root.zones.map((z) => zoneDone(g, z)),
  };
  if (state.inspector) state.inspector.show = 0;
  return {
    origin: { x: stack.x, y: stack.y },
    state: JSON.parse(JSON.stringify(state)),
  };
}
