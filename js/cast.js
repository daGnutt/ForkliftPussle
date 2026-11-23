export const CAST_APPLICATION_ID = '87D66C71';

export function createCastSender({ cast, chromeApi }) {
  const context = cast?.framework?.CastContext?.getInstance?.();
  if (!context || !chromeApi?.cast) throw new Error('Google Cast is unavailable in this browser');
  context.setOptions({
    receiverApplicationId: CAST_APPLICATION_ID,
    autoJoinPolicy: chromeApi.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });
  return {
    async start() {
      await context.requestSession();
      if (!context.getCurrentSession()) throw new Error('No Cast receiver session was started');
    },
  };
}

export function createEmptyPartyTimer(onTimeout, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null;
  return {
    update(players) {
      if (players > 0) {
        if (timer !== null) clearTimer(timer);
        timer = null;
      } else if (timer === null) {
        timer = setTimer(() => {
          timer = null;
          onTimeout();
        }, 60000);
      }
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

export function requestCastFrame(callback, {
  requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame,
  setTimer = setTimeout, clearTimer = clearTimeout, now = () => performance.now(),
} = {}) {
  let done = false;
  const finish = (time) => {
    if (done) return;
    done = true;
    clearTimer(timer);
    callback(time);
  };
  const animation = requestFrame(finish);
  const timer = setTimer(() => {
    if (done) return;
    cancelFrame(animation);
    finish(now());
  }, 1000 / 30);
}
