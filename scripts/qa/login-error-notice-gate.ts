/**
 * login-error-notice-gate — 네이버 로그인 실패 유저 안내(#1304) 회귀 게이트.
 *
 * 계약 (삼순 NO-GO 3건 반영):
 *  1. callback route가 실제 발급하는 login_error 코드 전수가 폐쇄집합(NAVER_LOGIN_ERROR_CODES)에
 *     포함된다 — 소스에서 리터럴·union 타입을 기계 추출해 대조(user_lookup_error 누락류 재발 방지).
 *  2. 전체 known 코드 + naver_unexpected에 메시지·진단코드가 존재한다.
 *  3. unknown login_error → naver_unexpected로 접히고 raw 값은 메시지에 비노출.
 *  4. access_denied(유저 자진 취소) → 안내 미표시(null).
 *  5. native 분류: classifyAppUrlOpen이 login_error URL을 oauth로 분류한다(공유 상수 결속).
 *  6. stripAuthErrorNoticeParams가 auth_error/login_error만 제거하고 무관 파라미터를 보존한다.
 *  7. buildLoginSupportMailto가 지원 메일 + 진단코드 결속 subject를 만든다.
 *  8. AuthErrorNotice 컴포넌트가 위 헬퍼를 실제로 import·호출한다(주석 blank 후 구조 판정).
 *
 * selftest: 결함 주입 mutant(코드 누락 소스/메시지 맵 결손 등)를 순수 판정 함수에 투입해
 * 게이트 검출력을 먼저 증명한다.
 * 실행: npm run qa:login-error-notice [-- --selftest]
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  AUTH_ERROR_DIAG_CODES,
  AUTH_ERROR_MESSAGES,
  AUTH_ERROR_PARAM_KEYS,
  AUTH_SUPPORT_EMAIL,
  KAKAO_EMAIL_UNVERIFIED_CODE,
  NAVER_LOGIN_ERROR_CODES,
  NAVER_LOGIN_ERROR_PARAM,
  NAVER_UNKNOWN_LOGIN_ERROR_CODE,
  buildLoginSupportMailto,
  getUserFacingAuthError,
  getUserFacingAuthErrorFromUrl,
  stripAuthErrorNoticeParams,
} from "../../src/lib/auth-error";
import { classifyAppUrlOpen } from "../../src/lib/capacitor/app-url-open";

const ROOT = path.resolve(__dirname, "../..");
const CALLBACK_PATH = path.join(ROOT, "src/app/api/auth/naver/callback/route.ts");
const NOTICE_PATH = path.join(ROOT, "src/components/auth/AuthErrorNotice.tsx");

let failures = 0;
let checks = 0;
function assert(id: string, cond: boolean, detail = "") {
  checks++;
  if (cond) {
    console.log(`  ✅ ${id}`);
  } else {
    failures++;
    console.log(`  FAILCHECK ${id} ${detail}`);
  }
}

/** 주석을 blank 처리(오프셋 보존) — 주석 문면이 구조 판정을 만족시키는 false-green 방지. */
export function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

/** callback 소스에서 발급되는 login_error 코드를 기계 추출(리터럴 + errorCode union). */
export function extractCallbackLoginErrorCodes(source: string): string[] {
  const src = blankComments(source);
  const codes = new Set<string>();
  for (const m of src.matchAll(/login_error=([a-z_]+)/g)) codes.add(m[1]);
  // `errorCode: "a" | "b"` union 리터럴 — 동적 `${userResolution.errorCode}` 경로의 실제 값 집합
  for (const m of src.matchAll(/errorCode:\s*((?:"[a-z_]+"\s*\|?\s*)+)/g)) {
    for (const lit of m[1].matchAll(/"([a-z_]+)"/g)) codes.add(lit[1]);
  }
  return [...codes];
}

/** 폐쇄집합 커버리지 판정 — 소스 발급 코드 ⊆ 폐쇄집합. */
export function findUncoveredCodes(
  emitted: string[],
  closedSet: readonly string[],
): string[] {
  return emitted.filter((c) => !closedSet.includes(c));
}

type StripFn = (url: URL) => boolean;

/**
 * strip 헬퍼 행위 계약을 통째로 판정하는 순수 평가기 — main과 selftest가 같은 함수를 태운다.
 * 반환: 위반 목록(비어있으면 계약 충족).
 */
