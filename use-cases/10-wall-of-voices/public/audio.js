/**
 * audio.js: the microphone, and nothing else.
 *
 * This page NEVER PLAYS A SOUND: no TTS, no playback queue, no panner, no half-duplex
 * gate. One microphone gets passed around a room and the words land on a screen.
 *
 * Frames leave here as Float32 at whatever rate the browser actually gave us.
 * melia-socket.js owns the wire format and does both the downsample to 16 kHz and the
 * 16-bit conversion in sendAudio(samples, inputRate); converting here as well would put
 * two resamplers in one example, which is how you ship chipmunk audio to an ASR endpoint.
 */

// Melia's audio_format is 16 kHz. Chrome and Firefox honour the request; Safari clamps to
// the hardware rate. That is fine: ask, then read back what you got.
const TARGET_SAMPLE_RATE = 16000;

// ~64 ms at 16 kHz, ~21 ms at 48 kHz: coarser than a 128-sample render quantum, fine
// enough that the level meter still looks alive.
const FRAME_SIZE = 1024;

/* ------------------------------------------------------------------ the AudioWorklet */

/**
 * Worklet source, inlined and loaded from a Blob URL because addModule() only accepts a
 * URL, which would otherwise force a second .js file whose relationship to this one is
 * invisible on disk. All it does is regroup 128-sample render quanta into FRAME_SIZE
 * frames. No mute plumbing: with no playback here, a mute flag would be a switch nothing
 * can ever flip.
 */
const WORKLET_SOURCE = `
class WallCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frameSize = options.processorOptions.frameSize;
    this.out = new Float32Array(this.frameSize);
    this.outIdx = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;

    for (let i = 0; i < ch.length; i++) {
      this.out[this.outIdx++] = ch[i];
      if (this.outIdx === this.frameSize) {
        const copy = new Float32Array(this.out);
        // Transfer rather than clone: these fire tens of times a second all session.
        this.port.postMessage(copy, [copy.buffer]);
        this.outIdx = 0;
      }
    }
    return true;
  }
}

registerProcessor('wall-capture', WallCaptureProcessor);
`;

/* ---------------------------------------------------------------- microphone capture */

export class MicCapture {
  /**
   * @param {object} opts
   * @param {(frame: Float32Array) => void} opts.onFrame  mono frames at `this.sampleRate`
   * @param {(err: Error) => void} [opts.onError]
   */
  constructor({ onFrame, onError = () => {} } = {}) {
    this.onFrame = onFrame;
    this.onError = onError;

    this.stream = null;
    this.ctx = null;
    this.source = null;
    this.node = null;
    this.analyser = null;
    this.running = false;

    /**
     * The rate frames are ACTUALLY delivered at, which callers must pass to
     * MeliaSocket.sendAudio(). Assuming 16000 is how you end up transcribing noise.
     */
    this.sampleRate = TARGET_SAMPLE_RATE;

    /** The OS's name for the input device, once permission is granted. The boot stamp prints it. */
    this.deviceLabel = '';
  }

  async start() {
    if (this.running) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: TARGET_SAMPLE_RATE,

        // OFF deliberately. AEC subtracts a reference of what the page is PLAYING, and
        // this page never plays anything, leaving only its residual suppressor, which
        // ducks the mic whenever it believes a far end is talking. On a microphone being
        // handed between people that duck lands on the next speaker's first syllable.
        echoCancellation: false,

        // ON: a conference room is HVAC, fans and two hundred people breathing, and room
        // tone is what turns a confident language label into a shrug.
        noiseSuppression: true,

        // ON: mouth-to-capsule distance changes by a factor of five as the mic travels
        // down a row of seats.
        autoGainControl: true,
      },
    });

    const track = this.stream.getAudioTracks()[0];
    this.deviceLabel = (track && track.label) || 'unknown input device';

    this.ctx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: TARGET_SAMPLE_RATE,
    });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    // Read back what we were actually given, never what we asked for.
    this.sampleRate = this.ctx.sampleRate;

    this.source = this.ctx.createMediaStreamSource(this.stream);

    // Tapped straight off the source node, so the meter keeps twitching even while the
    // socket is mid-reconnect: that is what tells a presenter with no console apart "the
    // network dropped" from "somebody has a thumb over the capsule".
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.source.connect(this.analyser);

    if (this.ctx.audioWorklet) {
      await this.#startWorklet();
    } else {
      this.#startScriptProcessor();
    }

    this.running = true;
  }

  async #startWorklet() {
    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      // Compiled by the time addModule resolves; holding the URL leaks it for the life
      // of the document.
      URL.revokeObjectURL(url);
    }

    this.node = new AudioWorkletNode(this.ctx, 'wall-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { frameSize: FRAME_SIZE },
    });

    this.node.port.onmessage = (e) => this.onFrame(e.data);
    this.source.connect(this.node);
    // Nothing connects to ctx.destination here. A worklet with numberOfOutputs: 0 is
    // still pulled by the graph, and routing a mic to the PA it is standing next to is
    // how you get feedback howl in front of an audience.
  }

  /**
   * ScriptProcessorNode fallback: deprecated, and it runs on the MAIN thread so it
   * glitches while we paint the wall. Here only for older Safari and embedded WebViews
   * with no AudioWorklet. Delete this branch once your target browsers all have one.
   */
  #startScriptProcessor() {
    console.warn('AudioWorklet unavailable. Falling back to deprecated ScriptProcessorNode.');

    this.node = this.ctx.createScriptProcessor(4096, 1, 1);

    let pending = [];
    this.node.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i++) {
        pending.push(input[i]);
        if (pending.length === FRAME_SIZE) {
          this.onFrame(Float32Array.from(pending));
          pending = [];
        }
      }
    };

    this.source.connect(this.node);
    // ScriptProcessorNode only fires onaudioprocess while connected to a destination, so
    // it must be connected, and must therefore be guaranteed to carry silence. This
    // zero-gain node is the only thing in the example that touches ctx.destination.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute);
    mute.connect(this.ctx.destination);
  }

  /** @returns {number} 0..1 input level, for the UI meter. */
  getLevel() {
    if (!this.analyser) return 0;
    const bins = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(bins);
    let sum = 0;
    for (let i = 0; i < bins.length; i++) sum += bins[i];
    return sum / bins.length / 255;
  }

  async stop() {
    this.running = false;
    if (this.node) {
      this.node.disconnect();
      if (this.node.port) this.node.port.onmessage = null;
      this.node.onaudioprocess = null;
    }
    if (this.source) this.source.disconnect();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close();

    this.node = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
  }
}
