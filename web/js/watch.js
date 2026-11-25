// Spectators: games from above, the way Doom's automap draws them, with the
// scores. Every host publishes what goes on in its game to doomq/watch/<game>
// (see doom/src/doom/d_watch.c). ?watch shows all games in progress,
// ?watch=<game> one of them.

import { MqttClient } from "./mqtt.js";
import { MODES, RECONNECT_FOR, brokerUrl, isGameId, link, parseListing, parseWatch, setStatus, topics } from "./doomq.js";
import { downloads } from "./files.js";
import { readMap } from "./wad.js";

// Snapshots come about every 115 ms. Drawing this far behind leaves two to
// move the players between.
const DELAY = 150;
// Further than this between two snapshots is a teleport or a respawn
const JUMP = 160;
const QUIET_AFTER = 5_000; // the host stopped publishing
// A host that never publishes, on a build from before spectators
const SILENT_AFTER = 10_000;
const GONE_AFTER = 30_000; // how long an ended game stays among all games
// Every match draws its map. Anyone can publish listings, also for games that
// don't exist, so all games shows this many.
const MAX_MATCHES = 24;

// Doom's player colors: green, indigo, brown and red
const PLAYER_COLORS = ["#5ee05e", "#a0a0ff", "#d0975a", "#ff5a4d"];
const LINE_COLORS = { ceiling: "#4f4943", floor: "#8a7258", wall: "#d9d6ce" };
const MONSTER_COLOR = "#c0442c";

const $ = (selector, root = document) => root.querySelector(selector);
const only = new URLSearchParams(location.search).get("watch") || null;
const matches = new Map(); // game id -> Match
let wad = null; // Doom's IWAD, for the maps
const maps = new Map(); // name -> lines and bounds

function mapNamed(name) {
  if (!maps.has(name)) maps.set(name, readMap(wad, name));
  return maps.get(name);
}

