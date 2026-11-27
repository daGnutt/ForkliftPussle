import { BOX_H, PAL } from './geom.js';
import { repairable } from './repair.js';
import { drawPhotoGl } from './gl/photoview.js';

// The inspector's snapshot: a WebGL render from a camera ~0.2 tiles off the floor, tilted up so the whole stack fits.
const W = 400, H = 300, STRIP = 81, LINE = 26, SHOW_MS = 4500;

const hurt = (pen) => (pen?.crash || 0) > 0 && repairable(pen); // no damage symbol on what can't be repaired

export function boxStatus(pen) {
  return { damaged: hurt(pen), crooked: (pen?.sq || 0) > 0 || (pen?.shift || 0) > 0 };
}

// What is wrong with the stack, one line per box (the lowest box is box 1): its damage points and whether it sits crooked.
// A barrel pair counts as one box (damage of both halves).
export function issues(photo) {
  const out = [];
  (photo.pens || []).forEach((pen, i) => {
    if (pen?.barrelPart === 'top') return;
    const status = boxStatus(pen), pts = status.damaged ? Math.round(pen?.crash || 0) : 0, bits = [];
    if (pts > 0) bits.push(`has ${pts} pt damage`);
    if (pen?.shift === undefined) {
      if (status.crooked) bits.push('is wonky');
    } else if (status.crooked) {
      bits.push(`is ${[pen.sq > 0 && 'rotated', pen.shift > 0 && 'shifted sideways'].filter(Boolean).join(' and ')}`);
    }
    if (bits.length) out.push(`Box ${i + 1} ${bits.join(' and ')}`);
  });
  return out;
}

// Height of the caption strip: the verdict plus one line per issue.
export const stripHeight = (photo) => STRIP + (issues(photo).length + (photo.score ? 1 : 0)) * LINE;

// The points the stack contributed (end-of-level gallery): "100 − 23 damage − 15 wonky = 62 pts".
export const scoreText = (sc) => `${sc.base}${sc.crash ? ` − ${sc.crash} damage` : ''}${sc.square ? ` − ${sc.square} wonky` : ''}${sc.crash || sc.square ? ` = ${sc.total}` : ''} pts`;

// Warning triangle with an exclamation mark, centred on screen point `c`, `r` px across.
function drawDamage(ctx, c, r) {
  const [x, y] = c, t = [[x, y - r * 0.55], [x + r * 0.6, y + r * 0.45], [x - r * 0.6, y + r * 0.45]];
  ctx.beginPath(); t.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); ctx.closePath();
  ctx.fillStyle = '#ffeb3b'; ctx.fill(); ctx.strokeStyle = '#d50000'; ctx.lineWidth = Math.max(2, r * 0.12); ctx.lineJoin = 'round'; ctx.stroke();
  ctx.fillStyle = '#d50000'; ctx.fillRect(x - r * 0.05, y - r * 0.2, r * 0.1, r * 0.36); ctx.fillRect(x - r * 0.05, y + r * 0.22, r * 0.1, r * 0.1);
}

// Where the warning triangles go (screen centre and size): the front of every box with repairable damage, found with the picture's projector.
export function damageSpots(photo, proj) {
  const view = photo.view || 0, fx = Math.cos(view) * 0.45, fy = Math.sin(view) * 0.45, out = [];
  photo.layers.forEach((_, i) => {
    const pen = photo.pens?.[i];
    if (!hurt(pen) || pen.barrelPart === 'top') return;
    const o = photo.offs?.[i] || { x: 0, y: 0 }, z = i * (BOX_H + PAL) + PAL + BOX_H / 2, x = o.x - fx, y = o.y - fy; // x, y: the face towards the camera
    const c = proj(x, y, z), a = proj(x, y, z - BOX_H / 2), b = proj(x, y, z + BOX_H / 2);
    if (c && a && b) out.push({ c, r: Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.7 });
  });
  return out;
}

