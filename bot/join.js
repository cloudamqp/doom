// Joins a DooMQ game as a guest, the way web/js/play.js does for a browser:
// Doom's packets travel as MQTT messages, see the topics in web/js/protocol.js.

import { MqttClient } from "../web/js/mqtt.js";
import { gunzip } from "../web/js/gzip.js";
import { GOODBYE } from "../web/js/goodbyes.js";
import {
  HOST_TIMEOUT,
  RECONNECT_FOR,
  SERVER_ID,
  canJoin,
  isGameId,
  newPeerId,
  parseListing,
  saveMatches,
  topics,
} from "../web/js/protocol.js";
import { startDoom } from "./doom.js";
import { network } from "./net.js";

// Where Doom looks for the save of a resumed game, -loadgame 0
const RESUME_FILE = "saves/doomsav0.dsg";
const LOBBY = topics.listing("");

// Where Doom looks for the running game as it joins, see doom/src/doom/d_net.c
const JOIN_FILE = "join.dsg";

const joinable = (game) => game !== null && canJoin(game);

// Looks in the lobby for the game with the given id, or else the first one
// that players can join, however long that takes. Resolves to its listing
// with its id, and the save it starts from if it is a resumed one that waits
// for players.
async function find(broker, wanted) {
  const mqtt = await MqttClient.connect(broker);
  const found = Promise.withResolvers();
  const saves = new Map(); // topic -> callback for its retained message
  mqtt.onclose = () => found.reject(new Error("Lost connection to the broker"));
  mqtt.onmessage = (topic, payload) => {
    saves.get(topic)?.(payload);
    if (!topic.startsWith(LOBBY)) return;
    const [id, game] = [topic.slice(LOBBY.length), parseListing(payload)];
    if (isGameId(id) && joinable(game) && (!wanted || id === wanted)) found.resolve({ id, ...game });
  };
  await mqtt.subscribe(topics.lobby);
  const game = await found.promise;
  if (game.resumedFrom && game.state === "waiting") {
    const topic = topics.saveData(game.resumedFrom);
    const fetched = new Promise((resolve) => saves.set(topic, resolve));
    await mqtt.subscribe(topic);
    game.save = await gunzip(await fetched);
    // Anyone can publish a save, see web/js/play.js
    if (!saveMatches(game.save, game, game.maxPlayers)) throw new Error("The saved game is damaged");
  }
  mqtt.onclose = () => {};
  mqtt.close();
  return game;
}

// Joins the game with the given id, or else the first one in the lobby
// that players can join. Resolves to Doom's exit status when the game is
// over.
//   broker  ws://user:pass@host:15672/mqtt
//   name    the player's name
//   bot     given Doom's module, returns what plays, see doom.js
//   say     is told what goes on, print gets Doom's output
export async function join({ broker, game: wanted, name, bot, say, print }) {
  say(wanted ? `Looking for game ${wanted}` : "Waiting in the lobby for a game to join");
  const game = await find(broker, wanted);
  say(`Joining "${game.title}" on ${game.map}, hosted by ${game.host}`);

  // A will has to be said as the connection opens, and it names the game,
  // so the game gets a connection of its own. The broker publishes it if
  // the bot goes without a goodbye: it tells the Doom server that the bot
  // left, before the others wait 10 s for the bot to time out.
  const peerId = newPeerId();
  const will = { topic: topics.packet(game.id, SERVER_ID, peerId), payload: GOODBYE };
  const mqtt = await MqttClient.connect(broker, { will, retry: RECONNECT_FOR });
  const { deliver, net } = network(mqtt, game.id, peerId);
  const over = Promise.withResolvers();
  let hostLeft; // timer, from when the host's listing went away
  let doom;
  mqtt.onclose = () => over.reject(new Error("Lost connection to the broker"));
  mqtt.ondrop = () => say("Lost the broker, trying to get back");
  mqtt.onreconnect = () => say("Back on the broker");
  mqtt.onmessage = (topic, payload) => {
    if (topic === topics.listing(game.id)) {
      // The host clears its listing as it leaves. So does a broker that
      // restarts, with the host's last will, and then the host puts it back.
      clearTimeout(hostLeft);
      if (!parseListing(payload)) hostLeft = setTimeout(over.resolve, HOST_TIMEOUT, 0);
    } else if (topic === topics.join(game.id, peerId)) {
      // The game runs already: the host sends it as it is, gzipped
      gunzip(payload).then((data) => doom?.FS.writeFile(JOIN_FILE, data), over.reject);
    }
    deliver(topic, payload);
  };
  await mqtt.subscribe(topics.inbox(game.id, peerId));
  await mqtt.subscribe(topics.listing(game.id));
  await mqtt.subscribe(topics.join(game.id, peerId));

  doom = await startDoom({
    args: ["-connect", String(SERVER_ID), "-pet", name, "-savedir", "saves"],
    // A resumed game starts from the host's save on every player's side
    files: game.save ? { [RESUME_FILE]: game.save } : {},
    bot,
    print,
    net,
    exited: over.resolve,
  });
  return over.promise.finally(() => mqtt.close());
}
