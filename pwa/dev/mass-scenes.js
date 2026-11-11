// Simulated photos for the mass scan (dev/mass-eval.html): cards lying in columns, each card covering
// the one above it except for its top strip, so only the top part with the corner (card number,
// rarity, year mark) is visible. Every card's corner position in the photo is known exactly.

// Corner with card number, rarity and year mark, as fractions of the card (official images are
// 600 × 838; the box starts further left with an "LK"/"SP" prefix, so the region is generous).
export const CORNER = { x0: 0.69, y0: 0, x1: 1, y1: 0.055 };
// Cap height of the card number relative to the card height (~14 px of 838).
export const TEXT_HEIGHT = 0.017;
export const BACKGROUNDS = ["holz", "dunkel", "hell", "spielmatte"];
const CARD_RATIO = 63 / 88;

export function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawBackground(ctx, W, H, kind, rand, matImage) {
  if (kind === "holz") {
    const hue = 20 + rand() * 20, light = 25 + rand() * 30;
    ctx.fillStyle = `hsl(${hue} 45% ${light}%)`;
    ctx.fillRect(0, 0, W, H);
    const band = Math.max(3, Math.round(H / 480));
    for (let y = 0; y < H; y += band) {
      const shade = Math.sin(y * 0.05 * 1440 / H + Math.sin(y * 0.007 * 1440 / H) * 6) * 0.5 + 0.5;
      ctx.fillStyle = `hsla(${hue} 50% ${light - 12 + shade * 18}% / 0.5)`;
      ctx.fillRect(0, y, W, band);
    }
  } else if (kind === "dunkel" || kind === "hell") {
    const light = kind === "dunkel" ? 8 + rand() * 15 : 75 + rand() * 17;
    ctx.fillStyle = `hsl(${rand() * 360} ${rand() * 25}% ${light}%)`;
    ctx.fillRect(0, 0, W, H);
  } else {
    // Play mat: card artwork, blurred and darkened, filling the table.
    ctx.filter = `blur(${W / 180}px) brightness(${0.5 + rand() * 0.4})`;
    ctx.drawImage(matImage, -W * 0.1, -H * 0.1, W * 1.2, H * 1.2);
    ctx.filter = "none";
  }
}

// Fabric grain and sensor noise.
function addNoise(ctx, W, H, rand, amount) {
  const image = ctx.getImageData(0, 0, W, H);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (rand() - 0.5) * amount;
    data[i] += n; data[i + 1] += n; data[i + 2] += n;
  }
  ctx.putImageData(image, 0, 0);
}

// One random value for "auto" settings, otherwise the chosen one.
const pick = (value, rand, choices) => value ?? choices[Math.floor(rand() * choices.length)];