export function evaluateStripContract(strip: StripFn): string[] {
  const violations: string[] = [];
  const url = new URL("https://keubo.fan/?login_error=state_mismatch&auth_error=kakao_email_unverified&tab=home");
  const removed = strip(url);
  if (!(removed === true && !url.searchParams.has("login_error") && !url.searchParams.has("auth_error"))) {
    violations.push("target-params-not-removed");
  }
  if (url.searchParams.get("tab") !== "home") {
    violations.push("unrelated-param-destroyed");
  }
  const clean = new URL("https://keubo.fan/?tab=home");
  if (!(strip(clean) === false && clean.searchParams.get("tab") === "home")) {
    violations.push("noop-contract-broken");
  }
  return violations;
}

function main() {
  console.log("== login-error-notice-gate ==");

  // 1. callback 발급 코드 전수 ⊆ 폐쇄집합
  const callbackSrc = readFileSync(CALLBACK_PATH, "utf-8");
  const emitted = extractCallbackLoginErrorCodes(callbackSrc);
  assert("LEGATE-01-emitted-nonempty", emitted.length >= 8, `emitted=${emitted.length}`);
  const uncovered = findUncoveredCodes(emitted, NAVER_LOGIN_ERROR_CODES);
  assert("LEGATE-02-callback-covered", uncovered.length === 0, `uncovered=${uncovered.join(",")}`);

  // 2. known 전 코드 + unknown 버킷: 메시지·진단코드 존재
  const allCodes = [...NAVER_LOGIN_ERROR_CODES, NAVER_UNKNOWN_LOGIN_ERROR_CODE];
  for (const code of allCodes) {
    assert(`LEGATE-03-message-${code}`, typeof AUTH_ERROR_MESSAGES[code] === "string" && AUTH_ERROR_MESSAGES[code].length > 0);
    assert(`LEGATE-04-diag-${code}`, typeof AUTH_ERROR_DIAG_CODES[code] === "string" && (AUTH_ERROR_DIAG_CODES[code] ?? "").startsWith("NV-"));
  }
  assert("LEGATE-05-kakao-message", AUTH_ERROR_MESSAGES[KAKAO_EMAIL_UNVERIFIED_CODE].length > 0);

  // 3. 판정: known 코드 그대로 / unknown → 버킷 + raw 비노출
  for (const code of NAVER_LOGIN_ERROR_CODES) {
    const got = getUserFacingAuthError(new URLSearchParams({ [NAVER_LOGIN_ERROR_PARAM]: code }));
    assert(`LEGATE-06-known-${code}`, got === code, `got=${got}`);
  }
  const rawUnknown = "weird_provider_thing";
  const gotUnknown = getUserFacingAuthError(new URLSearchParams({ [NAVER_LOGIN_ERROR_PARAM]: rawUnknown }));
  assert("LEGATE-07-unknown-bucket", gotUnknown === NAVER_UNKNOWN_LOGIN_ERROR_CODE, `got=${gotUnknown}`);
  assert(
    "LEGATE-08-raw-hidden",
    gotUnknown !== null && !AUTH_ERROR_MESSAGES[gotUnknown].includes(rawUnknown) && !(AUTH_ERROR_DIAG_CODES[gotUnknown] ?? "").includes(rawUnknown),
  );

  // 4. access_denied → 미표시
  const gotCancel = getUserFacingAuthError(new URLSearchParams({ [NAVER_LOGIN_ERROR_PARAM]: "access_denied" }));
  assert("LEGATE-09-cancel-null", gotCancel === null, `got=${gotCancel}`);

  // 기존 카카오 축 비회귀 (query + hash)
  assert(
    "LEGATE-10-kakao-query",
    getUserFacingAuthErrorFromUrl(new URL("https://keubo.fan/?auth_error=kakao_email_unverified")) === KAKAO_EMAIL_UNVERIFIED_CODE,
  );
  assert(
    "LEGATE-11-naver-hash",
    getUserFacingAuthErrorFromUrl(new URL("https://keubo.fan/#login_error=state_mismatch")) === "state_mismatch",
  );

  // 5. native 분류 결속
  assert("LEGATE-12-param-key", (AUTH_ERROR_PARAM_KEYS as readonly string[]).includes(NAVER_LOGIN_ERROR_PARAM));
  assert("LEGATE-13-native-classify", classifyAppUrlOpen("https://keubo.fan/?login_error=state_mismatch") === "oauth");

  // 6. URL 파라미터 제거 — 대상만 제거·무관 보존·noop (순수 평가기 경유, selftest와 동일 seam)
  const stripViolations = evaluateStripContract(stripAuthErrorNoticeParams);
  assert("LEGATE-14-strip-contract", stripViolations.length === 0, `violations=${stripViolations.join(",")}`);

  // 7. 문의 CTA — 메일 주소 + 진단코드 결속
  const mailto = buildLoginSupportMailto("NV-STATE");
  assert("LEGATE-17-mailto", mailto.startsWith(`mailto:${AUTH_SUPPORT_EMAIL}?subject=`) && mailto.includes(encodeURIComponent("NV-STATE")));

  // 8. 컴포넌트 seam — 헬퍼를 실제로 import·호출(주석 blank 후 판정)
  const noticeSrc = blankComments(readFileSync(NOTICE_PATH, "utf-8"));
  assert("LEGATE-18-notice-strip-call", /stripAuthErrorNoticeParams\s*\(/.test(noticeSrc) && noticeSrc.includes("replaceState"));
  assert("LEGATE-19-notice-mailto-call", /buildLoginSupportMailto\s*\(/.test(noticeSrc));
  assert("LEGATE-20-notice-imports", /from\s+"@\/lib\/auth-error"/.test(noticeSrc));

  console.log(`\nRESULT checks=${checks} failures=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

function selftest() {
  console.log("== login-error-notice-gate --selftest (결함 주입 검출력 증명) ==");
  let ok = 0;
  let bad = 0;
  const expect = (name: string, cond: boolean) => {
    if (cond) { ok++; console.log(`  ✅ RED-${name}`); }
    else { bad++; console.log(`  FAILCHECK selftest-${name}`); }
  };

  // mutant A: callback이 폐쇄집합 밖 코드를 발급 → LEGATE-02가 잡아야 함
  const mutantSrc = `redirect(\`\${o}?login_error=user_lookup_error\`); errorCode: "brand_new_error" | "create_user_error"`;
  const emitted = extractCallbackLoginErrorCodes(mutantSrc);
  expect("A-uncovered-detected", findUncoveredCodes(emitted, NAVER_LOGIN_ERROR_CODES).includes("brand_new_error"));

  // mutant B: 주석 속 발급 문면은 판정에 안 걸림(주석 blank 검증 — false 신호 차단)
  const commentOnly = `// login_error=fake_from_comment\n/* errorCode: "also_fake" */`;
  expect("B-comment-blanked", extractCallbackLoginErrorCodes(commentOnly).length === 0);

  // mutant C: 메시지 맵 결손 → 코드 존재 판정이 잡아야 함
  const brokenMessages: Record<string, string | undefined> = { ...AUTH_ERROR_MESSAGES };
  delete brokenMessages["user_lookup_error"];
  expect("C-missing-message-detected", !(typeof brokenMessages["user_lookup_error"] === "string"));

  // mutant D: 폐쇄집합에서 코드 제거 → known 판정이 unknown 버킷으로 밀리는 결함을 잡아야 함
  const shrunkSet = NAVER_LOGIN_ERROR_CODES.filter((c) => c !== "user_lookup_error");
  expect("D-shrunk-set-detected", findUncoveredCodes(["user_lookup_error"], shrunkSet).length === 1);

  // mutant E: 무관 파라미터까지 전부 지우는 broken helper를 실제 주입 → 평가기가 잡아야 함(삼순 지적: positive check 금지)
  const brokenStripAll: (url: URL) => boolean = (url) => {
    const had = url.searchParams.has("login_error") || url.searchParams.has("auth_error");
    for (const key of [...url.searchParams.keys()]) url.searchParams.delete(key); // 결함: 전수 삭제
    return had;
  };
  expect("E-broken-strip-detected", evaluateStripContract(brokenStripAll).includes("unrelated-param-destroyed"));

  // mutant F: 아무것도 지우지 않는 broken helper → 제거 판정이 잡아야 함
  const brokenStripNone: (url: URL) => boolean = () => false;
  expect("F-noop-strip-detected", evaluateStripContract(brokenStripNone).includes("target-params-not-removed"));

  // 양성 대조: 정상 헬퍼는 위반 0 — 평가기가 양방향으로 유효함을 증명
  expect("G-real-helper-clean", evaluateStripContract(stripAuthErrorNoticeParams).length === 0);

  console.log(`\nSELFTEST ok=${ok} bad=${bad}`);
  process.exit(bad === 0 ? 0 : 1);
}

if (process.argv.includes("--selftest")) selftest();
else main();
