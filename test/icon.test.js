// Every page names DooMQ's icons: img/doomq.svg for the tab, and from it, by
// bin/icon.js, favicon.ico for browsers without SVG and apple-touch-icon.png
// for a phone's home screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const WEB = new URL("../web/", import.meta.url);

// A PNG starts with its width and height, at bytes 16 and 20
const size = (png) => [png.readUInt32BE(16), png.readUInt32BE(20)];

for (const page of ["index.html", "how.html", "why-mqtt.html", "flow.html"]) {
  test(`${page} has DooMQ's icons`, async () => {
    const html = await readFile(new URL(page, WEB), "utf8");
    const link = (rel) => html.match(new RegExp(`<link rel="${rel}" href="([^"]*)"(?: sizes="([^"]*)")?`))?.slice(1);

    // An ICO holds a PNG for each size it says it has
    const [favicon, sizes] = link("icon");
    const ico = await readFile(new URL(favicon, WEB));
    const pngs = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
      const entry = 6 + 16 * i;
      return ico.subarray(ico.readUInt32LE(entry + 12)).subarray(0, ico.readUInt32LE(entry + 8));
    });
    assert.deepEqual(pngs.map((png) => size(png).join("x")).join(" "), sizes);

    // Sharp at any size where SVG will do, LavinMQ's peaks in Doom's colors
    const svg = html.match(/<link rel="icon" href="([^"]*)" type="image\/svg\+xml"/)?.[1];
    assert.match(await readFile(new URL(svg, WEB), "utf8"), /^<svg /);

    const [touch] = link("apple-touch-icon");
    assert.deepEqual(size(await readFile(new URL(touch, WEB))), [180, 180]);
  });
}
