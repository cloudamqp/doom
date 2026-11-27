import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readMap } from "../web/js/wad.js";

const wad = new Uint8Array(await readFile(new URL("../web/freedoom1.wad", import.meta.url)));

test("reads a map's lines as the automap draws them", () => {
  const { lines, bounds } = readMap(wad, "E1M1");
  const kinds = Object.groupBy(lines, (line) => line.kind);
  assert.ok(kinds.wall.length > 100, `${kinds.wall.length} walls`);
  assert.ok(kinds.floor.length > 10, `${kinds.floor.length} floor steps`);
  assert.ok(bounds.left < bounds.right && bounds.bottom < bounds.top);
  for (const { x1, y1, x2, y2 } of lines) {
    for (const x of [x1, x2]) assert.ok(x >= bounds.left && x <= bounds.right);
    for (const y of [y1, y2]) assert.ok(y >= bounds.bottom && y <= bounds.top);
  }
});

// E3M4's deathmatch starts are in an arena of its own, hidden from the automap
test("draws the lines that a map hides from the automap", () => {
  const { lines, bounds } = readMap(wad, "E3M4");
  assert.ok(lines.some(({ x1, x2 }) => Math.max(x1, x2) === bounds.right), "nothing drawn at the map's east end");
});

test("has every map of Freedoom's four episodes, and nothing else", () => {
  for (const episode of [1, 2, 3, 4]) for (let map = 1; map <= 9; map++) assert.ok(readMap(wad, `E${episode}M${map}`));
  assert.equal(readMap(wad, "E5M1"), null);
});