const clock = (tics) => {
  const seconds = Math.floor(tics / 35);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const lerp = (a, b, t) => a + (b - a) * t;

// Angles go 256 to a turn, the short way round
function lerpAngle(a, b, t) {
  const turn = ((((b - a) % 256) + 384) % 256) - 128;
  return a + turn * t;
}

class Match {
  constructor(id) {
    this.id = id;
    this.card = $("#match").content.firstElementChild.cloneNode(true);
    this.canvas = $("canvas", this.card);
    this.snapshots = []; // the last two, with when they came
    this.monsters = [];
    this.listing = null;
    this.ended = null; // when its listing went away
    this.playing = null; // since when its listing says it's in progress
    this.background = null; // the map, drawn for the canvas' size
    $("code", this.card).textContent = topics.watch(id);
    $("#arena").append(this.card);
    this.describe();
  }

  remove() {
    this.card.remove();
  }

  setListing(game) {
    if (game?.state === "playing") this.playing ??= performance.now();
    if (game) this.listing = game;
    else this.ended ??= performance.now();
    this.describe();
  }

  update(watch) {
    this.snapshots = [this.snapshots.at(-1), { ...watch, at: performance.now() }].filter(Boolean);
    if (watch.monsters) this.monsters = watch.monsters;
    this.describe();
    this.score(watch);
    this.showBanner();
  }

  describe() {
    const latest = this.snapshots.at(-1);
    $("h2", this.card).textContent = this.listing?.title ?? "A game";
    const details = [this.listing && MODES[this.listing.mode], latest?.map ?? this.listing?.map, latest && clock(latest.time)];
    $(".details", this.card).textContent = details.filter(Boolean).join(" · ");
  }

  // What goes over the map, if anything. Kept up to date by a timer, not
  // with the drawing, which stops in hidden tabs and when nothing moves.
  showBanner(now = performance.now()) {
    const text = this.banner(now);
    $(".banner", this.card).textContent = text;
    $(".banner", this.card).hidden = !text;
  }

  banner(now) {
    const latest = this.snapshots.at(-1);
    if (this.ended) return "Game over";
    if (!latest) {
      if (this.listing?.spectators === false) return "This game's host doesn't share it with spectators";
      if (this.listing?.state === "waiting") return "Waiting for players";
      if (this.playing !== null && now - this.playing > SILENT_AFTER) return "This game's host doesn't share it with spectators";
      return "Waiting for the host";
    }
    if (now - latest.at > QUIET_AFTER) return "The host went quiet";
    if (!wad) return "Loading the map…";
    return { intermission: "Intermission", finale: "Finale", demo: "Demo" }[latest.state] ?? "";
  }

  score(watch) {
    const key = watch.deathmatch ? "frags" : "kills";
    $("thead th:nth-child(2)", this.card).textContent = watch.deathmatch ? "Frags" : "Kills";
    const players = watch.players.toSorted((a, b) => b[key] - a[key] || a.name.localeCompare(b.name));
    const leading = players.length > 1 && players[0][key] > players[1][key];
    const rows = players.map((player, i) => {
      const tr = document.createElement("tr");
      tr.classList.toggle("leader", leading && i === 0);
      const name = document.createElement("td");
      const swatch = document.createElement("i");
      swatch.style.background = PLAYER_COLORS[player.number];
      name.append(swatch, player.name);
      const cells = [player[key], player.dead ? "Dead" : `${player.health}%`].map((text) => {
        const td = document.createElement("td");
        td.textContent = text;
        return td;
      });
      tr.append(name, ...cells);
      return tr;
    });
    $("tbody", this.card).replaceChildren(...rows);
  }

  draw(now) {
    const { canvas } = this;
    const scale = devicePixelRatio;
    const width = Math.round(canvas.clientWidth * scale);
    const height = Math.round(canvas.clientHeight * scale);
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, width, height);
    const latest = this.snapshots.at(-1);
    if (!latest || !wad || latest.state !== "level") return;

    const map = mapNamed(latest.map);
    const { left, right, bottom, top } = map.bounds;
    const pad = 16 * scale;
    const zoom = Math.min((width - 2 * pad) / (right - left), (height - 2 * pad) / (top - bottom));
    const ox = (width - (right - left) * zoom) / 2;
    const oy = (height - (top - bottom) * zoom) / 2;
    const screen = (x, y) => [ox + (x - left) * zoom, oy + (top - y) * zoom];

    const key = `${latest.map} ${width}x${height}`;
    if (this.background?.key !== key) this.background = { key, image: this.drawMap(map, screen, width, height) };
    context.drawImage(this.background.image, 0, 0);

    context.fillStyle = MONSTER_COLOR;
    const size = Math.max(3 * scale, 20 * zoom);
    for (let i = 0; i < this.monsters.length; i += 2) {
      const [x, y] = screen(this.monsters[i], this.monsters[i + 1]);
      context.fillRect(x - size / 2, y - size / 2, size, size);
    }

    for (const player of this.positions(now)) this.drawPlayer(context, player, screen, zoom, scale);
  }

  drawMap(map, screen, width, height) {
    const image = Object.assign(document.createElement("canvas"), { width, height });
    const context = image.getContext("2d");
    context.lineWidth = Math.max(1, devicePixelRatio);
    context.lineCap = "round";
    for (const kind of ["ceiling", "floor", "wall"]) {
      context.strokeStyle = LINE_COLORS[kind];
      context.beginPath();
      for (const line of map.lines) {
        if (line.kind !== kind) continue;
        context.moveTo(...screen(line.x1, line.y1));
        context.lineTo(...screen(line.x2, line.y2));
      }
      context.stroke();
    }
    return image;
  }

  // The players between the last two snapshots, DELAY ago
  positions(now) {
    const [before, after] = this.snapshots.length === 2 ? this.snapshots : [null, this.snapshots[0]];
    const t = before ? Math.min(1, Math.max(0, (now - DELAY - before.at) / (after.at - before.at))) : 1;
    return after.players.map((player) => {
      const from = before?.players.find((other) => other.number === player.number);
      if (!from || Math.hypot(player.x - from.x, player.y - from.y) > JUMP) return player;
      return { ...player, x: lerp(from.x, player.x, t), y: lerp(from.y, player.y, t), angle: lerpAngle(from.angle, player.angle, t) };
    });
  }

  drawPlayer(context, player, screen, zoom, scale) {
    const [x, y] = screen(player.x, player.y);
    const radius = Math.max(8 * scale, 32 * zoom);
    context.save();
    context.translate(x, y);
    context.fillStyle = context.strokeStyle = PLAYER_COLORS[player.number];
    if (player.dead) {
      context.globalAlpha = 0.6;
      context.lineWidth = 2 * scale;
      context.beginPath();
      context.moveTo(-radius / 2, -radius / 2);
      context.lineTo(radius / 2, radius / 2);
      context.moveTo(radius / 2, -radius / 2);
      context.lineTo(-radius / 2, radius / 2);
      context.stroke();
    } else {
      // Doom's angles turn counterclockwise, the screen's y axis points down
      context.rotate((-player.angle * Math.PI) / 128);
      context.beginPath();
      context.moveTo(radius, 0);
      context.lineTo(-radius * 0.7, radius * 0.65);
      context.lineTo(-radius * 0.3, 0);
      context.lineTo(-radius * 0.7, -radius * 0.65);
      context.closePath();
      context.fill();
    }
    context.restore();
    context.font = `600 ${12 * scale}px "Familjen Grotesk", sans-serif`;
    context.fillStyle = PLAYER_COLORS[player.number];
    context.fillText(player.name, x + radius + 4 * scale, y - radius / 2);
  }
}

