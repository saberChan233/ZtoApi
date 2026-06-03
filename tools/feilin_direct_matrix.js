#!/usr/bin/env node
const fs = require('fs');
const { computeLocalTokenFromSessionBlob } = require('./feilin_local_second');

async function main() {
  const input = process.argv[2] || '/tmp/session_exp.json';
  const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
  const exp = raw.sessionIdBlobExperiment;
  const rows = [];
  const candidates = [
    ['baseline', exp?.baseline],
    ...((exp?.rows || []).map((row) => [row?.label || 'row', row])),
  ];
  for (const [label, row] of candidates) {
    const sessionIdBase64 = row?.n0PartLogs?.find((entry) => entry?.name === 'tA')?.CPreview ||
      row?.sessionIdBase64Preview ||
      null;
    const expected = row?.parsed?.raw || null;
    if (!sessionIdBase64) {
      rows.push({ label, ok: false, error: 'missing sessionIdBase64' });
      continue;
    }
    try {
      const result = await computeLocalTokenFromSessionBlob(sessionIdBase64);
      rows.push({
        label,
        ok: result?.local?.verify?.ok === true,
        expected,
        actual: result?.local?.full || null,
        second: result?.local?.second || null,
        matchExpected: expected ? expected === result?.local?.full : null,
      });
    } catch (err) {
      rows.push({ label, ok: false, error: String(err && err.stack || err) });
    }
  }
  console.log(JSON.stringify({
    input,
    rows,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exit(1);
  });
}
