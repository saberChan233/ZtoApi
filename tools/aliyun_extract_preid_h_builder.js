#!/usr/bin/env node
const fs = require('fs');

function main() {
  const file = process.argv[2] || '/tmp/aliyun-pe.js';
  const source = fs.readFileSync(file, 'utf8');
  const startNeedle = 'V=ty(tx[x.G(n4,"EC")],tx[tm(92..valueOf(),70..valueOf())]),c=285';
  const hNeedle = 'H=function(t,n){';
  const endNeedle = '}(nU,tT),c^=276';
  const start = source.indexOf(startNeedle);
  const hStart = source.indexOf(hNeedle, start >= 0 ? start : 0);
  const end = source.indexOf(endNeedle, hStart >= 0 ? hStart : 0);
  if (hStart < 0 || end < 0) {
    throw new Error('failed to locate PREID.H builder snippet');
  }
  const snippet = source.slice(Math.max(0, start), end + endNeedle.length);
  console.log(JSON.stringify({
    file,
    start,
    hStart,
    end,
    snippet,
    conclusion: {
      wrapperCallsTs74: snippet.includes('this,74'),
      hasStaticVSeedStage: snippet.includes(startNeedle),
      note: 'raw bundle shows PREID.H assigned by a wrapper that dispatches into ts(...,74) with (nU,tT)',
    },
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
