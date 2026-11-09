# Presentation guide (for agents)

`docs/presentation.html` is a self-contained slide deck (no build, no dependencies) telling the development timeline of the game. Screenshots live in `docs/shots/`. Navigate with ←/→/Space, Home/End, `F` for full screen; `#N` in the URL opens slide N.

## Structure
- Each slide is a `<section class="slide">`. Timeline slides have a `.date` line (day · date), an `<h2>`, then `<div class="row"><ul>…</ul><figure><img src="shots/NN-name.png"><figcaption>…</figcaption></figure></div>`.
- Slides: title, idea & stack, one or more per day of development, "where it ended up", timeline at a glance, thank you.
- Keep stats current: commit count (`git rev-list --count HEAD`), JS lines (`wc -l js/*.js`), number of days, and the per-day bar in "Timeline at a glance". The "Commits per day" slide embeds a `perDay` object in the script (lines changed per commit, per day, from `git log --date=short --pretty='C %ad' --numstat`; binary files count as 0); refresh it when adding commits.
- Slogan poster slides ("Wall posters · n / 3"): the script holds a copy of `FONT` and `SLOGANS` from `js/pov/face.js` (colours as Y/K/W) and draws each poster to a canvas; when slogans change, refresh that copy and the `data-from`/`data-to` ranges of the three slides.

## Regenerating / updating
1. Read the history: `git log --reverse --date=short --pretty='%ad %h %s'`. Group commits by day and theme; for an update, only add what is new since the last slide (check the last date/commit mentioned).
2. Add or edit slides: 4–6 short bullets each, user-visible features first. Add a new slide per day or major theme; update the "at a glance" slide and the title-slide stats.
3. Refresh screenshots only when the look changed noticeably (new view, major visual overhaul). Name them `NN-short-name.png`, caption with the commit hash. Replace the "latest" shots (`06-overview-latest`, `07-cabin-latest`, `17-splash-latest`) from HEAD, taken in **dark mode with disco lights off** (disco only for the disco slide, `14-cabin-disco`). Other current shots: `12-chase-camera`, `13-menu-visuals`, `15/16-touch-joystick-*` (Playwright `isMobile`/`hasTouch`, 844×390 and 390×844; drive with keyboard events to dismiss the level-start overlay).
4. Check the result renders (see below) and commit on its own branch.

## Taking screenshots of old commits (Firefox headless)
Headless Firefox only renders the 2D fallback; fine for old (pre-WebGL) commits, use the Chromium recipe below for HEAD.
Firefox is the only browser installed; `firefox --headless --screenshot` fires at the load event, so the game must be driven *before* load finishes.
- Check out each commit in a temporary worktree: `git worktree add --detach /tmp/wt/<hash> <hash>` (remove with `git worktree remove --force` afterwards).
- Use a fresh profile each run, otherwise it reports "already running": `firefox --headless --no-remote --profile /tmp/ffp --screenshot out.png --window-size=1280,800 URL`.
- Small throwaway Python server (in `/tmp`, not in the repo) serving `/tmp/wt/<hash>/…` plus a `/wrap?c=<hash>&seq=<json>&ms=<n>` page that embeds the game in a full-size iframe, then plays a key sequence by dispatching `KeyboardEvent`s (with `code`) on the iframe window: `tap`/`down`/`up` of a code, `wait` ms. It then ends with `<script src="/delay.js?ms=N">`, an endpoint that sleeps N ms, which holds the load event so the screenshot happens after the sequence.
- Typical sequence: tap `Space` (dismiss splash), hold `ArrowUp` ~1.5 s, hold `ArrowRight` ~0.7 s, release. Swap to the cabin view with `KeyM` (older commits: `KeyF`; `Tab` does not work with synthetic events because it requires `target === body`). Set N a bit above the total sequence time.
- Splash screen/menu keys and the tutorial popup change between commits; look at the screenshot and adjust. Old commits with no scoring HUD or splash need no `Space`.
- Kill helper servers (by PID) and delete `/tmp` files when done.

