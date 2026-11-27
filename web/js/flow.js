// The message flow page: subscribes to every DooMQ topic, as one more client,
// and shows what goes through the broker. It only reads.
//
// It sees each message once, as it is published: a Doom packet then goes to
// one peer, a listing to everyone in the lobby, a spectator snapshot to
// everyone watching from above, a tic for in-game spectators to all of
// them at once, and a running game to a player who joins it.

import { MqttClient } from "./mqtt.js";
import {
  MAX_GAMES,
  RECONNECT_FOR,
  SERVER_ID,
  SPECTATORS,
  brokerUrl,
  isGameId,
  isSpectator,
  link,
  parseListing,
  region,
  regionName,
  regions,
  setStatus,
} from "./doomq.js";

// Colors checked for color blindness as a set on the window's surface; saves
// and joins are rare and also drawn as rings
const KINDS = {
  packets: { label: "Doom packets", filter: "doomq/games/+/+/+", color: "#e76624" },
  listings: { label: "Lobby listings", filter: "doomq/lobby/+", color: "#00a888" },
  snapshots: { label: "Spectator snapshots", filter: "doomq/watch/+", color: "#338ced" },
  saves: { label: "Saves", filter: "doomq/saves/+", color: "#d9d6ce" },
  joins: { label: "Games for newcomers", filter: "doomq/join/+/+", color: "#c75fc0" },
};
const KIND_OF_LEVEL = { games: "packets", lobby: "listings", watch: "snapshots", saves: "saves", join: "joins" };
const RINGS = new Set(["saves", "joins"]);

// Doom's packet types, see doom/src/net_defs.h; reliable ones have the top bit
const PACKET_TYPES = [
  "connect",
  "ack",
  "rejected",
  "keepalive",
  "waiting room",
  "game start",
  "game data",
  "game data ack",
  "disconnect",
  "disconnect ack",
  "reliable ack",
  "resend request",
  "console message",
  "query",
  "query response",
  "launch",
];

const SECONDS = 60;
const GAMES_ON_MAP = 10;
const DOT_EVERY = 90; // ms, at most, per pair of peers
const DOT_TIME = 900; // ms from the publisher to the subscriber
const MAX_DOTS = 1500;
const QUIET_FOR = 10_000; // ms before a game without a listing goes

const $ = (selector) => document.querySelector(selector);
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Counts per kind: this second, and each of the last minute's
const now = Object.fromEntries(Object.keys(KINDS).map((kind) => [kind, { messages: 0, bytes: 0 }]));
const history = Object.fromEntries(Object.keys(KINDS).map((kind) => [kind, []]));

// id -> { listing, peers: Map(peer -> last seen), spectators, second, rate, seen, order }
const games = new Map();
let order = 0;

function game(id) {
  if (!games.has(id) && games.size < MAX_GAMES) {
    games.set(id, { listing: null, peers: new Map(), spectators: 0, second: { messages: 0, bytes: 0 }, rate: { messages: 0, bytes: 0 }, seen: 0, order: order++ });
  }
  return games.get(id);
}

// A PUBLISH packet: header, topic length, topic and payload
const size = (topic, payload) => 4 + topic.length + payload.length;

// In-game spectators show as one node, where they all listen
const peerNode = (peer) => (isSpectator(peer) ? SPECTATORS : peer);

function receive(topic, payload, { retain }) {
  const [, level, id, to, from] = topic.split("/");
  const kind = KIND_OF_LEVEL[level];
  if (!kind || !isGameId(id)) return;
  const g = game(id);
  if (!g) return;

  if (kind === "listings") g.listing = parseListing(payload);
  // What the broker kept is state, not flow
  if (retain) return;

  const bytes = size(topic, payload);
  now[kind].messages++;
  now[kind].bytes += bytes;
  g.second.messages++;
  g.second.bytes += bytes;
  g.seen = performance.now();

  let path;
  if (kind === "packets") {
    const [target, source] = [Number(to), Number(from)];
    for (const peer of [target, source]) {
      if (peer === SPECTATORS || isSpectator(peer)) g.spectators = g.seen;
      else if (peer >= SERVER_ID) g.peers.set(peer, g.seen);
    }
    path = [`${id}/${peerNode(source)}`, `${id}/${peerNode(target)}`];
  } else if (kind === "joins") {
    // From the host to the newcomer
    path = [`${id}/${SERVER_ID}`, `${id}/${peerNode(Number(to))}`];
  } else {
    path = [`${id}/${SERVER_ID}`, kind];
  }
  dot(kind, path, `${id}/${to}/${from}`);
  latest = { topic, payload, kind };
}

