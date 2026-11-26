// What every DooMQ peer shares, in a browser or not: topics, game settings
// and what travels in the retained messages.
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

import { randomHex } from "./mqtt.js";

export const SERVER_ID = 1;
// Every in-game spectator listens here, see doom/src/net_mqtt.h
export const SPECTATORS = 0;
// Deathmatch takes eight players, co-op maps have starts for four, see
// doom/src/doom/doomdef.h
export const MAX_PLAYERS = 8;
export const maxPlayersFor = (mode) => (mode === "coop" ? 4 : MAX_PLAYERS);
// Savegames hold eight players since deathmatch took eight: older ones
// don't load
export const SAVE_FORMAT = 2;

// For how long peers try to get a lost connection to the broker back, as
// when the broker restarts. Doom drops a peer it hasn't heard from for 10 s,
// and gives a host that long too.
export const RECONNECT_FOR = 8_000;
export const HOST_TIMEOUT = 10_000;

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
// Bots are players of their own that a bot service sends into games whose
// listing asks for them, see doom/native/lobby.c
export const BOTS = [0, 1, 2, 3];
export const BOT_SKILLS = ["Clumsy", "Slow", "Decent", "Sharp", "Ruthless"];
export const MAPS = [1, 2, 3, 4].flatMap((e) => Array.from({ length: 9 }, (_, m) => `E${e}M${m + 1}`));

// Anyone can publish listings and saves, also for games that don't exist:
// pages keep track of this many, and leave the rest
export const MAX_GAMES = 100;

export const newGameId = () => randomHex(6);
export const isGameId = (id) => /^[0-9a-f]{12}$/.test(id ?? "");

// Players get ids from 2 to 2^31 - 1, spectators the same plus 2^31, so the
// host can tell them apart
const SPECTATOR_BIT = 0x80000000;
export const newPeerId = (spectator = false) =>
  (spectator ? SPECTATOR_BIT : 0) + 2 + (crypto.getRandomValues(new Uint32Array(1))[0] % (SPECTATOR_BIT - 2));
export const isSpectator = (peer) => peer >= SPECTATOR_BIT;
// The sender is a topic level: anything can stand there
export const isPeerId = (peer) => Number.isInteger(peer) && peer >= 1 && peer <= 0xffffffff;

function parseJson(payload) {
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
}

// Bots print titles and names to a terminal, which control characters steer
const text = (value) => typeof value === "string" && !/\p{Cc}/u.test(value);

// What listings and saves have in common
function validGame(game) {
  return (
    text(game?.title) &&
    text(game.host) &&
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
  const valid =
    validGame(save) &&
    save.format === SAVE_FORMAT &&
    save.players >= 1 &&
    save.players <= maxPlayersFor(save.mode) &&
    Number.isFinite(save.savedAt);
  return valid ? save : null;
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
// skill, episode, map and which of the eight players were in the game
export function readSaveHeader(data) {
  if (data.length < 43 + MAX_PLAYERS) return null;
  return { skill: data[40] + 1, map: `E${data[41]}M${data[42]}`, players: data.slice(43, 43 + MAX_PLAYERS).filter(Boolean).length };
}

// Whether a savegame is the one a listing or a save's summary describes,
// with that many players. Doom starts a resumed game with the players the
// lobby counted, and takes their marines from the save.
export function saveMatches(data, { skill, map }, players) {
  const header = readSaveHeader(data);
  return header?.skill === skill && header.map === map && header.players === players;
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
