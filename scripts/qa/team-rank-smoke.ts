/**
 * 팀 순위 변동 알림 문구 회귀 스모크.
 * 실행: npx tsx scripts/qa/team-rank-smoke.ts  (npm run qa:team-rank)
 */
import { buildRankChangeMessage } from "../../src/lib/notifications/team-rank-message";

let pass = 0;
let fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
  } else {
    fail++;
    console.error(`✗ ${name}\n  got:  ${g}\n  want: ${w}`);
  }
}

// 상승 (숫자 작아짐): 5위 → 3위, 2단계 상승
check("상승 2단계", buildRankChangeMessage("LG", 5, 3), {
  title: "🚀 LG 순위 상승",
  body: "LG의 팀 순위가 2단계 상승하여 3위가 되었습니다",
});

// 하락 (숫자 커짐): 3위 → 5위, 2단계 하락
check("하락 2단계", buildRankChangeMessage("두산", 3, 5), {
  title: "〽️ 두산 순위 하락",
  body: "두산의 팀 순위가 2단계 하락하여 5위가 되었습니다",
});

// 1단계 상승 (1위 등극)
check("1단계 상승", buildRankChangeMessage("KIA", 2, 1), {
  title: "🚀 KIA 순위 상승",
  body: "KIA의 팀 순위가 1단계 상승하여 1위가 되었습니다",
});

// 1단계 하락
check("1단계 하락", buildRankChangeMessage("SSG", 4, 5), {
  title: "〽️ SSG 순위 하락",
  body: "SSG의 팀 순위가 1단계 하락하여 5위가 되었습니다",
});

// 변동 없음 → null (발송 안 함)
check("변동 없음 null", buildRankChangeMessage("NC", 6, 6), null);

console.log(`\nteam-rank smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
