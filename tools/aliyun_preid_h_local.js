#!/usr/bin/env node
const crypto = require('crypto');

const PREID_H_STATIC_PREFIX_BYTES = 272;
const PREID_H_TAIL_IV_BYTES = 16;
const PREID_H_TT_TAIL_OFFSET = 288;
const PREID_H_STATIC_PREFIX_BASE64 = 'Ter/qxZsDkzBCRaIDC+CZgNIhikREC2+m1zI/B+Qa8/Ih1+u6uC9T5eoJBbfEmhDZQvzyMVtVIJi+XtoDMj8QpzR7SWK6VxryGj7NnZ0442Bnag5UlKUFG4dewNHgySYnueaTA3ZDSim2nwCP7vbODDrDPgVabofF237e1z7Wo3m+z4lXMnxz63FAYZJXLoSEAp/oSocrXh8d/2FDyIa2oFBkSa5FTz6eRC6bTfM9hmyhAfvVQ5+EUowpkr7nvCA5bcOGf6EczeEDlaTy32Nx/lZO8XljW20c4cAawGp9EIj35tCt8C3ws7pFx2PQD1Z4OtxyOkLfcw1lptSznCGoUyYtjvXIK/LEpNuCgwmRYA=';

function decodePreidH(value) {
  if (typeof value !== 'string' || !value) {
    throw new Error('H must be a non-empty base64 string');
  }
  return Buffer.from(value, 'base64');
}

function getDefaultPreidHPrefixBuffer() {
  const prefix = Buffer.from(PREID_H_STATIC_PREFIX_BASE64, 'base64');
  if (prefix.length !== PREID_H_STATIC_PREFIX_BYTES) {
    throw new Error(`unexpected default PREID.H prefix length: ${prefix.length}`);
  }
  return prefix;
}

function splitPreidH(value) {
  const buffer = decodePreidH(value);
  if (buffer.length < PREID_H_STATIC_PREFIX_BYTES + PREID_H_TAIL_IV_BYTES) {
    throw new Error(`unexpected H byte length: ${buffer.length}`);
  }
  return {
    buffer,
    prefix: buffer.subarray(0, PREID_H_STATIC_PREFIX_BYTES),
    tail: buffer.subarray(PREID_H_STATIC_PREFIX_BYTES),
  };
}

function derivePreidHTailKeyHexFromNO(nO) {
  if (typeof nO !== 'string' || !nO) {
    throw new Error('nO must be a non-empty string');
  }
  return Buffer.from(nO.slice(0, 8), 'utf8').toString('hex');
}

function derivePreidHTailKeyBufferFromNO(nO) {
  return Buffer.from(derivePreidHTailKeyHexFromNO(nO), 'utf8');
}

function decryptPreidHTail(H, nO) {
  const { tail } = splitPreidH(H);
  const key = derivePreidHTailKeyBufferFromNO(nO);
  const iv = tail.subarray(0, PREID_H_TAIL_IV_BYTES);
  const ciphertext = tail.subarray(PREID_H_TAIL_IV_BYTES);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(true);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return {
    keyHexUtf8: key.toString('utf8'),
    iv,
    ciphertext,
    plaintext,
    plaintextUtf8: plaintext.toString('utf8'),
  };
}

function createRandomPreidHTailIv() {
  return crypto.randomBytes(PREID_H_TAIL_IV_BYTES);
}

function encryptPreidHTail(plainUtf8, nO, iv) {
  const key = derivePreidHTailKeyBufferFromNO(nO);
  const ivBuffer = iv == null
    ? createRandomPreidHTailIv()
    : Buffer.isBuffer(iv)
      ? iv
      : Buffer.from(iv);
  if (ivBuffer.length !== PREID_H_TAIL_IV_BYTES) {
    throw new Error(`unexpected PREID.H iv length: ${ivBuffer.length}`);
  }
  const cipher = crypto.createCipheriv('aes-128-cbc', key, ivBuffer);
  cipher.setAutoPadding(true);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(String(plainUtf8 || ''), 'utf8')), cipher.final()]);
  return {
    keyHexUtf8: key.toString('utf8'),
    iv: ivBuffer,
    ciphertext,
    tail: Buffer.concat([ivBuffer, ciphertext]),
  };
}

