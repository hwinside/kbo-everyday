/**
 * 시드 콘텐츠 업로드 스크립트
 * 
 * 사용법:
 *   npx tsx scripts/seed-upload.ts              # 실제 업로드
 *   npx tsx scripts/seed-upload.ts --dry-run    # 미리보기 (INSERT 없이)
 * 
 * 환경변수:
 *   NEXT_PUBLIC_SUPABASE_URL    - Supabase URL (.env.local)
 *   SUPABASE_SERVICE_ROLE_KEY   - Service Role Key
 *   SEED_AUTHOR_ID              - 운영팀 계정 UUID (staff grade)
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { teamSlugsForPlayerTags } from "../src/lib/utils/player-roster";

// .env.local 수동 로딩
function loadEnv(filePath: string) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv(join(__dirname, "..", ".env.local"));

// ─── 설정 ───────────────────────────────────────────────

const SEED_DIR = join(__dirname, "seed-content");
const DRY_RUN = process.argv.includes("--dry-run");

// 파일명 → (board_type, board_id) 매핑
/**
 * seed 글의 공개범위(team_tags) — DB 트리거가 canonical 구단 slug 1개 이상을 요구한다
 * (`20260807020000_posts_require_team_scope.sql`). board_type 면제는 없다(면제 자체가 우회로).
 * seed 는 사람이 피커로 고르는 경로가 아니므로 board 에서 파생한다.
 *   · team   → board_id 가 곧 구단 slug (대소문자 정규화)
 *   · player → 그 선수의 소속팀 slug
 *   · 그 외  → 특정 팀 소유가 아니므로 10팀 전부(= 전체구단 공개)
 */
function seedTeamTags(boardType: string, boardId: string): string[] {
  const KBO = ["lg", "doosan", "kt", "ssg", "nc", "kia", "lotte", "samsung", "hanwha", "kiwoom"];
  if (boardType === "team") {
    const slug = String(boardId).toLowerCase();
    return KBO.includes(slug) ? [slug] : KBO;
  }
  if (boardType === "player") {
    const slug = teamSlugsForPlayerTags([String(boardId)])[0];
    return slug ? [slug] : KBO;
  }
  return KBO;
}

const FILE_MAPPING: Record<string, { boardType: string; boardId: string }> = {
  "01-시즌전망.md":       { boardType: "team",   boardId: "LG" },
  "02-오프시즌정리.md":    { boardType: "team",   boardId: "LG" },
  "03-잠실가이드.md":      { boardType: "team",   boardId: "LG" },
  "04-시범경기일정.md":    { boardType: "team",   boardId: "LG" },
  "05-응원가모음.md":      { boardType: "team",   boardId: "LG" },
  "06-오스틴-TMI.md":      { boardType: "player", boardId: "53123" },
  "07-신민재-TMI.md":      { boardType: "player", boardId: "65207" },
  "08-문보경-TMI.md":      { boardType: "player", boardId: "69102" },
  "09-박해민-TMI.md":      { boardType: "player", boardId: "67430" },
  "10-홍창기-TMI.md":      { boardType: "player", boardId: "66108" },
  "11-우승후보.md":        { boardType: "free",   boardId: "general" },
  "12-역대최고외인타자.md": { boardType: "free",   boardId: "general" },
  "13-시즌버킷리스트.md":  { boardType: "free",   boardId: "general" },
  "14-크보팬소개.md":      { boardType: "free",   boardId: "general" },
  "15-2025베스트경기.md":  { boardType: "free",   boardId: "general" },
};

// ─── 마크다운 파싱 ──────────────────────────────────────

function parseMd(filePath: string): { title: string; content: string } {
  const raw = readFileSync(filePath, "utf-8").trim();
  const lines = raw.split("\n");
  
  // 첫 줄이 # 제목
  const titleLine = lines[0];
  const title = titleLine.replace(/^#\s*/, "").trim();
  
  // 나머지가 content (빈 줄 스킵)
  const content = lines.slice(1).join("\n").trim();
  
  return { title, content };
}

// ─── 메인 ───────────────────────────────────────────────

async function main() {
  // 환경변수 체크
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const authorId = process.env.SEED_AUTHOR_ID;

  if (!DRY_RUN && (!supabaseUrl || !serviceRoleKey)) {
    console.error("❌ NEXT_PUBLIC_SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.");
    console.error("   .env.local 파일을 확인하거나 환경변수를 설정해주세요.");
    process.exit(1);
  }

  if (!DRY_RUN && !authorId) {
    console.error("❌ SEED_AUTHOR_ID 환경변수가 필요합니다. (운영팀 계정 UUID)");
    console.error("   Supabase Auth에서 운영팀 계정을 먼저 생성해주세요.");
    process.exit(1);
  }

  const supabase = !DRY_RUN
    ? createClient(supabaseUrl!, serviceRoleKey!)
    : null;

  console.log(DRY_RUN ? "🔍 DRY RUN 모드 (실제 INSERT 없음)\n" : "🚀 실제 업로드 모드\n");

  // 파일 목록
  const files = readdirSync(SEED_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();

  let uploaded = 0;
  let skipped = 0;
  let errors = 0;

  for (const fileName of files) {
    const mapping = FILE_MAPPING[fileName];
    if (!mapping) {
      console.warn(`⚠️  매핑 없음: ${fileName} — 스킵`);
      skipped++;
      continue;
    }

    const filePath = join(SEED_DIR, fileName);
    const { title, content } = parseMd(filePath);

    console.log(`📄 ${fileName}`);
    console.log(`   제목: ${title}`);
    console.log(`   게시판: ${mapping.boardType}/${mapping.boardId}`);
    console.log(`   내용 길이: ${content.length}자`);

    if (DRY_RUN) {
      console.log(`   ✅ [DRY RUN] 업로드 대상\n`);
      uploaded++;
      continue;
    }

    // 중복 체크 (같은 board에 같은 제목이 있으면 스킵)
    const { data: existing } = await supabase!
      .from("posts")
      .select("id")
      .eq("board_type", mapping.boardType)
      .eq("board_id", mapping.boardId)
      .eq("title", title)
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`   ⏭️  이미 존재 (id: ${existing[0].id}) — 스킵\n`);
      skipped++;
      continue;
    }

    // INSERT
    const { data, error } = await supabase!
      .from("posts")
      .insert({
        author_id: authorId,
        board_type: mapping.boardType,
        board_id: mapping.boardId,
        title,
        content,
        image_urls: [],
        team_tags: seedTeamTags(mapping.boardType, mapping.boardId),
      })
      .select("id")
      .single();

    if (error) {
      console.error(`   ❌ 에러: ${error.message}\n`);
      errors++;
    } else {
      console.log(`   ✅ 업로드 완료 (id: ${data.id})\n`);
      uploaded++;
    }
  }

  // 결과 요약
  console.log("─".repeat(40));
  console.log(`📊 결과: 업로드 ${uploaded} / 스킵 ${skipped} / 에러 ${errors}`);
  console.log(`   총 ${files.length}개 파일 처리 완료`);
  if (DRY_RUN) {
    console.log(`\n💡 실제 업로드는 --dry-run 플래그를 제거하고 다시 실행하세요.`);
  }
}

main().catch(console.error);
