// Runs the native headless build of Doom, see doom/native/platform.c.
// Needs: make -C doom native, web/freedoom1.wad from bin/build.sh, and a
// broker with MQTT on TCP for the network games
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cutConnections } from "./broker.js";

const BOT = resolve("doom/build/native/doomq-bot");
const WAD = resolve("web/freedoom1.wad");
const MQTT_URL = process.env.MQTT_URL ?? "mqtt://guest:guest@localhost:1883";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const players = [];

after(() => players.forEach((player) => player.kill()));

// A player of a network game, its output so far is in .output
function play(game, args, { broker = MQTT_URL, env = {} } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "doomq-"));
  const player = spawn(BOT, ["-iwad", WAD, "-broker", broker, "-game", game, ...args], { cwd, env: { ...process.env, ...env } });
  player.output = "";
  player.stdout.on("data", (data) => (player.output += data));
  player.stderr.on("data", (data) => (player.output += data));
  players.push(player);
  return player;
}

async function waitForLine(player, line, timeout) {
  const deadline = Date.now() + timeout;
  while (!player.output.includes(line)) {
    assert.ok(Date.now() < deadline, `no "${line}" in:\n${player.output}`);
    await sleep(100);
  }
}

// Doom writes its settings to the working directory
const doom = (...args) => spawnSync(BOT, ["-iwad", WAD, ...args], { cwd: mkdtempSync(join(tmpdir(), "doomq-")), encoding: "utf8", timeout: 30_000 });

test("plays a demo without screen, sound or input", () => {
  const { stderr } = doom("-timedemo", "demo1");
  assert.match(stderr, /timed 7117 gametics/);
});

// E3M4 is a level that the bot knows every route of. On others, like E1M1,
// some players start where it has a hard time getting to.
test("a bot finds and frags a player that stands still", async () => {
  const game = randomBytes(6).toString("hex");
  const host = play(game, ["-server", "-nodes", "2", "-deathmatch", "-nomonsters", "-warp", "3", "4"]);
  await waitForLine(host, "NET_Init", 5_000);
  play(game, ["-connect", "1", "-bot", "5"]);

  await waitForLine(host, "doom: 14, player 2 fragged player 1", 60_000);
});

test("a game between bots carries on when the broker restarts", async () => {
  const game = randomBytes(6).toString("hex");
  const match = ["-bot", "5", "-deathmatch", "-nomonsters", "-warp", "3", "4"];
  const host = play(game, ["-server", "-nodes", "2", ...match]);
  await waitForLine(host, "NET_Init", 5_000);
  const guest = play(game, ["-connect", "1", ...match]);
  await waitForLine(host, "doom: 14,", 60_000);

  await cutConnections();
  await waitForLine(guest, "broker: back", 10_000);
  const before = host.output.length;
  await waitForLine({ get output() { return host.output.slice(before); } }, "doom: 14,", 60_000);
});

// A deathmatch of 5 minutes between bots, played in one process in a
// fraction of a second. Returns a line per player.
function simulate(skills, seed) {
  const { stdout } = doom("-sim", skills, "-simtime", "300", "-seed", seed, "-deathmatch", "-nomonsters", "-warp", "3", "4");
  return stdout.match(/^doom: 16, .*$/gm);
}

const frags = (line) => Number(line.match(/frags (-?\d+)/)[1]);

test("bots play each other in one process, the same game for the same seed", () => {
  const results = simulate("5,1", "7");

  assert.equal(results?.length, 2, "a line per player");
  assert.match(results[0], /^doom: 16, player 1 skill 5 frags -?\d+ deaths \d+$/);
  assert.match(results[1], /^doom: 16, player 2 skill 1 frags -?\d+ deaths \d+$/);
  assert.deepEqual(simulate("5,1", "7"), results);
});

test("a bot of a higher skill wins", () => {
  for (const skills of ["5,1", "5,3", "3,1"]) {
    let [better, worse] = [0, 0];
    for (const seed of ["1", "2", "3"]) {
      const results = simulate(skills, seed);
      better += frags(results[0]);
      worse += frags(results[1]);
    }
    assert.ok(better > 1.5 * worse, `skill ${skills}: ${better} to ${worse} frags over 3 games`);
  }
});

// The broker with TLS in front of it, as in production, and a certificate
// of its own making. Returns the port and the file to trust it with.
async function tlsBroker() {
  const dir = mkdtempSync(join(tmpdir(), "doomq-tls-"));
  const [key, cert] = [join(dir, "key.pem"), join(dir, "cert.pem")];
  const subject = ["-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"];
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert, ...subject], { stdio: "ignore" });
  const { hostname, port } = new URL(MQTT_URL);
  const server = tls.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (socket) => {
    const broker = net.connect(Number(port) || 1883, hostname);
    socket.pipe(broker).pipe(socket);
    for (const end of [socket, broker]) end.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, resolve));
  after(() => server.close());
  return { port: server.address().port, cert };
}

test("players connect to the broker over TLS, and only to one they can trust", async () => {
  const { port, cert } = await tlsBroker();
  const { username, password } = new URL(MQTT_URL);
  const broker = `mqtts://${username}:${password}@localhost:${port}`;
  const game = randomBytes(6).toString("hex");

  const host = play(game, ["-server", "-nodes", "2", "-deathmatch"], { broker, env: { SSL_CERT_FILE: cert } });
  await waitForLine(host, "NET_Init", 5_000);
  const guest = play(game, ["-connect", "1"], { broker, env: { SSL_CERT_FILE: cert } });
  await waitForLine(guest, "doom: 10,", 15_000);

  // Without the file, nothing vouches for the certificate
  const stranger = play(game, ["-connect", "1"], { broker });
  await waitForLine(stranger, "doom: 7, broker:", 5_000);
  assert.match(stranger.output, /certificate/);
});

// make -C doom native builds the bot's logic as a library too
const BOTLIB = resolve("doom/build/native/bot.so");
const count = (text, part) => text.split(part).length - 1;

test("a bot takes on new code while it plays", async () => {
  const lib = join(mkdtempSync(join(tmpdir(), "doomq-lib-")), "bot.so");
  copyFileSync(BOTLIB, lib);
  const game = randomBytes(6).toString("hex");
  const host = play(game, ["-server", "-nodes", "2", "-deathmatch", "-nomonsters", "-warp", "3", "4"]);
  await waitForLine(host, "NET_Init", 5_000);
  const bot = play(game, ["-connect", "1", "-bot", "5", "-bottrace", "-botlib", lib]);
  await waitForLine(host, "doom: 14, player 2 fragged player 1", 60_000);
  assert.equal(count(bot.output, "bot: loaded"), 1, bot.output);

  // A new build of the library, as make leaves it
  copyFileSync(BOTLIB, lib);
  const loaded = async (times) => {
    for (const deadline = Date.now() + 5_000; count(bot.output, "bot: loaded") < times; await sleep(100)) {
      assert.ok(Date.now() < deadline, bot.output);
    }
  };
  await loaded(2);

  // The new code plays: it tells what it is up to once a second, and
  // the game goes on in step, or Doom would have ended it
  const told = bot.output.length;
  await sleep(3_000);
  assert.match(bot.output.slice(told), /^bot 2: \d+s at /m);
  assert.equal(bot.exitCode, null, bot.output);
  assert.equal(host.exitCode, null, host.output);
});
