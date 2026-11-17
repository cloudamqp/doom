import { MqttClient } from "./mqtt.js";
import {
  MAX_PLAYERS,
  MODES,
  SERVER_ID,
  brokerUrl,
  doomArgs,
  link,
  newPeerId,
  parseListing,
  settingsFromQuery,
  topics,
} from "./doomq.js";

// Doom peers send a keepalive at least every 2 s
const PRESENCE_WINDOW = 5_000;
const ANNOUNCE_INTERVAL = 5_000;
// Doom's settings (volume, keys, mouse, ...), kept between visits
const SETTINGS = ["default.cfg", "doomq.cfg"];

const $ = (selector) => document.querySelector(selector);
const query = new URLSearchParams(location.search);
const gameId = query.get("game") ?? "";
const hosting = query.has("host");
const playerName = (localStorage.getItem("doomq:name") || "Marine").slice(0, 20);
const peerId = hosting ? SERVER_ID : newPeerId();

const inbox = [];
const lastSeen = new Map(); // peer -> time of its last packet, the host counts players with it
let lastError = "";

function fail(message) {
  $("#message").textContent = message;
  $("#overlay").hidden = false;
  document.exitPointerLock?.();
}

function describe(game) {
  $("#title").textContent = game.title;
  $("#details").textContent = `${MODES[game.mode]} · ${game.map} · ${game.players}/${MAX_PLAYERS} players`;
}

function receive(topic, payload) {
  if (topic === topics.listing(gameId)) {
    const game = parseListing(payload);
    if (game) describe(game);
    else fail("The host left the game.");
    return;
  }
  const from = Number(topic.slice(topic.lastIndexOf("/") + 1));
  if (!Number.isInteger(from) || from < 1 || from > 0xffffffff) return;
  inbox.push({ from, data: payload });
  lastSeen.set(from, performance.now());
}

function host(mqtt) {
  const settings = settingsFromQuery(query);
  let state = "waiting";

  const players = () => {
    for (const [peer, seen] of lastSeen) {
      if (performance.now() - seen > PRESENCE_WINDOW) lastSeen.delete(peer);
    }
    return 1 + lastSeen.size;
  };
  const announce = () => {
    const game = { ...settings, host: playerName, players: players(), state };
    describe(game);
    mqtt.publish(topics.listing(gameId), JSON.stringify(game), { retain: true });
  };

  announce();
  setInterval(announce, ANNOUNCE_INTERVAL);
  addEventListener("pagehide", () => {
    mqtt.publish(topics.listing(gameId), "", { retain: true });
    mqtt.close();
  });

  return {
    args: ["-server", "-servername", settings.title, ...doomArgs(settings)],
    started() {
      state = "playing";
      announce();
    },
  };
}

function restoreSettings(FS) {
  for (const file of SETTINGS) {
    try {
      const text = localStorage.getItem(`doomq:${file}`);
      if (text) FS.writeFile(file, text);
    } catch {}
  }
  if (!FS.analyzePath("default.cfg").exists) FS.createPreloadedFile("/", "default.cfg", "default.cfg", true, true);
}

// Doom itself only writes its settings when it quits
function storeSettings(FS) {
  for (const file of SETTINGS) {
    try {
      localStorage.setItem(`doomq:${file}`, FS.readFile(file, { encoding: "utf8" }));
    } catch {}
  }
}

function startDoom(mqtt, role) {
  let running = false;
  const saveSettings = () => {
    if (!running) return; // before Doom has read them, this would reset them
    Module._M_SaveDefaults();
    storeSettings(Module.FS);
  };
  addEventListener("visibilitychange", () => document.hidden && saveSettings());
  addEventListener("pagehide", saveSettings);

  window.Module = {
    arguments: [
      ...["-iwad", "freedoom1.wad", "-config", "default.cfg", "-extraconfig", "doomq.cfg"],
      ...["-window", "-nogui", "-pet", playerName, ...role.args],
    ],
    canvas: $("#canvas"),
    preRun: [
      () => {
        Module.FS.createPreloadedFile("/", "freedoom1.wad", "freedoom1.wad", true, false);
        restoreSettings(Module.FS);
      },
    ],
    // Doom reports progress as "doom: <code>, <text>" lines on stdout
    print(line) {
      console.log(line);
      if (line.startsWith("doom: 10,")) {
        running = true;
        $("#hint").hidden = true;
        role.started?.();
      }
    },
    printErr(line) {
      console.warn(line);
      if (line.trim()) lastError = line.replace(/^doom: \d+, /, "");
    },
    onExit: (status) => {
      // Quitting saved the settings, an error didn't
      if (status === 0) storeSettings(Module.FS);
      running = false;
      fail(status === 0 ? "You left the game." : lastError);
    },
    // Used by doom/src/net_mqtt.c
    net: {
      connected: () => mqtt.connected,
      send: (to, data) => mqtt.publish(topics.packet(gameId, to, peerId), data),
      recv: () => inbox.shift(),
    },
  };
  document.body.append(Object.assign(document.createElement("script"), { src: "doom.js" }));
}

for (const a of document.querySelectorAll(".back")) a.href = link("index.html");
$("#hint").textContent = hosting
  ? "Press Space in the waiting room once everyone has joined."
  : "The host starts the game once everyone has joined.";

if (!/^[0-9a-f]{12}$/.test(gameId)) {
  fail("No such game.");
} else {
  try {
    const will = hosting ? { topic: topics.listing(gameId), payload: "", retain: true } : undefined;
    const mqtt = await MqttClient.connect(brokerUrl, { will });
    mqtt.onmessage = receive;
    mqtt.onclose = () => fail("Lost connection to the broker.");
    await mqtt.subscribe(topics.inbox(gameId, peerId));
    if (!hosting) await mqtt.subscribe(topics.listing(gameId));
    startDoom(mqtt, hosting ? host(mqtt) : { args: ["-connect", String(SERVER_ID)] });
    $("#canvas").focus();
  } catch (error) {
    fail(error.message);
  }
}
