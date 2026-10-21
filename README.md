# Forklift Puzzle

Top-down browser puzzle (keyboard only, tested for Firefox). Drive a forklift and move coloured boxes onto the matching coloured zones. A zone is done when a stack of exactly its count (`×N`) and only its colour sits on it.

## Controls
| Key | Action |
|-----|--------|
| ↑ / ↓ | Drive forward / reverse |
| ← / → | Steer (rear wheels steer, so the tail swings out) |
| Space | Brake |
| A / Z | Forks up / down (levels 0–5) |
| R | Restart level |
| N / P | Next / previous level (Enter after winning) |

## Fork levels
- **0**: tines slide under floor stacks. Press **A** with a stack on the forks to lift the whole stack (goes to level 1).
- **1**: tines touch the floor boxes, so driving into a stack pushes it.
- **2–5**: tines slide into the gap under box layer N of a stack. **A** lifts layer N and everything above it.
- Carried stacks collide with floor stacks that are at least as tall as the carried bottom level. Lower with **Z** to rest on a stack (merge) or to the floor (level 0 drops it). Stacks max 5 layers.
- A stack shows its top colour, plus a coloured number for every box below it (number = layer from the bottom).

## Run / deploy
No build step. Serve the folder statically (ES modules need http): `python3 -m http.server`, then open http://localhost:8000.
GitHub Pages: Settings → Pages → deploy from branch, root folder.

Levels are procedurally generated from the level number (deterministic). Tests: `npm test` (or `node test/game.test.js`).
