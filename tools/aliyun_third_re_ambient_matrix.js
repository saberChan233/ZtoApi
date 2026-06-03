#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

function pickNullRsSample(report) {
  const rows = Array.isArray(report?.feilinRsLogs) ? report.feilinRsLogs : [];
  const candidates = rows.filter((row) =>
    row?.outputString === 'null' &&
    typeof row?.arg0 === 'string' &&
    typeof row?.arg1 === 'string' &&
    row.arg1.includes('#') &&
    row.arg1.length > 300);
  candidates.sort((a, b) => (b.arg1Length || 0) - (a.arg1Length || 0));
  return candidates[0] || null;
}

function buildReMutations(altRe) {
  const mutations = [];
  const rootKeys = ['DeviceConfig', 'timestamp', 'secretKey', 'sessionId', 'initTime', 'logs', 'DeviceToken'];
  for (const key of rootKeys) {
    if (altRe?.[key] !== undefined) mutations.push({ path: [key], value: altRe[key] });
  }
  if (altRe?.deviceConfig && typeof altRe.deviceConfig === 'object') {
    mutations.push({ path: ['deviceConfig'], value: altRe.deviceConfig });
  }
  if (altRe?.deviceData && typeof altRe.deviceData === 'object') {
    mutations.push({ path: ['deviceData'], value: altRe.deviceData });
  }
  return mutations;
}

function buildRowSummary(row, label) {
  return {
    label,
    outputType: row?.outputType || null,
    outputString: row?.outputString || null,
    outputDecodedPreview: row?.outputDecodedPreview || null,
    lastAId: row?.lastAId ?? null,
    innerStages: row?.innerStages || null,
    innerThrow: row?.innerThrow
      ? {
        methodKey: row.innerThrow.methodKey || null,
        error: row.innerThrow.error || null,
      }
      : null,
    error: row?.error || null,
  };
}

async function loadOne() {
  return solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
  });
}

async function main() {
  const [base, alt] = await Promise.all([loadOne(), loadOne()]);
  const baseNull = pickNullRsSample(base);
  if (!baseNull) throw new Error('missing base null sample');
  const altRe = alt?.feilinReSnapshot?.preview?.deviceData?.value
    ? alt.feilinReSnapshot.preview
    : alt?.feilinReSnapshot?.preview || null;
  if (!altRe) throw new Error('missing alternate FEILIN_RE preview');

  const mutations = buildReMutations({
    DeviceConfig: altRe?.DeviceConfig?.value,
    timestamp: altRe?.timestamp?.value,
    secretKey: altRe?.secretKey?.value,
    sessionId: altRe?.sessionId?.value,
    initTime: altRe?.initTime?.value,
    logs: altRe?.logs?.value,
    DeviceToken: altRe?.DeviceToken?.value,
    deviceConfig: altRe?.deviceConfig?.value,
    deviceData: altRe?.deviceData?.value,
  });

  const replay = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
    reMutationExperimentInputs: mutations,
    rsExperimentInputs: [
      { label: 'base-null-with-mutated-FEILIN_RE', arg0: baseNull.arg0, arg1: baseNull.arg1, thisKind: 'undefined' },
    ],
  });

  const row = Array.isArray(replay.rsExperiment) ? replay.rsExperiment[0] || null : null;
  console.log(JSON.stringify({
    baseNull: {
      arg0: baseNull.arg0,
      arg1Length: baseNull.arg1Length,
      arg1Head: baseNull.arg1.slice(0, 280),
    },
    mutationCount: mutations.length,
    mutationPaths: mutations.map((x) => x.path.join('.')),
    reMutationApplied: replay.reMutationApplied || null,
    rsResult: buildRowSummary(row, 'base-null-with-mutated-FEILIN_RE'),
    feilinReSnapshotAfterMutation: replay.feilinReSnapshotAfterMutation || null,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
