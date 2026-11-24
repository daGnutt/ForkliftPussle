# Code guide (for AI agents)

Read this index first, then only the files relevant to your task. Vanilla JS ES modules + Canvas 2D, no build, no dependencies. Source lives in `js/`, tests in `test/*.test.js` by category (`npm test`).

| File | Contents |
|------|----------|
| [code/modules-core.md](code/modules-core.md) | Module map: `main`, `game`, `forklift`, `level`, `input`, `gamepad`, `local`, `savestate`, `theme`, `geom`, `debug`, `power`, `testing`; dependency direction; gear |
| [code/modules-modes.md](code/modules-modes.md) | Module map: `endless`, `bot`, `highscores`, `globalscores`, `repair` |
| [code/modules-audiovisual.md](code/modules-audiovisual.md) | Module map: `render`, `audio`, `midi`, `photo`, `disco`, `decals`, `revlight`, `dents` |
| [code/modules-3d.md](code/modules-3d.md) | Module map: cabin view `pov.js` + `pov/`, GL renderer `gl/`, bot and tape-post beacons |
| [code/features.md](code/features.md) | Open-top boxes, oil barrels |
| [code/multiplayer.md](code/multiplayer.md) | Party / multiplayer (lifting trucks etc.) |
| [code/state-and-rules.md](code/state-and-rules.md) | Units and pallet dimensions, game state `g`, fork and stack rules, scoring (including Hard Mode placement and inspection), level generation, rendering |
| [code/project.md](code/project.md) | Branding/splash, PWA, tests, workflow conventions |

When you change something, update the matching file (module → `modules-*.md`, state/rules/level/rendering → `state-and-rules.md`) and keep this index current if files are added or split. Keep each file under ~20 KB so it stays readable in one go.
