// Hosts a DooMQ game, the way web/js/play.js does for a browser: it runs
// Doom's server as peer 1, lists the game in the lobby until it is over and
// publishes what goes on in it for spectators.
// Nobody presses Space in a waiting room without a screen, so the game
// starts by itself once enough players have joined.

import { MqttClient } from "../web/js/mqtt.js";
import { RECONNECT_FOR, SERVER_ID, doomArgs, isSpectator, newGameId, topics } from "../web/js/protocol.js";
import { startDoom } from "./doom.js";
import { network } from "./net.js";

// Doom peers send a keepalive at least every 2 s
const PRESENCE_WINDOW = 5_000;
const ANNOUNCE_INTERVAL = 5_000;

// Resolves to Doom's exit status when the game is over.
//   broker    ws://user:pass@host:15672/mqtt
//   name      the host's name as a player
//   settings  { title, mode, skill, map, monsters, spectators } as in the
//             lobby's form
//   players   how many the game starts with, the host included
//   bot       given Doom's module, returns what plays, see doom.js
//   say       is told what goes on, print gets Doom's output
export async function host({ broker, name, settings, players, bot, say, print }) {
  const game = newGameId();
  const listing = topics.listing(game);
  // A host that crashes takes its listing with it
  const will = { topic: listing, payload: "", retain: true };
  const mqtt = await MqttClient.connect(broker, { will, retry: RECONNECT_FOR });
  const { deliver, dropped, net } = network(mqtt, game, SERVER_ID);
  const seen = new Map(); // guest -> when its last packet came
  let state = "waiting";

  const announce = () => {
    for (const [peer, time] of seen) if (performance.now() - time > PRESENCE_WINDOW) seen.delete(peer);
    const present = { ...settings, host: name, players: 1 + seen.size, maxPlayers: players, state };
    mqtt.publish(listing, JSON.stringify(present), { retain: true });
  };
  const over = Promise.withResolvers();
  mqtt.onclose = () => over.reject(new Error("Lost connection to the broker"));
  // A broker that restarts is back within seconds, with the listing cleared
  // by the will. The game stands still meanwhile.
  mqtt.ondrop = () => {
    say("Lost the broker, trying to get back");
    dropped();
  };
  mqtt.onreconnect = () => {
    say("Back on the broker");
    announce();
  };
  mqtt.onmessage = (topic, payload) => {
    const from = deliver(topic, payload);
    // Spectators are no players
    if (from === undefined || isSpectator(from)) return;
    // The lobby shows who is here as they come
    const arrived = !seen.has(from);
    seen.set(from, performance.now());
    if (arrived && state === "waiting") announce();
  };
  await mqtt.subscribe(topics.inbox(game, SERVER_ID));

  announce();
  const announcing = setInterval(announce, ANNOUNCE_INTERVAL);
  say(`Hosting "${settings.title}" on ${settings.map}, game ${game}. It starts with ${players} players.`);

  await startDoom({
    args: ["-server", "-servername", settings.title, ...doomArgs(settings), "-nodes", String(players), "-pet", name, "-savedir", "saves"],
    bot,
    net,
    watch: settings.spectators ? (seen) => mqtt.publish(topics.watch(game), JSON.stringify(seen)) : undefined,
    exited: over.resolve,
    print(line) {
      print(line);
      if (!line.startsWith("doom: 10,")) return;
      state = "playing";
      announce();
    },
  });
  return over.promise.finally(() => {
    clearInterval(announcing);
    mqtt.publish(listing, "", { retain: true });
    mqtt.close();
  });
}