## Taking screenshots of current commits with WebGL (Chromium via Playwright)
Headless Firefox (snap) has **no WebGL** (`getContext('webgl2')` is null, even with `webgl.force-enabled`), so it only shows the 2D fallback renderer. For anything since the WebGL2 renderer (overview, chase camera, cabin view, dark-mode lights, doorway beacons) use Chromium with software GL (SwiftShader). Everything lives in `/tmp`, nothing goes in the repo.
1. Install (no root, no build step in the repo): `mkdir /tmp/shotrig && cd /tmp/shotrig && npm init -y && npm i playwright && npx playwright install chromium`.
2. If Chromium fails with `libasound.so.2: cannot open shared object file`, fetch it without sudo: `mkdir libs && cd libs && apt-get download libasound2t64 && dpkg -x *.deb .`, then `export LD_LIBRARY_PATH=/tmp/shotrig/libs/usr/lib/x86_64-linux-gnu` before running node.
3. Serve the repo root (or a `git worktree` of another commit) statically: `python3 -m http.server 8765` (run from that directory; kill it by PID afterwards).
4. Script (`pw.mjs`, ES module): launch with `args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']`, new context with `viewport: {width:1280,height:800}`, `colorScheme: 'dark'`, and `ctx.addInitScript` that sets the `localStorage` keys below; `page.goto('http://127.0.0.1:8765/index.html?skip')` (`?skip` bypasses splash and tutorial); wait ~1.5 s; drive with `page.keyboard.down/up/press` (`ArrowUp`, `ArrowRight`, `KeyA`, `KeyM`, `KeyC`, `Escape`, …) and `page.waitForTimeout`; finally `page.screenshot({path})`. Real keyboard events work, so `Tab` and the rest of the keys need no tricks.
5. Useful `localStorage` keys: `forklift-theme` = `dark`/`light`, `forklift-disco` = `1` (disco lights, dark mode only), `forklift-level` = `N` (level 3+ has doorways), `forklift-cab-view` = `1` (start in cabin view), `forklift-chase-cam` = `1` (chase camera), `forklift-bare-forks` = `1`, `forklift-tutorial-done` = `1`. Other settings live in the menu (`Escape`); URL parameters are listed in `README.md`.
6. Prefer **dark mode** for new screenshots. The `TESTING` banner shows on localhost; that is fine. Look at each screenshot and adjust the key sequence/timing (SwiftShader is slow, so keep the simulated time short and add a small wait before the shot).

## Keeping it up to date
After a merge to `main` that adds a notable feature or visual change, extend the presentation (new bullets/slide, stats, possibly a new screenshot) in the same merge flow, following the repo branch rules. Skip it for small fixes and refactors.

## Devlog (`docs/devlog.html`)
A scrolling, self-contained page (no JS) with one `<article>` per milestone (feature or visual change; pure bugfixes skipped), grouped in `<section class="day" id="dYYYY-MM-DD">` per day. Each article has `<div class="shots"><img src="devlog/NN-name.webp"></div>` plus a `.txt` block (`<h3>`, `<p>`, `<code>` commit hash). Assets are animated/still WebP in `docs/devlog/`, named `NN-name[-anim].webp`. Add an entry for each notable feature merged to `main` (skip small fixes); keep the nav links and the milestone count in the header in sync.

Capturing (everything in `/tmp`, not the repo):
- Chromium via Playwright (see above) works for **all** commits, old 2D ones too: serve a directory of `git worktree add --detach /tmp/wt/<hash> <hash>` checkouts and open `/<hash>/index.html`. Add `--disable-accelerated-2d-canvas` to the launch args, otherwise `page.screenshot` hangs on pages with a busy 2D canvas.
- Old commits: set `forklift-tutorial-done=1` in `localStorage`, press `Enter` on the splash (no `?skip` before 0322845), swap view with `F` (before f470fef) or `M`; hold `ArrowUp`/`ArrowRight` for the driving shot, and check that boxes are in view. Level `N` via `forklift-level`. Commit 804168c hangs after the splash (tutorial bug); use 8ffe630.
- Animations: do **not** use Playwright's `record_video_dir` (low-bitrate VP8, blocky once converted). Open a CDP session (`ctx.new_cdp_session(page)`), `Page.startScreencast` with `format: 'png'` after the page has booted, ack each `Page.screencastFrame`, save frames with their `metadata.timestamp` (sort by it), and encode with the concat demuxer (`file`/`duration` lines): `ffmpeg -f concat -i list.txt -vf fps=15,scale=800:-2:flags=lanczos -loop 0 -quality 78 -compression_level 5 out.webp`. This gives ~20 fps lossless frames even with SwiftShader. Keep each animation to ~3-8 s and under ~1 MB. Stills: `ffmpeg -i still.png -quality 82 out.webp`.
