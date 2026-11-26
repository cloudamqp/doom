import { test } from "node:test";
import assert from "node:assert/strict";
import { ATTACK, USE, touchPlayer } from "../web/js/touch.js";

// Fist, pistol and shotgun, with bullets and no shells
const armed = { weapon: 1, weapons: 0b111, ammo: [50, 0, 0, 0] };

test("the stick pushes as far as it is held out, at most as a runner", () => {
  const player = touchPlayer(() => armed);
  player.stick(0.5, -1);
  assert.deepEqual(player.ticcmd(), { forward: 50, side: 25, turn: 0, buttons: 0 });
  player.stick(0, 3);
  assert.equal(player.ticcmd().forward, -50);
});

test("a thumb that rests on the stick stands still", () => {
  const player = touchPlayer(() => armed);
  player.stick(0.1, -0.1);
  assert.deepEqual(player.ticcmd(), { forward: 0, side: 0, turn: 0, buttons: 0 });
});

test("a drag turns once, by the part of the screen's width it crossed", () => {
  const player = touchPlayer(() => armed);
  player.drag(0.1);
  player.drag(0.1);
  // To the right is clockwise, a negative turn. A fifth of the width is a
  // quarter turn: the thumb's reach, 40%, turns the player around.
  assert.equal(player.ticcmd().turn, -16384);
  assert.equal(player.ticcmd().turn, 0);
});

test("a turn of more than a ticcmd holds is spread over the next", () => {
  const player = touchPlayer(() => armed);
  player.drag(-1);
  assert.equal(player.ticcmd().turn, 32767);
  assert.equal(player.ticcmd().turn, 32767);
  assert.equal(player.ticcmd().turn, 81920 - 2 * 32767);
});

test("a button is down while held, and a tap between two tics counts", () => {
  const player = touchPlayer(() => armed);
  player.press(ATTACK);
  assert.equal(player.ticcmd().buttons, ATTACK);
  assert.equal(player.ticcmd().buttons, ATTACK);
  player.release(ATTACK);
  assert.equal(player.ticcmd().buttons, 0);
  player.press(USE);
  player.release(USE);
  assert.equal(player.ticcmd().buttons, USE);
  assert.equal(player.ticcmd().buttons, 0);
});

test("the next weapon is the next one the player has ammo for", () => {
  // The shotgun (2) is empty, so the pistol (1) is followed by the fist (0)
  const player = touchPlayer(() => armed);
  player.nextWeapon();
  assert.equal(player.ticcmd().buttons, 4 | (0 << 3));
  assert.equal(player.ticcmd().buttons, 0);

  const loaded = touchPlayer(() => ({ ...armed, ammo: [50, 8, 0, 0] }));
  loaded.nextWeapon();
  assert.equal(loaded.ticcmd().buttons, 4 | (2 << 3));
});
