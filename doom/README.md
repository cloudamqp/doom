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
- Players run up to 16 tics (~450 ms) ahead instead of 8, so a player
  across the world, with some jitter, doesn't slow the game down for
  everyone.
- Co-op respawns on Freedoom's E4M1-E4M3, whose player starts face 360°, no
  longer fail with "G_CheckSpot: unexpected angle 8192" (backported from
  [chocolate-doom#1823][5]).
- A program can play instead of the keyboard and mouse: `Module.bot` is asked
  for the player's moves every tic, and reads the world with the `B_` functions
  of `src/doom/b_bot.c`. `-nodraw` runs the game without a window, also in Node,
  and `-singletics` runs a tic per frame however long frames take. `../bot` plays
  like this.
- The server's deadlock check reads its receive window the right way round
  (backported from [chocolate-doom@8aa4ed6][6]).
- Spectators (drones) share one address for the game, `NET_MQTT_SPECTATORS`:
  the server sends each tic there once, and the broker copies it to every
  spectator. The server doesn't wait for drones, so they don't acknowledge
  tics, and `-nodes` counts players only. Drones can switch players with F12
  in deathmatch too, and with the fire key and button, and get the status
  bar, messages and sounds of the player they watch, whose name they're
  told (`Module.onWatching`).
- Deathmatch takes 8 players, co-op stays at 4 (`MAXPLAYERS`,
  `VANILLA_MAXPLAYERS`): the host's game mode sets the server's limit.
  Players 5 to 8 are blue, yellow, white and orange (`R_PlayerTranslation`,
  three translation bits in the mobj flags), and get the first player's
  status bar box recolored. With more players than a map has deathmatch
  spots, the rest spawn on the next free spot or co-op start. Five players
  or more get a smaller intermission table. Savegames hold eight players,
  demos keep vanilla's four.

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
