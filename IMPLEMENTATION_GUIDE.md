# Implementation Guide: A Warehouse Forklift Stacking Puzzle

This guide describes how to build a spiritual successor to a cosy, slightly chaotic forklift puzzle game. It is about feel, intent and behaviour. It deliberately leaves out technology, data layouts and exact tuning values. Tune by playing until it feels the way this guide describes.

---

## 1. The Pitch

> *Stack the boxes. Park the forklift. Mind the tail swing.*

You arrive after a shift change and the last crew left a mess: piles of coloured boxes scattered around a warehouse. You drive a small, chunky forklift. Your job is to put every box on the drop-off spot of its colour, in a stack of exactly the height that spot asks for. Then you drive back to your charging spot and park neatly.

The game is a **spatial puzzle disguised as a driving game**. The puzzle is in which boxes to move, in what order, and how to unstack and restack them. The challenge, and the comedy, is in the handling: a rear-steering vehicle whose tail swings wide, which gets wobbly and slow when its forks are high, and which knocks things over if you're careless.

### Pillars

1. **The truck is the toy.** Driving must be satisfying even with no goal. Rear-wheel steering, tail swing, near-pivot turning at a crawl, engine braking when you let go.
2. **Exactness over speed.** A zone wants *exactly* N boxes of *only* its colour. Crooked placement and bumps cost points. Time costs a little, but never stops you finishing.
3. **Physical honesty.** Boxes sit where you put them, keep their crookedness, fall off when unsupported, slide when pushed. Nothing snaps to a grid.
4. **Warm, toy-like presentation.** Bold primary colours, hazard stripes, soft synth bleeps, a polka soundtrack, little robots with personalities.
5. **Forgiving structure, demanding craft.** You can always finish a level. Doing it *well* is the real goal.

---

## 2. The Forklift (The Most Important Section)

Spend most of your early time here. If the truck doesn't feel right, nothing else will.

### 2.1 Geometry and steering

- Treat the **front axle as the pivot**. The front wheels drive, and the **rear wheels steer**. Turning swings the counterweighted tail out to the side, like a real warehouse forklift.
- At a standstill or crawl, full lock is so tight that the rear wheels swing past the front axle and the truck **almost spins on the spot**. This makes tight manoeuvring possible but tricky.
- **The steering lock narrows with speed.** At top speed the maximum wheel angle is much shallower. This stops high-speed spins and rewards slowing down for corners.
- The steering wheel **turns towards the target angle at a limited rate**, so there's a slight, smooth lag when you snap from full left to full right.
- The tines stick out well in front of the body. The body is a little longer than the tines, and most of it is behind the front wheels. Tail swing should be a real hazard in narrow corridors.

### 2.2 Throttle, braking and gears

- Accelerate moderately. Push the throttle against your current motion and the truck **brakes about twice as hard** as it accelerates.
- **Releasing the throttle engine-brakes.** The truck rolls to a stop fairly quickly rather than coasting forever. Add a small extra drag proportional to speed.
- Reverse top speed is noticeably lower than forward, a bit over half.
- **Gear logic:** the truck stays in Drive until it has fully stopped and you push backwards, then it changes to Reverse, and vice versa. Reverse turns on the reverse lights and the beeper. If you sit idle in Reverse for a few seconds, the truck quietly drops back to Drive so the beeping stops.
- An analog input (stick, trigger, virtual joystick) scales throttle and steering smoothly. On a virtual joystick, **letting go actively brakes** instead of coasting.

### 2.3 Top-heaviness

- The higher the forks, the **slower and more sluggish** the truck becomes. Top speed and acceleration fall off steadily to a bit under half at full height. Braking is not affected.
- If you raise the forks while driving fast, the extra speed **bleeds off gradually**, like releasing the throttle, rather than snapping down.
- This makes "drive low, lift late" the natural expert habit.

### 2.4 Collisions and impact feel

- The body collides with walls, stacks and other trucks. Carried boxes collide too. **The tines themselves pass through boxes** in normal mode, but see the pallet rules in Hard Mode.
- Hitting something **off-centre** gives the truck a little yaw kick, so it pivots around the contact point. It also gets a sideways skid away from the obstacle. Both fade quickly as the tyres regain grip.
- Driving into an immovable wall while on the throttle makes the **tyres spin**: tyre smoke and a squeal.
- Sliding along a wall at speed gives a continuous **scrape** with sparks.
- A sudden large loss of forward speed counts as a **bonk**: a cartoon thud, a spark burst, a little screen of embers.

### 2.5 Fork levels

