// Finds ways through a map on a grid of cells, the way Doom itself decides
// where a player fits (P_CheckPosition and P_TryMove in doom/src/doom/p_map.c):
// a player is a box that no wall may cut, standing on the highest floor
// and under the lowest ceiling of the sectors it touches. It climbs steps
// of 24 units and needs 56 units of headroom.
//
// What the walls allow is worked out once per map. Floors and ceilings
// move, so the heights are given anew with update().

import { HEIGHT, ML_BLOCKING, RADIUS, STEP, TELEPORTERS } from "./doomdata.js";
import { side } from "./geometry.js";

export const CELL = 16;
const BUCKET = 128;
export const UNREACHED = 0x7fffffff;

// The eight neighbors: straight ones first, then each diagonal with the
// two straight moves it cuts between
const STRAIGHT = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const DIAGONAL = [[1, 1, 0, 1], [-1, 1, 1, 2], [-1, -1, 2, 3], [1, -1, 3, 0]];
export const STRAIGHT_COST = 10;
const DIAGONAL_COST = 14;
// Per neighboring wall, keeps ways out of corners and off door frames
const WALL_COST = 4;
const HAZARD_COST = 60;
// Above the dearest step
const BUCKETS = 128;

// Whether a line cuts the box of a player standing at x, y
function cuts(line, x, y) {
  const [left, right, bottom, top] = [x - RADIUS, x + RADIUS, y - RADIUS, y + RADIUS];
  if (Math.max(line.x1, line.x2) <= left || Math.min(line.x1, line.x2) >= right) return false;
  if (Math.max(line.y1, line.y2) <= bottom || Math.min(line.y1, line.y2) >= top) return false;
  const corners = [left, right].flatMap((x) => [bottom, top].map((y) => side(line, { x, y })));
  return Math.min(...corners) < 0 && Math.max(...corners) > 0;
}

export class Nav {
  #x0;
  #y0;
  #columns;
  #rows;
  #solid; // per cell: a wall or a pillar is in the way
  #walls; // per cell: how many of its neighbors are solid
  #sector; // per cell: the sector at its center
  #group; // per cell: index of the sectors it touches, in #groups
  #groups = [];
  #floor; // per group, as of the last update()
  #ceiling; // per group, with the doors the player can open taken as open
  #headroom; // per group, as it is
  #hazard; // per group
  #portals = new Map(); // cell -> teleporter lines that cut it
  #portal; // per cell: whether it has any

  // lines and obstacles ({ x, y, radius } of pillars and the like) as the
  // map starts, sectorAt(x, y) gives the index of the sector at a point
  constructor({ lines, sectorAt, obstacles = [] }) {
    const xs = lines.flatMap((line) => [line.x1, line.x2]);
    const ys = lines.flatMap((line) => [line.y1, line.y2]);
    // Two cells of margin, the outermost ring stays solid
    this.#x0 = Math.floor(Math.min(...xs) / CELL - 2) * CELL;
    this.#y0 = Math.floor(Math.min(...ys) / CELL - 2) * CELL;
    this.#columns = Math.ceil((Math.max(...xs) - this.#x0) / CELL) + 3;
    this.#rows = Math.ceil((Math.max(...ys) - this.#y0) / CELL) + 3;
    const cells = this.#columns * this.#rows;
    this.#solid = new Uint8Array(cells);
    this.#walls = new Uint8Array(cells);
    this.#sector = new Int32Array(cells);
    this.#group = new Int32Array(cells);
    this.#portal = new Uint8Array(cells);
    this.#survey(lines, sectorAt);
    for (const { x, y, radius } of obstacles) this.#block(x, y, radius + RADIUS);
    this.#countWalls();
  }

  get cells() {
    return this.#solid.length;
  }

