#!/usr/bin/env node
// Follow Chrome: the bridge playing the Tidal extension's EQ live (movie-sound-link.js in the extension, 1.5.7+).
// Node/VM only, with a fake page and fake audio nodes: no browser, and no audio device is opened.
// Run: node tests/follow-chrome.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'bridge/bridge.js'), 'utf8').replace(/^export /gm, '');
const ORIGIN = 'http://127.0.0.1:8791';
const TIDAL = process.env.TIDAL_EXTENSION_DIR || path.join(os.homedir(), 'Documents/ChatGPT/tidal-miniplayer-extension');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const params = (over = {}) => ({ bass: 13, hpf: 20, mid: 6, high: 0, gain: 1, semitones: 0, autoBalance: false, ...over });
const settings = (over = {}) => ({
  source: 'tidal-eq-link', version: 1, type: 'chrome-eq-settings',
  presets: { 'max-max-0': params(), 'Punchy Bass & Clarity': params({ bass: 9, hpf: 30, mid: 1.5, high: 2, autoBalance: true }) },
  currentPreset: 'max-max-0',
  currentParams: params(),
  dynamics: { leveler: 'full', match: false, limiter: 'lookahead', ceiling: 'clean' },
  ...over
});

// A fake bridge page. `holdResume` keeps the audio context starting until the test lets it go.
function makePage({ follow = true, holdResume = false, withFollowBox = true } = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      id, value: '', checked: false, disabled: false, textContent: '', dataset: {}, children: [], listeners: {},
      appendChild(child) { this.children.push(child); },
      addEventListener(type, fn) { this.listeners[type] = fn; }
    });
    return elements.get(id);
  };
  element('input-device').value = 'bh2';
  element('output-device').value = 'ifi-1';
  element('movie-mode').checked = true;
  if (withFollowBox) {
    element('follow-chrome').checked = follow;
    element('follow-status');
  }
  const ramps = [];
  const param = (name) => ({
    name, value: 0,
    setTargetAtTime(v, t, tau) { ramps.push({ name: this.name, v, tau }); this.value = v; }
  });
  let n = 0;
  const node = () => {
    const id = 'n' + (n++);
    return {
      gain: param(id + '.gain'), frequency: param(id + '.frequency'), Q: param(id + '.Q'),
      threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 },
      connect() {}, disconnect() {}, port: {}, parameters: new Map([['semitones', { value: 0 }]])
    };
  };
  let releaseResume = null;
  class FakeContext {
    constructor() {
      this.state = holdResume ? 'suspended' : 'running';
      this.sampleRate = 96000; this.currentTime = 5; this.destination = node();
      this.audioWorklet = { async addModule() {} };
    }
    async setSinkId() {}
    resume() { return new Promise((resolve) => { releaseResume = () => { this.state = 'running'; resolve(); }; }); }
    async close() { this.state = 'closed'; }
    createMediaStreamSource() { return node(); }
    createGain() { return node(); }
    createBiquadFilter() { return node(); }
    createDynamicsCompressor() { return node(); }
    createWaveShaper() { return node(); }
    createAnalyser() { return node(); }
  }
  const posted = [];
  const winListeners = {};
  const timers = [];
  const win = {
    location: { origin: ORIGIN },
    addEventListener(type, fn) { winListeners[type] = fn; },
    postMessage(data, target) { posted.push({ data, target }); }
  };
  const sandbox = {
    console, Float32Array, Uint8Array, Math, JSON, Object, Number, Array, Promise,
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    AudioContext: FakeContext,
    AudioWorkletNode: class { constructor() { return node(); } },
    window: win,
    document: {
      getElementById: element,
      createElement: () => ({ value: '', textContent: '', label: '', selected: false, children: [], appendChild(c) { this.children.push(c); } })
    },
    navigator: { mediaDevices: {
      async enumerateDevices() {
        return [{ kind: 'audioinput', deviceId: 'bh2', label: 'BlackHole 2ch' }, { kind: 'audiooutput', deviceId: 'ifi-1', label: 'iFi Pro iDSD' }];
      },
      async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; },
      addEventListener() {}
    } },
    requestAnimationFrame() {}
  };
  vm.createContext(sandbox);
  // Expose the page's own state from inside its block, as orion/tests/live-repros.mjs does.
  const last = SRC.lastIndexOf('}');
  vm.runInContext(SRC.slice(0, last) + 'globalThis.audit = { state, presetParams, follow: () => follow };\n' + SRC.slice(last), sandbox);
  const audit = sandbox.audit;
  const page = {
    element, posted, ramps, timers, audit,
    state: () => audit.state,
    graph: () => audit.state.graph,
    deliver(data, { source = win, origin = ORIGIN } = {}) {
      if (winListeners.message) winListeners.message({ source, origin, data: JSON.parse(JSON.stringify(data)) });
    },
    deliverRaw(data) { if (winListeners.message) winListeners.message({ source: win, origin: ORIGIN, data }); },
    async start() {
      element('start').listeners.click();
      for (let i = 0; i < 50 && !audit.state.running && !releaseResume; i++) await tick();
    },
    async releaseStart() {
      assert.ok(releaseResume, 'start is not waiting');
      releaseResume();
      for (let i = 0; i < 50 && !audit.state.running; i++) await tick();
    },
    pick(id, value) {
      element(id).value = value;
      element(id).listeners.change();
    },
    status: () => element('follow-status').textContent,
    bass: () => audit.state.graph.bassNode.gain.value
  };
  return page;
}

