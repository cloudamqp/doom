// Plays through the lobby and a game in headless Chrome.
// Needs the web app and a broker running: docker compose up --build
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import puppeteer from "puppeteer";

const WEB_URL = process.env.WEB_URL ?? "http://localhost:8080";

let browser;

before(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
});

after(() => browser?.close());

// Every player gets its own browser profile, like separate machines
async function player(name) {
  const context = await browser.createBrowserContext();
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
  await createGame(host, title);

  const join = await guest.waitForSelector(`${listing(title)} >>> a`);
  await Promise.all([guest.waitForNavigation(), join.click()]);
  await host.waitForFunction(() => document.querySelector("#details").textContent.includes("2/4 players"));

  await host.focus("#canvas");
  await host.keyboard.press("Space");
  await Promise.all([waitForLine(host, "doom: 10,"), waitForLine(guest, "doom: 10,")]);

  // The lockstep game only advances while ticcmds flow both ways, about
  // one packet per tic (35 Hz) in each direction. A stalled game only
  // sends a keepalive every 2 s.
  const packets = (page) => page.evaluate(() => Module.net.received);
  const countPackets = (page) =>
    page.evaluate(() => {
      const recv = Module.net.recv;
      Module.net.received = 0;
      Module.net.recv = () => {
        const packet = recv();
        if (packet) Module.net.received++;
        return packet;
      };
    });
  await Promise.all([countPackets(host), countPackets(guest)]);
  await guest.focus("#canvas");
  await guest.keyboard.down("KeyW");
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  await guest.keyboard.up("KeyW");
  const [hostPackets, guestPackets] = await Promise.all([packets(host), packets(guest)]);
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