// Dots, on their way from a publisher through the broker to a subscriber

const dots = [];
const lastDot = new Map();

function dot(kind, path, line) {
  if (still || document.hidden || dots.length >= MAX_DOTS) return;
  const t = performance.now();
  if (t - (lastDot.get(line) ?? 0) < DOT_EVERY) return;
  lastDot.set(line, t);
  dots.push({ kind, from: path[0], to: path[1], t });
}

// The map: the broker in the middle, the lobby, spectators and saves to the
// left, games around the rest, each a host with its players around it

const canvas = $("#map");
const context = canvas.getContext("2d");
const logo = new Image();
logo.src = "img/lavinmq.svg";
let width = 0;
let height = 0;

new ResizeObserver(() => {
  width = canvas.clientWidth;
  height = Math.round(Math.min(560, Math.max(380, width * 0.5)));
  canvas.style.height = `${height}px`;
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
}).observe(canvas);

const AUDIENCE = {
  listings: { label: "Lobby", angle: Math.PI + 0.6 },
  snapshots: { label: "Watching from above", angle: Math.PI },
  saves: { label: "Saves, kept", angle: Math.PI - 0.6 },
};

function shown() {
  return [...games.entries()]
    .filter(([, g]) => g.listing || g.seen)
    .sort(([, a], [, b]) => b.rate.messages - a.rate.messages || a.order - b.order)
    .slice(0, GAMES_ON_MAP)
    .sort(([, a], [, b]) => a.order - b.order);
}

function layout() {
  const broker = { x: width / 2, y: height / 2 };
  const rx = width / 2 - Math.min(120, width * 0.16);
  const ry = height / 2 - 70;
  const at = (angle, scale = 1) => ({ x: broker.x + rx * scale * Math.cos(angle), y: broker.y + ry * scale * Math.sin(angle) });
  const nodes = new Map(Object.entries(AUDIENCE).map(([kind, { label, angle }]) => [kind, { ...at(angle), label, kind: "audience" }]));
  const clusters = [];
  const list = shown();
  list.forEach(([id, g], i) => {
    const angle = -1.95 + (3.9 * (i + 0.5)) / list.length;
    const host = at(angle);
    clusters.push({ id, g, host, angle });
    nodes.set(`${id}/${SERVER_ID}`, { ...host, kind: "host" });
    const others = [...g.peers.keys()].filter((peer) => peer !== SERVER_ID).sort((a, b) => a - b);
    const around = [...others.map((peer) => `${id}/${peer}`), ...(g.spectators ? [`${id}/${SPECTATORS}`] : [])];
    around.forEach((key, k) => {
      const spread = around.length > 1 ? -1.25 + (2.5 * k) / (around.length - 1) : 0;
      const a = angle + spread;
      nodes.set(key, { x: host.x + 34 * Math.cos(a), y: host.y + 34 * Math.sin(a), kind: key.endsWith(`/${SPECTATORS}`) ? "spectators" : "guest" });
    });
  });
  return { broker, nodes, clusters };
}

