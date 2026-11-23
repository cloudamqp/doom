import { MqttClient } from "./mqtt.js";
import {
  MAX_PLAYERS,
  MODES,
  SERVER_ID,
  brokerUrl,
  deleteSave,
  doomArgs,
  gunzip,
  gzip,
  isGameId,
  link,
  modeArgs,
  newPeerId,
  parseListing,
  parseSave,
  readSaveHeader,
  setStatus,
  settingsFromQuery,
  topics,
} from "./doomq.js";
import { downloads, watchProgress } from "./files.js";
import { burn } from "./fire.js";
import { stopMusic } from "./music.js";

// Doom peers send a keepalive at least every 2 s
const PRESENCE_WINDOW = 5_000;
const ANNOUNCE_INTERVAL = 5_000;
const AUTOSAVE_INTERVAL = 120_000;
// Doom's settings (volume, keys, mouse, ...), kept between visits
const SETTINGS = ["default.cfg", "doomq.cfg"];
// Every player loads a resumed game from this slot, -loadgame 0
const RESUME_FILE = "saves/doomsav0.dsg";

const $ = (selector) => document.querySelector(selector);
const query = new URLSearchParams(location.search);
const gameId = query.get("game");
const hosting = query.has("host");
const resumeId = query.get("resume");
const playerName = (localStorage.getItem("doomq:name") || "Marine").slice(0, 20);
const peerId = hosting ? SERVER_ID : newPeerId();

// NET_PACKET_TYPE_DISCONNECT, see doom/src/net_defs.h
const DISCONNECT = Uint8Array.of(0, 8);
const inboxPrefix = topics.packet(gameId, peerId, "");

const inbox = [];
const lastSeen = new Map(); // peer -> time of its last packet, the host counts players with it
const waiting = new Map(); // topic -> callback for its retained message
let error = "The game crashed.";

const fire = burn($("#loading .fire"));

// Shown over the screen until Doom draws on it
function loaded() {
  $("#loading").hidden = true;
  fire.stop();
}

function fail(message) {
  $("#message").textContent = message;
  $("#overlay").hidden = false;
  loaded();
  document.exitPointerLock?.();
}

function loading(text, done, total) {
  $("#loading-text").textContent = text;
  const bar = $("#loading progress");
  if (total) Object.assign(bar, { max: total, value: done });
  else bar.removeAttribute("value");
}

const megabytes = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

function describe(game) {
  $("#title").textContent = game.title;
  $("#details").textContent = `${MODES[game.mode]} · ${game.map} · ${game.players}/${game.maxPlayers} players`;
}

function receive(topic, payload) {
  waiting.get(topic)?.(payload);
  if (topic === topics.listing(gameId)) {
    // Guests follow the host's listing
    const game = parseListing(payload);
    if (game) describe(game);
    else fail("The host left the game.");
  } else if (topic.startsWith(inboxPrefix)) {
    const from = Number(topic.slice(inboxPrefix.length));
    if (!Number.isInteger(from) || from < 1 || from > 0xffffffff) return;
    inbox.push({ from, data: payload });
    lastSeen.set(from, performance.now());
  }
}

const unpack = (data) =>
  gunzip(data).catch(() => {
    throw new Error("The saved game is damaged.");
  });

// The retained message on a topic, or null if there is none
function retained(mqtt, topic, timeout = 5_000) {
  return new Promise((resolve) => {
    const done = (payload) => {
      clearTimeout(timer);
      waiting.delete(topic);
      resolve(payload?.length ? payload : null);
    };
    const timer = setTimeout(done, timeout, null);
    waiting.set(topic, done);
    mqtt.subscribe(topic).catch(() => done(null));
  });
}

async function host(mqtt) {
  let settings = settingsFromQuery(query);
  let maxPlayers = MAX_PLAYERS;
  let resumedFrom;
  let args = doomArgs(settings);
  const files = {};

  if (resumeId) {
    const [summary, data] = await Promise.all([
      retained(mqtt, topics.save(resumeId)),
      retained(mqtt, topics.saveData(resumeId)),
    ]);
    const save = summary && parseSave(summary);
    if (!save || !data) throw new Error("The saved game is gone.");
    files[RESUME_FILE] = await unpack(data);
    const { title, mode, skill, map, monsters, players } = save;
    settings = { title, mode, skill, map, monsters };
    maxPlayers = players;
    resumedFrom = resumeId;
    // Doom starts by itself once as many players as saved have joined.
    // With fewer, the missing players' marines leave the game.
    args = [...modeArgs(settings), "-loadgame", "0", "-nodes", String(players)];
  }

  let state = "waiting";
  const players = () => {
    for (const [peer, seen] of lastSeen) {
      if (performance.now() - seen > PRESENCE_WINDOW) lastSeen.delete(peer);
    }
    return 1 + lastSeen.size;
  };
  const announce = () => {
    const game = { ...settings, host: playerName, players: players(), maxPlayers, state, resumedFrom };
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
    args: ["-server", "-servername", settings.title, ...args],
    files,
    hint: resumeId
      ? `The game starts once ${maxPlayers} players have joined, or press Space to start now.`
      : "Press Space in the waiting room once everyone has joined.",
    started() {
      state = "playing";
      announce();
      setInterval(() => Module._G_AutoSave(), AUTOSAVE_INTERVAL);
    },
    // Every player saved the same tic, the host shares its copy
    async saved(data) {
      const header = readSaveHeader(data);
      if (!header) return;
      settings = { ...settings, skill: header.skill, map: header.map };
      const summary = { ...settings, host: playerName, players: header.players, savedAt: Date.now() };
      mqtt.publish(topics.saveData(gameId), await gzip(data), { retain: true });
      mqtt.publish(topics.save(gameId), JSON.stringify(summary), { retain: true });
      // The resumed game carries on from here
      if (resumedFrom) deleteSave(mqtt, resumedFrom);
      resumedFrom = undefined;
      announce();
    },
  };
}

