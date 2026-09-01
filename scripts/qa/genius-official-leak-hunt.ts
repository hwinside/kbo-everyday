/**
 * official 누수 재현 사냥 — 삼순 2026-08-31 지시 (100rep, 첫 누수 즉시 중단).
 *
 * ## 무엇을 잡으려는가
 *
 * `한화 몬스터월은 뭐야?` 는 **구단 자산 질문**이라 team RAG 가 소유한다. 그런데 앞선
 * 진단에서 한 회차가 official RAG(KBO 공식야구규칙)로 샜다. 규칙집에는 마스코트·구장
 * 시설의 근거가 없으므로 그 회차의 유저는 "잘 모르겠다"를 받는다.
 *
 * official 게이트 조건은 이렇다:
 *     ownedByEntityRag ? isSupportedRuleTermQuestion(...) : true
 * 이 질문은 `ownedByEntityRag=true`(한화 결속) · `ruleTerm=false` 라 **항상 skip 돼야**
 * 한다. 즉 official 진입은 **원리적으로 불가능한 경로**다. 그게 일어났으니 둘 중 하나다:
 *   ⓐ 그 순간 파이프라인이 **다른 question 문자열**을 들고 있었다(교정·정규화 수용)
 *   ⓑ 두 술어 중 하나가 같은 입력에 다른 값을 냈다
 *
 * ## 앞선 하니스의 결함(삼순 지적, 이번에 제거)
 *
 *   · 별도 `classifyIntent` 를 한 번 더 호출해 종단과 **다른 호출**의 결과를 나란히
 *     적었다 → rep 단위로 대응되지 않는 표였다. 이번엔 **종단이 실제 소비한 것만** 본다.
 *   · 조건을 파이프라인 **바깥에서 재계산**했다 → "같아야 한다"는 내 가정이 섞였다.
 *     이번엔 official seam 안에서 **그 시점 question 으로** 재판정한다.
 *
 * ## 고정하는 것 / 바꾸는 것
 *   고정: question · context(없음) · flags · deps 구성 · 순차 실행(동시성 1)
 *   변동: messageId 만 (실서비스에서 매 메시지가 다른 id 를 갖는 것과 같다)
 *
 * 🔴 아무것도 고치지 않는다. 첫 누수를 잡으면 즉시 멈추고 그 회차를 통째로 덤프한다.
 *
 * 실행:
 *   npx tsx --require ./scripts/qa/_a0-preload.cjs scripts/qa/genius-official-leak-hunt.ts --reps 100
 */
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  answerQuestion, routeQuestion, isSupportedRuleTermQuestion,
  resolveRagTeamCandidate, isTeamRagServableQuestion,
  mentionsAnyRosterName, mentionedTeamCanonicals,
  type QaDeps, type LlmResult,
} from "../../src/lib/baseball-qa/pipeline";
import {
  loadGlossary, callLlm, mapGlossaryDefinition, normalizeQuestionLlm,
  searchRag, callRagLlm, callTeamRagLlm, teamRagEnabled,
  searchOfficialRag, callOfficialRagLlm, classifyIntent,
} from "../../src/lib/baseball-qa/server";
import { loadRosterPlayers } from "../../src/lib/baseball-qa/roster/load-roster-players";
import { parseIntentResponse } from "../../src/lib/baseball-qa/intent";

const OUT = "/Users/harinclaw/.openclaw/workspace/state/yaj-48h/official-leak-hunt-20260831.json";
const QUESTION = "한화 몬스터월은 뭐야?";

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const REPS = Number(arg("reps", "100"));

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

interface RepRecord {
  rep: number;
  messageId: string;
  source: string;
  /** 종단이 **실제 소비한** 의도 판정(별도 호출 아님). */
  consumedIntent: string | null;
  consumedStandalone: boolean | null;
  /** 각 seam 이 실제로 받은 question — 파이프라인 내부에서 문자열이 바뀌었는지 본다. */
  officialSeen: Array<Record<string, unknown>>;
  teamSeen: string[];
  playerSeen: string[];
  counters: { official: number; player: number; team: number; generic: number; intent: number };
}

