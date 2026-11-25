// Plays through the lobby and games in Chrome.
// Needs the web app and a broker running: docker compose up --build
// The hidden tab test also needs a display: xvfb-run npm test
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import puppeteer from "puppeteer";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { gunzipSync, gzipSync } from "node:zlib";
import { MqttClient } from "../web/js/mqtt.js";

const WEB_URL = process.env.WEB_URL ?? "http://localhost:8080";
const BROKER_URL = process.env.BROKER_URL ?? "ws://guest:guest@localhost:15672/mqtt";

let browser;

before(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
});

after(() => browser?.close());

// Players from earlier tests would keep playing, and slow the later tests
const contexts = [];
afterEach(() => Promise.all(contexts.splice(0).map((context) => context.close().catch(() => {}))));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every player gets its own browser profile, like separate machines
async function player(name, from = browser) {
  const context = await from.createBrowserContext();
  contexts.push(context);
  const page = await context.newPage();
  page.lines = [];
  page.on("console", (message) => page.lines.push(message.text()));
  await page.goto(`${WEB_URL}/index.html`);
  await page.evaluate((name) => localStorage.setItem("doomq:name", name), name);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#status").textContent === "Connected");
  return page;
}

async function createGame(page, title, mode = "deathmatch") {
  await page.type("#create [name=title]", title);
  await page.select("#create [name=mode]", mode);
  await Promise.all([page.waitForNavigation(), page.click("#create button")]);
  await page.waitForFunction((title) => document.querySelector("#title").textContent === title, {}, title);
}

const listing = (title) => `::-p-xpath(//table[@id="games"]/tbody/tr[td[1][text()="${title}"]])`;
const savedGame = (title) => `::-p-xpath(//table[@id="saves"]/tbody/tr[td[1][text()="${title}"]])`;

async function waitForLine(player, prefix, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!player.lines.some((line) => line.startsWith(prefix))) {
    assert.ok(Date.now() < deadline, `no "${prefix}" line in:\n${player.lines.join("\n")}`);
    await sleep(100);
  }
}

// bin/bot.js as a child process, with the lines it has printed
function bot(...args) {
  const child = spawn("bin/bot.js", ["--broker", BROKER_URL, ...args], { cwd: new URL("..", import.meta.url) });
  child.lines = [];
  createInterface(child.stdout).on("line", (line) => child.lines.push(line));
  return child;
}

// Doom ignores keys until its waiting room is up, and Space starts the game
async function launch(host) {
  await host.bringToFront();
  await host.focus("#canvas");
  for (let tries = 0; !host.lines.some((line) => line.startsWith("doom: 10,")); tries++) {
    assert.ok(tries < 60, `the game did not start:\n${host.lines.join("\n")}`);
    await host.keyboard.press("Space");
    await sleep(250);
  }
}

// Doom only saves in a running level, right after loading one it doesn't
async function autosave(page) {
  for (let tries = 0; !page.lines.some((line) => line.startsWith("doom: 13,")); tries++) {
    assert.ok(tries < 40, `no save:\n${page.lines.join("\n")}`);
    await page.evaluate(() => Module._G_AutoSave());
    await sleep(250);
  }
}

async function join(guest, title) {
  const link = await guest.waitForSelector(`${listing(title)} >>> a`);
  await Promise.all([guest.waitForNavigation(), link.click()]);
}

// The host creates a game in the lobby, the guest joins and the host starts it
async function startGame(host, guest, title, mode) {
  await createGame(host, title, mode);
  await join(guest, title);
  await host.waitForFunction(() => document.querySelector("#details").textContent.includes("2/4 players"));

  await launch(host);
  await waitForLine(guest, "doom: 10,");
  for (const page of [host, guest]) assert.ok(await page.$eval("#loading", (div) => div.hidden), "still loading");
}

