#!/usr/bin/env node
// Takes the picture for link previews, web/img/preview.png, from
// web/img/preview.html. Needs the web app on :8080, or at $WEB_URL. The fire
// burns differently every time.

import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const WEB_URL = process.env.WEB_URL ?? "http://localhost:8080";
const PICTURE = fileURLToPath(new URL("../web/img/preview.png", import.meta.url));

const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630 });
await page.goto(`${WEB_URL}/img/preview.html`);
await page.waitForFunction(() => document.body.dataset.ready);
// The fire takes a moment to burn all the way up
await new Promise((resolve) => setTimeout(resolve, 2_500));
await (await page.$(".card")).screenshot({ path: PICTURE });
await browser.close();
console.log(`Wrote ${PICTURE}`);
