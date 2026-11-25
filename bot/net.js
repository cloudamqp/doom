// Doom's network for a peer of a game: its packets travel as MQTT messages,
// one per packet, on doomq/games/<game>/<to>/<from>. See web/js/protocol.js.

import { isPeerId, topics } from "../web/js/protocol.js";

export function network(mqtt, game, self) {
  const inbox = [];
  const mine = topics.packet(game, self, "");
  return {
    // Takes a message that is a packet for this peer, and returns who sent it
    deliver(topic, data) {
      if (!topic.startsWith(mine)) return undefined;
      const from = Number(topic.slice(mine.length));
      if (!isPeerId(from)) return undefined;
      inbox.push({ from, data });
      return from;
    },
    // What doom/src/net_mqtt.c calls, as Module.net
    net: {
      connected: () => mqtt.connected,
      send: (to, data) => mqtt.publish(topics.packet(game, to, self), data),
      recv: () => inbox.shift(),
    },
  };
}
