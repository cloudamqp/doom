// What a Doom player knows by heart: the numbers of line types and things,
// as the map editors and doom/src/doom/p_spec.c, p_switch.c and info.c have them.

export const TICRATE = 35;

// Player's size, and the highest step it climbs
export const RADIUS = 16;
export const HEIGHT = 56;
export const STEP = 24;
// Reach of the use button
export const USE_RANGE = 64;
// Shots aim themselves up and down at targets this near
export const AIM_RANGE = 1024;

// Buttons in a ticcmd
export const BT_ATTACK = 1;
export const BT_USE = 2;
export const BT_CHANGE = 4;
export const BT_WEAPONSHIFT = 3;

// Thing flags
export const MF_SPECIAL = 0x1; // picked up by walking over it
export const MF_SOLID = 0x2;
export const MF_SHOOTABLE = 0x4;
export const MF_MISSILE = 0x10000;
export const MF_COUNTKILL = 0x400000;

// Line flags
export const ML_BLOCKING = 0x1;

export const WEAPON = { fist: 0, pistol: 1, shotgun: 2, chaingun: 3, rocket: 4, plasma: 5, bfg: 6, chainsaw: 7 };
export const NO_WEAPON_CHANGE = 10;
export const AMMO = { bullets: 0, shells: 1, cells: 2, rockets: 3 };

// Per weapon: its ammo and how much a shot takes, how fast its missile
// flies in units per tic (hitscan weapons have none), and the range it is
// good at
export const WEAPONS = {
  [WEAPON.fist]: { reach: 64 },
  [WEAPON.chainsaw]: { reach: 64 },
  [WEAPON.pistol]: { ammo: AMMO.bullets, uses: 1, best: 300 },
  [WEAPON.shotgun]: { ammo: AMMO.shells, uses: 1, best: 200 },
  [WEAPON.chaingun]: { ammo: AMMO.bullets, uses: 1, best: 300 },
  [WEAPON.rocket]: { ammo: AMMO.rockets, uses: 1, speed: 20, best: 450, splash: 200 },
  [WEAPON.plasma]: { ammo: AMMO.cells, uses: 1, speed: 25, best: 300 },
  [WEAPON.bfg]: { ammo: AMMO.cells, uses: 40, speed: 25, best: 400 },
};

const set = (...numbers) => new Set(numbers);

// Line types. Doors opened by pressing use on them, they act on the sector
// behind the line.
export const MANUAL_DOORS = set(1, 26, 27, 28, 31, 32, 33, 34, 117, 118);
// Switches, pressed with use
const SWITCHES = set(
  ...[7, 9, 11, 14, 15, 18, 20, 21, 23, 29, 41, 42, 43, 45, 49, 50, 51, 55, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71],
  ...[99, 101, 102, 103, 111, 112, 113, 114, 115, 116, 122, 123, 127, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140],
);
// Triggered by shooting them
const SHOT = set(24, 46, 47);
// Scrolling walls, lights, crushers and monsters' teleporters: nothing to
// gain from setting these off
const POINTLESS = set(48, 12, 13, 17, 35, 79, 80, 81, 104, 138, 139, 6, 25, 49, 57, 73, 74, 77, 141, 125, 126);
export const EXITS = set(11, 52);
export const SECRET_EXITS = set(51, 124);
export const TELEPORTERS = set(39, 97);
// Key colors by line type: 0 blue, 1 yellow, 2 red. A card or a skull opens them.
const LOCKS = new Map([
  ...[26, 32, 99, 133].map((type) => [type, 0]),
  ...[27, 34, 136, 137].map((type) => [type, 1]),
  ...[28, 33, 134, 135].map((type) => [type, 2]),
]);

// How a line type is set off: "use", "cross", or undefined if it has nothing to offer
export function trigger(special) {
  if (!special || POINTLESS.has(special) || SHOT.has(special)) return undefined;
  return SWITCHES.has(special) || MANUAL_DOORS.has(special) ? "use" : "cross";
}

// The player's cards as bits: blue, yellow and red cards, then the skulls
export const hasKey = (cards, color) => Boolean(cards & (0b001001 << color));
export const unlocked = (special, cards) => !LOCKS.has(special) || hasKey(cards, LOCKS.get(special));

// Sector types that hurt to stand in
export const HAZARDS = set(4, 5, 7, 16);

// Things, by their map editor number
export const TELEPORT_DESTINATION = 14;
export const BARREL = 2035;
// Blue, yellow and red: cards, then skulls
export const KEYS = new Map([[5, 0], [6, 1], [13, 2], [40, 0], [39, 1], [38, 2]]);
export const WEAPON_PICKUPS = new Map([
  [2001, WEAPON.shotgun],
  [2002, WEAPON.chaingun],
  [2003, WEAPON.rocket],
  [2004, WEAPON.plasma],
  [2005, WEAPON.chainsaw],
  [2006, WEAPON.bfg],
]);
export const AMMO_PICKUPS = new Map([
  [2007, AMMO.bullets],
  [2048, AMMO.bullets],
  [2008, AMMO.shells],
  [2049, AMMO.shells],
  [2010, AMMO.rockets],
  [2046, AMMO.rockets],
  [2047, AMMO.cells],
  [17, AMMO.cells],
]);
// Health they give, up to 100
export const HEALTH_PICKUPS = new Map([[2011, 10], [2012, 25]]);
// Worth a short detour whenever seen: soul sphere, health and armor bonus,
// berserk, backpack, invulnerability
export const BONUS_PICKUPS = set(2013, 2014, 2015, 2023, 8, 2022);
// Armor they give
export const ARMOR_PICKUPS = new Map([[2018, 100], [2019, 200]]);

const LOST_SOUL = 3006;
// Monsters that hit without a missile to dodge: zombies and the spider
const HITSCANNERS = set(3004, 9, 7);
// Monsters that have to come close: demon, spectre, lost soul
const BITERS = set(3002, 58, LOST_SOUL);
// Baron, cyberdemon, spider mastermind
const BOSSES = set(3003, 16, 7);

export const isMonster = (thing) => Boolean(thing.flags & MF_COUNTKILL) || thing.type === LOST_SOUL;
export const isHitscanner = (thing) => HITSCANNERS.has(thing.type);
export const isBiter = (thing) => BITERS.has(thing.type);
export const isBoss = (thing) => BOSSES.has(thing.type);
