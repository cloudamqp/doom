// What's on the broker right now, for the pages about DooMQ: from the retained
// listings on doomq/lobby/+, as the lobby reads them.

import { MqttClient } from "./mqtt.js";
import { MAX_GAMES, brokerUrl, link, parseListing, setStatus, topics } from "./doomq.js";

// Every player sends the host a packet a tic, and the host sends one back
const PACKETS_PER_GUEST = 2 * 35;

const games = new Map(); // id -> listing

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function render() {
  const playing = [...games.values()].filter((game) => game.state === "playing");
  const players = playing.reduce((sum, game) => sum + game.players, 0);
  const packets = playing.reduce((sum, game) => sum + PACKETS_PER_GUEST * (game.players - 1), 0);
  const now = document.querySelector("#now");
  now.hidden = false;
  now.textContent = playing.length
    ? `Right now: ${plural(playing.length, "game")} in progress, ${plural(players, "player")}, about ${packets} Doom packets a second through the broker. Counted from the retained listings on doomq/lobby/+.`
    : "No games in progress right now. The lobby lists them from the retained messages on doomq/lobby/+.";
}

for (const a of document.querySelectorAll('a[href="./"]')) a.href = link("./");

try {
  const mqtt = await MqttClient.connect(brokerUrl);
  setStatus("Connected", true);
  mqtt.onclose = () => setStatus("Disconnected from broker");
  mqtt.onmessage = (topic, payload) => {
    const game = parseListing(payload);
    const id = topic.split("/")[2];
    if (game && (games.has(id) || games.size < MAX_GAMES)) games.set(id, game);
    else games.delete(id);
    render();
  };
  await mqtt.subscribe(topics.lobby);
  render();
} catch (error) {
  setStatus(error.message);
}
