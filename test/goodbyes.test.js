import { test } from "node:test";
import assert from "node:assert/strict";
import { GOODBYE, holdGoodbyes } from "../web/js/goodbyes.js";

test("a host holds goodbyes, and forgets them when its connection drops", async () => {
  const delivered = [];
  const { receive, forget } = holdGoodbyes((packet) => delivered.push(packet.from), 50);
  const later = () => new Promise((resolve) => setTimeout(resolve, 100));

  receive({ from: 2, data: Uint8Array.of(0, 2, 7) });
  receive({ from: 3, data: GOODBYE });
  assert.deepEqual(delivered, [2], "other packets go straight on");
  await later();
  assert.deepEqual(delivered, [2, 3], "a guest that left");

  // The broker shut down: it said the guests' goodbyes, then the host's went too
  receive({ from: 4, data: GOODBYE });
  forget();
  await later();
  assert.deepEqual(delivered, [2, 3]);
});
