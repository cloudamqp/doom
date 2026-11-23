import { MqttClient } from "./mqtt.js";
import {
  MAPS,
  MODES,
  SKILLS,
  brokerUrl,
  deleteSave,
  link,
  newGameId,
  parseListing,
  parseSave,
  setStatus,
  showGame,
  topics,
} from "./doomq.js";
import { downloads, watch } from "./files.js";
import { burn } from "./fire.js";

// Hosts refresh their listing every 5 s, so a quiet one is gone
const STALE_AFTER = 15_000;
// Saves are for picking a game up again later today, not for keeping
const SAVE_TTL = 24 * 60 * 60_000;
const MAX_SAVES_SHOWN = 20;

const $ = (selector) => document.querySelector(selector);
const games = new Map(); // id -> { game, seen }
const saves = new Map(); // id -> save summary
const fire = burn($(".hero .fire"));
let mqtt;
let pruning;
let leaving = false; // a game opened in this page

function element(tag, text, attrs = {}) {
  const el = Object.assign(document.createElement(tag), attrs);
  if (text !== undefined) el.textContent = text;
  return el;
}

function fillSelect(select, options, selected) {
  for (const [value, label] of options) select.append(element("option", label, { value, selected: String(value) === String(selected) }));
}

function row(cells, action) {
  const tr = element("tr");
  tr.append(...cells.map((text) => element("td", text)), element("td"));
  tr.lastChild.append(action);
  return tr;
}

function ago(time) {
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return "just now";
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
}

function render() {
  const gameRows = [...games.entries()]
    .sort(([, a], [, b]) => a.game.title.localeCompare(b.game.title))
    .map(([id, { game }]) => {
      const joinable = game.state === "waiting" && game.players < game.maxPlayers;
      const action = joinable
        ? element("a", "Join", { href: link("./", { game: id }), className: "button play" })
        : element("span", game.state === "playing" ? "In progress" : "Full", { className: "muted" });
      const cells = [game.title, game.host, MODES[game.mode], game.map, SKILLS[game.skill - 1]];
      return row([...cells.map((text) => text.slice(0, 40)), `${game.players}/${game.maxPlayers}`], action);
    });
  $("#games tbody").replaceChildren(...gameRows);
  $("#empty").hidden = gameRows.length > 0;

  // A game that is still running, or already being resumed, can't be resumed
  const busy = new Set([...games.entries()].flatMap(([id, { game }]) => [id, game.resumedFrom]));
  const saveRows = [...saves.entries()]
    .filter(([id]) => !busy.has(id))
    .sort(([, a], [, b]) => b.savedAt - a.savedAt)
    .slice(0, MAX_SAVES_SHOWN)
    .map(([id, save]) => {
      const resume = element("a", "Resume", {
        href: link("./", { game: newGameId(), host: 1, resume: id }),
        className: "button play",
      });
      const cells = [save.title, save.host, MODES[save.mode], save.map];
      return row([...cells.map((text) => text.slice(0, 40)), String(save.players), ago(save.savedAt)], resume);
    });
  $("#saves tbody").replaceChildren(...saveRows);
  $("#saved").hidden = saveRows.length === 0;
}

const name = $("#name");
name.value = localStorage.getItem("doomq:name") ?? "";
name.addEventListener("input", () => localStorage.setItem("doomq:name", name.value.trim()));

const form = $("#create");
const fields = form.elements;
fillSelect(fields.mode, Object.entries(MODES), "deathmatch");
fillSelect(fields.skill, SKILLS.map((label, i) => [i + 1, label]), 3);
fillSelect(fields.map, MAPS.map((m) => [m, m]), "E1M1");
form.addEventListener("submit", (event) => {
  event.preventDefault();
  play(link("./", {
    game: newGameId(),
    host: 1,
    title: fields.title.value.trim() || `${name.value.trim() || "Marine"}'s game`,
    mode: fields.mode.value,
    skill: fields.skill.value,
    map: fields.map.value,
    monsters: fields.monsters.checked ? 1 : 0,
  }));
});

// Games open in this page, where Doom is downloading or already downloaded
function play(href) {
  history.pushState(null, "", href);
  leaving = true;
  fire.stop();
  clearInterval(pruning);
  if (mqtt) {
    mqtt.onclose = () => {};
    mqtt.close();
  }
  showGame(true);
  scrollTo(0, 0);
  import("./play.js");
}

document.addEventListener("click", (event) => {
  const a = event.target.closest("a.play");
  // Other clicks open a new tab as usual
  if (!a || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  play(a.href);
});

$(".actions .button").addEventListener("click", (event) => {
  event.preventDefault();
  form.scrollIntoView({ behavior: "smooth", block: "center" });
  fields.title.focus({ preventScroll: true });
});

// Doom downloads while people look around, games start right away after
const preload = $("#preload");
const [preloadText, preloadBar] = preload.children;
const unwatch = watch(({ received, total }) => {
  preloadText.textContent = `Downloading Doom: ${(received / 1e6).toFixed(1)}${total ? ` of ${(total / 1e6).toFixed(1)}` : ""} MB`;
  if (total) Object.assign(preloadBar, { max: total, value: received });
});
downloads.then(
  () => {
    unwatch();
    preloadText.textContent = "Doom is ready to play";
    preload.className = "ready";
  },
  () => {
    unwatch();
    preloadText.textContent = "Doom didn't download, reload the page to try again";
    preload.className = "failed";
  },
);

async function listen() {
  mqtt = await MqttClient.connect(brokerUrl);
  if (leaving) return mqtt.close();
  mqtt.onclose = () => setStatus("Disconnected from broker, reload to retry");

  // Every visitor helps keep the broker tidy
  const expire = (id, save) => {
    if (Date.now() - save.savedAt < SAVE_TTL) return false;
    saves.delete(id);
    deleteSave(mqtt, id);
    return true;
  };

  mqtt.onmessage = (topic, payload) => {
    fire.flare(); // fed by the broker
    const [, kind, id] = topic.split("/");
    if (kind === "lobby") {
      const game = parseListing(payload);
      if (game) games.set(id, { game, seen: performance.now() });
      else games.delete(id);
    } else {
      const save = parseSave(payload);
      if (save && !expire(id, save)) saves.set(id, save);
      else saves.delete(id);
    }
    render();
  };
  await Promise.all([mqtt.subscribe(topics.lobby), mqtt.subscribe(topics.saves)]);
  if (leaving) return;
  setStatus("Connected", true);

  // Clear listings whose host vanished without its last will firing,
  // e.g. when the broker restarted
  pruning = setInterval(() => {
    for (const [id, { seen }] of games) {
      if (performance.now() - seen < STALE_AFTER) continue;
      games.delete(id);
      mqtt.publish(topics.listing(id), "", { retain: true });
    }
    for (const [id, save] of saves) expire(id, save);
    render();
  }, 5_000);
}

listen().catch((error) => leaving || setStatus(error.message));
render();
