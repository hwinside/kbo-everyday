#!/usr/bin/env node
/** 커뮤니티 피드·상세·댓글 작성자 헤더의 실제 데이터/소비자 소스 계약. */
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const author = read("src/components/community/CommunityAuthorHeader.tsx");
const commentRow = read("src/components/community/CommunityCommentRow.tsx");
const detailHeader = read("src/components/community/PostDetailAuthorHeader.tsx");
const detail = read("src/components/community/PostDetail.tsx");
const feed = read("src/components/community/PhotoFeed.tsx");
const card = read("src/components/community/PostCard.tsx");
const comments = read("src/components/community/CommentSheet.tsx");
const profile = read("src/app/(main)/profile/[userId]/page.tsx");
const profileRow = read("src/components/profile/CommunityProfilePostRow.tsx");
const sourceResolver = read("src/lib/utils/community-board.ts");
const avatars = read("src/lib/constants/avatars.ts");
const collector = read("src/lib/gif-collector/publisher.ts");
let unified = read("src/lib/supabase/useUnifiedFeed.ts");
let free = read("src/app/(main)/community/free/page.tsx");
let player = read("src/hooks/usePlayerCommunity.ts");

if (process.env.POST_HEADER_MUTATE_AVATAR_WIRING === "1") {
  unified = unified.replace(/, avatar_url/g, "").replace(/avatar_url: prof\?\.avatar_url[^\n]*\n/g, "");
  free = free.replace("avatarUrl: p.avatar_url ?? null", "avatarUrl: null");
  player = player.replace(/, avatar_url/g, "").replace(/avatarUrl: prof\?\.avatar_url \?\? null/g, "avatarUrl: null").replace(/avatar_url: prof\?\.avatar_url \?\? undefined[^\n]*\n/g, "");
}

