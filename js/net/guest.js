// The guest side of a party: joins through the relay, connects to the host and mirrors the host's game.
import { createLink } from './peer.js';
import { createInterpolator, encode } from './protocol.js';
import { createPredictor } from './predict.js';

const INPUT_REFRESH = 0.25; // seconds; inputs are also resent while unchanged, as a guard against a lost message

// Events: onGame({ slot, started, level, seed, hard, seedText, snap }) for the welcome and every level change,
// onClosed(reason) when the party ends or the connection drops.
const BYE = { full: 'The party is full', kicked: 'The host removed you from the party', banned: 'You are banned from this party' };
export function createGuest({ relay, code, name, onGame, onClosed, linkFactory = createLink, clock = () => performance.now() / 1000 }) {
  const interp = createInterpolator();
  const predictor = createPredictor();
  let link = null, stream = null, peer = null, slot = -1, closed = false, lastIn = '', lastInAt = -Infinity, rtt = 0.1, lastGping = -Infinity;

  const end = (reason) => { if (closed) return; closed = true; stream?.close(); link?.close(); onClosed?.(reason); };

  return {
    interp,
    predictor,
    get rtt() { return rtt; }, // smoothed round trip to the host in seconds
    get slot() { return slot; },
    get code() { return code; },
    get closed() { return closed; },
    async join() {
      const r = await relay.join(code, name);
      peer = r.peer;
      link = linkFactory({
        initiator: false,
        iceServers: r.iceServers,
        sendSignal: (s) => relay.signal(code, { from: peer, to: 'host', ...s }).catch(() => end('Could not reach the host')),
        onOpen: () => link.sendReliable({ t: 'hello', name }),
        onMessage: (msg) => {
          if (msg.t === 'snap') { interp.push(msg, clock()); predictor.onSnapshot(msg, clock(), rtt); }
          else if (msg.t === 'gpong') rtt += (Math.max(0, clock() - msg.n) - rtt) * 0.3;
          else if (msg.t === 'welcome' || msg.t === 'level') {
            if (msg.t === 'welcome') slot = msg.slot;
            interp.reset();
            if (msg.t === 'welcome') lastGping = -Infinity;
            onGame({ slot, started: true, ...msg }); // a level message means the host is playing
          } else if (msg.t === 'ping') link.sendReliable({ t: 'pong', n: msg.n });
          else if (msg.t === 'bye') end(BYE[msg.reason] || 'The host closed the party');
        },
        onClose: () => end('Lost the connection to the host'),
      });
      stream = relay.events(code, peer, null, {
        signal: (d) => d && link.signal(d),
        closed: () => end('The host closed the party'),
      }, () => { /* the data channels carry the game; a dropped stream only matters for signalling */ });
    },
    // Sends the held keys (call every frame) and discrete fork actions.
    sendInput(st, now = clock()) {
      if (now - lastGping >= 1) { lastGping = now; link?.sendReliable({ t: 'gping', n: now }); }
      const text = encode({ t: 'in', up: !!st.up, down: !!st.down, left: !!st.left, right: !!st.right });
      if (text === lastIn && now - lastInAt < INPUT_REFRESH) return;
      lastIn = text; lastInAt = now;
      link?.sendReliable(text);
    },
    sendFork(dir) { link?.sendReliable({ t: 'fork', dir }); },
    close() { end('left'); },
  };
}