// cards: [{ variant, image }] in laying order (column by column, top to bottom).
// options: width, height, columns, visible (fraction of the card height left uncovered), background,
// sleeves; null/undefined = random. Returns { frame: ImageBitmap, cards: [{ variant, corner, textPx,
// inFrame }], meta }.
export async function makeMassScene(cards, rand, cv, options = {}) {
  const W = options.width ?? 4000, H = options.height ?? 3000;
  const background = pick(options.background, rand, BACKGROUNDS);
  const columns = Math.min(cards.length, options.columns ?? 2 + Math.floor(rand() * 4));
  const visible = options.visible ?? 0.15 + rand() * 0.17;
  const sleeves = options.sleeves ?? rand() < 0.5;
  const perColumn = Math.ceil(cards.length / columns);

  // Card size: all columns side by side and the longest column must fit into ~88 % of the photo.
  const gapX = 0.06 + rand() * 0.1;
  const cardH = Math.min(
    (H * 0.88) / (1 + (perColumn - 1) * visible),
    (W * 0.88) / (columns * CARD_RATIO * (1 + gapX)),
  );
  const cardW = cardH * CARD_RATIO;
  const layoutW = columns * cardW * (1 + gapX), layoutH = cardH * (1 + (perColumn - 1) * visible);

  const top = new OffscreenCanvas(W, H);
  const ctx = top.getContext("2d");
  drawBackground(ctx, W, H, background, rand, options.matImage ?? cards[0].image);
  addNoise(ctx, W, H, rand, 14);

  // Whole layout slightly turned; every column and every card a little more.
  const global = new DOMMatrix()
    .translate(W / 2 + (rand() - 0.5) * (W - layoutW) * 0.5, H / 2 + (rand() - 0.5) * (H - layoutH) * 0.5)
    .rotate((rand() - 0.5) * 10);
  const placed = [];
  for (let col = 0; col < columns; col++) {
    const column = global
      .translate(-layoutW / 2 + (col + 0.5) * cardW * (1 + gapX) + (rand() - 0.5) * cardW * 0.08, -layoutH / 2)
      .rotate((rand() - 0.5) * 6);
    const inColumn = cards.slice(col * perColumn, (col + 1) * perColumn);
    inColumn.forEach((card, row) => {
      const y = row * visible * cardH * (1 + (rand() - 0.5) * 0.15) + cardH / 2;
      const matrix = column.translate((rand() - 0.5) * cardW * 0.06, y).rotate((rand() - 0.5) * 4);
      placed.push({ ...card, matrix });
    });
  }

  for (const { image, matrix } of placed) {
    ctx.setTransform(matrix);
    if (sleeves) {
      // Slightly larger, glossy sleeve with a dark or clear border.
      const s = cardW * 0.025;
      ctx.beginPath();
      ctx.roundRect(-cardW / 2 - s, -cardH / 2 - s, cardW + 2 * s, cardH + 2 * s, cardW * 0.06);
      ctx.fillStyle = rand() < 0.5 ? "rgba(20,20,30,0.92)" : "rgba(230,230,240,0.35)";
      ctx.fill();
    } else {
      // Thin shadow under the card, so stacked cards stand out a bit like in a photo.
      ctx.shadowColor = "rgba(0,0,0,0.45)";
      ctx.shadowBlur = cardW * 0.02;
      ctx.shadowOffsetY = cardW * 0.008;
    }
    ctx.drawImage(image, -cardW / 2, -cardH / 2, cardW, cardH);
    ctx.shadowColor = "transparent";
    if (sleeves) {
      const gloss = ctx.createLinearGradient(-cardW / 2, -cardH / 2, cardW / 2, cardH / 2);
      const at = 0.2 + rand() * 0.6;
      gloss.addColorStop(0, "rgba(255,255,255,0)");
      gloss.addColorStop(at, `rgba(255,255,255,${0.05 + rand() * 0.15})`);
      gloss.addColorStop(Math.min(1, at + 0.1), "rgba(255,255,255,0)");
      ctx.fillStyle = gloss;
      ctx.fillRect(-cardW / 2, -cardH / 2, cardW, cardH);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Corner of every card in the flat layout, in photo pixels.
  const local = ([fx, fy]) => [(fx - 0.5) * cardW, (fy - 0.5) * cardH];
  const cornerPoints = [[CORNER.x0, CORNER.y0], [CORNER.x1, CORNER.y0], [CORNER.x1, CORNER.y1], [CORNER.x0, CORNER.y1]];
  for (const card of placed) {
    card.corner = cornerPoints.map((p) => {
      const [x, y] = local(p);
      const q = card.matrix.transformPoint(new DOMPoint(x, y));
      return [q.x, q.y];
    });
  }

  // Phone held at an angle: move the photo corners inwards by up to `tilt`.
  const tilt = 0.08 * rand();
  const from = [[0, 0], [W, 0], [W, H], [0, H]];
  const to = from.map(([x, y]) => [x + (x ? -1 : 1) * rand() * tilt * W, y + (y ? -1 : 1) * rand() * tilt * H]);
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, to.flat());
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, from.flat());
  const m = cv.getPerspectiveTransform(src, dst);
  const input = cv.matFromImageData(ctx.getImageData(0, 0, W, H));
  const output = new cv.Mat();
  let warped;
  try {
    cv.warpPerspective(input, output, m, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_REFLECT);
    warped = new ImageData(new Uint8ClampedArray(output.data), W, H);
    const h = m.data64F;
    const project = ([x, y]) => {
      const d = h[6] * x + h[7] * y + h[8];
      return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
    };
    for (const card of placed) card.corner = card.corner.map(project);
  } finally {
    [src, dst, m, input, output].forEach((mat) => mat.delete());
  }

  // Light, focus, glare, sensor noise and JPEG like a phone photo.
  const frame = new OffscreenCanvas(W, H);
  const fctx = frame.getContext("2d", { willReadFrequently: true });
  const flat = new OffscreenCanvas(W, H);
  flat.getContext("2d").putImageData(warped, 0, 0);
  const blur = rand() * 1.6 * (W / 4000) + 0.3;
  fctx.filter = `brightness(${0.65 + rand() * 0.6}) contrast(${0.8 + rand() * 0.35}) blur(${blur.toFixed(2)}px)`;
  fctx.drawImage(flat, 0, 0);
  fctx.filter = "none";
  // uneven light across the table
  const shade = fctx.createLinearGradient(rand() * W, 0, rand() * W, H);
  shade.addColorStop(0, `rgba(0,0,0,${rand() * 0.3})`);
  shade.addColorStop(1, `rgba(0,0,0,${rand() * 0.3})`);
  fctx.fillStyle = shade;
  fctx.fillRect(0, 0, W, H);
  const glare = rand() < 0.5;
  if (glare) {
    const gx = rand() * W, gy = rand() * H, r = W * (0.08 + rand() * 0.25);
    const spot = fctx.createRadialGradient(gx, gy, 0, gx, gy, r);
    spot.addColorStop(0, `rgba(255,255,255,${0.25 + rand() * 0.4})`);
    spot.addColorStop(1, "rgba(255,255,255,0)");
    fctx.fillStyle = spot;
    fctx.fillRect(0, 0, W, H);
  }
  addNoise(fctx, W, H, rand, 8);
  const blob = await frame.convertToBlob({ type: "image/jpeg", quality: 0.85 });

  const textFactor = TEXT_HEIGHT / (CORNER.y1 - CORNER.y0);
  const length = ([ax, ay], [bx, by]) => Math.hypot(bx - ax, by - ay);
  const result = placed.map(({ variant, corner }) => ({
    variant,
    corner,
    textPx: ((length(corner[1], corner[2]) + length(corner[0], corner[3])) / 2) * textFactor,
    inFrame: corner.every(([x, y]) => x >= 0 && y >= 0 && x <= W && y <= H),
  }));
  return {
    frame: await createImageBitmap(blob),
    cards: result,
    meta: { width: W, height: H, background, columns, perColumn, visible, sleeves, tilt, glare, blur, cardH },
  };
}
