#!/usr/bin/env node

const RX_OUTPUT_LABELS = {
  "45f8ac1e1de14397": "LOG1_DATA_KEY",
  "87f879f135f27da7": "DEVICE_CONFIG_KEY",
  "a549a55c60a39aa0": "UPLOAD_KEY",
  "75ae5c150d235802": "PREID_KEY",
  "c175a358550d02e2": "FLAG_KEY",
  "daye,raolewoba!": "INIT_TOKEN_SALT",
  "8449449787": "APP_VERSION_NUMERIC",
  ...(process.env.ALIYUN_CAPTCHA_ACCESS_KEY_ID
    ? { [process.env.ALIYUN_CAPTCHA_ACCESS_KEY_ID]: "ACCESS_KEY_ID" }
    : {}),
  ...(process.env.ALIYUN_CAPTCHA_ACCESS_KEY_SECRET
    ? { [process.env.ALIYUN_CAPTCHA_ACCESS_KEY_SECRET]: "ACCESS_KEY_SECRET" }
    : {}),
};

function collectRxConstantMap(solverOutput) {
  const rows = Array.isArray(solverOutput?.feilinRxLogs) ? solverOutput.feilinRxLogs : [];
  const grouped = new Map();
  for (const row of rows) {
    const output = typeof row?.output === "string" ? row.output : null;
    const arg1 = typeof row?.arg1 === "string" ? row.arg1 : null;
    if (!output || !arg1) continue;
    if (!grouped.has(output)) grouped.set(output, new Set());
    grouped.get(output).add(arg1);
  }
  const result = {};
  for (const [output, arg1Set] of grouped.entries()) {
    const label = RX_OUTPUT_LABELS[output] || null;
    result[output] = {
      label,
      arg1Samples: Array.from(arg1Set).slice(0, 6),
    };
  }
  return result;
}

function pickPreidKey(solverOutput) {
  const rows = Array.isArray(solverOutput?.feilinRxLogs) ? solverOutput.feilinRxLogs : [];
  const row = rows.find((item) => item?.output === "75ae5c150d235802");
  return row?.output || null;
}

module.exports = {
  RX_OUTPUT_LABELS,
  collectRxConstantMap,
  pickPreidKey,
};

if (require.main === module) {
  const fs = require("fs");
  const raw = fs.readFileSync(0, "utf8");
  const json = JSON.parse(raw);
  console.log(JSON.stringify(collectRxConstantMap(json), null, 2));
}
