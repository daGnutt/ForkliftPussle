import { padAxes, standardPads } from './gamepad.js';

const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyA', 'KeyZ', 'KeyQ', 'KeyW', 'KeyS', 'KeyD', 'KeyE', 'Comma', 'Period', 'KeyM', 'KeyF', 'KeyC', 'Tab', 'KeyP', 'KeyH', 'Escape']);

// Keyboard schemes: physical keys are translated to the canonical (arrows + A/Z) codes the rest of this file uses.
// Comma/Period rotate the camera in both schemes; the arrow keys only drive in the arrows scheme (unmapped in wasd).
const SCHEMES = {
  arrows: { KeyW: null, KeyQ: null, Comma: 'KeyW', Period: 'KeyQ' },
  wasd: { ArrowUp: null, ArrowDown: null, ArrowLeft: null, ArrowRight: null, KeyW: 'ArrowUp', KeyS: 'ArrowDown', KeyA: 'ArrowLeft', KeyD: 'ArrowRight', KeyE: 'KeyA', KeyQ: 'KeyZ', Comma: 'KeyW', Period: 'KeyQ' },
};

export function createInput(handlers) {
  const down = new Set();
  let scheme = SCHEMES.arrows;
  const keyOf = (code) => (code in scheme ? scheme[code] : code);
  function press(code) {
    down.add(code);
    handlers.anyKey?.();
    if (code === 'KeyA') handlers.up?.();
    else if (code === 'KeyZ') handlers.down?.();
    else if (code === 'Enter') handlers.next?.();
    else if (code === 'KeyM' || code === 'Tab') handlers.swapView?.();
    else if (code === 'KeyC') handlers.toggleChase?.();
    else if (code === 'KeyF') handlers.fullscreen?.();
    else if (code === 'KeyP') handlers.pause?.();
    else if (code === 'Escape') handlers.menu?.();
  }
  // On-screen buttons (#touch [data-key]) act as virtual keys; each pointer is tracked so several can be held at once.
  const held = new Map();
  const release = (id) => { const c = held.get(id); if (c) { held.delete(id); if (![...held.values()].includes(c)) down.delete(c); } };
  const buttons = [...document.querySelectorAll('#touch [data-key]')];
  const buttonAt = (x, y) => buttons.find((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; });
  buttons.forEach((b) => {
    b.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || handlers.blocked?.()) return; // touches are handled by the touch listeners below
      e.preventDefault();
      b.setPointerCapture?.(e.pointerId);
      b.classList.add('on');
      held.set(e.pointerId, b.dataset.key);
      press(b.dataset.key);
    });
    const up = (e) => { if (e.pointerType === 'touch') return; b.classList.remove('on'); release(e.pointerId); };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  });
  // Touches are re-evaluated from the full list of live touches on every event, so a lost end/cancel
  // (common in installed PWAs: system gestures, edge swipes) or a finger sliding between buttons can't leave
  // a key stuck or dead. A touch that started on a button keeps controlling whichever button is under it.
  // Virtual joystick (#stick, shown by the "joystick" touch scheme): the offset from its centre becomes arrow-key state plus analog thr/str (dead zone rescaled to 0..1).
  const stickEl = document.getElementById('stick');
  const knob = stickEl?.querySelector('.knob');
  const stick = { up: false, down: false, left: false, right: false, thr: 0, str: 0 };
  let stickId = null; // touch identifier or pointer id (mouse/pen)
  let stickByTouch = false;
  const stickRect = () => { const r = stickEl?.getBoundingClientRect(); return r && r.width > 0 ? r : null; };
  const inStick = (x, y) => { const r = stickRect(); return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; };
  const stickMove = (x, y) => {
    const r = stickRect(); if (!r) return;
    const R = r.width / 2;
    let dx = x - (r.left + R), dy = y - (r.top + R);
    dx = Math.max(-R, Math.min(R, dx)); dy = Math.max(-R, Math.min(R, dy)); // square pad: each axis reaches full on its own
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    stickEl.classList.add('on');
    const T = 0.12;
    const ax = (v) => Math.round(Math.sign(v) * Math.max(0, (Math.abs(v) - T) / (1 - T)) * 20) / 20 || 0;
    stick.thr = ax(-dy / R); stick.str = ax(dx / R);
    stick.left = dx / R < -T; stick.right = dx / R > T; stick.up = dy / R < -T; stick.down = dy / R > T;
  };
  const stickRelease = () => {
    stickId = null; stickByTouch = false;
    stick.up = stick.down = stick.left = stick.right = false; stick.thr = stick.str = 0;
    if (knob) knob.style.transform = '';
    stickEl?.classList.remove('on');
  };
  stickEl?.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || handlers.blocked?.()) return;
    e.preventDefault();
    stickEl.setPointerCapture?.(e.pointerId);
    stickId = e.pointerId;
    handlers.anyKey?.();
    stickMove(e.clientX, e.clientY);
  });
  stickEl?.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch' && e.pointerId === stickId) stickMove(e.clientX, e.clientY); });
  for (const type of ['pointerup', 'pointercancel']) stickEl?.addEventListener(type, (e) => { if (e.pointerType !== 'touch' && e.pointerId === stickId) stickRelease(); });
  const padTouches = new Set();
  const touchKeys = new Set();
  let twoFingerHorn = false;
  const syncTouches = (e) => {
    if (handlers.blocked?.()) { // menu open: drop all pad touches so they neither steer nor steal taps from the menu
      stickRelease();
      twoFingerHorn = false;
      if (padTouches.size || touchKeys.size) { padTouches.clear(); touchKeys.clear(); down.clear(); buttons.forEach((b) => b.classList.remove('on')); }
      return;
    }
    const live = new Map();
    for (const t of e.touches) live.set(t.identifier, t);
    // Two fingers resting on the canvas (not on the pad) hold the horn; one finger still orbits/taps.
    twoFingerHorn = [...live.values()].filter((t) => t.target?.id === 'game').length >= 2;
    for (const t of e.changedTouches) {
      if (e.type === 'touchstart' && stickId === null && inStick(t.clientX, t.clientY)) { stickId = t.identifier; stickByTouch = true; handlers.anyKey?.(); }
      if (e.type === 'touchstart' && buttonAt(t.clientX, t.clientY)) padTouches.add(t.identifier);
    }
    if (stickByTouch) {
      const st = live.get(stickId);
      if (st) stickMove(st.clientX, st.clientY); else stickRelease();
    }
    for (const id of [...padTouches]) if (!live.has(id)) padTouches.delete(id);
    const keys = new Set();
    for (const id of padTouches) {
      const t = live.get(id);
      const b = buttonAt(t.clientX, t.clientY);
      if (b) keys.add(b.dataset.key);
    }
    for (const b of buttons) b.classList.toggle('on', keys.has(b.dataset.key));
    for (const c of [...touchKeys]) if (!keys.has(c)) { touchKeys.delete(c); if (![...held.values()].includes(c)) down.delete(c); }
    for (const c of keys) if (!touchKeys.has(c)) { touchKeys.add(c); press(c); }
    if (e.cancelable && [...e.changedTouches].some((t) => padTouches.has(t.identifier) || (stickByTouch && t.identifier === stickId) || e.type === 'touchstart' && inStick(t.clientX, t.clientY) || e.type === 'touchstart' && buttonAt(t.clientX, t.clientY))) e.preventDefault();
  };
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) window.addEventListener(type, syncTouches, { passive: false, capture: true });
  window.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return; // leave browser shortcuts (Alt+D, Ctrl+W…) alone
    if (e.code === 'Tab' && e.target !== document.body) return;
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    press(keyOf(e.code));
  });
  window.addEventListener('keyup', (e) => down.delete(keyOf(e.code)));
  window.addEventListener('blur', () => { stickRelease(); twoFingerHorn = false; down.clear(); held.clear(); padTouches.clear(); touchKeys.clear(); });
  // Gamepad (standard mapping), polled on every state() call. Held controls are merged into state(); buttons act on their press edge.
  // Drive: right trigger forward, left trigger back; steer: left stick X; fork up: A/RB; fork down: B/LB (hard mode: tap = next level, hold = fluid);
  // horn: X; look: right stick X; camera: d-pad up overview / left cabin / right chase / down reset; menu: Start (also closes it).
  // While the menu (or splash) is open the d-pad moves/adjusts, A selects and B goes back, via the menuNav/menuSelect/menuBack handlers.
  const DEAD = 0.3;
  let localMode = false; // local multiplayer: pads belong to local.js; only Start and the menu still use them
  const pad = { forkUp: false, thr: 0, str: 0, up: false, down: false, left: false, right: false, lookL: false, lookR: false, lookU: false, lookD: false, horn: false };
  let padPrev = [];
  let padActive = false;
  const padActions = [
    [0, () => { handlers.up?.(); handlers.next?.(); }], [5, () => handlers.up?.()],
    [1, () => press('KeyZ')], [4, () => press('KeyZ')],
    [3, () => handlers.swapView?.()],
  ];
  const menuDirs = { 12: 'up', 13: 'down', 14: 'left', 15: 'right' };
  function pollPad() {
    const gp = standardPads()[0]?.gp ?? null;
    const was = padPrev;
    padActive = !!gp;
    padPrev = gp ? gp.buttons.map((b) => b.pressed) : [];
    const edge = (i) => !!gp && padPrev[i] && !was[i];
    pad.thr = pad.str = 0;
    pad.up = pad.down = pad.left = pad.right = pad.lookL = pad.lookR = pad.lookU = pad.lookD = pad.horn = pad.forkUp = false;
    if (!gp) return;
    if (edge(0) || edge(9)) handlers.anyKey?.();
    if (edge(9)) { handlers.menuToggle?.(); return; }
    if (handlers.blocked?.()) {
      for (const [i, dir] of Object.entries(menuDirs)) if (edge(+i)) handlers.menuNav?.(dir);
      if (edge(0)) handlers.menuSelect?.();
      if (edge(1)) handlers.menuBack?.();
      return;
    }
    if (localMode) return;
    const b = (i) => !!gp.buttons[i]?.pressed;
    const rx = gp.axes[2] ?? 0;
    const ry = gp.axes[3] ?? 0;
    // analog: trigger travel is the throttle/brake, left stick X the steering
    ({ thr: pad.thr, str: pad.str } = padAxes(gp));
    pad.up = pad.thr > 0;
    pad.down = pad.thr < 0;
    pad.left = pad.str < 0;
    pad.right = pad.str > 0;
    pad.lookL = rx < -DEAD;
    pad.lookR = rx > DEAD;
    pad.lookU = ry < -DEAD;
    pad.lookD = ry > DEAD;
    pad.horn = b(2);
    for (const [i, act] of padActions) if (edge(i)) act();
    if (edge(12)) handlers.cameraOverview?.();
    if (edge(14)) handlers.cameraCabin?.();
    if (edge(15)) handlers.cameraChase?.();
    if (edge(13)) handlers.cameraReset?.();
    // lowering is a held action: the key stays 'down' while either button is held
    if (b(1) || b(4)) down.add('KeyZ'); else if (was[1] || was[4]) down.delete('KeyZ');
    pad.forkUp = b(0) || b(5);
  }
  return {
    setScheme: (name) => { scheme = SCHEMES[name] ?? SCHEMES.arrows; down.clear(); },
    setLocalMode: (on) => { localMode = on; },
    clear: () => { stickRelease(); twoFingerHorn = false; down.clear(); held.clear(); padTouches.clear(); touchKeys.clear(); buttons.forEach((b) => b.classList.remove('on')); },
    state: () => {
      pollPad();
      const kUp = down.has('ArrowUp'), kDown = down.has('ArrowDown');
      const kLeft = down.has('ArrowLeft'), kRight = down.has('ArrowRight');
      const kThr = (kUp ? 1 : 0) - (kDown ? 1 : 0), kStr = (kRight ? 1 : 0) - (kLeft ? 1 : 0);
      return {
        thr: kThr || stick.thr || pad.thr,
        str: kStr || stick.str || pad.str,
        up: down.has('ArrowUp') || stick.up || pad.up,
        down: down.has('ArrowDown') || stick.down || pad.down,
        left: down.has('ArrowLeft') || stick.left || pad.left,
        right: down.has('ArrowRight') || stick.right || pad.right,
        lookL: down.has('KeyW') || pad.lookL,
        lookR: down.has('KeyQ') || pad.lookR,
        lookU: pad.lookU,
        lookD: pad.lookD,
        gamepad: padActive,
        brake: !!stickRect() && stickId === null && !kThr && !pad.thr, // joystick scheme shown but untouched: brake
        horn: down.has('KeyH') || twoFingerHorn || pad.horn,
        forkUp: down.has('KeyA') || pad.forkUp, // held fork keys: hard mode reads them (tap = next level, hold = fluid); easy mode uses the press handlers
        forkDown: down.has('KeyZ'),
      };
    },
  };
}

// Touch control zones (px, canvas coordinates): the pad strip along the bottom (144 landscape / 208 portrait) and the fork gauge column
// at the right edge. A camera drag that starts here is ignored, so gaps between the on-screen buttons don't rotate the camera.
const TOUCH_PAD_H = { landscape: 144, portrait: 208 };
export function inTouchControlZone(x, y, width, height, landscape, gauges = 1) {
  if (y >= height - (landscape ? TOUCH_PAD_H.landscape : TOUCH_PAD_H.portrait)) return true;
  return y >= 44 && y <= 236 && x >= width - 98 - (gauges - 1) * 90;
}
