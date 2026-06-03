#!/usr/bin/env node
const crypto = require('crypto');

const ACCESS_SEC = 'FqJB6iRNVYdEGpwb';
const AES_IV_HEX = 'd35db7e39ebbf3d001083105';
const AES_IV_UTF8 = Buffer.from(Buffer.from(AES_IV_HEX, 'hex').toString('base64'), 'utf8').toString('utf8');
const DEVICE_CONFIG_KEY = '87f879f135f27da7';
const LOG1_DATA_KEY = '45f8ac1e1de14397';
const KEY_ID = process.env.ALIYUN_CAPTCHA_ACCESS_KEY_ID || '';
const KEY_SECRET = process.env.ALIYUN_CAPTCHA_ACCESS_KEY_SECRET || '';
const AES_ALGO = 'aes-128-cbc';

function normalizeUtf8(value, fieldName) {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return Buffer.from(value, 'utf8');
}

function aesEncryptToBase64(secretKey, plain) {
  const key = normalizeUtf8(secretKey, 'secretKey');
  const iv = normalizeUtf8(AES_IV_UTF8, 'AES_IV_UTF8');
  const cipher = crypto.createCipheriv(AES_ALGO, key, iv);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(String(plain || ''), 'utf8'), cipher.final()]).toString('base64');
}

function aesDecryptFromBase64(secretKey, ciphertextBase64) {
  const key = normalizeUtf8(secretKey, 'secretKey');
  const iv = normalizeUtf8(AES_IV_UTF8, 'AES_IV_UTF8');
  const decipher = crypto.createDecipheriv(AES_ALGO, key, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(Buffer.from(String(ciphertextBase64 || ''), 'base64')), decipher.final()])
    .toString('utf8');
}

function encodeDeviceConfigParts(parts) {
  return aesEncryptToBase64(DEVICE_CONFIG_KEY, (parts || []).join('#'));
}

function decodeDeviceConfigRaw(value) {
  return aesDecryptFromBase64(DEVICE_CONFIG_KEY, value);
}

function encodeLog1DataParts(parts) {
  return aesEncryptToBase64(LOG1_DATA_KEY, (parts || []).join('#'));
}

function specialEncode(value) {
  if (value === undefined || value === null) return null;
  return encodeURIComponent(String(value))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

function canonicalizeCaptchaParams(params) {
  const payload = { ...(params || {}) };
  delete payload.Signature;
  const keys = Object.keys(payload).sort();
  return keys
    .map((key) => `${specialEncode(key)}=${specialEncode(payload[key])}`)
    .join('&');
}

function signCaptchaParams(params, secret = KEY_SECRET) {
  const canonicalized = canonicalizeCaptchaParams(params);
  const stringToSign = `POST&${specialEncode('/')}&${specialEncode(canonicalized)}`;
  return crypto.createHmac('sha1', `${secret}&`).update(stringToSign, 'utf8').digest('base64');
}

function decodeBase64Utf8(value) {
  if (typeof value !== 'string' || !value) return '';
  return Buffer.from(value, 'base64').toString('utf8');
}

function parseDeviceConfigToken(value) {
  const raw = decodeDeviceConfigRaw(value);
  const parts = raw.split('#');
  if (parts.length < 9) {
    return { raw, parts };
  }
  return {
    raw,
    parts,
    appKey: decodeBase64Utf8(parts[0]),
    flag: Number(decodeBase64Utf8(parts[1])),
    sessionId: parts[2],
    version: parts[3],
    userId: decodeBase64Utf8(parts[4]),
    nonce: decodeBase64Utf8(parts[5]),
    extra: decodeBase64Utf8(parts[6]),
    timestamp: parts[7],
    ip: parts[8],
  };
}

module.exports = {
  ACCESS_SEC,
  AES_IV_HEX,
  AES_IV_UTF8,
  DEVICE_CONFIG_KEY,
  LOG1_DATA_KEY,
  KEY_ID,
  KEY_SECRET,
  aesEncryptToBase64,
  aesDecryptFromBase64,
  encodeDeviceConfigParts,
  decodeDeviceConfigRaw,
  encodeLog1DataParts,
  specialEncode,
  canonicalizeCaptchaParams,
  signCaptchaParams,
  parseDeviceConfigToken,
};
