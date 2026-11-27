// Doom's network for a peer of a game: its packets travel as MQTT messages,
// one per packet, on doomq/games/<game>/<to>/<from>. See web/js/protocol.js.

import { holdGoodbyes } from "../web/js/goodbyes.js";
import { gzip } from "../web/js/gzip.js";
import { isPeerId, topics } from "../web/js/protocol.js";

export function network(mqtt, game, self) {
  const inbox = [];
  const mine = topics.packet(game, self, "");
  // A host gets its guests' goodbyes from a broker that shuts down
  const goodbyes = holdGoodbyes((packet) => inbox.push(packet));
  return {
    // The connection dropped: see ../web/js/goodbyes.js
    dropped: goodbyes.forget,
    // Takes a message that is a packet for this peer, and returns who sent it
    deliver(topic, data) {
      if (!topic.startsWith(mine)) return undefined;
      const from = Number(topic.slice(mine.length));
      if (!isPeerId(from)) return undefined;
      goodbyes.receive({ from, data });
      return from;
    },
    // What doom/src/net_mqtt.c calls, as Module.net
    net: {
      connected: () => mqtt.connected,
      send: (to, data) => mqtt.publish(topics.packet(game, to, self), data),
      recv: () => inbox.shift(),
      // The running game, for a peer who joins it
      snapshot: async (to, data) => mqtt.publish(topics.join(game, to), await gzip(data)),
    },
  };
}