- The forks move in **whole box heights**, from the floor up to five boxes high.
- One press of up or down moves the forks one level, with a short hydraulic whirr. **Holding down** for a moment drops them to the lowest safe level in one go: the floor, the point where a carried stack touches down, or just above a box the empty forks can't pass. Hold-to-drop never causes damage.
- The forks animate smoothly between levels. The game logic only ever sees whole levels.
- **Picking up:** the tines at level H are under the box that sits at height H in the stack in front of you. Raising lifts **that box and everything above it**. At the floor you take the whole stack; one level up you leave the bottom box behind. This partial lifting is the core of the puzzle.
- **Lowering empty forks into a box is refused.** You get a buzz, the forks stay put, and that box takes a small damage hit. You must back out or raise first.
- **Ceiling:** carrying a stack so high that its top would go above a fixed ceiling height is refused, and **every carried box is damaged**.
- **Putting down:** lower until the carried boxes touch whatever is beneath, either the floor or the top of a stack. They release automatically right there and merge into that stack. A stack is never taller than five boxes.

---

## 3. Boxes, Stacks and Their Physics

### 3.1 Boxes

- Each box is a cube about half a tile high, sitting on **its own wooden pallet** with three runners and a deck of slats. It has a coloured cardboard body, a slightly lighter lid and a tape strip across it.
- The **tape strip runs at right angles to the pallet's fork slots**, so you can read which way to approach.
- Each box can carry a small cosmetic label: this-side-up arrows, a fragile glass sign or a barcode.
- Every box has its own **angle and small offset** from the box below. Fresh stacks start **slightly wonky**: each box turned and shifted a little, the same way every time for that level. The world never looks machine-perfect.

### 3.2 Support and toppling

- When a box ends up with **less than half its area** on the box beneath, it falls off, along with everything above it. It tumbles a short distance to the side and lands as a new stack with **maximum damage**. If it lands neatly on top of a nearby stack, it settles there instead.
- Falls never go through walls. The landing spot is searched outward and redirected if a wall is in the way.
- The tumble is animated: a short slide, a turn and a drop with a little bounce. The game logic treats it as already landed.

### 3.3 Pushing, nudging and squaring

- **Slow, gentle forward contact** with the front of the truck **nudges a stack square** to the truck without damage. Use this deliberately to tidy crooked stacks. Contact with the tines only straightens the boxes at and just above the fork level. Boxes above the straightened ones turn along with them, keeping their relative angles.
- A stack pressed slowly into a wall **squares itself against the wall**. Hit the wall hard and a corner snags and the stack spins instead.
- Pushing a stack **off-centre turns it** by the lever arm of the push.
- **Hard hits** shove the upper boxes further than the lower ones, since they have more leverage and nothing holds them. This can make them topple.
- Boxes that have slid noticeably off the box below can be pushed back into line by the truck body or the fork carriage.
- Carried boxes can push individual boxes of a floor stack. You can scrape the top box off a stack with your load.

### 3.4 Damage

- Hitting stacks with the body or carried boxes above a gentle speed, stacks hitting stacks, or a carried load hitting a wall all deal **a few points of damage** per hit. There is a short cooldown per stack so one scrape doesn't count dozens of times.
- Each hit **dents** the box where it was struck: a crumpled corner, a bite out of a side, or a crushed lid. Dents grow with accumulated damage until a heavily damaged box looks properly crushed.
- A red **"−N" popup** floats up from the hit. Repeated hits within a moment add up into one popup.
- Damage on a box is capped at half its value.

### 3.5 Special box types

Introduce these gradually as levels progress.

- **Open-top boxes:** a box with an open lid and a "DO NOT STACK" sign. Nothing can go on it, so it can only ever be the top box. The generator never creates more open-top boxes of a colour than that colour has zones.
- **Wide boxes:** always grey, double length, on two pallets, lying across the forks. Any grey box fits any grey zone. You must come in **square** with both tines under; a crooked approach is refused. They stick out past the truck, so plan your turns. They stack only on other wide boxes and go to **wide drop points**, which are grouped in one grey area. A wide box is worth double.
- **Oil barrels:** a dark drum two box-heights tall on one pallet. It is lifted from its base as one rigid load and **nothing stacks on top**. Each barrel has its own one-barrel drop spot.
  - A **damaged barrel leaks**. The more damage, the faster it drips. Drops fall wherever the barrel is, so a carried barrel leaves a trail.
  - Each barrel holds a finite amount of oil. Nearby drops **merge into growing puddles**; together, all of a barrel's oil makes one big spill.
  - **Oil on the front (drive) wheels** cuts traction. **Oil on the rear (steering) wheels** cuts steering grip and lets the tail slide out, so you can drift or spin. One rear wheel on oil yanks the truck sideways. Tyre smoke shows the slipping.

---

## 4. Drop Zones, Scoring and Winning

### 4.1 Zones

- Each **drop point** wants a stack of **exactly N boxes, all of its colour**, sitting roughly on top of it. A floating or painted **"×N"** label sits beside it.
- All drop points of a colour are grouped in **one tinted drop-off area**, preferably flush against an outer wall. Inside it, the tallest stacks go at the back, against the wall, so you fill back to front.
- A completed zone fills in its colour, plays a cheerful rising four-note chime and bursts **confetti** in its colour. If the stack is crooked you get a deliberately out-of-tune, sagging version of the chime.
- Taking a stack off a completed zone pops a negative score.

