#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

async function main() {
  const out = await solveCaptcha({
    files: ['/tmp/feilin.js', '/tmp/aliyun-pe.js', '/tmp/AliyunCaptcha.js'],
    loaderPath: '/tmp/AliyunCaptcha.js',
    rsAidReplayExperiment: true,
  });
  console.log(JSON.stringify(out.rsAidReplayExperiment || null, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
