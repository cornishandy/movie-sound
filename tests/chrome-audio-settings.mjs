// Checks the Chrome audio-settings import (tools/import-chrome-audio-settings.mjs) without opening any audio device.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import(pathToFileURL(path.join(ROOT, 'bridge/chrome-settings.js')).href);
const bridge = await import(pathToFileURL(path.join(ROOT, 'bridge/bridge.js')).href + '?with-chrome');
const s = globalThis.CHROME_AUDIO_SETTINGS;
let pass = 0, fail = 0;
const check = (name, ok, got) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' — got ' + JSON.stringify(got)}`); };
check('settings loaded as a global', !!(s && s.presets && s.startup), s && Object.keys(s));
check('starts on the preset Chrome is using', bridge.STARTUP_PRESET_NAME === s.startup.preset, bridge.STARTUP_PRESET_NAME);
check('startup dynamics match Chrome', JSON.stringify(bridge.STARTUP_DYNAMICS) === JSON.stringify(bridge.normaliseDynamics(s.startup.dynamics)), bridge.STARTUP_DYNAMICS);
check('every Chrome preset resolves to its own values', Object.entries(s.presets).every(([n, p]) => bridge.presetParams(n).bass === p.bass && bridge.presetParams(n).hpf === p.hpf), null);
check('factory presets untouched', bridge.presetParams('Late Night Movies & Dialogue').hpf === 45 && !s.presets['Late Night Movies & Dialogue'], null);
if (s.presets['801']) check('stage switches applied (801: HPF and gain off)', s.presets['801'].hpf === 20 && s.presets['801'].gain === 1, s.presets['801']);
if (s.presets['max-max-0']) check('max-max-0 = bass 13, mid 6, high 0, HPF 20, no auto-balance', JSON.stringify(bridge.presetParams('max-max-0')) === JSON.stringify({ bass: 13, hpf: 20, mid: 6, high: 0, gain: 1, semitones: 0, autoBalance: false, bypass: false }), bridge.presetParams('max-max-0'));
console.log(`${pass}/${pass + fail} passed; no browser or audio device opened`);
process.exit(fail ? 1 : 0);
