/**
 * A raw WebSocket client for the Melia realtime endpoint. The browser opens this socket
 * directly and main.js mints the short-lived key over HTTP first. NOT the official SDK,
 * which drops the two things this example is built on: LanguageInfo, and the per-word
 * `alternatives[0].language` on PARTIALS that the SDK flattens into one string.
 *
 * VERIFIED MELIA CONFIG. Do not "improve" these values:
 *   transcription_config : { language: 'multi', model: 'melia-1', enable_partials: true }
 *   audio_format         : raw / pcm_s16le / 16000
 *
 * enable_partials is absent from the quickstart and REQUIRED: without it you get finals only.
 * max_delay, conversation_config and translation_config are all REJECTED by melia-1. It
 * is ASR only: no diarization, no knob to beat its ~4s average final.
 */

/* melia-1 lives on the preview host, which docs.speechmatics.com does not list (only eu.rt
 * and global.rt). Re-check this when melia-1 leaves preview. */
export const DEFAULT_MELIA_URL = 'wss://preview.rt.speechmatics.com/v2';

export const MELIA_SAMPLE_RATE = 16000;

/**
 * Box-average downsampler. Averaging the source window is the cheapest thing that is not
 * wrong: decimating 48 kHz folds everything above 8 kHz into the speech band, which the
 * model hears as consonants nobody spoke.
 */
function downsampleTo16k(input, inputRate, targetRate = MELIA_SAMPLE_RATE) {
  if (!input || input.length === 0) return new Float32Array(0);
  if (inputRate === targetRate) return input;
  if (inputRate < targetRate) {
    // Upsampling would be a lie: the high frequencies are not in the signal. Let the server do it.
    return input;
  }

  const ratio = inputRate / targetRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let n = 0;
    for (let j = start; j < end; j++) {
      sum += input[j];
      n++;
    }
    out[i] = n > 0 ? sum / n : 0;
  }
  return out;
}

/**
 * Float32 [-1, 1] to signed 16-bit little-endian PCM. Asymmetric because two's complement
 * has one more negative step: 0x8000 on the positive side would wrap the loudest peaks to
 * full-scale negative, a click on the syllables that matter most.
 */
function floatToPcm16(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i]));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

/**
 * Flatten `results[]` into the Word shape the wall expects. The load-bearing line is
 * `alternatives[0].language`: partials and finals have identical shapes, so partials carry
 * it too, which is what makes the mid-sentence colour flip possible at all.
 */
function normaliseResults(results) {
  const list = Array.isArray(results) ? results : [];
  const words = [];

  for (const result of list) {
    if (!result) continue;
    const alt = Array.isArray(result.alternatives) ? result.alternatives[0] : null;
    if (!alt) continue;

    const type = result.type === 'punctuation' ? 'punctuation' : 'word';
    words.push({
      text: alt.content ?? '',
      language: alt.language ?? null,
      startTime: typeof result.start_time === 'number' ? result.start_time : 0,
      endTime: typeof result.end_time === 'number' ? result.end_time : 0,
      isEos: result.is_eos === true,
      // attaches_to arrives on punctuation only; 'none' gives the wall's spacing rules
      // something concrete to test.
      attachesTo: result.attaches_to ?? (type === 'punctuation' ? 'previous' : 'none'),
      type,
    });
  }

  return words;
}

/** Events on `.detail`: open, started, languageinfo, partial, final, error, close. */
export class MeliaSocket extends EventTarget {
  constructor({ url = DEFAULT_MELIA_URL, maxBufferedBytes = 512 * 1024 } = {}) {
    super();
    this.url = url;
    this.maxBufferedBytes = maxBufferedBytes;

    this.ws = null;
    this.started = false;
    this.seqNo = 0;
  }

