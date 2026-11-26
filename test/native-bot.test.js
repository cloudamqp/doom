// A native bot (doom/native) in a game hosted by a browser.
// Needs the web app, a broker with MQTT on TCP and WebSocket, and
// make -C doom native
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer";
import { MqttClient } from "../web/js/mqtt.js";
import { newGameId, parseWatch, topics } from "../web/js/protocol.js";

const WEB_URL = process.env.WEB_URL ?? "http://localhost:8080";
const MQTT_URL = process.env.MQTT_URL ?? "mqtt://guest:guest@localhost:1883";
const WS_URL = process.env.BROKER_URL ?? "ws://guest:guest@localhost:15672/mqtt";
const BOT = resolve("doom/build/native/doomq-bot");
const WAD = resolve("web/freedoom1.wad");

let browser;
const bots = [];

before(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
});

after(async () => {
  for (const bot of bots) bot.kill();
  await browser?.close();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, condition, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(100);
  }
}

// Hosts a deathmatch from the lobby and returns its page
async function hostGame(title, { bots = 0 } = {}) {
  const page = await browser.newPage();
  page.lines = [];
  page.on("console", (message) => page.lines.push(message.text()));
  await page.goto(`${WEB_URL}/index.html`);
  await page.waitForFunction(() => document.querySelector("#status").textContent === "Connected");
  await page.type("#create [name=title]", title);
  await page.select("#create [name=mode]", "deathmatch");
  await page.select("#create [name=bots]", String(bots));
  await Promise.all([page.waitForNavigation(), page.click("#create button")]);
  return page;
}

// Doom writes its settings to the working directory
function doom(...args) {
  const bot = spawn(BOT, ["-iwad", WAD, "-broker", MQTT_URL, ...args], { cwd: mkdtempSync(join(tmpdir(), "doomq-")) });
  bot.output = "";
  bot.stdout.on("data", (data) => (bot.output += data));
  bot.stderr.on("data", (data) => (bot.output += data));
  bots.push(bot);
  return bot;
}

test("a native bot keeps in step with a browser", async () => {
  const host = await hostGame(`Bot ${Date.now().toString(36)}`);
  const game = new URL(host.url()).searchParams.get("game");
  const bot = doom("-game", game, "-connect", "1", "-pet", "Bot", "-bot", "3");
  await host.waitForFunction(() => document.querySelector("#details").textContent.includes("2/8 players"));

  // Space starts the game once Doom's waiting room is up
  await host.focus("#canvas");
  await until("the game to start", async () => {
    await host.keyboard.press("Space");
    return bot.output.includes("doom: 10,");
  });

  // Doom compares both sides every tic and ends the game when they
  // differ. While they agree, the bot sends 35 packets a second.
  await host.evaluate(() => {
    const recv = Module.net.recv;
    Module.net.received = 0;
    Module.net.recv = () => {
      const packet = recv();
      if (packet) Module.net.received++;
      return packet;
    };
  });
  await host.keyboard.down("KeyW");
  await host.keyboard.down("Space");
  await sleep(10_000);
  const received = await host.evaluate(() => Module.net.received);

  assert.ok(received > 300, `the host received ${received} packets in 10 s`);
  assert.equal(bot.exitCode, null, bot.output);
  assert.ok(!host.lines.some((line) => /consistency|crashed/i.test(line)), host.lines.join("\n"));
});

test("bots join a game that asks for them", async () => {
  doom("-lobby");
  const host = await hostGame(`Bots ${Date.now().toString(36)}`, { bots: 2 });

  await host.waitForFunction(() => document.querySelector("#details").textContent.includes("3/8 players"));
});

test("a game that a bot hosts can be watched from above", async () => {
  const game = newGameId();
  const mqtt = await MqttClient.connect(WS_URL);
  let watch;
  mqtt.onmessage = (topic, payload) => (watch = parseWatch(payload));
  await mqtt.subscribe(topics.watch(game));

  const match = ["-game", game, "-bot", "3", "-deathmatch", "-nomonsters", "-warp", "3", "4"];
  doom("-server", "-title", "Watched", "-pet", "Host", "-nodes", "2", ...match);
  doom("-connect", "1", "-pet", "Guest", ...match);

  await until("what spectators see", () => watch !== undefined).finally(() => mqtt.close());
  assert.equal(watch?.map, "E3M4");
  assert.deepEqual(watch.players.map((player) => player.name), ["Host", "Guest"]);
});

const arena = `::-p-xpath(//table[@id="games"]/tbody/tr[td[1][text()="Bot arena"]][td[6][text()="2/8"]])`;

test("the bot service keeps a game of bots waiting in the lobby", async () => {
  const service = doom("-lobby", "-arena", "2");
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.lines = [];
  page.on("console", (message) => page.lines.push(message.text()));
  await page.goto(`${WEB_URL}/index.html`);

  // Two bots wait for someone to play with
  const href = await (await page.waitForSelector(`${arena} >>> a`)).evaluate((a) => a.href);

  // Anyone can write to the lobby. A listing that says the game has
  // started must not make the service put up another one. The host lists
  // its game again within 5 s.
  const mqtt = await MqttClient.connect(WS_URL);
  mqtt.publish(`doomq/lobby/${new URL(href).searchParams.get("game")}`, JSON.stringify({ state: "playing" }), { retain: true });
  await sleep(2_000);
  mqtt.close();
  assert.equal(service.output.match(/lobby: arena/g).length, 1, service.output);
  const join = await page.waitForSelector(`${arena} >>> a`);
  await Promise.all([page.waitForNavigation(), join.click()]);

  // The game starts by itself some seconds after a player joined
  await until("the game to start", () => page.lines.some((line) => line.startsWith("doom: 10,")), 30_000);

  // Doom has no drop-in, so the next game waits already
  const lobby = await browser.newPage();
  await lobby.goto(`${WEB_URL}/index.html`);
  await lobby.waitForSelector(`${arena} >>> a`);
});
