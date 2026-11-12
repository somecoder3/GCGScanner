// Mass scan with the live camera: the reads of many frames (each from mass-read.js) are combined.
//
// Every read card number is a track: a place on the table that follows the camera from frame to frame.
// The camera motion between two frames comes from numbers read in both (see robustMotion()); then
// every read is matched to the nearest track near its expected place and votes for its number there. A track's number is the one with most votes, so a single misread
// (089 read as 109 once) does not count, and only tracks with at least `minVotes` votes are taken
// (single reads in the texture of a play mat are dropped).
//
// Counting: a number counts once per confirmed track at its own place (copies of one card lying apart),
// and at least as often as it was read at the same time in one frame. When no number of the last
// frames is in view, the camera motion is unknown: a new epoch starts, and places are only compared
// within an epoch (the most copies in one epoch count).

export const LIVE_DEFAULTS = {
  minVotes: 2, // a track needs this many reads to count
  matchRadius: 1.6, // a read belongs to a track within this many row heights of its expected place
  pairRadius: 40, // camera shift: same-number pairs within this many row heights (the camera may move far between two reads)
  stale: 2, // a track not seen for more than this many frames may be taken over by a read of its number
  sameCard: 2.5, // confirmed tracks of one number closer than this many row heights are one card
  inlier: 1, // a pair agrees with a camera motion within this many row heights
};

const centreOf = (quad) => [quad.reduce((s, p) => s + p[0], 0) / 4, quad.reduce((s, p) => s + p[1], 0) / 4];
const heightOf = (quad) => Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]);
// Reading direction of a number row (unit vector along the text; the quad runs along the picture,
// flip: the card lies upside down).
const dirOf = (quad, flip) => { const dx = quad[1][0] - quad[0][0], dy = quad[1][1] - quad[0][1], n = (Math.hypot(dx, dy) || 1) * (flip ? -1 : 1); return [dx / n, dy / n]; };
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

export class LiveTracker {
  constructor(options = {}) {
    this.o = { ...LIVE_DEFAULTS, ...options };
    this.tracks = []; // { id, pos: [x, y] in the current frame, h, votes: Map cardNo → n, lastFrame }
    this.frames = []; // per frame: track ids of its reads
    this.frame = 0;
    this.epoch = 0; // a new epoch when the camera motion is lost (see add())
  }

  // reads: [{ cardNo, quad }] of one frame (in frame pixels). Returns the reads with their track:
  // [{ ...read, track, label, confirmed }].
  add(reads) {
    const o = this.o;
    const frame = ++this.frame;
    const items = reads.filter((r) => r.cardNo).map((r) => ({ read: r, pos: centreOf(r.quad), h: heightOf(r.quad), u: dirOf(r.quad, r.flip) }));
    // All tracks of the epoch follow the camera, also those out of view: a card coming back into view
    // meets its track again, and copies of one number stay apart.
    let active = this.tracks.filter((t) => t.epoch === this.epoch);
    // Camera motion from same-number pairs (every read with every track of its number, so copies of
    // one card pair up too): shift, turn and scale, estimated robustly (RANSAC): every two pairs give a
    // motion, the one that most pairs agree with wins and is refitted on those (least squares).
    const pairs = [];
    for (const item of items) {
      for (const t of active) {
        if (labelOf(t) !== item.read.cardNo) continue;
        if (Math.hypot(item.pos[0] - t.pos[0], item.pos[1] - t.pos[1]) < o.pairRadius * item.h) pairs.push({ from: t.pos, to: item.pos, h: item.h, item, t });
      }
    }
    const move = robustMotion(pairs, o.inlier);
    if (move) for (const t of active) t.pos = move(t.pos);
    else if (items.length && active.length) {
      // Nothing read before is in view (a quick sweep, or new columns): where the old tracks are now
      // is unknown. They keep their votes but are not matched any more.
      this.epoch++;
      active = [];
    }

    // Nearest free track within the radius (cheapest reads first), else a new track.
    const taken = new Set();
    const ids = [];
    const out = [];
    for (const item of [...items].sort((a, b) => (a.read.cost ?? 0) - (b.read.cost ?? 0))) {
      let best = null, dist = Infinity;
      for (const t of active) {
        if (taken.has(t)) continue;
        const d = Math.hypot(item.pos[0] - t.pos[0], item.pos[1] - t.pos[1]);
        if (d < dist && d < o.matchRadius * Math.max(item.h, t.h)) { best = t; dist = d; }
      }
      if (!best) {
        // Not where a track is expected: the card may be one seen before whose track drifted while it
        // was out of view (the motion estimates add up). A track of this number not seen for a few
        // frames is taken over; a second track (a second copy) only starts while the other copy is
        // in view.
        let stale = null;
        for (const t of active) {
          if (taken.has(t) || labelOf(t) !== item.read.cardNo || frame - t.lastFrame <= o.stale) continue;
          const d = Math.hypot(item.pos[0] - t.pos[0], item.pos[1] - t.pos[1]);
          if (!stale || d < stale.d) stale = { t, d };
        }
        best = stale?.t ?? null;
      }
      if (!best) {
        best = { id: this.tracks.length, pos: item.pos, h: item.h, u: item.u, votes: new Map(), lastFrame: frame, epoch: this.epoch };
        this.tracks.push(best);
        active.push(best);
      }
      taken.add(best);
      best.votes.set(item.read.cardNo, (best.votes.get(item.read.cardNo) ?? 0) + 1);
      best.pos = item.pos;
      best.h = item.h;
      best.u = item.u;
      best.lastFrame = frame;
      ids.push(best.id);
      out.push({ ...item.read, track: best.id });
    }
    this.frames.push(ids);
    return out.map((r) => {
      const t = this.tracks[r.track];
      return { ...r, label: labelOf(t), confirmed: votesOf(t) >= o.minVotes };
    });
  }

