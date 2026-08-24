/**
 * The wiring: 'partial' -> wall.setLive(words), 'final' -> wall.commit(words), then
 * ribbon.update(wall.stats()), counter, legend. Owns the API key, the socket, the mic and
 * the chrome; wall.js and ribbon.js own everything that draws the transcript. Nothing here
 * waits on Melia, and no result is ever dropped or "corrected" for looking wrong.
 */

import { MeliaSocket, DEFAULT_MELIA_URL, MELIA_SAMPLE_RATE } from './melia-socket.js';
import { MicCapture } from './audio.js';
import { LanguagePalette } from './palette.js';

// Byte-identical to the interpreter's copy: two tables that quietly diverge is worse.
import { MELIA_LANGUAGES } from './languages.js';

import { VoiceWall } from './wall.js';
import { CompositionRibbon } from './ribbon.js';

/** Bump on every client change; answers "is the browser running the new code?" pre-demo. */
const BUILD = '1.1.0 (2026-08-18)';

const RECONNECT_BASE_MS = 400;
const RECONNECT_MAX_MS = 8000;

const LANGUAGES = new Map(MELIA_LANGUAGES.map((lang) => [lang.code, lang]));

/** An unresolved code renders as the raw code, never "Unknown": if Melia says `bxr`, so does the screen. */
function languageMeta(code) {
  const known = code ? LANGUAGES.get(code) : null;
  if (known) return known;
  return { code: code || '', name: code || 'unlabelled', nativeName: '', dir: 'ltr' };
}

const $ = (sel) => document.querySelector(sel);

const els = {
  wall: $('#wall'),
  liveLine: $('#live-line'),
  ribbon: $('#ribbon'),
  legend: $('#legend'),
  counter: $('#counter'),
  counterValue: $('#counter-value'),
  toggleBtn: $('#toggle-btn'),
  toggleLabel: $('#toggle-label'),
  meterFill: $('#meter-fill'),
  resetBtn: $('#reset-btn'),
  status: $('#status'),
  error: $('#error'),
  keyInput: $('#api-key'),
  keyToggle: $('#api-key-toggle'),
  keyRemember: $('#api-key-remember'),
  keyClear: $('#api-key-clear'),
  keybar: $('#keybar'),
};

// Load-bearing only, the rest guarded at its use site: a missing #wall found via a
// TypeError mid-demo is worse than one sentence at boot.
for (const [key, id] of [['wall', 'wall'], ['liveLine', 'live-line'], ['toggleBtn', 'toggle-btn']]) {
  if (!els[key]) throw new Error(`Wall of Voices: index.html is missing #${id}`);
}

const palette = new LanguagePalette();

// One shared instance is what keeps a language the same colour across all three surfaces.
const wall = new VoiceWall(els.wall, { palette, languages: LANGUAGES, liveEl: els.liveLine });

const ribbon = els.ribbon ? new CompositionRibbon(els.ribbon, { palette, languages: LANGUAGES }) : null;

// ── bring your own key ──────────────────────────────────────────────────────

/**
 * The deployment holds no credential: the visitor pastes their own key and the browser
 * exchanges it for a 60s realtime key. sessionStorage by default, localStorage only when
 * "remember" is ticked; one name in both, and clearing the field removes it from both.
 */
const KEY_STORAGE = 'wall-of-voices.api-key';

/** The Management Platform, not the ASR endpoint. `type=rt`: a batch key will not open a socket. */
const TEMP_KEY_URL = 'https://mp.speechmatics.com/v1/api_keys?type=rt';
const TEMP_KEY_TTL = 60;
const TOKEN_URL = '/api/token';

const MSG_NO_KEY = 'Paste your Speechmatics API key to start.';
const MSG_BAD_KEY =
  'Speechmatics rejected that API key. Check it for a typo or a stray space; it is still in the field.';
const MSG_NO_SERVER_KEY =
  'This deployment holds no API key of its own. Paste your Speechmatics key to start.';
