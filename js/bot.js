// Cleaning bot (inspired by M-O): lives behind a hatch and drives out for oil or fresh skid marks,
// paths on a coarse grid (avoiding walls, stacks and forklifts), mops oil (one drop per CLEAN_SECS) and
// runs away whenever a forklift comes close. With nothing left to clean it watches forklifts before returning to its hatch.
// Pure data + DOM-free; `g.hatch` is static (regenerated per level), `g.bot` is dynamic (saved and synced).
export * from './bot/common.js';
export * from './bot/nav.js';
export * from './bot/state.js';
export * from './bot/loiter.js';
export * from './bot/cleanbot.js';
export * from './bot/inspector.js';
export * from './bot/conebot.js';
export * from './bot/tapebot.js';
export * from './bot/worker.js';
export * from './bot/fixbot.js';
