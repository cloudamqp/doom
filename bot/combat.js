// How the bot fights: which enemy first, with what, where to aim and where
// to stand.

import {
  AIM_RANGE,
  MF_MISSILE,
  MF_SHOOTABLE,
  RADIUS,
  WEAPON,
  WEAPONS,
  isBiter,
  isBoss,
  isHitscanner,
  isMonster,
} from "./doomdata.js";
import { angleTo, distance, turnTo } from "./geometry.js";
import { TOP_SPEED } from "./steer.js";

// How far the bot looks for a better place to stand, and in how many directions
const SIDESTEP = 48;
const DIRECTIONS = 16;
// A missile that comes this near in this many tics is worth getting away from
const NEAR_MISS = 64;
const MISSILE_WARNING = 40;
// Biters are kept at this distance
const BITE_RANGE = 300;

// Monsters, and in a deathmatch the other marines
export function isEnemy(thing, game) {
  if (!(thing.flags & MF_SHOOTABLE) || thing.health <= 0 || thing.id === game.self) return false;
  return thing.player ? game.deathmatch : isMonster(thing);
}

// The enemy to shoot first: the nearest, but those whose shots can't be
// dodged count as nearer, and the bot stays on the one it has
export function pickTarget(self, enemies, current) {
  const urgency = (enemy) => distance(self, enemy) * (isHitscanner(enemy) ? 0.5 : 1) * (enemy.id === current ? 0.7 : 1);
  return enemies.reduce((first, enemy) => (!first || urgency(enemy) < urgency(first) ? enemy : first), undefined);
}

// What the bot remembers of the enemy it fights, a tic on: { id, health,
// unhurt }, with the tics it has fought this enemy since it last hurt it.
// Healing, or a while out of sight, doesn't make it another enemy.
export function fought(before, target) {
  const same = before?.id === target.id;
  const hurt = same && target.health < before.health;
  return { id: target.id, health: target.health, unhurt: same && !hurt ? before.unhurt + 1 : 0 };
}

const melee = (weapon) => weapon === WEAPON.fist || weapon === WEAPON.chainsaw;

// The best weapon the player has ammo for
export function pickWeapon(game, target, far, crowd) {
  const usable = (weapon) => {
    const { ammo, uses } = WEAPONS[weapon];
    return game.weapons & (1 << weapon) && (ammo === undefined || game.ammo[ammo] >= uses);
  };
  const wanted = [
    (isBoss(target) || crowd >= 4) && WEAPON.bfg,
    WEAPON.plasma,
    // Rockets hurt whoever is near where they land
    far > WEAPONS[WEAPON.rocket].splash && WEAPON.rocket,
    ...(far < 400 ? [WEAPON.shotgun, WEAPON.chaingun] : [WEAPON.chaingun, WEAPON.shotgun]),
    WEAPON.pistol,
  ];
  // Doom gives the chainsaw to those who ask for the fist and have one
  return wanted.find((weapon) => weapon !== false && usable(weapon)) ?? WEAPON.fist;
}

export const holds = (game, weapon) => game.weapon === weapon || (melee(weapon) && melee(game.weapon));

// Where to face to hit a target. Missiles take their time, so they are
// sent to where the target will be.
export function aimAt(self, target, weapon) {
  const { speed } = WEAPONS[weapon];
  if (!speed) return angleTo(self, target);
  const flight = distance(self, target) / speed;
  return angleTo(self, { x: target.x + target.momx * flight, y: target.y + target.momy * flight });
}

// Whether the bot is close enough for its weapon to hit
export function inRange(self, target, weapon) {
  const far = distance(self, target);
  if (melee(weapon)) return far < WEAPONS[weapon].reach + target.radius;
  return far < AIM_RANGE && far > (WEAPONS[weapon].splash ?? 0);
}

// Whether a friend stands where the shot goes
export function blocked(self, facing, target, friends) {
  return friends.some((friend) => {
    const far = distance(self, friend);
    return far < distance(self, target) && Math.abs(turnTo(facing, angleTo(self, friend))) < Math.atan2(2 * RADIUS, far);
  });
}

// How near a missile comes to a point, if it gets there soon
function nearMiss(missile, point) {
  const speed = Math.hypot(missile.momx, missile.momy);
  if (speed === 0) return Infinity;
  const [x, y] = [point.x - missile.x, point.y - missile.y];
  const ahead = (x * missile.momx + y * missile.momy) / speed;
  if (ahead < 0 || ahead > speed * MISSILE_WARNING) return Infinity;
  return Math.abs(x * missile.momy - y * missile.momx) / speed;
}

// Missiles on their way to the player
export function incoming(self, things) {
  return things.filter((thing) => thing.flags & MF_MISSILE && nearMiss(thing, self) < NEAR_MISS);
}

// The velocity to fight with: around the target at the weapon's best
// distance, out of the way of missiles, and never off a ledge or into slime.
// strafe is 1 or -1, the way round. Without a target only missiles matter.
export function sidestep({ self, nav, target, weapon, missiles, strafe }) {
  const here = nav.standingAt(self);
  const best = target && (isBiter(target) && !melee(weapon) ? BITE_RANGE : (WEAPONS[weapon].best ?? 0));
  const around = target && angleTo(self, target) + (strafe * Math.PI) / 2;
  const worth = (point, direction) => {
    const cell = nav.standingAt(point);
    let score = 0;
    if (nav.hazardAt(cell) || nav.floorAt(cell) < nav.floorAt(here) - 24) score -= 500;
    for (const missile of missiles) score -= Math.max(0, NEAR_MISS - nearMiss(missile, point)) * 10;
    if (target) score -= Math.abs(distance(point, target) - best) - Math.cos(direction - around) * 24;
    return score;
  };

  let [velocity, most] = [{ x: 0, y: 0 }, worth(self, around + Math.PI / 2)];
  for (let step = 0; step < DIRECTIONS; step++) {
    const direction = (step / DIRECTIONS) * 2 * Math.PI;
    const point = { x: self.x + Math.cos(direction) * SIDESTEP, y: self.y + Math.sin(direction) * SIDESTEP };
    if (!nav.clear(self, point)) continue;
    const score = worth(point, direction);
    if (score > most) [velocity, most] = [{ x: Math.cos(direction) * TOP_SPEED, y: Math.sin(direction) * TOP_SPEED }, score];
  }
  return velocity;
}