const MSG_UNREACHABLE =
  'Could not reach Speechmatics to create a temporary key. Check your network and try again.';

/**
 * Loopback only: dev_server.py falls back to SPEECHMATICS_API_KEY from .env so local work
 * needs no pasting. The token endpoint itself has no such path, so anywhere else an empty
 * field can only produce "paste a key".
 */
const SERVER_MAY_HOLD_KEY = ['localhost', '127.0.0.1', '::1', '[::1]', ''].includes(
  location.hostname,
);

let apiKey = '';
let remember = false;

/** Wrapped because private mode, blocked cookies, quota and `window[kind]` itself all throw. */
function storeOf(kind) {
  try {
    return window[kind] || null;
  } catch {
    return null;
  }
}

/** Session first, then the localStorage mirror: where it was found IS the remember flag. */
function readStoredKey() {
  for (const kind of ['sessionStorage', 'localStorage']) {
    try {
      const value = storeOf(kind)?.getItem(KEY_STORAGE);
      if (value) return { key: value.trim(), remembered: kind === 'localStorage' };
    } catch {
      /* try the other */
    }
  }
  return { key: '', remembered: false };
}

/** Ticking "remember" MOVES the key between stores; a copy would outlive the field. */
function writeStoredKey(key, toDevice) {
  try {
    storeOf(toDevice ? 'sessionStorage' : 'localStorage')?.removeItem(KEY_STORAGE);
  } catch {
    /* unwritable */
  }
  try {
    storeOf(toDevice ? 'localStorage' : 'sessionStorage')?.setItem(KEY_STORAGE, key);
  } catch {
    /* the key still works this session, it just will not survive a reload */
  }
}

function forgetStoredKey() {
  for (const kind of ['sessionStorage', 'localStorage']) {
    try {
      storeOf(kind)?.removeItem(KEY_STORAGE);
    } catch {
      /* unwritable */
    }
  }
}

function canStart() {
  return Boolean(apiKey) || SERVER_MAY_HOLD_KEY;
}

/**
 * The Start gate and the key indicator: .is-set on #keybar plus the status pill, which
 * index.html ships as status--nokey. Prevents finding on stage that storage cleared
 * overnight. The pill reports the key only while idle; a run owns it after that.
 */
function syncKeyUi(state) {
  if (els.keyRemember) els.keyRemember.checked = remember;
  if (els.keybar) els.keybar.classList.toggle('is-set', Boolean(apiKey));

  // Never disabled while live, or Stop becomes unreachable.
  els.toggleBtn.disabled = !running && !canStart();

  if (running || connecting) return;
  if (state === 'rejected') setStatus('nokey', 'Key rejected');
  else if (!canStart()) setStatus('nokey', 'No key');
  // The affirmative branch is not optional. Without it the pill keeps whatever it
  // last said, so pasting a key left the primary indicator reading "No key" while
  // Start was enabled - the indicator exists to be trusted on a stage morning.
  else setStatus('idle', 'Idle');
}

function wireKeyControls() {
  if (els.keyInput) {
    // Stored on every keystroke rather than on blur: a reload mid-paste should not lose it.
    els.keyInput.addEventListener('input', () => {
      apiKey = els.keyInput.value.trim();
      if (apiKey) writeStoredKey(apiKey, remember);
      else forgetStoredKey();
      syncKeyUi();
    });
  }

  if (els.keyRemember) {
    els.keyRemember.addEventListener('change', () => {
      remember = els.keyRemember.checked;
      if (apiKey) writeStoredKey(apiKey, remember);
      syncKeyUi();
    });
  }

  if (els.keyClear) {
    els.keyClear.addEventListener('click', () => {
      apiKey = '';
      forgetStoredKey();
      if (els.keyInput) els.keyInput.value = '';
      syncKeyUi();
    });
  }

  if (els.keyToggle && els.keyInput) {
    els.keyToggle.addEventListener('click', () => {
      const shown = els.keyInput.type === 'text';
      els.keyInput.type = shown ? 'password' : 'text';
      els.keyToggle.setAttribute('aria-pressed', String(!shown));
      els.keyToggle.setAttribute('aria-label', shown ? 'Show API key' : 'Hide API key');
      els.keyToggle.textContent = shown ? 'Show' : 'Hide';
    });
  }
}

