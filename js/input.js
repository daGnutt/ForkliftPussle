const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyA', 'KeyZ']);

export function createInput(handlers) {
  const down = new Set();
  window.addEventListener('keydown', (e) => {
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    down.add(e.code);
    if (e.code === 'KeyA') handlers.up?.(e.shiftKey);
    else if (e.code === 'KeyZ') handlers.down?.(e.shiftKey);
    else if (e.code === 'KeyR') handlers.restart?.();
    else if (e.code === 'KeyN' || e.code === 'Enter') handlers.next?.(e.code);
    else if (e.code === 'KeyP') handlers.prev?.();
  });
  window.addEventListener('keyup', (e) => down.delete(e.code));
  window.addEventListener('blur', () => down.clear());
  return {
    state: () => ({
      up: down.has('ArrowUp'),
      down: down.has('ArrowDown'),
      left: down.has('ArrowLeft'),
      right: down.has('ArrowRight'),
      brake: down.has('Space'),
    }),
  };
}