// The lockstep game only advances while ticcmds flow both ways, about one
// packet per tic (35 Hz) in each direction. A stalled game only sends a
// keepalive every 2 s. Returns a function that reads the count so far.
async function countPackets(page) {
  await page.evaluate(() => {
    const recv = Module.net.recv;
    Module.net.received = 0;
    Module.net.recv = () => {
      const packet = recv();
      if (packet) Module.net.received++;
      return packet;
    };
  });
  return () => page.evaluate(() => Module.net.received);
}

test("lobby lists games until their host goes away", async () => {
  const [alice, bob, lobby] = await Promise.all([player("Alice"), player("Bob"), player("Carol")]);
  const id = Date.now().toString(36);
  await createGame(alice, `Alice ${id}`);
  await createGame(bob, `Bob ${id}`, "coop");

  const row = await lobby.waitForSelector(listing(`Alice ${id}`));
  assert.match(await row.evaluate((tr) => tr.innerText), /Alice\tDeathmatch\tE1M1\tHurt me plenty\t1\/4\tJoin/);
  await lobby.waitForSelector(listing(`Bob ${id}`));

  // Closing the tab clears the listing on pagehide
  await bob.close();
  await lobby.waitForSelector(listing(`Bob ${id}`), { hidden: true });

  // A crashed tab never says goodbye, the broker publishes its last will
  const cdp = await alice.createCDPSession();
  cdp.send("Page.crash").catch(() => {});
  await lobby.waitForSelector(listing(`Alice ${id}`), { hidden: true });
});

test("players join a game and play it over MQTT", async () => {
  const [host, guest] = await Promise.all([player("Host"), player("Guest")]);
  const title = `Game ${Date.now().toString(36)}`;
  await startGame(host, guest, title);

  const received = await Promise.all([countPackets(host), countPackets(guest)]);
  await guest.focus("#canvas");
  await guest.keyboard.down("KeyW");
  await sleep(3_000);
  await guest.keyboard.up("KeyW");
  const [hostPackets, guestPackets] = await Promise.all(received.map((count) => count()));
  assert.ok(hostPackets > 35, `host received ${hostPackets} packets`);
  assert.ok(guestPackets > 35, `guest received ${guestPackets} packets`);
  // Reading how it works mid-game doesn't end the game
  assert.equal(await guest.$eval(".bar a.nav", (a) => a.target), "_blank");

  const lobby = await player("Watcher");
  const row = await lobby.waitForSelector(listing(title));
  assert.match(await row.evaluate((tr) => tr.innerText), /2\/4\tWatch/);

  // Doom has no drop-in
  await lobby.goto(guest.url());
  await lobby.waitForSelector("#overlay:not([hidden])");
  assert.match(await lobby.$eval("#message", (p) => p.textContent), /already started/);
});

// Where a player's marine is on the page's screen, read as bots read the
// world: see doom/src/doom/b_bot.c for the records
function marine(page, player) {
  return page.evaluate((player) => {
    const SIZE = 15;
    const things = Module._B_Things() >> 2;
    for (let at = things + 1; at < things + 1 + Module.HEAP32[things] * SIZE; at += SIZE) {
      const [, , x, y] = Module.HEAP32.subarray(at, at + SIZE);
      if (Module.HEAP32[at + 12] === player) return { x: x / 65536, y: y / 65536 };
    }
  }, player);
}

test("a bot joins a game and plays it", async (t) => {
  const host = await player("Host");
  const title = `Bots ${Date.now().toString(36)}`;
  await createGame(host, title, "coop");

  const marvin = bot("--name", "Marvin", new URL(host.url()).searchParams.get("game"));
  t.after(() => marvin.kill());
  await waitForLine(marvin, `Joining "${title}" on E1M1, hosted by Host`);
  await host.waitForFunction(() => document.querySelector("#details").textContent.includes("2/4 players"));
  await launch(host);
  await waitForLine(marvin, "Entering E1M1");

  // On the host's screen, the bot's marine runs off
  const start = await marine(host, 2);
  for (let far = 0, tries = 0; far < 512; tries++) {
    assert.ok(tries < 100, `the bot got ${far} units from where it started`);
    await sleep(250);
    const { x, y } = await marine(host, 2);
    far = Math.hypot(x - start.x, y - start.y);
  }

  // The game is over when its host leaves
  await host.close();
  assert.deepEqual(await once(marvin, "exit"), [0, null]);
});

