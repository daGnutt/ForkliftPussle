export function startVisibleLoop(isActive, frame, reset = () => {}) {
  let running = false, ended = false, raf = 0, timeout = 0, generation = 0;

  function clearPending() {
    generation++;
    if (raf) cancelAnimationFrame(raf);
    if (timeout) clearTimeout(timeout);
    raf = timeout = 0;
  }

  function stop() {
    running = false;
    ended = true;
    clearPending();
    document.removeEventListener('visibilitychange', visibilityChanged);
  }

  function request() {
    if (!running || document.hidden) return;
    if (!isActive()) { stop(); return; }
    if (raf || timeout) return;
    const current = generation;
    raf = requestAnimationFrame((now) => {
      if (current !== generation) return;
      raf = 0;
      if (!running || document.hidden) return;
      if (!isActive()) { stop(); return; }
      schedule(frame(now));
    });
  }

  function schedule(delay = 0) {
    if (!running || document.hidden) return;
    if (!isActive()) { stop(); return; }
    if (raf || timeout) return;
    if (delay > 0) {
      const current = generation;
      timeout = setTimeout(() => {
        if (current !== generation) return;
        timeout = 0;
        request();
      }, delay);
    } else {
      request();
    }
  }

  function visibilityChanged() {
    if (document.hidden) {
      if (!running) return;
      running = false;
      clearPending();
      reset();
    } else if (!ended && isActive()) {
      if (running) return;
      running = true;
      reset();
      schedule();
    } else {
      stop();
    }
  }

  document.addEventListener('visibilitychange', visibilityChanged);
  if (!document.hidden && isActive()) {
    running = true;
    schedule();
  } else if (!document.hidden) {
    stop();
  }
  return stop;
}
