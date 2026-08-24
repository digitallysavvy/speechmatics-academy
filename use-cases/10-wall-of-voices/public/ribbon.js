/**
 * ribbon.js: the language-composition ribbon along the bottom of the wall.
 *
 * A 100% stacked bar of the session's language mix, sized from VoiceWall.stats(). The
 * wall answers "who just spoke"; the ribbon answers what the room has been in aggregate.
 *
 * styles.css owns every pixel. The one inline style write is `seg.style.flexGrow = words`
 * in #buildSegment, and that is DATA, not design: a segment's width IS its share, a figure
 * that only exists at runtime. main.js owns #legend; this module builds no second one.
 *
 * A chart binds harder than the wall. A tile may reuse a hue because it is captioned with
 * its language name; two segments in one hue are simply a lie about the data. So the
 * ribbon spends at most 8 hues, refuses any language whose palette slot a higher-ranked
 * segment already claimed, and folds the tail into one achromatic "Other", which also
 * keeps each segment's hue matching that language's colour on the wall. The light theme's
 * contrast WARN on three slots is discharged by #legend and the hidden table below.
 *
 * Recessive by construction: a thin bar, no axis, no gridlines, no number on any segment.
 */

/** Hue budget. Slot 9 onward is not a new colour, it is "Other". */
const MAX_HUES = 8;

/** How many folded language names the "Other" tooltip spells out before "+N more". */
const MAX_OTHER_NAMED = 6;