test("a bot hosts a game that starts once its players are in", async (t) => {
  const title = `Hosted ${Date.now().toString(36)}`;
  const marvin = bot("--host", "--name", "Marvin", "--title", title, "--mode", "deathmatch", "--map", "E1M2");
  t.after(() => marvin.kill());
  await waitForLine(marvin, `Hosting "${title}" on E1M2`);

  const guest = await player("Guest");
  const row = await guest.waitForSelector(listing(title));
  assert.match(await row.evaluate((tr) => tr.innerText), /Marvin\tDeathmatch\tE1M2\tHurt me plenty\t1\/2\tJoin/);
  await join(guest, title);
  // Nobody presses Space: two players were asked for
  await waitForLine(guest, "doom: 10,");
  await waitForLine(marvin, "Entering E1M2");

  const lobby = await player("Watcher");
  const started = await lobby.waitForSelector(listing(title));
  assert.match(await started.evaluate((tr) => tr.innerText), /2\/2\tWatch/);

  // Spectators see a bot's game as any other
  const watch = await lobby.waitForSelector(`${listing(title)} >>> a.watch`);
  await Promise.all([lobby.waitForNavigation(), watch.click()]);
  await lobby.waitForFunction(() => document.querySelectorAll(".match tbody tr").length === 2);
  const names = await lobby.$$eval(".match tbody tr", (rows) => rows.map((tr) => tr.cells[0].textContent));
  assert.deepEqual(names.sort(), ["Guest", "Marvin"]);
  await lobby.goto(`${WEB_URL}/index.html`);
  await lobby.waitForSelector(listing(title));

  // A host that is killed takes its listing with it, by its last will
  marvin.kill("SIGKILL");
  await lobby.waitForSelector(listing(title), { hidden: true });
  await guest.waitForSelector("#overlay:not([hidden])");
});

test("a player who closes the tab doesn't stall the others", async () => {
  const [host, bob, carol] = await Promise.all([player("Host"), player("Bob"), player("Carol")]);
  const title = `Leaving ${Date.now().toString(36)}`;
  await createGame(host, title);
  await Promise.all([join(bob, title), join(carol, title)]);
  await host.waitForFunction(() => document.querySelector("#details").textContent.includes("3/4 players"));
  await launch(host);
  await Promise.all([waitForLine(bob, "doom: 10,"), waitForLine(carol, "doom: 10,")]);
  await sleep(1_000);

  // Doom would wait for Carol's moves until she times out, 10 s, and send
  // Bob a keepalive now and then. A game going on sends him 35 a second.
  const received = await countPackets(bob);
  await carol.close();
  await sleep(3_000);
  const packets = await received();
  assert.ok(packets > 45, `Bob received ${packets} packets in 3 s`);
});

test("a bot that is killed doesn't stall the others", async (t) => {
  const [host, bob] = await Promise.all([player("Host"), player("Bob")]);
  const title = `Killed ${Date.now().toString(36)}`;
  await createGame(host, title);
  const marvin = bot("--name", "Marvin", new URL(host.url()).searchParams.get("game"));
  t.after(() => marvin.kill());
  await Promise.all([join(bob, title), waitForLine(marvin, "Joining")]);
  await host.waitForFunction(() => document.querySelector("#details").textContent.includes("3/4 players"));
  await launch(host);
  await Promise.all([waitForLine(bob, "doom: 10,"), waitForLine(marvin, "Entering E1M1")]);
  await sleep(1_000);

  // As with a closed tab: the broker says the bot's goodbye for it
  const received = await countPackets(bob);
  marvin.kill("SIGKILL");
  await sleep(3_000);
  const packets = await received();
  assert.ok(packets > 45, `Bob received ${packets} packets in 3 s`);
});

