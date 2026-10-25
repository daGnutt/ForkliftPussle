// Minimal Standard MIDI File parser (formats 0/1). DOM-free so it can be tested in Node.
// parseMidi(bytes) -> { duration (s), notes: [{ t, dur, note, vel }] } sorted by start time.
export function parseMidi(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const str = (p, n) => String.fromCharCode(...u.subarray(p, p + n));
  const u32 = (p) => ((u[p] << 24) | (u[p + 1] << 16) | (u[p + 2] << 8) | u[p + 3]) >>> 0;
  const u16 = (p) => (u[p] << 8) | u[p + 1];
  if (str(0, 4) !== 'MThd') throw new Error('Not a MIDI file');
  const ntrk = u16(10);
  const division = u16(12);
  if (division & 0x8000) throw new Error('SMPTE timing unsupported');

  const tempos = [{ tick: 0, uspq: 500000 }];
  const raw = []; // { tick, dur(ticks), note, vel }
  let p = 8 + u32(4);
  for (let tr = 0; tr < ntrk && p < u.length; tr++) {
    const end = p + 8 + u32(p + 4);
    p += 8;
    let tick = 0, status = 0;
    const open = new Map();
    const vlq = () => { let v = 0, b; do { b = u[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
    const close = (ch, note) => {
      const k = ch * 128 + note, o = open.get(k);
      if (o) { raw.push({ tick: o.tick, dur: Math.max(1, tick - o.tick), note, vel: o.vel }); open.delete(k); }
    };
    while (p < end) {
      tick += vlq();
      let s = u[p];
      if (s & 0x80) p++; else s = status;
      if (s === 0xff) {
        const type = u[p++], len = vlq();
        if (type === 0x51 && len === 3) tempos.push({ tick, uspq: (u[p] << 16) | (u[p + 1] << 8) | u[p + 2] });
        p += len;
        if (type === 0x2f) break;
      } else if (s === 0xf0 || s === 0xf7) {
        p += vlq();
      } else {
        status = s;
        const ch = s & 15, hi = s & 0xf0;
        const a = u[p++], b = (hi === 0xc0 || hi === 0xd0) ? 0 : u[p++];
        if (ch === 9) continue; // percussion channel
        if (hi === 0x90 && b > 0) { close(ch, a); open.set(ch * 128 + a, { tick, vel: b }); }
        else if (hi === 0x80 || hi === 0x90) close(ch, a);
      }
    }
    for (const k of [...open.keys()]) close(k >> 7, k & 127);
    p = end;
  }

  tempos.sort((x, y) => x.tick - y.tick);
  const secAt = (tick) => {
    let s = 0, last = tempos[0];
    for (const t of tempos) {
      if (t.tick >= tick) break;
      s += (t.tick - last.tick) * last.uspq / 1e6 / division;
      last = t;
    }
    return s + (tick - last.tick) * last.uspq / 1e6 / division;
  };
  const notes = raw.map((n) => {
    const t = secAt(n.tick);
    return { t, dur: secAt(n.tick + n.dur) - t, note: n.note, vel: n.vel };
  }).sort((x, y) => x.t - y.t);
  const duration = notes.reduce((m, n) => Math.max(m, n.t + n.dur), 0);
  return { duration, notes };
}