test('Fable B1: while following, the sound comes from Chrome\'s current settings, never a menu-name lookup', async () => {
  const page = makePage();
  // A stored preset shares a factory name but has its own values: Chrome plays 9, the factory preset is 5.
  page.deliver(settings({ currentPreset: 'Punchy Bass & Clarity', currentParams: params({ bass: 9, hpf: 30, mid: 1.5, high: 2, autoBalance: true }) }));
  await page.start();
  assert.equal(page.state().running, true);
  assert.equal(page.bass(), 9, 'Start played the factory preset by name');
  page.deliver(settings({ currentParams: params({ bass: 7 }) }));
  assert.equal(page.bass(), 7, 'a live change did not reach the running graph');
});

test('Sol B1: settings that change while Start is still waiting are the ones that play', async () => {
  const page = makePage({ holdResume: true });
  page.deliver(settings());
  await page.start();
  assert.equal(page.state().running, false, 'start should be waiting');
  page.deliver(settings({ currentParams: params({ bass: 11 }) }));
  await page.releaseStart();
  assert.equal(page.state().running, true);
  assert.equal(page.bass(), 11, 'the graph kept the value from before the wait');
  // The same holds for a pick by hand while not following.
  const manual = makePage({ follow: false, holdResume: true });
  manual.element('preset').value = 'Late Night Movies & Dialogue';
  await manual.start();
  manual.pick('preset', 'Club / Festival Bangers');
  await manual.releaseStart();
  assert.equal(manual.bass(), 7, 'a pick made during start was lost');
});

test('Sol B2: malformed or out-of-range settings are refused whole, and the sound stays', async () => {
  const page = makePage();
  page.deliver(settings());
  await page.start();
  const before = JSON.stringify(page.state().params);
  const bad = [
    { currentParams: params({ bass: null }) },
    { currentParams: params({ gain: 'loud' }) },
    { currentParams: params({ semitones: 99 }) },
    { currentParams: params({ hpf: 10 }) },
    { currentParams: params({ bass: 15 }) },
    { currentParams: params({ stageBypass: { bass: 'yes' } }) },
    { currentParams: params({ autoBalance: 'no' }) },
    { currentParams: null },
    { currentParams: [1, 2] },
    { dynamics: { leveler: 'loud' } },
    { dynamics: { match: 'yes' } }
  ];
  for (const over of bad) {
    page.deliver(settings(over));
    assert.equal(JSON.stringify(page.state().params), before, 'applied ' + JSON.stringify(over));
    assert.match(page.status(), /can’t use/, 'status for ' + JSON.stringify(over));
  }
  page.deliverRaw(settings({ currentParams: params({ gain: NaN }) }));
  assert.equal(JSON.stringify(page.state().params), before, 'NaN gain applied');
  page.deliver(settings({ currentParams: params({ bass: 12 }) }));
  assert.equal(page.bass(), 12);
  assert.doesNotMatch(page.status(), /can’t use/, 'the warning stays after a good message');
});

