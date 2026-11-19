export function batterySaverDefault(storage, touch) {
  const saved = storage.getItem('forklift-battery-saver');
  return saved === null ? touch : saved === '1';
}

export function canvasDpr(deviceDpr, width, height, batterySaver, touch) {
  const pixels = Math.max(1, width * height);
  let dpr = deviceDpr || 1;
  if (batterySaver || touch) dpr = Math.min(dpr, 1, Math.sqrt(0.9e6 / pixels));
  return Math.min(dpr, Math.sqrt(3e6 / pixels));
}

export function shouldDraw(now, lastDraw, batterySaver) {
  return !batterySaver || now - lastDraw >= 1000 / 30;
}

export function autosaveIntervalMs(batterySaver) {
  return batterySaver ? 5000 : 1000;
}
