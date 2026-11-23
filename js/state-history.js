// Samples detached save-state data against active simulation time.
export function createStateHistory() {
  const samples = [];
  let time = 0, lastSample = -Infinity;
  return {
    clear() { samples.length = 0; time = 0; lastSample = -Infinity; },
    step(dt, snapshot) {
      if (!samples.length) {
        samples.push({ time, state: snapshot() });
        lastSample = time;
      }
      time += dt;
      if (time - lastSample + 1e-9 >= 0.1) {
        samples.push({ time, state: snapshot() });
        lastSample = time;
      }
      while (samples.length > 1 && samples[1].time <= time - 5 + 1e-9) samples.shift();
    },
    earlier() {
      return samples.length && samples[0].time <= time - 5 + 1e-9 ? samples[0].state : null;
    },
  };
}