test("spectators watch a game from above, with the scores", async () => {
  const [host, guest] = await Promise.all([player("Hanna"), player("Ozzy")]);
  const title = `Watched ${Date.now().toString(36)}`;
  await startGame(host, guest, title);

  const fan = await player("Fan");
  const watch = await fan.waitForSelector(`${listing(title)} >>> a.watch`);
  await Promise.all([fan.waitForNavigation(), watch.click()]);
  await fan.waitForFunction(() => document.querySelectorAll(".match tbody tr").length === 2);
  const names = await fan.$$eval(".match tbody tr", (rows) => rows.map((tr) => tr.cells[0].textContent));
  assert.deepEqual(names.sort(), ["Hanna", "Ozzy"]);
  assert.equal(await fan.$eval(".match thead th:nth-child(2)", (th) => th.textContent), "Frags");

  // The map, and the marines on it
  await fan.waitForFunction(() => document.querySelector(".match .banner").hidden, { timeout: 30_000 });
  const pixels = await fan.$eval(".match canvas", (canvas) => {
    const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    return data.filter((value, i) => i % 4 === 3 && value > 0).length;
  });
  assert.ok(pixels > 1000, `${pixels} pixels drawn`);

  await host.close();
  await fan.waitForFunction(() => document.querySelector(".match .banner").textContent === "Game over");
});

test("spectators learn when a host doesn't share its game", async () => {
  const host = await player("Hermit");
  const title = `Private ${Date.now().toString(36)}`;
  await createGame(host, title);
  // As a host on a build from before spectators, once Doom runs
  await host.waitForFunction(() => document.querySelector("#loading").hidden);
  await host.evaluate(() => (Module.onWatch = undefined));
  await launch(host);

  const fan = await player("Fan");
  const watch = await fan.waitForSelector(`${listing(title)} >>> a.watch`);
  await Promise.all([fan.waitForNavigation(), watch.click()]);
  await fan.waitForSelector(".match .banner");
  await fan.waitForFunction(
    () => document.querySelector(".match .banner").textContent === "This game's host doesn't share it with spectators",
    { timeout: 20_000 },
  );
});

// Doom only takes spectators before the game starts: wait until the host's
// server talks to this one, it sends waiting room news every second
async function spectate(fan, title) {
  // Found and clicked at once, as the row is redrawn when players join
  const click = (title) => {
    const row = [...document.querySelectorAll("#games tbody tr")].find((tr) => tr.cells[0].textContent === title);
    const link = [...(row?.querySelectorAll("a") ?? [])].find((a) => a.textContent === "Spectate");
    link?.click();
    return link;
  };
  await Promise.all([fan.waitForNavigation(), fan.waitForFunction(click, {}, title)]);
  await fan.waitForFunction(() => window.Module?.net);
  const received = await countPackets(fan);
  for (let tries = 0; (await received()) < 2; tries++) {
    assert.ok(tries < 100, `the server never answered:\n${fan.lines.join("\n")}`);
    await sleep(100);
  }
}

// What the host's Doom server sends, by recipient, over some time
async function hostPackets(host, ms) {
  const game = new URL(host.url()).searchParams.get("game");
  const mqtt = await MqttClient.connect(BROKER_URL);
  const sent = new Map();
  mqtt.onmessage = (topic) => {
    const to = Number(topic.split("/")[3]);
    sent.set(to, (sent.get(to) ?? 0) + 1);
  };
  await mqtt.subscribe(`doomq/games/${game}/+/1`);
  await sleep(ms);
  mqtt.close();
  return sent;
}

