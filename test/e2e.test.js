// Plays through the lobby and games in Chrome.
// Needs the web app and a broker running: docker compose up --build
// The hidden tab test also needs a display: xvfb-run npm test
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import puppeteer from "puppeteer";

const WEB_URL = process.env.WEB_URL ?? "http://localhost:8080";

let browser;

before(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
});

after(() => browser?.close());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every player gets its own browser profile, like separate machines
async function player(name, from = browser) {
  const context = await from.createBrowserContext();
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

const listing = (title) => `::-p-xpath(//tbody/tr[td[1][text()="${title}"]])`;

async function waitForLine(page, prefix, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!page.lines.some((line) => line.startsWith(prefix))) {
    assert.ok(Date.now() < deadline, `no "${prefix}" line in:\n${page.lines.join("\n")}`);
    await sleep(100);
  }
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

// The host creates a game in the lobby, the guest joins and the host starts it
async function startGame(host, guest, title) {
  await createGame(host, title);
  const join = await guest.waitForSelector(`${listing(title)} >>> a`);
  await Promise.all([guest.waitForNavigation(), join.click()]);
  await host.waitForFunction(() => document.querySelector("#details").textContent.includes("2/4 players"));

  await launch(host);
  await waitForLine(guest, "doom: 10,");
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

  const lobby = await player("Watcher");
  const row = await lobby.waitForSelector(listing(title));
  assert.match(await row.evaluate((tr) => tr.innerText), /2\/4\tIn progress/);

  // Doom has no drop-in, the server turns late joiners away
  await lobby.goto(guest.url());
  await lobby.waitForSelector("#overlay:not([hidden])");
  assert.match(await lobby.$eval("#message", (p) => p.textContent), /could not join/);
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
    // A throttled host manages about 3 packets per second
    assert.ok((await received()) > 300, `guest received ${await received()} packets in 10 s`);
  } finally {
    await headful.close();
  }
});
