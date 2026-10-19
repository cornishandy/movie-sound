#!/usr/bin/env node
/**
 * Copy the Tidal miniplayer extension's chrome.storage.local (Chrome Profile 1)
 * into a temp folder, read only that copy, and write bridge/chrome-settings.js:
 *   CHROME_PRESETS  your saved presets, with the extension's stage switches applied
 *                   the way offscreen.js applies them (HPF off = 20 Hz, EQ band off = 0 dB,
 *                   gain off = 1, pitch off = 0 semitones, comp off = no auto-balance)
 *   CHROME_STARTUP  the preset and dynamics Chrome is using now
 * Chrome's own files are never written. Re-run after changing presets in Chrome.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_ID = 'gponppchadgoilnlbogcdldbmpdoaeno';
const SRC = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Profile 1/Local Extension Settings', EXT_ID);
const OUT = path.join(ROOT, 'bridge/chrome-settings.js');

// The bridge's own conversion and checks, so the saved copy and live following agree exactly.
const { FACTORY_PRESETS, chromeEffectiveParams: effective, validChromeParams } = await import(pathToFileURL(path.join(ROOT, 'bridge/bridge.js')).href);
const isFactory = (name) => Object.prototype.hasOwnProperty.call(FACTORY_PRESETS, name);

// Reuse the LevelDB reader in extract-chrome-settings.mjs without running its main().
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-chrome-audio-'));
const extractor = fs.readFileSync(path.join(ROOT, 'tools/extract-chrome-settings.mjs'), 'utf8');
if (!/\nmain\(\);\s*$/.test(extractor)) throw new Error('extract-chrome-settings.mjs no longer ends with main();');
const readerPath = path.join(tmp, 'reader.mjs');
fs.writeFileSync(readerPath, extractor.replace(/\nmain\(\);\s*$/, '\nexport { loadDatabase };\n'));
const { loadDatabase } = await import(pathToFileURL(readerPath).href);

const copy = path.join(tmp, EXT_ID);
fs.cpSync(SRC, copy, { recursive: true });
fs.rmSync(path.join(copy, 'LOCK'), { force: true });
const { settings } = loadDatabase(copy);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const factoryEffective = (name) => effective({ ...FACTORY_PRESETS[name] });

// No prototype: a preset called "constructor" or "__proto__" is just a name.
const presets = Object.create(null);
const skipped = [];
for (const [name, p] of Object.entries(settings.presets || {})) {
  if (!validChromeParams(p)) { skipped.push(name); continue; }
  const eff = effective(p);
  if (isFactory(name) && same(eff, factoryEffective(name))) continue; // stored copy of a factory preset
  presets[isFactory(name) ? `${name} (your version)` : name] = eff;
}

let startupPreset = settings.currentPreset;
if (typeof startupPreset !== 'string') startupPreset = null;
if (startupPreset && isFactory(startupPreset) && presets[`${startupPreset} (your version)`]) startupPreset = `${startupPreset} (your version)`;
const current = validChromeParams(settings.currentParams) ? effective(settings.currentParams) : null;
const named = (startupPreset && presets[startupPreset]) || (isFactory(startupPreset) && factoryEffective(startupPreset));
if (current && !(named && same(current, named))) {
  // Unsaved slider changes get their own entry, under a name no real preset uses.
  let label = "Chrome's current settings";
  for (let n = 2; presets[label] || isFactory(label); n++) label = `Chrome's current settings (${n})`;
  presets[label] = current;
  startupPreset = label;
}
const dyn = settings.dynamics || {};
const startup = {
  preset: startupPreset || null,
  dynamics: { leveler: dyn.leveler, match: dyn.match === true, limiter: dyn.limiter, ceiling: dyn.ceiling }
};

const body = `// Generated ${new Date().toISOString()} by tools/import-chrome-audio-settings.mjs
// from a read-only copy of the Tidal miniplayer extension's Chrome settings. Re-run it after changing presets in Chrome.
// Loaded by index.html as a plain script before bridge.js.
globalThis.CHROME_AUDIO_SETTINGS = ${JSON.stringify({ presets, startup }, null, 2)};
`;
fs.writeFileSync(OUT, body);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Wrote ${OUT}: ${Object.keys(presets).length} presets; starts on "${startup.preset}" with ${JSON.stringify(startup.dynamics)}`);
if (skipped.length) console.log(`Skipped ${skipped.length} preset(s) with values outside the extension's slider ranges: ${skipped.join(', ')}`);
