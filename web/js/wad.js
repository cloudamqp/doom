// Maps from a WAD, as lines the way Doom's automap draws them: walls, then
// steps in the floor, then steps in the ceiling. Lines without a step, and
// lines the map hides, aren't drawn.

const NO_SIDE = 0xffff;
const SECRET = 32;
const DONT_DRAW = 128;
const TELEPORTER = 39;

function directory(wad) {
  const view = new DataView(wad.buffer, wad.byteOffset, wad.byteLength);
  const count = view.getInt32(4, true);
  const offset = view.getInt32(8, true);
  return Array.from({ length: count }, (_, i) => {
    const entry = offset + 16 * i;
    const name = String.fromCharCode(...wad.subarray(entry + 8, entry + 16)).replace(/\0.*$/, "");
    return { name, offset: view.getInt32(entry, true), size: view.getInt32(entry + 4, true) };
  });
}

// Returns { lines: [{ x1, y1, x2, y2, kind }], bounds: { left, right, bottom, top } }
// for a map like "E1M1", kind is "wall", "floor" or "ceiling". Null when the
// WAD has no such map.
export function readMap(wad, name) {
  const lumps = directory(wad);
  const marker = lumps.findIndex((lump) => lump.name === name);
  if (marker < 0) return null;
  const records = (lumpName, size) => {
    const lump = lumps.slice(marker + 1, marker + 11).find((lump) => lump.name === lumpName);
    const view = new DataView(wad.buffer, wad.byteOffset + lump.offset, lump.size);
    return Array.from({ length: Math.floor(lump.size / size) }, (_, i) => (at) => view.getInt16(i * size + at, true));
  };

  const vertices = records("VERTEXES", 4).map((field) => [field(0), field(2)]);
  const sectors = records("SECTORS", 26).map((field) => ({ floor: field(0), ceiling: field(2) }));
  const sides = records("SIDEDEFS", 30).map((field) => sectors[field(28)]);

  const lines = [];
  for (const field of records("LINEDEFS", 14)) {
    const flags = field(4) & 0xffff;
    if (flags & DONT_DRAW) continue;
    const front = sides[field(10) & 0xffff];
    const backSide = field(12) & 0xffff;
    const back = backSide === NO_SIDE ? null : sides[backSide];
    let kind;
    if (!back || flags & SECRET || field(6) === TELEPORTER) kind = "wall";
    else if (back.floor !== front.floor) kind = "floor";
    else if (back.ceiling !== front.ceiling) kind = "ceiling";
    else continue;
    const [x1, y1] = vertices[field(0) & 0xffff];
    const [x2, y2] = vertices[field(2) & 0xffff];
    lines.push({ x1, y1, x2, y2, kind });
  }

  const xs = vertices.map(([x]) => x);
  const ys = vertices.map(([, y]) => y);
  const bounds = { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) };
  return { lines, bounds };
}
