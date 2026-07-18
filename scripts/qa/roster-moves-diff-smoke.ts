/**
 * 로스터 변동 diff + 공개 게이트 + 일별 스냅샷 교체 회귀 스모크.
 * 실행: npx tsx scripts/qa/roster-moves-diff-smoke.ts  (npm run qa:roster-moves)
 *
 * ModelStore는 cron(/api/cron/roster-moves)의 저장 시멘틱을 1:1로 미러링한 인메모리 모델:
 *   - 스냅샷: 일자별 원자적 교체(upsert 후 stale 삭제 ≡ set)
 *   - 무브: planTeamMoves 집합 upsert(ON CONFLICT DO NOTHING — 기존 status 보존)
 *           + 당일 집합 밖 row 삭제
 * cron 코드가 이 시멘틱에서 벗어나면 여기 시나리오와 어긋난다(리뷰 시 대조 기준).
 */
import {
  parseTeamRegister,
  diffRoster,
  planTeamMoves,
  type RosterEntry,
  type MoveStatus,
} from "../../src/lib/roster-moves/parse";
import {
  evaluateReadiness,
  moveHref,
  publishedRegisterHref,
  filterVisibleMoves,
} from "../../src/lib/roster-moves/readiness";
import { formatPendingMessage } from "../../src/lib/roster-moves/pending-alert";

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

const A: RosterEntry = { kboId: "1", name: "가", backNo: "1", position: "투수" };
const B: RosterEntry = { kboId: "2", name: "나", backNo: "2", position: "포수" };
const C: RosterEntry = { kboId: "3", name: "다", backNo: "3", position: "내야수" };

// ═══ ① diff 순수 함수 ═══

check("등록 1건", diffRoster([A, B], [A, B, C]), [
  { kboPlayerId: "3", playerName: "다", moveType: "register" },
]);
check("말소 1건", diffRoster([A, B, C], [A, B]), [
  { kboPlayerId: "3", playerName: "다", moveType: "deregister" },
]);
check("변동 없음", diffRoster([A, B], [A, { ...B, backNo: "99", position: "외야수" }]), []);
check("첫 실행 baseline", diffRoster(null, [A, B, C]), []);
check("재실행 멱등", diffRoster([A, B], [A, C]), diffRoster([A, B], [A, C]));

// ═══ ② planTeamMoves — 등록 pending / 말소 published (P0 공개 게이트) ═══

check("plan: 등록은 pending 생성", planTeamMoves([A], [A, B]), [
  { kboPlayerId: "2", playerName: "나", moveType: "register", status: "pending" },
]);
check("plan: 말소는 즉시 published", planTeamMoves([A, B], [A]), [
  { kboPlayerId: "2", playerName: "나", moveType: "deregister", status: "published" },
]);

// ═══ ③ readiness 3요소 코어 (roster + 프로필 사진 + 히어로컷) ═══

check("준비됨(전체 통과)", evaluateReadiness(true, true, true), true);
check("히어로 없음 → 미준비 (삼순 오판 케이스)", evaluateReadiness(true, true, false), false);
check("사진 없음 → 미준비", evaluateReadiness(true, false, true), false);
check("로스터 없음 → 미준비", evaluateReadiness(false, true, true), false);

// ═══ ④ 공개 게이트 노출 계약 (P0) ═══

const gateRows = [
  { moveType: "register", status: "pending", name: "미준비등록" },
  { moveType: "register", status: "published", name: "준비등록" },
  { moveType: "deregister", status: "published", name: "말소" },
];
check(
  "게이트: 미준비 등록 API 미반환, 말소는 전부 반환",
  filterVisibleMoves(gateRows).map((r) => r.name),
  ["준비등록", "말소"],
);
check(
  "published 등록 href 보장 (canonical)",
  publishedRegisterHref("51516"),
  "/community/players/51516",
);
check(
  "published 등록 href 보장 (해석 실패 fallback도 non-null)",
  publishedRegisterHref("99999999"),
  "/community/players/99999999",
);
check("말소 미준비 → 링크 생략(null)", moveHref({ canonicalId: null }), null);
check("말소 준비됨 → 상세 링크", moveHref({ canonicalId: "51516" }), "/community/players/51516");

// pending 추적 — silent omission 금지: 대기 건은 사유와 함께 표면화 + 외국인 수동 안내
const pendingMsg = formatPendingMessage([
  { playerName: "엄준현", teamId: 6, moveDate: "2026-07-18", missing: ["hero"] },
  { playerName: "세베리노", teamId: 2, moveDate: "2026-07-18", missing: ["roster", "photo", "hero"] },
]);
check(
  "pending 알림: 선수/사유/외국인 안내 포함",
  pendingMsg.includes("엄준현") &&
    pendingMsg.includes("히어로컷") &&
    pendingMsg.includes("세베리노") &&
    pendingMsg.includes("foreign-id-map"),
  true,
);

// ═══ ⑤ 일별 스냅샷 교체 회귀 (삼순 P1) — cron 저장 시멘틱 모델 ═══

interface StoredMove {
  kboPlayerId: string;
  playerName: string;
  moveType: "register" | "deregister";
  moveDate: string;
  status: MoveStatus;
}

class ModelStore {
  snapshots = new Map<string, RosterEntry[]>();
  moves: StoredMove[] = [];

