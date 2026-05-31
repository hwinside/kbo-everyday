/**
 * 태그 기반 전환 백필 — 선수 글의 team_tags 채우기 (⑤-2)
 *
 * 마이그레이션 20260531_posts_tag_based.sql 이 팀보드 글은 이미 백필했다.
 * 이 스크립트는 *선수 태그가 달린 글*의 team_tags 를 선수 소속팀으로 채운다.
 *   - player_tags 포맷: "69100:구본혁" → kboId 추출 → roster 로 teamId → 팀 슬러그
 *   - 한 글에 여러 선수 태그가 있으면 팀 슬러그도 dedupe 해서 복수로
 *   - 이미 team_tags 가 채워진 글은 건너뜀(멱등)
 *
 * 안전장치: 기본은 dry-run(쓰지 않음). 실제 반영은 `--apply` 플래그 필요.
 *
 * 실행:
 *   node scripts/migrations/backfill-player-team-tags.mjs          # dry-run
 *   node scripts/migrations/backfill-player-team-tags.mjs --apply  # 실제 반영
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// .env.local 로드 (qa/_env.mjs 와 동일 방식)
try {
  const raw = readFileSync(resolve(__dirname, "../../.env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
} catch {
  /* env 없으면 process.env 그대로 사용 */
}

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "https://lbmbdjgsnenqjwjotoei.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const APPLY = process.argv.includes("--apply");

if (!SERVICE_KEY) {
  console.error("❌ SUPABASE_SERVICE_ROLE_KEY 필요");
  process.exit(1);
}

// teamId(int) → 팀 슬러그 (src/lib/constants/teams.ts 와 동일, 10팀 고정)
const TEAM_SLUG = {
  1: "lg", 2: "doosan", 3: "kt", 4: "ssg", 5: "nc",
  6: "kia", 7: "lotte", 8: "samsung", 9: "hanwha", 10: "kiwoom",
};

// roster: kboId → teamId
const roster = JSON.parse(
  readFileSync(resolve(__dirname, "../../src/lib/constants/players-roster.json"), "utf8"),
);
const kboToTeamId = new Map(roster.map((p) => [String(p.kboId), p.teamId]));

function teamSlugsForPlayerTags(playerTags) {
  if (!Array.isArray(playerTags)) return [];
  const slugs = new Set();
  for (const tag of playerTags) {
    const kboId = String(tag).split(":")[0];
    const teamId = kboToTeamId.get(kboId);
    const slug = teamId != null ? TEAM_SLUG[teamId] : undefined;
    if (slug) slugs.add(slug);
  }
  return [...slugs];
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

// PostgREST 기본 1000행 캡 → range 로 페이징해서 전수 조회.
// 실제 선수 태그가 달린 글만(빈 배열 [] 제외) 대상으로.
const PAGE = 1000;
const posts = [];
for (let from = 0; ; from += PAGE) {
  const { data, error } = await supabase
    .from("posts")
    .select("id, player_tags, team_tags")
    .not("player_tags", "is", null)
    .neq("player_tags", "[]")
    .order("id", { ascending: true })
    .range(from, from + PAGE - 1);
  if (error) {
    console.error("❌ 조회 실패:", error.message);
    process.exit(1);
  }
  posts.push(...(data ?? []));
  if (!data || data.length < PAGE) break;
}

let planned = 0,
  skipped = 0,
  unresolved = 0;

console.log(`${APPLY ? "🔧 APPLY" : "🔍 DRY-RUN"} — 선수태그 글 ${posts.length}건 검사`);

for (const post of posts) {
  const existing = Array.isArray(post.team_tags) ? post.team_tags : [];
  if (existing.length > 0) {
    skipped++;
    continue; // 이미 팀태그 있음 (멱등)
  }
  const slugs = teamSlugsForPlayerTags(post.player_tags);
  if (slugs.length === 0) {
    unresolved++;
    console.warn(`  ⚠️  post ${post.id}: 선수→팀 매핑 실패 ${JSON.stringify(post.player_tags)}`);
    continue;
  }
  planned++;
  if (APPLY) {
    const { error: upErr } = await supabase.from("posts").update({ team_tags: slugs }).eq("id", post.id);
    if (upErr) console.error(`  ❌ post ${post.id} 갱신 실패: ${upErr.message}`);
    else console.log(`  ✅ post ${post.id} → ${JSON.stringify(slugs)}`);
  } else {
    console.log(`  · post ${post.id} → ${JSON.stringify(slugs)}`);
  }
}

console.log(
  `\n완료: ${APPLY ? "반영" : "예정"} ${planned} / 건너뜀(기존태그) ${skipped} / 미해결 ${unresolved}`,
);
if (!APPLY && planned > 0) console.log("→ 실제 반영하려면 --apply 플래그로 재실행");
