// dynamics.worklet.js - The alternative dynamics stages (1.5.0, decision D-01), each an AudioWorkletProcessor:
//
//   band-leveler       a leveler that acts only below 150 Hz: the "Bass only" mode of the AUTO stage
//   loudness-match     trims the gain so the processed music is as loud as the untouched tab: the MATCH stage
//   lookahead-limiter  a peak limiter that sees 5 ms ahead and never lets a sample over its ceiling: the "Look-ahead" mode
//
// None of them is in the signal path unless its mode is selected (offscreen.js routes around them with gains), so the
// default chain is the 1.4.0 chain unchanged. Each posts its working figure to the main thread every ~40 ms for the meters.

const METER_BLOCKS = 16; // 16 x 128 frames = 43 ms at 48 kHz

// ---- RBJ biquads (Direct Form I, one state per channel) ----
function coefs(type, f0, Q, fs, gainDb = 0) {
  const w0 = 2 * Math.PI * f0 / fs;
  const cosw = Math.cos(w0), sinw = Math.sin(w0);
  const alpha = sinw / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass') {
    b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2;
    a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
  } else if (type === 'highpass') {
    b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2;
    a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
  } else { // highshelf
    const A = Math.pow(10, gainDb / 40), sA = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) + (A - 1) * cosw + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cosw); b2 = A * ((A + 1) + (A - 1) * cosw - sA);
    a0 = (A + 1) - (A - 1) * cosw + sA; a1 = 2 * ((A - 1) - (A + 1) * cosw); a2 = (A + 1) - (A - 1) * cosw - sA;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

