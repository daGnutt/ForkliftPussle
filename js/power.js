export function batterySaverOption(storage, option, touch) {
  const key = `forklift-battery-saver-${option}`;
  const saved = storage.getItem(key);
  if (saved !== null) return saved === '1';
  const legacy = storage.getItem('forklift-battery-saver');
  if (legacy !== null) return legacy === '1';
  return option === 'frame-rate' ? false : touch;
}

export function canvasDpr(deviceDpr, width, height, lowerResolution) {
  const pixels = Math.max(1, width * height);
  let dpr = deviceDpr || 1;
  if (lowerResolution) dpr = Math.min(dpr, 1, Math.sqrt(0.9e6 / pixels));
  return Math.min(dpr, Math.sqrt(3e6 / pixels));
}

export function shouldDraw(now, lastDraw, limitFrameRate) {
  return !limitFrameRate || now - lastDraw >= 1000 / 30;
}

export function autosaveIntervalMs(saveLessOften) {
  return saveLessOften ? 5000 : 1000;
}
