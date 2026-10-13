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
  // cultural = true (세레머니 초점 — A 범위)
  exp("안타를 쳤을때 기아타이거즈만에 세레머니거 있어?", true, "세레머니(원본 오탈자)");
  exp("기아 세리머니 뭐 있어", true, "세리머니 변형");
  exp("홈런 치면 세레모니 하는 거 있어?", true, "세레모니 오탈자");
  // false = 세레머니 단어가 있어도 초점이 수치/다른 것 (삼순 6차 반례 — 존재≠초점)
  exp("KIA 홈런 세레머니 말고 올해 팀 홈런 몇 개야?", false, "기각+수치 → 스탯 유지");
  exp("김도영 홈런 세레머니 말고 올해 홈런 몇 개야?", false, "선수축 기각+수치");
  exp("세레머니 말고 팀 타율 알려줘", false, "기각(수치어 없음)");
  // 삼순 8차 반례 — 기각어가 세레머니에서 2음절 넘게 떨어져도 기각이다(세그먼트 순서 판정).
  exp("세레머니 이야기는 됐고 KIA 팀 타율 알려줘", false, "원거리 기각(삼순 8차)");
  exp("세레머니는 일단 빼고 팀 홈런 몇 개야?", false, "삽입어 기각(삼순 8차)");
  // 순서 검증 — 기각어가 세레머니 **앞**이면 세레머니가 마지막 세그먼트 = 문화 초점 유지.
  exp("홈런 기록 말고 세레머니 알려줘", true, "역순 기각 → 세레머니 초점");
  // 세레머니 **수량** 질문은 초점이 여전히 세레머니다 — 수치어는 배제조건이 아니다(삼순 7차).
  exp("세레머니 몇 번 해?", true, "세레머니 수량 질문 → 문화 유지");
  exp("KIA는 홈런 쳤을 때 세레머니 몇 번 해?", true, "수량+조건절(삼순 7차 반례)");
  exp("KIA 홈런 세레머니 몇 종류야?", true, "종류 수량(삼순 7차 반례)");
  // false = 팬문화 확장어 — A 범위 밖(실로그·반례 근거 생기면 별도 PR)
  exp("두산 응원가 알려줘", false, "응원가 — A 범위 밖");
  exp("삼성 치어리더 누구야", false, "치어리더 — A 범위 밖");
  exp("한화 마스코트 이름 뭐야", false, "마스코트 — A 범위 밖");
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
    batting: [{ teamId: kiaId!, slug: "kia", avg: 0.281, hr: 143 }, { teamId: lotteId!, slug: "lotte", avg: 0.27, hr: 101 }],
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
        // 순위표는 **행 + 소스 수신 시각** 스냅샷이다 (삼순 2026-08-28 P0-③).
        fetchStandings: async () => ({ rows: STANDINGS, fetchedAt: new Date(NOW - 60_000).toISOString() }),
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
    // 삼순 7차 NO-GO 반례 — 세레머니 **수량** 질문은 여전히 문화 초점이다.
    //   수치어로 가드를 끄면 team_record 가 시즌 홈런 143을 던져 새 동문서답이 된다.
    { q: "KIA는 홈런 쳤을 때 세레머니 몇 번 해?", note: "수량+조건절(삼순 7차)" },
    { q: "KIA 홈런 세레머니 몇 종류야?", note: "종류 수량(삼순 7차)" },
  ];
  for (const c of CULTURE_CASES) {
    await check(`세레머니 → team_rag — "${c.q.slice(0, 22)}…" (${c.note})`, async () => {
      const { result, calls } = await ask(c.q);
      assert.equal(result.source, "team_rag", `종단 source=${result.source} (기대 team_rag): ${result.answer}`);
      assert.ok(/세리머니|호랑이/.test(result.answer ?? ""), `나무위키 근거답 아님: ${result.answer}`);
      assert.ok(!/\b988\b|\b143\b|\d+개입니다|\d+입니다/.test(result.answer ?? ""), `스탯 숫자 동문서답 새어나옴: ${result.answer}`);
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

  // ── ④ 존재≠초점 반례 (삼순 2026-08-18 6차 NO-GO 원문 그대로) — 세레머니 단어가 있어도
  //   명시 수치 요구/기각 구문이면 팀·선수 구조화 스탯이 유지되어야 한다.
  await check("반례(팀) — KIA 홈런 세레머니 말고 올해 팀 홈런 몇 개야? → kbo_structured 143", async () => {
    const { result, calls } = await ask("KIA 홈런 세레머니 말고 올해 팀 홈런 몇 개야?");
    assert.equal(result.source, "kbo_structured", `팀 스탯이 ${result.source} 로 샜다: ${result.answer}`);
    assert.ok(/143/.test(result.answer ?? ""), `팀 홈런 실값(143) 없다: ${result.answer}`);
    assert.equal(calls.teamLlm, 0, `team_rag LLM 누수 — ${calls.teamLlm}회`);
  });
  //   선수축 반례 — ⚠️ 이 문형은 **main 자체가** 이름 복합어(`김도영 홈런 세레머니`) 해석을 못 해
  //   stat_clarify 로 끝난다(실측). 가드는 미발동(명시 수치 `몇`)이고 가드-false 입력은 삽입 4지점
  //   전부 guard-조건부라 구조상 main 과 동일 경로다. 계약 = 문화 가로채(team_rag/kind:none) 금지
  //   + main-parity 유지. 이름 복합어 해석 개선은 A 범위 밖(B/backlog).
  await check("반례(선수) — 김도영 홈런 세레머니 말고 올해 홈런 몇 개야? → 문화 가로채 없음(main-parity)", async () => {
    const { result, calls } = await ask("김도영 홈런 세레머니 말고 올해 홈런 몇 개야?");
    assert.notEqual(result.source, "team_rag", `수치 요구 질문이 team_rag 로 강제됐다: ${result.answer}`);
    assert.equal(result.source, "stat_clarify", `main-parity 이탈 — source=${result.source}: ${result.answer}`);
    assert.equal(calls.teamLlm, 0, `team_rag LLM 누수 — ${calls.teamLlm}회`);
  });
  await check("반례(기각·비수치어) — 세레머니 말고 KIA 팀 타율 알려줘 → kbo_structured 0.281", async () => {
    const { result } = await ask("세레머니 말고 KIA 팀 타율 알려줘");
    assert.equal(result.source, "kbo_structured", `기각 구문 팀 스탯이 ${result.source} 로 샜다: ${result.answer}`);
    assert.ok(/0\.281/.test(result.answer ?? ""), `팀 타율(0.281) 없다: ${result.answer}`);
  });

  // ── ⑤ 원거리 기각 (삼순 2026-08-18 8차 NO-GO 원문 그대로) — 기각어가 세레머니에서 멀리
  //   떨어져도(삽입어 `이야기는/은 일단`) 구조화 스탯이 유지되어야 한다(세그먼트 순서 판정).
  //   ⚠️ `세레머니 이야기는 됐고 팀 타율` 문형은 **main 자체가** `이야기`(서술어) 때문에
  //   team_rag 서빙을 택한다(실측: 세레머니 없는 `이야기는 됐고 KIA 팀 타율 알려줘`도
  //   isTeamRagServableQuestion=true). 이건 세레머니 가드와 무관한 main 서술 라우팅 축으로,
  //   A에서 손대면 거울 회귀 재발 — B 트랙. 여기서는 **가드 무개입**(세레머니 유무가 결과를
  //   바꾸지 않음 = main-parity)만 잠귔다.
  await check("반례(원거리 기각) — 세레머니 이야기는 됐고 KIA 팀 타율 → 가드 미발동 + main-parity", async () => {
    const q = "세레머니 이야기는 됐고 KIA 팀 타율 알려줘";
    assert.equal(isCulturalTopicQuestion(q), false, "원거리 기각이 cultural 로 오판됐다");
    const { result } = await ask(q);
    const { result: baseline } = await ask("이야기는 됐고 KIA 팀 타율 알려줘");
    assert.equal(result.source, baseline.source,
      `세레머니 유무가 결과를 바꿨다(main-parity 이탈): 세레머니=${result.source} vs 베이스=${baseline.source}`);
  });
  await check("반례(삽입어 기각) — 세레머니는 일단 빼고 KIA 팀 홈런 몇 개야? → kbo_structured 143", async () => {
    const { result, calls } = await ask("세레머니는 일단 빼고 KIA 팀 홈런 몇 개야?");
    assert.equal(result.source, "kbo_structured", `삽입어 기각 팀 스탯이 ${result.source} 로 샜다: ${result.answer}`);
    assert.ok(/143/.test(result.answer ?? ""), `팀 홈런(143) 없다: ${result.answer}`);
    assert.equal(calls.teamLlm, 0, `team_rag LLM 누수 — ${calls.teamLlm}회`);
  });
  // 순서 검증 — 기각어가 세레머니 **앞**이면 세레머니가 마지막 세그먼트 = 문화 초점(team_rag).
  await check("역순 기각 — 홈런 기록 말고 KIA 세레머니 알려줘 → team_rag", async () => {
    const { result } = await ask("홈런 기록 말고 KIA 세레머니 알려줘");
    assert.equal(result.source, "team_rag", `역순 기각 세레머니가 ${result.source} 로 끝났다: ${result.answer}`);
    assert.ok(/세리머니|호랑이/.test(result.answer ?? ""), `근거답 아님: ${result.answer}`);
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
