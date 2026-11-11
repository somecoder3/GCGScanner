// Mass scan: finds the card-number corners in a photo and reads them (dev/mass-eval.html measures it).
// Step 1 of the plan only builds the test photos and the measurement, so this is still a placeholder
// that finds nothing. Steps 2 and 3 fill it in (find the corners, read the number, match it against
// the known card numbers).

export const METHOD = "Platzhalter (findet noch nichts)";

// bitmap: the photo. context: { cv, cardNumbers: Set of all card numbers }.
// Returns [{ quad: [[x, y] × 4] in photo pixels, text: raw reading, cardNo: matched number or null }].
export async function readCorners(bitmap, context) {
  return [];
}
