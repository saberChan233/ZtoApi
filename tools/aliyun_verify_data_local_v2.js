#!/usr/bin/env node
const crypto = require('crypto');
const zlib = require('zlib');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

const STD64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function safeBase64Decode(value) {
  try {
    return Buffer.from(String(value || ''), 'base64');
  } catch {
    return null;
  }
}

function safeInflate(value) {
  try {
    return zlib.inflateSync(value);
  } catch {
    return null;
  }
}

function xorBuffers(left, right) {
  const a = Buffer.from(left || []);
  const b = Buffer.from(right || []);
  const out = Buffer.alloc(Math.min(a.length, b.length));
  for (let i = 0; i < out.length; i += 1) out[i] = a[i] ^ b[i];
  return out;
}

function repeatBuffer(source, length) {
  const seed = Buffer.from(source || []);
  if (!seed.length || !Number.isFinite(length) || length <= 0) return Buffer.alloc(0);
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) out[i] = seed[i % seed.length];
  return out;
}

function sharedPrefix(left, right) {
  const a = Buffer.from(left || []);
  const b = Buffer.from(right || []);
  const size = Math.min(a.length, b.length);
  let i = 0;
  while (i < size && a[i] === b[i]) i += 1;
  return i;
}

function permStringFromTable(table) {
  if (!Array.isArray(table) || table.length !== 64) return null;
  return table.map((idx) => STD64[idx]).join('');
}

function remapAlphabet(input, from, to) {
  const text = String(input || '');
  if (!from || !to) return text;
  const map = new Map();
  for (let i = 0; i < Math.min(from.length, to.length); i += 1) {
    map.set(from[i], to[i]);
  }
  return [...text].map((ch) => map.get(ch) ?? ch).join('');
}

function hashSource(source) {
  if (typeof source !== 'string' || !source) return null;
  return crypto.createHash('sha1').update(source).digest('hex');
}

function summarizeBuffer(buf, raw) {
  if (!buf) return null;
  return {
    len: buf.length,
    hexHead: buf.toString('hex').slice(0, 160),
    sharedPrefixWithRaw: raw ? sharedPrefix(buf, raw) : 0,
    xorHeadWithRaw: raw ? xorBuffers(buf, raw).toString('hex').slice(0, 160) : null,
  };
}

function analyzeFrame(frame) {
  const raw = typeof frame?.rawBinaryFull === 'string' ? Buffer.from(frame.rawBinaryFull, 'latin1') : null;
  const seedString = String(frame?.runtimeSeedBase64Like || '');
  const seedLatin1 = Buffer.from(seedString, 'latin1');
  const seedDecoded = safeBase64Decode(seedString);
  const seedInflated = seedDecoded ? safeInflate(seedDecoded) : null;
  const perm = permStringFromTable(frame?.permTable);
  const remappedSeedToStd = perm ? remapAlphabet(seedString, perm, STD64) : null;
  const remappedSeedFromStd = perm ? remapAlphabet(seedString, STD64, perm) : null;
  const remappedSeedToStdDecoded = remappedSeedToStd ? safeBase64Decode(remappedSeedToStd) : null;
  const remappedSeedFromStdDecoded = remappedSeedFromStd ? safeBase64Decode(remappedSeedFromStd) : null;
  const keyHex = String(frame?.keyHex || '');
  const keyBuf = /^[0-9a-f]+$/i.test(keyHex) ? Buffer.from(keyHex, 'hex') : null;
  const seedJson = String(frame?.seedCallsite?.nxPreview || '').slice(32);
  const seedJsonBuf = Buffer.from(seedJson, 'utf8');
  const rawXorSeedAscii = raw ? xorBuffers(raw, seedLatin1) : null;

  return {
    lengths: {
      raw: raw?.length || null,
      runtimeSeedBase64Like: seedString.length || null,
      seedBase64Decoded: seedDecoded?.length || null,
      seedInflated: seedInflated?.length || null,
      seedJson: seedJsonBuf.length || null,
    },
    candidates: {
      seedLatin1: summarizeBuffer(seedLatin1, raw),
      seedDecoded: summarizeBuffer(seedDecoded, raw),
      seedInflated: summarizeBuffer(seedInflated, raw),
      remappedSeedToStdDecoded: summarizeBuffer(remappedSeedToStdDecoded, raw),
      remappedSeedFromStdDecoded: summarizeBuffer(remappedSeedFromStdDecoded, raw),
      seedJson: summarizeBuffer(seedJsonBuf, raw),
      rawXorSeedAscii: summarizeBuffer(rawXorSeedAscii, raw),
      rawXorKeyRepeat: raw && keyBuf ? summarizeBuffer(xorBuffers(raw, repeatBuffer(keyBuf, raw.length)), raw) : null,
    },
    runtimeHelpers: Object.fromEntries(
      Object.entries(frame?.runtimeHelpers || {}).map(([name, source]) => [
        name,
        source
          ? {
            sha1: hashSource(source),
            preview: String(source).slice(0, 240),
          }
          : null,
      ]),
    ),
  };
}

async function main() {
  const want = Number(process.argv[2] || 1);
  const rows = [];
  let tries = 0;
  while (rows.length < want && tries < want * 6) {
    tries += 1;
    const out = await solveCaptcha({
      files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
      loaderPath: '/tmp/AliyunCaptcha.js',
    });
    const frame = out.verifyDataRuntimeFrame || {};
    if (!frame.finalDataBase64 || !frame.rawBinaryFull || !frame.runtimeSeedBase64Like) continue;
    rows.push({
      keyHex: frame.keyHex || null,
      initialPermHead: Array.isArray(frame.initialPermTable) ? frame.initialPermTable.slice(0, 16) : null,
      permHead: Array.isArray(frame.permTable) ? frame.permTable.slice(0, 16) : null,
      finalDataLength: frame.finalDataLength || null,
      rawBinaryLength: frame.rawBinaryLength || null,
      analysis: analyzeFrame(frame),
    });
  }
  console.log(JSON.stringify({ tries, count: rows.length, rows }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
