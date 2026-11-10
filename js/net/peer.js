// One WebRTC connection between the host and a guest. The host (initiator) creates two data channels:
// 'ctl' is reliable and ordered (inputs, fork actions, level changes), 'state' is unordered with no retransmits (snapshots).
// Messages are JSON objects. Signalling (offer/answer/ice) goes through `sendSignal({ type, data })`.
export function createLink({ initiator, iceServers, sendSignal, onMessage, onOpen, onClose, PeerCls = globalThis.RTCPeerConnection }) {
  const pc = new PeerCls({ iceServers });
  let ctl = null, state = null, open = false, closed = false, haveRemote = false, chain = Promise.resolve();
  const early = [];

  const fail = () => { if (closed) return; closed = true; onClose?.(); try { pc.close(); } catch { /* already closed */ } };
  const check = () => {
    if (!open && ctl?.readyState === 'open' && state?.readyState === 'open') { open = true; onOpen?.(); }
  };
  function wire(ch) {
    ch.onmessage = (e) => { try { onMessage?.(JSON.parse(e.data)); } catch { /* ignore garbage */ } };
    ch.onopen = check;
    ch.onclose = fail;
    if (ch.label === 'ctl') ctl = ch; else state = ch;
    check();
  }

  pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ type: 'ice', data: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }); };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') fail(); };

  if (initiator) {
    wire(pc.createDataChannel('ctl'));
    wire(pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 }));
    pc.createOffer().then((o) => pc.setLocalDescription(o).then(() => sendSignal({ type: 'offer', data: { type: o.type, sdp: o.sdp } }))).catch(fail);
  } else {
    pc.ondatachannel = (e) => wire(e.channel);
  }

  return {
    get open() { return open && !closed; },
    // Handles a signal from the other side. Signals are processed one at a time, and ICE candidates that arrive before the
    // remote description (the relay does not guarantee ordering) wait for it.
    signal(sig) {
      chain = chain.then(async () => {
        const { type, data } = sig;
        try {
          if (type === 'offer' || type === 'answer') {
            await pc.setRemoteDescription(data);
            haveRemote = true;
            for (const c of early.splice(0)) await pc.addIceCandidate(c);
            if (type === 'offer') {
              const a = await pc.createAnswer();
              await pc.setLocalDescription(a);
              sendSignal({ type: 'answer', data: { type: a.type, sdp: a.sdp } });
            }
          } else if (type === 'ice') {
            if (haveRemote) await pc.addIceCandidate(data); else early.push(data);
          }
        } catch { fail(); }
      });
      return chain;
    },
    // Messages are objects, or text that is already JSON.
    sendReliable(msg) { if (ctl?.readyState === 'open') ctl.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); },
    sendFast(msg) { if (state?.readyState === 'open') state.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); },
    close() { if (closed) return; closed = true; try { pc.close(); } catch { /* already closed */ } },
  };
}
