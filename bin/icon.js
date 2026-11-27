#!/usr/bin/env node
// Takes DooMQ's icons from web/img/icon.html, which shows web/img/doomq.svg:
// web/favicon.ico (16, 32 and 48 pixels) and web/apple-touch-icon.png (180,
// square, for a phone's home screen). Needs the web app on :8080, or at
// $WEB_URL.

import { writeFile } from "node:fs/promises";
import puppeteer from "puppeteer";

const WEB_URL = process.env.WEB_URL ?? "http://localhost:8080";
const WEB = new URL("../web/", import.meta.url);

const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 512, height: 512 });

// The icon at 512 pixels, then smaller in halves at most, which keeps the
// small ones sharp
async function take(query, sizes) {
  await page.goto(`${WEB_URL}/img/icon.html${query}`);
  await page.waitForFunction(() => document.body.dataset.ready);
  const big = await (await page.$(".icon")).screenshot({ omitBackground: true, encoding: "base64" });
  const pngs = await page.evaluate(
    async (big, sizes) => {
      const image = new Image();
      image.src = `data:image/png;base64,${big}`;
      await image.decode();
      return sizes.map((size) => {
        let from = image;
        for (let at = from.width / 2; ; at /= 2) {
          const canvas = Object.assign(document.createElement("canvas"), { width: Math.max(at, size), height: Math.max(at, size) });
          const context = canvas.getContext("2d");
          context.imageSmoothingQuality = "high";
          context.drawImage(from, 0, 0, canvas.width, canvas.height);
          from = canvas;
          if (canvas.width === size) return canvas.toDataURL("image/png").split(",")[1];
        }
      });
    },
    big,
    sizes,
  );
  return pngs.map((png) => Buffer.from(png, "base64"));
}

// An ICO file can hold PNGs as they are: a header, an entry for each, then them
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(1, 2); // an icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach((png, i) => {
    const entry = 6 + 16 * i;
    header[entry] = png.readUInt32BE(16) % 256; // width, 0 for 256
    header[entry + 1] = png.readUInt32BE(20) % 256;
    header.writeUInt16LE(1, entry + 4); // color planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs]);
}

await writeFile(new URL("favicon.ico", WEB), ico(await take("", [16, 32, 48])));
const [touch] = await take("?square", [180]);
await writeFile(new URL("apple-touch-icon.png", WEB), touch);
await browser.close();
console.log(`Wrote ${new URL("favicon.ico", WEB).pathname} and ${new URL("apple-touch-icon.png", WEB).pathname}`);
