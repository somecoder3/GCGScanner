// Single-card scanning with perspective correction: look for the card's outline around the guide box
// and use the straightened cut-out instead of the plain guide crop when one is found.

// Guide box [x, y, w, h] plus a margin on each side, clipped to the frame: where to look for the card.
export function around([x, y, w, h], frameWidth, frameHeight, margin = 0.15) {
  const x0 = Math.max(0, x - w * margin), y0 = Math.max(0, y - h * margin);
  return [x0, y0, Math.min(frameWidth, x + w * (1 + margin)) - x0, Math.min(frameHeight, y + h * (1 + margin)) - y0];
}

// The detected card that belongs to the guide: centred inside it and of about its size (the card
// is held roughly in the frame). Largest first, so an inner frame of the artwork does not win.
export function pickCard({ cards }, [gx, gy, gw, gh]) {
  let best = null, bestArea = 0;
  for (const card of cards) {
    const [cx, cy] = card.quad.reduce(([sx, sy], [x, y]) => [sx + x / 4, sy + y / 4], [0, 0]);
    if (cx < gx || cy < gy || cx > gx + gw || cy > gy + gh) continue;
    const area = Math.abs(card.quad.reduce((s, [x, y], i) => s + x * card.quad[(i + 1) % 4][1] - card.quad[(i + 1) % 4][0] * y, 0)) / 2;
    if (area < gw * gh * 0.4 || area > gw * gh * 1.6) continue;
    if (area > bestArea) [best, bestArea] = [card, area];
  }
  return best;
}
