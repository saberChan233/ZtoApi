#!/usr/bin/env node
const { loadNrDecoder } = require('./aliyun_nr_local');

function buildCurrentBundleHelperChain(bundlePath = '/tmp/aliyun-pe.js') {
  const decoder = loadNrDecoder(bundlePath);
  return {
    bundlePath,
    decodeTo(arg0, arg1) {
      return decoder.to(arg0, arg1);
    },
    decodeTm(arg0, arg1) {
      return decoder.tm(arg0, arg1);
    },
    safeDecodeTo(arg0, arg1) {
      return decoder.safeTo(arg0, arg1);
    },
    safeDecodeTm(arg0, arg1) {
      return decoder.safeTm(arg0, arg1);
    },
    getKnownBundleSymbols() {
      return {
        keyHexSuffix: decoder.tm(227, 78),
        stringCtorName: decoder.tm(33, 89),
        lengthProp: decoder.tm(65, 7),
        configProp: decoder.tm(262, 73),
        eNonceProp: decoder.tm(187, 62),
      };
    },
    computeVerifyKeyHex(prefixHex) {
      return `${String(prefixHex || '')}${decoder.tm(227, 78)}`;
    },
  };
}

function main() {
  const chain = buildCurrentBundleHelperChain('/tmp/aliyun-pe.js');
  console.log(JSON.stringify({
    bundlePath: chain.bundlePath,
    knownSymbols: chain.getKnownBundleSymbols(),
    samples: {
      tm_84_30: chain.safeDecodeTm(84, 30),
      tm_227_78: chain.safeDecodeTm(227, 78),
      tm_33_89: chain.safeDecodeTm(33, 89),
      tm_65_7: chain.safeDecodeTm(65, 7),
      tm_262_73: chain.safeDecodeTm(262, 73),
      tm_187_62: chain.safeDecodeTm(187, 62),
    },
  }, null, 2));
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    buildCurrentBundleHelperChain,
  };
}
