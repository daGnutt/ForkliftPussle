const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyA', 'KeyZ', 'KeyQ', 'KeyW', 'KeyM', 'KeyF', 'KeyC', 'Tab', 'KeyP', 'KeyH', 'Escape']);

export function createInput(handlers) {
  const down = new Set();
  function press(code) {
    down.add(code);
    handlers.anyKey?.();
    if (code === 'KeyA') handlers.up?.();
    else if (code === 'KeyZ') handlers.down?.();
    else if (code === 'KeyR') handlers.restart?.();
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
  // Virtual joystick (#stick, shown by the "joystick" touch scheme): the offset from its centre becomes arrow-key state.
  const stickEl = document.getElementById('stick');
  const knob = stickEl?.querySelector('.knob');
  const stick = { up: false, down: false, left: false, right: false };
  let stickId = null; // touch identifier or pointer id (mouse/pen)
  let stickByTouch = false;
  const stickRect = () => { const r = stickEl?.getBoundingClientRect(); return r && r.width > 0 ? r : null; };
  const inStick = (x, y) => { const r = stickRect(); return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; };
  const stickMove = (x, y) => {
    const r = stickRect(); if (!r) return;
    const R = r.width / 2;
    let dx = x - (r.left + R), dy = y - (r.top + R);
    const len = Math.hypot(dx, dy);
    if (len > R) { dx *= R / len; dy *= R / len; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    stickEl.classList.add('on');
    const T = 0.3;
    stick.left = dx / R < -T; stick.right = dx / R > T; stick.up = dy / R < -T; stick.down = dy / R > T;
  };
  const stickRelease = () => {
    stickId = null; stickByTouch = false;
    stick.up = stick.down = stick.left = stick.right = false;
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
    press(e.code);
  });
  window.addEventListener('keyup', (e) => down.delete(e.code));
  window.addEventListener('blur', () => { stickRelease(); twoFingerHorn = false; down.clear(); held.clear(); padTouches.clear(); touchKeys.clear(); });
  return {
    clear: () => { stickRelease(); twoFingerHorn = false; down.clear(); held.clear(); padTouches.clear(); touchKeys.clear(); buttons.forEach((b) => b.classList.remove('on')); },
    state: () => ({
      up: down.has('ArrowUp') || stick.up,
      down: down.has('ArrowDown') || stick.down,
      left: down.has('ArrowLeft') || stick.left,
      right: down.has('ArrowRight') || stick.right,
      lookL: down.has('KeyW'),
      lookR: down.has('KeyQ'),
      horn: down.has('KeyH') || twoFingerHorn,
    }),
  };
}
