/**
 * 동문서답 방지 가드 (#1243 A안) — **`answerQuestion()` 종단 실행 결과(answer/source)** 로 판정한다.
 *
 * 배경: 2026-08-17 72h 로그 동문서답 전수조사 — "엔티티+지표어"만 보고 시즌/팀 누적을 던지는
 * 케이스. 스크린샷 원본은 `안타를 쳤을때 기아만의 세레머니 있어?` 에 `KIA 팀 안타는 988입니다`.
 *
 * ⚠️ **A안 범위 = 구단 문화·응원 의례(세레머니 등) 한 축만** 닫는다. 검출은 문화 토픽 키워드의
 *    닫힌 집합(`isCulturalTopicQuestion`)이며, 이 단어들은 스탯 질문엔 결코 등장하지 않으므로
 *    거울 회귀(반대 경로 오작동)가 원천 불가능하다. 시점(어제·오늘)·순위·추세·방법·혼합수치 등
 *    **스탯 스코프 오답은 A 범위 밖**이며 별도 트랙 B(신호를 함께 보는 단일 분류기)로 이관했다.
 *    → 그 케이스들은 여기서 `history_hold` 로 닫지 않고 main 동작 그대로 흘려보낸다(#1243 2~5차
 *    NO-GO = 순서 술어로 그 축을 닫으려다 반대 경로가 뚫린 이력).
 *
 * 고정 계약:
 *   ① 세레머니(cultural) 질문 → `answerQuestion` 최종 `source=team_rag`, 근거답, 스탯 숫자 금지.
 *   ② 정상 스탯(선수 세이브·팀 순위·팀 타율) → `kbo_structured` 그대로 (가드가 정상 답을 안 죽인다).
 *   ③ 검출 정밀도 — 문화 키워드만 true, 시점·순위·추세·혼합수치·정상스탯은 false(guard 미발동 증명).
 *
 * selftest(검출 정밀도): npx tsx scripts/qa/genius-nonstat-focus-gate.ts --selftest
 * 실행:                 npx tsx scripts/qa/genius-nonstat-focus-gate.ts
 */
import assert from "node:assert/strict";
import {
  answerQuestion,
  teamIdOfCanonical,
  type GlossaryEntry,
  type PlayerRef,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import type { StandingsRow, TeamRecordsPayload } from "../../src/lib/baseball-qa/stats/team-record";
import { isCulturalTopicQuestion } from "../../src/lib/baseball-qa/stats/season-record";
import { RAG_GROUNDED_SENTINEL, type RagEvidence } from "../../src/lib/baseball-qa/rag/retrieve";
import { loadRosterPlayers } from "../../src/lib/baseball-qa/roster/load-roster-players";

let pass = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn()).then(() => { pass += 1; console.log(`PASS ${name}`); });
}

// ── 검출 정밀도 (결함주입 selftest) ───────────────────────────────────────────
// isCulturalTopicQuestion 이 문화 키워드만 잡고, 스탯/시점/순위/추세/혼합수치엔 절대 안 걸리는지.
// 이 기대표는 고정이다 — 검출 로직을 훼손하면 여기서 RED 가 난다(mutation 감지).
function runSelftest(): number {
  let fail = 0;
  const exp = (q: string, want: boolean, label: string) => {
    const got = isCulturalTopicQuestion(q);
    if (got !== want) { fail++; console.error(`SELFTEST FAIL [${label}] want=${want} got=${got}  "${q}"`); }
  };
  // cultural = true (구단 문화·응원 의례)
  exp("안타를 쳤을때 기아타이거즈만에 세레머니거 있어?", true, "세레머니(원본 오탈자)");
  exp("기아 세리머니 뭐 있어", true, "세리머니 변형");
  exp("두산 응원가 알려줘", true, "응원가");
  exp("롯데 응원법 어떻게 돼", true, "응원법");
  exp("삼성 치어리더 누구야", true, "치어리더");
  exp("한화 마스코트 이름 뭐야", true, "마스코트");
  exp("엘지 구단가 가사", true, "구단가");
  // false = 스탯·시점·순위·추세·혼합수치·정상스탯 (A 범위 밖 → guard 미발동, main 동작 유지)
  exp("어제 롯데 홈런 몇번 쳣어", false, "시점(day) — B 트랙");
  exp("오늘 기아 선발 누구야", false, "시점(오늘 선발) — B 트랙");
  exp("네이버 경기정보에 고승민 4타수 3안타", false, "특정경기 수치 — B 트랙");
  exp("김재윤 세이브 순위", false, "순위 오요청 — B 트랙");
  exp("박동원 최근 타율 변화는 어때", false, "추세(method) — B 트랙");
  exp("김도영 타율 3할 되려면 어떻게", false, "방법(method) — B 트랙");
  exp("어제 롯데가 홈런 쳤을 때 몇 개였어", false, "혼합(시점+조건절+수치) — B 트랙");
  exp("문보경 최근 변화 알려줘", false, "지표어 없는 선수 서술 — player RAG");
  exp("KIA 팀 안타 몇개야", false, "정상 팀 스탯(안타)");
  exp("김재윤 세이브 몇개", false, "정상 선수 스탯");
  exp("케이티 순위", false, "정상 팀 순위");
  exp("올해 홈런 몇개", false, "시즌 스코프");
  exp("변화구 몇개 던졌어", false, "변화구=구종(오탐 금지)");
  return fail;
}