let failures = 0;
let total = 0;
function check(name, ok) {
  total += 1;
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}`);
  if (!ok) failures += 1;
}

check("공용 아바타 40px + 중립 테두리", /h-10 w-10[\s\S]*border border-white\/20/.test(author));
check("1행 아이디 단독·nowrap", /<div className="min-w-0 whitespace-nowrap">[\s\S]*block w-full whitespace-nowrap text-\[15px\]/.test(author));
check("운영팀은 2행", /flex min-w-0 flex-wrap[\s\S]*teamId \? <TeamBadge[\s\S]*isStaff \?/.test(author));
check("2행은 wrap + 메뉴 우측", /flex min-w-0 flex-wrap items-center gap-x-1\.5 gap-y-1/.test(author) && /menu \? <div className="ml-auto shrink-0"/.test(author));
check("프로필 링크 버블링 차단", (author.match(/onClick=\{stopCardNavigation\}/g) ?? []).length === 2);
check("raw·https avatar + 로드 실패 fallback", /avatarUrl\.startsWith\("\/"\)/.test(avatars) && /avatarUrl\.startsWith\("https:\/\/"\)/.test(avatars) && /onError=\{\(\) => setFailedAvatarPath\(avatarPath\)\}/.test(author));
check("PostCard 실제 공용 헤더+글소속", /<CommunityAuthorHeader[\s\S]*avatarUrl=\{post\.author\?\.avatarUrl\}/.test(card) && /data-community-source-label/.test(card));
// 2026-08-06: 피드 라벨이 board 기반 `getPostSourceLabel` → team_tags SSOT 기반 공개범위로 교체됐다.
// 여전히 poll·일반 두 경로 모두 라벨 블록을 가져야 하고, 그 입력은 공용 변환(scopeInputForPost)을 타야 한다.
check(
  "PhotoFeed poll·일반 모두 공개범위 라벨",
  (feed.match(/data-community-source-label/g) ?? []).length >= 2 &&
    (feed.match(/<PostScopeBadge post=\{scopeInputForPost\(post\)\}/g) ?? []).length >= 2,
);
check("상세 실제 메타 컴포넌트 소비", /<PostDetailAuthorHeader[\s\S]*clickCount=\{post\.click_view_count\}/.test(detail) && /<DMButton/.test(detailHeader) && /<PostViewBadge/.test(detailHeader));
check("댓글 시트 실제 공용 row 소비", /<CommunityCommentRow[\s\S]*kind="sheet"[\s\S]*<CommunityAuthorHeader/.test(comments));
check("상세 댓글 실제 공용 row 소비", /<CommunityCommentRow[\s\S]*kind="detail"[\s\S]*<CommunityAuthorHeader/.test(detail));
check("댓글 본문 50px 공용 정렬", /data-community-comment-body className="ml-\[50px\] min-w-0"/.test(commentRow));
check("프로필 쿼리에 team/player tags", /created_at, team_tags, player_tags/.test(profile));
// 2026-08-06: 프로필 글 목록 라벨도 board 기반 getPostSourceLabel → team_tags SSOT 기반 공개범위로 교체.
// 검사 의도(페이지가 actual row 컴포넌트를 쓰고, 그 row 가 태그로 라벨을 계산한다)는 유지하고
// 요구 대상만 새 배선으로 옮긴다. 삭제하면 row 가 라벨을 잃어도 통과하므로 조건은 유지.
check(
  "프로필 actual row가 태그 resolver 소비",
  /<CommunityProfilePostRow/.test(profile) &&
    /<PostScopeBadge post=\{scopeInputForPost\(post\)\}/.test(profileRow),
);
check("프로필 글 탭은 board_type별 상세 route", /getPostDetailHref\(post\)/.test(profileRow) && /onNavigate=\{\(href\) => router\.push\(href\)\}/.test(profile) && !/community\/players\/\$\{post\.board_id\}\/posts/.test(profile));
check("상세 route resolver가 free·team·player 분기", /board_type === "player"[\s\S]*community\/players[\s\S]*board_type === "team"[\s\S]*community\/teams[\s\S]*community\/free/.test(sourceResolver));
check("글소속 resolver는 player_tags 3명·team_tags·legacy 폴백", /post\.player_tags \?\? \[\]/.test(sourceResolver) && /외 \$\{names\.length - 2\}명/.test(sourceResolver) && /post\.team_tags \?\? \[\]/.test(sourceResolver) && /getCommunitySourceLabel\(post\.board_type, post\.board_id\)/.test(sourceResolver));
// 2026-08-07: 봇은 응원팀이 없다. 봇 프로필 team_id 는 NOT NULL 을 채우려고 seed 가 박은 임의값(1=LG)이라
// 그걸 작성자 배지로 쓰면 KIA 김도영 글이 "LG 팬"으로 보인다(하린아빠 지적). 이전 계약(봇 프로필 team)을
// 요구하던 검사를 그대로 두면 게이트가 결함을 고정시킨다. 검사 의도(스냅샷이 임의값이 아니라 결정된
// 출처에서 온다)는 유지하고 요구 대상만 새 배선(콘텐츠 팀 파생)으로 옮긴다.
check(
  "collector snapshot은 봇 프로필이 아니라 콘텐츠 팀 파생",
  /const collectorTeam = resolveCollectorTeam\(/.test(collector) &&
    /author_team_id_snapshot: collectorTeam\.id/.test(collector) &&
    /team_tags: \[collectorTeam\.slug\]/.test(collector) &&
    !/botProfile\?\.team_id/.test(collector),
);
check("게시글 프로필 조회 avatar_url", /profiles\(nickname, team_id, grade, points, avatar_url\)/.test(read("src/lib/supabase/usePosts.ts")));
check("통합 피드 avatar select+map", /profiles\(nickname, team_id, grade, points, avatar_url\)/.test(unified) && /avatar_url: prof\?\.avatar_url/.test(unified));
check("자유게시판 avatar map", /avatarUrl: p\.avatar_url \?\? null/.test(free));
check("선수 일반·사진 avatar select+map", (player.match(/profiles\(nickname, team_id, grade, avatar_url\)/g) ?? []).length === 2 && /avatarUrl: prof\?\.avatar_url \?\? null/.test(player) && /avatar_url: prof\?\.avatar_url \?\? undefined/.test(player));
check("browser mutation self-guard가 package script에 결속", /post-detail-header-nowrap-browser-gate\.sh/.test(read("package.json")));
check("browserless 환경은 mutation 루프 생략", /chromium 없음 — mutation self-guard 생략/.test(read("scripts/qa/post-detail-header-nowrap-browser-gate.sh")));

console.log(failures === 0 ? `\nPASS — ${total}/${total}` : `\nFAIL ${failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
