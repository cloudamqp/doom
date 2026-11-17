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

    docker compose up -d lavinmq                # broker, MQTT over WebSocket on :15672
    docker build --target dist --output web .   # doom.js, doom.wasm, freedoom1.wad into web/
    python3 -m http.server -d web 8080

    npm install
    npm test    # needs the broker and the web app on :8080

Add `?broker=wss://user:pass@host/mqtt` to the lobby URL to use another broker.

## Production

Host the image anywhere and point it at the broker:

    docker run -p 8080:80 -e BROKER_URL='wss://doomq%3Aplayer:secret@broker.example.com/mqtt' <image>

- LavinMQ serves MQTT over WebSocket on its HTTP(S) port, path `/mqtt`. Pages
  served over HTTPS need `wss://`.
- Every player gets these credentials. Give DooMQ its own vhost and user
  (`vhost%3Auser` as username picks the vhost), limit the user to `doomq/#`
  and cap connections on the vhost.

## Limitations

- Browsers pause hidden tabs, which pauses the game for everyone. After 10 s
  that player is dropped, or the game ends if it was the host.
- Doom has no drop-in: join before the host starts. 4 players at most.
- Sound starts on the first click or key press.

## License

`doom/` is GPL-2.0, see `doom/COPYING.md`. The game data is [Freedoom][3]
(BSD), downloaded at build time.

[1]: https://www.chocolate-doom.org
[2]: https://github.com/cloudflare/doom-wasm
[3]: https://freedoom.github.io