class Biquad {
  constructor(c) { this.c = c; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  run(x) {
    const c = this.c;
    const y = c.b0 * x + c.b1 * this.x1 + c.b2 * this.x2 - c.a1 * this.y1 - c.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

const onePole = (seconds) => 1 - Math.exp(-1 / (seconds * sampleRate));
const dbOf = (ms) => 10 * Math.log10(ms + 1e-20);

// ---- Bass-only leveler ----
// Linkwitz-Riley 4th-order crossover at 150 Hz (two Butterworth sections per band); the two bands sum back flat.
// The low band drives a soft-knee gain computer (threshold -20 dBFS RMS, knee 20 dB, ratio 3.5:1, attack 10 ms,
// release 200 ms, detector 30 ms) and only the low band is turned down. No makeup gain: it never adds loudness.
const XOVER_HZ = 150;
class BandLeveler extends AudioWorkletProcessor {
  constructor() {
    super();
    const lp = coefs('lowpass', XOVER_HZ, Math.SQRT1_2, sampleRate);
    const hp = coefs('highpass', XOVER_HZ, Math.SQRT1_2, sampleRate);
    this.lp = [[new Biquad(lp), new Biquad(lp)], [new Biquad(lp), new Biquad(lp)]];
    this.hp = [[new Biquad(hp), new Biquad(hp)], [new Biquad(hp), new Biquad(hp)]];
    this.ms = 0;
    this.aDet = onePole(0.03);
    this.aAtt = onePole(0.01);
    this.aRel = onePole(0.2);
    this.T = -20; this.W = 20; this.R = 3.5;
    this.redDb = 0; // current reduction, <= 0
    this.meterMax = 0; this.blocks = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    const oL = output[0], oR = output[1] || output[0];
    if (!input || input.length === 0) { oL.fill(0); if (oR !== oL) oR.fill(0); this.tick(0); return true; }
    const L = input[0], R = input[1] || input[0];
    const slope = 1 / this.R - 1;
    let maxRed = 0;
    for (let n = 0; n < L.length; n++) {
      const lowL = this.lp[0][1].run(this.lp[0][0].run(L[n]));
      const lowR = this.lp[1][1].run(this.lp[1][0].run(R[n]));
      const highL = this.hp[0][1].run(this.hp[0][0].run(L[n]));
      const highR = this.hp[1][1].run(this.hp[1][0].run(R[n]));
      const m = 0.5 * (lowL + lowR);
      this.ms += (m * m - this.ms) * this.aDet;
      const over = dbOf(this.ms) - this.T;
      let red = 0;
      if (2 * over > this.W) red = slope * over;
      else if (2 * over >= -this.W) { const k = over + this.W / 2; red = slope * k * k / (2 * this.W); }
      this.redDb += (red - this.redDb) * (red < this.redDb ? this.aAtt : this.aRel);
      const g = Math.pow(10, this.redDb / 20);
      oL[n] = highL + lowL * g;
      if (oR !== oL) oR[n] = highR + lowR * g;
      if (-this.redDb > maxRed) maxRed = -this.redDb;
    }
    this.tick(maxRed);
    return true;
  }
  tick(red) {
    if (red > this.meterMax) this.meterMax = red;
    if (++this.blocks >= METER_BLOCKS) { this.port.postMessage({ red: this.meterMax }); this.meterMax = 0; this.blocks = 0; }
  }
}

// ---- Loudness match ----
// Input 0: the processed signal (after the leveler, before Master Volume). Input 1: the untouched signal (before the
// HPF). Both are measured with the K-weighting of ITU-R BS.1770 (the measure streaming services use) over about 3 s,
// and the output is input 0 scaled so the two loudnesses agree; the scale moves slowly (0.4 s) and stays within
// -14 .. +6 dB. In silence the last value is held.
class LoudnessMatch extends AudioWorkletProcessor {
  constructor() {
    super();
    const shelf = coefs('highshelf', 1681.974450955533, 0.7071752369554196, sampleRate, 3.999843853973347);
    const hpf = coefs('highpass', 38.13547087602444, 0.5003270373238773, sampleRate);
    const chain = () => [new Biquad(shelf), new Biquad(hpf)];
    this.kProc = [chain(), chain()];
    this.kRef = [chain(), chain()];
    this.msProc = 0; this.msRef = 0;
    this.aMs = onePole(1.5);
    this.aG = onePole(0.4);
    this.g = 1; this.targetDb = 0;
    this.blocks = 0;
  }
  weigh(chains, L, R, n) {
    const a = chains[0][1].run(chains[0][0].run(L[n]));
    const b = chains[1][1].run(chains[1][0].run(R[n]));
    return 0.5 * (a * a + b * b);
  }
  process(inputs, outputs) {
    const proc = inputs[0], ref = inputs[1], output = outputs[0];
    const oL = output[0], oR = output[1] || output[0];
    if (!proc || proc.length === 0) { oL.fill(0); if (oR !== oL) oR.fill(0); this.tick(); return true; }
    const pL = proc[0], pR = proc[1] || proc[0];
    const hasRef = ref && ref.length > 0;
    const rL = hasRef ? ref[0] : null, rR = hasRef ? (ref[1] || ref[0]) : null;
    for (let n = 0; n < pL.length; n++) {
      this.msProc += (this.weigh(this.kProc, pL, pR, n) - this.msProc) * this.aMs;
      if (hasRef) this.msRef += (this.weigh(this.kRef, rL, rR, n) - this.msRef) * this.aMs;
      const gT = Math.pow(10, this.targetDb / 20);
      this.g += (gT - this.g) * this.aG;
      oL[n] = pL[n] * this.g;
      if (oR !== oL) oR[n] = pR[n] * this.g;
    }
    // New target once per block (the averages move slowly); hold in silence.
    if (this.msRef > 1e-7 && this.msProc > 1e-7) {
      this.targetDb = Math.max(-14, Math.min(6, dbOf(this.msRef) - dbOf(this.msProc)));
    }
    this.tick();
    return true;
  }
  tick() {
    if (++this.blocks >= METER_BLOCKS) { this.port.postMessage({ trim: 20 * Math.log10(this.g) }); this.blocks = 0; }
  }
}

// ---- Look-ahead limiter ----
// The audio is delayed by L = 5 ms. For every incoming sample the gain that would keep it under the ceiling is computed;
// a sliding minimum over the last L+1 of those, a release of 80 ms that can only raise the gain slowly, and a moving
// average over L+1 samples give the gain applied to the delayed sample. Every term of that average is a minimum over a
// window that contains the delayed sample, so the applied gain is never above what that sample needs: no sample can
// exceed the ceiling, and the gain reaches each peak by a straight 5 ms ramp instead of a step.
const LA_CEILING = 0.93; // -0.63 dBFS: just under the point where the clean output ceiling starts to bend
class LookaheadLimiter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.L = Math.round(0.005 * sampleRate);
    const N = this.N = this.L + 1;
    this.dL = new Float32Array(N); this.dR = new Float32Array(N); this.dIdx = 0;
    // deque (ring). Sample indices are kept as doubles: an Int32Array wrapped after 2^31 samples (6.2 hours at 96 kHz) and
    // the expiry loop below then never ended, which stalled the whole audio engine (fixed in 1.5.2).
    this.qVal = new Float32Array(N + 1); this.qIdx = new Float64Array(N + 1); this.qHead = 0; this.qTail = 0;
    this.box = new Float64Array(N).fill(1); this.boxIdx = 0; this.boxSum = N;
    this.rel = 1; this.aRel = onePole(0.08);
    this.n = 0; this.since = 0;
    this.meterMin = 1; this.blocks = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    const oL = output[0], oR = output[1] || output[0];
    const silent = !input || input.length === 0;
    const L = silent ? null : input[0], R = silent ? null : (input[1] || input[0]);
    const N = this.N, cap = N + 1;
    let minG = 1;
    for (let i = 0; i < oL.length; i++) {
      const xL = silent ? 0 : L[i], xR = silent ? 0 : R[i];
      const peak = Math.max(Math.abs(xL), Math.abs(xR));
      const gT = peak > LA_CEILING ? LA_CEILING / peak : 1;
      // sliding minimum over the last N targets (monotonic deque)
      while (this.qTail !== this.qHead) {
        const back = (this.qTail - 1 + cap) % cap;
        if (this.qVal[back] >= gT) this.qTail = back; else break;
      }
      this.qVal[this.qTail] = gT; this.qIdx[this.qTail] = this.n; this.qTail = (this.qTail + 1) % cap;
      while (this.qIdx[this.qHead] <= this.n - N) this.qHead = (this.qHead + 1) % cap;
      const m = this.qVal[this.qHead];
      // release: fall at once, rise slowly
      this.rel = m < this.rel ? m : this.rel + (m - this.rel) * this.aRel;
      // moving average over N
      this.boxSum += this.rel - this.box[this.boxIdx];
      this.box[this.boxIdx] = this.rel;
      this.boxIdx = this.boxIdx + 1 === N ? 0 : this.boxIdx + 1;
      const g = this.boxSum / N;
      // delayed sample out, new sample in
      const yL = this.dL[this.dIdx] * g, yR = this.dR[this.dIdx] * g;
      this.dL[this.dIdx] = xL; this.dR[this.dIdx] = xR;
      this.dIdx = this.dIdx + 1 === N ? 0 : this.dIdx + 1;
      oL[i] = yL; if (oR !== oL) oR[i] = yR;
      if (g < minG) minG = g;
      this.n++;
    }
    // re-sum the window now and then so rounding cannot drift the average
    if (++this.since >= 2048) { let s = 0; for (let k = 0; k < N; k++) s += this.box[k]; this.boxSum = s; this.since = 0; }
    if (minG < this.meterMin) this.meterMin = minG;
    if (++this.blocks >= METER_BLOCKS) { this.port.postMessage({ red: -20 * Math.log10(this.meterMin) }); this.meterMin = 1; this.blocks = 0; }
    return true;
  }
}

registerProcessor('band-leveler', BandLeveler);
registerProcessor('loudness-match', LoudnessMatch);
registerProcessor('lookahead-limiter', LookaheadLimiter);
