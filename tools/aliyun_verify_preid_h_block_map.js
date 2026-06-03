#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { encodeDeviceConfigParts } = require('./aliyun_local_reverse');

function wrap(value) {
  return value == null ? '' : Buffer.from(String(value), 'utf8').toString('base64');
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
  return {
    H,
    HBuffer: H ? Buffer.from(H, 'base64') : Buffer.alloc(0),
    ng: join?.namedParts?.ng || null,
    nO: join?.namedParts?.nO || null,
    verifyDataSeedPreview: out.verifyDataReverse?.seedPrefix || null,
    euSecond: (out.preidExprLogs || []).find((item) => item?.stage === 'eu' && typeof item?.valuePreview === 'string' && item.valuePreview.includes('TrackList'))?.valuePreview || null,
  };
}

async function runCase(name, options = {}) {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
    ...options,
  });
  return { name, summary: summarize(out) };
}

async function main() {
  const cases = [
    ['baseline', {}],
    ['ua-firefox', {
      navigatorOverrides: {
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
        appVersion: '5.0 (X11)',
        vendor: '',
        platform: 'Linux x86_64',
      },
    }],
    ['screen-4k', {
      screenOverrides: {
        width: 3840,
        height: 2160,
        availWidth: 3840,
        availHeight: 2112,
        colorDepth: 30,
        pixelDepth: 30,
      },
      windowOverrides: {
        innerWidth: 1905,
        innerHeight: 1021,
        devicePixelRatio: 2,
      },
    }],
    ['device-config-mutated', {
      syntheticLog1DeviceConfig: encodeDeviceConfigParts([
        wrap('3795d28242a11619bc25f786f84e53d4'),
        wrap('2048'),
        '3795d28242a11619bc25f786f84e53d4-h-1777777777777-feedfacecafebeef0011223344556677',
        '9.99.9',
        wrap('fr-FR'),
        wrap('Europe/Paris'),
        wrap('probe-mutated-device-config'),
        '1777777777777',
        '8.8.8.8',
      ]),
    }],
    ['device-token-mutated', {
      log1DeviceToken: Buffer.from(
        JSON.stringify({
          dt: 'probe-device-token',
          now: 1777777777777,
          rand: 'abcd1234efef5678',
        }),
        'utf8',
      ).toString('base64'),
    }],
  ];

  const results = [];
  for (const [name, options] of cases) {
    results.push(await runCase(name, options));
  }

  const baseline = results[0];
  const baseBuf = baseline.summary.HBuffer;
  const totalBlocks = Math.ceil(baseBuf.length / 16);
  const changesByCase = Object.fromEntries(
    results.slice(1).map((row) => [row.name, diffBlockIndexes(baseBuf, row.summary.HBuffer, 16)]),
  );

  const blockMap = Array.from({ length: totalBlocks }, (_, blockIndex) => {
    const changedBy = Object.entries(changesByCase)
      .filter(([, indexes]) => indexes.includes(blockIndex))
      .map(([name]) => name);
    return {
      blockIndex,
      offset: blockIndex * 16,
      changedBy,
      classGuess: changedBy.includes('ua-firefox') && changedBy.includes('device-config-mutated') && !changedBy.includes('screen-4k')
        ? 'ua-or-static-browser-fingerprint'
        : changedBy.includes('device-config-mutated') && !changedBy.includes('screen-4k') && !changedBy.includes('device-token-mutated')
        ? 'device-config-middle-zone'
        : changedBy.includes('screen-4k') && changedBy.includes('device-token-mutated')
        ? 'dynamic-verify-payload'
        : changedBy.length === 0
        ? 'stable-header'
        : 'mixed',
      baseHex: baseBuf.subarray(blockIndex * 16, Math.min((blockIndex + 1) * 16, baseBuf.length)).toString('hex'),
    };
  });

  console.log(JSON.stringify({
    baseline: {
      nO: baseline.summary.nO,
      ng: baseline.summary.ng,
      totalBlocks,
      verifyDataSeedPreview: baseline.summary.verifyDataSeedPreview,
      euSecond: baseline.summary.euSecond,
      HHead: baseline.summary.H.slice(0, 120),
      HTail: baseline.summary.H.slice(-120),
    },
    changesByCase,
    blockMap,
    grouped: {
      stableHeader: blockMap.filter((x) => x.classGuess === 'stable-header').map((x) => x.blockIndex),
      uaOrStaticBrowserFingerprint: blockMap.filter((x) => x.classGuess === 'ua-or-static-browser-fingerprint').map((x) => x.blockIndex),
      deviceConfigMiddleZone: blockMap.filter((x) => x.classGuess === 'device-config-middle-zone').map((x) => x.blockIndex),
      dynamicVerifyPayload: blockMap.filter((x) => x.classGuess === 'dynamic-verify-payload').map((x) => x.blockIndex),
      mixed: blockMap.filter((x) => x.classGuess === 'mixed').map((x) => x.blockIndex),
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
