/**
 * One stable colour slot per language, claimed the first time it is heard.
 *
 * First-heard order IS the assignment: ordering by anything that changes as a session grows
 * (frequency, recency, rank) would repaint words the audience is already reading. Slots are
 * NUMBERS: styles.css owns the eight CVD-validated `--series-N` hexes and resolves a
 * `data-series` attribute to one. Wrapping past eight is safe because identity is never
 * colour-alone: a repeated hue costs a grouping cue, never a meaning.
 *
 * A slot means "needs a colour", NOT "counts as a language": the live line claims slots for
 * languages that may never commit a word, so the counter and legend read wall.stats().
 */

/** Must match the number of `--series-N` tokens in styles.css, or a slot has no colour. */
const SLOT_COUNT = 8;

/** An empty code is malformed, not a new language: still painted, but it claims no slot. */
const UNKNOWN_SLOT = SLOT_COUNT - 1;

/** Stops `ar` and `AR` becoming two entries. */
function normalise(code) {
  return typeof code === 'string' ? code.trim().toLowerCase() : '';
}

export class LanguagePalette {
  #slots;
  #order;

  constructor() {
    this.reset();
  }

  /** Slot 0..7 for this ISO code, claiming the next one if new. Stable for the session. */
  slotFor(code) {
    const key = normalise(code);
    if (!key) return UNKNOWN_SLOT;

    const claimed = this.#slots.get(key);
    if (claimed !== undefined) return claimed;

    const slot = this.#order.length % SLOT_COUNT;
    this.#slots.set(key, slot);
    this.#order.push(key);
    return slot;
  }

  /** First-heard order. A copy: sorting the live array in place would repaint the wall. */
  seen() {
    return [...this.#order];
  }


  reset() {
    this.#slots = new Map();
    this.#order = [];
  }
}