function draw(t) {
  requestAnimationFrame(draw);
  if (!width) return;
  const { broker, nodes, clusters } = layout();
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);

  // Spokes; without motion, the games' traffic as their brightness
  const total = Object.keys(KINDS).reduce((sum, kind) => sum + rate(kind), 0);
  context.lineWidth = 1;
  for (const node of nodes.values()) {
    context.strokeStyle = "#2b2b2b";
    context.beginPath();
    context.moveTo(broker.x, broker.y);
    context.lineTo(node.x, node.y);
    context.stroke();
  }
  if (still) {
    for (const { host, g } of clusters) {
      context.strokeStyle = KINDS.packets.color;
      context.globalAlpha = Math.min(1, g.rate.messages / 200);
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(broker.x, broker.y);
      context.lineTo(host.x, host.y);
      context.stroke();
      context.globalAlpha = 1;
    }
  }

  // Messages
  for (let i = dots.length - 1; i >= 0; i--) {
    const d = dots[i];
    const progress = (t - d.t) / DOT_TIME;
    const from = nodes.get(d.from);
    const to = nodes.get(d.to);
    if (progress >= 1 || !from || !to) {
      dots.splice(i, 1);
      continue;
    }
    const [a, b, p] = progress < 0.5 ? [from, broker, progress * 2] : [broker, to, progress * 2 - 1];
    const x = a.x + (b.x - a.x) * p;
    const y = a.y + (b.y - a.y) * p;
    context.beginPath();
    if (RINGS.has(d.kind)) {
      context.strokeStyle = KINDS[d.kind].color;
      context.lineWidth = 2;
      context.arc(x, y, 5, 0, 2 * Math.PI);
      context.stroke();
    } else {
      context.fillStyle = KINDS[d.kind].color;
      context.arc(x, y, 2.5, 0, 2 * Math.PI);
      context.fill();
    }
  }

  // The broker, glowing with the flow
  const glow = 34 + 10 * Math.log10(1 + total);
  const halo = context.createRadialGradient(broker.x, broker.y, 30, broker.x, broker.y, glow + 18);
  halo.addColorStop(0, "rgba(68, 252, 112, 0.28)");
  halo.addColorStop(1, "rgba(68, 252, 112, 0)");
  context.fillStyle = halo;
  context.beginPath();
  context.arc(broker.x, broker.y, glow + 18, 0, 2 * Math.PI);
  context.fill();
  context.fillStyle = "#1b1b1b";
  context.strokeStyle = "#44fc70";
  context.lineWidth = 1.5;
  context.beginPath();
  context.arc(broker.x, broker.y, 32, 0, 2 * Math.PI);
  context.fill();
  context.stroke();
  if (logo.complete) context.drawImage(logo, broker.x - 15, broker.y - 15, 30, 30);

  // Peers
  context.textAlign = "center";
  for (const node of nodes.values()) {
    context.beginPath();
    if (node.kind === "host") {
      context.fillStyle = "#f7f5f2";
      context.arc(node.x, node.y, 7, 0, 2 * Math.PI);
      context.fill();
    } else if (node.kind === "guest") {
      context.fillStyle = "#d9d6ce";
      context.arc(node.x, node.y, 4.5, 0, 2 * Math.PI);
      context.fill();
    } else {
      context.strokeStyle = node.kind === "spectators" ? "#95928c" : "#d9d6ce";
      context.lineWidth = 1.5;
      context.arc(node.x, node.y, node.kind === "spectators" ? 5 : 8, 0, 2 * Math.PI);
      context.stroke();
    }
    if (node.label) label(node.label, node.x, node.y + 24, "#d9d6ce", 13);
  }
  for (const { g, host, angle, id } of clusters) {
    const below = Math.sin(angle) >= -0.2;
    const y = host.y + (below ? 52 : -60);
    label(clip(g.listing?.title ?? id, 26), host.x, y, "#f7f5f2", 13);
    const players = g.listing ? `${g.listing.host}, ${g.listing.players}/${g.listing.maxPlayers}` : `${g.peers.size} peers`;
    label(players, host.x, y + 16, "#95928c", 12);
  }
}

function label(text, x, y, color, px) {
  context.font = `${px}px "Familjen Grotesk", system-ui, sans-serif`;
  context.fillStyle = color;
  context.fillText(text, Math.min(width - 8 - context.measureText(text).width / 2, Math.max(8 + context.measureText(text).width / 2, x)), y);
}

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

// Rates and their history

// Messages a second, over the last three
function rate(kind, field = "messages") {
  const last = history[kind].slice(-3);
  return last.length ? last.reduce((sum, second) => sum + second[field], 0) / last.length : 0;
}

const count = new Intl.NumberFormat("en");

// A second's worth over the last few, or for what comes less than once a
// second, a minute's worth over all of them
function busy(kind) {
  const seconds = history[kind];
  const average = (field) => seconds.reduce((sum, second) => sum + second[field], 0) / Math.max(1, seconds.length);
  return average("messages") >= 1
    ? { count: rate(kind), per: "a second", bytes: rate(kind, "bytes") }
    : { count: average("messages") * 60, per: "a minute", bytes: average("bytes") };
}

