(() => {
// Complete extracted Video Speed Controller record: key bindings plus
// audioBoolean, controllerButtonSize, defaultLogLevel, logLevel, speed, and the rest.
const ANDY_VSC_SETTINGS = __ANDY_VSC_SETTINGS_JSON__;

const andyRaw = { syncGet: null, syncSet: null, localGet: null, localSet: null };
function captureAndyStorage() {
  andyRaw.syncGet = null;
  andyRaw.syncSet = null;
  andyRaw.localGet = null;
  andyRaw.localSet = null;
  try {
    if (chrome.storage && chrome.storage.sync && typeof chrome.storage.sync.get === 'function') {
      andyRaw.syncGet = chrome.storage.sync.get.bind(chrome.storage.sync);
    }
  } catch (e) { andyRaw.syncGet = null; }
  try {
    if (chrome.storage && chrome.storage.sync && typeof chrome.storage.sync.set === 'function') {
      andyRaw.syncSet = chrome.storage.sync.set.bind(chrome.storage.sync);
    }
  } catch (e) { andyRaw.syncSet = null; }
  try {
    if (chrome.storage && chrome.storage.local && typeof chrome.storage.local.get === 'function') {
      andyRaw.localGet = chrome.storage.local.get.bind(chrome.storage.local);
    }
  } catch (e) { andyRaw.localGet = null; }
  try {
    if (chrome.storage && chrome.storage.local && typeof chrome.storage.local.set === 'function') {
      andyRaw.localSet = chrome.storage.local.set.bind(chrome.storage.local);
    }
  } catch (e) { andyRaw.localSet = null; }
}

function andyStorageCall(method, payload) {
  const primary = method === 'get' ? andyRaw.syncGet : andyRaw.syncSet;
  const secondary = method === 'get' ? andyRaw.localGet : andyRaw.localSet;
  const empty = method === 'get' ? {} : undefined;
  function attempt(fn) {
    return new Promise((resolve, reject) => {
      if (typeof fn !== 'function') {
        reject(new Error('storage missing'));
        return;
      }
      let settled = false;
      const ok = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const bad = (err) => {
        if (settled) return;
        settled = true;
        reject(err || new Error('storage failed'));
      };
      let ret;
      try {
        ret = fn(payload, (value) => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) bad(err);
          else ok(value);
        });
      } catch (err) {
        bad(err);
        return;
      }
      if (ret && typeof ret.then === 'function') {
        ret.then((value) => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) bad(err);
          else ok(value);
        }).catch(bad);
      }
      setTimeout(() => bad(new Error('storage timeout')), 500);
    });
  }
  return attempt(primary).catch(() => attempt(secondary)).catch(() => empty);
}

function installStorageFacade() {
  captureAndyStorage();
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  if (!chrome.storage.sync) chrome.storage.sync = {};
  const sync = chrome.storage.sync;
  if (sync.__andyLocalBacked) return;
  sync.get = (keys, cb) => {
    const pending = andyStorageCall('get', keys).then((items) => (items && typeof items === 'object' ? items : {}));
    if (typeof cb === 'function') pending.then((items) => cb(items));
    return pending;
  };
  sync.set = (obj, cb) => {
    const pending = andyStorageCall('set', obj).then(() => undefined);
    if (typeof cb === 'function') pending.then(() => cb());
    return pending;
  };
  sync.__andyLocalBacked = true;
}

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
      console.error('[VSC] Initial settings load failed:', err);
      return { ...ANDY_VSC_SETTINGS };
    });
  }
  return andySeedPromise;
}

function matchBlacklist(list, href) {
  if (!list) return false;
  const trim = /^[\r\t\f\v ]+|[\r\t\f\v ]+$/gm;
  const flags = /\/(?!.*(.).*\1)[gimsuy]*$/;
  const esc = (s) => s.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
  for (const line of String(list).split('\n')) {
    const t = line.replace(trim, '');
    if (!t) continue;
    let re;
    if (t.startsWith('/')) {
      try {
        const parts = t.split('/');
        if (parts.length < 3) continue;
        const hasFlags = flags.test(t);
        const flag = hasFlags ? parts.pop() : '';
        const body = parts.slice(1, hasFlags ? undefined : -1).join('/');
        if (!body) continue;
        re = new RegExp(body, flag);
      } catch (e) { continue; }
    } else {
      const e = esc(t);
      re = t.includes('.') && !t.includes('/') ? new RegExp('(^|\\.|//)' + e + '(\\/|:|$)') : new RegExp(e);
    }
    if (re.test(href)) return true;
  }
  return false;
}

function compilePattern(pattern) {
  const trim = /^[\r\t\f\v ]+|[\r\t\f\v ]+$/gm;
  const flags = /\/(?!.*(.).*\1)[gimsuy]*$/;
  const esc = (s) => s.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
  const n = String(pattern || '').replace(trim, '');
  if (!n) return null;
  if (n.startsWith('/')) {
    try {
      const parts = n.split('/');
      if (parts.length < 3) return null;
      const hasFlags = flags.test(n);
      const flag = hasFlags ? parts.pop() : '';
      const body = parts.slice(1, hasFlags ? undefined : -1).join('/');
      return body ? new RegExp(body, flag) : null;
    } catch (e) { return null; }
  }
  const e = esc(n);
  return n.includes('.') && !n.includes('/') ? new RegExp('(^|\\.|//)' + e + '(\\/|:|$)') : new RegExp(e);
}