/** `keyState` marks a failure retrying cannot fix, and names the indicator state to show. */
function keyError(message, state) {
  const err = new Error(message);
  err.keyState = state;
  return err;
}

/**
 * Exchange the visitor's long-lived key for a 60s realtime key: browser-direct to the
 * Management Platform first, through our own /api/token only when CORS or the network
 * blocks that. Rejects with a projector-ready sentence, never a raw error and never
 * anything derived from the key. Sibling of promptmatics rt.js fetchTempKey().
 */
async function fetchTempKey(key) {
  if (key) {
    try {
      const res = await fetch(TEMP_KEY_URL, {
        method: 'POST',
        // Authorization header, never a query string: this URL reaches logs and history.
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TEMP_KEY_TTL }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.key_value === 'string' && data.key_value) return data.key_value;
      } else if (res.status === 401 || res.status === 403) {
        // The key itself, not the transport: the proxy would only offer the same rejected key
        // again, and in local dev its .env fallback would silently mask the typo.
        throw keyError(MSG_BAD_KEY, 'rejected');
      }
      // Any other non-2xx, or a 200 with no key in it: fall through to the proxy.
    } catch (err) {
      if (err?.keyState) throw err; // ours, deliberate, not a transport failure
    }
  }

  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No apiKey at all when the field is empty, so dev_server.py can use its .env key.
      body: JSON.stringify(key ? { apiKey: key } : {}),
    });
  } catch {
    throw new Error(MSG_UNREACHABLE);
  }

  if (res.status === 401 || res.status === 403) throw keyError(MSG_BAD_KEY, 'rejected');
  // 400 missing_api_key, or 503 unconfigured: no key here and none on the server either.
  if (res.status === 400 || res.status === 503) throw keyError(MSG_NO_SERVER_KEY, 'missing');
  // Status only: the route answers in machine codes ("token_mint_failed"), not sentences.
  if (!res.ok) throw new Error(`Could not mint a realtime key (HTTP ${res.status}).`);

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  const temp = data && (data.jwt || data.key_value);
  if (typeof temp !== 'string' || !temp) {
    throw new Error('The temporary key exchange returned no key.');
  }
  return temp;
}

// ── session ─────────────────────────────────────────────────────────────────

let running = false;

let mic = null;
let socket = null;

/**
 * Bumped on every connect attempt and on stop(). Callbacks carry the generation they were
 * wired at and bail on a mismatch, so a socket replaced mid-handshake cannot paint, error
 * or reconnect for a session that has moved on.
 */
let generation = 0;

let connecting = false;
let reconnectTimer = null;
let reconnectAttempt = 0;

let meterRaf = null;
let paintRaf = null;

let shownCount = 0;

const legendChips = new Map();

console.info(`[wall-of-voices] build ${BUILD}`);

// The laptop is mirrored to a projector: a thrown renderer error must land in #error.
window.addEventListener('error', (event) => showError(event.error || new Error(event.message)));
window.addEventListener('unhandledrejection', (event) => showError(event.reason));

init();

function init() {
  setStatus('idle', 'Idle');
  setToggle(false);
  els.toggleBtn.addEventListener('click', () => (running ? stop() : start()));

  // No confirmation step: a modal in front of a live audience is worse than a stray clear.
  if (els.resetBtn) els.resetBtn.addEventListener('click', resetAll);

  if (els.counter) {
    els.counter.addEventListener('animationend', () => els.counter.classList.remove('is-tick'));
  }

  const stored = readStoredKey();
  apiKey = stored.key;
  remember = stored.remembered;
  if (els.keyInput) els.keyInput.value = apiKey;
  wireKeyControls();
  syncKeyUi();
}

