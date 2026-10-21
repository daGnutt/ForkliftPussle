# Copilot instructions

Top-down, keyboard-only forklift puzzle. Vanilla JS ES modules + Canvas 2D, **no build step, no dependencies**; deployed as static files on GitHub Pages (Firefox is the primary target).

**Before starting any task, read `docs/CODE_GUIDE.md`** (module map, state shape, rules). Keep it up to date when you change the structure.

## Commands
- Test (plain `node:assert`, no framework; Node ≥ 20): `npm test` (= `node test/game.test.js`). Tests are sequential blocks in one file, so to run one scenario, temporarily comment out the others.
- Run: serve the repo root statically (modules don't load from `file://`), e.g. `python3 -m http.server`, then open `index.html`.
- No linter or build.

## Architecture
- `level.js` – seeded (`mulberry32`) procedural generator: `generateLevel(n)` is deterministic per level number and returns plain data (`walls`, `zones`, `stacks`, `start`). Difficulty scales in `levelParams`. It guarantees valid placement and matching box/zone counts, not solvability.
- `game.js` – all game state and rules, DOM-free (so tests import it in Node). `newGame(n)` builds state `g`; `update(g, input, dt)` steps it; `forkUp/forkDown` are discrete key actions; `isSolved/zoneDone` define winning. `resolve()` does collision/pushing with iterative SAT (`geom.js`).
- `forklift.js` – vehicle model: rear-wheel-steering bicycle model. Local frame has x forward and the origin at the **front** axle; the rear wheels steer, so the tail swings out. `FL` holds the geometry.
- `render.js` – pure drawing from `g`; `input.js` – key state + discrete handlers; `main.js` – fixed 1/120 s timestep loop and level persistence (`localStorage`).
- Simulation units are tiles (1 box = 1×1); render scales the canvas.

## Key conventions
- **Fork levels are integers 0–5** (`g.H`) = box heights above the floor. A floor stack of n boxes spans heights 0..n; tines at level H sit under the box at height H, and `forkUp` lifts that box and everything above it. Level 0 on a floor stack lifts the whole stack. Tines never collide with boxes; only the forklift body and the *carried* stack (when `stack.layers.length > g.H`) do.
- Lowering a carried stack (`forkDown`) releases it automatically on reaching the resting height (top of the stack beneath, or 0 on the floor), merging into that stack; max 5 layers (`MAX_LAYERS`).
- `g.H` is the logical level; `g.hf` is the smoothed value used only for drawing. Rendering fakes height with a parallax offset (`PX`/`PY` in `render.js`) and draws tines at their own height, over low stacks and under high ones.
- Stack `layers` are arrays of colour indices into `COLORS` (bottom → top). The top box is drawn in its colour, with coloured numbers for each box below.
- Zones are only satisfied by a stack of *exactly* `zone.count` boxes all of `zone.color`.
- Game-logic changes should be accompanied by a scenario in `test/game.test.js`, using the `run`/`driveUntil` helpers to simulate driving; update `README.md` control docs when the fork rules change.
- Update `docs/CODE_GUIDE.md` whenever a change affects module structure, game state shape, rules, level generation, or rendering.
- Create every new fix or feature on its own branch (not directly on `main`).
- Keep fix/feature branches local only (don't push them) unless explicitly told otherwise. After merging one into `main`, delete the local branch.
