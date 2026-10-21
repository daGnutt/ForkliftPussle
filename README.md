# Forklift Puzzle

Top-down browser puzzle (keyboard only, tested for Firefox). Drive a forklift and move coloured boxes onto the matching coloured zones. A zone is done when a stack of exactly its count (`×N`) and only its colour sits on it.

## Controls
| Key | Action |
|-----|--------|
| ↑ / ↓ | Drive forward / reverse |
| ← / → | Steer (rear wheels steer, so the tail swings out) |
| Space | Brake |
| A / Z | Forks up / down one level |
| R | Restart level |
| N / P | Next / previous level (Enter after winning) |

## Fork levels
Fork level is a whole number 0–6, changed with **A** (up) and **Z** (down). Box layer *i* (1–5) sits at level *i*. Tines never collide with boxes (the forklift body and carried boxes still do).

- **Level 0**: forks down; they never lift anything.
- **Level k ≥ 1**: tines are under layer *k* of the stack in front of you. Press **A** to lift layer *k* and everything above it (the forks rise to level *k*+1). Level 1 takes the whole stack, level 2 everything above the bottom box, and so on.
- **Carrying**: **A** raises, **Z** lowers. Carried boxes collide with floor stacks that reach their level, so raise high enough to pass over them.
- **Put down**: lower until the carried boxes rest on the stack beneath (or the floor, level 1), then press **Z** once more to release them (merge, max 5 layers).
- A stack shows its top colour, plus a coloured number for every box below it (number = layer from the bottom). Tines are drawn at their own height, under the boxes they are beneath.

## Run / deploy
No build step. Serve the folder statically (ES modules need http): `python3 -m http.server`, then open http://localhost:8000.
GitHub Pages: Settings → Pages → deploy from branch, root folder.

Levels are procedurally generated from the level number (deterministic). Tests: `npm test` (or `node test/game.test.js`).