async function guest(mqtt) {
  const listing = await retained(mqtt, topics.listing(gameId));
  const game = listing && parseListing(listing);
  if (!game) throw new Error("No such game.");
  if (game.state !== "waiting") throw new Error("The game has already started.");

  const files = {};
  if (game.resumedFrom) {
    const data = await retained(mqtt, topics.saveData(game.resumedFrom));
    if (!data) throw new Error("The saved game is gone.");
    files[RESUME_FILE] = await unpack(data);
  }
  return { args: ["-connect", String(SERVER_ID)], files, hint: "The host starts the game once everyone has joined." };
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

function startDoom(mqtt, role, { js, wasm, wad }) {
  let running = false;
  const saveSettings = () => {
    if (!running) return; // before Doom has read them, this would reset them
    Module._M_SaveDefaults();
    storeSettings(Module.FS);
  };
  addEventListener("visibilitychange", () => document.hidden && saveSettings());
  addEventListener("pagehide", saveSettings);
  $("#hint").textContent = role.hint;
  loading("Starting Doom…");

  window.Module = {
    arguments: [
      ...["-iwad", "freedoom1.wad", "-config", "default.cfg", "-extraconfig", "doomq.cfg", "-savedir", "saves"],
      ...["-window", "-nogui", "-pet", playerName, ...role.args],
    ],
    canvas: $("#canvas"),
    // What spectators see, see doom/src/doom/d_watch.c and watch.js
    onWatch: hosting ? (watch) => mqtt.publish(topics.watch(gameId), JSON.stringify(watch)) : undefined,
    // Compiled by files.js while the page waited
    instantiateWasm(imports, receive) {
      WebAssembly.instantiate(wasm, imports).then((instance) => receive(instance, wasm));
      return {};
    },
    preRun: [
      () => {
        const { FS } = Module;
        FS.writeFile("freedoom1.wad", wad, { canOwn: true });
        restoreSettings(FS);
        FS.mkdir("saves");
        for (const [path, data] of Object.entries(role.files)) FS.writeFile(path, data);
      },
    ],
    // Doom reports progress as "doom: <code>, <text>" lines on stdout
    print(line) {
      console.log(line);
      // Next comes the waiting room
      if (line.startsWith("NET_Init:")) loaded();
      if (line.startsWith("doom: 10,")) {
        running = true;
        stopMusic(); // Doom plays its own
        $("#hint").hidden = true;
        role.started?.();
      }
      const saved = line.match(/^doom: 13, saved (.+)$/);
      if (saved) role.saved?.(Module.FS.readFile(saved[1]));
    },
    printErr: (line) => console.warn(line),
    // Called by I_Error, see doom/src/i_system.c
    onError(message) {
      error = message.replace(/^doom: \d+, /, "").trim();
    },
    onExit: (status) => {
      // Quitting saved the settings, an error didn't
      if (status === 0) storeSettings(Module.FS);
      running = false;
      fail(status === 0 ? "You left the game." : error);
    },
    // Used by doom/src/net_mqtt.c
    net: {
      connected: () => mqtt.connected,
      send: (to, data) => mqtt.publish(topics.packet(gameId, to, peerId), data),
      recv: () => inbox.shift(),
    },
  };
  document.body.append(Object.assign(document.createElement("script"), { text: `${js}\n//# sourceURL=doom.js` }));
}

for (const a of document.querySelectorAll(".back")) a.href = link("./");

if (!isGameId(gameId) || (resumeId !== null && !isGameId(resumeId))) {
  fail("No such game.");
} else {
  try {
    const unwatch = watchProgress(({ received, total, downloading }) => {
      if (!downloading || received === total) return; // done in the lobby, or kept from a visit before
      loading(`Downloading Doom… ${megabytes(received)}${total ? ` of ${megabytes(total)}` : ""}`, received, total);
    });
    // The broker publishes this when the connection drops without a goodbye,
    // as when the tab closes. The host's clears its listing, a guest's tells
    // the Doom server that the guest left, before the others wait 10 s for
    // the guest to time out.
    const will = hosting
      ? { topic: topics.listing(gameId), payload: "", retain: true }
      : { topic: topics.packet(gameId, SERVER_ID, peerId), payload: DISCONNECT };
    const mqtt = await MqttClient.connect(brokerUrl, { will });
    mqtt.onmessage = receive;
    setStatus("Connected", true);
    mqtt.onclose = () => {
      setStatus("Disconnected");
      fail("Lost connection to the broker.");
    };
    await mqtt.subscribe(topics.inbox(gameId, peerId));
    const role = await (hosting ? host(mqtt) : guest(mqtt));
    const doom = await downloads;
    unwatch();
    startDoom(mqtt, role, doom);
    $("#canvas").focus();
  } catch (error) {
    fail(error.message);
  }
}
