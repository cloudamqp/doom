# Doom for DooMQ

[Chocolate Doom][1] compiled to WebAssembly, based on Cloudflare's [doom-wasm][2]
(imported unmodified in the first commit of this branch). Changes since:

- `src/net_mqtt.c` replaces the WebSocket relay module. It passes packets to
  `Module.net` in JavaScript (`web/js/play.js`), which carries them over MQTT.
  `-server` hosts a game as peer 1, `-connect 1` joins it.
- A single `Makefile` for Emscripten replaces autotools and CMake.
- `boolean` has the same size in every file (backported from [chocolate-doom#1723][3]).
- The OPL music emulator starts without waiting for audio, which browsers hold
  back until the user interacts with the page.
- Fatal errors stop the game loop, and connections time out after 10 s instead of 4 s.

## Build

Inside the [emsdk image][4], or see `../Dockerfile`:

    make -j"$(nproc)"    # build/doom.js, build/doom.wasm

## Status lines

The game prints `doom: <code>, <text>` lines on stdout for the page to act on:

| Code | Meaning |
|------|---------|
| 7    | could not join the server, with Doom's reason |
| 9    | disconnected from the server |
| 10   | game started |
| 11   | entering fullscreen |
| 12   | a client timed out (server only) |

## License

GNU GPL v2, see `COPYING.md`.

[1]: https://github.com/chocolate-doom/chocolate-doom
[2]: https://github.com/cloudflare/doom-wasm
[3]: https://github.com/chocolate-doom/chocolate-doom/pull/1723
[4]: https://hub.docker.com/r/emscripten/emsdk
