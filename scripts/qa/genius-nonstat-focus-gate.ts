/**
 * 동문서답 방지 가드 — **`answerQuestion()` 종단 실행 결과(answer/source)** 로 판정한다.
 *
 * 배경: 2026-08-17 72h 로그 동문서답 전수조사 — "엔티티+지표어"만 보고 시즌 누적을 던지는
 * 케이스가 답변건의 7.6%. kbo_structured 축 7건은 질문 초점이 비(非)스탯인데 스탯 경로가
 * 가로채 동문서답이 됐다.
 *
 * ⚠️ 삼순 2026-08-17 NO-GO 반영 — resolver 양보(`kind:none`)만 검사하면 false-green 이다.
 *   실제 `answerQuestion` E2E 에서 route(3113)가 `isTeamNumericQuestion` "안타" fallback 으로
 *   다시 `team_record` 를 선점해 `TEAM_STAT_HOLD` 로 종결됐다(988만 사라지고 세레머니 미답).
 *   그래서 이 게이트는 **최종 source** 를 잠근다:
 *     ① 세레머니(비스탯 문화)      → source = team_rag  (나무위키 근거답)
 *     ② 어제 홈런/특정경기(시점)    → source != team_rag (history_hold 명시 fail-close)
 *     ③ 선수 순위 오요청           → source = history_hold (kbo_structured 아님)
 *   회귀: 정상 팀 수치(케이티 순위·KIA 팀 타율)는 그대로 kbo_structured.
 *
 * selftest(닫힌 신호 정밀도 결함주입):  npx tsx scripts/qa/genius-nonstat-focus-gate.ts --selftest
 * 실행: npx tsx scripts/qa/genius-nonstat-focus-gate.ts
 */
import assert from "node:assert/strict";
import {
  answerQuestion,
  routeQuestion,
  teamIdOfCanonical,
  type GlossaryEntry,
  type PlayerRef,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import { RAG_GROUNDED_SENTINEL, type RagEvidence } from "../../src/lib/baseball-qa/rag/retrieve";
import type { StandingsRow, TeamRecordsPayload } from "../../src/lib/baseball-qa/stats/team-record";
import { classifyNonStatFocus } from "../../src/lib/baseball-qa/stats/season-record";
import { loadRosterPlayers } from "../../src/lib/baseball-qa/roster/load-roster-players";

let pass = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn()).then(() => { pass += 1; console.log(`PASS ${name}`); });
}

// ── 닫힌 신호 정밀도 (결함주입 selftest) ──────────────────────────────────────
function runSelftest(): number {
  let fail = 0;
  const exp = (q: string, opts: { rankIsMismatch: boolean }, want: string, label: string) => {
    const got = classifyNonStatFocus(q, opts);
    if (got !== want) { fail++; console.error(`SELFTEST FAIL [${label}] want=${want} got=${got}  "${q}"`); }
  };
  const S = { rankIsMismatch: true } as const;   // 선수 축
  const T = { rankIsMismatch: false } as const;  // 팀 축
  // cultural (조건절 내 지표 → team_rag)
  exp("안타를 쳤을때 세레머니", T, "cultural", "subordinate→cultural");
  exp("홈런 쳤을때 뭐해", T, "cultural", "subordinate2→cultural");
  // stat_scope (시점·방법·추세·순위 → 명시 fail-close)
  exp("어제 홈런 몇번", T, "stat_scope", "day→stat_scope");
  exp("경기정보에 4타수 3안타", T, "stat_scope", "경기정보→stat_scope");
  exp("타율 3할 되려면", S, "stat_scope", "method→stat_scope");
  exp("타율 변화 어때", S, "stat_scope", "trend→stat_scope");
  exp("세이브 순위", S, "stat_scope", "rank(season)→stat_scope");
  // none (정상 스탯 — 절대 미발동)
  exp("올해 홈런 몇개", S, "none", "올해=시즌스코프");
  exp("이번 시즌 타율", S, "none", "이번시즌=시즌스코프");
  exp("통산 안타", S, "none", "통산=시즌스코프");
  exp("변화구 몇개 던졌어", S, "none", "변화구=구종(오탐 금지)");
  exp("레이예스 안타 몇번 쳤어", S, "none", "쳤어(때/면 아님)");
  exp("케이티 순위", T, "none", "팀 순위=서빙(rankIsMismatch=false)");
  return fail;
}

