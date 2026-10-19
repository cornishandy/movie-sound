#!/usr/bin/env node
// Independent review regressions: Node/VM only; all media APIs are mocks.
// Run: node tests/review-sol-adversarial.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const bridge = await import(pathToFileURL(path.join(ROOT, 'bridge/bridge.js')));
const cases = [];
const test = (name, fn) => cases.push([name, fn]);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('capture must pin a concrete output, never the system-default alias', () => {
  const bh = { kind: 'audioinput', deviceId: 'bh2', label: 'BlackHole 2ch' };
  const alias = { kind: 'audiooutput', deviceId: 'default', label: 'Default - iFi Pro iDSD' };
  const ifi = { kind: 'audiooutput', deviceId: 'ifi-1', label: 'iFi Pro iDSD' };
  const auto = bridge.planCapture([bh, alias, ifi]);
  assert.equal(auto.outputDeviceId, 'ifi-1', 'automatic selection pins the mutable default alias');
  const explicit = bridge.planCapture([bh, alias, ifi], { outputDeviceId: 'default' });
  assert.ok(!explicit.ok || explicit.outputDeviceId === 'ifi-1', 'explicit default alias must be rejected or resolved');
});

function extractorFunctions() {
  const src = read('tools/extract-chrome-settings.mjs')
    .replace(/^import .*;\n/gm, '')
    .replace(/\nmain\(\);\s*$/, '');
  const sandbox = { Buffer, console };
  vm.createContext(sandbox);
  vm.runInContext(src + '\nglobalThis.review = { readBlock, parseDataBlock, readSstable };', sandbox);
  return sandbox.review;
}

test('SSTable block handles exclude the five-byte trailer', () => {
  const { readBlock } = extractorFunctions();
  const payload = Buffer.from('a normal uncompressed LevelDB table block');
  const withTrailer = Buffer.concat([payload, Buffer.alloc(5)]);
  assert.deepEqual(readBlock(withTrailer, 0, payload.length), payload);
});

function extensionHelpers() {
  // Reuse only the supplied DOM mock helpers, never their tests/extractor.
  const src = read('tests/verify-all.mjs').split('const tests = [];')[0].replace(/^import .*;\n/gm, '');
  const sandbox = {
    fs, path, vm, crypto, console, setTimeout, clearTimeout, setInterval,
    clearInterval, queueMicrotask, URL, Blob, TextEncoder, TextDecoder,
    performance, structuredClone, atob, btoa
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\nglobalThis.review = { runScript };', sandbox);
  return sandbox.review;
}

test('late native MAIN injection must preserve an existing controller registry', () => {
  if (!fs.existsSync(path.join(ROOT, 'orion/staged-extensions/video-speed-controller/inject.js'))) return 'SKIP (Orion; stage first: node tools/extract-chrome-settings.mjs && node orion/stage-extensions.mjs)';
  const { runScript } = extensionHelpers();
  const original = { sentinel: true };
  const ran = runScript('inject.js', read('orion/staged-extensions/video-speed-controller/inject.js'), {
    before(sandbox) {
      sandbox.VSC_controller = { initialized: true };
      sandbox.VSC = { stateManager: original };
      sandbox.addEventListener = () => {};
      sandbox.removeEventListener = () => {};
    }
  });
  assert.equal(ran.sandbox.VSC.stateManager, original, 'bundle resets stateManager before its duplicate-controller guard');
});

test('Stop cancels a Start waiting for capture permission', async () => {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: false, disabled: false, textContent: '', dataset: {}, children: [],
      listeners: {}, appendChild(child) { this.children.push(child); },
      addEventListener(type, fn) { this.listeners[type] = fn; }
    });
    return elements.get(id);
  };
  element('input-device').value = 'bh2';
  element('output-device').value = 'ifi-1';
  element('preset').value = 'Late Night Movies & Dialogue';
  element('movie-mode').checked = true;
  for (const [id, value] of [['dyn-leveler', 'full'], ['dyn-limiter', 'fast'], ['dyn-ceiling', 'clean']]) element(id).value = value;
  const devices = [
    { kind: 'audioinput', deviceId: 'bh2', label: 'BlackHole 2ch' },
    { kind: 'audiooutput', deviceId: 'ifi-1', label: 'iFi Pro iDSD' }
  ];
  let resolveCapture;
  let captureRequested = false;
  let tracksStopped = 0;
  let contextClosed = 0;
  const node = () => ({
    gain: { value: 0 }, frequency: { value: 0 }, Q: { value: 0 },
    threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 },
    attack: { value: 0 }, release: { value: 0 }, connect() {},
    port: {}, parameters: new Map([['semitones', { value: 0 }]])
  });
  class MockContext {
    constructor() {
      this.state = 'running'; this.sampleRate = 96000; this.destination = node();
      this.audioWorklet = { async addModule() {} };
    }
    async setSinkId() {}
    async close() { contextClosed++; this.state = 'closed'; }
    createMediaStreamSource() { return node(); }
    createGain() { return node(); }
    createBiquadFilter() { return node(); }
    createDynamicsCompressor() { return node(); }
    createWaveShaper() { return node(); }
    createAnalyser() { return node(); }
  }
  const sandbox = {
    console, setTimeout, clearTimeout, Float32Array, Uint8Array,
    AudioContext: MockContext,
    AudioWorkletNode: class { constructor() { return node(); } },
    document: {
      getElementById: element,
      createElement: () => ({ value: '', textContent: '' })
    },
    navigator: { mediaDevices: {
      async enumerateDevices() { return devices; },
      getUserMedia() {
        captureRequested = true;
        return new Promise((resolve) => { resolveCapture = resolve; });
      },
      addEventListener() {}
    } },
    requestAnimationFrame() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(read('bridge/bridge.js').replace(/^export /gm, ''), sandbox);
  element('start').listeners.click();
  for (let n = 0; !captureRequested && n < 20; n++) await tick();
  assert.ok(captureRequested, 'mock Start did not reach capture');
  element('stop').listeners.click();
  assert.equal(element('status').textContent, 'Stopped.');
  resolveCapture({ getTracks: () => [{ stop() { tracksStopped++; } }] });
  for (let n = 0; n < 5; n++) await tick();
  assert.equal(element('status').textContent, 'Stopped.', 'pending Start resumed after Stop');
  assert.ok(tracksStopped > 0 && contextClosed > 0, 'cancelled startup leaked capture/context');
});

let failures = 0;
let skips = 0;
for (const [name, run] of cases) {
  try {
    const note = await run();
    if (typeof note === 'string' && note.startsWith('SKIP')) { skips++; console.log(note.replace('SKIP', 'SKIP ' + name)); }
    else console.log('PASS ' + name);
  }
  catch (err) { failures++; console.error('FAIL ' + name + '\n' + err.name + ': ' + err.message); }
}
console.log(`${cases.length - failures - skips}/${cases.length - skips} passed${skips ? `, ${skips} skipped` : ''}; Node/VM mocks only; no browser or audio device opened`);
if (failures) process.exitCode = 1;
