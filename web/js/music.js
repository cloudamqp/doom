// Music until the game starts: Freedoom's E1M1, rendered as Doom plays it
// by bin/build.sh. Browsers only play sound once people interact with the
// page, so it starts then. Its volume is Doom's music volume, 0 to 15, kept
// in Doom's settings so the game starts with it too.

const CONFIG = "doomq:default.cfg"; // as play.js keeps Doom's settings
const VOLUME = /^(music_volume\s+)(\d+)$/m;
const FADE = 600; // ms

const $ = (selector) => document.querySelector(selector);
const audio = $("#music");
const controls = $(".music");
const toggle = $("#music-toggle");
const slider = $("#music-volume");

let volume = 8;
let unmuted = volume; // what the toggle turns it back on to
let touched = false;
let stopped = false;

// Doom's settings as stored, or as served before the first game
let defaults;
const config = async () =>
  localStorage.getItem(CONFIG) ?? (await (defaults ??= fetch("default.cfg").then((response) => response.text())));

function show() {
  slider.value = volume;
  toggle.setAttribute("aria-pressed", volume > 0);
  audio.volume = volume / 15;
}

// Clicks, taps and keys let a page play sound, other events may not
const STARTERS = ["click", "keydown"];

function play() {
  if (stopped || volume === 0) return;
  audio.play().then(
    () => STARTERS.forEach((type) => removeEventListener(type, play, true)),
    () => {}, // not yet allowed
  );
}

async function setVolume(value) {
  touched = true;
  volume = value;
  if (volume > 0) unmuted = volume;
  show();
  if (volume > 0) play();
  else audio.pause();
  try {
    localStorage.setItem(CONFIG, (await config()).replace(VOLUME, `$1${volume}`));
  } catch {}
}

// Fades out for the game's own music
export function stopMusic() {
  stopped = true;
  controls.hidden = true;
  const start = performance.now();
  const from = audio.volume;
  // A timer, unlike animation frames, also runs in hidden tabs
  const fading = setInterval(() => {
    const left = 1 - (performance.now() - start) / FADE;
    audio.volume = from * Math.max(0, left);
    if (left > 0) return;
    clearInterval(fading);
    audio.pause();
  }, 30);
}

slider.addEventListener("input", () => setVolume(Number(slider.value)));
toggle.addEventListener("click", () => setVolume(volume > 0 ? 0 : unmuted));
audio.addEventListener("error", () => (controls.hidden = true)); // not built

for (const type of STARTERS) addEventListener(type, play, true);

show();
config()
  .then((text) => {
    const stored = Number(text.match(VOLUME)?.[2]);
    if (touched || !(stored >= 0 && stored <= 15)) return;
    volume = stored;
    if (volume > 0) unmuted = volume;
    show();
  })
  .catch(() => {});
