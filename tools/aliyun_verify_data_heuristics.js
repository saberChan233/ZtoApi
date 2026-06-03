#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

const STD64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function xorBuffers(a, b) {
  const len = Math.min(a.length, b.length);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) out[i] = a[i] ^ b[i];
  return out;
}

function permStringFromTable(table) {
  if (!Array.isArray(table) || table.length !== 64) return null;
  return table.map((idx) => STD64[idx]).join('');
}

function remapAlphabet(input, from, to) {
  const map = new Map();
  for (let i = 0; i < Math.min(from.length, to.length); i += 1) {
    map.set(from[i], to[i]);
  }
  return [...input].map((ch) => map.get(ch) ?? ch).join('');
}

function collectRow(out) {
  const frame = out.verifyDataRuntimeFrame || {};
  if (!frame.finalDataBase64 || !frame.seedBase64Like || !frame.rawBinaryFull) return null;
  const raw = Buffer.from(frame.rawBinaryFull, 'latin1');
  const finalDecoded = Buffer.from(frame.finalDataBase64, 'base64');
  const seedB64Decoded = Buffer.from(frame.seedBase64Like, 'base64');
  const seedText = frame.seedCallsite?.nxPreview || '';
  const seedJson = seedText.slice(32);
  const seedJsonBuf = Buffer.from(seedJson, 'utf8');
  const perm = permStringFromTable(frame.permTable);
  const remappedSeed = perm ? remapAlphabet(frame.seedBase64Like, perm, STD64) : null;
  let remappedSeedDecoded = null;
  try {
    remappedSeedDecoded = remappedSeed ? Buffer.from(remappedSeed, 'base64') : null;
  } catch {
    remappedSeedDecoded = null;
  }
  return {
    keyHex: frame.keyHex || null,
    rawLen: raw.length,
    finalDecodedLen: finalDecoded.length,
    seedB64DecodedLen: seedB64Decoded.length,
    seedJsonLen: seedJsonBuf.length,
    permHead: Array.isArray(frame.permTable) ? frame.permTable.slice(0, 12) : null,
    rawHexHead: raw.toString('hex').slice(0, 160),
    finalHexHead: finalDecoded.toString('hex').slice(0, 160),
    seedB64DecodedHexHead: seedB64Decoded.toString('hex').slice(0, 160),
    seedJsonHexHead: seedJsonBuf.toString('hex').slice(0, 160),
    xorWithSeedJsonHead: xorBuffers(raw, seedJsonBuf).toString('hex').slice(0, 160),
    xorWithSeedB64DecodedHead: xorBuffers(raw, seedB64Decoded).toString('hex').slice(0, 160),
    remappedSeedDecodedHexHead: remappedSeedDecoded ? remappedSeedDecoded.toString('hex').slice(0, 160) : null,
    rawStartsWithFinal: finalDecoded.subarray(0, raw.length).equals(raw),
    rawEqualsFinal: finalDecoded.equals(raw),
  };
}

async function main() {
  const want = Number(process.argv[2] || 4);
  const rows = [];
  let tries = 0;
  while (rows.length < want && tries < want * 6) {
    tries += 1;
    const out = await solveCaptcha({
      files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
      loaderPath: '/tmp/AliyunCaptcha.js',
    });
    const row = collectRow(out);
    if (row) rows.push(row);
  }
  console.log(JSON.stringify({ tries, rows }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