function matchSiteRule(rules, href) {
  if (!rules || !rules.length) return null;
  for (const rule of rules) {
    const re = compilePattern(rule.pattern || '');
    if (re && re.test(href)) return rule;
  }
  return null;
}

window.VSC = window.VSC || {};
window.VSC.matchSiteRule = matchSiteRule;

const MIN_SPEED = 0.07;
const MAX_SPEED = 16;
const root = document.documentElement;
let bridgeStarted = false;
let mainWorldSeen = false;

function abortSettings() {
  root.dispatchEvent(new CustomEvent('VSC_SETTINGS_READY', { detail: { abort: true } }));
}

function noteMainWorld() {
  mainWorldSeen = true;
  if (root && root.dataset) root.dataset.vscMainReady = '1';
}

function mainWorldReady() {
  return !!(
    mainWorldSeen
    || window.VSC_controller
    || (root && root.dataset && (root.dataset.vscMainReady === '1' || root.dataset.vscMainInjected === '1'))
  );
}

function injectMainWorldFallback() {
  try {
    if (mainWorldReady()) return;
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js');
    script.async = false;
    script.onload = () => { try { script.remove(); } catch (e) {} };
    const parent = document.head || document.documentElement;
    if (parent && parent.appendChild) parent.appendChild(script);
    if (root && root.dataset) root.dataset.vscMainInjected = '1';
  } catch (err) {
    console.error('[VSC] MAIN world inject fallback failed:', err);
  }
}

function scheduleMainWorldFallback() {
  const armGrace = () => setTimeout(injectMainWorldFallback, 300);
  if (document.readyState === 'loading') {
    let armed = false;
    const go = () => {
      if (armed) return;
      armed = true;
      armGrace();
    };
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('DOMContentLoaded', go, { once: true });
    }
    setTimeout(go, 2000);
    return;
  }
  armGrace();
}

function startBridge() {
  try {
    if (bridgeStarted) return;
    bridgeStarted = true;
    if (location.protocol === 'about:') {
      root.addEventListener('VSC_REQUEST_SETTINGS', abortSettings);
      return;
    }
    scheduleMainWorldFallback();
    let blocked = false;
    let live = false;
    const loaded = ensureAndySeed();
    root.addEventListener('VSC_REQUEST_SETTINGS', async () => {
      noteMainWorld();
      let settings;
      try { settings = await loaded; } catch (err) { settings = null; }
      if (!settings || !Array.isArray(settings.keyBindings) || settings.keyBindings.length === 0) {
        settings = { ...ANDY_VSC_SETTINGS };
      }
      const legacyBlocked = !settings.siteRules && matchBlacklist(settings.blacklist, location.href);
      const rule = matchSiteRule(settings.siteRules, location.href);
      const ruleOff = rule && rule.enabled === false;
      if (blocked || settings.enabled === false || legacyBlocked || ruleOff) {
        abortSettings();
        return;
      }
      const detail = { ...settings };
      delete detail.blacklist;
      delete detail.enabled;
      live = true;
      const hostname = String(location.hostname || '').replace(/^www\./, '');
      root.dispatchEvent(new CustomEvent('VSC_SETTINGS_READY', { detail: { settings: detail, hostname } }));
    });

    if (chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync' && area !== 'local') return;
        const enabledChange = changes.enabled;
        if (((enabledChange?.oldValue === false || enabledChange?.newValue === false) && (blocked = true)), enabledChange?.newValue === false) {
          live = false;
          root.dispatchEvent(new CustomEvent('VSC_MESSAGE', { detail: { type: 'VSC_TEARDOWN' } }));
          return;
        }
        if (!live) return;
        const rest = { ...changes };
        delete rest.enabled;
        delete rest.blacklist;
        if (Object.keys(rest).length > 0) {
          root.dispatchEvent(new CustomEvent('VSC_STORAGE_CHANGED', { detail: rest }));
        }
      });
    }

    if (chrome.runtime && chrome.runtime.onMessage && chrome.runtime.onMessage.addListener) {
      chrome.runtime.onMessage.addListener((message) => {
        if (live) root.dispatchEvent(new CustomEvent('VSC_MESSAGE', { detail: message }));
      });
    }

    const onWrite = (event) => {
      try {
        if (!live) return;
        const detail = event.detail;
        if (!detail || typeof detail !== 'object') return;
        if ('lastSpeed' in detail) {
          const speed = detail.lastSpeed;
          if (typeof speed === 'number' && Number.isFinite(speed)) {
            vscRawSet({ lastSpeed: Math.min(Math.max(speed, MIN_SPEED), MAX_SPEED) });
          }
        }
      } catch (err) {
        if (err && err.message && err.message.includes('Extension context invalidated')) {
          root.removeEventListener('VSC_WRITE_STORAGE', onWrite);
        }
      }
    };
    root.addEventListener('VSC_WRITE_STORAGE', onWrite);
  } catch (err) {
    console.error('[VSC] Bridge init failed:', err);
  }
}

installStorageFacade();
startBridge();
})();
