// Joins a DooMQ game as a guest, the way web/js/play.js does for a browser:
// Doom's packets travel as MQTT messages, see the topics in web/js/protocol.js.

import { MqttClient } from "../web/js/mqtt.js";
import { gunzip } from "../web/js/gzip.js";
import { SERVER_ID, newPeerId, parseListing, topics } from "../web/js/protocol.js";
import { startDoom } from "./doom.js";

// Where Doom looks for the save of a resumed game, -loadgame 0
const RESUME_FILE = "saves/doomsav0.dsg";
const LOBBY = topics.listing("");

const joinable = (game) => game?.state === "waiting" && game.players < game.maxPlayers;

// Joins the game with the given id, or else the first one in the lobby
// that waits for players, however long that takes. Resolves to Doom's exit
// status when the game is over.
//   broker  ws://user:pass@host:15672/mqtt
//   name    the player's name
//   bot     given Doom's module, returns what plays, see doom.js
//   say     is told what goes on, print gets Doom's output
export async function join({ broker, game: wanted, name, bot, say, print }) {
  const mqtt = await MqttClient.connect(broker);
  const peerId = newPeerId();
  const inbox = [];
  const retained = new Map(); // topic -> callback for its retained message
  let joined; // id of the game the bot is in
  let found; // callback for a game to join

  const over = Promise.withResolvers();
  mqtt.onclose = () => over.reject(new Error("Lost connection to the broker"));
  mqtt.onmessage = (topic, payload) => {
    retained.get(topic)?.(payload);
    if (topic.startsWith(LOBBY)) {
      const [id, game] = [topic.slice(LOBBY.length), parseListing(payload)];
      if (joinable(game) && (!wanted || id === wanted)) found?.({ id, ...game });
      // The host clears its listing as it leaves
      if (id === joined && !game) over.resolve(0);
    } else if (joined && topic.startsWith(topics.packet(joined, peerId, ""))) {
      inbox.push({ from: Number(topic.split("/").pop()), data: payload });
    }
  };

  say(wanted ? `Looking for game ${wanted}` : "Waiting in the lobby for a game to join");
  const listed = new Promise((resolve) => (found = resolve));
  await mqtt.subscribe(topics.lobby);
  const game = await Promise.race([listed, over.promise]);
  found = undefined;
  joined = game.id;
  say(`Joining "${game.title}" on ${game.map}, hosted by ${game.host}`);
  await mqtt.subscribe(topics.inbox(joined, peerId));

  // The retained message on a topic
  const fetch = (topic) =>
    new Promise((resolve) => {
      retained.set(topic, resolve);
      mqtt.subscribe(topic);
    });
  // A resumed game starts from the host's save on every player's side
  const files = game.resumedFrom ? { [RESUME_FILE]: await gunzip(await fetch(topics.saveData(game.resumedFrom))) } : {};

  await startDoom({
    args: ["-connect", String(SERVER_ID), "-pet", name, "-savedir", "saves"],
    files,
    bot,
    print,
    exited: over.resolve,
    net: {
      connected: () => mqtt.connected,
      send: (to, data) => mqtt.publish(topics.packet(joined, to, peerId), data),
      recv: () => inbox.shift(),
    },
  });
  return over.promise.finally(() => mqtt.close());
}