/** getUserMedia must run inside the click gesture; the socket retries on its own schedule. */
async function start() {
  if (running) return;

  // Start is disabled without a key, so this is the scripted path: it says so, never throws.
  if (!canStart()) {
    showError(new Error(MSG_NO_KEY));
    syncKeyUi('missing');
    return;
  }

  hideError();
  running = true;
  setToggle(true);
  setStatus('connecting', 'Connecting');

  try {
    mic = new MicCapture({
      // Read fresh each frame, so capture survives a reconnect with no second prompt.
      onFrame: (frame) => {
        if (socket) socket.sendAudio(frame, mic.sampleRate);
      },
      onError: showError,
    });
    await mic.start();
  } catch (err) {
    // The one genuinely fatal failure: no audio to recover with, so unwind cleanly.
    running = false;
    setToggle(false);
    setStatus('error', 'No microphone');
    showError(err);
    return;
  }

  bootStamp();
  pumpMeter();
  openSocket();
}

async function stop() {
  running = false;
  // Whatever was mid-sentence is finished; a restart must not append onto the last tile.
  wall.closeOpen();
  lastFinalEnd = null;

  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempt = 0;

  // Orphan anything in flight, so a handshake landing during teardown cannot resurrect it.
  generation++;

  if (socket) {
    socket.close();
    socket = null;
  }
  if (mic) {
    await mic.stop();
    mic = null;
  }

  cancelAnimationFrame(meterRaf);
  if (els.meterFill) els.meterFill.style.width = '0%';

  // The live line resets because nobody is speaking. THE WALL DOES NOT: Stop is a pause
  // between segments as often as an ending, and only Clear wall ever empties it.
  wall.setLive([]);

  setToggle(false);
  setStatus('idle', 'Stopped');
  syncKeyUi();
}

/**
 * Fresh temporary key per attempt: at a 60s TTL the one that authorised the lost socket is
 * dead. The long-lived key is re-read from the field too, so fixing a typo is enough.
 */
async function openSocket() {
  if (!running || connecting) return;
  connecting = true;

  const gen = ++generation;

  try {
    setStatus('connecting', reconnectAttempt === 0 ? 'Connecting' : 'Reconnecting');

    const jwt = await fetchTempKey(apiKey);

    const next = new MeliaSocket();
    wire(next, gen);
    await next.connect(jwt);

    // Superseded while shaking hands: close it rather than leaving a live socket unread.
    if (gen !== generation) {
      next.close();
      return;
    }

    socket = next;
    reconnectAttempt = 0;
    hideError();
    setStatus('live', 'Live');
  } catch (err) {
    if (gen !== generation) return;
    // A rejected or absent key never succeeds by retrying, and a reconnect loop would paint
    // "Reconnecting" over the sentence saying what to fix. The field keeps its value.
    if (err?.keyState) {
      await stop();
      syncKeyUi(err.keyState);
      setStatus('nokey', err.keyState === 'rejected' ? 'Key rejected' : 'No key');
      showError(err);
      return;
    }
    showError(err);
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function wire(sock, gen) {
  const current = () => gen === generation;

  sock.on('partial', ({ words }) => current() && onPartial(words));
  sock.on('final', ({ words }) => current() && onFinal(words));

  // LanguageInfo is deliberately NOT wired: it fires on first DETECTION, including inside a
  // partial later revised away, and is never retracted. It would leave a legend chip and a
  // counter entry with no words under them. See syncCounter.

  sock.on('error', ({ reason }) => current() && showError(new Error(reason || 'socket error')));

  sock.on('close', ({ code }) => {
    if (!current()) return;
    socket = null;

    // NOT wall.setLive([]): blanking the projector is a larger event than the outage it
    // reports, and the next partial replaces it anyway.
    if (running) scheduleReconnect(code);
  });
}

/**
 * Unlimited attempts, wall preserved: this is a screen at the front of a room for a whole
 * talk, so the right move at attempt forty is still to try again. Idempotent via
 * reconnectTimer: a failed connect() and its 'close' both land here.
 */
function scheduleReconnect(code) {
  if (!running || reconnectTimer) return;

  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempt);
  reconnectAttempt++;

  console.warn(`[wall-of-voices] socket closed${code ? ` (${code})` : ''}, retry ${reconnectAttempt} in ${delay}ms`);
  setStatus('connecting', 'Reconnecting');

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openSocket();
  }, delay);
}

