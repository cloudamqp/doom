// What the lobby and the game page share: topics, game settings and links.
//
//   doomq/lobby/<game>               retained game listing, owned by the host
//   doomq/games/<game>/<to>/<from>   Doom packets between peers
//   doomq/saves/<game>               retained summary of the game's last save
//   doomq/savedata/<game>            retained savegame file
//
// The host runs the Doom server in its browser and is always peer 1. It
// shares the game's saves, which a resumed game loads on every player's side.

import config from "./config.js";
import { randomHex } from "./mqtt.js";

export const SERVER_ID = 1;
export const MAX_PLAYERS = 4;

export const topics = {
  lobby: "doomq/lobby/+",
  listing: (game) => `doomq/lobby/${game}`,
  inbox: (game, peer) => `doomq/games/${game}/${peer}/+`,
  packet: (game, to, from) => `doomq/games/${game}/${to}/${from}`,
  saves: "doomq/saves/+",
  save: (game) => `doomq/saves/${game}`,
  saveData: (game) => `doomq/savedata/${game}`,
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

export const newGameId = () => randomHex(6);
export const isGameId = (id) => /^[0-9a-f]{12}$/.test(id ?? "");

// Any id but the server's
export const newPeerId = () => SERVER_ID + 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 0xfffffff0);

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

// A savegame starts with a 24 byte description and a 16 byte version, then
// skill, episode, map and which of the four players were in the game
export function readSaveHeader(data) {
  if (data.length < 47) return null;
  return { skill: data[40] + 1, map: `E${data[41]}M${data[42]}`, players: data.slice(43, 47).filter(Boolean).length };
}

// Savegames shrink to a fifth with gzip
const pipe = async (data, transform) => new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(transform)).arrayBuffer());
export const gzip = (data) => pipe(data, new CompressionStream("gzip"));
export const gunzip = (data) => pipe(data, new DecompressionStream("gzip"));

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
