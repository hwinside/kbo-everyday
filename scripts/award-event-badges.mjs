/**
 * 얼리멤버 이벤트 등수별 뱃지 1회 부여 스크립트
 *
 * 동결된 최종 스냅샷(event_leaderboard_snapshot)을 읽어
 * 트랙(초대/글쓰기)별 순위 구간에 해당하는 시즌 뱃지를 user_badges 에 부여한다.
 *
 *   - 소스는 라이브 리더보드가 아니라 박제된 스냅샷 (컷오프 2026-05-31 24:00 KST)
 *   - is_bot(움짤콜렉터) 행은 스냅샷 재동결 시 이미 제외됐고, 여기서도 한 번 더 방어
 *   - user_badges (user_id, badge_id) unique 제약 → upsert(onConflict) 로 멱등
 *   - badgeId 매핑은 src/lib/events/prizes.ts 의 PrizeTier.badgeId 와 1:1 (수동 미러)
 *
 * Usage:
 *   node scripts/award-event-badges.mjs           # dry-run (부여 대상만 출력)
 *   node scripts/award-event-badges.mjs --apply    # 실제 부여
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

// .env.local 수동 파싱 (dotenv 의존성 없음)
const envFile = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
for (const line of envFile.split("\n")) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match && !process.env[match[1].trim()]) {
    process.env[match[1].trim()] = match[2].trim();
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(supabaseUrl, serviceRoleKey);

const APPLY = process.argv.includes("--apply");

// prizes.ts PrizeTier.badgeId 와 1:1 미러. 변경 시 동시 수정.
const BADGE_BY_TIER = {
  invite: ["event2026-invite-champion", "event2026-invite-master", "event2026-invite-legend", "event2026-invite-ace", "event2026-invite-recruiter", "event2026-invite-connector"],
  writing: ["event2026-writing-director", "event2026-writing-manager", "event2026-writing-scout", "event2026-writing-commentator", "event2026-writing-press", "event2026-writing-supporter"],
};

// 순위 → 구간 인덱스 (prizes.ts getPrizeTierByRank 와 동일)
function tierIndex(rank) {
  if (rank < 1 || rank > 50) return null;
  if (rank === 1) return 0;
  if (rank <= 4) return 1;
  if (rank <= 9) return 2;
  if (rank <= 19) return 3;
  if (rank <= 39) return 4;
  return 5; // 40~50
}

function badgeIdFor(track, rank) {
  const idx = tierIndex(rank);
  if (idx === null) return null;
  const list = BADGE_BY_TIER[track];
  return list ? list[idx] : null;
}

async function main() {
  const { data: rows, error } = await supabase
    .from("event_leaderboard_snapshot")
    .select("track, rank, user_id, nickname, is_bot")
    .order("track", { ascending: true })
    .order("rank", { ascending: true });

  if (error) {
    console.error("snapshot query failed:", error.message);
    process.exit(1);
  }

  const awards = [];
  let skippedBot = 0;
  let outOfRange = 0;

  for (const r of rows ?? []) {
    if (r.is_bot) { skippedBot++; continue; }
    const badge_id = badgeIdFor(r.track, r.rank);
    if (!badge_id) { outOfRange++; continue; }
    awards.push({ user_id: r.user_id, badge_id, _track: r.track, _rank: r.rank, _nick: r.nickname });
  }

  console.log(`스냅샷 ${rows?.length ?? 0}행 | 부여 대상 ${awards.length} | 봇 제외 ${skippedBot} | 구간외(51위~) ${outOfRange}`);
  console.log("");
  for (const a of awards) {
    console.log(`  [${a._track}] ${String(a._rank).padStart(2)}위  ${a.badge_id.padEnd(30)} ${a._nick ?? ""}`);
  }
  console.log("");

  if (!APPLY) {
    console.log("DRY-RUN — 실제 부여하려면 --apply 추가");
    return;
  }

  const payload = awards.map((a) => ({ user_id: a.user_id, badge_id: a.badge_id }));
  const { error: upErr } = await supabase
    .from("user_badges")
    .upsert(payload, { onConflict: "user_id,badge_id", ignoreDuplicates: true });

  if (upErr) {
    console.error("upsert 실패:", upErr.message);
    process.exit(1);
  }
  console.log(`✅ ${payload.length}건 부여 완료 (멱등 upsert)`);
}

main();
