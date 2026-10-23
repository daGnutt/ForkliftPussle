const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyA', 'KeyZ', 'KeyM', 'KeyF', 'KeyC', 'Tab', 'KeyP', 'Escape']);

export function createInput(handlers) {
  const down = new Set();
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Tab' && e.target !== document.body) return;
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    down.add(e.code);
    handlers.anyKey?.();
    if (e.code === 'KeyA') handlers.up?.();
    else if (e.code === 'KeyZ') handlers.down?.();
    else if (e.code === 'KeyR') handlers.restart?.();
    else if (e.code === 'Enter') handlers.next?.(e.code);
    else if (e.code === 'KeyM' || e.code === 'Tab') handlers.swapView?.();
    else if (e.code === 'KeyC') handlers.toggleSmall?.();
    else if (e.code === 'KeyF') handlers.fullscreen?.();
    else if (e.code === 'KeyG') handlers.goto?.();
    else if (e.code === 'KeyP') handlers.pause?.();
    else if (e.code === 'Escape') handlers.menu?.();
  });
  window.addEventListener('keyup', (e) => down.delete(e.code));
  window.addEventListener('blur', () => down.clear());
  return {
    clear: () => down.clear(),
    state: () => ({
      up: down.has('ArrowUp'),
      down: down.has('ArrowDown'),
      left: down.has('ArrowLeft'),
      right: down.has('ArrowRight'),
      brake: down.has('Space'),
    }),
  };
}
