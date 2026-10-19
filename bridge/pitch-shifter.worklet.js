// pitch-shifter.worklet.js - Pitch shift without a change of speed (key shift), for the offscreen DSP graph.
//
// Method: WSOLA time-stretching (the SoundTouch approach) followed by resampling, in one streaming processor.
// To raise the pitch by a ratio r, the audio is first stretched to r times its length by overlapping and
// adding whole segments of the waveform at the best-matching offset (segments are joined where their
// waveforms line up, never cut mid-cycle), then read out r times faster. Drum hits survive because every
// segment is copied intact; the cost is a slight warble on long steady notes that grows with the shift,
// and about 0.14 s of delay while the stage is in use. The graph routes around this node at 0 st.
//
// Parameter `semitones` (k-rate, -12 .. +12). Exactly 0 parks the processor (1.5.2): it outputs silence, does no work and
// forgets its history, because the graph routes around it then. A full WSOLA search costs up to ~2 ms at 96 kHz, more
// than one 1.33 ms block, and running it ten times a second while unused pushed the engine to the edge of real time
// (dropouts heard as clicks). Leaving 0 it starts afresh; it posts { primed: true } once it is producing audio and
// { primed: false } when it parks or runs dry, and the graph opens its path only while it is primed.

const OVERLAP_MS = 8;        // crossfade between segments
const SEQ_MIN_MS = 50;       // segment length at tempo 2 (pitch down an octave) ...
const SEQ_MAX_MS = 125;      // ... and at tempo 0.5 (pitch up an octave); 100 ms near 0 st
const SEEK_MIN_MS = 15;      // search window for the best join, likewise 15 .. 25 ms
const SEEK_MAX_MS = 25;
const CUSHION = 1024;        // stretched samples kept in hand so the reader never runs dry while the shift moves

class PitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'semitones', defaultValue: 0, minValue: -12, maxValue: 12, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    const fs = sampleRate;
    this.channels = 2;
    this.overlap = Math.round(OVERLAP_MS * fs / 1000);
    this.maxSeq = Math.round(SEQ_MAX_MS * fs / 1000);
    this.maxSeek = Math.round(SEEK_MAX_MS * fs / 1000);
    this.inCap = 8 * (this.maxSeq + this.maxSeek);
    this.stCap = Math.max(8 * this.maxSeq, 32768);
    this.inBuf = []; this.stBuf = []; this.mid = [];
    for (let c = 0; c < this.channels; c++) {
      this.inBuf.push(new Float32Array(this.inCap));
      this.stBuf.push(new Float32Array(this.stCap));
      this.mid.push(new Float32Array(this.overlap));
    }
    this.midMix = new Float32Array(this.overlap);
    this.mix = new Float32Array(this.maxSeek + this.overlap);
    this.inStart = 0; this.inEnd = 0;   // unread input: [inStart, inEnd) (inStart may run ahead: input still to skip)
    this.stEnd = 0;                     // stretched audio: [0, stEnd)
    this.rsPos = 1;                     // fractional read position in the stretched audio (>= 1 for the cubic reader)
    this.skipFract = 0;
    this.primed = false;
    this.parked = false;
  }

  // Back to the state of a new processor (the buffers' old contents are never read again, except the crossfade tail).
  reset() {
    this.inStart = 0; this.inEnd = 0; this.stEnd = 0; this.rsPos = 1; this.skipFract = 0;
    for (let c = 0; c < this.channels; c++) this.mid[c].fill(0);
    this.midMix.fill(0);
    this.setPrimed(false);
  }

  setPrimed(on) {
    if (this.primed === on) return;
    this.primed = on;
    this.port.postMessage({ primed: on });
  }

  // Segment lengths follow the stretch factor, as SoundTouch's automatic setting does.
  lengths(tempo) {
    const fs = sampleRate;
    const t = Math.min(2, Math.max(0.5, tempo));
    const seqMs = SEQ_MAX_MS + (SEQ_MIN_MS - SEQ_MAX_MS) * (t - 0.5) / 1.5;
    const seekMs = SEEK_MAX_MS + (SEEK_MIN_MS - SEEK_MAX_MS) * (t - 0.5) / 1.5;
    return { seq: Math.round(seqMs * fs / 1000), seek: Math.round(seekMs * fs / 1000) };
  }

  appendInput(input, n) {
    if (this.inEnd + n > this.inCap) this.compactInput();
    for (let c = 0; c < this.channels; c++) {
      const src = input[c] || input[0];
      const dst = this.inBuf[c];
      if (src) dst.set(src.subarray(0, n), this.inEnd);
      else dst.fill(0, this.inEnd, this.inEnd + n);
    }
    this.inEnd += n;
  }

  compactInput() {
    const pending = this.inStart - this.inEnd;
    if (pending >= 0) { this.inEnd = 0; this.inStart = pending; return; }
    for (let c = 0; c < this.channels; c++) this.inBuf[c].copyWithin(0, this.inStart, this.inEnd);
    this.inEnd -= this.inStart;
    this.inStart = 0;
  }

  compactStretched() {
    const keepFrom = Math.floor(this.rsPos) - 1;
    if (keepFrom <= 0) return;
    for (let c = 0; c < this.channels; c++) this.stBuf[c].copyWithin(0, keepFrom, this.stEnd);
    this.stEnd -= keepFrom;
    this.rsPos -= keepFrom;
  }

  // Where, within the search window, does the input best continue the previous segment's tail?
  // Normalised cross-correlation on the mono mix; the same offset is used for both channels.
  bestOffset(seek) {
    const ovl = this.overlap, mix = this.mix, midMix = this.midMix, base = this.inStart;
    const L = this.inBuf[0], R = this.inBuf[1];
    for (let k = 0; k < seek + ovl; k++) mix[k] = 0.5 * (L[base + k] + R[base + k]);
    let norm = 0;
    for (let j = 0; j < ovl; j++) norm += mix[j] * mix[j];
    let best = 0, bestVal = -Infinity;
    for (let i = 0; i < seek; i++) {
      let corr = 0;
      for (let j = 0; j < ovl; j++) corr += mix[i + j] * midMix[j];
      const val = norm > 1e-9 ? corr / Math.sqrt(norm) : 0;
      if (val > bestVal) { bestVal = val; best = i; }
      norm += mix[i + ovl] * mix[i + ovl] - mix[i] * mix[i];
    }
    return best;
  }

  // One segment: crossfade in from the previous tail, copy the body, remember the new tail,
  // then move on through the input by tempo * (segment - overlap) samples.
  stretchOnce(seq, tempo) {
    const ovl = this.overlap;
    const seek = Math.max(1, Math.min(this.maxSeek, this.inEnd - this.inStart - seq));
    const base = this.inStart + this.bestOffset(seek);
    for (let c = 0; c < this.channels; c++) {
      const ib = this.inBuf[c], mb = this.mid[c], ob = this.stBuf[c];
      let o = this.stEnd;
      for (let j = 0; j < ovl; j++) { const f = j / ovl; ob[o++] = mb[j] + (ib[base + j] - mb[j]) * f; }
      ob.set(ib.subarray(base + ovl, base + seq - ovl), o);
      mb.set(ib.subarray(base + seq - ovl, base + seq));
    }
    for (let j = 0; j < ovl; j++) this.midMix[j] = 0.5 * (this.mid[0][j] + this.mid[1][j]);
    this.stEnd += seq - ovl;
    this.skipFract += tempo * (seq - ovl);
    const skip = Math.floor(this.skipFract);
    this.skipFract -= skip;
    this.inStart += skip;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const n = output[0].length;
    if (parameters.semitones[0] === 0) {
      if (!this.parked) { this.reset(); this.parked = true; }
      for (let c = 0; c < output.length; c++) output[c].fill(0);
      return true;
    }
    this.parked = false;
    const ratio = Math.pow(2, parameters.semitones[0] / 12);
    const tempo = 1 / ratio;
    const { seq, seek } = this.lengths(tempo);
    const ovl = this.overlap;

    this.appendInput(inputs[0] || [], n);
    if (Math.floor(this.rsPos) > this.stCap / 2) this.compactStretched();

    // Keep `target` stretched samples in hand. Full segments whenever the input allows; starved of input
    // right after a change of shift, a shorter segment with a smaller step keeps the output alive while
    // the input backlog rebuilds; a large backlog is worked off with larger steps. Either is a brief,
    // tiny wobble of the time base, never a gap.
    const target = CUSHION + Math.ceil(n * ratio) + 4;
    const emergency = 2 * Math.ceil(n * ratio) + 4;
    const minSeq = 4 * ovl;
    for (let guard = 0; guard < 6; guard++) {
      const occupancy = this.stEnd - this.rsPos;
      const available = this.inEnd - this.inStart;
      let seqUse = 0, step = 1;
      if (available >= seq + seek) {
        if (occupancy < target || !this.primed) seqUse = seq;
        else if (available >= seq + seek + (seq - ovl)) { seqUse = seq; step = 1.5; }
        else break;
      } else if (this.primed && occupancy < emergency && available >= minSeq + seek) {
        seqUse = Math.min(seq, available - seek); step = 0.5;
      } else break;
      if (this.stEnd + seqUse > this.stCap) this.compactStretched();
      if (this.stEnd + seqUse > this.stCap) break;
      this.stretchOnce(seqUse, tempo * step);
      if (!this.primed) break; // one segment per block before the first read, so the input lead builds up
    }

    // Start reading once enough is in hand and the input will be ready for the next full segment in time.
    if (!this.primed) {
      const occupancy = this.stEnd - this.rsPos;
      const available = this.inEnd - this.inStart;
      if (occupancy >= target && available >= seq + seek - (occupancy - target) * tempo) this.setPrimed(true);
      else { for (let c = 0; c < output.length; c++) output[c].fill(0); return true; }
    }

    // Read the stretched audio out at the pitch ratio (4-point cubic interpolation).
    for (let k = 0; k < n; k++) {
      const i = Math.floor(this.rsPos);
      if (i + 2 >= this.stEnd) { // ran dry: silence for the rest of this block, then start again
        for (let c = 0; c < output.length; c++) output[c].fill(0, k);
        this.setPrimed(false); // the graph switches to the unshifted path until it is primed again
        break;
      }
      const f = this.rsPos - i;
      for (let c = 0; c < output.length; c++) {
        const b = this.stBuf[Math.min(c, this.channels - 1)];
        const y0 = b[i - 1], y1 = b[i], y2 = b[i + 1], y3 = b[i + 2];
        const c1 = 0.5 * (y2 - y0), c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3, c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
        output[c][k] = ((c3 * f + c2) * f + c1) * f + y1;
      }
      this.rsPos += ratio;
    }
    return true;
  }
}

registerProcessor('pitch-shifter', PitchShifterProcessor);
