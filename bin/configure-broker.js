#!/usr/bin/env node
// Prepares a LavinMQ broker for DooMQ and points the web app at it:
//
//   node bin/configure-broker.js amqps://admin:secret@broker.example.com [config.js]
//
// Creates the doomq vhost and the doomq user, then writes the wss:// URL
// with that user's credentials to web/js/config.js. Every run sets a new
// password. The HTTP API is expected on the broker's host: https://host
// for amqps:// URLs, http://host:15672 for amqp:// ones.

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MqttClient } from "../web/js/mqtt.js";

const VHOST = "doomq";
const USER = "doomq";
const MAX_CONNECTIONS = 500;

const [amqpUrl, configPath = fileURLToPath(new URL("../web/js/config.js", import.meta.url))] = process.argv.slice(2);
if (!amqpUrl) {
  console.error("usage: configure-broker.js <amqp-url> [config.js]");
  process.exit(1);
}

const amqp = new URL(amqpUrl);
const tls = amqp.protocol === "amqps:";
const api = new URL(tls ? `https://${amqp.hostname}` : `http://${amqp.hostname}:15672`);
const credentials = `${decodeURIComponent(amqp.username)}:${decodeURIComponent(amqp.password)}`;

async function put(path, body) {
  const response = await fetch(new URL(`/api/${path}`, api), {
    method: "PUT",
    headers: {
      authorization: `Basic ${Buffer.from(credentials).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`PUT /api/${path}: ${response.status} ${await response.text()}`);
}

process.on("uncaughtException", (error) => {
  console.error(error.cause ? `${error.message}: ${error.cause.message}` : error.message);
  process.exit(1);
});

const password = randomBytes(18).toString("base64url");

await put(`vhosts/${VHOST}`, {});
await put(`vhost-limits/${VHOST}/max-connections`, { value: MAX_CONNECTIONS });
await put(`users/${USER}`, { password, tags: "" });
// MQTT connects with any permission on the vhost. With MQTT permission
// checks enabled it also needs to read the mqtt.default exchange and write
// to it and the mqtt.<client id> session queues. Nothing to configure, so
// these credentials can't declare anything over AMQP.
await put(`permissions/${VHOST}/${USER}`, { configure: "^$", write: "^mqtt\\.", read: "^mqtt\\.default$" });

const broker = new URL("/mqtt", api);
broker.protocol = tls ? "wss:" : "ws:";
broker.username = `${VHOST}:${USER}`; // LavinMQ picks the vhost from "vhost:user"
broker.password = password;

const mqtt = await MqttClient.connect(broker.href);
mqtt.close();

await writeFile(configPath, `// Written by bin/configure-broker.js\nexport default {\n  broker: ${JSON.stringify(broker.href)},\n};\n`);
console.log(`${broker.protocol}//${broker.username}@${broker.host}${broker.pathname} works, written to ${configPath}`);
