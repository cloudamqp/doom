// The bot's parts on a map of three rooms, then the whole bot on E1M1.
// The last test needs Doom built into web/, see bin/build.sh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { aimAt, pickTarget, pickWeapon } from "../bot/combat.js";
import { AMMO, MF_COUNTKILL, MF_SHOOTABLE, MF_SPECIAL, WEAPON, trigger, unlocked } from "../bot/doomdata.js";
import { chooseGoal } from "../bot/goals.js";
import { Nav, UNREACHED } from "../bot/nav.js";
import { push, strafeRun } from "../bot/steer.js";
import { readThings } from "../bot/world.js";

const BLUE_KEY = 5;
const MEDIKIT = 2012;
const ZOMBIE = 3004;
const IMP = 3001;

// Rooms A and B share a wall with a doorway, room C stands apart:
//
//   256 +-------+-------+   +-------+
//       |       |       |   |       |
//       |   A   =   B   |   |   C   |
//       |       |       |   |       |
//     0 +-------+-------+   +-------+
//       0      256     512 600     856
//
// Walls have the room on their right and nothing behind them.
const wall = (x1, y1, x2, y2, front) => ({ x1, y1, x2, y2, flags: 1, special: 0, tag: 0, front, back: -1 });
const room = (left, right, sector) => [
  wall(left, 0, left, 256, sector),
  wall(left, 256, right, 256, sector),
  wall(right, 256, right, 0, sector),
  wall(right, 0, left, 0, sector),
];
const notShared = (line) => line.x1 !== 256 || line.x2 !== 256;
const DOORWAY = { x1: 256, y1: 96, x2: 256, y2: 160, flags: 4, special: 0, tag: 0, front: 1, back: 0 };
const A = { x: 128, y: 128 };
const B = { x: 384, y: 128 };
const C = { x: 728, y: 128 };

function map({ lines = [], sectors = {} } = {}) {
  const walls = [
    ...room(0, 256, 0).filter(notShared),
    ...room(256, 512, 1).filter(notShared),
    wall(256, 256, 256, 160, 0),
    wall(256, 96, 256, 0, 0),
    DOORWAY,
    ...room(600, 856, 2),
  ];
  const nav = new Nav({ lines: [...walls, ...lines], sectorAt: (x) => (x < 256 ? 0 : x < 512 ? 1 : 2) });
  const update = (changed = {}, openable) => {
    nav.update([0, 1, 2].map((index) => ({ floor: 0, ceiling: 128, hazard: false, ...sectors[index], ...changed[index] })), openable);
    return nav;
  };
  update();
  return { nav, update, lines: [...walls, ...lines] };
}

const reaches = (nav, from, to, options) => nav.flood(nav.standingAt(from), options).cost[nav.standingAt(to)] < UNREACHED;

test("a way leads through the doorway, and around the wall", () => {
  const { nav } = map();
  assert.ok(reaches(nav, A, B));
  assert.ok(!reaches(nav, A, C));

  const flood = nav.flood(nav.standingAt({ x: 128, y: 32 }));
  const path = nav.path(flood, nav.standingAt({ x: 384, y: 32 })).map((cell) => nav.center(cell));
  assert.deepEqual(path[0], { x: 128, y: 32 });
  assert.deepEqual(path.at(-1), { x: 384, y: 32 });
  assert.ok(path.some(({ x, y }) => x === 256 && y > 96 && y < 160), "through the doorway");
  assert.ok(!nav.clear({ x: 128, y: 32 }, { x: 384, y: 32 }), "the wall is in the way");
  assert.ok(nav.clear(A, B));
});

test("a step of more than 24 units is a wall, a drop is not", () => {
  const { update } = map();
  assert.ok(reaches(update({ 1: { floor: 24 } }), A, B));
  const nav = update({ 1: { floor: 32 } });
  assert.ok(!reaches(nav, A, B));
  assert.ok(reaches(nav, B, A));
});

test("a player needs 56 units of headroom", () => {
  const { update } = map();
  assert.ok(reaches(update({ 1: { ceiling: 56 } }), A, B));
  assert.ok(!reaches(update({ 1: { ceiling: 55 } }), A, B));
  assert.ok(!reaches(update({ 1: { floor: 24, ceiling: 128 }, 0: { ceiling: 72 } }), A, B), "the step up hits A's ceiling");
});

