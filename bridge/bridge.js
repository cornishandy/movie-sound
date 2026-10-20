// Standalone movie DSP bridge.
// Signal chain and factory presets are the frozen 1.5.4/1.5.5 path from
// tidal-miniplayer-extension (read-only source). This file does not import
// that extension. Nothing here opens a device until the page calls start().

export const FACTORY_PRESETS = {
  'Punchy Bass & Clarity': { bass: 5.0, hpf: 30, mid: 1.5, high: 2.0, gain: 1.0, semitones: 0, autoBalance: true },
  'Clean DJ (Anti-Distortion)': { bass: 4.5, hpf: 35, mid: 1.0, high: 2.5, gain: 1.0, semitones: 0, autoBalance: true },
  'Deep Sub-Bass (Dub/Trap)': { bass: 8.0, hpf: 25, mid: 0.0, high: 1.0, gain: 1.0, semitones: 0, autoBalance: true },
  'Club / Festival Bangers': { bass: 7.0, hpf: 32, mid: 2.0, high: 3.5, gain: 1.0, semitones: 0, autoBalance: true },
  'Audiophile Clean (Flat Bass)': { bass: 2.0, hpf: 20, mid: 0.5, high: 1.5, gain: 1.0, semitones: 0, autoBalance: false },
  'Late Night Movies & Dialogue': { bass: 3.5, hpf: 45, mid: 3.0, high: 1.0, gain: 1.0, semitones: 0, autoBalance: true },
  'Acoustic & Live': { bass: 3.0, hpf: 40, mid: 2.0, high: 3.0, gain: 1.0, semitones: 0, autoBalance: false },
  'Flat (Bypass)': { bass: 0.0, hpf: 20, mid: 0.0, high: 0.0, gain: 1.0, semitones: 0, autoBalance: false, bypass: true }
};

// chrome-settings.js (a plain script loaded before this module) sets CHROME_AUDIO_SETTINGS. Absent = factory behaviour.
const CHROME_AUDIO = (typeof globalThis !== 'undefined' && globalThis.CHROME_AUDIO_SETTINGS) || {};
const CHROME_PRESETS = CHROME_AUDIO.presets || {};
const CHROME_STARTUP = CHROME_AUDIO.startup || null;

export const DEFAULT_PRESET_NAME = 'Late Night Movies & Dialogue';
export const DEFAULT_DYNAMICS = { leveler: 'full', match: false, limiter: 'fast', ceiling: 'clean' };

export const DSP_SPEC = {
  chain: [
    'HPF',
    '3-band EQ',
    'Auto-Balance / Bass-only Leveler',
    'Loudness Match',
    'Fast / Look-ahead Limiter',
    'Clean / Warm Ceiling'
  ],
  hpf: { type: 'highpass', Q: 0.707 },
  bass: { type: 'lowshelf', frequency: 120 },
  mid: { type: 'peaking', frequency: 1000, Q: 0.8 },
  high: { type: 'highshelf', frequency: 5000 },
  autoBalance: { threshold: -18, knee: 20, ratio: 3.5, attack: 0.01, release: 0.2, slowRelease: 0.6 },
  limiter: { threshold: -0.3, knee: 0, ratio: 20, attack: 0.001, release: 0.05 },
  ceilingKnee: 0.93,
  ceilingMax: 0.966,
  warmPreGain: 0.5,
  warmOversample: '4x',
  sampleRate: 96000
};

export const CEILING_KNEE = DSP_SPEC.ceilingKnee;
export const CEILING_MAX = DSP_SPEC.ceilingMax;

export function audioContextOptions(movieMode) {
  return movieMode
    ? { latencyHint: 'interactive', sampleRate: 96000 }
    : { latencyHint: 'playback', sampleRate: 96000 };
}

export function createMovieAudioContext(movieMode) {
  const options = audioContextOptions(movieMode !== false);
  if (options.latencyHint === 'interactive') {
    return new AudioContext({ latencyHint: 'interactive', sampleRate: 96000 });
  }
  return new AudioContext({ latencyHint: 'playback', sampleRate: 96000 });
}

export function createMovieAudioContextWithFallback(movieMode) {
  try {
    return createMovieAudioContext(movieMode);
  } catch (err) {
    const hint = movieMode !== false ? 'interactive' : 'playback';
    return new AudioContext({ latencyHint: hint });
  }
}

export function isBlackHoleDevice(device) {
  const label = String(device && device.label || '');
  const id = String(device && device.deviceId || '');
  return /blackhole/i.test(label) || /blackhole/i.test(id);
}

export function isMutableAliasId(id) {
  const text = id == null ? '' : String(id);
  return text === '' || text === 'default' || text === 'communications';
}

function isBlackHole2ch(device) {
  return /blackhole\s*2ch/i.test(String(device && device.label || ''));
}

function aliasLabelTarget(label) {
  return String(label || '').replace(/^\s*(default|communications)\s*[-–—:]\s*/i, '').trim();
}

function concreteOutputs(outputs) {
  return outputs.filter((device) => device && !isMutableAliasId(device.deviceId) && !isBlackHoleDevice(device));
}

function resolveAliasOutput(alias, concrete) {
  if (!alias) return null;
  const wanted = aliasLabelTarget(alias.label).toLowerCase();
  if (wanted) {
    const exact = concrete.find((device) => String(device.label || '').trim().toLowerCase() === wanted);
    if (exact) return exact;
  }
  if (isIfiProIdsd(alias)) return concrete.find((device) => isIfiProIdsd(device)) || null;
  return null;
}

export function isIfiProIdsd(device) {
  const label = String(device && device.label || '');
  return /ifi/i.test(label) && /idsd/i.test(label);
}

export function isPhysicalMicrophone(device) {
  return !!device && device.kind === 'audioinput' && !isBlackHoleDevice(device);
}

function pickInputDevice(inputs, options) {
  const requested = options.inputDeviceId;
  if (requested && !isMutableAliasId(requested)) {
    const chosen = inputs.find((d) => d.deviceId === requested) || null;
    if (!chosen) return { error: 'Selected input device was not found.' };
    if (!isBlackHoleDevice(chosen) && options.allowMicrophone !== true) {
      return { error: 'Refusing to capture a physical microphone without an explicit override.', refusedMicrophone: true };
    }
    return { device: chosen };
  }
  // Skip Chrome's "Default - BlackHole 2ch" alias: it follows the macOS default input, which may be a real mic.
  const exact = inputs.find((d) => isBlackHole2ch(d) && !isMutableAliasId(d.deviceId)) || null;
  if (!exact) {
    return {
      error: 'BlackHole 2ch is not available. Refusing to open a physical microphone.',
      refusedMicrophone: inputs.some(isPhysicalMicrophone)
    };
  }
  return { device: exact };
}

function pickOutputDevice(outputs, options) {
  const concrete = concreteOutputs(outputs);
  const requested = options.outputDeviceId;
  if (requested && !isMutableAliasId(requested)) {
    const chosen = outputs.find((d) => d.deviceId === requested) || null;
    if (!chosen || isMutableAliasId(chosen.deviceId)) {
      return { error: 'Selected output device was not found.', needsOutput: true };
    }
    if (isBlackHoleDevice(chosen)) {
      return {
        error: 'Input and output are both BlackHole. Refusing to start (that loop feeds the DAC back into itself).',
        feedbackLoop: true
      };
    }
    return { device: chosen };
  }
  if (requested && isMutableAliasId(requested)) {
    const alias = outputs.find((d) => d.deviceId === requested) || null;
    const resolved = resolveAliasOutput(alias, concrete);
    if (!resolved) {
      return {
        error: 'Refusing the mutable default output. No concrete hardware device matches that alias.',
        needsOutput: true
      };
    }
    return { device: resolved };
  }
  const ifi = concrete.find((d) => isIfiProIdsd(d)) || null;
  if (!ifi) {
    return {
      error: 'iFi Pro iDSD was not found. Choose a non-BlackHole output before starting.',
      needsOutput: true
    };
  }
  return { device: ifi };
}

