// Broker the browsers connect to (MQTT over WebSocket). Every player gets
// these credentials, so use a user that can only reach the doomq/ topics.
// The Docker image rewrites this file from $BROKER_URL.
export default {
  broker: `ws://guest:guest@${location.hostname}:15672/mqtt`,
};