### 4.2 Scoring

- Each box is worth **a hundred points**, split into two halves:
  - **Damage half:** lost through crashes, never through gentle nudging.
  - **Squareness half:** lost by being turned away from square. A few degrees is free; beyond that you lose points in coarse steps. Squareness is always judged from **the box's current angle**, so nudging a stack straight later earns those points back.
- Only boxes in a **completed zone** earn points. Damage on loose or carried boxes is subtracted right away, so the live score **can go negative**.
- **Score popups** above a zone: "Score: +N" when it completes. A separate "Wonkiness: ±N" line re-pops every time you nudge the stack more or less crooked.
- **Time penalty:** the submitted score loses a point for every several seconds spent. The level timer only starts when the truck first moves, so you can study the layout for free. Time never prevents finishing.

### 4.3 Winning

- Fill every zone. The parking spot then **unlocks**: it turns green, shows an arrow for the required heading, and a "PARKING SPOT UNLOCKED" banner pulses briefly.
- Drive into the parking spot, **lined up, nearly stopped and facing the right way**, to finish. There is no minimum score.
- The parking spot is backed against a red **charger**: a stub jutting from a wall with high-voltage signs. Your tail rests against it.

### 4.4 Level complete

- A dark band shows the breakdown: box points − damage − squareness = points, then the time penalty and the final score. Next to it are a **local top list** and an **online top list** for that level and seed.
- Behind it plays the **photo gallery** (see the inspection bot section).
- A new personal best asks for a name. Lesser scores join the local list quietly.
- Continue with a key press or a tap to go to the next level.

---

## 5. Hard Mode (Realistic Pallets)

An opt-in toggle, remembered between sessions, that turns pallets into real physical objects.

- The tines **only slide into a pallet's slots when you approach along the slots**, square to the tape. From the side they hit the runners.
- A tine hitting a runner off-centre **pushes and turns** the pallet.
- With the tines inside a pallet, turning the truck makes the pallet **glide sideways with the forks** while you can still slide the forks in and out. In a stack the whole stack moves, but only the boxes from the fork level up turn.
- A tine push with the forks partway up a stack only damages the boxes below the forks, unless you're going fast, in which case the whole stack suffers.

---

## 6. Level Generation

Levels are **generated from the level number plus an optional seed**, and the same inputs always give the same layout. A seed is meant for tournaments and sharing; with no seed you get the "default" campaign.

### 6.1 Progression

As the level number rises:
- The map grows wider, up to a cap, and its height follows the width.
- More colours, more boxes, taller zones and stacks.
- From the second level, **dividing walls** split the warehouse into rooms and corridors. There are more dividers later, up to a cap.
- From the second level, **open-top boxes** appear.
- From around level three, **wide boxes** and **oil barrels** start appearing, more of each in later levels.

### 6.2 Generation recipe

