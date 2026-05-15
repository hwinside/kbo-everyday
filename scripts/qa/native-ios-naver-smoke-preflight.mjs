#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const CHECK = "✅";
const FAIL = "❌";
const WARN = "⚠️";

let failures = 0;
let warnings = 0;

function read(relPath) {
  const abs = resolve(ROOT, relPath);
  if (!existsSync(abs)) {
    failures += 1;
    console.log(`${FAIL} missing ${relPath}`);
    return "";
  }
  return readFileSync(abs, "utf8");
}

function pass(message) {
  console.log(`${CHECK} ${message}`);
}

function warn(message) {
  warnings += 1;
  console.log(`${WARN} ${message}`);
}

function fail(message) {
  failures += 1;
  console.log(`${FAIL} ${message}`);
}

function expectIncludes(label, content, needle) {
  if (content.includes(needle)) pass(`${label}: ${needle}`);
  else fail(`${label}: missing ${needle}`);
}

function expectMatch(label, content, pattern) {
  if (pattern.test(content)) pass(label);
  else fail(`${label}: no match for ${pattern}`);
}

function runCapDoctor() {
  console.log("\n== Capacitor doctor ==");
  const localCapBin = resolve(ROOT, "node_modules/.bin/cap");
  if (!existsSync(localCapBin)) {
    warn("node_modules/.bin/cap 없음 — npm install 후 npx cap doctor ios를 별도로 실행하세요");
    return;
  }

  try {
    const output = execFileSync(localCapBin, ["doctor", "ios"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    process.stdout.write(output);
    if (output.includes("[error]")) fail("Capacitor doctor ios reported an error");
    else pass("Capacitor doctor ios completed without errors");
  } catch (error) {
    fail(`Capacitor doctor ios failed: ${error.message}`);
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
  }
}

async function checkUrl(label, url, validate) {
  try {
    const res = await fetch(url, { redirect: "manual" });
    const body = await res.text();
    if (res.status !== 200) {
      fail(`${label}: HTTP ${res.status} from ${url}`);
      return;
    }
    const validation = validate(body, res);
    if (validation === true) pass(`${label}: 200 and content valid`);
    else fail(`${label}: ${validation}`);
  } catch (error) {
    fail(`${label}: ${error.message}`);
  }
}

console.log("크보팬 iOS 네이버 실기기 smoke preflight");
console.log("목표: 네이버 로그인 → native 앱 복귀 → 세션 유지 smoke 전에 브랜치/설정 상태를 빠르게 점검합니다.");

console.log("\n== Git branch ==");
try {
  const branch = execFileSync("git", ["branch", "--show-current"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  if (branch === "main") warn("현재 main입니다. 변경 작업은 새 브랜치에서 진행하세요.");
  else pass(`current branch: ${branch || "detached HEAD"}`);
} catch (error) {
  warn(`git branch 확인 실패: ${error.message}`);
}

console.log("\n== Native app config ==");
const capacitorConfig = read("capacitor.config.ts");
expectIncludes("Capacitor appId", capacitorConfig, 'appId: "fan.keubo.app"');
expectIncludes("Capacitor server URL", capacitorConfig, 'url: "https://keubo.fan"');

const pbxproj = read("ios/App/App.xcodeproj/project.pbxproj");
expectIncludes("iOS team", pbxproj, "DEVELOPMENT_TEAM = HRSVQZ27F9");
expectIncludes("iOS bundle id", pbxproj, "PRODUCT_BUNDLE_IDENTIFIER = fan.keubo.app");

const entitlements = read("ios/App/App/App.entitlements");
expectIncludes("iOS associated domains", entitlements, "applinks:keubo.fan");

const infoPlist = read("ios/App/App/Info.plist");
expectIncludes("iOS custom URL scheme", infoPlist, "fan.keubo.app");

const androidGradle = read("android/app/build.gradle");
expectIncludes("Android applicationId", androidGradle, 'applicationId "fan.keubo.app"');

const androidManifest = read("android/app/src/main/AndroidManifest.xml");
expectIncludes("Android app link host", androidManifest, 'android:host="keubo.fan"');
expectMatch("Android app link autoVerify", androidManifest, /android:autoVerify="true"/);

console.log("\n== OAuth/native callback code ==");
const supabaseAuth = read("src/lib/supabase/auth.ts");
expectIncludes("Native iOS callback URL", supabaseAuth, 'fan.keubo.app://auth/callback');
expectIncludes("Naver native start URL", supabaseAuth, 'https://keubo.fan/api/auth/naver?native=ios');

const capacitorAuth = read("src/lib/capacitor/auth.ts");
expectIncludes("Capacitor appUrlOpen listener", capacitorAuth, 'App.addListener("appUrlOpen"');
expectIncludes("Custom scheme handling", capacitorAuth, 'url.startsWith("fan.keubo.app://")');
expectIncludes("Native session recovery", capacitorAuth, "supabase.auth.setSession");

const naverStart = read("src/app/api/auth/naver/route.ts");
expectIncludes("Naver native callback flag", naverStart, "native=ios");
expectIncludes("Naver native cookie", naverStart, "naver_native_ios");

const naverCallback = read("src/app/api/auth/naver/callback/route.ts");
expectIncludes("Naver callback custom scheme", naverCallback, 'fan.keubo.app://auth/callback');
expectIncludes("Naver callback token handoff", naverCallback, "access_token");
expectIncludes("Naver callback refresh token handoff", naverCallback, "refresh_token");

runCapDoctor();

if (!process.argv.includes("--skip-network")) {
  console.log("\n== Production link files ==");
  await checkUrl(
    "Apple AASA",
    "https://keubo.fan/.well-known/apple-app-site-association",
    (body) => body.includes("HRSVQZ27F9.fan.keubo.app") || "missing HRSVQZ27F9.fan.keubo.app",
  );
  await checkUrl(
    "Android assetlinks",
    "https://keubo.fan/.well-known/assetlinks.json",
    (body) => body.includes('"package_name":"fan.keubo.app"')
      || body.includes('"package_name": "fan.keubo.app"')
      || "missing fan.keubo.app package_name",
  );
} else {
  warn("network checks skipped (--skip-network)");
}

console.log("\n== Manual iOS Naver smoke steps ==");
console.log(`1. git pull && npm install 필요 시 실행 && npm run qa:native-ios-naver-smoke-preflight
2. npx cap sync ios
3. open ios/App/App.xcodeproj
4. Xcode Signing: Team HRSVQZ27F9 / Bundle fan.keubo.app 확인
5. iPhone 실기기 선택 후 Run
6. 앱 로그아웃 상태 → 로그인 시트 → 네이버로 계속하기
7. 네이버 로그인 완료 후 fan.keubo.app 앱으로 자동 복귀 확인
8. 로그인 시트 닫힘 + 홈/MY 로그인 상태 확인
9. 앱 kill 후 재실행해도 세션 유지 확인`);

console.log("\n== Result ==");
if (failures > 0) {
  console.log(`${FAIL} preflight failed: ${failures} failure(s), ${warnings} warning(s)`);
  process.exit(1);
}
if (warnings > 0) {
  console.log(`${WARN} preflight passed with ${warnings} warning(s)`);
} else {
  console.log(`${CHECK} preflight passed`);
}
