/**
 * wall.js: the Wall of Voices renderer.
 *
 *   commit(words)  -> #wall (.wall), finals frozen into tiles, oldest first.
 *   setLive(words) -> #live-line (.live-line), the in-flight partial, repainted whole.
 *
 * Must not break: #live-line is a SIBLING of #wall or the money moment scrolls away; a
 * tile stays OPEN across finals until the sentence ends and a language change must NEVER
 * close one; nothing waits on Melia, whose finals lag 3-6s. Emits only class names,
 * `data-series` slots, `dir`/`lang` and textContent. README: "One sentence, one tile".
 */

/** Eviction safety net; a 15-speaker demo never reaches it. */
const MAX_BLOCKS = 60;

const MAX_SECONDARY_NAMED = 3;

/** Recency tiers, newest ROW first, clamped at the last. Shared vocabulary with styles.css. */
const TIER_CLASSES = [
  'utterance--tier-0',
  'utterance--tier-1',
  'utterance--tier-2',
  'utterance--tier-3',
];

/** Tiles are one row when their offsetTop matches within this much; sub-pixel tolerance. */
const ROW_EPSILON = 2;

/** Melia sends punctuation as its own result; attaches_to says how it joins. */
function needsSpaceBetween(prev, word) {
  if (!prev) return false;
  const before = word.attachesTo;
  const after = prev.attachesTo;
  if (before === 'previous' || before === 'both') return false;
  if (after === 'next' || after === 'both') return false;
  return true;
}

function isRenderable(word) {
  return Boolean(word) && typeof word.text === 'string' && word.text.length > 0;
}

/** Must be a Map; the empty fallback loses `dir`, so RTL renders LTR. Hence the shout. */
function normaliseLanguages(languages, owner) {
  if (languages instanceof Map) return languages;
  if (typeof console !== 'undefined') {
    console.error(
      `${owner}: expected \`languages\` to be a Map<code, {code, name, nativeName, dir}>, got ` +
        `${typeof languages}. Falling back to an empty map: blocks will be labelled with raw ` +
        'ISO codes and RTL languages will render left-to-right.',
    );
  }
  return new Map();
}

export class VoiceWall {
  #root;
  #live;
  #placeholder;
  #palette;
  #languages;
  #resizeObserver = null;
  #reflowRaf = null;

  /** Oldest-first. Each entry: { el, counts: Map<code, wordCount> }. */
  #blocks = [];

  #counts = new Map();

  /** The tile still accepting finals, or null. See commit() and #endsSentence. */
  #open = null;

  /** Backstop for a speaker who never lands a full stop. No ordinary sentence trips it. */
  #OPEN_WORD_CAP = 60;

  constructor(wallEl, { palette, languages, liveEl } = {}) {
    if (!wallEl) throw new Error('VoiceWall requires a wall element');
    // A build that quietly lost the live line would run perfectly and show nothing.
    if (!liveEl) throw new Error('VoiceWall requires a live-line element');
    if (!palette) throw new Error('VoiceWall requires a palette');

    this.#root = wallEl;
    this.#live = liveEl;
    this.#palette = palette;
    this.#languages = normaliseLanguages(languages, 'VoiceWall');

    this.#placeholder = liveEl.querySelector('.live-line__placeholder');
    this.#clearLive();

    // Everything around the wall resizes it mid-demo, and a width change moves tiles
    // between rows and so between tiers. One observer does both retier and follow. It
    // cannot loop: neither scrollTop nor a tier class resizes #root itself.
    if (typeof ResizeObserver !== 'undefined') {
      this.#resizeObserver = new ResizeObserver(() => this.#scheduleReflow());
      this.#resizeObserver.observe(this.#root);
    }
  }

