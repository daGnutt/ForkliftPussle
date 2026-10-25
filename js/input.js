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
  document.querySelectorAll('#touch [data-key]').forEach((b) => {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.setPointerCapture?.(e.pointerId);
      b.classList.add('on');
      held.set(e.pointerId, b.dataset.key);
      press(b.dataset.key);
    });
    const up = (e) => { b.classList.remove('on'); release(e.pointerId); };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    // Cancelling touchstart stops the browser's long-press handling (context menu / haptic buzz).
    b.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Tab' && e.target !== document.body) return;
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    press(e.code);
  });
  window.addEventListener('keyup', (e) => down.delete(e.code));
  window.addEventListener('blur', () => { down.clear(); held.clear(); });
  return {
    clear: () => { down.clear(); held.clear(); },
    state: () => ({
      up: down.has('ArrowUp'),
      down: down.has('ArrowDown'),
      left: down.has('ArrowLeft'),
      right: down.has('ArrowRight'),
      brake: down.has('Space'),
    }),
  };
}
