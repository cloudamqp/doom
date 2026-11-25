// Brokers the browsers connect to (MQTT over WebSocket), one per region. A
// region goes by a code in addresses (?region=ams), the airport code of a
// city nearby, and by its name in the lobby. Players pick a region in the
// lobby when there is more than one, and start in the first. Every player
// gets these credentials. bin/configure-broker.js writes this file for real
// brokers, and the Docker image rewrites it from $BROKER_URL.
export default {
  brokers: {
    local: `ws://guest:guest@${location.hostname}:15672/mqtt`,
  },
  names: {
    local: "Local",
  },
  // Lets ?broker=wss://user:pass@host/mqtt in the address pick another
  // broker, for development. The files written for a real broker leave it
  // out: a link to the site could take players to anyone's broker.
  brokerFromAddress: true,
};