test("spectators watch in Doom, all from one copy of the game", async () => {
  const [host, guest, ann, ben] = await Promise.all([player("Hanna"), player("Ozzy"), player("Ann"), player("Ben")]);
  const title = `Spectated ${Date.now().toString(36)}`;
  await createGame(host, title);
  await join(guest, title);
  await Promise.all([spectate(ann, title), spectate(ben, title)]);
  // Spectators aren't players
  await host.waitForFunction(() => document.querySelector("#details").textContent.includes("2/4 players"));
  await launch(host);
  await Promise.all([guest, ann, ben].map((page) => waitForLine(page, "doom: 10,")));
  assert.equal(await ann.$eval("#hint", (p) => p.textContent), "You're spectating.");
  await sleep(1_000);

  // The host sends the game to where all spectators listen, peer 0, once,
  // and to each of them only now and then
  const received = await Promise.all([ann, ben].map(countPackets));
  const sent = await hostPackets(host, 3_000);
  const toGuest = Math.max(...[...sent].filter(([to]) => to > 1 && to < 2 ** 31).map(([, count]) => count));
  const toEach = [...sent].filter(([to]) => to >= 2 ** 31).map(([, count]) => count);
  assert.ok(toGuest > 90, `${toGuest} packets to the guest in 3 s`);
  assert.ok(Math.abs(sent.get(0) - toGuest) < 15, `${sent.get(0)} packets to spectators, ${toGuest} to the guest`);
  assert.ok(toEach.every((count) => count < 10), `${toEach} packets to each spectator`);
  for (const count of await Promise.all(received.map((count) => count()))) {
    assert.ok(count > 90, `a spectator received ${count} packets in 3 s`);
  }
});

test("a spectator who falls behind doesn't hold up the game", async () => {
  const [host, guest, fan] = await Promise.all([player("Hanna"), player("Ozzy"), player("Fan")]);
  const title = `Slow fan ${Date.now().toString(36)}`;
  await createGame(host, title);
  await join(guest, title);
  await spectate(fan, title);
  await launch(host);
  await Promise.all([waitForLine(guest, "doom: 10,"), waitForLine(fan, "doom: 10,")]);
  await sleep(1_000);

  // As a phone that suspends the tab: no acknowledgements, no keepalives
  const cdp = await fan.createCDPSession();
  await cdp.send("Debugger.enable");
  await cdp.send("Debugger.pause");
  const received = await countPackets(guest);
  await sleep(4_000);
  const packets = await received();
  await cdp.send("Debugger.resume");
  assert.ok(packets > 120, `the guest received ${packets} packets in 4 s`);
});

test("a host can keep a game to its players", async () => {
  const [host, lobby] = await Promise.all([player("Hermit"), player("Fan")]);
  const title = `Players only ${Date.now().toString(36)}`;
  await host.click("#create [name=spectators]");
  await createGame(host, title);

  const row = await lobby.waitForSelector(listing(title));
  assert.match(await row.evaluate((tr) => tr.innerText), /1\/4\tJoin$/);
  await lobby.goto(`${WEB_URL}/?game=${new URL(host.url()).searchParams.get("game")}&spectate`);
  await lobby.waitForSelector("#overlay:not([hidden])");
  assert.equal(await lobby.$eval("#message", (p) => p.textContent), "This game's host doesn't let anyone watch.");

  await lobby.goto(`${WEB_URL}/index.html`);
  await host.waitForFunction(() => document.querySelector("#loading").hidden);
  await launch(host);
  // No watching from above either
  await lobby.waitForFunction(
    (title) => [...document.querySelectorAll("#games tbody tr")].some((tr) => tr.cells[0].textContent === title && tr.innerText.endsWith("1/4\tPlaying")),
    {},
    title,
  );
});

