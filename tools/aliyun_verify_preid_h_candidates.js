#!/usr/bin/env node
const zlib = require("zlib");
const crypto = require("crypto");
const { solveCaptcha } = require("./browserless_aliyun_captcha_solver");
const { pickPreidKey, collectRxConstantMap } = require("./feilin_rx_constants");

function toKeyBuffer(value) {
  if (typeof value !== "string" || !value) return null;
  if (/^[0-9a-f]{32}$/i.test(value)) return Buffer.from(value, "hex");
  if (value.length === 16) return Buffer.from(value, "utf8");
  return null;
}

function encryptAes128Cbc(plainBuffer, keyBuffer, ivBuffer) {
  const cipher = crypto.createCipheriv("aes-128-cbc", keyBuffer, ivBuffer);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
}

function buildPlainCandidates(out) {
  const rsRows = Array.isArray(out?.feilinRsLogs) ? out.feilinRsLogs : [];
  const unique = new Map();
  const pushCandidate = (text, source) => {
    if (typeof text !== "string" || !text || unique.has(text)) return;
    unique.set(text, {
      source,
      length: text.length,
      text,
    });
  };
  for (const row of rsRows) {
    pushCandidate(row?.arg1, "feilinRsLogs.arg1");
  }
  const n0Rows = Array.isArray(out?.n0PartLogs) ? out.n0PartLogs : [];
  for (const row of n0Rows) {
    pushCandidate(row?.lPreview, "n0PartLogs.lPreview");
  }
  const deviceData = out?.feilinReSnapshot?.preview?.deviceData?.value || null;
  const deviceConfig = out?.feilinReSnapshot?.preview?.deviceConfig?.value || null;
  const deviceConfigRaw = out?.feilinReSnapshot?.preview?.DeviceConfig?.value || null;
  const sessionIdBlob = out?.feilinReSnapshot?.preview?.sessionId?.value || null;
  const secretKeyBlob = out?.feilinReSnapshot?.preview?.secretKey?.value || null;
  const maybeJson = [
    [deviceData, "feilinReSnapshot.deviceData.json"],
    [deviceConfig, "feilinReSnapshot.deviceConfig.json"],
  ];
  for (const [value, source] of maybeJson) {
    if (value && typeof value === "object") {
      try {
        pushCandidate(JSON.stringify(value), source);
      } catch {
        // ignore
      }
    }
  }
  pushCandidate(deviceConfigRaw, "feilinReSnapshot.DeviceConfig.raw");
  pushCandidate(sessionIdBlob, "feilinReSnapshot.sessionId.base64");
  pushCandidate(secretKeyBlob, "feilinReSnapshot.secretKey.base64");
  return Array.from(unique.values()).sort((a, b) => b.length - a.length);
}

function buildCompressionCandidates(text) {
  const buf = Buffer.from(text, "utf8");
  return [
    { name: "none", buffer: buf },
    { name: "deflate", buffer: zlib.deflateSync(buf) },
    { name: "deflateRaw", buffer: zlib.deflateRawSync(buf) },
    { name: "gzip", buffer: zlib.gzipSync(buf) },
  ];
}

async function main() {
  const out = await solveCaptcha({
    files: ["/tmp/feilin.js", "/tmp/aliyun-pe.js", "/tmp/AliyunCaptcha.js"],
    loaderPath: "/tmp/AliyunCaptcha.js",
  });

  const joinLog = (out.verifyGCallsiteLogs || []).find((item) => item?.stage === "join") || null;
  const targetH = typeof joinLog?.namedParts?.H === "string" ? joinLog.namedParts.H : null;
  if (!targetH) {
    throw new Error("missing PREID third-segment H");
  }

  const targetBuffer = Buffer.from(targetH, "base64");
  const preidKey = pickPreidKey(out);
  const keyCandidates = [
    ["PREID_KEY", preidKey],
    ["APP_KEY", out?.feilinReSnapshot?.preview?.appKey?.value || null],
    ["ACCESS_SEC", "FqJB6iRNVYdEGpwb"],
    ["DEVICE_CONFIG_KEY", "87f879f135f27da7"],
    ["LOG1_DATA_KEY", "45f8ac1e1de14397"],
  ]
    .map(([name, value]) => ({ name, value, keyBuffer: toKeyBuffer(value) }))
    .filter((item) => item.keyBuffer);

  const ivCandidates = [
    { name: "ASCII_0123456789ABCDEF", buffer: Buffer.from("0123456789ABCDEF", "utf8") },
    {
      name: "ALIYUN_LOCAL_REVERSE_IV_UTF8",
      buffer: Buffer.from(Buffer.from("d35db7e39ebbf3d001083105", "hex").toString("base64"), "utf8"),
    },
  ];

  const attempts = [];
  for (const plain of buildPlainCandidates(out).slice(0, 12)) {
    for (const compressed of buildCompressionCandidates(plain.text)) {
      for (const key of keyCandidates) {
        for (const iv of ivCandidates) {
          let encrypted = null;
          try {
            encrypted = encryptAes128Cbc(compressed.buffer, key.keyBuffer, iv.buffer);
          } catch {
            continue;
          }
          const sameLen = encrypted.length === targetBuffer.length;
          const sharedPrefixBytes = (() => {
            let n = 0;
            while (n < encrypted.length && n < targetBuffer.length && encrypted[n] === targetBuffer[n]) n += 1;
            return n;
          })();
          attempts.push({
            plainSource: plain.source,
            plainLength: plain.length,
            compression: compressed.name,
            compressedBytes: compressed.buffer.length,
            keyName: key.name,
            ivName: iv.name,
            encryptedBytes: encrypted.length,
            sameLen,
            sharedPrefixBytes,
            encryptedHeadHex: encrypted.subarray(0, 24).toString("hex"),
          });
        }
      }
    }
  }

  attempts.sort((a, b) => {
    if (Number(b.sameLen) !== Number(a.sameLen)) return Number(b.sameLen) - Number(a.sameLen);
    if (b.sharedPrefixBytes !== a.sharedPrefixBytes) return b.sharedPrefixBytes - a.sharedPrefixBytes;
    return Math.abs(a.encryptedBytes - targetBuffer.length) - Math.abs(b.encryptedBytes - targetBuffer.length);
  });

  console.log(JSON.stringify({
    targetH: {
      length: targetH.length,
      decodedBytes: targetBuffer.length,
      head: targetH.slice(0, 160),
      tail: targetH.slice(-160),
    },
    rxConstants: collectRxConstantMap(out),
    topPlainCandidates: buildPlainCandidates(out).slice(0, 8).map((item) => ({
      source: item.source,
      length: item.length,
      head: item.text.slice(0, 220),
    })),
    bestAttempts: attempts.slice(0, 20),
  }, null, 2));
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
