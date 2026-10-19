#!/usr/bin/env node
/**
 * Copy Chrome Profile 1 Sync Extension Settings for the two movie extensions
 * into /tmp, then read only that copy. LevelDB write-ahead logs and SSTables
 * are replayed in sequence order. A later tombstone (deletion) drops a key.
 *
 * Writes extracted-settings.json and checks:
 *   Video Speed Controller keyBindings.length === 24
 *   HTML5 scObjs.length === 14 and settgs.length === 16
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Both paths are worked out when used, so the LevelDB helpers below can be loaded on their own (the tests do).
const chromeSyncDir = () => path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Profile 1/Sync Extension Settings');
// Your personal extension settings: written under orion/, which .gitignore keeps out of the repo.
const outPath = () => path.resolve(path.dirname(process.argv[1]), '..', 'orion', 'extracted-settings.json');

const SOURCES = [
  {
    name: 'videoSpeedController',
    extensionId: 'nffaoalbilbmmfgbnbgppjihopabppdk',
    version: '0.11.1',
    label: 'Video Speed Controller'
  },
  {
    name: 'html5SpeedSubs',
    extensionId: 'hgpaaanfcfejapmifdjoljedjhbjceli',
    version: '1.70',
    label: 'HTML5 media speed controller + subs'
  }
];

const LOG_BLOCK = 32768;
const SST_MAGIC_LO = 0x8b80fb57;
const SST_MAGIC_HI = 0xdb477524;
const CRC_POLY_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0x82f63b78 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32c(buf, start, length) {
  let crc = 0xffffffff;
  const end = start + length;
  for (let i = start; i < end; i++) crc = CRC_POLY_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function unmaskCrc(masked) {
  const rot = (masked - 0xa282ead8) >>> 0;
  return ((rot >>> 17) | (rot << 15)) >>> 0;
}

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  let p = pos;
  while (p < buf.length && shift <= 28) {
    const b = buf[p++];
    result += (b & 0x7f) * (2 ** shift);
    if ((b & 0x80) === 0) return { value: result, pos: p };
    shift += 7;
  }
  // Values above 2^31 (sequence numbers live elsewhere). Keep going with BigInt
  // only if the first 32 bits did not finish, which LevelDB block handles never need.
  throw new Error(`truncated varint at ${pos}`);
}

function copyDb(extensionId, tmpRoot) {
  const src = path.join(chromeSyncDir(), extensionId);
  if (!fs.existsSync(src)) throw new Error(`Chrome sync database not found: ${src}`);
  const dest = path.join(tmpRoot, extensionId);
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

function readLogRecords(buf) {
  const batches = [];
  let pos = 0;
  let partial = [];
  while (pos + 7 <= buf.length) {
    const inBlock = pos % LOG_BLOCK;
    const remain = LOG_BLOCK - inBlock;
    if (remain < 7) {
      pos += remain;
      continue;
    }
    const stored = buf.readUInt32LE(pos);
    const length = buf.readUInt16LE(pos + 4);
    const type = buf[pos + 6];
    if (stored === 0 && length === 0 && type === 0) {
      pos += remain;
      continue;
    }
    if (length > remain - 7 || pos + 7 + length > buf.length) break;
    const got = crc32c(buf, pos + 6, 1 + length);
    if (unmaskCrc(stored) !== got) break;
    const data = buf.subarray(pos + 7, pos + 7 + length);
    pos += 7 + length;
    if (type === 1) batches.push(data);
    else if (type === 2) partial = [Buffer.from(data)];
    else if (type === 3) partial.push(Buffer.from(data));
    else if (type === 4) {
      partial.push(Buffer.from(data));
      batches.push(Buffer.concat(partial));
      partial = [];
    } else break;
  }
  return batches;
}

function parseWriteBatch(buf) {
  if (buf.length < 12) return [];
  const seq0 = buf.readBigUInt64LE(0);
  const count = buf.readUInt32LE(8);
  let p = 12;
  const ops = [];
  for (let i = 0; i < count && p < buf.length; i++) {
    const tag = buf[p++];
    if (tag !== 0 && tag !== 1) break;
    const k = readVarint(buf, p);
    p = k.pos;
    const keyLen = k.value;
    if (p + keyLen > buf.length) break;
    const key = Buffer.from(buf.subarray(p, p + keyLen));
    p += keyLen;
    let value = null;
    if (tag === 1) {
      const v = readVarint(buf, p);
      p = v.pos;
      const valLen = v.value;
      if (p + valLen > buf.length) break;
      value = Buffer.from(buf.subarray(p, p + valLen));
      p += valLen;
    }
    ops.push({ seq: seq0 + BigInt(i), type: tag, key, value });
  }
  return ops;
}

function snappyUncompress(src) {
  const lenInfo = readVarint(src, 0);
  const expected = lenInfo.value;
  let p = lenInfo.pos;
  const out = Buffer.alloc(expected);
  let o = 0;
  while (o < expected) {
    if (p >= src.length) throw new Error('snappy truncated');
    const tag = src[p++];
    const kind = tag & 3;
    if (kind === 0) {
      let literal = tag >>> 2;
      if (literal >= 60) {
        const extra = literal - 59;
        literal = 0;
        for (let i = 0; i < extra; i++) literal |= src[p++] << (8 * i);
      }
      literal += 1;
      if (o + literal > expected) throw new Error('snappy literal overflow');
      src.copy(out, o, p, p + literal);
      p += literal;
      o += literal;
    } else {
      let length;
      let offset;
      if (kind === 1) {
        length = ((tag >>> 2) & 7) + 4;
        offset = ((tag & 0xe0) << 3) | src[p++];
      } else if (kind === 2) {
        length = (tag >>> 2) + 1;
        offset = src[p] | (src[p + 1] << 8);
        p += 2;
      } else {
        length = (tag >>> 2) + 1;
        offset = src.readUInt32LE(p);
        p += 4;
      }
      if (offset === 0 || offset > o) throw new Error(`snappy bad offset ${offset}`);
      for (let i = 0; i < length; i++) out[o + i] = out[o - offset + i];
      o += length;
    }
  }
  return out;
}

function readBlock(buf, offset, size) {
  // LevelDB block handles store the payload length only. The 1-byte
  // compression type and 4-byte masked CRC sit immediately after offset+size.
  const start = Number(offset) || 0;
  const length = Number(size) || 0;
  if (start < 0 || length < 0 || start + length + 5 > buf.length) {
    throw new Error(`short block ${length} at ${start}`);
  }
  const payload = buf.subarray(start, start + length);
  const compressionType = buf[start + length];
  if (compressionType === 0) return payload;
  if (compressionType === 1) return snappyUncompress(payload);
  throw new Error(`unknown block compression ${compressionType}`);
}

function parseDataBlock(block) {
  if (block.length < 4) return [];
  const nRestart = block.readUInt32LE(block.length - 4);
  const end = block.length - (nRestart + 1) * 4;
  if (end < 0 || end > block.length) return [];
  const entries = [];
  let p = 0;
  let prev = Buffer.alloc(0);
  while (p < end) {
    let shared;
    let unshared;
    let valueLen;
    try {
      const s = readVarint(block, p); p = s.pos; shared = s.value;
      const u = readVarint(block, p); p = u.pos; unshared = u.value;
      const v = readVarint(block, p); p = v.pos; valueLen = v.value;
    } catch {
      break;
    }
    if (shared > prev.length || p + unshared + valueLen > end) break;
    const key = Buffer.alloc(shared + unshared);
    prev.copy(key, 0, 0, shared);
    block.copy(key, shared, p, p + unshared);
    p += unshared;
    const value = Buffer.from(block.subarray(p, p + valueLen));
    p += valueLen;
    prev = key;
    entries.push({ key, value });
  }
  return entries;
}

function decodeInternalKey(entry) {
  if (entry.key.length < 8) return null;
  const user = entry.key.subarray(0, entry.key.length - 8);
  const trailer = entry.key.readBigUInt64LE(entry.key.length - 8);
  const type = Number(trailer & 0xffn);
  const seq = trailer >> 8n;
  return { seq, type, key: Buffer.from(user), value: type === 1 ? entry.value : null };
}

function readSstable(file) {
  if (file.length < 48) return [];
  const footer = file.length - 48;
  const magicLo = file.readUInt32LE(file.length - 8);
  const magicHi = file.readUInt32LE(file.length - 4);
  if (magicLo !== SST_MAGIC_LO || magicHi !== SST_MAGIC_HI) {
    throw new Error('SSTable magic mismatch');
  }
  let p = footer;
  const metaOff = readVarint(file, p); p = metaOff.pos;
  const metaSize = readVarint(file, p); p = metaSize.pos;
  const indexOff = readVarint(file, p); p = indexOff.pos;
  const indexSize = readVarint(file, p);
  void metaOff;
  void metaSize;
  const indexBlock = readBlock(file, indexOff.value, indexSize.value);
  const indexEntries = parseDataBlock(indexBlock);
  const ops = [];
  for (const ent of indexEntries) {
    let hp = 0;
    const off = readVarint(ent.value, hp); hp = off.pos;
    const sz = readVarint(ent.value, hp);
    const data = readBlock(file, off.value, sz.value);
    for (const rec of parseDataBlock(data)) {
      const decoded = decodeInternalKey(rec);
      if (decoded && (decoded.type === 0 || decoded.type === 1)) ops.push(decoded);
    }
  }
  return ops;
}

function applyOp(state, op) {
  const key = op.key.toString('utf8');
  const prev = state.map.get(key);
  if (prev && prev.seq > op.seq) return;
  state.map.set(key, { seq: op.seq, type: op.type, value: op.value });
  state.applied += 1;
  if (op.type === 0) state.tombstones += 1;
}

function decodeSetting(buf) {
  if (!buf) return null;
  const text = buf.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function loadDatabase(dir) {
  const state = { map: new Map(), applied: 0, tombstones: 0, files: [] };
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.ldb') || n.endsWith('.log')).sort();
  const ordered = [
    ...names.filter((n) => n.endsWith('.ldb')),
    ...names.filter((n) => n.endsWith('.log'))
  ];
  for (const name of ordered) {
    const buf = fs.readFileSync(path.join(dir, name));
    state.files.push({ name, bytes: buf.length });
    const ops = name.endsWith('.log')
      ? readLogRecords(buf).flatMap(parseWriteBatch)
      : readSstable(buf);
    for (const op of ops) applyOp(state, op);
  }
  const settings = {};
  const sequences = {};
  for (const [key, rec] of state.map) {
    if (rec.type !== 1 || rec.value == null) continue;
    settings[key] = decodeSetting(rec.value);
    sequences[key] = rec.seq.toString();
  }
  return {
    settings,
    sequences,
    recordsApplied: state.applied,
    tombstonesSeen: state.tombstones,
    files: state.files
  };
}

function hdrSettgs(settgs) {
  return settgs.map((row) => (row && row.n === 'colMat' ? { ...row, s: false } : row));
}

function settingValue(settgs, name) {
  const row = Array.isArray(settgs) ? settgs.find((r) => r && r.n === name) : undefined;
  return row ? row.s : undefined;
}

function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-chrome-sync-'));
  const extracted = {
    extractedAt: new Date().toISOString(),
    tmpCopy: tmpRoot,
    note: 'Values are the highest-sequence LevelDB records. Tombstones remove older copies. hdrProfile is Andy\'s HTML5 settings with colMat forced false so the SVG feColorMatrix filter is not applied to video (WebKit can drop HDR highlights). The remaining-time clock is speedcontrol.js rmng(), which uses duration and playbackRate; subtitle delay and move settings are unchanged.',
    videoSpeedController: null,
    html5SpeedSubs: null,
    hdrProfile: null
  };

  for (const src of SOURCES) {
    const dir = copyDb(src.extensionId, tmpRoot);
    const db = loadDatabase(dir);
    extracted[src.name] = {
      label: src.label,
      extensionId: src.extensionId,
      version: src.version,
      copiedTo: dir,
      files: db.files,
      recordsApplied: db.recordsApplied,
      tombstonesSeen: db.tombstonesSeen,
      storageKeys: Object.keys(db.settings).sort(),
      sequences: db.sequences,
      settings: db.settings
    };
  }

  const vsc = extracted.videoSpeedController.settings;
  const html = extracted.html5SpeedSubs.settings;
  const keyBindings = vsc.keyBindings;
  const scObjs = html.scObjs;
  const settgs = html.settgs;
  const errors = [];
  if (!Array.isArray(keyBindings) || keyBindings.length !== 24) {
    errors.push(`Video Speed Controller keyBindings: expected 24, got ${Array.isArray(keyBindings) ? keyBindings.length : typeof keyBindings}`);
  }
  if (!Array.isArray(scObjs) || scObjs.length !== 14) {
    errors.push(`HTML5 scObjs: expected 14, got ${Array.isArray(scObjs) ? scObjs.length : typeof scObjs}`);
  }
  if (!Array.isArray(settgs) || settgs.length !== 16) {
    errors.push(`HTML5 settgs: expected 16, got ${Array.isArray(settgs) ? settgs.length : typeof settgs}`);
  }

  const subsStyl = settingValue(settgs, 'subsStyl');
  const chromeColMat = settingValue(settgs, 'colMat');
  const hdr = {
    colMat: false,
    chromeColMat,
    scObjs,
    settgs: Array.isArray(settgs) ? hdrSettgs(settgs) : settgs,
    subsStyl,
    subsStylTwo: settingValue(settgs, 'subsStylTwo'),
    howToRestoreColMat: 'Open the HTML5 extension options and turn Color matrix back on. The staged movie copy keeps the checkbox; only the seeded default is off.'
  };
  extracted.hdrProfile = hdr;
  extracted.checks = {
    keyBindingCount: Array.isArray(keyBindings) ? keyBindings.length : 0,
    scObjCount: Array.isArray(scObjs) ? scObjs.length : 0,
    settgsCount: Array.isArray(settgs) ? settgs.length : 0,
    schemaVersion: vsc.schemaVersion ?? null,
    exclusiveKeys: vsc.exclusiveKeys ?? null,
    rememberSpeed: vsc.rememberSpeed ?? null,
    lastSpeed: vsc.lastSpeed ?? null,
    chromeColMat,
    hdrColMat: false
  };

  fs.writeFileSync(outPath(), `${JSON.stringify(extracted, null, 2)}\n`);

  if (errors.length) {
    console.error(errors.join('\n'));
    console.error(`Wrote partial ${outPath()}`);
    process.exit(1);
  }

  console.log(`Wrote ${outPath()}`);
  console.log(`VSC keyBindings: ${extracted.checks.keyBindingCount} (schemaVersion ${extracted.checks.schemaVersion}, rememberSpeed ${extracted.checks.rememberSpeed}, exclusiveKeys ${extracted.checks.exclusiveKeys}, lastSpeed ${extracted.checks.lastSpeed})`);
  console.log(`HTML5 scObjs: ${extracted.checks.scObjCount}, settgs: ${extracted.checks.settgsCount}, chrome colMat: ${chromeColMat}, HDR colMat: false`);
  console.log(`Actions: ${keyBindings.map((b) => b.action).join(', ')}`);
  console.log(`scObj ids: ${scObjs.map((row) => row && row.o && row.o.id).join(', ')}`);
  console.log(`settgs: ${settgs.map((row) => row && row.n).join(', ')}`);
}

main();
