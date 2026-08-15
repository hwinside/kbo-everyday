#!/usr/bin/env node
/**
 * 최애선수 인터뷰 알림 durable mutation gate.
 * 핵심 배선/SQL을 일부러 훼손한 8개 변이가 각각 계약 검증을 RED로 만드는지 증명한다.
 * smoke의 동작 검증과 함께 prebuild에 결속한다.
 */
import fs from "node:fs";

const files = {
  core: fs.readFileSync("src/lib/notifications/fav-player-interview.ts", "utf8"),
  deps: fs.readFileSync("src/lib/notifications/fav-player-interview-deps.ts", "utf8"),
  route: fs.readFileSync("src/app/api/cron/postgame-interviews/route.ts", "utf8"),
  migration: fs.readFileSync("supabase/migrations/20260814_fav_player_interview_notify.sql", "utf8"),
  migration2: fs.readFileSync("supabase/migrations/20260815191500_fav_interview_transient_retry.sql", "utf8"),
};

function violations(x) {
  const out = [];
  const due = x.route.indexOf("if (dueJobs.length === 0)");
  const dueEnd = x.route.indexOf("const [contexts, feedResults]", due);
  const recovery = x.route.indexOf("notifyFavPlayerInterviews(createInterviewDeps())", due);
  if (!(due >= 0 && recovery > due && recovery < dueEnd)) out.push("due0-recovery");
  if (!x.migration.includes("limit greatest(1, least(coalesce(p_limit, 40), 40))")
      || !x.migration.includes("for update skip locked")) out.push("bounded-atomic-lease");
  if (!x.deps.includes("claim_postgame_interview_notifications")) out.push("rpc-lease-wiring");
  if (!x.core.includes("hasSentMarker(interview.gameId, interview.videoId)")) out.push("composite-marker-read");
  if (x.deps.split("`interview#${gameId}#${videoId}`").length - 1 !== 2) {
    out.push("composite-marker-storage");
  }
  if (x.core.includes("releaseLease(releaseRowIds).catch")) out.push("release-failure-hidden");
  if (!x.core.includes("await deps.releaseLease(releaseRowIds);")) out.push("release-not-awaited");
  // transient 기기 durable retry (삼순 NO-GO 2026-08-15) — 버리면 영구 유실.
  if (!x.core.includes("if (result.retryableTokens.length > 0) {")) out.push("transient-dropped");
  if (!x.core.includes("await deps.storeRetryTokens(interview.id, result.retryableTokens, interview.attempts + 1);")) {
    out.push("retry-not-durable");
  }
  if (!x.core.includes("await deps.sendToTokens(interview.retryTokens, {")) out.push("retry-path-missing");
  // P0-2: transient 분기 안에 마커 기록이 있으면 안 된다 — 마커 선기록 후 retry 저장
  // 실패 시 다음 run이 마커만 보고 sent 종결해 transient 기기 재유실.
  {
    const t = x.core.indexOf("if (result.retryableTokens.length > 0) {");
    const p = x.core.indexOf("summary.pendingDeviceRetry++", t);
    if (t < 0 || p < 0 || x.core.slice(t, p).includes("insertSentMarker")) {
      out.push("marker-before-retry-store");
    }
  }
  // P1: 인프라 선행 실패(attempted=false)만 전체 release — 부분 성공을 release하면
  // accepted 기기 재발송 중복.
  if (!x.core.includes("if (!result.attempted) {")) out.push("attempted-gate-missing");
  if (!x.core.includes("if (!retry.attempted) {")) out.push("retry-attempted-gate-missing");
  // sendPush·sendToTokens 둘 다 transient outcome을 반환해야 한다(출현 2회 강제 —
  // includes만 보면 한 쪽 배선 제거 변이가 GREEN으로 샐: 8/15 실측).
  if (x.deps.split('.filter((o) => o.status === "transient")').length - 1 !== 2) {
    out.push("transient-outcome-unwired");
  }
  // P0-1: 원장은 service_role 전용 — 공개 SELECT 테이블에 raw FCM 토큰 금지.
  if (!x.migration2.includes("create table if not exists postgame_interview_retry_tokens")) {
    out.push("retry-ledger-missing");
  }
  if (!x.migration2.includes("alter table postgame_interview_retry_tokens enable row level security")) {
    out.push("retry-ledger-rls-missing");
  }
  if (!x.migration2.includes("revoke all on table postgame_interview_retry_tokens from public, anon, authenticated")) {
    out.push("retry-ledger-grant-open");
  }
  if (x.migration2.includes("alter table postgame_interviews")) {
    out.push("retry-tokens-on-public-table");
  }
  if (x.deps.includes("notify_retry_tokens")) out.push("deps-writes-public-tokens");
  // 원장 배선은 조회·upsert·purge 3곳 전부 있어야 한다(출현 횟수 강제 — includes만
  // 보면 한 곳 제거 변이가 GREEN으로 샐: 8/15 실측 2회차).
  if (x.deps.split('from("postgame_interview_retry_tokens")').length - 1 !== 3) {
    out.push("deps-ledger-unwired");
  }
  return out;
}

