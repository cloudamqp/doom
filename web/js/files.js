// What Doom needs, downloaded once. The lobby starts the download as soon as
// it opens, and a game opens in the same page, so it starts right away or
// carries on with the same download. The browser keeps the files by their
// hash in files.json (written by bin/build.sh), so the lobby has them at once
// when people come back, also right after a game, until the next deploy.

const FILES = ["doom.js", "doom.wasm", "freedoom1.wad"];
const CACHE = "doomq";

const progress = { received: 0, total: 0, downloading: false };
const listeners = new Set();
const notify = () => listeners.forEach((listener) => listener(progress));

// Calls back with { received, total, downloading } now and as bytes arrive.
// total is 0 while unknown, downloading is false while all comes from the
// browser's cache. Returns a function that stops the calls.
export function watch(listener) {
  listeners.add(listener);
  listener(progress);
  return () => listeners.delete(listener);
}

async function manifest() {
  try {
    const response = await fetch("files.json");
    if (response.ok) return await response.json();
  } catch {}
  return {};
}

// Cache Storage needs https or localhost, and private windows may refuse it
async function openCache() {
  try {
    return await caches.open(CACHE);
  } catch {
    return null;
  }
}

async function read(response) {
  const chunks = [];
  for (const reader = response.body.getReader(); ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    progress.received += value.length;
    notify();
  }
  const data = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  chunks.reduce((offset, chunk) => (data.set(chunk, offset), offset + chunk.length), 0);
  return data;
}

// The hash in the address keeps each deploy's files apart
const address = (file, hash) => new URL(hash ? `${file}?${hash}` : file, location.href).href;

async function load(cache, file, hash) {
  const url = address(file, hash);
  const cached = hash && (await cache?.match(url));
  if (cached) {
    const data = new Uint8Array(await cached.arrayBuffer());
    progress.received += data.length;
    notify();
    return data;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${file}: ${response.status}`);
  progress.downloading = true;
  const data = await read(response);
  if (hash) cache?.put(url, new Response(data)).catch(() => {}); // out of space, say
  return data;
}

// Files from earlier deploys
async function prune(cache, keep) {
  for (const request of await cache.keys()) if (!keep.includes(request.url)) await cache.delete(request);
}

async function downloadAll() {
  const known = await manifest();
  const hashes = FILES.map((file) => known[file]?.hash);
  if (FILES.every((file) => known[file]?.size > 0)) progress.total = FILES.reduce((sum, file) => sum + known[file].size, 0);
  const cache = await openCache();
  const [js, wasm, wad] = await Promise.all(FILES.map((file, i) => load(cache, file, hashes[i])));
  if (cache && hashes.every(Boolean)) prune(cache, FILES.map((file, i) => address(file, hashes[i]))).catch(() => {});
  return {
    js: new TextDecoder().decode(js),
    // Compiled ahead too, Doom only has to instantiate it
    wasm: await WebAssembly.compile(wasm),
    wad,
  };
}

export const downloads = downloadAll();
downloads.catch(() => {}); // reported where a game waits for them
