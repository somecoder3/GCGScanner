// Encrypted card image packs.
//
// The card pictures belong to Bandai and must not be public, so pwa/images/ only holds encrypted packs
// (one per card number prefix: GD01, ST04, T, ...). The key comes from a passphrase that is stored
// nowhere in the app or repo. After unlocking once, the phone keeps the derived key (non-extractable,
// IndexedDB) and the decrypted images (Cache Storage, served by the service worker under
// images/card/<file>), so later packs arrive automatically and everything works offline.
//
// images/index.json: { format, kdf: { iterations, salt }, check: <encrypted CHECK_TEXT>, packs: [{ name, file, count }] }
// pack file:         12-byte IV + AES-GCM ciphertext of: u32 header length, JSON header [{ f, o, n }], image bytes

const FORMAT = "gcg-images-1";
const CHECK_TEXT = "gcg-scanner image pack key";
export const IMAGE_CACHE = "gcg-card-images-v1";
const PACKS_RECORD = "_packs.json"; // which pack files are already in IMAGE_CACHE
const BASE = new URL("../images/", import.meta.url);

export function cardImageUrl(file) {
  return new URL(`card/${file}`, BASE).href;
}

// ---- Format and crypto (shared with dev/build-images.html) -------------------------------------

export async function deriveKey(passphrase, salt, iterations, extractable = false) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    extractable,
    ["encrypt", "decrypt"],
  );
}

export async function encrypt(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  const out = new Uint8Array(12 + data.length);
  out.set(iv);
  out.set(data, 12);
  return out;
}

export async function decrypt(key, buffer) {
  const bytes = new Uint8Array(buffer);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, key, bytes.subarray(12)));
}

export function makeCheck(key) {
  return encrypt(key, new TextEncoder().encode(CHECK_TEXT)).then(toBase64);
}

export async function keyMatches(key, check) {
  try {
    return new TextDecoder().decode(await decrypt(key, fromBase64(check))) === CHECK_TEXT;
  } catch {
    return false; // AES-GCM authentication fails for a wrong key
  }
}

// entries: [{ file, bytes }] -> one container
export function pack(entries) {
  const header = [];
  let offset = 0;
  for (const { file, bytes } of entries) {
    header.push({ f: file, o: offset, n: bytes.length });
    offset += bytes.length;
  }
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.length + offset);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  let at = 4 + json.length;
  for (const { bytes } of entries) {
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}

export function unpack(bytes) {
  const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
  const start = 4 + length;
  return header.map(({ f, o, n }) => ({ file: f, bytes: bytes.subarray(start + o, start + o + n) }));
}

export const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
export const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export async function fetchManifest() {
  const response = await fetch(new URL("index.json", BASE), { cache: "no-cache" });
  if (!response.ok) return null;
  const manifest = await response.json();
  if (manifest.format !== FORMAT) throw new Error(`Unbekanntes Bildpaket-Format: ${manifest.format}`);
  return manifest;
}

// ---- On the phone: unlock, import, keep up to date ---------------------------------------------

const DB_NAME = "gcg-scanner";
const KEY_STORE = "keys";
const KEY_ID = "image-pack";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(KEY_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function keyStore(mode, action) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = action(db.transaction(KEY_STORE, mode).objectStore(KEY_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function readRecord(cache) {
  const response = await cache.match(cardImageUrl(PACKS_RECORD));
  return response ? response.json() : {};
}

export class ImageStore {
  constructor() {
    this.running = null;
  }

  // The stored key, if this phone was unlocked before (and the passphrase has not changed since).
  async savedKey(manifest) {
    try {
      const key = await keyStore("readonly", (store) => store.get(KEY_ID));
      return key && manifest && (await keyMatches(key, manifest.check)) ? key : null;
    } catch {
      return null;
    }
  }

  async status() {
    const manifest = await fetchManifest().catch(() => null);
    const cache = await caches.open(IMAGE_CACHE);
    const record = await readRecord(cache);
    const count = Object.values(record).reduce((sum, pack) => sum + pack.count, 0);
    const key = await this.savedKey(manifest);
    const pending = manifest ? manifest.packs.filter((p) => record[p.name]?.file !== p.file).length : 0;
    // Offline the manifest is missing, but images imported earlier still show.
    return { available: !!manifest, unlocked: !!key, count, pending };
  }

  // Checks the passphrase, remembers the key and imports all packs.
  async unlock(passphrase, onProgress) {
    const manifest = await fetchManifest();
    if (!manifest) throw new Error("Keine Bildpakete gefunden.");
    const key = await deriveKey(passphrase, fromBase64(manifest.kdf.salt), manifest.kdf.iterations);
    if (!(await keyMatches(key, manifest.check))) throw new Error("Falsches Passwort.");
    await keyStore("readwrite", (store) => store.put(key, KEY_ID));
    return this.sync(onProgress, manifest, key);
  }

  // Imports packs that are new or changed since the last import. Runs once at a time.
  sync(onProgress = () => {}, manifest = null, key = null) {
    this.running ??= this.#sync(onProgress, manifest, key).finally(() => (this.running = null));
    return this.running;
  }

  async #sync(onProgress, manifest, key) {
    manifest ??= await fetchManifest();
    if (!manifest) return 0;
    key ??= await this.savedKey(manifest);
    if (!key) return 0;
    const cache = await caches.open(IMAGE_CACHE);
    const record = await readRecord(cache);
    const todo = manifest.packs.filter((p) => record[p.name]?.file !== p.file);
    let imported = 0;
    for (const [i, pack] of todo.entries()) {
      onProgress({ pack: pack.name, done: i, total: todo.length });
      const response = await fetch(new URL(pack.file, BASE), { cache: "no-store" });
      if (!response.ok) throw new Error(`Bildpaket ${pack.name} nicht ladbar (${response.status})`);
      const entries = unpack(await decrypt(key, await response.arrayBuffer()));
      for (const { file, bytes } of entries) {
        await cache.put(cardImageUrl(file), new Response(bytes, { headers: { "Content-Type": "image/webp" } }));
      }
      record[pack.name] = { file: pack.file, count: entries.length };
      await cache.put(cardImageUrl(PACKS_RECORD), Response.json(record));
      imported += entries.length;
    }
    onProgress({ pack: null, done: todo.length, total: todo.length });
    return imported;
  }

  async clear() {
    await caches.delete(IMAGE_CACHE);
    await keyStore("readwrite", (store) => store.delete(KEY_ID)).catch(() => {});
  }
}
