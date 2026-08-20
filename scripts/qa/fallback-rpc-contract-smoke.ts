/**
 * app ↔ DB RPC 시그니처 종단 계약 게이트.
 *
 * Why (2026-08-20 삼순 2차 blocker 1 — 이 게이트가 없어서 생긴 사고)
 * ------------------------------------------------------------------
 * `trackApiDegradation()` 이 `claim_api_fallback_alert(... p_scope)` 9-인자로 호출하는데
 * EXPAND migration 에는 8-인자 wrapper 만 있었다. 즉 **하루 13.8만건이 흐르는 P0 경로가
 * 쓰기 감소가 아니라 RPC 전량 실패**였다.
 *
 * 더 나쁜 건 DB 통합 테스트 70개가 이걸 못 잡았다는 점이다. 테스트가 프로덕션 호출부를
 * 태우지 않고 자기가 직접 8-인자로 호출했기 때문이다 — **테스트를 프로덕션에 맞춘 게 아니라
 * 통과하도록 맞춘** 셈이고, 그래서 "70 passed" 가 아무것도 증명하지 못했다.
 *
 * 이 게이트가 고정하는 것
 * ----------------------
 *  1. 프로덕션 소스가 실제로 호출하는 RPC 이름과 인자 키를 **소스에서 추출**한다(하드코딩 금지).
 *  2. 그 이름·인자가 migration 이 정의한 함수 시그니처와 **정확히 일치**하는지 대조한다.
 *  3. 프로덕션이 보내는 delta 필드가 migration 이 읽는 jsonb 키를 모두 덮는지 확인한다.
 *
 * 실행: npx tsx scripts/qa/fallback-rpc-contract-smoke.ts  (npm run qa:fallback-rpc-contract)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let fail = 0;
function ok(name: string, cond: boolean) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) fail++;
}

const TRACKER = readFileSync(resolve("src/lib/monitoring/api-fallback-tracker.ts"), "utf8");
const MIGRATION_BUCKET = readFileSync(
  resolve("supabase/migrations/20260820000000_api_fallback_events_bucket.sql"),
  "utf8",
);
const MIGRATION_CLAIM = readFileSync(
  resolve("supabase/migrations/20260729_api_fallback_alert_claim.sql"),
  "utf8",
);
const ALL_SQL = `${MIGRATION_CLAIM}\n${MIGRATION_BUCKET}`;

/** 주석을 공백으로 치환(오프셋 보존) — 주석 안 문구가 매칭을 만족시키는 false-green 방지. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length))
    .replace(/--[^\n]*/g, (m) => " ".repeat(m.length));
}

const TRACKER_CODE = blankComments(TRACKER);
const SQL_CODE = blankComments(ALL_SQL);

// ── 1) 프로덕션이 호출하는 RPC 이름·인자를 소스에서 추출 ────────────────────
/** `supabase.rpc("name", { k1: ..., k2: ... })` 호출을 전부 파싱한다. */
function extractRpcCalls(src: string): Array<{ name: string; args: string[] }> {
  const calls: Array<{ name: string; args: string[] }> = [];
  const re = /\.rpc\(\s*"([a-z_0-9]+)"\s*,\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    // 괄호 매칭으로 인자 객체 범위를 구한다(정규식 한 방으로는 중첩을 못 읽는다).
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = src.slice(start + 1, i);
    // 최상위 키만 — 중첩 객체 내부 키는 세지 않는다.
    const args: string[] = [];
    let d = 0;
    for (const line of body.split("\n")) {
      const opens = (line.match(/[{[]/g) ?? []).length;
      const closes = (line.match(/[}\]]/g) ?? []).length;
      if (d === 0) {
        const km = line.match(/^\s*([a-z_0-9]+)\s*:/);
        if (km) args.push(km[1]);
      }
      d += opens - closes;
    }
    calls.push({ name, args });
  }
  return calls;
}

const rpcCalls = extractRpcCalls(TRACKER_CODE);
ok(`tracker 에서 RPC 호출을 추출했다 (${rpcCalls.length}건)`, rpcCalls.length > 0);

