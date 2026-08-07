/**
 * 시드 콘텐츠 업로드 스크립트
 *
 * Usage:
 *   npx tsx scripts/seed-posts.ts --dry-run          # 미리보기
 *   npx tsx scripts/seed-posts.ts                    # 실제 업로드
 *   npx tsx scripts/seed-posts.ts --schedule 2026-03-10  # 특정 날짜 분량만
 *
 * 환경변수:
 *   SUPABASE_URL           (기본: .env.local의 NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_KEY   (필수 - Supabase 서비스 롤 키)
 *   SEED_AUTHOR_ID         (운영팀 계정 UUID)
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import { teamSlugsForPlayerTags } from "../src/lib/utils/player-roster";

// ─── Config ───
const SUPABASE_URL = process.env.SUPABASE_URL || "https://lbmbdjgsnenqjwjotoei.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
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

const SEED_AUTHOR_ID = process.env.SEED_AUTHOR_ID;

const SEED_DIR = path.resolve(
  process.env.SEED_DIR || `${process.env.HOME}/.openclaw/workspace-samsoon/seed-content`
);

// ─── Player ID 매핑 ───
const PLAYER_MAP: Record<string, string> = {
  "오스틴": "53123",
  "신민재": "65207",
  "문보경": "69102",
  "박해민": "67430",
  "홍창기": "66108",
};

// ─── 배포 스케줄 ───
interface ScheduleEntry {
  date: string;
  file: string;
  boardType: string;
  boardId: string;
}

const SCHEDULE: ScheduleEntry[] = [
  // 3/10: 팀게시판 2편
  { date: "2026-03-10", file: "LG-트윈스/01-팀게시판-시즌전망.md", boardType: "team", boardId: "lg" },
  { date: "2026-03-10", file: "LG-트윈스/02-팀게시판-오프시즌정리.md", boardType: "team", boardId: "lg" },

  // 3/11: 선수 TMI 5편 + 자유 2편
  { date: "2026-03-11", file: "LG-트윈스/06-선수-오스틴-TMI.md", boardType: "player", boardId: "53123" },
  { date: "2026-03-11", file: "LG-트윈스/07-선수-신민재-TMI.md", boardType: "player", boardId: "65207" },
  { date: "2026-03-11", file: "LG-트윈스/08-선수-문보경-TMI.md", boardType: "player", boardId: "69102" },
  { date: "2026-03-11", file: "LG-트윈스/09-선수-박해민-TMI.md", boardType: "player", boardId: "67430" },
  { date: "2026-03-11", file: "LG-트윈스/10-선수-홍창기-TMI.md", boardType: "player", boardId: "66108" },
  { date: "2026-03-11", file: "자유게시판/01-투표-우승후보.md", boardType: "free", boardId: "general" },
  { date: "2026-03-11", file: "자유게시판/02-토론-역대최고외인타자.md", boardType: "free", boardId: "general" },

  // 3/12: 팀게시판 3편 + 자유 3편
  { date: "2026-03-12", file: "LG-트윈스/03-팀게시판-잠실가이드.md", boardType: "team", boardId: "lg" },
  { date: "2026-03-12", file: "LG-트윈스/04-팀게시판-시범경기일정.md", boardType: "team", boardId: "lg" },
  { date: "2026-03-12", file: "LG-트윈스/05-팀게시판-응원가모음.md", boardType: "team", boardId: "lg" },
  { date: "2026-03-12", file: "자유게시판/03-시즌버킷리스트.md", boardType: "free", boardId: "general" },
  { date: "2026-03-12", file: "자유게시판/04-소개-크보팬.md", boardType: "free", boardId: "general" },
  { date: "2026-03-12", file: "자유게시판/05-토론-2025베스트경기.md", boardType: "free", boardId: "general" },
];

// ─── 마크다운 파싱 ───
function parseMarkdown(content: string): { title: string; tags: string[]; body: string } {
  const lines = content.trim().split("\n");
  const firstLine = lines[0];

  // # [태그] 제목 형식 파싱
  const titleMatch = firstLine.match(/^#\s+(?:\[([^\]]+)\]\s*)?(.+)$/);
  let title = firstLine.replace(/^#\s+/, "");
  let tags: string[] = [];

  if (titleMatch) {
    if (titleMatch[1]) tags = [titleMatch[1]];
    title = titleMatch[2].trim();
    if (titleMatch[1]) title = `[${titleMatch[1]}] ${title}`;
  }

  // 나머지 = content (첫 줄 제거, 앞뒤 빈 줄 제거)
  const body = lines.slice(1).join("\n").trim();

  return { title, tags, body };
}

// ─── 랜덤 딜레이 (30~60분을 ms로) ───
function randomDelay(): number {
  return (30 + Math.random() * 30) * 60 * 1000;
}

// ─── Main ───
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const scheduleIdx = args.indexOf("--schedule");
  const targetDate = scheduleIdx >= 0 ? args[scheduleIdx + 1] : null;
  const sampleMode = args.includes("--sample");

  if (!dryRun && !SUPABASE_SERVICE_KEY) {
    console.error("❌ SUPABASE_SERVICE_KEY 환경변수가 필요합니다.");
    process.exit(1);
  }
  if (!dryRun && !SEED_AUTHOR_ID) {
    console.error("❌ SEED_AUTHOR_ID 환경변수가 필요합니다 (운영팀 계정 UUID).");
    process.exit(1);
  }

  const supabase = !dryRun
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY!)
    : null;

  // 대상 필터
  let entries = SCHEDULE;
  if (targetDate) {
    entries = entries.filter(e => e.date === targetDate);
  }
  if (sampleMode) {
    entries = entries.slice(0, 2);
  }

  console.log(`\n📋 시드 콘텐츠 업로드 ${dryRun ? "(DRY RUN)" : ""}`);
  console.log(`   대상: ${entries.length}건`);
  if (targetDate) console.log(`   날짜 필터: ${targetDate}`);
  console.log("");

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const filePath = path.join(SEED_DIR, entry.file);

    if (!fs.existsSync(filePath)) {
      console.error(`❌ 파일 없음: ${entry.file}`);
      continue;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const { title, tags, body } = parseMarkdown(raw);

    console.log(`${i + 1}/${entries.length} | ${entry.date} | ${entry.boardType}/${entry.boardId}`);
    console.log(`   📝 "${title}"`);
    console.log(`   📏 본문 ${body.length}자`);
    if (tags.length) console.log(`   🏷️  ${tags.join(", ")}`);

    if (!dryRun && supabase) {
      const { data, error } = await supabase
        .from("posts")
        .insert({
          author_id: SEED_AUTHOR_ID,
          board_type: entry.boardType,
          board_id: entry.boardId,
          title,
          content: body,
          image_urls: [],
          team_tags: seedTeamTags(entry.boardType, entry.boardId),
        })
        .select("id")
        .single();

      if (error) {
        console.error(`   ❌ 실패: ${error.message}`);
      } else {
        console.log(`   ✅ 성공 (id: ${data.id})`);
      }

      // 다음 글까지 딜레이 (마지막 제외)
      if (i < entries.length - 1) {
        const delay = randomDelay();
        const mins = Math.round(delay / 60000);
        console.log(`   ⏳ ${mins}분 대기...\n`);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    console.log("");
  }

  console.log("🏁 완료!");
}

main().catch(console.error);
