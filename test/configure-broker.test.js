import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MqttClient } from "../web/js/mqtt.js";

const AMQP_URL = process.env.AMQP_URL ?? "amqp://guest:guest@localhost";

// Resolves to what config.js gets: the brokers and their names, by region
async function configureRegions(brokers, env = {}) {
  const config = join(await mkdtemp(join(tmpdir(), "doomq-")), "config.mjs");
  await promisify(execFile)("node", ["bin/configure-broker.js", ...brokers, config], { env: { ...process.env, ...env } });
  const { default: settings } = await import(config);
  return settings;
}

// Resolves to the one broker's URL
async function configure(env = {}) {
  return Object.values((await configureRegions([AMQP_URL], env)).brokers)[0];
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

test("only DooMQ's topics get through", async () => {
  const broker = await configure();
  const [a, b] = await Promise.all([MqttClient.connect(broker), MqttClient.connect(broker)]);
  const received = [];
  b.onmessage = (topic) => received.push(topic);
  await b.subscribe("#");
  a.publish("elsewhere", "dropped");
  a.publish("doomq/lobby/too/deep", "dropped");
  a.publish("doomq/lobby/game", "delivered");
  a.publish("doomq/watch/game", "delivered");
  await new Promise((resolve) => setTimeout(resolve, 500));
  a.close();
  b.close();
  assert.deepEqual(received, ["doomq/lobby/game", "doomq/watch/game"]);
});

test("every run starts over with a new password", async () => {
  const first = await configure();
  const client = await MqttClient.connect(first);
  client.publish("doomq/saves/game", "{}", { retain: true });
  client.close();

  const second = await configure();
  await assert.rejects(MqttClient.connect(first), /not authorized|bad username or password|connection closed/);
  const fresh = await MqttClient.connect(second);
  const received = [];
  fresh.onmessage = (topic) => received.push(topic);
  await fresh.subscribe("doomq/saves/+");
  await new Promise((resolve) => setTimeout(resolve, 500));
  fresh.close();
  assert.deepEqual(received, [], "retained messages survived");
});

test("a scheduled run can keep the password", async () => {
  const first = await configure({ DOOMQ_PASSWORD: "rip-and-tear" });
  const second = await configure({ DOOMQ_PASSWORD: "rip-and-tear" });
  assert.equal(second, first);
  (await MqttClient.connect(second)).close();
});

test("every region gets its broker, in order, by its code, or its host", async () => {
  const host = new URL(AMQP_URL).hostname;
  const { brokers, names } = await configureRegions([`ams:Amsterdam=${AMQP_URL}`, `syd=${AMQP_URL}`, AMQP_URL], { DOOMQ_PASSWORD: "rip-and-tear" });
  assert.deepEqual(Object.keys(brokers), ["ams", "syd", host]);
  assert.deepEqual(names, { ams: "Amsterdam", syd: "syd", [host]: host });
  // The same broker three times here, so each run recreated the vhost
  for (const broker of Object.values(brokers)) (await MqttClient.connect(broker)).close();
});

test("refuses what isn't a broker", async () => {
  await assert.rejects(configureRegions(["ams:Amsterdam=https://broker.example"]), /usage: configure-broker.js/);
});
