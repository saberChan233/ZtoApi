#!/usr/bin/env node
const fs = require('fs');
const vm = require('vm');
const { patchAliyunCaptchaSource } = require('./probe_feilin_runtime');

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function summarizeFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const patched = patchAliyunCaptchaSource(source, {});
  const has = (needle) => patched.includes(needle);
  let parseOk = true;
  let parseError = null;
  try {
    new vm.Script(patched, { filename: file });
  } catch (error) {
    parseOk = false;
    parseError = String(error && error.message || error);
  }
  return {
    file,
    changed: patched !== source,
    parseOk,
    parseError,
    markers: {
      feilinUbWrapV2: has('FEILIN_UB_WRAP_V2'),
      feilinUyWrapV2: has('FEILIN_UY_WRAP_V2'),
      feilinSessionDeriveV2: has('FEILIN_SESSION_DERIVE_V2'),
      verifyGJoin: has('VERIFY_G_JOIN'),
      preidHReal: has('PREID_H_REAL'),
      peTsReturn: has('PE_TS_RETURN'),
    },
  };
}

function main() {
  const files = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const effectiveFiles = files.length
    ? files
    : [
      getArg('--feilin52', '/tmp/feilin052.10c941753f93259c197fdd2cf3afcb03c9f7cd8cb4eb7fd21aabd5ccfdd374ff.js'),
      getArg('--feilin53', '/tmp/feilin053.669d09f9e96e88ddf8843e930fbf32da4255d218d33a619f5f1dac71c3f86baf.js'),
      getArg('--pe', '/tmp/aliyun-pe.js'),
    ].filter((file) => file && fs.existsSync(file));

  if (!effectiveFiles.length) {
    throw new Error('no bundle files found');
  }

  console.log(JSON.stringify({
    files: effectiveFiles.map(summarizeFile),
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(String(error && error.stack || error));
    process.exit(1);
  }
}
