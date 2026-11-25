// Broker the browsers connect to (MQTT over WebSocket). Every player gets
// these credentials. bin/configure-broker.js writes this file for a real
// broker, and the Docker image rewrites it from $BROKER_URL.
export default {
  broker: `ws://guest:guest@${location.hostname}:15672/mqtt`,
  // Lets ?broker=wss://user:pass@host/mqtt in the address pick another
  // broker, for development. The files written for a real broker leave it
  // out: a link to the site could take players to anyone's broker.
  brokerFromAddress: true,
};
