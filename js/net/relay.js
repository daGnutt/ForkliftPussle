// Client of the party relay in the high score service (https://highscore.gnutt.se): creates/joins parties and carries the
// WebRTC signalling (SSE in, POST out). `fetchFn` and `EventSourceCls` can be replaced for tests.
export const PARTY_BASE = 'https://highscore.gnutt.se/api/games/forklift';

export class RelayError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

export function createRelay({ base = PARTY_BASE, fetchFn = (...a) => fetch(...a), EventSourceCls = globalThis.EventSource } = {}) {
  // Plain-text bodies keep the requests free of CORS preflights.
  async function call(path, body, method = 'POST') {
    let res;
    try { res = await fetchFn(`${base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch { throw new RelayError('Could not reach the party server', 0); }
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    if (!res.ok || (json && json.status === 'error')) {
      const msg = res.status === 404 ? 'No such party (it may have expired)' : res.status === 409 ? 'That party is full' : res.status === 429 ? 'Too many requests, try again in a minute' : json?.message || `Party server error (${res.status})`;
      throw new RelayError(msg, res.status);
    }
    return json || {};
  }
  const code = (c) => encodeURIComponent(String(c).trim().toUpperCase());

  // Opens the event stream of a peer; `handlers` maps event names (join, leave, signal, closed) to functions of the parsed data.
  function events(partyCode, peer, token, handlers, onError) {
    const q = `peer=${encodeURIComponent(peer)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
    const es = new EventSourceCls(`${base}/parties/${code(partyCode)}/events?${q}`);
    for (const [name, fn] of Object.entries(handlers)) es.addEventListener(name, (e) => { let d = null; try { d = JSON.parse(e.data); } catch { /* ignore */ } fn(d); });
    es.onerror = () => { if (es.readyState === 2) onError?.(); };
    return { close: () => es.close() };
  }

  return {
    createParty: (name, meta) => call('/parties', { name, meta }),
    info: (c) => call(`/parties/${code(c)}`, undefined, 'GET'),
    join: (c, name) => call(`/parties/${code(c)}/join`, { name }),
    signal: (c, msg) => call(`/parties/${code(c)}/signal`, msg),
    end: (c, hostToken) => call(`/parties/${code(c)}`, { hostToken }, 'DELETE'),
    events,
  };
}
