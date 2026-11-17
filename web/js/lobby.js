import { MqttClient } from "./mqtt.js";
import { MAPS, MAX_PLAYERS, MODES, SKILLS, brokerUrl, link, newGameId, parseListing, topics } from "./doomq.js";

// Hosts refresh their listing every 5 s, so a quiet one is gone
const STALE_AFTER = 15_000;

const $ = (selector) => document.querySelector(selector);
const games = new Map(); // id -> { game, seen }

function element(tag, text, attrs = {}) {
  const el = Object.assign(document.createElement(tag), attrs);
  if (text !== undefined) el.textContent = text;
  return el;
}

function fillSelect(select, options, selected) {
  for (const [value, label] of options) select.append(element("option", label, { value, selected: String(value) === String(selected) }));
}

function render() {
  const rows = [...games.entries()]
    .sort(([, a], [, b]) => a.game.title.localeCompare(b.game.title))
    .map(([id, { game }]) => {
      const joinable = game.state === "waiting" && game.players < MAX_PLAYERS;
      const action = joinable
        ? element("a", "Join", { href: link("play.html", { game: id }), className: "button" })
        : element("span", game.state === "playing" ? "In progress" : "Full", { className: "muted" });
      const tr = element("tr");
      tr.append(
        element("td", game.title.slice(0, 40)),
        element("td", game.host.slice(0, 20)),
        element("td", MODES[game.mode]),
        element("td", game.map),
        element("td", SKILLS[game.skill - 1]),
        element("td", `${game.players}/${MAX_PLAYERS}`),
        element("td"),
      );
      tr.lastChild.append(action);
      return tr;
    });
  $("#games tbody").replaceChildren(...rows);
  $("#empty").hidden = rows.length > 0;
}

function setStatus(text, ok = false) {
  $("#status").textContent = text;
  $("#status").classList.toggle("ok", ok);
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
  location.href = link("play.html", {
    game: newGameId(),
    host: 1,
    title: fields.title.value.trim() || `${name.value.trim() || "Marine"}'s game`,
    mode: fields.mode.value,
    skill: fields.skill.value,
    map: fields.map.value,
    monsters: fields.monsters.checked ? 1 : 0,
  });
});

try {
  const mqtt = await MqttClient.connect(brokerUrl);
  mqtt.onclose = () => setStatus("Disconnected from broker, reload to retry");
  mqtt.onmessage = (topic, payload) => {
    const id = topic.split("/")[2];
    const game = parseListing(payload);
    if (game) games.set(id, { game, seen: performance.now() });
    else games.delete(id);
    render();
  };
  await mqtt.subscribe(topics.lobby);
  setStatus("Connected", true);

  // Clear listings whose host vanished without its last will firing,
  // e.g. when the broker restarted
  setInterval(() => {
    for (const [id, { seen }] of games) {
      if (performance.now() - seen < STALE_AFTER) continue;
      games.delete(id);
      mqtt.publish(topics.listing(id), "", { retain: true });
    }
    render();
  }, 5_000);
} catch (error) {
  setStatus(error.message);
}
render();