export function planCapture(devices, options = {}) {
  const list = Array.isArray(devices) ? devices : [];
  const inputs = list.filter((d) => d && d.kind === 'audioinput');
  const outputs = list.filter((d) => d && d.kind === 'audiooutput');
  const inputPick = pickInputDevice(inputs, options);
  if (!inputPick.device) return { ok: false, ...inputPick };
  const outputPick = pickOutputDevice(outputs, options);
  if (!outputPick.device) return { ok: false, ...outputPick };
  if (isBlackHoleDevice(inputPick.device) && isBlackHoleDevice(outputPick.device)) {
    return {
      ok: false,
      error: 'Input and output are both BlackHole. Refusing to start (that loop feeds the DAC back into itself).',
      feedbackLoop: true
    };
  }
  const movieMode = options.movieMode !== false;
  return {
    ok: true,
    inputDeviceId: inputPick.device.deviceId,
    outputDeviceId: outputPick.device.deviceId,
    inputLabel: inputPick.device.label || '',
    outputLabel: outputPick.device.label || '',
    movieMode,
    latencyHint: movieMode ? 'interactive' : 'playback',
    sampleRate: 96000,
    constraints: {
      audio: {
        deviceId: { exact: inputPick.device.deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2
      },
      video: false
    }
  };
}

export function captureMustStop(devices, inputDeviceId, allowMicrophone, outputDeviceId) {
  // Older callers pass allowMicrophone as the third argument. A string there is a pinned output id.
  let allowMic = false;
  let pinnedOutput = outputDeviceId;
  if (typeof allowMicrophone === 'string') {
    pinnedOutput = allowMicrophone;
    allowMic = false;
  } else {
    allowMic = allowMicrophone === true;
  }
  const list = Array.isArray(devices) ? devices : [];
  const found = list.find((d) => d && d.kind === 'audioinput' && d.deviceId === inputDeviceId);
  if (!found) return { stop: true, reason: 'BlackHole input disappeared. Capture stopped.' };
  if (!allowMic && found.label && !isBlackHoleDevice(found)) {
    return { stop: true, reason: 'Input is no longer BlackHole. Capture stopped so a microphone is not used.' };
  }
  const outputGone = {
    stop: true,
    reason: 'Pinned output sink disappeared. Capture stopped so audio does not fall back to the macOS default output.'
  };
  if (pinnedOutput == null || isMutableAliasId(pinnedOutput)) return outputGone;
  const output = list.find((d) => d && d.kind === 'audiooutput' && d.deviceId === pinnedOutput);
  if (!output || isMutableAliasId(output.deviceId) || isBlackHoleDevice(output)) return outputGone;
  return { stop: false };
}

export function latencyReadout(ctx) {
  if (!ctx) return { baseLatency: null, outputLatency: null, totalMs: null, sampleRate: null };
  const base = Number(ctx.baseLatency);
  const out = Number(ctx.outputLatency);
  const baseOk = Number.isFinite(base) ? base : 0;
  const outOk = Number.isFinite(out) ? out : 0;
  return {
    baseLatency: Number.isFinite(base) ? base : null,
    outputLatency: Number.isFinite(out) ? out : null,
    totalMs: Math.round((baseOk + outOk) * 1000),
    sampleRate: ctx.sampleRate || null
  };
}

export function makeCeilingCurve(points = 8193) {
  const curve = new Float32Array(points);
  const span = CEILING_MAX - CEILING_KNEE;
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    const ax = Math.abs(x);
    const y = ax <= CEILING_KNEE ? ax : CEILING_KNEE + span * Math.tanh((ax - CEILING_KNEE) / span);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

export function makeWarmCurve(points = 8193) {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    curve[i] = CEILING_MAX * Math.tanh(2 * x / CEILING_MAX);
  }
  return curve;
}

export function normaliseDynamics(d) {
  const x = d || {};
  return {
    leveler: ['full', 'slow', 'bass'].includes(x.leveler) ? x.leveler : 'full',
    match: x.match === true,
    limiter: ['fast', 'lookahead'].includes(x.limiter) ? x.limiter : 'fast',
    ceiling: ['clean', 'warm'].includes(x.ceiling) ? x.ceiling : 'clean'
  };
}

// Andy's saved presets and current settings from the Chrome extension (tools/import-chrome-audio-settings.mjs).
export const STARTUP_PRESET_NAME = (CHROME_STARTUP && (Object.prototype.hasOwnProperty.call(CHROME_PRESETS, CHROME_STARTUP.preset) || Object.prototype.hasOwnProperty.call(FACTORY_PRESETS, CHROME_STARTUP.preset)))
  ? CHROME_STARTUP.preset
  : DEFAULT_PRESET_NAME;
export const STARTUP_DYNAMICS = normaliseDynamics({ ...DEFAULT_DYNAMICS, ...((CHROME_STARTUP && CHROME_STARTUP.dynamics) || {}) });

const own = (obj, key) => !!obj && typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);
// Presets the Tidal extension sent while following (name -> effective values, no prototype). Null until then.
let liveChromePresets = null;

export function presetParams(name) {
  // Own properties only, so a preset called "constructor" can't reach Object.prototype.
  // Chrome's own copy of a name wins: it's what the extension plays when you pick that name.
  const chrome = liveChromePresets || CHROME_PRESETS;
  const src = own(chrome, name) ? chrome[name] : own(FACTORY_PRESETS, name) ? FACTORY_PRESETS[name] : FACTORY_PRESETS[DEFAULT_PRESET_NAME];
  return {
    bass: src.bass,
    hpf: src.hpf,
    mid: src.mid,
    high: src.high,
    gain: src.gain,
    semitones: src.semitones,
    autoBalance: src.autoBalance !== false,
    bypass: src.bypass === true
  };
}

// ---- Following the Tidal extension's EQ live (its movie-sound-link.js posts to this page) ----

// The extension's slider ranges (popup.html; Bass 0..28 and Mid/High -12..12 since extension 1.5.8 / Movie Sound 1.1.1).
// A value outside them is refused, never clamped.
export const CHROME_PARAM_RANGES = { bass: [0, 28], hpf: [20, 200], mid: [-12, 12], high: [-12, 12], gain: [0.5, 2.5], semitones: [-12, 12] };
const DYNAMICS_CHOICES = { leveler: ['full', 'slow', 'bass'], limiter: ['fast', 'lookahead'], ceiling: ['clean', 'warm'] };
const isPlainObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

// Checked before chromeEffectiveParams, whose `|| 30`-style defaults would otherwise turn a broken value into a different sound.
export function validChromeParams(p) {
  if (!isPlainObject(p)) return false;
  for (const [key, [lo, hi]] of Object.entries(CHROME_PARAM_RANGES)) {
    if (key === 'semitones' && !own(p, key)) continue; // presets saved before pitch existed
    const v = p[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) return false;
  }
  for (const key of ['autoBalance', 'bypass']) {
    if (own(p, key) && typeof p[key] !== 'boolean') return false;
  }
  if (own(p, 'stageBypass') && p.stageBypass != null) {
    if (!isPlainObject(p.stageBypass)) return false;
    if (Object.values(p.stageBypass).some((v) => typeof v !== 'boolean')) return false;
  }
  return true;
}