function bytesPerSecond(bytes) {
  if (bytes < 1000) return `${Math.round(bytes)} B/s`;
  if (bytes < 1e6) return `${(bytes / 1000).toFixed(bytes < 1e4 ? 1 : 0)} KB/s`;
  return `${(bytes / 1e6).toFixed(1)} MB/s`;
}

// A tile per kind, with its last minute as a line, on a scale of its own

const tiles = new Map();
for (const [kind, { label: name, filter, color }] of Object.entries(KINDS)) {
  const tile = document.createElement("article");
  tile.className = "kind";
  tile.dataset.kind = kind;
  tile.style.setProperty("--kind", color);
  tile.innerHTML = `
    <h3></h3>
    <p class="value"><strong></strong> <span></span></p>
    <p class="bytes"></p>
    <div class="spark">
      <svg viewBox="0 0 ${SECONDS - 1} 40" preserveAspectRatio="none" aria-hidden="true">
        <path class="area"></path><path class="line"></path><line class="cross" y1="0" y2="40"></line>
      </svg>
      <span class="tip" hidden></span>
    </div>
    <code></code>`;
  tile.querySelector("h3").textContent = name;
  tile.querySelector("code").textContent = filter;
  $("#kinds").append(tile);
  tiles.set(kind, tile);

  const spark = tile.querySelector(".spark");
  spark.addEventListener("pointermove", (event) => {
    const box = spark.getBoundingClientRect();
    const seconds = history[kind];
    const i = Math.round(((event.clientX - box.left) / box.width) * (SECONDS - 1)) - (SECONDS - seconds.length);
    const second = seconds[i];
    const tip = tile.querySelector(".tip");
    tip.hidden = !second;
    tile.querySelector(".cross").style.display = second ? "" : "none";
    if (!second) return;
    const ago = seconds.length - 1 - i;
    tip.textContent = `${ago ? `${ago} s ago` : "Last second"}: ${count.format(second.messages)}, ${bytesPerSecond(second.bytes)}`;
    tip.style.left = `${Math.min(box.width - tip.offsetWidth, Math.max(0, event.clientX - box.left - tip.offsetWidth / 2))}px`;
    const x = i + (SECONDS - seconds.length);
    tile.querySelector(".cross").setAttribute("x1", x);
    tile.querySelector(".cross").setAttribute("x2", x);
  });
  spark.addEventListener("pointerleave", () => {
    tile.querySelector(".tip").hidden = true;
    tile.querySelector(".cross").style.display = "none";
  });
}
for (const li of document.querySelectorAll(".key [data-kind]")) li.style.setProperty("--kind", KINDS[li.dataset.kind].color);

function renderTiles() {
  for (const [kind, tile] of tiles) {
    const seconds = history[kind];
    const { count: n, per, bytes } = busy(kind);
    tile.querySelector(".value strong").textContent = count.format(Math.round(n));
    tile.querySelector(".value span").textContent = per;
    tile.querySelector(".bytes").textContent = bytesPerSecond(bytes);
    const top = Math.max(1, ...seconds.map((second) => second.messages));
    const offset = SECONDS - seconds.length;
    const points = seconds.map((second, i) => `${i + offset},${(40 - (second.messages / top) * 36).toFixed(1)}`);
    if (!points.length) continue;
    tile.querySelector(".line").setAttribute("d", `M${points.join("L")}`);
    tile.querySelector(".area").setAttribute("d", `M${offset},40L${points.join("L")}L${SECONDS - 1},40Z`);
  }
  const all = Object.keys(KINDS).reduce((sum, kind) => sum + rate(kind), 0);
  const bytes = Object.keys(KINDS).reduce((sum, kind) => sum + rate(kind, "bytes"), 0);
  $("#rate").textContent = count.format(Math.round(all));
  $("#volume").textContent = `, ${bytesPerSecond(bytes)}`;
}

// The games, busiest first

