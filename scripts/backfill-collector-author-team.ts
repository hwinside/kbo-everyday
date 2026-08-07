/**
 * 콜렉터(짤/움짤) 글의 작성자 팀 스냅샷 — #1094 회귀분 한정 복구.
 *
 * 사고: #1094(merge 2026-08-04T01:12:44+09:00)에서 `author_team_id_snapshot` 을 콘텐츠 팀
 * 파생 → 봇 프로필 `profiles.team_id` 로 바꿨다. 봇은 응원팀이 없고 그 값은 seed 임의값(1=LG)이라
 * 그 이후 발행된 콜렉터 글이 전부 "LG 팬"으로 찍혔다(2026-08-07 하린아빠 지적).
 *
 * ⚠️ 이 스크립트는 **오염분만** 고친다. 전수 재계산이 아니다.
 * `author_team_id_snapshot` 은 이름 그대로 *게시 시점*의 팀을 얼린 값이다. 현재 로스터로 과거 글을
 * 전부 다시 계산하면 그 사이 이적한 선수(예: 데이비슨 NC→키움)의 옛 글까지 바뀌어 snapshot 계약이
 * 깨진다. 그래서 **동시에 세 조건을 만족하는 행**만 대상으로 한다.
 *   ① 콜렉터 봇 2계정이 쓴 글
 *   ② `created_at >= #1094 merge 시각` — 그 이전은 구 코드(콘텐츠 팀 파생)라 오염될 수 없다
 *   ③ 현재 snapshot == 그 봇의 `profiles.team_id` — 회귀가 남긴 지문. 다르면 손대지 않는다
 * 셋을 통과해도 파생 팀이 현재 snapshot 과 같으면 no-op 이고, 파생 불가면 SKIP 한다.
 *
 * ⚠️ ③ 때문에 "봇 프로필 팀과 콘텐츠 팀이 우연히 같은" 오염 행은 구분되지 않는다. 다만 그 경우
 * 값이 이미 정답과 같아 사용자에게 보이는 차이가 없다.
 *
 * `team_tags`(공개범위)는 건드리지 않는다 — DB 트리거 계약 영역이라 이 백필의 범위 밖.
 *
 * Usage:
 *   npx tsx scripts/backfill-collector-author-team.ts            # dry-run (기본)
 *   npx tsx scripts/backfill-collector-author-team.ts --apply    # 실제 반영
 *   npx tsx scripts/backfill-collector-author-team.ts --self-test  # 선별 로직 결함주입 검증(DB 불필요)
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveCollectorTeam } from "../src/lib/gif-collector/collector-team";
import { getTeamById } from "../src/lib/constants/teams";

/**
 * #1094 merge 시각(KST). 이 시각 이전에 발행된 글은 구 코드가 콘텐츠 팀으로 파생했으므로
 * 회귀 오염분이 아니다. 배포는 merge 이후에 일어나므로 merge 시각을 하한으로 쓰면
 * 오염분을 빠짐없이 덮으면서 그 이전 글은 확실히 배제한다.
 */
export const REGRESSION_SINCE_ISO = "2026-08-03T16:12:44.000Z"; // 2026-08-04T01:12:44+09:00

const PAGE_SIZE = 500;

export interface BackfillPost {
  id: number;
  author_id: string;
  board_type: string | null;
  board_id: string | null;
  author_team_id_snapshot: number | null;
  created_at: string;
}

export interface BackfillPlan {
  changes: Array<{ id: number; from: number | null; to: number; why: string }>;
  skipped: BackfillPost[];
}

/**
 * 순수 선별 로직 — DB 없이 검증 가능해야 한다(게이트가 직접 호출).
 * botTeamIds: 봇 id → 그 봇 프로필의 team_id.
 */
export function planBackfill(
  posts: BackfillPost[],
  botTeamIds: Map<string, number | null>,
  sinceIso: string = REGRESSION_SINCE_ISO,
): BackfillPlan {
  const since = Date.parse(sinceIso);
  const changes: BackfillPlan["changes"] = [];
  const skipped: BackfillPost[] = [];

  for (const p of posts) {
    // ② 회귀 이전 글은 게시 당시 팀이 이미 옳다 — snapshot 보존.
    if (!(Date.parse(p.created_at) >= since)) continue;
    // ③ 회귀 지문(봇 프로필 team_id)이 아니면 손대지 않는다.
    const botTeamId = botTeamIds.get(p.author_id);
    if (botTeamId == null || p.author_team_id_snapshot !== botTeamId) continue;

    const team = resolveCollectorTeam(p.board_type, p.board_id);
    if (!team) {
      skipped.push(p);
      continue;
    }
    if (p.author_team_id_snapshot === team.id) continue;
    changes.push({
      id: p.id,
      from: p.author_team_id_snapshot,
      to: team.id,
      why: `${p.board_type}/${p.board_id} → ${getTeamById(team.id)?.shortName}`,
    });
  }
  return { changes, skipped };
}

