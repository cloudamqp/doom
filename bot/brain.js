// Plays Doom: asked for a ticcmd every tic, it reads the world, decides and
// answers with its moves. Fighting comes first, then getting on with the
// map, see combat.js and goals.js.

import { aimAt, blocked, holds, inRange, incoming, isEnemy, pickTarget, pickWeapon, sidestep } from "./combat.js";
import {
  AIM_RANGE,
  BT_ATTACK,
  BT_CHANGE,
  BT_USE,
  BT_WEAPONSHIFT,
  HAZARDS,
  MANUAL_DOORS,
  MF_SHOOTABLE,
  MF_SOLID,
  MF_SPECIAL,
  NO_WEAPON_CHANGE,
  RADIUS,
  STEP,
  TELEPORTERS,
  TELEPORT_DESTINATION,
  TICRATE,
  USE_RANGE,
  unlocked,
} from "./doomdata.js";
import { angleTo, closestOn, distance, inFront, turnTo } from "./geometry.js";
import { chooseGoal } from "./goals.js";
import { CELL, Nav } from "./nav.js";
import { STILL, TURN, push, strafeRun, toward } from "./steer.js";
import { LEVEL, readGame, readLines, readSectors, readThings, sectorAt } from "./world.js";

const SECOND = TICRATE;
// A new look at what to do, this often
const PLAN_INTERVAL = SECOND;
// The route is followed by aiming for the furthest of its next cells that
// the bot can walk straight to
const LOOKAHEAD = 12;
// Further than this from the route, the bot has been pushed off it
const OFF_ROUTE = 96;
const ARRIVED = 24;
// Pressing use again on a door that opens would close it
const USE_INTERVAL = SECOND;
// How long the bot waits for what a switch did, rides a lift, tries to
// reach a thing or a line, and shoots at an enemy that takes no harm
const SWITCH_PATIENCE = 3 * SECOND;
const RIDE_PATIENCE = 10 * SECOND;
// How many times it tries a door
const DOOR_PATIENCE = 3;
const REACH_PATIENCE = 2 * SECOND;
const TARGET_PATIENCE = 5 * SECOND;
// How long it leaves alone what it could not get to, at first
const STUCK_BAN = 60 * SECOND;
// Moving less than this far in a second, the bot is stuck
const STUCK = 24;
// And moves another way for this long
const SHAKE = 12;
const GOLDEN_ANGLE = 2.4;
const STRAFE_INTERVAL = 2 * SECOND;

export class Brain {
  #doom;
  #report;
  #trace;
  #tic = 0;
  #turns = []; // sent but not run by the game yet: { tic, turn }
  #score; // as of the last tic: { dead, frags }
  #level; // what the bot knows of the map it is on
  #sectors; // as of this tic and the one before
  #before;
  #banned = new Map(); // goal or enemy key -> the tic it is let back in
  #tries = new Map(); // key -> times the bot has pressed, crossed or given up on it
  #goal;
  #route = [];
  #at = 0; // how far along the route the bot is
  #planned = -Infinity;
  #arrived; // tic the bot got to the end of its route
  #crossing = false; // at a line to cross: whether it has been on the near side
  #used = -Infinity; // tic it last pressed use
  #knocks = 0; // times it pressed use on the door in its way
  #watching; // what a switch set off: { tag, until }
  #riding; // the lift under the bot: { sector, floor it had as the bot got on, since, spot to stand on }
  #target; // the enemy shot at last: { id, health, since it was picked or hurt }
  #strafe = 1;
  #stuck = { tic: 0, x: 0, y: 0, strikes: 0 };
  #shaking; // stuck, the bot moves at random: { until, direction }

  // report(text) is told how the bot fares: the levels it enters and
  // finishes, its deaths and its frags. trace(text) what it is up to.
  constructor(doom, { report = () => {}, trace = () => {} } = {}) {
    this.#doom = doom;
    this.#report = report;
    this.#trace = trace;
  }