// Polaroid: the w x h picture plus a white caption strip below it (canvas height h + STRIP), the verdict is written on the strip.
export function drawPhoto(ctx, photo, w = W, h = H) {
  const list = issues(photo), sh = Math.round(h * stripHeight(photo) / H), k = h / H;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h + sh);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
  ctx.fillStyle = '#d8d4cc'; ctx.fillRect(0, 0, w, h); // stays plain without WebGL
  const proj = drawPhotoGl(ctx, photo, 0, 0, w, h);
  if (proj) for (const { c, r } of damageSpots(photo, proj)) drawDamage(ctx, c, r);
  // flash: hot centre, light vignette
  const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, h * 0.95);
  g.addColorStop(0, 'rgba(255,255,255,.25)'); g.addColorStop(0.6, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,.35)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.restore();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 14; ctx.strokeRect(0, 0, w, h + sh); // polaroid border
  const text = photo.ok ? 'GOOD JOB' : 'COULD BE BETTER', col = photo.ok ? '#43a047' : '#e53935';
  ctx.save();
  ctx.translate(w / 2, h + (STRIP * k) / 2 + 2); ctx.rotate(-0.04);
  ctx.font = 'bold 40px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.scale(Math.min(1, (w - 50) / ctx.measureText(text).width), 1);
  ctx.fillStyle = col; ctx.fillText(text, 0, 0);
  ctx.restore();
  ctx.save();
  ctx.font = 'bold 20px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#b71c1c';
  list.forEach((t, n) => ctx.fillText(t, w / 2, h + STRIP * k + (n + 0.5) * LINE * k - 6 * k, w - 50));
  if (photo.score) { ctx.fillStyle = photo.score.total < photo.score.base ? '#e65100' : '#1b5e20'; ctx.fillText(scoreText(photo.score), w / 2, h + STRIP * k + (list.length + 0.5) * LINE * k - 6 * k, w - 50); }
  ctx.restore();
}

let spot = null;

// The renderers report where the player's forklift is on the canvas (CSS px, with a radius); no report (cab views) means nothing to dodge.
export const clearTruckSpot = () => { spot = null; hud = []; };
// Canvas HUD rects ({ left, top, right, bottom } in canvas CSS px: fork gauges, compass, party badge) the popups must stay off.
let hud = [];
export const addHudRect = (left, top, right, bottom) => { hud.push({ left, top, right, bottom }); };
export const setTruckSpot = (x, y, r) => { spot = { x, y, r }; };

const PHOTO_SCALES = [1, 0.75, 0.5];
const MARGIN = 16, OLD_SCALE = 0.50, POPUP_SCALE = 0.50; // gameplay popups are smaller than the full size; old ones smaller still

// Size factor of a gameplay popup: re-shown (old) pictures are smaller, except on touch devices where all are as large as new ones and TOUCH_BOOST times bigger (phones are too small to read them otherwise).
const TOUCH_BOOST = 1.75, TOUCH_SCALES = [1, 0.9]; // on touch, popups barely shrink: a crowded portrait screen is better covered a little than unreadable
export const popupScale = (old, coarse) => POPUP_SCALE * (coarse ? TOUCH_BOOST : old ? OLD_SCALE : 1);

