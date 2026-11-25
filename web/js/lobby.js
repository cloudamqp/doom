import { MqttClient } from "./mqtt.js";
import {
  MAPS,
  MAX_GAMES,
  MODES,
  SKILLS,
  brokerUrl,
  deleteSave,
  isGameId,
  link,
  newGameId,
  parseListing,
  parseSave,
  setStatus,
  show,
  topics,
  view,
} from "./doomq.js";
import { downloads, watchProgress } from "./files.js";
import { burn } from "./fire.js";

// Hosts refresh their listing every 5 s, so a quiet one is gone
const STALE_AFTER = 15_000;
// Saves are for picking a game up again later today, not for keeping
const SAVE_TTL = 24 * 60 * 60_000;
const MAX_SAVES_SHOWN = 20;

const $ = (selector) => document.querySelector(selector);
const games = new Map(); // id -> { game, seen }
const saves = new Map(); // id -> save summary
const resumes = new Map(); // save id -> id of the game that resumes it
const fire = burn($(".hero .fire"));
let mqtt;
let pruning;
let leaving = false; // a game opened in this page

function keep(known, id, value) {
  if (known.has(id) || known.size < MAX_GAMES) known.set(id, value);
}

function element(tag, text, attrs = {}) {
  const el = Object.assign(document.createElement(tag), attrs);
  if (text !== undefined) el.textContent = text;
  return el;
}

function fillSelect(select, options, selected) {
  for (const [value, label] of options) select.append(element("option", label, { value, selected: String(value) === String(selected) }));
}

function row(cells, ...actions) {
  const tr = element("tr");
  tr.append(...cells.map((text) => element("td", text)), element("td"));
  tr.lastChild.append(...actions);
  return tr;
}

// Join while there's room, spectate in game until it starts, then watch from
// above, unless the host keeps the game to the players
function gameActions(id, game) {
  const watchable = game.spectators !== false;
  const button = (text, query, className = "button in-page") => element("a", text, { href: link("./", query), className });
  const actions = [];
  if (game.state === "waiting") {
    if (game.players < game.maxPlayers) actions.push(button("Join", { game: id }));
    if (watchable) actions.push(button("Spectate", { game: id, spectate: 1 }, "button watch in-page"));
  } else if (watchable) {
    actions.push(button("Watch", { watch: id }, "button watch in-page"));
  }
  return actions.length ? actions : [element("span", game.state === "waiting" ? "Full" : "Playing", { className: "muted" })];
}

// Leaves the rows alone unless they changed, as listings come again every
// 5 s, so that a click on one isn't lost
function replaceRows(tbody, rows) {
  if (tbody.innerHTML !== rows.map((tr) => tr.outerHTML).join("")) tbody.replaceChildren(...rows);
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
      const cells = [game.title, game.host, MODES[game.mode], game.map, SKILLS[game.skill - 1]];
      return row([...cells.map((text) => text.slice(0, 40)), `${game.players}/${game.maxPlayers}`], ...gameActions(id, game));
    });
  replaceRows($("#games tbody"), gameRows);
  $("#empty").hidden = gameRows.length > 0;

  // A game that is still running, or already being resumed, can't be resumed
  const busy = new Set([...games.entries()].flatMap(([id, { game }]) => [id, game.resumedFrom]));
  const saveRows = [...saves.entries()]
    .filter(([id]) => !busy.has(id))
    .sort(([, a], [, b]) => b.savedAt - a.savedAt)
    .slice(0, MAX_SAVES_SHOWN)
    .map(([id, save]) => {
      if (!resumes.has(id)) resumes.set(id, newGameId());
      const resume = element("a", "Resume", {
        href: link("./", { game: resumes.get(id), host: 1, resume: id }),
        className: "button in-page",
      });
      const cells = [save.title, save.host, MODES[save.mode], save.map];
      return row([...cells.map((text) => text.slice(0, 40)), String(save.players), ago(save.savedAt)], resume);
    });
  replaceRows($("#saves tbody"), saveRows);
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
  open(link("./", {
    game: newGameId(),
    host: 1,
    title: fields.title.value.trim() || `${name.value.trim() || "Marine"}'s game`,
    mode: fields.mode.value,
    skill: fields.skill.value,
    map: fields.map.value,
    monsters: fields.monsters.checked ? 1 : 0,
    spectators: fields.spectators.checked ? 1 : 0,
  }));
});

// Games open in this page, where Doom is downloading or already downloaded,
// and so do spectators' views, which draw maps from Doom's files
function open(href) {
  history.pushState(null, "", href);
  leaving = true;
  fire.stop();
  clearInterval(pruning);
  if (mqtt) {
    mqtt.onclose = () => {};
    mqtt.close();
  }
  scrollTo(0, 0);
  show(view());
}

document.addEventListener("click", (event) => {
  const a = event.target.closest("a.in-page");
  // Other clicks open a new tab as usual
  if (!a || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  open(a.href);
});

// Starts a game right away, with the settings in the form for new games
$("#watch-all").href = link("./", { watch: "" });

$("#quick").addEventListener("submit", (event) => {
  event.preventDefault();
  form.requestSubmit();
});

// Doom downloads while people look around, games start right away after
const preload = $("#preload");
const [preloadText, preloadBar] = preload.children;
const unwatch = watchProgress(({ received, total, downloading }) => {
  if (!downloading) return;
  preload.className = "downloading";
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
    if (!isGameId(id)) return;
    if (kind === "lobby") {
      const game = parseListing(payload);
      if (game) keep(games, id, { game, seen: performance.now() });
      else games.delete(id);
    } else {
      const save = parseSave(payload);
      if (save && !expire(id, save)) keep(saves, id, save);
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