export function validChromeDynamics(d) {
  if (d == null) return true; // never saved: the defaults apply, as in the extension
  if (!isPlainObject(d)) return false;
  for (const [key, choices] of Object.entries(DYNAMICS_CHOICES)) {
    if (own(d, key) && !choices.includes(d[key])) return false;
  }
  return !own(d, 'match') || typeof d.match === 'boolean';
}

// The sound a saved setting makes, with the extension's stage switches applied the way offscreen.js applies them
// (HPF off = 20 Hz, EQ band off = 0 dB, gain off = 1, pitch off = 0 semitones, comp off = no auto-balance).
// tools/import-chrome-audio-settings.mjs uses this too.
export function chromeEffectiveParams(p) {
  const round = (n) => Math.round(Number(n) * 1000) / 1000;
  const b = p.stageBypass || {};
  const off = {
    hpf: !!b.hpf,
    bass: !!(b.bass || b.eq),
    mid: !!(b.mid || b.eq),
    high: !!(b.high || b.eq),
    comp: !!b.comp || p.autoBalance === false,
    gain: !!b.gain,
    pitch: !!(b.pitch || b.speed)
  };
  const st = Number(p.semitones);
  return {
    bass: off.bass ? 0 : round(p.bass || 0),
    hpf: off.hpf ? 20 : round(p.hpf || 30),
    mid: off.mid ? 0 : round(p.mid || 0),
    high: off.high ? 0 : round(p.high || 0),
    gain: off.gain ? 1 : round(p.gain || 1),
    semitones: off.pitch || !isFinite(st) ? 0 : Math.max(-12, Math.min(12, st)),
    autoBalance: !off.comp,
    bypass: p.bypass === true
  };
}

const soundKey = (params, dynamics) => JSON.stringify([params, dynamics]);

// Turns one message from the extension into the sound to play, or says why not. Nothing here touches audio.
// Pitch is always off: Movie Sound plays films, and the extension itself locks pitch off for video (its movie mode).
export function chromeFollowCandidate(msg) {
  if (!isPlainObject(msg)) return { ok: false, reason: 'not an object' };
  if (!validChromeParams(msg.currentParams)) return { ok: false, reason: 'current settings out of range or malformed' };
  if (!validChromeDynamics(msg.dynamics)) return { ok: false, reason: 'dynamics malformed' };
  const presets = Object.create(null);
  let dropped = 0;
  if (isPlainObject(msg.presets)) {
    for (const name of Object.keys(msg.presets)) {
      if (validChromeParams(msg.presets[name])) presets[name] = { ...chromeEffectiveParams(msg.presets[name]), semitones: 0 };
      else dropped += 1;
    }
  }
  const presetName = typeof msg.currentPreset === 'string' ? msg.currentPreset : null;
  const chromeParams = chromeEffectiveParams(msg.currentParams);
  const params = { ...chromeParams, semitones: 0 };
  const dynamics = normaliseDynamics(msg.dynamics);
  const named = presetName !== null && own(presets, presetName);
  return {
    ok: true,
    presets,
    dropped,
    presetName,
    modified: !named || JSON.stringify(presets[presetName]) !== JSON.stringify(params),
    pitchDropped: chromeParams.semitones !== 0,
    params,
    dynamics
  };
}

