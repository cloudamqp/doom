// Turns where the bot wants to go into a ticcmd's moves. A ticcmd pushes
// the player forward and sideways and turns it by any angle at once, so the
// bot moves like a speedrunner: it runs forward and sideways together, which
// is 41% faster than forward alone, and it cancels the momentum that would
// carry it past a corner.

import { angleTo, distance, turnTo } from "./geometry.js";

const MAX_MOVE = 50; // a running player's push, forward and sideways each
const PUSH = 1 / 32; // momentum a point of push adds, in units per tic
export const TOP_SPEED = 23.5; // units per tic, with both pushes at their most
export const TURN = (2 * Math.PI) / 65536; // a point of turn in a ticcmd

// The pushes that take a player, facing an angle, to a velocity in units
// per tic, or as near as it gets in one tic
export function push(self, facing, velocity) {
  const [x, y] = [velocity.x - self.momx, velocity.y - self.momy];
  const forward = (x * Math.cos(facing) + y * Math.sin(facing)) / PUSH;
  const side = (x * Math.sin(facing) - y * Math.cos(facing)) / PUSH;
  const scale = Math.min(1, MAX_MOVE / Math.max(Math.abs(forward), Math.abs(side), 1e-9));
  return { forward: Math.round(forward * scale), side: Math.round(side * scale) };
}

// Where to face to run in a direction with both pushes at their most:
// 45 degrees to either side of it, whichever is the smaller turn
export function strafeRun(direction, facing) {
  const [left, right] = [direction + Math.PI / 4, direction - Math.PI / 4];
  return Math.abs(turnTo(facing, left)) < Math.abs(turnTo(facing, right)) ? left : right;
}

// The velocity that takes a player to a point and, with arrive, stops it there
export function toward(self, point, arrive = false) {
  const far = distance(self, point);
  const speed = arrive ? Math.min(TOP_SPEED, far * 0.15) : TOP_SPEED;
  const direction = angleTo(self, point);
  return { x: Math.cos(direction) * speed, y: Math.sin(direction) * speed };
}

export const STILL = { x: 0, y: 0 };
