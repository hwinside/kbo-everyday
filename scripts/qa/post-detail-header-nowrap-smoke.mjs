#!/usr/bin/env node
/**
 * 게시글 상세 작성자 헤더 — 2단 구조 소스 계약.
 *
 * 2026-08-03: 한 행에 아이디+메타를 전부 넣으면 닉네임만 잘려서(하린아빠 제보)
 * 1행=아이디 전용 / 2행=쪽지·시간·조회수·더보기 로 분리했다.
 * 실제 레이아웃 판정은 post-detail-header-nowrap-browser.mjs 가 한다.
 */
import { readFileSync } from "node:fs";

const FILE = "src/components/community/PostDetail.tsx";
const src = readFileSync(FILE, "utf8");

let failures = 0;
function check(name, ok) {
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}`);
  if (!ok) failures += 1;
}

const ROW1 = '<div className="flex items-center gap-2 whitespace-nowrap">';
const ROW2 = '<div className="mt-1 flex items-center gap-2 whitespace-nowrap">';

check("1행(아이디 행)이 존재하고 유일", src.split(ROW1).length - 1 === 1);
check("2행(메타 행)이 존재하고 유일", src.split(ROW2).length - 1 === 1);

const row1 = src.slice(src.indexOf(ROW1), src.indexOf(ROW2));
const row2Start = src.indexOf(ROW2);
const row2 = src.slice(row2Start, src.indexOf("</div>\n        </div>", row2Start));

check("1행에 팀 배지 + 닉네임", /shrink-0"><TeamBadge/.test(row1) && /min-w-0 flex-1 truncate/.test(row1));
check("1행 닉네임은 가로 전체를 쓰고 초과분만 말줄임", /min-w-0 flex-1 truncate[^"\n]*text-\[13px\]/.test(row1));
check("1행에 메타(쪽지/시간/조회수/더보기) 없음", !/DMButton|PostViewBadge|PostActionsMenu|timeAgo/.test(row1));
check("2행에 쪽지 버튼", /DMButton[^>]*className="shrink-0"/.test(row2));
check("2행에 작성 시간", /className="shrink-0 text-sm text-text-tertiary"/.test(row2));
check("2행에 조회수", /PostViewBadge[\s\S]*?className="shrink-0"/.test(row2));
check("2행 더보기는 우측 정렬", /className="ml-auto shrink-0">\s*<PostActionsMenu/.test(row2));

console.log(failures === 0 ? "\nPASS — 9/9" : `\nFAIL ${failures} / exit 1`);
process.exit(failures === 0 ? 0 : 1);