function renderGames() {
  const rows = [...games.entries()]
    .filter(([, g]) => g.listing || g.rate.messages)
    .sort(([, a], [, b]) => b.rate.messages - a.rate.messages || a.order - b.order)
    .map(([id, g]) => {
      const tr = document.createElement("tr");
      const listing = g.listing;
      const cells = [
        listing?.title ?? id,
        listing?.host ?? "",
        listing ? `${listing.players}/${listing.maxPlayers}` : `${g.peers.size}`,
        `${count.format(g.rate.messages)}/s`,
        bytesPerSecond(g.rate.bytes),
      ];
      for (const text of cells) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.append(td);
      }
      if (listing?.state === "playing" && listing.spectators !== false) {
        const a = document.createElement("a");
        a.href = link("./", { watch: id });
        a.className = "watch";
        a.textContent = "Watch";
        tr.cells[0].append(" ", a);
      }
      return tr;
    });
  $("#flow-games").replaceChildren(...rows);
  $("#no-games").hidden = rows.length > 0;
}

// The latest message, a few times a second

let latest = null;
const TAIL_LINES = 14;

function describe({ kind, payload }) {
  if (kind === "packets") {
    if (payload.length < 2) return "?";
    const type = (payload[0] << 8) | payload[1];
    const name = PACKET_TYPES[type & 0x7fff] ?? `type ${type & 0x7fff}`;
    return type & 0x8000 ? `${name}, reliable` : name;
  }
  if (!payload.length) return kind === "listings" ? "listing cleared, the host left" : "cleared";
  if (kind === "listings") {
    const listing = parseListing(payload);
    return listing ? `${clip(listing.title, 30)}, ${listing.state}, ${listing.players}/${listing.maxPlayers}` : "listing";
  }
  if (kind === "snapshots") {
    try {
      const watch = JSON.parse(new TextDecoder().decode(payload));
      return `${watch.players?.length ?? 0} players on ${watch.map ?? "?"}`;
    } catch {
      return "snapshot";
    }
  }
  return "save summary";
}

function tail() {
  if (!latest) return;
  const line = document.createElement("div");
  line.style.setProperty("--kind", KINDS[latest.kind].color);
  const [verb, topic, note] = ["b", "i", "span"].map((tag) => document.createElement(tag));
  verb.textContent = "PUBLISH";
  topic.textContent = latest.topic;
  note.textContent = `${size(latest.topic, latest.payload)} B  ${describe(latest)}`;
  line.append(verb, "  ", topic, "  ", note);
  const pre = $("#tail");
  pre.prepend(line);
  while (pre.children.length > TAIL_LINES) pre.lastChild.remove();
  latest = null;
}

// Every second: the counts move on, quiet games go

function tick() {
  for (const kind of Object.keys(KINDS)) {
    history[kind].push(now[kind]);
    if (history[kind].length > SECONDS) history[kind].shift();
    now[kind] = { messages: 0, bytes: 0 };
  }
  const t = performance.now();
  for (const [id, g] of games) {
    g.rate = g.second;
    g.second = { messages: 0, bytes: 0 };
    for (const [peer, seen] of g.peers) if (t - seen > 5_000) g.peers.delete(peer);
    if (t - g.spectators > 5_000) g.spectators = 0;
    if (!g.listing && t - g.seen > QUIET_FOR) games.delete(id);
  }
  for (const [line, seen] of lastDot) if (t - seen > 5_000) lastDot.delete(line);
  renderTiles();
  renderGames();
}

if (regions.length > 1) $("#broker-name").textContent = `LavinMQ, ${regionName(region)}`;
for (const a of document.querySelectorAll('a[href="./"], .bar a.nav')) a.href = link(a.getAttribute("href"));
renderTiles();
renderGames();
requestAnimationFrame(draw);

try {
  const mqtt = await MqttClient.connect(brokerUrl, { retry: RECONNECT_FOR });
  setStatus("Connected", true);
  mqtt.ondrop = () => setStatus("Reconnecting…");
  mqtt.onreconnect = () => setStatus("Connected", true);
  mqtt.onclose = () => setStatus("Disconnected from broker, reload to retry");
  mqtt.onmessage = receive;
  for (const { filter } of Object.values(KINDS)) await mqtt.subscribe(filter);
  setInterval(tick, 1000);
  setInterval(tail, 150);
} catch (error) {
  setStatus(error.message);
}
