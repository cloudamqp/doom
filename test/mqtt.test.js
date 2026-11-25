import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MqttClient,
  connectPacket,
  encodeLength,
  parse,
  parsePublish,
  publishPacket,
  subscribePacket,
} from "../web/js/mqtt.js";

import { cutConnections } from "./broker.js";

const BROKER_URL = process.env.BROKER_URL ?? "ws://guest:guest@localhost:15672/mqtt";

const text = (bytes) => new TextDecoder().decode(bytes);
const concat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));

test("remaining length is encoded in 7 bit groups", () => {
  const cases = [
    [0, [0x00]],
    [127, [0x7f]],
    [128, [0x80, 0x01]],
    [16_383, [0xff, 0x7f]],
    [16_384, [0x80, 0x80, 0x01]],
    [268_435_455, [0xff, 0xff, 0xff, 0x7f]],
  ];
  for (const [n, bytes] of cases) assert.deepEqual([...encodeLength(n)], bytes, `length ${n}`);
});

test("parse reassembles packets split at any byte", () => {
  const stream = concat(publishPacket("doomq/a", "hi", true), publishPacket("doomq/b", new Uint8Array(300).fill(7)));
  for (let cut = 0; cut <= stream.length; cut++) {
    const first = parse(stream.subarray(0, cut));
    const second = parse(concat(first.rest, stream.subarray(cut)));
    const messages = [...first.packets, ...second.packets].map(parsePublish);
    assert.deepEqual(
      messages.map((m) => [m.topic, m.payload.length, m.retain]),
      [
        ["doomq/a", 2, true],
        ["doomq/b", 300, false],
      ],
      `cut at ${cut}`,
    );
    assert.equal(second.rest.length, 0);
  }
});

test("connect packet carries credentials and a retained will", () => {
  const packet = connectPacket({
    clientId: "c",
    username: "u",
    password: "p",
    keepalive: 60,
    will: { topic: "t", payload: "", retain: true },
  });
  const [{ type, body }] = parse(packet).packets;
  assert.equal(type, 1);
  assert.equal(text(body.subarray(2, 6)), "MQTT");
  assert.equal(body[6], 4, "protocol level 3.1.1");
  assert.equal(body[7], 0x80 | 0x40 | 0x20 | 0x04 | 0x02, "user, password, will retain, will, clean session");
  assert.equal((body[8] << 8) | body[9], 60);
});

test("subscribe packet asks for QoS 0", () => {
  const [{ type, flags, body }] = parse(subscribePacket(258, "doomq/#")).packets;
  assert.deepEqual([type, flags], [8, 2]);
  assert.deepEqual([...body], [1, 2, 0, 7, ...new TextEncoder().encode("doomq/#"), 0]);
});

test("broker keeps retained messages and publishes last wills", async () => {
  const topic = `doomq/test/${Date.now()}`;
  const watcher = await MqttClient.connect(BROKER_URL);
  const seen = [];
  watcher.onmessage = (topic, payload, { retain }) => seen.push({ topic, payload: text(payload), retain });

  const publisher = await MqttClient.connect(BROKER_URL);
  publisher.publish(`${topic}/retained`, "kept", { retain: true });
  publisher.close();

  // A client that drops without DISCONNECT triggers its will
  const { username, password } = new URL(BROKER_URL);
  const url = new URL(BROKER_URL);
  url.username = url.password = "";
  const dropper = new WebSocket(url, "mqtt");
  dropper.binaryType = "arraybuffer";
  await new Promise((resolve) => (dropper.onopen = resolve));
  dropper.send(connectPacket({ clientId: "dropper", username, password, keepalive: 60, will: { topic: `${topic}/will`, payload: "gone" } }));
  await new Promise((resolve) => (dropper.onmessage = resolve)); // CONNACK

  await watcher.subscribe(`${topic}/#`);
  dropper.close();

  const deadline = Date.now() + 5_000;
  while (seen.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  watcher.publish(`${topic}/retained`, "", { retain: true });
  watcher.close();

  assert.deepEqual(seen, [
    { topic: `${topic}/retained`, payload: "kept", retain: true },
    { topic: `${topic}/will`, payload: "gone", retain: false },
  ]);
});

test("a lost connection comes back, subscribed as before", async () => {
  const topic = `doomq/test/${Date.now()}`;
  const client = await MqttClient.connect(BROKER_URL, { retry: 5_000, will: { topic: `${topic}/will`, payload: "gone" } });
  const events = [];
  const back = new Promise((resolve) => (client.onreconnect = resolve));
  client.ondrop = () => events.push("drop");
  client.onclose = () => events.push("close");
  client.onmessage = (topic, payload) => events.push(`${topic.split("/").pop()}: ${text(payload)}`);
  await client.subscribe(`${topic}/#`);

  await cutConnections();
  await back;
  assert.ok(client.connected);
  client.publish(`${topic}/news`, "still here");
  while (!events.includes("news: still here")) await new Promise((resolve) => setTimeout(resolve, 20));
  // Its own will, which the broker published as the connection went
  assert.deepEqual(
    events.filter((event) => event !== "will: gone"),
    ["drop", "news: still here"],
  );

  client.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(events.at(-1), "close");
});

test("without retry a lost connection is over", async () => {
  const client = await MqttClient.connect(BROKER_URL);
  const closed = new Promise((resolve) => (client.onclose = resolve));
  client.ondrop = () => assert.fail("nothing to wait for");
  await cutConnections();
  await closed;
  assert.ok(!client.connected);
});

test("broker refuses bad credentials", async () => {
  const url = new URL(BROKER_URL);
  url.password = "wrong";
  await assert.rejects(MqttClient.connect(url.href), /not authorized|bad username or password/);
});
