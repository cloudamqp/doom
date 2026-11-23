// Where to play, from what a player would have: the address of a DooMQ
// page, as copied from the browser, or just a game's id.

import { isGameId } from "../web/js/protocol.js";

// The page's broker is in its js/config.js, see web/js/config.js. It is
// read as text, not run: it is someone else's code.
async function brokerOf(page) {
  const config = new URL("js/config.js", page);
  const response = await fetch(config);
  if (!response.ok) throw new Error(`No DooMQ at ${page.origin}${page.pathname}: ${config} gave ${response.status}`);
  const [, broker] = (await response.text()).match(/broker:\s*[`"']([^`"']+)[`"']/) ?? [];
  if (!broker) throw new Error(`No broker in ${config}`);
  // The page's own host, for a broker next to the web server
  return broker.replace("${location.hostname}", page.hostname);
}

// Resolves to { broker, game }, each undefined if the address does not say.
// A page's address may name a game (?game=) and another broker (?broker=),
// as the page's own links do.
export async function locate(address) {
  if (address === undefined || isGameId(address)) return { game: address };
  if (!URL.canParse(address)) throw new Error(`Neither a game id nor an address: ${address}`);
  const page = new URL(address);
  const game = page.searchParams.get("game") ?? undefined;
  if (game !== undefined && !isGameId(game)) throw new Error(`No such game: ${game}`);
  return { broker: page.searchParams.get("broker") ?? (await brokerOf(page)), game };
}