function locatePreidHTailPlaintextInTT(tT, plaintext) {
  if (typeof tT !== 'string' || !tT) {
    throw new Error('tT must be a non-empty string');
  }
  const plainUtf8 = Buffer.isBuffer(plaintext) ? plaintext.toString('utf8') : String(plaintext || '');
  if (!plainUtf8) {
    throw new Error('plaintext must be non-empty');
  }
  const start = tT.indexOf(plainUtf8);
  if (start < 0) {
    return {
      found: false,
      start: -1,
      end: -1,
      length: plainUtf8.length,
      headNeedle: plainUtf8.slice(0, 80),
      tailNeedle: plainUtf8.slice(-80),
    };
  }
  return {
    found: true,
    start,
    end: start + plainUtf8.length,
    length: plainUtf8.length,
    slice: tT.slice(start, start + plainUtf8.length),
  };
}

function extractPreidHTailPlaintextFromTT(tT) {
  if (typeof tT !== 'string' || !tT) {
    throw new Error('tT must be a non-empty string');
  }
  if (tT.length < PREID_H_TT_TAIL_OFFSET) {
    throw new Error(`tT too short: ${tT.length}`);
  }
  return tT.slice(PREID_H_TT_TAIL_OFFSET);
}

function buildPreidHFromParts(prefix, plainUtf8, nO, iv) {
  const prefixBuffer = Buffer.isBuffer(prefix) ? prefix : Buffer.from(prefix);
  const encrypted = encryptPreidHTail(plainUtf8, nO, iv);
  return {
    prefix: prefixBuffer,
    ...encrypted,
    buffer: Buffer.concat([prefixBuffer, encrypted.tail]),
    H: Buffer.concat([prefixBuffer, encrypted.tail]).toString('base64'),
  };
}

function rebuildPreidHFromTT(prefix, tT, nO, iv) {
  return buildPreidHFromParts(prefix, extractPreidHTailPlaintextFromTT(tT), nO, iv);
}

if (require.main === module) {
  const [, , command, arg1, arg2] = process.argv;
  try {
    if (command === 'split') {
      const out = splitPreidH(String(arg1 || ''));
      console.log(JSON.stringify({
        totalBytes: out.buffer.length,
        prefixBytes: out.prefix.length,
        tailBytes: out.tail.length,
        prefixBase64: out.prefix.toString('base64'),
        tailBase64: out.tail.toString('base64'),
      }, null, 2));
    } else if (command === 'decrypt-tail') {
      const out = decryptPreidHTail(String(arg1 || ''), String(arg2 || ''));
      console.log(JSON.stringify({
        keyHexUtf8: out.keyHexUtf8,
        ivHex: out.iv.toString('hex'),
        ciphertextBytes: out.ciphertext.length,
        plaintextBytes: out.plaintext.length,
        plaintextUtf8: out.plaintextUtf8,
      }, null, 2));
    } else {
      console.error('usage: aliyun_preid_h_local.js <split|decrypt-tail> <H> [nO]');
      process.exit(1);
    }
  } catch (err) {
    console.error(String(err && err.stack || err));
    process.exit(1);
  }
} else {
  module.exports = {
    PREID_H_STATIC_PREFIX_BYTES,
    PREID_H_TAIL_IV_BYTES,
    PREID_H_TT_TAIL_OFFSET,
    PREID_H_STATIC_PREFIX_BASE64,
    decodePreidH,
    getDefaultPreidHPrefixBuffer,
    splitPreidH,
    derivePreidHTailKeyHexFromNO,
    derivePreidHTailKeyBufferFromNO,
    decryptPreidHTail,
    createRandomPreidHTailIv,
    encryptPreidHTail,
    locatePreidHTailPlaintextInTT,
    extractPreidHTailPlaintextFromTT,
    buildPreidHFromParts,
    rebuildPreidHFromTT,
  };
}