// Picks the screen corner (0 right-top, 1 left-top, 2 right-bottom, 3 left-bottom) and size factor for a popup of full size w x h: the current corner is kept while it is free, otherwise the first free one; if no corner is free at full size the popup shrinks (PHOTO_SCALES). `blocked` are screen rects to keep clear (touch controls) and `avoid` the rects of other popups (`{ x, y, w, h }`), `truck` the forklift circle.
export function placePhoto({ vw, vh, w, h, corner = 0, blocked = [], avoid = [], truck = null, m = MARGIN, scales = PHOTO_SCALES }) {
  const rect = (k, f) => { const rw = w * f, rh = h * f; return { x: k & 1 ? m : vw - rw - m, y: k & 2 ? vh - rh - m : m, w: rw, h: rh }; };
  const hit = (k, f) => {
    const r = rect(k, f);
    if (blocked.some((b) => r.x < b.right + 8 && r.x + r.w > b.left - 8 && r.y < b.bottom + 8 && r.y + r.h > b.top - 8)) return true;
    if (avoid.some((b) => r.x < b.x + b.w + 8 && r.x + r.w > b.x - 8 && r.y < b.y + b.h + 8 && r.y + r.h > b.y - 8)) return true;
    return !!truck && Math.hypot(truck.x - Math.max(r.x, Math.min(truck.x, r.x + r.w)), truck.y - Math.max(r.y, Math.min(truck.y, r.y + r.h))) < truck.r + 24;
  };
  for (const f of scales) {
    const k = hit(corner, f) ? [0, 1, 2, 3].find((c) => !hit(c, f)) : corner;
    if (k !== undefined) return { corner: k, scale: f, fits: true, ...rect(k, f) };
  }
  return { corner, fits: false, scale: scales.at(-1), ...rect(corner, scales.at(-1)) };
}

// Several pictures can be on screen at once (at most MAX_POPUPS, the oldest goes first); each is its own canvas with its own timers.
const MAX_POPUPS = 4, GALLERY_MAX = 30, GALLERY_SCALE = 0.5;
const popups = [];
const hidePopup = (p) => { clearTimeout(p.timer); clearTimeout(p.fade); p.el.remove(); const i = popups.indexOf(p); if (i >= 0) popups.splice(i, 1); };

// End-of-level gallery: the pictures (a function returning them, ordered longest-dormant stack first, with stable objects; more can turn up while it runs) pop in whenever a corner is free and rotate through
// the list, each staying GALLERY_MS. The pictures may cover anything (forklift, controls, HUD); the results panel is drawn above them.
const GALLERY_MS = 6000, GALLERY_GAP = 500;
let gallery = null;
export function startGallery(photos) {
  stopGallery();
  gallery = { photos, next: 0, nextAt: 0 };
}
export function stopGallery() {
  if (!gallery) return;
  gallery = null;
  [...popups].forEach(hidePopup);
}
export function clearPhotos() {
  stopGallery();
  [...popups].forEach(hidePopup);
}

const place = (q, p) => {
  q.corner = p.corner; q.rect = p;
  if (p.scale !== q.scale) { q.scale = p.scale; q.el.style.width = `calc(min(45vw, 60vh) * ${p.scale * q.k})`; }
  const at = (x, y) => `translate(${x - (innerWidth - p.w - MARGIN)}px, ${y - MARGIN}px) rotate(2deg)`;
  if (q.entering) { // a new picture flies in from the screen edge closest to the spot it was given
    q.entering = false;
    const d = [p.x, innerWidth - p.x - p.w, p.y, innerHeight - p.y - p.h], k = d.indexOf(Math.min(...d));
    q.el.style.transition = 'none';
    q.el.style.transform = at(k === 0 ? -p.w - MARGIN : k === 1 ? innerWidth + MARGIN : p.x, k === 2 ? -p.h - MARGIN : k === 3 ? innerHeight + MARGIN : p.y);
    q.el.style.visibility = '';
    void q.el.offsetWidth;
    q.el.style.transition = '';
  }
  q.el.style.transform = at(p.x, p.y);
};

// The first spot (scanning the screen row by row) where a w x h picture clears the blocked rects and the placed pictures (the level is over, so anything may be covered), or null.
function freeSpot(w, h, blocked, placed) {
  const m = MARGIN, g = 8, sx = Math.max(12, w / 4), sy = Math.max(12, h / 4);
  for (let y = m; y + h <= innerHeight - m; y += sy) for (let x = m; x + w <= innerWidth - m; x += sx) {
    if (blocked.some((b) => x < b.right + g && x + w > b.left - g && y < b.bottom + g && y + h > b.top - g)) continue;
    if (placed.some((b) => x < b.x + b.w + g && x + w > b.x - g && y < b.y + b.h + g && y + h > b.y - g)) continue;
    return { x, y };
  }
  return null;
}