  /** Paint the in-flight partial. Rebuilt wholesale: a correct repaint beats a diff. */
  setLive(words) {
    const list = (Array.isArray(words) ? words : []).filter(isRenderable);
    if (list.length === 0) {
      this.#clearLive();
      this.#follow();
      return;
    }

    const counts = this.#tally(list);
    const dominant = this.#dominantOf(counts);
    const meta = this.#metaFor(dominant);

    this.#live.textContent = '';
    this.#live.classList.remove('is-empty');
    this.#applyIdentity(this.#live, dominant, meta);
    this.#live.appendChild(this.#buildMeta('live-line', dominant, meta, counts));

    const text = document.createElement('p');
    text.className = 'live-line__text';
    this.#renderWords(text, list, dominant);
    this.#live.appendChild(text);

    // Sibling of the wall, so a partial growing a second line shrinks the wall under it.
    this.#follow();
  }

  /** Freeze a final into the wall. Returns the tile, or null if nothing was renderable. */
  commit(words) {
    const list = (Array.isArray(words) ? words : []).filter(isRenderable);
    // A final IS its partial settled, so clearing now stops one sentence showing twice.
    this.#clearLive();
    if (list.length === 0) return null;

    // Append into the open tile, re-tallied over ALL its words, so a code-switched aside
    // arriving in a later final still colours its own words and still counts.
    if (this.#open) {
      const merged = this.#open.words.concat(list);
      const el = this.#open.el;
      const counts = this.#tally(merged);
      const dominant = this.#dominantOf(counts);
      const meta = this.#metaFor(dominant);

      this.#applyIdentity(el, dominant, meta);
      el.replaceChildren(this.#buildMeta('utterance', dominant, meta, counts));
      const text = document.createElement('p');
      text.className = 'utterance__text';
      this.#renderWords(text, merged, dominant);
      el.appendChild(text);

      // The tally is replaced wholesale, so back the old one out of #counts first.
      for (const [code, n] of this.#open.counts) {
        const left = (this.#counts.get(code) ?? 0) - n;
        if (left > 0) this.#counts.set(code, left);
        else this.#counts.delete(code);
      }
      for (const [code, n] of counts) {
        this.#counts.set(code, (this.#counts.get(code) ?? 0) + n);
      }

      this.#open.words = merged;
      this.#open.counts = counts;
      const block = this.#blocks.find((b) => b.el === el);
      if (block) block.counts = counts;

      if (this.#endsSentence(list) || merged.length >= this.#OPEN_WORD_CAP) this.#open = null;

      // The tile grew and may have spilled onto a new row; retier before following.
      this.#retier();
      this.#follow();
      return el;
    }

    const counts = this.#tally(list);
    const dominant = this.#dominantOf(counts);
    const meta = this.#metaFor(dominant);

    const el = document.createElement('article');
    // Born at tier 0 so a tile is never painted for a frame without a tier class.
    el.className = `utterance utterance--new ${TIER_CLASSES[0]}`;
    this.#applyIdentity(el, dominant, meta);
    el.appendChild(this.#buildMeta('utterance', dominant, meta, counts));

    const text = document.createElement('p');
    text.className = 'utterance__text';
    this.#renderWords(text, list, dominant);
    el.appendChild(text);

    el.addEventListener('animationend', () => el.classList.remove('utterance--new'), { once: true });

    this.#root.appendChild(el);
    this.#blocks.push({ el, counts });
    for (const [code, n] of counts) {
      this.#counts.set(code, (this.#counts.get(code) ?? 0) + n);
    }

    this.#open =
      this.#endsSentence(list) || list.length >= this.#OPEN_WORD_CAP
        ? null
        : { el, words: list, counts };

    this.#evict();
    this.#retier();
    this.#follow();
    return el;
  }

  /**
   * Force the open tile shut; main.js calls it on a handover gap and on stop. NEVER on a
   * language change: "so the point is, това е важното, right?" is one sentence, one tile.
   */
  closeOpen() {
    this.#open = null;
  }

  reset() {
    for (const block of this.#blocks) block.el.remove();
    this.#blocks = [];
    this.#counts.clear();
    this.#open = null;
    if (this.#reflowRaf !== null) {
      cancelAnimationFrame(this.#reflowRaf);
      this.#reflowRaf = null;
    }
    this.#clearLive();
    // The palette is shared with the ribbon, so main.js's resetAll() clears it, not this.
  }

  /**
   * @returns {{ utterances: number, languages: Array<{code: string, count: number}> }}
   * WORDS, from resident blocks only, so a three-word aside mid-sentence still registers.
   */
  stats() {
    const languages = [...this.#counts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
    return { utterances: this.#blocks.length, languages };
  }

  /**
   * A SLOT NUMBER for `data-series`, never a colour. The empty-code guard is load-bearing:
   * slotFor('') returns a real slot, painting an untagged word as a phantom code-switch.
   */
  #seriesFor(code) {
    if (!code) return '';
    return String(this.#palette.slotFor(code) + 1);
  }

  #metaFor(code) {
    if (!code) return null;
    return this.#languages.get(code) ?? null;
  }

  /** dir/lang/slot for a surface. The `dir` line is the entire RTL story, no language list. */
  #applyIdentity(el, dominant, meta) {
    el.dir = meta?.dir === 'rtl' ? 'rtl' : 'ltr';

    const series = this.#seriesFor(dominant);
    if (series) el.dataset.series = series;
    else el.removeAttribute('data-series');

    if (dominant) el.lang = dominant;
    else el.removeAttribute('lang');
  }

  #clearLive() {
    this.#live.textContent = '';
    this.#live.classList.add('is-empty');
    this.#live.removeAttribute('data-series');
    this.#live.removeAttribute('lang');
    this.#live.dir = 'auto';
    if (this.#placeholder) this.#live.appendChild(this.#placeholder);
  }

  /** Words per language; punctuation and untagged words excluded so the counter stays honest. */
  #tally(words) {
    const counts = new Map();
    for (const word of words) {
      if (word.type === 'punctuation') continue;
      const code = word.language;
      if (!code) continue;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    return counts;
  }

  #dominantOf(counts) {
    let best = null;
    let bestCount = 0;
    for (const [code, n] of counts) {
      if (n > bestCount) {
        best = code;
        bestCount = n;
      }
    }
    return best;
  }

  /** The label row. One builder, two BEM blocks: `block` is 'utterance' or 'live-line'. */
  #buildMeta(block, dominant, meta, counts) {
    const row = document.createElement('p');
    row.className = `${block}__meta`;

    if (block === 'live-line') {
      const dot = document.createElement('span');
      dot.className = 'live-line__dot';
      dot.setAttribute('aria-hidden', 'true');
      row.appendChild(dot);
    }

    // Identity is never colour-alone: the name is always here, even for a code this build
    // has never seen and even when Melia tagged nothing at all.
    const name = document.createElement('span');
    name.className = `${block}__lang`;
    name.textContent = meta?.name ?? dominant ?? 'Unrecognised';
    row.appendChild(name);

    if (meta?.nativeName && meta.nativeName !== meta.name) {
      const native = document.createElement('span');
      native.className = `${block}__native`;
      native.dir = meta.dir === 'rtl' ? 'rtl' : 'ltr';
      native.lang = meta.code;
      native.textContent = meta.nativeName;
      row.appendChild(native);
    }

    // Naming the other languages present states the switch outright.
    const others = [...counts.entries()]
      .filter(([code]) => code !== dominant)
      .sort((a, b) => b[1] - a[1])
      .map(([code]) => this.#metaFor(code)?.name ?? code);

    if (others.length > 0) {
      const also = document.createElement('span');
      also.className = `${block}__also`;
      const named = others.slice(0, MAX_SECONDARY_NAMED);
      const extra = others.length - named.length;
      also.textContent = `+ ${named.join(', ')}${extra > 0 ? ` +${extra}` : ''}`;
      row.appendChild(also);
    }

    return row;
  }

  /**
   * Each word carries its own data-series, so relabelling a tile cannot move it; an
   * off-dominant word also gets .word--switch, a second channel beside the hue.
   */
  #renderWords(container, words, dominant) {
    const frag = document.createDocumentFragment();
    let prev = null;
    // Punctuation inherits the previous word's slot; a third hue mid-line reads as noise.
    let carried = '';

    for (const word of words) {
      if (needsSpaceBetween(prev, word)) frag.appendChild(document.createTextNode(' '));

      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = word.text;

      const punctuation = word.type === 'punctuation';
      const code = punctuation ? '' : word.language || '';
      const series = punctuation ? carried : this.#seriesFor(code);

      if (series) span.dataset.series = series;
      else span.classList.add('word--unlabelled');

      if (!punctuation) {
        carried = series;
        if (code && dominant && code !== dominant) span.classList.add('word--switch');
      }

      frag.appendChild(span);
      prev = word;
    }

    container.appendChild(frag);
  }

  /** Did this final end a sentence? is_eos when present, terminal punctuation otherwise. */
  #endsSentence(words) {
    for (let i = words.length - 1; i >= 0; i--) {
      const w = words[i];
      if (!w) continue;
      if (w.isEos) return true;
      const t = String(w.text ?? '').trim();
      if (!t) continue;
      // Wide on purpose: merging correctly in English but not in Mandarin, Arabic or
      // Hindi fails this audience. Last mark is Greek U+037E, NOT an ASCII semicolon.
      if (/[.!?…。！？؟۔।;]["'’”»）)\]]*$/.test(t)) return true;
      // Only the last text-bearing result decides.
      return false;
    }
    return false;
  }

  /** Never evict a language's last words: a counter that ticks back down is the worse bug. */
  #evict() {
    while (this.#blocks.length > MAX_BLOCKS) {
      const index = this.#blocks.findIndex((block) => this.#isEvictable(block));
      if (index === -1) break;

      const [gone] = this.#blocks.splice(index, 1);
      gone.el.remove();
      for (const [code, n] of gone.counts) {
        const left = (this.#counts.get(code) ?? 0) - n;
        if (left > 0) this.#counts.set(code, left);
        else this.#counts.delete(code);
      }
    }
  }

  #isEvictable(block) {
    for (const [code, n] of block.counts) {
      if ((this.#counts.get(code) ?? 0) - n <= 0) return false;
    }
    return true;
  }

  /**
   * Size every tile by how far back its ROW is. BY ROW, NOT BY INDEX: the column count
   * comes from the viewport, so "the newest five tiles" tiers the same wall differently
   * on a laptop and a projector; tiles sharing an offsetTop are a row.
   *
   * Read every offsetTop before writing any class, since a tier class resizes the tiles
   * below it. One pass suffices: grid auto-flow places items by index and column count,
   * never by height, so a tier class cannot move a tile between rows.
   */
  #retier() {
    const blocks = this.#blocks;
    if (blocks.length === 0) return;

    // Pass 1: read only.
    const tops = blocks.map((block) => block.el.offsetTop);

    const rows = [];
    let rowTop = null;
    for (let i = 0; i < blocks.length; i++) {
      if (rowTop === null || Math.abs(tops[i] - rowTop) > ROW_EPSILON) {
        rows.push([]);
        rowTop = tops[i];
      }
      rows[rows.length - 1].push(blocks[i].el);
    }

    // Pass 2: write only. Tiers deeper than the last class clamp to it.
    const newest = rows.length - 1;
    for (let r = 0; r < rows.length; r++) {
      const tier = Math.min(TIER_CLASSES.length - 1, newest - r);
      const wanted = TIER_CLASSES[tier];
      for (const el of rows[r]) {
        if (el.classList.contains(wanted)) continue;
        el.classList.remove(...TIER_CLASSES);
        el.classList.add(wanted);
      }
    }
  }

  /** Coalesce to one per frame for the ResizeObserver only; commits stay SYNCHRONOUS. */
  #scheduleReflow() {
    if (this.#reflowRaf !== null) return;
    this.#reflowRaf = requestAnimationFrame(() => {
      this.#reflowRaf = null;
      this.#retier();
      this.#follow();
    });
  }

  /**
   * Follow the newest tile, instantly: finals land in bursts after a reconnect. Only
   * does anything while scrollHeight exceeds clientHeight, which a WRAPPING flex column
   * never produces: it spills sideways, gets clipped, and this silently no-ops. That
   * really happened, and the wall stopped after the third speaker. Keep the wall a
   * vertically-scrolling grid; measure both numbers here before touching anything else.
   */
  #follow() {
    this.#root.scrollTop = this.#root.scrollHeight;
  }
}