/** THE MONEY MOMENT: Melia tags every word of a PARTIAL, so the colour flips mid-sentence. */
function onPartial(words) {
  if (!words || !words.length) return;
  wall.setLive(words);
  schedulePaint();
}

/**
 * A gap this long is the mic changing hands, not a breath, so the open tile closes before
 * the next person's words land in it. Measured on Melia's word clock, since finals drift;
 * erring short is safe, a wrong merge is the costly one.
 */
const HANDOVER_GAP_SECONDS = 1.5;

let lastFinalEnd = null;

function onFinal(words) {
  if (!words || !words.length) return;

  const start = firstFinite(words, 'startTime');
  if (
    lastFinalEnd !== null &&
    start !== null &&
    start - lastFinalEnd > HANDOVER_GAP_SECONDS
  ) {
    wall.closeOpen();
  }
  const end = lastFinite(words, 'endTime');
  if (end !== null) lastFinalEnd = end;

  // One call, deliberately: commit() clears the live line and follows the scroll itself.
  wall.commit(words);
  schedulePaint();
}

function firstFinite(words, key) {
  for (const w of words) if (Number.isFinite(w?.[key])) return w[key];
  return null;
}

function lastFinite(words, key) {
  for (let i = words.length - 1; i >= 0; i--) {
    if (Number.isFinite(words[i]?.[key])) return words[i][key];
  }
  return null;
}

/** All five together: clearing any subset leaves the screen contradicting itself. NOT a stop. */
function resetAll() {
  wall.reset();
  palette.reset();
  lastFinalEnd = null; // a new run must not measure its gap against the old one
  if (ribbon) ribbon.reset();

  legendChips.clear();
  if (els.legend) els.legend.textContent = '';

  shownCount = 0;
  if (els.counterValue) els.counterValue.textContent = '0';
  if (els.counter) {
    els.counter.classList.remove('is-tick');
    // Left behind, this would tint the next tick in a dead session's colour.
    delete els.counter.dataset.series;
  }

  hideError();
}

/** Repaints coalesce; the wall itself updates synchronously above, being what is watched. */
function schedulePaint() {
  if (paintRaf) return;
  paintRaf = requestAnimationFrame(() => {
    paintRaf = null;
    paint();
  });
}

function paint() {
  const stats = wall.stats();
  if (ribbon) ribbon.update(stats);
  syncCounter(stats);
  syncLegend(stats);
}

/**
 * The hero figure, and the line the talk closes on. Counted from the WALL, not the palette:
 * a slot means "needs a colour" and the never-retracted live line claims those too.
 * wall.stats() counts committed tiles only, so it is what the room can count.
 */
function syncCounter(stats) {
  const seen = new Set((stats?.languages ?? []).map((entry) => entry.code));
  const count = seen.size;
  if (count === shownCount) return;

  const grew = count > shownCount;
  shownCount = count;

  if (els.counterValue) els.counterValue.textContent = String(count);
  if (!grew || !els.counter) return;

  const ordered = palette.seen().filter((code) => seen.has(code));
  const newest = ordered[ordered.length - 1];
  if (!newest) return;
  els.counter.dataset.series = String(palette.slotFor(newest) + 1);

  // Remove, reflow, re-add: re-adding a present class does not restart a CSS animation.
  els.counter.classList.remove('is-tick');
  void els.counter.offsetWidth;
  els.counter.classList.add('is-tick');
}

