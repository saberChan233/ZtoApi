#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

function pkcs7EnvelopeBytes(plainLength, blockSize = 16, ivBytes = 16) {
  const padded = (Math.floor(plainLength / blockSize) + 1) * blockSize;
  return ivBytes + padded;
}

function summarize(out) {
  const join = (out.verifyGCallsiteLogs || []).find((item) => item?.stage === 'join') || null;
  const H = join?.namedParts?.H || '';
  const hBytes = H ? Buffer.from(H, 'base64') : Buffer.alloc(0);
  const dynamicZoneBytes = hBytes.length >= 272 ? hBytes.length - 272 : null;
  const seedLength = out.verifyDataReverse?.seedLength ?? null;
  const rawBinaryLength = out.verifyDataRuntimeFrame?.rawBinaryLength ?? null;
  const finalDataLength = out.verifyDataRuntimeFrame?.finalDataLength ?? null;
  return {
    nO: join?.namedParts?.nO || null,
    ng: join?.namedParts?.ng || null,
    hBytes: hBytes.length,
    dynamicZoneBytes,
    seedLength,
    rawBinaryLength,
    finalDataLength,
    seedEnvelopeBytes: seedLength == null ? null : pkcs7EnvelopeBytes(seedLength),
    rawBinaryEnvelopeBytes: rawBinaryLength == null ? null : pkcs7EnvelopeBytes(rawBinaryLength),
    finalDataEnvelopeBytes: finalDataLength == null ? null : pkcs7EnvelopeBytes(finalDataLength),
    seedJson: out.verifyDataReverse?.seedJsonParsed || null,
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

  console.log(JSON.stringify({
    baseline,
    mutated,
    conclusion: {
      dynamicZoneBytesStable: baseline.dynamicZoneBytes === mutated.dynamicZoneBytes,
      seedEnvelopeMatchesDynamicZone: baseline.dynamicZoneBytes === baseline.seedEnvelopeBytes &&
        mutated.dynamicZoneBytes === mutated.seedEnvelopeBytes,
      rawBinaryEnvelopeMatchesDynamicZone: baseline.dynamicZoneBytes === baseline.rawBinaryEnvelopeBytes &&
        mutated.dynamicZoneBytes === mutated.rawBinaryEnvelopeBytes,
      finalDataEnvelopeMatchesDynamicZone: baseline.dynamicZoneBytes === baseline.finalDataEnvelopeBytes &&
        mutated.dynamicZoneBytes === mutated.finalDataEnvelopeBytes,
      interpretation: [
        'H dynamic tail length matches IV + PKCS7(seed string) envelope',
        'it does not match IV + PKCS7(raw binary verifyData)',
        'it does not match IV + PKCS7(base64 finalData)',
        'so H tail is more likely encrypting the pre-K seed string (seedPrefix + TrackList/VerifyTime/arg)',
      ],
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
