// A guest's last will is Doom's disconnect packet to the host: the broker
// sends it when the guest goes without a word, as when its tab closes. A
// broker that shuts down sends everyone's will on its way out, also for the
// guests that are back a moment later. So a host holds a goodbye for a while
// before Doom gets it, and forgets those it holds when its own connection
// drops: that was the broker leaving, not the guests.

// NET_PACKET_TYPE_DISCONNECT, see doom/src/net_defs.h
export const GOODBYE = Uint8Array.of(0, 8);
// The broker closes its connections within milliseconds of each other
const HOLD = 1_500;

const isGoodbye = (data) => data.length === GOODBYE.length && data.every((byte, i) => byte === GOODBYE[i]);

// Returns { receive(packet), forget() }: packets are { from, data } and go on
// to deliver(packet), goodbyes after the hold.
export function holdGoodbyes(deliver, hold = HOLD) {
  const held = new Set();
  return {
    receive(packet) {
      if (!isGoodbye(packet.data)) return deliver(packet);
      const timer = setTimeout(() => {
        held.delete(timer);
        deliver(packet);
      }, hold);
      held.add(timer);
    },
    forget() {
      for (const timer of held) clearTimeout(timer);
      held.clear();
    },
  };
}