  /** Convenience over addEventListener. Returns an unsubscribe function. */
  on(type, handler) {
    const wrapped = (event) => handler(event.detail);
    this.addEventListener(type, wrapped);
    return () => this.removeEventListener(type, wrapped);
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /**
   * Open the socket and resolve on RecognitionStarted. `jwt` must be a SHORT-LIVED key: it
   * rides in the query string because a browser WebSocket cannot set an Authorization
   * header, which is why the ttl is 60s. NEVER put a long-lived API key here.
   */
  connect(jwt) {
    if (!jwt) return Promise.reject(new Error('MeliaSocket.connect: missing jwt'));

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${this.url}?jwt=${encodeURIComponent(jwt)}`);
      socket.binaryType = 'arraybuffer';
      this.ws = socket;
      this.started = false;
      this.seqNo = 0;

      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      socket.onopen = () => {
        this.#emit('open');
        socket.send(
          JSON.stringify({
            message: 'StartRecognition',
            audio_format: {
              type: 'raw',
              encoding: 'pcm_s16le',
              sample_rate: MELIA_SAMPLE_RATE,
            },
            // 'multi' is what labels each word individually; naming a concrete language would
            // defeat the example. Omitting enable_partials returned ZERO partials over a 27s
            // stream, only finals at 3.3-6.0s lag.
            transcription_config: {
              language: 'multi',
              model: 'melia-1',
              enable_partials: true,
            },
          }),
        );
      };

      socket.onmessage = (event) => {
        // Melia sends only JSON downstream. Binary frames are ours, going up.
        if (typeof event.data !== 'string') return;

        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        switch (msg.message) {
          case 'RecognitionStarted':
            this.started = true;
            this.#emit('started', { id: msg.id ?? null });
            if (!settled) {
              settled = true;
              resolve();
            }
            break;

          case 'LanguageInfo':
            // Fires once per language, on first detection.
            this.#emit('languageinfo', {
              language: msg.language ?? null,
              wordDelimiter: msg.word_delimiter ?? ' ',
              writingDirection: msg.writing_direction ?? 'left-to-right',
              partial: msg.partial === true,
            });
            break;

          case 'AddPartialTranscript':
            this.#emit('partial', this.#transcriptDetail(msg));
            break;

          case 'AddTranscript':
            this.#emit('final', this.#transcriptDetail(msg));
            break;

          case 'AudioAdded':
            // Not gated on: waiting for acks turns a mic stream into stop-and-wait.
            break;

          case 'Error':
            this.#emit('error', {
              reason: msg.reason ?? 'unknown error',
              type: msg.type ?? null,
            });
            fail(new Error(`Speechmatics error (${msg.type ?? '?'}): ${msg.reason ?? ''}`));
            break;

          case 'Warning':
          case 'Info':
          case 'EndOfTranscript':
          default:
            break;
        }
      };

      socket.onerror = () => {
        // The browser withholds the cause (cross-origin); the close event carries a code.
        this.#emit('error', { reason: 'websocket transport error', type: null });
        fail(new Error('MeliaSocket: websocket transport error'));
      };

      socket.onclose = (event) => {
        this.started = false;
        this.#emit('close', { code: event.code, reason: event.reason });
        fail(new Error(`MeliaSocket: closed before start (${event.code})`));
      };
    });
  }

  #transcriptDetail(msg) {
    const words = normaliseResults(msg.results);
    return {
      words,
      transcript: msg.transcript ?? '',
      startTime: msg.metadata?.start_time ?? 0,
      endTime: msg.metadata?.end_time ?? 0,
    };
  }

  /**
   * Push one AudioWorklet buffer of mono float `samples` captured at `inputRate` (usually
   * 48000). False means the chunk was dropped.
   */
  sendAudio(samples, inputRate) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;

    // The server rejects AddAudio before RecognitionStarted. Dropped rather than buffered:
    // handshake audio is stale, and replaying it puts every later word further behind the
    // room for the rest of the session.
    if (!this.started) return false;

    // Backpressure: dropping the NEWEST chunk keeps the stream anchored to the present.
    // Queuing grows a delay that never recovers, which is worse than a dropped syllable.
    if (this.ws.bufferedAmount > this.maxBufferedBytes) {
      return false;
    }

    const resampled = downsampleTo16k(samples, inputRate);
    if (resampled.length === 0) return false;

    const pcm = floatToPcm16(resampled);
    this.ws.send(pcm.buffer);
    this.seqNo++;
    return true;
  }

  /** Politely end the stream so the server flushes its last final. */
  close() {
    if (!this.ws) return;
    if (this.ws.readyState === WebSocket.OPEN) {
      if (this.started) {
        this.ws.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: this.seqNo }));
      }
      this.ws.close();
    }
    this.started = false;
  }
}
