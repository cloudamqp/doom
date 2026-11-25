// The broker under test, cut off as its restart would: every connection to
// the vhost is closed through LavinMQ's HTTP API, which is on the same port
// as MQTT over WebSocket. Tests in other files run at the same time, so their
// clients have to take it too, or be in another vhost.
const BROKER_URL = process.env.BROKER_URL ?? "ws://guest:guest@localhost:15672/mqtt";

export async function cutConnections() {
  const { username, password, host, protocol } = new URL(BROKER_URL);
  const [user, pass] = [username, password].map(decodeURIComponent);
  // MQTT users name their vhost before a colon, see bin/configure-broker.js
  const vhost = user.includes(":") ? user.split(":")[0] : "/";
  const api = `${protocol === "wss:" ? "https" : "http"}://${host}/api/connections`;
  const headers = { authorization: `Basic ${btoa(`${user}:${pass}`)}` };
  const connections = (await (await fetch(api, { headers })).json()).filter((connection) => connection.vhost === vhost);
  await Promise.all(connections.map(({ name }) => fetch(`${api}/${encodeURIComponent(name)}`, { method: "DELETE", headers })));
}