/** Appended to, never rebuilt: a rebuild restarts every chip's animation and churns nodes. */
function syncLegend(stats) {
  if (!els.legend) return;

  const counts = new Map((stats?.languages ?? []).map((entry) => [entry.code, entry.count]));

  // ORDER from the palette (first-heard, so a chip never moves under a pointing finger)
  // but MEMBERSHIP from the wall, so the legend and the counter cannot disagree.
  for (const code of palette.seen().filter((c) => counts.has(c))) {
    let chip = legendChips.get(code);
    if (!chip) {
      chip = buildLegendChip(code);
      legendChips.set(code, chip);
      els.legend.appendChild(chip.item);
    }

    const words = counts.get(code);
    const hasCount = Number.isFinite(words) && words > 0;
    chip.count.hidden = !hasCount;
    chip.count.textContent = hasCount ? String(words) : '';
  }
}

function buildLegendChip(code) {
  const meta = languageMeta(code);

  const item = document.createElement('span');
  item.className = 'legend__item legend__item--new';
  item.dataset.series = String(palette.slotFor(code) + 1);
  item.lang = meta.code;

  const swatch = document.createElement('span');
  swatch.className = 'legend__swatch';

  const name = document.createElement('span');
  name.className = 'legend__name';
  // textContent, never innerHTML: languageMeta's fallback echoes a code off the wire.
  name.textContent = meta.name;

  const native = document.createElement('span');
  native.className = 'legend__native';
  if (meta.nativeName && meta.nativeName !== meta.name) {
    native.textContent = meta.nativeName;
    // Its own script, so its own direction and its own lang for font selection.
    native.dir = meta.dir || 'ltr';
    native.lang = meta.code;
  } else {
    native.hidden = true;
  }

  const count = document.createElement('span');
  count.className = 'legend__count';
  count.hidden = true;

  item.append(swatch, name, native, count);
  item.addEventListener('animationend', () => item.classList.remove('legend__item--new'), { once: true });

  return { item, count };
}

function pumpMeter() {
  if (!running || !mic) return;
  if (els.meterFill) {
    // Scaled up: speech rarely fills 0..1, and a meter stuck at a fifth reads as a dead mic.
    els.meterFill.style.width = `${Math.min(100, mic.getLevel() * 220)}%`;
  }
  meterRaf = requestAnimationFrame(pumpMeter);
}

function setToggle(live) {
  els.toggleBtn.classList.toggle('is-live', live);
  if (els.toggleLabel) els.toggleLabel.textContent = live ? 'Stop' : 'Start listening';
}

function setStatus(state, label) {
  if (!els.status) return;
  els.status.className = `status status--${state}`;
  els.status.textContent = label;
}

/** Reported, then ignored by everything that draws: nothing already on screen is removed. */
function showError(err) {
  console.error('[wall-of-voices]', err);
  if (!els.error) return;
  els.error.hidden = false;
  els.error.textContent = err && err.message ? err.message : String(err);
}

function hideError() {
  if (!els.error) return;
  els.error.hidden = true;
  els.error.textContent = '';
}

/** The mic label earns its place: the wrong capsule is how this fails while looking fine. */
function bootStamp() {
  console.info(
    `[wall-of-voices] build ${BUILD}\n` +
      `  endpoint       ${DEFAULT_MELIA_URL}\n` +
      '  transcription  language=multi model=melia-1 enable_partials=true\n' +
      `  audio          raw/pcm_s16le/${MELIA_SAMPLE_RATE}, captured at ${mic.sampleRate} Hz and downsampled in melia-socket.js\n` +
      `  microphone     ${mic.deviceLabel}\n` +
      // Where the key came from, never the key.
      `  api key        ${apiKey ? (remember ? 'browser, remembered on this device' : 'browser, this tab only') : 'none in the browser, using local server .env'}\n` +
      `  languages      ${LANGUAGES.size} in the table\n` +
      `  reconnect      ${RECONNECT_BASE_MS}ms doubling to ${RECONNECT_MAX_MS}ms, unlimited attempts, wall preserved`,
  );
}
