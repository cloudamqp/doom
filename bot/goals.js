// What the bot does next when nothing shoots at it. It knows the whole map,
// as players who have run it a hundred times do, but not what its switches
// do. So it takes what it needs on the way, leaves by the exit as soon as
// there is a way to it, and until then presses and crosses what it has
// tried the least and goes where it has not been.

import {
  AMMO_PICKUPS,
  ARMOR_PICKUPS,
  BONUS_PICKUPS,
  EXITS,
  HEALTH_PICKUPS,
  HEIGHT,
  KEYS,
  MANUAL_DOORS,
  MF_SPECIAL,
  SECRET_EXITS,
  TELEPORTERS,
  WEAPON,
  WEAPON_PICKUPS,
  hasKey,
  trigger,
  unlocked,
} from "./doomdata.js";
import { CELL, STRAIGHT_COST, UNREACHED } from "./nav.js";

// How far in front of a switch the bot stands, and how far to both sides of
// a line it goes to cross it
const SWITCH_DISTANCES = [20, 36];
const CROSS_DISTANCE = 24;
// Setting things off opens the map up, so it counts as nearer than going to see
const TRIGGER_DISCOUNT = 0.5;
// The bot stays on what it is doing unless something else is this much nearer
const LOYALTY = 0.7;
// Offsets to the cells whose centers are within a thing's and a player's
// radius of the thing, on each axis
const TOUCH = [-24, -8, 8, 24];

const costOf = (units) => (units / CELL) * STRAIGHT_COST;

// How far the bot goes out of its way for a thing, in map units
function detour(thing, game) {
  const { type } = thing;
  if (KEYS.has(type)) return hasKey(game.cards, KEYS.get(type)) ? 0 : Infinity;
  if (WEAPON_PICKUPS.has(type)) return game.weapons & (1 << WEAPON_PICKUPS.get(type)) ? 0 : game.deathmatch ? 4000 : 2000;
  if (HEALTH_PICKUPS.has(type)) {
    if (game.health < 35) return 4000;
    if (game.health < 70) return 1500;
    return game.health + HEALTH_PICKUPS.get(type) <= 100 ? 400 : 0;
  }
  if (ARMOR_PICKUPS.has(type)) return game.armor < ARMOR_PICKUPS.get(type) / 2 ? 800 : 0;
  if (AMMO_PICKUPS.has(type)) {
    const ammo = AMMO_PICKUPS.get(type);
    const share = game.ammo[ammo] / game.maxAmmo[ammo];
    return share < 0.2 ? 1500 : share < 0.5 ? 600 : 0;
  }
  return BONUS_PICKUPS.has(type) ? 300 : 0;
}

// Points along a line, a distance to its front (positive) or back
function beside(line, distance) {
  const length = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
  const [dx, dy] = [(line.x2 - line.x1) / length, (line.y2 - line.y1) / length];
  const points = [];
  for (let along = Math.min(CELL, length / 2); along < length; along += CELL) {
    points.push({ x: line.x1 + dx * along + dy * distance, y: line.y1 + dy * along - dx * distance });
  }
  return points;
}

// Things are picked up by touching them, also from beside the ledge they
// lie on: the nearest cell to do it from. At most 8 units below the
// player's feet and no higher than its head, see P_TouchSpecialThing.
function touching(thing, nav, costAt) {
  let nearest = -1;
  for (const dy of TOUCH) {
    for (const dx of TOUCH) {
      const cell = nav.cellAt(thing.x + dx, thing.y + dy);
      if (costAt(cell) >= costAt(nearest)) continue;
      const height = thing.z - nav.floorAt(cell);
      if (height >= -8 && height <= HEIGHT) nearest = cell;
    }
  }
  return nearest;
}