// Keeps the popups off the forklift, the visible touch controls and each other: each slides to a free screen corner and shrinks when none is free.
export function dodgePhoto() {
  if (typeof document === 'undefined' || (!popups.length && !gallery)) return;
  const c = document.getElementById('game')?.getBoundingClientRect() || { left: 0, top: 0 };
  const blocked = gallery ? [] : [...document.querySelectorAll('#touch button, #stick')].map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  if (!gallery) blocked.push(...hud.map((r) => ({ left: r.left + c.left, top: r.top + c.top, right: r.right + c.left, bottom: r.bottom + c.top })));
  const truck = spot && { x: spot.x + c.left, y: spot.y + c.top, r: spot.r };
  const placed = [];
  for (const q of popups) {
    if (q.fixed) { placed.push(q.rect); continue; } // gallery pictures keep the spot they were given
    const w = q.el.offsetWidth / q.scale, h = q.el.offsetHeight / q.scale; // already includes q.k
    const p = placePhoto({ vw: innerWidth, vh: innerHeight, w, h, corner: q.corner, blocked, avoid: placed, truck, scales: matchMedia('(pointer: coarse)').matches && !gallery ? TOUCH_SCALES : PHOTO_SCALES });
    place(q, p);
    placed.push(p);
  }
  const now = performance.now();
  if (!gallery || now < gallery.nextAt || popups.length >= GALLERY_MAX) return;
  const list = gallery.photos(), n = list.length;
  for (let i = 0; i < n; i++) {
    const idx = (gallery.next + i) % n, photo = list[idx];
    if (popups.some((q) => q.photo === photo)) continue;
    const w = Math.min(innerWidth * 0.45, innerHeight * 0.6) * GALLERY_SCALE, h = (w * (H + stripHeight(photo))) / W;
    const p = freeSpot(w, h, blocked, placed);
    if (!p) return; // no space yet: try again next frame
    gallery.next = idx + 1; gallery.nextAt = now + GALLERY_GAP;
    const q = showPhoto(photo, GALLERY_MS);
    q.fixed = true; place(q, { ...p, scale: GALLERY_SCALE, w, h, corner: 0 });
    return;
  }
}

// Shows a picture for `ms` (tapping it hides it, touch only, see style.css); showing the same picture again just keeps it up for another `ms`. Returns the popup.
// `old` marks a picture shown again (not just taken): drawn smaller and in sepia.
export function showPhoto(photo, ms = SHOW_MS, old = false) {
  if (typeof document === 'undefined') return null;
  let q = popups.find((o) => o.photo === photo);
  if (!q) {
    if (popups.length >= (gallery ? GALLERY_MAX : MAX_POPUPS)) hidePopup(popups[0]);
    const el = document.createElement('canvas');
    el.className = 'photo'; el.setAttribute('aria-hidden', 'true');
    el.width = W; el.height = H + stripHeight(photo); el.style.aspectRatio = `${el.width} / ${el.height}`;
    drawPhoto(el.getContext('2d'), photo);
    el.style.visibility = 'hidden'; // until dodgePhoto has picked its spot
    document.body.append(el);
    q = { el, photo, scale: 1, k: gallery ? 1 : popupScale(old, matchMedia('(pointer: coarse)').matches), entering: true, corner: 0, timer: 0, fade: 0 };
    if (old) el.classList.add('old');
    el.style.width = `calc(min(45vw, 60vh) * ${q.k})`;
    el.addEventListener('pointerdown', () => hidePopup(q));
    popups.push(q);
  }
  clearTimeout(q.timer); clearTimeout(q.fade);
  q.el.classList.remove('fade');
  q.fade = setTimeout(() => q.el.classList.add('fade'), ms - 400);
  q.timer = setTimeout(() => hidePopup(q), ms);
  return q;
}
