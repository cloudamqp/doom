// What the lobby and the games share: topics, game settings and links.
//
//   doomq/lobby/<game>               retained game listing, owned by the host
//   doomq/games/<game>/<to>/<from>   Doom packets between peers, to 0 for
//                                    all spectators at once
//   doomq/saves/<game>               retained summary of the game's last save
//   doomq/savedata/<game>            retained savegame file
//   doomq/watch/<game>               what spectators see, a few times a second
//
// The host runs the Doom server in its browser and is always peer 1. It
// shares the game's saves, which a resumed game loads on every player's side,
// and what goes on in the game.

import config from "./config.js";
import { randomHex } from "./mqtt.js";

export const SERVER_ID = 1;
// Every in-game spectator listens here, see doom/src/net_mqtt.h
export const SPECTATORS = 0;
export const MAX_PLAYERS = 4;

export const topics = {
  lobby: "doomq/lobby/+",
  listing: (game) => `doomq/lobby/${game}`,
  inbox: (game, peer) => `doomq/games/${game}/${peer}/+`,
  packet: (game, to, from) => `doomq/games/${game}/${to}/${from}`,
  saves: "doomq/saves/+",
  save: (game) => `doomq/saves/${game}`,
  saveData: (game) => `doomq/savedata/${game}`,
  watching: "doomq/watch/+",
  watch: (game) => `doomq/watch/${game}`,
};

export const MODES = { coop: "Co-op", deathmatch: "Deathmatch", altdeath: "Deathmatch 2.0" };
export const SKILLS = ["I'm too young to die", "Hey, not too rough", "Hurt me plenty", "Ultra-Violence", "Nightmare!"];
export const MAPS = [1, 2, 3, 4].flatMap((e) => Array.from({ length: 9 }, (_, m) => `E${e}M${m + 1}`));

const params = new URLSearchParams(location.search);

// ?broker=wss://user:pass@host/mqtt overrides config.js, and sticks to links
export const brokerUrl = params.get("broker") ?? config.broker;

export function link(path, query = {}) {
  const url = new URL(path, location.href);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  if (params.has("broker")) url.searchParams.set("broker", brokerUrl);
  return url.href;
}

// The page shows the lobby, a game, or games for spectators, by its address.
// Returns the view's name, which is also its element's id and its script.
export function view(search = location.search) {
  const params = new URLSearchParams(search);
  return params.has("game") ? "game" : params.has("watch") ? "watch" : "lobby";
}

export function show(name) {
  for (const main of document.querySelectorAll("body > main")) main.hidden = main.id !== name;
  return import({ lobby: "./lobby.js", game: "./play.js", watch: "./watch.js" }[name]);
}

// The broker connection, in the page header
export function setStatus(text, ok = false) {
  const status = document.querySelector("#status");
  status.textContent = text;
  status.classList.toggle("ok", ok);
}

export const newGameId = () => randomHex(6);
export const isGameId = (id) => /^[0-9a-f]{12}$/.test(id ?? "");

// Players get ids from 2 to 2^31 - 1, spectators the same plus 2^31, so the
// host can tell them apart
const SPECTATOR_BIT = 0x80000000;
export const newPeerId = (spectator = false) =>
  (spectator ? SPECTATOR_BIT : 0) + 2 + (crypto.getRandomValues(new Uint32Array(1))[0] % (SPECTATOR_BIT - 2));
export const isSpectator = (peer) => peer >= SPECTATOR_BIT;

// Settings travel as query parameters from the lobby form to the host page
export function settingsFromQuery(query) {
  const mode = query.get("mode");
  const skill = Number(query.get("skill"));
  const map = query.get("map");
  return {
    title: (query.get("title") || "Untitled").slice(0, 40),
    mode: mode in MODES ? mode : "coop",
    skill: skill >= 1 && skill <= 5 ? skill : 3,
    map: MAPS.includes(map) ? map : "E1M1",
    monsters: query.get("monsters") !== "0",
    spectators: query.get("spectators") !== "0",
  };
}

function parseJson(payload) {
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
}

// What listings and saves have in common
function validGame(game) {
  return (
    typeof game?.title === "string" &&
    typeof game.host === "string" &&
    game.mode in MODES &&
    SKILLS[game.skill - 1] !== undefined &&
    MAPS.includes(game.map) &&
    typeof game.monsters === "boolean" &&
    (game.spectators === undefined || typeof game.spectators === "boolean") &&
    Number.isInteger(game.players)
  );
}

// Listings and saves come from the network: accept only well-formed ones
export function parseListing(payload) {
  const game = parseJson(payload);
  const valid =
    validGame(game) &&
    Number.isInteger(game.maxPlayers) &&
    ["waiting", "playing"].includes(game.state) &&
    (game.resumedFrom === undefined || isGameId(game.resumedFrom));
  return valid ? game : null;
}

export function parseSave(payload) {
  const save = parseJson(payload);
  return validGame(save) && save.players >= 1 && save.players <= MAX_PLAYERS && Number.isFinite(save.savedAt) ? save : null;
}

// What a host publishes for spectators, see doom/src/doom/d_watch.c
export function parseWatch(payload) {
  const watch = parseJson(payload);
  const numbers = (object, keys) => keys.every((key) => Number.isFinite(object[key]));
  const player = (p) =>
    Number.isInteger(p?.number) &&
    p.number >= 0 &&
    p.number < MAX_PLAYERS &&
    typeof p.name === "string" &&
    typeof p.dead === "boolean" &&
    numbers(p, ["x", "y", "angle", "health", "armor", "frags", "kills"]);
  const valid =
    MAPS.includes(watch?.map) &&
    ["level", "intermission", "finale", "demo"].includes(watch.state) &&
    numbers(watch, ["time"]) &&
    typeof watch.deathmatch === "boolean" &&
    Array.isArray(watch.players) &&
    watch.players.length <= MAX_PLAYERS &&
    watch.players.every(player) &&
    (watch.monsters === undefined || (Array.isArray(watch.monsters) && watch.monsters.every(Number.isFinite)));
  return valid ? watch : null;
}

// A savegame starts with a 24 byte description and a 16 byte version, then
// skill, episode, map and which of the four players were in the game
export function readSaveHeader(data) {
  if (data.length < 47) return null;
  return { skill: data[40] + 1, map: `E${data[41]}M${data[42]}`, players: data.slice(43, 47).filter(Boolean).length };
}

export function deleteSave(mqtt, game) {
  mqtt.publish(topics.save(game), "", { retain: true });
  mqtt.publish(topics.saveData(game), "", { retain: true });
}

export function modeArgs(settings) {
  const args = settings.mode === "coop" ? [] : [`-${settings.mode}`];
  if (!settings.monsters) args.push("-nomonsters");
  return args;
}

export function doomArgs(settings) {
  const [, episode, map] = settings.map.match(/E(\d)M(\d)/);
  return [...modeArgs(settings), "-skill", String(settings.skill), "-warp", episode, map];
}
