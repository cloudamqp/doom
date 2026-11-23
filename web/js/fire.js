// The fire from the PlayStation port of Doom: every cell takes the heat of
// the cell below it, a little cooler and blown sideways, and the bottom row
// burns at full heat. Drawn at a low resolution and scaled up, pixels and all.

const HOT = 36;
const FPS = 30;
const COOLING = 0.45; // chance a cell cools a step on its way up, lower burns taller

// Black, through red, orange and yellow, to white
const STOPS = [
  [0, [7, 7, 7]],
  [5, [103, 23, 7]],
  [11, [191, 55, 7]],
  [17, [223, 95, 7]],
  [25, [215, 135, 23]],
  [31, [239, 191, 63]],
  [34, [255, 231, 150]],
  [36, [255, 250, 235]],
];

const palette = new Uint32Array(HOT + 1);
for (let heat = 1; heat <= HOT; heat++) {
  const upper = STOPS.findIndex(([at]) => at >= heat);
  const [from, low] = STOPS[upper - 1];
  const [to, high] = STOPS[upper];
  const [r, g, b] = low.map((value, i) => Math.round(value + ((high[i] - value) * (heat - from)) / (to - from)));
  palette[heat] = (255 << 24) | (b << 16) | (g << 8) | r; // ImageData is RGBA, little endian
}

// Burns in the canvas until stopped. flare() makes it burn taller for a moment.
export function burn(canvas, { rows = 110 } = {}) {
  const context = canvas.getContext("2d");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let width, height, heat, image, pixels;
  let cooling = COOLING;
  let frame;
  let last = 0;

  function resize() {
    const scale = Math.max(1, canvas.clientHeight / rows);
    width = Math.max(1, Math.round(canvas.clientWidth / scale));
    height = rows;
    canvas.width = width;
    canvas.height = height;
    heat = new Uint8Array(width * height).fill(HOT, (height - 1) * width);
    image = context.createImageData(width, height);
    pixels = new Uint32Array(image.data.buffer);
    // Lit already, a still of it burns all the way up
    for (let i = 0; i < (still ? rows * 3 : 24); i++) spread();
    draw();
  }

  function spread() {
    for (let source = width; source < heat.length; source++) {
      const value = heat[source];
      if (value === 0) {
        heat[source - width] = 0;
        continue;
      }
      const wind = (Math.random() * 3) | 0;
      const target = source - width - wind + 1;
      if (target >= 0) heat[target] = value - (Math.random() < cooling ? 1 : 0);
    }
  }

  function draw() {
    for (let i = 0; i < heat.length; i++) pixels[i] = palette[heat[i]];
    context.putImageData(image, 0, 0);
  }

  function tick(time) {
    frame = requestAnimationFrame(tick);
    if (time - last < 1000 / FPS) return;
    last = time;
    spread();
    draw();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  if (!still) frame = requestAnimationFrame(tick);

  let calm;
  return {
    flare() {
      cooling = COOLING * 0.6;
      clearTimeout(calm);
      calm = setTimeout(() => (cooling = COOLING), 400);
    },
    stop() {
      cancelAnimationFrame(frame);
      observer.disconnect();
    },
  };
}
