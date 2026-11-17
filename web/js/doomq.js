// What the lobby and the game page share: topics, game settings and links.
//
//   doomq/lobby/<game>               retained game listing, owned by the host
//   doomq/games/<game>/<to>/<from>   Doom packets between peers
//
// The host runs the Doom server in its browser and is always peer 1.

import config from "./config.js";
import { randomHex } from "./mqtt.js";

export const SERVER_ID = 1;
export const MAX_PLAYERS = 4;

export const topics = {
  lobby: "doomq/lobby/+",
  listing: (game) => `doomq/lobby/${game}`,
  inbox: (game, peer) => `doomq/games/${game}/${peer}/+`,
  packet: (game, to, from) => `doomq/games/${game}/${to}/${from}`,
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

// Lobby listings come from the network: accept only well-formed ones
export function parseListing(payload) {
  try {
    const game = JSON.parse(new TextDecoder().decode(payload));
    const valid =
      typeof game.title === "string" &&
      typeof game.host === "string" &&
      game.mode in MODES &&
      SKILLS[game.skill - 1] !== undefined &&
      MAPS.includes(game.map) &&
      Number.isInteger(game.players) &&
      ["waiting", "playing"].includes(game.state);
    return valid ? game : null;
  } catch {
    return null;
  }
}

export function doomArgs(settings) {
  const [, episode, map] = settings.map.match(/E(\d)M(\d)/);
  const args = ["-skill", String(settings.skill), "-warp", episode, map];
  if (settings.mode !== "coop") args.push(`-${settings.mode}`);
  if (!settings.monsters) args.push("-nomonsters");
  return args;
}
