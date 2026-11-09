# Vocabulary

Shared names for things in Pallet Polka, so bug reports and requests are unambiguous. The "In code" column gives the identifier to grep for. Edit freely; if a term changes, tell the agent.

## The world

| Term | Meaning | In code |
|------|---------|---------|
| **Level** | One generated map, deterministic per level number + seed | `generateLevel`, `g.level` |
| **Seed** | Text/number that varies the generated layouts | `g.seed`, `#seed` |
| **Tile** | Simulation unit; one box is 1×1 tile | – |
| **Outer wall / border** | Walls around the level | `g.walls` |
| **Dividing wall** | Interior wall splitting the level into rooms/corridors | `g.pillars` |
| **Room / corridor** | Spaces made by the dividing walls | `buildRooms` |
| **Doorway / door** | Gap in a dividing wall (hazard-striped jambs with amber beacons, header lamp, dashed centre lane) | `g.doors`, `addDoorways` |
| **Charger** | Red high-voltage wall stub the forklift's tail rests against at the parking spot | `g.charger`, `drawCharger` |
| **Ceiling / joists / light bars / fans** | Overhead scenery (cabin view only) | `drawCeiling`, `overheadDecals` |

## Boxes and stacks

| Term | Meaning | In code |
|------|---------|---------|
| **Box** | One 1×1 crate with a colour | entry in `layers` |
| **Pallet** | The base the bottom box sits on; has runners and slots for the tines | `palletRunners` |
| **Runners** | The pallet's centre and outer boards; leave a **slot** for each tine | `palletRunners` |
| **Stack** | 1–5 boxes on top of each other on the floor | `g.stacks` |
| **Layer** | One box's position/colour in a stack (bottom → top) | `layers` |
| **Top box** | The box drawn in its colour; lower ones show as coloured numbers | `drawStack` |
| **Carried stack** | The boxes currently on the forks | `g.carried` |
| **Wonky / crooked stack** | Boxes turned/offset from each other | `wonkyStack`, `rots`, `offs` |
| **Colour** | Box/zone colour (index into the palette) | `COLORS`, `COLOR_NAMES` |
| **Fall / toppling** | Box with < 50% support falls off the stack as a new damaged stack | `settle`, `MIN_SUPPORT` |
| **Start bay** | Yellow-outlined cluster of 1–4 start stacks | `g.bays` |

## Drop-offs and goal

| Term | Meaning | In code |
|------|---------|---------|
| **Drop point / drop-off** | Target spot for one stack of an exact colour and box count | `g.zones` |
| **Zone label** | Floating `×count` marker on a drop point | `zoneLabelItems` |
| **Drop-off area** | Tinted region holding all drop points of one colour | `g.areas` |
| **Done zone** | Drop point holding exactly `count` boxes of its colour | `zoneDone` |
| **Parking spot** | Where the forklift starts and must finish; turns green when ready, shows heading arrow | `g.parking`, `isParked` |
| **Level complete / win** | All zones done + score ≥ 50% + parked | `isFinished`, `status:'won'` |

## The forklift

| Term | Meaning | In code |
|------|---------|---------|
| **Forklift / truck** | The player vehicle | `g.fl` |
| **Body / chassis** | The truck minus forks; collides with everything | `forklift.js` |
| **Counterweight / tail** | Rear end; swings out when steering | `FL` |
| **Overhead guard / cage / roof** | Frame over the driver | `models.js` |
| **Front axle / rear wheels** | Origin of the local frame / the steering wheels | `FL` |
| **Mast / carriage** | Upright and plate the tines hang from | `addForks` |
| **Bare forks** | Menu option (key B): in the GL cabin view hides the whole forklift body and the mast, leaving carriage and tines | `bareForksEnabled`, `addForks` |
| **Tines / forks / blades** | The two prongs that go into a pallet | `addForks` |
| **Tine tips** | Thin tapered ends; look-at point of the cabin camera | `g.ef` |
| **Fork level** | Integer 0–5 height of the tines in box heights | `g.H` |
| **Smoothed fork height** | Animated height used only for drawing | `g.hf`, `g.ef` |
| **Fork up / fork down** | Keys A / Z | `forkUp`, `forkDown` |
| **Release / drop** | Lowering a carried stack onto the floor/stack | `forkDown` |
| **Blocked fork down** | Refused lowering onto a box; 10 crash points | `'blocked'` |
| **Nudge / align** | Slow forward contact straightens a stack | `g.aligning` |
| **Glide** | Pallet on the tines turns with them (hard mode) | `glideWithForks` |
| **Hard mode** | Realistic pallets: runner collisions, torque | `g.hard` |
| **Reversing light** | Blue disc behind the truck when backing | `revlight.js` |
| **Steering lock** | Max wheel angle; shrinks with speed | `maxSteerFor` |

## Scoring and feedback

| Term | Meaning | In code |
|------|---------|---------|
| **Score** | Points of boxes in completed zones (100 each, minus losses) | `score(g)` |
| **Max score** | 100 × all boxes | `maxScore` |
| **Crash points** | Deduction (≤ 50/box) from hits at speed | `pen.crash`, `hurt` |
| **Squareness points** | Deduction (≤ 50/box) for boxes not at 90° | `pen.sq` |
| **Damage popup** | Floating red `−pts` text | `g.hits`, `drawHits` |
| **Wonky popup** | Amber `Wonky −pts` when placing crooked boxes on a drop point | `wonkyPopup` |
| **Dent / crumple** | Cosmetic damage shape on a box | `dents.js` |
| **Final score** | Score minus time penalty, submitted to the high scores | `finalScore` |
| **Local / global top list** | Local top 10 / online top 10 per seed+level | `highscores.js`, `globalscores.js` |
| **Skid marks / smoke** | Splash-animation effects | `splash.js` |

