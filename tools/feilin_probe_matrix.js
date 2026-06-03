#!/usr/bin/env node
const { runProbe } = require('./probe_feilin_runtime');

function pickVerifyRequest(report) {
  const entries = Array.isArray(report?.xhrLog) ? report.xhrLog : [];
  for (const entry of entries) {
    if (entry?.params?.Action === 'VerifyCaptchaV3') {
      return entry;
    }
  }
  return null;
}

function decodeDeviceTokenPrefix(verifyRequest) {
  try {
    const raw = verifyRequest?.params?.CaptchaVerifyParam;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Buffer.from(parsed.deviceToken, 'base64').toString('utf8').slice(0, 120);
  } catch {
    return null;
  }
}

const variants = [
  { name: 'baseline', options: {} },
  {
    name: 'with_zai_cookie',
    options: {
      documentCookie: 'zai_visit=1; locale=en-US; visitor_id=probe-visitor-1',
      localStorageSeed: { visitor_id: 'probe-visitor-1' },
    },
  },
  {
    name: 'with_uid_markers',
    options: {
      documentCookie: 'UM_distinctid=probe-um-1; cna=probe-cna-1; isg=probe-isg-1',
      localStorageSeed: {
        UM_distinctid: 'probe-um-1',
        cna: 'probe-cna-1',
      },
    },
  },
  {
    name: 'with_chromeish_state',
    options: {
      localStorageSeed: {
        locale: 'en-US',
        theme: 'dark',
        visitor_id: 'probe-visitor-2',
      },
      navigatorOverrides: {
        deviceMemory: 16,
        hardwareConcurrency: 16,
      },
      screenOverrides: {
        width: 1728,
        height: 1117,
        availWidth: 1728,
        availHeight: 1117,
      },
    },
  },
];

async function main() {
  const files = process.argv.slice(2).filter((x) => !x.startsWith('--'));
  const out = [];
  for (const variant of variants) {
    const report = await runProbe(files, {
      injectCaptchaVerifyCallback: false,
      initialAliyunCaptchaConfig: { region: 'sgp', prefix: 'no8xfe' },
      setGlobalAliyunCaptchaConfig: false,
      ...variant.options,
    });
    const verifyRequest = pickVerifyRequest(report);
    out.push({
      name: variant.name,
      evalOk: report.evalOk,
      xhrActions: (report.xhrLog || []).map((x) => x?.params?.Action).filter(Boolean),
      deviceTokenPrefix: decodeDeviceTokenPrefix(verifyRequest),
      documentCookie: report.documentCookie,
      localStorageSnapshot: report.localStorageSnapshot,
      sessionStorageSnapshot: report.sessionStorageSnapshot,
    });
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
