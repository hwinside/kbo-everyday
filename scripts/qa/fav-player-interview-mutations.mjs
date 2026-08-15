#!/usr/bin/env node
/**
 * 최애선수 인터뷰 알림 durable mutation gate.
 * 핵심 배선/SQL을 일부러 훼손한 변이가 각각 계약 검증을 RED로 만드는지 증명한다.
 * smoke의 동작 검증과 함께 prebuild에 결속한다.
 */
import fs from "node:fs";

const files = {
  core: fs.readFileSync("src/lib/notifications/fav-player-interview.ts", "utf8"),
  deps: fs.readFileSync("src/lib/notifications/fav-player-interview-deps.ts", "utf8"),
  route: fs.readFileSync("src/app/api/cron/postgame-interviews/route.ts", "utf8"),
  migration: fs.readFileSync("supabase/migrations/20260814_fav_player_interview_notify.sql", "utf8"),
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
  // partial-transient: ok:true 여도 retryableFailed>0 이면 종결하지 않고 release 해야 한다.
  // 어댑터가 값을 올리지 않으면(상수 0) core 가 아무리 맞아도 무의미라 둘 다 본다.
  if (!/retryableFailed:\s*result\.retryableFailed/.test(x.deps)) out.push("retryable-not-propagated");
  {
    const guard = x.core.indexOf("(result.retryableFailed ?? 0) > 0");
    const marker = x.core.indexOf("insertSentMarker(interview.gameId, interview.videoId)");
    // 가드가 없거나 marker 기록 뒤에 있으면 이미 종결된 뒤라 유실을 막지 못한다.
    if (!(guard >= 0 && marker > guard)) out.push("retryable-guard-missing");
    if (!/\(result\.retryableFailed \?\? 0\) > 0\)\s*\{[^}]*releaseRowIds\.push/.test(x.core)) {
      out.push("retryable-guard-not-releasing");
    }
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
  // 삼순 최종 NO-GO P0 — partial-transient 유실 축
  ["deps 가 retryableFailed 미전파", "deps", "retryableFailed: result.retryableFailed ?? 0", "retryableFailed: 0"],
  ["core partial-transient 가드 제거", "core", "if ((result.retryableFailed ?? 0) > 0) {", "if (false) {"],
  ["partial-transient 을 release 없이 카운트만", "core", "releaseRowIds.push(interview.id);\n        summary.released++;\n        summary.releasedPartialDelivery++;", "summary.released++;\n        summary.releasedPartialDelivery++;"],
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
