// Local multiplayer: every connected gamepad can join the running game as its own truck (the keyboard drives truck 0).
// Y toggles that truck's cabin view (onCab(slot)). A pad joins by pressing A; its truck is removed when the pad is unplugged. Drive/steer/horn/forks use the same mapping as input.js.
import { addTruck, removeTruck, truckView, forkUp, forkDown } from './game.js';
import { standardPads, padAxes } from './gamepad.js';

const MAX_LOCAL_PADS = 3;

export function createLocal(onCab = null) {
  const players = new Map(); // gamepad index -> { slot, prev: boolean[] }
  const seen = new Map(); // gamepad index -> previous button states of pads that have not joined yet
  const pressed = (gp) => gp.buttons.map((b) => b.pressed);

  return {
    get players() { return players.size; },
    // Slots of the joined pads, in join order.
    slots() { return [...players.values()].map((p) => p.slot); },
    beginVote() {
      const pads = new Map(standardPads().map(({ index, gp }) => [index, gp]));
      for (const [index, p] of players) p.votePrev = pressed(pads.get(index) || { buttons: [] });
    },
    pollVote(g, acceptBallots = true) {
      const pads = new Map(standardPads().map(({ index, gp }) => [index, gp]));
      const ballots = [], left = [];
      for (const [index, p] of players) {
        const gp = pads.get(index);
        if (!gp) {
          left.push(p.slot);
          removeTruck(g, p.slot);
          players.delete(index);
          continue;
        }
        const cur = pressed(gp), prev = p.votePrev || cur;
        if (acceptBallots && cur[0] && !prev[0]) ballots.push({ slot: p.slot, choice: 'yes' });
        else if (acceptBallots && cur[1] && !prev[1]) ballots.push({ slot: p.slot, choice: 'no' });
        p.votePrev = cur;
        if (acceptBallots) p.prev = cur;
      }
      return { ballots, left };
    },
    remove(g, slot) {
      for (const [index, p] of players) if (p.slot === slot) {
        const gp = standardPads().find((pad) => pad.index === index)?.gp;
        if (gp) seen.set(index, pressed(gp));
        players.delete(index);
        removeTruck(g, slot);
        return true;
      }
      return false;
    },
    // Called every frame while the game runs: joins, leaves, sets each local truck's input and fires fork actions.
    step(g, now) {
      const pads = standardPads();
      const live = new Set(pads.map((p) => p.index));
      for (const [index, p] of players) if (!live.has(index)) { removeTruck(g, p.slot); players.delete(index); }
      for (const { index, gp } of pads) {
        const cur = pressed(gp);
        let p = players.get(index);
        if (!p) {
          const was = seen.get(index) ?? [];
          seen.set(index, cur);
          if (!cur[0] || was[0] || players.size >= MAX_LOCAL_PADS) continue;
          const slot = addTruck(g, `Pad ${index + 1}`);
          if (slot < 0) continue;
          p = { slot, prev: cur };
          players.set(index, p);
          continue;
        }
        const t = g.trucks[p.slot];
        const edge = (i) => cur[i] && !p.prev[i];
        if (t && !t.gone) {
          const { thr, str } = padAxes(gp);
          t.input = { thr, str, up: thr > 0, down: thr < 0, left: str < 0, right: str > 0, horn: cur[2], forkUp: !!(cur[0] || cur[5]), forkDown: !!(cur[1] || cur[4]) };
          const v = truckView(g, p.slot);
          if (edge(3)) onCab?.(p.slot);
          if (!g.hard) { // hard mode reads the held buttons in update()
            if (edge(0) || edge(5)) forkUp(v);
            if (edge(1) || edge(4)) forkDown(v);
          }
        }
        p.prev = cur;
      }
    },
    // A new game replaced the old one: every joined pad gets a truck in its old slot again.
    levelLoaded(g) { for (const p of players.values()) addTruck(g, `Pad ${p.slot + 1}`, p.slot); },
    // Removes all local players (the option was switched off).
    clear(g) { for (const p of players.values()) removeTruck(g, p.slot); players.clear(); seen.clear(); },
  };
}
