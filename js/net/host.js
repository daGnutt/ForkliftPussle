// The host side of a party: owns the relay party, one WebRTC link per guest and the guests' trucks in the running game.
import { addTruck, removeTruck, truckView, forkUp, forkDown } from '../game.js';
import { createLink } from './peer.js';
import { createSnapshotter, snapshot, encode, photoId, SNAPSHOT_HZ } from './protocol.js';
import { HARD_PHYSICS_VERSION } from '../hard-physics.js';
import { createRound } from './round.js';
import { createVote } from './vote.js';

const STALE = 3; // seconds without any message before a guest counts as gone when its name is taken again
const KICK_COOLDOWN = 60;
const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

// `getGame()` returns the current game (it is replaced on every level load); `levelInfo()` its { level, seed, hard, seedText, endless };
// `isStarted()` tells whether the host has left the splash. `onChange()` fires when the player list changes.
export function createHost({ relay, getGame, levelInfo, isStarted, name, meta, onChange, onClosed, onRound, onVote, onVoteResult, linkFactory = createLink, clock = () => performance.now() / 1000 }) {
  const members = new Map(); // peer id -> { name, slot, link }
  const snapper = createSnapshotter();
  const banned = new Set(); // lower-case names; relay peer ids change on every join, so names are all there is to go on
  const kicked = new Map();
  const observer = meta?.observer === true;
  const round = createRound();
  const vote = createVote();
  let votingEnabled = true;
  let code = null, token = null, stream = null, lastSent = -Infinity, lastPing = -Infinity, closed = false;
  let lastVoteSent = -Infinity;
  let lastVoteResolved = 0;

  const payload = (g) => ({ ...levelInfo(), observer, hardPhysicsVersion: HARD_PHYSICS_VERSION, snap: snapshot(g, true, false) });
  const live = (m) => m.slot >= 0 && m.link.open;
  function sendPhotoScenes(g, m) {
    const photos = g.inspector?.photos || {}, sent = m.photoScenes ||= new Map();
    for (const key of sent.keys()) if (!photos[key]) sent.delete(key);
    for (const [key, photo] of Object.entries(photos)) {
      if (!photo.scene) continue;
      const id = photoId(photo);
      if (sent.get(key) === id) continue;
      const text = JSON.stringify(photo.scene), size = 12000, count = Math.ceil(text.length / size);
      for (let i = 0; i < count; i++) m.link.sendReliable({ t: 'photoScene', key, id, i, count, data: text.slice(i * size, (i + 1) * size) });
      sent.set(key, id);
    }
  }
  function sendRound() {
    const now = clock();
    for (const [peer, m] of members) {
      const state = round.state(peer, now);
      if (live(m) && state) m.link.sendReliable({ t: 'round', ...state });
    }
    onRound?.(round.state(null, now));
  }

  function validVoteAction(action) {
    if (!action || typeof action !== 'object') return false;
    if (action.type === 'mode') return typeof action.hard === 'boolean';
    if (action.type === 'level') return Number.isSafeInteger(action.level) && action.level >= 1;
    if (action.type === 'endless') return true;
    if (action.type === 'kick') {
      return Number.isInteger(action.slot) && (observer || action.slot > 0) &&
        [...members.values()].some((m) => m.slot === action.slot && live(m));
    }
    return false;
  }

  function publishVote(force = true, now = clock()) {
    if (!force && now - lastVoteSent < 1) return;
    lastVoteSent = now;
    const localState = vote.state(now, observer ? null : 'host');
    onVote?.(localState, votingEnabled);
    for (const [peer, m] of members) {
      if (live(m)) m.link.sendReliable({ t: 'vote', enabled: votingEnabled, state: vote.state(now, peer) });
    }
  }

  function finishVote(now) {
    const state = vote.poll(now);
    if (!state || state.status === 'active' || state.id === lastVoteResolved) return;
    lastVoteResolved = state.id;
    if (state.status === 'passed' && validVoteAction(state.action)) onVoteResult?.(state.action);
    publishVote(true, now);
  }

  function startVote(action) {
    if (!votingEnabled || !validVoteAction(action)) return false;
    const voters = [...members].filter(([, m]) => live(m)).map(([peer]) => peer);
    if (!observer) voters.push('host');
    const state = vote.start(action, voters, clock());
    if (!state) return false;
    publishVote(true);
    return true;
  }

  function drop(peer) {
    const m = members.get(peer);
    if (!m) return;
    members.delete(peer);
    if (m.slot >= 0) removeTruck(getGame(), m.slot);
    const activeVote = vote.state(clock());
    if (activeVote?.status === 'active' && activeVote.action.type === 'kick' && activeVote.action.slot === m.slot) vote.cancel(clock());
    else vote.leave(peer, clock());
    finishVote(clock());
    round.leave(peer, clock());
    m.link.close();
    onChange?.();
    publishVote(true);
    if (observer && round.state(null, clock())) sendRound();
  }

  function onGuestMessage(peer, m, msg) {
    m.lastRx = clock();
    const g = getGame();
    if (msg.t === 'hello' && m.slot < 0) {
      m.name = String(msg.name || 'Player').trim().slice(0, 24) || 'Player';
      m.playerId = typeof msg.playerId === 'string' && msg.playerId.length > 0 && msg.playerId.length <= 64 ? msg.playerId : peer;
      m.hardPhysicsVersion = msg.hardPhysicsVersion;
      if (g.hard && m.hardPhysicsVersion !== HARD_PHYSICS_VERSION) {
        m.link.sendReliable({ t: 'bye', reason: 'physics' });
        setTimeout(() => drop(peer), 300);
        return;
      }
      const key = m.name.toLowerCase();
      const until = kicked.get(key);
      if (until !== undefined && until <= clock()) kicked.delete(key);
      const reason = banned.has(key) ? 'banned' : kicked.has(key) ? 'cooldown' : null;
      if (reason) { m.link.sendReliable({ t: 'bye', reason }); setTimeout(() => drop(peer), 300); return; }
      // a reloaded page rejoins before the host notices the old connection is dead: the stale one is replaced
      // (only silent ones: guests send inputs/pings at least every second, and two live players may share a name)
      for (const [p, o] of members) if (p !== peer && o.slot >= 0 && o.name?.toLowerCase() === m.name.toLowerCase() && clock() - o.lastRx > STALE) drop(p);
      const slot = addTruck(g, m.name);
      if (slot < 0) { m.link.sendReliable({ t: 'bye', reason: 'full' }); drop(peer); return; }
      m.slot = slot;
      m.link.sendReliable({ t: 'welcome', slot, started: isStarted(), ...payload(g) });
      sendPhotoScenes(g, m);
      if (observer) {
        round.join(peer, m.name, isStarted(), m.playerId);
        const state = round.state(peer, clock());
        if (state) m.link.sendReliable({ t: 'round', ...state });
      }
      onChange?.();
      publishVote(true);
    } else if (msg.t === 'gping') {
      m.link.sendReliable({ t: 'gpong', n: msg.n });
    } else if (msg.t === 'pong') {
      m.ping = Math.max(0, Math.round((clock() - msg.n) * 1000));
      onChange?.();
    } else if (msg.t === 'ready' && m.slot >= 0 && observer) {
      if (round.ready(peer, msg.id, clock())) sendRound();
    } else if (msg.t === 'voteCall' && m.slot >= 0) {
      startVote(msg.action);
    } else if (msg.t === 'voteCast' && m.slot >= 0) {
      if (vote.cast(msg.id, peer, msg.choice, clock())) {
        finishVote(clock());
        publishVote(true);
      }
    } else if (m.slot >= 0) {
      const t = g.trucks[m.slot];
      if (!t || t.gone) return;
      if (msg.t === 'in') t.input = { up: !!msg.up, down: !!msg.down, left: !!msg.left, right: !!msg.right, ...(Number.isFinite(msg.thr) && { thr: Math.max(-1, Math.min(1, msg.thr)) }), ...(Number.isFinite(msg.str) && { str: Math.max(-1, Math.min(1, msg.str)) }), ...(msg.brake === true && { brake: true }), horn: !!msg.horn, forkUp: !!msg.fu, forkDown: !!msg.fd };
      else if (msg.t === 'fork') (msg.dir === 'up' ? forkUp : forkDown)(truckView(g, m.slot));
    }
  }

  function onJoin({ peer, name: guestName }) {
    if (!peer || members.has(peer)) return;
    const m = { name: guestName, slot: -1, link: null, lastRx: clock() };
    members.set(peer, m);
    m.link = linkFactory({
      initiator: true,
      iceServers: DEFAULT_ICE,
      sendSignal: (s) => relay.signal(code, { from: 'host', to: peer, hostToken: token, ...s }).catch(() => {}),
      onMessage: (msg) => onGuestMessage(peer, m, msg),
      onClose: () => drop(peer),
    });
  }

  return {
    get code() { return code; },
    get token() { return token; },
    get closed() { return closed; },
    async start() {
      const r = await relay.createParty(name, meta);
      code = r.code; token = r.hostToken;
      stream = relay.events(code, 'host', token, {
        join: onJoin,
        leave: (d) => d && drop(d.peer),
        signal: (d) => d && members.get(d.from)?.link.signal(d),
      }, () => { if (!closed) { closed = true; onClosed?.('Lost the connection to the party server'); } });
      return code;
    },
    // Everyone in the party in slot order: [{ slot, name, ping }] (the host is slot 0; ping is the round trip in ms, null if unknown).
    players() {
      const g = getGame();
      const ping = (i) => [...members.values()].find((m) => m.slot === i)?.ping ?? null;
      return g.trucks.map((t, i) => (t.gone ? null : { slot: i, name: t.name || (!observer && i === 0 ? name : `Player ${i + 1}`), ping: !observer && i === 0 ? 0 : ping(i) })).filter(Boolean);
    },
    // Removes a guest's truck and sends it away; `ban` also refuses its name for the rest of the party.
    kick(slot, ban = false) {
      for (const [peer, m] of members) {
        if (m.slot !== slot || (!observer && slot <= 0)) continue;
        if (ban) banned.add(m.name.toLowerCase());
        else kicked.set(m.name.toLowerCase(), clock() + KICK_COOLDOWN);
        members.delete(peer);
        removeTruck(getGame(), slot);
        round.leave(peer, clock());
        const activeVote = vote.state(clock());
        if (activeVote?.status === 'active' && activeVote.action.type === 'kick' && activeVote.action.slot === slot) vote.cancel(clock());
        else vote.leave(peer, clock());
        finishVote(clock());
        m.link.sendReliable({ t: 'bye', reason: ban ? 'banned' : 'kicked' });
        setTimeout(() => m.link.close(), 300); // let the goodbye out first
        onChange?.();
        publishVote(true);
        if (observer && round.state(null, clock())) sendRound();
        return true;
      }
      return false;
    },
    get banned() { return [...banned]; },
    get guests() { return [...members.values()].filter(live).length; },
    startRound() {
      if (!observer || round.state(null, clock())) return;
      round.start(clock());
      sendRound();
    },
    roundState() { return round.state(null, clock()); },
    roundPlayers() { return round.players(); },
    get votingEnabled() { return votingEnabled; },
    setVotingEnabled(enabled) {
      votingEnabled = !!enabled;
      if (!votingEnabled) vote.clear();
      publishVote(true);
    },
    callVote(action) { return startVote(action); },
    castVote(id, choice) {
      if (!votingEnabled || !vote.cast(id, 'host', choice, clock())) return false;
      finishVote(clock());
      publishVote(true);
      return true;
    },
    voteState() { return vote.state(clock(), observer ? null : 'host'); },
    // After the host loaded a new level: every guest gets a new truck in its old slot and the new level.
    levelLoaded(g) {
      snapper.reset();
      for (const [peer, m] of members) {
        if (m.slot < 0) continue;
        if (g.hard && m.hardPhysicsVersion !== HARD_PHYSICS_VERSION) {
          m.link.sendReliable({ t: 'bye', reason: 'physics' });
          m.slot = -1;
          setTimeout(() => drop(peer), 300);
        } else m.slot = addTruck(g, m.name, m.slot);
      }
      for (const m of members.values()) if (live(m)) {
        m.photoScenes = new Map();
        m.link.sendReliable({ t: 'level', ...payload(g) });
        sendPhotoScenes(g, m);
      }
      if (observer) round.reset([...members].filter(([, m]) => live(m)).map(([peer, m]) => [peer, m.name, m.playerId]), isStarted());
    },
    // The host left the splash: waiting guests may start.
    started(g) {
      if (observer) round.begin();
      for (const m of members.values()) if (live(m)) {
        m.photoScenes = new Map();
        m.link.sendReliable({ t: 'level', ...payload(g) });
        sendPhotoScenes(g, m);
      }
    },
    // Called every frame; sends a snapshot to every guest at SNAPSHOT_HZ.
    broadcast(g, now = clock()) {
      finishVote(now);
      publishVote(false, now);
      if (getGame() !== g) return;
      if (now - lastPing >= 2) {
        lastPing = now;
        for (const m of members.values()) if (live(m)) m.link.sendReliable({ t: 'ping', n: clock() });
      }
      if (now - lastSent < 1 / SNAPSHOT_HZ) return;
      lastSent = now;
      const ready = [...members.values()].filter(live);
      if (!ready.length) return;
      for (const m of ready) sendPhotoScenes(g, m);
      const text = encode(snapper.next(g, now));
      for (const m of ready) m.link.sendFast(text);
    },
    close() {
      if (closed && !code) return;
      closed = true;
      for (const m of members.values()) { m.link.sendReliable({ t: 'bye', reason: 'closed' }); m.link.close(); }
      members.clear();
      stream?.close();
      if (code) relay.end(code, token).catch(() => {});
    },
  };
}
