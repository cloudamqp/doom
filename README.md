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

Add `?broker=wss://user:pass@host/mqtt` to the lobby URL to use another broker.

## Production

Set up the broker with an administrator's AMQP URL:

    node bin/configure-broker.js amqps://admin:secret@broker.example.com

This creates the `doomq` vhost, capped at 500 connections, and a `doomq` user
that can only use MQTT there. It checks that MQTT over WebSocket works with
that user and writes the `wss://` URL to `web/js/config.js`. Every player gets
these credentials, and each run sets a new password. The script expects the
HTTP API at `https://host` for `amqps://` and `http://host:15672` for `amqp://`.

Then build the image and host it anywhere. `-e BROKER_URL=wss://...` sets
the URL when the container starts instead.

## Limitations

- Hidden tabs keep playing: browsers stop animation frames there and throttle
  timers, so a Web Worker's timer runs the game instead. Browsers that suspend
  background tabs entirely, like on phones, pause the game for everyone, and
  after 10 s that player is dropped, or the game ends if it was the host.
- Doom has no drop-in: join before the host starts. 4 players at most.
- Sound starts on the first click or key press.

## License

`doom/` is GPL-2.0, see `doom/COPYING.md`. The game data is [Freedoom][3]
(BSD), downloaded at build time.

[1]: https://www.chocolate-doom.org
[2]: https://github.com/cloudflare/doom-wasm
[3]: https://freedoom.github.io
[4]: https://hub.docker.com/r/emscripten/emsdk
