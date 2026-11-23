// Reads the world from Doom, see doom/src/doom/b_bot.c: its B_ functions
// return a count and that many records of ints. The fields here are in the
// order they are written there. Lengths become map units, momentum map
// units per tic and angles radians.

const FRACUNIT = 65536;
const units = (fixed) => fixed / FRACUNIT;
const radians = (angle) => ((angle >>> 0) / 2 ** 32) * 2 * Math.PI;

export const LEVEL = 0; // gamestate while a level is played
const DEAD = 1; // playerstate

function records(doom, pointer, size) {
  const at = pointer >> 2;
  return doom.HEAP32.subarray(at + 1, at + 1 + doom.HEAP32[at] * size);
}

function* each(ints, size) {
  for (let at = 0; at < ints.length; at += size) yield ints.subarray(at, at + size);
}

export function readGame(doom) {
  const [state, tic, time, episode, map, skill, deathmatch, playerstate, self, health, armor, weapon, pending, weapons, cards, berserk, kills, monsters, frags, ...ammo] =
    records(doom, doom._B_Game(), 27);
  return {
    state,
    tic,
    time,
    map: `E${episode}M${map}`,
    skill,
    deathmatch: deathmatch > 0,
    dead: playerstate === DEAD,
    self, // id of the player's thing
    health,
    armor,
    weapon,
    pending,
    weapons, // owned, as bits
    cards, // as bits
    berserk: berserk > 0,
    kills,
    monsters,
    frags, // marines killed in a deathmatch
    // By ammo type
    ammo: [0, 2, 4, 6].map((at) => ammo[at]),
    maxAmmo: [1, 3, 5, 7].map((at) => ammo[at]),
  };
}

export function readSectors(doom) {
  return Array.from(each(records(doom, doom._B_Sectors(), 5), 5), ([floor, ceiling, special, tag, active]) => ({
    floor: units(floor),
    ceiling: units(ceiling),
    special,
    tag,
    active: active > 0, // a door, lift or floor on the move
  }));
}

export function readLines(doom) {
  return Array.from(each(records(doom, doom._B_Lines(), 9), 9), ([x1, y1, x2, y2, flags, special, tag, front, back]) => ({
    x1: units(x1),
    y1: units(y1),
    x2: units(x2),
    y2: units(y2),
    flags,
    special,
    tag,
    front, // sector on the line's right, the side switches work from
    back, // sector on its left, -1 for a wall
  }));
}

export function readThings(doom) {
  return Array.from(
    each(records(doom, doom._B_Things(), 15), 15),
    ([id, type, x, y, z, momx, momy, angle, radius, height, health, flags, player, sector, visible]) => ({
      id,
      type, // map editor number, see doomdata.js
      x: units(x),
      y: units(y),
      z: units(z),
      momx: units(momx),
      momy: units(momy),
      angle: radians(angle),
      radius: units(radius),
      height: units(height),
      health,
      flags,
      player, // 1 to 4 for marines, else 0
      sector,
      visible: visible > 0, // to the bot, for things that can be shot
    }),
  );
}

export const sectorAt = (doom, x, y) => doom._B_SectorAt(Math.round(x * FRACUNIT), Math.round(y * FRACUNIT));
