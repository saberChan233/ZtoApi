#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');
const { encodeDeviceConfigParts } = require('./aliyun_local_reverse');

function wrap(value) {
  return value == null ? '' : Buffer.from(String(value), 'utf8').toString('base64');
}

function sharedPrefixBytes(left, right) {
  const size = Math.min(left.length, right.length);
  let i = 0;
  while (i < size && left[i] === right[i]) i += 1;
  return i;
}

function changedBlocks(base, next, blockSize = 16) {
  const total = Math.ceil(Math.min(base.length, next.length) / blockSize);
  const rows = [];
  for (let i = 0; i < total; i += 1) {
    const start = i * blockSize;
    const end = Math.min(start + blockSize, Math.min(base.length, next.length));
    let diffBytes = 0;
    for (let p = start; p < end; p += 1) {
      if (base[p] !== next[p]) diffBytes += 1;
    }
    if (diffBytes > 0) {
      rows.push({ blockIndex: i, offset: start, diffBytes });
    }
  }
  return rows;
}

function summarize(out) {
  const join = (out.verifyGCallsiteLogs || []).find((item) => item?.stage === 'join') || null;
  const H = join?.namedParts?.H || '';
  return {
    H,
    HBuffer: H ? Buffer.from(H, 'base64') : Buffer.alloc(0),
    ng: join?.namedParts?.ng || null,
    nO: join?.namedParts?.nO || null,
    evalOk: !!out.evalOk,
    xhrActions: out.xhrActions || [],
    asyncErrors: out.asyncErrors || [],
    deviceTokenPreview: out.deviceTokenPreview || null,
    verifyDataSeedPreview: out.verifyDataReverse?.seedPrefix || null,
    verifyDataPreview: out.verifyDataReverse?.dataPreview || null,
    btoaInteresting: out.btoaInteresting || null,
    euStages: (out.preidExprLogs || [])
      .filter((item) => item?.stage === 'eu')
      .map((item) => item?.valuePreview)
      .slice(0, 4),
  };
}

async function runCase(name, options = {}) {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
    ...options,
  });
  return { name, options, summary: summarize(out) };
}

async function main() {
  const cases = [
    {
      name: 'baseline',
      options: {},
    },
    {
      name: 'ua-firefox',
      options: {
        navigatorOverrides: {
          userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
          appVersion: '5.0 (X11)',
          vendor: '',
          platform: 'Linux x86_64',
        },
      },
    },
    {
      name: 'screen-4k',
      options: {
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
      },
    },
    {
      name: 'device-config-mutated',
      options: {
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
      },
    },
    {
      name: 'device-token-mutated',
      options: {
        log1DeviceToken: Buffer.from(
          JSON.stringify({
            dt: 'probe-device-token',
            now: 1777777777777,
            rand: 'abcd1234efef5678',
          }),
          'utf8',
        ).toString('base64'),
      },
    },
    {
      name: 'tracklist-heavy',
      options: {
        syntheticEvents: [
          { type: 'pointerdown', target: 'holder', clientX: 10, clientY: 10, buttons: 1 },
          { type: 'pointermove', target: 'holder', clientX: 35, clientY: 28, buttons: 1 },
          { type: 'pointermove', target: 'holder', clientX: 72, clientY: 51, buttons: 1 },
          { type: 'pointermove', target: 'holder', clientX: 120, clientY: 80, buttons: 1 },
          { type: 'pointerup', target: 'holder', clientX: 120, clientY: 80, buttons: 0 },
        ],
      },
    },
    {
      name: 'tracklist-different-path',
      options: {
        syntheticEvents: [
          { type: 'mousemove', target: 'holder', clientX: 220, clientY: 140, buttons: 1 },
          { type: 'mousemove', target: 'holder', clientX: 260, clientY: 210, buttons: 1 },
          { type: 'mousemove', target: 'holder', clientX: 310, clientY: 260, buttons: 1 },
        ],
      },
    },
  ];

  const results = [];
  for (const item of cases) {
    results.push(await runCase(item.name, item.options));
  }

  const baseline = results[0];
  const baseBuf = baseline.summary.HBuffer;
  const comparisons = results.slice(1).map((row) => {
    const buf = row.summary.HBuffer;
    const diff = changedBlocks(baseBuf, buf);
    return {
      name: row.name,
      HLength: row.summary.H.length,
      ng: row.summary.ng,
      nO: row.summary.nO,
      evalOk: row.summary.evalOk,
      xhrActions: row.summary.xhrActions,
      asyncErrors: row.summary.asyncErrors,
      sharedPrefixBytes: sharedPrefixBytes(baseBuf, buf),
      firstChangedBlock: diff[0] || null,
      changedBlocks: diff.map((item) => item.blockIndex),
      changedBlockCount: diff.length,
      deviceTokenPreview: row.summary.deviceTokenPreview,
      verifyDataSeedPreview: row.summary.verifyDataSeedPreview,
      euStages: row.summary.euStages,
    };
  });

  console.log(JSON.stringify({
    baseline: {
      name: baseline.name,
      ng: baseline.summary.ng,
      nO: baseline.summary.nO,
      HLength: baseline.summary.H.length,
      HHead: baseline.summary.H.slice(0, 120),
      HTail: baseline.summary.H.slice(-120),
      deviceTokenPreview: baseline.summary.deviceTokenPreview,
      verifyDataSeedPreview: baseline.summary.verifyDataSeedPreview,
      euStages: baseline.summary.euStages,
    },
    comparisons,
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
