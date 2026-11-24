import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { MAX_SAVE_BYTES, gunzip, gzip } from "../web/js/gzip.js";

test("gunzip returns what gzip was given", async () => {
  const data = Uint8Array.from({ length: 300_000 }, (_, i) => i % 251);
  assert.deepEqual(await gunzip(await gzip(data)), data);
});

test("gunzip accepts data up to the limit", async () => {
  assert.equal((await gunzip(gzipSync(new Uint8Array(MAX_SAVE_BYTES)))).length, MAX_SAVE_BYTES);
});

test("gunzip stops at the limit, without expanding the rest", async () => {
  const bomb = gzipSync(new Uint8Array(1024 * 1024 * 1024));
  assert.ok(bomb.length < MAX_SAVE_BYTES, `${bomb.length} bytes of gzip`);
  const before = process.memoryUsage().rss;
  await assert.rejects(gunzip(bomb), /expands to more than/);
  assert.ok(process.memoryUsage().rss - before < 100 * 1024 * 1024);
});

test("gunzip rejects what isn't gzip", async () => {
  await assert.rejects(gunzip(Uint8Array.of(1, 2, 3)));
});
