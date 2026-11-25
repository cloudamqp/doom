// Minimal MQTT 3.1.1 client over WebSocket. Supports what DooMQ needs:
// QoS 0 publish/subscribe, retained messages, a last will, and getting a
// lost connection back.

const CONNECT = 1;
const CONNACK = 2;
const PUBLISH = 3;
const PUBACK = 4;
const SUBSCRIBE = 8;
const SUBACK = 9;
const PINGREQ = 12;
const DISCONNECT = 14;

const CONNACK_ERRORS = [
  "",
  "unacceptable protocol version",
  "identifier rejected",
  "server unavailable",
  "bad username or password",
  "not authorized",
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// crypto.randomUUID() needs a secure context, players may use plain http
export function randomHex(n) {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function bytes(data) {
  return typeof data === "string" ? encoder.encode(data) : data;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u16(n) {
  return Uint8Array.of(n >> 8, n & 0xff);
}

function lengthPrefixed(data) {
  const b = bytes(data);
  return concat([u16(b.length), b]);
}

export function encodeLength(n) {
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Uint8Array.from(out);
}

function packet(type, flags, parts) {
  const body = concat(parts);
  return concat([Uint8Array.of((type << 4) | flags), encodeLength(body.length), body]);
}

export function connectPacket({ clientId, username, password, keepalive, will }) {
  let flags = 0x02; // clean session
  const payload = [lengthPrefixed(clientId)];
  if (will) {
    flags |= 0x04 | (will.retain ? 0x20 : 0);
    payload.push(lengthPrefixed(will.topic), lengthPrefixed(will.payload));
  }
  if (username) {
    flags |= 0x80;
    payload.push(lengthPrefixed(username));
  }
  if (password) {
    flags |= 0x40;
    payload.push(lengthPrefixed(password));
  }
  const header = [lengthPrefixed("MQTT"), Uint8Array.of(4, flags), u16(keepalive)];
  return packet(CONNECT, 0, [...header, ...payload]);
}

export function publishPacket(topic, payload, retain = false) {
  return packet(PUBLISH, retain ? 1 : 0, [lengthPrefixed(topic), bytes(payload)]);
}

export function subscribePacket(id, filter) {
  return packet(SUBSCRIBE, 0x02, [u16(id), lengthPrefixed(filter), Uint8Array.of(0)]);
}

// Splits a byte stream into packets. Returns the packets and the bytes
// left over from an incomplete trailing packet.
export function parse(data) {
  const packets = [];
  let offset = 0;
  for (;;) {
    let length = 0;
    let i = offset + 1;
    for (let shift = 0; ; shift += 7) {
      if (i >= data.length) return { packets, rest: data.subarray(offset) };
      if (shift > 21) throw new Error("malformed remaining length");
      const byte = data[i++];
      length += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) break;
    }
    if (i + length > data.length) return { packets, rest: data.subarray(offset) };
    packets.push({ type: data[offset] >> 4, flags: data[offset] & 0x0f, body: data.subarray(i, i + length) });
    offset = i + length;
  }
}

export function parsePublish({ flags, body }) {
  const topicLength = (body[0] << 8) | body[1];
  const topic = decoder.decode(body.subarray(2, 2 + topicLength));
  const qos = (flags >> 1) & 3;
  const offset = 2 + topicLength + (qos > 0 ? 2 : 0);
  return {
    topic,
    payload: body.subarray(offset),
    retain: Boolean(flags & 1),
    qos,
    id: qos > 0 ? (body[offset - 2] << 8) | body[offset - 1] : undefined,
  };
}

// How often a lost connection is tried again
const RETRY_INTERVAL = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class MqttClient {
  // url may carry credentials: ws://user:pass@host:15672/mqtt
  //
  // With retry, a connection that is lost is tried again for that many
  // milliseconds, as when the broker restarts: ondrop() tells of the loss,
  // onreconnect() that the client is back and subscribed as before. What is
  // published in between is lost, as are the messages that came. Without
  // retry, or when the time is up, onclose() tells that it is over.
  static async connect(url, options) {
    const client = new MqttClient(url, options);
    try {
      await client.#open();
    } catch (error) {
      clearInterval(client.#ping);
      throw error;
    }
    return client;
  }

  onmessage = () => {};
  ondrop = () => {};
  onreconnect = () => {};
  onclose = () => {};

  #target;
  #session; // what the broker is told as the connection opens
  #retry;
  #ws;
  #buffer;
  #nextId = 1;
  #pending = new Map();
  #filters = new Set(); // subscribed to, for when the connection is back
  #ping;
  #handshake;
  #recovering = false;
  #closed = false;

  constructor(url, { will, keepalive = 60, retry = 0 } = {}) {
    this.#target = new URL(url);
    const username = decodeURIComponent(this.#target.username);
    const password = decodeURIComponent(this.#target.password);
    this.#target.username = this.#target.password = "";
    this.#session = { clientId: `doomq-${randomHex(8)}`, username, password, keepalive, will };
    this.#retry = retry;
    this.#ping = setInterval(() => this.#send(Uint8Array.of(PINGREQ << 4, 0)), (keepalive * 1000) / 2);
  }

  get connected() {
    return this.#ws.readyState === WebSocket.OPEN;
  }

  publish(topic, payload, { retain = false } = {}) {
    this.#send(publishPacket(topic, payload, retain));
  }

  subscribe(filter) {
    this.#filters.add(filter);
    const id = this.#nextId;
    this.#nextId = (id % 0xffff) + 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send(subscribePacket(id, filter));
    });
  }

  close() {
    this.#closed = true;
    this.#send(Uint8Array.of(DISCONNECT << 4, 0));
    this.#ws.close();
  }

  // Opens a connection, and resolves once the broker has accepted it
  #open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.#target, "mqtt");
      let accepted = false;
      ws.binaryType = "arraybuffer";
      ws.onopen = () => ws.send(connectPacket(this.#session));
      ws.onerror = () => reject(new Error(`Could not connect to ${this.#target}`));
      ws.onmessage = (event) => this.#receive(new Uint8Array(event.data));
      ws.onclose = () => {
        this.#handshake?.(new Error("connection closed"));
        for (const pending of this.#pending.values()) pending.reject(new Error("connection closed"));
        this.#pending.clear();
        if (accepted) this.#lost();
      };
      this.#ws = ws;
      this.#buffer = new Uint8Array(0);
      this.#handshake = (error) => {
        this.#handshake = null;
        accepted = !error;
        if (error) reject(error);
        else resolve();
      };
    });
  }

  async #lost() {
    if (this.#recovering) return;
    this.#recovering = true;
    const deadline = Date.now() + (this.#closed ? 0 : this.#retry);
    if (Date.now() < deadline) this.ondrop();
    // Until the time is up, or close() says there is no need
    while (!this.#closed && Date.now() < deadline) {
      try {
        await this.#open();
        await Promise.all(Array.from(this.#filters, (filter) => this.subscribe(filter)));
        this.#recovering = false;
        this.onreconnect();
        return;
      } catch {
        await sleep(RETRY_INTERVAL);
      }
    }
    clearInterval(this.#ping);
    this.onclose();
  }

  #send(data) {
    if (this.connected) this.#ws.send(data);
  }

  #receive(data) {
    const { packets, rest } = parse(this.#buffer.length ? concat([this.#buffer, data]) : data);
    this.#buffer = rest;
    for (const p of packets) this.#dispatch(p);
  }

  #dispatch(p) {
    switch (p.type) {
      case CONNACK: {
        const code = p.body[1];
        this.#handshake(code && new Error(`MQTT connect refused: ${CONNACK_ERRORS[code] ?? code}`));
        break;
      }
      case PUBLISH: {
        const message = parsePublish(p);
        if (message.qos === 1) this.#send(packet(PUBACK, 0, [u16(message.id)]));
        this.onmessage(message.topic, message.payload, { retain: message.retain });
        break;
      }
      case SUBACK: {
        const id = (p.body[0] << 8) | p.body[1];
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        if (p.body[2] === 0x80) pending?.reject(new Error("subscription refused"));
        else pending?.resolve();
        break;
      }
    }
  }
}
