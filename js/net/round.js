// Readiness is per connection; score participants use a guest's session ID when available.
export function createRound() {
  let serial = 0, round = null;
  const participants = new Map(), connected = new Map();
  function shorten(now) {
    if (round && [...round.eligible].every((peer) => round.ready.has(peer))) {
      round.deadline = Math.min(round.deadline, now + 3);
    }
  }
  return {
    join(peer, name, playing = true, playerId = peer) {
      connected.set(peer, { name, playerId });
      if (!round && playing) participants.set(playerId, name);
    },
    begin() { if (!round) for (const { name, playerId } of connected.values()) participants.set(playerId, name); },
    leave(peer, now) {
      connected.delete(peer);
      if (round && round.eligible.delete(peer)) shorten(now);
    },
    start(now) {
      if (round) return;
      round = { id: ++serial, deadline: now + 10, eligible: new Set(connected.keys()), ready: new Set() };
      shorten(now);
    },
    ready(peer, id, now) {
      if (!round || round.id !== id || !round.eligible.has(peer) || round.ready.has(peer)) return false;
      round.ready.add(peer);
      shorten(now);
      return true;
    },
    state(peer, now) {
      return round && { id: round.id, remaining: Math.max(0, round.deadline - now), eligible: round.eligible.has(peer), ready: round.ready.has(peer) };
    },
    players() { return [...participants.values()]; },
    reset(members, playing = true) {
      round = null;
      participants.clear();
      connected.clear();
      for (const [peer, name, playerId = peer] of members) {
        connected.set(peer, { name, playerId });
        if (playing) participants.set(playerId, name);
      }
    },
  };
}
