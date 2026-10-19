#!/usr/bin/env node
/**
 * Stage unpacked Orion/Safari copies of the two Chrome extensions.
 * Reads extracted-settings.json. Does not write into the Chrome profile.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// orion/ in the movie-sound repo. extracted-settings.json and staged-extensions/ are personal and git-ignored.
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const EXTRACTED = path.join(ROOT, 'extracted-settings.json');
const CHROME_EXT = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Profile 1/Extensions');
const VSC_SRC = path.join(CHROME_EXT, 'nffaoalbilbmmfgbnbgppjihopabppdk/0.11.1_0');
const HTML_SRC = path.join(CHROME_EXT, 'hgpaaanfcfejapmifdjoljedjhbjceli/1.70_0');
const VSC_DEST = path.join(ROOT, 'staged-extensions/video-speed-controller');
const HTML_DEST = path.join(ROOT, 'staged-extensions/html5-speed-subs');

const extracted = JSON.parse(fs.readFileSync(EXTRACTED, 'utf8'));
const vscSettings = extracted.videoSpeedController.settings;
const hdr = extracted.hdrProfile;
// The subtitle fonts in your saved styles. Orion has no chrome.fontSettings, so the options page gets a fixed
// list, and it must include these or it can't select your saved font.
const savedFonts = [...new Set(['subsStyl', 'subsStylTwo']
  .flatMap((n) => [(hdr.settgs.find((row) => row.n === n) || {}).s, hdr[n]])
  .filter((style) => typeof style === 'string')
  .flatMap((style) => [...style.matchAll(/font-family:\s*([^;]+)/g)].map((m) => m[1].trim())))];
const fallbackFonts = [...new Set(['sans-serif', 'Arial', 'Helvetica', 'Segoe UI', ...savedFonts])]
  .map((font) => font.replace(/\\/g, '\\\\').replace(/'/g, "\\'"))
  .map((font) => `\t\t{ fontId: '${font}', displayName: '${font}' }`).join(',\n');
const REQUIRED_VSC_KEYS = [
  'audioBoolean',
  'controllerButtonSize',
  'defaultLogLevel',
  'logLevel',
  'speed',
  'keyBindings',
  'schemaVersion',
  'lastSpeed',
  'rememberSpeed',
  'exclusiveKeys'
];
for (const key of REQUIRED_VSC_KEYS) {
  if (!Object.prototype.hasOwnProperty.call(vscSettings, key)) {
    throw new Error('Refusing to stage: VSC settings missing ' + key);
  }
}
if (!Array.isArray(vscSettings.keyBindings) || vscSettings.keyBindings.length !== 24) {
  throw new Error('Refusing to stage: VSC keyBindings is not 24');
}
if (!Array.isArray(hdr.scObjs) || hdr.scObjs.length !== 14) throw new Error('Refusing to stage: scObjs is not 14');
if (!Array.isArray(hdr.settgs) || hdr.settgs.length !== 16) throw new Error('Refusing to stage: settgs is not 16');
if (hdr.settgs.find((row) => row.n === 'colMat').s !== false) throw new Error('HDR colMat must be false');

function copyExtension(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      return base !== '_metadata' && base !== '.DS_Store';
    }
  });
}

function mustReplace(file, from, to, label) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(from)) throw new Error(`Patch target missing (${label}) in ${file}`);
  const next = text.replace(from, to);
  if (next === text) throw new Error(`Patch did not change ${label}`);
  fs.writeFileSync(file, next);
}

function storageHelpers() {
  return [
    'var ANDY_HTML5_SC_OBJS = ' + JSON.stringify(hdr.scObjs) + ';',
    'var ANDY_HTML5_SETTGS = ' + JSON.stringify(hdr.settgs) + ';',
    'var ANDY_HTML5_SUBS_STYL = ' + JSON.stringify(hdr.subsStyl) + ';',
    'var selectStyl = null;',
    '// HDR movie copy: colMat is false so the SVG feColorMatrix filter stays off <video>.',
    '// WebKit can composite that filter in SDR and strip HDR highlights. Andy\'s Chrome value was true.',
    '// The options checkbox still toggles colMat. The remaining-time clock is rmng() (duration / playbackRate).',
    '// Subtitle delay, fine delay, move, and subsStyl are Andy\'s exact saved values.',
    ''
  ].join('\n') + `
var andyHtml5Raw = { syncGet: null, syncSet: null, localGet: null, localSet: null };
try {
  if (chrome.storage && chrome.storage.sync && typeof chrome.storage.sync.get === 'function') {
    andyHtml5Raw.syncGet = chrome.storage.sync.get.bind(chrome.storage.sync);
  }
} catch (e) { andyHtml5Raw.syncGet = null; }
try {
  if (chrome.storage && chrome.storage.sync && typeof chrome.storage.sync.set === 'function') {
    andyHtml5Raw.syncSet = chrome.storage.sync.set.bind(chrome.storage.sync);
  }
} catch (e) { andyHtml5Raw.syncSet = null; }
try {
  if (chrome.storage && chrome.storage.local && typeof chrome.storage.local.get === 'function') {
    andyHtml5Raw.localGet = chrome.storage.local.get.bind(chrome.storage.local);
  }
} catch (e) { andyHtml5Raw.localGet = null; }
try {
  if (chrome.storage && chrome.storage.local && typeof chrome.storage.local.set === 'function') {
    andyHtml5Raw.localSet = chrome.storage.local.set.bind(chrome.storage.local);
  }
} catch (e) { andyHtml5Raw.localSet = null; }

function andyHtml5Call(method, payload, done) {
  var primary = method === 'get' ? andyHtml5Raw.syncGet : andyHtml5Raw.syncSet;
  var secondary = method === 'get' ? andyHtml5Raw.localGet : andyHtml5Raw.localSet;
  var empty = method === 'get' ? {} : undefined;
  function attempt(fn, next) {
    if (typeof fn !== 'function') { next(); return; }
    var settled = false;
    function ok(value) {
      if (settled) return;
      settled = true;
      done(value);
    }
    function bad() {
      if (settled) return;
      settled = true;
      next();
    }
    var ret;
    try {
      ret = fn(payload, function (value) {
        var err = chrome.runtime && chrome.runtime.lastError;
        if (err) bad();
        else ok(value);
      });
    } catch (e) {
      bad();
      return;
    }
    if (ret && typeof ret.then === 'function') {
      ret.then(function (value) {
        var err = chrome.runtime && chrome.runtime.lastError;
        if (err) bad();
        else ok(value);
      }).catch(function () { bad(); });
    }
    setTimeout(function () { bad(); }, 500);
  }
  attempt(primary, function () {
    attempt(secondary, function () { done(empty); });
  });
}

function html5StorageGet(keys, callback) {
  andyHtml5Call('get', keys, function (items) {
    callback(items && typeof items === 'object' ? items : {});
  });
}

function html5StorageSet(obj, callback) {
  andyHtml5Call('set', obj, function () {
    if (callback) callback();
  });
}

function installHtml5StorageFacade() {
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  if (!chrome.storage.sync) chrome.storage.sync = {};
  var sync = chrome.storage.sync;
  if (sync.__andyLocalBacked) return;
  sync.get = function (keys, cb) {
    andyHtml5Call('get', keys, function (items) {
      var value = items && typeof items === 'object' ? items : {};
      if (typeof cb === 'function') cb(value);
    });
  };
  sync.set = function (obj, cb) {
    andyHtml5Call('set', obj, function () {
      if (typeof cb === 'function') cb();
    });
  };
  sync.__andyLocalBacked = true;
}
installHtml5StorageFacade();

function andyHtml5Payload() {
  return {
    scObjs: JSON.parse(JSON.stringify(ANDY_HTML5_SC_OBJS)),
    settgs: JSON.parse(JSON.stringify(ANDY_HTML5_SETTGS)),
    subsStyl: ANDY_HTML5_SUBS_STYL
  };
}
`;
}

function renderContentBridge(settings) {
  const template = fs.readFileSync(path.join(ROOT, 'content-bridge.template.js'), 'utf8');
  if (!template.includes('__ANDY_VSC_SETTINGS_JSON__')) throw new Error('content-bridge template placeholder missing');
  return template.replace('__ANDY_VSC_SETTINGS_JSON__', JSON.stringify(settings));
}

function renderBackgroundHelper(settings) {
  return 'const ANDY_VSC_SETTINGS = ' + JSON.stringify(settings) + ';\n' + `
const andyRaw = { syncGet: null, syncSet: null, localGet: null, localSet: null };
try { andyRaw.syncGet = globalThis.chrome.storage.sync['get'].bind(globalThis.chrome.storage.sync); } catch (e) { andyRaw.syncGet = null; }
try { andyRaw.syncSet = globalThis.chrome.storage.sync['set'].bind(globalThis.chrome.storage.sync); } catch (e) { andyRaw.syncSet = null; }
try { andyRaw.localGet = globalThis.chrome.storage.local['get'].bind(globalThis.chrome.storage.local); } catch (e) { andyRaw.localGet = null; }
try { andyRaw.localSet = globalThis.chrome.storage.local['set'].bind(globalThis.chrome.storage.local); } catch (e) { andyRaw.localSet = null; }
function andyStorageCall(method, payload) {
  const primary = method === 'get' ? andyRaw.syncGet : andyRaw.syncSet;
  const secondary = method === 'get' ? andyRaw.localGet : andyRaw.localSet;
  const empty = method === 'get' ? {} : undefined;
  function attempt(fn) {
    return new Promise((resolve, reject) => {
      if (typeof fn !== 'function') { reject(new Error('storage missing')); return; }
      let settled = false;
      const ok = (value) => { if (!settled) { settled = true; resolve(value); } };
      const bad = (err) => { if (!settled) { settled = true; reject(err || new Error('storage failed')); } };
      let ret;
      try {
        ret = fn(payload, (value) => {
          const err = globalThis.chrome.runtime && globalThis.chrome.runtime.lastError;
          if (err) bad(err); else ok(value);
        });
      } catch (err) { bad(err); return; }
      if (ret && typeof ret.then === 'function') {
        ret.then((value) => {
          const err = globalThis.chrome.runtime && globalThis.chrome.runtime.lastError;
          if (err) bad(err); else ok(value);
        }).catch(bad);
      }
      setTimeout(() => bad(new Error('storage timeout')), 500);
    });
  }
  return attempt(primary).catch(() => attempt(secondary)).catch(() => empty);
}
function installBackgroundStorageFacade() {
  if (!globalThis.chrome || !globalThis.chrome.storage) return;
  if (!globalThis.chrome.storage.sync) globalThis.chrome.storage.sync = {};
  const sync = globalThis.chrome.storage.sync;
  if (sync.__andyLocalBacked) return;
  sync['get'] = (keys, cb) => andyStorageCall('get', keys).then((items) => {
    const value = items && typeof items === 'object' ? items : {};
    if (typeof cb === 'function') cb(value);
    return value;
  });
  sync['set'] = (obj, cb) => andyStorageCall('set', obj).then(() => { if (typeof cb === 'function') cb(); });
  sync.__andyLocalBacked = true;
}
installBackgroundStorageFacade();
function vscRawGet(keys) {
  return andyStorageCall('get', keys).then((items) => (items && typeof items === 'object' ? items : {}));
}
function vscRawSet(obj) {
  return andyStorageCall('set', obj).then(() => undefined);
}
let andySeedPromise = null;
function ensureAndySeed() {
  if (!andySeedPromise) {
    andySeedPromise = vscRawGet(null).then((items) => {
      if (items && Array.isArray(items.keyBindings) && items.keyBindings.length > 0) return items;
      const seeded = { ...ANDY_VSC_SETTINGS };
      return vscRawSet(seeded).then(() => seeded);
    }).catch((err) => {
      console.error('[VSC] Settings seed failed:', err);
      return { ...ANDY_VSC_SETTINGS };
    });
  }
  return andySeedPromise;
}
function vscStorageGet(keys) {
  return ensureAndySeed().then((all) => {
    const src = all && typeof all === 'object' ? all : { ...ANDY_VSC_SETTINGS };
    if (keys == null) return { ...src };
    if (typeof keys === 'string') return { [keys]: src[keys] };
    if (Array.isArray(keys)) {
      const out = {};
      for (const key of keys) out[key] = src[key];
      return out;
    }
    if (typeof keys === 'object') {
      const out = {};
      for (const key of Object.keys(keys)) out[key] = src[key] !== undefined ? src[key] : keys[key];
      return out;
    }
    return { ...src };
  });
}
`;
}

function andySettingsPrelude(settings) {
  return 'var ANDY_VSC_SETTINGS = ' + JSON.stringify(settings) + ';\n';
}

function vscUiStorageShim() {
  return `(() => {
  if (!globalThis.chrome || !chrome.storage) return;
  if (!chrome.storage.sync) chrome.storage.sync = {};
  if (chrome.storage.sync.__andyDual) return;
  var sync = chrome.storage.sync;
  var rawGet = typeof sync.get === 'function' ? sync.get.bind(sync) : null;
  var rawSet = typeof sync.set === 'function' ? sync.set.bind(sync) : null;
  var rawLocalGet = chrome.storage.local && typeof chrome.storage.local.get === 'function' ? chrome.storage.local.get.bind(chrome.storage.local) : null;
  var rawLocalSet = chrome.storage.local && typeof chrome.storage.local.set === 'function' ? chrome.storage.local.set.bind(chrome.storage.local) : null;
  function attempt(fn, payload) {
    return new Promise(function (resolve, reject) {
      if (typeof fn !== 'function') { reject(new Error('storage missing')); return; }
      var settled = false;
      function ok(value) { if (!settled) { settled = true; resolve(value); } }
      function bad(err) { if (!settled) { settled = true; reject(err || new Error('storage failed')); } }
      var ret;
      try {
        ret = fn(payload, function (value) {
          var err = chrome.runtime && chrome.runtime.lastError;
          if (err) bad(err); else ok(value);
        });
      } catch (err) { bad(err); return; }
      if (ret && typeof ret.then === 'function') {
        ret.then(function (value) {
          var err = chrome.runtime && chrome.runtime.lastError;
          if (err) bad(err); else ok(value);
        }).catch(bad);
      }
      setTimeout(function () { bad(new Error('storage timeout')); }, 500);
    });
  }
  function callGet(keys) {
    return attempt(rawGet, keys).catch(function () { return attempt(rawLocalGet, keys); }).catch(function () { return {}; }).then(function (items) {
      return items && typeof items === 'object' ? items : {};
    });
  }
  function callSet(obj) {
    return attempt(rawSet, obj).catch(function () { return attempt(rawLocalSet, obj); }).catch(function () { return undefined; }).then(function () { return undefined; });
  }
  function project(src, keys) {
    if (keys == null) return Object.assign({}, src);
    if (typeof keys === 'string') {
      var one = {};
      one[keys] = src[keys];
      return one;
    }
    if (Array.isArray(keys)) {
      var listed = {};
      for (var i = 0; i < keys.length; i++) listed[keys[i]] = src[keys[i]];
      return listed;
    }
    if (typeof keys === 'object') {
      var out = {};
      var names = Object.keys(keys);
      for (var j = 0; j < names.length; j++) {
        var name = names[j];
        out[name] = src[name] !== undefined ? src[name] : keys[name];
      }
      return out;
    }
    return Object.assign({}, src);
  }
  var seedPromise = null;
  function ensureSeed() {
    if (!seedPromise) {
      seedPromise = callGet(null).then(function (items) {
        if (items && Array.isArray(items.keyBindings) && items.keyBindings.length > 0) return;
        return callSet(Object.assign({}, ANDY_VSC_SETTINGS));
      }).catch(function () {});
    }
    return seedPromise;
  }
  sync.get = function (keys, cb) {
    return ensureSeed().then(function () {
      return callGet(null);
    }).then(function (all) {
      var src = all && Array.isArray(all.keyBindings) && all.keyBindings.length > 0 ? all : Object.assign({}, ANDY_VSC_SETTINGS);
      var items = project(src, keys);
      if (typeof cb === 'function') cb(items);
      return items;
    });
  };
  sync.set = function (obj, cb) {
    return callSet(obj).then(function () {
      if (typeof cb === 'function') cb();
    });
  };
  sync.__andyDual = true;
})();
`;
}

function patchDefaultSettings(text, label) {
  const from = 'window.VSC.Constants.DEFAULT_SETTINGS=t;';
  if (!text.includes(from)) throw new Error('DEFAULT_SETTINGS assignment missing in ' + label);
  const next = text.replace(from, 'window.VSC.Constants.DEFAULT_SETTINGS=ANDY_VSC_SETTINGS;');
  if (next.includes(from)) throw new Error('stock DEFAULT_SETTINGS remains in ' + label);
  return next;
}

function patchInjectController(text) {
  const prefix = '(function(){let n=new j;if(document.documentElement.addEventListener("VSC_MESSAGE",';
  const suffix = '}),window.VSC_controller&&window.VSC_controller.initialized){window.VSC.logger?.info("VSC already initialized, skipping re-injection");return}n.initialize().catch(e=>{window.VSC.logger.error(`Extension initialization failed: ${e.message}`)}),window.VSC_controller=n})();';
  if (!text.includes(prefix)) throw new Error('inject.js controller prefix missing');
  if (!text.includes(suffix)) throw new Error('inject.js controller suffix missing');
  const nextPrefix = '(async function(){if(document.documentElement&&document.documentElement.dataset)document.documentElement.dataset.vscMainReady="1";if(window.VSC_controller&&(window.VSC_controller.initialized||window.VSC_controller._initializing)){window.VSC.logger?.info("VSC already initialized, skipping re-injection");return}let n=new j;n._initializing=!0;window.VSC_controller=n;document.documentElement.addEventListener("VSC_MESSAGE",';
  const nextSuffix = '});try{await n.initialize()}catch(e){window.VSC.logger.error(`Extension initialization failed: ${e.message}`)} })();';
  const next = text.replace(prefix, nextPrefix).replace(suffix, nextSuffix);
  const listenAt = next.lastIndexOf('addEventListener("VSC_MESSAGE"');
  const initAt = next.lastIndexOf('n._initializing=!0');
  const guardAt = next.lastIndexOf('window.VSC_controller._initializing');
  if (!(guardAt > 0 && initAt > guardAt && initAt < listenAt)) {
    throw new Error('inject.js still registers VSC_MESSAGE before the cross-world guard');
  }
  if (!next.includes('dataset.vscMainReady="1"') || !next.includes('await n.initialize()')) {
    throw new Error('inject.js main-world ready marker missing');
  }
  return next;
}

function patchVscScript(file, settings, mode) {
  let text = fs.readFileSync(file, 'utf8');
  if (mode.controller) text = patchInjectController(text);
  if (mode.defaults) text = patchDefaultSettings(text, file);
  let prelude = andySettingsPrelude(settings);
  if (mode.shim) prelude += vscUiStorageShim();
  if (text.startsWith('var ANDY_VSC_SETTINGS')) throw new Error('settings prelude already present in ' + file);
  text = prelude + text;
  if (mode.defaults && !text.includes('DEFAULT_SETTINGS=ANDY_VSC_SETTINGS')) {
    throw new Error('DEFAULT_SETTINGS was not replaced in ' + file);
  }
  if (mode.shim && !text.includes('sync.__andyDual')) throw new Error('storage shim missing in ' + file);
  const encoded = text.slice('var ANDY_VSC_SETTINGS = '.length, text.indexOf(';\n'));
  const parsed = JSON.parse(encoded);
  if (!parsed.keyBindings || parsed.keyBindings.length !== 24) {
    throw new Error('page settings are not 24 bindings: ' + file);
  }
  if (mode.controller) text = wrapInjectBundle(text);
  fs.writeFileSync(file, text);
}

function wrapInjectBundle(text) {
  if (!text.startsWith('var ANDY_VSC_SETTINGS = ')) {
    throw new Error('inject.js prelude missing before duplicate guard');
  }
  const splitAt = text.indexOf(';\n');
  if (splitAt < 0) throw new Error('inject.js prelude terminator missing');
  const head = text.slice(0, splitAt + 2);
  const body = text.slice(splitAt + 2);
  return head
    + 'if (typeof window !== "undefined" && ((window.VSC_controller && (window.VSC_controller.initialized || window.VSC_controller._initializing)) || (window.VSC && window.VSC.stateManager && document.documentElement && document.documentElement.dataset && document.documentElement.dataset.vscMainReady === "1"))) {\n'
    + '  // Already active or initializing in MAIN world; do not overwrite window.VSC.stateManager\n'
    + '} else {\n'
    + body
    + '\n}\n';
}


copyExtension(VSC_SRC, VSC_DEST);
copyExtension(HTML_SRC, HTML_DEST);

const vscManifestPath = path.join(VSC_DEST, 'manifest.json');
let vscManifest = fs.readFileSync(vscManifestPath, 'utf8');
if (!vscManifest.includes('"update_url"')) throw new Error('VSC manifest has no update_url to remove');
if (!vscManifest.includes('"world": "MAIN"')) throw new Error('VSC manifest lost world MAIN before patch');
vscManifest = vscManifest.replace(/\n\s*"update_url": "https:\/\/clients2\.google\.com\/service\/update2\/crx",/, '');
if (!vscManifest.includes('"web_accessible_resources"')) {
  vscManifest = vscManifest.replace(
    '"version": "0.11.1"\n}',
    '"version": "0.11.1",\n   "web_accessible_resources": [ {\n      "matches": [ "<all_urls>" ],\n      "resources": [ "inject.js" ]\n   } ]\n}'
  );
}
if (vscManifest.includes('update_url')) throw new Error('VSC update_url still present');
if (!vscManifest.includes('"world": "MAIN"')) throw new Error('VSC world MAIN was removed');
fs.writeFileSync(vscManifestPath, vscManifest);

const htmlManifestPath = path.join(HTML_DEST, 'manifest.json');
let htmlManifest = fs.readFileSync(htmlManifestPath, 'utf8');
htmlManifest = htmlManifest.replace(/\n\s*"update_url": "https:\/\/clients2\.google\.com\/service\/update2\/crx",/, '');
htmlManifest = htmlManifest.replace('"permissions": [ "fontSettings", "storage" ]', '"permissions": [ "storage" ]');
if (htmlManifest.includes('update_url') || htmlManifest.includes('fontSettings')) {
  throw new Error('HTML5 manifest still has update_url or fontSettings');
}
fs.writeFileSync(htmlManifestPath, htmlManifest);

fs.writeFileSync(path.join(VSC_DEST, 'content-bridge.js'), renderContentBridge(vscSettings));

const backgroundPath = path.join(VSC_DEST, 'background.js');
let background = fs.readFileSync(backgroundPath, 'utf8');
const getCount = background.split('chrome.storage.sync.get').length - 1;
if (getCount !== 2) throw new Error(`Expected 2 chrome.storage.sync.get calls in background.js, found ${getCount}`);
if (!background.startsWith('(()=>{')) throw new Error('background.js does not start with the expected IIFE');
background = '(()=>{' + renderBackgroundHelper(vscSettings) + background.slice('(()=>{'.length);
background = background.replaceAll('chrome.storage.sync.get', 'vscStorageGet');
if (background.includes('chrome.storage.sync.get')) throw new Error('background.js still calls chrome.storage.sync.get');
if (!background.includes("chrome.storage.sync['get']")) throw new Error('raw get helper missing');
fs.writeFileSync(backgroundPath, background);

patchVscScript(path.join(VSC_DEST, 'inject.js'), vscSettings, { controller: true, defaults: true, shim: false });
patchVscScript(path.join(VSC_DEST, 'ui/options/options.js'), vscSettings, { defaults: true, shim: true });
patchVscScript(path.join(VSC_DEST, 'ui/popup/popup.js'), vscSettings, { shim: true });

const seedFns = storageHelpers('ANDY_HTML5_SC_OBJS', 'ANDY_HTML5_SC_OBJS', 'ANDY_HTML5_SETTGS', 'ANDY_HTML5_SUBS_STYL');
const optionsPath = path.join(HTML_DEST, 'options.js');
let options = fs.readFileSync(optionsPath, 'utf8');
options = options.replace(
  'var hed = [...document.getElementsByTagName("head")][0];\n',
  'var hed = [...document.getElementsByTagName("head")][0];\n' + seedFns + '\n'
);
options = options.replace(
`function fontPopul()
{
	chrome.fontSettings.getFontList(populate);
}`,
`function fontPopul()
{
	var fallbackFonts = [
${fallbackFonts}
	];
	var canList = typeof chrome !== 'undefined' && chrome.fontSettings && typeof chrome.fontSettings.getFontList === 'function';
	if (!canList) {
		populate(fallbackFonts);
		return;
	}
	try {
		chrome.fontSettings.getFontList(function (fonts) {
			if (!fonts || !fonts.length) populate(fallbackFonts);
			else populate(fonts);
		});
	} catch (err) {
		populate(fallbackFonts);
	}
}`
);
options = options.replace(
`function populate(fonts)
{`,
`function populate(fonts)
{
	if (typeof selectStyl === 'undefined' || !selectStyl) {
		selectStyl = document.createElement('style');
		if (typeof hed !== 'undefined' && hed && hed.appendChild) hed.appendChild(selectStyl);
	}`
);
const restoreStart = options.indexOf('function restore_options()');
const selectStylAt = options.indexOf('var selectStyl = document.createElement');
if (restoreStart < 0 || selectStylAt < 0 || selectStylAt < restoreStart) {
  throw new Error('options.js restore_options block not found');
}
const newRestore = `function restore_options()
{
	html5StorageGet(null, function(items)
	{
		if(v_selFont.length>0){
		var empty = !items || Object.keys(items).length === 0 || !Array.isArray(items.scObjs) || !Array.isArray(items.settgs);
		if (empty) {
			items = andyHtml5Payload();
			html5StorageSet({
				scObjs: items.scObjs,
				settgs: items.settgs,
				subsStyl: items.subsStyl
			}, function () {});
		}
		if (items && Array.isArray(items.scObjs) && Array.isArray(items.settgs))
		{
			console.log(items);
			objs = items.scObjs;
			sets = items.settgs

			objs.forEach(function(obj, index)
			{
				document.getElementById(obj.o.id).addEventListener('click', scClk, false);
			});

			for (let i = 0; i < objs.length; i++)
			{
				defSc(objs[i].o, document.getElementById(objs[i].o.id));
			}

			document.getElementById(sets[0].n).checked = sets[0].s;
			document.getElementById(sets[1].n).value = sets[1].s;
			document.getElementById(sets[2].n).value = sets[2].s;
			document.getElementById(sets[3].n).checked = sets[3].s;
			document.getElementById(sets[4].n).checked = sets[4].s;

			var matVals = sets[5].s.split(' ');
			for (let i = 1; i < 21; i++)
			{
				var tmpId = 'colMat' + i;
				document.getElementById(tmpId).textContent = matVals[i - 1];
			}

			document.getElementById(sets[6].n).value = sets[6].s;
			let fnt = sets[8].s.split('font-family:')[1].trim().split(';')[0];
			v_selFont.selectedIndex = (sets[7] && typeof sets[7].s === 'number') ? sets[7].s : 0;
			for(let k=0; k<v_selFont.length; k++){
				if(v_selFont[k].value==fnt){
					v_selFont.selectedIndex=k;
					break;
				}
			}
			v_subtitlesCSS.innerText = sets[8].s.split(' font-family: ')[0];
			document.getElementById('testSub').style.cssText = sets[8].s + ' ' + " transform: translate(0%, 0%)" + sets[15].s.replace(/translate(.|\\n)+?\\)/g, "").replace(/transform(.|\\n)*:/g, "").replace(/(\\n| )/g, "") + " text-align: center; width: -webkit-fill-available; padding-left: 0px;";
			document.getElementById('testSub').style.setProperty("font-family", v_selFont.value);
			document.getElementById(sets[9].n).innerText = sets[9].s;
			document.getElementById(sets[10].n).checked = sets[10].s;
			document.getElementById(sets[11].n).value = sets[11].s;
			document.getElementById(sets[12].n).value = sets[12].s;
			document.getElementById(sets[13].n).value = sets[13].s;
			document.getElementById(sets[14].n).value = sets[14].s;
			v_subtitlesCSS_two.innerHTML = '';
			v_subtitlesCSS_two.innerText = sets[15].s;
		}
	}else{
		restore_options();
	}
	});

}

`;
options = options.slice(0, restoreStart) + newRestore + options.slice(selectStylAt);
options = options.replace(
`var selectStyl = document.createElement('style');

hed.appendChild(selectStyl);`,
`if (typeof selectStyl === 'undefined' || !selectStyl) {
	selectStyl = document.createElement('style');
}
if (hed && selectStyl.parentNode !== hed) hed.appendChild(selectStyl);`
);
options = options.replace(
`		chrome.storage.sync.set(
		{
			scObjs: objs,
			settgs: sets
		}, function()`,
`		html5StorageSet(
		{
			scObjs: objs,
			settgs: sets
		}, function()`
);
if (options.includes('chrome.fontSettings.getFontList(populate)')) {
  throw new Error('unguarded fontSettings.getFontList remains');
}
for (const font of savedFonts) {
  if (!options.includes(`fontId: '${font.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)) throw new Error('saved subtitle font missing from fallbackFonts: ' + font);
}
if (!options.includes("typeof sets[7].s === 'number'")) {
  throw new Error('selFont selectedIndex still assigns the settings object');
}
const actSaveAt = options.indexOf('function actSave()');
if (actSaveAt < 0 || options.slice(actSaveAt).includes('chrome.storage.sync.set')) {
  throw new Error('actSave still calls chrome.storage.sync.set');
}
if (!options.includes("typeof chrome.fontSettings.getFontList === 'function'")) {
  throw new Error('fontSettings feature detect missing');
}
fs.writeFileSync(optionsPath, options);

const speedPath = path.join(HTML_DEST, 'speedcontrol.js');
let speed = fs.readFileSync(speedPath, 'utf8');
const speedRestore = speed.indexOf('function restore_options()');
const speedSave = speed.indexOf('function save_options()');
const speedRun = speed.indexOf('function runExt()');
if (speedRestore < 0 || speedSave < 0 || speedRun < 0) throw new Error('speedcontrol.js markers missing');
const speedSeed = storageHelpers('ANDY_HTML5_SC_OBJS', 'ANDY_HTML5_SC_OBJS', 'ANDY_HTML5_SETTGS', 'ANDY_HTML5_SUBS_STYL');
speed = speed.replace(
  'var vController = vController || {};\n',
  'var vController = vController || {};\n' + speedSeed + '\n'
);
const restoreFn = `function restore_options()
{

	html5StorageGet(null, function(items)
	{
		var empty = !items || Object.keys(items).length === 0 || !Array.isArray(items.scObjs) || !Array.isArray(items.settgs);
		if (empty)
		{
			items = andyHtml5Payload();
			html5StorageSet({
				scObjs: items.scObjs,
				settgs: items.settgs,
				subsStyl: items.subsStyl
			}, function () {});
		}
		objs = items.scObjs;
		sets = items.settgs;

		scrSpd = sets[0].s;
		pRIncrement = sets[1].s * 1;
		sIncrement = sets[2].s * 1;
		Alt_no = sets[3].s;
		colMat = sets[4].s;
		clrMtrx = sets[5].s;
		blacklist = sets[6].s.split('\\n').join('').split(',');
		subsStyl = sets[8].s;
		videoCSS = sets[9].s;
		vidCSS = sets[10].s;
		sDel = sets[11].s * 1;
		sDelF = sets[12].s * 1;
		sMv = sets[13].s * 1;
		swtchTo = sets[14].s;
		subsStylTwo = sets[15].s;
		pR1 = swtchTo;

		runExt();
	});

}

`;
const saveFn = `function save_options()
{
	var payload = andyHtml5Payload();
	sets = payload.settgs;
	objs = payload.scObjs;
	html5StorageSet({
		scObjs: objs,
		settgs: sets,
		subsStyl: payload.subsStyl
	}, function()
	{
		console.log('Default options saved.');
		restore_options();
	});
}

`;
const speedRestoreNow = speed.indexOf('function restore_options()');
const speedSaveNow = speed.indexOf('function save_options()');
const speedRunNow = speed.indexOf('function runExt()');
speed = speed.slice(0, speedRestoreNow) + restoreFn + saveFn + speed.slice(speedRunNow);
if (speed.includes('"n": "colMat",\n\t\t"s": true') || speed.includes('"s": true\n\t},\n\t{\n\t\t"n": "clrMtrx"')) {
  // factory default array should be gone; the live if (colMat) check remains
}
if (!speed.includes('ANDY_HTML5_SETTGS')) throw new Error('speedcontrol seed missing');
if (!speed.includes('function rmng') && !speed.includes('.rmng = function')) {
  throw new Error('remaining-time clock rmng() was dropped');
}
fs.writeFileSync(speedPath, speed);

const stagedBg = fs.readFileSync(backgroundPath, 'utf8');
if (!stagedBg.includes(JSON.stringify(vscSettings.keyBindings))) {
  throw new Error('background.js is missing Andy keyBindings');
}
console.log('Staged', VSC_DEST);
console.log('Staged', HTML_DEST);