/** id 키셋 페이지네이션 — 콜렉터 글은 계속 늘어나므로 무제한 select 를 쓰지 않는다. */
async function fetchCollectorPosts(
  supa: SupabaseClient,
  botIds: string[],
): Promise<BackfillPost[]> {
  const out: BackfillPost[] = [];
  let cursor = 0;
  for (;;) {
    // query-guard: bounded-page -- id 키셋으로 PAGE_SIZE 씩 끊어 전량 순회한다
    const { data, error } = await supa
      .from("posts")
      .select("id, author_id, board_type, board_id, author_team_id_snapshot, created_at")
      .in("author_id", botIds)
      .gte("created_at", REGRESSION_SINCE_ISO)
      .order("id", { ascending: true })
      .gt("id", cursor)
      .limit(PAGE_SIZE)
      .returns<BackfillPost[]>();
    if (error) throw error;
    if (!data?.length) break;
    out.push(...data);
    cursor = data[data.length - 1].id;
    if (data.length < PAGE_SIZE) break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// self-test — 선별 로직에 결함을 주입해도 잡히는지 DB 없이 확인한다.
// ─────────────────────────────────────────────────────────────────────────────
function selfTest(): void {
  const BOT = "bot-a";
  const bots = new Map<string, number | null>([[BOT, 1]]); // 봇 프로필 = LG(1)
  const base = { author_id: BOT, board_type: "player" as string | null };
  const posts: BackfillPost[] = [
    // 회귀분: 배포 이후 + snapshot=봇팀(1) + 콘텐츠는 KIA(김도영 52605)
    { ...base, id: 1, board_id: "52605", author_team_id_snapshot: 1, created_at: "2026-08-07T00:00:00Z" },
    // 회귀 이전 이적 글: 배포 전이라 건드리면 안 됨(데이비슨 54944, 당시 NC=5)
    { ...base, id: 2, board_id: "54944", author_team_id_snapshot: 5, created_at: "2026-06-27T00:00:00Z" },
    // 배포 이후지만 snapshot 이 봇팀이 아님 → 회귀 지문 없음, 보존
    { ...base, id: 3, board_id: "54944", author_team_id_snapshot: 5, created_at: "2026-08-07T00:00:00Z" },
    // 배포 이후 + 봇팀이지만 콘텐츠도 LG → no-op
    { ...base, id: 4, board_id: "50054", author_team_id_snapshot: 1, created_at: "2026-08-07T00:00:00Z" },
    // 파생 불가 → SKIP
    { ...base, id: 5, board_id: "00000", author_team_id_snapshot: 1, created_at: "2026-08-07T00:00:00Z" },
    // ⚠️ 컷오프만이 막을 수 있는 유일한 케이스 — 지문 조건은 이걸 못 걸러늸다.
    // 배포 이전 글이고 snapshot 이 우연히 봇팀(LG)과 같다 — 그 선수가 당시 LG 소속이라 정답이었다.
    // 이후 이적해 현재 로스터는 KIA(52605) → 전수 재계산하면 과거 snapshot 이 훼손된다.
    { ...base, id: 6, board_id: "52605", author_team_id_snapshot: 1, created_at: "2026-07-01T00:00:00Z" },
  ];

  let pass = 0;
  let fail = 0;
  const check = (name: string, ok: boolean, detail?: string) => {
    console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
    ok ? pass++ : fail++;
  };

  const plan = planBackfill(posts, bots);
  const ids = plan.changes.map((c) => c.id);
  check("회귀분(#1)만 변경 대상", ids.length === 1 && ids[0] === 1, `got ${JSON.stringify(ids)}`);
  check("회귀 이전 이적 글(#2) 보존 — snapshot 계약", !ids.includes(2));
  check("회귀 지문 없는 글(#3) 보존", !ids.includes(3));
  check("이미 정답인 글(#4) no-op", !ids.includes(4));
  check("파생 불가(#5) SKIP, 변경 아님", plan.skipped.map((s) => s.id).includes(5) && !ids.includes(5));
  check(
    "배포 이전 + 지문 일치 이적 글(#6) 보존 — 컷오프만이 막는 케이스",
    !ids.includes(6),
    `got ${JSON.stringify(ids)}`,
  );
  check("#1 목표값이 KIA(6)", plan.changes[0]?.to === 6, `got ${plan.changes[0]?.to}`);

  // 결함주입 — 두 조건을 **각각** 제거해 각자가 독립적으로 검출력을 갖는지 확인한다.
  // (단순히 "둘 중 하나라도 막으면 GREEN" 이면 한 쪽이 죽어도 모른다.)
  const noCutoff = planBackfill(posts, bots, "1970-01-01T00:00:00Z");
  check(
    "결함주입: 컷오프 제거 → 과거 이적 글(#6) 끌려옴 — 컷오프가 실제로 작동",
    noCutoff.changes.map((c) => c.id).includes(6),
    `got ${JSON.stringify(noCutoff.changes.map((c) => c.id))}`,
  );
  // 지문 조건 단독 검출력: 봇팀을 5(NC)로 바꾸면 대상 집합이 #1 → #3 으로 옮겨가야 한다.
  const otherFingerprint = planBackfill(posts, new Map([[BOT, 5]]), REGRESSION_SINCE_ISO);
  check(
    "결함주입: 지문값 변경 → 대상이 #1→#3 으로 이동 — 지문 조건이 실제로 작동",
    otherFingerprint.changes.map((c) => c.id).includes(3) &&
      !otherFingerprint.changes.map((c) => c.id).includes(1),
    `got ${JSON.stringify(otherFingerprint.changes.map((c) => c.id))}`,
  );

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  if (process.argv.includes("--self-test")) return selfTest();

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
    process.exit(1);
  }
  const APPLY = process.argv.includes("--apply");
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // query-guard: bounded -- 콜렉터 봇 계정은 고정 2개(닉네임 unique)
  const { data: bots, error: botErr } = await supa
    .from("profiles")
    .select("id, nickname, team_id")
    .in("nickname", ["짤콜렉터", "움짤콜렉터"])
    .limit(10);
  if (botErr) throw botErr;
  if (!bots?.length) {
    console.error("콜렉터 봇 프로필을 찾지 못했습니다.");
    process.exit(1);
  }
  console.log(`봇 ${bots.length}개: ${bots.map((b) => `${b.nickname}(team_id=${b.team_id})`).join(", ")}`);
  console.log(`회귀 컷오프: ${REGRESSION_SINCE_ISO} (#1094 merge) 이후 발행분만 대상\n`);

  const botTeamIds = new Map<string, number | null>(
    bots.map((b) => [b.id as string, (b.team_id as number | null) ?? null]),
  );
  const posts = await fetchCollectorPosts(supa, [...botTeamIds.keys()]);
  const { changes, skipped } = planBackfill(posts, botTeamIds);

  console.log(`컷오프 이후 콜렉터 글 ${posts.length}건 / 변경 ${changes.length}건 / 파생불가 SKIP ${skipped.length}건`);
  for (const c of changes) {
    const fromName = c.from != null ? getTeamById(c.from)?.shortName ?? c.from : "null";
    console.log(`  #${c.id}  ${fromName} → ${getTeamById(c.to)?.shortName}   (${c.why})`);
  }
  for (const s of skipped) {
    console.log(`  SKIP #${s.id}  ${s.board_type}/${s.board_id} — 미해석, 현재값 유지(${s.author_team_id_snapshot})`);
  }

  if (!APPLY) {
    console.log("\ndry-run 입니다. 반영하려면 --apply 를 붙여 다시 실행하세요.");
    return;
  }

  let ok = 0;
  for (const c of changes) {
    // 낙관적 잠금 — 읽은 값이 그대로일 때만 쓴다(그 사이 바뀌었으면 건너뛴다).
    const { data, error } = await supa
      .from("posts")
      .update({ author_team_id_snapshot: c.to })
      .eq("id", c.id)
      .eq("author_team_id_snapshot", c.from)
      .select("id");
    if (error) {
      console.error(`  ✗ #${c.id} 실패: ${error.message}`);
      continue;
    }
    if (!data?.length) {
      console.error(`  · #${c.id} 건너뜀 — 그 사이 값이 바뀜`);
      continue;
    }
    ok++;
  }
  console.log(`\n반영 ${ok}/${changes.length}건 완료.`);

  const after = await fetchCollectorPosts(supa, [...botTeamIds.keys()]);
  const remaining = planBackfill(after, botTeamIds).changes;
  console.log(`재검증: 남은 회귀 오염 ${remaining.length}건${remaining.length ? ` — ${remaining.map((r) => r.id).join(", ")}` : ""}`);
  if (remaining.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
