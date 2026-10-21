# Forklift Puzzle

Top-down browser puzzle (keyboard only, tested for Firefox). Drive a forklift and move coloured boxes onto the matching coloured zones. A zone is done when a stack of exactly its count (`×N`) and only its colour sits on it.

## Controls
| Key | Action |
|-----|--------|
| ↑ / ↓ | Drive forward / reverse |
| ← / → | Steer (rear wheels steer, so the tail swings out) |
| Space | Brake |
| A / Z | Forks up / down one full step (Shift: half step) |
| R | Restart level |
| N / P | Next / previous level (Enter after winning) |

## Fork height
Box layer *i* (1–5) occupies height *i*−0.5 … *i*+0.5, so a floor stack spans 0.5–5.5. The tines sit at height **H** (0 – 5.5). **A/Z** move the forks a full step (±1), **Shift+A / Shift+Z** a half step (±0.5, only while the forks are empty).

- **Integer H (1–5)**: tines are *inside* that box layer, so driving into a stack pushes it.
- **Half-integer H (0.5, 1.5 …)**: tines are in the gap *under* layer H+0.5 and slide into a stack freely (0.5 = floor level, under the whole stack).
- **Pick up / destack**: with the tines in a gap under layer *k* of the stack in front of you, press **A**: layers *k* and up are lifted (one step up). From the floor (H 0.5) that is the whole stack. E.g. `Shift+A, A` puts the forks at 1.5, drive in, `A` takes everything above the bottom box.
- **Put down**: lower with **Z**. Carried boxes rest on a stack beneath them (or the floor at H 0.5); pressing **Z** there releases them (merge, max 5 layers). Carried boxes collide with floor stacks that reach their bottom height.
- A stack shows its top colour, plus a coloured number for every box below it (number = layer from the bottom). Tines are drawn at their own height, under the boxes they are beneath.

## Run / deploy
No build step. Serve the folder statically (ES modules need http): `python3 -m http.server`, then open http://localhost:8000.
GitHub Pages: Settings → Pages → deploy from branch, root folder.

Levels are procedurally generated from the level number (deterministic). Tests: `npm test` (or `node test/game.test.js`).
