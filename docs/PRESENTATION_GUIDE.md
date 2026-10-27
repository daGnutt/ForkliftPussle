# Presentation guide (for agents)

`docs/presentation.html` is a self-contained slide deck (no build, no dependencies) telling the development timeline of the game. Screenshots live in `docs/shots/`. Navigate with ←/→/Space, Home/End, `F` for full screen; `#N` in the URL opens slide N.

## Structure
- Each slide is a `<section class="slide">`. Timeline slides have a `.date` line (day · date), an `<h2>`, then `<div class="row"><ul>…</ul><figure><img src="shots/NN-name.png"><figcaption>…</figcaption></figure></div>`.
- Slides: title, idea & stack, one or more per day of development, "where it ended up", timeline at a glance, thank you.
- Keep stats current: commit count (`git rev-list --count HEAD`), JS lines (`wc -l js/*.js`), number of days, and the per-day bar in "Timeline at a glance". The "Commits per day" slide embeds a `perDay` object in the script (lines changed per commit, per day, from `git log --date=short --pretty='C %ad' --numstat`; binary files count as 0); refresh it when adding commits.

## Regenerating / updating
1. Read the history: `git log --reverse --date=short --pretty='%ad %h %s'`. Group commits by day and theme; for an update, only add what is new since the last slide (check the last date/commit mentioned).
2. Add or edit slides: 4–6 short bullets each, user-visible features first. Add a new slide per day or major theme; update the "at a glance" slide and the title-slide stats.
3. Refresh screenshots only when the look changed noticeably (new view, major visual overhaul). Name them `NN-short-name.png`, caption with the commit hash. Replace the "latest" shots (`06-overview-latest`, `07-cabin-latest`) from HEAD.
4. Check the result renders (see below) and commit on its own branch.

## Taking screenshots of old commits (Firefox headless)
Firefox is the only browser installed; `firefox --headless --screenshot` fires at the load event, so the game must be driven *before* load finishes.
- Check out each commit in a temporary worktree: `git worktree add --detach /tmp/wt/<hash> <hash>` (remove with `git worktree remove --force` afterwards).
- Use a fresh profile each run, otherwise it reports "already running": `firefox --headless --no-remote --profile /tmp/ffp --screenshot out.png --window-size=1280,800 URL`.
- Small throwaway Python server (in `/tmp`, not in the repo) serving `/tmp/wt/<hash>/…` plus a `/wrap?c=<hash>&seq=<json>&ms=<n>` page that embeds the game in a full-size iframe, then plays a key sequence by dispatching `KeyboardEvent`s (with `code`) on the iframe window: `tap`/`down`/`up` of a code, `wait` ms. It then ends with `<script src="/delay.js?ms=N">`, an endpoint that sleeps N ms, which holds the load event so the screenshot happens after the sequence.
- Typical sequence: tap `Space` (dismiss splash), hold `ArrowUp` ~1.5 s, hold `ArrowRight` ~0.7 s, release. Swap to the cabin view with `KeyM` (older commits: `KeyF`; `Tab` does not work with synthetic events because it requires `target === body`). Set N a bit above the total sequence time.
- Splash screen/menu keys and the tutorial popup change between commits; look at the screenshot and adjust. Old commits with no scoring HUD or splash need no `Space`.
- Kill helper servers (by PID) and delete `/tmp` files when done.

## Keeping it up to date
After a merge to `main` that adds a notable feature or visual change, extend the presentation (new bullets/slide, stats, possibly a new screenshot) in the same merge flow, following the repo branch rules. Skip it for small fixes and refactors.