test("doors the player can open are open, but not to walk straight through", () => {
  const { update } = map();
  const closed = { 1: { ceiling: 0 } };
  assert.ok(!reaches(update(closed), A, B));
  const nav = update(closed, new Set([1]));
  assert.ok(reaches(nav, A, B));
  assert.ok(!nav.clear(A, B));
});

test("safe ways keep off floors that hurt, but lead off them", () => {
  const { update } = map();
  const nav = update({ 1: { hazard: true } });
  assert.ok(reaches(nav, A, B));
  assert.ok(!reaches(nav, A, B, { safe: true }));
  assert.ok(reaches(nav, B, A, { safe: true }));
});

test("a teleporter takes those who cross it from the front", () => {
  // Front is the right of a line: this one's is east
  const teleporter = { x1: 128, y1: 0, x2: 128, y2: 256, flags: 4, special: 97, tag: 1, front: 0, back: 0 };
  const { nav } = map({ lines: [teleporter] });
  const teleporters = new Map([[teleporter, nav.standingAt(C)]]);
  const east = nav.standingAt({ x: 192, y: 128 });
  assert.equal(nav.flood(east, { teleporters }).cost[nav.standingAt(C)], 40, "four cells west, then C");
  assert.equal(nav.flood(east).cost[nav.standingAt(C)], UNREACHED, "it has to work");
  // From the west it takes a step across and one back
  assert.equal(nav.flood(nav.standingAt({ x: 112, y: 128 }), { teleporters }).cost[nav.standingAt(C)], 30);
});

test("a player beside a ledge stands on the floor, not on the ledge", () => {
  const { update } = map();
  const nav = update({ 1: { floor: 64 } });
  // The nearest cell is in the doorway, up on B's floor
  const cell = nav.standingAt({ x: 250, y: 128, z: 0 });
  assert.equal(nav.floorAt(cell), 0);
  assert.equal(nav.floorAt(nav.standingAt({ x: 250, y: 128 })), 64);
});

test("the middle of a sector is clear of its edges", () => {
  const { nav } = map();
  assert.deepEqual(nav.center(nav.middleOf(1, { x: 384, y: 128 }, 16)), { x: 384, y: 128 });
  assert.equal(nav.middleOf(2, A), -1);
});

test("line types are pressed, crossed or left alone", () => {
  assert.equal(trigger(11), "use"); // exit switch
  assert.equal(trigger(88), "cross"); // lift
  assert.equal(trigger(48), undefined); // scrolling wall
  assert.equal(trigger(0), undefined);
  assert.ok(unlocked(1, 0));
  assert.ok(!unlocked(26, 0b000110), "a blue door, with the yellow and red cards");
  assert.ok(unlocked(26, 0b001000), "the blue skull opens it too");
});

test("pushes run forward and sideways at once, and stop what carries on", () => {
  const still = { momx: 0, momy: 0 };
  assert.deepEqual(push(still, 0, { x: 20, y: 0 }), { forward: 50, side: 0 });
  assert.deepEqual(push(still, Math.PI / 4, { x: 20, y: 0 }), { forward: 50, side: 50 });
  assert.equal(push({ momx: 0.5, momy: 0 }, 0, { x: 0, y: 0 }).forward, -16);
  assert.equal(strafeRun(0, 0.1), Math.PI / 4);
  assert.equal(strafeRun(0, -0.1), -Math.PI / 4);
});

const monster = (type, x, y, more) => ({ id: type, type, x, y, z: 0, momx: 0, momy: 0, radius: 20, health: 60, flags: MF_SHOOTABLE | MF_COUNTKILL, ...more });
const game = (more) => ({ self: 1, deathmatch: false, health: 100, armor: 0, cards: 0, weapon: WEAPON.pistol, weapons: 0b11, ammo: [50, 0, 0, 0], maxAmmo: [200, 50, 300, 50], ...more });

test("those whose shots can't be dodged are shot first", () => {
  const [imp, zombie] = [monster(IMP, 200, 0), monster(ZOMBIE, 300, 0)];
  assert.equal(pickTarget({ x: 0, y: 0 }, [imp, zombie]), zombie);
  assert.equal(pickTarget({ x: 0, y: 0 }, [imp, monster(ZOMBIE, 500, 0)]), imp);
  assert.equal(pickTarget({ x: 0, y: 0 }, []), undefined);
});