  cellAt(x, y) {
    const column = Math.round((x - this.#x0) / CELL);
    const row = Math.round((y - this.#y0) / CELL);
    if (column < 0 || row < 0 || column >= this.#columns || row >= this.#rows) return -1;
    return row * this.#columns + column;
  }

  center(cell) {
    return { x: this.#x0 + (cell % this.#columns) * CELL, y: this.#y0 + Math.floor(cell / this.#columns) * CELL };
  }

  // The cell a player at a point stands in: the nearest one it fits in.
  // With the height it stands at (z), on a floor it can be on: beside a
  // ledge, the nearest cell may be up on it.
  standingAt({ x, y, z }) {
    const cell = this.cellAt(x, y);
    const fits = (cell) => !this.#solid[cell] && (z === undefined || Math.abs(this.floorAt(cell) - z) <= STEP);
    if (cell < 0 || fits(cell)) return cell;
    let nearest = -1;
    let least = Infinity;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const other = cell + dy * this.#columns + dx;
        if (other < 0 || other >= this.cells || !fits(other)) continue;
        const center = this.center(other);
        const distance = Math.hypot(center.x - x, center.y - y);
        if (distance < least) [nearest, least] = [other, distance];
      }
    }
    // In the air, or on something that moves
    return nearest < 0 && z !== undefined ? this.standingAt({ x, y }) : nearest;
  }

  sectorAt(cell) {
    return this.#sector[cell];
  }

  // The middle of a sector, around a point: of the cells where a player
  // stands in that sector only, the one nearest to the middle of them all.
  // A lift won't rise with a player's head under the doorway. Or -1.
  middleOf(sector, { x, y }, reach = 8) {
    const cell = this.cellAt(x, y);
    const inside = [];
    for (let dy = -reach; dy <= reach && cell >= 0; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const other = cell + dy * this.#columns + dx;
        if (other < 0 || other >= this.cells || this.#solid[other]) continue;
        const sectors = this.sectorsAt(other);
        if (sectors.length === 1 && sectors[0] === sector) inside.push(this.center(other));
      }
    }
    if (inside.length === 0) return -1;
    const middle = { x: inside.reduce((sum, at) => sum + at.x, 0) / inside.length, y: inside.reduce((sum, at) => sum + at.y, 0) / inside.length };
    const nearest = inside.reduce((best, at) => (Math.hypot(at.x - middle.x, at.y - middle.y) < Math.hypot(best.x - middle.x, best.y - middle.y) ? at : best));
    return this.cellAt(nearest.x, nearest.y);
  }

  // The sectors a player in the cell touches
  sectorsAt(cell) {
    return this.#groups[this.#group[cell]];
  }

  floorAt(cell) {
    return this.#floor[this.#group[cell]];
  }

  hazardAt(cell) {
    return this.#hazard[this.#group[cell]] > 0;
  }

  // Takes the sectors as they are now: { floor, ceiling, hazard } each.
  // openable has the sectors of doors the player can open.
  update(sectors, openable = new Set()) {
    const count = this.#groups.length;
    this.#floor = new Float64Array(count);
    this.#ceiling = new Float64Array(count);
    this.#headroom = new Float64Array(count);
    this.#hazard = new Uint8Array(count);
    this.#groups.forEach((group, index) => {
      let [floor, ceiling, real] = [-Infinity, Infinity, Infinity];
      for (const sector of group) {
        floor = Math.max(floor, sectors[sector].floor);
        real = Math.min(real, sectors[sector].ceiling);
        if (!openable.has(sector)) ceiling = Math.min(ceiling, sectors[sector].ceiling);
        if (sectors[sector].hazard) this.#hazard[index] = 1;
      }
      this.#floor[index] = floor;
      this.#ceiling[index] = ceiling;
      this.#headroom[index] = real;
    });
  }

  // Whether a player steps from a cell to the one next to it. With
  // closedDoors, doors the player can open are in the way while closed.
  passable(from, to, closedDoors = false) {
    if (this.#solid[to]) return false;
    const ceiling = closedDoors ? this.#headroom : this.#ceiling;
    const [a, b] = [this.#group[from], this.#group[to]];
    const floor = this.#floor[a];
    return ceiling[b] - this.#floor[b] >= HEIGHT && this.#floor[b] - floor <= STEP && ceiling[b] - floor >= HEIGHT;
  }

  // Whether the player walks straight from where it is to a point right now
  clear(from, to) {
    const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / (CELL / 2));
    let cell = this.standingAt(from);
    for (let step = 1; step <= steps && cell >= 0; step++) {
      const next = this.cellAt(from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps);
      if (next === cell) continue;
      if (next < 0 || !this.passable(cell, next, true)) return false;
      cell = next;
    }
    return cell >= 0;
  }

  // The cost of the cheapest way from a cell to every cell, and the cell
  // before each on that way. teleporters has the destination cell per
  // teleporter line that works. If safe, no way steps onto a floor that
  // hurts, they only lead off it.
  flood(start, { teleporters = new Map(), safe = false } = {}) {
    const cost = new Int32Array(this.cells).fill(UNREACHED);
    const previous = new Int32Array(this.cells).fill(-1);
    if (start < 0) return { cost, previous };
    // Dial's algorithm: costs are small whole numbers, so cells wait in
    // one bucket per cost, and the buckets go round
    const buckets = Array.from({ length: BUCKETS }, () => []);
    const reach = (from, to, total) => {
      if (total >= cost[to]) return;
      cost[to] = total;
      previous[to] = from;
      buckets[total % BUCKETS].push(to);
      waiting++;
    };
    const allowed = (from, to) => this.passable(from, to) && !(safe && this.hazardAt(to) && !this.hazardAt(from));
    const open = [false, false, false, false]; // the straight moves from the cell at hand
    let waiting = 0;
    reach(-1, start, 0);
    for (let total = 0; waiting > 0; total++) {
      const bucket = buckets[total % BUCKETS];
      while (bucket.length > 0) {
        const cell = bucket.pop();
        waiting--;
        if (cost[cell] !== total) continue; // found a cheaper way since
        STRAIGHT.forEach(([dx, dy], direction) => {
          const next = cell + dy * this.#columns + dx;
          open[direction] = allowed(cell, next);
          if (open[direction]) reach(cell, this.#through(cell, next, teleporters), total + STRAIGHT_COST + this.#toll(next));
        });
        for (const [dx, dy, first, second] of DIAGONAL) {
          const next = cell + dy * this.#columns + dx;
          if (!open[first] || !open[second] || !allowed(cell, next)) continue;
          reach(cell, this.#through(cell, next, teleporters), total + DIAGONAL_COST + this.#toll(next));
        }
      }
    }
    return { cost, previous };
  }

  // The nearest cell that flood() reached in a sector that wanted(sector)
  // accepts, or -1
  nearest({ cost }, wanted) {
    const accepted = new Map();
    let nearest = -1;
    for (let cell = 0; cell < this.cells; cell++) {
      if (cost[cell] >= (cost[nearest] ?? UNREACHED)) continue;
      const sector = this.#sector[cell];
      if (!accepted.has(sector)) accepted.set(sector, wanted(sector));
      if (accepted.get(sector)) nearest = cell;
    }
    return nearest;
  }

  // The cells on the way that flood() found to a cell, from the start
  path({ previous }, to) {
    const cells = [];
    for (let cell = to; cell >= 0; cell = previous[cell]) cells.push(cell);
    return cells.reverse();
  }

  #toll(cell) {
    return this.#walls[cell] * WALL_COST + this.#hazard[this.#group[cell]] * HAZARD_COST;
  }

  // Where a step ends: across a teleporter's front it is the destination
  #through(from, to, teleporters) {
    if (!this.#portal[from] && !this.#portal[to]) return to;
    const lines = [...(this.#portals.get(from) ?? []), ...(this.#portals.get(to) ?? [])];
    const [a, b] = [this.center(from), this.center(to)];
    for (const line of lines) {
      if (!teleporters.has(line) || side(line, a) >= 0 || side(line, b) < 0) continue;
      // The step crosses the line itself, not where it would go on
      const step = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
      if (side(step, { x: line.x1, y: line.y1 }) * side(step, { x: line.x2, y: line.y2 }) <= 0) return teleporters.get(line);
    }
    return to;
  }

  #survey(lines, sectorAt) {
    const buckets = new Map();
    const bucketAt = (x, y) => `${Math.floor(x / BUCKET)},${Math.floor(y / BUCKET)}`;
    for (const line of lines) {
      // Every bucket with a point whose box the line may cut
      for (let x = Math.min(line.x1, line.x2) - RADIUS; x < Math.max(line.x1, line.x2) + RADIUS + BUCKET; x += BUCKET) {
        for (let y = Math.min(line.y1, line.y2) - RADIUS; y < Math.max(line.y1, line.y2) + RADIUS + BUCKET; y += BUCKET) {
          const key = bucketAt(x, y);
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(line);
        }
      }
    }

    const groups = new Map();
    for (let cell = 0; cell < this.cells; cell++) {
      const { x, y } = this.center(cell);
      const cutting = (buckets.get(bucketAt(x, y)) ?? []).filter((line) => cuts(line, x, y));
      const edge = x === this.#x0 || y === this.#y0 || cell % this.#columns === this.#columns - 1 || cell >= this.cells - this.#columns;
      if (edge || cutting.some((line) => line.back < 0 || line.flags & ML_BLOCKING)) {
        this.#solid[cell] = 1;
        continue;
      }
      this.#sector[cell] = sectorAt(x, y);
      const sectors = [...new Set([this.#sector[cell], ...cutting.flatMap((line) => [line.front, line.back])])].sort((a, b) => a - b);
      const key = sectors.join();
      if (!groups.has(key)) groups.set(key, this.#groups.push(sectors) - 1);
      this.#group[cell] = groups.get(key);
      const portals = cutting.filter((line) => TELEPORTERS.has(line.special));
      if (portals.length === 0) continue;
      this.#portals.set(cell, portals);
      this.#portal[cell] = 1;
    }
  }

  // No room for a player's center within reach of x, y
  #block(x, y, reach) {
    for (let cy = Math.ceil((y - reach - this.#y0) / CELL + 1e-9); cy * CELL + this.#y0 < y + reach; cy++) {
      for (let cx = Math.ceil((x - reach - this.#x0) / CELL + 1e-9); cx * CELL + this.#x0 < x + reach; cx++) {
        if (cx >= 0 && cy >= 0 && cx < this.#columns && cy < this.#rows) this.#solid[cy * this.#columns + cx] = 1;
      }
    }
  }

  #countWalls() {
    for (let cell = this.#columns + 1; cell < this.cells - this.#columns - 1; cell++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) this.#walls[cell] += this.#solid[cell + dy * this.#columns + dx];
      }
    }
  }
}