function wireGraph(ctx, source, params, dynamics, meters) {
  const dyn = normaliseDynamics(dynamics);
  const off = {
    hpf: false,
    bass: false,
    mid: false,
    high: false,
    comp: params.autoBalance === false,
    gain: false,
    pitch: false
  };

  const pitchDryGain = ctx.createGain();
  const pitchWetGain = ctx.createGain();
  const directPassThroughGain = ctx.createGain();
  const dspPathGain = ctx.createGain();

  const hpfNode = ctx.createBiquadFilter();
  hpfNode.type = DSP_SPEC.hpf.type;
  hpfNode.frequency.value = off.hpf ? 20 : params.hpf;
  hpfNode.Q.value = DSP_SPEC.hpf.Q;

  const bassNode = ctx.createBiquadFilter();
  bassNode.type = DSP_SPEC.bass.type;
  bassNode.frequency.value = DSP_SPEC.bass.frequency;
  bassNode.gain.value = off.bass ? 0 : params.bass;

  const midNode = ctx.createBiquadFilter();
  midNode.type = DSP_SPEC.mid.type;
  midNode.frequency.value = DSP_SPEC.mid.frequency;
  midNode.Q.value = DSP_SPEC.mid.Q;
  midNode.gain.value = off.mid ? 0 : params.mid;

  const highNode = ctx.createBiquadFilter();
  highNode.type = DSP_SPEC.high.type;
  highNode.frequency.value = DSP_SPEC.high.frequency;
  highNode.gain.value = off.high ? 0 : params.high;

  const autoBalanceComp = ctx.createDynamicsCompressor();
  autoBalanceComp.threshold.value = DSP_SPEC.autoBalance.threshold;
  autoBalanceComp.knee.value = DSP_SPEC.autoBalance.knee;
  autoBalanceComp.ratio.value = DSP_SPEC.autoBalance.ratio;
  autoBalanceComp.attack.value = DSP_SPEC.autoBalance.attack;
  autoBalanceComp.release.value = dyn.leveler === 'slow' ? DSP_SPEC.autoBalance.slowRelease : DSP_SPEC.autoBalance.release;

  const autoBalanceBypassGain = ctx.createGain();
  const autoBalanceWetGain = ctx.createGain();
  const levelerOut = ctx.createGain();
  const bandLevelerGain = ctx.createGain();

  const matchDryGain = ctx.createGain();
  const matchWetGain = ctx.createGain();
  const volumeGain = ctx.createGain();
  volumeGain.gain.value = off.gain ? 1 : params.gain;

  const masterLimiter = ctx.createDynamicsCompressor();
  masterLimiter.threshold.value = DSP_SPEC.limiter.threshold;
  masterLimiter.knee.value = DSP_SPEC.limiter.knee;
  masterLimiter.ratio.value = DSP_SPEC.limiter.ratio;
  masterLimiter.attack.value = DSP_SPEC.limiter.attack;
  masterLimiter.release.value = DSP_SPEC.limiter.release;

  const limiterFastGain = ctx.createGain();
  const lookaheadGain = ctx.createGain();
  const limiterOut = ctx.createGain();

  const outputCeiling = ctx.createWaveShaper();
  outputCeiling.curve = makeCeilingCurve();
  outputCeiling.oversample = 'none';
  const ceilingCleanGain = ctx.createGain();
  const ceilingWarmGain = ctx.createGain();
  const warmPreGain = ctx.createGain();
  warmPreGain.gain.value = DSP_SPEC.warmPreGain;
  const warmShaper = ctx.createWaveShaper();
  warmShaper.curve = makeWarmCurve();
  warmShaper.oversample = DSP_SPEC.warmOversample;
  const outputSum = ctx.createGain();

  const ceilingTap = ctx.createAnalyser();
  ceilingTap.fftSize = 4096;
  ceilingTap.smoothingTimeConstant = 0;
  const inputAnalyser = ctx.createAnalyser();
  inputAnalyser.fftSize = 8192;
  inputAnalyser.smoothingTimeConstant = 0.75;
  const outputAnalyser = ctx.createAnalyser();
  outputAnalyser.fftSize = 8192;
  outputAnalyser.smoothingTimeConstant = 0.75;

  let pitchNode = null;
  let bandLevelerNode = null;
  let matchNode = null;
  let lookaheadNode = null;
  const makeDyn = (name, numberOfInputs) => {
    try {
      const node = new AudioWorkletNode(ctx, name, {
        numberOfInputs,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit'
      });
      node.port.onmessage = (event) => {
        const data = event.data || {};
        if (name === 'band-leveler' && typeof data.red === 'number') meters.band = data.red;
        if (name === 'lookahead-limiter' && typeof data.red === 'number') meters.lookahead = data.red;
        if (name === 'loudness-match' && typeof data.trim === 'number') meters.trim = data.trim;
      };
      return node;
    } catch (err) {
      meters.error = err.message;
      return null;
    }
  };
  if (meters.worklets) {
    try { pitchNode = new AudioWorkletNode(ctx, 'pitch-shifter'); } catch (err) { meters.error = err.message; }
    bandLevelerNode = makeDyn('band-leveler', 1);
    matchNode = makeDyn('loudness-match', 2);
    lookaheadNode = makeDyn('lookahead-limiter', 1);
  }

  source.connect(directPassThroughGain);
  source.connect(dspPathGain);
  dspPathGain.connect(pitchDryGain);
  pitchDryGain.connect(hpfNode);
  if (pitchNode) {
    dspPathGain.connect(pitchNode);
    pitchNode.connect(pitchWetGain);
    pitchWetGain.connect(hpfNode);
    const shift = Math.abs(Number(params.semitones) || 0) >= 0.05 ? Number(params.semitones) : 0;
    try { pitchNode.parameters.get('semitones').value = shift; } catch (err) { meters.error = err.message; }
  }
  hpfNode.connect(bassNode);
  bassNode.connect(midNode);
  midNode.connect(highNode);
  highNode.connect(autoBalanceComp);
  autoBalanceComp.connect(autoBalanceWetGain);
  autoBalanceWetGain.connect(levelerOut);
  highNode.connect(autoBalanceBypassGain);
  autoBalanceBypassGain.connect(levelerOut);
  if (bandLevelerNode) {
    highNode.connect(bandLevelerNode);
    bandLevelerNode.connect(bandLevelerGain);
    bandLevelerGain.connect(levelerOut);
  }
  levelerOut.connect(matchDryGain);
  matchDryGain.connect(volumeGain);
  if (matchNode) {
    levelerOut.connect(matchNode, 0, 0);
    pitchDryGain.connect(matchNode, 0, 1);
    if (pitchNode) pitchWetGain.connect(matchNode, 0, 1);
    matchNode.connect(matchWetGain);
    matchWetGain.connect(volumeGain);
  }
  volumeGain.connect(masterLimiter);
  masterLimiter.connect(limiterFastGain);
  limiterFastGain.connect(limiterOut);
  if (lookaheadNode) {
    volumeGain.connect(lookaheadNode);
    lookaheadNode.connect(lookaheadGain);
    lookaheadGain.connect(limiterOut);
  }
  limiterOut.connect(outputCeiling);
  outputCeiling.connect(ceilingCleanGain);
  ceilingCleanGain.connect(outputSum);
  limiterOut.connect(warmPreGain);
  warmPreGain.connect(warmShaper);
  warmShaper.connect(ceilingWarmGain);
  ceilingWarmGain.connect(outputSum);
  limiterOut.connect(ceilingTap);
  source.connect(inputAnalyser);
  outputSum.connect(outputAnalyser);
  outputSum.connect(ctx.destination);
  directPassThroughGain.connect(ctx.destination);

  const graph = {
    autoBalanceComp,
    masterLimiter,
    inputAnalyser,
    outputAnalyser,
    ceilingTap,
    hpf: hpfNode,
    input: hpfNode,
    hpfNode,
    bassNode,
    midNode,
    highNode,
    volumeGain,
    dspPathGain,
    directPassThroughGain,
    autoBalanceWetGain,
    autoBalanceBypassGain,
    bandLevelerGain,
    bandLevelerNode,
    matchWetGain,
    matchDryGain,
    matchNode,
    lookaheadGain,
    limiterFastGain,
    lookaheadNode,
    ceilingWarmGain,
    ceilingCleanGain,
    pitchWetGain,
    pitchDryGain,
    pitchNode,
    // Changes jump while the graph is being set up, and glide once start() marks it live.
    ctx,
    live: false
  };
  applyPresetToGraph(graph, params, dyn);
  applyDynamicsToGraph(graph, dyn, params);
  return graph;
}

// Live changes glide like the Tidal extension's (offscreen.js): 30 ms for EQ values, 20 ms for routing switches.
const PARAM_RAMP = 0.03;
const ROUTE_RAMP = 0.02;
function setAudioParam(param, value, graph, ramp = ROUTE_RAMP) {
  if (!param) return;
  const ctx = graph && graph.live ? graph.ctx : null;
  if (ctx && typeof param.setTargetAtTime === 'function') {
    param.setTargetAtTime(value, ctx.currentTime, ramp);
    return;
  }
  param.value = value;
}

function applyRouting(graph, params, dynamics) {
  const dyn = normaliseDynamics(dynamics);
  const compOff = params.autoBalance === false;
  const bypass = params.bypass === true;
  const useBand = !compOff && dyn.leveler === 'bass' && !!graph.bandLevelerNode;
  const shifting = !!graph.pitchNode && Math.abs(Number(params.semitones) || 0) >= 0.05;
  setAudioParam(graph.dspPathGain && graph.dspPathGain.gain, bypass ? 0 : 1, graph);
  setAudioParam(graph.directPassThroughGain && graph.directPassThroughGain.gain, bypass ? 1 : 0, graph);
  setAudioParam(graph.autoBalanceWetGain && graph.autoBalanceWetGain.gain, !compOff && !useBand ? 1 : 0, graph);
  setAudioParam(graph.autoBalanceBypassGain && graph.autoBalanceBypassGain.gain, compOff ? 1 : 0, graph);
  setAudioParam(graph.bandLevelerGain && graph.bandLevelerGain.gain, useBand ? 1 : 0, graph);
  setAudioParam(graph.matchWetGain && graph.matchWetGain.gain, dyn.match && graph.matchNode ? 1 : 0, graph);
  setAudioParam(graph.matchDryGain && graph.matchDryGain.gain, dyn.match && graph.matchNode ? 0 : 1, graph);
  setAudioParam(graph.lookaheadGain && graph.lookaheadGain.gain, dyn.limiter === 'lookahead' && graph.lookaheadNode ? 1 : 0, graph);
  setAudioParam(graph.limiterFastGain && graph.limiterFastGain.gain, dyn.limiter === 'lookahead' && graph.lookaheadNode ? 0 : 1, graph);
  setAudioParam(graph.ceilingWarmGain && graph.ceilingWarmGain.gain, dyn.ceiling === 'warm' ? 1 : 0, graph);
  setAudioParam(graph.ceilingCleanGain && graph.ceilingCleanGain.gain, dyn.ceiling === 'warm' ? 0 : 1, graph);
  setAudioParam(graph.pitchWetGain && graph.pitchWetGain.gain, shifting ? 1 : 0, graph);
  setAudioParam(graph.pitchDryGain && graph.pitchDryGain.gain, shifting ? 0 : 1, graph);
}

