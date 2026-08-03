#!/usr/bin/env node
/** 커뮤니티 피드·상세·댓글 공용 작성자 헤더 소스 계약. */
import { readFileSync } from "node:fs";

const author = readFileSync("src/components/community/CommunityAuthorHeader.tsx", "utf8");
const detail = readFileSync("src/components/community/PostDetail.tsx", "utf8");
const feed = readFileSync("src/components/community/PhotoFeed.tsx", "utf8");
const card = readFileSync("src/components/community/PostCard.tsx", "utf8");
const comments = readFileSync("src/components/community/CommentSheet.tsx", "utf8");
let failures = 0;
let total = 0;
function check(name, ok) { total += 1; console.log(`${ok ? "  ✅" : "  ❌"} ${name}`); if (!ok) failures += 1; }

check("공용 아바타는 40px + 중립 테두리", /h-10 w-10[\s\S]*border border-white\/20/.test(author));
check("1행 아이디는 가용폭 전체 + 말줄임 안전장치", /min-w-0 flex-1 truncate text-\[15px\]/.test(author));
check("2행 메타가 별도 행", /mt-1 flex min-w-0 items-center/.test(author));
check("응원팀 배지는 2행 첫 요소 + 팬 접미사", /teamId \? <TeamBadge[^>]*size="xs" suffix="팬"/.test(author));
check("메뉴는 2행 우측 정렬", /menu \? <div className="ml-auto shrink-0"/.test(author));
check("피드가 공용 헤더 사용", /<CommunityAuthorHeader[\s\S]*avatarUrl=\{post\.avatar_url\}/.test(feed));
check("일반글 카드가 공용 헤더 사용", /<CommunityAuthorHeader[\s\S]*avatarUrl=\{post\.author\?\.avatarUrl\}/.test(card));
check("상세가 공용 헤더 사용", /<CommunityAuthorHeader[\s\S]*avatarUrl=\{post\.avatar_url\}/.test(detail));
check("댓글 시트 아바타도 40px", /h-10 w-10 shrink-0 cursor-pointer/.test(comments));
check("상세 댓글 아바타도 40px", /h-10 w-10 shrink-0 cursor-pointer/.test(detail));
check("댓글 팀 배지는 2행 팬 배지", /TeamBadge teamId=\{commentTeam\.id\} size="xs" suffix="팬"/.test(comments));
check("상세 댓글 팀 배지는 2행 팬 배지", /TeamBadge teamId=\{cmtTeam\.id\} size="xs" suffix="팬"/.test(detail));
check("혼합 피드 글 소속은 작성자 헤더와 분리", /글 소속[\s\S]*TeamBadge teamId=\{prominent\.teamId\}/.test(feed));
check("글 소속은 sourceLabels 주입 화면에서만 노출", /sourceLabels && prominent/.test(feed));
check("게시글 프로필 조회에 avatar_url 포함", /profiles\(nickname, team_id, grade, points, avatar_url\)/.test(readFileSync("src/lib/supabase/usePosts.ts", "utf8")));

console.log(failures === 0 ? `\nPASS — ${total}/${total}` : `\nFAIL ${failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
