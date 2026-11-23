// What Doom needs, downloaded once per page. The lobby starts the download as
// soon as it opens, and a game opens in the same page, so it starts right
// away or carries on with the same download.

const FILES = ["doom.js", "doom.wasm", "freedoom1.wad"];

const progress = { received: 0, total: 0 };
const listeners = new Set();

// Calls back with { received, total } now and as bytes arrive, total is 0
// while unknown. Returns a function that stops the calls.
export function watch(listener) {
  listeners.add(listener);
  listener(progress);
  return () => listeners.delete(listener);
}

// bin/build.sh writes the sizes, a compressed response doesn't tell them
async function sizes() {
  try {
    const response = await fetch("files.json");
    if (response.ok) return await response.json();
  } catch {}
  return {};
}

async function download(file) {
  const response = await fetch(file);
  if (!response.ok) throw new Error(`Could not download ${file}: ${response.status}`);
  const chunks = [];
  for (const reader = response.body.getReader(); ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    progress.received += value.length;
    for (const listener of listeners) listener(progress);
  }
  const data = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  chunks.reduce((offset, chunk) => (data.set(chunk, offset), offset + chunk.length), 0);
  return data;
}

async function downloadAll() {
  const known = await sizes();
  if (FILES.every((file) => known[file] > 0)) progress.total = FILES.reduce((sum, file) => sum + known[file], 0);
  const [js, wasm, wad] = await Promise.all(FILES.map(download));
  return {
    js: new TextDecoder().decode(js),
    // Compiled ahead too, Doom only has to instantiate it
    wasm: await WebAssembly.compile(wasm),
    wad,
  };
}

export const downloads = downloadAll();
downloads.catch(() => {}); // reported where a game waits for them