test('Sol B3: live changes glide (30 ms EQ, 20 ms routing); setup is immediate', async () => {
  const page = makePage();
  page.deliver(settings());
  await page.start();
  assert.equal(page.ramps.length, 0, 'setup should set values directly');
  page.deliver(settings({ currentParams: params({ bass: 5, gain: 2.5, autoBalance: true }) }));
  const bassRamp = page.ramps.find((r) => r.name === page.graph().bassNode.gain.name);
  assert.ok(bassRamp && bassRamp.v === 5 && bassRamp.tau === 0.03, 'bass did not glide');
  const route = page.ramps.find((r) => r.name === page.graph().autoBalanceWetGain.gain.name);
  assert.ok(route && route.tau === 0.02, 'routing did not glide');
  const count = page.ramps.length;
  page.deliver(settings({ currentParams: params({ bass: 5, gain: 2.5, autoBalance: true }) }));
  assert.equal(page.ramps.length, count, 'an unchanged message touched the graph');
});

test('only this page\'s own window, from the link script, version 1, counts', async () => {
  const page = makePage();
  page.deliver(settings({ currentParams: params({ bass: 1 }) }), { source: {} });
  page.deliver(settings({ currentParams: params({ bass: 1 }) }), { origin: 'http://evil.example' });
  page.deliver(settings({ source: 'someone-else', currentParams: params({ bass: 1 }) }));
  page.deliver(settings({ version: 2, currentParams: params({ bass: 1 }) }));
  assert.equal(page.audit.follow().chrome, null, 'a foreign message was accepted');
  const requests = page.posted.filter((p) => p.data.type === 'request-chrome-eq');
  assert.ok(requests.length >= 1 && requests.every((p) => p.target === ORIGIN && p.data.source === 'movie-sound' && p.data.version === 1), 'asks its own origin only');
  page.deliver({ source: 'tidal-eq-link', version: 1, type: 'chrome-eq-link-ready' });
  assert.equal(page.posted.filter((p) => p.data.type === 'request-chrome-eq').length, requests.length + 1, 'asks again when the link says it is ready');
});

test('preset names are plain data (Sol r1 B2)', async () => {
  const page = makePage();
  const presets = JSON.parse('{"constructor": {"bass": 2, "hpf": 20, "mid": 0, "high": 0, "gain": 1}, "__proto__": {"bass": 3, "hpf": 20, "mid": 0, "high": 0, "gain": 1}, "Chrome\'s current settings": {"bass": 4, "hpf": 20, "mid": 0, "high": 0, "gain": 1}}');
  page.deliver(settings({ presets, currentPreset: 'constructor', currentParams: params({ bass: 2, mid: 0, autoBalance: true }) }));
  assert.equal(page.audit.presetParams('constructor').bass, 2);
  assert.equal(page.audit.presetParams('__proto__').bass, 3);
  assert.equal(page.audit.presetParams("Chrome's current settings").bass, 4);
  assert.equal(({}).bass, undefined, 'Object.prototype was touched');
  assert.match(page.status(), /Following Chrome: constructor/);
  const fresh = makePage({ follow: false });
  assert.equal(fresh.audit.presetParams('constructor').bass, fresh.audit.presetParams('Late Night Movies & Dialogue').bass, 'an unknown name must fall back to the default preset');
});