## Decals (cosmetic)

| Term | Meaning | In code |
|------|---------|---------|
| **Decals** | Collective name; toggled by the menu option "Decals" | `decalsEnabled` |
| **Floor decals** | Tire tracks, oil stains, grates, dashed lines, hazard patches, yellow bays | `floorDecals` |
| **Tire tracks** | Tracks following natural turns | `floorDecals` |
| **Hazard patch / chevrons** | Yellow-black striped markings | `floorDecals`, `wallBase` |
| **Wall signs** | Window, door, exit, extinguisher, speed limit, toilets, posters… | `wallDecal`, `WALL_SIGNS` |
| **Roller door** | Closed two-segment wall decal | `drawWallDecals` |
| **Wall base stripe** | Yellow / chevron stripe along a wall foot | `wallBase` |
| **Overhead decals / fixtures** | Light bars and fans on the ceiling | `overheadDecals` |
| **Box decals** | This-side-up arrows, fragile glass, barcode label | `boxDecalKind` |
| **Charger decals** | High-voltage markings | `chargerDecal` |

## Views and cameras

| Term | Meaning | In code |
|------|---------|---------|
| **Overview** | Top-down (tilted) view of the level; default | `drawWorld`, `drawOverview3d` |
| **Cabin view / POV** | First-person view from the driver's seat | `drawPov`, `drawPov3d` |
| **Orbit / look** | Drag or Q/W in the GL views: swings the overview around the forklift (`view.orbit`) or turns the cab camera (`view.look`); driving springs it back (`view.snap`) | `view.orbit`, `view.look` |
| **Big view** | Which of overview/cabin fills the screen | `view.povBig` |
| **Chase camera** | Third-person GL overview camera behind the forklift on a spring (`view.camA` lags the forklift heading, so the tail swings); drag/Q/W orbit it around the middle of the tines, driving springs it back; a wall hiding more than half the forklift makes it orbit upwards (`view.chaseLift`) (C / menu / double tap on the canvas); the minimap outlines its tilted floor footprint instead of a rectangle | `view.chase`, `chaseCamera`, `groundFootprint` |
| **Corner window / look window** | Small inset showing the other view | `drawLook3d` |
| **Software camera** | 2D Canvas renderer (`pov.js`, `pov/camera.js`) | – |
| **GL camera** | WebGL renderer (`gl/camera.js`) | `povCamera`, `overviewCamera` |
| **Eye** | Cabin camera position/pitch following the forks | `g.ef`, `EYE_Z` |
| **Follow camera** | Overview that scrolls on big maps | `main.js` |
| **Parallax** | Fake height in the 2D overview | `PX`, `PY` |
| **Blob shadow** | Simple shadow under objects in GL | `dynamicMeshes` |
| **Disco lights** | Glitter balls and coloured light pools (real point lights in WebGL), dark mode only | `disco.js` |
| **Headlights / brake & reverse lights** | Dark-mode GL point lights on the forklift (spots high on the A-pillars; red when braking, white when reversing); ceiling lights add the remaining ~25% | `gl/scene.js` |

## UI

| Term | Meaning | In code |
|------|---------|---------|
| **HUD** | Score, time, best, loss breakdown overlay | `render.js` |
| **HUD pop-up** | In full screen the HUD is hidden and floats down for ~2 s when score/zones/hint change | `render.js` |
| **Unlock flash** | Full-screen centre banner when the parking spot unlocks | `render.js` |
| **Status strip** | Compact HUD line (e.g. with the cabin view) | `render.js` |
| **Start board** | Level + local/global best shown until the truck first moves, the canvas is touched/clicked, or 10 s have passed | `drawStartBoard` |
| **Level complete overlay** | End-of-level breakdown with top lists | `render.js` |
| **Splash** | Title screen: seed, Start, Disco start, options | `#splash` |
| **Menu / pause menu** | Esc/P menu with pages: main, sound, display, game, info, state | `#menu` |
| **Record prompt** | Name entry when a record is set | `#record` |
| **Tutorial banner** | 4-step hint strip | `#tutorial` |
| **Testing banner** | Red "TEST" banner on non-official hosts | `#testingBanner` |
| **Touch controls** | On-screen buttons or joystick (classic / rotated / joystick) | `#touch`, `#stick` |
| **Paused overlay** | Drawn when the window is unfocused | `view.paused` |
| **Debug overlay** | `?debug` timing panel | `debug.js` |
| **State export/import** | Save-game text in the menu | `savestate.js` |

## Audio

| Term | Meaning | In code |
|------|---------|---------|
| **Music / track** | MIDI songs, random by default | `TRACKS`, `audio.js` |
| **Engine whine / beep** | Electric motor sound and reversing beep | `setEngine` |
| **Fork sound / blocked / break / bonk / scrape / success** | Sound effects | `playFork`, `playBlocked`, `playBreak`, `playBonk`, `setScrape`, `playSuccess` |
