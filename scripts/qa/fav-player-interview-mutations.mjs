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
  route: fs.readFileSync("src/app/api/game-interviews/route.ts", "utf8"),
  section: fs.readFileSync("src/components/game/PostgameInterviewSection.tsx", "utf8"),
  cron: fs.readFileSync("src/app/api/cron/postgame-interviews/route.ts", "utf8"),
  migration: fs.readFileSync("supabase/migrations/20260814_fav_player_interview_notify.sql", "utf8"),
  migration2: fs.readFileSync("supabase/migrations/20260815191500_fav_interview_transient_retry.sql", "utf8"),
};

function violations(x) {
  const out = [];
  const due = x.cron.indexOf("if (dueJobs.length === 0)");
  const dueEnd = x.cron.indexOf("const [contexts, feedResults]", due);
  const recovery = x.cron.indexOf("notifyFavPlayerInterviews(createInterviewDeps())", due);
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
  // 2026-08-15 문정빈 사고: DB에 있다 ≠ 유저가 본다. 발송 전 노출 확인이 있어야 하고,
  // present 가 아니면 발송하지 않고 보류해야 한다.
  // 노출 확인은 1차 발송·retry 두 곳 모두 있어야 한다 — 출현 횟수로 강제.
  // (includes만 보면 한 곳 제거 변이가 다른 곳 때문에 GREEN으로 샐다 — 8/15 실측 3회차)
  if (x.core.split("await deps.isVisibleOnGamePage(").length - 1 !== 2) {
    out.push("visibility-check-missing");
  }
  if (!x.core.includes('if (visible !== "present") {')) out.push("visibility-gate-open");
  if (!x.core.includes('if (retryVisible !== "present") {')) out.push("retry-visibility-gate-open");
  // 삼순 P0-1: 확인은 fail-close — attempts/deferrals 상한을 조건으로 확인을 건너뛰는
  // 형태(`if (attempts < MAX) { 확인 }` = 상한 도달 시 무확인 발송)가 없어야 한다.
  if (/if \(interview\.(?:attempts|visibilityDeferrals) <[\s\S]{0,400}?isVisibleOnGamePage/.test(x.core)) {
    out.push("visibility-fail-open");
  }
  // 삼순 P0-2: 보류는 전용 카운터로 — FCM attempts 예산을 갉아먹으면 안 된다.
  // 1차·retry 두 곳 모두 전용 카운터로 기록해야 하므로 출현 횟수로 강제.
  if (x.core.split("await deps.recordVisibilityDeferral(interview.id, interview.visibilityDeferrals + 1)").length - 1 !== 2) {
    out.push("deferral-counter-not-separated");
  }
  // 삼순 P0-3: 수집 중·빈 목록은 no-store — s-maxage 잠깐도 빈 목록을 고착시킨다.
  if (!/if \(collecting \|\| itemCount === 0\) return "no-store";/.test(x.route)) {
    out.push("empty-or-collecting-cached");
  }
  // 삼순 P1: warm 탭은 collecting 무관하게 포그라운드 복귀 시 fresh 재조회.
  if (!x.section.includes('cache: "no-store"')) out.push("warm-tab-uses-browser-cache");
  {
    const vis = x.section.indexOf('document.addEventListener("visibilitychange", onVisible)');
    const head = x.section.lastIndexOf("useEffect(", vis);
    if (vis < 0 || /!collecting/.test(x.section.slice(head, vis))) out.push("warm-refetch-collecting-only");
  }
  // 확인은 반드시 sendPush 앞에 있어야 한다(뒤에 있으면 이미 보낸 뒤다).
  {
    const v = x.core.indexOf("await deps.isVisibleOnGamePage(");
    const send = x.core.indexOf("await deps.sendPush(");
    if (v < 0 || send < 0 || v > send) out.push("visibility-after-send");
  }
  // 삼순 2차 P0: retry 경로(sendToTokens)도 노출 확인 없이 발송하면 안 된다.
  // retry 분기 시작~sendToTokens 사이에 확인 호출이 있어야 한다.
  {
    const r = x.core.indexOf("if (interview.retryTokens.length > 0) {");
    const send = x.core.indexOf("await deps.sendToTokens(interview.retryTokens, {", r);
    if (r < 0 || send < 0 || !x.core.slice(r, send).includes("await deps.isVisibleOnGamePage(")) {
      out.push("retry-visibility-missing");
    }
  }
  // 어댑터는 공개 경로를 타야 한다 — DB 재조회는 이번 사고를 못 잡는다.
  if (!x.deps.includes("/api/game-interviews?gameId=")) out.push("visibility-not-public-path");
  // 수집 중이거나 목록이 비어 있으면 캐시 자체를 두지 않는다(사고의 1차 원인).
  // 삼순 P0-3: 동적 헤더는 이미 캐시된 false 응답을 무효화하지 못하므로
  // s-maxage 잠깐이 아니라 no-store 여야 한다.
  if (!x.route.includes("interviewCacheControl(collecting, (items ?? []).length)")) {
    out.push("cache-policy-unwired");
  }
  if (/stale-while-revalidate[\s\S]{0,120}collecting/.test(x.route)) {
    out.push("stale-served-while-collecting");
  }
  if (!x.core.includes("if (!result.settled) {")) out.push("settled-gate-missing");
  if (!x.core.includes("if (!retry.settled) {")) out.push("retry-settled-gate-missing");
  // P0(3차): 전원 토글 OFF·토큰 0은 ok:true + outcomes 없음으로 돌아오는 정상 종결이다.
  // outcomes 유무만 보면 그 경로가 영구 pending이 된다 — ok를 반드시 함께 본다(2곳).
  if (x.deps.split("settled: result.ok || Array.isArray(result.outcomes)").length - 1 !== 2) {
    out.push("settled-ignores-ok");
  }
  // P1(3차): retry 행도 마커를 먼저 본다 — 안 보면 직전 run 종결분을 재발송한다.
  {
    const r = x.core.indexOf("if (interview.retryTokens.length > 0) {");
    const send = x.core.indexOf("await deps.sendToTokens(interview.retryTokens, {", r);
    if (r < 0 || send < 0 || !x.core.slice(r, send).includes("hasSentMarker(interview.gameId, interview.videoId)")) {
      out.push("retry-skips-marker");
    }
  }
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
  // 원장 배선은 조회·upsert·purge + 보류 전용 3곳(read/update/insert) = 6회 사용된다.
  // 출현 횟수로 강제 — includes만 보면 한 곳 제거 변이가 GREEN으로 샐다(8/15 실측 2회차).
  if (x.deps.split('from("postgame_interview_retry_tokens")').length - 1 !== 6) {
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
  ["due=0 복구 호출 제거", "cron", "interviewNotify = await notifyFavPlayerInterviews(createInterviewDeps());", "interviewNotify = null;"],
  ["노출 확인 제거(사고 복원)", "core", "visible = await deps.isVisibleOnGamePage(interview.gameId, interview.videoId);", 'visible = "present";'],
  ["노출 게이트 개방", "core", 'if (visible !== "present") {', "if (false) {"],
  ["retry 노출 확인 제거(재시도 빈페이지 알림)", "core", "          retryVisible = await deps.isVisibleOnGamePage(interview.gameId, interview.videoId);", '          retryVisible = "present";'],
  ["retry 노출 게이트 개방", "core", 'if (retryVisible !== "present") {', "if (false) {"],
  ["확인을 공개 경로 대신 DB로", "deps", "/api/game-interviews?gameId=", "/internal/db-check?gameId="],
  ["수집 중·빈 목록을 캐시함(no-store 제거)", "route", 'if (collecting || itemCount === 0) return "no-store";', ""],
  ["빈 목록 캐시 허용(collecting만 막음)", "route", "if (collecting || itemCount === 0)", "if (collecting)"],
  ["캐시 정책 배선 제거", "route", "interviewCacheControl(collecting, (items ?? []).length)", '"public, s-maxage=60, stale-while-revalidate=300"'],
  ["fail-open 복원(attempts 상한 시 무확인 발송)", "core", 'if (visible !== "present") {', 'if (visible !== "present" && interview.attempts < MAX_SEND_ATTEMPTS) {'],
  ["보류 카운터를 FCM attempts에 혼용", "core", "await deps.recordVisibilityDeferral(interview.id, interview.visibilityDeferrals + 1);", "await deps.storeRetryTokens(interview.id, [], interview.attempts + 1);"],
  ["warm 탭 브라우저 캐시 사용", "section", '{ cache: "no-store" },', ""],
  ["포그라운드 재조회를 collecting 조건부로 회귀", "section", "    if (!enabled) return;\n    const onVisible = () => {", "    if (!enabled || !collecting) return;\n    const onVisible = () => {"],
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
  ["settled 게이트 제거(1차)", "core", "if (!result.settled) {", "if (false) {"],
  ["settled 게이트 제거(retry)", "core", "if (!retry.settled) {", "if (false) {"],
  ["settled가 ok 무시(토글 OFF 영구 pending)", "deps", "settled: result.ok || Array.isArray(result.outcomes)", "settled: Array.isArray(result.outcomes)"],
  ["retry 마커 선확인 제거", "core", "          retryMarker = await deps.hasSentMarker(interview.gameId, interview.videoId);", "          retryMarker = \"absent\";"],
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
