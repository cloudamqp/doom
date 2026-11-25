import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PLAYERS, isPeerId, parseListing, saveMatches } from "../web/js/protocol.js";

const json = (value) => new TextEncoder().encode(JSON.stringify(value));
const listing = { title: "A game", host: "Hanna", mode: "coop", skill: 3, map: "E1M3", monsters: true, players: 1, maxPlayers: 4, state: "waiting" };

// A savegame's header: description, version, then skill, episode, map and
// which of the eight players are in the game
function save({ skill, episode, map, players }) {
  const data = new Uint8Array(60);
  data.set([skill - 1, episode, map, ...Array.from({ length: MAX_PLAYERS }, (_, i) => players[i] ?? 0)], 40);
  return data;
}

test("a listing is taken as it is, or not at all", () => {
  assert.deepEqual(parseListing(json(listing)), listing);
  assert.equal(parseListing(json({ ...listing, map: "E9M9" })), null);
  assert.equal(parseListing(new TextEncoder().encode("not JSON")), null);
});

test("titles and names can't steer a terminal", () => {
  assert.equal(parseListing(json({ ...listing, title: "\u001b]0;gone\u0007" })), null);
  assert.equal(parseListing(json({ ...listing, host: "Hanna\r\n" })), null);
  assert.ok(parseListing(json({ ...listing, title: "Björn's spel 🔥" })));
});

test("a sender is a number from 1 to 2^32 - 1", () => {
  for (const peer of [1, 2, 0xffffffff]) assert.ok(isPeerId(peer), String(peer));
  for (const peer of [0, -1, 1.5, 2 ** 32, NaN, Infinity]) assert.ok(!isPeerId(peer), String(peer));
});

test("a savegame matches the game it is said to be", () => {
  const data = save({ skill: 3, episode: 1, map: 3, players: [1, 1, 0, 0] });
  assert.ok(saveMatches(data, listing, 2));
  assert.ok(!saveMatches(data, listing, 4), "more players than marines");
  assert.ok(!saveMatches(data, { ...listing, map: "E1M4" }, 2), "another map");
  assert.ok(!saveMatches(data, { ...listing, skill: 5 }, 2), "another skill");
  assert.ok(!saveMatches(data.subarray(0, 40), listing, 2), "no header");
});
