// Card images come from the encrypted image packs (see imagepack.js): once unlocked, they live in the
// phone's Cache Storage and the service worker serves them under images/card/<file>. Until then, or
// for a card missing from the packs, a box with the card number shows instead.

import { cardImageUrl } from "./imagepack.js";

export function imageUrl(variant) {
  return cardImageUrl(variant.file);
}

// <img> for a variant; falls back to a box with the card number when the image cannot be loaded.
export function cardImage(variant) {
  const img = new Image();
  img.className = "card-img";
  img.alt = variant.id;
  img.decoding = "async";
  img.loading = "lazy";
  img.addEventListener("error", () => {
    const box = document.createElement("div");
    box.className = "noimg";
    box.textContent = variant.id;
    img.replaceWith(box);
  }, { once: true });
  img.src = imageUrl(variant);
  return img;
}
