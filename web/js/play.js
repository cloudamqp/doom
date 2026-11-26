import { MqttClient } from "./mqtt.js";
import {
  HOST_TIMEOUT,
  MODES,
  RECONNECT_FOR,
  SAVE_FORMAT,
  SERVER_ID,
  SPECTATORS,
  brokerUrl,
  deleteSave,
  doomArgs,
  isGameId,
  isPeerId,
  isSpectator,
  link,
  maxPlayersFor,
  modeArgs,
  newPeerId,
  parseListing,
  parseSave,
  readSaveHeader,
  saveMatches,
  setStatus,
  settingsFromQuery,
  topics,
} from "./doomq.js";
import { downloads, watchProgress } from "./files.js";
import { burn } from "./fire.js";
import { GOODBYE, holdGoodbyes } from "./goodbyes.js";
import { gunzip, gzip } from "./gzip.js";
import { stopMusic } from "./music.js";
import { onTouchScreen, touchControls } from "./touch.js";

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
const spectating = !hosting && query.has("spectate");
const resumeId = query.get("resume");
const playerName = (localStorage.getItem("doomq:name") || "Marine").slice(0, 20);
const peerId = hosting ? SERVER_ID : newPeerId(spectating);

// Spectators get the game itself where they all listen, the rest on their own
const inboxes = [peerId, ...(spectating ? [SPECTATORS] : [])].map((to) => topics.packet(gameId, to, ""));

const inbox = [];
// See goodbyes.js: guests whose goodbye the broker said as it shut down
const goodbyes = holdGoodbyes((packet) => inbox.push(packet));
let hostLeft; // timer, from when the host's listing went away
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
    clearTimeout(hostLeft);
    if (game) describe(game);
    // A broker that restarts clears the listing too, with the host's last
    // will. The host puts it back as soon as it is connected again.
    else hostLeft = setTimeout(fail, HOST_TIMEOUT, "The host left the game.");
  } else {
    const prefix = inboxes.find((inbox) => topic.startsWith(inbox));
    const from = prefix && Number(topic.slice(prefix.length));
    if (!isPeerId(from)) return;
    goodbyes.receive({ from, data: payload });
    if (!isSpectator(from)) lastSeen.set(from, performance.now());
  }
}

// The savegame of a game as described, with that many players. Anyone can
// publish one, so it isn't taken for more than it is.
async function unpack(data, game, players) {
  const save = await gunzip(data).catch(() => null);
  if (!save || !saveMatches(save, game, players)) throw new Error("The saved game is damaged.");
  return save;
}

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
  let maxPlayers = maxPlayersFor(settings.mode);
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
    files[RESUME_FILE] = await unpack(data, save, save.players);
    const { title, mode, skill, map, monsters, spectators = true, players } = save;
    settings = { title, mode, skill, map, monsters, spectators };
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
    // What spectators see from above, see doom/src/doom/d_watch.c and watch.js
    onWatch: settings.spectators ? (watch) => mqtt.publish(topics.watch(gameId), JSON.stringify(watch)) : undefined,
    files,
    hint: resumeId
      ? `The game starts once ${maxPlayers} players have joined, or press Space to start now.`
      : "Press Space in the waiting room once everyone has joined.",
    started() {
      state = "playing";
      announce();
      setInterval(() => Module._G_AutoSave(), AUTOSAVE_INTERVAL);
    },
    // The broker cleared the listing as the connection went
    reconnected: announce,
    // Every player saved the same tic, the host shares its copy
    async saved(data) {
      const header = readSaveHeader(data);
      if (!header) return;
      settings = { ...settings, skill: header.skill, map: header.map };
      const summary = { ...settings, host: playerName, players: header.players, savedAt: Date.now(), format: SAVE_FORMAT };
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
  if (!spectating && game.players >= game.maxPlayers) throw new Error("The game is full.");
  if (spectating && game.spectators === false) throw new Error("This game's host doesn't let anyone watch.");

  const files = {};
  if (game.resumedFrom) {
    const data = await retained(mqtt, topics.saveData(game.resumedFrom));
    if (!data) throw new Error("The saved game is gone.");
    files[RESUME_FILE] = await unpack(data, game, game.maxPlayers);
  }
  if (spectating) {
    return {
      args: ["-connect", String(SERVER_ID), "-drone"],
      files,
      hint: "You're spectating. The host starts the game once everyone has joined.",
      playingHint: "You're spectating.",
    };
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
  // On a phone the player's moves come from the screen, see touch.js
  const touch = !spectating && onTouchScreen() ? touchControls($("#touch"), () => window.Module) : undefined;
  $("#game").classList.toggle("touch", Boolean(touch));
  // Doom's waiting room starts the game with Space
  $("#touch [data-action=start]").hidden = !hosting;
  const saveSettings = () => {
    if (!running) return; // before Doom has read them, this would reset them
    Module._M_SaveDefaults();
    storeSettings(Module.FS);
  };
  addEventListener("visibilitychange", () => document.hidden && saveSettings());
  addEventListener("pagehide", saveSettings);
  $("#hint").textContent = touch && hosting ? "Tap Start once everyone has joined." : role.hint;
  loading("Starting Doom…");

  window.Module = {
    arguments: [
      ...["-iwad", "freedoom1.wad", "-config", "default.cfg", "-extraconfig", "doomq.cfg", "-savedir", "saves"],
      ...["-window", "-nogui", "-pet", playerName, ...role.args],
    ],
    canvas: $("#canvas"),
    bot: touch,
    onWatch: role.onWatch,
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
        $("#touch [data-action=start]").hidden = true;
        $("#hint").textContent = role.playingHint ?? "";
        $("#hint").hidden = !role.playingHint;
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
$("#game").classList.toggle("spectating", spectating);
// Leaving the page leaves the game, so the page's other links open beside it
for (const a of document.querySelectorAll(".bar a:not(.back), footer a")) a.target = "_blank";

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
      : { topic: topics.packet(gameId, SERVER_ID, peerId), payload: GOODBYE };
    // A broker that restarts is back within seconds: the game stands still
    // meanwhile, and Doom sends again what went missing
    const mqtt = await MqttClient.connect(brokerUrl, { will, retry: RECONNECT_FOR });
    let role;
    mqtt.onmessage = receive;
    setStatus("Connected", true);
    mqtt.ondrop = () => {
      setStatus("Reconnecting…");
      goodbyes.forget();
    };
    mqtt.onreconnect = () => {
      setStatus("Connected", true);
      role?.reconnected?.();
    };
    mqtt.onclose = () => {
      setStatus("Disconnected");
      fail("Lost connection to the broker.");
    };
    for (const to of [peerId, ...(spectating ? [SPECTATORS] : [])]) await mqtt.subscribe(topics.inbox(gameId, to));
    role = await (hosting ? host(mqtt) : guest(mqtt));
    const doom = await downloads;
    unwatch();
    startDoom(mqtt, role, doom);
    $("#canvas").focus();
  } catch (error) {
    fail(error.message);
  }
}
