#!/usr/bin/env node
const { runProbe } = require('./probe_feilin_runtime');

async function main() {
  const files = ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'];
  const report = await runProbe(files, {
    tyExperimentInputs: [
      { arg0: 'FqJB6iRNVYdEGpwb', arg1: '7JLsB18MnA7GX3d6LxErT1sGT68xcVuOAoxz0b7vVzY=' },
      { arg0: 'FqJB6iRNVYdEGpwb', arg1: 'n9jH0yACW8YrgOBcM0v7u45+/bfozcSz8ZpvzGBXg3E=' },
      { arg0: 'FqJB6iRNVYdEGpwb', arg1: 'NLAoqT6K03oLbQXW2VS3zA==' },
      {
        arg0: 'FqJB6iRNVYdEGpwb',
        arg1: '7165d874c83e120bb253ea034ec1f501{"TrackList":{"mc":"","tc":"","mu":"","te":"","mp":"","tmv":"","ks":"","fi":"","startTime":1779398289336},"TrackStartTime":1779398289336,"VerifyTime":1779398289371,"arg":"DiH0/m6ALKVkG0hImg9hGpRBcnVWQ0Y/fw=="}',
      },
    ],
  });
  console.log(JSON.stringify({
    tyExperiment: report.tyExperiment || null,
    peTyLogs: report.peTyLogs || [],
    peTyReturns: report.peTyReturns || [],
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