test("a player far away doesn't slow the game down", async () => {
  const [host, guest] = await Promise.all([player("Stockholm"), player("Auckland")]);
  // About 310 ms there and back, give or take 100 ms, in order as over TCP
  await guest.evaluateOnNewDocument(() => {
    const delay = () => 155 + Math.random() * 100;
    const wait = setInterval(() => {
      if (!window.Module?.net) return;
      clearInterval(wait);
      const { send, recv } = Module.net;
      const held = [];
      let sent = 0;
      let received = 0;
      Module.net.send = (to, data) => {
        sent = Math.max(sent, performance.now() + delay());
        setTimeout(() => send(to, data), sent - performance.now());
      };
      Module.net.recv = () => {
        for (let packet; (packet = recv()); ) held.push({ packet, at: (received = Math.max(received, performance.now() + delay())) });
        return held[0]?.at <= performance.now() ? held.shift().packet : undefined;
      };
    }, 50);
  });
  await guest.reload();
  await guest.waitForFunction(() => document.querySelector("#status").textContent === "Connected");
  await startGame(host, guest, `Far away ${Date.now().toString(36)}`);

  // How fast the game goes, as spectators see it, once its clocks settled
  const game = new URL(host.url()).searchParams.get("game");
  const mqtt = await MqttClient.connect(BROKER_URL);
  const snapshots = [];
  mqtt.onmessage = (topic, payload) => snapshots.push([performance.now(), JSON.parse(new TextDecoder().decode(payload)).time]);
  await mqtt.subscribe(`doomq/watch/${game}`);
  await sleep(5_000);
  snapshots.length = 0;
  await sleep(10_000);
  mqtt.close();
  const [[start, from], [end, to]] = [snapshots[0], snapshots.at(-1)];
  const speed = (to - from) / ((end - start) / 1000);
  assert.ok(speed > 33, `${speed.toFixed(1)} tics a second, full speed is 35`);
});

test("the pages about DooMQ count what's on the broker", async () => {
  const [host, guest] = await Promise.all([player("Hanna"), player("Ozzy")]);
  await startGame(host, guest, `Counted ${Date.now().toString(36)}`);

  const context = await browser.createBrowserContext();
  contexts.push(context);
  const reader = await context.newPage();
  await reader.goto(`${WEB_URL}/index.html`);
  await Promise.all([reader.waitForNavigation(), reader.click(".bar a.nav")]);
  assert.equal(new URL(reader.url()).pathname, "/how.html");
  for (const page of ["how.html", "why-mqtt.html"]) {
    await reader.goto(`${WEB_URL}/${page}`);
    await reader.waitForSelector("#now:not([hidden])");
    assert.match(await reader.$eval("#now", (p) => p.textContent), /^Right now: \d+ games? in progress, \d+ players/);
  }
});

test("a saved game can be resumed", async () => {
  const [host, guest, lobby] = await Promise.all([player("Hanna"), player("Gus"), player("Lou")]);
  const title = `Saved ${Date.now().toString(36)}`;
  await host.select("#create [name=map]", "E1M3");
  await startGame(host, guest, title, "coop");

  // The page autosaves every 2 minutes, every player saves the same tic
  const mqtt = await MqttClient.connect(BROKER_URL);
  const shared = new Promise((resolve) => (mqtt.onmessage = resolve));
  await mqtt.subscribe(`doomq/saves/${new URL(host.url()).searchParams.get("game")}`);
  await autosave(host);
  await Promise.all([waitForLine(guest, "doom: 13,"), shared]);
  mqtt.close();
  await Promise.all([host.close(), guest.close()]);

  // Once the game is over the lobby offers to resume it
  const save = await lobby.waitForSelector(savedGame(title));
  assert.match(await save.evaluate((tr) => tr.innerText), /Hanna\tCo-op\tE1M3\t2\t/);
  const savedId = await save.$eval("a", (a) => new URL(a.href).searchParams.get("resume"));
  await Promise.all([lobby.waitForNavigation(), save.$eval("a", (a) => a.click())]);
  await lobby.waitForFunction(() => document.querySelector("#details").textContent.endsWith("1/2 players"));

  // It starts by itself once as many players as saved have joined
  const latecomer = await player("Gil");
  await latecomer.waitForSelector(savedGame(title), { hidden: true });
  await join(latecomer, title);
  await Promise.all([waitForLine(lobby, "doom: 10,"), waitForLine(latecomer, "doom: 10,")]);
  assert.match(await lobby.$eval("#details", (p) => p.textContent), /E1M3 · 2\/2 players/);

  // Its first save replaces the one it was resumed from
  await autosave(lobby);
  const watcher = await player("Wes");
  await sleep(1_000);
  const resumable = await watcher.$$eval("#saves a", (links) => links.map((a) => new URL(a.href).searchParams.get("resume")));
  assert.ok(!resumable.includes(savedId), "the old save is still there");
});

