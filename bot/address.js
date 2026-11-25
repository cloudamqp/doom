// Where to play, from what a player would have: the address of a DooMQ
// page, as copied from the browser, or just a game's id.

import { isGameId } from "../web/js/protocol.js";

// A region's code and its broker in config.js: syd: "wss://…", with or
// without quotes around the code
const BROKER = /(?:"([^"]+)"|'([^']+)'|([\w$]+))\s*:\s*[`"'](wss?:\/\/[^`"']+)[`"']/g;

// The page's brokers, one per region, are in its js/config.js, see
// web/js/config.js. It is read as text, not run: it is someone else's code.
// The address picks the region by its code (?region=) as for the page,
// else it's the first, and may name another broker (?broker=) where the
// config lets it.
async function brokerOf(page) {
  const config = new URL("js/config.js", page);
  const response = await fetch(config);
  if (!response.ok) throw new Error(`No DooMQ at ${page.origin}${page.pathname}: ${config} gave ${response.status}`);
  const text = await response.text();
  const fromAddress = /brokerFromAddress:\s*true/.test(text) ? page.searchParams.get("broker") : null;
  if (fromAddress !== null) return fromAddress;
  const brokers = new Map([...text.matchAll(BROKER)].map(([, double, single, bare, url]) => [double ?? single ?? bare, url]));
  if (!brokers.size) throw new Error(`No broker in ${config}`);
  const broker = brokers.get(page.searchParams.get("region")) ?? [...brokers.values()][0];
  // The page's own host, for a broker next to the web server
  return broker.replace("${location.hostname}", page.hostname);
}

// Resolves to { broker, game }, each undefined if the address does not say.
// A page's address may name a game (?game=), as the page's own links do.
export async function locate(address) {
  if (address === undefined || isGameId(address)) return { game: address };
  if (!URL.canParse(address)) throw new Error(`Neither a game id nor an address: ${address}`);
  const page = new URL(address);
  const game = page.searchParams.get("game") ?? undefined;
  if (game !== undefined && !isGameId(game)) throw new Error(`No such game: ${game}`);
  return { broker: await brokerOf(page), game };
}
