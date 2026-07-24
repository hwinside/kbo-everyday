// 크관 헤더 실시간 카운트 낙관적 증분(trackCountDeltas) 회귀 스모크.
// - 새 메시지 도착 즉시 +1 (홈/원정 최애팀 분류 포함)
// - id 기준 dedupe: backfill/재구독으로 같은 메시지 재관찰 시 중복 증분 금지
// - loadMore prepend(베이스라인 이하 id)는 증분 제외
// - 삭제 전이 시 -1, 처음부터 삭제 상태로 관찰된 메시지는 불변
// 실행: npm run qa:chat-count-delta
import "./_smoke-env";
import { trackCountDeltas, type ChatCountTracker } from "../../src/lib/supabase/useChat";

const HOME = 1;
const AWAY = 2;

type Msg = { id: number; deleted_at?: string | null; team_id?: number };

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}: expected ${e}, got ${a}`);
  }
}

function freshTracker(baselineMaxId: number): ChatCountTracker {
  return { baselineMaxId, known: new Map() };
}

// 1) 베이스라인 이후 새 메시지 도착 → 즉시 +1 (팀 분류)
{
  const t = freshTracker(100);
  const msgs: Msg[] = [
    { id: 99, team_id: HOME }, // 베이스라인 이하 — 서버 count에 이미 포함, 증분 금지
    { id: 101, team_id: HOME },
    { id: 102, team_id: AWAY },
    { id: 103, team_id: 999 }, // 제3팀(중립) — total만 +1
    { id: 104 }, // 최애팀 미설정 — total만 +1
  ];
  const d = trackCountDeltas(t, msgs, HOME, AWAY);
  check("new arrivals increment", d, { total: 4, home: 1, away: 1 });
}

// 2) 같은 메시지 재관찰(backfill/재구독) → 중복 증분 없음
{
  const t = freshTracker(100);
  const msgs: Msg[] = [{ id: 101, team_id: HOME }];
  trackCountDeltas(t, msgs, HOME, AWAY);
  const d2 = trackCountDeltas(t, [...msgs, { id: 101, team_id: HOME }], HOME, AWAY);
  check("dedupe on re-observe", d2, { total: 0, home: 0, away: 0 });
}

// 3) loadMore prepend (과거 id만 추가) → 증분 0
{
  const t = freshTracker(100);
  const d = trackCountDeltas(t, [{ id: 10, team_id: AWAY }, { id: 11, team_id: HOME }], HOME, AWAY);
  check("loadMore prepend no-op", d, { total: 0, home: 0, away: 0 });
}

// 4) 삭제 전이 → -1 (낙관 증분됐던 메시지)
{
  const t = freshTracker(100);
  trackCountDeltas(t, [{ id: 101, team_id: HOME }], HOME, AWAY);
  const d = trackCountDeltas(t, [{ id: 101, team_id: HOME, deleted_at: "2026-07-24" }], HOME, AWAY);
  check("delete transition (optimistic msg)", d, { total: -1, home: -1, away: 0 });
}

// 5) 삭제 전이 → -1 (베이스라인에 포함됐던 과거 메시지)
{
  const t = freshTracker(100);
  trackCountDeltas(t, [{ id: 50, team_id: AWAY }], HOME, AWAY);
  const d = trackCountDeltas(t, [{ id: 50, team_id: AWAY, deleted_at: "2026-07-24" }], HOME, AWAY);
  check("delete transition (baseline msg)", d, { total: -1, home: 0, away: -1 });
}

// 6) 처음부터 삭제 상태로 관찰 → 불변 (서버 count도 이미 제외)
{
  const t = freshTracker(100);
  const d = trackCountDeltas(t, [{ id: 101, team_id: HOME, deleted_at: "2026-07-24" }], HOME, AWAY);
  const d2 = trackCountDeltas(t, [{ id: 101, team_id: HOME, deleted_at: "2026-07-24" }], HOME, AWAY);
  check("born-deleted no-op", d, { total: 0, home: 0, away: 0 });
  check("born-deleted stays no-op", d2, { total: 0, home: 0, away: 0 });
}

// 7) 이중 삭제 관찰 → 한 번만 -1
{
  const t = freshTracker(100);
  trackCountDeltas(t, [{ id: 101, team_id: HOME }], HOME, AWAY);
  trackCountDeltas(t, [{ id: 101, team_id: HOME, deleted_at: "2026-07-24" }], HOME, AWAY);
  const d = trackCountDeltas(t, [{ id: 101, team_id: HOME, deleted_at: "2026-07-24" }], HOME, AWAY);
  check("double delete observed once", d, { total: 0, home: 0, away: 0 });
}

// 8) 첫 서버 카운트 전(baseline=Infinity) → 어떤 도착도 증분 금지
{
  const t = freshTracker(Infinity);
  const d = trackCountDeltas(t, [{ id: 101, team_id: HOME }], HOME, AWAY);
  check("no increments before baseline", d, { total: 0, home: 0, away: 0 });
}

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll chat-count-delta checks passed");