// ── E2E fixture ───────────────────────────────────────────────────────────────
async function runE2E(): Promise<void> {
  const players: PlayerRef[] = await loadRosterPlayers();
  assert.ok(players.length >= 100, `로스터가 ${players.length}명뿐 — 로더가 깨졌다`);
  const nameOf = (kboId: string) => players.find((p) => p.kboId === kboId)?.name ?? "";
  const GLOSSARY: GlossaryEntry[] = [];
  const NOW = Date.parse("2026-08-17T12:00:00.000Z");

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

  const CEREMONY_EVIDENCE: RagEvidence = {
    content: "KIA 타이거즈는 홈런이 나오면 더그아웃에서 호랑이 탈을 쓰고 세리머니를 펼치고, 승리 시 수훈 선수가 호랑이 담요 세리머니로 런웨이를 한다.",
    pageTitle: "KIA 타이거즈", canonicalUrl: "https://namu.wiki/w/KIA%20타이거즈",
    revision: "r1", sectionPath: "문화", asOf: "2026-08-17", sourceGrade: "tier2", sourceKind: "namu_document",
  };

  interface Calls { teamLlm: number; searchRag: number; playerLlm: number; genericLlm: number }
  function makeDeps(): { deps: QaDeps; calls: Calls } {
    const calls: Calls = { teamLlm: 0, searchRag: 0, playerLlm: 0, genericLlm: 0 };
    const deps = {
      enablePlayerRag: true,
      enableTeamRag: true,
      now: () => NOW,
      loadGlossary: async () => GLOSSARY,
      loadPlayers: async () => players,
      getCache: async () => null,
      setCache: async () => {},
      reserveDaily: async () => ({ allowed: true, remaining: 19 }),
      releaseDaily: async () => {},
      log: async () => {},
      callLlm: async () => {
        calls.genericLlm += 1;
        return { text: JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: "야구 이야기로 이해했습니다." }), inputTokens: 1, outputTokens: 1 };
      },
      searchRag: async (candidate: { entityType?: string; entityId?: string; name?: string }) => {
        calls.searchRag += 1;
        if (candidate.entityType === "team") return [CEREMONY_EVIDENCE];
        return [];
      },
      callTeamRagLlm: async () => {
        calls.teamLlm += 1;
        return { text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "KIA 타이거즈는 홈런 때 호랑이 탈, 승리 때 호랑이 담요 세리머니 같은 다양한 세리머니를 합니다." }), inputTokens: 10, outputTokens: 5 };
      },
      callRagLlm: async () => {
        calls.playerLlm += 1;
        return { text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "선수 서술 답변입니다." }), inputTokens: 10, outputTokens: 5 };
      },
      fetchSeasonRecord: async (_table: string, kboId: string) => ([{
        player_key: kboId, kbo_id: kboId, name: nameOf(kboId), team: "삼성",
        updated_at: new Date(NOW - 3600_000).toISOString(),
        avg: ".294", games: 50, ab: 200, runs: 30, hits: 60, doubles: 10, triples: 1, hr: 20, tb: 100, rbi: 45,
        saves: 26, holds: 5, wins: 8, losses: 4, era: "2.11", ip: "60.0", so: 70, bb: 20, wpct: ".667",
      }] as never),
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

  // ── ① 세레머니(cultural) → team_rag 근거답, 스탯 숫자 금지 (THE 수정) ──────────
  const CULTURE_CASES: Array<{ q: string; note: string }> = [
    { q: "안타를 쳤을때 기아타이거즈만에 세레머니거 있어?", note: "스크린샷 원본 오탈자" },
    { q: "기아 세리머니 어떤 거 있어?", note: "세리머니 변형" },
  ];
  for (const c of CULTURE_CASES) {
    await check(`세레머니 → team_rag — "${c.q.slice(0, 22)}…" (${c.note})`, async () => {
      const { result, calls } = await ask(c.q);
      assert.equal(result.source, "team_rag", `종단 source=${result.source} (기대 team_rag): ${result.answer}`);
      assert.ok(/세리머니|호랑이/.test(result.answer ?? ""), `나무위키 근거답 아님: ${result.answer}`);
      assert.ok(!/\b988\b|\d+개입니다|\d+입니다/.test(result.answer ?? ""), `스탯 숫자 동문서답 새어나옴: ${result.answer}`);
      assert.ok(calls.searchRag >= 1, `team_rag 근거 검색 미도달: searchRag=${calls.searchRag}`);
    });
  }

  // ── ② 정상 스탯은 그대로 kbo_structured (가드가 정상 답을 죽이지 않음 = false-close 방지) ──
  await check("정상 — 김재윤 세이브 몇 개야? → kbo_structured 26", async () => {
    const { result } = await ask("김재윤 세이브 몇 개야?");
    assert.equal(result.source, "kbo_structured", `정상 스탯이 ${result.source} 로 죽었다: ${result.answer}`);
    assert.ok(/26/.test(result.answer ?? ""), `세이브 값(26)이 없다: ${result.answer}`);
  });
  await check("회귀 — 케이티 순위 → kbo_structured 1위", async () => {
    const { result } = await ask("케이티 순위");
    assert.equal(result.source, "kbo_structured", `팀 순위가 ${result.source} 로 끝났다: ${result.answer}`);
    assert.ok(/1위/.test(result.answer ?? ""), `순위값(1위) 없다: ${result.answer}`);
  });
  await check("회귀 — KIA 팀 타율 알려줘 → kbo_structured 0.281", async () => {
    const { result } = await ask("KIA 팀 타율 알려줘");
    assert.equal(result.source, "kbo_structured", `팀 타율이 ${result.source} 로 끝났다: ${result.answer}`);
    assert.ok(/0\.281/.test(result.answer ?? ""), `팀 타율(0.281) 없다: ${result.answer}`);
  });

  // ── ③ 가드 타이트성 — 문화 키워드 없는 스탯 질문(안타)은 team_rag 로 새지 않는다 ──────
  //   `KIA 팀 안타` 는 세레머니 키워드가 없으므로 문화 경로가 아니라 정상 팀 스탯 경로여야 한다.
  //   (fixture 에 팀 안타 값이 없어 kbo_structured 실값 대신 team_rag 미착지로만 계약을 고정한다.)
  await check("가드 타이트 — KIA 팀 안타 몇개야 → team_rag 아님", async () => {
    const { result } = await ask("KIA 팀 안타 몇개야");
    assert.notEqual(result.source, "team_rag", `문화 키워드 없는 스탯이 team_rag 로 샜다: ${result.answer}`);
  });
}

async function main() {
  if (process.argv.includes("--selftest")) {
    const fail = runSelftest();
    if (fail > 0) { console.error(`\n❌ selftest 실패 ${fail}건`); process.exit(1); }
    console.log("✅ selftest 통과 (검출 정밀도 20축)");
    return;
  }
  await runE2E();
  console.log(`✅ E2E 통과 (${pass}건)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
