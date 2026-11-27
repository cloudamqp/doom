#!/usr/bin/env node
// Sets up LavinMQ brokers for DooMQ, one per region, and points the web app
// at them:
//
//   node bin/configure-broker.js [--reset] [<code>[:<name>]=]<amqp-url>... [config.js]
//   node bin/configure-broker.js amqps://admin:secret@broker.example.com
//   node bin/configure-broker.js ams:Amsterdam=amqps://admin:secret@ams.example.com syd:Sydney=amqps://admin:secret@syd.example.com
//
// A region goes by a code in addresses (?region=ams), the airport code of a
// city nearby, and by its name in the lobby, which is the code unless
// given. Players pick a region in the lobby, and start in the first. A
// broker without a region goes by its host.
//
// Every run sets up the doomq vhost on every broker in place, games and
// saves and all, and sets the doomq user's password, to $DOOMQ_PASSWORD or
// a new random one. With --reset it starts over: it deletes the vhost
// first, which ends running games and clears saves. Run that on a schedule
// to clear out abuse. It then writes the wss:// URLs with the credentials
// to web/js/config.js. The HTTP API is expected on the broker's host:
// https://host for amqps:// URLs, http://host:15672 for amqp:// ones.

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
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
  join: "doomq/join/+/+",
};
// [<code>[:<name>]=]<amqp-url>
const BROKER = /^(?:([^=:]+)(?::([^=]+))?=)?(amqps?:\/\/.+)$/;

process.on("uncaughtException", (error) => {
  console.error(error.cause ? `${error.message}: ${error.cause.message}` : error.message);
  process.exit(1);
});

const { values: options, positionals: args } = parseArgs({
  allowPositionals: true,
  options: { reset: { type: "boolean", default: false } },
});
const configPath = args.length && !BROKER.test(args.at(-1)) ? args.pop() : fileURLToPath(new URL("../web/js/config.js", import.meta.url));
const brokers = args.map((arg) => arg.match(BROKER));
if (!brokers.length || !brokers.every(Boolean)) {
  console.error("usage: configure-broker.js [--reset] [<code>[:<name>]=]<amqp-url>... [config.js]");
  process.exit(1);
}

const password = process.env.DOOMQ_PASSWORD || randomBytes(18).toString("base64url");

// Returns the broker's wss:// URL for players, once it works
async function configure(amqpUrl) {
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
    if (method === "GET") return response.json();
  }

  if (options.reset) {
    await request("DELETE", `vhosts/${VHOST}`).catch((error) => {
      if (!error.message.includes(": 404 ")) throw error;
    });
  }
  await request("PUT", `vhosts/${VHOST}`);
  await request("PUT", `vhost-limits/${VHOST}/max-connections`, { value: MAX_CONNECTIONS });

  await request("PUT", `users/${USER}`, { password, tags: "" });
  // MQTT connects with any permission on the vhost. With MQTT permission
  // checks enabled it also needs to read the mqtt.default exchange and write
  // to it and the mqtt.<client id> session queues. Nothing to configure, so
  // these credentials can't declare anything over AMQP.
  await request("PUT", `permissions/${VHOST}/${USER}`, { configure: "^$", write: "^mqtt\\.", read: "^mqtt\\.default$" });

  // Every vhost starts with a group whose rule allows every topic. DooMQ's
  // rules replace it, and any rule an older DooMQ left behind.
  const group = `mqtt/permission-groups/${VHOST}/default/rules`;
  for (const [rule, pattern] of Object.entries(TOPICS)) {
    await request("PUT", `${group}/${rule}`, { pattern, read: true, write: true });
  }
  for (const { identifier } of await request("GET", group)) {
    if (!Object.hasOwn(TOPICS, identifier)) await request("DELETE", `${group}/${identifier}`);
  }

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
  return broker;
}

// By region: the brokers' wss:// URLs, and the names the lobby shows
const urls = [];
const names = [];
for (const [, given, name, amqpUrl] of brokers) {
  const code = given ?? new URL(amqpUrl).hostname;
  const broker = await configure(amqpUrl).catch((error) => {
    error.message = `${code}: ${error.message}`;
    throw error;
  });
  console.log(`${code}: ${broker.protocol}//${broker.username}@${broker.host}${broker.pathname} works`);
  urls.push(`    ${JSON.stringify(code)}: ${JSON.stringify(broker.href)},`);
  names.push(`    ${JSON.stringify(code)}: ${JSON.stringify(name ?? code)},`);
}

const config = `export default {\n  brokers: {\n${urls.join("\n")}\n  },\n  names: {\n${names.join("\n")}\n  },\n};\n`;
await writeFile(configPath, `// Written by bin/configure-broker.js\n${config}`);
console.log(`Written to ${configPath}`);
