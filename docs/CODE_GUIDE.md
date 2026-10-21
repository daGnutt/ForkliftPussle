# Code guide (for AI agents)

Read this first for a map of the code. Vanilla JS ES modules + Canvas 2D, no build, no dependencies. Source lives in `js/`, tests in `test/game.test.js` (`npm test`).

## Module map

| File | Role | Key exports |
|------|------|-------------|
| `js/main.js` | Browser entry: canvas setup, fixed 1/120 s loop, level persistence in `localStorage` (`forklift-level`) | – |
| `js/input.js` | Key state (arrows, Space = brake) + discrete handlers (A = fork up, Z = fork down, R restart, N/Enter next, P prev) | `createInput` |
| `js/game.js` | All state and rules; DOM-free so Node tests import it | `newGame`, `update`, `forkUp`, `forkDown`, `stackInZone`, `isSolved`, `zoneDone` |
| `js/forklift.js` | Vehicle model (rear-wheel-steering bicycle) and geometry constants | `FL`, `makeForklift`, `drive`, `toWorld`, `toLocal` |
| `js/level.js` | Seeded procedural level generator | `generateLevel`, `parseSeed`, `levelParams`, `COLORS`, `COLOR_NAMES` |
| `js/audio.js` | Procedural Web Audio (no asset files): generative 98 BPM background music (pad, bass, arpeggio, drums; mute toggle, `localStorage` key `forklift-music-muted`) and SFX; browser only, started on the first key press | `startAudio`, `toggleMusic`, `playFork`, `playBlocked`, `playSuccess`, `setEngine` (electric motor whine, pitch follows speed, called every frame) |
| `js/geom.js` | Polygon helpers: `rectPoly`, SAT collision, `pointRectDist` | – |
| `js/render.js` | Pure drawing from game state | `draw` |

Dependency direction: `main` → `game`, `input`, `render`, `audio` (`main` triggers sounds by watching state changes: fork level, number of done zones; `game.js` stays audio-free); `game` → `forklift`, `level`, `geom`; `render` → `game`, `level`, `forklift`. `game.js` must never touch the DOM.

## Units and coordinates
- Simulation units are tiles; one box is 1×1. The renderer scales the canvas.
- x right, y down; angle `a` in radians, 0 = facing +x.
- Forklift local frame: x forward, y right, origin at the **front** axle; rear wheels steer. `toWorld`/`toLocal` convert.

## Game state `g` (from `newGame`)
- `walls`: border + pillar rects with a `poly` (collision). `pillars`: the raw pillar rects (for drawing).
- `zones`: `{x, y, color, count}` targets. `areas`: `{color, x, y, w, h}` tinted regions; all zones of a colour sit in one area.
- `stacks`: floor stacks `{x, y, layers, a}`; `layers` are colour indices into `COLORS` (bottom → top); `rots` is a parallel array with each box's own world angle (remembered through lift/drop/merge); `a` is the bottom box's angle, used for collision. `pen` is a parallel array of `{crash, sq}` point deductions per box.
- `fl`: forklift `{x, y, a, speed, steer}`.
- `carried`: array of layers being carried, or `null`; `carriedRots`: each carried box's angle relative to the forklift (so they turn with it, and keep their world angle when dropped); `carriedRel` = `carriedRots[0]`, used for collision. `carriedPen`: the carried boxes' `pen` entries.
- `H`: logical fork level (integer 0–5); `hf`: smoothed value used only for drawing.
- `parking`: `{x, y, a}` centre/heading of the parking spot (the forklift's spawn pose).
- `status`: `'play'` or `'won'`; `time`: seconds elapsed.

## Rules (see `game.js`)
- Fork level `H` = box heights above the floor. A stack of n boxes spans heights 0..n. `forkUp` lifts the box at height `H` and everything above it; level 0 lifts the whole stack.
- Tines never collide with boxes. Only the forklift body and the carried stack (when `stack.layers.length > g.H`) do.
- Empty `forkDown` with a box under the forks (`stack.layers.length >= H`, `H > 0`) is refused: returns `'blocked'`, adds 10 crash points (`FORK_BLOCK_POINTS`) to that box; `main.js` then plays `playBlocked`.
- `forkDown` releases the carried stack automatically at its resting height (top of the stack below, or the floor), merging into it. Max 5 layers (`MAX_LAYERS`).
- A zone is done only when a stack of exactly `zone.count` boxes, all of `zone.color`, is within 0.5 of it. Winning (`isFinished`) = all zones done (`isSolved`) AND `score ≥ 50%` of `maxScore` AND forklift parked (`isParked`: within 0.6 of the spot, heading within 0.35 rad, speed < 0.5).
- `resolve()` runs iterative SAT: forklift shapes vs walls; forklift shapes vs stacks (mass-weighted pushing); stacks vs walls; stacks vs stacks.

## Scoring (`game.js`)
- Each box is worth 100 points, but only boxes in a stack that completes a zone count towards `score(g)`; score = sum of (100 − crash − square) over those boxes, so it starts at 0 on every `newGame` and rises as zones are filled; `maxScore` is 100 × all boxes.
- Crash (up to 50 per box): forklift body or carried boxes hitting a floor stack, stack-vs-stack contact, or carried boxes hitting a wall, at forklift speed ≥ 0.8 (1–5 points, 0.4 s cooldown per stack/carried group).
- Squareness (up to 50 per box): on release in `forkDown`, deduction scales with the box's deviation from the nearest multiple of 90° (free within 5°, then floored to steps of 5 points); `sq` is overwritten on every placement, so re-placing a box can recover its squareness points (crash losses are permanent). `lostBreakdown(g)` returns `{crash, square}` totals; the HUD shows both under the score.

## Level generation (`level.js`)
- Deterministic per (level number, seed) via `mulberry32`; `generateLevel(n, seed = 0)`, seed 0 = the default layouts. `parseSeed(text)` maps splash input to an int (integers as-is, other text hashed). `newGame(n, seed)` stores `g.seed`; retries up to 300 attempts and falls back to level 1 if placement keeps failing.
- Order: choose boxes and zone counts per colour → pillars → per-colour zone area → stack placement avoiding areas, pillars and the start.
- Guarantees valid placement and matching box/zone counts, **not** solvability. Difficulty scales in `levelParams`.

## Rendering (`render.js`)
- Height is faked with a parallax offset (`PX`/`PY`). Draw order: floor/grid → areas → zones → low stacks → forklift body → tines → high stacks → carried stack → pillars → HUD.
- `drawStack(ctx, layers, x, y, z0, rots)` draws boxes as extruded cubes (shaded side faces facing the floor-ward parallax direction, gradient lid with tape strip), each with its own angle from `rots`; the top box shows its colour and the boxes below appear as coloured numbers.

## Branding / splash
- Game name: Forklift Frenzy. `favicon.svg` is the tab icon; `#splash` in `index.html` (styled in `style.css`) has a seed text box and a Random button (fills a random integer) (persisted in `localStorage` `forklift-seed`; submitting with Enter/Start applies it and reloads the level). It is dismissed by the first key press outside the box (handled in `main.js`, which pauses the simulation until then and swallows that key).

## Tests
- `test/game.test.js` is a sequence of independent blocks (plain `node:assert`). Helpers: `run` (simulate seconds of input), `driveUntil`, `flatWorld` (clears zones and pillars). Any game-logic change needs a scenario here.

## Workflow conventions
- Each fix or feature goes on its own local branch (not pushed); never merge into `main` unless the user explicitly asks; delete the branch only after such a merge.
- Update `README.md` when controls or rules change, and this guide when structure changes.
