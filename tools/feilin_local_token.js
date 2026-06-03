#!/usr/bin/env node
const crypto = require('crypto');

const DEFAULT_PREFIX = 'SG_WEB';
const DEFAULT_FLAG = '0';
const DEFAULT_SALT = 'daye,raolewoba!';

function buildFifthSegmentSeed(secondSegment, options = {}) {
  const prefix = options.prefix || DEFAULT_PREFIX;
  const flag = options.flag ?? DEFAULT_FLAG;
  const salt = options.salt || DEFAULT_SALT;
  if (typeof secondSegment !== 'string' || !secondSegment) {
    throw new Error('secondSegment must be a non-empty string');
  }
  return `${prefix}#${secondSegment}##${flag}#${salt}`;
}

function computeFifthSegment(secondSegment, options = {}) {
  const seed = buildFifthSegmentSeed(secondSegment, options);
  return crypto.createHash('md5').update(seed, 'utf8').digest('hex');
}

function buildFullToken(secondSegment, options = {}) {
  const prefix = options.prefix || DEFAULT_PREFIX;
  const flag = options.flag ?? DEFAULT_FLAG;
  const fifth = computeFifthSegment(secondSegment, options);
  return `${prefix}#${secondSegment}##${flag}#${fifth}`;
}

function parseTokenPlain(tokenPlain) {
  if (typeof tokenPlain !== 'string' || !tokenPlain) return null;
  const parts = tokenPlain.split('#');
  return {
    raw: tokenPlain,
    partsLength: parts.length,
    prefix: parts[0] ?? null,
    second: parts[1] ?? null,
    third: parts[2] ?? null,
    fourth: parts[3] ?? null,
    fifth: parts[4] ?? null,
  };
}

function verifyTokenPlain(tokenPlain, options = {}) {
  const parsed = parseTokenPlain(tokenPlain);
  if (!parsed || !parsed.second) {
    return { ok: false, error: 'invalid tokenPlain' };
  }
  const expected = computeFifthSegment(parsed.second, {
    prefix: parsed.prefix || options.prefix,
    flag: parsed.fourth || options.flag,
    salt: options.salt,
  });
  return {
    ok: expected === parsed.fifth,
    expected,
    actual: parsed.fifth,
    parsed,
  };
}

function normalizeToBrowserLikeInitToken(tokenPlain, options = {}) {
  const parsed = parseTokenPlain(tokenPlain);
  if (!parsed?.second) {
    return {
      ok: false,
      error: 'invalid tokenPlain',
      parsed,
      normalizedPlain: null,
      normalizedFrom: null,
      verify: null,
    };
  }
  const normalizedPlain = buildFullToken(parsed.second, {
    prefix: options.prefix || DEFAULT_PREFIX,
    flag: parsed.fourth || options.flag,
    salt: options.salt,
  });
  return {
    ok: true,
    parsed,
    normalizedPlain,
    normalizedFrom: parsed.prefix || null,
    verify: verifyTokenPlain(normalizedPlain, options),
  };
}

if (require.main === module) {
  const [, , command, value] = process.argv;
  try {
    if (command === 'fifth') {
      console.log(computeFifthSegment(String(value || '')));
    } else if (command === 'full') {
      console.log(buildFullToken(String(value || '')));
    } else if (command === 'verify') {
      console.log(JSON.stringify(verifyTokenPlain(String(value || '')), null, 2));
    } else {
      console.error('usage: feilin_local_token.js <fifth|full|verify> <value>');
      process.exit(1);
    }
  } catch (err) {
    console.error(String(err && err.stack || err));
    process.exit(1);
  }
} else {
  module.exports = {
    DEFAULT_PREFIX,
    DEFAULT_FLAG,
    DEFAULT_SALT,
    buildFifthSegmentSeed,
    computeFifthSegment,
    buildFullToken,
    parseTokenPlain,
    verifyTokenPlain,
    normalizeToBrowserLikeInitToken,
  };
}
