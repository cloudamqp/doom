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
import { join } from "../bot/join.js";

const USAGE = `Usage: bin/bot.js [options] [address or game]

Joins a DooMQ game and plays it. Give it the address of a DooMQ page, as
copied from the browser: the lobby's for the first game that waits for
players, or a game's own. It finds the page's broker by itself. A game's id
alone is looked for on the broker below.

  --broker <url>   MQTT over WebSocket, instead of the page's. Default
                   $BROKER_URL or ws://guest:guest@localhost:15672/mqtt
  --name <name>    the bot's name in the game, default Bot
  --solo <map>     practice alone on a map (E1M1 to E4M9) as fast as the
                   machine goes, without a broker
  --skill <1-5>    with --solo, default 3
  --verbose        print Doom's output and what the bot is up to
`;

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    broker: { type: "string" },
    name: { type: "string", default: "Bot" },
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

// Joins a game on a broker and plays it until it is over
async function play(address) {
  const { broker, game } = await locate(address);
  const status = await join({
    broker: options.broker ?? broker ?? process.env.BROKER_URL ?? "ws://guest:guest@localhost:15672/mqtt",
    game,
    name: options.name,
    bot: (doom) => new Brain(doom, { report: say, trace: chatter }),
    say,
    print: chatter,
  });
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
