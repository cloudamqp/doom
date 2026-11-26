// Doom on a touch screen: a stick under the left thumb to move, a drag
// under the right to turn, and buttons to fire, use and change weapon.
//
// Doom asks Module.bot for the player's moves every tic, as it asks a bot
// (doom/src/doom/b_bot.c), so the screen answers with ticcmds instead of
// pretending to be a keyboard and a mouse.

// Buttons of a ticcmd, see doom/src/doom/d_event.h
export const ATTACK = 1;
export const USE = 2;
const CHANGE = 4;
const WEAPON_SHIFT = 3;

const RUN = 50; // a running player's push, forward and sideways each
const REST = 0.2; // of the stick's reach: a thumb never lies quite still
const FULL_TURN = 65536;
// Of a full turn, for a drag across the screen's width: a thumb reaches
// 40% of it, which turns the player around
const SWIPE = 1.25;
const MAX_TURN = 32767; // a ticcmd's turn is 16 bits

// Fist, pistol, shotgun, chaingun, rocket launcher, plasma rifle, BFG, and
// the ammo each takes: bullets, shells, cells, rockets
const WEAPON_AMMO = [null, 0, 1, 0, 3, 2, 2];

const push = (part) => (Math.abs(part) < REST ? 0 : Math.round(Math.max(-1, Math.min(1, part)) * RUN));

// What the fingers do, as ticcmds. game() tells what the player carries:
// weapon, weapons as bits, and ammo by type.
export function touchPlayer(game) {
  let [forward, side, turn, change] = [0, 0, 0, 0];
  const held = new Set();
  const tapped = new Set();

  return {
    // Where the stick is held, -1 to 1 of its reach: right and down
    stick(x, y) {
      [forward, side] = [push(-y), push(x)];
    },
    // By how much of the screen's width a finger moved to the right
    drag(width) {
      turn -= width * SWIPE * FULL_TURN;
    },
    press(button) {
      held.add(button);
      tapped.add(button);
    },
    release: (button) => held.delete(button),
    nextWeapon() {
      const { weapon, weapons, ammo } = game();
      const usable = (w) => weapons & (1 << w) && (WEAPON_AMMO[w] === null || ammo[WEAPON_AMMO[w]] > 0);
      const next = WEAPON_AMMO.map((_, i) => (weapon + 1 + i) % WEAPON_AMMO.length).find(usable);
      if (next !== undefined && next !== weapon) change = CHANGE | (next << WEAPON_SHIFT);
    },
    ticcmd() {
      const now = Math.max(-MAX_TURN, Math.min(MAX_TURN, Math.round(turn)));
      const buttons = [...held, ...tapped].reduce((all, button) => all | button, change);
      turn -= now;
      change = 0;
      tapped.clear();
      return { forward, side, turn: now, buttons };
    },
  };
}

// Whether the page is on a phone or a tablet: fingers, and no mouse
export const onTouchScreen = () => navigator.maxTouchPoints > 0 && matchMedia("(pointer: coarse)").matches;

const REACH = 56; // px a thumb moves the stick to its end
const NO_CHANGE = 10; // pending weapon when none is, wp_nochange

// What the player carries, from B_Game in doom/src/doom/b_bot.c
function carried(doom) {
  if (!doom?._B_Game) return { weapon: 0, weapons: 0, ammo: [] };
  const record = doom.HEAP32.subarray((doom._B_Game() >> 2) + 1);
  const [weapon, pending, weapons] = record.subarray(11, 14);
  // Tapping twice goes two weapons on, before the first is up
  return { weapon: pending === NO_CHANGE ? weapon : pending, weapons, ammo: [19, 21, 23, 25].map((at) => record[at]) };
}

// Doom's waiting room and menus take keys
function key(code, keyCode) {
  for (const type of ["keydown", "keyup"]) window.dispatchEvent(new KeyboardEvent(type, { code, key: code, keyCode, which: keyCode, bubbles: true }));
}

// Shows the controls in root (#touch in index.html) and returns the player
// for Module.bot. doom() is the Emscripten module once Doom runs.
export function touchControls(root, doom) {
  const player = touchPlayer(() => carried(doom()));
  const knob = root.querySelector(".stick");
  const actions = {
    fire: { down: () => player.press(ATTACK), up: () => player.release(ATTACK) },
    use: { down: () => player.press(USE), up: () => player.release(USE) },
    weapon: { down: () => player.nextWeapon() },
    start: { down: () => key("Space", 32) },
    // Browsers only go fullscreen from a touch that ended
    fullscreen: { up: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}) },
  };
  const fingers = new Map(); // touch identifier -> what that finger does
  let stick; // the finger on it
  let awake; // the lock that keeps the screen on

  // A screen that dims and locks stalls the game for everyone. The lock is
  // lost when the page is hidden, and some browsers only give it after a
  // touch.
  const stayAwake = async () => {
    if (document.hidden || (awake && !awake.released)) return;
    awake = await navigator.wakeLock?.request("screen").catch(() => undefined);
  };

  root.hidden = false;
  root.querySelector("[data-action=fullscreen]").hidden = !document.documentElement.requestFullscreen;

  // Touch events, not pointer events: every finger keeps reporting to the
  // element it landed on, wherever it moves
  const each = (handle) => (event) => {
    if (event.target.closest("a")) return; // Leave is a link
    event.preventDefault();
    for (const touch of event.changedTouches) handle(touch);
  };

  const land = (touch) => {
    const action = actions[touch.target.closest("[data-action]")?.dataset.action];
    const finger = { action, x: touch.clientX, y: touch.clientY };
    // The left half of the screen is the stick, wherever the thumb lands.
    // Every other finger turns, also one on a button: the thumb that fires
    // aims too.
    if (!action && !stick && touch.clientX < innerWidth / 2) {
      stick = finger;
      Object.assign(knob.style, { left: `${finger.x}px`, top: `${finger.y}px` });
      knob.hidden = false;
    }
    fingers.set(touch.identifier, finger);
    action?.down?.();
  };

  const move = (touch) => {
    const finger = fingers.get(touch.identifier);
    if (!finger) return;
    if (finger === stick) {
      const [x, y] = [(touch.clientX - finger.x) / REACH, (touch.clientY - finger.y) / REACH];
      const far = Math.max(1, Math.hypot(x, y));
      player.stick(x, y);
      knob.style.setProperty("--x", `${(x / far) * REACH}px`);
      knob.style.setProperty("--y", `${(y / far) * REACH}px`);
    } else {
      player.drag((touch.clientX - finger.x) / innerWidth);
      finger.x = touch.clientX;
    }
  };

  const lift = (touch) => {
    const finger = fingers.get(touch.identifier);
    if (!finger) return;
    fingers.delete(touch.identifier);
    finger.action?.up?.();
    if (finger === stick) {
      stick = undefined;
      player.stick(0, 0);
      knob.hidden = true;
      knob.style.removeProperty("--x");
      knob.style.removeProperty("--y");
    }
    // Browsers only let sound start from a touch that ended
    doom()?.SDL2?.audioContext?.resume();
    stayAwake();
  };

  root.addEventListener("touchstart", each(land), { passive: false });
  root.addEventListener("touchmove", each(move), { passive: false });
  root.addEventListener("touchend", each(lift), { passive: false });
  root.addEventListener("touchcancel", each(lift), { passive: false });
  root.addEventListener("contextmenu", (event) => event.preventDefault());

  document.addEventListener("visibilitychange", stayAwake);
  stayAwake();

  return player;
}
