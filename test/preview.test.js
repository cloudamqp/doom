// Links to the pages unfurl in Slack and the like with a title, a line of
// text and a picture, which have to be told with full addresses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const WEB = new URL("../web/", import.meta.url);
const SITE = "https://doom.lavinmq.com/";

const property = (html, name) => html.match(new RegExp(`<meta (?:property|name)="${name}" content="([^"]*)"`))?.[1];

for (const page of ["index.html", "how.html", "why-mqtt.html"]) {
  test(`${page} says how a link to it looks`, async () => {
    const html = await readFile(new URL(page, WEB), "utf8");
    assert.equal(property(html, "og:url"), SITE + (page === "index.html" ? "" : page));
    assert.ok(property(html, "og:title").includes("DooMQ"));
    assert.equal(property(html, "og:description"), property(html, "description"));
    assert.equal(property(html, "twitter:card"), "summary_large_image");

    // The picture is there, and as big as the page says: a PNG starts with
    // its width and height, at bytes 16 and 20
    const image = property(html, "og:image");
    assert.ok(image.startsWith(SITE), image);
    const png = await readFile(new URL(image.slice(SITE.length), WEB));
    assert.equal(png.readUInt32BE(16), Number(property(html, "og:image:width")));
    assert.equal(png.readUInt32BE(20), Number(property(html, "og:image:height")));
  });
}