test("the best weapon with ammo is picked, rockets only from afar", () => {
  const armed = game({ weapons: 0b11111, ammo: [50, 20, 0, 5] });
  assert.equal(pickWeapon(armed, monster(IMP), 150, 1), WEAPON.shotgun);
  assert.equal(pickWeapon(armed, monster(IMP), 600, 1), WEAPON.rocket);
  assert.equal(pickWeapon({ ...armed, ammo: [50, 0, 0, 0] }, monster(IMP), 150, 1), WEAPON.chaingun);
  assert.equal(pickWeapon({ ...armed, ammo: [0, 0, 0, 0] }, monster(IMP), 150, 1), WEAPON.fist);
});

test("missiles are aimed at where the target will be", () => {
  const runner = monster(IMP, 400, 0, { momy: 10 });
  assert.equal(aimAt({ x: 0, y: 0 }, runner, WEAPON.pistol), 0);
  // A rocket flies 20 units per tic: 20 tics to get there, the target 200 units on
  assert.equal(aimAt({ x: 0, y: 0 }, runner, WEAPON.rocket), Math.atan2(200, 400));
});

function choose({ things = [], lines = [], state, changed }) {
  const { nav, update, lines: all } = map({ lines });
  update(changed);
  const flood = nav.flood(nav.standingAt(A));
  return chooseGoal({ game: game(state), things, lines: all, nav, flood, banned: () => false, tries: () => 0, visited: new Set([0]) });
}

const item = (type, at, more) => ({ id: type, type, ...at, z: 0, flags: MF_SPECIAL, health: 1000, player: 0, ...more });
const EXIT = { ...wall(512, 160, 512, 96, 1), special: 11 };

test("keys come first, then the exit, then what is left to see", () => {
  const key = item(BLUE_KEY, B);
  assert.equal(choose({ things: [key], lines: [EXIT] }).key, `item:${BLUE_KEY}`);
  const exit = choose({ things: [key], lines: [EXIT], state: { cards: 0b1 } });
  assert.equal(exit.kind, "use");
  assert.equal(exit.line.special, 11);
  // In front of the switch, within reach of it
  assert.deepEqual(map().nav.center(exit.cell), { x: 480, y: 128 });
  assert.equal(choose({}).kind, "explore");
});

test("health is fetched when it is needed", () => {
  const medikit = item(MEDIKIT, B);
  assert.equal(choose({ things: [medikit], lines: [EXIT] }).kind, "use");
  assert.equal(choose({ things: [medikit], lines: [EXIT], state: { health: 40 } }).key, `item:${MEDIKIT}`);
});

test("things are taken from beside the ledge they lie on", () => {
  const key = item(BLUE_KEY, { x: 268, y: 128 }, { z: 48 });
  const goal = choose({ things: [key], changed: { 1: { floor: 48 } } });
  assert.equal(goal.key, `item:${BLUE_KEY}`);
  assert.deepEqual(map().nav.center(goal.cell), { x: 240, y: 128 });
  assert.equal(choose({ things: [{ ...key, z: 64 }], changed: { 1: { floor: 64 } } }), undefined, "above the player's head");
});

test("in a deathmatch the other marines come first", () => {
  const marine = { id: 2, type: -1, ...B, z: 0, flags: MF_SHOOTABLE, health: 100, player: 2 };
  const things = [marine, item(MEDIKIT, { x: 64, y: 64 })];
  assert.equal(choose({ things, lines: [EXIT], state: { deathmatch: true, weapons: 0b111 } }).kind, "hunt");
  assert.equal(choose({ things, lines: [EXIT], state: { deathmatch: true, weapons: 0b111, health: 30 } }).key, `item:${MEDIKIT}`);
});

test("the world is read from Doom's records", () => {
  const thing = [7, ZOMBIE, 64 << 16, -32 << 16, 0, 1 << 15, 0, 0x40000000, 20 << 16, 56 << 16, 20, MF_SHOOTABLE, 0, 3, 1];
  const doom = { HEAP32: Int32Array.of(0, 0, 1, ...thing), _B_Things: () => 8 };
  const [zombie] = readThings(doom);
  assert.deepEqual(
    { ...zombie },
    { id: 7, type: ZOMBIE, x: 64, y: -32, z: 0, momx: 0.5, momy: 0, angle: Math.PI / 2, radius: 20, height: 56, health: 20, flags: MF_SHOOTABLE, player: 0, sector: 3, visible: true },
  );
});

test("the bot plays E1M1 to its exit", { timeout: 120_000 }, async () => {
  const { stdout } = await promisify(execFile)("bin/bot.js", ["--solo", "E1M1"], { cwd: new URL("..", import.meta.url) });
  assert.match(stdout, /^Entering E1M1\nFinished E1M1 in \d:\d\d, kills \d+\/29\n$/);
});
