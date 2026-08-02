#!/usr/bin/env node
import { readFileSync } from "node:fs";

const FILE = "src/components/community/PostDetail.tsx";
const src = readFileSync(FILE, "utf8");

let failures = 0;
function check(name, ok) {
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}`);
  if (!ok) failures += 1;
}

const header = src.match(/<div className="([^"]*whitespace-nowrap[^"]*)">[\s\S]*?<PostActionsMenu[\s\S]*?<\/div>\s*<\/div>/);
check("작성자 헤더가 줄바꿈을 금지", Boolean(header));

const block = header?.[0] ?? "";
check("긴 닉네임만 남은 폭 안에서 말줄임", /min-w-0 flex-1 truncate[^"\n]*text-sm/.test(block));
check("팀 배지는 축소하지 않음", /className="shrink-0"><TeamBadge/.test(block));
check("쪽지 버튼은 축소하지 않음", /DMButton[^>]*className="shrink-0"/.test(block));
check("작성 시간은 축소하지 않음", /className="shrink-0 text-sm text-text-tertiary"/.test(block));
check("조회수는 축소하지 않음", /PostViewBadge[\s\S]*?className="shrink-0"/.test(block));
check("더보기 메뉴는 축소하지 않음", /className="shrink-0">\s*<PostActionsMenu/.test(block));

console.log(failures === 0 ? "\nPASS — 7/7" : `\nFAIL ${failures} / exit 1`);
process.exit(failures === 0 ? 0 : 1);
