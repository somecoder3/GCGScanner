// Mass scan view (#masse): one photo of cards lying in columns, each covering the one above except
// for its top strip. The worker finds and reads the card numbers in the top right corners; the
// photo is shown with a frame on every read card (tap to leave a card out), the cards below it,
// and one button adds them all to the list. The variant is not known from the number alone, so
// cards with several variants are marked "Variante prüfen" in the list.

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
const LENS_KEY = "gcg-scanner-lens"; // the lens chosen in the single-card scanner (app.js)

export function setupMass({ index, collection, cardImage, toast }) {
  let worker = null, ready = null, nextId = 0;
  const pending = new Map();
  let photoUrl = null;
  let found = []; // [{ quad, cardNo, variant, included }]

  function call(message, transfer = []) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...message, id }, transfer);
    });
  }

  // Worker and reading model are loaded on the first photo (OpenCV.js is cached already).
  function start() {
    ready ??= (async () => {
      worker = new Worker(new URL("./mass-worker.js", import.meta.url));
      worker.onmessage = ({ data }) => {
        const request = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) request.reject(new Error(data.error));
        else request.resolve(data);
      };
      worker.onerror = (event) => {
        const error = new Error(event.message || "Massenscan konnte nicht geladen werden");
        for (const request of pending.values()) request.reject(error);
        pending.clear();
        ready = null;
      };
      const meta = await fetch(new URL("../data/index.json", import.meta.url), { cache: "no-cache" }).then((r) => r.json());
      if (!meta.ocr) throw new Error("Kein Lesemodell vorhanden (data/ocr-model.json)");
      const model = await fetch(new URL(`../data/ocr-model.json?v=${meta.ocr}`, import.meta.url)).then((r) => r.json());
      await call({ type: "init", model, cardNumbers: [...new Set(index.variants.map((v) => v.cardNo))] });
    })();
    return ready;
  }

  // The base variant of a card number (its id equals the number), else the first one.
  const variantOf = (cardNo) => index.variants[index.byId.get(cardNo)] ?? index.variants.find((v) => v.cardNo === cardNo);
  const variantCount = new Map();
  for (const v of index.variants) variantCount.set(v.cardNo, (variantCount.get(v.cardNo) ?? 0) + 1);

  async function read(file) {
    if (!file) return;
    stopLive();
    const status = $("mass-status");
    status.textContent = "Lade Erkennung …";
    found = [];
    render(null);
    try {
      await start();
      // EXIF orientation is applied, so the bitmap matches the <img> shown below.
      const photo = await createImageBitmap(file);
      const { width, height } = photo;
      if (photoUrl) URL.revokeObjectURL(photoUrl);
      photoUrl = URL.createObjectURL(file);
      status.textContent = `Lese ${width} × ${height} Pixel …`;
      const { cards, ms } = await call({ type: "read", photo }, [photo]);
      found = cards.map((card) => ({ ...card, variant: variantOf(card.cardNo), included: true }))
        .filter((card) => card.variant);
      status.textContent = found.length
        ? `${found.length} Karten erkannt (${(ms / 1000).toFixed(1)} s). Antippen schließt eine Karte aus. Fehlende Karten bitte einzeln scannen oder ein zweites Foto machen.`
        : "Keine Kartennummer erkannt. Tipp: Nummern oben rechts gut ausleuchten, Handy gerade halten, nicht zu weit weg.";
      render({ width, height });
    } catch (error) {
      console.error(error);
      status.textContent = `Fehler: ${error.message}`;
    }
  }

  // Photo with a frame per card and the list of cards below it.
  let size = null;
  function render(newSize) {
    if (newSize !== undefined) size = newSize;
    const box = $("mass-photo");
    box.hidden = !size;
    $("mass-zoom").hidden = !size;
    if (!size) box.classList.remove("zoomed");
    $("mass-zoom").textContent = box.classList.contains("zoomed") ? "Foto verkleinern" : "Foto vergrößern";
    if (size) {
      const img = $("mass-img");
      if (img.src !== photoUrl) img.src = photoUrl;
      const svg = $("mass-overlay");
      svg.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
      const line = Math.max(3, size.width / 400);
      svg.replaceChildren(...found.map((card, i) => {
        const group = document.createElementNS(SVG, "g");
        group.classList.toggle("off", !card.included);
        const polygon = document.createElementNS(SVG, "polygon");
        // a little larger than the read row, easier to tap
        const cx = card.quad.reduce((s, p) => s + p[0], 0) / 4, cy = card.quad.reduce((s, p) => s + p[1], 0) / 4;
        polygon.setAttribute("points", card.quad.map(([x, y]) => `${cx + (x - cx) * 1.25},${cy + (y - cy) * 1.6}`).join(" "));
        polygon.setAttribute("stroke-width", line);
        const label = document.createElementNS(SVG, "text");
        // Left of the frame, as high as the number row (rows lie close together).
        const rowHeight = Math.hypot(card.quad[3][0] - card.quad[0][0], card.quad[3][1] - card.quad[0][1]);
        label.setAttribute("x", Math.min(...card.quad.map((p) => p[0])) - rowHeight * 0.8);
        label.setAttribute("y", cy + rowHeight * 0.4);
        label.setAttribute("font-size", rowHeight * 1.1);
        label.setAttribute("text-anchor", "end");
        label.textContent = card.cardNo;
        group.append(polygon, label);
        group.addEventListener("click", () => {
          found[i].included = !found[i].included;
          render();
        });
        return group;
      }));
    }

    // Cards below the photo, grouped by number.
    const groups = new Map();
    for (const card of found) {
      const group = groups.get(card.cardNo) ?? { variant: card.variant, count: 0, off: 0 };
      if (card.included) group.count++;
      else group.off++;
      groups.set(card.cardNo, group);
    }
    $("mass-items").replaceChildren(...[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([cardNo, group]) => {
      const row = document.createElement("div");
      row.className = "item" + (group.count ? "" : " off");
      const thumb = document.createElement("div");
      thumb.className = "thumb";
      thumb.append(cardImage(group.variant));
      const info = document.createElement("div");
      info.className = "info";
      info.innerHTML = "<b></b><small></small>";
      info.querySelector("b").textContent = group.variant.name;
      const several = variantCount.get(cardNo) > 1 ? " · Variante später prüfen" : "";
      info.querySelector("small").textContent = `${cardNo}${several}${group.off ? ` · ${group.off} ausgeschlossen` : ""}`;
      const qty = document.createElement("b");
      qty.className = "mass-count";
      qty.textContent = `${group.count}×`;
      row.append(thumb, info, qty);
      return row;
    }));
    const total = found.filter((card) => card.included).length;
    $("mass-take").hidden = !found.length;
    $("mass-take").disabled = !total;
    $("mass-take").textContent = `${total} Karte${total === 1 ? "" : "n"} in die Liste übernehmen`;
  }

  // ---- live camera ---------------------------------------------------------------------------
  //
  // Frames are read one after the other (the next as soon as the worker is free); LiveTracker
  // combines them. The list below shows the confirmed cards so far; "Fertig" stops the camera and
  // leaves the list to be taken over like the result of a photo.

  let live = null; // { gen, stream, tracker }
  let liveGen = 0;
  const video = $("mass-video");

  async function startLive() {
    stopLive();
    const gen = ++liveGen;
    const current = () => gen === liveGen;
    const status = $("mass-status");
    found = [];
    render(null);
    $("mass-live").hidden = false;
    $("mass-live-start").disabled = true;
    status.textContent = "Starte Kamera …";
    try {
      const loading = start();
      let lens = null;
      try { lens = localStorage.getItem(LENS_KEY); } catch {}
      // As large as the camera allows: the numbers are small in a picture of the whole table.
      const size = { width: { ideal: 3840 }, height: { ideal: 2160 } };
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: lens ? { deviceId: { exact: lens }, ...size } : { facingMode: { ideal: "environment" }, ...size } });
      } catch (error) {
        if (!lens) throw error;
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, ...size } });
      }
      if (!current()) return stream.getTracks().forEach((t) => t.stop());
      const { LiveTracker } = await import("./mass-live.js");
      live = { gen, stream, tracker: new LiveTracker() };
      const track = stream.getVideoTracks()[0];
      if ((track.getCapabilities?.().focusMode ?? []).includes("continuous")) {
        await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
      }
      video.srcObject = stream;
      await video.play();
      status.textContent = "Lade Erkennung …";
      await loading;
      if (!current()) return;
      liveLoop(gen);
    } catch (error) {
      if (!current()) return;
      console.error(error);
      stopLive();
      status.textContent = `Kamera nicht verfügbar: ${error.message}`;
    }
  }

  async function liveLoop(gen) {
    const status = $("mass-status");
    let errors = 0;
    while (gen === liveGen && live) {
      try {
        if (!video.videoWidth) { await new Promise((r) => setTimeout(r, 100)); continue; }
        const frame = await createImageBitmap(video);
        const { width, height } = frame;
        const { cards, ms } = await call({ type: "read", photo: frame }, [frame]);
        if (gen !== liveGen || !live) return;
        const reads = live.tracker.add(cards);
        drawLive(reads, width, height);
        const result = live.tracker.result();
        found = result.cards.flatMap(({ cardNo, count }) => {
          const variant = variantOf(cardNo);
          return variant ? Array.from({ length: count }, () => ({ cardNo, variant, included: true })) : [];
        });
        render(null);
        $("mass-take").hidden = true;
        status.textContent = `${found.length} Karten sicher erkannt` +
          (result.unconfirmed ? `, ${result.unconfirmed} erst einmal gesehen` : "") +
          `. Bild ${result.frames} (${width} × ${height}, ${(ms / 1000).toFixed(1)} s). Langsam über alle Spalten schwenken, dann Fertig.`;
        errors = 0;
      } catch (error) {
        console.error(error);
        if (++errors >= 3) {
          stopLive();
          status.textContent = `Fehler: ${error.message}`;
          return;
        }
      }
    }
  }

  // Frames of the reads of the current frame on the video: green = confirmed, yellow = seen once.
  function drawLive(reads, width, height) {
    const svg = $("mass-live-overlay");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const line = Math.max(3, width / 400);
    svg.replaceChildren(...reads.map((r) => {
      const group = document.createElementNS(SVG, "g");
      if (r.confirmed) group.classList.add("confirmed");
      const polygon = document.createElementNS(SVG, "polygon");
      polygon.setAttribute("points", r.quad.map(([x, y]) => `${x},${y}`).join(" "));
      polygon.setAttribute("stroke-width", line);
      const h = Math.hypot(r.quad[3][0] - r.quad[0][0], r.quad[3][1] - r.quad[0][1]);
      const label = document.createElementNS(SVG, "text");
      label.setAttribute("x", Math.min(...r.quad.map((p) => p[0])) - h * 0.6);
      label.setAttribute("y", r.quad.reduce((s, p) => s + p[1], 0) / 4 + h * 0.4);
      label.setAttribute("font-size", h * 1.4);
      label.setAttribute("text-anchor", "end");
      label.textContent = r.label;
      group.append(polygon, label);
      return group;
    }));
  }

  function stopLive() {
    liveGen++;
    live?.stream.getTracks().forEach((t) => t.stop());
    live = null;
    video.srcObject = null;
    $("mass-live-overlay").replaceChildren();
    $("mass-live").hidden = true;
    $("mass-live-start").disabled = false;
  }

  $("mass-live-start").addEventListener("click", startLive);
  $("mass-live-done").addEventListener("click", () => {
    const result = live?.tracker.result();
    stopLive();
    render(null);
    $("mass-status").textContent = found.length
      ? `${found.length} Karten erkannt (${result?.frames ?? 0} Bilder). Fehlende Karten bitte einzeln scannen.`
      : "Keine Karte sicher erkannt.";
  });
  $("mass-live-cancel").addEventListener("click", () => {
    stopLive();
    found = [];
    render(null);
    $("mass-status").textContent = "";
  });
  // The camera only runs in this view and while the app is visible.
  const leave = () => { if (live && location.hash !== "#masse") stopLive(); };
  window.addEventListener("hashchange", leave);
  window.addEventListener("popstate", leave);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && live) {
      stopLive();
      $("mass-status").textContent = "Kamera gestoppt (App im Hintergrund). Die bisher erkannten Karten stehen unten.";
      render(null);
    }
  });

  $("mass-zoom").addEventListener("click", () => {
    $("mass-photo").classList.toggle("zoomed");
    render();
  });
  $("mass-camera").addEventListener("change", (event) => { read(event.target.files[0]); event.target.value = ""; });
  $("mass-file").addEventListener("change", (event) => { read(event.target.files[0]); event.target.value = ""; });
  $("mass-take").addEventListener("click", () => {
    const cards = found.filter((card) => card.included);
    for (const card of cards) collection.add(card.variant, 1, { unsure: variantCount.get(card.cardNo) > 1 });
    toast(`${cards.length} Karten übernommen`);
    found = [];
    size = null;
    render(null);
    $("mass-status").textContent = "Übernommen. Nächstes Foto?";
  });

  return { start };
}
