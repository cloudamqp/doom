#!/usr/bin/env node
// Sets up a LavinMQ broker for DooMQ and points the web app at it:
//
//   node bin/configure-broker.js amqps://admin:secret@broker.example.com [config.js]
//
// Every run starts over: it deletes and recreates the doomq vhost, which
// ends running games and clears saves, and sets the doomq user's password,
// to $DOOMQ_PASSWORD or a new random one. Run it on a schedule to clear out
// abuse. It then writes the wss:// URL with the credentials to
// web/js/config.js. The HTTP API is expected on the broker's host:
// https://host for amqps:// URLs, http://host:15672 for amqp:// ones.

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MqttClient } from "../web/js/mqtt.js";

const VHOST = "doomq";
const USER = "doomq";
const MAX_CONNECTIONS = 500;
// What a client that stops reading may have queued, more than any save
const MAX_SESSION_BYTES = 1024 * 1024;
// The topics in web/js/doomq.js, and nothing else
const TOPICS = {
  lobby: "doomq/lobby/+",
  games: "doomq/games/+/+/+",
  saves: "doomq/saves/+",
  savedata: "doomq/savedata/+",
  watch: "doomq/watch/+",
};

const [amqpUrl, configPath = fileURLToPath(new URL("../web/js/config.js", import.meta.url))] = process.argv.slice(2);
if (!amqpUrl) {
  console.error("usage: configure-broker.js <amqp-url> [config.js]");
  process.exit(1);
}

const amqp = new URL(amqpUrl);
const tls = amqp.protocol === "amqps:";
const api = new URL(tls ? `https://${amqp.hostname}` : `http://${amqp.hostname}:15672`);
const credentials = `${decodeURIComponent(amqp.username)}:${decodeURIComponent(amqp.password)}`;

async function request(method, path, body) {
  const response = await fetch(new URL(`/api/${path}`, api), {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(credentials).toString("base64")}`,
      "content-type": "application/json",
    },
    body: body && JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} /api/${path}: ${response.status} ${await response.text()}`);
}

process.on("uncaughtException", (error) => {
  console.error(error.cause ? `${error.message}: ${error.cause.message}` : error.message);
  process.exit(1);
});

const password = process.env.DOOMQ_PASSWORD || randomBytes(18).toString("base64url");

await request("DELETE", `vhosts/${VHOST}`).catch((error) => {
  if (!error.message.includes(": 404 ")) throw error;
});
await request("PUT", `vhosts/${VHOST}`);
await request("PUT", `vhost-limits/${VHOST}/max-connections`, { value: MAX_CONNECTIONS });

await request("PUT", `users/${USER}`, { password, tags: "" });
// MQTT connects with any permission on the vhost. With MQTT permission
// checks enabled it also needs to read the mqtt.default exchange and write
// to it and the mqtt.<client id> session queues. Nothing to configure, so
// these credentials can't declare anything over AMQP.
await request("PUT", `permissions/${VHOST}/${USER}`, { configure: "^$", write: "^mqtt\\.", read: "^mqtt\\.default$" });

// Every vhost starts with a group that allows every topic, swap its rule
for (const [rule, pattern] of Object.entries(TOPICS)) {
  await request("PUT", `mqtt/permission-groups/${VHOST}/default/rules/${rule}`, { pattern, read: true, write: true });
}
await request("DELETE", `mqtt/permission-groups/${VHOST}/default/rules/allow-all`);

// MQTT sessions are queues named mqtt.<client id>, the oldest messages
// go when a client falls behind
await request("PUT", `policies/${VHOST}/sessions`, {
  pattern: "^mqtt\\.",
  "apply-to": "queues",
  definition: { "max-length-bytes": MAX_SESSION_BYTES },
});

const broker = new URL("/mqtt", api);
broker.protocol = tls ? "wss:" : "ws:";
broker.username = `${VHOST}:${USER}`; // LavinMQ picks the vhost from "vhost:user"
broker.password = password;

const mqtt = await MqttClient.connect(broker.href);
mqtt.close();

await writeFile(configPath, `// Written by bin/configure-broker.js\nexport default {\n  broker: ${JSON.stringify(broker.href)},\n};\n`);
console.log(`${broker.protocol}//${broker.username}@${broker.host}${broker.pathname} works, written to ${configPath}`);
