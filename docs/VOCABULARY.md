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
| **Endless mode** | Level-less mode (menu → Game, `?endless`): no win, ends when every incoming dock is still occupied as the next truck arrives | `newEndless`, `g.endless`, `status:'over'` |
| **Incoming truck / dock** | Grey truck standing in one of six bays (three on each of the west and east walls; the southernmost are filled first, alternating sides, each has a permanent flat ramp decal on the warehouse side, truck or not), carrying 2×3 stacks of random height and colour (messier over time). It leaves once unloaded; if all docks are still occupied when the next truck is due the game is over | `g.endless.docks`, `DOCKS`, `DOCK_COLOR` |
| **Delivery truck / bay** | One per colour: a trailer with six drop points (2 wide × 3 deep slots, 4 boxes each); when full and the forklift is out, the gate closes, it drives off with its load and a new one arrives; drawn in its bay colour with wheels, a darker cab and light-grey rear doors (the gate), a wooden plank floor, a small loading permanent flat ramp decal in front of the bay (always visible, no height) and a solid cab block at the south edge behind it; the trailers stand in the yard south of the warehouse, their gates in line with the south wall (`parts.cab`; `truckGeom` gives floor and ramp) | `endless.bays`, bay `state` |
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
| **Score popup** | Floating popup for a drop point's stack: `Score: ±N` (completed / moved off) | `scorePopups`, `zonePoints`, `hitRows` |
| **Wonkiness popup** | Separate floating popup, one row lower: `Wonkiness: ±N` when a stack is placed or nudged more/less crooked; re-pops on every change | `scorePopups`, `hitRows` |
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
| **Compass** | Small needle (shown only when north is not up; always in the chase camera) under the fork gauge pointing north (world up) as seen from the current camera | `drawCompass` |
| **Chase camera** | Third-person GL overview camera behind the forklift on a spring (`view.camA` lags the forklift heading, so the tail swings); drag/Q/W orbit it around the middle of the tines, driving springs it back; a wall hiding more than half the forklift makes it orbit upwards (`view.chaseLift`) (C / menu / double tap on the canvas); the minimap outlines its tilted floor footprint instead of a rectangle | `view.chase`, `chaseCamera`, `groundFootprint` |
| **Corner window / look window** | Small inset showing the other view | `drawLook3d` |
| **Software camera** | 2D Canvas renderer (`pov.js`, `pov/camera.js`) | – |
| **GL camera** | WebGL renderer (`gl/camera.js`) | `povCamera`, `overviewCamera` |
| **Eye** | Cabin camera position/pitch following the forks | `g.ef`, `EYE_Z` |
| **Follow camera** | Overview that scrolls on big maps | `main.js` |
| **Parallax** | Fake height in the 2D overview | `PX`, `PY` |
| **Blob shadow** | Simple shadow under objects in GL | `dynamicMeshes` |
| **Disco lights** | Glitter balls and coloured light pools (real point lights in WebGL), dark mode only | `disco.js` |
| **Headlights / brake & reverse lights** | Dark-mode GL point lights on every forklift, own and other players' (spots high on the A-pillars; red when braking, white when reversing); ceiling lights add the remaining ~25% | `gl/scene.js` |

## UI

| Term | Meaning | In code |
|------|---------|---------|
| **HUD** | Score, time, best, loss breakdown overlay | `render.js` |
| **HUD pop-up** | In full screen the HUD is hidden and floats down for ~2 s when score/zones/hint change | `render.js` |
| **Unlock flash** | Full-screen centre banner when the parking spot unlocks | `render.js` |
| **Status strip** | Compact HUD line (e.g. with the cabin view) | `render.js` |
| **Start board** | Level + local/global best shown until the truck first moves, the canvas is touched/clicked, or 10 s have passed | `drawStartBoard` |
| **Level complete overlay** | End-of-level breakdown with top lists | `render.js` |
| **Splash** | Title screen: seed, Start, Start endless, options | `#splash` |
| **Menu / pause menu** | Esc/P menu with pages: main, sound, display, game, info, state | `#menu` |
| **Zoom slider** | Desktop-only on-screen camera zoom slider in the bottom-right of the main view (same value as Camera zoom in the menu) | `#zoomBar` |
| **Record prompt** | Name entry when a record is set | `#record` |
| **Tutorial banner** | 5-step hint strip | `#tutorial` |
| **Testing banner** | Red "TEST" banner on non-official hosts | `#testingBanner` |
| **Touch controls** | On-screen buttons or joystick (classic / rotated / joystick) | `#touch`, `#stick` |
| **Paused overlay** | Drawn when the window is unfocused | `view.paused` |
| **Debug overlay** | `?debug` timing panel | `debug.js` |
| **State export/import** | Save-game text in the menu (testing builds only) | `savestate.js` |

## Multiplayer

| Term | Meaning | In code |
|------|---------|---------|
| **Party / party code** | A hosted multiplayer game and its 5-character join code | `mp.code`, `#partyCode` |
| **Host / guest** | Host runs the game; guests send input and render snapshots | `createHost`, `createGuest` |
| **Truck colour** | Per-player palette (yellow, red, blue, green) | `TRUCK_COLORS`, `truckColor` |
| **Ghost** | Translucent truck that overlaps another at spawn; not solid until separated | `isGhost`, `ghostBetween` |
| **Handoff** | Taking or giving a carried stack via tines | `transferCarried` |
| **Multiplayer page** | Menu page for hosting, roster, ping, kick/ban | `#mpList`, `renderMpPage` |
| **Kick / ban** | Host removes a guest; a ban refuses that name for the party | `host.kick` |
| **Party badge** | Top-right party code and player list | `drawPartyBadge` |

## Audio

| Term | Meaning | In code |
|------|---------|---------|
| **Music / track** | MIDI songs, random by default | `TRACKS`, `audio.js` |
| **Horn** | Key H (hold): continuous two-tone horn with a floating label in the truck colour growing HONK → HOOOOONK → *HOOOOONK* (0.5 s per O, stars after 3 s) over the honking truck (`honkers`/`drawHonk` in `pov/overlay.js`, drawn in all four views), one voice per truck with its own pitch; `truck.horn` is synced in snapshots and the guest's `in` message | `setHorns`, `hornFreq` |
| **Engine whine / beep** | Electric motor sound and reversing beep | `setEngine` |
| **Particles** | GL-only effects: sparks (wall bonk / scrape), tyre smoke (`slip`: wheelspin against a wall or when shoved), damage smoke + cardboard chips, dust when a stack is set down, confetti on a completed zone | `gl/particles.js`, `tireSlip`, truck `contact` / `slip` |
| **Fork sound / blocked / break / bonk / scrape / success** | Sound effects | `playFork`, `playBlocked`, `playBreak`, `playBonk`, `setScrape`, `playSuccess` |
