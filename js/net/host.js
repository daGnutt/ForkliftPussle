// The host side of a party: owns the relay party, one WebRTC link per guest and the guests' trucks in the running game.
import { addTruck, removeTruck, truckView, forkUp, forkDown } from '../game.js';
import { createLink } from './peer.js';
import { createSnapshotter, snapshot, encode, SNAPSHOT_HZ } from './protocol.js';

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

// `getGame()` returns the current game (it is replaced on every level load); `levelInfo()` its { level, seed, hard, seedText };
// `isStarted()` tells whether the host has left the splash. `onChange()` fires when the player list changes.
export function createHost({ relay, getGame, levelInfo, isStarted, name, meta, onChange, onClosed, linkFactory = createLink, clock = () => performance.now() / 1000 }) {
  const members = new Map(); // peer id -> { name, slot, link }
  const snapper = createSnapshotter();
  let code = null, token = null, stream = null, lastSent = -Infinity, closed = false;

  const payload = (g) => ({ ...levelInfo(), snap: snapshot(g) });
  const live = (m) => m.slot >= 0 && m.link.open;

  function drop(peer) {
    const m = members.get(peer);
    if (!m) return;
    members.delete(peer);
    if (m.slot >= 0) removeTruck(getGame(), m.slot);
    m.link.close();
    onChange?.();
  }

  function onGuestMessage(peer, m, msg) {
    const g = getGame();
    if (msg.t === 'hello' && m.slot < 0) {
      m.name = String(msg.name || 'Player').slice(0, 24);
      const slot = addTruck(g, m.name);
      if (slot < 0) { m.link.sendReliable({ t: 'bye', reason: 'full' }); drop(peer); return; }
      m.slot = slot;
      m.link.sendReliable({ t: 'welcome', slot, started: isStarted(), ...payload(g) });
      onChange?.();
    } else if (m.slot >= 0) {
      const t = g.trucks[m.slot];
      if (!t || t.gone) return;
      if (msg.t === 'in') t.input = { up: !!msg.up, down: !!msg.down, left: !!msg.left, right: !!msg.right };
      else if (msg.t === 'fork') (msg.dir === 'up' ? forkUp : forkDown)(truckView(g, m.slot));
    }
  }

  function onJoin({ peer, name: guestName }) {
    if (!peer || members.has(peer)) return;
    const m = { name: guestName, slot: -1, link: null };
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
    // Everyone in the party in slot order: [{ slot, name }] (the host is slot 0).
    players() {
      const g = getGame();
      return g.trucks.map((t, i) => (t.gone ? null : { slot: i, name: t.name || (i === 0 ? name : `Player ${i + 1}`) })).filter(Boolean);
    },
    get guests() { return [...members.values()].filter(live).length; },
    // After the host loaded a new level: every guest gets a new truck in its old slot and the new level.
    levelLoaded(g) {
      snapper.reset();
      for (const m of members.values()) if (m.slot >= 0) m.slot = addTruck(g, m.name, m.slot);
      for (const m of members.values()) if (live(m)) m.link.sendReliable({ t: 'level', ...payload(g) });
    },
    // The host left the splash: waiting guests may start.
    started(g) { for (const m of members.values()) if (live(m)) m.link.sendReliable({ t: 'level', ...payload(g) }); },
    // Called every frame; sends a snapshot to every guest at SNAPSHOT_HZ.
    broadcast(g, now = clock()) {
      if (now - lastSent < 1 / SNAPSHOT_HZ) return;
      lastSent = now;
      const ready = [...members.values()].filter(live);
      if (!ready.length) return;
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
