#!/usr/bin/env node
/**
 * Silent checks for Movie Sound's bridge (bridge/).
 * No AudioContext, no getUserMedia, no lip-sync clap, no DAC output.
 * The Orion tools' own checks compare against your personal extension settings, so they aren't published
 * (see orion/README.md).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';



let mediaOpens = 0;
function forbidMedia() {
  mediaOpens += 1;
  throw new Error('test tried to open an audio device');
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function flush() {
  for (let i = 0; i < 8; i++) await sleep(0);
}

function makeStyle() {
  const style = { cssText: '', fontFamily: '' };
  style.setProperty = (name, value) => {
    style[name] = value == null ? '' : String(value);
  };
  return style;
}

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    id: '',
    className: '',
    value: '',
    checked: false,
    selected: false,
    selectedIndex: 0,
    innerHTML: '',
    dataset: {},
    children: [],
    style: makeStyle(),
    listeners: []
  };
  let text = '';
  Object.defineProperty(el, 'textContent', {
    get() { return text; },
    set(v) { text = v == null ? '' : String(v); }
  });
  Object.defineProperty(el, 'innerText', {
    get() { return text; },
    set(v) { text = v == null ? '' : String(v); }
  });
  Object.defineProperty(el, 'length', {
    get() { return el.children.length; }
  });
  el.appendChild = (child) => {
    if (child && !child.value && child.textContent) child.value = child.textContent;
    el.children.push(child);
    el[el.children.length - 1] = child;
    return child;
  };
  el.addEventListener = (type, fn) => {
    if (typeof fn === 'function') el.listeners.push({ type, fn });
  };
  el.removeEventListener = () => {};
  el.setAttribute = (name, value) => { el[name] = value; };
  el.getAttribute = (name) => (name in el ? el[name] : null);
  el.remove = () => {};
  el.getContext = () => ({
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillRect() {}, getImageData() { return { data: [] }; }
  });
  el.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, left: 0 });
  return el;
}

class MutationObserver {
  constructor(cb) { this.cb = cb; }
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
}

class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init && init.detail;
  }
}

function makeDocument(scripts) {
  const byId = new Map();
  const tags = new Map();
  const doc = {
    documentElement: makeEl('html'),
    scripts,
    createElement(tag) {
      const el = makeEl(tag);
      if (String(tag).toLowerCase() === 'script') scripts.push(el);
      return el;
    },
    getElementById(id) {
      if (!byId.has(id)) {
        const el = makeEl(id === 'canvas' ? 'canvas' : 'div');
        el.id = id;
        byId.set(id, el);
      }
      return byId.get(id);
    },
    getElementsByTagName(name) {
      const key = String(name).toLowerCase();
      if (!tags.has(key)) tags.set(key, [makeEl(key)]);
      return tags.get(key);
    },
    createTextNode(text) { return { textContent: String(text) }; },
    listeners: [],
    addEventListener(type, fn, opts) {
      if (typeof fn !== 'function') return;
      doc.listeners.push({ type, fn, opts });
    },
    removeEventListener(type, fn) {
      doc.listeners = doc.listeners.filter((row) => !(row.type === type && row.fn === fn));
    },
    dispatchEvent(ev) {
      const type = ev && ev.type ? ev.type : ev;
      const list = doc.listeners.filter((row) => row.type === type);
      for (const row of list) {
        if (row.opts && row.opts.once) doc.listeners = doc.listeners.filter((item) => item !== row);
        row.fn(ev && ev.type ? ev : { type });
      }
      return true;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  doc.head = doc.getElementsByTagName('head')[0];
  doc.body = doc.getElementsByTagName('body')[0];
  doc.documentElement.addEventListener = function add(type, fn, opts) {
    if (typeof fn !== 'function') return;
    const bucket = doc.documentElement.listeners;
    const record = { type, fn, opts };
    if (opts && opts.once) {
      record.fn = function once(ev) {
        const i = bucket.indexOf(record);
        if (i >= 0) bucket.splice(i, 1);
        fn(ev);
      };
      record.fn.original = fn;
    }
    bucket.push(record);
  };
  doc.documentElement.removeEventListener = function remove(type, fn) {
    const bucket = doc.documentElement.listeners;
    for (let i = bucket.length - 1; i >= 0; i--) {
      if (bucket[i].type === type && (bucket[i].fn === fn || bucket[i].fn.original === fn)) bucket.splice(i, 1);
    }
  };
  doc.documentElement.dispatchEvent = function dispatch(ev) {
    const list = doc.documentElement.listeners.filter((row) => row.type === ev.type).map((row) => row.fn);
    for (const fn of list) fn(ev);
    return true;
  };
  return doc;
}

function installChrome(sandbox, mode, initial) {
  const store = JSON.parse(JSON.stringify(initial || {}));
  const setCalls = [];
  function snapshot() {
    return JSON.parse(JSON.stringify(store));
  }
  const chrome = {
    storage: {
      sync: {
        get(keys, cb) {
          const items = snapshot();
          if (mode === 'callback') {
            if (typeof cb === 'function') cb(items);
            return undefined;
          }
          return Promise.resolve(items);
        },
        set(obj, cb) {
          Object.assign(store, JSON.parse(JSON.stringify(obj)));
          setCalls.push(JSON.parse(JSON.stringify(obj)));
          if (typeof cb === 'function') cb();
          if (mode === 'promise') return Promise.resolve();
          return undefined;
        }
      },
      local: {
        get(keys, cb) {
          if (typeof cb === 'function') cb({});
          return Promise.resolve({});
        },
        set() { return Promise.resolve(); }
      },
      onChanged: { addListener() {} }
    },
    runtime: {
      lastError: null,
      id: 'test',
      getURL(file) { return 'chrome-extension://local/' + file; },
      getManifest() { return { version: '0.11.1' }; },
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} }
    },
    action: { setIcon() { return Promise.resolve(); }, setTitle() {}, setBadgeText() {} },
    tabs: { query: () => Promise.resolve([]), sendMessage() {}, onUpdated: { addListener() {} }, onActivated: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    contextMenus: { create() {}, onClicked: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    scripting: { executeScript: () => Promise.resolve([]) }
  };
  sandbox.chrome = chrome;
  sandbox.browser = chrome;
  return { store, setCalls, snapshot };
}

function runScript(filename, code, { mode = 'callback', initial = {}, protocol = 'https:', href = 'https://www.example.com/watch', before } = {}) {
  const scripts = [];
  const document = makeDocument(scripts);
  const sandbox = {
    console: { log() {}, info() {}, debug() {}, warn() {}, error(...args) { console.error(...args); } },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    Promise,
    URL,
    Blob,
    TextEncoder,
    TextDecoder,
    performance,
    crypto,
    structuredClone,
    atob,
    btoa,
    MutationObserver,
    CustomEvent,
    document,
    location: { protocol, href, hostname: 'www.example.com' },
    navigator: {
      userAgent: 'verify-all',
      mediaDevices: {
        getUserMedia: forbidMedia,
        enumerateDevices: () => Promise.resolve([]),
        addEventListener() {}
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const chromeApi = installChrome(sandbox, mode, initial);
  if (before) before(sandbox);
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename, timeout: 4000 });
  return { sandbox, document, scripts, ...chromeApi };
}

const tests = [];
// Paths sit below `const tests` so other harnesses can reuse the helpers above in a plain VM.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(ROOT, 'bridge');
// Andy's Tidal miniplayer extension (github.com/cornishandy/tidal-miniplayer-extension), source of the worklets.
const TIDAL = process.env.TIDAL_EXTENSION_DIR || path.join(os.homedir(), 'Documents/ChatGPT/tidal-miniplayer-extension');
function test(name, fn) { tests.push([name, fn]); }

test('audio bridge refuses mics, BlackHole loops, and any audio device during import', async () => {
  let constructed = 0;
  const Previous = globalThis.AudioContext;
  globalThis.AudioContext = function AudioContext() {
    constructed += 1;
    forbidMedia();
  };
  const opened = mediaOpens;
  let bridge;
  try {
    bridge = await import(pathToFileURL(path.join(BRIDGE, 'bridge.js')).href);
  } finally {
    if (Previous) globalThis.AudioContext = Previous;
    else delete globalThis.AudioContext;
  }
  assert(constructed === 0, 'import constructed AudioContext');
  assert(mediaOpens === opened, 'import called getUserMedia or playClap');
  const src = fs.readFileSync(path.join(BRIDGE, 'bridge.js'), 'utf8');
  const sinkAt = src.indexOf('await ctx.setSinkId');
  const captureAt = src.indexOf('getUserMedia');
  assert(sinkAt > 0 && captureAt > sinkAt, 'setSinkId must happen before capture');
  assert(src.includes('echoCancellation: false') && src.includes('noiseSuppression: false') && src.includes('autoGainControl: false'), 'raw capture flags');
  assert(src.includes("latencyHint: 'interactive'") && src.includes("latencyHint: 'playback'"), 'movie and music latency');
  assert(src.includes('sampleRate: 96000'), '96 kHz request');
  assert(bridge.DEFAULT_PRESET_NAME === 'Late Night Movies & Dialogue', 'default preset');
  assert(bridge.FACTORY_PRESETS[bridge.DEFAULT_PRESET_NAME].hpf === 45, 'late night preset');
  assert(bridge.DSP_SPEC.chain.join(' > ') === 'HPF > 3-band EQ > Auto-Balance / Bass-only Leveler > Loudness Match > Fast / Look-ahead Limiter > Clean / Warm Ceiling', 'chain');
  assert(bridge.audioContextOptions(true).latencyHint === 'interactive', 'movie hint');
  assert(bridge.audioContextOptions(false).latencyHint === 'playback', 'music hint');

  const ifi = { kind: 'audiooutput', deviceId: 'ifi-1', label: 'iFi Pro iDSD' };
  const speakers = { kind: 'audiooutput', deviceId: 'spk', label: 'MacBook Pro Speakers' };
  const bh2 = { kind: 'audioinput', deviceId: 'bh2', label: 'BlackHole 2ch' };
  const bh16 = { kind: 'audioinput', deviceId: 'bh16', label: 'BlackHole 16ch' };
  const bhOut = { kind: 'audiooutput', deviceId: 'bh-out', label: 'BlackHole 2ch' };
  const mic = { kind: 'audioinput', deviceId: 'mic-1', label: 'MacBook Pro Microphone' };
  const devices = [bh16, bh2, mic, ifi, speakers, bhOut];

  const noHole = bridge.planCapture([mic, ifi], {});
  assert(noHole.ok === false && !noHole.constraints, 'mic was offered without BlackHole');
  const allowed = bridge.planCapture([mic, ifi], { allowMicrophone: true, inputDeviceId: 'mic-1' });
  assert(allowed.ok === true && allowed.constraints.audio.deviceId.exact === 'mic-1', 'explicit mic override');
  assert(allowed.constraints.audio.echoCancellation === false && allowed.constraints.audio.channelCount === 2 && allowed.constraints.video === false, 'override constraints');
  const unnamed = bridge.planCapture([
    { kind: 'audioinput', deviceId: 'hidden', label: '' },
    ifi
  ], {});
  assert(unnamed.ok === false && !unnamed.constraints, 'blank label was treated as BlackHole');
  const planned = bridge.planCapture(devices, {});
  assert(planned.ok === true && planned.inputDeviceId === 'bh2' && planned.outputDeviceId === 'ifi-1', 'default devices ' + JSON.stringify(planned));
  assert(planned.latencyHint === 'interactive' && planned.sampleRate === 96000 && planned.movieMode === true, 'movie defaults');
  const music = bridge.planCapture(devices, { movieMode: false });
  assert(music.ok === true && music.latencyHint === 'playback', 'music mode');
  const loop = bridge.planCapture(devices, { inputDeviceId: 'bh2', outputDeviceId: 'bh-out' });
  assert(loop.ok === false && loop.feedbackLoop === true && !loop.constraints, 'BlackHole loop was allowed');
  assert(bridge.captureMustStop(devices, 'missing', false).stop === true, 'missing input should stop');
  assert(bridge.captureMustStop([{ kind: 'audioinput', deviceId: 'bh2', label: 'MacBook Pro Microphone' }], 'bh2', false).stop === true, 'relabelled input should stop');
  assert(bridge.captureMustStop([bh2, ifi], 'bh2', false, 'ifi-1').stop === false, 'BlackHole should keep running');
  assert(bridge.captureMustStop([{ kind: 'audioinput', deviceId: 'bh2', label: '' }, ifi], 'bh2', false, 'ifi-1').stop === false, 'empty label should not force a mic open');
  const pinned = [bh2, ifi];
  assert(bridge.captureMustStop(pinned, 'bh2', false, 'ifi-1').stop === false, 'pinned iFi should keep running');
  assert(bridge.captureMustStop([bh2], 'bh2', false, 'ifi-1').stop === true, 'missing pinned output should stop');
  assert(bridge.captureMustStop([bh2, speakers], 'bh2', false, 'ifi-1').reason.includes('Pinned output'), 'output disconnect reason');
  assert(bridge.captureMustStop(pinned, 'bh2', false).stop === true, 'omitted output id should stop');
  assert(bridge.captureMustStop(pinned, 'bh2', false, 'default').stop === true, 'mutable default alias should stop');
  assert(bridge.captureMustStop(pinned, 'bh2', false, 'communications').stop === true, 'communications alias should stop');
  assert(bridge.captureMustStop([bh2], 'bh2', 'ifi-1').stop === true, 'third-arg output id should stop when that sink is gone');
  const read = bridge.latencyReadout({ baseLatency: 0.012, outputLatency: 0.03, sampleRate: 96000 });
  assert(read.totalMs === 42 && read.sampleRate === 96000, 'latency ' + JSON.stringify(read));
  const curve = bridge.makeCeilingCurve();
  assert(curve[4096] === 0, 'ceiling zero');
  assert(curve[6144] === 0.5 && curve[2048] === -0.5, 'ceiling identity below the knee');
  let peak = 0;
  for (let i = 0; i < curve.length; i++) peak = Math.max(peak, Math.abs(curve[i]));
  assert(peak <= 0.966 + 1e-9 && curve[curve.length - 1] > 0.93 && curve[curve.length - 1] < 0.966, 'ceiling cap ' + peak);
  const warm = bridge.makeWarmCurve();
  assert(warm[(warm.length - 1) / 2] === 0, 'warm zero');
  let warmPeak = 0;
  for (let i = 0; i < warm.length; i++) warmPeak = Math.max(warmPeak, Math.abs(warm[i]));
  assert(warmPeak <= 0.966 + 1e-9, 'warm cap');
});

test('bridge applies live preset and dynamics, routes the clap through DSP, and flashes', async () => {
  const src = fs.readFileSync(path.join(BRIDGE, 'bridge.js'), 'utf8');
  const html = fs.readFileSync(path.join(BRIDGE, 'index.html'), 'utf8');
  assert(src.includes('applyPresetToGraph') && src.includes('applyDynamicsToGraph'), 'live graph helpers missing');
  for (const id of ['dyn-leveler', 'dyn-limiter', 'dyn-ceiling', 'dyn-match']) {
    assert(src.includes("'" + id + "'"), 'missing change target ' + id);
  }
  assert(src.includes("presetSelect.addEventListener('change'") && src.includes("control.addEventListener('change', onDynamicsChange)"), 'live change listeners missing');
  assert(src.includes("movieToggle.addEventListener('change'") && src.includes('state.movieMode = movieToggle.checked !== false'), 'movie mode listener missing');
  assert(src.includes('state.outputDeviceId = plan.outputDeviceId'), 'start does not remember the pinned sink');
  assert(src.includes('captureMustStop(devices, state.inputDeviceId, state.allowMicrophone, state.outputDeviceId)'), 'devicechange ignores the output sink');
  assert(html.includes('body.clap-flash'), 'clap flash style missing');
  assert(src.includes('osc.frequency.value = 1000') && src.includes('osc.stop(now + 0.03)'), 'clap is not a 30ms 1kHz pulse');
  assert(src.includes('graph.hpf || graph.input'), 'clap does not prefer the DSP input');

  const bridge = await import(pathToFileURL(path.join(BRIDGE, 'bridge.js')).href);
  const graph = {
    hpfNode: { frequency: { value: 0 } },
    bassNode: { gain: { value: 0 } },
    midNode: { gain: { value: 0 } },
    highNode: { gain: { value: 0 } },
    volumeGain: { gain: { value: 0 } },
    dspPathGain: { gain: { value: 0 } },
    directPassThroughGain: { gain: { value: 1 } },
    autoBalanceWetGain: { gain: { value: 0 } },
    autoBalanceBypassGain: { gain: { value: 1 } },
    bandLevelerGain: { gain: { value: 0 } },
    matchWetGain: { gain: { value: 0 } },
    matchDryGain: { gain: { value: 1 } },
    lookaheadGain: { gain: { value: 0 } },
    limiterFastGain: { gain: { value: 1 } },
    ceilingWarmGain: { gain: { value: 0 } },
    ceilingCleanGain: { gain: { value: 1 } },
    pitchWetGain: { gain: { value: 0 } },
    pitchDryGain: { gain: { value: 1 } },
    autoBalanceComp: { release: { value: 0.2 } },
    bandLevelerNode: {},
    lookaheadNode: {},
    matchNode: {},
    hpf: { id: 'hpf' },
    input: { id: 'input' }
  };
  const late = bridge.presetParams('Late Night Movies & Dialogue');
  bridge.applyPresetToGraph(graph, late, bridge.DEFAULT_DYNAMICS);
  assert(graph.hpfNode.frequency.value === 45 && graph.bassNode.gain.value === 3.5 && graph.midNode.gain.value === 3, 'live preset values');
  assert(graph.dspPathGain.gain.value === 1 && graph.directPassThroughGain.gain.value === 0, 'live preset routing');
  bridge.applyDynamicsToGraph(graph, { leveler: 'slow', match: true, limiter: 'lookahead', ceiling: 'warm' }, late);
  assert(graph.autoBalanceComp.release.value === 0.6, 'slow leveler release');
  assert(graph.lookaheadGain.gain.value === 1 && graph.limiterFastGain.gain.value === 0, 'look-ahead routing');
  assert(graph.ceilingWarmGain.gain.value === 1 && graph.ceilingCleanGain.gain.value === 0, 'warm ceiling routing');
  assert(graph.matchWetGain.gain.value === 1 && graph.matchDryGain.gain.value === 0, 'loudness match routing');

  const connections = [];
  let stopped = null;
  let pulse = null;
  const ctx = {
    state: 'running',
    currentTime: 1.25,
    baseLatency: 0.012,
    outputLatency: 0.03,
    sampleRate: 96000,
    destination: { id: 'dest' },
    createOscillator() {
      const osc = { frequency: { value: 0 }, connect(node) { connections.push(['osc', node]); } };
      osc.start = () => {};
      osc.stop = (when) => { stopped = when; };
      pulse = osc;
      return osc;
    },
    createGain() {
      return { gain: { value: 0 }, connect(node) { connections.push(['gain', node]); } };
    }
  };
  const hpf = { id: 'dsp-hpf' };
  const previousDocument = globalThis.document;
  const classes = new Set();
  const body = {
    dataset: {},
    classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); } }
  };
  const status = { textContent: '' };
  let filled = false;
  globalThis.document = {
    body,
    getElementById(id) {
      if (id === 'status') return status;
      if (id === 'spectrum') {
        return { width: 8, height: 4, getContext() { return { fillStyle: '', fillRect() { filled = true; } }; } };
      }
      return null;
    }
  };
  try {
    const routed = bridge.playClap(ctx, { hpf, input: { id: 'dsp-input' } });
    assert(routed.target === hpf && routed.frequency === 1000 && routed.duration === 0.03, 'clap route');
    assert(pulse.frequency.value === 1000, 'clap frequency ' + pulse.frequency.value);
    assert(connections.some((row) => row[0] === 'gain' && row[1] === hpf), 'gain did not enter the DSP node');
    assert(!connections.some((row) => row[1] === ctx.destination), 'clap bypassed the DSP chain');
    assert(Math.abs(stopped - 1.28) < 1e-9, 'clap length ' + stopped);
    assert(body.dataset.clapFlash === '1' && classes.has('clap-flash') && filled, 'visual flash missing');
    assert(status.textContent.includes('42 ms'), 'latency readout ' + status.textContent);
    const bare = [];
    const bareCtx = {
      state: 'running',
      currentTime: 0,
      destination: { id: 'dest' },
      createOscillator() {
        return { frequency: { value: 0 }, connect(node) { bare.push(['osc', node]); }, start() {}, stop() {} };
      },
      createGain() {
        return { gain: { value: 0 }, connect(node) { bare.push(['gain', node]); } };
      }
    };
    bridge.playClap(bareCtx);
    assert(bare.some((row) => row[0] === 'gain' && row[1] === bareCtx.destination), 'unit-test clap did not use destination');
    await sleep(140);
    assert(body.dataset.clapFlash === '' && !classes.has('clap-flash'), 'flash was not cleared');
    assert(mediaOpens === 0, 'clap test opened an audio device');
  } finally {
    if (previousDocument) globalThis.document = previousDocument;
    else delete globalThis.document;
  }
});

test('bridge page and worklets stay local, and the server binds only to loopback', async () => {
  const html = fs.readFileSync(path.join(BRIDGE, 'index.html'), 'utf8');
  assert(html.includes('BlackHole') && html.includes('iFi Pro iDSD'), 'page device copy');
  assert(html.includes('id="spectrum"') && html.includes('id="meter-leveler"') && html.includes('id="clap"'), 'page meters');
  assert(html.includes('disabled'), 'clap starts disabled');
  if (fs.existsSync(TIDAL)) {
    for (const name of ['dynamics.worklet.js', 'pitch-shifter.worklet.js']) {
      assert(sha256(path.join(BRIDGE, name)) === sha256(path.join(TIDAL, name)), name + ' is not a byte copy');
    }
  } else {
    console.log('NOTE worklet byte-copy check skipped: no Tidal extension at ' + TIDAL + ' (set TIDAL_EXTENSION_DIR)');
  }
  const serverMod = await import(pathToFileURL(path.join(BRIDGE, 'server.mjs')).href);
  const server = serverMod.createBridgeServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const addr = server.address();
    assert(addr.address === '127.0.0.1', 'bound ' + addr.address);
    const url = `http://127.0.0.1:${addr.port}/`;
    const page = await fetch(url);
    const body = await page.text();
    assert(page.status === 200 && body.includes('BlackHole'), 'index body');
    const denied = await fetch(url + '..%2f..%2fextracted-settings.json');
    const deniedBody = await denied.text();
    assert(denied.status === 403, 'traversal status ' + denied.status);
    assert(!deniedBody.includes('keyBindings'), 'traversal returned settings');
    const posted = await fetch(url, { method: 'POST' });
    assert(posted.status === 405, 'post status ' + posted.status);
    for (const bad of ['%', '%E0%A4%A', '%00', 'index.html%00.js']) {
      const res = await fetch(url + bad);
      assert(res.status === 400, bad + ' status ' + res.status);
    }
    // Request targets fetch() won't send: sent raw, they used to crash the server in new URL().
    for (const target of ['//', '//%', '//[', '/%']) {
      const status = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: addr.port, path: target, method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
        req.end();
      });
      assert(status === 400, target + ' status ' + status);
    }
    const after = await fetch(url);
    assert(after.status === 200, 'server still up after bad requests: ' + after.status);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
  assert(mediaOpens === 0, 'a test opened an audio device');
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log('PASS ' + name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}
if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log(tests.length + ' passed; no audio device opened');