// Hosts a game, changes its save on the broker, and resumes it. Returns
// what the player is told.
async function resumeDamaged(damage) {
  const [host, lobby] = await Promise.all([player("Breaker"), player("Lou")]);
  const title = `Broken ${Date.now().toString(36)}`;
  await createGame(host, title, "coop");
  await launch(host);

  const game = new URL(host.url()).searchParams.get("game");
  const mqtt = await MqttClient.connect(BROKER_URL);
  const stored = new Promise((resolve) => (mqtt.onmessage = (topic, payload) => resolve(payload)));
  await mqtt.subscribe(`doomq/savedata/${game}`);
  await autosave(host);
  const data = gunzipSync(await stored);
  await host.close(); // no more saves to overwrite this one
  damage(data);
  mqtt.publish(`doomq/savedata/${game}`, gzipSync(data), { retain: true });
  mqtt.close();

  // Doom's error, not the shutdown messages that follow it on stderr
  const save = await lobby.waitForSelector(savedGame(title));
  await Promise.all([lobby.waitForNavigation(), save.$eval("a", (a) => a.click())]);
  await lobby.waitForSelector("#overlay:not([hidden])", { timeout: 30_000 });
  return lobby.$eval("#message", (p) => p.textContent);
}

test("Doom's errors reach the player", async () => {
  // The save's end of file marker, its last byte
  assert.equal(await resumeDamaged((data) => (data[data.length - 1] ^= 0xff)), "Bad savegame");
});

// Anyone can publish a save. Doom uses much of one as indexes into its own
// tables, and checks them as it reads them.
test("a save can't point Doom outside the game", async () => {
  // After the 50 byte header, padded to 52: the first player's marine, then
  // the player's state, one of three
  assert.equal(await resumeDamaged((data) => (data[56] = 99)), "Bad savegame: player state 99");
});

// Anyone can publish listings, also for games that don't exist
test("a flood of listings doesn't grow the pages without end", async () => {
  const fake = { title: "Flood", host: "Nobody", mode: "coop", skill: 3, map: "E1M1", monsters: true, players: 1, maxPlayers: 4, state: "playing" };
  const ids = Array.from({ length: 150 }, (_, i) => i.toString(16).padStart(12, "f"));
  const mqtt = await MqttClient.connect(BROKER_URL);
  const publish = (payload) => ids.forEach((id) => mqtt.publish(`doomq/lobby/${id}`, payload, { retain: true }));
  publish(JSON.stringify(fake));

  try {
    const lobby = await player("Lou");
    await lobby.waitForFunction(() => document.querySelectorAll("#games tbody tr").length >= 100);
    await sleep(500);
    assert.equal(await lobby.$$eval("#games tbody tr", (rows) => rows.length), 100);

    await Promise.all([lobby.waitForNavigation(), lobby.click("#watch-all")]);
    await lobby.waitForFunction(() => document.querySelectorAll(".match").length >= 24);
    await sleep(500);
    assert.equal(await lobby.$$eval(".match", (matches) => matches.length), 24);
  } finally {
    publish("");
    mqtt.close();
  }
});

