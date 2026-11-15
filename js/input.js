import { padAxes, standardPads } from './gamepad.js';

const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyA', 'KeyZ', 'KeyQ', 'KeyW', 'KeyS', 'KeyD', 'KeyE', 'Comma', 'Period', 'KeyM', 'KeyF', 'KeyC', 'Tab', 'KeyP', 'KeyH', 'Escape']);

const HOLD_MS = 400; // holding the lower key this long drops the forks to the lowest safe level

// Keyboard schemes: physical keys are translated to the canonical (arrows + A/Z) codes the rest of this file uses.
// Comma/Period rotate the camera in both schemes (W/Q still do in the arrows scheme); the arrow keys always work.
const SCHEMES = {
  arrows: { Comma: 'KeyW', Period: 'KeyQ' },
  wasd: { KeyW: 'ArrowUp', KeyS: 'ArrowDown', KeyA: 'ArrowLeft', KeyD: 'ArrowRight', KeyQ: 'KeyA', KeyE: 'KeyZ', Comma: 'KeyW', Period: 'KeyQ' },
};

export function createInput(handlers) {
  const down = new Set();
  let scheme = SCHEMES.arrows;
  let detect = false; // first run: the first drive key pressed picks the scheme
  const DETECT = { ArrowUp: 'arrows', ArrowDown: 'arrows', ArrowLeft: 'arrows', ArrowRight: 'arrows', KeyW: 'wasd', KeyS: 'wasd', KeyD: 'wasd' };
  const keyOf = (code) => scheme[code] ?? code;
  let zPress = 0;
  function press(code) {
    down.add(code);
    handlers.anyKey?.();
    if (code === 'KeyA') handlers.up?.();
    else if (code === 'KeyZ') {
      handlers.down?.();
      const id = ++zPress;
      setTimeout(() => { if (id === zPress && down.has('KeyZ')) handlers.downAll?.(); }, HOLD_MS);
    }
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
    const T = 0.3;
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
    if (e.code === 'Tab' && e.target !== document.body) return;
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    if (detect && DETECT[e.code] && !handlers.blocked?.()) { detect = false; handlers.schemeDetected?.(DETECT[e.code]); }
    press(keyOf(e.code));
  });
  window.addEventListener('keyup', (e) => down.delete(keyOf(e.code)));
  window.addEventListener('blur', () => { stickRelease(); twoFingerHorn = false; down.clear(); held.clear(); padTouches.clear(); touchKeys.clear(); });
  // Gamepad (standard mapping), polled on every state() call. Held controls are merged into state(); buttons act on their press edge.
  // Drive: right trigger forward, left trigger back; steer: left stick X; fork up: A/RB; fork down: B/LB (hold: lowest safe level);
  // horn: X; cabin view: Y; chase camera: right stick click; look: right stick X; menu: Start (also closes it).
  // While the menu (or splash) is open the d-pad moves/adjusts, A selects and B goes back, via the menuNav/menuSelect/menuBack handlers.
  const DEAD = 0.3;
  let localMode = false; // local multiplayer: pads belong to local.js; only Start and the menu still use them
  const pad = { thr: 0, str: 0, up: false, down: false, left: false, right: false, lookL: false, lookR: false, horn: false };
  let padPrev = [];
  const padActions = [
    [0, () => { handlers.up?.(); handlers.next?.(); }], [5, () => handlers.up?.()],
    [1, () => press('KeyZ')], [4, () => press('KeyZ')],
    [3, () => handlers.swapView?.()], [11, () => handlers.toggleChase?.()],
  ];
  const menuDirs = { 12: 'up', 13: 'down', 14: 'left', 15: 'right' };
  function pollPad() {
    const gp = standardPads()[0]?.gp ?? null;
    const was = padPrev;
    padPrev = gp ? gp.buttons.map((b) => b.pressed) : [];
    const edge = (i) => !!gp && padPrev[i] && !was[i];
    pad.thr = pad.str = 0;
    pad.up = pad.down = pad.left = pad.right = pad.lookL = pad.lookR = pad.horn = false;
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
    // analog: trigger travel is the throttle/brake, left stick X the steering
    ({ thr: pad.thr, str: pad.str } = padAxes(gp));
    pad.up = pad.thr > 0;
    pad.down = pad.thr < 0;
    pad.left = pad.str < 0;
    pad.right = pad.str > 0;
    pad.lookL = rx < -DEAD;
    pad.lookR = rx > DEAD;
    pad.horn = b(2);
    for (const [i, act] of padActions) if (edge(i)) act();
    // lowering is a held action: the key stays 'down' while either button is held
    if (b(1) || b(4)) down.add('KeyZ'); else if (was[1] || was[4]) down.delete('KeyZ');
  }
  return {
    setAutoDetect: (on) => { detect = on; },
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
        horn: down.has('KeyH') || twoFingerHorn || pad.horn,
      };
    },
  };
}
