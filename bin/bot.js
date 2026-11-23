#!/usr/bin/env node
// A bot that plays DooMQ. It joins a game as any player does, but runs Doom
// without a screen and plays by the game's state instead of pixels and keys.
//
//   bin/bot.js [options] [address or game]
//
// See README.md.

import { parseArgs } from "node:util";
import { locate } from "../bot/address.js";
import { Brain } from "../bot/brain.js";
import { TICRATE } from "../bot/doomdata.js";
import { startDoom } from "../bot/doom.js";
import { host } from "../bot/host.js";
import { join } from "../bot/join.js";
import { MAPS, MAX_PLAYERS, MODES, SKILLS } from "../web/js/protocol.js";

const USAGE = `Usage: bin/bot.js [options] [address or game]

Joins a DooMQ game and plays it. Give it the address of a DooMQ page, as
copied from the browser: the lobby's for the first game that waits for
players, or a game's own. It finds the page's broker by itself. A game's id
alone is looked for on the broker below.

  --broker <url>   MQTT over WebSocket, instead of the page's. Default
                   $BROKER_URL or ws://guest:guest@localhost:15672/mqtt
  --name <name>    the bot's name in the game, default Bot
  --host           start a game instead, on the page's broker, and play it.
                   It shows in the lobby and starts once enough have joined.
  --players <1-4>  with --host, how many it starts with, the bot included.
                   Default 2
  --mode <mode>    with --host: coop (default), deathmatch or altdeath
  --map <map>      with --host, E1M1 (default) to E4M9
  --title <title>  with --host, default "<name>'s game"
  --no-monsters    with --host
  --no-spectators  with --host, keep the game to its players
  --solo <map>     practice alone on a map (E1M1 to E4M9) as fast as the
                   machine goes, without a broker
  --skill <1-5>    with --solo or --host, default 3
  --verbose        print Doom's output and what the bot is up to
`;

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    broker: { type: "string" },
    name: { type: "string", default: "Bot" },
    host: { type: "boolean", default: false },
    players: { type: "string", default: "2" },
    mode: { type: "string", default: "coop" },
    map: { type: "string", default: "E1M1" },
    title: { type: "string" },
    "no-monsters": { type: "boolean", default: false },
    "no-spectators": { type: "boolean", default: false },
    solo: { type: "string" },
    skill: { type: "string", default: "3" },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

// Practice ends after this much time on a map, in tics
const SOLO_LIMIT = 15 * 60 * TICRATE;

const say = (text) => console.log(text);
const chatter = options.verbose ? say : () => {};

// Practice: Doom runs a tic per frame, and frames as fast as they come
async function solo(map) {
  const [, episode, number] = map.match(/^E([1-4])M([1-9])$/) ?? [];
  if (!episode) throw new Error(`No such map: ${map}`);
  let finished = false;
  const report = (text) => {
    say(text);
    finished ||= text.startsWith("Finished");
  };
  const doom = await startDoom({
    args: ["-singletics", "-skill", options.skill, "-warp", episode, number],
    print: chatter,
    exited: (status) => process.exit(status),
    bot: (doom) => new Brain(doom, { report, trace: chatter }),
  });
  for (let tic = 0; !finished; tic++) {
    if (tic === SOLO_LIMIT) throw new Error(`Still on ${map} after ${SOLO_LIMIT / TICRATE / 60} minutes`);
    doom._D_RunFrame();
    // Lets Doom's output out
    if (tic % TICRATE === 0) await new Promise(setImmediate);
  }
  process.exit(0);
}

// What --host asks for, as the lobby's form would
function hosting() {
  const [players, skill] = [Number(options.players), Number(options.skill)];
  if (!(players >= 1 && players <= MAX_PLAYERS)) throw new Error(`A game has 1 to ${MAX_PLAYERS} players, not ${options.players}`);
  if (!(options.mode in MODES)) throw new Error(`No such mode: ${options.mode}. There is ${Object.keys(MODES).join(", ")}`);
  if (!MAPS.includes(options.map)) throw new Error(`No such map: ${options.map}`);
  if (!SKILLS[skill - 1]) throw new Error(`No such skill: ${options.skill}`);
  const title = (options.title ?? `${options.name}'s game`).slice(0, 40);
  const settings = { title, mode: options.mode, skill, map: options.map, monsters: !options["no-monsters"], spectators: !options["no-spectators"] };
  return { players, settings };
}

// Hosts a game on a broker or joins one, and plays it until it is over
async function play(address) {
  const { broker, game } = await locate(address);
  const player = {
    broker: options.broker ?? broker ?? process.env.BROKER_URL ?? "ws://guest:guest@localhost:15672/mqtt",
    name: options.name,
    bot: (doom) => new Brain(doom, { report: say, trace: chatter }),
    say,
    print: chatter,
  };
  const status = await (options.host ? host({ ...player, ...hosting() }) : join({ ...player, game }));
  say("The game is over");
  process.exit(status);
}

try {
  if (options.help) say(USAGE);
  else if (options.solo) await solo(options.solo);
  else await play(positionals[0]);
} catch (error) {
  // What went wrong is for whoever started the bot, where for those who work on it
  console.error(options.verbose ? error : error.message);
  process.exit(1);
}
