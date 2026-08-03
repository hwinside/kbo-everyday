#!/usr/bin/env node
/** 커뮤니티 피드·상세·댓글 공용 작성자 헤더 소스 계약. */
import { readFileSync } from "node:fs";

const author = readFileSync("src/components/community/CommunityAuthorHeader.tsx", "utf8");
const detail = readFileSync("src/components/community/PostDetail.tsx", "utf8");
const feed = readFileSync("src/components/community/PhotoFeed.tsx", "utf8");
const card = readFileSync("src/components/community/PostCard.tsx", "utf8");
const comments = readFileSync("src/components/community/CommentSheet.tsx", "utf8");
let unified = readFileSync("src/lib/supabase/useUnifiedFeed.ts", "utf8");
let free = readFileSync("src/app/(main)/community/free/page.tsx", "utf8");
let player = readFileSync("src/hooks/usePlayerCommunity.ts", "utf8");
let profile = readFileSync("src/app/(main)/profile/[userId]/page.tsx", "utf8");
if (process.env.POST_HEADER_MUTATE_AVATAR_WIRING === "1") {
  unified = unified.replace(/, avatar_url/g, "").replace(/avatar_url: prof\?\.avatar_url[^\n]*\n/g, "");
  free = free.replace("avatarUrl: p.avatar_url ?? null", "avatarUrl: null");
  player = player.replace(/, avatar_url/g, "").replace(/avatarUrl: prof\?\.avatar_url \?\? null/g, "avatarUrl: null").replace(/avatar_url: prof\?\.avatar_url \?\? undefined[^\n]*\n/g, "");
}
if (process.env.POST_HEADER_MUTATE_PROFILE_SOURCE === "1") {
  profile = profile.replace("data-community-source-label", "data-removed-source-label");
}
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
check("댓글 시트가 공용 헤더 사용", /<CommunityAuthorHeader[\s\S]*avatarUrl=\{\(comment as Comment/.test(comments));
check("상세 댓글이 공용 헤더 사용", /<CommunityAuthorHeader[\s\S]*avatarUrl=\{c\.avatar_url\}/.test(detail));
check("혼합 피드 글 소속은 작성자 헤더와 분리", /글 소속[\s\S]*TeamBadge teamId=\{prominent\.teamId\}/.test(feed));
check("글 소속은 sourceLabels 주입 화면에서만 노출", /sourceLabels && prominent/.test(feed));
check("게시글 프로필 조회에 avatar_url 포함", /profiles\(nickname, team_id, grade, points, avatar_url\)/.test(readFileSync("src/lib/supabase/usePosts.ts", "utf8")));
check("통합 피드 avatar select+map", /profiles\(nickname, team_id, grade, points, avatar_url\)/.test(unified) && /avatar_url: prof\?\.avatar_url/.test(unified));
check("자유게시판 변환 avatar map", /avatarUrl: p\.avatar_url \?\? null/.test(free));
check("선수 일반·사진 avatar select+map", (player.match(/profiles\(nickname, team_id, grade, avatar_url\)/g) ?? []).length === 2 && /avatarUrl: prof\?\.avatar_url \?\? null/.test(player) && /avatar_url: prof\?\.avatar_url \?\? undefined/.test(player));
check("프로필 글 탭 큰 글 소속 라벨", /getCommunitySourceLabel/.test(profile) && /data-community-source-label/.test(profile) && /TeamBadge teamId=\{sourceLabel\.teamId\} playerName=\{sourceLabel\.playerName\} size="sm"/.test(profile));

console.log(failures === 0 ? `\nPASS — ${total}/${total}` : `\nFAIL ${failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
