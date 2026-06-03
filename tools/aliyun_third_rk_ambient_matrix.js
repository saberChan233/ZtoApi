#!/usr/bin/env node
const { runProbe } = require('./probe_feilin_runtime');
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

const FILES = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];
const BASE_OPTIONS = {
  initialAliyunCaptchaConfig: {
    region: 'sgp',
    prefix: 'no8xfe',
  },
  setGlobalAliyunCaptchaConfig: true,
  captureXhrStacks: false,
};

function note(message) {
  process.stderr.write(`[rk-matrix] ${message}\n`);
}

function forceGc() {
  if (typeof global.gc === 'function') {
    try {
      global.gc();
    } catch {
      // ignore
    }
  }
}

function pickNullRsSample(report) {
  const rows = Array.isArray(report?.feilinRsLogs) ? report.feilinRsLogs : [];
  const candidates = rows.filter((row) =>
    row?.outputString === 'null' &&
    typeof row?.arg0 === 'string' &&
    typeof row?.arg1 === 'string' &&
    row.arg1.includes('#') &&
    row.arg1.length > 300);
  candidates.sort((a, b) => (b.arg1Length || 0) - (a.arg1Length || 0));
  const row = candidates[0] || null;
  if (!row) return null;
  return {
    arg0: row.arg0,
    arg1: row.arg1,
    arg1Length: row.arg1Length || row.arg1.length,
  };
}

function buildRkMutations(altRkPreview) {
  const mutations = [];
  for (const key of ['REQ', 'RES', 'FLAG', 'UPLOAD', 'PREID']) {
    const value = altRkPreview?.[key]?.value;
    if (value !== undefined) mutations.push({ path: [key], value });
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

async function runLiteProbe(extraOptions = {}) {
  const report = await runProbe(FILES, {
    ...BASE_OPTIONS,
    ...extraOptions,
  });
  const out = {
    nullSample: pickNullRsSample(report),
    rkPreview: report?.feilinRkSnapshot?.preview || null,
    rsExperiment: Array.isArray(report?.rsExperiment) ? report.rsExperiment : null,
    rkMutationApplied: report?.rkMutationApplied || null,
    feilinRkSnapshotAfterMutation: report?.feilinRkSnapshotAfterMutation || null,
  };
  forceGc();
  return out;
}

async function main() {
  note('load base runtime');
  const baseFull = await solveCaptcha({
    files: FILES,
    loaderPath: FILES[2],
  });
  const baseNullSample = pickNullRsSample(baseFull);
  if (!baseNullSample) throw new Error('missing base null sample');
  forceGc();

  note('load alternate runtime');
  const alt = await runLiteProbe();
  if (!alt.rkPreview) throw new Error('missing alternate FEILIN_RK preview');

  const wholeObjectMutations = buildRkMutations(alt.rkPreview);
  note(`run whole RK mutation set (${wholeObjectMutations.length})`);
  const wholeReplay = await runLiteProbe({
    rkMutationExperimentInputs: wholeObjectMutations,
    rsExperimentInputs: [
      {
        label: 'base-null-with-mutated-FEILIN_RK',
        arg0: baseNullSample.arg0,
        arg1: baseNullSample.arg1,
        thisKind: 'undefined',
      },
    ],
  });

  const perKeyRows = [];
  for (const key of ['REQ', 'RES', 'FLAG', 'UPLOAD', 'PREID']) {
    if (alt.rkPreview?.[key]?.value === undefined) continue;
    note(`run RK single-key mutation: ${key}`);
    const replay = await runLiteProbe({
      rkMutationExperimentInputs: [{ path: [key], value: alt.rkPreview[key].value }],
      rsExperimentInputs: [
        {
          label: `base-null-with-mutated-FEILIN_RK.${key}`,
          arg0: baseNullSample.arg0,
          arg1: baseNullSample.arg1,
          thisKind: 'undefined',
        },
      ],
    });
    const row = Array.isArray(replay.rsExperiment) ? replay.rsExperiment[0] || null : null;
    perKeyRows.push({
      key,
      mutationApplied: replay.rkMutationApplied || null,
      rsResult: buildRowSummary(row, `base-null-with-mutated-FEILIN_RK.${key}`),
      feilinRkSnapshotAfterMutation: replay.feilinRkSnapshotAfterMutation || null,
    });
    forceGc();
  }

  const wholeRow = Array.isArray(wholeReplay.rsExperiment) ? wholeReplay.rsExperiment[0] || null : null;
  console.log(JSON.stringify({
    baseNull: {
      arg0: baseNullSample.arg0,
      arg1Length: baseNullSample.arg1Length,
      arg1Head: baseNullSample.arg1.slice(0, 280),
    },
    wholeMutationCount: wholeObjectMutations.length,
    wholeMutationPaths: wholeObjectMutations.map((x) => x.path.join('.')),
    wholeMutationApplied: wholeReplay.rkMutationApplied || null,
    wholeRsResult: buildRowSummary(wholeRow, 'base-null-with-mutated-FEILIN_RK'),
    wholeRkSnapshotAfterMutation: wholeReplay.feilinRkSnapshotAfterMutation || null,
    perKeyRows,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
