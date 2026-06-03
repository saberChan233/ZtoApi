#!/usr/bin/env node
const crypto = require('crypto');
const { computeFifthSegment, parseTokenPlain, verifyTokenPlain } = require('./feilin_local_token');

const DEFAULT_FEILIN_KEY = 'FqJB6iRNVYdEGpwb';
const DEFAULT_FEILIN_IV = '0123456789ABCDEF';
const DEFAULT_ALGO = 'aes-128-cbc';

function normalizeUtf8Buffer(value, fieldName) {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return Buffer.from(value, 'utf8');
}

function decryptSessionIdBlobBase64(sessionIdBase64, options = {}) {
  const key = normalizeUtf8Buffer(options.key || DEFAULT_FEILIN_KEY, 'key');
  const iv = normalizeUtf8Buffer(options.iv || DEFAULT_FEILIN_IV, 'iv');
  if (typeof sessionIdBase64 !== 'string' || !sessionIdBase64) {
    throw new Error('sessionIdBase64 must be a non-empty string');
  }
  const ciphertext = Buffer.from(sessionIdBase64, 'base64');
  const decipher = crypto.createDecipheriv(options.algorithm || DEFAULT_ALGO, key, iv);
  decipher.setAutoPadding(false);
  const raw = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (raw.length === 0) return '';
  const pad = raw[raw.length - 1];
  const nextLength = Math.max(0, raw.length - pad);
  return raw.subarray(0, nextLength).toString('utf8');
}

function encryptSessionPlainToBase64(plain, options = {}) {
  const key = normalizeUtf8Buffer(options.key || DEFAULT_FEILIN_KEY, 'key');
  const iv = normalizeUtf8Buffer(options.iv || DEFAULT_FEILIN_IV, 'iv');
  if (typeof plain !== 'string' || !plain) {
    throw new Error('plain must be a non-empty string');
  }
  const cipher = crypto.createCipheriv(options.algorithm || DEFAULT_ALGO, key, iv);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
}

function deriveFullTokenFromSessionBlob(sessionIdBase64, options = {}) {
  const second = decryptSessionIdBlobBase64(sessionIdBase64, options);
  const fifth = second === ''
    ? crypto.createHash('md5').update(`SG_WEB###0#${options.salt || 'daye,raolewoba!'}`, 'utf8').digest('hex')
    : computeFifthSegment(second, options);
  const full = `SG_WEB#${second}##0#${fifth}`;
  return {
    second,
    fifth,
    full,
    verify: second === ''
      ? {
        ok: true,
        expected: fifth,
        actual: fifth,
        parsed: parseTokenPlain(full),
      }
      : verifyTokenPlain(full, options),
  };
}

if (require.main === module) {
  const [, , command, value] = process.argv;
  try {
    if (command === 'decrypt') {
      console.log(decryptSessionIdBlobBase64(String(value || '')));
    } else if (command === 'encrypt') {
      console.log(encryptSessionPlainToBase64(String(value || '')));
    } else if (command === 'full') {
      console.log(JSON.stringify(deriveFullTokenFromSessionBlob(String(value || '')), null, 2));
    } else {
      console.error('usage: feilin_direct_crypto.js <decrypt|encrypt|full> <value>');
      process.exit(1);
    }
  } catch (err) {
    console.error(String(err && err.stack || err));
    process.exit(1);
  }
} else {
  module.exports = {
    DEFAULT_FEILIN_KEY,
    DEFAULT_FEILIN_IV,
    DEFAULT_ALGO,
    decryptSessionIdBlobBase64,
    encryptSessionPlainToBase64,
    deriveFullTokenFromSessionBlob,
  };
}