1. **Parking and charger:** pick a random outer wall and spot. The truck faces straight out from the wall with its tail against the charger stub.
2. **Boxes and zones:** make sure every colour appears at least once, then fill up randomly. For each colour, split its boxes into zones of random heights, never taller than this level's maximum.
3. **Starting stacks:** shuffle all boxes and deal them into stacks of random height.
4. **Rooms:** repeatedly split the largest region with a thick wall. Each wall gets one wide **doorway**, or sometimes two on long walls. Sometimes the split makes a narrow **corridor** instead of two rooms. Later walls avoid earlier doorways so everything stays connected. Keep walls away from the start.
5. **Drop-off areas:** one tidy block per colour, mostly flush against an outer wall, kept clear of walls, other areas and the start. Lay out the drop points on a grid, tallest at the back.
6. **Start bays:** group starting stacks into clusters of one to four on a loose grid. Each cluster gets a big yellow outlined bay on the floor, kept clear of walls, doorways, areas and other bays.
7. **Specials:** mark open-top boxes, swap some zones for wide zones, and convert matching pairs of boxes into oil barrels with their own zones. Each special uses its own random sequence, so adding a feature doesn't reshuffle older layouts.
8. **Tidy:** shrink colour areas to fit their remaining drop points and push them back against their wall.
9. **Validate:** flood-fill from the start (keeping clear of walls by about the truck's half-width) and require every stack and zone to be reachable. Wide boxes and wide zones also need a **straight approach corridor** long enough to back the tines out. If validation fails, try again with the next attempt number, so it stays deterministic.

Validation guarantees reachability, not solvability. It doesn't account for turning circles. That's acceptable: the player can always shove stacks around.

---

## 7. The Supporting Cast: Bots and the Repair Station

These give the warehouse life and make mistakes recoverable.

### 7.1 The bot hatch

Every level has a small **hatch in an outer wall**: a dark slot with a yellow stripe. Robots slide straight out of it, always facing forward, and drive straight back in. When they leave, they line up in front of the hatch, turn to face it, and roll in.

### 7.2 The inspection bot

- **Look:** a small white egg on treads with a black visor, ring eyes and a camera lens.
- **Behaviour:**
  - When a zone is completed, it rolls out slowly and deliberately. It parks at a **diagonal vantage point** near the stack's corner, so the photo shows two faces.
  - It sweeps a **red laser** up the stack one box at a time, then **flashes** a photo.
  - A label floats up from it: **"✔ Perfect"** or **"⚠ Warning"**.
  - It visits every newly completed zone, lingers briefly, then goes home.
- **Personality:** a bit oblivious. It only flees trucks actually driving towards it, and only notices obstacles right in front of it. A scare cancels its scan.
- **Flags:** a stack it judged imperfect gets a bobbing flag over it, shown in every view and on the minimap: an amber tilted box for crooked, a red cracked box for damage, alternating if both. Touching the stack in any way removes the flag and queues a re-inspection.

### 7.3 Inspection photos

- A **instant-camera-style photo** with a white frame and a caption strip. It's taken from the bot's low vantage looking up, so stacks look heroic.
- The scene is simple: a warm wall, a dark ceiling with lights, a grey floor. Boxes are drawn exactly as crooked as they really are.
  - Damaged boxes carry a yellow warning triangle.
  - Repaired boxes show stretch film.
  - Barrels appear as banded drums.
- The caption is a slightly tilted headline: green **"GOOD JOB"** or red **"COULD BE BETTER"**. Below it, one line per problem, counting from the bottom box, e.g. "Box 2 has damage and is wonky".
- Photos **fly in from the nearest edge** into a screen corner, slightly tilted. They linger for a few seconds and then fade.
  - Only a few can be up at once.
  - They dodge the truck, the HUD and the touch controls, and shrink if they must.
- Pushing your tines into a still-flagged stack **shows its old photo again**, smaller and sepia-toned, as a reminder.
- **End-of-level gallery:** every stack's photo with the points it earned ("100 − damage − wonky = N"). Stacks the bot never photographed get a faked photo. Photos pop in one after another, tile all free screen space and keep cycling, with the longest-untouched stacks first.

### 7.4 The cleaning bot

- Appears only on levels with barrels, as soon as oil hits the floor.
- **Look:** a small rounded white bot on treads with a dark visor, a single glowing eye and a spinning roller brush held out front. It's about a quarter the size of a truck.
- **Behaviour:**
  - It mops spills one drop at a time. Each drop takes several seconds, so a big spill takes minutes.
  - It cleans open floor first, smallest and nearest spills first. Oil under stacks comes last; it reaches in from the stack's edge.
  - It's **skittish**. A moving truck coming close makes it flee to the reachable spot farthest from all trucks, avoiding corners where it could be trapped. Its eye turns orange-red. For a while afterwards it stays spooked and prefers spills far from trucks.
  - When fully blocked, it waits in a roomy nearby spot and checks again regularly. Eventually it gives up on that spill for a while if there's other work.
  - Trucks gently push it aside. It is never crushed and never pinned into walls.

### 7.5 Droid voices

Both bots "speak" in quick, chirpy **droid babble**: short sweeping beeps with vibrato. Each bot has its own pitch, and the sound gets quieter with distance. There are distinct phrases:
- bright and rising when they appear;
- falling when they go home;
- frantic squeaks when scared;
- low mumbles when they start mopping;
- a fast climbing trill while scanning;
- a happy warble or a worried wobble after a photo.

### 7.6 The repair station

- A **pallet-wrapping turntable** near the parking spot: a round pad with a hazard-striped rim and spokes, and a film mast beside it that you can't drive through. It sits against a wall, with the mast on the wall side.
- Set **one ordinary box** on it and it **spins**, slowly repairing damage. Stretch-film strips build up on the lid as it goes. When done it snaps square and its dents smooth out, but the film stays as a scar.
- It **pauses while any truck is close**, so you have to back off and let it work.
- Onboarding: until a player has repaired something once, carrying a single damaged box shows:
  - a tip;
  - a pulsing arrow towards the station (pinned to the screen edge in first-person);
  - a glowing station;
  - a blinking minimap marker.

---

## 8. Endless Mode

A level-less, open-ended mode with its own fixed warehouse.

### 8.1 Layout

- A medium warehouse with **six numbered incoming bays**, three in each side wall. The bay numbers are painted big on the floor ramps so co-op players can call out "bay four!".
- Yellow-outlined **loading lanes** cross the floor between bays, as staging areas.
- Along the south wall stand **outbound trucks**, one per colour, each painted its colour and opening through its own gap in the wall. Each holds a grid of drop slots that each want a full stack of its colour.
- **Roller doors** in every opening roll up when a truck docks and stay shut otherwise, so you can never drive out into the yard.

### 8.2 The loop

- **Incoming trucks:**
  - A neutral grey truck rolls in, eases to a stop, **honks once** and opens. It carries a small grid of short stacks.
  - Once its trailer is empty and nobody is in its doorway, it closes up and drives off.
  - A truck kept waiting a long time starts honking every so often, a little longer each time. This is gentle, rising social pressure with no penalty.
- **Outbound trucks:**
  - When every slot is full and all trucks are well clear, an outbound truck **honks twice**, closes its gate and leaves.
  - Its load plus a **bonus** is banked.
  - A replacement soon backs in.
  - If anyone comes close while the gate is closing, it reopens. Departure must never trap the player.
- **Mess grows:** early loads are often single-colour stacks, but the chance of mixed-colour stacks rises steadily with time. After a while nearly every stack needs sorting, which turns the job from carrying into restacking, and the lanes become essential.
- **Adaptive pacing:**
  - The game measures how fast the crew actually unloads (a decaying average over recent busy time, seeded from a sensible prior scaled by player count).
  - The gap until the next truck is "the time you'd need to unload this one", times a margin, with a little randomness, clamped between sensible bounds.
  - The margin slowly tightens while bays are free and relaxes when the queue is nearly full.
  - The goal is that the queue **hovers near full** instead of following a fixed timer.
- **Game over:** a new truck is due and **every incoming bay is still occupied**. Players can also end a run from the menu. The live score includes completed stacks in unfinished outbound trucks, so a run never feels wasted.

---

## 9. Cameras and Views

### 9.1 Overview (default)

- A near-top-down, slightly tilted 3D view, so walls and stack sides show. Walls are **cut low** so you can see over them.
- On maps too large to fit, the camera **follows the truck** and stops at the map edges.
- **Rotate keys or a drag** swing the view a quarter turn around the view centre with a quick spring, and it stays turned. Free dragging also tilts.
- **Driving springs the view back** to the nearest quarter turn and the default tilt.

### 9.2 Chase camera

- A third-person camera raised behind the truck, always looking at the middle of the tines, aimed a little higher when the forks are up.
- It's **lazy**: it hangs in place and only moves when the truck gets too far away or too close, then pitches and yaws to keep the truck centred. Reversing causes no sudden swing.
- While moving it slowly drifts round behind the truck. After sustained reversing it swaps to the front, with a short delay so shuffling back and forth doesn't make it flip.
- It zooms out slightly with speed.
- If a wall hides most of the truck, it **rises towards top-down**: quickly up, slowly back down.
- Rotate keys swing it 45° around the truck. It stays where you leave it, and its tilt eases back to default while moving.
- Switching between overview and chase is a smooth swoop.

### 9.3 Cabin (first-person) view

- A wide-angle view from the driver's seat that always faces forward, even in reverse.
- The view **pitches to look at the fork tips**, tilting up as the forks rise. The head leans slightly into turns.
- Look keys or a drag turn the head, and driving springs it back.
- The overhead guard is drawn as a see-through frame. An optional "bare forks" mode hides everything but the carriage and tines.
- Two small **mirror windows** sit at the top centre: a top-down view behind the truck on the left and in front of it on the right. Each has a thick frame and a label.
- A **minimap** sits in a corner.
- The ceiling is visible only here: beams, glowing light bars and still fans.

### 9.4 Minimap

- Shows the floor, walls, zones (faded until done), the parking spot, stacks as dots in their top colour, and trucks as arrowheads in their paint colour.
- **Zones that accept what you're carrying flash** in two high-contrast colours. Mixed loads and full zones don't flash.
- The visible area is outlined: a rectangle, or the tilted footprint in the chase camera.

### 9.5 Compass

A small needle under the fork gauge, shown only when north isn't straight up. It always shows in the chase camera.

---

## 10. HUD and Feedback

- **Status panel (top left):** level, zones done, score out of max and time; a damage line split into repairable and permanent damage; a placement-penalty line; your best and the global best; a hint when parking unlocks. In full screen the panel **slides down for a couple of seconds** when something changes, then hides again.
- **Fork gauge (top right):** a vertical ladder of cells, one per fork level, labelled "FORKS", tinted in your truck's colour.
  - The current fork level is outlined, with a pointer tab.
  - Carried boxes fill cells in their colours; the stack in front of your tines shows faded.
  - Open-top boxes show a no-entry mark.
  - After inspection, damaged boxes show a "!" triangle and crooked boxes a tilted diamond.
  - In local co-op each truck gets its own gauge.
- **Stack readability in 2D:** a stack shows its top box in colour, and the boxes below it as small coloured numbers by layer.
- **Popups:** bold text with heavy outlines that drifts up and fades.
  - Red damage.
  - Green or red score.
  - Amber or green wonkiness.
  - Inspector verdicts.
- **Horn label:** a bobbing **"HONK"** in the truck's colour that grows extra O's the longer you hold, up to a starred mega-honk. Off-screen honks are pinned to the screen edge.
- **Start board:** at level start, a panel with the level number and the local and global top lists. It disappears when the truck moves, the screen is tapped, or after a few seconds. In endless mode it explains the rules.
- **Proximity alert:** whenever you're carrying boxes and not in Reverse, the game sweeps the path your load will take over the next moment along your current steering arc, plus a short probe ahead of the tines. If it would hit a stack at an overlapping height, **the headlights flash red** with a fast double beep. This is a gentle "you're about to crash" warning.

---

## 11. Visual Style

### 11.1 Overall

**Toy-like, low-poly industrial cartoon.** Flat-shaded blocks, bold saturated colours, yellow-and-black hazard trim everywhere, no textures. Detail comes from many small painted shapes (decals). There should be a 2D fallback renderer that fakes height with a parallax offset and keeps the same palette.

### 11.2 Palette

- **Boxes:** red, blue, green, yellow and purple, plus grey for wide boxes and a dark slate for oil barrels.
- **Player trucks:** yellow by default, with red, blue and green for other players. Each has a darker roof and counterweight, and a very dark tint behind its fork gauge.
- **Light theme:** pale warm grey around a beige concrete floor, near-black walls in 2D, and a soft sky gradient in first-person.
- **Dark theme:** charcoal, a dark floor, light walls in 2D. Real lights come on.
- The theme follows the system setting by default, with a manual override.

### 11.3 Environment

- **Walls:** tall grey panels with a subtle alternating tint.
- **Doorways:** hazard-striped jambs topped by amber beacons, a striped header with a lamp, hazard thresholds on the floor and a dashed yellow centre lane.
- **Floor:** a faint tile grid.
- **Charger:** a red, knee-high block with high-voltage warning signs.
- **Parking spot:** a grey outlined rectangle with a big "P" that turns green when unlocked.

### 11.4 The forklift model

Chunky and readable:
- a coloured chassis with a raised dark counterweight;
- a seat and backrest;
- four slim posts holding a roof, with a tiny direction arrow on top;
- a grey mast whose inner section **extends as the forks rise**;
- a carriage with a backrest grid, lift chains and a cylinder;
- light-grey tines;
- big front drive wheels and smaller rear wheels that **visibly steer and roll**.

### 11.5 Decals (cosmetic, can be toggled off, the same every time for a given level)

- **Floor:** tyre tracks curving naturally into zones and around wall ends, oil stains, grates, dashed lines, hazard patches and yellow bay outlines.
- **Walls (sprinkled sparsely):** windows, doors, exit signs, extinguishers, speed limits, toilet doors, PPE notices, posters, a stray deer, AC units. Plus yellow or chevron stripes along wall bases.
- **Box lids:** labels as described in 3.1.

### 11.6 Lights

- **Light mode:** a flickering blue reverse-warning disc on the floor behind the truck. Walls cut it off, and it climbs up a wall when close.
- **Dark mode:**
  - Warm cone headlights.
  - Dim red tail glow, bright red when braking, white when reversing.
  - Glowing lamp housings.
- **Optional disco lights (dark mode only):** mirror balls hanging from the ceiling cast orbiting, hue-cycling pools of coloured light across the floor. One invisible ball rides along with the truck.

### 11.7 Particles

- **Sparks** on bonks and scrapes: streaky orange-to-white embers that bounce on the floor, plus a brief flash.
- **Tyre smoke** when wheels spin.
- **Damage:** grey smoke plus brown cardboard chips.
- **Set-down dust:** a small beige ring when a stack is put down outside a zone.
- **Confetti** in the zone's colour when a zone completes.
- **Player joins and leaves:** a big comic **pop**, with a smoke cloud, a ring, sparks, confetti and stars, while the truck scales in or out.
- **Honk:** stacks within a short radius do a quick **hop**. Their boxes shift and turn a tiny bit for real, never enough to topple anything. Boxes on any nearby truck's forks wiggle too.

---

## 12. Audio

Every sound effect is **synthesized live** from simple tones and filtered noise. Effects are short, soft, slightly comic and never harsh. Give separate volume controls for master, music, engine, beeps and other effects.

### 12.1 Sound effects

- **Electric motor:** a low, soft hum that rises in pitch and brightens with speed. A touch of throttle adds a hint of rise even before the truck moves. Each truck is pitched slightly differently.
- **Reverse beeper:** a polite, pure, slow on-off beep while in Reverse.
- **Proximity alert:** a fast, high double bip.
- **Horn:** a nasal, toy-car two-tone meep that lasts as long as the button is held. Each truck has its own pitch. Delivery lorries have a lower, gruffer horn.
- **Fork motor:** a short hydraulic whirr that sweeps up when raising and down when lowering, with a hiss of fluid under it.
- **Blocked:** a short descending buzz.
- **Bonk:** a dull cartoon thud that gets louder the harder the hit.
- **Scrape:** gritty noise whose level and pitch rise with sliding speed.
- **Tyre squeal:** a thin, wobbling screech.
- **Box damage:** a splintering crack followed by a few falling woody clicks.
- **Zone complete:** a bright four-note rising chime. The **wonky version** is detuned, unevenly timed and sags as it rings.
- **Pop:** a cartoon zip-up blip with a puff.
- **Droid babble:** see 7.5.

When paused, all effects stop but the music carries on.

### 12.2 Music

- **Public-domain or freely licensed MIDI tunes** played through a tiny built-in synth, so it sounds like a charming toy band.
- **Polka** is the signature style, alongside country, classical pieces, metal, rock, synthwave and dance. Give the tracks warehouse-pun titles.
- By default a new random song plays after each one ends. Players can also pick a single track to loop.
- Keep the mix light: a little compression and a short dark echo, sitting under the effects.

---

## 13. Controls

### 13.1 Keyboard

There are two schemes, chosen on first launch in a "Choose your controls" picker:
1. **Arrows** to drive and steer, with one pair of nearby letter keys for forks up and down.
2. **WASD** to drive and steer, with the neighbouring keys for the forks. The arrows then do nothing.

Shared keys:
- swap overview / first-person;
- toggle chase camera;
- **hold** to honk;
- full screen;
- menu (two keys, one of them not Escape, because Escape leaves full screen);
- next level;
- rotate the camera left and right.

Never capture browser shortcuts that use modifier keys.

### 13.2 Gamepad

- **Triggers act as pedals:** right is throttle, left is brake/reverse, both analog. The left stick steers, with a small dead zone rescaled so steering starts gently from zero.
- Face buttons and shoulders raise and lower the forks (hold lower for a full drop). Other buttons honk and swap views; clicking the right stick toggles the chase camera; the right stick looks around. Start opens the menu, or starts the game on the splash.
- The whole menu is navigable with the pad.

### 13.3 Touch

Three layouts:
- **Classic:** big steer buttons on the left; a 2×2 pad on the right with fork up/down above and drive back/forward below.
- **Rotated:** the same, with the right-hand columns swapped.
- **Joystick:** a **square virtual stick** (each axis reaches full on its own) with a small dead zone and coarse steps, and fork buttons on the other side. Letting go brakes.

Touch gestures:
- Fingers can slide between buttons.
- Drag the view to orbit; double-tap for the chase camera.
- Hold two fingers to honk.
- Tap the results board to continue.
- First-person isn't offered on touch, except as a hidden easter egg: tap the minimap in landscape.
- Battery-saver options (lower resolution, capped frame rate, fewer effects) default to on for touch.

### 13.4 Mouse

Drag to orbit, double-click for the chase camera, and an on-screen zoom slider that hands focus back to driving after use.

---

## 14. Game Flow and Onboarding

1. **Splash screen:** the title, the tagline, a looping attract scene (see below), Start and Start Endless buttons, Tutorial and Hard Mode toggles, name entry, Host Game / Join Game, a short story blurb and "Press Enter to start". The splash is silent.
2. **Control picker** on first visit only.
3. **Tutorial banner**, shown on first play. Short steps, each disappearing **as soon as you've done it** (even if you did it early), but each staying up for a minimum moment:
   1. Drive and steer, with the tail-swing warning and "let go to brake".
   2. Forks, and lifting a stack.
   3. Put a stack on its matching zone, then park.
   4. First-person view (left out on touch).
   5. Extras (honk, cameras) and a pointer to the menu's info page.

   The text always shows the player's actual keys. The tutorial can be restarted from the menu.
4. **One-off event tips**, shown once per device and briefly replacing the banner:
   - first open-top box;
   - first ceiling hit;
   - first refused fork-down;
   - first damaged barrel ("…a cleaning bot has been dispatched");
   - the repair hint.
5. **Start board → play → parking unlock → results → next level.**

### 14.1 Attract scene

On the splash, a scripted forklift endlessly shuffles stacks around a ring in a small room. It moves the stack next to the one empty spot into that spot, with smooth curved paths and real fork lifts. The camera cycles between slow orbits and chase shots with quick fades through black. The 2D fallback is a cartoon forklift drifting a figure-eight that leaves skid marks and smoke puffs.

### 14.2 Pause menu

- **Main page:** Resume, Restart level, Mute all, and the sub-pages below.
- **Sub-pages:**
  - *Play:* hard mode, endless, go to level, first unplayed level, tutorial.
  - *Sound*
  - *Graphics:* theme, decals, 3D on/off, battery saver, disco, bare forks.
  - *Camera:* chase, zoom, auto full screen.
  - *Controls:* layout pictures, gamepad diagram.
  - *Multiplayer*
  - *Scores & saves*
  - *Info & scoring*
  - A link to report a bug.

Losing focus **pauses and opens the menu**, except during online play.

### 14.3 Saving

- Save **quietly at natural checkpoints**: when a level starts, and whenever the menu opens. That includes when focus is lost. Reloading puts you back at the last checkpoint.
- Endless runs save separately and are cleared on game over.
- An export/import text box lets players share or restore a state.
- The current level number and all settings are remembered.

---

## 15. Multiplayer

### 15.1 Shared rules

- Up to **four trucks**, co-op, **one shared score**. Each truck has its own paint colour and horn pitch.
- Trucks that start inside each other at the parking spot are translucent **ghosts** to each other until they drive apart. Stacks overlapping a newly spawned truck are ghosts to it until it's clear.
- **Handoffs:**
  - Raise your empty tines under another truck's carried load to take it.
  - With your tines partway up the load, take only the boxes from that level up.
  - Lower your load onto another truck's tines to give it away, or onto the load it's already carrying.
- **Lifting trucks:**
  - With the tines at floor level, drive under another truck's **side** at roughly right angles and lift. It rides sideways on your tines and can't drive or use its forks.
  - Set it on top of a stack and it stays **perched** there until someone lifts it off.
  - The lifted truck's first-person view rides up with it.
- A leaving player's carried boxes are put down in front of their truck so the level stays solvable.

### 15.2 Local co-op

- The keyboard player is truck one. Gamepads join mid-game with a button press, and unplugging a pad removes its truck. Joined players keep their truck and colour across levels.
- The overview camera **frames every truck**.
- Each player can open their own first-person view, and the screen splits:
  - one cab: halves;
  - two cabs: overview on top, two cabs below;
  - three cabs: quadrants with the overview in one;
  - four cabs: four cab quadrants with a translucent minimap in the middle.

  Each tile is framed in its player's colour.

### 15.3 Online party

- The host gets a **short party code** to share. Friends enter it to join, and the host presses Start. Late joiners drop straight into play.
- The host controls levels, restarts and endless mode.
- A small badge shows the code and each player's colour and name.
- On the host's multiplayer page, each player's ping is shown, with **Kick** and **Ban** buttons.
- Your own truck must respond **instantly** regardless of latency, and other trucks should look smooth.
- Co-op leaderboards are kept separate by player count.

---

## 16. Scores and Seeds

- **Local** and **online** top lists for each level and seed. A best score is shown in the HUD.
- A name is asked only when you set a personal best. The same player name is used everywhere.
- Failed online submissions are kept and retried later.
- An option downloads your online scores into this browser.
- Seeds come only from the page address, for tournaments and sharing. There is no seed field in the game.

---

## 17. Build Order

1. **The truck:** rear-steer kinematics, speed-sensitive lock, engine braking, gears, a top-down view. Iterate until driving circles is fun.
2. **Collisions:** walls and boxes, push, spin, nudge-to-square, bonk and scrape.
3. **Forks:** whole levels, partial-stack lifting, put-down and merge, refusals, the ceiling, hold-to-drop, top-heaviness.
4. **Zones, scoring, parking and winning:** the core loop is now complete.
5. **Level generator:** with reachability validation and difficulty progression.
6. **Audio pass:** motor hum, beeper, fork whirr, bonk, chime, horn. The game comes alive here.
7. **HUD:** fork gauge, popups, minimap, start board, results.
8. **3D overview and first-person view** with mirror windows, then the chase camera.
9. **Toppling, crooked towers, damage dents.**
10. **Special boxes:** open-top, then wide, then barrels and oil.
11. **Bots, photos and the repair station.**
12. **Tutorial, event tips, control picker, touch and gamepad.**
13. **Endless mode.**
14. **Local co-op, then online party.**
15. **Polish:** decals, particles, disco, themes, attract scene, music.

---

## 18. Feel Checklist

Before calling it done, check that:

- [ ] Reversing into the parking spot takes two or three attempts for a new player and one smooth arc for an expert.
- [ ] Clipping a doorway with the tail is a common, funny mistake.
- [ ] Lifting just the top two boxes off a stack of four feels precise and deliberate.
- [ ] A crooked tower can be built and stays crooked; nudging it slowly straightens it.
- [ ] Driving fast with raised forks feels risky and sluggish.
- [ ] Letting go of the throttle stops you without drama.
- [ ] Honking near a stack makes everyone laugh, and never knocks anything over.
- [ ] The cleaning bot running away from you is endearing.
- [ ] A "COULD BE BETTER" photo makes the player want to go back and fix it.
- [ ] Endless mode's bays hover near full, and losing feels like your own fault.
- [ ] Every sound is soft enough to listen to for an hour.