export function applyPresetToGraph(graph, params, dynamics) {
  if (!graph || !params) return;
  setAudioParam(graph.hpfNode && graph.hpfNode.frequency, params.hpf, graph, PARAM_RAMP);
  setAudioParam(graph.bassNode && graph.bassNode.gain, params.bass, graph, PARAM_RAMP);
  setAudioParam(graph.midNode && graph.midNode.gain, params.mid, graph, PARAM_RAMP);
  setAudioParam(graph.highNode && graph.highNode.gain, params.high, graph, PARAM_RAMP);
  setAudioParam(graph.volumeGain && graph.volumeGain.gain, params.gain, graph, PARAM_RAMP);
  if (graph.pitchNode && graph.pitchNode.parameters && graph.pitchNode.parameters.get) {
    const shift = Math.abs(Number(params.semitones) || 0) >= 0.05 ? Number(params.semitones) : 0;
    try { graph.pitchNode.parameters.get('semitones').value = shift; } catch (err) { /* parameter missing */ }
  }
  graph.params = params;
  applyRouting(graph, params, dynamics || graph.dynamics || DEFAULT_DYNAMICS);
}

export function applyDynamicsToGraph(graph, dynamics, params) {
  if (!graph) return;
  const dyn = normaliseDynamics(dynamics);
  if (graph.autoBalanceComp && graph.autoBalanceComp.release) {
    graph.autoBalanceComp.release.value = dyn.leveler === 'slow' ? DSP_SPEC.autoBalance.slowRelease : DSP_SPEC.autoBalance.release;
  }
  graph.dynamics = dyn;
  applyRouting(graph, params || graph.params || {}, dyn);
}

function clapLookaheadEnabled(doc) {
  try {
    const el = doc && doc.getElementById && doc.getElementById('dyn-limiter');
    return !!(el && el.value === 'lookahead');
  } catch (err) {
    return false;
  }
}

function showClapFlash(ctx) {
  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc || !doc.body) return;
  const read = latencyReadout(ctx);
  const ms = read.totalMs == null ? '—' : String(read.totalMs);
  doc.body.dataset.clapFlash = '1';
  if (doc.body.classList && doc.body.classList.add) doc.body.classList.add('clap-flash');
  const canvas = doc.getElementById ? doc.getElementById('spectrum') : null;
  if (canvas && canvas.getContext) {
    const pen = canvas.getContext('2d');
    if (pen && pen.fillRect) {
      pen.fillStyle = '#ffffff';
      pen.fillRect(0, 0, canvas.width || 840, canvas.height || 160);
    }
  }
  const status = doc.getElementById ? doc.getElementById('status') : null;
  const ahead = clapLookaheadEnabled(doc);
  if (status) {
    status.textContent = 'Clap through the DSP chain. AudioContext output latency ' + ms + ' ms'
      + (ahead ? ' plus look-ahead delay' : '') + '.';
  }
  setTimeout(() => {
    if (doc.body && doc.body.dataset) doc.body.dataset.clapFlash = '';
    if (doc.body && doc.body.classList && doc.body.classList.remove) doc.body.classList.remove('clap-flash');
  }, 120);
}

export function playClap(ctx, graph) {
  if (!ctx || ctx.state === 'closed') throw new Error('Bridge is not running.');
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 1000;
  gain.gain.value = 0.2;
  osc.connect(gain);
  const throughDsp = graph && (graph.hpf || graph.input);
  const target = throughDsp ? (graph.hpf || graph.input) : ctx.destination;
  gain.connect(target);
  const now = Number(ctx.currentTime) || 0;
  osc.start(now);
  osc.stop(now + 0.03);
  showClapFlash(ctx);
  return { frequency: 1000, duration: 0.03, target };
}

// Level log: numbers only, never audio. Bands in Hz; levels in dBFS (power summed across each band's bins).
export const LEVEL_BANDS = [['sub', 20, 60], ['bass', 60, 120], ['lowMid', 120, 500], ['mid', 500, 2000], ['presence', 2000, 6000], ['air', 6000, 20000]];

function bandLevels(analyser, sampleRate) {
  const bins = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(bins);
  const hz = sampleRate / analyser.fftSize;
  const out = {};
  for (const [name, lo, hi] of LEVEL_BANDS) {
    let power = 0;
    for (let i = Math.max(1, Math.floor(lo / hz)); i <= Math.min(bins.length - 1, Math.ceil(hi / hz)); i++) {
      if (isFinite(bins[i])) power += Math.pow(10, bins[i] / 10);
    }
    out[name] = power > 0 ? Math.round(10 * Math.log10(power) * 10) / 10 : -200;
  }
  return out;
}

function waveLevels(analyser) {
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let peak = 0, sum = 0, clipped = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped += 1;
    sum += data[i] * data[i];
  }
  const db = (x) => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -200);
  return { peak: db(peak), rms: db(Math.sqrt(sum / data.length)), clipped };
}

// One row of the level log: the signal coming in from BlackHole and what goes out to the DAC.
export function levelSnapshot(graph, sampleRate, reductions) {
  return {
    t: Date.now(),
    in: { ...waveLevels(graph.inputAnalyser), bands: bandLevels(graph.inputAnalyser, sampleRate) },
    out: { ...waveLevels(graph.outputAnalyser), bands: bandLevels(graph.outputAnalyser, sampleRate) },
    leveler: Math.round(reductions.leveler * 10) / 10,
    limiter: Math.round(reductions.limiter * 10) / 10
  };
}