  // Cards so far: [{ cardNo, count, votes, places }] (confirmed tracks only) and the number of
  // unconfirmed tracks. count: the confirmed tracks of a number at different places, at least as many
  // as were seen at the same time in one frame. places: [{ pos, h, u, epoch }] of the epoch with the
  // most places of the number (for sorting by columns; positions in the last frame of that epoch).
  result() {
    const confirmed = this.tracks.filter((t) => votesOf(t) >= this.o.minVotes);
    const counts = new Map(), votes = new Map(), places = new Map();
    for (const t of confirmed) {
      const cardNo = labelOf(t);
      votes.set(cardNo, (votes.get(cardNo) ?? 0) + votesOf(t));
      // Places are only comparable within one epoch.
      const key = `${cardNo} ${t.epoch}`;
      const list = places.get(key) ?? [];
      if (!list.some((p) => Math.hypot(p.pos[0] - t.pos[0], p.pos[1] - t.pos[1]) < this.o.sameCard * Math.max(p.h, t.h))) list.push(t);
      places.set(key, list);
    }
    const where = new Map();
    for (const [key, list] of places) {
      const cardNo = key.split(" ")[0];
      counts.set(cardNo, Math.max(counts.get(cardNo) ?? 0, list.length));
      if (list.length > (where.get(cardNo)?.length ?? 0)) where.set(cardNo, list.map((t) => ({ pos: t.pos, h: t.h, u: t.u, epoch: t.epoch })));
    }
    for (const ids of this.frames) {
      const inFrame = new Map();
      for (const id of ids) {
        const t = this.tracks[id];
        if (votesOf(t) < this.o.minVotes) continue;
        inFrame.set(labelOf(t), (inFrame.get(labelOf(t)) ?? 0) + 1);
      }
      for (const [cardNo, n] of inFrame) counts.set(cardNo, Math.max(counts.get(cardNo) ?? 0, n));
    }
    const cards = [...counts].map(([cardNo, count]) => ({ cardNo, count, votes: votes.get(cardNo), places: where.get(cardNo) ?? [] }));
    return { cards, unconfirmed: this.tracks.length - confirmed.length, frames: this.frame };
  }
}

// Best motion for the pairs (see add()), or null without pairs.
function robustMotion(pairs, inlier) {
  if (!pairs.length) return null;
  const agree = (move) => pairs.filter((p) => { const [x, y] = move(p.from); return Math.hypot(x - p.to[0], y - p.to[1]) < inlier * p.h; });
  let best = [];
  // Hypotheses: the shift of every single pair, and the similarity of every two pairs (at most ~600).
  const hypotheses = pairs.map((p) => fitMotion([p]));
  const step = Math.max(1, Math.floor((pairs.length * (pairs.length - 1)) / 2 / 600));
  let k = 0;
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      if (k++ % step) continue;
      if (pairs[i].item === pairs[j].item || pairs[i].t === pairs[j].t) continue;
      hypotheses.push(fitSimilarity([pairs[i], pairs[j]]));
    }
  }
  for (const move of hypotheses) {
    if (!move) continue;
    const inliers = agree(move);
    if (inliers.length > best.length) best = inliers;
  }
  return fitMotion(best) ?? fitMotion(pairs);
}

// Similarity transform from pairs { from, to }: p ↦ s·R·p + t, as a function; null without pairs.
// With fewer than three pairs only the shift (median), which a single misread pair cannot turn.
function fitMotion(pairs) {
  if (!pairs.length) return null;
  if (pairs.length < 3) {
    const dx = median(pairs.map((p) => p.to[0] - p.from[0])), dy = median(pairs.map((p) => p.to[1] - p.from[1]));
    return ([x, y]) => [x + dx, y + dy];
  }
  return fitSimilarity(pairs);
}

// Least-squares similarity (shift, turn, scale) of two or more pairs.
function fitSimilarity(pairs) {
  const n = pairs.length;
  const mf = [0, 0], mt = [0, 0];
  for (const p of pairs) { mf[0] += p.from[0] / n; mf[1] += p.from[1] / n; mt[0] += p.to[0] / n; mt[1] += p.to[1] / n; }
  let a = 0, b = 0, norm = 0;
  for (const p of pairs) {
    const fx = p.from[0] - mf[0], fy = p.from[1] - mf[1], tx = p.to[0] - mt[0], ty = p.to[1] - mt[1];
    a += fx * tx + fy * ty;
    b += fx * ty - fy * tx;
    norm += fx * fx + fy * fy;
  }
  if (norm < 1e-6) return ([x, y]) => [x + mt[0] - mf[0], y + mt[1] - mf[1]];
  a /= norm; b /= norm; // a = s·cos, b = s·sin
  return ([x, y]) => {
    const fx = x - mf[0], fy = y - mf[1];
    return [mt[0] + a * fx - b * fy, mt[1] + b * fx + a * fy];
  };
}

// Number with most votes (ties: the first one voted for).
function labelOf(track) {
  let best = null, n = 0;
  for (const [cardNo, votes] of track.votes) if (votes > n) { best = cardNo; n = votes; }
  return best;
}
const votesOf = (track) => track.votes.get(labelOf(track)) ?? 0;