// Picks the goal: { key, kind, cell, cost } and what the kind needs.
//   item     walk over a thing
//   use      press use on a line
//   cross    walk across a line, from the point near it to the one beyond
//   hunt     go to an enemy marine
//   explore  go to a cell
// banned(key) tells what the bot has given up on and tries(key) how many
// times it has done it, visited has the sectors it has been in, current is
// the key of the goal it has.
export function chooseGoal({ game, things, lines, nav, flood, banned, tries, visited, current }) {
  const costAt = (cell) => (cell < 0 ? UNREACHED : flood.cost[cell]);
  // The nearest of the goals tried the fewest times
  const nearest = (goals) =>
    goals
      .filter((goal) => goal.cost < UNREACHED && !banned(goal.key))
      .map((goal) => ({ ...goal, tries: tries(goal.key), weighted: goal.cost * (goal.key === current ? LOYALTY : 1) }))
      .reduce((best, goal) => (!best || goal.tries < best.tries || (goal.tries === best.tries && goal.weighted < best.weighted) ? goal : best), undefined);

  const items = things
    .filter((thing) => thing.flags & MF_SPECIAL)
    .map((thing) => {
      const cell = touching(thing, nav, costAt);
      const [weapon, health] = [WEAPON_PICKUPS.has(thing.type), HEALTH_PICKUPS.has(thing.type)];
      return { key: `item:${thing.id}`, kind: "item", cell, cost: costAt(cell), thing: thing.id, limit: costOf(detour(thing, game)), weapon, health };
    })
    .filter((item) => item.cost <= item.limit);
  const isKey = (item) => item.limit === Infinity;

  const hunted = things
    .filter((thing) => game.deathmatch && thing.player && thing.health > 0 && thing.id !== game.self)
    .map((thing) => {
      const cell = nav.standingAt(thing);
      return { key: `hunt:${thing.id}`, kind: "hunt", cell, cost: costAt(cell) };
    });

  const triggers = lines.flatMap((line, index) => {
    const kind = trigger(line.special);
    if (!kind || MANUAL_DOORS.has(line.special) || !unlocked(line.special, game.cards)) return [];
    const key = `${kind}:${index}`;
    if (kind === "use") {
      const cell = SWITCH_DISTANCES.flatMap((distance) => beside(line, distance))
        .map((spot) => nav.standingAt(spot))
        .reduce((best, cell) => (costAt(cell) < costAt(best) ? cell : best), -1);
      return [{ key, kind, cell, cost: costAt(cell), line }];
    }
    // Teleporters only work from the front
    const sides = TELEPORTERS.has(line.special) ? [CROSS_DISTANCE] : [CROSS_DISTANCE, -CROSS_DISTANCE];
    return sides.flatMap((distance) => {
      const beyond = beside(line, -distance);
      return beside(line, distance).map((near, along) => {
        const cell = nav.standingAt(near);
        // There has to be a way on at the other side
        const cost = costAt(nav.standingAt(beyond[along])) < UNREACHED ? costAt(cell) : UNREACHED;
        return { key, kind, cell, cost, line, near, beyond: beyond[along] };
      });
    });
  });
  const exits = triggers.filter((goal) => EXITS.has(goal.line.special));
  const secretExits = triggers.filter((goal) => SECRET_EXITS.has(goal.line.special));
  const others = triggers
    .filter((goal) => !EXITS.has(goal.line.special) && !SECRET_EXITS.has(goal.line.special))
    .map((goal) => ({ ...goal, cost: goal.cost < UNREACHED ? Math.round(goal.cost * TRIGGER_DISCOUNT) : UNREACHED }));
  const unseen = nav.nearest(flood, (sector) => !visited.has(sector));
  const explore = { key: "explore", kind: "explore", cell: unseen, cost: costAt(unseen) };

  // A deathmatch goes on where it is, and is about the other marines: only
  // a better weapon than the pistol or health come before them
  if (game.deathmatch) {
    const armed = game.weapons >> WEAPON.shotgun !== 0;
    const urgent = items.filter((item) => (item.weapon && !armed) || (item.health && game.health < 50));
    return nearest(urgent) ?? nearest(hunted) ?? nearest(items) ?? nearest([...others, explore]);
  }
  return nearest(items.filter(isKey)) ?? nearest(items) ?? nearest(exits) ?? nearest([...others, explore]) ?? nearest(secretExits);
}
