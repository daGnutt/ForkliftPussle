const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyA', 'KeyZ', 'KeyM', 'KeyF', 'KeyC', 'Tab', 'KeyP', 'Escape']);

export function createInput(handlers) {
  const down = new Set();
  function press(code) {
    down.add(code);
    handlers.anyKey?.();
    if (code === 'KeyA') handlers.up?.();
    else if (code === 'KeyZ') handlers.down?.();
    else if (code === 'KeyR') handlers.restart?.();
    else if (code === 'Enter') handlers.next?.(code);
    else if (code === 'KeyM' || code === 'Tab') handlers.swapView?.();
    else if (code === 'KeyC') handlers.toggleSmall?.();
    else if (code === 'KeyF') handlers.fullscreen?.();
    else if (code === 'KeyP') handlers.pause?.();
    else if (code === 'Escape') handlers.menu?.();
  }
  // On-screen buttons (#touch [data-key]) act as virtual keys; each pointer is tracked so several can be held at once.
  const held = new Map();
  const release = (id) => { const c = held.get(id); if (c) { held.delete(id); if (![...held.values()].includes(c)) down.delete(c); } };
  const buttons = [...document.querySelectorAll('#touch [data-key]')];
  const buttonAt = (x, y) => buttons.find((b) => { const r = b.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; });
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
  const padTouches = new Set();
  const touchKeys = new Set();
  const syncTouches = (e) => {
    if (handlers.blocked?.()) { // menu open: drop all pad touches so they neither steer nor steal taps from the menu
      if (padTouches.size || touchKeys.size) { padTouches.clear(); touchKeys.clear(); down.clear(); buttons.forEach((b) => b.classList.remove('on')); }
      return;
    }
    const live = new Map();
    for (const t of e.touches) live.set(t.identifier, t);
    for (const t of e.changedTouches) {
      if (e.type === 'touchstart' && buttonAt(t.clientX, t.clientY)) padTouches.add(t.identifier);
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
    if (e.cancelable && [...e.changedTouches].some((t) => padTouches.has(t.identifier) || e.type === 'touchstart' && buttonAt(t.clientX, t.clientY))) e.preventDefault();
  };
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) window.addEventListener(type, syncTouches, { passive: false, capture: true });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Tab' && e.target !== document.body) return;
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    press(e.code);
  });
  window.addEventListener('keyup', (e) => down.delete(e.code));
  window.addEventListener('blur', () => { down.clear(); held.clear(); padTouches.clear(); touchKeys.clear(); });
  return {
    clear: () => { down.clear(); held.clear(); padTouches.clear(); touchKeys.clear(); buttons.forEach((b) => b.classList.remove('on')); },
    state: () => ({
      up: down.has('ArrowUp'),
      down: down.has('ArrowDown'),
      left: down.has('ArrowLeft'),
      right: down.has('ArrowRight'),
    }),
  };
}
