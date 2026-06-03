#!/usr/bin/env node
const { runProbe } = require('./probe_feilin_runtime');
const { encodeDeviceConfigParts } = require('./aliyun_local_reverse');

function inspect(report) {
  const init = (report.xhrLog || []).find((x) => x?.params?.Action === 'InitCaptchaV3');
  const verify = (report.xhrLog || []).find((x) => x?.params?.Action === 'VerifyCaptchaV3');
  let decoded = null;
  let payload = null;
  if (verify?.params?.CaptchaVerifyParam) {
    payload = JSON.parse(verify.params.CaptchaVerifyParam);
    decoded = Buffer.from(payload.deviceToken, 'base64').toString('utf8');
  }
  return {
    initHasDeviceToken: !!init?.params?.DeviceToken,
    initHasDeviceData: !!init?.params?.DeviceData,
    getTokenValuePreview: report.getTokenValuePreview,
    zGetTokenValuePreview: report.zGetTokenValuePreview,
    deviceTokenDecoded: decoded,
    deviceTokenParts: decoded ? decoded.split('#') : null,
    dataLen: payload?.data?.length ?? null,
    asyncErrors: report.asyncErrors || [],
  };
}

async function main() {
  const files = [
    process.argv[2] || '/tmp/feilin.js',
    process.argv[3] || '/tmp/aliyun-pe.js',
    process.argv[4] || '/tmp/AliyunCaptcha.js',
  ];
  const variants = [
    ['probeKey', '0', 'probe-session', '3.25.0', 'A', 'B', 'C', String(Date.now()), '1.2.3.4'],
    ['probeKey', '513', 'probe-session', '3.25.0', 'A', 'B', 'C', String(Date.now()), '1.2.3.4'],
    ['probeKey', '513', 'probe-session', '3.25.0', 'navigator', 'resource', 'global', String(Date.now()), '1.2.3.4'],
  ];
  const rows = [];
  for (const parts of variants) {
    const report = await runProbe(files, {
      exposeReverseHelpers: true,
      injectCaptchaVerifyCallback: false,
      initialAliyunCaptchaConfig: { region: 'sgp', prefix: 'no8xfe' },
      setGlobalAliyunCaptchaConfig: true,
      log1DeviceConfig: encodeDeviceConfigParts(parts),
    });
    rows.push({
      candidateParts: parts,
      ...inspect(report),
    });
  }
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
