/**
 * Apple Client Secret JWT 생성 스크립트
 *
 * 사용법:
 *   node scripts/generate-apple-secret.mjs \
 *     --key-file ./AuthKey_XXXXXXXXXX.p8 \
 *     --key-id YOUR_KEY_ID \
 *     --team-id HRSVQZ27F9 \
 *     --service-id fan.keubo.app.web
 */

import { readFileSync } from "fs";
import { createPrivateKey, createSign } from "crypto";

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, "").replace(/-/g, "_");
    parsed[key] = args[i + 1];
  }
  return parsed;
}

function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

const args = parseArgs();

const keyFile = args.key_file;
const keyId = args.key_id;
const teamId = args.team_id || "HRSVQZ27F9";
const serviceId = args.service_id || "fan.keubo.app.web";

if (!keyFile || !keyId) {
  console.error("Usage: node scripts/generate-apple-secret.mjs --key-file <path> --key-id <id> [--team-id <id>] [--service-id <id>]");
  process.exit(1);
}

const privateKeyPem = readFileSync(keyFile, "utf8");

const now = Math.floor(Date.now() / 1000);
const exp = now + 15777000; // ~6 months

const header = { alg: "ES256", kid: keyId };
const payload = {
  iss: teamId,
  iat: now,
  exp,
  aud: "https://appleid.apple.com",
  sub: serviceId,
};

const headerB64 = base64url(JSON.stringify(header));
const payloadB64 = base64url(JSON.stringify(payload));
const signingInput = `${headerB64}.${payloadB64}`;

const key = createPrivateKey(privateKeyPem);
const sign = createSign("SHA256");
sign.update(signingInput);
const sig = sign.sign({ key, dsaEncoding: "ieee-p1363" });

const jwt = `${signingInput}.${base64url(sig)}`;

console.log("\n=== Apple Client Secret JWT ===\n");
console.log(jwt);
console.log("\n이 값을 Supabase Dashboard > Authentication > Providers > Apple > Secret Key에 붙여넣으세요.");
console.log(`유효기간: ~6개월 (${new Date(exp * 1000).toISOString().slice(0, 10)}까지)\n`);