test('films: pitch is off; the AUDIO EQ switch is not read; "Flat (Bypass)" is followed', async () => {
  const page = makePage();
  page.deliver(settings({ currentParams: params({ semitones: -1.7 }), isAudioCapturing: false }));
  await page.start();
  assert.equal(page.state().params.semitones, 0);
  assert.match(page.status(), /Pitch is off for films/);
  assert.equal(page.graph().dspPathGain.gain.value, 1, 'the power switch turned Movie Sound off');
  page.deliver(settings({ currentPreset: 'Flat (Bypass)', currentParams: { bass: 0, hpf: 20, mid: 0, high: 0, gain: 1, semitones: 0, autoBalance: false, bypass: true } }));
  assert.equal(page.graph().dspPathGain.gain.value, 0);
  assert.equal(page.graph().directPassThroughGain.gain.value, 1);
});

test('unsaved changes are followed and shown as such', async () => {
  const page = makePage();
  page.deliver(settings());
  assert.match(page.status(), /^Following Chrome: max-max-0\.$/);
  page.deliver(settings({ currentParams: params({ bass: 10 }) }));
  assert.match(page.status(), /max-max-0, changed and not saved/);
  assert.equal(page.state().params.bass, 10);
  page.deliver(settings({ currentPreset: 'gone', currentParams: params({ bass: 8 }) }));
  assert.match(page.status(), /its current settings/);
});

test('the controls are locked while following; a pick by hand stops following; ticking again restores Chrome', async () => {
  const page = makePage();
  page.deliver(settings({ currentParams: params({ bass: 10 }) }));
  await page.start();
  assert.equal(page.element('preset').disabled, true);
  assert.equal(page.element('dyn-limiter').disabled, true);
  page.element('follow-chrome').checked = false;
  page.element('follow-chrome').listeners.change();
  assert.equal(page.element('preset').disabled, false);
  assert.equal(page.bass(), 10, 'unticking changed the sound');
  page.pick('preset', 'Late Night Movies & Dialogue');
  assert.equal(page.bass(), 3.5);
  page.deliver(settings({ currentParams: params({ bass: 12 }) }));
  assert.equal(page.bass(), 3.5, 'followed Chrome while unticked');
  const asked = page.posted.length;
  page.element('follow-chrome').checked = true;
  page.element('follow-chrome').listeners.change();
  assert.equal(page.bass(), 12, 're-ticking did not restore Chrome\'s latest');
  assert.ok(page.posted.length > asked, 're-ticking did not ask Chrome again');
  // A programmatic pick while following is a pick by hand too.
  page.pick('dyn-limiter', 'fast');
  assert.equal(page.element('follow-chrome').checked, false);
  assert.equal(page.state().dynamics.limiter, 'fast');
});

test('Sol r3: a restart (Movie mode switch) keeps the sound chosen by hand, never re-reads the menu', async () => {
  const restart = async (page) => {
    page.element('movie-mode').checked = false;
    page.element('movie-mode').listeners.change();
    for (let i = 0; i < 50 && !(page.state().running && page.graph() && page.graph().live); i++) await tick();
    assert.equal(page.state().running, true, 'did not restart');
  };
  // Followed unsaved bass 10, then unticked: a restart must not swap in the saved preset (13).
  const a = makePage();
  a.deliver(settings({ currentParams: params({ bass: 10 }) }));
  await a.start();
  a.element('follow-chrome').checked = false;
  a.element('follow-chrome').listeners.change();
  await restart(a);
  assert.equal(a.bass(), 10, 'unsaved Chrome sound lost on restart');
  // Picked a preset by hand; Chrome then changes that preset while Follow is off: a restart keeps the pick.
  const b = makePage({ follow: false });
  b.deliver(settings());
  b.pick('preset', 'max-max-0');
  await b.start();
  assert.equal(b.bass(), 13);
  b.deliver(settings({ presets: { 'max-max-0': params({ bass: 2 }) } }));
  await restart(b);
  assert.equal(b.bass(), 13, 'a restart re-read the changed preset');
});

