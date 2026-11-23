// What the lobby and the games share: the broker, links and the page around
// them. protocol.js has what they share with every other peer.

import config from "./config.js";
import { MAPS, MODES } from "./protocol.js";

export * from "./protocol.js";

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
