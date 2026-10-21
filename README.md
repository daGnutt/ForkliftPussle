# Forklift Frenzy

Top-down browser puzzle (keyboard only, tested for Firefox). Drive a forklift and move coloured boxes onto the matching coloured zones. A zone is done when a stack of exactly its count (`×N`) and only its colour sits on it. All zones of one colour are grouped in a single tinted area.

## Controls
| Key | Action |
|-----|--------|
| ↑ / ↓ | Drive forward / reverse |
| ← / → | Steer (rear wheels steer, so the tail swings out) |
| Space | Brake |
| A / Z | Forks up / down one level |
| M | Mute / unmute the background music |
| R | Restart level |
| N / P | Next / previous level (Enter after winning) |

## Seeds
On the splash screen you can type a seed (a number or any text) and press Enter/Start. **Random** fills in a random seed. The same seed and level number always give the same layout; empty = the default levels. The seed is remembered between visits.

## Fork levels
Fork level is a whole number 0–5 (height above the floor in box heights), changed with **A** (up) and **Z** (down). A floor stack spans heights 0..n. Tines never collide with boxes (the forklift body and carried boxes still do), but empty forks can't be lowered *through* a box: **Z** then plays a buzz, the forks stay put and the box under them loses 10 points. Raise the forks (or back out) first.

- **Level H**: tines are under the box at height H of the stack in front of you. **A** lifts every box from there up (the forks rise one level). Level 0 takes the whole stack, level 1 everything above the bottom box, and so on.
- **Carrying**: **A** raises, **Z** lowers. Carried boxes collide with floor stacks that reach their height, so raise high enough to pass over them.
- **Put down**: lower with **Z** until the carried boxes reach the stack beneath (or the floor, level 0); they are released as soon as they reach it (merge, max 5 layers).
- The gauge on the right shows the fork level, the stack the forks are in, and what you carry. A stack shows its top colour, plus a coloured number for every box below it (number = layer from the bottom).

## Run / deploy
No build step. Serve the folder statically (ES modules need http): `python3 -m http.server`, then open http://localhost:8000.
GitHub Pages: Settings → Pages → deploy from branch, root folder.

## Finishing a level
You spawn in a parking spot (marked **P**). To finish a level, fill every zone, have at least 50% of the maximum score, and drive back into the parking spot (aligned, nearly stopped).

## Scoring
Each box is worth 100 points, but only boxes in a stack that is in its correct zone count towards your score. Crashing into boxes (or hitting a wall while carrying) costs a few points, down to 50 per box; the other 50 depend on how square a box is when you put it down (within 5° is free; deductions come in steps of 5); you can pick a box up and re-place it to fix its squareness (crash losses stay). The score resets on level load/restart.

Levels are procedurally generated from the level number (deterministic). Tests: `npm test` (or `node test/game.test.js`).
