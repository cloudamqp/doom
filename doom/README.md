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
- Hidden tabs keep playing: a Web Worker's timer runs the frames there, as
  browsers stop animation frames and throttle timers in hidden tabs. Frames
  never sleep, so they can run from anywhere.
- Settings are saved on demand (`M_SaveDefaults` is exported), the page keeps
  them between visits.
- `G_AutoSave` is exported for the page's autosave timer, and the savegame size
  limit is off: some Freedoom maps outgrow vanilla's 180 KB.
- Fatal errors stop the game loop and go to `Module.onError` before the
  shutdown messages, and connections time out after 10 s instead of 4 s.
- Co-op respawns on Freedoom's E4M1-E4M3, whose player starts face 360°, no
  longer fail with "G_CheckSpot: unexpected angle 8192" (backported from
  [chocolate-doom#1823][5]).
- The server's deadlock check reads its receive window the right way round
  (backported from [chocolate-doom@8aa4ed6][6]).

`src/doom/d_watch.c` hands the page what spectators see, nine times a second:
the players, their scores and the monsters.

`tools/oplrender.c` renders a song from the IWAD to a WAV file with the game's
OPL music player and emulator, for the lobby's music. It runs in Node.

## Build

With Emscripten, e.g. inside the [emsdk image][4]:

    make -j"$(nproc)"    # build/doom.js, build/doom.wasm, build/oplrender.cjs

`../bin/build.sh` installs Emscripten if needed and copies the result to `web/`.

## Status lines

The game prints `doom: <code>, <text>` lines on stdout for the page to act on:

| Code | Meaning |
|------|---------|
| 7    | could not join the server, with Doom's reason |
| 9    | disconnected from the server |
| 10   | game started |
| 11   | entering fullscreen |
| 12   | a client timed out (server only) |
| 13   | saved, with the savegame's path |

## License

GNU GPL v2, see `COPYING.md`.

[1]: https://github.com/chocolate-doom/chocolate-doom
[2]: https://github.com/cloudflare/doom-wasm
[3]: https://github.com/chocolate-doom/chocolate-doom/pull/1723
[4]: https://hub.docker.com/r/emscripten/emsdk
[5]: https://github.com/chocolate-doom/chocolate-doom/pull/1823
[6]: https://github.com/chocolate-doom/chocolate-doom/commit/8aa4ed6c01c19b934e64d012ac304eaf1a777607
