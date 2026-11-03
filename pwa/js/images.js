// Card images come from ExBurst's CDN: it allows cross-origin use (Access-Control-Allow-Origin: *) and
// names files like the official site (GD06-002_p1.webp). gundam-gcg.com itself sends
// Cross-Origin-Resource-Policy: same-site, so its images cannot be shown here. The service worker keeps
// every image it has loaded once, so each picture is requested from ExBurst only once per phone.

const CDN = "https://cdn.exburst.dev/cards/gundam-en/";
// The CDN resizes on request; 360 px wide is sharp enough for thumbnails and half the original size.
const WIDTH = 360;

export function imageUrl(variant) {
  return `${CDN}${variant.file}?width=${WIDTH}`;
}

// <img> for a variant; falls back to a box with the card number when the image cannot be loaded.
export function cardImage(variant) {
  const img = new Image();
  img.className = "card-img";
  img.alt = variant.id;
  img.decoding = "async";
  img.loading = "lazy";
  // A CORS request, so the service worker gets a readable response it can check and cache.
  img.crossOrigin = "anonymous";
  img.addEventListener("error", () => {
    const box = document.createElement("div");
    box.className = "noimg";
    box.textContent = variant.id;
    img.replaceWith(box);
  }, { once: true });
  img.src = imageUrl(variant);
  return img;
}
