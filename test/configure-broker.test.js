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
async function configureRegions(brokers, env = {}, flags = []) {
  const config = join(await mkdtemp(join(tmpdir(), "doomq-")), "config.mjs");
  await promisify(execFile)("node", ["bin/configure-broker.js", ...flags, ...brokers, config], { env: { ...process.env, ...env } });
  const { default: settings } = await import(config);
  return settings;
}

// Resolves to the one broker's URL
async function configure(env = {}, flags = []) {
  return Object.values((await configureRegions([AMQP_URL], env, flags)).brokers)[0];
}

// Resolves to the topics with a message retained that match the filter
async function retained(broker, filter) {
  const client = await MqttClient.connect(broker);
  const received = [];
  client.onmessage = (topic) => received.push(topic);
  await client.subscribe(filter);
  await new Promise((resolve) => setTimeout(resolve, 500));
  client.close();
  return received;
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

test("a run leaves running games and saves alone", { timeout: 10_000 }, async () => {
  const broker = await configure({ DOOMQ_PASSWORD: "rip-and-tear" }, ["--reset"]);
  const host = await MqttClient.connect(broker);
  let ended = false;
  host.onclose = () => (ended = true);
  host.publish("doomq/saves/game", "{}", { retain: true });

  assert.equal(await configure({ DOOMQ_PASSWORD: "rip-and-tear" }), broker);
  assert.deepEqual(await retained(broker, "doomq/saves/+"), ["doomq/saves/game"]);
  assert.equal(ended, false, "the game's connection ended");
  host.close();
});

test("--reset starts over with a new password", async () => {
  const first = await configure();
  const client = await MqttClient.connect(first);
  client.publish("doomq/saves/game", "{}", { retain: true });
  client.close();

  const second = await configure({}, ["--reset"]);
  await assert.rejects(MqttClient.connect(first), /not authorized|bad username or password|connection closed/);
  assert.deepEqual(await retained(second, "doomq/saves/+"), [], "retained messages survived");
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
  for (const broker of Object.values(brokers)) (await MqttClient.connect(broker)).close();
});

test("refuses what isn't a broker", async () => {
  await assert.rejects(configureRegions(["ams:Amsterdam=https://broker.example"]), /usage: configure-broker.js/);
  await assert.rejects(configureRegions([AMQP_URL], {}, ["--rest"]), /Unknown option '--rest'/);
});
