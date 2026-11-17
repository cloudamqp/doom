// Broker the browsers connect to (MQTT over WebSocket). Every player gets
// these credentials. bin/configure-broker.js writes this file for a real
// broker, and the Docker image rewrites it from $BROKER_URL.
export default {
  broker: `ws://guest:guest@${location.hostname}:15672/mqtt`,
};