/** Sub-1% shares are shown as "<1%" rather than rounded to a flat 0%, which reads as absent. */
function formatShare(count, total) {
  if (!total) return '0%';
  const pct = (count / total) * 100;
  if (pct > 0 && pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

export class CompositionRibbon {
  #root;
  #palette;
  #languages;
  #track;
  #table;
  #tableWrap;
  #empty;

  /**
   * @param {HTMLElement} rootEl  #ribbon (class .ribbon), empty in index.html
   * @param {{ palette: object, languages: Map<string, {code: string, name: string, nativeName: string, dir: 'ltr'|'rtl'}> }} deps
   */
  constructor(rootEl, { palette, languages } = {}) {
    if (!rootEl) throw new Error('CompositionRibbon requires a root element');
    if (!palette) throw new Error('CompositionRibbon requires a palette');

    this.#root = rootEl;
    this.#palette = palette;
    // Same contract as VoiceWall: a Map, not a lookup function.
    if (!(languages instanceof Map) && typeof console !== 'undefined') {
      console.error(
        'CompositionRibbon: expected `languages` to be a Map<code, {code, name, nativeName, dir}>, ' +
          `got ${typeof languages}. Segments will be labelled with raw ISO codes.`,
      );
    }
    this.#languages = languages instanceof Map ? languages : new Map();

    this.#track = document.createElement('div');
    this.#track.className = 'ribbon__track';
    // role=img on the TRACK alone: an image swallows its own subtree, so putting it on
    // #ribbon would hide the data table below from the assistive tech it exists for.
    this.#track.setAttribute('role', 'img');

    this.#empty = document.createElement('div');
    this.#empty.className = 'ribbon__empty';
    this.#empty.textContent = 'Waiting for the first voice';

    // The table is WRAPPED rather than given .sr-only itself: a table box sizes to its
    // own content and ignores the 1px the visually-hidden rule asks for, so it would go
    // on inflating scrollHeight. A plain block wrapper obeys the rule.
    this.#tableWrap = document.createElement('div');
    this.#tableWrap.className = 'sr-only';
    this.#table = document.createElement('table');
    this.#tableWrap.appendChild(this.#table);

    rootEl.append(this.#track, this.#empty, this.#tableWrap);
    this.reset();
  }

  /**
   * @param {{ utterances: number, languages: Array<{code: string, count: number}> }} stats
   * Takes VoiceWall.stats() unchanged.
   */
  update(stats) {
    const raw = Array.isArray(stats?.languages) ? stats.languages : [];
    const entries = raw
      .filter((entry) => entry && typeof entry.code === 'string' && entry.count > 0)
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

    const total = entries.reduce((sum, entry) => sum + entry.count, 0);
    if (total === 0) {
      this.reset();
      return;
    }

    this.#empty.hidden = true;
    const segments = this.#allocate(entries);

    this.#track.textContent = '';
    this.#table.textContent = '';

    for (const segment of segments) {
      this.#track.appendChild(this.#buildSegment(segment, formatShare(segment.count, total)));
    }

    this.#track.setAttribute(
      'aria-label',
      `Language mix across ${entries.length} ${entries.length === 1 ? 'language' : 'languages'}: ` +
        segments.map((s) => `${s.label} ${formatShare(s.count, total)}`).join(', '),
    );
    this.#buildTable(segments, total);
  }

  reset() {
    this.#track.textContent = '';
    this.#table.textContent = '';
    this.#empty.hidden = false;

    // An empty track keeps its height, so the footer does not jump on the first voice.
    const placeholder = document.createElement('div');
    placeholder.className = 'ribbon__seg ribbon__seg--empty';
    const fill = document.createElement('span');
    fill.className = 'ribbon__fill';
    placeholder.appendChild(fill);
    this.#track.appendChild(placeholder);
    this.#track.setAttribute('aria-label', 'Language mix: no languages heard yet');
  }

  /* ---------------------------------------------------------------- internals */

  /** Single funnel for every colour decision here. Returns a slot INDEX (0-based) or null. */
  #slotFor(code) {
    if (!code) return null;
    return this.#palette.slotFor(code);
  }

  #nameFor(code) {
    return this.#languages.get(code)?.name ?? code;
  }

  /**
   * Rank-ordered hue allocation. A language gets its own segment only while fewer than 8
   * hues are spent AND its palette slot is not already on the chart. The second
   * condition is what makes the wall's slot cycling safe here. Everything else folds into
   * "Other". Slots are compared as numbers, never as colours.
   */
  #allocate(entries) {
    const hued = [];
    const folded = [];
    const claimed = new Set();

    for (const entry of entries) {
      const slot = this.#slotFor(entry.code);
      if (hued.length < MAX_HUES && slot !== null && !claimed.has(slot)) {
        claimed.add(slot);
        hued.push({
          key: entry.code,
          label: this.#nameFor(entry.code),
          native: this.#languages.get(entry.code)?.nativeName ?? '',
          count: entry.count,
          series: String(slot + 1),
          folded: null,
        });
      } else {
        folded.push(entry);
      }
    }

    if (folded.length > 0) {
      // "Other" sits last regardless of size: it is a remainder, not a rank.
      hued.push({
        key: '__other__',
        label: `Other (${folded.length} ${folded.length === 1 ? 'language' : 'languages'})`,
        native: '',
        count: folded.reduce((sum, entry) => sum + entry.count, 0),
        series: null,
        folded,
      });
    }

    return hued;
  }

  #buildSegment(segment, share) {
    const el = document.createElement('div');
    el.className = segment.series ? 'ribbon__seg' : 'ribbon__seg ribbon__seg--other';
    if (segment.series) el.dataset.series = segment.series;
    el.style.flexGrow = String(segment.count);

    // Not focusable, and not aria-hidden either: everything inside a role="img" is
    // presentational, so a focusable segment would be a tab stop that announces nothing.
    // The track's aria-label and the table carry the numbers; the tooltip is a pointer
    // affordance on top. Value leads, label follows.
    let tip = `${share}  ${segment.label}`;
    if (segment.native && segment.native !== segment.label) tip += ` (${segment.native})`;
    if (segment.folded) {
      const named = segment.folded.slice(0, MAX_OTHER_NAMED).map((entry) => this.#nameFor(entry.code));
      const extra = segment.folded.length - named.length;
      tip += `: ${named.join(', ')}${extra > 0 ? `, +${extra} more` : ''}`;
    }
    // CSS renders this via content: attr(data-tip), which inserts TEXT and never parses
    // markup, so a language name off the wire cannot inject anything here.
    el.setAttribute('data-tip', tip);

    const fill = document.createElement('span');
    fill.className = 'ribbon__fill';
    el.appendChild(fill);

    return el;
  }

  /** Invisible on the projector, reachable by assistive tech, and the relief for the light-mode contrast warning. */
  #buildTable(segments, total) {
    const caption = document.createElement('caption');
    caption.textContent = 'Language mix by words transcribed';
    this.#table.appendChild(caption);

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const heading of ['Language', 'Words', 'Share']) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = heading;
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    this.#table.appendChild(head);

    const body = document.createElement('tbody');
    for (const segment of segments) {
      const row = document.createElement('tr');
      for (const value of [segment.label, String(segment.count), formatShare(segment.count, total)]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
    this.#table.appendChild(body);
  }
}
