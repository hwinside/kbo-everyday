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
  if (!x.core.includes("data: { notification_id: notificationId }")
      || !x.core.includes("collapseKey: notificationId")
      || !x.core.includes("apnsCollapseId: notificationId")) out.push("provider-dedupe-id");
  if (x.core.includes("releaseLease(releaseRowIds).catch")) out.push("release-failure-hidden");
  if (!x.core.includes("await deps.releaseLease(releaseRowIds);")) out.push("release-not-awaited");
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
  ["provider dedupe id 제거", "core", "data: { notification_id: notificationId }", "data: { notification_id: 'random' }"],
  ["release 실패 다시 은폐", "core", "await deps.releaseLease(releaseRowIds);", "await deps.releaseLease(releaseRowIds).catch(() => {});"],
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
