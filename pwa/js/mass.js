// Mass scan view (#masse): one photo of cards lying in columns, each covering the one above except
// for its top strip. The worker finds and reads the card numbers in the top right corners; the
// photo is shown with a frame on every read card (tap to leave a card out), the cards below it,
// and one button adds them all to the list. The variant is not known from the number alone, so
// cards with several variants are marked "Variante prüfen" in the list.

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
const LENS_KEY = "gcg-scanner-lens"; // the lens chosen in the single-card scanner (app.js)
const SORT_KEY = "gcg-scanner-mass-sort";
const SORTS = ["az", "za", "columns-rl", "columns-lr"];

// Where a read row lies: centre, text height and reading direction (unit vector along the text; the
// quad runs along the picture, flip: the card lies upside down).
function placeOf(quad, flip) {
  const pos = [quad.reduce((s, p) => s + p[0], 0) / 4, quad.reduce((s, p) => s + p[1], 0) / 4];
  const h = Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]);
  const dx = quad[1][0] - quad[0][0], dy = quad[1][1] - quad[0][1], n = (Math.hypot(dx, dy) || 1) * (flip ? -1 : 1);
  return { pos, h, u: [dx / n, dy / n] };
}

// Cards into columns as they lie on the table: [[card, …] per column], each column top to bottom,
// the columns left to right (or right to left). "Top" and "left" as seen on the cards (the photo may
// be turned): axes from the mean reading direction. Cards without a place come last, alphabetically.
// Live cards of different epochs (camera motion lost in between) have no common axes: one after the
// other.
export function columnsOf(cards, rightToLeft = false) {
  const out = [];
  const epochs = new Map();
  for (const card of cards) {
    if (!card.place) continue;
    const key = card.place.epoch ?? 0;
    if (!epochs.has(key)) epochs.set(key, []);
    epochs.get(key).push(card);
  }
  for (const key of [...epochs.keys()].sort((a, b) => a - b)) {
    const members = epochs.get(key);
    let ux = 0, uy = 0;
    for (const c of members) { ux += c.place.u[0]; uy += c.place.u[1]; }
    const n = Math.hypot(ux, uy) || 1;
    const u = [ux / n, uy / n], down = [-u[1], u[0]]; // across the cards (to the right), along them (down)
    const items = members.map((card) => ({
      card,
      s: card.place.pos[0] * u[0] + card.place.pos[1] * u[1],
      t: card.place.pos[0] * down[0] + card.place.pos[1] * down[1],
    })).sort((a, b) => a.s - b.s);
    // A new column where the next number lies far to the side (columns lie about a card width apart,
    // ~40 text heights; the cards of one column are a little out of line, and a column may lean).
    const h = members.map((c) => c.place.h).sort((a, b) => a - b)[Math.floor(members.length / 2)];
    const columns = [];
    let last = -Infinity;
    for (const item of items) {
      if (item.s - last > 10 * h) columns.push([]);
      columns.at(-1).push(item);
      last = item.s;
    }
    if (rightToLeft) columns.reverse();
    for (const column of columns) out.push(column.sort((a, b) => a.t - b.t).map((item) => item.card));
  }
  const rest = cards.filter((card) => !card.place).sort((a, b) => a.cardNo.localeCompare(b.cardNo));
  if (rest.length) out.push(rest);
  return out;
}

export function setupMass({ index, collection, cardImage, toast }) {
  let worker = null, ready = null, nextId = 0;
  const pending = new Map();
  let photoUrl = null;
  let found = []; // [{ quad, cardNo, variant, included, place: { pos, h, u, epoch } }]
  let sort = "az";
  try { if (SORTS.includes(localStorage.getItem(SORT_KEY))) sort = localStorage.getItem(SORT_KEY); } catch {}
  $("mass-sort").value = sort;

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
      found = cards.map((card) => ({ ...card, variant: variantOf(card.cardNo), included: true, place: placeOf(card.quad, card.flip) }))
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

    // Cards below the photo: alphabetically grouped by number, or in columns as they lie on the table
    // (one row per card; copies lying one after the other in a column as one row).
    const row = (cardNo, variant, count, off) => {
      const row = document.createElement("div");
      row.className = "item" + (count ? "" : " off");
      const thumb = document.createElement("div");
      thumb.className = "thumb";
      thumb.append(cardImage(variant));
      const info = document.createElement("div");
      info.className = "info";
      info.innerHTML = "<b></b><small></small>";
      info.querySelector("b").textContent = variant.name;
      const several = variantCount.get(cardNo) > 1 ? " · Variante später prüfen" : "";
      info.querySelector("small").textContent = `${cardNo}${several}${off ? ` · ${off} ausgeschlossen` : ""}`;
      const qty = document.createElement("b");
      qty.className = "mass-count";
      qty.textContent = `${count}×`;
      row.append(thumb, info, qty);
      return row;
    };
    const rows = [];
    if (sort.startsWith("columns")) {
      columnsOf(found, sort === "columns-rl").forEach((column, i) => {
        const head = document.createElement("div");
        head.className = "mass-column";
        head.textContent = `${column[0].place ? `Spalte ${i + 1}` : "Ohne Lage"} · ${column.length} Karte${column.length === 1 ? "" : "n"}`;
        rows.push(head);
        for (let j = 0; j < column.length;) {
          let k = j;
          while (k < column.length && column[k].cardNo === column[j].cardNo && column[k].included === column[j].included) k++;
          const { cardNo, variant, included } = column[j];
          rows.push(included ? row(cardNo, variant, k - j, 0) : row(cardNo, variant, 0, k - j));
          j = k;
        }
      });
    } else {
      const groups = new Map();
      for (const card of found) {
        const group = groups.get(card.cardNo) ?? { variant: card.variant, count: 0, off: 0 };
        if (card.included) group.count++;
        else group.off++;
        groups.set(card.cardNo, group);
      }
      const sign = sort === "za" ? -1 : 1;
      for (const [cardNo, group] of [...groups.entries()].sort(([a], [b]) => sign * a.localeCompare(b))) {
        rows.push(row(cardNo, group.variant, group.count, group.off));
      }
    }
    $("mass-items").replaceChildren(...rows);
    $("mass-tools").hidden = !found.length;
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
        found = result.cards.flatMap(({ cardNo, count, places }) => {
          const variant = variantOf(cardNo);
          // More copies than places (seen together in one frame): the extra ones at the last place.
          return variant ? Array.from({ length: count }, (_, i) => ({ cardNo, variant, included: true, place: places[Math.min(i, places.length - 1)] })) : [];
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

  $("mass-sort").addEventListener("change", () => {
    sort = $("mass-sort").value;
    try { localStorage.setItem(SORT_KEY, sort); } catch {}
    render();
  });
  // Empties this list and the photo (not the list of recognised cards). While the live camera runs,
  // counting starts again.
  $("mass-clear").addEventListener("click", async () => {
    if (!found.length || !confirm(`Alle ${found.length} Karten aus dem Massenscan löschen? „Erkannte Karten“ bleibt unverändert.`)) return;
    if (live) {
      const { LiveTracker } = await import("./mass-live.js");
      if (live) live.tracker = new LiveTracker();
    }
    found = [];
    size = null;
    render(null);
    $("mass-status").textContent = live ? "Liste geleert, zählt neu." : "Liste geleert.";
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