const page = typeof document !== 'undefined' ? document : null;
if (page) {
  const state = {
    ctx: null,
    stream: null,
    graph: null,
    running: false,
    inputDeviceId: null,
    outputDeviceId: null,
    allowMicrophone: false,
    meters: { band: 0, trim: 0, lookahead: 0, error: null, worklets: false },
    params: presetParams(STARTUP_PRESET_NAME),
    dynamics: { ...STARTUP_DYNAMICS },
    movieMode: true
  };

  const HIDDEN_LABEL_STATUS = 'Device labels are hidden until Chrome grants microphone permission for this page. Switch the macOS input to BlackHole 2ch, then allow Microphone for http://127.0.0.1:8791 in Chrome Site Settings. Or check the override box to request permission once and re-scan.';
  let runGeneration = 0;
  // Set only from the input select's change event. A browser-chosen first
  // option (for example BlackHole 16ch) is not an explicit selection.
  let userSelectedInputId = null;
  const audioJobs = [];

  function closeQuiet(ctx) {
    if (!ctx || ctx.state === 'closed') return;
    try {
      const pending = ctx.close();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (err) { /* already closed */ }
  }

  function stopTracks(stream) {
    if (!stream || typeof stream.getTracks !== 'function') return;
    for (const track of stream.getTracks()) {
      try { track.stop(); } catch (err) { /* track already stopped */ }
    }
  }

  function labelsAreHidden(devices) {
    return Array.isArray(devices) && devices.length > 0 && devices.every((device) => !String(device && device.label || '').trim());
  }

  const statusEl = page.getElementById('status');
  const inputSelect = page.getElementById('input-device');
  const outputSelect = page.getElementById('output-device');
  const presetSelect = page.getElementById('preset');
  const followToggle = page.getElementById('follow-chrome');
  const followStatusEl = page.getElementById('follow-status');
  const movieToggle = page.getElementById('movie-mode');
  const micOverride = page.getElementById('mic-override');
  const startBtn = page.getElementById('start');
  const stopBtn = page.getElementById('stop');
  const clapBtn = page.getElementById('clap');
  const spectrum = page.getElementById('spectrum');
  const latencyEl = page.getElementById('latency');
  const levelerEl = page.getElementById('meter-leveler');
  const matchEl = page.getElementById('meter-match');
  const limiterEl = page.getElementById('meter-limiter');
  const ceilingEl = page.getElementById('meter-ceiling');

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
    // The tab title shows ▶ while running, so `movie-audio status` (which can read titles, not pages) can tell.
    page.title = (state.running ? '▶ ' : '') + 'Movie DSP bridge';
  }

  function fillPresets(selected = STARTUP_PRESET_NAME, dynamics = STARTUP_DYNAMICS) {
    if (!presetSelect) return;
    presetSelect.textContent = '';
    const chrome = liveChromePresets || CHROME_PRESETS;
    const chromeNames = Object.keys(chrome);
    // While following, Chrome's list also holds the factory names; show each name once.
    const groups = [['Your presets (from Chrome)', chromeNames], ['Factory presets', Object.keys(FACTORY_PRESETS).filter((n) => !own(chrome, n))]];
    const grouped = chromeNames.length > 0;
    for (const [label, names] of groups) {
      if (!names.length) continue;
      const group = grouped ? page.createElement('optgroup') : presetSelect;
      if (grouped) group.label = label;
      for (const name of names) {
        const opt = page.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (name === selected) opt.selected = true;
        group.appendChild(opt);
      }
      if (grouped) presetSelect.appendChild(group);
    }
    presetSelect.value = selected;
    const startupDynamics = { 'dyn-leveler': dynamics.leveler, 'dyn-limiter': dynamics.limiter, 'dyn-ceiling': dynamics.ceiling };
    for (const [id, value] of Object.entries(startupDynamics)) {
      const el = page.getElementById(id);
      if (el) el.value = value;
    }
    const matchEl = page.getElementById('dyn-match');
    if (matchEl) matchEl.checked = dynamics.match;
  }

  // ---- Follow Chrome: the Tidal extension's movie-sound-link.js posts its saved EQ to this page ----
  // One source of truth: while following, the sound comes only from Chrome's current settings (follow.chrome),
  // never from the menu, which just shows them. Unticking keeps the sound until you pick something.
  const win = typeof window !== 'undefined' && window.addEventListener ? window : null;
  const DYN_IDS = ['dyn-leveler', 'dyn-limiter', 'dyn-ceiling', 'dyn-match'];
  const follow = { on: !!(followToggle && followToggle.checked), chrome: null, heard: false, lost: false, waitedOut: false, rejected: null };
  const following = () => follow.on && !!follow.chrome;

  function desiredSound() {
    if (following()) return { params: follow.chrome.params, dynamics: follow.chrome.dynamics };
    // By hand: the sound last chosen (a pick, or what was playing when Follow was unticked). Never a fresh lookup
    // by name, which could pick up a preset Chrome has since changed, or drop unsaved changes.
    return { params: state.params, dynamics: state.dynamics };
  }

  function lockControls(locked) {
    for (const el of [presetSelect, ...DYN_IDS.map((id) => page.getElementById(id))]) {
      if (el) el.disabled = locked;
    }
  }

  function showFollowStatus() {
    if (!followStatusEl) return;
    let text;
    if (!follow.on) {
      text = 'Not following Chrome: the preset and settings above are yours to pick.';
    } else if (follow.lost) {
      text = 'Lost the link to the Tidal extension (it was reloaded or updated), so the sound stays as it is. Reload this page when you’re not watching to reconnect.';
    } else if (follow.chrome) {
      const c = follow.chrome;
      text = 'Following Chrome: ' + (c.presetName !== null && !c.modified ? c.presetName
        : c.presetName !== null && own(c.presets, c.presetName) ? c.presetName + ', changed and not saved' : 'its current settings')
        + (c.pitchDropped ? '. Pitch is off for films.' : '.');
    } else if (follow.waitedOut) {
      text = 'Not linked to Chrome: the Tidal extension (1.5.7 or later) isn’t answering, so Movie Sound uses the presets saved with it.';
    } else {
      text = 'Looking for the Tidal extension in Chrome…';
    }
    if (follow.on && follow.rejected) text += ' Chrome sent settings Movie Sound can’t use, so the sound stays as it is.';
    followStatusEl.textContent = text;
  }

  function applyFollowed() {
    const c = follow.chrome;
    liveChromePresets = c.presets;
    fillPresets(c.presetName, c.dynamics);
    lockControls(true);
    const changed = soundKey(state.params, state.dynamics) !== soundKey(c.params, c.dynamics);
    state.params = c.params;
    state.dynamics = c.dynamics;
    if (changed && state.running && state.graph) {
      applyPresetToGraph(state.graph, state.params, state.dynamics);
      applyDynamicsToGraph(state.graph, state.dynamics, state.params);
    }
    showFollowStatus();
  }

  function requestChrome() {
    if (win) win.postMessage({ source: 'movie-sound', type: 'request-chrome-eq', version: 1 }, win.location.origin);
  }

  function onChromeMessage(event) {
    // Only this page's own window: the extension's content script shares it. Anything else is ignored.
    if (!win || event.source !== win || event.origin !== win.location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== 'tidal-eq-link' || data.version !== 1) return;
    if (data.type === 'chrome-eq-link-ready') {
      if (follow.on) requestChrome();
      return;
    }
    if (data.type === 'chrome-eq-link-lost') {
      follow.lost = true;
      showFollowStatus();
      return;
    }
    if (data.type !== 'chrome-eq-settings') return;
    follow.heard = true;
    follow.lost = false;
    const candidate = chromeFollowCandidate(data);
    if (!candidate.ok) {
      follow.rejected = candidate.reason;
      showFollowStatus();
      return;
    }
    follow.rejected = null;
    follow.chrome = candidate;
    if (follow.on) {
      applyFollowed();
    } else {
      // Keep the menu's list current for picking by hand, without touching the sound.
      const picked = presetSelect ? presetSelect.value : undefined;
      liveChromePresets = candidate.presets;
      fillPresets(picked, readDynamics());
      showFollowStatus();
    }
  }

  async function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      setStatus('This browser has no media device list.');
      return;
    }
    let devices = await navigator.mediaDevices.enumerateDevices();
    const allowMic = !!(micOverride && micOverride.checked);
    if (labelsAreHidden(devices) && allowMic) {
      devices = await primeHiddenLabels(runGeneration);
      if (!devices) return;
    }
    const inputs = devices.filter((d) => d.kind === 'audioinput' && !isMutableAliasId(d.deviceId) && (allowMic || isBlackHoleDevice(d)));
    const outputs = devices.filter((d) => d.kind === 'audiooutput' && !isBlackHoleDevice(d) && !isMutableAliasId(d.deviceId));
    if (inputSelect) {
      const explicitId = userSelectedInputId;
      const explicitStillPresent = !!(explicitId && inputs.some((device) => device.deviceId === explicitId));
      const has2ch = inputs.some((device) => isBlackHole2ch(device));
      inputSelect.textContent = '';
      // A single-select otherwise lands on its first option. That would make
      // BlackHole 16ch look like an explicit choice when 2ch is absent.
      if (!explicitStillPresent && !has2ch && inputs.length) {
        const placeholder = page.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Select BlackHole 2ch…';
        placeholder.selected = true;
        inputSelect.appendChild(placeholder);
      }
      for (const device of inputs) {
        const opt = page.createElement('option');
        opt.value = device.deviceId;
        opt.textContent = device.label || 'Unnamed input';
        if (explicitStillPresent && device.deviceId === explicitId) opt.selected = true;
        else if (!explicitStillPresent && isBlackHole2ch(device)) opt.selected = true;
        inputSelect.appendChild(opt);
      }
      if (!inputs.length) {
        const opt = page.createElement('option');
        opt.value = '';
        opt.textContent = 'BlackHole 2ch not visible';
        inputSelect.appendChild(opt);
      }
      if (explicitStillPresent) inputSelect.value = explicitId;
      else if (!has2ch) inputSelect.value = '';
    }
    if (outputSelect) {
      outputSelect.textContent = '';
      for (const device of outputs) {
        const opt = page.createElement('option');
        opt.value = device.deviceId;
        opt.textContent = device.label || 'Unnamed output';
        if (isIfiProIdsd(device)) opt.selected = true;
        outputSelect.appendChild(opt);
      }
      if (!outputs.length) {
        const opt = page.createElement('option');
        opt.value = '';
        opt.textContent = 'No non-BlackHole output';
        outputSelect.appendChild(opt);
      }
    }
    if (labelsAreHidden(devices) && !allowMic) setStatus(HIDDEN_LABEL_STATUS);
  }

  function readDynamics() {
    const leveler = page.getElementById('dyn-leveler');
    const match = page.getElementById('dyn-match');
    const limiter = page.getElementById('dyn-limiter');
    const ceiling = page.getElementById('dyn-ceiling');
    return normaliseDynamics({
      leveler: leveler ? leveler.value : 'full',
      match: !!(match && match.checked),
      limiter: limiter ? limiter.value : 'fast',
      ceiling: ceiling ? ceiling.value : 'clean'
    });
  }

  function stop(reason) {
    runGeneration += 1;
    for (const job of audioJobs) {
      job.dropped = true;
      stopTracks(job.stream);
      closeQuiet(job.ctx);
    }
    audioJobs.length = 0;
    state.running = false;
    stopTracks(state.stream);
    closeQuiet(state.ctx);
    state.stream = null;
    state.ctx = null;
    state.graph = null;
    state.inputDeviceId = null;
    state.outputDeviceId = null;
    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
    if (clapBtn) clapBtn.disabled = true;
    setStatus(reason || 'Stopped.');
  }

  async function start() {
    runGeneration += 1;
    const myGen = runGeneration;
    // Before any await, so Stop can cancel a restart while permission or setSinkId is pending.
    if (stopBtn) stopBtn.disabled = false;
    stopTracks(state.stream);
    closeQuiet(state.ctx);
    state.stream = null;
    state.ctx = null;
    state.graph = null;
    state.running = false;
    state.inputDeviceId = null;
    state.outputDeviceId = null;
    const job = { gen: myGen, ctx: null, stream: null, dropped: false };
    audioJobs.push(job);
    const dead = () => job.dropped || myGen !== runGeneration;
    const failCurrent = (message) => {
      if (myGen !== runGeneration) return;
      if (message != null) setStatus(message);
      if (stopBtn) stopBtn.disabled = true;
    };
    const allowMic = !!(micOverride && micOverride.checked);

    let devices;
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (err) {
      failCurrent(err.message || 'Could not list audio devices.');
      return;
    }
    if (job.dropped) return;
    if (labelsAreHidden(devices) && !allowMic) {
      failCurrent(HIDDEN_LABEL_STATUS);
      return;
    }
    if (labelsAreHidden(devices) && allowMic) {
      devices = await primeHiddenLabels(myGen);
      if (!devices || dead()) {
        if (myGen === runGeneration) failCurrent();
        return;
      }
    }
    const plan = planCapture(devices, {
      allowMicrophone: allowMic,
      inputDeviceId: inputSelect && inputSelect.value ? inputSelect.value : undefined,
      outputDeviceId: outputSelect && outputSelect.value ? outputSelect.value : undefined,
      movieMode: !(movieToggle && movieToggle.checked === false)
    });
    if (!plan.ok) {
      failCurrent(plan.error);
      return;
    }
    let ctx;
    try {
      ctx = createMovieAudioContextWithFallback(plan.movieMode);
    } catch (err) {
      failCurrent(err.message || 'Could not open an audio context.');
      return;
    }
    job.ctx = ctx;
    if (typeof ctx.setSinkId !== 'function') {
      closeQuiet(ctx);
      failCurrent('This browser has no AudioContext.setSinkId. Open the bridge in Chrome so output can be pinned to the iFi Pro iDSD.');
      return;
    }
    try {
      await ctx.setSinkId(plan.outputDeviceId);
    } catch (err) {
      closeQuiet(ctx);
      failCurrent('Could not pin output to the selected sink. ' + (err.message || ''));
      return;
    }
    if (job.dropped) {
      closeQuiet(ctx);
      return;
    }
    if (!dead()) state.meters = { band: 0, trim: 0, lookahead: 0, error: null, worklets: false };
    try {
      await ctx.audioWorklet.addModule('dynamics.worklet.js');
      await ctx.audioWorklet.addModule('pitch-shifter.worklet.js');
      if (!dead()) state.meters.worklets = true;
    } catch (err) {
      if (!dead()) state.meters.error = err.message;
    }
    if (job.dropped) {
      closeQuiet(ctx);
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(plan.constraints);
    } catch (err) {
      closeQuiet(ctx);
      failCurrent('BlackHole capture failed. ' + (err.message || 'The microphone was not opened as a fallback.'));
      return;
    }
    job.stream = stream;
    if (dead()) {
      stopTracks(stream);
      closeQuiet(ctx);
      job.stream = null;
      job.ctx = null;
      return;
    }
    state.movieMode = plan.movieMode;
    state.allowMicrophone = allowMic;
    const want = desiredSound();
    state.params = want.params;
    state.dynamics = want.dynamics;
    const source = ctx.createMediaStreamSource(stream);
    state.ctx = ctx;
    state.stream = stream;
    state.inputDeviceId = plan.inputDeviceId;
    state.outputDeviceId = plan.outputDeviceId;
    state.graph = wireGraph(ctx, source, state.params, state.dynamics, state.meters);
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch (err) {
        stopTracks(stream);
        closeQuiet(ctx);
        // A superseded start owns only its local stream and context.
        // Clearing state or buttons here would tear down the newer capture.
        if (myGen !== runGeneration) return;
        state.ctx = null;
        state.stream = null;
        state.graph = null;
        state.running = false;
        failCurrent(err.message || 'Could not resume the audio context.');
        return;
      }
      if (dead()) {
        stopTracks(stream);
        closeQuiet(ctx);
        return;
      }
    }
    if (dead()) {
      stopTracks(stream);
      closeQuiet(ctx);
      return;
    }
    // The settings may have changed while the context was starting (a pick, or a message from Chrome).
    // Until now those only reached state, so install the latest before going live.
    applyPresetToGraph(state.graph, state.params, state.dynamics);
    applyDynamicsToGraph(state.graph, state.dynamics, state.params);
    state.graph.live = true;
    state.running = true;
    if (startBtn) startBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = false;
    if (clapBtn) clapBtn.disabled = false;
    const rate = ctx.sampleRate ? Math.round(ctx.sampleRate / 1000) + ' kHz' : '';
    setStatus('Running. ' + plan.inputLabel + ' to ' + plan.outputLabel + (rate ? ' at ' + rate : '') + '.');
  }

  async function primeHiddenLabels(myGen) {
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      if (myGen === runGeneration) setStatus('Could not request microphone permission to reveal device labels. ' + (err.message || ''));
      return null;
    }
    stopTracks(stream);
    if (myGen !== runGeneration) return null;
    try {
      return await navigator.mediaDevices.enumerateDevices();
    } catch (err) {
      if (myGen === runGeneration) setStatus(err.message || 'Could not list audio devices.');
      return null;
    }
  }

  // Last 6 minutes of levels, 10 rows a second, kept in memory only until Save levels downloads them.
  const levelLog = [];
  const LEVEL_LOG_MAX = 3600;
  function currentReductions() {
    const g = state.graph;
    return {
      leveler: state.dynamics.leveler === 'bass' ? state.meters.band : Math.max(0, -(g.autoBalanceComp ? g.autoBalanceComp.reduction : 0)),
      limiter: state.dynamics.limiter === 'lookahead' ? state.meters.lookahead : Math.max(0, -(g.masterLimiter ? g.masterLimiter.reduction : 0))
    };
  }
  if (typeof setInterval === 'function') setInterval(() => {
    if (!state.running || !state.ctx || !state.graph || !state.graph.inputAnalyser) return;
    try {
      levelLog.push(levelSnapshot(state.graph, state.ctx.sampleRate, currentReductions()));
      if (levelLog.length > LEVEL_LOG_MAX) levelLog.shift();
    } catch (err) { /* analyser not ready */ }
  }, 100);
  function saveLevels() {
    const body = JSON.stringify({
      saved: new Date().toISOString(),
      sampleRate: state.ctx ? state.ctx.sampleRate : null,
      preset: presetSelect ? presetSelect.value : null,
      params: state.params,
      dynamics: state.dynamics,
      bands: LEVEL_BANDS,
      rows: levelLog
    });
    const a = page.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    a.download = 'bridge-levels-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    page.body.appendChild(a);
    a.click();
    a.remove();
    setStatus('Saved ' + levelLog.length + ' level readings (numbers only, no audio) to Downloads.');
  }
  if (page.getElementById('save-levels')) page.getElementById('save-levels').addEventListener('click', saveLevels);

  function paint() {
    if (state.running && state.ctx && state.graph && spectrum) {
      const g = spectrum.getContext('2d');
      const w = spectrum.width;
      const h = spectrum.height;
      g.clearRect(0, 0, w, h);
      const bins = new Uint8Array(state.graph.inputAnalyser.frequencyBinCount);
      state.graph.inputAnalyser.getByteFrequencyData(bins);
      const outBins = new Uint8Array(state.graph.outputAnalyser.frequencyBinCount);
      state.graph.outputAnalyser.getByteFrequencyData(outBins);
      const draw = (data, color) => {
        g.beginPath();
        const step = Math.max(1, Math.floor(data.length / w));
        for (let x = 0; x < w; x++) {
          const v = data[Math.min(data.length - 1, x * step)] / 255;
          const y = h - v * h;
          if (x === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.strokeStyle = color;
        g.stroke();
      };
      draw(bins, '#7d8da6');
      draw(outBins, '#00e5ff');
      const leveler = state.dynamics.leveler === 'bass'
        ? state.meters.band
        : Math.max(0, -(state.graph.autoBalanceComp ? state.graph.autoBalanceComp.reduction : 0));
      const limiter = state.dynamics.limiter === 'lookahead'
        ? state.meters.lookahead
        : Math.max(0, -(state.graph.masterLimiter ? state.graph.masterLimiter.reduction : 0));
      if (levelerEl) levelerEl.textContent = leveler.toFixed(1) + ' dB';
      if (matchEl) matchEl.textContent = state.meters.trim.toFixed(1) + ' dB';
      if (limiterEl) limiterEl.textContent = limiter.toFixed(1) + ' dB';
      if (ceilingEl) ceilingEl.textContent = state.dynamics.ceiling;
      const read = latencyReadout(state.ctx);
      if (latencyEl) {
        const ahead = state.dynamics && state.dynamics.limiter === 'lookahead';
        latencyEl.textContent = 'AudioContext output latency '
          + (read.outputLatency == null ? '—' : Math.round(read.outputLatency * 1000) + ' ms')
          + ' · base ' + (read.baseLatency == null ? '—' : Math.round(read.baseLatency * 1000) + ' ms')
          + (ahead ? ' · plus look-ahead delay' : '');
      }
    }
    requestAnimationFrame(paint);
  }

  if (inputSelect) {
    inputSelect.addEventListener('change', () => {
      userSelectedInputId = inputSelect.value ? inputSelect.value : null;
    });
  }

  fillPresets();
  refreshDevices().catch((err) => setStatus(err.message));
  if (page.getElementById('refresh')) page.getElementById('refresh').addEventListener('click', () => refreshDevices().catch((err) => setStatus(err.message)));
  if (startBtn) startBtn.addEventListener('click', () => start().catch((err) => setStatus(err.message || String(err))));
  if (stopBtn) stopBtn.addEventListener('click', () => stop('Stopped.'));
  if (clapBtn) clapBtn.addEventListener('click', () => {
    try { playClap(state.ctx, state.running ? state.graph : null); } catch (err) { setStatus(err.message); }
  });
  // A pick by hand stops following (the controls are locked while following, so this is a safeguard).
  function stopFollowingForManualPick() {
    if (!following()) return;
    follow.on = false;
    if (followToggle) followToggle.checked = false;
    lockControls(false);
    showFollowStatus();
  }
  function onPresetChange() {
    stopFollowingForManualPick();
    state.params = presetParams(presetSelect ? presetSelect.value : DEFAULT_PRESET_NAME);
    if (state.running && state.graph) applyPresetToGraph(state.graph, state.params, state.dynamics);
  }
  function onDynamicsChange() {
    stopFollowingForManualPick();
    state.dynamics = readDynamics();
    if (state.running && state.graph) applyDynamicsToGraph(state.graph, state.dynamics, state.params);
  }
  if (presetSelect) presetSelect.addEventListener('change', onPresetChange);
  for (const id of ['dyn-leveler', 'dyn-limiter', 'dyn-ceiling', 'dyn-match']) {
    const control = page.getElementById(id);
    if (control) control.addEventListener('change', onDynamicsChange);
  }
  if (movieToggle) {
    movieToggle.addEventListener('change', () => {
      state.movieMode = movieToggle.checked !== false;
      if (state.running) {
        start().catch((err) => setStatus(err.message || String(err)));
        return;
      }
      setStatus(state.movieMode
        ? 'Movie mode (interactive) will apply the next time you start.'
        : 'Music mode (playback) will apply the next time you start.');
    });
  }
  if (followToggle) {
    followToggle.addEventListener('change', () => {
      follow.on = followToggle.checked;
      if (follow.on) {
        if (follow.chrome) applyFollowed();
        requestChrome();
      } else {
        lockControls(false);
      }
      showFollowStatus();
    });
  }
  if (win && followToggle) {
    win.addEventListener('message', onChromeMessage);
    if (follow.on) requestChrome();
    setTimeout(() => {
      if (!follow.heard) {
        follow.waitedOut = true;
        showFollowStatus();
      }
    }, 2000);
    showFollowStatus();
  }
  if (micOverride) micOverride.addEventListener('change', () => refreshDevices().catch(() => {}));
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      if (!state.running) {
        refreshDevices().catch(() => {});
        return;
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const decision = captureMustStop(devices, state.inputDeviceId, state.allowMicrophone, state.outputDeviceId);
      if (decision.stop) stop(decision.reason);
    });
  }
  requestAnimationFrame(paint);
}
