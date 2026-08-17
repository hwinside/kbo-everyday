/**
 * 동문서답 방지 가드 — **`answerQuestion()` 종단 실행 결과(answer/source)** 로 판정한다.
 *
 * 배경: 2026-08-17 72h 로그 동문서답 전수조사 — "엔티티+지표어"만 보고 시즌 누적을 던지는
 * 케이스가 답변건의 7.6%. kbo_structured 축 7건은 질문 초점이 비(非)스탯인데 스탯 경로가
 * 가로채 동문서답이 됐다.
 *
 * ⚠️ 삼순 2026-08-17 NO-GO 2차 반영 — 완료 게이트:
 *   ① 실로그 kbo_structured 7건 원문 전부 `answerQuestion` 최종 source E2E
 *   ② 정상 `김재윤 세이브 몇개 → kbo_structured` (가드가 정상 스탯을 죽이지 않음)
 *   ③ 조건절+시점 혼합 수치 반례 `어제 롯데가 홈런 쳤을 때 몇 개였어` → history_hold + RAG 0
 * production 배선과 동일하게 enablePlayerRag/enableTeamRag=true 로 태운다.
 *
 * selftest(닫힌 신호 정밀도):  npx tsx scripts/qa/genius-nonstat-focus-gate.ts --selftest
 * 실행: npx tsx scripts/qa/genius-nonstat-focus-gate.ts
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
import { classifyNonStatFocus } from "../../src/lib/baseball-qa/stats/season-record";
import { RAG_GROUNDED_SENTINEL, type RagEvidence } from "../../src/lib/baseball-qa/rag/retrieve";
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
  const S = { rankIsMismatch: true } as const;
  const T = { rankIsMismatch: false } as const;
  // cultural (조건절 내 **비수치** 지표 → team_rag)
  exp("안타를 쳤을때 세레머니", T, "cultural", "subordinate 비수치→cultural");
  exp("홈런 쳤을때 뭐해", T, "cultural", "subordinate2→cultural");
  // stat_scope — 시점/방법/추세/순위, 그리고 조건절+수치값
  exp("어제 홈런 몇번", T, "stat_scope", "day→stat_scope");
  exp("경기정보에 4타수 3안타", T, "stat_scope", "경기정보→stat_scope");
  exp("타율 3할 되려면", S, "stat_scope", "method→stat_scope");
  exp("타율 변화 어때", S, "stat_scope", "trend→stat_scope");
  exp("세이브 순위", S, "stat_scope", "rank(season)→stat_scope");
  exp("어제 롯데가 홈런 쳤을 때 몇 개였어", T, "stat_scope", "혼합(시점+조건절+수치)→stat_scope");
  exp("롯데가 홈런 쳤을때 몇개였어", T, "stat_scope", "조건절+수치값→stat_scope");
  // none (정상 스탯 — 절대 미발동)
  exp("올해 홈런 몇개", S, "none", "올해=시즌스코프");
  exp("이번 시즌 타율", S, "none", "이번시즌=시즌스코프");
  exp("통산 안타", S, "none", "통산=시즌스코프");
  exp("변화구 몇개 던졌어", S, "none", "변화구=구종(오탐 금지)");
  exp("레이예스 안타 몇번 쳤어", S, "none", "쳤어(때/면 아님)");
  exp("김재윤 세이브 몇개", S, "none", "정상 선수 스탯");
  exp("케이티 순위", T, "none", "팀 순위=서빙(rankIsMismatch=false)");
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
      searchRag: async (candidate: { entityType?: string }) => {
        calls.searchRag += 1;
        return candidate.entityType === "team" ? [CEREMONY_EVIDENCE] : [];
      },
      callTeamRagLlm: async () => {
        calls.teamLlm += 1;
        return { text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "KIA 타이거즈는 홈런 때 호랑이 탈, 승리 때 호랑이 담요 세리머니 같은 다양한 세리머니를 합니다." }), inputTokens: 10, outputTokens: 5 };
      },
      callRagLlm: async () => {
        calls.playerLlm += 1;
        return { text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "선수 서술 답변입니다." }), inputTokens: 10, outputTokens: 5 };
      },
      // 시즌 기록 조회 — 요청 kboId 로 원값 row 를 만들어 돌려준다(정상 스탯 답변용).
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

  // ── ① 실로그 kbo_structured 7건 원문 전부 종단 source ──────────────────────
  // source: 정확 종단 라벨. `antiStat`=true 는 종단 라벨이 로스터 후보 해석에 의존해
  //   결정론이 아닌 케이스(문장형 제보) — 요건은 "kbo_structured 가 아니다(=시즌누적 오답이 안 나간다)".
  const ORIGINALS: Array<{ q: string; source?: string; antiStat?: boolean; forbid: RegExp; note: string }> = [
    { q: "안타를 쳤을때 기아타이거즈만에 세레머니거 있어?", source: "team_rag", forbid: /988/, note: "세레머니(cultural)→나무위키" },
    { q: "김재윤  세이브 순위", source: "history_hold", forbid: /\b26\b/, note: "선수 순위 오요청" },
    { q: "네이버에 보면 경기정보에 고승민 4타수 3안타 이렇게되어잇던데", antiStat: true, forbid: /\b298\b/, note: "특정경기(day) 문장제보 — 시즌누적 298 금지" },
    { q: "어제 롯데 홈런 몇번 쳣어", source: "history_hold", forbid: /\b81\b/, note: "시점(day) 팀" },
    { q: "박동원의 최근 타율 변화는 어때?", source: "history_hold", forbid: /\.233/, note: "추세(method)" },
    { q: "그니까 오늘 기아랑 두산 경기에서 이의리가 세이브를 했잖아", source: "history_hold", forbid: /\b1\b/, note: "시점(day)" },
    { q: "김도영 타율 3할 되려면 어떻게 해야할까", source: "history_hold", forbid: /\.294/, note: "방법(method)" },
  ];
  for (const o of ORIGINALS) {
    await check(`원문 종단 — "${o.q.slice(0, 26)}…" (${o.note})`, async () => {
      const { result } = await ask(o.q);
      if (o.antiStat) {
        assert.notEqual(result.source, "kbo_structured", `동문서답(시즌누적 스탯) 재발: ${result.answer}`);
      } else {
        assert.equal(result.source, o.source, `종단 source=${result.source} (기대 ${o.source}): ${result.answer}`);
      }
      assert.ok(!o.forbid.test(result.answer ?? ""), `동문서답 스탯 숫자 새어나옴: ${result.answer}`);
      if (o.source === "team_rag") {
        assert.ok(/세리머니|호랑이/.test(result.answer ?? ""), `근거답 아님: ${result.answer}`);
      }
    });
  }

  // 결정론적 season fail-close — 로스터에서 단일 해석되는 선수로 stat_scope 를 태운다.
  await check("결정론 fail-close — 문보경 타율 최근 변화는 어때? → history_hold", async () => {
    const { result } = await ask("문보경 타율 최근 변화는 어때?");
    assert.equal(result.source, "history_hold", `추세 질문이 ${result.source} 로 끝났다: ${result.answer}`);
  });

  // ── ② 정상 스탯은 그대로 kbo_structured (가드가 정상 답을 죽이지 않음) ──────
  await check("정상 — 김재윤 세이브 몇 개야? → kbo_structured 실값", async () => {
    const { result } = await ask("김재윤 세이브 몇 개야?");
    assert.equal(result.source, "kbo_structured", `정상 스탯이 ${result.source} 로 죽었다: ${result.answer}`);
    assert.ok(/26/.test(result.answer ?? ""), `세이브 값(26)이 없다: ${result.answer}`);
  });

  // ── ③ 조건절+시점 혼합 수치 반례 → history_hold + RAG 0 ─────────────────────
  await check("혼합 반례 — 어제 롯데가 홈런 쳤을 때 몇 개였어 → history_hold + RAG 0", async () => {
    const { result, calls } = await ask("어제 롯데가 홈런 쳤을 때 몇 개였어");
    assert.equal(result.source, "history_hold", `혼합 수치 질문이 ${result.source} 로 샜다: ${result.answer}`);
    assert.equal(calls.searchRag, 0, `RAG 누수 — searchRag ${calls.searchRag}회 호출`);
    assert.equal(calls.teamLlm, 0, `RAG 누수 — teamLlm ${calls.teamLlm}회 호출`);
  });

  // ── ④ 회귀 — 정상 팀 수치 ────────────────────────────────────────────────
  await check("회귀 — 케이티 순위 → kbo_structured 1위", async () => {
    const { result } = await ask("케이티 순위");
    assert.equal(result.source, "kbo_structured", `팀 순위가 ${result.source} 로 끝났다`);
    assert.ok(/1위/.test(result.answer ?? ""), `순위값(1위) 없다: ${result.answer}`);
  });
  await check("회귀 — KIA 팀 타율 알려줘 → kbo_structured 0.281", async () => {
    const { result } = await ask("KIA 팀 타율 알려줘");
    assert.equal(result.source, "kbo_structured", `팀 타율이 ${result.source} 로 끝났다`);
    assert.ok(/0\.281/.test(result.answer ?? ""), `팀 타율(0.281) 없다: ${result.answer}`);
  });
}

async function main() {
  if (process.argv.includes("--selftest")) {
    const fail = runSelftest();
    if (fail > 0) { console.error(`\n❌ selftest 실패 ${fail}건`); process.exit(1); }
    console.log("✅ selftest 통과 (정밀도 16축)");
    return;
  }
  await runE2E();
  console.log(`✅ E2E 통과 (${pass}건)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
