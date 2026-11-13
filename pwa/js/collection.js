// The list of scanned cards: kept in localStorage so a reload or an app switch loses nothing.

const STORAGE_KEY = "gcg-scanner-collection-v1";

// Export formats of the list (Collection.export()), in the order of the selection in the list view.
export const EXPORT_FORMATS = [
  { id: "exburst", name: "ExBurst CSV", label: "ExBurst CSV", hint: "jetzt ExBurst öffnen und beim Import einfügen" },
  { id: "simple", name: "Einfach", label: "Einfach (2x GD06-004)" },
  { id: "limitless", name: "Limitless", label: "Limitless (2 Name GD06-004)" },
  { id: "names", name: "Nur Namen", label: "Nur Namen (2x Name)" },
  { id: "msa", name: "MSA Shuffle Fixer", label: "MSA Shuffle Fixer (by captsetitoff)" },
  { id: "tts", name: "Tabletop Simulator", label: "Tabletop Simulator" },
];

export class Collection {
  // index: the reference index (for looking up variants by ExBurst id)
  constructor(index) {
    this.index = index;
    // ExBurst id -> { variant, count, checked, unsure }, in scan order. unsure: added by the mass scan,
    // which reads only the card number, so the variant still has to be picked.
    this.entries = new Map();
    this.listeners = new Set();
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"); } catch {}
    for (const { id, count, checked, unsure } of saved) {
      const row = index.byId.get(id);
      // Ids that are gone after a database update are dropped instead of exporting unknown cards.
      if (row !== undefined && count > 0) this.entries.set(id, { variant: index.variants[row], count, checked: !!checked, unsure: !!unsure });
    }
  }

  get total() {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.count;
    return total;
  }

  add(variant, delta = 1, { unsure = false } = {}) {
    const entry = this.entries.get(variant.id) ?? { variant, count: 0, checked: false, unsure: false };
    if (unsure) entry.unsure = true;
    entry.count += delta;
    if (entry.count <= 0) this.entries.delete(variant.id);
    else this.entries.set(variant.id, entry);
    this.changed();
    return entry.count;
  }

  // Swaps an entry to another variant of the same card (merging if that one is already in the list).
  // The user picked it, so it no longer needs checking.
  replace(fromId, variant) {
    const from = this.entries.get(fromId);
    if (!from) return;
    if (fromId === variant.id) {
      from.checked = true;
    } else {
      const target = this.entries.get(variant.id);
      if (target) {
        target.count += from.count;
        target.checked = true;
        this.entries.delete(fromId);
      } else {
        // Rebuild the map so the swapped entry keeps its place in scan order.
        this.entries = new Map([...this.entries].map(([id, entry]) =>
          id === fromId ? [variant.id, { variant, count: entry.count, checked: true, unsure: false }] : [id, entry]));
      }
    }
    this.changed();
  }

  clear() {
    this.entries.clear();
    this.changed();
  }

  // ExBurst collection import format.
  csv() {
    return this.export("exburst");
  }

  // The list as text in one of EXPORT_FORMATS, sorted by card number (ExBurst ids, e.g. GD06-002-ALT1).
  export(format) {
    const sorted = [...this.entries.values()].sort((a, b) => a.variant.id.localeCompare(b.variant.id));
    const lines = [];
    switch (format) {
      case "simple":
        for (const { variant, count } of sorted) lines.push(`${count}x ${variant.id}`);
        break;
      case "limitless":
        for (const { variant, count } of sorted) lines.push(`${count} ${variant.name} ${variant.id}`);
        break;
      case "names": {
        // Variants of one card (alt arts) share the name: one line per name.
        const byName = new Map();
        for (const { variant, count } of sorted) byName.set(variant.name, (byName.get(variant.name) ?? 0) + count);
        for (const [name, count] of byName) lines.push(`${count}x ${name}`);
        break;
      }
      case "msa": {
        // msafixer.com: one line per copy, in random order; alternate arts as their base card.
        const copies = [];
        for (const { variant, count } of sorted) for (let k = 0; k < count; k++) copies.push(`1 ${variant.cardNo}`);
        for (let i = copies.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [copies[i], copies[j]] = [copies[j], copies[i]];
        }
        lines.push(...copies);
        break;
      }
      case "tts": {
        // Tabletop Simulator deck list; alternate arts counted with their base card.
        lines.push("// Main Deck");
        const byCard = new Map();
        for (const { variant, count } of sorted) {
          const card = byCard.get(variant.cardNo) ?? { name: variant.name, count: 0 };
          card.count += count;
          byCard.set(variant.cardNo, card);
        }
        for (const [cardNo, { name, count }] of [...byCard].sort(([a], [b]) => a.localeCompare(b))) lines.push(`${count} x ${cardNo} ${name}`);
        break;
      }
      default:
        lines.push("Card No,Owned,Wanted,Trading,Tags");
        for (const { variant, count } of sorted) lines.push(`${variant.id},${count},0,0,`);
    }
    return lines.join("\n") + "\n";
  }

  onChange(listener) {
    this.listeners.add(listener);
  }

  changed() {
    const saved = [...this.entries.values()].map(({ variant, count, checked, unsure }) => ({ id: variant.id, count, checked, unsure }));
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch {}
    for (const listener of this.listeners) listener();
  }
}
