# Pallet Polka

Top-down browser puzzle (keyboard only, tested for Firefox). Drive a forklift and move coloured boxes onto the matching coloured zones. A zone is done when a stack of exactly its count (`×N`) and only its colour sits on it. All zones of one colour are grouped in a single tinted area.

## Controls

On touch devices, on-screen buttons replace the keyboard (big steer left/right buttons on the left; on the right the top row raises/lowers the forks and the bottom row drives back/forward, plus Menu (top right); the Menu's "Touch controls" option switches layout: classic, rotated (forks up/down in the left column, drive forward/back in the right column of the bottom-right pad), or an analog virtual square joystick bottom right (the further you push, the more throttle/steering; small dead zone; let go and the forklift brakes) for driving with only the fork buttons bottom left; tap the level-complete board for the next level; the cabin view is not offered on touch, except as a hidden easter egg: in landscape, tap the minimap to swap between overview and cab view; rotating to portrait switches back to the overview; plus Next after a win).
| Key | Action |
|-----|--------|
| ↑ / ↓ | Drive forward / reverse (the truck stays in gear D or R until it has stopped and starts moving the other way; R turns on reverse lights and beeps, the GL cabin view keeps looking forward and doesn't swivel round) |
| ← / → | Steer (rear wheels steer, so the tail swings out) |
| A / Z | Forks up / down one level (hold Z: drop to the lowest safe level). With the **WASD** keyboard scheme (menu → Visuals → Keyboard): E / Q (hold Q: lowest safe level), and W/S/A/D drive and steer (the arrow keys then do nothing) |
| C | Switch the 3D overview between the top-down camera and a third-person camera (behind and above the forklift, which always points up the screen while the world rotates); also a menu option, or double-tap (double-click) the 3D overview |
| , / . (also W / Q in the arrows scheme) | Look around in the 3D (WebGL) views: turn the cabin view left (, or W) / right (. or Q), or spring the overview a quarter turn around the view centre; in the third-person camera each press swings it 45° around the forklift. Dragging the view with the mouse/touch does the same (also tilts); driving springs the cabin view back and the overview to the nearest 90°, while the third-person camera stays where you put it (it only follows the usual distance rules); a tilted third-person camera slowly eases back to its default height while it moves |
| H (hold) | Horn: sounds for as long as the key is held; each honk also sends a shockwave (3.5 tiles) that makes nearby stacks, and the boxes on any truck's forks, jump and wiggle a little (boxes shift and turn slightly but never leave their stack). In a party every truck has its own pitch. On touch screens: hold two fingers on the canvas |
| Gamepad | Standard-mapping controller: right trigger accelerates, left trigger brakes/reverses, left stick X steers (all analog: how far you pull/tilt scales acceleration and steering), A or RB fork up, B or LB fork down (hold to lower fully), X horn, Y swap view, right stick X look around, right stick click chase camera, Start menu (also closes it; on the splash it starts the game). In the menu: d-pad up/down move, left/right adjust sliders and drop-downs, A selects, B goes back/closes |
| Local multiplayer | Menu → Game → Local multiplayer: you keep the keyboard, up to three gamepads join the same level by pressing A (same pad controls as above, one truck each; unplug to leave). The overview camera frames all trucks; the chase camera and zoom slider are off while pads are joined. Not available during an online party |
| M / Tab | Swap the big view between the top-down overview and the cabin (first-person) view. The cabin view has two small top-down windows at the top centre: rear on the left, front on the right. In local multiplayer M/Tab (keyboard truck) or Y (pad) instead opens a cabin view for that truck in its own window: the screen splits (1 cabin: half and half; 2: overview on top, cabins below; 3: quadrants; 4: four cabin quadrants with a translucent minimap in the centre) |
| (pause menu) | Button to stop or restart the on-screen tutorial (shown once on first play: drive, forks, place a stack, cab view, extras like camera/honk and a pointer to Menu → Info; each step disappears when you do it) |
| F | Toggle full screen (also in the menu). With the menu option "Auto full-screen" (off by default) enabled, starting from the splash or resuming from the menu enters full screen and opening the menu leaves it. Esc leaves full screen first (browser behaviour); use P for the menu there |
| Esc / P | Menu (pauses the game and timer; the music keeps playing in the menu; the game also pauses and mutes sound effects when the window loses focus): mute all sounds, sound effects on/off (with engine whine and reversing beep as separate sub-toggles), music on/off (off by default), random music (default: a new random track after each song) and track choice (public-domain/CC0/CC-BY MIDI songs: polka, country, Bach, metal, rock, groove and dance; credits in `assets/midi/CREDITS.md`), decals on/off (less cluttered view), colour mode follow OS/light/dark, disco lights on/off (dark mode only; off by default), an Info & scoring page, go to a level number, and restart the level with hard mode on or off (these settings are remembered). Menu shortcuts: M mute all, G level field, Esc/P/Enter resume |
| Enter | Next level (after winning) |

## 3D graphics
The overview, cabin view and look windows are rendered in true 3D with WebGL2 (depth-buffered, lit, fogged; no libraries). If WebGL2 isn't available the game falls back to the old 2D canvas renderers. The pause menu's "3D graphics (WebGL)" option (or `?gl=0` / `?gl=1`, see [URL parameters](#url-parameters)) switches between them.

## Saved progress
The level in progress (stacks, forklift, forks, timer) is saved in your browser every second, so reloading the page resumes where you left off. The pause menu has **Export state** (fills the text box with a compressed base64 string, or plain JSON in `?debug` mode, and copies it to the clipboard) and **Import state** (paste a previously exported state into the box to load it, including its seed, hard mode and level).

## Seeds
The seed is only set through the URL parameter `?seed=` (a number or any text), intended for tournaments; there is no seed field on the splash screen. The same seed and level number always give the same layout; no seed = the default levels.

The top 10 local scores and the top 10 global scores for the level are shown when a level loads and on the end-of-level screen. The best score per seed and level is stored locally in your browser and shown in the HUD. Finishing a level with a higher score (or the same score faster) asks for a name. The submitted score is the level score minus 1 point per 10 seconds spent (this does not affect whether the level counts as finished) to store with the record. The menu's "Game & levels" page has "Pull my scores from server" downloads your online scores (by the saved player name) into this browser.

## Fork levels
Fork level is a whole number 0–5 (height above the floor in box heights), changed with **A** (up) and **Z** (down). A floor stack spans heights 0..n. Tines never collide with boxes (the forklift body and carried boxes still do), but empty forks can't be lowered *through* a box: **Z** then plays a buzz, the forks stay put and the box under them loses 10 points. Raise the forks (or back out) first. Holding **Z** (or the lower button) for 0.4 s drops the forks straight to the lowest safe level: the floor, the resting height of a carried stack (which is released), or just above a box the empty forks can't pass; it never causes damage. The higher the forks, the more top-heavy the forklift is: top speed and acceleration drop off with fork height, down to under half speed at the maximum level 5.

- **Hard mode** (splash checkbox, remembered): enables the pallet rules below.
- **Straight in**: the tines only slide into the pallet's slots when you come in along the pallet's slots, perpendicular to the tape on the box (from the sides they hit the runners); otherwise they hit the pallet's runners, pushing it and turning it according to where they hit. Turn the forklift with the forks in a pallet and the pallet glides sideways (and turns) with the forks (in a stack the whole stack moves, but only the boxes from the fork level upward turn), while you can still slide the forks in and out.
- **Level H**: tines are under the box at height H of the stack in front of you. **A** lifts every box from there up (the forks rise one level). Level 0 takes the whole stack, level 1 everything above the bottom box, and so on.
- **Lifting trucks** (multiplayer): with the forks at floor level (or level with a perched truck), drive the tines under the *side* of another truck (roughly at right angles to it) and press **A** to lift it; it rides sideways on your tines and cannot drive or work its forks until it is put down. A truck carrying boxes can be lifted too, but if its boxes would hit the ceiling the lift stops and they are damaged. A truck perched on a stack goes with it when you take the stack, and is perched again when you put the stack down. Lower with **Z**: on the floor it drives again, on top of a stack it stays perched (immobile) until lifted off again or until the stack is removed. The lifted truck's cabin view rides up with it.
- **Carrying**: **A** raises, **Z** lowers. Carried boxes collide with floor stacks that reach their height, so raise high enough to pass over them.
- **Ceiling**: raising carried boxes into the ceiling (stack top above 6 box heights) is refused and damages every carried box.
- **Put down**: lower with **Z** until the carried boxes reach the stack beneath (or the floor, level 0); they are released as soon as they reach it (merge, max 5 layers). At least half of the box must rest on the box below, otherwise it falls off beside the stack and takes maximum damage. Boxes keep the offset they were dropped with, so you can build a crooked tower, or push a box sideways off a stack with the forks or a carried box.
- **Wide boxes** (from level 3, always gray, any gray box fits any gray zone): 1×2 boxes that lie across the forks. Drive in square on to them with both tines under (a crooked approach is refused), carry them one at a time (they stick out past the truck, so plan your turns), and set them on the floor, on other wide boxes, or on a wide drop point, lined up with it. Wide boxes stack only on wide boxes, and wide drop points are grouped in one gray area and ask for a whole stack of them. A wide box is worth two boxes.
- **Oil barrels** (from level 3): a dedicated dark gray type, two box heights tall on one pallet. Later levels can have multiple barrels (up to four); each has its own drop zone, counted as one barrel. Barrels are always the top load on a stack: nothing can be stacked on them. Lift one from its base as a rigid load. Each damage point leaks one oil drop per ten seconds, until the barrel's 50 drops run out. Nearby drops merge into bigger spills; all 50 drops together make the original full-sized spill. Oil on the front tires reduces drive traction; oil on the rear tires reduces steering grip and can make the truck yaw, drift or spin out.
- The gauge on the right shows the fork level, the stack the forks are in, and what you carry. A stack shows its top colour, plus a coloured number for every box below it (number = layer from the bottom). In local multiplayer every truck on the level gets its own gauge in its truck colour.

## Debug overlay
Add `?debug` to the URL (see [URL parameters](#url-parameters)) for an FPS counter, frame/update/draw timings and their share of frame time (update/draw/debug/idle %, where debug is the overlay's own cost), boxes in the right place and other state, for troubleshooting performance. In endless mode it also shows the adaptive difficulty (measured unloading rate, pace, time to the next truck).

## URL parameters
Combine with `&`, e.g. `index.html?skip&debug&gl=0`.

| Parameter | Effect |
|-----------|--------|
| `?gl=0` / `?gl=1` | Force the 2D canvas / WebGL2 renderers (overrides the saved setting) |
| `?debug` | Show the [debug overlay](#debug-overlay); state export is plain JSON |
| `?skip` | Skip the splash screen and start the game, with the tutorial off for that visit (saved settings are kept); on touch devices it opens the main menu and leaving it enters fullscreen |
| `?level=N` | Start at level N; every page load goes to (and resets) that level, ignoring the saved level and saved progress (timer, box positions) |
| `?local` | Turn on [local multiplayer](#multiplayer) for this visit (pads join with A) |
| `?endless` | Start in endless mode (also in the menu's Game page) |
| `?testing` | Show the TESTING banner/favicon (always on when not served from the production host) |

## Multiplayer
Up to 4 players share a level (co-op, one shared score). On the start screen enter a name and press **Host game** to get a party code, share it, and friends enter it under **Join game**; the host presses Start. Each truck has its own colour (yellow, red, blue, green) and the fork gauge backdrop matches it. Trucks spawning in the parking spot overlap as translucent *ghosts* until they separate, then collide. Put your tines under another truck's carried stack (same or lower height) and raise them to its height to take the stack, or put them inside the stack and raise to take only the boxes from that level up (split); the carrier can lower its tines over yours to give it, or lower a stack onto the one you carry to merge them (max 5 layers). You can also start hosting from the in-game menu (**Esc → Multiplayer**), where the host sees each player's ping and can kick or ban them. Connection is peer-to-peer (WebRTC) via the high score service as relay; the host runs the game. Endless mode works in a party too: the host presses **Start endless** (or restarts endless from the menu) and everyone shares the warehouse, the trucks and the score; the pace adapts to the crew size.

## Run / deploy
No build step. Serve the folder statically (ES modules need http): `python3 -m http.server`, then open http://localhost:8000.
GitHub Pages: Settings → Pages → deploy from branch, root folder.

## Finishing a level
You spawn in a parking spot (marked **P**). To finish a level, fill every zone and drive back into the parking spot (aligned, nearly stopped).

## Scoring
Each box is worth 100 points, but only boxes in a stack that is in its correct zone count towards your score. Nudging a box slowly head-on turns it square to the forklift. Crashing into boxes (or hitting a wall while carrying) costs a few points, down to 50 per box; the other 50 depend on how square a box is when you put it down (within 5° is free; deductions come in steps of 5); you can pick a box up and re-place it to fix its squareness (crash losses stay). The score resets on level load/restart.

Levels are procedurally generated from the level number (deterministic). Tests: `npm test` runs everything; `node test/run.js fork score` runs only some categories (`level physics fork stacks score render save demo net endless`).

The splash screen and the end-of-level overlay explain/break down how the score is calculated (box points, crash and squareness losses, time penalty, final score).
