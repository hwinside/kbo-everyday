/**
 * team-videos 선택 로직 회귀 스모크 (search→playlistItems 전환 검증).
 *
 * 전환 배경: /api/team-videos 가 channelId-scoped search.list(100 units) 대신
 * uploads playlistItems.list(1 unit)로 목록을 가져오도록 바꿨다(약 50배 quota 절감).
 * uploads 는 short/long 미구분 단일 목록이라, 이 순수 선택 로직이
 *   ① duration 기준 short/long 필터 ② targetCount slice ③ duration 미상 제외
 * 를 정확히 하는지 고정한다.
 *
 * 실행: npm run qa:team-videos-select
 */
import {
  selectTeamVideoItems,
  isTeamShortVideo,
  type UploadEntry,
} from "../../src/lib/video/team-videos-select";

let pass = 0;
let fail = 0;

function assert(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
}

console.log("team-videos select smoke");

const uploads: UploadEntry[] = [
  { video_id: "L1", title: "롱폼 하이라이트 풀경기", thumbnail: "t-l1", published_at: "2026-07-29T00:00:00Z" },
  { video_id: "S1", title: "결정적 순간 #Shorts", thumbnail: "t-s1", published_at: "2026-07-28T00:00:00Z" },
  { video_id: "S2", title: "홈런 숏츠", thumbnail: null, published_at: "2026-07-27T00:00:00Z" },
  { video_id: "L2", title: "선수 인터뷰", thumbnail: "t-l2", published_at: "2026-07-26T00:00:00Z" },
  { video_id: "NODUR", title: "duration 미상 클립", thumbnail: "t-nd", published_at: "2026-07-25T00:00:00Z" },
];

const detailMap = new Map<string, { durationSeconds: number }>([
  ["L1", { durationSeconds: 600 }],
  ["S1", { durationSeconds: 45 }],
  ["S2", { durationSeconds: 300 }], // 제목 '숏츠' 힌트로 short (duration>70이어도)
  ["L2", { durationSeconds: 400 }],
  // NODUR: detailMap 없음 → 제외돼야 함
]);

// isTeamShortVideo 단위
assert("duration<=70 → short", isTeamShortVideo("무제", 45) === true);
assert("duration>70 + #shorts 힌트 → short", isTeamShortVideo("멋진 #shorts", 300) === true);
assert("duration>70 + 힌트 없음 → long", isTeamShortVideo("풀경기", 600) === false);
assert("duration=0(미상) → long 취급(false)", isTeamShortVideo("숏츠", 0) === false);

// short 선택
const shorts = selectTeamVideoItems(uploads, detailMap, "short", 20);
assert("short: S1,S2만 선택", shorts.map((v) => v.id).join(",") === "S1,S2");
assert("short: NODUR 제외(duration 미상)", !shorts.some((v) => v.id === "NODUR"));
assert("short: thumbnail null → undefined 매핑", shorts.find((v) => v.id === "S2")?.thumbnail === undefined);
assert("short: durationSeconds 실려있음", shorts.find((v) => v.id === "S1")?.durationSeconds === 45);

// long 선택
const longs = selectTeamVideoItems(uploads, detailMap, "long", 10);
assert("long: L1,L2만 선택", longs.map((v) => v.id).join(",") === "L1,L2");
assert("long: NODUR 제외", !longs.some((v) => v.id === "NODUR"));

// targetCount slice (필터 후 순서 유지 + 상한)
const capped = selectTeamVideoItems(uploads, detailMap, "long", 1);
assert("slice: targetCount=1 → 상위 1개(L1)만", capped.length === 1 && capped[0].id === "L1");

// HTML 엔티티 디코드
const enc: UploadEntry[] = [
  { video_id: "E1", title: "A &amp; B &quot;live&quot;", thumbnail: "t", published_at: "2026-07-29T00:00:00Z" },
];
const encMap = new Map([["E1", { durationSeconds: 500 }]]);
const decoded = selectTeamVideoItems(enc, encMap, "long", 10);
assert("title HTML 엔티티 디코드", decoded[0].title === 'A & B "live"');

// 빈 입력 → 빈 결과(라우트는 fallback으로 이어짐)
assert("빈 uploads → 빈 결과", selectTeamVideoItems([], detailMap, "short", 20).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log("✓ ALL PASS — team-videos select OK");