test('no extension: the saved presets play, and the page says it isn\'t linked', async () => {
  const page = makePage();
  page.element('preset').value = 'max-max-0';
  assert.match(page.status(), /Looking for the Tidal extension/);
  const wait = page.timers.find((t) => t.ms === 2000);
  assert.ok(wait, 'no not-linked timer');
  wait.fn();
  assert.match(page.status(), /Not linked to Chrome/);
  await page.start();
  assert.equal(page.state().running, true, 'Start must not wait for the extension');
  assert.equal(page.bass(), page.audit.presetParams('max-max-0').bass);
});

test('the link is lost after an extension reload: the sound stays and the page says so', async () => {
  const page = makePage();
  page.deliver(settings({ currentParams: params({ bass: 10 }) }));
  await page.start();
  page.deliver({ source: 'tidal-eq-link', version: 1, type: 'chrome-eq-link-lost' });
  assert.equal(page.bass(), 10);
  assert.match(page.status(), /Lost the link/);
});

test('a page without the Follow box (older pages and harnesses) behaves exactly as before', async () => {
  const page = makePage({ withFollowBox: false });
  page.element('preset').value = 'Late Night Movies & Dialogue';
  page.deliver(settings({ currentParams: params({ bass: 1 }) }));
  await page.start();
  assert.equal(page.bass(), 3.5);
  assert.equal(page.posted.length, 0, 'asked Chrome without a Follow box');
});

test('the real movie-sound-link.js feeds the bridge (skips without the Tidal extension repo)', async () => {
  const linkFile = path.join(TIDAL, 'movie-sound-link.js');
  if (!fs.existsSync(linkFile)) return 'SKIP (no ' + linkFile + '; set TIDAL_EXTENSION_DIR)';
  const page = makePage();
  // One shared fake window: the bridge's listener and the link script's listener both hear every post.
  const bridgeListener = page.posted; // the bridge's posts are recorded here; replay them to the link
  const linkListeners = [];
  const stored = { presets: settings().presets, currentPreset: 'max-max-0', currentParams: params({ bass: 6 }), dynamics: settings().dynamics };
  const changeListeners = [];
  const linkWindow = {
    postMessage(data) { page.deliver(data); },
    addEventListener(type, fn) { if (type === 'message') linkListeners.push(fn); }
  };
  linkWindow.top = linkWindow;
  const sandbox = {
    window: linkWindow, location: { origin: ORIGIN },
    Date, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    chrome: {
      runtime: { id: 'x' },
      storage: {
        local: { get: async (keys) => Object.fromEntries(keys.map((k) => [k, structuredClone(stored[k])])) },
        onChanged: { addListener(fn) { changeListeners.push(fn); } }
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(linkFile, 'utf8'), sandbox);
  // The bridge asked at load (before the link existed) and again on "ready": hand those asks to the link.
  for (const p of bridgeListener.filter((x) => x.data.type === 'request-chrome-eq')) {
    for (const fn of linkListeners) fn({ source: linkWindow, origin: ORIGIN, data: p.data });
  }
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(page.state().params.bass, 6, 'the bridge did not get the link\'s settings');
  stored.currentParams = params({ bass: 8 });
  for (const fn of changeListeners) fn({ currentParams: { newValue: stored.currentParams } }, 'local');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(page.state().params.bass, 8, 'a change in the extension did not arrive');
});

let failures = 0;
let skips = 0;
for (const [name, run] of cases) {
  try {
    const note = await run();
    if (typeof note === 'string' && note.startsWith('SKIP')) { skips++; console.log(note.replace('SKIP', 'SKIP ' + name)); }
    else console.log('PASS ' + name);
  } catch (err) {
    failures++;
    console.error('FAIL ' + name + '\n' + (err && err.stack ? err.stack : err));
  }
}
console.log(`${cases.length - failures - skips}/${cases.length - skips} passed${skips ? `, ${skips} skipped` : ''}; Node/VM mocks only; no browser or audio device opened`);
if (failures) process.exitCode = 1;
