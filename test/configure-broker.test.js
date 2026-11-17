import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MqttClient } from "../web/js/mqtt.js";

const AMQP_URL = process.env.AMQP_URL ?? "amqp://guest:guest@localhost";

async function configure() {
  const config = join(await mkdtemp(join(tmpdir(), "doomq-")), "config.mjs");
  await promisify(execFile)("node", ["bin/configure-broker.js", AMQP_URL, config]);
  const { default: settings } = await import(config);
  return settings.broker;
}

test("configures a doomq user that can play but not administer", async () => {
  const broker = await configure();
  const url = new URL(broker);
  assert.equal(url.username, "doomq%3Adoomq");
  assert.equal(url.pathname, "/mqtt");

  const [a, b] = await Promise.all([MqttClient.connect(broker), MqttClient.connect(broker)]);
  const received = new Promise((resolve) => (b.onmessage = resolve));
  await b.subscribe("doomq/games/test/1/+");
  a.publish("doomq/games/test/1/2", "ticcmd");
  assert.equal(await received, "doomq/games/test/1/2");
  a.close();
  b.close();

  const api = new URL("/api/overview", url);
  api.protocol = url.protocol === "wss:" ? "https:" : "http:";
  api.username = api.password = "";
  const auth = Buffer.from(`doomq:${decodeURIComponent(url.password)}`).toString("base64");
  const response = await fetch(api, { headers: { authorization: `Basic ${auth}` } });
  assert.equal(response.status, 401);
});

test("every run sets a new password", async () => {
  const first = await configure();
  await configure();
  await assert.rejects(MqttClient.connect(first), /not authorized|bad username or password|connection closed/);
});