// None when the page is full
function matchFor(id) {
  if (!matches.has(id) && matches.size < MAX_MATCHES) matches.set(id, new Match(id));
  return matches.get(id);
}

function animate(now) {
  for (const match of matches.values()) match.draw(now);
  requestAnimationFrame(animate);
}

// Every second, and after every message
function refresh() {
  for (const [id, match] of matches) {
    match.showBanner();
    if (only || !match.ended || performance.now() - match.ended < GONE_AFTER) continue;
    match.remove();
    matches.delete(id);
  }
  $("#nothing").hidden = matches.size > 0;
}

for (const a of document.querySelectorAll(".back")) a.href = link("./");
$("#all-games").href = link("./", { watch: "" });
$("#all-games").hidden = !only;
$("#nothing").hidden = true;

downloads.then(({ wad: data }) => (wad = data), () => setStatus("Doom didn't download, reload the page to try again"));

if (only && !isGameId(only)) {
  $("#nothing").textContent = "No such game.";
  $("#nothing").hidden = false;
} else {
  try {
    const mqtt = await MqttClient.connect(brokerUrl, { retry: RECONNECT_FOR });
    setStatus("Connected", true);
    mqtt.ondrop = () => setStatus("Reconnecting…");
    mqtt.onreconnect = () => setStatus("Connected", true);
    mqtt.onclose = () => setStatus("Disconnected from broker, reload to retry");
    mqtt.onmessage = (topic, payload) => {
      const [, kind, id] = topic.split("/");
      if (!isGameId(id) || (only && id !== only)) return;
      if (kind === "lobby") {
        const game = parseListing(payload);
        // All games shows games in progress, and keeps those it already shows
        if (game?.state === "playing" || matches.has(id) || only) matchFor(id)?.setListing(game);
      } else {
        const watch = parseWatch(payload);
        // A game shows once its listing says it's in progress
        if (watch) matches.get(id)?.update(watch);
      }
      refresh();
    };
    if (only) matchFor(only);
    await Promise.all([
      mqtt.subscribe(only ? topics.listing(only) : topics.lobby),
      mqtt.subscribe(only ? topics.watch(only) : topics.watching),
    ]);
    setInterval(refresh, 1_000);
    refresh();
    requestAnimationFrame(animate);
  } catch (error) {
    setStatus(error.message);
  }
}
