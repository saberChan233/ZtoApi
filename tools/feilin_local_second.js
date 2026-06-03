#!/usr/bin/env node
const {
  DEFAULT_FEILIN_KEY,
  DEFAULT_FEILIN_IV,
  deriveFullTokenFromSessionBlob,
} = require('./feilin_direct_crypto');

async function computeLocalTokenFromSessionBlob(sessionIdBase64, options = {}) {
  if (!sessionIdBase64) {
    throw new Error('sessionIdBase64 is required');
  }
  const local = deriveFullTokenFromSessionBlob(sessionIdBase64, options);
  return {
    method: 'direct-aes-cbc',
    crypto: {
      algorithm: options.algorithm || 'aes-128-cbc',
      key: options.key || DEFAULT_FEILIN_KEY,
      iv: options.iv || DEFAULT_FEILIN_IV,
    },
    sessionIdBase64,
    local,
  };
}

async function main() {
  const [, , sessionIdBase64] = process.argv;
  if (!sessionIdBase64) {
    console.error('usage: feilin_local_second.js <sessionIdBase64>');
    process.exit(1);
  }
  const result = await computeLocalTokenFromSessionBlob(sessionIdBase64);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
} else {
  module.exports = {
    computeLocalTokenFromSessionBlob,
  };
}
