// The list of scanned cards: kept in localStorage so a reload or an app switch loses nothing.

const STORAGE_KEY = "gcg-scanner-collection-v1";

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
    const lines = ["Card No,Owned,Wanted,Trading,Tags"];
    const sorted = [...this.entries.values()].sort((a, b) => a.variant.id.localeCompare(b.variant.id));
    for (const { variant, count } of sorted) lines.push(`${variant.id},${count},0,0,`);
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
