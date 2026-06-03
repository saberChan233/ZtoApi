#!/usr/bin/env node
const { runProbe } = require('./probe_feilin_runtime');
const { encodeDeviceConfigParts } = require('./aliyun_local_reverse');

function pickVerifyRequest(report) {
  const entries = Array.isArray(report?.xhrLog) ? report.xhrLog : [];
  return entries.find((entry) => entry?.params?.Action === 'VerifyCaptchaV3') || null;
}

function inspectVerifyPayload(verifyRequest) {
  if (!verifyRequest?.params?.CaptchaVerifyParam) return null;
  const parsed = JSON.parse(verifyRequest.params.CaptchaVerifyParam);
  const decoded = Buffer.from(parsed.deviceToken, 'base64').toString('utf8');
  const parts = decoded.split('#');
  return {
    rawPrefix: parts[0] || '',
    rawPart3: parts[3] || '',
    rawParts: parts.map((x) => x.length),
    dataLen: (parsed.data || '').length,
  };
}

const variants = [
  { name: 'baseline', options: {} },
  {
    name: 'webdriver_true',
    options: {
      navigatorOverrides: { webdriver: true },
    },
  },
  {
    name: 'no_plugins',
    options: {
      navigatorOverrides: { plugins: [], mimeTypes: [] },
    },
  },
  {
    name: 'appleish',
    options: {
      navigatorOverrides: {
        vendor: 'Apple Computer, Inc.',
        platform: 'MacIntel',
        maxTouchPoints: 5,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
        appVersion: '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      },
      windowOverrides: { chrome: undefined },
    },
  },
  {
    name: 'no_chrome_object',
    options: {
      windowOverrides: { chrome: undefined },
    },
  },
  {
    name: 'hidden_doc',
    options: {
      documentOverrides: {
        visibilityState: 'hidden',
        hidden: true,
      },
    },
  },
  {
    name: 'touch_device',
    options: {
      navigatorOverrides: {
        maxTouchPoints: 10,
        platform: 'Linux armv8l',
      },
      screenOverrides: {
        width: 430,
        height: 932,
        availWidth: 430,
        availHeight: 932,
      },
      windowOverrides: {
        innerWidth: 430,
        innerHeight: 932,
        outerWidth: 430,
        outerHeight: 932,
      },
    },
  },
];

async function main() {
  const files = process.argv.slice(2).filter((x) => !x.startsWith('--'));
  const log1DeviceConfig = encodeDeviceConfigParts([
    'probeKey',
    '513',
    'probe-session',
    '3.25.0',
    'A',
    'B',
    'C',
    String(Date.now()),
    '1.2.3.4',
  ]);
  const rows = [];
  for (const variant of variants) {
    const report = await runProbe(files, {
      injectCaptchaVerifyCallback: false,
      initialAliyunCaptchaConfig: { region: 'sgp', prefix: 'no8xfe' },
      setGlobalAliyunCaptchaConfig: true,
      log1DeviceConfig,
      ...variant.options,
    });
    const verifyRequest = pickVerifyRequest(report);
    const initToken = report.getTokenValuePreview
      ? Buffer.from(report.getTokenValuePreview, 'base64').toString('utf8')
      : null;
    rows.push({
      name: variant.name,
      initToken,
      ...inspectVerifyPayload(verifyRequest),
      xhrActions: (report.xhrLog || []).map((x) => x?.params?.Action).filter(Boolean),
      documentCookie: report.documentCookie,
    });
  }
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