async function main() {
  console.log(`[leak-hunt] "${QUESTION}" × ${REPS}rep · 순차 · 첫 누수에서 중단\n`);
  const glossary = await loadGlossary();
  const players = await loadRosterPlayers();

  // 참조 판정 — 이 값들이 매 회차 같아야 한다는 것이 계약이다.
  const baseline = {
    question: QUESTION,
    questionHash: sha(QUESTION),
    route: routeQuestion(QUESTION, glossary, players, false),
    ownedByEntityRag: mentionsAnyRosterName(QUESTION, players) || mentionedTeamCanonicals(QUESTION).length > 0,
    ruleTerm: isSupportedRuleTermQuestion(QUESTION, glossary, players),
    teams: mentionedTeamCanonicals(QUESTION),
    teamCandidate: Boolean(resolveRagTeamCandidate(QUESTION)),
    teamServable: isTeamRagServableQuestion(QUESTION),
  };
  console.log(`[기준] route=${baseline.route} owned=${baseline.ownedByEntityRag} ruleTerm=${baseline.ruleTerm} `
    + `teams=${baseline.teams.join("+")} teamCand=${baseline.teamCandidate} servable=${baseline.teamServable}`);
  console.log(`[계약] owned=true && ruleTerm=false → official 게이트는 **항상 skip** 되어야 한다.\n`);

  const records: RepRecord[] = [];
  let leak: RepRecord | null = null;

  for (let i = 0; i < REPS && !leak; i += 1) {
    const c = { official: 0, player: 0, team: 0, generic: 0, intent: 0 };
    const officialSeen: Array<Record<string, unknown>> = [];
    const teamSeen: string[] = [];
    const playerSeen: string[] = [];
    let consumedIntent: string | null = null;
    let consumedStandalone: boolean | null = null;
    const messageId = `leak-hunt-${Date.now()}-${i}`;

    const track = (r: LlmResult) => r;
    const deps = {
      loadGlossary: async () => glossary,
      loadPlayers: async () => players,
      getCache: async () => null,
      setCache: async () => {},
      callLlm: async (...a: Parameters<typeof callLlm>) => { c.generic += 1; return track(await callLlm(...a)); },
      mapGlossaryDefinition,
      normalizeQuestionLlm,
      pickedNormalizedQuestion: null,
      correctionDeclined: false,
      searchRag: async (...a: Parameters<typeof searchRag>) => {
        c.player += 1; playerSeen.push(String(a[0]).slice(0, 40)); return searchRag(...a);
      },
      callRagLlm: async (...a: Parameters<typeof callRagLlm>) => track(await callRagLlm(...a)),
      enablePlayerRag: true,
      enableTeamRag: teamRagEnabled(),
      callTeamRagLlm: async (...a: Parameters<typeof callTeamRagLlm>) => {
        c.team += 1; teamSeen.push(String(a[0]).slice(0, 40)); return track(await callTeamRagLlm(...a));
      },
      // 🔴 여기가 핵심 관측점 — official 진입 시점의 **그 question 으로** 조건을 재판정한다.
      searchOfficialRag: async (q: string) => {
        c.official += 1;
        officialSeen.push({
          question: q,
          questionHash: sha(q),
          sameAsInput: q === QUESTION,
          nfkcSame: q.normalize("NFKC") === QUESTION.normalize("NFKC"),
          codepoints: [...q].map((ch) => ch.codePointAt(0)!.toString(16)).join(","),
          ownedByEntityRag: mentionsAnyRosterName(q, players) || mentionedTeamCanonicals(q).length > 0,
          ruleTerm: isSupportedRuleTermQuestion(q, glossary, players),
          route: routeQuestion(q, glossary, players, false),
          teams: mentionedTeamCanonicals(q),
          teamCandidate: Boolean(resolveRagTeamCandidate(q)),
          teamServable: isTeamRagServableQuestion(q),
        });
        return searchOfficialRag(q);
      },
      callOfficialRagLlm: async (...a: Parameters<typeof callOfficialRagLlm>) => track(await callOfficialRagLlm(...a)),
      // 종단이 소비하는 그 호출을 그대로 쓰되, **결과만 복사**한다(추가 호출 없음).
      classifyIntent: async (...a: Parameters<typeof classifyIntent>) => {
        c.intent += 1;
        const r = await classifyIntent(...a);
        try {
          const d = parseIntentResponse(r.text, { question: a[0] as string });
          consumedIntent = d.intent;
          consumedStandalone = d.standalone;
        } catch { /* 판정 실패는 파이프라인이 처리한다 */ }
        return r;
      },
      reserveDaily: async () => ({ allowed: true, remaining: 999 }),
      log: async () => {},
    } as unknown as QaDeps;

    let source = "ERR";
    try {
      const r = await answerQuestion(messageId, QUESTION, deps);
      source = (r as { source?: string }).source ?? "null";
    } catch (e) {
      source = `THROW:${(e as Error).message.slice(0, 40)}`;
    }

    const rec: RepRecord = {
      rep: i, messageId, source, consumedIntent, consumedStandalone,
      officialSeen, teamSeen, playerSeen, counters: { ...c },
    };
    records.push(rec);

    // 🔴 누수 판정 = official 을 **탔는가**. source 가 아니라 호출로 본다
    //   (official 을 타고도 근거가 없어 다른 곳으로 갈 수 있으므로 source 는 늦다).
    if (c.official > 0) {
      leak = rec;
      console.log(`\n🔴 rep${i} 누수 포착 — official 진입 ${c.official}회 (source=${source})`);
      break;
    }
    if ((i + 1) % 10 === 0) console.log(`  ... ${i + 1}/${REPS} (official 0)`);
  }

  const sources = records.reduce<Record<string, number>>((a, r) => { a[r.source] = (a[r.source] ?? 0) + 1; return a; }, {});
  console.log(`\n[결과] ${records.length}회 실행 · source 분포 ${JSON.stringify(sources)}`);

  if (leak) {
    console.log(`\n=== 누수 회차 덤프 (rep${leak.rep}) ===`);
    console.log(`consumedIntent=${leak.consumedIntent} standalone=${leak.consumedStandalone}`);
    for (const seen of leak.officialSeen) {
      console.log(`  official seam question=${JSON.stringify(seen.question)}`);
      console.log(`    sameAsInput=${seen.sameAsInput} nfkcSame=${seen.nfkcSame}`);
      console.log(`    owned=${seen.ownedByEntityRag} ruleTerm=${seen.ruleTerm} route=${seen.route}`);
      console.log(`    teams=${JSON.stringify(seen.teams)} teamCand=${seen.teamCandidate} servable=${seen.teamServable}`);
    }
    console.log(`  team seam 받은 question: ${JSON.stringify(leak.teamSeen)}`);
  } else {
    console.log(`✅ ${records.length}/${records.length} official 진입 0 — 이 하니스 구성에서 재현되지 않음.`);
    console.log(`   ⚠️ "결함 없음" 이 아니라 "이 구성·이 횟수에서 재현 실패" 다.`);
  }

  writeFileSync(OUT, JSON.stringify({
    at: new Date().toISOString(), question: QUESTION, reps: REPS, executed: records.length,
    concurrency: 1, baseline,
    note: "삼순 2026-08-31: 별도 classifyIntent 호출 제거(종단 소비분만 포획) · 순차 · 첫 누수 즉시 중단. 수정 없음.",
    doNotCombine: "직전 8rep/10rep 런과 하니스 구성이 달라 발생률을 합산하지 않는다.",
    reproduced: Boolean(leak),
    leak, sources, records,
  }, null, 1));
  console.log(`\n원장: ${OUT}`);
}

void main();