  /** cron 1회 실행: 전일 스냅샷 대비 diff → 오늘 스냅샷/무브 원자적 교체. */
  run(date: string, curr: RosterEntry[]) {
    const prevDates = [...this.snapshots.keys()].filter((d) => d < date).sort();
    const prev =
      prevDates.length > 0 ? this.snapshots.get(prevDates[prevDates.length - 1])! : null;
    const planned = planTeamMoves(prev, curr);
    // 스냅샷 교체 (upsert 후 stale 삭제 ≡ 통째 교체)
    this.snapshots.set(date, curr);
    // 무브 upsert — ON CONFLICT DO NOTHING (기존 row status 보존)
    for (const p of planned) {
      const exists = this.moves.some(
        (m) => m.moveDate === date && m.kboPlayerId === p.kboPlayerId && m.moveType === p.moveType,
      );
      if (!exists) this.moves.push({ ...p, moveDate: date });
    }
    // 당일 계획 집합 밖 row 삭제 (stale 이벤트 제거)
    const keys = new Set(planned.map((p) => `${p.kboPlayerId}|${p.moveType}`));
    this.moves = this.moves.filter(
      (m) => m.moveDate !== date || keys.has(`${m.kboPlayerId}|${m.moveType}`),
    );
  }

  promote(kboPlayerId: string) {
    for (const m of this.moves) {
      if (m.kboPlayerId === kboPlayerId && m.moveType === "register") m.status = "published";
    }
  }

  count(kboPlayerId: string, moveType: string): number {
    return this.moves.filter((m) => m.kboPlayerId === kboPlayerId && m.moveType === moveType)
      .length;
  }
}

// ⑤-1 삼순 지정 시나리오: 전날 [A,B] → 오늘 10시 [A,B] → 오늘 20시 [A] → 다음날 [A]
//     ⇒ B 말소 이벤트 정확히 1건 (upsert-only였다면 다음날 중복 말소 발생)
{
  const s = new ModelStore();
  s.run("2026-07-17", [A, B]); // baseline (이벤트 0)
  s.run("2026-07-18", [A, B]); // 10시 — 변동 없음
  s.run("2026-07-18", [A]); // 20시 — B 말소
  s.run("2026-07-19", [A]); // 다음날 — 중복 말소 없어야 함
  check("P1 회귀: B 말소 정확히 1건", s.count("2", "deregister"), 1);
  check("P1 회귀: 오늘 스냅샷에 B 잔존 없음", s.snapshots.get("2026-07-18"), [A]);
  check("P1 회귀: 말소 날짜 = 발생일", s.moves.filter((m) => m.kboPlayerId === "2").map((m) => m.moveDate), ["2026-07-18"]);
}

// ⑤-2 동일일 왕복: 등록 후 당일 말소 ⇒ 일 단위 계약상 순변동 0 (이벤트 잔존 없음)
{
  const s = new ModelStore();
  s.run("2026-07-17", [A]); // baseline
  s.run("2026-07-18", [A, B]); // 10시 — B 등록(pending)
  check("왕복: 오전 등록 pending 생성", s.count("2", "register"), 1);
  s.run("2026-07-18", [A]); // 20시 — B 이탈 → 오전 등록 이벤트 제거, 말소도 없음
  s.run("2026-07-19", [A]);
  check("왕복: 순변동 0 (등록 잔존 없음)", s.count("2", "register"), 0);
  check("왕복: 순변동 0 (말소 미생성)", s.count("2", "deregister"), 0);
}

// ⑤-3 status 보존: 오전 승격된 published 등록이 저녁 재계산에 pending으로 강등되지 않음
{
  const s = new ModelStore();
  s.run("2026-07-17", [A]);
  s.run("2026-07-18", [A, B]); // B 등록 pending
  s.promote("2"); // 승격 단계 통과 가정
  s.run("2026-07-18", [A, B]); // 20시 재실행 — ON CONFLICT DO NOTHING
  const b = s.moves.filter((m) => m.kboPlayerId === "2");
  check("status 보존: published 유지 + 중복 row 없음", b.map((m) => m.status), ["published"]);
}

// ═══ ⑥ 파서: 감독/코치 제외, 선수 섹션만 (playerId 링크 추출) ═══

const fixture = `
<table class="tNData"><thead><tr><th>등번호</th><th>감독</th><th>투타유형</th></tr></thead>
<tbody><tr><td>88</td><td><a href="/Record/Retire/Hitter.aspx?playerId=90214">김태형</a></td><td>우투우타</td></tr></tbody></table>
<table class="tNData"><thead><tr><th>등번호</th><th>투수</th><th>투타유형</th></tr></thead>
<tbody><tr><td>15</td><td><a href="/Record/Player/PitcherDetail/Basic.aspx?playerId=51516">김진욱</a></td><td>좌투좌타</td></tr></tbody></table>
<table class="tNData"><thead><tr><th>등번호</th><th>선수명</th><th>포지션</th></tr></thead>
<tbody><tr><td>7</td><td><a href="/x?playerId=99999">변경표선수</a></td><td>내</td></tr></tbody></table>`;
check("파서 감독제외·선수만", parseTeamRegister(fixture), [
  { kboId: "51516", name: "김진욱", backNo: "15", position: "투수" },
]);

console.log(`\nroster-moves smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
