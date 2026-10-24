// Local forklift frame: x forward, y right, origin at the (fixed) front axle.
// Steering happens at the rear axle, so the tail swings out when turning.
export const FL = {
  L: 1.5,
  back: -1.9,
  front: 0.35,
  halfW: 0.55,
  tineX0: 0.35,
  tineX1: 1.55,
  tineOff: 0.3,
  tineHalf: 0.07,
  carryX: 1.0,
  maxSteer: 0.7,
};

const ACC = 3.2;
const BRAKE = 12;
const ROLL = 1.4;
const MAX_FWD = 4;
const MAX_REV = 2.5;
const STEER_RATE = 2.0;

// Raised forks make the forklift top-heavy: top speed and acceleration taper
// off linearly with fork level H (0..MAX_H), down to MIN_SPEED_FACTOR at full height.
const MAX_H = 5;
const MIN_SPEED_FACTOR = 0.45;

export function heightSpeedFactor(h) {
  return 1 - (1 - MIN_SPEED_FACTOR) * Math.max(0, Math.min(1, h / MAX_H));
}

export function makeForklift(x, y, a) {
  return { x, y, a, speed: 0, steer: 0 };
}

export function toWorld(f, lx, ly) {
  const c = Math.cos(f.a), s = Math.sin(f.a);
  return { x: f.x + lx * c - ly * s, y: f.y + lx * s + ly * c };
}

export function toLocal(f, wx, wy) {
  const c = Math.cos(f.a), s = Math.sin(f.a);
  const dx = wx - f.x, dy = wy - f.y;
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

function approachZero(v, d) {
  return Math.abs(v) <= d ? 0 : v - Math.sign(v) * d;
}

export function drive(f, inp, dt, h = 0) {
  const hsf = heightSpeedFactor(h);
  const capFwd = MAX_FWD * hsf, capRev = MAX_REV * hsf;
  const th = (inp.up ? 1 : 0) - (inp.down ? 1 : 0);
  const overCap = f.speed > capFwd || f.speed < -capRev;
  if (inp.brake) {
    f.speed = approachZero(f.speed, BRAKE * dt);
  } else if (overCap) {
    // Raising the forks past the current speed's cap bleeds speed off like releasing
    // the throttle (even while still holding it), until back within the new cap.
    if (f.speed > capFwd) f.speed = Math.max(capFwd, f.speed - ROLL * dt);
    else f.speed = Math.min(-capRev, f.speed + ROLL * dt);
  } else if (th !== 0) {
    const against = f.speed * th < 0;
    f.speed += th * (against ? ACC * 2 : ACC) * hsf * dt;
  } else {
    f.speed = approachZero(f.speed, ROLL * dt);
  }
  f.speed -= f.speed * 0.1 * dt;

  const target = ((inp.right ? 1 : 0) - (inp.left ? 1 : 0)) * FL.maxSteer;
  const dSteer = Math.max(-STEER_RATE * dt, Math.min(STEER_RATE * dt, target - f.steer));
  f.steer += dSteer;

  f.a += (f.speed * Math.tan(f.steer) / FL.L) * dt;
  f.x += Math.cos(f.a) * f.speed * dt;
  f.y += Math.sin(f.a) * f.speed * dt;
}