const base = violations(files);
if (base.length) {
  console.error(`FAIL baseline contract: ${base.join(", ")}`);
  process.exit(1);
}

const mutations = [
  ["due=0 복구 호출 제거", "route", "interviewNotify = await notifyFavPlayerInterviews(createInterviewDeps());", "interviewNotify = null;"],
  ["lease LIMIT 제거", "migration", "limit greatest(1, least(coalesce(p_limit, 40), 40))", ""],
  ["SKIP LOCKED 제거", "migration", "for update skip locked", "for update"],
  ["RPC lease 배선 제거", "deps", "claim_postgame_interview_notifications", "broken_claim_rpc"],
  ["marker read에서 gameId 제거", "core", "hasSentMarker(interview.gameId, interview.videoId)", "hasSentMarker(interview.videoId, interview.videoId)"],
  ["marker storage에서 gameId 제거", "deps", "`interview#${gameId}#${videoId}`", "`interview#${videoId}`"],
  ["release 실패 다시 은폐", "core", "await deps.releaseLease(releaseRowIds);", "await deps.releaseLease(releaseRowIds).catch(() => {});"],
  ["transient 기기 다시 버림(유실 복원)", "core", "if (result.retryableTokens.length > 0) {", "if (false) {"],
  ["retry 토큰 durable 저장 제거", "core", "await deps.storeRetryTokens(interview.id, result.retryableTokens, interview.attempts + 1);", ""],
  ["retry 재발송 경로 제거", "core", "await deps.sendToTokens(interview.retryTokens, {", "await (async () => ({ ok: true, retryableTokens: [] }))({"],
  ["deps transient outcome 배선 제거(sendPush 쪽)", "deps", '.filter((o) => o.status === "transient")', '.filter(() => false)'],
  ["원장 테이블 migration 제거", "migration2", "create table if not exists postgame_interview_retry_tokens", "-- removed"],
  ["원장 RLS 제거(토큰 공개)", "migration2", "alter table postgame_interview_retry_tokens enable row level security;", ""],
  ["원장 권한 revoke 제거", "migration2", "revoke all on table postgame_interview_retry_tokens from public, anon, authenticated;", ""],
  ["마커를 transient 분기로 이동(P0-2 순서 역전)", "core", "await deps.storeRetryTokens(interview.id, result.retryableTokens, interview.attempts + 1);", "await deps.insertSentMarker(interview.gameId, interview.videoId).catch(() => false); await deps.storeRetryTokens(interview.id, result.retryableTokens, interview.attempts + 1);"],
  ["attempted 게이트 제거(1차)", "core", "if (!result.attempted) {", "if (false) {"],
  ["attempted 게이트 제거(retry)", "core", "if (!retry.attempted) {", "if (false) {"],
  ["deps 원장 배선 제거", "deps", 'from("postgame_interview_retry_tokens")', 'from("broken_ledger")'],
];

let failed = 0;
for (const [name, key, from, to] of mutations) {
  if (!files[key].includes(from)) {
    console.error(`MISS ${name}: anchor`);
    failed++;
    continue;
  }
  const mutant = { ...files, [key]: files[key].replace(from, to) };
  if (violations(mutant).length === 0) {
    console.error(`GREEN ${name}: validator missed mutation`);
    failed++;
  } else {
    console.log(`RED ${name}`);
  }
}
if (failed) {
  console.error(`FAIL ${failed} mutation(s)`);
  process.exit(1);
}
console.log(`PASS ${mutations.length}/${mutations.length} mutations RED`);
