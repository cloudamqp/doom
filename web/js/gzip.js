// Savegames shrink to a fifth with gzip

// The biggest save is 300 KB. Saves come from the network, and a few KB of
// gzip can expand to gigabytes.
export const MAX_SAVE_BYTES = 1024 * 1024;

const through = (data, transform) => new Blob([data]).stream().pipeThrough(transform);

export async function gzip(data) {
  return new Uint8Array(await new Response(through(data, new CompressionStream("gzip"))).arrayBuffer());
}

// Throws when the data isn't gzip, or expands beyond the limit. The stream
// only expands what is read from it, so that stops there.
export async function gunzip(data, limit = MAX_SAVE_BYTES) {
  const reader = through(data, new DecompressionStream("gzip")).getReader();
  const out = new Uint8Array(limit);
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out.slice(0, length);
    if (length + value.length > limit) {
      await reader.cancel();
      throw new Error(`expands to more than ${limit} bytes`);
    }
    out.set(value, length);
    length += value.length;
  }
}
