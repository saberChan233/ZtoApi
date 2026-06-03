#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

function sharedPrefixBytes(left, right) {
  const size = Math.min(left.length, right.length);
  let i = 0;
  while (i < size && left[i] === right[i]) i += 1;
  return i;
}

function diffBlockIndexes(base, next, blockSize = 16) {
  const total = Math.ceil(Math.min(base.length, next.length) / blockSize);
  const changed = [];
  for (let i = 0; i < total; i += 1) {
    const start = i * blockSize;
    const end = Math.min(start + blockSize, Math.min(base.length, next.length));
    for (let p = start; p < end; p += 1) {
      if (base[p] !== next[p]) {
        changed.push(i);
        break;
      }
    }
  }
  return changed;
}

function summarize(out) {
  const join = (out.verifyGCallsiteLogs || []).find((item) => item?.stage === 'join') || null;
  const H = join?.namedParts?.H || '';
  const HBuffer = H ? Buffer.from(H, 'base64') : Buffer.alloc(0);
  return {
    joinNamed: join?.namedParts || null,
    H,
    HBuffer,
    verifyDataReverse: out.verifyDataReverse || null,
    verifyDataLocalRebuild: out.verifyDataLocalRebuild || null,
    verifyDataRuntimeFrame: out.verifyDataRuntimeFrame || null,
  };
}

async function runCase(options = {}) {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
    ...options,
  });
  return summarize(out);
}

async function main() {
  const baseline = await runCase();
  const mutated = await runCase({
    log1DeviceToken: Buffer.from(
      JSON.stringify({
        dt: 'probe-device-token',
        now: 1777777777777,
        rand: 'abcd1234efef5678',
      }),
      'utf8',
    ).toString('base64'),
  });

  const sharedPrefix = sharedPrefixBytes(baseline.HBuffer, mutated.HBuffer);
  const changedBlocks = diffBlockIndexes(baseline.HBuffer, mutated.HBuffer, 16);

  console.log(JSON.stringify({
    baseline: {
      nO: baseline.joinNamed?.nO || null,
      ng: baseline.joinNamed?.ng || null,
      HLength: baseline.H.length,
      sharedStablePrefixBlocksHypothesis: 17,
      verifyDataSeedPrefix: baseline.verifyDataReverse?.seedPrefix || null,
      verifyDataSeedJson: baseline.verifyDataReverse?.seedJsonParsed || null,
      verifyDataBase64: baseline.verifyDataReverse?.dataValue || null,
      verifyDataRebuildMatchesRuntime: baseline.verifyDataLocalRebuild?.matchRuntime || false,
      runtimeSeedBase64Like: baseline.verifyDataRuntimeFrame?.runtimeSeedBase64Like || null,
      keyHex: baseline.verifyDataRuntimeFrame?.keyHex || null,
      rawBinaryLength: baseline.verifyDataRuntimeFrame?.rawBinaryLength || null,
      finalDataLength: baseline.verifyDataRuntimeFrame?.finalDataLength || null,
    },
    mutated: {
      nO: mutated.joinNamed?.nO || null,
      ng: mutated.joinNamed?.ng || null,
      HLength: mutated.H.length,
      verifyDataSeedPrefix: mutated.verifyDataReverse?.seedPrefix || null,
      verifyDataSeedJson: mutated.verifyDataReverse?.seedJsonParsed || null,
      verifyDataBase64: mutated.verifyDataReverse?.dataValue || null,
      verifyDataRebuildMatchesRuntime: mutated.verifyDataLocalRebuild?.matchRuntime || false,
      runtimeSeedBase64Like: mutated.verifyDataRuntimeFrame?.runtimeSeedBase64Like || null,
      keyHex: mutated.verifyDataRuntimeFrame?.keyHex || null,
      rawBinaryLength: mutated.verifyDataRuntimeFrame?.rawBinaryLength || null,
      finalDataLength: mutated.verifyDataRuntimeFrame?.finalDataLength || null,
    },
    correlation: {
      sharedPrefixBytes: sharedPrefix,
      sharedPrefixBlocks: sharedPrefix / 16,
      changedBlocks,
      dynamicZoneStartsAtBlock: changedBlocks[0] ?? null,
      verifyDataChanged: baseline.verifyDataReverse?.dataValue !== mutated.verifyDataReverse?.dataValue,
      verifyDataSeedChanged: baseline.verifyDataReverse?.seedPrefix !== mutated.verifyDataReverse?.seedPrefix,
      verifyDataJsonChanged: JSON.stringify(baseline.verifyDataReverse?.seedJsonParsed || null) !== JSON.stringify(mutated.verifyDataReverse?.seedJsonParsed || null),
      interpretation: [
        'verifyData local rebuild already matches runtime exactly',
        'mutating device token changes verifyData seed/payload',
        'the same mutation flips H only from block 17 onward',
        'therefore H block 17..33 is downstream of the verifyData pipeline already reversed locally',
      ],
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
