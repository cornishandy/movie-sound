// Independent final-gate reproductions (Orion tools). Node mocks, plus a read-only look at your own Chrome
// profile's Video Speed Controller settings, so it runs only with MOVIE_SOUND_LIVE_CHECKS=1.
// tests/review-r3-astra-boundaries.mjs reuses its fakePage() fixture.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as bridge from '../../bridge/bridge.js';

if (process.env.MOVIE_SOUND_LIVE_CHECKS !== '1') {
  console.log('SKIP Orion live reproductions (set MOVIE_SOUND_LIVE_CHECKS=1)');
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
if (!fs.existsSync(path.join(root, 'orion/extracted-settings.json'))) {
  console.log('SKIP Orion live reproductions (stage first: node tools/extract-chrome-settings.mjs && node orion/stage-extensions.mjs)');
  process.exit(0);
}
const bh = { kind: 'audioinput', deviceId: 'bh2', label: 'BlackHole 2ch' };
const ifi = { kind: 'audiooutput', deviceId: 'ifi', label: 'iFi Pro iDSD' };
const report = (name, actual) => console.log(name + ': ' + JSON.stringify(actual));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const alias = { ...ifi, deviceId: 'default', label: 'Default - iFi Pro iDSD' };
const picked = bridge.planCapture([bh, alias, ifi]);
report('default alias accepted instead of physical iFi', picked.outputDeviceId);
report('after default changes to BlackHole and iFi disappears', bridge.captureMustStop([
  bh, { ...alias, label: 'Default - BlackHole 2ch' }
], 'bh2', false, picked.outputDeviceId));
report('BlackHole 16ch accepted without 2ch', bridge.planCapture([
  { ...bh, deviceId: 'bh16', label: 'BlackHole 16ch' }, ifi
]).ok);

function fakePage(devices) {
  const elements = new Map();
  function element(id = '') {
    return { id, value: '', checked: false, disabled: false, children: [], listeners: {},
      textContent: '', dataset: {}, style: {}, classList: { add() {}, remove() {} },
      appendChild(child) { this.children.push(child); },
      addEventListener(type, fn) { this.listeners[type] = fn; }
    };
  }
  const document = {
    body: element(), createElement: () => element(),
    getElementById(id) { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); }
  };
  document.getElementById('movie-mode').checked = true;
  document.getElementById('preset').value = bridge.DEFAULT_PRESET_NAME;
  const pending = [], streams = [], contexts = [];
  const mediaListeners = {};
  const mediaDevices = {
    enumerateDevices: async () => devices,
    getUserMedia: () => new Promise(resolve => pending.push(resolve)),
    addEventListener(type, fn) { mediaListeners[type] = fn; }
  };
  function node() {
    return { gain: { value: 1 }, frequency: { value: 0 }, Q: { value: 0 },
      threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 },
      attack: { value: 0 }, release: { value: 0 }, reduction: 0,
      connect() {}, disconnect() {}, port: {}, parameters: new Map([['semitones', { value: 0 }]]) };
  }
  class FakeAudioContext {
    constructor() {
      this.state = 'running'; this.sampleRate = 96000; this.destination = node();
      this.audioWorklet = { addModule: async () => {} }; contexts.push(this);
    }
    async setSinkId(id) { this.sinkId = id; }
    async close() { this.state = 'closed'; }
    async resume() { this.state = 'running'; }
    createGain() { return node(); }
    createBiquadFilter() { return node(); }
    createDynamicsCompressor() { return node(); }
    createWaveShaper() { return node(); }
    createAnalyser() { return node(); }
    createMediaStreamSource() { return node(); }
  }
  const sandbox = { document, navigator: { mediaDevices }, console,
    AudioContext: FakeAudioContext, AudioWorkletNode: function () { return node(); },
    requestAnimationFrame() {}, setTimeout, clearTimeout };
  let src = fs.readFileSync(path.join(root, 'bridge/bridge.js'), 'utf8').replace(/^export /gm, '');
  const lastBrace = src.lastIndexOf('}');
  src = src.slice(0, lastBrace) + 'globalThis.audit = { start, stop, state };\n' + src.slice(lastBrace);
  vm.runInNewContext(src, sandbox);
  return { ...sandbox.audit, pending, streams, contexts, document,
    release() {
      const track = { stopped: false, stop() { this.stopped = true; } };
      const stream = { getTracks: () => [track] }; streams.push(track); pending.shift()(stream);
    }
  };
}

const cancelled = fakePage([bh, ifi]);
const starting = cancelled.start();
await tick();
cancelled.stop('User pressed Stop while permission was pending');
cancelled.release();
await starting;
report('start resolves after Stop', { running: cancelled.state.running,
  tracksStillActive: cancelled.streams.filter(t => !t.stopped).length });
cancelled.stop();

const double = fakePage([bh, ifi]);
const first = double.start(), second = double.start();
await tick();
double.release(); double.release();
await Promise.all([first, second]);
double.stop();
report('two pending Starts then Stop', {
  tracksStillActive: double.streams.filter(t => !t.stopped).length,
  contextsStillActive: double.contexts.filter(c => c.state !== 'closed').length
});

const hidden = fakePage([{ kind: 'audioinput', deviceId: '', label: '' }, { kind: 'audiooutput', deviceId: '', label: '' }]);
await hidden.start();
report('fresh permission state cannot start', { permissionRequests: hidden.pending.length,
  status: hidden.document.getElementById('status').textContent });

