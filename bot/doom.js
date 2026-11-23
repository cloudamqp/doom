// Doom without a screen, in Node: the same build as the browsers run,
// started with -nodraw. Needs web/doom.js, web/doom.wasm and
// web/freedoom1.wad, see bin/build.sh.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../web/", import.meta.url));
const WAD = "freedoom1.wad";

// Starts Doom with its arguments and resolves to its Emscripten module.
//   files   to write before it starts, by path
//   net     the network for doom/src/net_mqtt.c, as in web/js/play.js
//   bot     given the module, returns what answers ticcmd(maketic) with the
//           player's moves, see doom/src/doom/b_bot.c
//   print   is called with each line Doom prints
//   exited  is called with Doom's exit status
export async function startDoom({ args = [], files = {}, net, bot, print = () => {}, exited = () => {} }) {
  const [js, wasm, wad] = await Promise.all(["doom.js", "doom.wasm", WAD].map((file) => readFile(WEB + file).catch(() => undefined)));
  // A build from before bots only runs in browsers, and asks no bot for its moves
  if (!js || !wasm || !wad || !js.includes("Module.bot")) throw new Error("web/ has no Doom for bots, build it with bin/build.sh");
  return new Promise((resolve) => {
    const Module = {
      arguments: ["-iwad", WAD, "-nodraw", "-nosound", "-nogui", ...args],
      wasmBinary: wasm,
      preRun: [
        () => {
          Module.FS.writeFile(WAD, wad);
          for (const [path, data] of Object.entries(files)) {
            Module.FS.mkdirTree(dirname(path));
            Module.FS.writeFile(path, data);
          }
        },
      ],
      onRuntimeInitialized() {
        Module.bot = bot?.(Module);
        resolve(Module);
      },
      print,
      printErr: print,
      onExit: exited,
      net,
    };
    // doom.js is a script for a page, where Module is a global
    new Function("Module", "require", "__filename", "__dirname", js)(Module, createRequire(import.meta.url), WEB + "doom.js", WEB);
  });
}
