# DooMQ

Multiplayer Doom in the browser with LavinMQ as the network: every packet
between players is an MQTT message over WebSocket.

## Run it

    docker compose up --build

Open http://localhost:8080 in two browser windows, create a game in one, join
it from the other, then press Space in the host's waiting room.

## How it works

[Chocolate Doom][1] runs as WebAssembly (based on Cloudflare's [doom-wasm][2]).
Its UDP network layer is replaced by `doom/src/net_mqtt.c`, which hands packets
to `web/js/play.js`. The player who creates a game runs the Doom server in
their tab.

| Topic                            | Retained | Published by                                         |
|----------------------------------|----------|------------------------------------------------------|
| `doomq/lobby/<game>`             | yes      | the host every 5 s: title, mode, map, players, state |
| `doomq/games/<game>/<to>/<from>` | no       | every peer, one Doom packet per message              |
| `doomq/saves/<game>`             | yes      | the host on every save: title, mode, map, players    |
| `doomq/savedata/<game>`          | yes      | the host on every save: the gzipped savegame         |

- The lobby subscribes to `doomq/lobby/+`, retained messages list running games
  to new visitors at once.
- The host connects with a last will that clears its lobby topic, so a crashed
  tab takes its game with it.
- Peers subscribe to `doomq/games/<game>/<self>/+`, the server is peer 1. The
  sender is the last topic level, so payloads are plain Doom packets.
- Doom runs in lockstep at 35 tics per second, about 35 messages per second
  per player and direction. QoS 0 is enough: TCP keeps them in order and Doom
  resends what goes missing.

`web/js/mqtt.js` is a small MQTT 3.1.1 client with just what this needs.

### Regions

Every player's packets go through the broker, so a game plays best on a
broker near its players. `web/js/config.js` can list a broker per region,
each with games and saves of its own. A region goes by the airport code of a
city nearby in addresses, and by its name in the lobby. The lobby offers the
regions when there is more than one: players start in the first, or in the
one they picked last, and a game's address carries its region
(`?region=ams`), so everyone who follows it gets to the same broker. Bots go
by the address too.

### When the broker restarts

A game carries on, if the broker is back within 8 seconds: Doom drops a peer
it hasn't heard from for 10.

- Every player's client connects again and subscribes as before
  (`web/js/mqtt.js`). The game stands still meanwhile, and Doom sends again
  what went missing.
- A broker that shuts down publishes everyone's last will on its way out. The
  host's clears its listing, so the host announces the game again once it is
  back, and guests give a listing that went away 10 seconds to return.
- A guest's will is Doom's disconnect packet to the host. The host holds such
  a packet for a moment before Doom gets it, and forgets it if its own
  connection drops: that was the broker leaving, not the guest
  (`web/js/goodbyes.js`).

Retained messages, the listings and the saves, are kept by LavinMQ across the
restart.

The lobby and the games share `web/index.html`. A game opens in place, so the
download of Doom (31 MB, mostly the Freedoom WAD) that starts with the lobby
carries on, or is already done (`web/js/files.js`).

`web/how.html`, linked from the top of every page, follows one game from the
lobby to the spectators with the MQTT messages each step sends.
`web/why-mqtt.html` makes the longer case for MQTT: how Doom maps onto it, and
what DooMQ uses in MQTT and LavinMQ. Both show live counts from the lobby's
retained messages.

Spectators watch games from above, one or all at once, with the scores
(`?watch=<game>`, or `?watch=` for all). The host publishes where the players
and monsters are to `doomq/watch/<game>` nine times a second, read from Doom
by `doom/src/doom/d_watch.c`, and the page draws the maps from the WAD the
way Doom's automap does (`web/js/watch.js`, `web/js/wad.js`).

Spectators can also watch in Doom itself: Spectate, in the lobby before the
game starts, joins as one of Doom's drones (`-drone`), and F12 switches
between players, in deathmatch too. They all get the game on one topic,
`doomq/games/<game>/0/1`: the host's Doom server publishes each tic there once
and the broker copies it to every spectator. The server doesn't wait for
spectators, so a slow one only falls behind itself. A host can turn
spectators off, from above and in Doom, when creating the game.

The lobby plays Freedoom's E1M1 from the first click or key press until the
game starts, at Doom's music volume. `bin/build.sh` renders it from the WAD
the way the game plays it, with `doom/tools/oplrender.c`, and encodes it with
LAME.

### Saved games

- The host autosaves every 2 minutes, and players can save from Doom's menu.
  The request travels with that player's input, so every player saves the
  same tic. The host shares its copy, each game keeps only its latest save.
- The lobby lists saved games whose game has ended. Resume hosts a new game
  that loads the save on every player's side.
- A savegame records which of the eight player slots were in use. A resumed
  game starts by itself once that many players have joined. The host can
  start it earlier with fewer, and the missing players' marines leave the
  game. More can't join: Doom would have no marine for them.
- Saves expire after 24 hours, the lobby deletes expired ones it sees. A
  resumed game's first save replaces the save it was resumed from.
- A save is 17 to 300 KB depending on the map, 120 KB on average across
  Freedoom's 36 maps, and a fifth of that gzipped: up to 60 KB per game.
- Anyone with the credentials can publish a save, so players' browsers stop
  unpacking one at 1 MB (`web/js/gzip.js`): a few KB of gzip can expand to
  gigabytes.
- Doom finds its way around a level with what a save says: which sector a
  door is in, which state a monster is in. It checks those as it reads them
  (`doom/src/doom/p_saveg.c`), and refuses a save that points outside the
  game.
- A save has to be for the map, skill and number of players that the lobby
  showed for it, or it isn't loaded.

## Bots

    bin/bot.js http://localhost:8080/           # joins the first game that waits for players
    bin/bot.js <a game's address>               # or this one, as copied from the browser
    bin/bot.js --host http://localhost:8080/    # starts a game of its own
    bin/bot.js --solo E1M1                      # practice alone, as fast as the machine goes

A bot is one more player on the broker: it finds a game in the lobby's
retained listings, subscribes to its own packet topic and publishes its moves
to the host's. It works in co-op games, where it heads for the exit, and in
deathmatches, where it heads for the other marines. Given a page's address it
reads the broker from the page's `js/config.js`, as browsers do. `--broker` or
`$BROKER_URL` name a broker without a page, `--name` names the bot and
`--verbose` shows what it is up to. Start one per bot, each plays one game and
exits when it is over.

With `--host` a bot starts a game instead: it runs Doom's server and lists the
game in the lobby, for people and other bots to join. Without a screen there is
no waiting room to press Space in, so the game starts once `--players` are in,
the bot included. `--mode`, `--map`, `--skill`, `--title`, `--no-monsters` and
`--no-spectators` are the lobby's form. Spectators can watch a bot's game as
any other. It is not saved, so it can't be resumed.

Bots need Node 22 and the build in `web/`, see Development.

It does not look at the screen or press keys. Doom's packets only carry what
each player does, a ticcmd per tic: run, strafe, turn, fire, use. Every player
works out the rest by running the same game, and so does the bot: the same
build of Doom, in Node, without a window (`bot/doom.js`). Each tic Doom asks it
for a ticcmd, and it reads the world from the game: the sectors, the lines and
the things, with whether it has them in sight (`doom/src/doom/b_bot.c`,
`bot/world.js`).

- `bot/nav.js` finds ways on a grid of 16 unit cells, by Doom's own rules for
  where a player fits. Floors and ceilings move, so it takes their heights anew
  every tic.
- `bot/goals.js` picks what to do: get the keys and what it is short of, leave
  by the exit once there is a way to it, and until then press the switches and
  cross the lines it has tried the least, and go where it has not been. It
  knows the map, as players who have run it often do, but not what the
  switches do.
- `bot/combat.js` picks the enemy, the weapon, where to aim and where to stand.
  Zombies first, as their shots can't be dodged. Missiles are dodged, and sent
  to where a moving target will be.
- `bot/steer.js` turns that into ticcmds. A ticcmd turns by any angle at once,
  so the bot never misses its aim, and it runs forward and sideways together as
  speedrunners do, 41% faster than forward alone.
- `bot/brain.js` puts it together, opens doors, rides lifts and gets unstuck.

It plays by a player's limits: the game clamps its pushes to a running
player's, and it only knows what the game tells every player's machine.

Alone, it leaves Freedoom's E1M1 after 37 seconds, and gets through five of the
36 maps: E1M1, E1M2, E1M4, E1M8 and E3M1. On the others it runs out of ideas
or of health, and is glad of human company.

## Development

    docker compose up -d lavinmq         # broker, MQTT over WebSocket on :15672
    bin/build.sh                         # doom.js, doom.wasm, freedoom1.wad into web/
    python3 -m http.server -d web 8080

`bin/build.sh` installs what it needs: build tools with apt-get, and
Emscripten in `~/emsdk` unless `emcc` is already on `PATH`, as in the
[emsdk image][4].

    npm install
    npm test    # needs the broker and the web app on :8080, and a display
                # for the hidden tab test, e.g. xvfb-run npm test

`test/bot.test.js` only needs the build, and what a bot does on a map shows
with `bin/bot.js --solo E1M3 --verbose`.

Add `?broker=wss://user:pass@host/mqtt` to the lobby URL to use another broker.
`brokerFromAddress` in `web/js/config.js` allows that. The config written for
a real broker leaves it out, see below.

## Production

Set up the broker with an administrator's AMQP URL:

    node bin/configure-broker.js amqps://admin:secret@broker.example.com

Or a broker per region, by its code and the name the lobby shows, the first
where players start:

    node bin/configure-broker.js ams:Amsterdam=amqps://admin:secret@ams.example.com syd:Sydney=amqps://admin:secret@syd.example.com

It writes the `wss://` URLs for the web app to `web/js/config.js`, after
checking that MQTT over WebSocket works with each. Then build the image and
host it anywhere, or set the URL when the container starts with
`-e BROKER_URL=wss://...`. Serving `web/` from another web server, send
`Cache-Control: no-cache`: without it, browsers may mix cached files from
an old deploy with new ones. The script expects the HTTP API at `https://host`
for `amqps://` and `http://host:15672` for `amqp://`.

Either way the config no longer lets `?broker=` in an address pick the
broker: with it, a link to your site could take players to anyone's broker.

Every player gets the credentials, so the setup limits what they allow:

- A `doomq` vhost of its own, with at most 500 connections.
- A `doomq` user that can only use MQTT, on DooMQ's topic patterns only.
  Other topics are dropped.
- A policy that drops the oldest messages once 1 MB is queued for a client
  that stopped reading.

Every run starts over: it deletes and recreates the vhost on every broker,
which ends running games and clears all saves, along with anything someone
stored there. Run it daily or weekly to clear out abuse, with
`DOOMQ_PASSWORD` set so the web app's URLs stay the same:

    DOOMQ_PASSWORD=... node bin/configure-broker.js amqps://admin:secret@broker.example.com

LavinMQ has no limit on retained messages, so between runs, someone with the
credentials can fill the disk with retained messages on topics like
`doomq/saves/<anything>`. Two broker settings bound that:

- `[mqtt] max_packet_size = 262144` caps every message at 256 KB, four times
  the biggest gzipped save.
- `[main] free_disk_min` sets how much free disk LavinMQ keeps, it refuses
  publishes below that. Without it, the floor is three segments (24 MB).

They can also publish listings and saves for games that don't exist. The
pages keep track of 100 games and 100 saves, and show 24 games to spectators
at once, so a flood of them doesn't grow a player's tab without end. It still
hides the real games until the next run.

## Limitations

- Hidden tabs keep playing: browsers stop animation frames there and throttle
  timers, so a Web Worker's timer runs the game instead. Browsers that suspend
  background tabs entirely, like on phones, pause the game for everyone, and
  after 10 s that player is dropped, or the game ends if it was the host.
- A broker that is away for more than 8 seconds ends its games.
- Doom has no drop-in: join before the host starts. 8 players at most in
  deathmatch, 4 in co-op, bots included: co-op maps have four player starts.
- Sound starts on the first click or key press.

## License

`doom/` is GPL-2.0, see `doom/COPYING.md`. The game data is [Freedoom][3]
(BSD), downloaded at build time.

[1]: https://www.chocolate-doom.org
[2]: https://github.com/cloudflare/doom-wasm
[3]: https://freedoom.github.io
[4]: https://hub.docker.com/r/emscripten/emsdk
