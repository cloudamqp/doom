// Points, angles and lines on the map. Points are { x, y } in map units,
// angles radians, lines run from x1, y1 to x2, y2.

export const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
export const angleTo = (from, to) => Math.atan2(to.y - from.y, to.x - from.x);

// The shortest turn from one angle to another
export const turnTo = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

// Negative for points on the front of a line, its right, and positive on its back
export const side = (line, point) => (line.x2 - line.x1) * (point.y - line.y1) - (line.y2 - line.y1) * (point.x - line.x1);
export const inFront = (line, point) => side(line, point) < 0;

// The point of a line nearest to a point
export function closestOn(line, point) {
  const [dx, dy] = [line.x2 - line.x1, line.y2 - line.y1];
  const along = Math.max(0, Math.min(1, ((point.x - line.x1) * dx + (point.y - line.y1) * dy) / (dx * dx + dy * dy)));
  return { x: line.x1 + dx * along, y: line.y1 + dy * along };
}