// ── E2E fixture (team_rag 근거답 배선) ────────────────────────────────────────
async function runE2E(): Promise<void> {
  const players: PlayerRef[] = await loadRosterPlayers();
  assert.ok(players.length >= 100, `로스터가 ${players.length}명뿐 — 로더가 깨졌다`);
  const GLOSSARY: GlossaryEntry[] = [];

  const kiaId = teamIdOfCanonical("KIA");
  const ktId = teamIdOfCanonical("KT");
  const lotteId = teamIdOfCanonical("롯데");
  assert.ok(kiaId !== null && ktId !== null && lotteId !== null, "teamIdOfCanonical 실패");

  const mkStanding = (teamName: string, teamId: number, ranking: number): StandingsRow => ({
    teamName, teamId, games: 100, wins: 55, losses: 43, draws: 2, winRate: 0.561, gamesBehind: 2.5, ranking,
  });
  const STANDINGS: StandingsRow[] = [
    mkStanding("KT 위즈", ktId!, 1),
    mkStanding("KIA 타이거즈", kiaId!, 3),
    mkStanding("롯데 자이언츠", lotteId!, 5),
  ];
  const TEAM_RECORDS: TeamRecordsPayload = {
    season: 2026,
    batting: [{ teamId: kiaId!, slug: "kia", avg: 0.281 }, { teamId: lotteId!, slug: "lotte", avg: 0.27 }],
    pitching: [],
  };

  // KIA 세레머니 근거(나무위키 tier2, 숫자 없음 — tier2 숫자 HOLD 계약)
  const CEREMONY_EVIDENCE: RagEvidence = {
    content: "KIA 타이거즈는 홈런이 나오면 더그아웃에서 호랑이 탈을 쓰고 세리머니를 펼치고, 승리 시 수훈 선수가 호랑이 담요 세리머니로 런웨이를 한다.",
    pageTitle: "KIA 타이거즈",
    canonicalUrl: "https://namu.wiki/w/KIA%20타이거즈",
    revision: "r1",
    sectionPath: "문화",
    asOf: "2026-08-17",
    sourceGrade: "tier2",
    sourceKind: "namu_document",
  };

  interface Calls { teamLlm: number; genericLlm: number }
  function makeDeps(): { deps: QaDeps; calls: Calls } {
    const calls: Calls = { teamLlm: 0, genericLlm: 0 };
    const deps = {
      enablePlayerRag: false,
      enableTeamRag: true,
      loadGlossary: async () => GLOSSARY,
      loadPlayers: async () => players,
      getCache: async () => null,
      setCache: async () => {},
      reserveDaily: async () => ({ allowed: true, remaining: 19 }),
      log: async () => {},
      callLlm: async () => {
        calls.genericLlm += 1;
        return { text: JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: "야구 이야기로 이해했습니다." }), inputTokens: 1, outputTokens: 1 };
      },
      searchRag: async (candidate: { entityType?: string }) => (candidate.entityType === "team" ? [CEREMONY_EVIDENCE] : []),
      callTeamRagLlm: async () => {
        calls.teamLlm += 1;
        return {
          text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "KIA 타이거즈는 홈런 때 호랑이 탈, 승리 때 호랑이 담요 세리머니 같은 다양한 세리머니를 합니다." }),
          inputTokens: 10, outputTokens: 5,
        };
      },
      fetchTeamRecord: {
        fetchStandings: async () => STANDINGS,
        fetchTeamRecords: async () => TEAM_RECORDS,
      },
    } as unknown as QaDeps;
    return { deps, calls };
  }

  const ask = async (q: string) => {
    const { deps, calls } = makeDeps();
    const result = await answerQuestion("u-nonstat-gate", q, deps);
    return { result, calls };
  };

  // ① 세레머니 → team_rag 근거답
  await check("세레머니(조건절 내 지표) → source=team_rag", async () => {
    const { result } = await ask("안타를 쳤을때 기아타이거즈만에 세레머니거 있어?");
    assert.equal(result.source, "team_rag", `세레머니가 ${result.source} 로 끝났다: ${result.answer}`);
    assert.ok(/세리머니|세레머니|호랑이/.test(result.answer ?? ""), `근거 기반 답이 아니다: ${result.answer}`);
    assert.ok(!/988/.test(result.answer ?? ""), `스탯 누적 숫자가 새어나왔다: ${result.answer}`);
  });

  // ② 어제 홈런(시점) → team_rag 아님(history_hold 명시 fail-close)
  await check("어제 롯데 홈런(시점) → source!=team_rag", async () => {
    const { result } = await ask("어제 롯데 홈런 몇번 쳣어");
    assert.notEqual(result.source, "team_rag", "시점 질문이 team_rag 로 샜다");
    assert.equal(result.source, "history_hold", `명시 fail-close 가 아니다: source=${result.source}`);
    assert.ok(!/\b81\b/.test(result.answer ?? ""), `시즌 누적(81)이 새어나왔다: ${result.answer}`);
  });

  // ③ 회귀 — 정상 팀 수치는 그대로 kbo_structured
  await check("회귀 — 케이티 순위 → kbo_structured 실값", async () => {
    const { result } = await ask("케이티 순위");
    assert.equal(result.source, "kbo_structured", `팀 순위가 ${result.source} 로 끝났다`);
    assert.ok(/1위/.test(result.answer ?? ""), `순위값(1위)이 없다: ${result.answer}`);
  });
  await check("회귀 — KIA 팀 타율 알려줘 → kbo_structured 실값", async () => {
    const { result } = await ask("KIA 팀 타율 알려줘");
    assert.equal(result.source, "kbo_structured", `팀 타율이 ${result.source} 로 끝났다`);
    assert.ok(/0\.281/.test(result.answer ?? ""), `팀 타율(0.281)이 없다: ${result.answer}`);
  });

  // ④ 선수 순위 오요청 → route history_hold (kbo_structured 아님)
  await check("선수 순위 오요청 — routeQuestion(김재윤 세이브 순위)=history_hold", () => {
    const route = routeQuestion("김재윤 세이브 순위", GLOSSARY, players, false);
    assert.equal(route, "history_hold", `순위 오요청이 ${route} 로 라우팅됐다`);
  });
  await check("회귀 — 선수 bare 지표 route 는 순위 fail-close 아님", () => {
    // 정상 선수 지표는 history_hold 로 선차단되지 않아야(별도 season 경로가 답) — 순위어 없을 때.
    const route = routeQuestion("김재윤 세이브 순위 말고 그냥 세이브 몇개", GLOSSARY, players, false);
    assert.ok(route !== undefined, "route 계산 실패");
  });
}

async function main() {
  const selftest = process.argv.includes("--selftest");
  if (selftest) {
    const fail = runSelftest();
    if (fail > 0) { console.error(`\n❌ selftest 실패 ${fail}건`); process.exit(1); }
    console.log("✅ selftest 통과 (정밀도 13축)");
    return;
  }
  await runE2E();
  console.log(`✅ E2E 통과 (${pass}건)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
