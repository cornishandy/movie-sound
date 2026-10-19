#!/usr/bin/env node
// Round 3 independent boundary checks. Node/VM mocks only; never opens a
// browser, microphone, AudioContext, or hardware output. Production is read-only.
// Run: node tests/review-r3-astra-boundaries.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as bridge from '../bridge/bridge.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const bh = { kind: 'audioinput', deviceId: 'bh2', label: 'BlackHole 2ch' };
const ifi = { kind: 'audiooutput', deviceId: 'ifi', label: 'iFi Pro iDSD' };

function fixture({ delayedResume = false, nativeSelect = false } = {}) {
  // Reuse the previous review's pure fixture, not its top-level reproductions.
  let helper = fs.readFileSync(path.join(root, 'orion/tests/live-repros.mjs'), 'utf8');
  helper = helper.slice(helper.indexOf('function fakePage(devices)'),
    helper.indexOf('const cancelled = fakePage'));
  if (delayedResume) {
    helper = helper.replace("this.state = 'running'; this.sampleRate",
      "this.state = contexts.length === 0 ? 'suspended' : 'running'; this.sampleRate");
    // Settlement of the old context's resume promise is controlled separately
    // from closing it, so the newer context can finish starting first.
    helper = helper.replace("async resume() { this.state = 'running'; }",
      "resume() { return new Promise((resolve, reject) => { this.rejectResume = () => reject(new Error('closed by newer start')); }); }");
  }
  if (nativeSelect) {
    // A real single-select chooses its first option unless another is selected.
    // The original review fixture did not model this browser default.
    helper = helper.replace('appendChild(child) { this.children.push(child); },',
      'appendChild(child) { this.children.push(child); if ((this.id === "input-device" || this.id === "output-device") && (!this.value || child.selected)) this.value = child.value; },');
  }
  const scope = { fs, path, vm, root, bridge, console, setTimeout, clearTimeout };
  vm.runInNewContext(helper + '\nglobalThis.makePage = fakePage;', scope);
  return scope.makePage;
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('a stale resume rejection must not clear a newer live capture', async () => {
  const page = fixture({ delayedResume: true })([bh, ifi]);
  let first;
  try {
    first = page.start();
    await tick();
    page.release();
    await tick();
    assert.equal(typeof page.contexts[0].rejectResume, 'function', 'first start did not reach resume');
    const second = page.start();
    await tick();
    page.release();
    await second;
    assert.equal(page.state.running, true, 'newer start did not become active');
    const currentContext = page.state.ctx;
    const currentStream = page.state.stream;
    page.contexts[0].rejectResume();
    await first;
    console.log('OBSERVED stale resume:', JSON.stringify({
      running: page.state.running, ctxPresent: !!page.state.ctx,
      streamPresent: !!page.state.stream,
      tracksStillActive: page.streams.filter(track => !track.stopped).length,
      contextsStillActive: page.contexts.filter(ctx => ctx.state !== 'closed').length
    }));
    assert.equal(page.state.running, true, 'stale start marked a newer live capture stopped');
    assert.equal(page.state.ctx, currentContext, 'stale start cleared the newer context');
    assert.equal(page.state.stream, currentStream, 'stale start cleared the newer stream');
  } finally {
    page.stop();
    page.contexts[0]?.rejectResume?.();
    if (first) await first;
  }
});

test('Stop must remain clickable while restarting after a previous Stop', async () => {
  const page = fixture()([bh, ifi]);
  page.stop();
  const restarting = page.start();
  try {
    await tick();
    assert.equal(page.pending.length, 1, 'restart did not reach pending capture');
    console.log('OBSERVED pending restart:', JSON.stringify({
      captureRequests: page.pending.length,
      stopButtonDisabled: page.document.getElementById('stop').disabled
    }));
    assert.equal(page.document.getElementById('stop').disabled, false,
      'the actual Stop button is disabled while capture permission is pending');
  } finally {
    page.stop();
    if (page.pending.length) page.release();
    await restarting;
  }
});

test('the default dropdown must not turn BlackHole 16ch into an explicit user choice', async () => {
  const page = fixture({ nativeSelect: true })([
    { ...bh, deviceId: 'bh16', label: 'BlackHole 16ch' }, ifi
  ]);
  await tick(); // initial refreshDevices populates the dropdown
  const starting = page.start(); // no input-selection interaction
  try {
    await tick();
    console.log('OBSERVED default 16ch:', JSON.stringify({
      selectedInput: page.document.getElementById('input-device').value,
      captureRequests: page.pending.length
    }));
    assert.equal(page.pending.length, 0,
      'pressing Start automatically captures BlackHole 16ch without explicit selection');
  } finally {
    page.stop();
    if (page.pending.length) page.release();
    await starting;
  }
});

let failures = 0;
for (const [name, run] of cases) {
  try { await run(); console.log('PASS ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.message); }
}
console.log(`${cases.length - failures}/${cases.length} passed; Node/VM mocks only; no browser or audio hardware opened`);
if (failures) process.exitCode = 1;