// ── 2) migration 이 정의한 함수 시그니처 추출 ──────────────────────────────
function extractFunctionParams(sql: string, fnName: string): string[][] {
  const sigs: string[][] = [];
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${fnName}\\s*\\(([^)]*)\\)`,
    "gi",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const params = m[1]
      .split(",")
      .map((p) => p.trim().split(/\s+/)[0])
      .filter((p) => p.length > 0);
    sigs.push(params);
  }
  return sigs;
}

// ── 3) 핵심 대조: 호출하는 모든 RPC 가 DB 에 존재하고 인자가 일치하는가 ────
for (const call of rpcCalls) {
  const sigs = extractFunctionParams(SQL_CODE, call.name);
  ok(`[${call.name}] migration 에 정의가 존재`, sigs.length > 0);
  if (sigs.length === 0) continue;

  // 호출 인자 집합이 어떤 시그니처와도 일치하지 않으면 런타임에 "function does not exist" 다.
  const callArgs = [...call.args].sort();
  const matched = sigs.some((sig) => {
    const sigArgs = [...sig].sort();
    return sigArgs.length === callArgs.length && sigArgs.every((a, i) => a === callArgs[i]);
  });
  ok(
    `[${call.name}] 호출 인자 ${call.args.length}개가 DB 시그니처와 일치` +
      (matched ? "" : ` — 호출:[${callArgs.join(",")}] vs DB:[${sigs.map((s) => s.length).join("|")}개]`),
    matched,
  );
}

// ── 4) 삼순 blocker 1 재발 방지: P0 경로가 batch flush 를 탄다 ─────────────
{
  // trackApiDegradation 본문을 잘라 그 안에서 무엇을 부르는지 본다.
  const startIdx = TRACKER_CODE.indexOf("export async function trackApiDegradation");
  ok("trackApiDegradation 이 존재한다", startIdx >= 0);
  const endIdx = TRACKER_CODE.indexOf("\nexport ", startIdx + 10);
  const body = TRACKER_CODE.slice(startIdx, endIdx > 0 ? endIdx : undefined);

  ok(
    "P0 경로가 버퍼를 탄다(observeFallback 호출)",
    /observeFallback\s*\(/.test(body),
  );
  ok(
    "P0 경로가 batch flush 를 쓴다",
    /flushFallbackDeltas\s*\(/.test(body),
  );
  // 종전 결함: 이벤트마다 claim RPC 직접 호출.
  ok(
    "P0 경로가 claim RPC 를 직접 호출하지 않는다(1건/1RPC 회귀 차단)",
    !/\.rpc\(\s*"claim_api_fallback_alert"/.test(body),
  );
  ok("P0 경로가 claim:true 로 표시한다", /claim:\s*true/.test(body));
}

// ── 5) legacy 경로는 record-only (삼순 blocker 3) ──────────────────────────
{
  const startIdx = TRACKER_CODE.indexOf("async function saveToSupabase");
  ok("saveToSupabase 가 존재한다", startIdx >= 0);
  const endIdx = TRACKER_CODE.indexOf("\n/**", startIdx + 10);
  const body = TRACKER_CODE.slice(startIdx, endIdx > 0 ? endIdx : startIdx + 2000);
  ok(
    "legacy 경로는 claim:false (서버 outbox 를 만들지 않는다)",
    /claim:\s*false/.test(body),
  );
}

// ── 6) delta 필드가 migration 이 읽는 jsonb 키를 모두 덮는가 ───────────────
{
  // migration 이 e->>'key' 로 읽는 키 전부
  const readKeys = new Set<string>();
  const re = /e->>'([a-z_0-9]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blankComments(MIGRATION_BUCKET))) !== null) readKeys.add(m[1]);
  ok(`migration 이 읽는 delta 키를 추출했다 (${readKeys.size}개)`, readKeys.size > 0);

  // 프로덕션이 보내는 필드 = FALLBACK_RPC_CONTRACT.deltaFields
  const contractIdx = TRACKER_CODE.indexOf("FALLBACK_RPC_CONTRACT");
  ok("FALLBACK_RPC_CONTRACT 가 노출돼 있다", contractIdx >= 0);
  const contractBody = TRACKER_CODE.slice(contractIdx, contractIdx + 1200);
  const sentFields = new Set(
    [...contractBody.matchAll(/"([a-z_0-9]+)"/g)].map((x) => x[1]),
  );

  const missing = [...readKeys].filter((k) => !sentFields.has(k));
  ok(
    `migration 이 읽는 모든 키를 프로덕션이 보낸다${missing.length ? ` — 누락:[${missing.join(",")}]` : ""}`,
    missing.length === 0,
  );
}

// ── 7) 자가 검증: 이 게이트가 실제로 불일치를 잡을 수 있는가 ───────────────
{
  // 존재하지 않는 함수를 부르는 가짜 소스로 추출기·대조기를 태운다.
  const fakeSrc = `await supabase.rpc("nonexistent_fn_xyz", { p_a: 1, p_b: 2 });`;
  const calls = extractRpcCalls(fakeSrc);
  ok("추출기가 가짜 호출을 인식", calls.length === 1 && calls[0].name === "nonexistent_fn_xyz");
  ok("존재하지 않는 함수는 시그니처 0개로 판정", extractFunctionParams(SQL_CODE, "nonexistent_fn_xyz").length === 0);

  // 인자 개수 불일치를 잡는지 — 실제 사고 재현(9-인자 호출 vs 8-인자 정의)
  const sigs = extractFunctionParams(SQL_CODE, "claim_api_fallback_alert");
  const nineArgs = [
    "p_api_name", "p_reason", "p_status_code", "p_error_message",
    "p_window_minutes", "p_threshold", "p_cooldown_minutes", "p_lease_seconds", "p_scope",
  ].sort();
  const wouldMatch = sigs.some(
    (sig) => sig.length === nineArgs.length && [...sig].sort().every((a, i) => a === nineArgs[i]),
  );
  ok("실제 사고(9-인자 호출)를 불일치로 잡는다", !wouldMatch);
}

console.log(`\nfallback rpc contract: ${fail === 0 ? "PASS" : `${fail} FAILED`}`);
if (fail > 0) process.exit(1);