test("a game carries on with the download the lobby started", async () => {
  const host = await player("Quick");
  const files = [];
  host.on("request", (request) => {
    const file = new URL(request.url()).pathname.split("/").pop();
    if (["doom.js", "doom.wasm", "freedoom1.wad"].includes(file)) files.push(file);
  });
  // Not kept from the visit before, and slow enough to open the game halfway through
  await host.evaluate(() => caches.delete("doomq"));
  const cdp = await host.createCDPSession();
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: 10e6, uploadThroughput: 10e6 });
  await host.reload();
  await host.waitForFunction(() => document.querySelector("#preload").textContent.startsWith("Downloading Doom: "));

  await createGame(host, `Quick ${Date.now().toString(36)}`);
  assert.match(await host.$eval("#loading-text", (p) => p.textContent), /^(Downloading Doom… |Connecting)/);
  await launch(host);
  assert.deepEqual(files.sort(), ["doom.js", "doom.wasm", "freedoom1.wad"]);
});

test("the lobby keeps Doom for the next visit", async () => {
  const page = await player("Returning");
  await page.waitForSelector("#preload.ready");
  const files = [];
  page.on("request", (request) => {
    const file = new URL(request.url()).pathname.split("/").pop();
    if (["doom.js", "doom.wasm", "freedoom1.wad"].includes(file)) files.push(file);
  });
  await page.reload();
  await page.waitForSelector("#preload.ready");
  assert.deepEqual(files, []);
});

test("a name and Enter start a game", async () => {
  const host = await player("Speedy");
  await host.click("#name", { count: 3 });
  await host.type("#name", "Swift");
  await Promise.all([host.waitForNavigation(), host.keyboard.press("Enter")]);
  await host.waitForFunction(() => document.querySelector("#title").textContent === "Swift's game");
  assert.ok(new URL(host.url()).searchParams.has("host"));
});

test("music starts with the first click, at Doom's music volume", async () => {
  const page = await player("Listener");
  const paused = () => page.$eval("#music", (audio) => audio.paused);
  assert.ok(await paused(), "playing before anyone clicked");
  await page.click("#name");
  await page.waitForFunction(() => !document.querySelector("#music").paused);

  // Off in the lobby is off in the game too
  await page.click("#music-toggle");
  assert.ok(await paused());
  assert.match(await page.evaluate(() => localStorage.getItem("doomq:default.cfg")), /^music_volume\s+0$/m);
  await page.reload();
  await page.click("#name");
  await sleep(500);
  assert.ok(await paused(), "playing although turned off");
});

test("Doom settings outlive the page", async () => {
  const host = await player("Tweaker");
  const defaults = await (await fetch(`${WEB_URL}/default.cfg`)).text();
  const config = defaults.replace(/^music_volume\s+\d+$/m, "music_volume                  3");
  await host.evaluate((config) => localStorage.setItem("doomq:default.cfg", config), config);
  await createGame(host, `Settings ${Date.now().toString(36)}`);
  await launch(host);

  // Leaving saves what Doom has in memory, which it loaded from storage
  await host.goto(`${WEB_URL}/index.html`);
  const saved = await host.evaluate(() => [localStorage.getItem("doomq:default.cfg"), localStorage.getItem("doomq:doomq.cfg")]);
  assert.match(saved[0], /^music_volume\s+3$/m);
  assert.match(saved[1], /^player_name\s+"Tweaker"$/m);
});

test("a hidden tab keeps playing", { skip: !process.env.DISPLAY && "needs a display" }, async () => {
  // Muted, as Chrome spares tabs that play sound, and without the flags
  // Puppeteer adds to turn background throttling off
  const headful = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox", "--mute-audio"],
    ignoreDefaultArgs: [
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
  });
  try {
    const [host, guest] = await Promise.all([player("Hider", headful), player("Seeker", headful)]);
    await startGame(host, guest, `Hidden ${Date.now().toString(36)}`);

    await (await host.browserContext().newPage()).bringToFront();
    assert.equal(await host.evaluate(() => document.visibilityState), "hidden");
    const received = await countPackets(guest);
    await sleep(10_000);
    // At least half speed, a throttled host manages about 3 packets per second
    const packets = await received();
    assert.ok(packets > 175, `guest received ${packets} packets in 10 s`);
  } finally {
    await headful.close();
  }
});