// Construct a valid, uncompressed one-record SSTable in memory. The LevelDB block
// handle's size excludes its five-byte compression/checksum trailer.
let extractor = fs.readFileSync(path.join(root, 'tools/extract-chrome-settings.mjs'), 'utf8');
extractor = extractor.replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '').replace(/\nmain\(\);\s*$/, '');
const db = { Buffer, Uint32Array };
vm.runInNewContext(extractor + '\nglobalThis.audit = { readSstable, readBlock, crc32c };', db);
const varint = value => {
  const bytes = [];
  while (value >= 128) { bytes.push((value & 127) | 128); value >>>= 7; }
  bytes.push(value); return Buffer.from(bytes);
};
const block = (key, value) => {
  const restart = Buffer.alloc(8); restart.writeUInt32LE(1, 4);
  return Buffer.concat([varint(0), varint(key.length), varint(value.length), key, value, restart]);
};
const trailer = body => {
  const typed = Buffer.concat([body, Buffer.from([0])]);
  const crc = db.audit.crc32c(typed, 0, typed.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32LE((((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0);
  return Buffer.concat([typed, checksum]);
};
const tag = Buffer.alloc(8); tag.writeBigUInt64LE((1n << 8n) | 1n);
const key = Buffer.concat([Buffer.from('lastSpeed'), tag]);
const data = block(key, Buffer.from('1.5'));
const storedData = trailer(data);
const meta = Buffer.alloc(8); meta.writeUInt32LE(1, 4);
const storedMeta = trailer(meta);
const index = block(key, Buffer.concat([varint(0), varint(data.length)]));
const footer = Buffer.alloc(48);
Buffer.concat([varint(storedData.length), varint(meta.length),
  varint(storedData.length + storedMeta.length), varint(index.length)]).copy(footer);
footer.writeUInt32LE(0x8b80fb57, 40); footer.writeUInt32LE(0xdb477524, 44);
const table = Buffer.concat([storedData, storedMeta, trailer(index), footer]);
try { report('SSTable expected one setting, decoded', db.audit.readSstable(table).length); }
catch (err) { report('SSTable expected one setting, error', err.message); }
report('block handle expected ' + data.length + ' payload bytes, decoded', db.audit.readBlock(storedData, 0, data.length).length);

// Compare the current real VSC database read-only, correcting only block length
// in memory. No profile, production script, or exported settings are written.
const corrected = { fs, path, Buffer, Uint32Array };
vm.runInNewContext(extractor.replace('file.subarray(offset, offset + size);',
  'file.subarray(offset, offset + size + 5);') + '\nglobalThis.load = loadDatabase;', corrected);
const dbPath = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Profile 1/Sync Extension Settings/nffaoalbilbmmfgbnbgppjihopabppdk');
const saved = JSON.parse(fs.readFileSync(path.join(root, 'orion/extracted-settings.json'), 'utf8'));
const decoded = corrected.load(dbPath).settings;
report('VSC fields differing after in-memory SST length correction',
  Object.keys({ ...saved.videoSpeedController.settings, ...decoded }).filter(k =>
    JSON.stringify(saved.videoSpeedController.settings[k]) !== JSON.stringify(decoded[k])));

// Reuse only the supplied suite's pure DOM/Chrome mock helpers (no tests run).
let helpers = fs.readFileSync(path.join(root, 'tests/verify-all.mjs'), 'utf8')
  .replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '');
helpers = helpers.slice(0, helpers.indexOf('const tests = [];')) + '\nglobalThis.makeRun = runScript;';
const helperContext = { fs, path, vm, crypto, console, Promise, URL, Blob,
  TextEncoder, TextDecoder, performance, structuredClone, atob, btoa,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask };
vm.runInNewContext(helpers, helperContext);
let localReads = 0, localWrites = 0;
const content = helperContext.makeRun('content-bridge.js', fs.readFileSync(
  path.join(root, 'orion/staged-extensions/video-speed-controller/content-bridge.js'), 'utf8'), { before(s) {
    delete s.chrome.storage.sync;
    s.chrome.storage.local = {
      get(keys, cb) {
        localReads++;
        const value = { enabled: true, lastSpeed: 4, keyBindings: [{ action: 'display', value: 0 }] };
        if (cb) cb(value); return Promise.resolve(value);
      },
      set(value, cb) { localWrites++; if (cb) cb(); return Promise.resolve(); }
    };
  } });
await new Promise(resolve => setTimeout(resolve, 600));
const delivered = [];
content.document.documentElement.addEventListener('VSC_SETTINGS_READY', ev => delivered.push(ev.detail.settings));
content.document.documentElement.dispatchEvent({ type: 'VSC_REQUEST_SETTINGS' });
await tick();
report('local-only storage is ignored', { localReads, localWrites, expectedSpeed: 4, deliveredSpeed: delivered[0]?.lastSpeed });

// Verify presets by parsing the read-only source object, without executing it.
const tidal = process.env.TIDAL_EXTENSION_DIR || path.join(os.homedir(), 'Documents/ChatGPT/tidal-miniplayer-extension');
const upstream = fs.readFileSync(path.join(tidal, 'background.js'), 'utf8');
const presetText = upstream.match(/const FACTORY_PRESETS = (\{[\s\S]*?\n\});/)[1];
const expectedPresets = vm.runInNewContext('(' + presetText + ')');
report('factory presets exactly equal source', JSON.stringify(expectedPresets) === JSON.stringify(bridge.FACTORY_PRESETS));
console.log('All reproductions completed using mocks; no audio hardware or browser opened.');
