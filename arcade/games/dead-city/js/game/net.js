// Co-op over the artifact's live room: everyone who has this page open is in the same city.
// Each player publishes one presence object (their hero, recent effects, the zombies they simulate near the
// others, and the hits they landed on other players' zombies). Presence works for every admitted viewer, so no
// one needs edit rights to play.

const PRESENCE_LIMIT = 3900; // bytes of JSON; the platform's cap is 4 KiB

const safeKey = (peer) => 'p_' + String(peer).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);

function createNet() {
  const net = {
    available: false,
    connected: false,
    room: null,
    me: null, // my peer label
    myKey: null,
    others: new Map(), // peer -> { peer, key, presence, updatedAt }
    onChange: null,
    status: 'connecting',
    lastSend: 0,
    bytes: 0
  };

  const refresh = (peers) => {
    const seen = new Set();
    for (const p of peers) {
      if (p.sameTab) {
        net.me = p.peer;
        net.myKey = safeKey(p.peer);
        continue;
      }
      if (p.kind !== 'viewer') continue;
      const pres = p.presence || {};
      if (!Array.isArray(pres.h)) continue; // in the city but not deployed (or another tab of the page)
      seen.add(p.peer);
      net.others.set(p.peer, { peer: p.peer, key: safeKey(p.peer), presence: pres, updatedAt: p.updatedAt, guest: p.guest });
    }
    for (const peer of [...net.others.keys()]) if (!seen.has(peer)) net.others.delete(peer);
    net.onChange?.(net);
  };

  net.ready = (async () => {
    try {
      if (!window.claude?.use) throw new Error('no runtime');
      const room = await window.claude.use('room');
      if (!room) throw new Error('room unavailable');
      net.room = room;
      net.available = true;
      net.status = 'online';
      room.onPeers((change) => refresh(change.peers), () => { net.available = false; net.status = 'offline'; net.onChange?.(net); });
      room.onConnection((c) => { net.connected = c; net.onChange?.(net); }, () => {});
      refresh(room.peers());
    } catch {
      net.available = false;
      net.status = 'solo';
      net.onChange?.(net);
    }
    return net;
  })();

  // Publish my state; drops zombie entries until it fits under the presence cap
  net.publish = (state) => {
    if (!net.available || !net.room) return;
    let json = JSON.stringify(state);
    if (json.length > PRESENCE_LIMIT && Array.isArray(state.z)) {
      while (json.length > PRESENCE_LIMIT && state.z.length) {
        state.z.length = Math.max(0, state.z.length - 7 * 6);
        json = JSON.stringify(state);
      }
    }
    if (json.length > PRESENCE_LIMIT) return;
    net.bytes = json.length;
    net.room.presence(state).catch(() => {});
  };

  net.clear = () => {
    if (!net.available || !net.room) return;
    net.room.presence({ h: null, z: null, fx: null, hits: null, a: null, rv: null }).catch(() => {});
  };

  return net;
}

export { createNet, safeKey };
