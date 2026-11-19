# Vocabulary

Shared names for things in Pallet Polka, so bug reports and requests are unambiguous. The "In code" column gives the identifier to grep for. Edit freely; if a term changes, tell the agent.

## The world

| Term | Meaning | In code |
|------|---------|---------|
| **Level** | One generated map, deterministic per level number + seed | `generateLevel`, `g.level` |
| **Seed** | Text/number that varies the generated layouts; only set via URL `?seed=` | `g.seed` |
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
| **Open-top box** | Box with an open lid and a "do not stack" sign; nothing can be put on it, so it is only ever the top box (`pen.open`, `stack.open` in layouts) | `topOpen`, `newPen`, `boxDecalShapes(4)` |
| **Wide box** | Always gray; 1×2 box (long side across the forks) on two pallets; lifted only with both tines under it and heading within ~27° of its local x axis, stacks only with other wide boxes; worth 200 and only fits a wide zone (`pen.wide`, `stack.wide` in layouts) | `wideBox`, `halfY`, `boxPoints`, `markWide` |
| **Wide zone** | 1×2 drop point for a stack of 1–3 wide boxes, grouped with the other wide zones in the one gray area (`zone.wide`, `hx`/`hy` half extents, `a`) | `zoneExt`, `tryWide` |
| **Oil barrel** | A rigid, two-box-high load of its own type (`BARREL_COLOR`) that cannot be stacked on; one barrel counts as one item in its dedicated zone (`pen.barrelPart`) | `markOilBarrel`, `BARREL_COLOR`, `barrelPart` |
| **Oil slick** | Persistent floor puddle formed by merging nearby oil drops; each barrel holds 50 drops and leaks one per damage point per ten seconds. Affects drive and steering tires independently, allowing rear-axle drift | `g.oil`, `dropOil`, `wheelOilGrip`, `axleOilGrip`, `stepOil` |
| **Cleaning bot** | Small (about a quarter forklift) M-O-style robot that emerges from the **bot hatch** when there is oil, mops each drop in 5 s and flees from nearby forklifts | `g.bot`, `js/bot.js` |
| **Inspection flag** | Bobbing sign the inspector leaves over a stack it judged could be better: an amber tilted box for crooked (wonky) boxes, a red cracked box for repairable damage, alternating (~1 s each) when both (shown in all views and on the minimap, gone, and the stack re-inspected, as soon as the stack is touched in any way) | `flaggedStacks`, `flagSymbol`, `drawFlag` |
| **Inspection photo** | Polaroid-style popup in the top right (max 25% of the screen each; up to 4 can be up at once, each in its own corner; moves to a free corner and shrinks if needed so it never covers the touch controls or the forklift) showing the scanned stack (crooked and offset boxes drawn as they are, oil drums as striped cylinders) from the bot's low vantage point looking up, on a white caption strip below the picture with "GOOD JOB" or "COULD BE BETTER" written on it | `g.photo`, `js/photo.js` A damaged or crooked stack is never GOOD JOB: the caption lists the problems per box (lowest box = Box 1). Damaged boxes carry a yellow warning triangle, and putting the tines into a stack that still carries the inspector's flag (photographed, untouched, damaged or wonky) shows the picture taken of that stack again (tap it on touch to hide it). |
| **Photo gallery** | End-of-level popups: every stack's inspector photo with the points it contributed (damage and wonky deductions), many at once, tiled over the whole screen (anywhere, no no-go zones; always underneath the **Level complete overlay**), rotating through all of them, the stack dormant longest first; stacks the inspector never photographed get a faked picture | `endPhotos`, `startGallery`, `scoreText` |
| **Inspection bot** | Ebo-style white egg with a black visor, ring eyes and a lens; drives out of the bot hatch to every completed drop point, laser-scans it, flashes, shows the photo and floats a ⚠ Warning (wonky stack) or ✔ Perfect label up from itself, then shows the photo it took (**Inspection photo**) and goes home; flees from forklifts | `g.inspector`, `stepInspector` |
| **Bot hatch** | Predetermined door in an outer wall (every level) where the bots come out and go home | `g.hatch`, `makeHatch` |
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
| **Done zone** | Drop point holding exactly `count` items of its colour (barrels count as one item despite being two heights) | `zoneDone` |
| **Parking spot** | Where the forklift starts and must finish; turns green when ready, shows heading arrow | `g.parking`, `isParked` |
| **Repair station** | Pallet turntable wrapping machine against a wall (mast on the wall side), at the free spot nearest the parking spot: a round turntable (hazard rim, turning spokes) with a film mast post beside it. It holds one single box: the box spins and is repaired 1 damage point per second, getting more **tape** (stretch-film strips across its lid, also visible in the inspection photo) the more is repaired. A truck close to the turntable pauses the spin and the repair. |
| **Event tip** | One-off 8 s pop-up in the tutorial banner, shown once per device the first time boxes hit the ceiling, empty forks are lowered through a box, or an oil barrel is damaged (flags `forklift-ceiling-tip`, `forklift-forkbox-tip`, `forklift-oil-tip`) | `checkEventTips`, `js/main.js` |
| **Repair hint** | Onboarding until the first repair on this device (`forklift-repaired` in `localStorage`): while carrying one damaged, repairable box, a tip pop-up, an arrow towards the station (overview: beside the truck; cab views: on the screen edge), a glow on the station and a blinking minimap marker | `repairHintWanted`, `js/repairhint.js` |
| **Endless mode** | Level-less mode (menu → Play, `?endless`): no win, ends when every incoming dock is still occupied as the next truck arrives, or by hand with menu → Play → End endless run | `newEndless`, `g.endless`, `status:'over'` |
| **Incoming truck / dock** | Grey truck (honks once on arrival) standing in one of six bays (three on each of the west and east walls; the southernmost are filled first, alternating sides, each has a permanent flat ramp decal on the warehouse side, truck or not, marked with its bay number 1-6; a small **bay wait panel** under the compass shows each truck's waiting time), carrying 2×3 stacks of random height and colour (messier over time). It leaves once unloaded; if all docks are still occupied when the next truck is due the game is over | `g.endless.docks`, `DOCKS`, `DOCK_COLOR` |
| **Loading lane** | Two yellow-outlined strips across the warehouse (west to east), each between two incoming bays and two box rows deep, for parking boxes | `loadingLanes`, `g.bays` in endless |
| **Delivery truck / bay** | One per colour: a trailer with six drop points (2 wide × 3 deep slots, 4 boxes each); when full and every forklift (body, carried stack and tines) is well clear, the gate closes (reopening if one comes close again) and the truck honks twice, it drives off with its load and a new one arrives; drawn in its bay colour with wheels, a darker cab and light-grey rear doors (the gate), a wooden plank floor, a small loading permanent flat ramp decal in front of the bay (always visible, no height) and a solid cab block at the south edge behind it; the trailers stand in the yard south of the warehouse, their gates in line with the south wall (`parts.cab`; `truckGeom` gives floor and ramp) | `endless.bays`, bay `state` |
| **Level complete / win** | All zones done + parked | `isFinished`, `status:'won'` |

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
| **Fork gauge** | HUD ladder showing fork height, boxes under the forks and the carried stack | `drawForkGauge` |
| **Box status badge** | In the fork gauge, after inspection and until the stack is nudged, a warning triangle marks repairable damage and a tilted diamond marks crookedness | `boxStatus`, `drawBoxStatus` |
| **Smoothed fork height** | Animated height used only for drawing | `g.hf`, `g.ef` |
| **Fork up / fork down** | Keys A / Z | `forkUp`, `forkDown` |
| **Lifted / perched truck** | A truck riding on another truck's tines (`liftedBy`, cannot move) or sitting on top of stacks (`perchZ`) | `forkUp`, `liftedHf` |
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
| **Endless save** | Autosaved endless game in progress, resumed by Start endless after a browser restart; game over clears it | `forklift-endless-state`, `serializeEndless` |
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

## Performance settings

| Term | Meaning | In code |
|------|---------|---------|
| **Battery saver** | Graphics-menu setting (default on touch devices) that caps canvas resolution, limits drawing to 30 fps, reduces decorative effects, slows autosaving and freezes the splash animation after 20 seconds | `forklift-battery-saver`, `view.batterySaver` |

## Views and cameras

| Term | Meaning | In code |
|------|---------|---------|
| **Overview** | Top-down (tilted) view of the level; default | `drawWorld`, `drawOverview3d` |
| **Cabin view / POV** | First-person view from the driver's seat | `drawPov`, `drawPov3d` |
| **Orbit / look** | Drag or `,`/`.` in the GL views: swings the overview around the forklift (`view.orbit`) or turns the cab camera (`view.look`); driving springs it back (`view.snap`), except the chase camera, which is left where it was put (Q/W swing `view.camP` 45° around the truck via `chaseOrbit`, `view.chaseGoal`); its tilt (height) slowly eases back to `CHASE_TILT` while it moves) | `view.orbit`, `view.look` |
| **Big view** | Which of overview/cabin fills the screen | `view.povBig` |
| **Compass** | Small needle (shown only when north is not up; always in the chase camera) under the fork gauge pointing north (world up) as seen from the current camera | `drawCompass` |
| **Chase camera** | Third-person GL overview camera behind the forklift (`view.camP` is its floor position: it translates as little as possible, only to stay within a maximum distance of the truck, and pitches/yaws to keep the truck centred, so reversing causes no swing; while moving it slowly drifts behind (forwards) or in front (reverse) of the truck; drag/Q/W orbit it around the middle of the tines, driving springs it back; a wall hiding more than half the forklift makes it orbit upwards (`view.chaseLift`) (C / menu / double tap on the canvas); the minimap outlines its tilted floor footprint instead of a rectangle | `view.chase`, `chaseCamera`, `groundFootprint` |
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
| **Level complete overlay** | End-of-level breakdown with top lists (own `#results` canvas above the gallery photos) | `drawResults` |
| **Splash** | Title screen: Start, Start endless, options | `#splash` |
| **Scheme picker** | First-run popup on the splash to choose keyboard scheme / touch layout; keyboard version also shows a gamepad pictogram + local-multiplayer hint (`.padhint`) | `#schemePicker`, `schemepicker.js` |
| **Control hints** | Lists on the menu's "Controls" page of the extra controls (camera drag, double-tap chase camera, minimap tap, honk…); the desktop list is hidden on touch devices and the touch list on desktop | `#ctlDesktop`, `#ctlTouch` |
| **Gamepad map** | Static pictogram of the gamepad controls on the menu's "Controls" page; on touch devices only shown once a gamepad has been seen (`forklift-pad-seen` in `localStorage`) | `.padmap` / `#padMap` in `index.html` |
| **Touch map** | The three touch-layout pictograms (active one highlighted, tap to select) shown instead of the keyboard map on touch devices; reuses `TOUCH` from `schemepicker.js` | `#touchMap`, `applyTouch` |
| **Keyboard map** | The two keyboard-scheme pictograms (active one highlighted; click or Enter/Space selects it, like the dropdown) above the gamepad map; reuses `KEYBOARD` from `schemepicker.js` | `#keyMap`, `applyKeys` |
| **Menu / pause menu** | Esc/P menu with pages: main, play, sound, graphics, camera, controls, party (Multiplayer), scores (Scores & saves), info | `#menu` |
| **Report link** | Main-menu entry "Report a bug / request a feature" opening the GitHub issues page in a new tab | `#menu a.nav` |
| **Zoom slider** | Desktop-only on-screen camera zoom slider in the bottom-right of the main view (sets the chase camera's zoom, same value as Camera zoom in the menu, while in the chase camera, and the overview's own zoom otherwise) | `#zoomBar` |
| **Record prompt** | Name entry when a record is set | `#record` |
| **Tutorial banner** | 5-step hint strip | `#tutorial` |
| **Testing banner** | Red "TEST" banner on non-official hosts | `#testingBanner` |
| **Local multiplayer** | Extra trucks driven by gamepads on the same screen | `createLocal`, `view.shared` |
| **Gamepad** | Controller input polled in `createInput` (standard mapping) | `pollPad` |
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
| **Ghost** | Translucent truck that overlaps another truck (or a stack, `s.ghost`) at spawn; not solid until separated | `isGhost`, `ghostBetween` |
| **Handoff** | Taking or giving a carried stack via tines | `transferCarried` |
| **Multiplayer page** | Menu page for hosting, roster, ping, kick/ban | `#mpList`, `renderMpPage` |
| **Kick / ban** | Host removes a guest; a ban refuses that name for the party | `host.kick` |
| **Party badge** | Top-right party code and player list | `drawPartyBadge` |

## Audio

| Term | Meaning | In code |
|------|---------|---------|
| **Music / track** | MIDI songs, random by default | `TRACKS`, `audio.js` |
| **Horn** | Key H (hold; each press also fires a shockwave, a hop and small wiggle of nearby stacks, see *Honk shockwave* in docs/code/): continuous two-tone horn with a floating label in the truck colour growing HONK → HOOOOONK → *HOOOOONK* (0.5 s per O, stars after 3 s) over the honking truck (`honkers`/`drawHonk` in `pov/overlay.js`, drawn in all four views; in the cabin and GL views a label outside the view is pinned just inside the edge, smaller, by `pinHonk`), one voice per truck with its own pitch; `truck.horn` is synced in snapshots and the guest's `in` message | `setHorns`, `hornFreq` |
| **Proximity alert** | Headlights (both views) flash red plus fast double beep (beep toggle) in any gear but R with occupied forks (also when coasting or standing still), when the carried stack's path over the next 1 s (following the current steering arc, plus a close probe reaching at least 1 tile beyond the fork tips, sweep limited to 90° of turn) hits a stack at an overlapping height; debug mode (`?debug`) outlines the probes and floats a lightbulb decal with a 3 s countdown above every stack that set the alert off | `crashAlert`, `alertTriggers`, `crashProbes` (`game.js`), `drawAlertProbes`, `drawAlertMarks` (`debug.js`), `setCrashAlert`, `crashBlink`, `render.js` `drawAlertGlow` |
| **Engine whine / beep** | Electric motor sound and reversing beep (plus the proximity alert); each has a volume slider (**Engine**, 50% = original loudness; **Beeps**) on the sound page, next to **Master**, **Music** and **Other sound effects**; 0 = muted | `setEngine`, `setVolume`, `getVolume` |
| **Particles** | GL-only effects: sparks (wall bonk / scrape), tyre smoke (`slip`: wheelspin against a wall or when shoved), damage smoke + cardboard chips, dust when a stack is set down outside drop zones, confetti on a completed zone | `gl/particles.js`, `tireSlip`, truck `contact` / `slip` |
| **Fork sound / blocked / break / bonk / scrape / success** | Sound effects | `playFork`, `playBlocked`, `playBreak`, `playBonk`, `setScrape`, `playSuccess` |