  // The moves for a tic: { forward, side, turn, buttons } as in Doom's
  // ticcmd_t, see doom/src/doom/b_bot.c
  ticcmd(maketic) {
    const game = readGame(this.#doom);
    this.#tic = game.tic;
    if (game.state !== LEVEL) return this.#tap(game, BT_USE); // skips the intermission
    const things = readThings(this.#doom);
    const self = things.find((thing) => thing.id === game.self);
    if (!self) return null;
    this.#keepScore(game);
    if (game.dead) return this.#tap(game, BT_USE); // comes back to life
    if (this.#level?.map !== game.map || game.time < this.#level.time) this.#enter(game, things);
    this.#level.time = game.time;
    this.#level.kills = `${game.kills}/${game.monsters}`;
    this.#before = this.#sectors;
    this.#sectors = readSectors(this.#doom).map((sector) => ({ ...sector, hazard: HAZARDS.has(sector.special) }));
    this.#level.nav.update(this.#sectors, this.#level.openable);
    const waiting = this.#waiting(self);
    // The bot has been where it has stood, and on a lift once it has
    // ridden it: one it only passed by may still take it somewhere
    if (!this.#sectors[self.sector].active) this.#level.visited.add(self.sector);

    const facing = this.#facing(game, self);
    const { velocity, face, buttons } = this.#fight(game, self, things, facing, waiting) ?? this.#travel(game, self, things, waiting);
    const moving = Math.hypot(velocity.x, velocity.y) > 1;
    const wanted = face ?? (moving ? strafeRun(Math.atan2(velocity.y, velocity.x), facing) : facing);
    const turn = Math.round(turnTo(facing, wanted) / TURN);
    this.#turns.push({ tic: maketic, turn });
    return { ...push(self, facing + turn * TURN, velocity), turn, buttons };
  }

  #keepScore(game) {
    const { dead = false, frags = 0 } = this.#score ?? {};
    if (game.dead && !dead) this.#report(`Died on ${game.map}`);
    if (game.frags > frags) this.#report(`Fragged a marine, ${game.frags} so far`);
    this.#score = { dead: game.dead, frags: game.frags };
  }

  #tap(game, button) {
    if (this.#level && game.state !== LEVEL) {
      const seconds = Math.floor(this.#level.time / TICRATE);
      this.#report(`Finished ${this.#level.map} in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}, kills ${this.#level.kills}`);
      this.#level = undefined;
    }
    return { forward: 0, side: 0, turn: 0, buttons: game.tic % 2 ? button : 0 };
  }

  #enter(game, things) {
    const lines = readLines(this.#doom);
    const obstacles = things.filter((thing) => thing.flags & MF_SOLID && !(thing.flags & (MF_SHOOTABLE | MF_SPECIAL)));
    const nav = new Nav({ lines, obstacles, sectorAt: (x, y) => sectorAt(this.#doom, x, y) });
    // Per sector, its floor as the map starts and the tic it or its ceiling last moved
    const floors = readSectors(this.#doom).map((sector) => sector.floor);
    const moved = floors.map(() => -Infinity);
    this.#level = { map: game.map, time: game.time, lines, nav, floors, moved, visited: new Set(), openable: new Set(), jammed: new Set() };
    this.#sectors = undefined;
    this.#banned.clear();
    this.#tries.clear();
    this.#drop();
    this.#report(`Entering ${game.map}`);
  }

  // Where the player will face when this tic's moves are run: in a netgame
  // the turns of the last few tics are still on their way
  #facing(game, self) {
    this.#turns = this.#turns.filter(({ tic }) => tic >= game.tic);
    return self.angle + this.#turns.reduce((sum, { turn }) => sum + turn, 0) * TURN;
  }

  #isBanned = (key) => this.#banned.get(key) > this.#tic;

  #ban(key, tics = Infinity) {
    this.#banned.set(key, this.#tic + tics);
  }

  #tried(key) {
    this.#tries.set(key, (this.#tries.get(key) ?? 0) + 1);
  }

  // Leaves alone what is out of reach, twice as long every time
  #giveUp(key, tics) {
    this.#ban(key, tics * 2 ** (this.#tries.get(key) ?? 0));
    this.#tried(key);
    if (key === this.#goal?.key) this.#drop();
  }

  #drop() {
    this.#crossing = false;
    this.#goal = undefined;
    this.#route = [];
    this.#arrived = undefined;
    this.#planned = -Infinity;
  }

  // Pressed once, a held button does nothing more
  #use() {
    if (this.#tic - this.#used < USE_INTERVAL) return 0;
    this.#used = this.#tic;
    return BT_USE;
  }

  // Shoots what is in sight, or nothing if there is nothing to shoot
  #fight(game, self, things, facing, waiting) {
    const { nav } = this.#level;
    const enemies = things.filter((thing) => isEnemy(thing, game));
    const inSight = enemies.filter((enemy) => enemy.visible && distance(self, enemy) < AIM_RANGE && !this.#isBanned(`enemy:${enemy.id}`));
    const target = pickTarget(self, inSight, this.#target?.id);
    if (!target) return undefined;
    // An enemy that comes in and out of sight is still the same one
    if (target.id !== this.#target?.id || target.health < this.#target.health) {
      this.#target = { id: target.id, health: target.health, since: this.#tic };
    } else if (this.#tic - this.#target.since > TARGET_PATIENCE) {
      this.#giveUp(`enemy:${target.id}`, 2 * TARGET_PATIENCE);
    }
    if (this.#tic % STRAFE_INTERVAL === 0) this.#strafe = -this.#strafe;

    const far = distance(self, target);
    const weapon = pickWeapon(game, target, far, inSight.length);
    const face = aimAt(self, target, game.weapon);
    const friends = things.filter((thing) => thing.player && thing.id !== game.self && !game.deathmatch);
    let buttons = 0;
    if (!holds(game, weapon) && game.pending === NO_WEAPON_CHANGE) buttons |= BT_CHANGE | (weapon << BT_WEAPONSHIFT);
    if (inRange(self, target, game.weapon) && !blocked(self, face, target, friends)) buttons |= BT_ATTACK;
    // On a lift, the fight is no reason to get off
    const velocity = waiting ? this.#hold(self) : sidestep({ self, nav, target, weapon: game.weapon, missiles: incoming(self, things), strafe: this.#strafe });
    this.#drop(); // the fight takes the bot off its way
    this.#stuck.tic = this.#tic;
    return { velocity, face, buttons };
  }

  // Gets on with the map
  #travel(game, self, things, waiting) {
    if (waiting) return { ...this.#stay(), velocity: this.#hold(self) };
    const missiles = incoming(self, things);
    if (missiles.length > 0) return { velocity: sidestep({ self, nav: this.#level.nav, missiles }), buttons: 0 };
    if (this.#shaking && this.#tic < this.#shaking.until) {
      const { direction } = this.#shaking;
      return { velocity: { x: Math.cos(direction) * 20, y: Math.sin(direction) * 20 }, buttons: 0 };
    }
    if (this.#tic - this.#planned >= PLAN_INTERVAL) this.#plan(game, self, things);
    if (!this.#goal) return this.#stay();
    this.#checkStuck(self);
    return this.#follow(self, things);
  }

  // Where to be while waiting: on a lift, in the middle of it
  #hold(self) {
    return this.#riding ? toward(self, this.#riding.spot, true) : STILL;
  }

  // Standing still on purpose is not being stuck
  #stay(face, buttons = 0) {
    this.#stuck.tic = this.#tic;
    return { velocity: STILL, face, buttons };
  }

  // Whether to stand still for a lift under the bot, or for what a switch set off
  #waiting(self) {
    const { moved, floors } = this.#level;
    const [now, before] = [this.#sectors, this.#before ?? this.#sectors];
    now.forEach((sector, index) => {
      if (sector.floor !== before[index].floor || sector.ceiling !== before[index].ceiling) moved[index] = this.#tic;
    });
    const moving = (index) => now[index].active && moved[index] === this.#tic;

    // A lift is a floor on the move, or one that waits away from where it
    // started. It is ridden until it stops at another height than the bot
    // got on at.
    const under = now[self.sector];
    const lift = under.active && (under.floor !== before[self.sector].floor || under.floor !== floors[self.sector]);
    if (!under.active) this.#riding = undefined;
    else if (lift && this.#riding?.sector !== self.sector) {
      const spot = this.#level.nav.middleOf(self.sector, self);
      this.#riding = { sector: self.sector, floor: under.floor, since: this.#tic, spot: spot < 0 ? self : this.#level.nav.center(spot) };
    }
    if (this.#riding && this.#tic - this.#riding.since < RIDE_PATIENCE) {
      if (moving(self.sector) || Math.abs(under.floor - this.#riding.floor) <= STEP) return true;
    }

    if (!this.#watching || this.#tic > this.#watching.until) return false;
    // Give it a moment to start
    if (this.#tic < this.#watching.until - SWITCH_PATIENCE + 10) return true;
    return now.some((sector, index) => sector.tag === this.#watching.tag && moving(index));
  }

  #plan(game, self, things) {
    const { nav, lines, visited } = this.#level;
    const sectors = this.#sectors;
    // Switches change type once they are spent, and keys open doors
    readLines(this.#doom).forEach(({ special }, index) => (lines[index].special = special));
    const doors = lines.filter((line) => MANUAL_DOORS.has(line.special) && line.back >= 0 && unlocked(line.special, game.cards));
    this.#level.openable = new Set(doors.map((line) => line.back).filter((sector) => !this.#level.jammed.has(sector)));
    nav.update(sectors, this.#level.openable);

    const teleporters = new Map();
    for (const line of lines.filter((line) => TELEPORTERS.has(line.special))) {
      const destination = things.find((thing) => thing.type === TELEPORT_DESTINATION && sectors[thing.sector].tag === line.tag);
      if (destination) teleporters.set(line, nav.standingAt(destination));
    }

    const tries = (key) => this.#tries.get(key) ?? 0;
    // Wading through slime is the last thing to try
    let flood;
    let goal;
    for (const safe of [true, false]) {
      flood = nav.flood(nav.standingAt(self), { teleporters, safe });
      goal = chooseGoal({ game, things, lines, nav, flood, visited, tries, banned: this.#isBanned, current: this.#goal?.key });
      if (goal) break;
    }
    if (goal && goal.key !== this.#goal?.key) {
      this.#trace(`${game.map}: ${describe(goal)}`);
      this.#arrived = undefined;
      this.#crossing = false;
      this.#stuck.strikes = 0;
    }
    if (!goal) {
      // Nowhere to go: what was in the way before may not be now
      this.#trace(`${game.map}: nothing to do here`);
      this.#banned.clear();
      this.#level.jammed.clear();
    }
    this.#goal = goal;
    this.#route = goal ? nav.path(flood, goal.cell) : [];
    this.#at = 0;
    this.#planned = this.#tic;
  }

  #checkStuck(self) {
    const stuck = this.#stuck;
    if (this.#tic - stuck.tic < SECOND) return;
    if (distance(stuck, self) < STUCK) {
      // A turn of the golden angle each time tries every way out in the end
      this.#shaking = { until: this.#tic + SHAKE, direction: (this.#shaking?.direction ?? 0) + GOLDEN_ANGLE };
      if (++stuck.strikes >= 3) this.#giveUp(this.#goal.key, STUCK_BAN);
    }
    Object.assign(stuck, { tic: this.#tic, x: self.x, y: self.y });
  }

  // Walks the route, opens the doors on it, and does what the goal is about at its end
  #follow(self, things) {
    const { nav } = this.#level;
    const route = this.#route;
    const centers = (index) => nav.center(route[index]);
    const last = route.length - 1;

    for (let index = this.#at + 1; index <= Math.min(this.#at + LOOKAHEAD, last); index++) {
      if (distance(self, centers(index)) < distance(self, centers(this.#at))) this.#at = index;
    }
    const at = this.#at;
    if (last < 0 || distance(self, centers(at)) > OFF_ROUTE) {
      this.#planned = -Infinity;
      return this.#stay();
    }

    // The route takes doors as open. A closed one stops the bot until it has opened.
    let open = at;
    while (open < Math.min(at + LOOKAHEAD, last) && nav.passable(route[open], route[open + 1], true)) open++;
    if (open < last && open < at + 3) {
      const door = centers(open + 1);
      const behind = nav.sectorsAt(route[open + 1]);
      const opening = behind.some((sector) => this.#sectors[sector].active);
      if (distance(self, door) > USE_RANGE - CELL) return { velocity: toward(self, centers(open), true), buttons: 0 };
      const buttons = opening ? 0 : this.#use();
      if (buttons && ++this.#knocks > DOOR_PATIENCE) {
        // It only opens from the other side, or not for players at all
        for (const sector of behind) this.#level.jammed.add(sector);
        this.#drop();
      }
      return this.#stay(angleTo(self, door), buttons);
    }
    this.#knocks = 0;

    let ahead = Math.min(at + 1, last);
    for (let index = open; index > ahead; index--) {
      if (nav.clear(self, centers(index))) ahead = index;
      if (ahead === index) break;
    }
    if (ahead < last || distance(self, centers(last)) > ARRIVED) return { velocity: toward(self, centers(ahead)), buttons: 0 };

    this.#arrived ??= this.#tic;
    return this.#act(self, things);
  }

  // At the end of the route: what the goal is about
  #act(self, things) {
    const goal = this.#goal;
    const late = this.#tic - this.#arrived > REACH_PATIENCE;
    switch (goal.kind) {
      case "item": {
        const thing = things.find((thing) => thing.id === goal.thing);
        if (thing && !late) return { velocity: toward(self, thing), buttons: 0 };
        // Still there: the player has no use for it
        if (thing) this.#ban(goal.key);
        break;
      }
      case "use": {
        // Use reaches along where the player faces: at the line's very end it may miss
        const point = closestOn(goal.line, self, RADIUS);
        if (distance(self, point) > USE_RANGE - CELL && !late) return { velocity: toward(self, point, true), buttons: 0 };
        const buttons = this.#use();
        if (!buttons && !late) return this.#stay(angleTo(self, point));
        this.#tried(goal.key);
        this.#watching = { tag: goal.line.tag, until: this.#tic + SWITCH_PATIENCE };
        this.#drop();
        return this.#stay(angleTo(self, point), buttons);
      }
      case "cross": {
        // A line is set off by walking across it, so from its near side
        const side = inFront(goal.line, self);
        this.#crossing ||= side === inFront(goal.line, goal.near) && distance(self, closestOn(goal.line, self)) > CELL / 2;
        if (!this.#crossing && !late) return { velocity: toward(self, goal.near), buttons: 0 };
        if (side !== inFront(goal.line, goal.beyond) && !late) return { velocity: toward(self, goal.beyond), buttons: 0 };
        this.#tried(goal.key);
        break;
      }
      case "explore": {
        const { nav, visited } = this.#level;
        if (nav.standingAt(self) !== goal.cell && !late) return { velocity: toward(self, nav.center(goal.cell), true), buttons: 0 };
        // As near as it gets
        visited.add(nav.sectorAt(goal.cell));
        break;
      }
    }
    this.#drop();
    return this.#stay();
  }
}

function describe(goal) {
  switch (goal.kind) {
    case "item":
      return "going for an item";
    case "use":
      return `going to press a switch (type ${goal.line.special})`;
    case "cross":
      return `going to cross a line (type ${goal.line.special})`;
    case "hunt":
      return "hunting a marine";
    default:
      return "exploring";
  }
}
