#!/usr/bin/env node
const crypto = require('crypto');

const PREID_PREFIX = 'SG_WEB_PREID';
const PREID_V_VALUE = 'daye,raolewoba!';
const PREID_FOURTH_SEGMENT = 0;

function buildPreidNgSeed(parts, options = {}) {
  const prefix = options.prefix || PREID_PREFIX;
  const tA = Object.prototype.hasOwnProperty.call(options, 'tA')
    ? options.tA
    : PREID_FOURTH_SEGMENT;
  const v = options.v || PREID_V_VALUE;
  const nO = parts?.nO;
  const H = parts?.H;
  if (typeof nO !== 'string' || !nO) {
    throw new Error('parts.nO must be a non-empty string');
  }
  if (typeof H !== 'string' || !H) {
    throw new Error('parts.H must be a non-empty string');
  }
  return [prefix, nO, H, String(tA), v].join('#');
}

function computePreidNg(parts, options = {}) {
  return crypto.createHash('md5').update(buildPreidNgSeed(parts, options), 'utf8').digest('hex');
}

function buildPreidPlain(parts, options = {}) {
  const prefix = options.prefix || PREID_PREFIX;
  const tA = Object.prototype.hasOwnProperty.call(options, 'tA')
    ? options.tA
    : PREID_FOURTH_SEGMENT;
  const ng = options.ng || computePreidNg(parts, options);
  const nO = parts?.nO;
  const H = parts?.H;
  if (typeof nO !== 'string' || !nO) {
    throw new Error('parts.nO must be a non-empty string');
  }
  if (typeof H !== 'string' || !H) {
    throw new Error('parts.H must be a non-empty string');
  }
  return [prefix, nO, H, String(tA), ng].join('#');
}

function parsePreidPlain(value) {
  if (typeof value !== 'string' || !value) return null;
  const parts = value.split('#');
  return {
    raw: value,
    partsLength: parts.length,
    prefix: parts[0] ?? null,
    nO: parts[1] ?? null,
    H: parts[2] ?? null,
    tA: parts[3] ?? null,
    ng: parts[4] ?? null,
  };
}

function verifyPreidPlain(value, options = {}) {
  const parsed = parsePreidPlain(value);
  if (!parsed?.nO || !parsed?.H) {
    return { ok: false, error: 'invalid preid plain' };
  }
  const expected = computePreidNg(
    { nO: parsed.nO, H: parsed.H },
    {
      prefix: parsed.prefix || options.prefix,
      tA: parsed.tA ?? options.tA,
      v: options.v,
    },
  );
  return {
    ok: expected === parsed.ng,
    expected,
    actual: parsed.ng,
    parsed,
  };
}

if (require.main === module) {
  const [, , command, raw] = process.argv;
  try {
    if (command === 'ng') {
      const payload = JSON.parse(String(raw || '{}'));
      console.log(computePreidNg(payload));
    } else if (command === 'plain') {
      const payload = JSON.parse(String(raw || '{}'));
      console.log(buildPreidPlain(payload));
    } else if (command === 'verify') {
      console.log(JSON.stringify(verifyPreidPlain(String(raw || '')), null, 2));
    } else {
      console.error('usage: aliyun_preid_local.js <ng|plain|verify> <json-or-value>');
      process.exit(1);
    }
  } catch (err) {
    console.error(String(err && err.stack || err));
    process.exit(1);
  }
} else {
  module.exports = {
    PREID_PREFIX,
    PREID_V_VALUE,
    PREID_FOURTH_SEGMENT,
    buildPreidNgSeed,
    computePreidNg,
    buildPreidPlain,
    parsePreidPlain,
    verifyPreidPlain,
  };
}
